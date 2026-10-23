/**
 * Studio opens EZTest browser traces (the per-attempt zip `context.tracing`
 * writes with `trace.browser: on`) in the time-travel viewer: from a run's
 * evidence (`POST /api/runs/:runId/browser-trace`) and as an uploaded file
 * (`POST /api/traces/upload`), with the manifest's integrity check.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { loadConfig } from '../../src/config/index.js';
import { createEngine } from '../../src/engine/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { readEvidenceManifest } from '../../src/insights/index.js';
import { readZip, writeZip } from '../../src/runner/index.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { client } from './helpers.js';

let demo: DemoServer;
let project: string;
let studio: StudioHandle;
let runId: string;
let zipPath: string;

beforeAll(async () => {
  demo = await startDemoApp();
  project = await mkdtemp(join(tmpdir(), 'eztest-studio-browser-trace-'));
  await writeFile(join(project, 'eztest.config.yaml'), toYaml({ baseUrl: demo.url, outputDir: 'results', healing: { enabled: false }, trace: { browser: 'on' } }));
  const engine = await createEngine(await loadConfig({ cwd: project, environment: {} }), { cwd: project });
  try {
    const run = await engine.run([parseEzScript('Journey: Login page\nOpen "/login"\nType "bob" into the Username field\n')]);
    expect(run.journeys[0].status).toBe('passed');
    runId = run.runId;
  } finally {
    await engine.close();
  }
  const ev = (await readEvidenceManifest(join(project, 'results', runId))).find((e) => e.kind === 'trace' && e.path.endsWith('.zip'))!;
  zipPath = ev.path;
  studio = await startStudio({ cwd: project, watch: false, env: { ...process.env } });
}, 120_000);

afterAll(async () => {
  await studio?.close();
  await demo?.close();
});

describe('Studio opens EZTest browser traces', () => {
  it("opens a run's per-attempt browser trace from its evidence, with snapshots", async () => {
    const c = client(studio.port, studio.token);
    const r = await c.post(`/api/runs/${runId}/browser-trace`, { path: zipPath });
    expect(r.status, r.body).toBe(201);
    const v = r.json();
    expect(v).toMatchObject({ kind: 'browser', verified: true, problems: [], trace: { source: 'browser', journeyName: 'Login page' } });
    expect(v.trace.steps.map((s: { action: string }) => s.action)).toEqual(expect.arrayContaining(['goto', 'fill']));
    const fill = v.trace.steps.findIndex((s: { action: string }) => s.action === 'fill');
    const snap = await c.get(`/api/traces/uploaded/${v.id}/steps/${fill}/after`);
    expect(snap.status).toBe(200);
    expect(snap.body).toMatch(/value="bob"/);
    expect(snap.body.toLowerCase()).not.toContain('<script');
    expect((await c.post(`/api/runs/${runId}/browser-trace`, { path: '../../etc/passwd' })).status).toBe(404);
    expect((await c.post(`/api/runs/${runId}/browser-trace`, { path: 'run.json' })).status).toBe(404);
  });

  it('opens an uploaded browser trace and reports a tampered one', async () => {
    const c = client(studio.port, studio.token);
    const zip = await readFile(join(project, 'results', runId, zipPath));
    const ok = await c.post('/api/traces/upload', { name: 'attempt.zip', data: zip.toString('base64') });
    expect(ok.status, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ kind: 'browser', verified: true });
    const files = readZip(zip);
    files.set('actions.jsonl', Buffer.concat([files.get('actions.jsonl')!, Buffer.from(' ')]));
    const bad = await c.post('/api/traces/upload', { name: 'tampered.zip', data: writeZip([...files].map(([name, data]) => ({ name, data }))).toString('base64') });
    expect(bad.json()).toMatchObject({ kind: 'browser', verified: false, problems: ['actions.jsonl was altered (SHA-256 differs from the manifest)'] });
    const junk = await c.post('/api/traces/upload', { name: 'x.zip', data: writeZip([{ name: 'trace.trace', data: Buffer.from('{}') }]).toString('base64') });
    expect(junk.status).toBe(422);
  });
});
