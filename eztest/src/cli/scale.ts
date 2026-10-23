/**
 * CLI support for running at scale: test selection, sharding, resource locks,
 * shared state, publishing, OTLP export and structured logs for `eztest run`,
 * plus the `merge`, `ci matrix`, `publish`, `server`, `trends` and
 * `upgrade-config` commands.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, join, resolve, isAbsolute } from 'node:path';
import { hostname } from 'node:os';
import { Command, Option } from 'commander';
import { EvidenceVault, type Journey, type RunResult } from '../core/index.js';
import type { LoadedConfig } from '../config/index.js';
import { identityVaultFromConfig } from '../identity/index.js';
import { analyzeImpact, changedFilesFromGit, HistoryStore, loadImpactMapping, type ImpactResult, type RunHistoryEntry } from '../insights/index.js';
import { loadJourneyFile } from '../intent/index.js';
import { analyzeRun } from '../engine/index.js';
import type { ReportFormat } from '../report/index.js';
import {
  ciMatrix, durationsFromHistory, durationsFromRuns, expandRunDirs, FileLockBackend, fmtMs, JourneyLocker, mergeRuns, parseBudget, parseRisk,
  parseShard, selectJourneys, selectShard, verifyMergedRun, type DurationTable, type Selection, type ShardPlan,
  baseJourneyId, failedFirst, lastFailedIds, lastStatuses, repeatJourneys, seededShuffle,
} from '../scale/index.js';
import { ResultsClient, ServerLockBackend, syncSharedState } from '../server/index.js';
import { exportRunTrace } from '../ops/otlp.js';
import { registries, runPublishers, type RunAnalysis } from '../plugins/index.js';
import { upgradeConfigFile } from '../ops/config-migrate.js';
import { expandBrowserMatrix, stripBrowser, type RunLocks } from '../runner/index.js';
import type { CliIO } from './program.js';

type Loader = (o: { config?: string; env?: string; project?: string }) => Promise<LoadedConfig>;

const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);

/** `.eztest` next to the output directory (where history, heal decisions, quarantine live). */
export function eztestDir(cwd: string, loaded: LoadedConfig): string {
  return join(dirname(resolve(cwd, loaded.config.outputDir)), '.eztest');
}

export function secretResolver(loaded: LoadedConfig, cwd: string): (v: string) => Promise<string> {
  let vault: ReturnType<typeof identityVaultFromConfig> | undefined;
  return async (v: string) => {
    if (!v.startsWith('secret://')) return v;
    vault ??= identityVaultFromConfig(loaded.config, { cwd, masker: loaded.masker, env: { ...process.env, ...loaded.variables } });
    const s = await vault.registry.resolve(v);
    loaded.masker.add(s);
    return s;
  };
}

/** A results-server client from `server:` config (or an explicit URL), or undefined. */
export async function serverClientFor(loaded: LoadedConfig, cwd: string, o: { url?: string; project?: string } = {}): Promise<ResultsClient | undefined> {
  const s = loaded.config.server;
  const url = o.url ?? s?.url;
  if (!url) return undefined;
  const tokenRef = s?.token ?? (process.env.EZTEST_SERVER_TOKEN ? 'secret://env/EZTEST_SERVER_TOKEN' : undefined);
  const token = tokenRef ? await secretResolver(loaded, cwd)(tokenRef) : undefined;
  return new ResultsClient({ url, token, project: o.project ?? s?.project ?? loaded.config.project ?? 'default', timeoutMs: s?.timeoutMs });
}

/** Historical durations: from the results server when configured, else the local history file. */
export async function durationTableFor(loaded: LoadedConfig, cwd: string, client: ResultsClient | undefined, warn: (s: string) => void): Promise<DurationTable> {
  if (client) {
    try {
      return await client.durations();
    } catch (e) {
      warn(`durations from the results server unavailable (${(e as Error).message}); using local history`);
    }
  }
  try {
    return durationsFromHistory(await HistoryStore.open(resolve(cwd, '.eztest', 'history.json')));
  } catch (e) {
    warn(`history unreadable (${(e as Error).message}); shards are balanced by count`);
    return durationsFromRuns([]);
  }
}

function repoRoot(cwd: string): string {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', shell: false });
  return r.status === 0 ? r.stdout.trim() : cwd;
}

export interface RunSelectionOptions {
  changedSince?: string;
  onlyFailed?: string;
  risk?: string;
  budget?: string;
  impactMapping?: string;
  shard?: string;
  /** Only the journeys that failed in the last recorded run. */
  lastFailed?: boolean;
  failedFirst?: boolean;
  /** true = a fresh seed (printed), or a seed. */
  shuffle?: boolean | string;
  repeatEach?: number;
  /** true = 5, or a count: repeat only new or changed journeys. */
  burnIn?: boolean | string | number;
}

