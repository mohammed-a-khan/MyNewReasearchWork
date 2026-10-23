/**
 * Gherkin features in the Studio: listing `.feature` files with their
 * scenarios, validating them as you type (syntax with line and column, and
 * for every step the step definition or EZTest phrasing it binds to, or that
 * it is undefined or ambiguous), the step definitions index for autocomplete,
 * and the feature folders of the project.
 *
 * Step definition files are read, never executed: the index is a static scan
 * (src/bdd/diagnostics.ts). Modules load only when a scenario runs or is
 * debugged, as for code journeys.
 */
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { analyzeFeature, scanStepDefinitions, type FeatureDiagnostic, type StaticDefinition, type StaticParameterType } from '../bdd/diagnostics.js';
import { featureDirsFrom, featureJourneys, findGlueFiles, type BddOptions } from '../bdd/load.js';
import { parseGherkinLenient } from '../bdd/gherkin/parser.js';
import { bddOptionsFrom } from '../cli/journeys.js';
import type { JourneyEntry, ValidationResult } from './authoring.js';
import { relPosix } from './security.js';

/** What the Studio needs from its app: the project and its config. */
export interface BddStudioHost {
  cwd: string;
  config(): Promise<{ config: { journeysDir: string; bddDir?: string; bdd?: BddOptions & { features?: string[] } } }>;
}

export async function bddOptionsOf(app: BddStudioHost): Promise<BddOptions> {
  try {
    return bddOptionsFrom((await app.config()).config as Parameters<typeof bddOptionsFrom>[0]);
  } catch {
    return {};
  }
}

/** Feature folders that exist and are not inside the journeys folder (that one is listed anyway). */
export async function extraFeatureDirs(app: BddStudioHost): Promise<string[]> {
  let cfg: { journeysDir: string; bddDir?: string; bdd?: { features?: string[] } };
  try {
    cfg = (await app.config()).config;
  } catch {
    cfg = { journeysDir: 'journeys' };
  }
  const configured = featureDirsFrom(cfg);
  const dirs = configured.length ? configured : ['features'];
  const jd = resolve(app.cwd, cfg.journeysDir);
  return dirs.filter((d) => {
    const abs = resolve(app.cwd, d);
    const r = relative(jd, abs);
    return existsSync(abs) && (r.startsWith('..') || r === abs);
  });
}

/** The listing entry of a feature file: one `code` entry per scenario and Examples row (the journeys a run makes). */
export function featureEntry(cwd: string, abs: string, text: string): JourneyEntry {
  const path = relPosix(cwd, abs);
  const { document, issues } = parseGherkinLenient(text, abs);
  if (issues.length) return { path, format: 'feature', tags: [], requirements: [], error: `line ${issues[0].line}:${issues[0].column}: ${issues[0].message}` };
  try {
    const js = featureJourneys(text, abs, { cwd });
    const f = document.feature;
    return {
      path, format: 'feature', ...(js[0] ? { id: js[0].id } : {}), name: f?.name || path,
      tags: [...new Set(js.flatMap((j) => j.tags))], requirements: [...new Set(js.flatMap((j) => j.requirements))], steps: js.length,
      code: js.map((j) => ({ id: j.id, name: j.name, line: j.bdd!.scenario.line, ...(j.bdd!.examples?.row ? { row: j.bdd!.examples.row.line } : {}), tags: j.tags, requirements: j.requirements, risk: j.risk })),
      ...(js.length ? {} : { error: 'No scenarios' }),
    };
  } catch (e) {
    return { path, format: 'feature', tags: [], requirements: [], error: (e as Error).message };
  }
}

// ------------------------------------------------------------------ step definitions index (static)

interface IndexedFile {
  sig: string;
  definitions: StaticDefinition[];
  parameterTypes: StaticParameterType[];
}

const fileIndex = new Map<string, IndexedFile>();

export interface DefinitionsIndex {
  files: string[];
  definitions: StaticDefinition[];
  parameterTypes: StaticParameterType[];
}

/** Every step definition written with a literal pattern in the project's step files. */
export async function definitionsIndex(app: BddStudioHost): Promise<DefinitionsIndex> {
  const o = await bddOptionsOf(app);
  const files = await findGlueFiles(app.cwd, o).catch(() => [] as string[]);
  const definitions: StaticDefinition[] = [];
  const parameterTypes: StaticParameterType[] = [];
  for (const f of files) {
    let st;
    try {
      st = await stat(f);
    } catch {
      continue;
    }
    const sig = `${st.size}:${st.mtimeMs}`;
    let hit = fileIndex.get(f);
    if (!hit || hit.sig !== sig) {
      const text = await readFile(f, 'utf8').catch(() => '');
      hit = { sig, ...scanStepDefinitions(text, f) };
      fileIndex.set(f, hit);
    }
    definitions.push(...hit.definitions);
    parameterTypes.push(...hit.parameterTypes);
  }
  return { files: files.map((f) => relPosix(app.cwd, f)), definitions, parameterTypes };
}

/** The validation the editor shows for feature text. */
export interface FeatureValidationResult extends ValidationResult {
  bdd: {
    diagnostics: FeatureDiagnostic[];
    scenarios: Array<{ name: string; line: number; rowLine?: number; tags: string[] }>;
    definitions: number;
  };
}

export async function validateFeatureText(app: BddStudioHost, text: string, path = 'feature.feature'): Promise<FeatureValidationResult> {
  const o = await bddOptionsOf(app);
  const idx = await definitionsIndex(app);
  const a = analyzeFeature(text, resolve(app.cwd, path), {
    definitions: idx.definitions, parameterTypes: idx.parameterTypes, fallback: o.fallback ?? true, ...(o.language ? { language: o.language } : {}),
    display: (f) => relPosix(app.cwd, f),
  });
  const errors = a.diagnostics
    .filter((d) => d.severity === 'error')
    .map((d) => ({ line: d.line, column: d.column, message: d.message, suggestions: [] as string[] }));
  return {
    ok: errors.length === 0,
    errors,
    ...(a.feature ? { journey: { id: a.feature.name, name: a.feature.name || path, steps: a.steps, tags: [...new Set(a.scenarios.flatMap((s) => s.tags))] } } : {}),
    bdd: { diagnostics: a.diagnostics.filter((d) => d.severity !== 'error' || d.kind !== 'syntax'), scenarios: a.scenarios, definitions: idx.definitions.length },
  };
}

/** Syntax-only validation (no step binding), for the problems index. */
export function validateFeatureSyntax(text: string, path = 'feature.feature'): ValidationResult {
  const { issues, document } = parseGherkinLenient(text, path);
  return {
    ok: issues.length === 0,
    errors: issues.map((i) => ({ line: i.line, column: i.column, message: i.message, suggestions: [] })),
    ...(document.feature && !issues.length ? { journey: { id: document.feature.name, name: document.feature.name, steps: 0, tags: document.feature.tags.map((t) => t.name.slice(1)) } } : {}),
  };
}

/** A new feature file. */
export function featureTemplate(name: string): string {
  const clean = name.replace(/[\r\n]+/g, ' ').trim() || 'New feature';
  return [
    '@draft',
    `Feature: ${clean}`,
    '  Describe the business value here.',
    '',
    '  Scenario: The first scenario',
    '    Given I am on "/"',
    '    Then the page contains "Welcome"',
    '',
  ].join('\n');
}
