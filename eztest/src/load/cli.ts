/**
 * `eztest load ...`: run, distribute, author and analyze load tests.
 *
 *   eztest load run scenario.yaml [--agents 2 --listen :7400 --token $T] [--baseline dir] [--policy readiness-policy.yaml]
 *   eztest load agent --controller host:7400 --token $T [--zone eu] [--once]
 *   eztest load validate | check scenario.yaml
 *   eztest load record <url> | har <file.har> | from-run <runDir> | from-journey <journey...>  -o scenario.yaml
 *   eztest load report | compare | trend | gate
 *   eztest load monitor-agent --port 7401 --token $T
 *
 * Exit codes: 0 pass, 1 SLA failed / regression / NO_GO, 2 the test could not run.
 */
import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { stringify as toYaml } from 'yaml';
import type { CliIO } from '../cli/program.js';
import { evaluateReadiness, loadReadinessPolicy, type ReadinessResult } from '../insights/index.js';
import { loadRunArtifacts } from '../insights/index.js';
import { ResultsClient } from '../server/client.js';
import { loadJourneyFile } from '../intent/index.js';
import { normalizeNetworkLog, type NetworkEntry } from '../perf/network.js';
import { loadScenarioFile, parseScenario, scenarioDocument, type Scenario } from './model.js';
import { profileCurve } from './profiles.js';
import { LoadTest, verdictOf, type LiveSnapshot, type LoadResults } from './run.js';
import { LoadController } from './distributed/controller.js';
import { startAgent } from './distributed/agent.js';
import { appendHistory, readHistory, readLoadResults, writeLoadRun } from './results.js';
import { renderLoadReport } from './report.js';
import { compareRuns, trend } from './analysis.js';
import { generateUserPath, type GeneratedUserPath } from './correlation.js';
import { importHar, journeyToUserPath, recordBrowserTraffic } from './recording.js';
import { loadReadinessInputs } from './readiness.js';
import { startMonitorAgent } from './monitors/index.js';
import { loadAllData } from './data.js';
import { MetricsCollector } from './metrics.js';
import { LoadRuntime, VirtualUser } from './engine/vu.js';
import { buildPopulations } from './run.js';

const num = (v: string) => Number(v);

function liveLine(s: LiveSnapshot): string {
  const p = s.point;
  const lat = p?.latency ? `p50 ${p.latency.p50} p95 ${p.latency.p95} p99 ${p.latency.p99} ms` : 'no responses';
  const failing = s.sla.filter((i) => i.status === 'fail').length;
  return `[${Math.round(s.elapsedMs / 1000)}s] ${s.vus} VUs  ${p?.rps ?? 0} req/s  ${p?.errors ?? 0} err/s  ${lat}  total ${s.totals.requests} req ${s.totals.errors} err${failing ? `  SLA failing: ${failing}` : ''}`;
}

function summary(r: LoadResults): string[] {
  const t = r.totals;
  const lines = [
    `${r.scenario.name}: ${r.verdict.toUpperCase()}  ${t.requests} requests in ${Math.round(r.durationMs / 1000)} s (${t.rps.toFixed(1)}/s), errors ${(t.errorRate * 100).toFixed(2)}%, p50 ${t.latency.p50} p90 ${t.latency.p90} p95 ${t.latency.p95} p99 ${t.latency.p99} ms, peak ${t.maxVus} VUs${t.dropped ? `, ${t.dropped} dropped` : ''}`,
  ];
  for (const i of r.sla.items.filter((x) => x.status !== 'pass')) lines.push(`  SLA ${i.status.toUpperCase()}: ${i.sla} ${i.name} ${i.metric} = ${i.value ?? 'no data'} (warn ${i.warn ?? '-'}, fail ${i.fail ?? '-'})`);
  for (const f of r.analysis.findings.slice(0, 8)) lines.push(`  ${f.severity === 'high' ? '!' : '-'} ${f.title}: ${f.detail}`);
  return lines;
}

async function writeScenario(file: string, s: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `# EZTest Load scenario (docs/load.md)\n${toYaml(s, { lineWidth: 0 })}`);
}

