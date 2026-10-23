/**
 * CLI for tests mapped to pipelines and for shared test data:
 *
 *   eztest pipelines list | explain <name>     what each pipeline runs, and why
 *   eztest tags report                         journeys in no pipeline, untagged journeys
 *   eztest deployments [--environment sit]     what was tested where, per version
 *   eztest store list | get | set | delete | purge | pools | pool-add
 *
 * plus the `eztest run --pipeline <name|auto>` support: resolving the entry
 * before the run, the `requires:` check, and the deployment record, Azure
 * DevOps reporting and the readiness gate after it.
 */
import { Option, type Command } from 'commander';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Journey, RunResult } from '../core/index.js';
import type { LoadedConfig, PipelineEntry } from '../config/index.js';
import { interpolate } from '../core/index.js';
import {
  buildDeploymentRecord, checkRequires, detectCi, detectVersion, planPipeline, pipelineRunSettings, reportDeploymentToAdo, resolvePipeline, tagsReport,
  writeDeploymentFiles, type CiContext, type DeploymentRecord, type PipelinePlan, type PipelineResolution, type ReadinessLike,
} from '../pipelines/index.js';
import { hasAdoCredentials, adoSettings, publishRun, pipelineLinksFromEnv } from '../alm-ado/index.js';
import { storeFromConfig, type SharedStore } from '../store/index.js';
import { MASK } from '../config/masker.js';
import { loadJourneys } from './journeys.js';
import { adoClientFor, readinessGate } from './ado.js';
import type { ReadinessResult } from '../insights/index.js';
import { prepareSelection, secretResolver, serverClientFor } from './scale.js';
import type { CliIO } from './program.js';
import type { ResultsClient } from '../server/client.js';

type Loader = (o: { config?: string; env?: string; project?: string }) => Promise<LoadedConfig>;

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

export function isAroundJourney(j: Journey): boolean {
  return j.tags.includes('setup') || j.tags.includes('teardown');
}

// ------------------------------------------------------------------ eztest run --pipeline

export interface PipelineRun {
  resolution: PipelineResolution;
  ci: CiContext;
  version: string;
}

/**
 * Resolve `--pipeline` before the run and apply the entry to the run options: environment, browsers,
 * retries, workers, impact base, budget, risk and the CI's shard. Command-line flags win.
 */
export async function preparePipelineRun(o: Record<string, unknown>, overrides: Record<string, unknown>, io: CliIO, load: Loader): Promise<PipelineRun> {
  const loaded = await load(o as { config?: string; env?: string; project?: string });
  const ci = detectCi(io.env);
  const resolution = resolvePipeline(String(o.pipeline), loaded.config.pipelines, ci, io.env);
  const s = pipelineRunSettings(resolution.entry, ci, io.env);
  if (s.environment && !o.env) o.env = s.environment;
  if (s.browsers?.length && !o.browser && !(o.browsers as string[] | undefined)?.length) {
    if (s.browsers.length > 1) overrides.browsers = s.browsers;
    else overrides.browser = s.browsers[0];
  }
  if (s.retries !== undefined && o.retries === undefined) overrides.retries = s.retries;
  if (s.workers !== undefined && !o.workers) overrides.concurrency = s.workers;
  if (s.changedSince && !o.changedSince) o.changedSince = s.changedSince;
  if (s.budget && !o.budget) o.budget = s.budget;
  if (s.risk && !o.risk) o.risk = s.risk;
  if (s.shard && !o.shard) o.shard = s.shard;
  const version = resolution.entry.version ? interpolate(resolution.entry.version, io.env as Record<string, unknown>) : detectVersion(ci, io.env) ?? 'unversioned';
  io.out(`pipeline: ${resolution.name} (${resolution.how})${s.environment ? `, environment ${s.environment}` : ''}${resolution.entry.tags ? `, tags ${resolution.entry.tags}` : ''}, version ${version}`);
  return { resolution, ci, version };
}

