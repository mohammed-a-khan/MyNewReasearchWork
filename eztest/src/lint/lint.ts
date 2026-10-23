/**
 * `eztest lint`: finds the anti-patterns behind flaky and fragile suites in
 * journeys (.ez, .yaml, .json) and in imported code (TypeScript, JavaScript,
 * Java, Python, C#), with a fix suggestion for each finding. Deterministic,
 * offline, CI friendly (text, JSON and SARIF output; exit code on errors).
 *
 * Rules
 *   hard-wait              fixed sleeps ("Wait 3 seconds", waitForTimeout, Thread.sleep)
 *   absolute-xpath         XPath from the document root (/html/body/div[2]/...)
 *   positional-xpath       XPath with [n], position() or last()
 *   text-only-locator      only visible-text locators on a translated UI
 *   missing-postcondition  a state-changing action (save, submit, POST, INSERT) with nothing checked after it
 *   plaintext-secret       passwords, tokens and keys written in plain text
 *   weak-locator           a target whose best locator scores low (see locator-score.ts)
 *   unsafe-xpath-quotes    an XPath built with \' (not an escape in XPath 1.0) or a quoted ${var}
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import type { Condition, Journey, LocatorCandidate, Step, Target } from '../core/index.js';
import { flattenSteps } from '../core/index.js';
import { describeCandidateText, isAbsoluteXPath, isPositionalXPath, isTextOnly, scoreTarget, type TargetScore } from './locator-score.js';

export type LintSeverity = 'error' | 'warning' | 'info';
export type LintRule =
  | 'hard-wait' | 'absolute-xpath' | 'positional-xpath' | 'text-only-locator' | 'missing-postcondition'
  | 'plaintext-secret' | 'weak-locator' | 'unsafe-xpath-quotes' | 'parse-error';

export const LINT_RULES: Record<LintRule, { severity: LintSeverity; summary: string }> = {
  'hard-wait': { severity: 'warning', summary: 'fixed sleeps make suites slow and still flaky' },
  'absolute-xpath': { severity: 'warning', summary: 'absolute XPath breaks on any layout change' },
  'positional-xpath': { severity: 'warning', summary: 'positional XPath depends on element order' },
  'text-only-locator': { severity: 'warning', summary: 'visible-text locators break on translated UIs' },
  'missing-postcondition': { severity: 'warning', summary: 'state-changing action with nothing checked after it' },
  'plaintext-secret': { severity: 'error', summary: 'secret written in plain text' },
  'weak-locator': { severity: 'info', summary: 'target has only weak locators' },
  'unsafe-xpath-quotes': { severity: 'error', summary: 'value put into an XPath string without safe quoting' },
  'parse-error': { severity: 'error', summary: 'file could not be parsed' },
};

export interface LintFinding {
  rule: LintRule;
  severity: LintSeverity;
  file: string;
  line?: number;
  column?: number;
  message: string;
  /** How to fix it. */
  suggestion: string;
  /** Step id (journeys). */
  stepId?: string;
  /** Locator quality score of the target (weak-locator, xpath rules). */
  score?: number;
}

export interface LintOptions {
  /** Severity per rule ("off" disables it). */
  rules?: Partial<Record<LintRule, LintSeverity | 'off'>>;
  /** The UI is translated: text-only locators are reported. Default: only for journeys with a Locale: header. */
  translatedUi?: boolean;
  /** weak-locator threshold (score below it is reported). Default 40. */
  weakBelow?: number;
  /** Base directory for relative file names in findings. */
  cwd?: string;
}

const JOURNEY_EXT = new Set(['.ez', '.yaml', '.yml', '.json']);
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.java', '.py', '.cs', '.kt']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.eztest', 'dist', 'eztest-results', 'build', 'target', '.venv']);
const NOT_JOURNEYS = /^(?:import-report\.json|package(?:-lock)?\.json|tsconfig.*\.json|eztest\.config\.(?:ya?ml|json)|readiness-policy\.ya?ml|.*\.template\.ya?ml|.*\.locators\.json)$/i;

// ------------------------------------------------------------------ helpers