function scenarioFromGenerated(name: string, g: GeneratedUserPath, o: { vus?: number; duration?: string }): Record<string, unknown> {
  return {
    version: 1, name, baseUrl: g.baseUrl,
    profile: { type: 'ramp', vus: o.vus ?? 10, rampUp: '30s', plateau: o.duration ?? '2m', rampDown: '10s' },
    userPaths: { main: g.path },
    sla: [{ match: '*', kind: 'transaction', p95: { warn: 1000, fail: 3000 }, errorRate: { fail: 0.01 } }],
  };
}

function reportGenerated(io: CliIO, out: string, g: GeneratedUserPath): void {
  io.out(`wrote ${out}: ${g.requests} requests in ${g.transactions.length} transaction(s), ${g.correlations.length} correlated value(s)`);
  for (const c of g.correlations) io.out(`  ${c.variable} <- ${c.rule}${c.framework ? ` [${c.framework}]` : ''} (request ${c.sourceRequest}, used by ${c.usedBy.join(', ')})`);
  if (g.env.length) io.out(`  set these environment variables on the load generators: ${g.env.join(', ')}`);
  for (const w of g.warnings) io.err(`warning: ${w}`);
}

export function registerLoadCommands(program: Command, io: CliIO): void {
  const load = program.command('load').description('EZTest Load: performance and load testing (scenarios, distributed agents, monitors, SLAs)');
  const cwdPath = (p: string) => resolve(io.cwd, p);

  // ------------------------------------------------------------------ run / controller
  const runCmd = (name: string, desc: string, distributed: boolean) =>
    load
      .command(name)
      .description(desc)
      .argument('<scenario>', 'scenario YAML/JSON')
      .option('-o, --out <dir>', 'results directory (a run directory is created inside)', 'eztest-results')
      .option('--run-dir <dir>', 'exact run directory')
      .option('--duration <d>', 'override the test duration (e.g. 30s)')
      .option('--scale <f>', 'scale every profile by a factor', num)
      .option('--agents <n>', 'distributed: number of load generators to wait for', num)
      .option('--listen <host:port>', 'distributed: controller address', '0.0.0.0:7400')
      .option('--token <token>', 'distributed: shared agent token (or EZTEST_LOAD_TOKEN)')
      .option('--tls-cert <file>').option('--tls-key <file>').option('--tls-ca <file>', 'CA for agent client certificates (mutual TLS)')
      .option('--wait <d>', 'distributed: how long to wait for agents', '120s')
      .option('--scale-up <cmd>', 'distributed: command that starts the agents ({agents}, {port}, {runId}), e.g. kubectl scale ...')
      .option('--scale-down <cmd>', 'distributed: command run after the test')
      .option('--baseline <results>', 'compare with a baseline load run (directory or load-results.json)')
      .option('--fail-on-warn', 'exit 1 when an SLA is in its warning range')
      .option('--fail-on-regression', 'exit 1 on a regression against the baseline')
      .option('--policy <file>', 'readiness policy: evaluate the decision (gate "load") and exit 1 on NO_GO')
      .option('--history <file>', 'run history for trends', '.eztest/load-history.json')
      .option('--no-monitors', 'do not run the scenario monitors')
      .option('--server <url>', 'publish the run to an EZTest results server')
      .option('--server-project <name>', 'results server project', 'default')
      .option('--json', 'print the results JSON')
      .option('-q, --quiet', 'no live lines')
      .action(async (file: string, o: Record<string, string | number | boolean | undefined>) => {
        try {
          let s = await loadScenarioFile(cwdPath(file));
          if (typeof o.scale === 'number') s = scaleScenario(s, o.scale);
          const { parseDurationMs } = await import('./model.js');
          const durationMs = o.duration ? parseDurationMs(String(o.duration)) : undefined;
          const baseline = o.baseline ? await readLoadResults(cwdPath(String(o.baseline))) : undefined;
          const agents = distributed ? Number(o.agents ?? 1) : o.agents === undefined ? 0 : Number(o.agents);
          let test: LoadTest | LoadController;
          if (agents > 0) {
            const token = (o.token as string | undefined) ?? io.env.EZTEST_LOAD_TOKEN;
            test = new LoadController(s, {
              agents, listen: String(o.listen), token, durationMs, baseline, monitors: o.monitors !== false, waitMs: parseDurationMs(String(o.wait)),
              tls: o.tlsCert || o.tlsCa ? { cert: o.tlsCert as string | undefined, key: o.tlsKey as string | undefined, ca: o.tlsCa as string | undefined, requireClientCert: !!o.tlsCa } : undefined,
              log: (l) => io.err(l), scaleUp: o.scaleUp as string | undefined, scaleDown: o.scaleDown as string | undefined,
            });
            await (test as LoadController).listen();
            io.err(`waiting for ${agents} agent(s) on port ${(test as LoadController).port}`);
          } else test = new LoadTest(s, { durationMs, baseline, monitors: o.monitors !== false });
          let lastLine = 0;
          test.on('point', (_p, snap: LiveSnapshot) => {
            if (o.quiet || Date.now() - lastLine < 5000) return;
            lastLine = Date.now();
            io.err(liveLine(snap));
          });
          const stopOnSignal = () => {
            io.err('stopping (graceful); press Ctrl+C again to abort');
            process.once('SIGINT', () => test.abort());
            test.stop('interrupted');
          };
          process.once('SIGINT', stopOnSignal);
          const results = await test.run();
          process.off('SIGINT', stopOnSignal);
          if (test instanceof LoadController) await test.close();
          const written = await writeLoadRun(results, { outputDir: cwdPath(String(o.out)), runDir: o.runDir ? cwdPath(String(o.runDir)) : undefined, scenarioText: await readFile(cwdPath(file), 'utf8') });
          await appendHistory(cwdPath(String(o.history)), results);
          for (const l of summary(results)) io.out(l);
          io.out(`report: ${written.files.report}`);
          let exit = verdictOf(results, { failOnWarn: !!o.failOnWarn, failOnRegression: !!o.failOnRegression }).exitCode;
          if (o.policy) {
            const rd = await readinessFor(written.runDir, cwdPath(String(o.policy)));
            await writeFile(join(written.runDir, 'readiness.json'), JSON.stringify(rd, null, 2));
            io.out(`readiness: ${rd.decision} (score ${rd.score})`);
            if (rd.decision === 'NO_GO') exit = 1;
          }
          if (o.server) {
            const client = new ResultsClient({ url: String(o.server), token: io.env.EZTEST_SERVER_TOKEN, project: String(o.serverProject) });
            const pub = await client.publishRun(written.runDir, { meta: { kind: 'load', scenario: results.scenario.name, verdict: results.verdict } });
            io.out(`published ${pub.runId}: ${pub.uploaded} file(s), chain ${pub.verified ? 'verified' : `NOT verified: ${pub.problems.join('; ')}`}`);
          }
          if (o.json) io.out(JSON.stringify(results));
          process.exitCode = exit;
        } catch (e) {
          io.err(`error: ${(e as Error).message}`);
          process.exitCode = 2;
        }
      });
  runCmd('run', 'run a load test (here, or as the controller of --agents load generators)', false);
  runCmd('controller', 'run a load test as the controller of distributed load generators (eztest load agent)', true);

  load
    .command('agent')
    .description('a load generator: connect to a controller and run the jobs it sends')
    .requiredOption('--controller <host:port>', 'controller address')
    .option('--token <token>', 'shared token (or EZTEST_LOAD_TOKEN)')
    .option('--id <id>', 'agent id (default host-pid)')
    .option('--zone <zone>', 'zone label (geographic populations go to agents of their zone)')
    .option('--capacity <n>', 'relative capacity weight', num, 1)
    .option('--tls-ca <file>', 'CA of the controller certificate').option('--tls-cert <file>', 'client certificate (mutual TLS)').option('--tls-key <file>')
    .option('--tls-insecure', 'TLS without verifying the controller (test labs only)')
    .option('--once', 'run one job and exit')
    .action(async (o: { controller: string; token?: string; id?: string; zone?: string; capacity: number; tlsCa?: string; tlsCert?: string; tlsKey?: string; tlsInsecure?: boolean; once?: boolean }) => {
      const a = startAgent({
        controller: o.controller, token: o.token ?? io.env.EZTEST_LOAD_TOKEN, id: o.id, zone: o.zone, capacity: o.capacity, once: o.once, log: (l) => io.err(l), baseDir: io.cwd,
        tls: o.tlsCa || o.tlsCert || o.tlsInsecure ? { ca: o.tlsCa, cert: o.tlsCert, key: o.tlsKey, insecure: o.tlsInsecure } : undefined,
        connectTimeoutMs: o.once ? 60_000 : 24 * 3_600_000,
      });
      const stop = () => a.stop();
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      try {
        await a.done;
      } catch (e) {
        io.err(`error: ${(e as Error).message}`);
        process.exitCode = 2;
      }
    });

  load
    .command('monitor-agent')
    .description('serve this host\'s CPU, memory, disk, network and process metrics (and JVMs by pid) to load controllers')
    .option('--port <n>', 'port', num, 7401)
    .option('--host <host>', 'bind address', '0.0.0.0')
    .option('--token <token>', 'bearer token (or EZTEST_MONITOR_TOKEN)')
    .option('--process <names>', 'processes to report (comma separated)', (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean))
    .action(async (o: { port: number; host: string; token?: string; process?: string[] }) => {
      const token = o.token ?? io.env.EZTEST_MONITOR_TOKEN;
      if (!token) {
        io.err('error: --token (or EZTEST_MONITOR_TOKEN) is required');
        process.exitCode = 2;
        return;
      }
      const m = await startMonitorAgent({ port: o.port, host: o.host, token, processes: o.process });
      io.out(`monitor agent on ${m.url} (GET /metrics, /jvm?pid=N with Authorization: Bearer <token>)`);
      await new Promise<void>((r) => process.once('SIGTERM', () => r()));
      await m.close();
    });

  // ------------------------------------------------------------------ authoring
  load
    .command('validate')
    .description('check a scenario and preview its load curves')
    .argument('<scenario>')
    .action(async (file: string) => {
      try {
        const s = await loadScenarioFile(cwdPath(file));
        io.out(`${s.name}: ${s.model} model, ${Object.keys(s.userPaths).length} user path(s), ${s.populations.length} population(s), ${s.sla.length} SLA(s), ${s.monitors.length} monitor(s)`);
        const total = s.populations.reduce((a, p) => a + p.share, 0);
        for (const p of s.populations) {
          const c = profileCurve(p.profile ?? s.profile!, s.model).scale(p.share / total);
          io.out(`  ${p.name} (${p.userPath}${s.userPaths[p.userPath].browser ? ', browser' : ''}): ${Math.round((p.share / total) * 100)}%, peak ${Math.round(c.peak * 100) / 100} ${s.model === 'closed' ? 'VUs' : 'iterations/s'}, ${Math.round(c.durationMs / 1000)} s${p.network ? `, network ${p.network.latencyMs} ms / ${p.network.downloadKbps || '∞'} kbps / ${p.network.lossPercent}% loss` : ''}`);
          io.out(`    ${sparkline(c.sample(60).map((x) => x.value))}`);
        }
      } catch (e) {
        io.err(`error: ${(e as Error).message}`);
        process.exitCode = 2;
      }
    });

  load
    .command('check')
    .description('run every user path once with one virtual user and show each request (correlation check)')
    .argument('<scenario>')
    .action(async (file: string) => {
      try {
        const s = await loadScenarioFile(cwdPath(file));
        const r = await checkScenario(s);
        for (const p of r) {
          io.out(`${p.path}: ${p.ok ? 'OK' : 'FAILED'}`);
          for (const n of p.requests) io.out(`  ${n.ok ? 'ok ' : 'ERR'} ${n.name}  ${n.ms} ms${n.error ? `  ${n.error}` : ''}`);
          for (const e of p.errors) io.out(`  ! ${e}`);
        }
        process.exitCode = r.every((p) => p.ok) ? 0 : 1;
      } catch (e) {
        io.err(`error: ${(e as Error).message}`);
        process.exitCode = 2;
      }
    });

  const genOpts = (c: Command) => c.option('-o, --out <file>', 'scenario file to write', 'load/scenario.yaml').option('--name <name>', 'scenario name').option('--vus <n>', 'virtual users in the generated profile', num, 10).option('--frameworks <list>', 'correlation rule packs (aspnet,jsf,salesforce,d365,sap,generic)', (v: string) => v.split(','));
  genOpts(load.command('har').description('import a HAR file (a browser recording) as a correlated user path').argument('<file>'))
    .action(async (file: string, o: { out: string; name?: string; vus: number; frameworks?: string[] }) => {
      const g = await importHar(cwdPath(file), { frameworks: o.frameworks });
      const out = cwdPath(o.out);
      await writeScenario(out, scenarioFromGenerated(o.name ?? 'Imported HAR', g, o));
      reportGenerated(io, out, g);
    });
  genOpts(load.command('record').description('record a browser session through EZTest\'s driver and generate a correlated user path (close the browser to finish)').argument('<url>'))
    .action(async (url: string, o: { out: string; name?: string; vus: number; frameworks?: string[] }) => {
      io.err('recording: use the application, then close the browser window');
      const entries = await recordBrowserTraffic({ url, headless: false });
      const g = generateUserPath(entries, { name: url, frameworks: o.frameworks });
      const out = cwdPath(o.out);
      await writeScenario(out, scenarioFromGenerated(o.name ?? `Recorded ${new URL(url).host}`, g, o));
      reportGenerated(io, out, g);
    });
  genOpts(load.command('from-run').description('generate a user path from an EZTest run\'s captured network (browser and API steps)').argument('<runDir>').option('--journey <id>', 'only this journey'))
    .action(async (runDir: string, o: { out: string; name?: string; vus: number; journey?: string; frameworks?: string[] }) => {
      const entries = await runNetwork(cwdPath(runDir), o.journey);
      const g = generateUserPath(entries, { name: runDir, frameworks: o.frameworks });
      const out = cwdPath(o.out);
      await writeScenario(out, scenarioFromGenerated(o.name ?? `From run ${runDir}`, g, o));
      reportGenerated(io, out, g);
    });
  load
    .command('from-journey')
    .description('user paths from EZTest journeys: API steps at protocol level, UI steps as browser-level users')
    .argument('<journeys...>')
    .option('-o, --out <file>', 'scenario file to write', 'load/scenario.yaml')
    .option('--name <name>').option('--vus <n>', 'virtual users', num, 5)
    .option('--base-url <url>')
    .action(async (files: string[], o: { out: string; name?: string; vus: number; baseUrl?: string }) => {
      const userPaths: Record<string, unknown> = {};
      const populations: unknown[] = [];
      for (const f of files) {
        const j = await loadJourneyFile(cwdPath(f));
        const { path, browser, warnings } = journeyToUserPath(j);
        userPaths[j.id] = path;
        populations.push({ name: j.id, userPath: j.id, share: Math.round(100 / files.length), ...(browser ? { browser: true } : {}) });
        for (const w of warnings) io.err(`warning: ${w}`);
        io.out(`${j.name}: ${browser ? 'browser-level' : 'protocol-level'} user path`);
      }
      const out = cwdPath(o.out);
      await writeScenario(out, { version: 1, name: o.name ?? 'Journeys under load', ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}), profile: { type: 'ramp', vus: o.vus, rampUp: '30s', plateau: '2m' }, userPaths, populations });
      io.out(`wrote ${out}`);
    });

  // ------------------------------------------------------------------ results
  load
    .command('report')
    .description('re-render the HTML report of a load run')
    .argument('<run>', 'load run directory or load-results.json')
    .option('-o, --out <file>', 'output HTML (default report.html in the run directory)')
    .action(async (run: string, o: { out?: string }) => {
      const r = await readLoadResults(cwdPath(run));
      const out = o.out ? cwdPath(o.out) : join(existsSync(join(cwdPath(run), 'load-results.json')) ? cwdPath(run) : dirname(cwdPath(run)), 'report.html');
      await writeFile(out, renderLoadReport(r));
      for (const l of summary(r)) io.out(l);
      io.out(`report: ${out}`);
    });

  load
    .command('compare')
    .description('compare a load run with a baseline: per transaction p95, error rate and throughput (exit 1 on regressions)')
    .argument('<baseline>').argument('<current>')
    .option('--p95-pct <f>', 'p95 increase that counts as a regression (fraction)', num, 0.15)
    .option('--p95-min-ms <ms>', 'and at least this many ms', num, 20)
    .option('--json')
    .action(async (b: string, c: string, o: { p95Pct: number; p95MinMs: number; json?: boolean }) => {
      const cmp = compareRuns(await readLoadResults(cwdPath(b)), await readLoadResults(cwdPath(c)), { p95Pct: o.p95Pct, p95MinMs: o.p95MinMs });
      if (o.json) io.out(JSON.stringify(cmp, null, 2));
      else {
        io.out(`${cmp.currentRunId} vs ${cmp.baselineRunId}: ${cmp.regressions} regression(s), ${cmp.improvements} improvement(s)`);
        for (const r of cmp.rows.filter((x) => x.verdict !== 'unchanged')) io.out(`  ${r.verdict.padEnd(11)} ${r.name}  ${r.reasons.join('; ')}`);
      }
      process.exitCode = cmp.regressions ? 1 : 0;
    });

  load
    .command('trend')
    .description('p95 trend per transaction over the run history')
    .option('--history <file>', 'history file', '.eztest/load-history.json')
    .option('--scenario <name>')
    .option('--last <n>', 'runs', num, 20)
    .action(async (o: { history: string; scenario?: string; last: number }) => {
      const t = trend(await readHistory(cwdPath(o.history), o.scenario), o.last);
      io.out(`${t.runs.length} run(s)`);
      for (const s of t.series) io.out(`  ${s.direction.padEnd(6)} ${s.name}  ${sparkline(s.p95)}  ${s.p95.map((x) => Math.round(x)).join(' ')} ms (slope ${s.slope} ms/run)`);
    });

  load
    .command('gate')
    .description('the readiness decision for a load run (gate "load"): exit 0 GO, 1 NO_GO (GO_WITH_RISKS per --on-risks)')
    .argument('<run>', 'load run directory (or any run directory with load-results.json)')
    .option('--policy <file>', 'readiness policy (default: the load gate alone)')
    .option('--on-risks <action>', 'GO_WITH_RISKS: pass or fail', 'pass')
    .action(async (run: string, o: { policy?: string; onRisks: string }) => {
      const rd = await readinessFor(cwdPath(run), o.policy ? cwdPath(o.policy) : undefined);
      io.out(`readiness ${rd.decision} (score ${rd.score})`);
      for (const g of rd.gates) io.out(`  ${g.gate}: ${g.status} - ${g.summary}`);
      process.exitCode = rd.decision === 'NO_GO' || (rd.decision === 'GO_WITH_RISKS' && o.onRisks === 'fail') ? 1 : 0;
    });
}

