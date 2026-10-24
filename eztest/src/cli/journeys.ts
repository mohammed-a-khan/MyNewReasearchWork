/** Journey discovery and filtering shared by CLI commands. */
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { Journey } from '../core/index.js';
import { loadJourneyFile } from '../intent/index.js';
import { applyLocatorSidecar, loadLocatorSidecar, SIDECAR_RE } from '../heal/apply.js';
import { isCodeJourneyFile, loadCodeJourneys } from '../runner/code-journeys.js';
import { featureDirsFrom, isFeatureFile, loadFeatureJourneys, type BddOptions } from '../bdd/load.js';
import { tagFilterFrom } from '../bdd/tags.js';

const EXTENSIONS = new Set(['.ez', '.yaml', '.yml', '.json']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.eztest', 'dist', 'eztest-results']);
/** Files that live next to journeys but are not journeys (reports, configs, manifests). */
const NOT_JOURNEYS = /^(?:import-report\.json|package(?:-lock)?\.json|tsconfig.*\.json|eztest\.config\.(?:ya?ml|json)|readiness-policy\.ya?ml|.*\.template\.ya?ml)$/i;

/**
 * Journey files under `paths`. With `code: true`, code journeys (`*.journey.ts`,
 * `*.journey.js`, eztest/sdk) and Gherkin features (`*.feature`, docs/bdd.md)
 * are included too (`features: false` leaves the features out).
 */
export async function findJourneyFiles(paths: string[], cwd: string, o: { code?: boolean; features?: boolean } = {}): Promise<string[]> {
  const out: string[] = [];
  async function walk(p: string): Promise<void> {
    const s = await stat(p);
    if (s.isDirectory()) {
      for (const name of (await readdir(p)).sort()) {
        if (SKIP_DIRS.has(name)) continue;
        await walk(join(p, name));
      }
    } else if (EXTENSIONS.has(extname(p).toLowerCase()) && !NOT_JOURNEYS.test(p.split(/[\\/]/).pop() ?? '') && !SIDECAR_RE.test(p)) {
      out.push(p);
    } else if (o.code && isCodeJourneyFile(p)) {
      out.push(p);
    } else if ((o.features ?? o.code) && isFeatureFile(p)) {
      out.push(p);
    }
  }
  for (const p of paths) await walk(resolve(cwd, p));
  return [...new Set(out)];
}

export interface LoadedJourneys {
  journeys: Journey[];
  errors: Array<{ file: string; message: string }>;
}

/**
 * The journeys in one file: one for `.ez`/YAML/JSON, one per `journey()` call in a code journey file,
 * one per scenario (and Examples row) of a `.feature` file.
 */
export async function loadJourneysFromFile(file: string, cwd: string, o: { bdd?: BddOptions } = {}): Promise<Journey[]> {
  if (isCodeJourneyFile(file)) return loadCodeJourneys(file, { cwd });
  if (isFeatureFile(file)) return loadFeatureJourneys(file, { ...(o.bdd ?? {}), cwd });
  return [await loadJourneyFile(file)];
}

export async function loadJourneys(paths: string[], cwd: string, o: { bdd?: BddOptions } = {}): Promise<LoadedJourneys> {
  const files = await findJourneyFiles(paths, cwd, { code: true });
  const journeys: Journey[] = [];
  const errors: LoadedJourneys['errors'] = [];
  for (const file of files) {
    if (isFeatureFile(file)) {
      try {
        journeys.push(...(await loadFeatureJourneys(file, { ...(o.bdd ?? {}), cwd })));
      } catch (e) {
        errors.push({ file, message: e instanceof Error ? e.message : String(e) });
      }
      continue;
    }
    if (isCodeJourneyFile(file)) {
      try {
        journeys.push(...(await loadCodeJourneys(file, { cwd })));
      } catch (e) {
        errors.push({ file, message: e instanceof Error ? e.message : String(e) });
      }
      continue;
    }
    try {
      const j = await loadJourneyFile(file);
      // Locators accepted from the Studio's heal inbox that the journey text cannot express.
      const side = await loadLocatorSidecar(file);
      journeys.push(side ? applyLocatorSidecar(j, side) : j);
    } catch (e) {
      errors.push({ file, message: e instanceof Error ? e.message : String(e) });
    }
  }
  const seen = new Map<string, string>();
  for (const j of journeys) {
    if (seen.has(j.id)) errors.push({ file: j.id, message: `Duplicate journey id "${j.id}"` });
    seen.set(j.id, j.id);
  }
  return { journeys, errors };
}

const normTag = (t: string) => t.trim().replace(/^@/, '').toLowerCase();

/**
 * Keep journeys that have any of `tags` and none of `exclude`; `grep` matches id or name.
 * A `tags` entry may be a tag expression (`@smoke and not @wip`, `(@a or @b) and not @slow`).
 */
export function filterJourneys(js: Journey[], f: { tags?: string[]; exclude?: string[]; grep?: string; ids?: string[] }): Journey[] {
  const wantTags = tagFilterFrom(f.tags);
  const not = (f.exclude ?? []).map(normTag).filter(Boolean);
  const re = f.grep ? new RegExp(f.grep, 'i') : undefined;
  return js.filter((j) => {
    const tags = j.tags.map(normTag);
    if (wantTags && !wantTags(tags)) return false;
    if (not.some((t) => tags.includes(t))) return false;
    if (re && !re.test(j.id) && !re.test(j.name)) return false;
    if (f.ids?.length && !f.ids.includes(j.id)) return false;
    return true;
  });
}

/** The config's BDD settings (`bdd:`, `bddDir:`) as loader options. */
export function bddOptionsFrom(cfg: { bddDir?: string; bdd?: { features?: string[]; steps?: string[]; fallback?: boolean; language?: string; worldParameters?: Record<string, unknown> } }): BddOptions {
  const b = cfg.bdd ?? {};
  const features = featureDirsFrom(cfg);
  return {
    ...(features.length ? { features } : {}),
    ...(b.steps?.length ? { steps: b.steps } : {}),
    ...(b.fallback !== undefined ? { fallback: b.fallback } : {}),
    ...(b.language ? { language: b.language } : {}),
    ...(b.worldParameters && Object.keys(b.worldParameters).length ? { worldParameters: b.worldParameters } : {}),
  };
}

/**
 * What `eztest run` / `validate` look at without paths: journeysDir, then the feature folders
 * (`bddDir`, `bdd.features`, else `features/` when it exists). Missing folders are left out
 * unless none exists.
 */
export function defaultJourneyPaths(cfg: { journeysDir: string; bddDir?: string; bdd?: { features?: string[] } }, cwd: string): string[] {
  const configured = featureDirsFrom(cfg);
  const features = configured.length ? configured : ['features'];
  const all = [...new Set([cfg.journeysDir, ...features])];
  const present = all.filter((p) => existsSync(resolve(cwd, p)));
  return present.length ? present : [cfg.journeysDir];
}