/** The pipeline's tag selection over the loaded tests (setup/teardown journeys are kept aside by the caller). */
export function selectForPipeline(p: PipelineRun, tests: Journey[], out: (s: string) => void): Journey[] {
  const plan = planPipeline(p.resolution.name, p.resolution.entry, tests);
  const n = plan.decisions.filter((d) => !d.role && d.selected).length;
  out(`pipeline ${p.resolution.name}: ${n} of ${tests.length} journeys by ${plan.expression ?? 'no tag filter'}${plan.dynamic.length ? `; then ${plan.dynamic.join('; ')}` : ''}`);
  return plan.selected;
}

/** `requires:`: the pipelines that must have passed for this version first. Returns false when the run must not go on. */
export async function checkPipelineRequires(p: PipelineRun, client: ResultsClient | undefined, io: CliIO): Promise<boolean> {
  const r = await checkRequires(p.resolution.entry, p.version, client);
  if (r.skipped) io.err(`warning: ${r.skipped}`);
  if (r.problems.length) {
    io.err(`pipeline ${p.resolution.name} requires ${p.resolution.entry.requires.join(', ')} to have passed for version ${p.version}:\n  ${r.problems.join('\n  ')}`);
    return false;
  }
  if (r.checked.length) io.out(`requires: ${r.checked.join(', ')} passed for version ${p.version}`);
  return true;
}

/**
 * After the run: the deployment test record (run directory, results server, Azure DevOps summary, tags,
 * work items, test plan) and the readiness gate. Returns the exit code the gate asks for (undefined: keep).
 */
export async function finishPipelineRun(p: PipelineRun, runDir: string, readiness: ReadinessLike | undefined, ctx: {
  loaded: LoadedConfig; io: CliIO; out: (s: string) => void; client?: ResultsClient; runUrl?: string;
}): Promise<number | undefined> {
  const { entry, name } = p.resolution;
  const cfg = ctx.loaded.config;
  const run = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as RunResult;
  const environment = entry.environment ?? p.ci.environment ?? cfg.environment;
  const recordIt = entry.record ?? !!entry.environment;
  // The report's address where the CI keeps artifacts (EZTEST_REPORT_URL), else the published run.
  const reportUrl = ctx.io.env.EZTEST_REPORT_URL || undefined;
  const rec = buildDeploymentRecord({
    pipeline: name, entry, ci: p.ci, run, version: p.version, environment, app: entry.app ?? cfg.project, readiness,
    selection: { ...(entry.tags ? { tags: entry.tags } : {}), ...(entry.shards ? { shards: entry.shards === 'auto' ? undefined : entry.shards } : {}), ...(entry.browsers ? { browsers: entry.browsers } : {}) },
    evidence: { ...(ctx.runUrl ? { runUrl: ctx.runUrl } : {}), ...(reportUrl ? { reportUrl } : {}) },
  });
  if (entry.testPlan && cfg.ado && hasAdoCredentials(cfg, ctx.io.env) && !adoSettings(cfg, ctx.io.env).missing.length) {
    try {
      const ado = await adoClientFor(ctx.loaded, ctx.io.cwd, ctx.io.env);
      const attachments = ['report.html', 'junit.xml'].map((f) => join(runDir, f)).filter((f) => existsSync(f)).map((path) => ({ path }));
      const s = await publishRun(run, { client: ado, planId: entry.testPlan, suiteId: entry.testSuite, links: pipelineLinksFromEnv(ctx.io.env), attachments, runName: `EZTest ${name} ${environment} ${p.version}` });
      rec.testPlan = { planId: entry.testPlan, ...(entry.testSuite ? { suiteId: entry.testSuite } : {}), testRunId: s.runId, results: s.results.length };
      rec.evidence = { ...(rec.evidence ?? {}), testRunUrl: `${ado.projectUrl}/_testManagement/runs?runId=${s.runId}` };
      ctx.out(`test plan ${entry.testPlan}: ${s.results.length} result(s) in test run ${s.runId}${s.unmapped.length ? ` (${s.unmapped.length} journey(s) without a test case)` : ''}`);
    } catch (e) {
      ctx.io.err(`warning: test plan ${entry.testPlan} not updated: ${(e as Error).message}`);
    }
  }
  if (recordIt) {
    const files = await writeDeploymentFiles(runDir, rec);
    ctx.out(`deployment record: ${environment} ${p.version} (${files.json})`);
    if (ctx.client) {
      try {
        await ctx.client.recordDeployment(rec);
        ctx.out(`deployment record kept on the results server (${ctx.client.base}, project ${ctx.client.project})`);
      } catch (e) {
        ctx.io.err(`warning: deployment record not sent to the results server: ${(e as Error).message}`);
      }
    }
    const inAzure = p.ci.system === 'azure';
    if (inAzure && hasAdoCredentials(cfg, ctx.io.env) && !adoSettings(cfg, ctx.io.env).missing.length) {
      try {
        const ado = await adoClientFor(ctx.loaded, ctx.io.cwd, ctx.io.env);
        const r = await reportDeploymentToAdo(ado, rec, {
          buildId: Number(p.ci.buildId) || undefined, summaryFile: entry.ado.summary ? files.markdown : undefined, tags: entry.ado.tags,
          commentWorkItems: entry.ado.commentWorkItems, linkWorkItems: entry.ado.linkWorkItems, inPipeline: true, out: (l) => ctx.io.out(l),
        });
        if (r.tags.length) ctx.out(`build tags: ${r.tags.join(', ')}`);
        for (const w of r.workItems) ctx.out(`work item #${w.id}:${w.comment ? ` comment ${w.comment}` : ''}${w.linked ? ' linked' : ''}`);
        for (const w of r.warnings) ctx.io.err(`warning: ${w}`);
      } catch (e) {
        ctx.io.err(`warning: Azure DevOps deployment report failed: ${(e as Error).message}`);
      }
    } else if (inAzure && entry.ado.summary) ctx.io.out(`##vso[task.uploadsummary]${files.markdown}`);
  }
  if (entry.gate === 'readiness' && readiness?.decision === 'NO_GO') {
    ctx.io.err(`readiness gate: NO_GO for ${environment} ${p.version}${readiness.gates?.length ? ` (${readiness.gates.filter((g) => g.status === 'fail').map((g) => g.gate).join(', ')})` : ''}: the pipeline fails`);
    return 1;
  }
  return undefined;
}

