/**
 * Authoring services for the Studio: journey discovery, multi-error
 * validation with line numbers and suggestions, grammar hints, conversion
 * between .ez / YAML / JSON and new-journey templates.
 */
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import type { Journey } from '../core/index.js';
import {
  INTENT_RULES,
  IntentParseError,
  journeyToEzScript,
  loadJourneyFile,
  normalizeJourneyInput,
  parseEzScript,
  tryParseCondition,
} from '../intent/index.js';
import { findJourneyFiles } from '../cli/journeys.js';
import { codeJourneyTemplate, isCodePath, scanCodeJourneys } from './code.js';
import { featureEntry, featureTemplate, validateFeatureSyntax } from './bdd.js';
import { relPosix } from './security.js';
import { journeyKind } from '../runner/manual.js';
import { lintJourney, scoreTarget, type LintFinding } from '../lint/index.js';

/** "ts": code journeys, code steps and screens (eztest/sdk). "feature": Gherkin feature files (docs/bdd.md). */
export type JourneyFormat = 'ez' | 'yaml' | 'json' | 'ts' | 'feature';

export function formatOf(path: string): JourneyFormat {
  if (/\.feature$/i.test(path)) return 'feature';
  if (isCodePath(path)) return 'ts';
  const p = path.toLowerCase();
  if (p.endsWith('.ez')) return 'ez';
  if (p.endsWith('.json')) return 'json';
  return 'yaml';
}

export interface JourneyEntry {
  path: string;
  format: JourneyFormat;
  id?: string;
  name?: string;
  tags: string[];
  risk?: number;
  requirements: string[];
  steps?: number;
  /** automated, manual or hybrid (docs/manual-testing.md). */
  kind?: 'automated' | 'manual' | 'hybrid';
  assignee?: string;
  error?: string;
  /**
   * Code journey files: every journey() in the file, with its line. Feature files: every scenario and
   * Examples row (`line` of the scenario, `row` of the Examples row).
   */
  code?: Array<{ id: string; name: string; line: number; row?: number; tags?: string[]; requirements?: string[]; risk?: number }>;
}

/**
 * Journey files under `dir` (and `extraDirs`, e.g. feature folders outside it) with their metadata
 * (files that fail to parse are listed with an error).
 */
export async function listJourneys(cwd: string, dir: string, extraDirs: string[] = []): Promise<JourneyEntry[]> {
  const roots: string[] = [];
  for (const d of [dir, ...extraDirs]) {
    const root = resolve(cwd, d);
    if (existsSync(root) && (await stat(root)).isDirectory()) roots.push(root);
  }
  if (!roots.length) return [];
  const files = await findJourneyFiles(roots, cwd, { code: true });
  const out: JourneyEntry[] = [];
  for (const f of files) {
    const path = relPosix(cwd, f);
    if (/\.feature$/i.test(f)) {
      // Read, not executed: step definitions load only when a scenario runs or is debugged.
      out.push(featureEntry(cwd, f, await readFile(f, 'utf8')));
      continue;
    }
    if (isCodePath(f)) {
      // Read, not executed: the module is loaded only when a run or debug session starts.
      const js = scanCodeJourneys(await readFile(f, 'utf8'));
      if (!js.length) out.push({ path, format: 'ts', tags: [], requirements: [], error: 'No journey() call found' });
      else out.push({ path, format: 'ts', id: js[0].id, name: js.length > 1 ? `${js[0].name} (+${js.length - 1})` : js[0].name, tags: [...new Set(js.flatMap((j) => j.tags))], requirements: [], steps: js.length, code: js });
      continue;
    }
    try {
      const j = await loadJourneyFile(f);
      out.push({ path, format: formatOf(f), id: j.id, name: j.name, tags: j.tags, risk: j.risk, requirements: j.requirements, steps: j.steps.length, kind: journeyKind(j), ...(j.assignee ? { assignee: j.assignee } : {}) });
    } catch (e) {
      out.push({ path, format: formatOf(f), tags: [], requirements: [], error: (e as Error).message });
    }
  }
  return out;
}

export interface ValidationIssue {
  /** 1-based line, when known. */
  line?: number;
  /** 1-based column of the first offending character, when known. */
  column?: number;
  message: string;
  suggestions: string[];
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  journey?: { id: string; name: string; steps: number; tags: string[] };
  /** eztest lint findings (hard waits, fragile XPath, unchecked state changes, plain-text secrets, weak locators). */
  lint?: Array<Pick<LintFinding, 'rule' | 'severity' | 'line' | 'message' | 'suggestion' | 'stepId' | 'score'>>;
  /** Locator quality score per step target (0-100), keyed by step id. */
  locatorScores?: Record<string, { score: number; grade: string; reasons: string[] }>;
}

