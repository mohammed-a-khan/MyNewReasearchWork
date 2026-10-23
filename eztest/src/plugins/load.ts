/**
 * Plugin loading from `plugins:` in config: npm package names (resolved from
 * the project directory) or local paths (relative to it). Each plugin's API
 * version is checked before its setup runs.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EzTestError, silentLogger, type Logger } from '../core/index.js';
import { createPluginApi, PLUGIN_API_VERSION, type EzPlugin } from './api.js';
import { firstPartyPlugins } from './publishers/index.js';

export type PluginSpec = string | { name: string; options?: Record<string, unknown> };

export interface LoadedPlugins {
  plugins: Array<{ name: string; version?: string; source: string }>;
  /** Undo every registration (tests, Studio reload). */
  off(): void;
}

function isPath(s: string): boolean {
  return s.startsWith('.') || isAbsolute(s) || /\.(m?js|cjs|ts|mts)$/.test(s);
}

async function importPlugin(spec: string, cwd: string): Promise<{ mod: Record<string, unknown>; source: string }> {
  let url: string;
  if (isPath(spec)) {
    const abs = resolve(cwd, spec);
    if (!existsSync(abs)) throw new EzTestError(`Plugin file not found: ${spec} (resolved to ${abs})`, 'PLUGIN_NOT_FOUND');
    url = pathToFileURL(abs).href;
  } else {
    try {
      url = pathToFileURL(createRequire(join(cwd, 'package.json')).resolve(spec)).href;
    } catch {
      throw new EzTestError(`Plugin package "${spec}" is not installed in ${cwd} (npm install ${spec})`, 'PLUGIN_NOT_FOUND');
    }
  }
  return { mod: (await import(url)) as Record<string, unknown>, source: url };
}

/** Validate a plugin object; throws a clear error for an API version mismatch. */
export function checkPlugin(p: unknown, from: string): EzPlugin {
  const plugin = p as Partial<EzPlugin> | undefined;
  if (!plugin || typeof plugin !== 'object' || typeof plugin.setup !== 'function' || typeof plugin.name !== 'string') {
    throw new EzTestError(`${from} is not an EZTest plugin: export default definePlugin({ name, apiVersion, setup })`, 'PLUGIN_INVALID');
  }
  if (typeof plugin.apiVersion !== 'number') throw new EzTestError(`Plugin ${plugin.name} does not declare apiVersion (this EZTest provides plugin API v${PLUGIN_API_VERSION})`, 'PLUGIN_API_VERSION');
  if (plugin.apiVersion !== PLUGIN_API_VERSION) {
    throw new EzTestError(
      `Plugin ${plugin.name} targets plugin API v${plugin.apiVersion}, but this EZTest provides v${PLUGIN_API_VERSION}. ` +
        (plugin.apiVersion > PLUGIN_API_VERSION ? 'Upgrade EZTest, or use an older version of the plugin.' : 'Upgrade the plugin to a version written for this EZTest.'),
      'PLUGIN_API_VERSION',
    );
  }
  return plugin as EzPlugin;
}

/** Register the first-party plugins (Slack, Teams and Jira publishers). Idempotent. */
let firstPartyOff: (() => void) | undefined;
export async function registerFirstPartyPlugins(o: { cwd?: string; logger?: Logger } = {}): Promise<void> {
  if (firstPartyOff) return;
  const offs: Array<() => void> = [];
  for (const p of firstPartyPlugins) await p.setup(createPluginApi({ cwd: o.cwd ?? process.cwd(), logger: o.logger ?? silentLogger, offs }), {});
  firstPartyOff = () => offs.reverse().forEach((f) => f());
}

export async function loadPlugins(specs: PluginSpec[], o: { cwd: string; logger?: Logger }): Promise<LoadedPlugins> {
  await registerFirstPartyPlugins(o);
  const offs: Array<() => void> = [];
  const loaded: LoadedPlugins['plugins'] = [];
  try {
    for (const s of specs) {
      const name = typeof s === 'string' ? s : s.name;
      const options = typeof s === 'string' ? {} : (s.options ?? {});
      const { mod, source } = await importPlugin(name, o.cwd);
      const plugin = checkPlugin(mod.default ?? mod.plugin, name);
      const api = createPluginApi({ cwd: o.cwd, logger: o.logger ?? silentLogger, offs });
      try {
        await plugin.setup(api, options);
      } catch (e) {
        throw new EzTestError(`Plugin ${plugin.name} failed to set up: ${(e as Error).message}`, 'PLUGIN_SETUP');
      }
      loaded.push({ name: plugin.name, version: plugin.version, source });
    }
  } catch (e) {
    offs.reverse().forEach((f) => f());
    throw e;
  }
  return { plugins: loaded, off: () => offs.reverse().forEach((f) => f()) };
}