export interface PreparedSelection {
  journeys: Journey[];
  selection?: Selection;
  plan?: ShardPlan;
  shard?: { index: number; total: number };
  /** Ordering and burn-in applied after selection and sharding. */
  order?: { failedFirst?: boolean; shuffleSeed?: string; repeat?: { times: number; journeys: string[] } };
  lines: string[];
}

/** Run history for selection and ordering: the results server when configured, else the local file. */
async function historyRunsFor(cwd: string, client: ResultsClient | undefined, warn: (s: string) => void): Promise<readonly RunHistoryEntry[]> {
  if (client) {
    try {
      return await client.history();
    } catch (e) {
      warn(`history from the results server unavailable (${(e as Error).message}); using local history`);
    }
  }
  try {
    return (await HistoryStore.open(resolve(cwd, '.eztest', 'history.json'))).runs;
  } catch {
    return [];
  }
}

/**
 * Apply the selection flags (--changed-since, --only-failed, --last-failed, --risk, --budget),
 * then --shard, then ordering (--shuffle, --failed-first) and burn-in (--repeat-each, --burn-in),
 * explaining each decision.
 */
export async function prepareSelection(journeys: Journey[], o: RunSelectionOptions, ctx: { loaded: LoadedConfig; cwd: string; client?: ResultsClient; warn: (s: string) => void }): Promise<PreparedSelection> {
  const lines: string[] = [];
  const wantsSelection = !!(o.changedSince || o.onlyFailed || o.risk || o.budget || o.lastFailed);
  const wantsOrder = !!(o.failedFirst || o.shuffle || (o.repeatEach && o.repeatEach > 1) || o.burnIn);
  if (!wantsSelection && !o.shard && !wantsOrder) return { journeys, lines };
  const table = await durationTableFor(ctx.loaded, ctx.cwd, ctx.client, ctx.warn);
  let historyCache: readonly RunHistoryEntry[] | undefined;
  const history = async () => (historyCache ??= await historyRunsFor(ctx.cwd, ctx.client, ctx.warn));
  const rowsOf = (j: Journey) => j.examples?.length ?? 1;
  let selected = journeys;
  let selection: Selection | undefined;
  let changedJourneyIds: string[] | undefined;
  if (wantsSelection) {
    let impact: ImpactResult | undefined;
    if (o.changedSince) {
      const changed = await changedFilesFromGit({ cwd: ctx.cwd, base: o.changedSince });
      const root = repoRoot(ctx.cwd);
      changedJourneyIds = [];
      for (const f of changed) {
        const abs = resolve(root, f);
        if (!['.ez', '.yaml', '.yml', '.json'].includes(extname(f).toLowerCase()) || !existsSync(abs)) continue;
        try {
          const id = (await loadJourneyFile(abs)).id;
          if (journeys.some((j) => j.id === id)) changedJourneyIds.push(id);
        } catch {
          // not a journey
        }
      }
      const mappingPath = resolve(ctx.cwd, o.impactMapping ?? ctx.loaded.config.selection.impactMapping);
      if (changed.length && existsSync(mappingPath)) {
        impact = analyzeImpact(changed, journeys.map((j) => ({ id: j.id, name: j.name, tags: j.tags, requirements: j.requirements, risk: j.risk })), await loadImpactMapping(mappingPath));
      } else {
        if (!existsSync(mappingPath)) ctx.warn(`no impact mapping at ${mappingPath}: only journeys whose own file changed are selected`);
        impact = { changedFiles: changed, ignoredFiles: [], impacted: [], uncovered: [] } as unknown as ImpactResult;
      }
    }
    let failed: { runId: string; journeyIds: string[] } | undefined;
    if (o.onlyFailed) {
      const runPath = join(resolve(ctx.cwd, o.onlyFailed), 'run.json');
      if (!existsSync(runPath)) throw new Error(`--only-failed: no run.json in ${o.onlyFailed}`);
      const prev = JSON.parse(await readFile(runPath, 'utf8')) as RunResult;
      // Cross-browser units (<id>@<browser>) select their journey.
      const bad = prev.journeys.filter((j) => j.status === 'failed' || j.status === 'error').map((j) => stripBrowser(baseJourneyId(j.journeyId)));
      // Examples rows run as <id>-<row>: select the data-driven journey they came from.
      const ids = new Set<string>();
      for (const b of bad) {
        const hit = journeys.find((j) => j.id === b) ?? journeys.find((j) => j.examples?.length && b.startsWith(`${j.id}-`));
        if (hit) ids.add(hit.id);
      }
      failed = { runId: prev.runId, journeyIds: [...ids] };
    } else if (o.lastFailed) {
      const lf = lastFailedIds(await history(), journeys);
      if (!lf.runId) ctx.warn('--last-failed: no recorded run in the history yet; nothing is selected');
      failed = { runId: lf.runId ?? 'the last run (none recorded)', journeyIds: lf.ids };
    }
    selection = selectJourneys(
      journeys.map((j) => ({ id: j.id, name: j.name, risk: j.risk, rows: rowsOf(j) })),
      { impact, changedJourneyIds, changedSince: o.changedSince, failed, minRisk: o.risk ? parseRisk(o.risk) : undefined, budgetMs: o.budget ? parseBudget(o.budget) : undefined },
      table,
    );
    const keep = new Set(selection.selected);
    selected = journeys.filter((j) => keep.has(j.id));
    lines.push(`selection: ${selection.summary}`);
    for (const d of selection.decisions.filter((x) => x.selected).slice(0, 50)) lines.push(`  + ${d.journeyId}: ${d.reasons.join('; ')}`);
    const dropped = selection.decisions.filter((x) => !x.selected);
    for (const d of dropped.slice(0, 20)) lines.push(`  - ${d.journeyId}: ${d.reasons[d.reasons.length - 1]}`);
    if (dropped.length > 20) lines.push(`  - ...and ${dropped.length - 20} more not selected (see selection.json in the run)`);
  }
  // Cross-browser runs: the plan is journey x browser units, so shards balance units and every machine agrees on them.
  const browserNames = (ctx.loaded.config.browsers ?? []).map((b) => (typeof b === 'string' ? b : b.name).toLowerCase());
  if (browserNames.length > 1) {
    const m = expandBrowserMatrix(selected, browserNames);
    // Journeys whose Browsers: header excludes the whole matrix stay as they are: the runner records why they did not run.
    selected = [...m.journeys, ...m.excluded.map((x) => x.journey)];
    lines.push(`browsers: ${browserNames.join(', ')} (${m.journeys.length} journey x browser units)`);
  }
  let plan: ShardPlan | undefined;
  let shard: { index: number; total: number } | undefined;
  if (o.shard) {
    shard = parseShard(o.shard);
    const r = selectShard(selected.map((j) => ({ id: j.id, locks: j.locks, rows: rowsOf(j), j })), shard, table);
    plan = r.plan;
    selected = r.journeys.map((x) => x.j);
    const mine = plan.shards[shard.index - 1];
    lines.push(`shard ${shard.index}/${shard.total}: ${mine.journeyIds.length} journeys, ~${fmtMs(mine.estimatedMs)} (plan imbalance ${plan.imbalance}; balanced by historical duration)`);
  }
  const order: NonNullable<PreparedSelection['order']> = {};
  if (o.shuffle) {
    const seed = typeof o.shuffle === 'string' ? o.shuffle : String(Math.floor(Math.random() * 1e9));
    selected = seededShuffle(selected, seed);
    order.shuffleSeed = seed;
    lines.push(`order: shuffled with seed ${seed} (reproduce with --shuffle ${seed})`);
  }
  if (o.failedFirst) {
    const last = lastStatuses(await history(), selected.map((j) => j.id));
    selected = failedFirst(selected, last);
    order.failedFirst = true;
    const first = selected.filter((j) => last.get(j.id) === 'failed' || last.get(j.id) === 'error').map((j) => j.id);
    lines.push(`order: failed first (${first.length ? first.join(', ') : 'none failed last time'}), then by risk`);
  }
  const burn = o.burnIn === undefined || o.burnIn === false ? undefined : o.burnIn === true ? 5 : Number(o.burnIn);
  if (burn !== undefined && !(burn >= 2)) throw new Error('--burn-in needs a count of at least 2');
  if ((o.repeatEach && o.repeatEach > 1) || burn) {
    let only: Set<string> | undefined;
    let why = 'every selected journey';
    if (burn && !(o.repeatEach && o.repeatEach > 1)) {
      const known = lastStatuses(await history(), selected.map((j) => j.id));
      only = new Set(selected.filter((j) => !known.has(j.id) || changedJourneyIds?.includes(j.id)).map((j) => j.id));
      why = `new or changed journeys${changedJourneyIds ? '' : ' (pass --changed-since to include changed ones)'}`;
    }
    const times = o.repeatEach && o.repeatEach > 1 ? o.repeatEach : burn!;
    const ids = selected.filter((j) => !only || only.has(j.id)).map((j) => j.id);
    selected = repeatJourneys(selected, times, only);
    order.repeat = { times, journeys: ids };
    lines.push(`burn-in: ${ids.length ? `${ids.join(', ')} run ${times} times each` : 'no journey to repeat'} (${why}); mixed outcomes mark a journey flaky`);
  }
  return { journeys: selected, selection, plan, shard, ...(Object.keys(order).length ? { order } : {}), lines };
}