// ------------------------------------------------------------------ commands

async function journeysFor(entry: PipelineEntry | undefined, loaded: LoadedConfig, cwd: string): Promise<Journey[]> {
  const { journeys, errors } = await loadJourneys(entry?.journeys?.length ? entry.journeys : [loaded.config.journeysDir], cwd);
  if (errors.length) throw new Error(errors.map((e) => `${e.file}: ${e.message}`).join('\n'));
  return journeys;
}

function describeEntry(name: string, e: PipelineEntry): string {
  const bits = [
    e.trigger && `trigger ${e.trigger}${e.schedule ? ` (${e.schedule})` : ''}`,
    e.environment && `environment ${e.environment}`,
    e.tags && `tags ${e.tags}`,
    e.impact && `impact${e.impact === true ? '' : ` since ${e.impact}`}`,
    e.budget && `budget ${e.budget}`,
    e.risk !== undefined && `risk ${e.risk}`,
    e.shards && `shards ${e.shards}`,
    e.browsers?.length && `browsers ${e.browsers.join(', ')}`,
    e.testPlan && `test plan ${e.testPlan}${e.testSuite ? `/${e.testSuite}` : ''}`,
    `gate ${e.gate}`,
    e.requires.length && `requires ${e.requires.join(', ')}`,
  ].filter(Boolean);
  return `${name}: ${bits.join(' · ')}`;
}

