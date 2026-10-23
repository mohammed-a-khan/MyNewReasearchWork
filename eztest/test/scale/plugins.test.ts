/**
 * Plugin API: loading from config (paths and packages), the API version check,
 * custom steps with their own phrasing, lenses, reporters, secret stores and
 * publishers; and the first-party Slack and Teams publishers against
 * mock HTTP servers.
 */
import { afterEach, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEzScript } from '../../src/intent/index.js';
import { checkPlugin, compilePhrase, loadPlugins, PLUGIN_API_VERSION, registries, runPublishers, type LoadedPlugins } from '../../src/plugins/index.js';
import { lensesFromConfig } from '../../src/engine/index.js';
import { createSecretRegistry } from '../../src/identity/index.js';
import { syntheticRun } from './synthetic.js';
import { startRecorder } from './mock-http.js';

const SRC = pathToFileURL(join(process.cwd(), 'src', 'plugins', 'index.ts')).href;
let loaded: LoadedPlugins | undefined;
afterEach(() => {
  loaded?.off();
  loaded = undefined;
});

async function pluginDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ez-plugins-'));
  for (const [f, text] of Object.entries(files)) {
    await mkdir(join(dir, f, '..'), { recursive: true });
    await writeFile(join(dir, f), text);
  }
  return dir;
}

const ACME = `
import { definePlugin } from ${JSON.stringify(SRC)};
export default definePlugin({
  name: '@acme/eztest-erp',
  version: '1.2.0',
  apiVersion: 1,
  setup(api, options) {
    api.registerStep({
      name: 'acme.approve-invoice',
      phrase: ['Approve invoice {invoice} as {approver}', 'Approve {invoice}'],
      async run(page, args) { return { approved: args.invoice + ' by ' + (args.approver ?? options.defaultApprover) }; },
    });
    api.registerLens('acme-brand', ({ mode }) => ({ name: 'acme-brand', async afterStep() { return [{ lens: 'acme-brand', severity: mode === 'warning' ? 'warning' : 'info', message: 'logo present' }]; } }));
    api.registerReporter({ name: 'acme-csv', write: ({ run }) => ['acme-' + run.runId + '.csv'] });
    api.registerSecretStore({ name: 'acme-vault', async get(key) { return key === 'db' ? 'from-acme-vault' : undefined; } });
    api.registerPublisher({ name: 'acme-tracker', async publish(ctx) { return { ok: true, message: 'tracked ' + ctx.run.summary.total + ' with ' + (await ctx.resolveSecret(String(ctx.options.key))) }; } });
    api.registerCommand((program, io) => { program.command('acme-hello').action(() => io.out('hello from acme')); });
  },
});
`;

describe('plugin loading', () => {
  it('loads a local plugin and wires steps, lenses, reporters, secret stores and publishers', async () => {
    const dir = await pluginDir({ 'plugins/acme.mjs': ACME });
    loaded = await loadPlugins([{ name: './plugins/acme.mjs', options: { defaultApprover: 'finance' } }], { cwd: dir });
    expect(loaded.plugins).toEqual([expect.objectContaining({ name: '@acme/eztest-erp', version: '1.2.0' })]);

    const j = parseEzScript('Journey: Approve\n\nApprove invoice "INV-7" as controller\nApprove INV-8\n');
    expect(j.steps[0]).toMatchObject({ action: 'custom', handler: 'acme.approve-invoice', args: { invoice: 'INV-7', approver: 'controller' } });
    expect(j.steps[1]).toMatchObject({ action: 'custom', handler: 'acme.approve-invoice', args: { invoice: 'INV-8' } });
    const handler = registries.steps.get('acme.approve-invoice')!;
    const out = await handler({} as never, j.steps[1], { interpolate: (s: string) => s } as never);
    expect(out).toEqual({ approved: 'INV-8 by finance' });

    expect(lensesFromConfig(['acme-brand:warn'], dir)[0].name).toBe('acme-brand');
    expect(await createSecretRegistry([], { env: {} }).resolve('secret://acme-vault/db')).toBe('from-acme-vault');
    expect(registries.reporters.get('acme-csv')!.write({ run: { runId: 'r1' } as never, runDir: dir, analysis: {} })).toEqual(['acme-r1.csv']);

    const { run } = syntheticRun(3);
    const res = await runPublishers([{ use: 'acme-tracker', key: 'secret://acme-vault/db' }], { run, runDir: dir, resolveSecret: (v) => createSecretRegistry([], { env: {} }).resolve(v) });
    expect(res[0]).toMatchObject({ ok: true, message: 'tracked 3 with from-acme-vault' });
    expect(registries.commands.list()).toHaveLength(1);

    loaded.off();
    loaded = undefined;
    expect(registries.steps.get('acme.approve-invoice')).toBeUndefined();
    expect(() => parseEzScript('Journey: x\n\nApprove invoice "INV-7" as controller\n')).toThrow();
  });

  it('refuses a plugin written for another plugin API version, with a clear message', async () => {
    const dir = await pluginDir({
      'v2.mjs': `export default { name: 'future-plugin', apiVersion: ${PLUGIN_API_VERSION + 1}, setup() { throw new Error('must not run'); } };`,
      'v0.mjs': `export default { name: 'old-plugin', apiVersion: 0, setup() {} };`,
      'none.mjs': `export default { name: 'no-version', setup() {} };`,
      'junk.mjs': `export const x = 1;`,
    });
    await expect(loadPlugins(['./v2.mjs'], { cwd: dir })).rejects.toThrow(/future-plugin targets plugin API v2, but this EZTest provides v1\. Upgrade EZTest/);
    await expect(loadPlugins(['./v0.mjs'], { cwd: dir })).rejects.toThrow(/old-plugin targets plugin API v0.*Upgrade the plugin/);
    await expect(loadPlugins(['./none.mjs'], { cwd: dir })).rejects.toThrow(/does not declare apiVersion/);
    await expect(loadPlugins(['./junk.mjs'], { cwd: dir })).rejects.toThrow(/is not an EZTest plugin/);
    await expect(loadPlugins(['./missing.mjs'], { cwd: dir })).rejects.toThrow(/Plugin file not found/);
    await expect(loadPlugins(['@acme/not-installed'], { cwd: dir })).rejects.toThrow(/is not installed/);
    expect(() => checkPlugin({ name: 'x', apiVersion: 1, setup: () => undefined }, 'x')).not.toThrow();
  });

  it('loads a plugin from an npm package in the project', async () => {
    const dir = await pluginDir({
      'package.json': '{"name":"proj","type":"module"}',
      'node_modules/@acme/eztest-hello/package.json': '{"name":"@acme/eztest-hello","type":"module","main":"index.js","exports":"./index.js"}',
      'node_modules/@acme/eztest-hello/index.js': `export const plugin = { name: '@acme/eztest-hello', apiVersion: 1, setup(api) { api.registerStepHandler('hello', async () => ({ greeted: true })); } };`,
    });
    loaded = await loadPlugins(['@acme/eztest-hello'], { cwd: dir });
    expect(registries.steps.get('hello')).toBeTypeOf('function');
  });

  it('compiles phrasings with quoted or bare arguments, case-insensitively', () => {
    const { re, args } = compilePhrase('Approve invoice {invoice} as {who}');
    expect(args).toEqual(['invoice', 'who']);
    expect(re.test('approve  INVOICE ⟦0⟧ as bob')).toBe(true);
    expect(re.test('Approve invoice as bob')).toBe(false);
  });
});

