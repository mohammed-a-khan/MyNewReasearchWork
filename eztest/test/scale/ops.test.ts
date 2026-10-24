/**
 * Operations: OTLP trace export to a collector stub, structured JSON logs
 * (no secrets), config schema versioning and upgrade-config, doctor --json,
 * and the CLI end to end: selection and sharding with --plan, a real sharded
 * run with JSON logs, OTLP and publishing, ci matrix and trends.
 */
import { afterAll, describe, expect, it } from '../support/testkit.js';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createJsonLogger, redact } from '../../src/ops/log.js';
import { exportRunTrace, runToOtlp, traceIdForRun } from '../../src/ops/otlp.js';
import { upgradeConfigText, type ConfigMigration } from '../../src/ops/config-migrate.js';
import { loadConfig } from '../../src/config/index.js';
import { buildProgram, type CliIO } from '../../src/cli/program.js';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { tempDir } from '../runner/fixtures.js';
import { syntheticRun } from './synthetic.js';
import { startRecorder } from './mock-http.js';
import { startTestServer } from '../server/helpers.js';

const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of closers) await c();
});

async function cli(cwd: string, args: string[], env: Record<string, string | undefined> = {}): Promise<{ out: string[]; err: string[]; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: { ...process.env, ...env } };
  process.exitCode = 0;
  await buildProgram(io).parseAsync(['node', 'eztest', ...args], { from: 'node' });
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { out, err, code };
}

describe('OTLP trace export', () => {
  it('builds one trace per run with run, journey and step spans (nested blocks) and posts OTLP/HTTP JSON', async () => {
    const { run } = syntheticRun(3, { failEvery: 3, stepsPerJourney: 2 });
    run.journeys[1].steps[0].children = [{ stepId: 'inner', intent: 'Click "Inner"', status: 'passed', startedAt: run.journeys[1].steps[0].startedAt, durationMs: 5, conditions: [], evidence: [] }];
    const payload = runToOtlp(run) as { resourceSpans: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }; scopeSpans: Array<{ spans: Array<{ traceId: string; spanId: string; parentSpanId?: string; name: string; status: { code: number }; attributes: Array<{ key: string }> }> }> }> };
    const spans = payload.resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(1 + 3 + 6 + 1);
    expect(new Set(spans.map((s) => s.traceId))).toEqual(new Set([traceIdForRun(run.runId)]));
    const root = spans[0];
    expect(root.parentSpanId).toBeUndefined();
    expect(root.status.code).toBe(2); // a journey failed
    const journeySpans = spans.filter((s) => s.parentSpanId === root.spanId);
    expect(journeySpans.map((s) => s.name)).toEqual(run.journeys.map((j) => j.name));
    const inner = spans.find((s) => s.name === 'Click "Inner"')!;
    expect(spans.find((s) => s.spanId === inner.parentSpanId)!.name).toBe(run.journeys[1].steps[0].intent);
    expect(payload.resourceSpans[0].resource.attributes.find((a) => a.key === 'service.name')?.value.stringValue).toBe('eztest');

    const collector = await startRecorder(() => ({ body: {} }));
    closers.push(collector.close);
    const r = await exportRunTrace(syntheticRun(250, { stepsPerJourney: 3 }).run, { endpoint: collector.url, headers: { 'x-api-key': 'k' }, batch: 400 });
    expect(r).toMatchObject({ spans: 1 + 250 + 750, requests: 3 });
    expect(collector.requests.every((q) => q.path === '/v1/traces' && q.headers['content-type'] === 'application/json' && q.headers['x-api-key'] === 'k')).toBe(true);
    const total = collector.requests.reduce((n, q) => n + JSON.parse(q.body).resourceSpans[0].scopeSpans[0].spans.length, 0);
    expect(total).toBe(1001);
  });

  it('reports a collector error', async () => {
    const bad = await startRecorder(() => ({ status: 503 }));
    closers.push(bad.close);
    await expect(exportRunTrace(syntheticRun(1).run, { endpoint: `${bad.url}/v1/traces` })).rejects.toThrow(/HTTP 503/);
  });
});