/** Resource locks for a run, or undefined when no journey declares any. */
export function runLocksFor(journeys: Journey[], loaded: LoadedConfig, cwd: string, client: ResultsClient | undefined): RunLocks | undefined {
  const cfg = loaded.config.locks;
  if (cfg.backend === 'off') return undefined;
  const any = journeys.some((j) => j.locks?.length) || journeys.some((j) => j.examples?.length && j.locks?.length);
  if (!any) return undefined;
  const owner = `${hostname()}:${process.pid}${process.env.EZTEST_SHARD ? `:shard-${process.env.EZTEST_SHARD}` : ''}`;
  const useServer = cfg.backend === 'server' || (cfg.backend === 'auto' && !!client);
  if (cfg.backend === 'server' && !client) throw new Error('locks.backend is "server" but no results server is configured (server.url)');
  const backend = useServer && client
    ? new ServerLockBackend(client, owner, cfg.ttlSeconds * 1000)
    : new FileLockBackend({ dir: isAbsolute(cfg.dir) ? cfg.dir : resolve(cwd, cfg.dir), ttlMs: cfg.ttlSeconds * 1000, owner });
  const locker = new JourneyLocker({ backend, timeoutMs: cfg.timeoutMinutes * 60_000 });
  return { tryAcquire: (j) => locker.tryAcquire(j), timeoutMs: locker.timeoutMs, pollMs: locker.pollMs, describeHolders: (j) => locker.describeHolders(j) };
}

