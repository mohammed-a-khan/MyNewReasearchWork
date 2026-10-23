/**
 * Git commands: `eztest hooks install|uninstall|run`, `eztest bisect`,
 * `eztest pr report|propose` (any host) and `eztest git promote|owners`.
 */
import { Argument, Command, Option } from 'commander';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { LoadedConfig } from '../config/index.js';
import { identityVaultFromConfig } from '../identity/index.js';
import { analyzeImpact, HistoryStore, loadImpactMapping } from '../insights/index.js';
import { loadJourneyFile } from '../intent/index.js';
import { bisectJourney } from '../git/bisect.js';
import { promoteBranchBaselines, promoteMergedBranches } from '../git/branch.js';
import { loadCodeowners, ownersOf } from '../git/codeowners.js';
import { installHooks, preCommit, prePushPlan, runCli, uninstallHooks, type HookName } from '../git/hooks.js';
import { GitRepo } from '../git/repo.js';
import { gitlabCodeQuality, proposeChange, reportPullRequest, resolveProvider, type ChangeKind, type VcsProvider } from '../vcs/index.js';
import { adoClientFor } from './ado.js';
import { findJourneyFiles } from './journeys.js';
import type { CliIO } from './program.js';

type Loader = (o: { config?: string; env?: string; project?: string }) => Promise<LoadedConfig>;

/** Split a command string into argv without a shell: whitespace separated, single/double quotes group. */
export function splitArgv(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[3]));
  return out;
}

const hasConfig = (cwd: string, file?: string) => !!file || ['eztest.config.yaml', 'eztest.config.yml', 'eztest.config.json'].some((f) => existsSync(resolve(cwd, f)));

export async function providerFromConfig(loaded: LoadedConfig | undefined, io: CliIO, o: { provider?: string } = {}): Promise<VcsProvider> {
  const vcs = loaded?.config.vcs;
  let token: string | undefined;
  if (vcs?.token && loaded) {
    const vault = identityVaultFromConfig(loaded.config, { cwd: io.cwd, masker: loaded.masker, env: io.env });
    token = vcs.token.startsWith('secret://') ? await vault.registry.resolve(vcs.token) : vcs.token;
    loaded.masker.add(token);
  }
  const r = await resolveProvider({
    cwd: io.cwd,
    env: io.env,
    provider: (o.provider as never) ?? vcs?.provider,
    hosts: vcs?.hosts,
    apiUrl: vcs?.apiUrl,
    token,
    adoClient: loaded ? () => adoClientFor(loaded, io.cwd, io.env) : undefined,
    adoRepository: loaded?.config.ado.repository,
  });
  return r.provider;
}