const COMMIT_WORDS = /\b(?:save|submit|create|delete|remove|confirm|apply|pay|place|update|send|approve|reject|book|order|checkout|register|sign\s*up|publish|post|transfer|cancel|archive|upload)\b/i;
const SECRET_KEY = /(?:^|[_\-.\s])(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|private[_-]?key|client[_-]?secret|access[_-]?key|auth(?:orization)?)(?:$|[_\-.\s])/i;
const SECRET_FIELD = /password|passwd|passcode|pin\b|secret|token|api ?key|one-time code/i;
const SAFE_SECRET_VALUE = /^\s*(?:\$\{[^}]+\}|secret:\/\/|ENC\(|env:|<[^>]+>|\*+|x+|REPLACE_WITH|CHANGE_?ME|TODO)/i;
const SECRET_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, 'a JSON Web Token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, 'a GitHub token'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'a private key'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/, 'a bearer token'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:[^\s@'"]{3,}@/i, 'credentials in a URL'],
];

/** Redact a secret for display: first 2 characters and the length. */
export function redact(v: string): string {
  return v.length <= 4 ? '****' : `${v.slice(0, 2)}… (${v.length} chars)`;
}

function locatorsOf(t: Target | undefined): LocatorCandidate[] {
  return t?.locators ?? [];
}

function conditionTargets(c: Condition): Target[] {
  const out: Target[] = [];
  if ('target' in c && c.target) out.push(c.target as Target);
  if ('of' in c && c.of) out.push(c.of as Target);
  return out;
}

/** Find the 1-based line of a step in .ez text (searching forward from `from`). */
function lineOf(lines: string[], needle: string, from: number): number | undefined {
  const n = needle.trim().toLowerCase();
  if (!n) return undefined;
  for (let i = from; i < lines.length; i++) if (lines[i].trim().toLowerCase().startsWith(n.slice(0, 60))) return i + 1;
  for (let i = 0; i < lines.length; i++) if (lines[i].toLowerCase().includes(n.slice(0, 40))) return i + 1;
  return undefined;
}

function isTranslatedJourney(j: Journey): boolean {
  return !!j.emulation?.locale;
}

