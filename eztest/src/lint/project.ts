/**
 * The project-level checks of `eztest lint` (docs/project-guide.md): Gherkin
 * features against the project's step definitions (read as text, never
 * executed), code journeys' ids and tags, plain-text secrets in test data,
 * config layers and `.env.example`, the project layout, and the rules that
 * need every journey at once: duplicate ids, raw selectors written again and
 * again, and values one journey takes from another without `Depends on:`.
 */
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node as YamlNode } from 'yaml';
import type { Journey, Step, Target } from '../core/index.js';
import { flattenSteps } from '../core/index.js';
import { analyzeFeature, scanStepDefinitions, type StaticDefinition, type StaticParameterType } from '../bdd/diagnostics.js';
import { featureJourneys, findGlueFiles } from '../bdd/load.js';
import { scanCodeJourneys } from '../studio/code.js';
import {
  applySeverities, finding, isSecretName, redact, SAFE_SECRET_VALUE, SECRET_VALUE_PATTERNS,
  type LintFinding, type LintOptions,
} from './rules.js';

type Add = Omit<LintFinding, 'severity' | 'file' | 'doc'>;

// ------------------------------------------------------------------ facts about journeys (for cross-file rules)

export interface JourneyFacts {
  id: string;
  name: string;
  file: string;
  line?: number;
  style: 'journey' | 'feature' | 'code';
  /** A Setup: / Teardown: journey: its Returns are run-wide values every journey may use. */
  runWide: boolean;
  /** `${name}` the journey reads, with the first line. */
  uses: Array<{ name: string; line?: number }>;
  /** Names the journey sets itself (variables, params, Examples columns, data aliases, captures, loop variables). */
  sets: Set<string>;
  /** Names it captures or returns (what another journey could take from it). */
  produces: Set<string>;
  /** Its Examples come from a file or a query: any name may be a column. */
  openInputs: boolean;
  /** `Depends on:` prerequisites, by id or name. */
  dependsOn: string[];
  /** Raw selectors written in steps: css=, xpath=, testid=. */
  selectors: Array<{ key: string; line?: number }>;
}