export function renderPlan(plan: PipelinePlan, o: { all?: boolean } = {}): string[] {
  const lines = [describeEntry(plan.name, plan.entry)];
  const sel = plan.decisions.filter((d) => d.selected && !d.role);
  const around = plan.decisions.filter((d) => d.selected && d.role);
  const no = plan.decisions.filter((d) => !d.selected && !d.role);
  lines.push(`would run ${sel.length} journey(s)${around.length ? ` (+${around.length} setup/teardown)` : ''}; ${no.length} not selected`);
  for (const d of around) lines.push(`  ~ ${d.journeyId}: ${d.reasons.join('; ')}`);
  for (const d of sel) lines.push(`  + ${d.journeyId}: ${d.reasons.join('; ')}`);
  for (const d of o.all ? no : no.slice(0, 30)) lines.push(`  - ${d.journeyId}: ${d.reasons.filter((r) => /not|lacks|<|excludes|library/.test(r)).join('; ') || d.reasons.join('; ')}`);
  if (!o.all && no.length > 30) lines.push(`  - ...and ${no.length - 30} more (--all lists them)`);
  for (const x of plan.dynamic) lines.push(`at run time: ${x}`);
  return lines;
}

async function storeFor(loaded: LoadedConfig, cwd: string, io: CliIO): Promise<SharedStore> {
  const client = await serverClientFor(loaded, cwd);
  return storeFromConfig(loaded.config, { cwd, client, resolveSecret: secretResolver(loaded, cwd), addSecret: (v) => loaded.masker.add(v), env: { ...loaded.variables, ...io.env } });
}

/** Deployment records: the results server's, else the `deployment.json` files of local runs. */
export async function listDeployments(loaded: LoadedConfig, cwd: string, q: { environment?: string; version?: string; pipeline?: string } = {}): Promise<{ source: string; records: DeploymentRecord[] }> {
  const client = await serverClientFor(loaded, cwd);
  if (client) return { source: client.base, records: await client.deployments(q) };
  const out = resolve(cwd, loaded.config.outputDir);
  const records: DeploymentRecord[] = [];
  if (existsSync(out)) {
    for (const d of await readdir(out)) {
      const f = join(out, d, 'deployment.json');
      if (!existsSync(f)) continue;
      try {
        const r = JSON.parse(await readFile(f, 'utf8')) as DeploymentRecord;
        if ((!q.environment || r.environment === q.environment) && (!q.version || r.version === q.version) && (!q.pipeline || r.pipeline === q.pipeline)) records.push(r);
      } catch {
        // a torn file
      }
    }
  }
  records.sort((a, b) => (b.recordedAt ?? '').localeCompare(a.recordedAt ?? ''));
  return { source: out, records };
}

