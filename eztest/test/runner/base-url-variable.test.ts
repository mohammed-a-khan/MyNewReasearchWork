/**
 * `Base URL: ${PARTNER_URL}` (what lint's hardcoded-host rule recommends) reads the journey's variables: config
 * `vars`, EZTEST_VAR_<name> and run variables. It was used as written, so `Open /hovers` failed with "Invalid URL".
 * A name nothing sets stops the journey with that name. Real browser, local server.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { stringify as toYaml } from 'yaml';
import { loadConfig } from '../../src/config/index.js';
import { createEngine } from '../../src/engine/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { journeyBaseUrl, runJourneys } from '../../src/runner/index.js';

/** Temporary folders this file made, removed at the end. */
const made: string[] = [];
async function tempDirOf(prefix: string): Promise<string> {
  const d = await mkdtemp(prefix);
  made.push(d);
  return d;
}
afterAll(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

let server: Server;
let partner = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Partner</title><h1>Partner ${new URL(req.url ?? '/', 'http://x').pathname}</h1>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  partner = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const JOURNEY = 'Journey: On the partner host\nBase URL: ${PARTNER_URL}\n\nOpen /hovers\nExpect the page contains "Partner /hovers"\n';

describe('Base URL: ${VAR}', () => {
  it('a run variable', async () => {
    const out = await tempDirOf(join(tmpdir(), 'ez-base-url-'));
    const run = await runJourneys([parseEzScript(JOURNEY)], { outputDir: out, baseUrl: 'http://127.0.0.1:9', variables: { PARTNER_URL: partner }, stepTimeoutMs: 8000 });
    const j = run.journeys[0];
    expect(j.steps.map((s) => `${s.status}${s.error ? ` ${s.error.message}` : ''}`)).toEqual(['passed']);
    expect(j.status).toBe('passed');
  }, 60_000);

  it('a config variable, and EZTEST_VAR_<name> over it, through the engine', async () => {
    const dir = await tempDirOf(join(tmpdir(), 'ez-base-url-cfg-'));
    await writeFile(join(dir, 'eztest.config.yaml'), toYaml({ outputDir: 'results', baseUrl: 'http://127.0.0.1:9', healing: { enabled: false }, vars: { PARTNER_URL: 'http://127.0.0.1:9/wrong' } }));
    const engine = await createEngine(await loadConfig({ cwd: dir, environment: { EZTEST_VAR_PARTNER_URL: partner } }), { cwd: dir, runOptions: { stepTimeoutMs: 8000, screenshots: 'off' } });
    try {
      const r = await engine.run([parseEzScript(JOURNEY)]);
      expect(r.journeys[0].status, JSON.stringify(r.journeys[0].steps.map((s) => s.error?.message))).toBe('passed');
    } finally {
      await engine.close();
    }
  }, 60_000);

  it('a name nothing sets stops the journey with that name, not "Invalid URL"', async () => {
    const out = await tempDirOf(join(tmpdir(), 'ez-base-url-missing-'));
    const run = await runJourneys([parseEzScript(JOURNEY)], { outputDir: out, baseUrl: partner, stepTimeoutMs: 8000 });
    const j = run.journeys[0];
    expect(j.status).toBe('error');
    expect(j.error?.message).toMatch(/^Base URL: \$\{PARTNER_URL\}: \$\{PARTNER_URL\} is not set/);
    expect(journeyBaseUrl('${HOST}/app', { HOST: 'https://partner.test' })).toEqual({ url: 'https://partner.test/app' });
    expect(journeyBaseUrl('${HOST}', { HOST: 'partner.test' }).problem).toMatch(/is not an absolute URL/);
    expect(journeyBaseUrl('${HOST:-https://fallback.test}', {})).toEqual({ url: 'https://fallback.test' });
  }, 60_000);
});