function sparkline(values: number[]): string {
  const bars = '▁▂▃▄▅▆▇█';
  const max = Math.max(1e-9, ...values);
  return values.map((v) => bars[Math.min(7, Math.floor((v / max) * 7.999))]).join('');
}

/** Scale every profile of a scenario. */
export function scaleScenario(s: Scenario, f: number): Scenario {
  const scaleProfile = (p: unknown) => {
    const q = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
    for (const k of ['vus', 'rate', 'base', 'peak', 'step', 'to', 'from']) if (typeof q[k] === 'number') q[k] = k === 'vus' ? Math.round((q[k] as number) * f) : (q[k] as number) * f;
    if (Array.isArray(q.points)) q.points = (q.points as Array<{ at: number; value: number }>).map((x) => ({ ...x, value: x.value * f }));
    return q;
  };
  const doc = scenarioDocument(s) as Record<string, unknown> & { profile?: unknown; populations: Array<Record<string, unknown>> };
  if (doc.profile) doc.profile = scaleProfile(doc.profile);
  doc.populations = doc.populations.map((p) => (p.profile ? { ...p, profile: scaleProfile(p.profile) } : p));
  return parseScenario(doc, s.baseDir);
}

/** Readiness for a run directory with load results: the given policy, or the load gate alone. */
export async function readinessFor(runDir: string, policyFile?: string): Promise<ReadinessResult> {
  const art = await loadRunArtifacts(runDir);
  const inputs = await loadReadinessInputs(runDir, art.evidence);
  const policy = policyFile ? await loadReadinessPolicy(policyFile) : { version: 1 as const, gates: { load: true }, scoring: { goMinScore: 90, noGoBelowScore: 50, healedPassCredit: 0.8, blockerPenalty: 30, riskPenalty: 10, waivedPenalty: 5 }, exceptions: [] };
  return evaluateReadiness(policy, { run: art.run, evidence: art.evidence, ...inputs });
}