describe('structured logs', () => {
  it('writes one JSON object per line, with ids, and never secrets', () => {
    const lines: string[] = [];
    const log = createJsonLogger({ out: (l) => lines.push(l), base: { service: 'eztest' }, mask: (s) => s.replace('hunter2', '***'), now: () => new Date('2026-10-22T00:00:00Z') });
    log.child({ runId: 'run-1' }).info('step end', { journeyId: 'j', stepId: 's', password: 'p', authorization: 'Bearer abcdefghijkl', note: 'pw hunter2 and ezt_abc_defghijklmnop' });
    log.debug('hidden');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ ts: '2026-10-22T00:00:00.000Z', level: 'info', msg: 'step end', service: 'eztest', runId: 'run-1', journeyId: 'j', stepId: 's', password: '[redacted]', authorization: '[redacted]', note: 'pw *** and [redacted]' });
    expect(redact({ nested: { apiKey: 'x', ok: true, tokenCount: 3 } })).toEqual({ nested: { apiKey: '[redacted]', ok: true, tokenCount: '[redacted]' } });
  });
});

describe('config schema versioning', () => {
  it('defaults configVersion to 1 and refuses a config from a newer EZTest', async () => {
    const dir = await tempDir('cfgv');
    await writeFile(join(dir, 'eztest.config.yaml'), 'baseUrl: http://x.test\n');
    expect((await loadConfig({ cwd: dir, environment: {} })).config.configVersion).toBe(1);
    await writeFile(join(dir, 'eztest.config.yaml'), 'configVersion: 2\n');
    await expect(loadConfig({ cwd: dir, environment: {} })).rejects.toThrow(/configVersion/);
  });

  it('upgrade-config stamps v1 keeping comments, is idempotent, and runs migrations in order', async () => {
    const text = '# my settings\nbaseUrl: http://x.test # app\nretries: 1\n';
    const r = upgradeConfigText(text);
    expect(r.changes).toEqual(['added configVersion: 1']);
    expect(r.text.split('\n')[0]).toBe('# my settings');
    expect(r.text).toContain('configVersion: 1\nbaseUrl: http://x.test # app');
    expect(upgradeConfigText(r.text).changed).toBe(false);
    const rename: ConfigMigration = { from: 1, to: 2, describe: 'retries -> retry.count', migrate: (doc) => { const v = doc.get('retries'); doc.delete('retries'); doc.setIn(['retry', 'count'], v); return ['moved retries to retry.count']; } };
    const v2 = upgradeConfigText(r.text, { migrations: [rename], target: 2 });
    expect(v2.changes).toEqual(['v1 -> v2: retries -> retry.count', '  moved retries to retry.count', 'configVersion: 1 -> 2']);
    expect(v2.text).toMatch(/configVersion: 2[\s\S]*retry:\n {2}count: 1/);
    expect(() => upgradeConfigText('configVersion: 3\n')).toThrow(/newer than this EZTest supports/);
    expect(upgradeConfigText('{"baseUrl":"http://x.test"}', { json: true }).text).toBe('{\n  "configVersion": 1,\n  "baseUrl": "http://x.test"\n}\n');
  });

  it('CLI: upgrade-config --dry-run does not write', async () => {
    const dir = await tempDir('cfgv-cli');
    await writeFile(join(dir, 'eztest.config.yaml'), 'baseUrl: http://x.test\n');
    const dry = await cli(dir, ['upgrade-config', '--dry-run']);
    expect(dry.out.join('\n')).toMatch(/would upgrade .* to 1/);
    expect(await readFile(join(dir, 'eztest.config.yaml'), 'utf8')).toBe('baseUrl: http://x.test\n');
    await cli(dir, ['upgrade-config']);
    expect(await readFile(join(dir, 'eztest.config.yaml'), 'utf8')).toBe('configVersion: 1\nbaseUrl: http://x.test\n');
  });
});

