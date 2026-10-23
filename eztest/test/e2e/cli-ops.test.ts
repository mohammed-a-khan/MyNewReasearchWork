/** End-to-end: monitor, keys, evidence packs and mocks through the real CLI. */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { cp, mkdtemp, readdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startDemoApp, DEMO_TOTP_SECRET, type DemoServer } from '../../examples/demo-app/server.js';
import { buildProgram } from '../../src/cli/index.js';
import { readZip, writeZip } from '../../src/evidence-pack/index.js';

const EXAMPLE = resolve(__dirname, '../../examples/shop-project');

async function cli(cwd: string, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const before = process.exitCode;
  process.exitCode = 0;
  await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: process.env })
    .exitOverride()
    .parseAsync(['node', 'eztest', ...args]);
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = before;
  return { out: out.join('\n'), err: err.join('\n'), exitCode };
}

describe('eztest operations commands (end to end)', () => {
  let app: DemoServer;
  let project: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    project = await mkdtemp(join(tmpdir(), 'eztest-ops-'));
    await cp(EXAMPLE, project, { recursive: true });
    app = await startDemoApp({ dbFile: join(project, 'shop.db') });
    const env: Record<string, string> = {
      SHOP_URL: app.url,
      SHOP_DB: join(project, 'shop.db'),
      SHOP_ALICE_PASSWORD: 'Wonderland#1',
      SHOP_ALICE_TOTP: DEMO_TOTP_SECRET,
      SHOP_BOB_PASSWORD: 'Builder#2',
      SHOP_API_CLIENT_SECRET: 'ez-client-secret',
    };
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterAll(async () => {
    await app.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('monitors @monitor journeys and writes a status page', async () => {
    await writeFile(
      join(project, 'journeys', 'health.ez'),
      'Journey: API health\nTags: @monitor\n\nCall API "GET /api/customers" as manager and store as customers\nExpect the customers response status to be 200\n',
    );
    const r = await cli(project, ['monitor', '--iterations', '2', '--interval', '1']);
    expect(r.err).toBe('');
    // Labels are tick numbers; under load a tick can be skipped (overlap guard), so count completed runs instead.
    expect(r.out.match(/run \d+: 1\/1 up/g)).toHaveLength(2);
    expect(existsSync(join(project, 'eztest-monitor', 'status.html'))).toBe(true);
  });

  it('refuses to monitor when no journey is tagged as production-safe', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'eztest-ops-empty-'));
    await cp(EXAMPLE, empty, { recursive: true });
    const r = await cli(empty, ['monitor', '--iterations', '1']);
    expect(r.exitCode).toBe(1);
    expect(r.err).toMatch(/No journeys tagged @monitor/);
  });

  it('signs an evidence pack, verifies it, and detects tampering', async () => {
    const run = await cli(project, ['run', '--tags', 'api', '--no-analyze']);
    expect(run.exitCode).toBe(0);
    const results = join(project, 'eztest-results');
    const runDir = join(results, (await readdir(results)).sort().pop()!);

    expect((await cli(project, ['keys', 'generate', '-o', 'qa'])).exitCode).toBe(0);
    const pack = await cli(project, ['evidence', 'pack', runDir, '--key', 'qa.key.pem', '--signer', 'Jane Doe', '--profile', 'csa-part11', '-o', 'pack.zip']);
    expect(pack.exitCode).toBe(0);
    expect(existsSync(join(project, 'pack-summary.html'))).toBe(true);

    const ok = await cli(project, ['evidence', 'verify-pack', 'pack.zip', '--pub', 'qa.pub.pem']);
    expect(ok.out).toMatch(/^VALID/);
    expect(ok.exitCode).toBe(0);

    const entries = readZip(await readFile(join(project, 'pack.zip')));
    const victim = entries.find((e) => e.name === 'run.json')!;
    victim.data = Buffer.from(victim.data.toString().replace('"passed"', '"failed"'));
    await writeFile(join(project, 'tampered.zip'), writeZip(entries.map((e) => ({ name: e.name, data: e.data }))));
    const bad = await cli(project, ['evidence', 'verify-pack', 'tampered.zip', '--pub', 'qa.pub.pem']);
    expect(bad.out).toMatch(/^INVALID/);
    expect(bad.exitCode).toBe(1);
  });

  it('records a real API through the mock proxy and replays it without the service', async () => {
    const tokenRes = await fetch(`${app.url}/api/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials&client_id=ez-client&client_secret=ez-client-secret',
    });
    const token = ((await tokenRes.json()) as { access_token: string }).access_token;
    const recording = cli(project, ['mock', 'record', '--store', 'mocks.json', '--target', app.url, '--port', '4791', '--for', '2']);
    await new Promise((r) => setTimeout(r, 500));
    const live = await fetch('http://127.0.0.1:4791/api/customers', { headers: { authorization: `Bearer ${token}` } });
    const liveBody = await live.json();
    expect((await recording).out).toMatch(/1 recordings/);

    const replaying = cli(project, ['mock', 'replay', '--store', 'mocks.json', '--port', '4792', '--for', '1.5']);
    await new Promise((r) => setTimeout(r, 500));
    const replayed = await fetch('http://127.0.0.1:4792/api/customers', { headers: { authorization: 'Bearer anything' } });
    expect(await replayed.json()).toEqual(liveBody);
    const unmatched = await fetch('http://127.0.0.1:4792/api/nope');
    expect(unmatched.status).toBe(501);
    await replaying;
    expect((await readFile(join(project, 'mocks.json'), 'utf8')).includes(token)).toBe(false);
  });
});