function textOnlyTarget(t: Target): boolean {
  if (!t.locators.length) return false;
  // Language-independent candidates: test ids, ids/attributes in CSS/XPath.
  const independent = t.locators.some((c) => c.strategy === 'testId' || (c.strategy === 'css' && !/:has-text|:text\(/.test(c.value)) || (c.strategy === 'xpath' && !isTextOnly(c) && /@(?:id|name|data-[\w-]+|for|type)\s*=/.test(c.value)));
  if (independent) return false;
  return t.locators.every((c) => isTextOnly(c) || c.strategy === 'role' || c.strategy === 'label' || c.strategy === 'placeholder' || c.strategy === 'title' || c.strategy === 'altText' || c.strategy === 'text');
}

// ------------------------------------------------------------------ journey rules

export function lintJourney(j: Journey, file: string, text: string | undefined, o: LintOptions = {}): LintFinding[] {
  const out: LintFinding[] = [];
  const lines = (text ?? '').split(/\r?\n/);
  const isEz = file.toLowerCase().endsWith('.ez');
  let cursor = 0;
  const steps = flattenSteps(j.steps);
  const lineFor = (s: Step) => {
    if (!isEz) return undefined;
    const l = lineOf(lines, s.intent, cursor);
    if (l) cursor = l;
    return l;
  };
  const translated = o.translatedUi ?? isTranslatedJourney(j);
  const weakBelow = o.weakBelow ?? 40;
  const add = (f: Omit<LintFinding, 'severity' | 'file'>) => out.push({ ...f, severity: LINT_RULES[f.rule].severity, file });

  // Variables that hold secrets in plain text.
  for (const [k, v] of Object.entries(j.variables)) {
    if (SECRET_KEY.test(`_${k.replace(/([a-z0-9])([A-Z])/g, '$1_$2')}_`) && v && !SAFE_SECRET_VALUE.test(v)) {
      add({ rule: 'plaintext-secret', line: isEz ? lineOf(lines, 'Variables:', 0) : undefined, message: `variable "${k}" holds a secret in plain text (${redact(v)})`, suggestion: `store it in a secret store and reference it: ${k}=\${${k.toUpperCase()}} with the value in .env / secret://env/${k.toUpperCase()} (or the Identity Vault for passwords)` });
    }
  }

  // Each step, with its position among siblings (for "is the next step a check?").
  const nextOf = new Map<Step, Step | undefined>();
  const walk = (list: Step[] | undefined) => {
    (list ?? []).forEach((s, i) => {
      nextOf.set(s, list![i + 1]);
      walk(s.steps); walk(s.else); walk(s.catch);
    });
  };
  walk(j.steps);

  for (const s of steps) {
    const line = lineFor(s);
    // ---- hard waits
    if (s.action === 'wait' && !s.target && s.args?.for === undefined && s.value !== undefined && !s.postconditions.length) {
      add({ rule: 'hard-wait', line, stepId: s.id, message: `hard wait "${s.intent}" (${s.value} ms) - the step waits the full time even when the app is ready, and is still too short when it is slow`, suggestion: 'wait for the real signal instead: "Wait for the text \"Saved\"", "Wait for the Orders table to appear", "Wait until the URL contains \"/done\"", or an Expect line (polled); spinners belong in waits.loaders / Loaders:' });
    }
    // ---- locators of the step and of its conditions
    const targets: Array<{ t: Target; where: string }> = [];
    if (s.target) targets.push({ t: s.target, where: 'target' });
    if (s.to) targets.push({ t: s.to, where: 'drop target' });
    for (const c of s.postconditions) for (const t of conditionTargets(c)) targets.push({ t, where: 'expectation' });
    for (const { t, where } of targets) {
      for (const c of locatorsOf(t)) {
        if (c.strategy !== 'xpath') continue;
        if (isAbsoluteXPath(c.value)) {
          add({ rule: 'absolute-xpath', line, stepId: s.id, message: `${where} "${t.description}" uses an absolute XPath ${c.value.slice(0, 80)}`, suggestion: 'use a test id (testid=...), the element\'s role and name (the "Save" button) or its label; keep the XPath only as a last fallback candidate', score: scoreTarget([c]).score });
        } else if (isPositionalXPath(c.value)) {
          add({ rule: 'positional-xpath', line, stepId: s.id, message: `${where} "${t.description}" uses a positional XPath ${c.value.slice(0, 80)}`, suggestion: 'anchor on something that identifies the element (an id, test id, label or the row\'s text, e.g. //tr[td="ORD-1"]//button) instead of its position', score: scoreTarget([c]).score });
        }
        if (/\\'/.test(c.value)) {
          add({ rule: 'unsafe-xpath-quotes', line, stepId: s.id, message: `XPath ${c.value.slice(0, 80)} uses \\' to escape a quote, which XPath 1.0 does not support`, suggestion: 'write the value with ${var}: EZTest quotes it safely (concat() when it holds both quote kinds)' });
        }
      }
      if (translated && textOnlyTarget(t)) {
        add({ rule: 'text-only-locator', line, stepId: s.id, message: `${where} "${t.description}" is found only by visible text, which changes per language`, suggestion: `add a language-independent candidate: "${t.description} at testid=..." (or a stable id), keeping the text candidates as fallbacks` });
      }
      const score: TargetScore = scoreTarget(t.locators);
      if (where === 'target' && t.locators.length && score.score < weakBelow && !t.locators.every((c) => c.strategy === 'xpath' && (isAbsoluteXPath(c.value) || isPositionalXPath(c.value)))) {
        add({ rule: 'weak-locator', line, stepId: s.id, score: score.score, message: `target "${t.description}" scores ${score.score}/100 (${score.grade}): ${score.reasons.slice(0, 2).join('; ')}`, suggestion: `prefer, in order: testid=..., role and accessible name (the "Name" button), label (the Name field); current best: ${describeCandidateText(score.candidates.reduce((a, b) => (b.score > a.score ? b : a)).candidate)}` });
      }
    }
    // ---- secrets typed in plain text
    if ((s.action === 'fill' || s.action === 'keyboard') && s.value && !SAFE_SECRET_VALUE.test(s.value) && SECRET_FIELD.test(s.target?.description ?? '')) {
      add({ rule: 'plaintext-secret', line, stepId: s.id, message: `"${s.target?.description}" is filled with a plain-text secret (${redact(s.value)})`, suggestion: 'use a role login ("Log in as manager", credentials in the Identity Vault) or a variable from a secret store: Type "${PASSWORD}" into ...' });
    }
    for (const v of [s.value, s.api?.url, s.api?.body === undefined ? undefined : JSON.stringify(s.api.body), ...Object.values(s.api?.headers ?? {})]) {
      if (!v) continue;
      const hit = SECRET_VALUE_PATTERNS.find(([re]) => re.test(v));
      if (hit) add({ rule: 'plaintext-secret', line, stepId: s.id, message: `step "${s.intent.slice(0, 60)}" contains ${hit[1]} in plain text`, suggestion: 'move it to a secret store and reference it as ${NAME}; API steps can use "as <role>" for tokens' });
    }
    // ---- state-changing actions with no check
    if (!s.postconditions.length && !s.optional) {
      const next = nextOf.get(s);
      const checkedNext = next !== undefined && (next.action === 'assert' || (next.action === 'wait' && (next.target !== undefined || next.args?.for !== undefined || next.postconditions.length > 0)));
      let commit = false;
      if (['click', 'dblclick'].includes(s.action) && COMMIT_WORDS.test(`${s.target?.description ?? ''} ${s.intent}`)) commit = true;
      if (s.action === 'api' && s.api && s.api.method !== 'GET' && s.api.method !== 'HEAD' && s.api.method !== 'OPTIONS') commit = true;
      if (s.action === 'db' && /^\s*(?:insert|update|delete|merge)\b/i.test(s.db?.sql ?? '')) commit = true;
      if (commit && !checkedNext) {
        add({ rule: 'missing-postcondition', line, stepId: s.id, message: `"${s.intent.slice(0, 80)}" changes state but nothing checks that it worked`, suggestion: 'add an Expect line under it, e.g. "  Expect the page contains \"Saved\"" or "  Expect the response status is 201"; it is what makes the step verifiable (and what lets a heal be verified)' });
      }
    }
  }
  return applySeverities(out, o);
}

/** Apply configured severities; rules set to "off" are dropped. */
function applySeverities(list: LintFinding[], o: LintOptions): LintFinding[] {
  return list.flatMap((f) => {
    const s = severityFor(f.rule, o);
    return s === 'off' ? [] : [{ ...f, severity: s ?? f.severity }];
  });
}

function severityFor(rule: LintRule, o: LintOptions): LintSeverity | 'off' | undefined {
  return o.rules?.[rule];
}

// ------------------------------------------------------------------ code rules

const CODE_WAITS: Array<[RegExp, string]> = [
  [/\bwaitForTimeout\s*\(\s*[^)]*\)/, 'page.waitForTimeout'],
  [/\bnew\s+Promise\s*\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*setTimeout\s*\(\s*\1\s*,/, 'a Promise around setTimeout'],
  [/\b(?:await\s+)?(?:\w+\.)?(?:sleep|delay|pause|wait)\s*\(\s*\d{2,}\s*\)/, 'a sleep call'],
  [/\bThread\.sleep\s*\(/, 'Thread.sleep'],
  [/\btime\.sleep\s*\(/, 'time.sleep'],
  [/\bTask\.Delay\s*\(\s*\d+/, 'Task.Delay'],
  [/\bcy\.wait\s*\(\s*\d+/, 'cy.wait(ms)'],
  [/\bbrowser\.pause\s*\(/, 'browser.pause'],
  [/\bdriver\.sleep\s*\(/, 'driver.sleep'],
];

/** String literals that hold an XPath (a double-quoted string may contain single quotes and vice versa; templates both). */
const XPATH_IN_CODE = /"(\(?\/\/?[a-zA-Z*][^"\n]*)"|'(\(?\/\/?[a-zA-Z*][^'\n]*)'|`(\(?\/\/?[a-zA-Z*][^`\n]*)`/g;

/** Lint source code (page objects, step definitions, helpers) imported into or next to EZTest. */
export function lintCode(text: string, file: string, o: LintOptions = {}): LintFinding[] {
  const out: LintFinding[] = [];
  const add = (f: Omit<LintFinding, 'severity' | 'file'>) => out.push({ ...f, severity: LINT_RULES[f.rule].severity, file });
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = i + 1;
    const code = raw.replace(/\/\/(?!\/).*$/, (m) => (/['"`]/.test(m) ? m : '')); // drop line comments that are not inside strings (rough)
    if (/^\s*(?:\*|\/\*|#)/.test(raw)) return;
    for (const [re, what] of CODE_WAITS) {
      const m = re.exec(code);
      if (m) {
        add({ rule: 'hard-wait', line, column: m.index + 1, message: `hard wait: ${what} (${m[0].slice(0, 60)})`, suggestion: 'wait for a condition instead: locator.waitFor({ state: "visible" }), expect(locator).toHaveText(...), page.waitForResponse(...); in EZTest journeys use an Expect line or "Wait for ..."' });
        break;
      }
    }
    for (const m of code.matchAll(XPATH_IN_CODE)) {
      const x = m[1] ?? m[2] ?? m[3];
      if (!/[[\]@/]/.test(x.slice(1)) && !/^\/\/\w+$/.test(x)) continue; // not an XPath (e.g. a URL path)
      if (/^\/\/[\w.-]+\.[a-z]{2,}/i.test(x) || /^\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)*\/?$/i.test(x)) continue; // URLs and plain paths
      const col = (m.index ?? 0) + 2;
      if (isAbsoluteXPath(x) && /^\/(?:html|body)\b/i.test(x)) add({ rule: 'absolute-xpath', line, column: col, message: `absolute XPath ${x.slice(0, 80)}`, suggestion: 'anchor on an id, test id, label or role instead; the importer keeps it only as a last fallback' });
      else if (!isAbsoluteXPath(x) && isPositionalXPath(x)) add({ rule: 'positional-xpath', line, column: col, message: `positional XPath ${x.slice(0, 80)}`, suggestion: 'anchor on something that identifies the element instead of its index' });
      if (/'\$\{[^}]+\}'|"\$\{[^}]+\}"/.test(x)) add({ rule: 'unsafe-xpath-quotes', line, column: col, message: `XPath built by putting a value inside quotes: ${x.slice(0, 80)} breaks when the value contains that quote`, suggestion: 'build the literal with concat() for values with quotes (EZTest journeys do this automatically for ${var} in xpath= locators)' });
    }
    if (/replace\(\s*\/'\/g\s*,\s*["']\\\\'["']\s*\)/.test(code)) {
      add({ rule: 'unsafe-xpath-quotes', line, message: "quote 'escaping' with \\' is not valid XPath 1.0; values with an apostrophe break the locator", suggestion: 'use an XPath literal helper that emits concat(...) for mixed quotes' });
    }
    // Secrets assigned in code.
    const assign = /\b(\w*(?:password|passwd|pwd|secret|token|apikey|api_key|clientsecret|client_secret)\w*)\s*[:=]\s*(['"])([^'"\n]{4,})\2/i.exec(code);
    const notSecretName = assign ? /(?:type|kind|name|url|uri|field|label|header|endpoint|prefix|length|count|expires?(?:_?in)?|policy|regex|pattern|hint|placeholder|selector|locator)$/i.test(assign[1]) : true;
    if (assign && !notSecretName && !assign[3].includes('${') && !/^(?:bearer|basic|true|false|null|none|undefined)$/i.test(assign[3]) && !SAFE_SECRET_VALUE.test(assign[3]) && !/process\.env|getenv|System\.getenv|os\.environ/.test(code)) {
      add({ rule: 'plaintext-secret', line, message: `${assign[1]} is assigned a plain-text value (${redact(assign[3])})`, suggestion: 'read it from the environment or a secret store (EZTest: secret://env/NAME, Azure Key Vault, the Identity Vault)' });
    } else {
      const hit = SECRET_VALUE_PATTERNS.find(([re]) => re.test(code));
      if (hit) add({ rule: 'plaintext-secret', line, message: `${hit[1]} in source code`, suggestion: 'move it to a secret store and rotate it' });
    }
  });
  return applySeverities(out, o);
}

// ------------------------------------------------------------------ files

export interface LintReport {
  files: number;
  findings: LintFinding[];
  counts: Record<LintSeverity, number>;
}

async function collect(paths: string[], cwd: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (p: string): Promise<void> => {
    const s = await stat(p);
    if (s.isDirectory()) {
      for (const name of (await readdir(p)).sort()) if (!SKIP_DIRS.has(name)) await walk(join(p, name));
      return;
    }
    const ext = extname(p).toLowerCase();
    const base = p.split(/[\\/]/).pop() ?? '';
    if ((JOURNEY_EXT.has(ext) && !NOT_JOURNEYS.test(base)) || CODE_EXT.has(ext)) out.push(p);
  };
  for (const p of paths) await walk(resolve(cwd, p));
  return [...new Set(out)];
}

/** Lint files and directories. Journeys are parsed with the EZTest grammar; code files are scanned. */
export async function lintPaths(paths: string[], o: LintOptions = {}): Promise<LintReport> {
  const cwd = o.cwd ?? process.cwd();
  const files = await collect(paths, cwd);
  const findings: LintFinding[] = [];
  const { loadJourneyFile } = await import('../intent/index.js');
  for (const abs of files) {
    const rel = relative(cwd, abs) || abs;
    const ext = extname(abs).toLowerCase();
    const text = await readFile(abs, 'utf8');
    if (CODE_EXT.has(ext)) {
      findings.push(...lintCode(text, rel, o));
      continue;
    }
    try {
      const j = await loadJourneyFile(abs);
      findings.push(...lintJourney(j, rel, text, o));
    } catch (e) {
      if ((ext === '.json' && !/"steps"\s*:/.test(text)) || ((ext === '.yaml' || ext === '.yml') && !/^steps\s*:/m.test(text))) continue; // data / config files, not journeys
      findings.push({ rule: 'parse-error', severity: 'error', file: rel, message: (e as Error).message.split('\n')[0], suggestion: 'run eztest validate for details' });
    }
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule));
  const counts: Record<LintSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return { files: files.length, findings, counts };
}

// ------------------------------------------------------------------ output

export function formatText(r: LintReport): string {
  const out: string[] = [];
  for (const f of r.findings) {
    out.push(`${f.file}${f.line ? `:${f.line}${f.column ? `:${f.column}` : ''}` : ''}  ${f.severity.padEnd(7)} ${f.rule.padEnd(22)} ${f.message}`);
    out.push(`    fix: ${f.suggestion}`);
  }
  out.push(`${r.files} file(s): ${r.counts.error} error(s), ${r.counts.warning} warning(s), ${r.counts.info} info`);
  return out.join('\n');
}

/** SARIF 2.1.0 (GitHub code scanning, Azure DevOps). */
export function formatSarif(r: LintReport): string {
  const level = (s: LintSeverity) => (s === 'error' ? 'error' : s === 'warning' ? 'warning' : 'note');
  return JSON.stringify({
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'eztest-lint', informationUri: 'https://example.invalid/eztest/docs/reliability.md', rules: Object.entries(LINT_RULES).map(([id, d]) => ({ id, shortDescription: { text: d.summary }, defaultConfiguration: { level: level(d.severity) } })) } },
      results: r.findings.map((f) => ({
        ruleId: f.rule, level: level(f.severity), message: { text: `${f.message}. Fix: ${f.suggestion}` },
        locations: [{ physicalLocation: { artifactLocation: { uri: f.file.replace(/\\/g, '/') }, ...(f.line ? { region: { startLine: f.line, ...(f.column ? { startColumn: f.column } : {}) } } : {}) } }],
      })),
    }],
  }, null, 2);
}

/** Exit code for CI: 1 when there are errors, or more warnings than allowed. */
export function lintExitCode(r: LintReport, maxWarnings?: number): number {
  if (r.counts.error > 0) return 1;
  if (maxWarnings !== undefined && r.counts.warning > maxWarnings) return 1;
  return 0;
}