/** Lint findings and locator scores for a parsed journey (shown in the Studio editor). */
export function lintForEditor(j: Journey, text: string, format: JourneyFormat): Pick<ValidationResult, 'lint' | 'locatorScores'> {
  const lint = lintJourney(j, `journey.${format}`, text).map(({ rule, severity, line, message, suggestion, stepId, score }) => ({ rule, severity, line, message, suggestion, stepId, score }));
  const locatorScores: NonNullable<ValidationResult['locatorScores']> = {};
  const walk = (steps: Journey['steps']) => {
    for (const st of steps) {
      if (st.target?.locators.length) {
        const sc = scoreTarget(st.target.locators);
        locatorScores[st.id] = { score: sc.score, grade: sc.grade, reasons: sc.reasons };
      }
      walk(st.steps ?? []);
      walk(st.else ?? []);
      walk(st.catch ?? []);
    }
  };
  walk(j.steps);
  return { lint, locatorScores };
}

function lineFromMessage(msg: string): number | undefined {
  const m = /\bline (\d+)\b/.exec(msg);
  return m ? Number(m[1]) : undefined;
}

/**
 * Validate an `.ez` script and report every bad line, not just the first:
 * each failing line is reported, commented out and parsing is retried.
 */
export function validateEz(text: string, source = 'journey.ez'): ValidationResult {
  const lines = text.split(/\r?\n/);
  const errors: ValidationIssue[] = [];
  for (let guard = 0; guard < 200; guard++) {
    try {
      const j = parseEzScript(lines.join('\n'), { source });
      return errors.length
        ? { ok: false, errors }
        : { ok: true, errors, journey: { id: j.id, name: j.name, steps: j.steps.length, tags: j.tags } };
    } catch (e) {
      const err = e as Error;
      const line = err instanceof IntentParseError ? err.lineNumber ?? lineFromMessage(err.message) : lineFromMessage(err.message);
      const suggestions = err instanceof IntentParseError ? err.suggestions : [];
      const column = line !== undefined && line >= 1 && line <= lines.length ? (/^\s*/.exec(lines[line - 1])?.[0].length ?? 0) + 1 : undefined;
      errors.push({ line, column, message: err.message.replace(`${source}:`, '').trim(), suggestions });
      if (line === undefined || line < 1 || line > lines.length || lines[line - 1].trim().startsWith('#')) break;
      lines[line - 1] = '# ' + lines[line - 1];
    }
  }
  errors.sort((a, b) => (a.line ?? 1e9) - (b.line ?? 1e9));
  return { ok: false, errors };
}

/** Parse journey text in any format into a Journey (throws on errors). */
export function parseJourneyText(text: string, format: JourneyFormat, fallbackId = 'journey'): Journey {
  if (format === 'ts') throw new Error('Code journeys are TypeScript: they are loaded when they run, not parsed as steps');
  if (format === 'feature') throw new Error('Feature files are Gherkin: each scenario becomes a journey when it runs (docs/bdd.md)');
  if (format === 'ez') return parseEzScript(text, { source: `${fallbackId}.ez` });
  const raw = format === 'json' ? JSON.parse(text) : YAML.parse(text);
  return normalizeJourneyInput(raw, fallbackId);
}

export function validateText(text: string, format: JourneyFormat): ValidationResult {
  // Syntax here; the editor's validation also binds every step (validateFeatureText, async).
  if (format === 'feature') return validateFeatureSyntax(text);
  if (format === 'ez') {
    const r = validateEz(text);
    if (!r.ok) return r;
    try {
      return { ...r, ...lintForEditor(parseJourneyText(text, 'ez'), text, 'ez') };
    } catch {
      return r;
    }
  }
  if (format === 'ts') {
    // Syntax is checked by validateCode (async, esbuild); here only what a text scan can tell.
    const js = scanCodeJourneys(text);
    return { ok: true, errors: [], ...(js.length ? { journey: { id: js[0].id, name: js[0].name, steps: js.length, tags: js[0].tags } } : {}) };
  }
  try {
    const j = parseJourneyText(text, format);
    return { ok: true, errors: [], journey: { id: j.id, name: j.name, steps: j.steps.length, tags: j.tags }, ...lintForEditor(j, text, format) };
  } catch (e) {
    const err = e as Error & { linePos?: Array<{ line: number; col: number }> };
    let line = err.linePos?.[0]?.line ?? lineFromMessage(err.message);
    let column = err.linePos?.[0]?.col;
    const pos = format === 'json' && line === undefined ? /\bposition (\d+)/.exec(err.message) : null;
    if (pos) {
      const before = text.slice(0, Number(pos[1])).split('\n');
      line = before.length;
      column = before[before.length - 1].length + 1;
    }
    return { ok: false, errors: [{ line, column, message: err.message, suggestions: [] }] };
  }
}

export function convertText(text: string, from: JourneyFormat, to: JourneyFormat): string {
  if (from === 'ts' || to === 'ts') throw new Error('Code journeys (TypeScript) cannot be converted to or from .ez, YAML or JSON');
  if (from === 'feature' || to === 'feature') throw new Error('Feature files run as they are; to turn one into .ez journeys use the Gherkin importer (eztest import)');
  const j = parseJourneyText(text, from);
  if (to === 'ez') return journeyToEzScript(j);
  if (to === 'yaml') return YAML.stringify(j);
  return JSON.stringify(j, null, 2) + '\n';
}