/** Network entries captured by an EZTest run (browser network logs and API steps). */
export async function runNetwork(runDir: string, journeyId?: string): Promise<NetworkEntry[]> {
  const art = await loadRunArtifacts(runDir);
  const out: NetworkEntry[] = [];
  for (const e of art.evidence) {
    if (e.kind !== 'network') continue;
    if (journeyId && e.journeyId && e.journeyId !== journeyId) continue;
    try {
      const raw = JSON.parse(await readFile(join(runDir, e.path), 'utf8')) as unknown;
      out.push(...normalizeNetworkLog(raw).map((x) => ({ ...x, journeyId: x.journeyId ?? e.journeyId, stepId: x.stepId ?? e.stepId, group: x.group ?? (e.stepId ? `${e.journeyId ?? ''} ${e.stepId}`.trim() : undefined) })));
    } catch {
      // not a network log
    }
  }
  return out.sort((a, b) => (typeof a.timing === 'object' ? (a.timing.startTime ?? 0) : 0) - (typeof b.timing === 'object' ? (b.timing.startTime ?? 0) : 0));
}

export interface CheckedPath {
  path: string;
  ok: boolean;
  requests: Array<{ name: string; ok: boolean; ms: number; error?: string }>;
  errors: string[];
  vars: Record<string, string>;
}

