/**
 * `eztest lint`: finds the anti-patterns behind flaky and fragile suites, and
 * the departures from the EZTest Project Guide (docs/project-guide.md), in
 * journeys (.ez, .yaml, .json), Gherkin features, code (TypeScript,
 * JavaScript, Java, Python, C#), test data (CSV, TSV, XLSX, JSON), the config
 * layers and `.env.example`, with a fix suggestion and a guide link for each
 * finding. Deterministic, offline, CI friendly (text, JSON, SARIF and JUnit
 * output; exit code on errors). Nothing is executed: step definitions and
 * code journeys are read as text.
 *
 * Rules (rules.ts has the severities and guide sections)
 *   hard-wait              fixed sleeps ("Wait 3 seconds", waitForTimeout, Thread.sleep)
 *   absolute-xpath         XPath from the document root (/html/body/div[2]/...)
 *   positional-xpath       XPath with [n], position() or last()
 *   text-only-locator      only visible-text locators on a translated UI
 *   raw-selector           a target found only by CSS or XPath
 *   repeated-selector      one raw selector written in several steps instead of one element entry
 *   weak-locator           a target whose best locator scores low (see locator-score.ts)
 *   unsafe-xpath-quotes    an XPath built with \' (not an escape in XPath 1.0) or a quoted ${var}
 *   missing-postcondition  a state-changing, submitting or navigating action with nothing checked after it
 *   no-assertion           a journey that checks nothing
 *   plaintext-secret       passwords, tokens and keys written in plain text (journeys, code, data, config)
 *   missing-tags           a journey without tags
 *   missing-id             a journey without an explicit id
 *   duplicate-id           two journeys with one id
 *   undefined-step         a Gherkin step no definition matches (and not an EZTest phrasing)
 *   ambiguous-step         a Gherkin step several definitions match
 *   undeclared-dependency  a journey using a value only another journey captures, without Depends on:
 *   hardcoded-host         an absolute URL instead of baseUrl / an environment variable
 *   outside-layout         a file outside the project layout (projects with an apps/ folder)
 */
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Condition, Journey, LocatorCandidate, Step, Target } from '../core/index.js';
import { flattenSteps } from '../core/index.js';
import { describeCandidateText, isAbsoluteXPath, isPositionalXPath, isTextOnly, scoreTarget, type TargetScore } from './locator-score.js';
import {
  applySeverities, finding, LINT_RULES, redact, SAFE_SECRET_VALUE, SECRET_FIELD, SECRET_VALUE_PATTERNS, isSecretName,
  type LintFinding, type LintOptions, type LintRule, type LintSeverity,
} from './rules.js';
import { checkLayout, journeyFacts, lintDataFile, lintFeature, lintLayout, lintProject, loadStepIndex, type JourneyFacts, type StepIndex } from './project.js';

export { LINT_RULES, LINT_RULE_IDS, redact, type LintFinding, type LintOptions, type LintRule, type LintSeverity } from './rules.js';

