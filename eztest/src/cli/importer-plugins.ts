/**
 * Importer plugins for `eztest import` and Studio's import page: the modules in
 * `importers.plugins` (eztest.config.yaml) plus any given with `--plugin`.
 * See docs/plugins.md, "Importer plugins".
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config/index.js';
import { loadPlugins, type PluginSpec } from '../plugins/index.js';

export interface LoadedImporterPlugins {
  /** Names of the plugins loaded. */
  names: string[];
  /** `importers.options` from config, per importer name. */
  options: Record<string, Record<string, string | boolean>>;
  off(): void;
}

const CONFIG_FILES = ['eztest.config.yaml', 'eztest.config.yml', 'eztest.config.json'];

/** Parse `--importer-option key=value` values (a bare `key` is true). */
export function parseImporterOptions(values: string[] | undefined): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const v of values ?? []) {
    const i = v.indexOf('=');
    if (i < 0) out[v.trim()] = true;
    else out[v.slice(0, i).trim()] = v.slice(i + 1);
  }
  return out;
}

export async function loadImporterPlugins(o: { cwd: string; env: Record<string, string | undefined>; extra?: string[]; warn?: (s: string) => void }): Promise<LoadedImporterPlugins> {
  const specs: PluginSpec[] = [];
  const options: LoadedImporterPlugins['options'] = {};
  if (CONFIG_FILES.some((f) => existsSync(join(o.cwd, f)))) {
    try {
      const loaded = await loadConfig({ cwd: o.cwd, environment: o.env });
      specs.push(...(loaded.config.importers.plugins as PluginSpec[]));
      for (const [name, opts] of Object.entries(loaded.config.importers.options)) {
        options[name] = Object.fromEntries(Object.entries(opts).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v]));
      }
    } catch (e) {
      o.warn?.(`importers.plugins not loaded: the configuration does not load (${(e as Error).message})`);
    }
  }
  specs.push(...(o.extra ?? []));
  if (!specs.length) return { names: [], options, off: () => {} };
  const p = await loadPlugins(specs, { cwd: o.cwd });
  return { names: p.plugins.map((x) => x.name), options, off: () => p.off() };
}