/** Record how the journeys were selected, inside the run's evidence chain, and show it in the reports. */
export async function recordSelection(runDir: string, prepared: PreparedSelection): Promise<void> {
  if (!prepared.selection && !prepared.plan && !prepared.order) return;
  const vault = await EvidenceVault.resume(runDir);
  const body = { selection: prepared.selection, shard: prepared.shard, order: prepared.order, plan: prepared.plan ? { total: prepared.plan.total, imbalance: prepared.plan.imbalance, shards: prepared.plan.shards.map((s) => ({ index: s.index, journeys: s.journeyIds.length, estimatedMs: s.estimatedMs })) } : undefined };
  await vault.store('report', 'selection.json', JSON.stringify(body, null, 2), { description: 'how the journeys of this run were selected' });
  const runPath = join(runDir, 'run.json');
  const run = JSON.parse(await readFile(runPath, 'utf8')) as RunResult;
  run.environment = {
    ...run.environment,
    ...(prepared.selection ? { selection: prepared.selection.summary } : {}),
    ...(prepared.shard ? { shard: `${prepared.shard.index}/${prepared.shard.total}` } : {}),
  };
  run.evidenceHead = vault.headHash;
  await writeFile(runPath, JSON.stringify(run, null, 2));
}

export interface AfterRunOptions {
  publish?: string | boolean;
  otlp?: string;
  pluginReporters: string[];
}

/** Everything after analysis: plugin reporters, OTLP export, results-server publish and publishers. */
export async function afterRun(runDir: string, analysis: RunAnalysis, o: AfterRunOptions, ctx: { loaded: LoadedConfig; cwd: string; client?: ResultsClient; io: CliIO; out: (s: string) => void }): Promise<{ runUrl?: string }> {
  const run = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as RunResult;
  for (const name of o.pluginReporters) {
    const r = registries.reporters.get(name);
    if (!r) {
      ctx.io.err(`warning: unknown reporter "${name}"`);
      continue;
    }
    try {
      for (const f of await r.write({ run, runDir, analysis })) ctx.out(`report ${name}: ${f}`);
    } catch (e) {
      ctx.io.err(`warning: reporter ${name} failed: ${(e as Error).message}`);
    }
  }
  const otlp = o.otlp ?? ctx.loaded.config.telemetry.otlp?.endpoint ?? (ctx.loaded.config.telemetry.otlp ? process.env.OTEL_EXPORTER_OTLP_ENDPOINT : undefined);
  if (otlp) {
    try {
      const r = await exportRunTrace(run, { endpoint: otlp, headers: ctx.loaded.config.telemetry.otlp?.headers, serviceName: ctx.loaded.config.telemetry.otlp?.serviceName });
      ctx.out(`otlp: exported ${r.spans} spans (trace ${r.traceId})`);
    } catch (e) {
      ctx.io.err(`warning: ${(e as Error).message}`);
    }
  }
  let runUrl: string | undefined;
  const publish = o.publish ?? ctx.loaded.config.server?.publish;
  if (publish) {
    const client = typeof publish === 'string' ? await serverClientFor(ctx.loaded, ctx.cwd, { url: publish }) : ctx.client;
    if (!client) ctx.io.err('warning: --publish needs a URL or server.url in the config');
    else {
      try {
        const r = await client.publishRun(runDir, { analysis: analysis as Record<string, unknown>, meta: ciMeta() });
        runUrl = `${client.base}/ui/p/${encodeURIComponent(client.project)}/runs/${encodeURIComponent(r.runId)}`;
        ctx.out(`published ${r.uploaded} files (${Math.round(r.bytes / 1024)} KiB) to ${runUrl}${r.verified ? ' (evidence verified by the server)' : ` - server could NOT verify the evidence: ${r.problems.slice(0, 2).join('; ')}`}`);
      } catch (e) {
        ctx.io.err(`warning: publishing to the results server failed: ${(e as Error).message}`);
      }
    }
  }
  if (ctx.loaded.config.publishers.length) {
    const results = await runPublishers(ctx.loaded.config.publishers as never, { run, runDir, analysis, resolveSecret: secretResolver(ctx.loaded, ctx.cwd), runUrl });
    for (const r of results) (r.ok ? ctx.out : ctx.io.err)(`publish ${r.publisher}: ${r.message}`);
  }
  return { runUrl };
}

