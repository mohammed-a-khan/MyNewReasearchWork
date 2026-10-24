/**
 * `eztest publish <runDir>` sends the run's readiness decision to the results server: a saved report.json keeps it
 * under insights.readiness, and the server dashboard used to show "Readiness: none" for a run that had one.
 */
import { afterAll, describe, expect, it } from '../support/testkit.js';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { buildProgram, type CliIO } from '../../src/cli/program.js';
import { pickAnalysis } from '../../src/cli/scale.js';
import { tempDir } from '../runner/fixtures.js';
import { startTestServer, type TestServer } from './helpers.js';

let site: Server | undefined;
let server: TestServer | undefined;
afterAll(async () => {
  site?.close();
  await server?.close();
});

async function cli(cwd: string, args: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: { ...process.env, ...env } };
  process.exitCode = 0;
  await buildProgram(io).parseAsync(['node', 'eztest', ...args], { from: 'node' });
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { out: out.join('\n'), err: err.join('\n'), code };
}

describe('publishing the readiness decision', () => {
  it('pickAnalysis reads report.json insights as well as an in-process analysis', () => {
    const readiness = { decision: 'GO', score: 97 };
    expect(pickAnalysis({ insights: { readiness, triage: { verdicts: [] } } })).toEqual({ readiness, triage: { verdicts: [] } });
    expect(pickAnalysis({ readiness })).toEqual({ readiness });
    expect(pickAnalysis({})).toEqual({});
  });

  it('a published run shows its decision on the server, not "none"', async () => {
    site = createServer((_q, r) => r.end('<!doctype html><html lang="en"><title>Home</title><main><h1>Welcome</h1></main></html>'));
    await new Promise<void>((r) => site!.listen(0, '127.0.0.1', r));
    const dir = await tempDir('publish-readiness');
    await mkdir(join(dir, 'journeys'));
    await writeFile(join(dir, 'eztest.config.yaml'), `baseUrl: http://127.0.0.1:${(site.address() as AddressInfo).port}\njourneysDir: journeys\noutputDir: results\nreporters: [json]\nvideo: off\nreadiness:\n  policyPath: readiness-policy.yaml\n`);
    await writeFile(join(dir, 'readiness-policy.yaml'), 'version: 1\ngates:\n  minPassRate: { min: 0.9 }\n');
    await writeFile(join(dir, 'journeys', 'home.ez'), 'Journey: Home\nId: home\nOpen "/"\n  Expect the page to contain "Welcome"\n');
    const run = await cli(dir, ['run']);
    expect(run.code, run.out + run.err).toBe(0);
    const runId = (await readdir(join(dir, 'results'))).find((d) => d.startsWith('run-'))!;

    server = await startTestServer();
    const token = await server.token('ci', [{ project: 'shop', role: 'tester' }]);
    const pub = await cli(dir, ['publish', `results/${runId}`, '--server', server.url, '--server-project', 'shop'], { EZTEST_SERVER_TOKEN: token });
    expect(pub.code, pub.out + pub.err).toBe(0);
    const runs = await server.req('GET', '/api/projects/shop/runs', { token });
    const published = (runs.json.runs ?? runs.json) as Array<{ runId: string; readiness?: string; readinessScore?: number }>;
    expect(published.find((r) => r.runId === runId)).toMatchObject({ readiness: 'GO' });
    const page = await server.req('GET', '/ui/p/shop', { token });
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/Readiness<\/span><span class="t-value"><span class="badge b-go">GO<\/span>/);
  }, 120_000);
});
