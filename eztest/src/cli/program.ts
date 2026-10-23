/**
 * The `eztest` command line. Every command is a thin layer over the public
 * modules, so anything the CLI does can also be done programmatically.
 */
import { Command, Option } from 'commander';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join, extname } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { EventBus, verifyEvidence, type EzEvent, type RunResult } from '../core/index.js';
import { loadConfig, listProjects, encryptValue, createMaskedLogger, type LoadedConfig } from '../config/index.js';
import { effectiveSummary } from './effective.js';
import { journeyToEzScript, loadJourneyFile } from '../intent/index.js';
import { createEngine, analyzeRun, lensesFromConfig, enableAddons, a11yLensOptions } from '../engine/index.js';
import { terminalManualProvider } from '../manual/terminal.js';
import { registerCoverageCommands } from './coverage.js';
import { registerManualCommands } from './manual.js';
import { snapshotMetadata, diffMetadata, impactedJourneys, type MetadataSnapshot } from '../d365/index.js';
import * as sf from '../salesforce/index.js';
import { extractPdf, diffPdfs, bulkCompare, checkDocument, renderHtml, toJson, type DocumentChecks } from '../docs/index.js';
import { generateTotp } from '../identity/index.js';
import { analyzeImpact, loadImpactMapping, changedFilesFromGit, exitCodeWithQuarantine, loadQuarantine, quarantineStatus } from '../insights/index.js';
import { registerLoadCommands } from '../load/cli.js';
import { registerAdoCommands } from './ado.js';
import { registerGitCommands } from './git.js';
import { findJourneyFiles, loadJourneys, filterJourneys, bddOptionsFrom, defaultJourneyPaths } from './journeys.js';
import { isCodeJourneyFile, loadCodeJourneys } from '../runner/code-journeys.js';
import { isFeatureFile } from '../bdd/load.js';
import { validateFeature } from '../bdd/validate.js';
import { initProject, CI_SYSTEMS, type CiSystemName } from './init.js';
import { checkPipelineRequires, finishPipelineRun, isAroundJourney, preparePipelineRun, registerPipelineCommands, selectForPipeline, type PipelineRun } from './pipelines.js';
import { registerOpsCommands } from './ops.js';
import { registerAppCommands } from '../apps/cli.js';
import { registerContractCommands } from './contracts.js';
import { registerMobileCommands } from '../mobile/cli.js';
import { registerBrowserCommands } from '../browser/cli.js';
import { doctorDatabases, registerQueryCommands, validateJourneyQueries } from './queries.js';
import { registerElementCommands } from './elements.js';
import { recordJourney, verifyRecording } from '../recorder/index.js';
import { startStudio } from '../studio/index.js';
import { importFiles, importFormats, verifyImported, writeImported, writeImportAssets, coverageEquivalence, BUILTIN_IMPORT_KINDS, type ImportKind } from '../importers/index.js';
import { loadImporterPlugins, parseImporterOptions } from './importer-plugins.js';
import type { ReportFormat } from '../report/index.js';
import { DEFAULT_PLACEHOLDER, validateExamplesSource, fastRunOptions } from '../runner/index.js';
import { registerLintCommand } from './lint.js';
import { registerVisualCommands } from '../lenses/visual-cli.js';
import { registerSecurityCommands } from './security.js';
import { registerStoriesCommands } from './stories.js';
import { registerSessionsCommands } from './sessions.js';
import { registerTraceCommands } from './trace.js';
import { afterRun, eztestDir, prepareSelection, pullSharedState, recordSelection, registerScaleCommands, runLocksFor, serverClientFor } from './scale.js';
import { registerDoctorCommand } from './doctor.js';
import { studioExtras } from './studio-extras.js';
import { loadPlugins, registries, type PluginSpec, type RunAnalysis } from '../plugins/index.js';
import { createJsonLogger } from '../ops/log.js';
import { verifyMergedRun } from '../scale/merge.js';
import { EZTEST_VERSION } from '../ops/version.js';
import { startWebServer, type WebServerHandle } from '../ops/webserver.js';
import { burnInVerdicts, passedOnRetry } from '../scale/runflags.js';
import { journeyFileMap, watchAndRerun } from './watch.js';
import type { Journey } from '../core/index.js';

export interface CliIO {
  out(s: string): void;
  err(s: string): void;
  cwd: string;
  env: Record<string, string | undefined>;
}

const defaultIO: CliIO = {
  out: (s) => process.stdout.write(s + '\n'),
  err: (s) => process.stderr.write(s + '\n'),
  cwd: process.cwd(),
  env: process.env,
};

const ICON: Record<string, string> = {
  passed: 'PASS ',
  'passed-healed': 'HEAL ',
  failed: 'FAIL ',
  skipped: 'SKIP ',
  blocked: 'BLOCK',
  error: 'ERROR',
};