const JOURNEY_EXT = new Set(['.ez', '.yaml', '.yml', '.json']);
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.java', '.py', '.cs', '.kt']);
const DATA_EXT = new Set(['.csv', '.tsv', '.xlsx']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.eztest', 'dist', 'eztest-results', 'build', 'target', '.venv']);
/** Not journeys and not data: reports, manifests, the readiness policy, templates, locator sidecars. */
const NOT_LINTED = /^(?:import-report\.json|package(?:-lock)?\.json|tsconfig.*\.json|readiness-policy\.ya?ml|.*\.template\.ya?ml|.*\.locators\.json)$/i;
/** The config layers: checked for plain-text secrets only. */
const CONFIG_FILE = /^eztest\.config\.(?:ya?ml|json)$/i;
/** Examples of the environment's names (never a real .env, which holds the values and is not committed). */
const ENV_EXAMPLE = /^\.env\.(?:example|sample|template)$/i;
const FEATURE_EXT = '.feature';

// ------------------------------------------------------------------ helpers

const COMMIT_WORDS = /\b(?:save|submit|create|delete|remove|confirm|apply|pay|place|update|send|approve|reject|book|order|checkout|register|sign\s*up|sign\s*in|log\s*in|publish|post|transfer|cancel|archive|upload|search)\b/i;
/** Steps that check something, or may (a sub-journey, code, a manual verdict, a widget read). */
const CHECKING_ACTIONS = new Set(['assert', 'compareDocument', 'compareData', 'runJourney', 'code', 'manual', 'custom', 'integration', 'component']);
const ABSOLUTE_URL = /^\s*["']?https?:\/\//i;

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
export function lineOf(lines: string[], needle: string, from: number): number | undefined {
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

/** A target written as CSS or XPath only (no role, label, text or test id candidate), and not a repository element. */
function rawOnly(t: Target): boolean {
  return !t.element && t.locators.length > 0 && t.locators.every((c) => c.strategy === 'css' || c.strategy === 'xpath');
}

/** Did the author give the journey its own id? (.ez `Id:`, YAML `id:`, JSON `"id":`) */
export function hasExplicitId(file: string, text: string): boolean {
  const ext = extname(file).toLowerCase();
  if (ext === '.ez') return /^\s*id\s*:\s*\S/im.test(text);
  if (ext === '.json') return /"id"\s*:/.test(text);
  return /^id\s*:\s*\S/m.test(text);
}

const isSetupOrTeardown = (j: Journey) => j.tags.includes('setup') || j.tags.includes('teardown');

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
  const header = (name: string) => (isEz ? lineOf(lines, `${name}:`, 0) : undefined);
  const translated = o.translatedUi ?? isTranslatedJourney(j);
  const weakBelow = o.weakBelow ?? 40;
  const add = (f: Omit<LintFinding, 'severity' | 'file' | 'doc'>) => out.push(finding(f.rule, file, f));

  // ---- the journey's identity: id and tags (docs/project-guide.md#tags-ids-risk-and-requirements)
  if (text !== undefined && !hasExplicitId(file, text)) {
    add({ rule: 'missing-id', line: isEz ? 1 : undefined, message: `journey "${j.name}" has no explicit id (it gets "${j.id}" from its ${isEz ? 'file name' : 'name'}, which changes when it is renamed)`, suggestion: `add ${isEz ? `"Id: ${j.id}"` : `"id: ${j.id}"`} under the name; history, quarantine, heals and Azure DevOps test cases follow the id` });
  }
  if (!j.tags.length && !isSetupOrTeardown(j)) {
    add({ rule: 'missing-tags', line: isEz ? 1 : undefined, message: `journey "${j.name}" has no tags, so no suite (@smoke, @regression) or module selects it`, suggestion: 'add "Tags: @regression @<module>" (and @smoke for the few journeys every pull request runs)' });
  }

  // Variables that hold secrets in plain text.
  for (const [k, v] of Object.entries(j.variables)) {
    if (isSecretName(k) && v && !SAFE_SECRET_VALUE.test(v)) {
      add({ rule: 'plaintext-secret', line: header('Variables'), message: `variable "${k}" holds a secret in plain text (${redact(v)})`, suggestion: `store it in a secret store and reference it: ${k}=\${${k.toUpperCase()}} with the value in .env / secret://env/${k.toUpperCase()} (or the Identity Vault for passwords)` });
    }
  }

  // ---- hosts written into the journey
  if (j.baseUrl && ABSOLUTE_URL.test(j.baseUrl) && !j.baseUrl.includes('${')) {
    add({ rule: 'hardcoded-host', line: header('Base URL'), message: `Base URL "${j.baseUrl}" pins the journey to one environment`, suggestion: 'remove the Base URL: header and set baseUrl per environment (config/<app>/<env>.yaml), or use a variable: "Base URL: ${PARTNER_URL}"' });
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

  let checks = 0;
  for (const s of steps) {
    const line = lineFor(s);
    if (s.postconditions.length || CHECKING_ACTIONS.has(s.action) || (s.action === 'wait' && (s.target !== undefined || s.args?.for !== undefined))) checks++;
    // ---- hard waits
    if (s.action === 'wait' && !s.target && s.args?.for === undefined && s.value !== undefined && !s.postconditions.length) {
      add({ rule: 'hard-wait', line, stepId: s.id, message: `hard wait "${s.intent}" (${s.value} ms) - the step waits the full time even when the app is ready, and is still too short when it is slow`, suggestion: 'wait for the real signal instead: "Wait for the text \"Saved\"", "Wait for the Orders table to appear", "Wait until the URL contains \"/done\"", or an Expect line (polled); spinners belong in waits.loaders / Loaders:' });
    }
    // ---- hosts
    const url = s.action === 'navigate' ? s.value : s.action === 'api' ? s.api?.url : undefined;
    if (url && ABSOLUTE_URL.test(url) && !/^\s*\$\{/.test(url)) {
      add({ rule: 'hardcoded-host', line, stepId: s.id, message: `"${s.intent.slice(0, 80)}" goes to a fixed host (${url.replace(/^(\w+:\/\/[^/]+).*$/, '$1')})`, suggestion: 'use a path ("Open /orders") under the environment\'s baseUrl, or a ${VAR} set per environment (config/<env>.yaml vars:) for a second host' });
    }
    // ---- locators of the step and of its conditions
    const targets: Array<{ t: Target; where: string }> = [];
    if (s.target) targets.push({ t: s.target, where: 'target' });
    if (s.to) targets.push({ t: s.to, where: 'drop target' });
    for (const c of s.postconditions) for (const t of conditionTargets(c)) targets.push({ t, where: 'expectation' });
    for (const { t, where } of targets) {
      let fragile = false;
      for (const c of locatorsOf(t)) {
        if (c.strategy !== 'xpath') continue;
        if (isAbsoluteXPath(c.value)) {
          fragile = true;
          add({ rule: 'absolute-xpath', line, stepId: s.id, message: `${where} "${t.description}" uses an absolute XPath ${c.value.slice(0, 80)}`, suggestion: 'use a test id (testid=...), the element\'s role and name (the "Save" button) or its label; keep the XPath only as a last fallback candidate', score: scoreTarget([c]).score });
        } else if (isPositionalXPath(c.value)) {
          fragile = true;
          add({ rule: 'positional-xpath', line, stepId: s.id, message: `${where} "${t.description}" uses a positional XPath ${c.value.slice(0, 80)}`, suggestion: 'anchor on something that identifies the element (an id, test id, label or the row\'s text, e.g. //tr[td="ORD-1"]//button) instead of its position', score: scoreTarget([c]).score });
        }
        if (/\\'/.test(c.value)) {
          add({ rule: 'unsafe-xpath-quotes', line, stepId: s.id, message: `XPath ${c.value.slice(0, 80)} uses \\' to escape a quote, which XPath 1.0 does not support`, suggestion: 'write the value with ${var}: EZTest quotes it safely (concat() when it holds both quote kinds)' });
        }
      }
      if (!fragile && rawOnly(t)) {
        add({ rule: 'raw-selector', line, stepId: s.id, message: `${where} "${t.description}" is found only by ${t.locators[0].strategy === 'css' ? 'CSS' : 'XPath'} (${t.locators[0].value.slice(0, 60)})`, suggestion: 'name the element the way a user sees it (the "Save" button, the Email field) or by its test id (testid=save); when only a selector works, give it a name in the element repository (elements/<screen>.yaml) and use @Screen.element' });
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
    // ---- state-changing, submitting and navigating actions with no check
    if (!s.postconditions.length && !s.optional) {
      const next = nextOf.get(s);
      const checkedNext = next !== undefined && (next.action === 'assert' || (next.action === 'wait' && (next.target !== undefined || next.args?.for !== undefined || next.postconditions.length > 0)));
      let what: string | undefined;
      const described = `${s.target?.description ?? ''} ${s.intent}`;
      if (['click', 'dblclick'].includes(s.action) && COMMIT_WORDS.test(described)) what = 'changes state';
      else if (['click', 'dblclick'].includes(s.action) && (/\blink\b/i.test(s.target?.description ?? '') || locatorsOf(s.target).some((c) => c.strategy === 'role' && c.value === 'link'))) what = 'navigates';
      else if (s.action === 'press' && s.target && /^enter$/i.test(s.value ?? '')) what = 'submits a form';
      if (s.action === 'api' && s.api && s.api.method !== 'GET' && s.api.method !== 'HEAD' && s.api.method !== 'OPTIONS') what = 'changes state';
      if (s.action === 'db' && /^\s*(?:insert|update|delete|merge)\b/i.test(s.db?.sql ?? '')) what = 'changes state';
      if (what && !checkedNext) {
        add({ rule: 'missing-postcondition', line, stepId: s.id, message: `"${s.intent.slice(0, 80)}" ${what} but nothing checks that it worked`, suggestion: 'add an Expect line under it, e.g. "  Expect the page contains \"Saved\"", "  Expect the URL contains \"/orders\"" or "  Expect the response status is 201"; it is what makes the step verifiable (and what lets a heal be verified)' });
      }
    }
  }
  if (!checks && j.type !== 'manual' && !j.tags.includes('library') && !isSetupOrTeardown(j)) {
    add({ rule: 'no-assertion', line: isEz ? 1 : undefined, message: `journey "${j.name}" checks nothing: it can pass while the app is broken`, suggestion: 'add an Expect line after each meaningful action (the outcome the user would see, the stored record, the response status)' });
  }
  return applySeverities(out, o);
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
/** A navigation or HTTP call to a literal absolute URL: ui.open('https://...'), api.get("http://..."), page.goto(`https://...`). */
const HOST_IN_CODE = /\b(?:open|goto|navigate|get|post|put|patch|delete|request|fetch)\s*\(\s*(?:['"]\s*[A-Z]+\s*['"]\s*,\s*)?(['"`])(https?:\/\/[^'"`\s/]+)/;

/** Lint source code (page objects, step definitions, helpers, code journeys) imported into or next to EZTest. */
export function lintCode(text: string, file: string, o: LintOptions = {}): LintFinding[] {
  const out: LintFinding[] = [];
  const add = (f: Omit<LintFinding, 'severity' | 'file' | 'doc'>) => out.push(finding(f.rule, file, f));
  const lines = text.split(/\r?\n/);
  const isTsOrJs = /\.(?:[mc]?[jt]sx?)$/i.test(file);
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
    if (isTsOrJs) {
      const h = HOST_IN_CODE.exec(code);
      if (h) add({ rule: 'hardcoded-host', line, column: (h.index ?? 0) + 1, message: `call to a fixed host ${h[2]}`, suggestion: 'pass a path (ui.open(\'/orders\'), api.get(\'/api/orders\')) so the environment\'s baseUrl applies, or read the second host from vars.config(\'PARTNER_URL\')' });
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
  /** Number of files linted. */
  files: number;
  /** The files linted (relative to cwd), for per-file reports (JUnit). */
  fileList?: string[];
  findings: LintFinding[];
  counts: Record<LintSeverity, number>;
}

type Kind = 'journey' | 'code' | 'feature' | 'data' | 'config' | 'env';

function kindOf(p: string, inConfigDir: boolean): Kind | undefined {
  const base = basename(p);
  const ext = extname(p).toLowerCase();
  if (ENV_EXAMPLE.test(base)) return 'env';
  if (CONFIG_FILE.test(base) || (inConfigDir && /\.(?:ya?ml|json)$/i.test(base))) return 'config';
  if (NOT_LINTED.test(base)) return undefined;
  if (ext === FEATURE_EXT) return 'feature';
  if (DATA_EXT.has(ext)) return 'data';
  if (JOURNEY_EXT.has(ext)) return 'journey';
  if (CODE_EXT.has(ext)) return 'code';
  return undefined;
}

async function collect(paths: string[], cwd: string): Promise<Array<{ abs: string; kind: Kind }>> {
  const out = new Map<string, Kind>();
  const configDir = resolve(cwd, 'config');
  const walk = async (p: string): Promise<void> => {
    const s = await stat(p);
    if (s.isDirectory()) {
      for (const name of (await readdir(p)).sort()) if (!SKIP_DIRS.has(name)) await walk(join(p, name));
      return;
    }
    const k = kindOf(p, p.startsWith(configDir + '/') || p.startsWith(configDir + '\\'));
    if (k) out.set(p, k);
  };
  for (const p of paths) await walk(resolve(cwd, p));
  return [...out].map(([abs, kind]) => ({ abs, kind }));
}

/**
 * What `eztest lint` looks at without paths: the journeys folder, the feature folders, and the other parts of
 * the project layout that exist (shared/, config/, eztest.config.*, .env.example).
 */
export function defaultLintPaths(cwd: string, cfg: { journeysDir?: string; featureDirs?: string[] } = {}): string[] {
  const candidates = [cfg.journeysDir ?? 'journeys', ...(cfg.featureDirs ?? []), 'shared', 'config', 'eztest.config.yaml', 'eztest.config.yml', 'eztest.config.json', '.env.example'];
  const present = [...new Set(candidates)].filter((p) => existsSync(resolve(cwd, p)));
  return present.length ? present : [cfg.journeysDir ?? 'journeys'];
}

/** Lint files and directories. Journeys are parsed with the EZTest grammar; features, code and data are read as text. */
export async function lintPaths(paths: string[], o: LintOptions = {}): Promise<LintReport> {
  const cwd = o.cwd ?? process.cwd();
  const files = await collect(paths, cwd);
  const findings: LintFinding[] = [];
  const facts: JourneyFacts[] = [];
  const { loadJourneyFile } = await import('../intent/index.js');
  // Step definitions, per project folder when the config scopes them (bddScopes), read once per set of globs.
  const indexes = new Map<string, Promise<StepIndex>>();
  const stepsFor = (abs: string): Promise<StepIndex> => {
    const scope = (o.bddScopes ?? [])
      .filter((s) => { const r = relative(resolve(cwd, s.dir), abs); return !r.startsWith('..') && !isAbsolute(r); })
      .sort((a, b) => b.dir.length - a.dir.length)[0];
    const opts: LintOptions = scope ? { ...o, bdd: { ...o.bdd, steps: scope.steps } } : o;
    const key = JSON.stringify(opts.bdd?.steps ?? []);
    if (!indexes.has(key)) indexes.set(key, loadStepIndex(cwd, opts));
    return indexes.get(key)!;
  };
  for (const { abs, kind } of files) {
    const rel = relative(cwd, abs) || abs;
    findings.push(...lintLayout(rel, kind, cwd, o));
    if (kind === 'data' && extname(abs).toLowerCase() === '.xlsx') {
      findings.push(...(await lintDataFile(abs, rel, undefined, o)));
      continue;
    }
    const text = await readFile(abs, 'utf8');
    if (kind === 'code') {
      findings.push(...lintCode(text, rel, o));
      const code = journeyFacts.code(text, rel);
      facts.push(...code.facts);
      findings.push(...applySeverities(code.findings, o));
      continue;
    }
    if (kind === 'feature') {
      const f = lintFeature(text, abs, rel, await stepsFor(abs), o);
      findings.push(...f.findings);
      facts.push(...f.facts);
      continue;
    }
    if (kind === 'data' || kind === 'config' || kind === 'env') {
      findings.push(...(await lintDataFile(abs, rel, text, o)));
      continue;
    }
    try {
      const j = await loadJourneyFile(abs);
      findings.push(...checkLayout(rel, 'journey', cwd, o));
      findings.push(...lintJourney(j, rel, text, o));
      facts.push(journeyFacts.journey(j, rel, text));
    } catch (e) {
      const ext = extname(abs).toLowerCase();
      if ((ext === '.json' && !/"steps"\s*:/.test(text)) || ((ext === '.yaml' || ext === '.yml') && !/^steps\s*:/m.test(text))) {
        // Data, element repositories and other YAML/JSON next to journeys: checked for secrets only.
        findings.push(...checkLayout(rel, 'yaml', cwd, o));
        findings.push(...(await lintDataFile(abs, rel, text, o)));
        continue;
      }
      findings.push(...applySeverities([finding('parse-error', rel, { message: (e as Error).message.split('\n')[0], suggestion: 'run eztest validate for details' })], o));
    }
  }
  findings.push(...lintProject(facts, o));
  findings.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule));
  const counts: Record<LintSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return { files: files.length, fileList: files.map((f) => relative(cwd, f.abs) || f.abs), findings, counts };
}

// ------------------------------------------------------------------ output

export function formatText(r: LintReport): string {
  const out: string[] = [];
  for (const f of r.findings) {
    out.push(`${f.file}${f.line ? `:${f.line}${f.column ? `:${f.column}` : ''}` : ''}  ${f.severity.padEnd(7)} ${f.rule.padEnd(22)} ${f.message}`);
    out.push(`    fix: ${f.suggestion}`);
    if (f.doc) out.push(`    see: ${f.doc}`);
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
      tool: { driver: { name: 'eztest-lint', informationUri: 'https://example.invalid/eztest/docs/project-guide.md', rules: Object.entries(LINT_RULES).map(([id, d]) => ({ id, shortDescription: { text: d.summary }, helpUri: d.doc, defaultConfiguration: { level: level(d.severity) } })) } },
      results: r.findings.map((f) => ({
        ruleId: f.rule, level: level(f.severity), message: { text: `${f.message}. Fix: ${f.suggestion}` },
        locations: [{ physicalLocation: { artifactLocation: { uri: f.file.replace(/\\/g, '/') }, ...(f.line ? { region: { startLine: f.line, ...(f.column ? { startColumn: f.column } : {}) } } : {}) } }],
      })),
    }],
  }, null, 2);
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/**
 * JUnit XML for CI test views (Azure DevOps PublishTestResults, Jenkins, GitLab): one test case per file,
 * failed when the file has errors or warnings (each listed with line, rule, fix and guide section); info
 * findings go to the test case's output.
 */
export function formatJunit(r: LintReport): string {
  const byFile = new Map<string, LintFinding[]>();
  for (const f of r.fileList ?? []) byFile.set(f, []);
  for (const f of r.findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  const cases: string[] = [];
  let failures = 0;
  const line = (f: LintFinding) => `${f.file}${f.line ? `:${f.line}` : ''} ${f.severity} ${f.rule}: ${f.message}\n  fix: ${f.suggestion}${f.doc ? `\n  see: ${f.doc}` : ''}`;
  for (const [file, list] of [...byFile].sort((a, b) => a[0].localeCompare(b[0]))) {
    const bad = list.filter((f) => f.severity !== 'info');
    const info = list.filter((f) => f.severity === 'info');
    const parts = [`    <testcase classname="eztest.lint" name="${xml(file)}">`];
    if (bad.length) {
      failures++;
      const e = bad.filter((f) => f.severity === 'error').length;
      parts.push(`      <failure type="lint" message="${xml(`${e} error(s), ${bad.length - e} warning(s): ${[...new Set(bad.map((f) => f.rule))].join(', ')}`)}">${xml(bad.map(line).join('\n'))}</failure>`);
    }
    if (info.length) parts.push(`      <system-out>${xml(info.map(line).join('\n'))}</system-out>`);
    parts.push('    </testcase>');
    cases.push(parts.join('\n'));
  }
  const n = byFile.size;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="eztest lint" tests="${n}" failures="${failures}" errors="0">\n  <testsuite name="eztest lint" tests="${n}" failures="${failures}" errors="0" skipped="0">\n${cases.join('\n')}\n  </testsuite>\n</testsuites>\n`;
}

/** Exit code for CI: 1 when there are errors, or more warnings than allowed. */
export function lintExitCode(r: LintReport, maxWarnings?: number): number {
  if (r.counts.error > 0) return 1;
  if (maxWarnings !== undefined && r.counts.warning > maxWarnings) return 1;
  return 0;
}