export function registerGitCommands(program: Command, io: CliIO, load: Loader): void {
  // ------------------------------------------------------------------ hooks
  const hooks = program.command('hooks').description('git hooks: pre-commit validate + lint of changed journeys, optional pre-push impacted run');
  hooks
    .command('install')
    .option('--pre-push', 'also install the pre-push hook (runs the journeys the push impacts)')
    .option('--strict', 'pre-commit fails on lint warnings too')
    .option('--mapping <file>', 'impact mapping for pre-push (journeys selected for changed app files)')
    .option('--command <cmd>', 'how the hook starts eztest (default: npx --no-install eztest)')
    .option('--force', 'replace an earlier backup of a foreign hook')
    .action(async (o) => {
      const r = await installHooks(io.cwd, {
        hooks: o.prePush ? ['pre-commit', 'pre-push'] : ['pre-commit'],
        ...(o.command ? { command: splitArgv(o.command) } : {}),
        force: !!o.force,
        args: { 'pre-commit': o.strict ? ['--strict'] : [], 'pre-push': o.mapping ? ['--mapping', o.mapping] : [] },
      });
      for (const h of r) io.out(`${h.action.padEnd(28)} ${h.hook} (${h.path})`);
    });
  hooks
    .command('uninstall')
    .action(async () => {
      const r = await uninstallHooks(io.cwd);
      io.out(r.length ? `removed ${r.join(', ')}` : 'no EZTest hooks installed');
    });
  hooks
    .command('run')
    .description('run a hook now (what the installed hooks call)')
    .addArgument(new Argument('<hook>', 'pre-commit or pre-push').choices(['pre-commit', 'pre-push']))
    .option('--strict', 'fail on warnings')
    .option('--mapping <file>', 'impact mapping (pre-push)')
    .option('--dry-run', 'pre-push: list the journeys instead of running them')
    .allowExcessArguments(true)
    .action(async (hook: HookName, o) => {
      const loaded = hasConfig(io.cwd) ? await load({}).catch(() => undefined) : undefined;
      const journeysDir = loaded?.config.journeysDir ?? 'journeys';
      if (hook === 'pre-commit') {
        const r = await preCommit(io.cwd, { strict: !!o.strict, journeysDirs: [journeysDir.replace(/^\.\//, '')] });
        for (const i of r.issues) (i.severity === 'error' ? io.err : io.out)(`${i.severity === 'error' ? 'error' : 'warn '} ${i.file}${i.line ? `:${i.line}` : ''} [${i.rule}] ${i.message}`);
        io.out(`eztest pre-commit: ${r.files.length} journey file(s) checked, ${r.issues.filter((i) => i.severity === 'error').length} error(s), ${r.issues.filter((i) => i.severity === 'warning').length} warning(s)`);
        process.exitCode = r.ok ? 0 : 1;
        return;
      }
      const journeys = [];
      if (o.mapping) {
        for (const f of await findJourneyFiles([journeysDir], io.cwd)) {
          try {
            const j = await loadJourneyFile(f);
            const repo = await GitRepo.open(io.cwd);
            journeys.push({ id: j.id, name: j.name, tags: j.tags, requirements: j.requirements, risk: j.risk ?? 3, file: repo.rel(f) });
          } catch {
            // unparsable journeys are pre-commit's business
          }
        }
      }
      const plan = await prePushPlan(io.cwd, { mapping: o.mapping ? resolve(io.cwd, o.mapping) : undefined, journeys, journeysDirs: [journeysDir] });
      if (!plan.journeyFiles.length) {
        io.out(`eztest pre-push: no impacted journeys${plan.base ? ` since ${plan.base}` : ' (no upstream to compare with)'}`);
        return;
      }
      io.out(`eztest pre-push: ${plan.journeyFiles.length} impacted journey(s) since ${plan.base}: ${plan.journeyFiles.join(', ')}`);
      if (o.dryRun) return;
      const repo = await GitRepo.open(io.cwd);
      const code = await runCli([process.execPath, process.argv[1], 'run', ...plan.journeyFiles.map((f) => resolve(repo.root, f))], io.cwd);
      if (code !== 0) io.err('eztest pre-push: impacted journeys failed (push with --no-verify to skip)');
      process.exitCode = code;
    });

  // ------------------------------------------------------------------ bisect
  program
    .command('bisect')
    .description('find the commit that broke a journey (app and tests in one repository), in a separate git worktree')
    .argument('<journey>', 'journey file')
    .requiredOption('--good <rev>', 'a commit where the journey passes')
    .option('--bad <rev>', 'a commit where it fails', 'HEAD')
    .option('--setup <cmd...>', 'commands run in the worktree before each test, e.g. "npm ci"')
    .option('--cmd <cmd>', 'test command (journey path appended; default: this eztest run)')
    .addOption(new Option('--journey-from <where>', 'journey version to run').choices(['current', 'candidate']).default('current'))
    .option('--no-verify-ends', 'do not test good and bad first')
    .action(async (journey: string, o) => {
      const r = await bisectJourney({
        cwd: io.cwd,
        journey,
        good: o.good,
        bad: o.bad,
        setup: (o.setup ?? []).map(splitArgv),
        command: o.cmd ? splitArgv(o.cmd) : [process.execPath, process.argv[1], 'run'],
        journeyFrom: o.journeyFrom,
        verifyEnds: o.verifyEnds,
        log: (l) => io.out(l),
      });
      if (r.status === 'found' && r.firstBad) io.out(`first bad commit: ${r.firstBad.sha} ${r.firstBad.subject} (${r.firstBad.author}, ${r.firstBad.date}); ${r.tested} of ${r.total} commits tested`);
      else if (r.status === 'inconclusive') io.out(`inconclusive: skipped commits hide the answer; it is one of ${r.candidates?.join(', ')}`);
      else io.out(r.status === 'good-is-bad' ? `the journey already fails at ${o.good}` : r.status === 'bad-is-good' ? `the journey passes at ${o.bad}` : 'no commits between good and bad');
      process.exitCode = r.status === 'found' ? 0 : 1;
    });

  // ------------------------------------------------------------------ pull requests (any host)
  const pr = program.command('pr').description('pull request integration (Azure Repos, GitHub, GitLab, Bitbucket)');
  pr.command('report')
    .description('post the run to its pull request: status / check with annotations, and the summary comment (updated in place)')
    .argument('<runDir>')
    .option('-c, --config <file>')
    .option('-e, --env <name>')
    .option('--project <name>')
    .addOption(new Option('--provider <kind>').choices(['azure-devops', 'github', 'gitlab', 'bitbucket']))
    .option('--sha <sha>', 'commit (default: CI variables, else the run)')
    .option('--pr <n>', 'pull request number', (v) => parseInt(v, 10))
    .option('--mapping <file>', 'impact mapping (lists impacted journeys)')
    .option('--base <ref>', 'base for impacted journeys (default: the PR target)')
    .option('--context <name>', 'status / check name', 'EZTest')
    .option('--report-url <url>', 'link to the full report')
    .addOption(new Option('--on-risks <state>', 'status for GO_WITH_RISKS').choices(['success', 'failure']).default('success'))
    .option('--no-comment', 'status only')
    .option('--gitlab-codequality <file>', 'also write a GitLab Code Quality report with the annotations')
    .action(async (runDir: string, o) => {
      const loaded = hasConfig(io.cwd, o.config) ? await load(o) : undefined;
      const provider = await providerFromConfig(loaded, io, o);
      let impact;
      if (o.mapping) {
        const repo = await GitRepo.open(io.cwd);
        const base = o.base ?? (io.env.SYSTEM_PULLREQUEST_TARGETBRANCH ? `origin/${io.env.SYSTEM_PULLREQUEST_TARGETBRANCH.replace(/^refs\/heads\//, '')}` : io.env.GITHUB_BASE_REF ? `origin/${io.env.GITHUB_BASE_REF}` : io.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME ? `origin/${io.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME}` : `origin/${(await repo.defaultBranch()) ?? 'main'}`);
        const changed = await repo.changedFiles(base).catch(() => []);
        const js = [];
        for (const f of await findJourneyFiles([loaded?.config.journeysDir ?? 'journeys'], io.cwd)) {
          try {
            const j = await loadJourneyFile(f);
            js.push({ id: j.id, name: j.name, tags: j.tags, requirements: j.requirements, risk: j.risk ?? 3 });
          } catch {
            // skip
          }
        }
        if (changed.length && js.length) impact = analyzeImpact(changed, js, await loadImpactMapping(resolve(io.cwd, o.mapping)));
      }
      const { detectCi } = await import('../vcs/detect.js');
      const r = await reportPullRequest({
        provider,
        runDir: resolve(io.cwd, runDir),
        cwd: io.cwd,
        journeys: [loaded?.config.journeysDir ?? 'journeys'],
        ci: detectCi(io.env),
        sha: o.sha,
        pr: o.pr,
        impact,
        context: o.context,
        reportUrl: o.reportUrl,
        policy: { goWithRisks: o.onRisks },
        comment: o.comment,
      });
      io.out(`${provider.kind}: ${r.summary.description}${r.status ? `; ${r.status.kind} posted (${r.status.annotations} annotation(s))` : ''}${r.comment ? `; comment ${r.comment.action} on #${r.pr}` : ''}`);
      for (const w of r.warnings) io.err(`warning: ${provider.redact(w)}`);
      // The run's report shows the pull request, the comment and the status it got.
      if (r.pr) {
        const { recordIntegration, rerenderReports } = await import('../report/index.js');
        const repo = provider.repo;
        const url = provider.kind === 'azure-devops' && 'webUrl' in provider ? (provider as unknown as { webUrl(n: number): string }).webUrl(r.pr)
          : repo.provider === 'github' ? `https://${repo.host}/${repo.owner}/${repo.repo}/pull/${r.pr}`
          : repo.provider === 'gitlab' ? `https://${repo.host}/${repo.project}/-/merge_requests/${r.pr}`
          : repo.provider === 'bitbucket' ? `https://${repo.host}/${repo.owner}/${repo.repo}/pull-requests/${r.pr}` : undefined;
        const dir = resolve(io.cwd, runDir);
        await recordIntegration(dir, { pullRequest: { provider: provider.kind, number: r.pr, ...(url ? { url } : {}), ...(r.comment ? { comment: { action: r.comment.action, id: r.comment.id } } : {}), ...(r.status ? { status: { kind: r.status.kind, state: r.summary.state, annotations: r.status.annotations } } : {}), at: new Date().toISOString() } }).catch(() => undefined);
        await rerenderReports(dir).catch(() => undefined);
      }
      if (o.gitlabCodequality) {
        const out = resolve(io.cwd, o.gitlabCodequality);
        await mkdir(dirname(out), { recursive: true });
        await writeFile(out, JSON.stringify(gitlabCodeQuality(r.summary.annotations), null, 2));
      }
    });
  pr.command('propose')
    .description('commit files on a new branch (working tree untouched), push it and open a PR with CODEOWNERS reviewers')
    .argument('<files...>')
    .requiredOption('--title <title>')
    .option('--body <text>', 'description', 'Proposed by EZTest.')
    .addOption(new Option('--kind <kind>').choices(['heal', 'baseline', 'quarantine', 'journey']).default('journey'))
    .option('--branch <name>')
    .option('--target <branch>')
    .option('--no-push', 'only create the local branch and commit')
    .option('--draft')
    .option('-c, --config <file>')
    .addOption(new Option('--provider <kind>').choices(['azure-devops', 'github', 'gitlab', 'bitbucket']))
    .action(async (files: string[], o) => {
      const loaded = hasConfig(io.cwd, o.config) ? await load(o) : undefined;
      const provider = o.push === false ? undefined : await providerFromConfig(loaded, io, o).catch((e: Error) => (io.err(`warning: ${e.message}`), undefined));
      const r = await proposeChange({ cwd: io.cwd, kind: o.kind as ChangeKind, files, title: o.title, body: o.body, branch: o.branch, target: o.target, push: o.push, provider, draft: !!o.draft });
      io.out(`branch ${r.branch} (${r.commit.slice(0, 10)}) -> ${r.target}${r.pr ? `: PR #${r.pr.number} ${r.pr.url}` : ''}${r.reviewers.length ? `; reviewers ${r.reviewers.map((x) => x.raw).join(', ')}` : ''}`);
      for (const w of r.warnings) io.err(`warning: ${w}`);
    });

  // ------------------------------------------------------------------ git helpers
  const g = program.command('git').description('branch-aware results and ownership');
  g.command('promote')
    .description('promote branch-scoped baselines and history to the default branch (after a merge)')
    .option('--branch <name>', 'promote this branch (default: every branch already merged)')
    .option('--to <branch>', 'target (default: vcs.branchScope.defaultBranch)')
    .action(async (o) => {
      const loaded = hasConfig(io.cwd) ? await load({}).catch(() => undefined) : undefined;
      const to = o.to ?? loaded?.config.vcs.branchScope.defaultBranch ?? 'main';
      const baselineDir = resolve(io.cwd, '.eztest', 'baselines');
      const history = await HistoryStore.open(resolve(io.cwd, '.eztest', 'history.json'));
      if (o.branch) {
        const b = await promoteBranchBaselines(baselineDir, o.branch);
        const n = history.promote(o.branch, to);
        if (n) await history.save();
        io.out(`${o.branch} -> ${to}: ${b.promoted.length} baseline(s), ${n} history run(s)`);
        return;
      }
      const r = await promoteMergedBranches(await GitRepo.open(io.cwd), { baselineDir, defaultBranch: to, history });
      if (!r.length) io.out('no merged branch has branch-scoped baselines');
      for (const x of r) io.out(`${x.branch} -> ${to}: ${x.baselines.length} baseline(s), ${x.historyRuns} history run(s)`);
    });
  g.command('owners')
    .description('owners of files from CODEOWNERS (GitHub, GitLab or Azure Repos locations)')
    .argument('<paths...>')
    .action(async (paths: string[]) => {
      const repo = await GitRepo.open(io.cwd);
      const co = await loadCodeowners(repo.root);
      if (!co.file) io.err('no CODEOWNERS file found');
      for (const e of co.errors) io.err(`${co.file}:${e.line}: ${e.message}`);
      for (const p of paths) io.out(`${repo.rel(p, io.cwd)}: ${ownersOf(co, repo.rel(p, io.cwd)).map((x) => x.raw).join(' ') || '(no owner)'}`);
    });
}
