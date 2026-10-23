/**
 * `.feature` files as journeys: each scenario, and each Examples row of an
 * outline, becomes one Journey. Its steps are the Gherkin steps (action
 * "code", handler "bdd"); the runner binds them to step definitions or to
 * EZTest phrasings when the scenario runs (src/runner/bdd-run.ts).
 *
 * Loading a feature only reads files: step definition modules are imported
 * when a scenario runs or is validated, never when journeys are listed.
 */
import { readFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { EzTestError, Journey, slugify, type JourneyInput, type StepInput } from '../core/index.js';
import { expandGlobs } from '../insights/glob.js';
import { loadCodeModule } from '../runner/code-journeys.js';
import { compilePickles, type Pickle } from './gherkin/compile.js';
import { parseGherkin } from './gherkin/parser.js';
import { fileRegistrations, glueOf, setFileRegistrations, type Glue } from './registry.js';

/** BDD settings (config `bdd:` and `bddDir:`). */
export interface BddOptions {
  /** Feature folders or files. */
  features?: string[];
  /** Step definition globs, relative to the project. */
  steps?: string[];
  fallback?: boolean;
  language?: string;
  worldParameters?: Record<string, unknown>;
}

export const FEATURE_RE = /\.feature$/i;

export function isFeatureFile(path: string): boolean {
  return FEATURE_RE.test(path);
}

export const DEFAULT_STEP_GLOBS = ['**/*.steps.{ts,mts,js,mjs}', '**/step_definitions/**/*.{ts,mts,js,mjs}', '**/step-definitions/**/*.{ts,mts,js,mjs}'];

const CODE_FILE = /\.(?:ts|mts|js|mjs)$/i;

/** Step definition files of a project (absolute, sorted). Nothing is executed. */
export async function findGlueFiles(cwd: string, o: BddOptions = {}): Promise<string[]> {
  const globs = o.steps?.length ? o.steps : DEFAULT_STEP_GLOBS;
  const files = await expandGlobs(globs, cwd);
  return files.filter((f) => CODE_FILE.test(f) && !/\.d\.[mc]?ts$/i.test(f) && !/\.journey\.(?:ts|mts|js|mjs)$/i.test(f));
}

const glueCache = new Map<string, { at: number; files: string[] }>();

/** findGlueFiles, cached for a few seconds (one `eztest run` loads many features). */
async function glueFiles(cwd: string, o: BddOptions): Promise<string[]> {
  const key = `${cwd}\u0000${(o.steps ?? []).join('\u0000')}`;
  const hit = glueCache.get(key);
  if (hit && Date.now() - hit.at < 5000) return hit.files;
  const files = await findGlueFiles(cwd, o);
  glueCache.set(key, { at: Date.now(), files });
  return files;
}

/** Folders of feature files from the config (`bdd.features`, `bddDir`). */
export function featureDirsFrom(cfg: { bddDir?: string; bdd?: { features?: string[] } }): string[] {
  return [...new Set([...(cfg.bddDir ? [cfg.bddDir] : []), ...(cfg.bdd?.features ?? [])])];
}

const posix = (p: string) => p.split(sep).join('/');

/** The id prefix of a feature file: its path without the extension (a leading "features/" dropped), slugified. */
export function featureIdBase(file: string, cwd: string): string {
  let rel = posix(relative(cwd, file)).replace(FEATURE_RE, '');
  if (rel.startsWith('..')) rel = basename(rel);
  rel = rel.replace(/^(?:features|feature|specs?|bdd)\//i, '');
  return slugify(rel.replace(/\//g, '-')) || 'feature';
}

const META_TAG = /^@(id|req|requirement|risk|role):(.+)$/i;

function journeyFor(p: Pickle, file: string, cwd: string, o: BddOptions, glue: string[], ids: Map<string, number>, rowNo: number | undefined): Journey {
  // `@id:` only sets the journey id; the other meta tags (@req:, @risk:, @role:) stay tags as well.
  const tags = p.tags.filter((t) => !/^@id:/i.test(t)).map((t) => t.replace(/^@/, ''));
  const meta = p.tags.map((t) => META_TAG.exec(t)).filter((m): m is RegExpExecArray => !!m);
  const metaOf = (k: string) => meta.filter((m) => m[1].toLowerCase() === k).map((m) => m[2]);
  const scenarioId = metaOf('id').at(-1) ?? `${featureIdBase(file, cwd)}--${slugify(p.scenario.name) || `l${p.scenario.line}`}`;
  let id = rowNo !== undefined ? `${scenarioId}-${rowNo}` : scenarioId;
  const n = (ids.get(id) ?? 0) + 1;
  ids.set(id, n);
  if (n > 1) id = `${id}-l${p.examples?.row?.line ?? p.scenario.line}`;
  const values = p.examples?.row?.values;
  const named = values && p.scenario.name.includes('<') ? p.name : values ? `${p.name} [${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(', ')}]` : p.name;
  const stepIds = new Map<string, number>();
  const steps: StepInput[] = p.steps.map((s) => {
    const base = `L${s.line}`;
    const k = (stepIds.get(base) ?? 0) + 1;
    stepIds.set(base, k);
    return {
      id: k > 1 ? `${base}-${k}` : base,
      intent: `${s.keyword} ${s.text}`,
      action: 'code',
      handler: 'bdd',
      value: s.text,
      args: {
        keyword: s.keyword, type: s.type,
        ...(s.background ? { background: true } : {}),
        ...(s.docString ? { docString: s.docString } : {}),
        ...(s.dataTable ? { dataTable: s.dataTable } : {}),
      },
      source: { file, line: s.line, column: s.column },
    };
  });
  const risk = Number(metaOf('risk').at(-1));
  const role = metaOf('role').at(-1);
  const input: JourneyInput = {
    id,
    name: named,
    ...(p.scenario.description || p.feature.description ? { description: (p.scenario.description || p.feature.description).replace(/\s+/g, ' ').trim() } : {}),
    tags,
    requirements: [...metaOf('req'), ...metaOf('requirement')],
    ...(Number.isInteger(risk) && risk >= 1 && risk <= 5 ? { risk } : {}),
    ...(role ? { role } : {}),
    variables: values ?? {},
    ...(p.examples?.source ? { examplesFrom: p.examples.source } : {}),
    code: { file, name: p.name, line: p.examples?.row?.line ?? p.scenario.line },
    bdd: {
      uri: file, language: p.language,
      feature: { keyword: p.feature.keyword, name: p.feature.name, line: p.feature.line, tags: p.feature.tags, ...(p.feature.description ? { description: p.feature.description } : {}) },
      ...(p.rule ? { rule: { keyword: p.rule.keyword, name: p.rule.name, line: p.rule.line, tags: p.rule.tags } } : {}),
      scenario: { keyword: p.scenario.keyword, name: p.scenario.name, line: p.scenario.line, tags: p.scenario.tags, outline: p.scenario.outline },
      ...(p.examples ? {
        examples: {
          keyword: p.examples.keyword, name: p.examples.name, line: p.examples.line, tags: p.examples.tags, index: p.examples.index,
          ...(p.examples.row ? { row: { line: p.examples.row.line, index: p.examples.row.index } } : {}),
        },
      } : {}),
      glue, fallback: o.fallback ?? true,
      ...(o.worldParameters && Object.keys(o.worldParameters).length ? { worldParameters: o.worldParameters } : {}),
    },
    steps: steps.length ? steps : [{ id: 'empty', intent: `${p.scenario.keyword}: ${p.name} (no steps)`, action: 'code', handler: 'bdd', value: '', args: { keyword: '', type: 'context', empty: true } }],
  };
  return Journey.parse(input);
}

/** Journeys of feature text (one per scenario, one per Examples row of an outline). */
export function featureJourneys(text: string, file: string, o: BddOptions & { cwd?: string; glue?: string[] } = {}): Journey[] {
  const cwd = resolve(o.cwd ?? process.cwd());
  const abs = resolve(cwd, file);
  const doc = parseGherkin(text, abs, { ...(o.language ? { language: o.language } : {}) });
  const { pickles } = compilePickles(doc);
  const ids = new Map<string, number>();
  // Row numbers per outline (1-based, across all of its Examples blocks).
  const rows = new Map<number, number>();
  return pickles.map((p) => {
    let rowNo: number | undefined;
    if (p.examples?.row) {
      rowNo = (rows.get(p.scenario.line) ?? 0) + 1;
      rows.set(p.scenario.line, rowNo);
    } else if (p.examples?.source) {
      rowNo = undefined;
      const k = (rows.get(p.scenario.line) ?? 0) + 1;
      rows.set(p.scenario.line, k);
      if (k > 1) rowNo = k;
    }
    return journeyFor(p, abs, cwd, o, o.glue ?? [], ids, rowNo);
  });
}

/** Journeys of a `.feature` file. */
export async function loadFeatureJourneys(file: string, o: BddOptions & { cwd?: string } = {}): Promise<Journey[]> {
  const cwd = resolve(o.cwd ?? process.cwd());
  const abs = resolve(cwd, file);
  const text = await readFile(abs, 'utf8');
  const glue = await glueFiles(cwd, o);
  return featureJourneys(text, abs, { ...o, cwd, glue });
}

// ------------------------------------------------------------------ loading step definitions

let queue: Promise<unknown> = Promise.resolve();
const modules = new Map<string, unknown>();

/**
 * Import step definition files (in order) and return their glue. A file whose
 * module is cached keeps its registrations; a changed file replaces them.
 * Loads are serialised: registrations are attributed to the file being loaded.
 */
export function loadGlue(files: string[], o: { cwd?: string } = {}): Promise<Glue> {
  const run = async (): Promise<Glue> => {
    const errors: string[] = [];
    for (const f of files) {
      const before = fileRegistrations(f);
      setFileRegistrations(f, undefined);
      const prev = modules.get(f);
      try {
        const loaded = await loadCodeModule(f, { cwd: o.cwd ?? dirname(f) });
        if (!fileRegistrations(f) && (prev === undefined || loaded.module === prev)) setFileRegistrations(f, before);
        modules.set(f, loaded.module);
      } catch (e) {
        setFileRegistrations(f, before);
        errors.push(e instanceof EzTestError ? e.message : `${f}: ${(e as Error).message}`);
      }
    }
    const glue = glueOf(files);
    glue.errors.unshift(...errors);
    return glue;
  };
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}
