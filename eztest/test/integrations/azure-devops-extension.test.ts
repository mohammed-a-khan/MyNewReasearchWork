/**
 * The Azure DevOps extension: manifest and task.json against their schemas;
 * the task handler's orchestration (install, sharding, publishing, PR report)
 * and its readiness gate run against the real eztest CLI; and the pipeline
 * results tab rendered in Chromium (accessibility checks in light and dark, under its own CSP).
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { chromium, type Browser } from '../../src/browser/index.js';
import { expectNoSeriousA11y } from '../a11y/assert.js';

const ROOT = resolve(__dirname, '../..');
const EXT = join(ROOT, 'integrations', 'azure-devops');
const HANDLER = join(EXT, 'tasks', 'EZTest', 'index.js');
const CLI = `"${join(ROOT, 'node_modules', '.bin', 'tsx')}" "${join(ROOT, 'src', 'cli', 'bin.ts')}"`;
const require = createRequire(import.meta.url);
const handler = require(HANDLER) as {
  main(env: Record<string, string | undefined>, deps?: { exec?: (argv: string[], o: { cwd: string; env: Record<string, string>; quiet?: boolean }) => Promise<{ code: number; stdout: string }>; write?: (s: string) => void }): Promise<{ result: string; message: string; runDir?: string }>;
  splitArgv(s: string): string[];
};

async function runDir(decision: 'GO' | 'GO_WITH_RISKS' | 'NO_GO' | undefined, failed = 0): Promise<{ project: string; dir: string }> {
  const project = await mkdtemp(join(tmpdir(), 'eztest-task-'));
  const dir = join(project, 'eztest-results', 'run-20261022-100000-abcdef');
  await mkdir(dir, { recursive: true });
  const summary = { total: 2, passed: 2 - failed, passedHealed: 0, failed, skipped: 0, errors: 0 };
  const run = { runId: 'run-20261022-100000-abcdef', startedAt: '2026-10-22T10:00:00Z', finishedAt: '2026-10-22T10:01:00Z', durationMs: 60000, journeys: [], summary, environment: {} };
  await writeFile(join(dir, 'run.json'), JSON.stringify(run));
  const readiness = decision ? { decision, score: decision === 'NO_GO' ? 40 : decision === 'GO_WITH_RISKS' ? 75 : 98, runId: run.runId, gates: [{ gate: 'pass-rate', severity: 'blocker', status: decision === 'GO' ? 'pass' : 'fail', summary: '1 of 2 journeys failed', cites: { evidence: [], journeys: [], requirements: [] } }], rationale: [], exceptionsApplied: [], exceptionsIgnored: [], evaluatedAt: run.finishedAt } : undefined;
  await writeFile(join(dir, 'report.json'), JSON.stringify({ format: 'eztest-report', version: 1, generatedAt: run.finishedAt, run, insights: { readiness, healProposals: [] } }));
  return { project, dir };
}

/** Run the handler as the agent does: node index.js with INPUT_* variables. */
function agent(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const child = spawn(process.execPath, [HANDLER], { env: { PATH: process.env.PATH, HOME: process.env.HOME, TF_BUILD: 'True', ...env }, shell: false });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => res({ code: code ?? 1, out }));
  });
}

