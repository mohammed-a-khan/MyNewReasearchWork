/**
 * A heal rejected by a reviewer on the results server changes what a local
 * `eztest run` does: the CLI pulls the shared decisions before running, and the
 * step fails as a suspected regression instead of healing (real Chromium).
 */
import { afterAll, describe, expect, it } from '../support/testkit.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildProgram, type CliIO } from '../../src/cli/program.js';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { BOB_ORDER_EZ, tempDir } from '../runner/fixtures.js';
import { startTestServer, type TestServer } from './helpers.js';
import type { RunResult } from '../../src/core/index.js';

const servers: Array<{ close(): Promise<void> }> = [];
afterAll(async () => {
  for (const s of servers) await s.close();
  delete process.env.EZTEST_SERVER_TOKEN;
});

async function cli(cwd: string, args: string[]): Promise<{ out: string; err: string; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: { ...process.env } };
  process.exitCode = 0;
  await buildProgram(io).parseAsync(['node', 'eztest', ...args], { from: 'node' });
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { out: out.join('\n'), err: err.join('\n'), code };
}

describe('shared heal decisions from the results server', () => {
  it('a reviewer rejection on the server makes the local run fail the step as a suspected regression', async () => {
    const dir = await tempDir('shared-heals');
    await mkdir(join(dir, 'journeys'), { recursive: true });
    await writeFile(join(dir, 'journeys', 'bob.ez'), BOB_ORDER_EZ);
    const base = 'headless: true\nscreenshots: off\nhealing: { enabled: true }\ntimeouts: { step: 5000 }\n';
    await writeFile(join(dir, 'eztest.config.yaml'), base);

    const a: DemoServer = await startDemoApp({ variant: 'a' });
    servers.push(a);
    const first = await cli(dir, ['run', '--base-url', a.url, '--no-analyze']);
    expect(first.out).toMatch(/1 journeys: 1 passed/);

    const s: TestServer = await startTestServer();
    servers.push(s);
    const approver = await s.token('rita', [{ project: 'payments', role: 'approver' }]);
    const ci = await s.token('ci', [{ project: 'payments', role: 'tester' }]);
    const r = await s.req('POST', '/api/projects/payments/state/heal-decisions', {
      token: approver,
      body: { upsert: [{ journeyId: 'bob-order', stepId: 'click-the-sign-in-button', decision: 'rejected', tier: 'T1-fingerprint', locator: { strategy: 'role', value: 'button', name: 'Log in', exact: true }, reviewer: 'Rita', reason: 'a different control', decidedAt: '2026-10-22T00:00:00Z' }] },
    });
    expect(r.status).toBe(200);

    await writeFile(join(dir, 'eztest.config.yaml'), `${base}server:\n  url: ${s.url}\n  token: secret://env/EZTEST_SERVER_TOKEN\n  project: payments\n`);
    process.env.EZTEST_SERVER_TOKEN = ci;
    const b: DemoServer = await startDemoApp({ variant: 'b' });
    servers.push(b);
    const second = await cli(dir, ['run', '--base-url', b.url, '--no-analyze']);
    expect(second.out).toMatch(/shared state from http:\/\/127\.0\.0\.1:\d+: heal-decisions 1/);
    expect(second.code).toBe(1);
    const local = JSON.parse(await readFile(join(dir, '.eztest', 'heal-decisions.json'), 'utf8')) as { decisions: Array<{ reviewer: string }> };
    expect(local.decisions[0].reviewer).toBe('Rita');
    const outDir = join(dir, 'eztest-results');
    const runId = /run-[\w-]+/.exec(second.out.split('\n').find((l) => l.includes('heal-proposals')) ?? '')?.[0];
    const { readdir } = await import('node:fs/promises');
    const runs = (await readdir(outDir)).filter((d) => d.startsWith('run-')).sort();
    const run = JSON.parse(await readFile(join(outDir, runId ?? runs[runs.length - 1], 'run.json'), 'utf8')) as RunResult;
    const step = run.journeys[0].steps.find((x) => x.stepId === 'click-the-sign-in-button')!;
    expect(step.status).toBe('failed');
    expect(step.error?.message).toMatch(/suspected regression: this heal was rejected in review by Rita/);

    // When the server is down, the local copy is the fallback (and the run says so).
    await s.close();
    servers.splice(servers.indexOf(s), 1);
    const third = await cli(dir, ['run', '--base-url', b.url, '--no-analyze']);
    expect(third.err).toMatch(/shared state heal-decisions: .*unreachable.*\(using local files\)/);
    expect(third.code).toBe(1);
  }, 180_000);
});