describe('doctor --json', () => {
  it('prints one machine-readable report', async () => {
    const dir = await tempDir('doctor');
    await writeFile(join(dir, 'eztest.config.yaml'), 'baseUrl: http://x.test\n');
    const r = await cli(dir, ['doctor', '--json', '--no-browser']);
    const report = JSON.parse(r.out.join('\n'));
    expect(report).toMatchObject({ ok: true, configVersion: 1, pluginApiVersion: 1, checks: [{ name: 'node', status: 'ok' }, { name: 'config', status: 'ok' }] });
    expect(r.code).toBe(0);
  });

  it('keeps warnings out of the JSON: unrelated EZTEST_* variables go to stderr and leave the config check ok', async () => {
    const dir = await tempDir('doctor-env');
    await writeFile(join(dir, 'eztest.config.yaml'), 'baseUrl: http://x.test\n');
    const r = await cli(dir, ['doctor', '--json', '--no-browser'], { EZTEST_BUILD_LABEL: 'nightly', EZTEST_ADO_ORG_URL: undefined, EZTEST_ADO_PROJECT: undefined, EZTEST_ADO_PAT: 'pat' });
    const report = JSON.parse(r.out.join('\n'));
    expect(report.checks.find((c: { name: string }) => c.name === 'config')).toMatchObject({ status: 'ok' });
    expect(JSON.stringify(report)).not.toMatch(/warning|EZTEST_/);
    expect(r.err).toEqual([expect.stringMatching(/^warning: environment variable EZTEST_BUILD_LABEL is not an EZTest setting .*EZTEST_ADO__ORGANIZATION_URL for ado\.organizationUrl/)]);
    // EZTEST_ADO_ORG_URL and EZTEST_ADO_PROJECT are accepted names for ado.organizationUrl and ado.project: no warning.
    const alias = await cli(dir, ['doctor', '--json', '--no-browser'], { EZTEST_ADO_ORG_URL: 'https://dev.azure.com/acme', EZTEST_ADO_PROJECT: 'Shop', EZTEST_ADO_PAT: 'pat' });
    expect(alias.err).toEqual([]);
    expect(JSON.parse(alias.out.join('\n')).checks.find((c: { name: string }) => c.name === 'config')).toMatchObject({ status: 'ok' });
    // A config file's own unknown key still makes the check "warn" (text on stderr, a count in the JSON).
    await writeFile(join(dir, 'eztest.config.yaml'), 'baseUrl: http://x.test\nmystery: 1\n');
    const w = await cli(dir, ['doctor', '--json', '--no-browser']);
    const report2 = JSON.parse(w.out.join('\n'));
    expect(report2.checks.find((c: { name: string }) => c.name === 'config')).toMatchObject({ status: 'warn', warnings: 1 });
    expect(w.err.join('\n')).toMatch(/Unknown configuration key "mystery"/);
  });
});