const USE = /\$\{\s*([A-Za-z_][\w]*)(?!\s*\()/g;

function firstLine(lines: string[], needle: string): number | undefined {
  const i = lines.findIndex((l) => l.includes(needle));
  return i >= 0 ? i + 1 : undefined;
}

function rawSelectorsOf(t: Target | undefined): string[] {
  if (!t || t.element) return [];
  return t.locators.filter((c) => c.strategy === 'css' || c.strategy === 'xpath' || c.strategy === 'testId').map((c) => `${c.strategy === 'testId' ? 'testid' : c.strategy}=${c.value}`);
}

function ownText(s: Step): string {
  const { steps: _s, else: _e, catch: _c, ...own } = s;
  return JSON.stringify(own);
}

export const journeyFacts = {
  /** Facts of an `.ez`, YAML or JSON journey. */
  journey(j: Journey, file: string, text: string): JourneyFacts {
    const lines = text.split(/\r?\n/);
    const steps = flattenSteps(j.steps);
    const sets = new Set<string>([...Object.keys(j.variables), ...(j.params ?? []), ...j.data.map((d) => d.as), 'error', 'item', 'row', 'index', 'i']);
    for (const row of j.examples ?? []) for (const k of Object.keys(row)) sets.add(k);
    for (const r of j.requires ?? []) if (r.kind === 'data' && r.as) sets.add(r.as);
    for (const d of j.dependsOn ?? []) for (const k of d.take) sets.add(k);
    for (const a of Object.keys(j.actors ?? {})) sets.add(a);
    const produces = new Set<string>(j.returns ?? []);
    const uses = new Map<string, number | undefined>();
    const selectors: JourneyFacts['selectors'] = [];
    for (const s of steps) {
      if (s.captureAs) {
        sets.add(s.captureAs);
        produces.add(s.captureAs);
      }
      if (s.flow?.as) sets.add(s.flow.as);
      for (const m of ownText(s).matchAll(USE)) if (!uses.has(m[1])) uses.set(m[1], firstLine(lines, `\${${m[1]}`));
      const targets = [s.target, s.to, ...s.postconditions.flatMap((c) => [('target' in c ? c.target : undefined) as Target | undefined, ('of' in c ? c.of : undefined) as Target | undefined])];
      for (const t of targets) for (const key of rawSelectorsOf(t)) selectors.push({ key, line: firstLine(lines, key.slice(0, 60)) ?? firstLine(lines, key.replace(/^\w+=/, '').slice(0, 60)) });
    }
    const idLine = lines.findIndex((l) => /^\s*(?:id\s*:|"id"\s*:)/i.test(l));
    return {
      id: j.id, name: j.name, file, line: idLine >= 0 ? idLine + 1 : 1, style: 'journey', runWide: j.tags.includes('setup') || j.tags.includes('teardown'),
      uses: [...uses].map(([name, line]) => ({ name, line })), sets, produces, openInputs: !!j.examplesFrom,
      dependsOn: (j.dependsOn ?? []).map((d) => d.journey), selectors,
    };
  },

  /** Facts and id/tag findings of the code journeys in a source file (read as text). */
  code(text: string, file: string): { facts: JourneyFacts[]; findings: LintFinding[] } {
    if (!/\.journey\.(?:ts|mts|js|mjs)$/i.test(file)) return { facts: [], findings: [] };
    const facts: JourneyFacts[] = [];
    const findings: LintFinding[] = [];
    for (const j of scanCodeJourneys(text)) {
      facts.push({ id: j.id, name: j.name, file, line: j.line, style: 'code', runWide: false, uses: [], sets: new Set(), produces: new Set(), openInputs: true, dependsOn: [], selectors: [] });
      if (!j.explicitId) findings.push(finding('missing-id', file, { line: j.line, message: `code journey "${j.name}" has no explicit id (it gets "${j.id}" from its name, which changes when it is renamed)`, suggestion: `add id: '${j.id}' to its options: journey('${j.name}', { id: '${j.id}', tags: [...] }, ...)` }));
      if (!j.tags.length) findings.push(finding('missing-tags', file, { line: j.line, message: `code journey "${j.name}" has no tags, so no suite or module selects it`, suggestion: "add tags: ['@regression', '@<module>'] to its options" }));
    }
    return { facts, findings };
  },
};

// ------------------------------------------------------------------ Gherkin features

export interface StepIndex {
  definitions: StaticDefinition[];
  parameterTypes: StaticParameterType[];
}

/** The project's step definitions with literal patterns, read as text (config bdd.steps globs, else the defaults). */
export async function loadStepIndex(cwd: string, o: LintOptions): Promise<StepIndex> {
  const files = await findGlueFiles(cwd, o.bdd?.steps?.length ? { steps: o.bdd.steps } : {}).catch(() => [] as string[]);
  const definitions: StaticDefinition[] = [];
  const parameterTypes: StaticParameterType[] = [];
  for (const f of files) {
    const scan = scanStepDefinitions(await readFile(f, 'utf8').catch(() => ''), f);
    definitions.push(...scan.definitions);
    parameterTypes.push(...scan.parameterTypes);
  }
  return { definitions, parameterTypes };
}

const STEP_LINE = /^\s*(?:Given|When|Then|And|But|\*)\s/;

export function lintFeature(text: string, abs: string, rel: string, idx: StepIndex, o: LintOptions): { findings: LintFinding[]; facts: JourneyFacts[] } {
  const out: LintFinding[] = [];
  const add = (f: Add & { rule: LintFinding['rule'] }) => out.push(finding(f.rule, rel, f));
  const cwd = o.cwd ?? process.cwd();
  const a = analyzeFeature(text, abs, {
    definitions: idx.definitions, parameterTypes: idx.parameterTypes, fallback: o.bdd?.fallback ?? true,
    ...(o.bdd?.language ? { language: o.bdd.language } : {}), display: (f) => f.startsWith(cwd) ? f.slice(cwd.length + 1).split(sep).join('/') : f,
  });
  if (a.issues.length) {
    const i = a.issues[0];
    add({ rule: 'parse-error', line: i.line, column: i.column, message: i.message, suggestion: 'fix the Gherkin syntax (eztest validate lists every problem)' });
    return { findings: applySeverities(out, o), facts: [] };
  }
  for (const d of a.diagnostics) {
    if (d.kind === 'undefined') add({ rule: 'undefined-step', line: d.line, column: d.column, message: 'no step definition matches this step and it is not an EZTest phrasing', suggestion: `write a step definition (apps/<app>/steps/, or shared/steps/ for steps every app uses), or use an EZTest phrasing. Snippet:\n${d.snippet ?? ''}` });
    if (d.kind === 'ambiguous') add({ rule: 'ambiguous-step', line: d.line, column: d.column, message: d.message, suggestion: 'make the patterns distinct, or keep one definition (a step shared by apps belongs in shared/steps/)' });
  }
  // Scenario identity: @id: and tags, once per scenario (outline rows share them).
  const seen = new Set<number>();
  for (const s of a.scenarios) {
    if (seen.has(s.line)) continue;
    seen.add(s.line);
    const tags = s.tags.filter((t) => !/^@?id:/i.test(t));
    if (!s.tags.some((t) => /^@?id:/i.test(t))) add({ rule: 'missing-id', line: s.line, message: `scenario "${s.name}" has no @id: tag (its id comes from the file path and the scenario name)`, suggestion: 'tag the scenario with a stable id, e.g. @id:web-orders-place-order; history, quarantine and test cases follow it' });
    if (!tags.length) add({ rule: 'missing-tags', line: s.line, message: `scenario "${s.name}" has no tags (on it, its rule or its feature)`, suggestion: 'tag the feature with its module (@orders) and the scenario with its suite (@smoke, @regression)' });
  }
  text.split(/\r?\n/).forEach((l, i) => {
    if (STEP_LINE.test(l) && /["']https?:\/\//i.test(l)) add({ rule: 'hardcoded-host', line: i + 1, message: `step "${l.trim().slice(0, 80)}" names a fixed host`, suggestion: 'use a path ("/orders") under the environment\'s baseUrl' });
  });
  let journeys: Journey[] = [];
  try {
    journeys = featureJourneys(text, abs, { cwd });
  } catch {
    /* reported above as a syntax problem when the parser finds one */
  }
  const facts = journeys.map((j): JourneyFacts => ({
    id: j.id, name: j.name, file: rel, line: j.bdd?.examples?.row?.line ?? j.bdd?.scenario.line, style: 'feature', runWide: false,
    uses: [], sets: new Set(), produces: new Set(), openInputs: true, dependsOn: [], selectors: [],
  }));
  return { findings: applySeverities(out, o), facts };
}

// ------------------------------------------------------------------ secrets in data, config and .env.example

/** Keys named like secrets that hold settings, not secrets (tokenUrl, passwordType, secretStores, clientAuth, ...). */
const NOT_SECRET_KEY = /(?:type|kind|name|url|uri|field|fields|label|header|endpoint|prefix|length|count|expires?(?:_?in)?|policy|regex|pattern|hint|placeholder|selector|locator|rotation|stores?|file|path|dir|auth|method|grant|mode|format|ttl|minutes|seconds|hours|days|margin|refresh)$/i;
const NOT_A_SECRET_VALUE = /^(?:true|false|null|none|yes|no|on|off|bearer|basic|error|warning|info)$/i;

function secretValue(key: string, value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const v = String(value).trim();
  if (!v || !isSecretName(key) || NOT_SECRET_KEY.test(key) || SAFE_SECRET_VALUE.test(v) || NOT_A_SECRET_VALUE.test(v)) return undefined;
  return v;
}

const valueHit = (v: unknown) => (typeof v === 'string' ? SECRET_VALUE_PATTERNS.find(([re]) => re.test(v)) : undefined);

const SECRET_FIX = 'keep secrets out of files: secret://env/NAME (from .env, which git ignores, or the pipeline), ENC(...) (eztest secret encrypt) or a vault reference; data files name the role or ${VAR} instead of the password';

/** Plain-text secrets in a data file (CSV, TSV, XLSX, JSON), a YAML file (data, elements, config layers) or `.env.example`. */
export async function lintDataFile(abs: string, rel: string, text: string | undefined, o: LintOptions): Promise<LintFinding[]> {
  const out: LintFinding[] = [];
  const add = (f: Omit<Add, 'rule'>) => out.push(finding('plaintext-secret', rel, f));
  const ext = extname(abs).toLowerCase();
  const base = abs.split(/[\\/]/).pop() ?? '';
  if (/^\.env\./i.test(base)) {
    (text ?? '').split(/\r?\n/).forEach((l, i) => {
      const m = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*)$/.exec(l);
      if (!m || l.trim().startsWith('#')) return;
      const v = secretValue(m[1], m[2].replace(/^(['"])(.*)\1$/, '$2'));
      if (v) add({ line: i + 1, message: `${m[1]} has a value in ${base} (${redact(v)}); the example names the secrets, the values live in .env or the pipeline`, suggestion: `leave it empty: ${m[1]}=` });
    });
    return applySeverities(out, o);
  }
  if (ext === '.csv' || ext === '.tsv' || ext === '.xlsx') {
    let rows: Array<Record<string, unknown>>;
    try {
      const { readDataRows } = await import('../runner/flow.js');
      rows = await readDataRows(abs);
    } catch (e) {
      return applySeverities([finding('parse-error', rel, { message: (e as Error).message.split('\n')[0], suggestion: 'fix the data file (one header row, unique column names)' })], o);
    }
    rows.forEach((r, i) => {
      for (const [k, val] of Object.entries(r)) {
        const v = secretValue(k, val);
        const line = ext === '.xlsx' ? undefined : i + 2;
        if (v) add({ ...(line ? { line } : {}), message: `column "${k}" holds a plain-text secret in row ${i + 1} (${redact(v)})`, suggestion: SECRET_FIX });
        else {
          const hit = valueHit(val);
          if (hit) add({ ...(line ? { line } : {}), message: `column "${k}" holds ${hit[1]} in row ${i + 1}`, suggestion: SECRET_FIX });
        }
      }
    });
    return applySeverities(out, o);
  }
  if (text === undefined) return [];
  if (ext === '.json') {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      return applySeverities([finding('parse-error', rel, { message: (e as Error).message, suggestion: 'fix the JSON' })], o);
    }
    const lines = text.split(/\r?\n/);
    const walk = (v: unknown, key: string): void => {
      if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
      if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>).forEach(([k, x]) => walk(x, k));
      const s = secretValue(key, v);
      const hit = s ? undefined : valueHit(v);
      if (s || hit) add({ line: firstLine(lines, `"${key}"`), message: s ? `"${key}" holds a plain-text secret (${redact(s)})` : `"${key}" holds ${hit![1]}`, suggestion: SECRET_FIX });
    };
    walk(doc, '');
    return applySeverities(out, o);
  }
  if (ext === '.yaml' || ext === '.yml') {
    const lc = new LineCounter();
    const doc = parseDocument(text, { lineCounter: lc });
    if (doc.errors.length) return applySeverities([finding('parse-error', rel, { line: lc.linePos(doc.errors[0].pos[0]).line, message: doc.errors[0].message.split('\n')[0], suggestion: 'fix the YAML' })], o);
    const walk = (n: YamlNode | null | undefined, key: string, path: string[]): void => {
      if (!n) return;
      if (isMap(n)) {
        for (const p of n.items) {
          const k = isScalar(p.key) ? String(p.key.value) : '';
          // Field descriptions of a role's login form ("password: Passphrase") name a field, not a secret.
          if (k === 'fields' && path.includes('roles')) continue;
          walk(p.value as YamlNode, k, [...path, k]);
        }
        return;
      }
      if (isSeq(n)) {
        for (const x of n.items) walk(x as YamlNode, key, path);
        return;
      }
      if (isScalar(n)) {
        const s = secretValue(key, n.value);
        const hit = s ? undefined : valueHit(n.value);
        const line = n.range ? lc.linePos(n.range[0]).line : undefined;
        if (s || hit) add({ ...(line ? { line } : {}), message: s ? `${path.join('.')} holds a plain-text secret (${redact(s)})` : `${path.join('.')} holds ${hit![1]}`, suggestion: SECRET_FIX });
      }
    };
    walk(doc.contents as YamlNode, '', []);
    return applySeverities(out, o);
  }
  return [];
}

// ------------------------------------------------------------------ the project layout

export type LayoutKind = 'journey' | 'feature' | 'code-journey' | 'steps' | 'code' | 'data' | 'yaml' | 'config' | 'env';

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Is the layout checked here? auto: when the project has an apps/ folder (the layout of docs/project-guide.md). */
export function layoutActive(cwd: string, o: LintOptions): boolean {
  if (o.layout === false || o.rules?.['outside-layout'] === 'off') return false;
  return o.layout === true || isDir(resolve(cwd, 'apps'));
}

/** Where each kind of file belongs: `apps/<app>/<folder>/...` (and shared/). */
const APP_FOLDERS: Record<LayoutKind, { folders: string[]; nested?: boolean; where: string }> = {
  journey: { folders: ['journeys'], nested: true, where: 'apps/<app>/journeys/<module>/' },
  feature: { folders: ['features'], nested: true, where: 'apps/<app>/features/<module>/' },
  'code-journey': { folders: ['code'], nested: true, where: 'apps/<app>/code/<module>/' },
  steps: { folders: ['steps'], where: 'apps/<app>/steps/ (or shared/steps/)' },
  code: { folders: ['steps', 'screens', 'helpers', 'code'], where: 'apps/<app>/screens/, helpers/ or steps/ (or shared/)' },
  data: { folders: ['data'], nested: true, where: 'apps/<app>/data/<env>/ (or data/common/, shared/data/)' },
  yaml: { folders: ['elements', 'data'], where: 'apps/<app>/elements/ (element repository) or apps/<app>/data/<env>/' },
  config: { folders: [], where: 'config/' },
  env: { folders: [], where: 'the project root' },
};

/** outside-layout: a test file that is not where the project layout puts it. */
export function checkLayout(rel: string, kind: LayoutKind, cwd: string, o: LintOptions): LintFinding[] {
  if (!layoutActive(cwd, o) || rel.startsWith('..')) return [];
  const p = rel.split(sep).join('/').split('/');
  const msg = (why: string) => applySeverities([finding('outside-layout', rel, { message: why, suggestion: `move it to ${APP_FOLDERS[kind].where} (docs/project-guide.md, "The project layout")` })], o);
  if (kind === 'config' || kind === 'env') return [];
  if (p[0] === 'apps') {
    if (p.length < 4) return msg(`${rel} is not inside one of the application's folders`);
    const want = APP_FOLDERS[kind];
    if (!want.folders.includes(p[2])) return msg(`a ${kind === 'yaml' ? 'YAML/JSON' : kind} file in apps/${p[1]}/${p[2]}/`);
    // Journeys, features and code journeys sit in a module folder; data in a folder per environment.
    if (want.nested && p.length < 5) return msg(kind === 'data' ? 'test data belongs in a folder per environment (data/<env>/) or data/common/' : `${kind === 'journey' ? 'journeys' : kind === 'feature' ? 'features' : 'code journeys'} sit in a module folder (${p.slice(0, 3).join('/')}/<module>/)`);
    return [];
  }
  if (p[0] === 'shared') {
    if (kind === 'journey' || kind === 'feature' || kind === 'code-journey') return msg('journeys belong to an application (apps/<app>/), not to shared/');
    return [];
  }
  // Elsewhere (plugins/, tools/, the root): only test assets are out of place.
  if (kind === 'journey' || kind === 'feature' || kind === 'code-journey' || kind === 'steps' || kind === 'data') return msg(`${rel} is outside apps/ and shared/`);
  return [];
}

/** The layout check by file kind, as lintPaths sees files (YAML and JSON journeys are told apart later). */
export function lintLayout(rel: string, kind: 'journey' | 'code' | 'feature' | 'data' | 'config' | 'env', cwd: string, o: LintOptions): LintFinding[] {
  if (kind === 'journey') return []; // decided after loading (journey or data/elements YAML): see lintPaths
  if (kind === 'code') {
    const k: LayoutKind = /\.journey\.(?:ts|mts|js|mjs)$/i.test(rel) ? 'code-journey' : /\.steps\.(?:ts|mts|js|mjs)$/i.test(rel) ? 'steps' : 'code';
    return checkLayout(rel, k, cwd, o);
  }
  return checkLayout(rel, kind, cwd, o);
}

// ------------------------------------------------------------------ cross-file rules

export function lintProject(facts: JourneyFacts[], o: LintOptions): LintFinding[] {
  const out: LintFinding[] = [];
  // ---- duplicate ids (every style)
  const byId = new Map<string, JourneyFacts[]>();
  for (const f of facts) byId.set(f.id, [...(byId.get(f.id) ?? []), f]);
  for (const [id, list] of byId) {
    if (list.length < 2) continue;
    for (const f of list.slice(1)) {
      out.push(finding('duplicate-id', f.file, { ...(f.line ? { line: f.line } : {}), message: `journey id "${id}" is also used by ${list[0].file}${list[0].line ? `:${list[0].line}` : ''}`, suggestion: 'give every journey its own id; prefix ids with the app and module (web-orders-...) so two apps never collide' }));
    }
  }
  // ---- one raw selector written in several steps
  const bySel = new Map<string, Array<{ file: string; line?: number }>>();
  for (const f of facts) for (const s of f.selectors) bySel.set(s.key, [...(bySel.get(s.key) ?? []), { file: f.file, line: s.line }]);
  for (const [key, uses] of bySel) {
    if (uses.length < 2) continue;
    const where = uses.map((u) => `${u.file}${u.line ? `:${u.line}` : ''}`);
    out.push(finding('repeated-selector', uses[0].file, { ...(uses[0].line ? { line: uses[0].line } : {}), message: `${key.slice(0, 80)} is written ${uses.length} times (${[...new Set(where)].slice(0, 4).join(', ')}${where.length > 4 ? ', ...' : ''})`, suggestion: 'add it once to the element repository (apps/<app>/elements/<screen>.yaml) and use @Screen.element in every step; a changed locator is then one fix' }));
  }
  // ---- a value only another journey captures, taken without Depends on:
  const producers = new Map<string, JourneyFacts[]>();
  const runWide = new Set<string>();
  for (const f of facts) {
    for (const n of f.produces) {
      if (f.runWide) runWide.add(n);
      else producers.set(n, [...(producers.get(n) ?? []), f]);
    }
  }
  const known = new Set(o.variables ?? []);
  for (const f of facts) {
    if (f.style !== 'journey' || f.openInputs) continue;
    for (const u of f.uses) {
      if (f.sets.has(u.name) || known.has(u.name) || runWide.has(u.name)) continue;
      const from = (producers.get(u.name) ?? []).filter((p) => p !== f);
      if (!from.length) continue;
      if (from.some((p) => f.dependsOn.includes(p.id) || f.dependsOn.includes(p.name))) continue;
      const p = from[0];
      out.push(finding('undeclared-dependency', f.file, { ...(u.line ? { line: u.line } : {}), message: `uses \${${u.name}}, which only journey "${p.id}" (${p.file}) captures; nothing in this journey sets it`, suggestion: `create the data in this journey (API setup, a data pool, Data:), or declare the order: "Depends on: ${p.id} with ${u.name}"` }));
    }
  }
  return applySeverities(out, o);
}