/** Branch and commit from common CI variables (GitHub Actions, Azure Pipelines, GitLab). */
export function ciMeta(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const branch = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || env.BUILD_SOURCEBRANCHNAME || env.CI_COMMIT_REF_NAME;
  const commit = env.GITHUB_SHA || env.BUILD_SOURCEVERSION || env.CI_COMMIT_SHA;
  const ciUrl = env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : env.BUILD_BUILDURI;
  return Object.fromEntries(Object.entries({ branch, commit, ciUrl }).filter(([, v]) => v)) as Record<string, string>;
}

/** Pull shared heal decisions / quarantine / triage overrides before a run (local files are the fallback). */
export async function pullSharedState(loaded: LoadedConfig, cwd: string, client: ResultsClient | undefined, warn: (s: string) => void, info: (s: string) => void, push = false): Promise<void> {
  if (!client || loaded.config.server?.sharedState === false) return;
  const reports = await syncSharedState(client, eztestDir(cwd, loaded), { push });
  const failed = reports.filter((r) => r.error);
  for (const r of failed) warn(`shared state ${r.kind}: ${r.error}${r.pulled === 0 ? ' (using local files)' : ''}`);
  const ok = reports.filter((r) => !r.error || r.pulled);
  if (ok.length) info(`shared state from ${client.base}: ${ok.map((r) => `${r.kind} ${r.pulled}${r.pendingLocal ? ` (+${r.pendingLocal} local)` : ''}`).join(', ')}`);
}