// ------------------------------------------------------------------ grammar

const CATEGORY_OF: Array<[RegExp, string]> = [
  [/^(?:reload|go-back|go-forward|open-url|go-to|start-at|open-element)$/, 'Navigate'],
  [/^login/, 'Log in'],
  [/^(?:double-click|right-click|click|press-element|follow-link|submit|hover)$/, 'Click and mouse'],
  [/^(?:type-into|fill-with|fill-into|set-to|put-in|clear)$/, 'Type'],
  [/^(?:set-select|select-from|uncheck|check|turn-on|turn-off|select-option)$/, 'Choose'],
  [/^press-key/, 'Keyboard'],
  [/^(?:upload|choose-file|download|download-as)$/, 'Files'],
  [/^(?:capture|capture-mode|let-be)$/, 'Capture values'],
  [/^(?:wait|pause)/, 'Wait'],
  [/^(?:call-api|send-request|bare-request)/, 'API'],
  [/^(?:run-query|query-on)$/, 'Database'],
  [/^(?:use-data|given-entity)$/, 'Test data'],
  [/^compare-document$/, 'Documents'],
  [/^(?:assert|check-that|should-see|see|subject-should)$/, 'Assertions'],
  [/^custom-step$/, 'Custom'],
];

/** Grammar category of an intent rule (e.g. "Click and mouse"): the rule's own category, else the name-based table. */
export function categoryOf(rule: { name: string; category?: string }): string {
  return rule.category ?? CATEGORY_OF.find(([re]) => re.test(rule.name))?.[1] ?? 'Other';
}

/** Expectation phrasings (post-conditions after an action). Each is checked against the grammar before it is offered. */
const EXPECTATION_EXAMPLES: Record<string, string[]> = {
  'Page text': ['the page contains "Saved"', 'the page does not contain "Error"', 'I see "Welcome"', 'I do not see "Error"', 'the text "Saved" is visible'],
  'URL and title': ['the URL contains "/orders"', 'the URL matches "orders/\\d+"', 'the URL is "/dashboard"', 'the title contains "Orders"'],
  Elements: ['the Save button is visible', 'the spinner is hidden', 'the Status field has value "Open"', 'the value of the Total field is "10.00"', 'the Heading has text "Orders"', 'the Toast contains "created"'],
  Counts: ['there are 2 rows in the Orders table', 'the Orders table has 2 rows', 'the Results list has 5 items', 'the number of Order rows is 3'],
  'Captured values': ['${orderTotal} equals "148.50"', 'the captured value total is "148.50"'],
  'API, DB, files': ['the orders response status is 200', 'the status of orders is 200', 'the query rows returns 3 rows', 'the download invoice exists'],
};

const HEADERS = [
  'Journey: My journey',
  'Id: my-journey',
  'Description: What this journey proves',
  'Tags: @smoke',
  'Role: manager',
  'Requirements: REQ-1',
  'Risk: 3',
  'Base URL: https://app.test',
  'Variables: currency=EUR, qty=2',
  'Lenses: a11y, security',
  'Data: Customer as customer where region=EU',
];

export interface GrammarGroup {
  category: string;
  kind: 'action' | 'expectation' | 'header';
  examples: Array<{ text: string; keywords: string[]; rule?: string }>;
}

export function grammar(): GrammarGroup[] {
  const groups = new Map<string, GrammarGroup>();
  for (const r of INTENT_RULES) {
    const cat = categoryOf(r);
    const g = groups.get(cat) ?? { category: cat, kind: 'action' as const, examples: [] };
    if (!g.examples.some((x) => x.text === r.example)) g.examples.push({ text: r.example, keywords: r.keywords, rule: r.name });
    groups.set(cat, g);
  }
  const out = [...groups.values()];
  for (const [cat, list] of Object.entries(EXPECTATION_EXAMPLES)) {
    out.push({
      category: `Expect: ${cat}`,
      kind: 'expectation',
      examples: list.filter((t) => tryParseCondition(t) !== undefined).map((t) => ({ text: `Expect ${t}`, keywords: ['expect', 'verify'] })),
    });
  }
  out.push({ category: 'Headers', kind: 'header', examples: HEADERS.map((h) => ({ text: h, keywords: [h.split(':')[0].toLowerCase()] })) });
  return out;
}

export function journeyTemplate(name: string, format: JourneyFormat): string {
  if (format === 'ts') return codeJourneyTemplate(name);
  if (format === 'feature') return featureTemplate(name);
  const clean = name.replace(/[\r\n]+/g, ' ').trim() || 'New journey';
  const ez = [
    `Journey: ${clean}`,
    'Tags: @draft',
    'Risk: 3',
    '',
    '# One step per line. "Expect ..." lines check the outcome of the step above them.',
    'Open /',
    'Expect the page to contain "Welcome"',
    '',
  ].join('\n');
  return format === 'ez' ? ez : convertText(ez, 'ez', format as Exclude<JourneyFormat, 'ts' | 'feature'>);
}

export async function readText(abs: string): Promise<string> {
  return readFile(abs, 'utf8');
}
