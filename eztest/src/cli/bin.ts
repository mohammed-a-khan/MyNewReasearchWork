#!/usr/bin/env node
import { buildProgram } from './program.js';

/** Plugins may add CLI commands; load them (best effort) before the command line is parsed. */
async function preloadPluginCommands(): Promise<void> {
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const cwd = process.cwd();
  if (!['eztest.config.yaml', 'eztest.config.yml', 'eztest.config.json'].some((f) => existsSync(join(cwd, f)))) return;
  try {
    const { loadConfig } = await import('../config/index.js');
    const loaded = await loadConfig({ cwd, environment: process.env });
    // Importer plugins may add commands too, and their formats show in `eztest import --help`.
    const specs = [...loaded.config.plugins, ...loaded.config.importers.plugins];
    if (!specs.length) return;
    const { loadPlugins } = await import('../plugins/index.js');
    await loadPlugins(specs as never, { cwd });
  } catch {
    // Commands that load the config report problems themselves.
  }
}

preloadPluginCommands()
  .then(() => buildProgram().parseAsync(process.argv))
  .catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`eztest: ${msg}\n`);
    process.exitCode = 1;
  });