/** One VU, one iteration per user path: what each request did (the correlation assistant's replay). */
export async function checkScenario(s: Scenario): Promise<CheckedPath[]> {
  const data = await loadAllData(s);
  const out: CheckedPath[] = [];
  for (const p of s.populations) {
    const metrics = new MetricsCollector(50);
    const rt = new LoadRuntime(s, data, metrics);
    try {
      const [pop] = buildPopulations({ ...s, populations: [{ ...p, share: 100 }] }, rt);
      const vu = new VirtualUser(rt, pop);
      const inited = await vu.init();
      if (inited) await vu.iteration();
      await vu.end();
      await vu.close();
      const stats = metrics.stats(1000);
      const requests = stats.filter((x) => x.kind === 'request' || x.kind === 'page').map((x) => ({ name: x.name, ok: x.errors === 0, ms: x.latency.max, error: x.errors ? Object.keys(x.errorsByType).join(', ') : undefined }));
      const vars: Record<string, string> = {};
      for (const [k, v] of vu.scope.vars) if (k !== 'env' && !k.startsWith('__')) vars[k] = typeof v === 'string' ? (v.length > 12 ? `${v.slice(0, 4)}…(${v.length})` : v) : typeof v;
      out.push({ path: p.userPath, ok: inited && metrics.errorSamples.length === 0, requests, errors: metrics.errorSamples.map((e) => `${e.name}: ${e.message}`), vars });
    } finally {
      await rt.close();
    }
  }
  return out;
}
