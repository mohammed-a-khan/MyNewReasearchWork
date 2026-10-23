/**
 * `eztest ado ...`: Azure DevOps from the command line (and from the EZTest
 * pipeline task): publish, import, sync, suites, configurations,
 * requirements, the readiness gate and a credential check.
 */
import { Command, Option } from 'commander';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  adoClientFromConfig,
  areaFor,
  commentOnRequirements,
  ensureConfiguration,
  ensureQuerySuite,
  importTestCases,
  listConfigurations,
  parseAdoTags,
  pipelineLinksFromEnv,
  publishRun,
  queryRequirements,
  requirementsWiql,
  resolveConfiguration,
  syncJourneys,
  syncSuiteByTag,
  testCaseWiql,
  BROWSER_VALUE,
  attachRunFiles,
  type AdoClient,
  type PublishSummary,
} from '../alm-ado/index.js';
import { adoWeb, recordIntegration, rerenderReports } from '../report/index.js';
import type { LoadedConfig } from '../config/index.js';
import type { RunResult } from '../core/index.js';
import { identityVaultFromConfig } from '../identity/index.js';
import { writeImported } from '../importers/index.js';
import { HistoryStore, scoreHistory, type ReadinessResult } from '../insights/index.js';
import { loadJourneyFile } from '../intent/index.js';
import { assigneeFor, loadCodeowners, ownersOf } from '../git/codeowners.js';
import { GitRepo } from '../git/repo.js';
import { findJourneyFiles } from './journeys.js';
import type { CliIO } from './program.js';

type Loader = (o: { config?: string; env?: string; project?: string }) => Promise<LoadedConfig>;

const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);
const int = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`not a positive integer: ${v}`);
  return n;
};

export async function adoClientFor(loaded: LoadedConfig, cwd: string, env: Record<string, string | undefined>): Promise<AdoClient> {
  const vault = identityVaultFromConfig(loaded.config, { cwd, masker: loaded.masker, env });
  return adoClientFromConfig(loaded.config, { env, masker: loaded.masker, resolveSecret: (r) => vault.registry.resolve(r) });
}

export interface GateOutcome {
  decision?: ReadinessResult['decision'];
  score?: number;
  action: 'pass' | 'warn' | 'fail';
  message: string;
}

/** The readiness gate: NO_GO fails and GO_WITH_RISKS warns by default; both configurable. */
export function readinessGate(readiness: ReadinessResult | undefined, o: { noGo?: 'fail' | 'warn' | 'pass'; goWithRisks?: 'fail' | 'warn' | 'pass'; missing?: 'fail' | 'warn' | 'pass' } = {}): GateOutcome {
  if (!readiness) return { action: o.missing ?? 'warn', message: 'no readiness decision in the report (run with a readiness policy: readiness.policyPath)' };
  const why = readiness.gates.filter((g) => g.status !== 'pass').map((g) => `${g.gate}: ${g.summary}`).slice(0, 5).join('; ');
  const msg = `EZTest readiness ${readiness.decision} (score ${readiness.score})${why ? `: ${why}` : ''}`;
  const action = readiness.decision === 'NO_GO' ? (o.noGo ?? 'fail') : readiness.decision === 'GO_WITH_RISKS' ? (o.goWithRisks ?? 'warn') : 'pass';
  return { decision: readiness.decision, score: readiness.score, action, message: msg };
}

async function journeyFilesRel(paths: string[], cwd: string): Promise<Array<{ path: string; rel: string }>> {
  let root = cwd;
  try {
    root = (await GitRepo.open(cwd)).root;
  } catch {
    // not a git checkout
  }
  return (await findJourneyFiles(paths, cwd)).map((p) => ({ path: p, rel: relative(root, p).split(sep).join('/') }));
}