function list(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Repeatable option: every occurrence is kept. */
function collect(v: string, prev: string[]): string[] {
  return [...prev, v];
}

/** Exit code: 0 only when nothing failed or errored. Healed passes pass but are reported. */
export function exitCodeFor(run: RunResult, quarantined: Iterable<string> = []): number {
  return exitCodeWithQuarantine(run, quarantined);
}

export function buildProgram(io: CliIO = defaultIO): Command {
  const program = new Command();
  program
    .name('eztest')
    .description('EZTest: one-stop, verified test automation (web, API, DB, documents, identity, data, performance, a11y, security).')
    .version(EZTEST_VERSION)
    .showHelpAfterError()
    .configureOutput({ writeOut: (s) => io.out(s.trimEnd()), writeErr: (s) => io.err(s.trimEnd()) });

  const withConfigOpts = (c: Command) =>
    c
      .option('-c, --config <file>', 'config file (default eztest.config.yaml|yml|json)')
      .option('-e, --env <name>', 'environment name (selects config/<env>.* and .env.<env>)')
      .option('--project <name>', 'project overlay (projects.<name> in the config; default EZTEST_PROJECT)');

  const load = async (o: { config?: string; env?: string; project?: string }, overrides: Record<string, unknown> = {}): Promise<LoadedConfig> =>
    loadConfig({ cwd: io.cwd, configFile: o.config, env: o.env, project: o.project, environment: io.env, overrides });

  // ------------------------------------------------------------------ init
  program
    .command('init')
    .description('create eztest.config.yaml, an example journey and a readiness policy')
    .argument('[dir]', 'project directory', '.')
    .addOption(new Option('--ci <system>', 'also add CI pipelines: PR smoke, scheduled nightly regression, on-deploy per environment, shards, JUnit, report, readiness gate').choices([...CI_SYSTEMS]))
    .action(async (dir: string, o: { ci?: CiSystemName }) => {
      const r = await initProject(resolve(io.cwd, dir), { ci: o.ci });
      for (const f of r.created) io.out(`created  ${f}`);
      for (const f of r.skipped) io.out(`exists   ${f} (left unchanged)`);
    });

  // ------------------------------------------------------------------ run
  withConfigOpts(
    program
      .command('run')
      .description('run journeys (.ez, .yaml, .json, code journeys) and Gherkin features (.feature), and write reports')
      .argument('[paths...]', 'journey or feature files or directories (default: journeysDir and the feature folders from config)'),
  )
    .option('-t, --tags <tags>', 'only journeys with any of these tags (comma separated), or a tag expression: "@smoke and not @wip"', list)
    .option('-x, --exclude-tags <tags>', 'skip journeys with any of these tags', list)
    .option('-g, --grep <pattern>', 'only journeys whose id or name matches')
    .addOption(new Option('-b, --browser <name>').choices(['chromium', 'firefox', 'webkit']))
    .option('--browsers <names>', 'cross-browser run: every journey on each browser (chromium,firefox,msedge,chrome,...); result ids end in @<browser>', list)
    .option('--headed', 'show the browser')
    .option('-w, --workers <n>', 'journeys in parallel', (v) => parseInt(v, 10))
    .option('-r, --retries <n>', 'journey retries', (v) => parseInt(v, 10))
    .option('-u, --base-url <url>', 'base URL of the app under test')
    .option('--no-heal', 'disable self-healing')
    .option('--trace', 'record a browser trace zip per journey')
    .addOption(new Option('--screenshots <policy>', 'screenshot policy (default: config screenshots, else every-step)').choices(['every-step', 'on-failure', 'off', 'before-assertions']))
    .option('--lens <names>', 'lenses after every step: a11y, security, visual (":warn" to not fail)', list)
    .option('--update-baselines', 'write visual baselines instead of comparing')
    .option('--update-snapshots', 'write aria snapshot baselines instead of comparing')
    .option('--reporter <formats>', 'report formats: html,json,junit', list)
    .option('--policy <file>', 'readiness policy (default readiness.policyPath from config)')
    .option('--no-analyze', 'skip history/flaky/triage/readiness analysis')
    .option('--fast', 'fast mode: screenshots on failure only, no lenses, fingerprints only when missing, logs kept only for failures')
    .option('--reuse-context', 'reuse one browser context per worker, reset between journeys')
    .option('--shard <i/n>', 'run shard i of n (balanced by historical duration; same plan on every machine)')
    .option('--changed-since <ref>', 'only journeys affected by changes since a git ref (impact mapping + changed journey files)')
    .option('--only-failed <runDir>', 'only journeys that failed or errored in an earlier run')
    .option('--risk <n>', 'only journeys with risk >= n (e.g. 4 or ">=4")')
    .option('--budget <duration>', 'the highest risk-per-minute journeys that fit this time budget (e.g. 15m), from history')
    .option('--impact-mapping <file>', 'impact mapping for --changed-since (default selection.impactMapping)')
    .option('--plan', 'print the selection and shard plan, do not run')
    .option('--publish [url]', 'publish the run to the results server (default server.url)')
    .option('--otlp <endpoint>', 'export the run as an OpenTelemetry trace (OTLP/HTTP JSON), e.g. http://collector:4318')
    .addOption(new Option('--log-format <format>', 'console output: text, or JSON lines with run/journey/step ids').choices(['text', 'json']).default('text'))
    .option('--no-locks', 'ignore resource locks (Locks:) for this run')
    .option('--last-failed', 'only the journeys that failed in the last recorded run (history or results server)')
    .option('--failed-first', 'run previously failing journeys first, then by risk')
    .option('--shuffle [seed]', 'random, reproducible order (the seed is printed)')
    .option('--repeat-each <n>', 'run every selected journey n times (burn-in); mixed outcomes mark it flaky', (v) => parseInt(v, 10))
    .option('--burn-in [n]', 'repeat only new or changed journeys n times (default 5)')
    .option('--max-failures <n>', 'cancel the run after n failed journeys; the rest are skipped', (v) => parseInt(v, 10))
    .addOption(new Option('--retry-strategy <strategy>', 'inline: retry at once; isolated: retry failures after the main pass, one at a time').choices(['inline', 'isolated']))
    .option('--fail-on-flaky', 'exit non-zero when a journey passed only on retry or was flaky in burn-in')
    .addOption(new Option('--manual <mode>', 'manual steps: prompt the tester in this terminal, or skip (recorded as not executed)').choices(['prompt', 'skip']))
    .option('--time-travel', 'record DOM snapshots per step (time-travel trace; feeds the UI coverage map)')
    .option('--watch', 'after the run, re-run changed journeys (and the journeys that call them) on every save')
    .option('--pipeline <name>', 'run a pipelines: entry (its tags, environment, browsers, shards, gate and deployment record); "auto" detects it from the CI stage')
    .action(async (paths: string[], o) => {
     let web: WebServerHandle | undefined;
     const runOnce = async (onlyIds?: string[]): Promise<void> => {
      const overrides: Record<string, unknown> = {};
      // --pipeline: the entry's environment, browsers, retries, workers, impact, budget and CI shard (flags win).
      // EZTEST_PIPELINE names it too (the EZTest task and the YAML templates set it).
      if (!o.pipeline && io.env.EZTEST_PIPELINE) o.pipeline = io.env.EZTEST_PIPELINE;
      const pipe: PipelineRun | undefined = o.pipeline ? await preparePipelineRun(o, overrides, io, load) : undefined;
      if (o.browser) overrides.browser = o.browser;
      if (o.browsers?.length) overrides.browsers = o.browsers;
      if (o.headed) overrides.headless = false;
      if (o.workers) overrides.concurrency = o.workers;
      if (o.retries !== undefined) overrides.retries = o.retries;
      if (o.baseUrl) overrides.baseUrl = o.baseUrl;
      if (o.heal === false) overrides.healing = { enabled: false };
      if (o.lens) overrides.lenses = o.lens;
      // Visual assertion steps ("Expect X to look like the baseline") write baselines too.
      if (o.updateBaselines) process.env.EZTEST_UPDATE_BASELINES = '1';
      // "Expect X to match the aria snapshot ..." writes its baseline instead of comparing.
      if (o.updateSnapshots) process.env.EZTEST_UPDATE_SNAPSHOTS = '1';
      // Shards on one machine can derive ports/dirs from ${EZTEST_SHARD_INDEX} in the config.
      if (o.shard) {
        const [i, n] = String(o.shard).split('/');
        process.env.EZTEST_SHARD = String(o.shard);
        process.env.EZTEST_SHARD_INDEX = i;
        process.env.EZTEST_SHARD_TOTAL = n;
      }
      const json = o.logFormat === 'json';
      const loaded = await load(o, overrides);
      const log = json ? createJsonLogger({ level: 'info', mask: (t) => loaded.masker.mask(t), base: { service: 'eztest' }, out: io.out }) : undefined;
      const out = (s: string) => (log ? log.info(s.trim()) : io.out(s));
      const warn = (s: string) => (log ? log.warn(s) : io.err(`warning: ${s}`));
      for (const w of [...loaded.warnings, ...(loaded.envWarnings ?? [])]) warn(w);
      const cfg = loaded.config;
      if (cfg.webServer && !web) web = await startWebServer(cfg.webServer, { cwd: io.cwd, log: out });
      const addons = await enableAddons(loaded, { cwd: io.cwd });
      // Plugins register phrasings, steps, lenses, stores and publishers before journeys are parsed.
      const plugins = await loadPlugins(cfg.plugins as PluginSpec[], { cwd: io.cwd });
      if (plugins.plugins.length) out(`plugins: ${plugins.plugins.map((p) => `${p.name}${p.version ? `@${p.version}` : ''}`).join(', ')}`);
      const client = await serverClientFor(loaded, io.cwd);
      await pullSharedState(loaded, io.cwd, client, warn, out);

      const { journeys: all, errors } = await loadJourneys(paths.length ? paths : pipe?.resolution.entry.journeys?.length ? pipe.resolution.entry.journeys : defaultJourneyPaths(cfg, io.cwd), io.cwd, { bdd: bddOptionsFrom(cfg) });
      for (const e of errors) io.err(`error: ${e.file}: ${e.message}`);
      if (errors.length) {
        plugins.off();
        process.exitCode = 2;
        return;
      }
      // Journeys tagged @library are reusable sub-journeys ("Run journey ..."): callable, not run on their own.
      const filtered = filterJourneys(all, { tags: o.tags, exclude: o.excludeTags, grep: o.grep, ids: onlyIds }).filter((j) => !j.tags.includes('library'));
      // Setup:/Teardown: journeys run around whatever is selected (not filtered by tags, not sharded).
      const around = filterJourneys(all, { exclude: o.excludeTags }).filter(isAroundJourney);
      let tests = filtered.filter((j) => !isAroundJourney(j));
      if (pipe) tests = selectForPipeline(pipe, tests, out);
      if (pipe && !(await checkPipelineRequires(pipe, client, io))) {
        plugins.off();
        process.exitCode = 1;
        return;
      }
      const prepared = await prepareSelection(tests, o, { loaded, cwd: io.cwd, client, warn });
      for (const line of prepared.lines) out(line);
      const journeys = prepared.journeys.length ? [...prepared.journeys, ...around] : prepared.journeys;
      if (o.plan) {
        if (prepared.plan) for (const s of prepared.plan.shards) out(`plan shard ${s.index}/${prepared.plan.total}: ${s.journeyIds.length} journeys, ~${Math.round(s.estimatedMs / 1000)} s`);
        out(`would run ${journeys.length} journeys: ${journeys.map((j) => j.id).join(', ')}`);
        plugins.off();
        addons.off();
        return;
      }
      if (journeys.length === 0) {
        plugins.off();
        addons.off();
        // An empty shard or an empty selection is not a failure; an empty filter is.
        if (prepared.selection || prepared.shard) {
          out(prepared.shard ? `shard ${prepared.shard.index}/${prepared.shard.total} has no journeys` : 'selection matched no journeys; nothing to run');
          process.exitCode = 0;
          return;
        }
        io.err('No journeys matched (nothing run counts as a failure).');
        process.exitCode = 1;
        return;
      }

      let runId = '';
      const events = new EventBus();
      // --max-failures: cancel the run once enough journeys failed; journeys not started are skipped.
      const cancel = o.maxFailures ? new AbortController() : undefined;
      let failures = 0;
      if (cancel) {
        events.on((e: EzEvent) => {
          if (e.type === 'journey:end' && (e.status === 'failed' || e.status === 'error') && ++failures >= o.maxFailures && !cancel.signal.aborted) {
            out(`max failures reached (${failures}): cancelling the rest of the run`);
            cancel.abort();
          }
        });
      }
      // Code-journey steps (eztest/sdk) have line-based ids (L12): print their intent instead.
      const intents = new Map<string, string>();
      events.on((e: EzEvent) => {
        if (e.type === 'step:start' && /(?:^|-)L\d+(?:-\d+)?$/.test(e.stepId)) intents.set(e.stepId, e.intent);
        if (log) {
          if (e.type === 'run:start') runId = e.runId;
          if (e.type === 'journey:start') log.info('journey start', { runId, journeyId: e.journeyId, name: e.name });
          else if (e.type === 'step:end') log.info('step end', { runId, journeyId: e.journeyId, stepId: e.stepId, status: e.status, durationMs: e.durationMs });
          else if (e.type === 'heal') log.info('heal', { runId, journeyId: e.journeyId, stepId: e.stepId, tier: e.tier, verified: e.verified });
          else if (e.type === 'journey:end') log.info('journey end', { runId, journeyId: e.journeyId, status: e.status });
          else if (e.type === 'run:start' || e.type === 'run:end') log.info(e.type === 'run:start' ? 'run start' : 'run end', { runId });
          return;
        }
        if (e.type === 'journey:start') io.out(`\n> ${e.name}`);
        else if (e.type === 'step:end') io.out(`  ${ICON[e.status] ?? e.status} ${intents.get(e.stepId) ?? e.stepId} (${e.durationMs} ms)`);
        else if (e.type === 'heal') io.out(`         healed via ${e.tier}${e.verified ? ' (verified)' : ' (NOT verified)'}`);
        else if (e.type === 'journey:end') io.out(`  => ${e.status}`);
      });

      const locks = o.locks === false ? undefined : runLocksFor(journeys, loaded, io.cwd, client);
      const reporterNames: string[] = o.reporter ?? cfg.reporters;
      const builtinFormats = reporterNames.filter((r: string) => ['html', 'json', 'junit'].includes(r)) as ReportFormat[];
      const pluginReporters = reporterNames.filter((r: string) => !['html', 'json', 'junit', 'console'].includes(r));
      const engine = await createEngine(loaded, {
        cwd: io.cwd,
        addons,
        ...(client ? { serverClient: client } : {}),
        ...(pipe ? { pipeline: pipe.resolution.name } : {}),
        logger: log ? log.child({}) : createMaskedLogger(cfg.logLevel === 'debug' ? 'debug' : 'warn', loaded.masker),
        runOptions: {
          events,
          library: all,
          ...(o.trace ? { trace: true } : {}),
          ...(locks ? { locks } : {}),
          ...(cancel ? { signal: cancel.signal } : {}),
          ...(o.retryStrategy ? { retryStrategy: o.retryStrategy } : {}),
          screenshots: o.screenshots ?? cfg.screenshots ?? 'every-step',
          lenses: lensesFromConfig(cfg.lenses, io.cwd, { updateBaselines: !!o.updateBaselines, branchBaselines: cfg.vcs.branchScope.baselines, defaultBranch: cfg.vcs.branchScope.defaultBranch, a11y: a11yLensOptions(cfg) }),
          // Manual steps: ask in the terminal (--manual prompt), or record them as not executed.
          ...(o.manual === 'prompt' ? { manual: terminalManualProvider({ input: process.stdin, output: (t: string) => io.out(t), masker: loaded.masker }) } : {}),
          ...(o.timeTravel ? { timeTravel: { ...cfg.trace.timeTravel, enabled: true, masker: loaded.masker } } : {}),
          ...(o.fast ? fastRunOptions() : {}),
          ...(o.reuseContext ? { reuseContext: true } : {}),
        },
      });
      let run: RunResult;
      try {
        run = await engine.run(journeys);
      } finally {
        await engine.close();
        addons.off();
      }
      const runDir = join(engine.runOptions.outputDir, run.runId);
      await recordSelection(runDir, prepared);
      const s = run.summary;
      if (log) log.info('run summary', { runId: run.runId, ...s, runDir });
      else io.out(`\n${s.total} journeys: ${s.passed} passed, ${s.passedHealed} passed-healed, ${s.failed} failed, ${s.skipped} skipped, ${s.errors} errors`);
      if (s.passedHealed) out(`Healed steps need review: ${join(runDir, 'heal-proposals.json')}`);
      // Reliability: environment problems, and the circuit breaker.
      if (run.health?.preflight && !run.health.preflight.ok) io.err(`environment unavailable: ${run.health.preflight.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.message}`).join('; ')} (nothing ran)`);
      if (run.health?.circuit) io.err(`circuit breaker opened after ${run.health.circuit.afterJourney}: ${run.health.circuit.notRun} journey(s) not run (${run.health.circuit.reason})`);

      let analysis: RunAnalysis = {};
      if (o.analyze !== false) {
        const policy = o.policy ?? cfg.readiness.policyPath;
        const a = await analyzeRun(runDir, {
          historyPath: resolve(io.cwd, '.eztest', 'history.json'),
          // A shard is a slice of a run: `eztest merge` records the combined run into history.
          recordHistory: !prepared.shard,
          readinessPolicyPath: policy ? resolve(io.cwd, policy) : undefined,
          formats: builtinFormats.length ? builtinFormats : ['html', 'json'],
          ...(cfg.vcs.branchScope.history && run.environment?.gitBranch ? { historyBranch: run.environment.gitBranch } : {}),
          journeys: all, uiCoverage: cfg.coverage.ui, a11yScopes: cfg.accessibility.scopes,
        });
        if (a.uiCoverage) out(`UI coverage: ${a.uiCoverage.totals.tested}/${a.uiCoverage.totals.elements} elements (${(a.uiCoverage.totals.percent * 100).toFixed(1)}%) on ${a.uiCoverage.totals.pages} page(s); eztest coverage ui ${runDir}`);
        for (const t of a.failureTags.filter((x) => x.tags.length)) out(`tags: ${t.journeyId}: ${t.tags.join(', ')}`);
        analysis = { triage: a.triage, readiness: a.readiness, flaky: a.flaky };
        for (const w of a.warnings) warn(w);
        for (const v of a.triage.verdicts) {
          if (log) log.info('triage', { runId: run.runId, journeyId: v.journeyId, category: v.category, confidence: v.confidence, needsHuman: v.status === 'needs-human', reason: v.reasons[0] ?? '' });
          else io.out(`triage: ${v.journeyId}: ${v.category} (${Math.round(v.confidence * 100)}%) - ${v.reasons[0] ?? ''}${v.status === 'needs-human' ? ' [needs human review]' : ''}`);
        }
        if (a.readiness) out(`readiness: ${a.readiness.decision} (score ${a.readiness.score})`);
        for (const [fmt, p] of Object.entries(a.reports)) out(`report ${fmt}: ${p}`);
      }
      if (prepared.shard) out(`shard ${prepared.shard.index}/${prepared.shard.total} done; combine the shards with: eztest merge <shard run dirs> -o <dir>`);
      const published = await afterRun(runDir, analysis, { publish: o.publish, otlp: o.otlp, pluginReporters }, { loaded, cwd: io.cwd, client, io, out });
      // Deployment test record (results server, Azure DevOps) and the pipeline's readiness gate.
      const gateExit = pipe ? await finishPipelineRun(pipe, runDir, analysis.readiness, { loaded, io, out, client, runUrl: published.runUrl }) : undefined;
      plugins.off();
      // Quarantined journeys still run, but their failures do not fail the run (see .eztest/quarantine.json).
      let activeQuarantine: string[] = [];
      try {
        const qs = quarantineStatus(await loadQuarantine(join(dirname(engine.runOptions.outputDir), '.eztest', 'quarantine.json')));
        activeQuarantine = qs.active.map((q) => q.journeyId);
        if (o.analyze === false) for (const w of qs.warnings) io.err(`warning: ${w}`);
      } catch (e) {
        io.err(`warning: ${(e as Error).message}`);
      }
      const excused = run.journeys.filter((j) => activeQuarantine.includes(j.journeyId) && (j.status === 'failed' || j.status === 'error'));
      if (excused.length) io.out(`quarantined (not failing the run): ${excused.map((j) => `${j.journeyId} ${j.status}`).join(', ')}`);
      process.exitCode = gateExit ?? exitCodeFor(run, activeQuarantine);
      // Burn-in and flakiness verdicts.
      const flakyIds = new Set<string>();
      if (prepared.order?.repeat) {
        for (const v of burnInVerdicts(run)) {
          out(`burn-in: ${v.journeyId}: ${v.passed}/${v.runs} passed -> ${v.verdict}`);
          if (v.verdict === 'flaky') flakyIds.add(v.journeyId);
        }
      }
      for (const id of passedOnRetry(run)) {
        // With the root cause the runner's flake classifier recorded (overlay, timing, detached, network, data).
        const flake = run.journeys.find((j) => j.journeyId === id)?.reliability?.flake;
        out(`flaky: ${id} passed only on retry${flake ? ` (cause: ${flake.cause}) - ${flake.reason}` : ''}`);
        flakyIds.add(id);
      }
      if (o.failOnFlaky && flakyIds.size) {
        io.err(`--fail-on-flaky: ${flakyIds.size} flaky journey(s): ${[...flakyIds].join(', ')}`);
        process.exitCode = 1;
      }
      lastRun = { all, files: journeyFiles };
     };
     let lastRun: { all: Journey[]; files: Map<string, string> } | undefined;
     let journeyFiles = new Map<string, string>();
     try {
      if (o.watch) journeyFiles = await journeyFileMap(paths, io.cwd, o, io.env).catch(() => new Map<string, string>());
      await runOnce();
      if (o.watch) await watchAndRerun(io, paths, o, () => lastRun, runOnce);
     } finally {
      await web?.stop();
     }
    });

  // ------------------------------------------------------------------ lint
  registerLintCommand(program, io, (o) => load(o));

  // ------------------------------------------------------------------ validate / convert
  program
    .command('validate')
    .description('parse journeys and features and report errors without running them (features: undefined and ambiguous steps too)')
    .argument('[paths...]', 'journey files or directories', ['journeys'])
    .option('-c, --config <file>')
    .option('-e, --env <name>')
    .option('--project <name>', 'project overlay (projects.<name>)')
    .option('--placeholder <regex>', 'values that must not remain in Examples data (default REPLACE_WITH_*)')
    .action(async (paths: string[], o: { config?: string; env?: string; project?: string; placeholder?: string }) => {
      // Add-ons (e.g. Dynamics 365) contribute phrasings; enable them when a config is present.
      const hasConfig = o.config || ['eztest.config.yaml', 'eztest.config.yml', 'eztest.config.json'].some((f) => existsSync(join(io.cwd, f)));
      const loaded = hasConfig ? await load(o) : undefined;
      const addons = loaded ? await enableAddons(loaded, { cwd: io.cwd }) : { off: () => {} };
      const placeholder = o.placeholder ? new RegExp(o.placeholder) : DEFAULT_PLACEHOLDER;
      const files = await findJourneyFiles(paths, io.cwd, { code: true });
      let bad = 0;
      const parsed: Array<{ file: string; journey: Awaited<ReturnType<typeof loadJourneyFile>> }> = [];
      for (const f of files) {
        // Gherkin features: syntax, then every step bound to a step definition or an EZTest phrasing.
        if (isFeatureFile(f)) {
          try {
            const v = await validateFeature(f, { ...(loaded ? bddOptionsFrom(loaded.config) : {}), cwd: io.cwd });
            for (const j of v.journeys) parsed.push({ file: f, journey: j });
            const errs = v.problems.filter((p) => p.severity === 'error');
            bad += errs.length;
            if (!errs.length) io.out(`ok     ${f} (${v.journeys.length} scenario${v.journeys.length === 1 ? '' : 's'}; ${v.bound.definition} step${v.bound.definition === 1 ? '' : 's'} with definitions, ${v.bound.ez} EZTest phrasing${v.bound.ez === 1 ? '' : 's'})`);
            for (const p of v.problems) {
              (p.severity === 'error' ? io.err : io.out)(`${p.severity === 'error' ? 'error ' : 'warn  '} ${f}${p.line ? `:${p.line}` : ''}: ${p.message}${p.snippet ? `\n${p.snippet.split('\n').map((l) => `         ${l}`).join('\n')}` : ''}`);
            }
          } catch (e) {
            bad++;
            io.err(`error  ${f}: ${e instanceof Error ? e.message : String(e)}`);
          }
          continue;
        }
        // Code journeys (eztest/sdk): loading the module checks it compiles and declares journeys.
        if (isCodeJourneyFile(f)) {
          try {
            const js = await loadCodeJourneys(f, { cwd: io.cwd });
            for (const j of js) parsed.push({ file: f, journey: j });
            io.out(`ok     ${f} (${js.length} code journey${js.length === 1 ? '' : 's'}: ${js.map((j) => j.id).join(', ')})`);
          } catch (e) {
            bad++;
            io.err(`error  ${f}: ${e instanceof Error ? e.message : String(e)}`);
          }
          continue;
        }
        try {
          const j = await loadJourneyFile(f);
          parsed.push({ file: f, journey: j });
          io.out(`ok     ${f} (${j.steps.length} steps)`);
          // External Examples: missing files, filters matching nothing, unknown columns, placeholder values.
          if (j.examplesFrom) {
            const issues = await validateExamplesSource(j.examplesFrom, { baseDir: io.cwd, placeholder });
            for (const i of issues) {
              if (i.severity === 'error') bad++;
              (i.severity === 'error' ? io.err : io.out)(`${i.severity === 'error' ? 'error ' : i.severity === 'warning' ? 'warn  ' : 'info  '} ${f}: ${i.message}`);
            }
          }
        } catch (e) {
          bad++;
          io.err(`error  ${f}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // Named queries: the query exists, its params are supplied, and the connection is configured.
      for (const p of await validateJourneyQueries(parsed, loaded, io.cwd)) {
        bad++;
        io.err(`error  ${p.file}: ${p.message}`);
      }
      if (files.length === 0) io.err('No journey files found.');
      addons.off();
      process.exitCode = bad || files.length === 0 ? 1 : 0;
    });

  program
    .command('convert')
    .description('convert a journey between .ez, .yaml and .json')
    .argument('<file>', 'journey file')
    .addOption(new Option('--to <format>').choices(['ez', 'yaml', 'json']).makeOptionMandatory())
    .option('-o, --out <file>', 'write to file instead of stdout')
    .action(async (file: string, o: { to: 'ez' | 'yaml' | 'json'; out?: string }) => {
      const j = await loadJourneyFile(resolve(io.cwd, file));
      const text = o.to === 'ez' ? journeyToEzScript(j) : o.to === 'yaml' ? toYaml(j) : JSON.stringify(j, null, 2) + '\n';
      if (o.out) await writeFile(resolve(io.cwd, o.out), text);
      else io.out(text.trimEnd());
    });

  // ------------------------------------------------------------------ analyze / evidence
  program
    .command('analyze')
    .description('re-run history, flaky scoring, triage, readiness and reports for a run directory')
    .argument('<runDir>')
    .option('--policy <file>', 'readiness policy YAML')
    .option('--no-history', 'do not record this run into history')
    .action(async (runDir: string, o: { policy?: string; history: boolean }) => {
      const a = await analyzeRun(resolve(io.cwd, runDir), {
        historyPath: resolve(io.cwd, '.eztest', 'history.json'),
        recordHistory: o.history,
        readinessPolicyPath: o.policy ? resolve(io.cwd, o.policy) : undefined,
      });
      io.out(JSON.stringify({ triage: a.triage.counts, needsHuman: a.triage.needsHuman, readiness: a.readiness?.decision, reports: a.reports }, null, 2));
    });

  const evidence = program.command('evidence').description('evidence vault tools');
  evidence
    .command('verify')
    .description('verify the hash-chained evidence manifest of a run (detects any tampering)')
    .argument('<runDir>')
    .action(async (runDir: string) => {
      const dir = resolve(io.cwd, runDir);
      if (existsSync(join(dir, 'shards'))) {
        // A merged run: its own chain, every shard chain, and the links between them.
        const m = await verifyMergedRun(dir);
        io.out(`${m.ok ? 'VALID' : 'TAMPERED'}: merged run, ${m.merged.entries} entries, head ${m.merged.head.slice(0, 16)}...; ${m.shards.length} shard chain(s): ${m.shards.map((x) => `${x.shardRunId} ${x.ok && x.linked ? 'linked' : 'BROKEN'}`).join(', ')}`);
        for (const p of m.problems) io.err(`  ${p}`);
        process.exitCode = m.ok ? 0 : 1;
        return;
      }
      const r = await verifyEvidence(dir);
      io.out(`${r.ok ? 'VALID' : 'TAMPERED'}: ${r.entries} entries, head ${r.head.slice(0, 16)}...`);
      for (const p of r.problems) io.err(`  ${p}`);
      process.exitCode = r.ok ? 0 : 1;
    });

  // ------------------------------------------------------------------ documents
  const docs = program.command('docs').description('document assurance: PDFs, reports, statements');
  docs
    .command('extract')
    .description('extract fields/tables from a PDF (JSON to stdout)')
    .argument('<pdf>')
    .option('--template <file>', 'YAML/JSON extraction template')
    .action(async (pdf: string, o: { template?: string }) => {
      const template = o.template ? await readFile(resolve(io.cwd, o.template), 'utf8') : undefined;
      const doc = await extractPdf(resolve(io.cwd, pdf), { template });
      io.out(JSON.stringify({ metadata: doc.metadata, fields: doc.fields, tables: doc.tables, findings: doc.findings }, null, 2));
    });
  docs
    .command('compare')
    .description('semantic PDF-to-PDF diff')
    .argument('<a>')
    .argument('<b>')
    .option('--mask <regex...>', 'regex of text to ignore (dates, ids)')
    .option('--template <file>')
    .option('--html <file>', 'write an HTML diff report')
    .action(async (a: string, b: string, o: { mask?: string[]; template?: string; html?: string }) => {
      const template = o.template ? await readFile(resolve(io.cwd, o.template), 'utf8') : undefined;
      const r = await diffPdfs(resolve(io.cwd, a), resolve(io.cwd, b), { masks: o.mask, template });
      if (o.html) await writeFile(resolve(io.cwd, o.html), renderHtml(r, { title: `${a} vs ${b}` }));
      io.out(toJson(r));
      process.exitCode = r.identical ? 0 : 1;
    });
  docs
    .command('bulk')
    .description('compare two folders of documents and cluster the differences')
    .argument('<dirA>')
    .argument('<dirB>')
    .option('--mask <regex...>')
    .option('--html <file>')
    .action(async (dirA: string, dirB: string, o: { mask?: string[]; html?: string }) => {
      const r = await bulkCompare(resolve(io.cwd, dirA), resolve(io.cwd, dirB), { masks: o.mask });
      if (o.html) await writeFile(resolve(io.cwd, o.html), renderHtml(r, { title: 'Bulk document comparison' }));
      io.out(toJson(r));
    });
  docs
    .command('check')
    .description('check a PDF: page count, clauses, placeholders, PII, masking')
    .argument('<pdf>')
    .requiredOption('--checks <file>', 'YAML/JSON checks definition')
    .action(async (pdf: string, o: { checks: string }) => {
      const { parse } = await import('yaml');
      const checks = parse(await readFile(resolve(io.cwd, o.checks), 'utf8')) as DocumentChecks;
      const r = checkDocument(await extractPdf(resolve(io.cwd, pdf)), checks);
      io.out(toJson(r));
      process.exitCode = r.status === 'PASS' ? 0 : 1;
    });

  // ------------------------------------------------------------------ secrets / identity
  const secret = program.command('secret').description('secret helpers');
  secret
    .command('encrypt')
    .description('encrypt a value for config files as ENC(...) using EZTEST_MASTER_KEY')
    .argument('<value>')
    .action((value: string) => {
      const key = io.env.EZTEST_MASTER_KEY;
      if (!key) {
        io.err('EZTEST_MASTER_KEY is not set.');
        process.exitCode = 1;
        return;
      }
      io.out(encryptValue(value, key));
    });
  program
    .command('totp')
    .description('print the current TOTP code for a base32 secret (for debugging MFA test users)')
    .argument('<secret>')
    .action((s: string) => io.out(generateTotp(s)));

  // ------------------------------------------------------------------ impact / perf / ado
  program
    .command('impact')
    .description('which journeys a change affects, and which changed areas no journey covers')
    .requiredOption('--mapping <file>', 'impact mapping YAML (globs -> journeys/tags/requirements)')
    .option('--since <ref>', 'git base ref, e.g. origin/main')
    .option('--files <files>', 'changed files (comma separated)', list)
    .option('--journeys <paths>', 'journey paths', list)
    .action(async (o: { mapping: string; since?: string; files?: string[]; journeys?: string[] }) => {
      const changed = o.files ?? (o.since ? await changedFilesFromGit({ cwd: io.cwd, base: o.since }) : []);
      if (!changed.length) {
        io.err('No changed files (use --files or --since).');
        process.exitCode = 1;
        return;
      }
      const { journeys } = await loadJourneys(o.journeys ?? ['journeys'], io.cwd);
      const r = analyzeImpact(
        changed,
        journeys.map((j) => ({ id: j.id, name: j.name, tags: j.tags, requirements: j.requirements, risk: j.risk })),
        await loadImpactMapping(resolve(io.cwd, o.mapping)),
      );
      io.out(JSON.stringify(r, null, 2));
    });

  // EZTest Load: performance and load testing (docs/load.md).
  registerLoadCommands(program, io);

  // Azure DevOps (publish, import, sync, suites, configurations, requirements, gate) and Git (hooks, bisect, pr, git).
  registerAdoCommands(program, io, (o) => load(o));
  registerGitCommands(program, io, (o) => load(o));

  // ------------------------------------------------------------------ record
  program
    .command('record')
    .description('record a journey by using the app (Alt+Click an element to record an expectation); close the browser to finish')
    .argument('<url>', 'start URL (absolute, or relative to --base-url)')
    .option('-o, --out <file>', 'output .ez file (YAML when the journey uses iframes)', 'journeys/recorded.ez')
    .option('--base-url <url>', 'origin recorded URLs are made relative to')
    .addOption(new Option('-b, --browser <name>').choices(['chromium', 'firefox', 'webkit']))
    .option('--headless', 'record without a visible browser (for scripted use)')
    .option('--name <name>', 'journey name')
    .option('--tags <tags>', 'journey tags', list)
    .option('--verify', 'replay the recording right away and report each step')
    .option('--var <k=v...>', 'values for recorded variables (e.g. password=...) used by --verify')
    .action(async (url: string, o) => {
      io.out('Recording... use the app; Alt+Click an element to assert its text. Close the browser to finish.');
      const project = await load(o).then((c) => ({ baseUrl: c.config.baseUrl })).catch(() => ({}));
      const result = await recordJourney({
        url,
        baseUrl: o.baseUrl,
        project,
        browser: o.browser,
        headless: !!o.headless,
        name: o.name,
        tags: o.tags,
        until: 'close',
        onStep: (line) => io.out(`  + ${line}`),
      });
      const out = resolve(io.cwd, result.ez ? o.out : o.out.replace(/\.ez$/i, '.yaml'));
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, result.ez || toYaml(result.journey));
      io.out(`saved ${out} (${result.journey.steps.length} steps)`);
      for (const w of result.warnings) io.err(`warning: ${w}`);
      if (result.variables.length) io.out(`supply at run time: ${result.variables.join(', ')} (recorded values are never stored)`);
      if (o.verify) {
        const vars = Object.fromEntries((o.var ?? []).map((kv: string) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
        const v = await verifyRecording(result, { variables: vars, headless: true });
        for (const s of v.steps) io.out(`  ${(ICON[s.status] ?? s.status).padEnd(5)} ${s.intent}${s.error ? ` - ${s.error}` : ''}`);
        io.out(v.passed ? 'replay: all steps passed' : `replay: ${v.failed.length} step(s) need attention`);
        process.exitCode = v.passed ? 0 : 1;
      }
    });

  // ------------------------------------------------------------------ studio
  program
    .command('studio')
    .description('open EZTest Studio: a local web UI to edit, run, record, import and review tests')
    .option('-p, --port <n>', 'port (default: a free port)', (v) => parseInt(v, 10))
    .option('--no-open', 'do not open a browser')
    .option('-e, --env <name>', 'start with this environment active')
    .option('--project <name>', 'start with this project active')
    .action(async (o: { port?: number; open?: boolean; env?: string; project?: string }) => {
      const env = { ...io.env, ...(o.env ? { EZTEST_ENV: o.env } : {}), ...(o.project ? { EZTEST_PROJECT: o.project } : {}) };
      // Plugin routes/pages, and shared team state when a results server is configured.
      const extras = await studioExtras(io, env);
      const s = await startStudio({ cwd: io.cwd, port: o.port, openBrowser: o.open !== false, env, routeDefs: extras.routeDefs });
      io.out(`EZTest Studio: ${s.url}`);
      io.out('Local only (127.0.0.1); the link contains a one-time session token. Ctrl+C to stop.');
      for (const line of extras.lines) io.out(line);
      await new Promise<void>((done) => {
        const stop = () => {
          extras.close();
          void s.close().then(done);
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });

  // ------------------------------------------------------------------ import (Migration Factory)
  withConfigOpts(program.command('import'))
    .description('convert tests from Cucumber, Playwright, Selenium, Excel/CSV manual cases, RSAT Task Recorder, OpenAPI/Swagger specs or Postman collections into .ez journeys; importer plugins add more formats (docs/plugins.md)')
    .argument('<paths...>', 'source files or directories')
    .option('-o, --out <dir>', 'output directory', 'journeys/imported')
    .addOption(new Option('--kind <kind>', 'built-in format (default: detect per file)').choices([...BUILTIN_IMPORT_KINDS]))
    .option('--from <format>', `source format: a built-in kind or an importer plugin's name (now: ${importFormats().map((f) => f.name).join(', ')})`)
    .option('--plugin <module>', 'load an importer plugin (npm package or path; repeatable) in addition to importers.plugins in config', collect, [])
    .option('--importer-option <key=value>', 'option for the importer plugin (repeatable; a bare key is true)', collect, [])
    .option('--role <role>', 'OpenAPI: Identity Vault role for secured operations ("as <role>")')
    .option('--postman-env <file>', 'Postman: environment export whose non-secret values become Variables')
    .option('--sheet <name>', 'worksheet for Excel imports')
    .option('--tags <tags>', 'tags added to every imported journey', list)
    .option('--verify', 'run the imported journeys and mark each one verified or not (needs baseUrl)')
    .addOption(new Option('--as <mode>', 'Excel/CSV manual cases: automated (TODO lines), manual (Manual: steps run in Studio) or hybrid').choices(['automated', 'manual', 'hybrid']))
    .action(async (paths: string[], o) => {
      const importers = await loadImporterPlugins({ cwd: io.cwd, env: io.env, extra: o.plugin, warn: (s) => io.err(`warning: ${s}`) });
      let report;
      try {
        const from = o.from as string | undefined;
        report = await importFiles(paths.map((p) => resolve(io.cwd, p)), {
          ...(o.as ? { manualMode: o.as } : {}),
          kind: o.kind as ImportKind | undefined,
          ...(from ? { from, importerOptions: { ...(importers.options[from] ?? {}), ...parseImporterOptions(o.importerOption) } } : {}),
          sheet: o.sheet,
          tags: o.tags,
          cwd: io.cwd,
          outDir: o.out,
          ...(o.role ? { role: o.role } : {}),
          ...(o.postmanEnv ? { postmanEnvironment: o.postmanEnv } : {}),
        });
      } finally {
        importers.off();
      }
      for (const w of report.warnings) io.err(`warning: ${w}`);
      let verification;
      if (o.verify) {
        await writeImportAssets(report, resolve(io.cwd, o.out));
        const loaded = await load(o);
        const engine = await createEngine(loaded, { cwd: io.cwd, runOptions: { screenshots: 'on-failure' } });
        try {
          verification = await verifyImported(report, engine.runOptions);
        } finally {
          await engine.close();
        }
      }
      const written = await writeImported(report, resolve(io.cwd, o.out), verification);
      const eq = coverageEquivalence(report, verification);
      const c = report.coverage;
      io.out(`imported ${report.journeys.length} journeys from ${report.files.length} file(s) -> ${o.out}`);
      io.out(`steps converted ${c.convertedSteps}/${c.sourceSteps}, assertions converted ${c.convertedAssertions}/${c.assertions}, ${report.todo.length} TODO line(s)`);
      if (report.diagnostics?.length) io.out(`source-suite diagnostics: ${report.diagnostics.length} (see the report)`);
      if (verification) io.out(`verified by replay: ${eq.totals.verifiedSteps} steps, ${eq.totals.verifiedAssertions} assertions`);
      io.out(`report: ${written.reportMd}`);
      process.exitCode = report.journeys.length === 0 ? 1 : 0;
    });

  // ------------------------------------------------------------------ dynamics 365
  const d365 = program.command('d365').description('Dynamics 365 / Power Apps: metadata snapshots and release-wave impact');
  withConfigOpts(d365.command('snapshot'))
    .description('save Dataverse metadata (fields, labels, types, required levels) for the configured entities')
    .option('-o, --out <file>', 'output JSON', 'd365-metadata.json')
    .action(async (o) => {
      const loaded = await load(o);
      const addons = await enableAddons(loaded, { cwd: io.cwd });
      if (!addons.d365) throw new Error('No d365: block in the configuration');
      try {
        const entities = ((loaded.config.d365 as { entities?: string[] }).entities) ?? [];
        const snap = await snapshotMetadata(addons.d365.client, entities, { source: String((loaded.config.d365 as { url?: string }).url) });
        await writeFile(resolve(io.cwd, o.out), JSON.stringify(snap, null, 2));
        io.out(`wrote ${o.out}: ${Object.keys(snap.entities).length} entities`);
      } finally {
        addons.off();
      }
    });
  withConfigOpts(d365.command('impact'))
    .description('compare two metadata snapshots (e.g. before/after a release wave) and list impacted journeys')
    .requiredOption('--before <file>')
    .requiredOption('--after <file>')
    .argument('[paths...]', 'journey files or directories', ['journeys'])
    .action(async (paths: string[], o) => {
      const loaded = await load(o);
      const addons = await enableAddons(loaded, { cwd: io.cwd });
      try {
        const read = async (f: string) => JSON.parse(await readFile(resolve(io.cwd, f), 'utf8')) as MetadataSnapshot;
        const diff = diffMetadata(await read(o.before), await read(o.after));
        const { journeys } = await loadJourneys(paths, io.cwd);
        const impacted = journeys.length ? impactedJourneys(diff, journeys) : [];
        io.out(JSON.stringify({ changes: diff.changes, impacted }, null, 2));
        process.exitCode = impacted.some((j) => j.reasons.some((r) => r.severity === 'breaking')) ? 1 : 0;
      } finally {
        addons.off();
      }
    });

  // ------------------------------------------------------------------ salesforce
  const sfCmd = program.command('salesforce').description('Salesforce Lightning: describe snapshots, release impact, permission matrix');
  withConfigOpts(sfCmd.command('snapshot'))
    .description('save describe metadata (fields, labels, types, picklists, required) for the configured objects')
    .option('-o, --out <file>', 'output JSON', 'salesforce-describe.json')
    .option('--release <name>', 'label the snapshot with a release name, e.g. "Summer"')
    .action(async (o) => {
      const loaded = await load(o);
      const addons = await enableAddons(loaded, { cwd: io.cwd });
      if (!addons.salesforce) throw new Error('No salesforce: block in the configuration');
      try {
        const snap = await addons.salesforce.snapshot({ release: o.release });
        await writeFile(resolve(io.cwd, o.out), JSON.stringify(snap, null, 2));
        io.out(`wrote ${o.out}: ${Object.keys(snap.objects).length} objects`);
      } finally {
        addons.off();
      }
    });
  withConfigOpts(sfCmd.command('impact'))
    .description('compare two describe snapshots (e.g. before/after a release) and list impacted journeys')
    .requiredOption('--before <file>')
    .requiredOption('--after <file>')
    .argument('[paths...]', 'journey files or directories', ['journeys'])
    .action(async (paths: string[], o) => {
      const loaded = await load(o);
      const addons = await enableAddons(loaded, { cwd: io.cwd });
      try {
        const read = async (f: string) => JSON.parse(await readFile(resolve(io.cwd, f), 'utf8')) as sf.DescribeSnapshot;
        const diff = sf.diffDescribe(await read(o.before), await read(o.after));
        const { journeys } = await loadJourneys(paths, io.cwd);
        const impacted = journeys.length ? sf.impactedJourneys(diff, journeys) : [];
        io.out(JSON.stringify({ changes: diff.changes, impacted }, null, 2));
        process.exitCode = impacted.some((j) => j.breaking > 0) ? 1 : 0;
      } finally {
        addons.off();
      }
    });
  withConfigOpts(sfCmd.command('permissions'))
    .description('check object, field and tab access for every configured user against expectations (via the REST API)')
    .requiredOption('--checks <file>', 'YAML/JSON list of { object, field?, tab?, expect, users? }')
    .option('-o, --out <file>', 'write the full report as JSON')
    .action(async (o) => {
      const loaded = await load(o);
      const addons = await enableAddons(loaded, { cwd: io.cwd });
      if (!addons.salesforce) throw new Error('No salesforce: block in the configuration');
      try {
        const { parse } = await import('yaml');
        const raw = parse(await readFile(resolve(io.cwd, o.checks), 'utf8')) as unknown;
        const checks = (Array.isArray(raw) ? raw : (raw as { checks?: unknown })?.checks) as sf.PermissionCheck[] | undefined;
        if (!Array.isArray(checks)) throw new Error(`${o.checks}: expected a list of checks (or { checks: [...] })`);
        const report = await addons.salesforce.permissionMatrix(checks);
        if (o.out) await writeFile(resolve(io.cwd, o.out), JSON.stringify(report, null, 2));
        for (const v of report.violations) io.out(`VIOLATION ${v.user}: ${v.subject} expected ${v.expected}, API reports ${v.api}${v.ui ? `, UI shows ${v.ui}` : ''}`);
        io.out(`${report.results.length} checks for ${report.users.length} users: ${report.violations.length} violation(s)`);
        process.exitCode = report.passed ? 0 : 1;
      } finally {
        addons.off();
      }
    });

  registerOpsCommands(program, io, (o) => load(o));
  registerAppCommands(program, io, (o) => load(o));
  registerBrowserCommands(program, io);
  registerQueryCommands(program, io, (o) => load(o));
  registerElementCommands(program, io, (o) => load(o));
  registerContractCommands(program, io, (o) => load(o));
  registerMobileCommands(program, io);
  registerVisualCommands(program, io);
  registerSecurityCommands(program, io, (o) => load(o));
  registerStoriesCommands(program, io, (o) => load(o));
  registerSessionsCommands(program, io);
  registerTraceCommands(program, io);

  program
    .command('lsp')
    .description('the .ez language server (LSP over stdio) for VS Code and other editors')
    .option('--stdio', 'talk LSP over stdin/stdout (the default and only transport)')
    .action(async () => {
      const { startLanguageServer } = await import('../lsp/index.js');
      await startLanguageServer({ root: io.cwd });
    });

  registerScaleCommands(program, io, (o) => load(o));
  registerPipelineCommands(program, io, (o) => load(o));
  registerCoverageCommands(program, io, (o) => load(o));
  registerManualCommands(program, io, (o) => load(o));
  registerDoctorCommand(program, io, (o) => load(o));
  // CLI commands contributed by plugins (loaded by bin.ts before parsing).
  for (const hook of registries.commands.list()) hook(program, io);

  return program;
}
