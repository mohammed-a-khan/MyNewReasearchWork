/**
 * What `eztest studio` adds when the project is configured for it:
 * - plugin Studio routes (plugin pages are served by src/studio/routes/plugins.ts);
 * - shared team state: with `server:` configured, heal decisions, quarantine and
 *   triage overrides are synced with the results server at start, every minute,
 *   and shortly after the Studio changes one of the local files.
 * The Studio itself stays local-first: without a server, nothing changes.
 */
import { createHash } from 'node:crypto';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../config/index.js';
import { loadPlugins, registries } from '../plugins/index.js';
import type { RouteDef } from '../studio/routes/types.js';
import { eztestDir, pullSharedState, serverClientFor } from './scale.js';
import type { CliIO } from './program.js';

export interface StudioExtras {
  routeDefs: RouteDef[];
  lines: string[];
  close(): void;
}

export async function studioExtras(io: CliIO, env: Record<string, string | undefined>): Promise<StudioExtras> {
  const lines: string[] = [];
  const offs: Array<() => void> = [];
  const hasConfig = ['eztest.config.yaml', 'eztest.config.yml', 'eztest.config.json'].some((f) => existsSync(join(io.cwd, f)));
  if (!hasConfig) return { routeDefs: [], lines, close: () => {} };
  let loaded;
  try {
    loaded = await loadConfig({ cwd: io.cwd, environment: env, env: env.EZTEST_ENV, project: env.EZTEST_PROJECT });
  } catch {
    return { routeDefs: [], lines, close: () => {} };
  }
  // Importer plugins join the Studio's import page (docs/plugins.md, "Importer plugins").
  const pluginSpecs = [...loaded.config.plugins, ...loaded.config.importers.plugins];
  if (pluginSpecs.length) {
    const p = await loadPlugins(pluginSpecs as never, { cwd: io.cwd });
    offs.push(() => p.off());
    lines.push(`plugins: ${p.plugins.map((x) => x.name).join(', ')}`);
  }
  // Plugin pages are served by the Studio's own routes (routes/plugins.ts).
  const routeDefs = registries.studioRoutes.list().flat();

  const client = await serverClientFor(loaded, io.cwd).catch(() => undefined);
  if (client && loaded.config.server?.sharedState !== false) {
    const dir = eztestDir(io.cwd, loaded);
    const files = ['heal-decisions.json', 'quarantine.json', 'triage-overrides.json'];
    const seen = new Map<string, string>();
    const hashAll = async () => {
      for (const f of files) {
        const p = join(dir, f);
        seen.set(f, existsSync(p) ? createHash('sha256').update(await readFile(p)).digest('hex') : '');
      }
    };
    let running: Promise<void> = Promise.resolve();
    const sync = (why: string) => {
      running = running.then(async () => {
        await pullSharedState(loaded, io.cwd, client, (s) => io.err(`warning: ${s}`), (s) => (why === 'start' ? lines.push(s) : undefined), true).catch((e: Error) => io.err(`warning: shared state sync failed: ${e.message}`));
        await hashAll();
      });
      return running;
    };
    await sync('start');
    const timer = setInterval(() => void sync('interval'), 60_000);
    timer.unref();
    offs.push(() => clearInterval(timer));
    let debounce: NodeJS.Timeout | undefined;
    let watcher: FSWatcher | undefined;
    try {
      watcher = watch(dir, async (_e, name) => {
        if (!name || !files.includes(String(name))) return;
        const p = join(dir, String(name));
        const h = existsSync(p) ? createHash('sha256').update(await readFile(p).catch(() => Buffer.alloc(0))).digest('hex') : '';
        if (seen.get(String(name)) === h) return; // our own sync wrote it
        clearTimeout(debounce);
        debounce = setTimeout(() => void sync('change'), 1000);
      });
      offs.push(() => watcher?.close());
    } catch {
      // no .eztest yet: the periodic sync still shares changes
    }
    lines.push(`shared state: synced with ${client.base} (project ${client.project})`);
  }
  return { routeDefs, lines, close: () => offs.reverse().forEach((f) => f()) };
}