export interface AdoRunPublishOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  runDir: string;
  plan?: number;
  suite?: number;
  configuration?: string;
  runName?: string;
  createBugs?: boolean;
  trace?: boolean;
  evidencePack?: string;
  stepResults?: boolean;
  flaky?: boolean;
  commentRequirements?: boolean;
  /** Record the result in integrations.json, render the reports again with the links and attach them (default true). */
  report?: boolean;
  /** An AdoClient to use (tests); default from the configuration. */
  client?: AdoClient;
}

/**
 * Publish a run directory to Azure Test Plans (`eztest ado publish`, and `eztest run` with
 * ado.publishResults), record what was published in integrations.json, render the HTML report again
 * with the test run, result, test case and bug links, and attach that report to the test run.
 */
export async function publishRunToAdo(loaded: LoadedConfig, o: AdoRunPublishOptions): Promise<{ summary: PublishSummary; requirements: Array<{ requirement: string; action: string }>; reports: Partial<Record<string, string>>; attached: string[] }> {
  const cfg = loaded.config;
  const ac = cfg.ado;
  const dir = o.runDir;
  const client = o.client ?? (await adoClientFor(loaded, o.cwd, o.env));
  const run = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as RunResult;
  const pack = o.evidencePack ?? join(dir, 'evidence-pack.zip');
  const reportFiles = ['report.html', 'summary.html'];
  // The report is attached after publishing, rendered again with the run's links.
  const attachments: Array<{ path: string; comment?: string }> = ['report.html', 'junit.xml', 'report.json'].filter((f) => o.report === false || !reportFiles.includes(f)).map((f) => join(dir, f)).filter((p) => existsSync(p)).map((path) => ({ path }));
  if (existsSync(pack)) attachments.push({ path: pack, comment: 'EZTest evidence pack (signed, hash-chained)' });
  let configurationId: number | undefined;
  const cfgArg = o.configuration;
  if (cfgArg) configurationId = /^\d+$/.test(cfgArg) ? Number(cfgArg) : (await resolveConfiguration(client, { x: cfgArg }, ['x']))?.id;
  else configurationId = (await resolveConfiguration(client, ac.configurations, [cfg.environment, run.environment?.browser, BROWSER_VALUE[run.environment?.browser ?? '']]))?.id;
  let flakyScores;
  if (o.flaky || ac.markFlaky) {
    try {
      const h = await HistoryStore.open(resolve(o.cwd, '.eztest', 'history.json'));
      const scoped = cfg.vcs.branchScope.history && run.environment?.gitBranch ? h.forBranch(run.environment.gitBranch) : h;
      flakyScores = scoreHistory(scoped);
    } catch {
      flakyScores = [];
    }
  }
  const co = await GitRepo.open(o.cwd).then((r) => loadCodeowners(r.root)).catch(() => undefined);
  const files = co ? await journeyFilesRel([cfg.journeysDir], o.cwd) : [];
  const fileOfJourney = new Map<string, string>();
  for (const f of files) {
    try {
      fileOfJourney.set((await loadJourneyFile(f.path)).id, f.rel);
    } catch {
      // skip unparsable journeys
    }
  }
  const fileFor = (id: string) => fileOfJourney.get(id) ?? [...fileOfJourney.entries()].find(([k]) => id.startsWith(`${k}-`))?.[1];
  const links = pipelineLinksFromEnv(o.env);
  const at = () => new Date().toISOString();
  let summary: PublishSummary;
  try {
    summary = await publishRun(run, {
      client,
      planId: o.plan ?? ac.testPlanId,
      suiteId: o.suite ?? ac.testSuiteId,
      runName: o.runName,
      links,
      configurationId,
      attachments,
      resultEvidence: { runDir: dir, kinds: o.trace ? ['screenshot', 'trace'] : ['screenshot'] },
      stepResults: o.stepResults !== false,
      flaky: { enabled: !!(o.flaky || ac.markFlaky), scores: flakyScores },
      bugs: {
        enabled: !!o.createBugs || ac.createBugs,
        areaPath: ac.areaPath,
        iterationPath: ac.iterationPath,
        pathsFor: (id, tags) => areaFor({ tags, path: fileFor(id) }, ac.paths, { areaPath: ac.areaPath, iterationPath: ac.iterationPath }),
        assignTo: (id) => {
          const f = fileFor(id);
          return co && f ? assigneeFor(ownersOf(co, f), cfg.vcs.owners) : undefined;
        },
      },
    });
  } catch (e) {
    if (o.report !== false) {
      await recordIntegration(dir, { ado: { collectionUrl: client.collectionUrl, project: client.project, publish: { status: 'failed', reason: client.redact((e as Error).message).slice(0, 500), at: at(), results: [], unmapped: [], missingPoints: [], attachments: 0, warnings: [] } } });
      await rerenderReports(dir).catch(() => undefined);
    }
    throw e;
  }
  const requirements: Array<{ requirement: string; action: string }> = [];
  if (o.commentRequirements || ac.commentOnRequirements) {
    for (const x of await commentOnRequirements(client, run, { published: summary })) requirements.push({ requirement: String(x.requirement), action: String(x.action) });
  }
  const reports: Partial<Record<string, string>> = {};
  const attached: string[] = [];
  if (o.report !== false) {
    const problems = [...(summary.missingPoints.length ? [`${summary.missingPoints.length} test case(s) without a test point (${summary.missingPoints.map((m) => `#${m.testCaseId}`).slice(0, 5).join(', ')})`] : []), ...summary.warnings.filter((w) => !/already present|reusing/.test(w)).slice(0, 3)];
    const base = { collectionUrl: client.collectionUrl, project: client.project };
    const buildUrl = links.buildId ? adoWeb.build(base, links.buildId) : undefined;
    await recordIntegration(dir, {
      ado: {
        ...base,
        publish: {
          status: problems.length ? 'partial' : 'success', ...(problems.length ? { reason: problems.join('; ') } : {}), at: at(),
          runId: summary.runId, runName: summary.runName, runUrl: adoWeb.testRun(base, summary.runId),
          ...((o.plan ?? ac.testPlanId) ? { planId: o.plan ?? ac.testPlanId } : {}), ...((o.suite ?? ac.testSuiteId) ? { suiteId: o.suite ?? ac.testSuiteId } : {}),
          results: summary.results.map((r) => ({ journeyId: r.journeyId, testCaseId: r.testCaseId, ...(r.resultId ? { resultId: r.resultId, url: adoWeb.testResult(base, summary.runId, r.resultId) } : {}), outcome: r.outcome })),
          unmapped: summary.unmapped, missingPoints: summary.missingPoints, attachments: summary.attachments.length, warnings: summary.warnings,
        },
        bugs: summary.bugs.map((b) => ({ journeyId: b.journeyId, id: b.id, action: b.action, signature: b.signature, url: adoWeb.workItem(base, b.id) })),
        ...(links.buildId || links.buildNumber ? { build: { ...(links.buildId ? { id: String(links.buildId) } : {}), ...(links.buildNumber ? { number: links.buildNumber } : {}), ...(buildUrl ? { url: buildUrl } : {}) } } : {}),
        ...(o.env.RELEASE_RELEASENAME ? { release: { name: o.env.RELEASE_RELEASENAME, ...(o.env.RELEASE_RELEASEWEBURL ? { url: o.env.RELEASE_RELEASEWEBURL } : {}), ...(o.env.RELEASE_ENVIRONMENTNAME ? { environment: o.env.RELEASE_ENVIRONMENTNAME } : {}) } } : {}),
        ...(requirements.length ? { requirementsCommented: requirements.map((r) => ({ requirement: r.requirement, action: r.action, ...(/^\d+$/.test(r.requirement) ? { url: adoWeb.workItem(base, r.requirement) } : {}) })) } : {}),
      },
    });
    Object.assign(reports, await rerenderReports(dir));
    const late = reportFiles.map((f) => join(dir, f)).filter((p) => existsSync(p)).map((path) => ({ path, comment: 'EZTest report with the Azure DevOps links of this run' }));
    try {
      for (const a of await attachRunFiles(client, summary.runId, late)) if (a.action === 'uploaded') attached.push(a.fileName);
    } catch (e) {
      summary.warnings.push(`report not attached to run ${summary.runId}: ${client.redact((e as Error).message).slice(0, 200)}`);
    }
  }
  return { summary, requirements, reports, attached };
}

export function registerAdoCommands(program: Command, io: CliIO, load: Loader): void {
  const withConfig = (c: Command) =>
    c
      .option('-c, --config <file>', 'config file (default eztest.config.yaml|yml|json)')
      .option('-e, --env <name>', 'environment name (selects config/<env>.* and .env.<env>)')
      .option('--project <name>', 'project overlay (projects.<name> in the config)');
  const ado = program.command('ado').description('Azure DevOps: Test Plans, Boards, Repos and Pipelines');

  // ------------------------------------------------------------------ publish
  withConfig(ado.command('publish'))
    .description('publish a run to Azure Test Plans: results, step results, iterations, attachments, bugs')
    .argument('<runDir>')
    .option('--plan <id>', 'test plan (default: tags or ado.testPlanId)', int)
    .option('--suite <id>', 'test suite (default: tags or ado.testSuiteId)', int)
    .option('--configuration <nameOrId>', 'test configuration (default: ado.configurations[env or browser])')
    .option('--run-name <name>')
    .option('--create-bugs', 'file deduplicated bugs for failures')
    .option('--trace', 'also attach trace bundles to results')
    .option('--evidence-pack <zip>', 'attach this evidence pack to the run (default <runDir>/evidence-pack.zip when present)')
    .option('--no-step-results', 'do not publish per-step action results')
    .option('--flaky', 'mark flaky results (retried passes, flaky history) through the flaky-test API')
    .option('--comment-requirements', 'post a result summary on the requirements the journeys trace to')
    .action(async (runDir: string, o) => {
      const loaded = await load(o);
      const r = await publishRunToAdo(loaded, { cwd: io.cwd, env: io.env, runDir: resolve(io.cwd, runDir), plan: o.plan, suite: o.suite, configuration: o.configuration, runName: o.runName, createBugs: !!o.createBugs, trace: !!o.trace, evidencePack: o.evidencePack ? resolve(io.cwd, o.evidencePack) : undefined, stepResults: o.stepResults !== false, flaky: !!o.flaky, commentRequirements: !!o.commentRequirements, report: true });
      io.out(JSON.stringify(r.summary, null, 2));
      for (const x of r.requirements) io.out(`requirement ${x.requirement}: comment ${x.action}`);
      // stdout stays the publish summary (JSON); the report note goes to stderr.
      if (r.reports.html) io.err(`report html: ${r.reports.html} (with the Azure DevOps links${r.attached.length ? `; attached to test run ${r.summary.runId}` : ''})`);
    });

  // ------------------------------------------------------------------ import
  withConfig(ado.command('import'))
    .description('import manual test cases (steps, expected results, shared steps, parameters) into .ez journeys')
    .option('--plan <id>', 'test plan', int)
    .option('--suite <id>', 'test suite (with its child suites unless --no-recursive)', int)
    .option('--no-recursive', 'only the suite itself')
    .option('--query <wiql>', 'WIQL query returning test cases')
    .option('--saved-query <idOrPath>', 'saved query id or path, e.g. "Shared Queries/Regression"')
    .option('--area <path>', 'test cases under an area path')
    .option('--tag <tag>', 'test cases with a work item tag')
    .option('--ids <ids>', 'test case ids (comma separated)', (v) => list(v).map(int))
    .option('-o, --out <dir>', 'output directory', 'journeys/imported')
    .option('--no-plan-tags', 'do not add @TestPlanId / @TestSuiteId tags')
    .option('--as <mode>', 'automated (default: TODO lines for what the grammar cannot read), manual (Manual: steps run in Studio) or hybrid (automate what reads, keep the rest manual)')
    .action(async (o) => {
      if (o.as && !['automated', 'manual', 'hybrid'].includes(o.as)) throw new Error('--as must be automated, manual or hybrid');
      const loaded = await load(o);
      const client = await adoClientFor(loaded, io.cwd, io.env);
      const wiql = o.query ?? (o.area || o.tag ? testCaseWiql({ area: o.area, tag: o.tag }) : undefined);
      const out = resolve(io.cwd, o.out);
      const taken = new Set<string>();
      for (const f of await findJourneyFiles([loaded.config.journeysDir], io.cwd).catch(() => [])) {
        if (resolve(f).startsWith(out + sep)) continue;
        try {
          taken.add((await loadJourneyFile(f)).id);
        } catch {
          // ignore
        }
      }
      const report = await importTestCases({
        client,
        source: { planId: o.plan ?? loaded.config.ado.testPlanId, suiteId: o.suite, recursive: o.recursive, wiql, savedQuery: o.savedQuery, ids: o.ids },
        ids: taken,
        planTags: o.planTags,
        ...(o.as ? { manualMode: o.as } : {}),
      });
      const w = await writeImported(report, out);
      io.out(`imported ${report.converted.length} test case(s): ${report.coverage.convertedSteps}/${report.coverage.sourceSteps} steps, ${report.coverage.convertedAssertions}/${report.coverage.assertions} expected results converted; ${report.todo.length} TODO`);
      for (const f of w.ezFiles) io.out(`wrote ${relative(io.cwd, f)}`);
      for (const x of report.warnings) io.err(`warning: ${x}`);
    });

  // ------------------------------------------------------------------ sync
  withConfig(ado.command('sync'))
    .description('create or update test cases from journeys (steps, parameters, associated automation); writes @TestCaseId back')
    .argument('[paths...]', 'journey files or directories (default journeysDir)')
    .option('--plan <id>', 'add the test cases to this plan...', int)
    .option('--suite <id>', '...and suite', int)
    .option('--dry-run', 'show what would change; write nothing')
    .option('--write', 'write @TestCaseId tags into new journeys (default: print the diff)')
    .option('--no-update', 'do not update test cases that exist')
    .action(async (paths: string[], o) => {
      const loaded = await load(o);
      const ac = loaded.config.ado;
      const client = await adoClientFor(loaded, io.cwd, io.env);
      const files = await journeyFilesRel(paths.length ? paths : [loaded.config.journeysDir], io.cwd);
      const r = await syncJourneys({
        client,
        files,
        planId: o.plan ?? ac.testPlanId,
        suiteId: o.suite ?? ac.testSuiteId,
        areaPath: ac.areaPath,
        iterationPath: ac.iterationPath,
        paths: ac.paths,
        dryRun: !!o.dryRun,
        writeBack: !!o.write,
        update: o.update,
      });
      for (const it of r.items) {
        io.out(`${it.action.padEnd(12)} ${it.file}${it.testCaseId ? ` -> test case ${it.testCaseId}` : ''}${it.changedFields?.length ? ` (${it.changedFields.join(', ')})` : ''}${it.error ? `: ${it.error}` : ''}`);
        if (it.change && it.change.before !== it.change.after && (!o.write || o.dryRun)) io.out(it.change.unified);
      }
      for (const w of r.warnings) io.err(`warning: ${w}`);
      if (r.items.some((i) => i.action === 'error')) process.exitCode = 1;
    });

  // ------------------------------------------------------------------ suites
  withConfig(ado.command('suite'))
    .description('build a suite from a journey tag (static, kept in sync) or a WIQL query (query-based)')
    .requiredOption('--plan <id>', 'test plan', int)
    .option('--parent <id>', 'parent suite (default: the plan root)', int)
    .option('--tag <tag>', 'journeys with this tag')
    .option('--query <wiql>', 'query-based suite with this WIQL')
    .option('--name <name>', 'suite name (default: @<tag>)')
    .option('--prune', 'remove test cases whose journeys no longer carry the tag')
    .action(async (o) => {
      const loaded = await load(o);
      const client = await adoClientFor(loaded, io.cwd, io.env);
      if (o.query) {
        if (!o.name) throw new Error('--name is required for a query-based suite');
        const r = await ensureQuerySuite(client, o.plan, o.name, o.query, o.parent);
        io.out(`suite ${r.suite.id} "${r.suite.name}" ${r.action}`);
        return;
      }
      if (!o.tag) throw new Error('give --tag or --query');
      const js: Array<{ tags: string[]; testCaseIds: number[] }> = [];
      for (const f of await findJourneyFiles([loaded.config.journeysDir], io.cwd)) {
        try {
          const j = await loadJourneyFile(f);
          js.push({ tags: j.tags, testCaseIds: parseAdoTags(j.tags).testCaseIds });
        } catch {
          // unparsable journey
        }
      }
      const r = await syncSuiteByTag(client, { planId: o.plan, parentSuiteId: o.parent, name: o.name, tag: o.tag, journeys: js, prune: !!o.prune });
      io.out(`suite ${r.suiteId}${r.created ? ' (created)' : ''}: +${r.added.length} -${r.removed.length}`);
    });

  // ------------------------------------------------------------------ configurations
  const configs = ado.command('configurations').description('test configurations (browser / environment)');
  withConfig(configs.command('list')).action(async (o) => {
    const client = await adoClientFor(await load(o), io.cwd, io.env);
    for (const c of await listConfigurations(client)) io.out(`${String(c.id).padStart(6)}  ${c.name}${c.values?.length ? `  (${c.values.map((v) => `${v.name}=${v.value}`).join(', ')})` : ''}`);
  });
  withConfig(configs.command('ensure'))
    .argument('<name>')
    .option('--browser <value>', 'Browser test variable, e.g. Chrome')
    .option('--os <value>', 'Operating System test variable')
    .action(async (name: string, o) => {
      const client = await adoClientFor(await load(o), io.cwd, io.env);
      const values: Record<string, string> = {};
      if (o.browser) values.Browser = BROWSER_VALUE[o.browser.toLowerCase()] ?? o.browser;
      if (o.os) values['Operating System'] = o.os;
      const r = await ensureConfiguration(client, name, values);
      io.out(`configuration ${r.configuration.id} "${r.configuration.name}" ${r.created ? 'created' : 'exists'}`);
    });

  // ------------------------------------------------------------------ requirements
  withConfig(ado.command('requirements'))
    .description('pull requirements by WIQL into traceability (.eztest/requirements-ado.json)')
    .option('--query <wiql>', 'WIQL query')
    .option('--saved-query <idOrPath>')
    .option('--area <path>', 'requirements under an area path')
    .option('--iteration <path>', 'requirements in an iteration')
    .action(async (o) => {
      const loaded = await load(o);
      const client = await adoClientFor(loaded, io.cwd, io.env);
      const wiql = o.query ?? (o.savedQuery ? undefined : requirementsWiql({ area: o.area ?? loaded.config.ado.areaPath, iteration: o.iteration }));
      const requirements = await queryRequirements(client, { wiql, savedQuery: o.savedQuery });
      const out = resolve(io.cwd, '.eztest', 'requirements-ado.json');
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, JSON.stringify({ fetchedAt: new Date().toISOString(), query: wiql ?? o.savedQuery, requirements }, null, 2));
      io.out(`${requirements.length} requirement(s) -> ${relative(io.cwd, out)}`);
    });

  // ------------------------------------------------------------------ gate
  ado
    .command('gate')
    .description('the readiness gate for a pipeline stage: NO_GO fails, GO_WITH_RISKS warns (configurable)')
    .argument('<runDir>')
    .addOption(new Option('--on-no-go <action>', 'what NO_GO does').choices(['fail', 'warn', 'pass']).default('fail'))
    .addOption(new Option('--on-risks <action>', 'what GO_WITH_RISKS does').choices(['fail', 'warn', 'pass']).default('warn'))
    .addOption(new Option('--on-missing <action>', 'when the run has no readiness decision').choices(['fail', 'warn', 'pass']).default('warn'))
    .action(async (runDir: string, o) => {
      const rj = join(resolve(io.cwd, runDir), 'report.json');
      const readiness = existsSync(rj) ? (JSON.parse(await readFile(rj, 'utf8')) as { insights?: { readiness?: ReadinessResult } }).insights?.readiness : undefined;
      const g = readinessGate(readiness, { noGo: o.onNoGo, goWithRisks: o.onRisks, missing: o.onMissing });
      const inPipeline = io.env.TF_BUILD === 'True';
      if (g.action === 'fail') {
        io.err(inPipeline ? `##vso[task.logissue type=error]${g.message}` : `FAIL ${g.message}`);
        process.exitCode = 1;
      } else if (g.action === 'warn') {
        io.out(inPipeline ? `##vso[task.logissue type=warning]${g.message}` : `WARN ${g.message}`);
        // In a script step this marks the step "succeeded with issues"; the EZTest task completes itself (EZTEST_TASK).
        if (inPipeline && !io.env.EZTEST_TASK) io.out('##vso[task.complete result=SucceededWithIssues;]readiness warning');
      } else io.out(`PASS ${g.message}`);
    });

  // ------------------------------------------------------------------ summary (pipeline results tab, build summary)
  ado
    .command('summary')
    .description('write the run summary the EZTest pipeline results tab renders (JSON) and the build summary (Markdown)')
    .argument('<runDir>')
    .option('--json <file>', 'results tab data (default <runDir>/eztest-tab.json)')
    .option('--markdown <file>', 'build summary Markdown (default <runDir>/eztest-summary.md)')
    .option('--journeys <paths>', 'journey paths (for file:line of failing steps)', list)
    .action(async (runDir: string, o: { json?: string; markdown?: string; journeys?: string[] }) => {
      const { buildTabData } = await import('../vcs/tab.js');
      const dir = resolve(io.cwd, runDir);
      const r = await buildTabData(dir, io.cwd, o.journeys ?? ['journeys'], { buildUrl: io.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI && io.env.SYSTEM_TEAMPROJECT && io.env.BUILD_BUILDID ? `${io.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI.replace(/\/+$/, '')}/${encodeURIComponent(io.env.SYSTEM_TEAMPROJECT)}/_build/results?buildId=${io.env.BUILD_BUILDID}` : undefined });
      const json = resolve(io.cwd, o.json ?? join(runDir, 'eztest-tab.json'));
      const md = resolve(io.cwd, o.markdown ?? join(runDir, 'eztest-summary.md'));
      await writeFile(json, JSON.stringify(r.data, null, 2));
      await writeFile(md, r.markdown);
      io.out(`${r.data.decision}: ${json}, ${md}`);
    });

  // ------------------------------------------------------------------ whoami
  withConfig(ado.command('whoami'))
    .description('check the Azure DevOps credentials (prints the identity and auth method, never the token)')
    .action(async (o) => {
      const client = await adoClientFor(await load(o), io.cwd, io.env);
      const r = await client.request<{ authenticatedUser?: { providerDisplayName?: string; id?: string } }>('GET', client.collection('/_apis/connectionData'), { preview: 'preview' });
      io.out(`${client.authKind}: ${r.data?.authenticatedUser?.providerDisplayName ?? 'unknown'} (${client.collectionUrl}, project ${client.project}, api-version ${client.apiVersion})`);
    });
}