export function registerScaleCommands(program: Command, io: CliIO, load: Loader): void {
  const withConfig = (c: Command) => c.option('-c, --config <file>').option('-e, --env <name>').option('--project <name>', 'project overlay (projects.<name>)');

  // ------------------------------------------------------------------ merge
  withConfig(program.command('merge'))
    .description('combine shard runs into one run: one evidence chain linked to each shard chain, combined reports, history, triage and readiness')
    .argument('<runDirs...>', 'shard run directories (or directories that contain them, e.g. downloaded CI artifacts)')
    .requiredOption('-o, --out <dir>', 'merged run directory')
    .option('--run-id <id>', 'merged run id')
    .option('--policy <file>', 'readiness policy (default readiness.policyPath)')
    .option('--reporter <formats>', 'report formats: html,json,junit', list)
    .option('--no-history', 'do not record the merged run into history')
    .option('--allow-unverified', 'merge even when a shard evidence chain does not verify')
    .option('--publish [url]', 'publish the merged run to the results server')
    .option('--otlp <endpoint>', 'export the merged run as an OpenTelemetry trace')
    .action(async (dirs: string[], o) => {
      const loaded = await load(o).catch(() => undefined);
      const runDirs = await expandRunDirs(dirs.map((d) => resolve(io.cwd, d)));
      const r = await mergeRuns(runDirs, resolve(io.cwd, o.out), { runId: o.runId, allowUnverified: !!o.allowUnverified });
      for (const w of r.warnings) io.err(`warning: ${w}`);
      const s = r.run.summary;
      io.out(`merged ${runDirs.length} shard run(s) into ${r.runDir}: ${s.total} journeys, ${s.passed} passed, ${s.passedHealed} passed-healed, ${s.failed} failed, ${s.errors} errors`);
      const v = await verifyMergedRun(r.runDir);
      io.out(`evidence: ${v.ok ? 'VALID' : 'TAMPERED'} merged chain (${v.merged.entries} entries, head ${v.merged.head.slice(0, 16)}...), ${v.shards.filter((x) => x.ok && x.linked).length}/${v.shards.length} shard chains linked`);
      const cfg = loaded?.config;
      const policy = o.policy ?? cfg?.readiness.policyPath;
      const a = await analyzeRun(r.runDir, {
        historyPath: resolve(io.cwd, '.eztest', 'history.json'),
        recordHistory: o.history !== false,
        readinessPolicyPath: policy ? resolve(io.cwd, policy) : undefined,
        formats: (o.reporter ?? ['html', 'json', 'junit']) as ReportFormat[],
      });
      for (const w of a.warnings) io.err(`warning: ${w}`);
      if (a.readiness) io.out(`readiness: ${a.readiness.decision} (score ${a.readiness.score})`);
      for (const [fmt, p] of Object.entries(a.reports)) io.out(`report ${fmt}: ${p}`);
      if (loaded) {
        const client = await serverClientFor(loaded, io.cwd);
        await afterRun(r.runDir, { triage: a.triage, readiness: a.readiness, flaky: a.flaky }, { publish: o.publish, otlp: o.otlp, pluginReporters: [] }, { loaded, cwd: io.cwd, client, io, out: io.out });
      }
      process.exitCode = v.ok ? (s.failed + s.errors > 0 ? 1 : 0) : 1;
    });

  // ------------------------------------------------------------------ ci matrix
  const ci = program.command('ci').description('CI helpers');
  withConfig(ci.command('matrix'))
    .description('print a CI matrix (JSON) of duration-balanced shards for GitHub Actions or Azure DevOps')
    .argument('[paths...]', 'journey files or directories (default: journeysDir)')
    .option('--shards <n>', 'number of shards, or "auto" (from historical durations)', 'auto')
    .addOption(new Option('--provider <name>').choices(['github', 'azure']).default('github'))
    .option('--target <duration>', 'auto: target wall time per shard', '10m')
    .option('--max <n>', 'auto: maximum shards', (v) => parseInt(v, 10), 20)
    .option('-t, --tags <tags>', 'only journeys with any of these tags', list)
    .option('--plan', 'also print the shard plan (journeys per shard) to stderr')
    .action(async (paths: string[], o) => {
      const loaded = await load(o);
      const { loadJourneys, filterJourneys } = await import('./journeys.js');
      const { journeys: all, errors } = await loadJourneys(paths.length ? paths : [loaded.config.journeysDir], io.cwd);
      for (const e of errors) io.err(`error: ${e.file}: ${e.message}`);
      const journeys = filterJourneys(all, { tags: o.tags }).filter((j) => !j.tags.includes('library'));
      const client = await serverClientFor(loaded, io.cwd).catch(() => undefined);
      const table = await durationTableFor(loaded, io.cwd, client, (s) => io.err(`warning: ${s}`));
      const shards = o.shards === 'auto' ? 'auto' : parseInt(o.shards, 10);
      if (shards !== 'auto' && !(shards >= 1)) throw new Error('--shards must be a positive number or "auto"');
      const m = ciMatrix(o.provider, journeys.map((j) => ({ id: j.id, locks: j.locks, rows: j.examples?.length ?? 1 })), table, { shards, targetMs: parseBudget(o.target), max: o.max });
      io.out(JSON.stringify(m.matrix));
      if (o.plan) for (const s of m.plan.shards) io.err(`shard ${s.index}/${m.shards}: ${s.journeyIds.length} journeys, ~${fmtMs(s.estimatedMs)}`);
    });

  // ------------------------------------------------------------------ publish
  withConfig(program.command('publish'))
    .description('publish a run directory to the results server (server.url) and run the configured publishers (Slack, Teams, Jira, plugins)')
    .argument('<runDir>')
    .option('--server <url>', 'results server URL (default server.url)')
    .option('--server-project <name>', 'project on the results server')
    .option('--no-server', 'only run the publishers')
    .option('--only <names>', 'only these publishers (comma separated)', list)
    .option('--dry-run', 'show what each publisher would send; send nothing (and skip the results server)')
    .action(async (runDir: string, o) => {
      const loaded = await load(o);
      const { loadPlugins } = await import('../plugins/index.js');
      const plugins = await loadPlugins(loaded.config.plugins as never, { cwd: io.cwd });
      try {
        const dir = resolve(io.cwd, runDir);
        const run = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as RunResult;
        const analysis = existsSync(join(dir, 'report.json')) ? ((JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as Record<string, unknown>) as RunAnalysis) : {};
        let runUrl: string | undefined;
        let failed = false;
        if (o.server !== false && !o.dryRun) {
          const client = await serverClientFor(loaded, io.cwd, { url: typeof o.server === 'string' ? o.server : undefined, project: o.serverProject });
          if (client) {
            const r = await client.publishRun(dir, { analysis: pickAnalysis(analysis), meta: ciMeta() });
            runUrl = `${client.base}/ui/p/${encodeURIComponent(client.project)}/runs/${encodeURIComponent(r.runId)}`;
            io.out(`published ${r.runId}: ${r.uploaded} files to ${runUrl}${r.verified ? ' (evidence verified)' : ` - NOT verified: ${r.problems.slice(0, 2).join('; ')}`}`);
            failed ||= !r.verified;
          } else if (!loaded.config.publishers.length) {
            io.err('Nothing to publish to: configure server.url or publishers, or pass --server <url>.');
            process.exitCode = 1;
            return;
          }
        }
        const results = await runPublishers(loaded.config.publishers as never, { run, runDir: dir, analysis: pickAnalysis(analysis) as RunAnalysis, resolveSecret: secretResolver(loaded, io.cwd), runUrl, only: o.only, dryRun: !!o.dryRun });
        for (const r of results) {
          (r.ok ? io.out : io.err)(`publish ${r.publisher}: ${r.message}`);
          if (o.dryRun && r.details !== undefined) io.out(JSON.stringify(r.details, null, 2));
        }
        failed ||= results.some((r) => !r.ok);
        process.exitCode = failed ? 1 : 0;
      } finally {
        plugins.off();
      }
    });

  // ------------------------------------------------------------------ jira
  const jira = program.command('jira').description('Jira: requirements traceability from JQL');
  withConfig(jira.command('requirements'))
    .description('pull requirements with JQL and show which no journey covers (connection from the "jira" entry in publishers:)')
    .requiredOption('--jql <query>', 'e.g. project = PAY AND issuetype = Story AND fixVersion = "2026.11"')
    .argument('[paths...]', 'journey files or directories (default: journeysDir)')
    .option('--json', 'print the traceability matrix as JSON')
    .action(async (paths: string[], o) => {
      const loaded = await load(o);
      const spec = loaded.config.publishers.find((p) => p.use === 'jira') as Record<string, unknown> | undefined;
      if (!spec) throw new Error('Add a publishers entry with use: jira (baseUrl, email + apiToken or token) to configure the Jira connection');
      const resolveSecret = secretResolver(loaded, io.cwd);
      const s = (k: string) => (typeof spec[k] === 'string' ? (spec[k] as string) : undefined);
      const { JiraClient, jiraRequirements } = await import('../alm-jira/index.js');
      const client = new JiraClient({ baseUrl: s('baseUrl')!, deployment: s('deployment') as never, email: s('email'), apiToken: s('apiToken') ? await resolveSecret(s('apiToken')!) : undefined, token: s('token') ? await resolveSecret(s('token')!) : undefined });
      const requirements = await jiraRequirements(client, o.jql);
      const { loadJourneys } = await import('./journeys.js');
      const { journeys } = await loadJourneys(paths.length ? paths : [loaded.config.journeysDir], io.cwd);
      const store = await HistoryStore.open(resolve(io.cwd, '.eztest', 'history.json'));
      const latest: Record<string, { status: never; runId: string }> = {};
      for (const j of journeys) {
        const last = store.outcomesFor(j.id).slice(-1)[0];
        if (last) latest[j.id] = { status: last.status as never, runId: last.runId };
      }
      const { computeTraceability } = await import('../insights/index.js');
      const m = computeTraceability({ journeys: journeys.map((j) => ({ id: j.id, name: j.name, requirements: j.requirements, tags: j.tags, risk: j.risk })), latest, requirements });
      if (o.json) {
        io.out(JSON.stringify(m, null, 2));
        return;
      }
      io.out(`${requirements.length} requirement(s) from Jira; coverage ${m.totals.coveragePct}%, ${m.totals.gaps} gap(s)`);
      for (const r of m.rows.filter((x) => x.gap)) io.out(`  GAP ${r.requirement.id}${r.requirement.title ? ` ${r.requirement.title}` : ''}: ${r.gap}`);
      process.exitCode = m.totals.gaps ? 1 : 0;
    });

  // ------------------------------------------------------------------ trends
  program
    .command('trends')
    .description('export run trends from the local history as CSV (pass rate, heals, failures, duration per run)')
    .option('-o, --out <file>', 'write to a file instead of stdout')
    .option('--history <file>', 'history file', '.eztest/history.json')
    .action(async (o: { out?: string; history: string }) => {
      const store = await HistoryStore.open(resolve(io.cwd, o.history));
      const csv = historyCsv(store.runs);
      if (o.out) {
        await mkdir(dirname(resolve(io.cwd, o.out)), { recursive: true });
        await writeFile(resolve(io.cwd, o.out), csv);
        io.out(`wrote ${o.out}: ${store.runs.length} runs`);
      } else io.out(csv.trimEnd());
    });

  // ------------------------------------------------------------------ upgrade-config
  program
    .command('upgrade-config')
    .description('migrate eztest.config.* to the current configuration schema version (keeps comments)')
    .option('-c, --config <file>', 'config file (default eztest.config.yaml|yml|json)')
    .option('--dry-run', 'show what would change without writing')
    .action(async (o: { config?: string; dryRun?: boolean }) => {
      const file = o.config ? resolve(io.cwd, o.config) : ['eztest.config.yaml', 'eztest.config.yml', 'eztest.config.json'].map((f) => join(io.cwd, f)).find((f) => existsSync(f));
      if (!file) {
        io.err('No eztest.config.yaml|yml|json found.');
        process.exitCode = 1;
        return;
      }
      const r = await upgradeConfigFile(file, { write: !o.dryRun });
      for (const c of r.changes) io.out(`  ${c}`);
      io.out(r.changed ? `${o.dryRun ? 'would upgrade' : 'upgraded'} ${file} from configVersion ${r.from} to ${r.to}` : `${file} is already at configVersion ${r.to}; nothing to do`);
    });

  // ------------------------------------------------------------------ server
  const server = program.command('server').description('the optional central results server for teams (dashboards, shared state, locks, audit)');
  server
    .command('start', { isDefault: true })
    .description('start the results server')
    .option('--config <file>', 'server config (default eztest-server.yaml)')
    .option('-p, --port <n>', 'port', (v) => parseInt(v, 10))
    .option('--host <host>', 'interface to bind (default 127.0.0.1; 0.0.0.0 in containers)')
    .option('--data-dir <dir>', 'data directory (SQLite database and run files)')
    .action(async (o: { config?: string; port?: number; host?: string; dataDir?: string }) => {
      const { serveFromConfig } = await import('../server/index.js');
      const overrides: Record<string, unknown> = {};
      if (o.port !== undefined) overrides.port = o.port;
      if (o.host) overrides.host = o.host;
      if (o.dataDir) overrides.dataDir = resolve(io.cwd, o.dataDir);
      const h = await serveFromConfig({ file: o.config, cwd: io.cwd, env: io.env, overrides });
      io.err(`EZTest results server: ${h.url} (Ctrl+C to stop)`);
      await new Promise<void>((done) => {
        const stop = () => void h.close().then(done);
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });
  const token = server.command('token').description('API tokens (operates on the server database directly)');
  token
    .command('create')
    .description('create an API token, e.g. for CI: --grant payments:tester')
    .requiredOption('--name <name>')
    .requiredOption('--grant <project:role...>', 'grants such as payments:tester or *:admin')
    .option('--expires <date>', 'expiry date (ISO)')
    .option('--config <file>', 'server config')
    .action(async (o: { name: string; grant: string[]; expires?: string; config?: string }) => {
      const { loadServerConfig, createToken, AuditLog, ROLES } = await import('../server/index.js');
      const cfg = await loadServerConfig({ file: o.config, cwd: io.cwd, env: io.env });
      const store = await openServerStore(cfg);
      try {
        const grants = o.grant.map((g) => {
          const [project, role] = g.split(':');
          if (!project || !(ROLES as readonly string[]).includes(role)) throw new Error(`--grant ${g}: use <project|*>:<${ROLES.join('|')}>`);
          return { project, role: role as (typeof ROLES)[number] };
        });
        const { token: t, record } = await createToken(store, { name: o.name, grants, createdBy: `cli:${process.env.USER ?? 'admin'}`, expiresAt: o.expires });
        await new AuditLog(store).append({ actor: `cli:${process.env.USER ?? 'admin'}`, action: 'token.create', target: record.id, details: { name: o.name, grants } });
        io.out(t);
        io.err(`token ${record.id} created for ${grants.map((g) => `${g.project}:${g.role}`).join(', ')}; it is shown once - store it as a CI secret`);
      } finally {
        await store.close();
      }
    });
  server
    .command('audit-verify')
    .description('verify the audit log hash chain')
    .option('--config <file>', 'server config')
    .action(async (o: { config?: string }) => {
      const { loadServerConfig, AuditLog } = await import('../server/index.js');
      const store = await openServerStore(await loadServerConfig({ file: o.config, cwd: io.cwd, env: io.env }));
      try {
        const v = await new AuditLog(store).verify();
        io.out(`${v.ok ? 'VALID' : 'TAMPERED'}: ${v.entries} audit entries, head ${v.head.slice(0, 16)}...`);
        for (const p of v.problems) io.err(`  ${p}`);
        process.exitCode = v.ok ? 0 : 1;
      } finally {
        await store.close();
      }
    });
}

async function openServerStore(cfg: Awaited<ReturnType<typeof import('../server/index.js')['loadServerConfig']>>) {
  const { Store } = await import('../server/index.js');
  await mkdir(cfg.dataDir, { recursive: true });
  return Store.open(cfg.database.driver === 'sqlite' ? { driver: 'sqlite', file: cfg.database.file ? resolve(cfg.baseDir, cfg.database.file) : join(cfg.dataDir, 'eztest.db') } : (cfg.database as never));
}

function pickAnalysis(report: object): Record<string, unknown> {
  const r = report as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ['triage', 'readiness', 'flaky']) if (r[k] !== undefined) out[k] = r[k];
  return out;
}

export function historyCsv(runs: readonly { runId: string; startedAt: string; outcomes: Array<{ status: string; durationMs: number }> }[]): string {
  const head = 'run_id,started_at,journeys,passed,passed_healed,failed,errors,skipped,pass_rate,heal_rate,journey_time_ms';
  const rows = runs.map((r) => {
    const c = (s: string) => r.outcomes.filter((o) => o.status === s).length;
    const n = r.outcomes.length || 1;
    const passed = c('passed');
    const healed = c('passed-healed');
    return [r.runId, r.startedAt, r.outcomes.length, passed, healed, c('failed'), c('error'), c('skipped'), ((passed + healed) / n).toFixed(4), (healed / n).toFixed(4), r.outcomes.reduce((a, o) => a + o.durationMs, 0)].join(',');
  });
  return [head, ...rows].join('\n') + '\n';
}