describe('first-party publishers', () => {
  const { run } = syntheticRun(30, { failEvery: 10, runId: 'run-pub-1' });
  const analysis = { readiness: { decision: 'NO_GO', score: 42 } as never };

  it('Slack: posts a summary with the failed journeys to the webhook', async () => {
    const hook = await startRecorder(() => ({ body: 'ok', type: 'text/plain' }));
    try {
      const [r] = await runPublishers([{ use: 'slack', webhook: 'secret://env/SLACK_HOOK', title: 'Payments' }], {
        run, runDir: '.', analysis, runUrl: 'https://eztest.example/ui/p/payments/runs/run-pub-1', resolveSecret: async (v) => (v === 'secret://env/SLACK_HOOK' ? `${hook.url}/services/T/B/X` : v),
      });
      expect(r).toMatchObject({ publisher: 'slack', ok: true });
      const body = JSON.parse(hook.requests[0].body);
      expect(hook.requests[0].path).toBe('/services/T/B/X');
      expect(body.text).toBe('Payments: 3 of 30 journeys failed (run-pub-1)');
      expect(JSON.stringify(body.blocks)).toContain('Journey 0: order flow variant 0');
      expect(JSON.stringify(body.blocks)).toContain('NO_GO (score 42)');
      expect(body.blocks.at(-1).elements[0].url).toBe('https://eztest.example/ui/p/payments/runs/run-pub-1');
    } finally {
      await hook.close();
    }
  });

  it('Teams: posts an Adaptive Card; `when: failed` skips passing runs; a webhook error is reported', async () => {
    const hook = await startRecorder((r) => ({ status: r.path.includes('broken') ? 500 : 202 }));
    try {
      const [r] = await runPublishers([{ use: 'teams', webhook: `${hook.url}/webhook` }], { run, runDir: '.', analysis, resolveSecret: async (v) => v });
      expect(r.ok).toBe(true);
      const card = JSON.parse(hook.requests[0].body).attachments[0];
      expect(card.contentType).toBe('application/vnd.microsoft.card.adaptive');
      expect(card.content.body[0]).toMatchObject({ color: 'Attention', text: 'EZTest: 3 of 30 journeys failed (run-pub-1)' });
      const passing = syntheticRun(2, { runId: 'run-ok' }).run;
      const [skipped] = await runPublishers([{ use: 'teams', when: 'failed', webhook: `${hook.url}/webhook` }], { run: passing, runDir: '.', resolveSecret: async (v) => v });
      expect(skipped).toMatchObject({ ok: true, skipped: true });
      const [bad] = await runPublishers([{ use: 'teams', webhook: `${hook.url}/broken` }], { run, runDir: '.', resolveSecret: async (v) => v });
      expect(bad).toMatchObject({ ok: false, message: 'Teams webhook returned HTTP 500' });
      const [unknown] = await runPublishers([{ use: 'jenkins-notes' }], { run, runDir: '.', resolveSecret: async (v) => v });
      for (const name of ['slack', 'teams', 'jira']) expect(unknown.message).toContain(name);
      for (const name of ['xray', 'testrail', 'zephyr', 'qtest', 'octane']) expect(unknown.message).not.toContain(name);
      expect(unknown.message).toMatch(/^no publisher "jenkins-notes"/);
    } finally {
      await hook.close();
    }
  });
});