export function registerPipelineCommands(program: Command, io: CliIO, load: Loader): void {
  const withConfig = (c: Command) =>
    c.option('-c, --config <file>', 'config file').option('-e, --env <name>', 'environment name').option('--project <name>', 'project overlay');

  const pipelines = program.command('pipelines').description('CI triggers and deployment stages mapped to journeys (pipelines: in the config)');
  withConfig(pipelines.command('list'))
    .description('every configured pipeline and how many journeys its tags select')
    .option('--json', 'JSON output')
    .action(async (o) => {
      const loaded = await load(o);
      const ps = loaded.config.pipelines;
      if (!Object.keys(ps).length) {
        io.out('No pipelines configured. Add a "pipelines:" block to eztest.config.yaml (docs/pipelines.md).');
        return;
      }
      const rows = [];
      for (const [name, e] of Object.entries(ps)) {
        const plan = planPipeline(name, e, (await journeysFor(e, loaded, io.cwd)));
        rows.push({ name, journeys: plan.selected.length, entry: e, line: describeEntry(name, e) });
      }
      if (o.json) io.out(JSON.stringify(rows.map((r) => ({ name: r.name, journeys: r.journeys, ...r.entry })), null, 2));
      else for (const r of rows) io.out(`${pad(`${r.journeys}`, 5)} ${r.line}`);
    });
  withConfig(pipelines.command('explain'))
    .description('which journeys a pipeline would run, and why (tags, risk, Browsers: headers, setup journeys); with --dynamic also impact and budget')
    .argument('<name>', 'pipeline name, or "auto" to detect it from the CI variables')
    .option('--all', 'list every journey that is not selected')
    .option('--dynamic', 'also apply impact (git) and budget (history) the way the run would')
    .option('--json', 'JSON output')
    .action(async (name: string, o) => {
      const loaded = await load(o);
      const ci = detectCi(io.env);
      const r = resolvePipeline(name, loaded.config.pipelines, ci, io.env);
      const plan = planPipeline(r.name, r.entry, await journeysFor(r.entry, loaded, io.cwd));
      if (o.json) {
        io.out(JSON.stringify({ name: r.name, how: r.how, expression: plan.expression, decisions: plan.decisions, dynamic: plan.dynamic, settings: pipelineRunSettings(r.entry, ci, io.env) }, null, 2));
        return;
      }
      if (name === 'auto') io.out(`detected: ${r.name} (${r.how})`);
      for (const l of renderPlan(plan, { all: o.all })) io.out(l);
      if (o.dynamic && (r.entry.impact || r.entry.budget)) {
        const s = pipelineRunSettings(r.entry, ci, io.env);
        const prepared = await prepareSelection(plan.selected, { changedSince: s.changedSince, budget: s.budget }, { loaded, cwd: io.cwd, warn: (w) => io.err(`warning: ${w}`) });
        for (const l of prepared.lines) io.out(l);
      }
    });

  const tags = program.command('tags').description('tags across journeys and pipelines');
  withConfig(tags.command('report'))
    .description('journeys no pipeline runs, untagged journeys, pipelines that select nothing, tag counts')
    .option('--json', 'JSON output')
    .option('--strict', 'exit 1 when a journey is in no pipeline or a pipeline selects nothing')
    .action(async (o) => {
      const loaded = await load(o);
      const rep = tagsReport(await journeysFor(undefined, loaded, io.cwd), loaded.config.pipelines);
      if (o.json) io.out(JSON.stringify(rep, null, 2));
      else {
        io.out(`${rep.journeys.length} journeys, ${rep.pipelines.length} pipelines`);
        for (const p of rep.pipelines) io.out(`  pipeline ${pad(p.name, 18)} ${pad(String(p.journeys), 5)} journeys${p.tags ? `  (${p.tags})` : ''}`);
        io.out(`untagged (${rep.untagged.length}): ${rep.untagged.join(', ') || 'none'}`);
        io.out(`in no pipeline (${rep.inNoPipeline.length}): ${rep.inNoPipeline.join(', ') || (rep.pipelines.length ? 'none' : 'no pipelines configured')}`);
        if (rep.emptyPipelines.length) io.out(`pipelines that select nothing: ${rep.emptyPipelines.join(', ')}`);
        io.out(`tags: ${rep.tagCounts.map((t) => `@${t.tag} (${t.journeys})`).join(', ') || 'none'}`);
      }
      if (o.strict && (rep.inNoPipeline.length || rep.emptyPipelines.length)) process.exitCode = 1;
    });

  const deployments = program.command('deployments').description('deployment test records: what was tested in each environment for each version');
  withConfig(deployments.command('record'))
    .description('record a deployment test for a finished run, e.g. a merged sharded run (results server, Azure DevOps, readiness gate)')
    .argument('<runDir>')
    .requiredOption('--pipeline <name>', 'the pipelines: entry the run belongs to ("auto": from the CI stage)')
    .action(async (runDir: string, o) => {
      const p = await preparePipelineRun(o, {}, io, load);
      const loaded = await load(o);
      const dir = resolve(io.cwd, runDir);
      const rj = join(dir, 'report.json');
      const readiness = existsSync(rj) ? (JSON.parse(await readFile(rj, 'utf8')) as { insights?: { readiness?: ReadinessResult } }).insights?.readiness : undefined;
      const client = await serverClientFor(loaded, io.cwd);
      const code = await finishPipelineRun({ ...p, resolution: { ...p.resolution, entry: { ...p.resolution.entry, record: true } } }, dir, readiness, { loaded, io, out: io.out, client });
      if (code !== undefined) process.exitCode = code;
    });
  withConfig(deployments.command('list'))
    .description('what was tested in each environment for each version (results server, else the local runs)')
    .option('--environment <name>')
    .option('--version <v>')
    .option('--pipeline <name>')
    .option('--json', 'JSON output')
    .action(async (o) => {
      const loaded = await load(o);
      const r = await listDeployments(loaded, io.cwd, { environment: o.environment, version: o.version, pipeline: o.pipeline });
      if (o.json) {
        io.out(JSON.stringify(r.records, null, 2));
        return;
      }
      if (!r.records.length) io.out(`No deployment records (${r.source}). They are written by eztest run --pipeline <entry with environment>.`);
      for (const d of r.records) {
        const x = d.results;
        io.out(`${d.recordedAt?.slice(0, 16) ?? ''}  ${pad(d.environment, 8)} ${pad(d.version, 14)} ${pad(d.pipeline, 12)} ${pad(d.readiness?.decision ?? '-', 14)} ${x.passed + x.passedHealed}/${x.total} passed${x.failed + x.errors ? `, ${x.failed + x.errors} failed` : ''}${d.runId ? `  ${d.runId}` : ''}`);
      }
    });

  // ------------------------------------------------------------------ gate and summary for any CI system
  program
    .command('gate')
    .description('the readiness gate for any CI system: NO_GO fails (exit 1), GO_WITH_RISKS warns; annotations for Azure Pipelines and GitHub Actions')
    .argument('<runDir>')
    .addOption(new Option('--on-no-go <action>', 'what NO_GO does').choices(['fail', 'warn', 'pass']).default('fail'))
    .addOption(new Option('--on-risks <action>', 'what GO_WITH_RISKS does').choices(['fail', 'warn', 'pass']).default('warn'))
    .addOption(new Option('--on-missing <action>', 'when the run has no readiness decision').choices(['fail', 'warn', 'pass']).default('warn'))
    .action(async (runDir: string, o) => {
      const rj = join(resolve(io.cwd, runDir), 'report.json');
      const readiness = existsSync(rj) ? (JSON.parse(await readFile(rj, 'utf8')) as { insights?: { readiness?: ReadinessResult } }).insights?.readiness : undefined;
      const g = readinessGate(readiness, { noGo: o.onNoGo, goWithRisks: o.onRisks, missing: o.onMissing });
      const sys = detectCi(io.env).system;
      const note = (kind: 'error' | 'warning') => (sys === 'azure' ? `##vso[task.logissue type=${kind}]${g.message}` : sys === 'github' ? `::${kind}::${g.message}` : `${kind === 'error' ? 'FAIL' : 'WARN'} ${g.message}`);
      if (g.action === 'fail') {
        io.err(note('error'));
        process.exitCode = 1;
      } else if (g.action === 'warn') io.out(note('warning'));
      else io.out(`PASS ${g.message}`);
    });
  const ci = program.commands.find((c) => c.name() === 'ci') ?? program.command('ci').description('CI helpers');
  ci.command('summary')
    .description('print a Markdown summary of a run (for $GITHUB_STEP_SUMMARY, merge request notes, build summaries)')
    .argument('<runDir>')
    .option('--journeys <paths>', 'journey paths (for file:line of failing steps)', (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean))
    .action(async (runDir: string, o: { journeys?: string[] }) => {
      const { buildTabData } = await import('../vcs/tab.js');
      const r = await buildTabData(resolve(io.cwd, runDir), io.cwd, o.journeys ?? ['journeys'], { buildUrl: detectCi(io.env).url });
      io.out(r.markdown);
    });

  const store = program.command('store').description('the shared test data store and data pools (docs/shared-data.md)');
  const show = (v: unknown, secret?: boolean) => (secret ? MASK : typeof v === 'string' ? v : JSON.stringify(v));
  withConfig(store.command('list'))
    .description('keys of the shared store (secret values masked)')
    .option('-n, --namespace <ns>', 'one namespace (default: all)')
    .option('--json', 'JSON output')
    .action(async (o) => {
      const loaded = await load(o);
      const s = await storeFor(loaded, io.cwd, io);
      const list = (await s.backend.list(o.namespace)).filter((e) => !e.key.startsWith('__eztest'));
      if (o.json) io.out(JSON.stringify(list.map(({ sealed: _s, ...e }) => (e.secret ? { ...e, value: MASK } : e)), null, 2));
      else for (const e of list) io.out(`${pad(e.namespace, 10)} ${pad(e.key, 28)} ${pad(show(e.value, e.secret).slice(0, 60), 60)} ${e.expiresAt ? `expires ${e.expiresAt}` : ''}${e.pipeline ? ' [pipeline]' : ''}`);
      if (!o.json && !list.length) io.out(`The shared store is empty (${s.backend.description}).`);
    });
  withConfig(store.command('get'))
    .description('print a value (secrets stay masked unless --reveal)')
    .argument('<key>')
    .option('-n, --namespace <ns>')
    .option('--reveal', 'print a secret value in clear text')
    .action(async (key: string, o) => {
      const loaded = await load(o);
      const s = await storeFor(loaded, io.cwd, io);
      const r = await s.load(key, { namespace: o.namespace });
      const secret = r.entry?.secret ?? false;
      process.stdout.write(`${secret && !o.reveal ? MASK : typeof r.value === 'string' ? r.value : JSON.stringify(r.value)}\n`);
    });
  withConfig(store.command('set'))
    .description('save a value (text, or JSON with --json)')
    .argument('<key>')
    .argument('<value>')
    .option('-n, --namespace <ns>')
    .option('--ttl <duration>', 'expire after, e.g. 2d, 12h')
    .option('--secret', 'encrypt the value (needs EZTEST_STORE_KEY or EZTEST_MASTER_KEY)')
    .option('--json', 'the value is JSON')
    .action(async (key: string, value: string, o) => {
      const loaded = await load(o);
      const s = await storeFor(loaded, io.cwd, io);
      const { parseTtl } = await import('../store/types.js');
      const e = await s.save(key, o.json ? JSON.parse(value) : value, { namespace: o.namespace, ...(o.ttl ? { ttlMs: parseTtl(o.ttl) } : {}), secret: !!o.secret, by: 'eztest store set' });
      io.out(`saved ${e.namespace}/${e.key}${e.expiresAt ? ` (expires ${e.expiresAt})` : ''}`);
    });
  withConfig(store.command('delete'))
    .argument('<key>')
    .option('-n, --namespace <ns>')
    .action(async (key: string, o) => {
      const loaded = await load(o);
      const s = await storeFor(loaded, io.cwd, io);
      io.out((await s.delete(key, { namespace: o.namespace })) ? `deleted ${key}` : `no ${key}`);
    });
  withConfig(store.command('purge'))
    .description('remove expired values')
    .option('-n, --namespace <ns>')
    .action(async (o) => {
      const loaded = await load(o);
      const s = await storeFor(loaded, io.cwd, io);
      io.out(`removed ${await s.backend.purgeExpired(o.namespace)} expired value(s)`);
    });
  withConfig(store.command('pools'))
    .description('data pools: free, claimed and total items')
    .option('-n, --namespace <ns>')
    .action(async (o) => {
      const loaded = await load(o);
      const s = await storeFor(loaded, io.cwd, io);
      const ps = await s.backend.pools(o.namespace);
      if (!ps.length) io.out('No data pools yet.');
      for (const p of ps) io.out(`${pad(p.namespace, 10)} ${pad(p.pool, 28)} ${p.available} free, ${p.claimed} claimed, ${p.total} total`);
    });
  withConfig(store.command('pool-add'))
    .description('add items to a data pool (each value is one item; --from seeds from a data file)')
    .argument('<pool>')
    .argument('[values...]')
    .option('-n, --namespace <ns>')
    .option('--from <file>', 'csv, xlsx or json data file: one item per row')
    .option('--column <name>', 'with --from: the column to use as the item')
    .action(async (pool: string, values: string[], o) => {
      const loaded = await load(o);
      const s = await storeFor(loaded, io.cwd, io);
      const r = o.from ? await s.seed(pool, o.from, { namespace: o.namespace, column: o.column }) : await s.poolAdd(pool, values, { namespace: o.namespace, by: 'eztest store pool-add' });
      io.out(`pool ${pool}: ${r.added} added, ${r.skipped} already there`);
    });
}