describe('extension manifest', () => {
  it('task.json validates against the official task schema and the manifest against the extension schema', async () => {
    const { validateExtension } = (await import(join(EXT, 'scripts', 'validate.mjs'))) as { validateExtension(dir?: string): string[] };
    expect(validateExtension(EXT)).toEqual([]);
    const task = JSON.parse(readFileSync(join(EXT, 'tasks', 'EZTest', 'task.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(EXT, 'vss-extension.json'), 'utf8'));
    expect(manifest.contributions.find((c: { type: string }) => c.type === 'ms.vss-build-web.build-results-tab').properties.supportsTasks).toEqual([task.id]);
    expect(Object.keys(task.execution)).toEqual(['Node20_1']);
  });
});

describe('task handler: readiness gate (real eztest CLI)', () => {
  it('NO_GO fails the step', async () => {
    const { project, dir } = await runDir('NO_GO', 1);
    const r = await agent({ INPUT_COMMAND: 'gate', INPUT_WORKINGDIRECTORY: project, INPUT_RUNDIRECTORY: dir, INPUT_EZTESTCOMMAND: CLI });
    expect(r.code).toBe(1);
    expect(r.out).toContain('##vso[task.setvariable variable=EztestDecision;isOutput=true;]NO_GO');
    expect(r.out).toContain('##vso[task.logissue type=error]EZTest readiness NO_GO (score 40): pass-rate: 1 of 2 journeys failed');
    expect(r.out).toContain('##vso[task.complete result=Failed;]EZTest readiness is NO_GO (score 40)');
  }, 120_000);

  it('GO_WITH_RISKS warns; NO_GO can be configured to warn; GO passes', async () => {
    const risky = await runDir('GO_WITH_RISKS');
    const r1 = await agent({ INPUT_COMMAND: 'gate', INPUT_WORKINGDIRECTORY: risky.project, INPUT_EZTESTCOMMAND: CLI });
    expect(r1.code).toBe(0);
    expect(r1.out).toContain('##vso[task.complete result=SucceededWithIssues;]EZTest readiness is GO_WITH_RISKS');
    expect(r1.out.match(/##vso\[task\.complete/g)).toHaveLength(1);
    const r2 = await agent({ INPUT_COMMAND: 'gate', INPUT_WORKINGDIRECTORY: risky.project, INPUT_ONRISKS: 'fail', INPUT_EZTESTCOMMAND: CLI });
    expect(r2.code).toBe(1);
    const nogo = await runDir('NO_GO', 1);
    const r3 = await agent({ INPUT_COMMAND: 'gate', INPUT_WORKINGDIRECTORY: nogo.project, INPUT_ONNOGO: 'warn', INPUT_EZTESTCOMMAND: CLI });
    expect(r3.code).toBe(0);
    expect(r3.out).toContain('result=SucceededWithIssues;]EZTest readiness is NO_GO');
    const go = await runDir('GO');
    const r4 = await agent({ INPUT_COMMAND: 'gate', INPUT_WORKINGDIRECTORY: go.project, INPUT_EZTESTCOMMAND: CLI });
    expect(r4.code).toBe(0);
    expect(r4.out).toContain('##vso[task.complete result=Succeeded;]EZTest passed');
  }, 240_000);

  it('without a readiness policy, failing journeys fail the step unless configured otherwise', async () => {
    const { project } = await runDir(undefined, 1);
    expect((await agent({ INPUT_COMMAND: 'gate', INPUT_WORKINGDIRECTORY: project, INPUT_EZTESTCOMMAND: CLI })).out).toContain('result=Failed;]1 journey(s) failed');
    const r = await agent({ INPUT_COMMAND: 'gate', INPUT_WORKINGDIRECTORY: project, INPUT_FAILONTESTFAILURE: 'false', INPUT_EZTESTCOMMAND: CLI });
    expect(r.code).toBe(0);
    expect(r.out).toContain('result=SucceededWithIssues;]1 journey(s) failed');
  }, 120_000);
});

describe('task handler: orchestration', () => {
  it('installs, shards, runs, summarises, publishes to the pipeline and Test Plans, reports to the PR, then gates', async () => {
    const { project, dir } = await runDir('GO');
    await writeFile(join(project, 'package-lock.json'), '{}');
    const calls: Array<{ argv: string[]; env: Record<string, string> }> = [];
    let out = '';
    const exec = async (argv: string[], o: { env: Record<string, string> }) => {
      calls.push({ argv, env: o.env });
      const a = argv.slice(3).join(' ');
      if (a === 'run --help') return { code: 0, stdout: 'Options:\n  --shard <i/n>  run one shard\n' };
      if (a.startsWith('run ')) return { code: 0, stdout: `2 journeys: 2 passed\nreport json: ${join(dir, 'report.json')}\n` };
      if (a.startsWith('ado summary')) {
        await writeFile(join(dir, 'eztest-tab.json'), '{}');
        await writeFile(join(dir, 'eztest-summary.md'), '### EZTest: GO');
      }
      if (a.startsWith('ado gate')) return { code: 0, stdout: 'PASS EZTest readiness GO (score 98)' };
      await writeFile(join(dir, 'junit.xml'), '<testsuites/>');
      return { code: 0, stdout: '' };
    };
    const env = {
      INPUT_COMMAND: 'all',
      INPUT_WORKINGDIRECTORY: project,
      INPUT_ENVIRONMENT: 'sit',
      INPUT_JOURNEYS: 'journeys/checkout',
      INPUT_SETUPCOMMAND: 'node scripts/start-app.js "--port 3000"',
      INPUT_PUBLISHTESTPLANS: 'true',
      INPUT_TESTPLANID: '417',
      INPUT_TESTSUITEID: '418',
      INPUT_CREATEBUGS: 'true',
      INPUT_MARKFLAKY: 'true',
      INPUT_EVIDENCEPACK: 'true',
      INPUT_EZTESTCOMMAND: 'npx --no-install eztest',
      SYSTEM_JOBPOSITIONINPHASE: '2',
      SYSTEM_TOTALJOBSINPHASE: '3',
      SYSTEM_JOBNAME: 'journeys 2',
      SYSTEM_PULLREQUEST_PULLREQUESTID: '77',
      ENDPOINT_AUTH_PARAMETER_SYSTEMVSSCONNECTION_ACCESSTOKEN: 'jobTOKEN-123456789',
    };
    const r = await handler.main(env, { exec, write: (s) => (out += s) });
    expect(r.result).toBe('SucceededWithIssues'); // the evidence pack had no signing key
    const argvs = calls.map((x) => x.argv.join(' '));
    expect(argvs[0]).toMatch(/^npm ci --no-audit --no-fund$/);
    expect(calls[1].argv).toEqual(['node', 'scripts/start-app.js', '--port 3000']);
    expect(argvs).toContain('npx --no-install eztest run journeys/checkout --env sit --reporter html,json,junit --shard 2/3');
    expect(argvs).toContain(`npx --no-install eztest ado summary ${dir} --journeys journeys/checkout`);
    expect(argvs).toContain(`npx --no-install eztest ado publish ${dir} --env sit --plan 417 --suite 418 --create-bugs --flaky --trace`);
    expect(argvs).toContain(`npx --no-install eztest pr report ${dir} --env sit --context EZTest --on-risks success`);
    expect(argvs.at(-1)).toBe(`npx --no-install eztest ado gate ${dir} --on-no-go fail --on-risks warn --on-missing pass`);
    // The job token is masked, handed to EZTest as SYSTEM_ACCESSTOKEN, and the task's own inputs are not leaked to children.
    expect(out).toContain('##vso[task.setsecret]jobTOKEN-123456789');
    expect(calls.every((c) => c.env.SYSTEM_ACCESSTOKEN === 'jobTOKEN-123456789' && !Object.keys(c.env).some((k) => k.startsWith('INPUT_') || k.startsWith('ENDPOINT_AUTH_')))).toBe(true);
    expect(out).toContain(`##vso[task.addattachment type=eztest.report;name=eztest-tab;]${join(dir, 'eztest-tab.json')}`);
    expect(out).toContain(`##vso[task.uploadsummary]${join(dir, 'eztest-summary.md')}`);
    expect(out).toContain(`##vso[results.publish type=JUnit;mergeResults=true;runTitle=EZTest sit;resultFiles=${join(dir, 'junit.xml')};testRunSystem=EZTest;]`);
    expect(out).toContain(`##vso[artifact.upload containerfolder=eztest;artifactname=eztest-sit-journeys_2;]${dir}`);
    expect(out).toContain('##vso[task.complete result=SucceededWithIssues;]evidencePack is on but no signingKey is set');
  });

  it('runs every journey with a warning when the CLI cannot shard, and splits command lines without a shell', async () => {
    const { project, dir } = await runDir(undefined, 0);
    const calls: string[][] = [];
    let out = '';
    await handler.main(
      { INPUT_COMMAND: 'run', INPUT_WORKINGDIRECTORY: project, INPUT_INSTALL: 'none', INPUT_SHARD: '1/2', INPUT_PUBLISHARTIFACT: 'false' },
      {
        exec: async (argv) => {
          calls.push(argv);
          return argv.includes('--help') ? { code: 0, stdout: 'Options:\n  --tags <tags>\n' } : argv[3] === 'run' ? { code: 0, stdout: `report json: ${join(dir, 'report.json')}` } : { code: 0, stdout: '' };
        },
        write: (s) => (out += s),
      },
    );
    expect(calls.find((c) => c[3] === 'run' && !c.includes('--help'))).not.toContain('--shard');
    expect(out).toContain('##vso[task.logissue type=warning;]this EZTest version has no --shard; job 1/2 runs every journey');
    expect(handler.splitArgv(`a "b c" 'd e' f\\ g "h \\"i\\""`)).toEqual(['a', 'b c', 'd e', 'f\\', 'g', 'h "i"']);
  });
});

describe('task handler: "package" install mode', () => {
  it('installs @eztech.com/eztest at the requested version (never the unrelated unscoped "eztest")', async () => {
    const { project, dir } = await runDir(undefined, 0);
    const calls: string[][] = [];
    const r = await handler.main(
      { INPUT_COMMAND: 'run', INPUT_WORKINGDIRECTORY: project, INPUT_INSTALL: 'package', INPUT_EZTESTVERSION: '0.1.0', INPUT_PUBLISHARTIFACT: 'false' },
      {
        exec: async (argv) => {
          calls.push(argv);
          return argv[3] === 'run' && !argv.includes('--help') ? { code: 0, stdout: `report json: ${join(dir, 'report.json')}` } : { code: 0, stdout: '' };
        },
        write: () => undefined,
      },
    );
    expect(r.result).not.toBe('Failed');
    expect(calls[0].slice(1)).toEqual(['install', '--no-save', '--no-audit', '--no-fund', '@eztech.com/eztest@0.1.0']);
    const failing = await handler.main(
      { INPUT_COMMAND: 'run', INPUT_WORKINGDIRECTORY: project, INPUT_INSTALL: 'package', INPUT_EZTESTVERSION: 'latest' },
      { exec: async () => ({ code: 1, stdout: '' }), write: () => undefined },
    );
    expect(failing).toMatchObject({ result: 'Failed', message: 'npm install @eztech.com/eztest@latest failed' });
    const task = JSON.parse(readFileSync(join(EXT, 'tasks', 'EZTest', 'task.json'), 'utf8')) as { inputs: Array<{ name: string; options?: Record<string, string> }> };
    expect(task.inputs.find((i) => i.name === 'install')!.options!.package).toBe('npm install @eztech.com/eztest (version below)');
  });
});

describe('pipeline results tab (Chromium)', () => {
  let server: Server;
  let base: string;
  let browser: Browser;
  const TAB = {
    format: 'eztest-tab', version: 1, runId: 'run-x', startedAt: '2026-10-22T10:00:00Z', finishedAt: '2026-10-22T10:01:00Z', branch: 'feature/pay', commit: 'abcdef0123456789',
    decision: 'NO_GO', score: 40, summary: { total: 3, passed: 1, passedHealed: 1, failed: 1, skipped: 0, errors: 0 },
    gates: [{ gate: 'critical-journeys', status: 'fail', summary: 'pay-by-card failed' }],
    failures: [{ journeyId: 'pay', name: 'Pay by card <img src=x onerror=alert(1)>', step: 'Click the "Pay" button', error: 'Post-condition failed', file: 'journeys/pay.ez', line: 5, category: 'product-bug', confidence: 0.8 }],
    heals: [{ journeyId: 'login', name: 'Login', step: 'Click the "Sign in" button', from: 'role=button', to: 'testId=login', tier: 'T1-fingerprint', confidence: 0.94, verified: true }],
    journeys: [{ id: 'pay', name: 'Pay by card', status: 'failed', durationMs: 1200, attempt: 1 }, { id: 'login', name: 'Login', status: 'passed-healed', durationMs: 500, attempt: 1 }, { id: 'home', name: 'Home', status: 'passed', durationMs: 90000, attempt: 2 }],
  };
  const STUB_SDK = `
    let buildCb;
    export async function init() {}
    export async function ready() {}
    export function getConfiguration() { return { onBuildChanged(cb) { buildCb = cb; setTimeout(() => cb({ id: 42 }), 0); } }; }
    export async function getAccessToken() { return 'ext-token-1'; }
    export function getWebContext() { return { project: { name: 'Shop Web' } }; }
    export async function getService(id) {
      if (id === 'ms.vss-features.location-service') return { getResourceAreaLocation: async () => location.origin + '/org/' };
      throw new Error('no service ' + id);
    }
    export async function notifyLoadSucceeded() { window.__loaded = true; }
    export async function notifyLoadFailed() {}
    export function resize() {}
  `;
  const seen: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      seen.push(`${u.pathname} ${req.headers.authorization ?? ''}`);
      if (u.pathname === '/web/lib/SDK.min.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end(STUB_SDK);
      }
      if (u.pathname.startsWith('/web/')) {
        const file = join(EXT, u.pathname.slice(1));
        try {
          const body = readFileSync(file);
          res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] ?? 'application/octet-stream' });
          return res.end(body);
        } catch {
          res.writeHead(404);
          return res.end();
        }
      }
      // Full Chrome (not the headless shell) asks for a favicon; Azure DevOps serves one.
      if (u.pathname === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
      }
      if (req.headers.authorization !== 'Bearer ext-token-1') {
        res.writeHead(401);
        return res.end();
      }
      if (u.pathname === '/org/Shop%20Web/_apis/build/builds/42/attachments/eztest.report') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ count: 1, value: [{ name: 'eztest-tab', _links: { self: { href: `${base}/org/Shop%20Web/_apis/build/builds/42/t1/r1/attachments/eztest.report/eztest-tab` } } }] }));
      }
      if (u.pathname === '/org/Shop%20Web/_apis/build/builds/42/t1/r1/attachments/eztest.report/eztest-tab') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(TAB));
      }
      res.writeHead(404);
      return res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise((r) => server?.close(r));
  });

  it('renders the run report from the build attachment, safely, accessible in light and dark, under its CSP', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    const page = await ctx.newPage();
    const problems: string[] = [];
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
    page.on('pageerror', (e) => problems.push(e.message));
    await page.goto(`${base}/web/results-tab.html`);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __loaded?: boolean }).__loaded === true)).toBe(true);
    await expect.poll(() => page.getByRole('heading', { level: 1 }).textContent()).toBe('EZTest: NO GO');
    expect(await page.locator('main').getAttribute('aria-busy')).toBe('false');
    expect(await page.getByRole('table', { name: 'Failing journeys' }).textContent()).toContain('journeys/pay.ez:5');
    expect(await page.getByRole('table', { name: 'Readiness gates not passing' }).textContent()).toContain('pay-by-card failed');
    expect(await page.getByRole('table', { name: 'Healed steps' }).textContent()).toMatch(/role=button.*testId=login/);
    expect(await page.getByRole('table', { name: 'All journeys' }).textContent()).toContain('1.5 min');
    // report text is text, never markup
    expect(await page.locator('main img').count()).toBe(0);
    expect(seen.some((s) => s.startsWith('/org/Shop%20Web/_apis/build/builds/42/attachments/eztest.report Bearer ext-token-1'))).toBe(true);
    // EZTest's accessibility engine runs through the driver, so it works under the page's own strict CSP.
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`${base}/web/results-tab.html`);
      await expect.poll(() => page.getByRole('heading', { level: 1 }).textContent()).toBe('EZTest: NO GO');
      await expectNoSeriousA11y(page, `results-tab-${scheme}`, ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']);
    }
    await ctx.close();
    expect(problems).toEqual([]);
  }, 120_000);
});
