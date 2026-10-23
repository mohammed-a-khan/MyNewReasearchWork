/** `eztest trace list|steps|step|snapshot|network` over a real time-travel trace of the demo app. */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { buildProgram } from '../../src/cli/index.js';
import { runJourneys } from '../../src/runner/index.js';
import { FAST, bobOrderJourney, runDirOf, tempDir } from './fixtures.js';

let server: DemoServer;
let runDir: string;
let cwd: string;

async function cli(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const before = process.exitCode;
  process.exitCode = 0;
  await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: process.env }).exitOverride().parseAsync(['node', 'eztest', ...args]);
  process.exitCode = before;
  return out.join('\n');
}

beforeAll(async () => {
  server = await startDemoApp({ variant: 'a' });
  cwd = await tempDir('trace-cli');
  const out = join(cwd, 'results');
  const run = await runJourneys([bobOrderJourney()], { ...FAST, baseUrl: server.url, outputDir: out, timeTravel: { enabled: true, screenshots: false } });
  runDir = runDirOf(out, run);
});
afterAll(async () => {
  await server.close();
});

describe('eztest trace', () => {
  it('lists traces and steps with status and timings', async () => {
    const list = await cli(['trace', 'list', runDir]);
    expect(list).toMatch(/^bob-order {2}attempt 1 {2}passed {2}\d+ steps/m);
    const steps = await cli(['trace', 'steps', runDir, 'bob-order']);
    expect(steps.split('\n')[0]).toMatch(/^ {2}1 {2}passed +\d+ ms {2}Open \/login$/);
    const j = JSON.parse(await cli(['trace', 'steps', runDir, 'bob-order', '--json'])) as Array<{ n: number; status: string }>;
    expect(j[0]).toMatchObject({ n: 1, status: 'passed' });
  });

  it('prints one step, writes a snapshot as self-contained HTML, and lists network requests', async () => {
    const step = await cli(['trace', 'step', runDir, 'bob-order', '2']);
    expect(step).toMatch(/status {3}passed/);
    expect(step).toMatch(/target {3}the Username field via/);
    const said = await cli(['trace', 'snapshot', runDir, 'bob-order', '3', '--after', '-o', 'snap.html']);
    expect(said).toMatch(/^wrote snap\.html \(after snapshot of/);
    const html = await readFile(join(cwd, 'snap.html'), 'utf8');
    expect(html).toContain("default-src 'none'");
    const before = await cli(['trace', 'snapshot', runDir, 'bob-order', '1', '--before']);
    expect(before).toContain('<html');
    const net = await cli(['trace', 'network', runDir, 'bob-order']);
    expect(net).toMatch(/GET +200 .*\/login/);
  });
});
