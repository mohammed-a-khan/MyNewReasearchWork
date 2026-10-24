/**
 * The worker setup of engine runs (`eztest run`, `createEngine(...).run`) with process workers
 * (docs/scale.md): each worker process builds the same handlers the run has (identity, databases,
 * data fabric, documents, healer, lenses, the shared store, integrations, add-ons and plugins) from
 * the run's resolved configuration, so a journey behaves the same in a worker as inline.
 *
 * The configuration crosses as resolved data (no config files are read again), with the secret
 * values the run masks; secrets a worker finds later are handed back to the run's masking.
 */
import type { EzTestConfig, LoadedConfig } from '../config/index.js';
import { SecretMasker } from '../config/masker.js';
import type { WorkerSetupResult } from '../runner/workers/protocol.js';
import type { RunOptions } from '../runner/types.js';

export interface EngineWorkerArgs {
  cwd: string;
  config: EzTestConfig;
  variables: Record<string, string>;
  env?: string;
  project?: string;
  pipeline?: string;
  /** Lenses write visual baselines instead of comparing (eztest run --update-baselines). */
  updateBaselines?: boolean;
  /** Time-travel trace forced on (eztest run --time-travel). */
  timeTravel?: boolean;
  /** eztest run --base-url: wins over journeys' own Base URL. */
  baseUrlOverride?: string;
}

export async function setupEngineWorker(args: EngineWorkerArgs, ctx: { secrets: string[]; onSecret(v: string): void }): Promise<WorkerSetupResult> {
  const { createEngine, enableAddons, lensesFromConfig, a11yLensOptions } = await import('./index.js');
  const { loadPlugins } = await import('../plugins/load.js');
  const masker = new SecretMasker();
  masker.addAll(ctx.secrets);
  masker.observe((v) => ctx.onSecret(v));
  const loaded: LoadedConfig = { config: args.config, warnings: [], sources: [], masker, variables: args.variables, ...(args.env ? { env: args.env } : {}), ...(args.project ? { project: args.project } : {}) };
  const cfg = args.config;
  const addons = await enableAddons(loaded, { cwd: args.cwd });
  const plugins = await loadPlugins((cfg.plugins ?? []) as Parameters<typeof loadPlugins>[0], { cwd: args.cwd });
  const lensOpts = { updateBaselines: !!args.updateBaselines, branchBaselines: cfg.vcs.branchScope.baselines, defaultBranch: cfg.vcs.branchScope.defaultBranch, a11y: a11yLensOptions(cfg) };
  const runOptions: Partial<RunOptions> = {
    lenses: lensesFromConfig(cfg.lenses, args.cwd, lensOpts),
    lensFactory: (spec: string) => lensesFromConfig([spec], args.cwd, lensOpts)[0],
    ...(args.timeTravel ? { timeTravel: { ...cfg.trace.timeTravel, enabled: true, masker } } : {}),
    ...(args.baseUrlOverride ? { baseUrlOverride: args.baseUrlOverride } : {}),
  };
  const engine = await createEngine(loaded, { cwd: args.cwd, addons, ...(args.pipeline ? { pipeline: args.pipeline } : {}), runOptions });
  return {
    options: engine.runOptions,
    async close() {
      try {
        await engine.store.releaseOutstanding().catch(() => undefined);
        await engine.close();
      } finally {
        addons.off();
        plugins.off();
      }
    },
  };
}
