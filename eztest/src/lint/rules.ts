/**
 * The rules of `eztest lint`: id, default severity, a one-line summary and the
 * section of the EZTest Project Guide (docs/project-guide.md) that explains
 * the rule and how to follow it. Shared by the journey, code and project
 * checks (lint.ts, project.ts) and by the CLI.
 */

export type LintSeverity = 'error' | 'warning' | 'info';

export type LintRule =
  | 'hard-wait' | 'absolute-xpath' | 'positional-xpath' | 'text-only-locator' | 'missing-postcondition'
  | 'plaintext-secret' | 'weak-locator' | 'unsafe-xpath-quotes' | 'parse-error'
  | 'raw-selector' | 'repeated-selector' | 'no-assertion' | 'missing-tags' | 'missing-id' | 'duplicate-id'
  | 'undefined-step' | 'ambiguous-step' | 'undeclared-dependency' | 'hardcoded-host' | 'outside-layout';

/** Where the guide explains a rule (relative to the package root; the package ships docs/). */
const GUIDE = 'docs/project-guide.md';

export const LINT_RULES: Record<LintRule, { severity: LintSeverity; summary: string; doc: string }> = {
  'hard-wait': { severity: 'warning', summary: 'fixed sleeps make suites slow and still flaky', doc: `${GUIDE}#no-fixed-waits` },
  'absolute-xpath': { severity: 'warning', summary: 'absolute XPath breaks on any layout change', doc: `${GUIDE}#locators` },
  'positional-xpath': { severity: 'warning', summary: 'positional XPath depends on element order', doc: `${GUIDE}#locators` },
  'text-only-locator': { severity: 'warning', summary: 'visible-text locators break on translated UIs', doc: `${GUIDE}#locators` },
  'missing-postcondition': { severity: 'warning', summary: 'state-changing, submitting or navigating action with nothing checked after it', doc: `${GUIDE}#assertions-after-every-meaningful-action` },
  'plaintext-secret': { severity: 'error', summary: 'secret written in plain text', doc: `${GUIDE}#secrets` },
  'weak-locator': { severity: 'info', summary: 'target has only weak locators', doc: `${GUIDE}#locators` },
  'unsafe-xpath-quotes': { severity: 'error', summary: 'value put into an XPath string without safe quoting', doc: `${GUIDE}#locators` },
  'parse-error': { severity: 'error', summary: 'file could not be parsed', doc: `${GUIDE}#lint-rules` },
  'raw-selector': { severity: 'warning', summary: 'target found only by CSS or XPath, not by its name, label or test id', doc: `${GUIDE}#locators` },
  'repeated-selector': { severity: 'warning', summary: 'the same raw selector written in several steps instead of one element entry', doc: `${GUIDE}#the-element-repository` },
  'no-assertion': { severity: 'warning', summary: 'journey that checks nothing', doc: `${GUIDE}#assertions-after-every-meaningful-action` },
  'missing-tags': { severity: 'warning', summary: 'journey without tags (no suite or module to select it by)', doc: `${GUIDE}#tags-ids-risk-and-requirements` },
  'missing-id': { severity: 'warning', summary: 'journey without an explicit id (history and test cases follow the id)', doc: `${GUIDE}#tags-ids-risk-and-requirements` },
  'duplicate-id': { severity: 'error', summary: 'two journeys with one id', doc: `${GUIDE}#tags-ids-risk-and-requirements` },
  'undefined-step': { severity: 'error', summary: 'Gherkin step that no step definition matches and that is not an EZTest phrasing', doc: `${GUIDE}#bdd-step-definitions` },
  'ambiguous-step': { severity: 'error', summary: 'Gherkin step that several step definitions match', doc: `${GUIDE}#bdd-step-definitions` },
  'undeclared-dependency': { severity: 'warning', summary: 'journey that uses a value another journey captures, without Depends on:', doc: `${GUIDE}#independent-journeys` },
  'hardcoded-host': { severity: 'warning', summary: 'absolute URL in a journey or step instead of baseUrl or an environment variable', doc: `${GUIDE}#environments-and-hosts` },
  'outside-layout': { severity: 'warning', summary: 'file outside the project layout', doc: `${GUIDE}#the-project-layout` },
};

export const LINT_RULE_IDS = Object.keys(LINT_RULES) as LintRule[];

export interface LintFinding {
  rule: LintRule;
  severity: LintSeverity;
  file: string;
  line?: number;
  column?: number;
  message: string;
  /** How to fix it. */
  suggestion: string;
  /** Where the rule is explained (docs/project-guide.md#...). */
  doc?: string;
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
  /** Step definition globs and the plain-English fallback, for undefined-step / ambiguous-step (config bdd:). */
  bdd?: { steps?: string[]; fallback?: boolean; language?: string };
  /**
   * Step definitions per folder: a feature under `dir` binds to `steps` only (each project's journeysDir and
   * bdd.steps, so two applications' definitions of one phrase are not ambiguous). Others use `bdd`.
   */
  bddScopes?: Array<{ dir: string; steps: string[] }>;
  /** Names of configuration variables (vars:), set for every journey of a run. */
  variables?: string[];
  /** outside-layout: check files against the project layout. auto (default): when the project has an apps/ folder. */
  layout?: boolean | 'auto';
}

/** A finding with the rule's default severity and its guide section. */
export function finding(rule: LintRule, file: string, f: Omit<LintFinding, 'rule' | 'severity' | 'file' | 'doc'>): LintFinding {
  return { rule, severity: LINT_RULES[rule].severity, file, doc: LINT_RULES[rule].doc, ...f };
}

/** Apply configured severities; rules set to "off" are dropped. */
export function applySeverities(list: LintFinding[], o: LintOptions): LintFinding[] {
  return list.flatMap((f) => {
    const s = o.rules?.[f.rule];
    return s === 'off' ? [] : [{ ...f, severity: s ?? f.severity }];
  });
}

// ------------------------------------------------------------------ secrets

export const SECRET_KEY = /(?:^|[_\-.\s])(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|private[_-]?key|master[_-]?key|signing[_-]?key|client[_-]?secret|access[_-]?key|auth(?:orization)?)(?:$|[_\-.\s])/i;
export const SECRET_FIELD = /password|passwd|passcode|pin\b|secret|token|api ?key|one-time code/i;
export const SAFE_SECRET_VALUE = /^\s*(?:\$\{[^}]+\}|\$\$\{[^}]+\}|secret:\/\/|ENC\(|env:|<[^>]+>|\*+|x+|REPLACE_WITH|CHANGE_?ME|TODO)/i;
export const SECRET_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, 'a JSON Web Token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, 'a GitHub token'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'a private key'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/, 'a bearer token'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:[^\s@'"$]{3,}@/i, 'credentials in a URL'],
];

/** A name that holds a secret: password, apiToken, CLIENT_SECRET, db.pwd ... (camelCase is split first). */
export function isSecretName(k: string): boolean {
  return SECRET_KEY.test(`_${k.replace(/([a-z0-9])([A-Z])/g, '$1_$2')}_`);
}

/** Redact a secret for display: first 2 characters and the length. */
export function redact(v: string): string {
  return v.length <= 4 ? '****' : `${v.slice(0, 2)}… (${v.length} chars)`;
}
