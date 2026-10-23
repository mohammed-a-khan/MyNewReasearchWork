/** Journey discovery and filtering shared by CLI commands. */
import { readdir, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { Journey } from '../core/index.js';
import { loadJourneyFile } from '../intent/index.js';
import { applyLocatorSidecar, loadLocatorSidecar, SIDECAR_RE } from '../heal/apply.js';
import { isCodeJourneyFile, loadCodeJourneys } from '../runner/code-journeys.js';

const EXTENSIONS = new Set(['.ez', '.yaml', '.yml', '.json']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.eztest', 'dist', 'eztest-results']);
/** Files that live next to journeys but are not journeys (reports, configs, manifests). */
const NOT_JOURNEYS = /^(?:import-report\.json|package(?:-lock)?\.json|tsconfig.*\.json|eztest\.config\.(?:ya?ml|json)|readiness-policy\.ya?ml|.*\.template\.ya?ml)$/i;

/**
 * Journey files under `paths`. With `code: true`, code journeys (`*.journey.ts`,
 * `*.journey.js`, eztest/sdk) are included too.
 */
export async function findJourneyFiles(paths: string[], cwd: string, o: { code?: boolean } = {}): Promise<string[]> {
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
    }
  }
  for (const p of paths) await walk(resolve(cwd, p));
  return [...new Set(out)];
}

export interface LoadedJourneys {
  journeys: Journey[];
  errors: Array<{ file: string; message: string }>;
}

/** The journeys in one file: one for `.ez`/YAML/JSON, one per `journey()` call in a code journey file. */
export async function loadJourneysFromFile(file: string, cwd: string): Promise<Journey[]> {
  if (isCodeJourneyFile(file)) return loadCodeJourneys(file, { cwd });
  return [await loadJourneyFile(file)];
}

export async function loadJourneys(paths: string[], cwd: string): Promise<LoadedJourneys> {
  const files = await findJourneyFiles(paths, cwd, { code: true });
  const journeys: Journey[] = [];
  const errors: LoadedJourneys['errors'] = [];
  for (const file of files) {
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

/** Keep journeys that have any of `tags` and none of `exclude`; `grep` matches id or name. */
export function filterJourneys(js: Journey[], f: { tags?: string[]; exclude?: string[]; grep?: string; ids?: string[] }): Journey[] {
  const want = (f.tags ?? []).map(normTag).filter(Boolean);
  const not = (f.exclude ?? []).map(normTag).filter(Boolean);
  const re = f.grep ? new RegExp(f.grep, 'i') : undefined;
  return js.filter((j) => {
    const tags = j.tags.map(normTag);
    if (want.length && !want.some((t) => tags.includes(t))) return false;
    if (not.some((t) => tags.includes(t))) return false;
    if (re && !re.test(j.id) && !re.test(j.name)) return false;
    if (f.ids?.length && !f.ids.includes(j.id)) return false;
    return true;
  });
}