describe('CLI at scale (real Chromium, demo app)', () => {
  let demo: DemoServer;
  async function project(): Promise<string> {
    demo ??= await startDemoApp({ variant: 'a' });
    if (!closers.includes(demo.close)) closers.push(demo.close);
    const dir = await tempDir('scale-cli');
    await mkdir(join(dir, 'journeys'), { recursive: true });
    const j = (id: string, risk: number, extra = '') => `Journey: ${id}\nId: ${id}\nRisk: ${risk}\n${extra}\nOpen /login\n  Expect the page contains "Sign in"\n`;
    await writeFile(join(dir, 'journeys', 'a.ez'), j('alpha', 5, 'Locks: account-1\n'));
    await writeFile(join(dir, 'journeys', 'b.ez'), j('bravo', 2, 'Locks: account-1\n'));
    await writeFile(join(dir, 'journeys', 'c.ez'), j('charlie', 4));
    await writeFile(join(dir, 'journeys', 'd.ez'), j('delta', 1));
    // History: alpha is slow, the others fast.
    const runs = [1, 2, 3].map((i) => ({ runId: `h${i}`, startedAt: `2026-10-0${i}T00:00:00Z`, outcomes: [['alpha', 600_000], ['bravo', 60_000], ['charlie', 120_000], ['delta', 30_000]].map(([journeyId, durationMs]) => ({ journeyId, status: 'passed', durationMs, attempt: 1 })) }));
    await mkdir(join(dir, '.eztest'), { recursive: true });
    await writeFile(join(dir, '.eztest', 'history.json'), JSON.stringify({ version: 1, runs }));
    await writeFile(join(dir, 'eztest.config.yaml'), `baseUrl: ${demo.url}\nscreenshots: off\nconcurrency: 2\n`);
    return dir;
  }

  it('--plan explains selection by budget and risk and the duration-balanced shard plan', async () => {
    const dir = await project();
    const r = await cli(dir, ['run', '--plan', '--risk', '>=2', '--budget', '4m', '--shard', '1/2']);
    const text = r.out.join('\n');
    expect(text).toMatch(/selection: Selected 2 of 4 journeys \(~3\.0m\) by risk >= 2, budget 4\.0m/);
    expect(text).toMatch(/\+ charlie: risk 4 >= 2; fits budget/);
    expect(text).toMatch(/- alpha: over budget/);
    expect(text).toMatch(/- delta: risk 1 < 2/);
    expect(text).toMatch(/shard 1\/2: 1 journeys/);
    expect(text).toMatch(/would run 1 journeys: (bravo|charlie)$/m);
    const m = await cli(dir, ['ci', 'matrix', '--shards', 'auto', '--target', '5m']);
    expect(JSON.parse(m.out[0])).toEqual({ include: [1, 2, 3].map((i) => expect.objectContaining({ shard: `${i}/3` })) });
  });

  it('runs two shards with JSON logs, merges them, exports OTLP and publishes to the results server', async () => {
    const dir = await project();
    const collector = await startRecorder(() => ({ body: {} }));
    closers.push(collector.close);
    const server = await startTestServer();
    closers.push(server.close);
    const tester = await server.token('ci', [{ project: 'shop', role: 'tester' }]);
    const env = { EZTEST_SERVER_TOKEN: tester };
    process.env.EZTEST_SERVER_TOKEN = tester;
    await writeFile(join(dir, 'eztest.config.yaml'), `baseUrl: ${demo.url}\nscreenshots: off\nconcurrency: 2\nserver:\n  url: ${server.url}\n  project: shop\n`);
    const s1 = await cli(dir, ['run', '--shard', '1/2', '--log-format', 'json', '--reporter', 'json'], env);
    const s2 = await cli(dir, ['run', '--shard', '2/2', '--reporter', 'json', '--otlp', collector.url], env);
    expect(s1.code).toBe(0);
    expect(s2.code).toBe(0);
    const records = s1.out.map((l) => JSON.parse(l) as Record<string, unknown>);
    const stepEnd = records.find((r) => r.msg === 'step end')!;
    expect(stepEnd).toMatchObject({ level: 'info', service: 'eztest', status: 'passed' });
    expect(String(stepEnd.runId)).toMatch(/^run-/);
    expect(stepEnd.journeyId).toBeTruthy();
    expect(stepEnd.stepId).toBeTruthy();
    expect(records.some((r) => String(r.msg).startsWith('shard 1/2:'))).toBe(true);
    expect(s1.out.join('\n')).not.toContain(tester);
    expect(s2.out.join('\n')).toMatch(/otlp: exported \d+ spans/);
    expect(collector.requests).toHaveLength(1);

    // History is not recorded per shard: merge records the combined run.
    const before = JSON.parse(await readFile(join(dir, '.eztest', 'history.json'), 'utf8')).runs.length;
    expect(before).toBe(3);
    const runDirs = (await readdir(join(dir, 'eztest-results'))).filter((d) => d.startsWith('run-')).map((d) => join('eztest-results', d));
    expect(runDirs).toHaveLength(2);
    const selection = JSON.parse(await readFile(join(dir, runDirs[0], 'selection.json'), 'utf8'));
    expect(selection.shard.total).toBe(2);
    const merged = await cli(dir, ['merge', ...runDirs, '-o', 'merged', '--reporter', 'json,html', '--publish'], env);
    const text = merged.out.join('\n');
    expect(text).toMatch(/4 journeys, 4 passed/);
    expect(text).toMatch(/evidence: VALID merged chain/);
    expect(text).toMatch(/published \d+ files .* \(evidence verified by the server\)/);
    expect(JSON.parse(await readFile(join(dir, '.eztest', 'history.json'), 'utf8')).runs.length).toBe(4);
    const runs = (await server.req('GET', '/api/projects/shop/runs', { token: tester })).json;
    expect(runs[0]).toMatchObject({ verified: true, summary: { total: 4, passed: 4 } });
    // The shard run with alpha and bravo (both Locks: account-1) ran them one after the other.
    const trends = await cli(dir, ['trends']);
    expect(trends.out[0].split('\n')[0]).toBe('run_id,started_at,journeys,passed,passed_healed,failed,errors,skipped,pass_rate,heal_rate,journey_time_ms');
    delete process.env.EZTEST_SERVER_TOKEN;
  }, 180_000);
});
