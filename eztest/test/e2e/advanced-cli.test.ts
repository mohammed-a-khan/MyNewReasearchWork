/**
 * End-to-end through the real CLI and config: @library sub-journeys, hooks
 * from config, security.allowPageScripts, the dialog policy, the SMTP sink
 * mail provider and secret masking of captured values.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { buildProgram } from '../../src/cli/index.js';
import { flattenStepResults, type RunResult } from '../../src/core/index.js';
import { loadConfig } from '../../src/config/index.js';
import { createEngine } from '../../src/engine/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { SmtpSink } from '../../src/messaging/index.js';

async function cli(cwd: string, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const before = process.exitCode;
  process.exitCode = 0;
  await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: process.env }).exitOverride().parseAsync(['node', 'eztest', ...args]);
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = before;
  // EZTEST_* variables of the machine that are not EZTest settings are reported on stderr; they are not this test's.
  return { out: out.join('\n'), err: err.filter((l) => !/^warning: environment variable EZTEST_/.test(l)).join('\n'), exitCode };
}

let server: DemoServer;
beforeAll(async () => {
  server = await startDemoApp();
});
afterAll(async () => {
  await server.close();
});

describe('advanced engine through config and the CLI', () => {
  it('runs sub-journeys from @library files, config hooks, opt-in page scripts and a dialog policy', async () => {
    const project = await mkdtemp(join(tmpdir(), 'eztest-adv-cli-'));
    await mkdir(join(project, 'journeys', 'lib'), { recursive: true });
    await writeFile(join(project, 'journeys', 'lib', 'open-form.ez'), 'Journey: Open the form\nId: open-form\nTags: @library\nOpen /lab/form\n');
    await writeFile(join(project, 'journeys', 'lib', 'fill-name.ez'), 'Journey: Fill name\nId: fill-name\nTags: @library\nParams: who\nReturns: typed\nType "${who}" into the Name field\nCapture the value of the Name field as typed\n');
    await writeFile(join(project, 'journeys', 'main.ez'), `Journey: Main
Run journey "fill-name" with who=Ada
  Expect \${typed} equals "Ada"
Run JavaScript and store the result as title: return document.title
Open /lab/dialogs
Click the "Delete order" button
  Expect #confirm-result has text "Deleted"
`);
    await writeFile(join(project, 'eztest.config.yaml'), [
      `baseUrl: ${server.url}`,
      'healing: { enabled: false }',
      'timeouts: { step: 8000 }',
      'security: { allowPageScripts: true }',
      'dialogs: { default: accept }',
      'hooks:',
      '  beforeEach: [open-form]',
      '  afterAll: [journeys/lib/open-form.ez]',
    ].join('\n'));
    const r = await cli(project, ['run', '--no-analyze', '--screenshots', 'off']);
    expect(r.err).toBe('');
    expect(r.exitCode, r.out).toBe(0);
    const root = join(project, 'eztest-results');
    const runDir = join(root, (await readdir(root)).sort().at(-1)!);
    const run = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as RunResult;
    // Library journeys are not run on their own; the hook runs before each journey and once after all.
    expect(run.journeys.map((j) => [j.journeyId, j.status])).toEqual([['main', 'passed'], ['open-form', 'passed']]);
    const main = run.journeys[0];
    expect(main.steps[0].stepId).toBe('before-each-open-form');
    expect(main.ledger).toMatchObject({ typed: 'Ada', title: 'Form lab' });
    expect(flattenStepResults(main.steps).some((s) => s.result.stepId === 'type-who-into-the-name-field')).toBe(true);
    expect(main.steps.find((s) => s.warnings?.length)?.warnings?.[0]).toMatch(/was accepted/);
  });

  it('page scripts stay disabled by default', async () => {
    const project = await mkdtemp(join(tmpdir(), 'eztest-adv-cli-'));
    await mkdir(join(project, 'journeys'));
    await writeFile(join(project, 'journeys', 'js.ez'), 'Journey: JS\nOpen /lab/form\nRun JavaScript: return 1\n');
    await writeFile(join(project, 'eztest.config.yaml'), `baseUrl: ${server.url}\n`);
    const r = await cli(project, ['run', '--no-analyze', '--screenshots', 'off']);
    expect(r.exitCode).toBe(1);
    expect(r.out).toMatch(/run-javascript-return-1/);
  });

  it('the engine starts the configured SMTP sink, masks secrets in captures, and stops it on close', async () => {
    const project = await mkdtemp(join(tmpdir(), 'eztest-adv-engine-'));
    process.env.ADV_TEST_SECRET = 'hunter22';
    await writeFile(join(project, 'eztest.config.yaml'), [
      `baseUrl: ${server.url}`,
      'email: { provider: sink, port: 0 }',
      'identity:',
      '  secretStores: [{ type: env, prefix: ADV_TEST_ }]',
    ].join('\n'));
    const loaded = await loadConfig({ cwd: project });
    loaded.masker.add('hunter22');
    const engine = await createEngine(loaded, { cwd: project, runOptions: { screenshots: 'off' } });
    const sink = engine.runOptions.mail as SmtpSink;
    expect(sink).toBeInstanceOf(SmtpSink);
    const app = await startDemoApp({ smtpPort: sink.port });
    try {
      const j = parseEzScript(`Journey: Mail via config
Base URL: ${app.url}
Open /lab/mail
Type "hunter22@test.local" into the Email field
Click the "Sign up" button
Get the latest email to "hunter22@test.local" as mail
Set cookie "token" to "hunter22"
Capture cookie "token" as token
`);
      const run = await engine.run([j]);
      const jr = run.journeys[0];
      expect(jr.status).toBe('passed');
      expect(jr.ledger.token).toBe('****');
      expect(JSON.stringify(jr.ledger.mail)).not.toContain('hunter22');
      expect((jr.ledger.mail as { to: string[] }).to).toEqual(['****@test.local']);
    } finally {
      await app.close();
      await engine.close();
    }
  });
});
