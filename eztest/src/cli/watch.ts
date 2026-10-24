/**
 * `eztest run --watch`: after the first run, watch the journey files and
 * re-run the journey that changed together with every journey that calls it
 * (`Run journey`, transitively). Saves are debounced; Ctrl+C stops watching.
 */
import { watch, type FSWatcher } from 'node:fs';
import { extname, resolve } from 'node:path';
import type { Journey } from '../core/index.js';
import { loadConfig } from '../config/index.js';
import { loadJourneyFile } from '../intent/index.js';
import { affectedJourneys } from '../scale/watch.js';
import { defaultJourneyPaths, findJourneyFiles } from './journeys.js';
import { isFeatureFile, loadFeatureJourneys } from '../bdd/load.js';
import type { CliIO } from './program.js';

const EXT = new Set(['.ez', '.yaml', '.yml', '.json', '.feature']);

/** The journeys of a changed file (a feature has one per scenario and Examples row). */
async function journeysOf(f: string, cwd: string): Promise<Journey[]> {
  return isFeatureFile(f) ? loadFeatureJourneys(f, { cwd }) : [await loadJourneyFile(f)];
}

async function dirsFor(paths: string[], cwd: string, o: { config?: string; env?: string; project?: string }, env: Record<string, string | undefined>): Promise<string[]> {
  if (paths.length) return paths.map((p) => resolve(cwd, p));
  const loaded = await loadConfig({ cwd, configFile: o.config, env: o.env, project: o.project, environment: env });
  return defaultJourneyPaths(loaded.config, cwd).map((p) => resolve(cwd, p));
}

/** journey id -> file, for the watched paths. */
export async function journeyFileMap(paths: string[], cwd: string, o: { config?: string; env?: string; project?: string }, env: Record<string, string | undefined> = process.env): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of await findJourneyFiles(await dirsFor(paths, cwd, o, env), cwd, { features: true })) {
    try {
      for (const j of await journeysOf(f, cwd)) out.set(j.id, f);
    } catch {
      // invalid files are reported by the run itself
    }
  }
  return out;
}

export async function watchAndRerun(
  io: CliIO,
  paths: string[],
  o: { config?: string; env?: string; project?: string },
  last: () => { all: Journey[]; files: Map<string, string> } | undefined,
  rerun: (ids: string[]) => Promise<void>,
  opts: { signal?: AbortSignal; debounceMs?: number } = {},
): Promise<void> {
  const dirs = await dirsFor(paths, io.cwd, o, io.env);
  const ac = new AbortController();
  const stop = () => ac.abort();
  opts.signal?.addEventListener('abort', stop, { once: true });
  if (!opts.signal) {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  const flush = () => {
    const files = [...pending];
    pending.clear();
    running = running.then(async () => {
      const changed: Journey[] = [];
      const fileOf = new Map<string, string>();
      for (const f of files) {
        try {
          for (const j of await journeysOf(f, io.cwd)) {
            changed.push(j);
            fileOf.set(j.id, f);
          }
        } catch (e) {
          io.err(`error: ${f}: ${(e as Error).message}`);
        }
      }
      if (!changed.length) return;
      const state = last();
      const all = state?.all ?? changed;
      const fileMap = new Map(state?.files ?? []);
      for (const j of changed) fileMap.set(j.id, fileOf.get(j.id) ?? '');
      const ids = affectedJourneys(changed, [...all.filter((a) => !changed.some((c) => c.id === a.id)), ...changed], fileMap);
      io.out(`\nwatch: ${files.map((f) => f.slice(io.cwd.length + 1) || f).join(', ')} changed; re-running ${ids.join(', ')}`);
      await rerun(ids).catch((e: Error) => io.err(`error: ${e.message}`));
    });
  };
  const watchers: FSWatcher[] = dirs.map((d) =>
    watch(d, { recursive: true }, (_e, name) => {
      if (!name || !EXT.has(extname(String(name)).toLowerCase())) return;
      pending.add(resolve(d, String(name)));
      clearTimeout(timer);
      timer = setTimeout(flush, opts.debounceMs ?? 300);
    }),
  );
  io.out(`watching ${dirs.join(', ')} for changes (Ctrl+C to stop)`);
  await new Promise<void>((r) => ac.signal.addEventListener('abort', () => r(), { once: true }));
  clearTimeout(timer);
  for (const w of watchers) w.close();
  await running;
}
