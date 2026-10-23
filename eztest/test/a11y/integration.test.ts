/**
 * EZTest's accessibility engine wired into the product: the "Check
 * accessibility" phrasings, the step handler, the a11y lens through
 * `eztest run --lens`, and the `a11yNoCritical` readiness gate fed from the
 * run's evidence (CLI and analyzeRun).
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { buildProgram } from '../../src/cli/index.js';
import { analyzeRun } from '../../src/engine/index.js';
import { journeyToEzScript, parseEzScript, parseIntent } from '../../src/intent/index.js';
import { a11yReadinessInputs, isA11yEvidence } from '../../src/a11y/index.js';
import { readEvidenceManifest } from '../../src/insights/index.js';
import { GIF, page as wrap } from './fixtures.js';

let server: Server;
let base = '';
let dir = '';

async function cli(cwd: string, args: string[]): Promise<{ out: string; err: string; exitCode: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const before = process.exitCode;
  process.exitCode = 0;
  try {
    await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: process.env }).exitOverride().parseAsync(['node', 'eztest', ...args]);
  } catch (e) {
    err.push((e as Error).message);
    if (!process.exitCode) process.exitCode = 1;
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = before;
  return { out: out.join('\n'), err: err.join('\n'), exitCode };
}

const seenRuns = new Set<string>();

/** The run directory created since the last call (run ids can sort equal within a second, so compare sets). */
async function newestRun(cwd: string): Promise<string> {
  const runs = (await readdir(join(cwd, 'results'))).filter((r) => existsSync(join(cwd, 'results', r, 'run.json')));
  const fresh = runs.filter((r) => !seenRuns.has(r));
  for (const r of runs) seenRuns.add(r);
  expect(fresh).toHaveLength(1);
  return join(cwd, 'results', fresh[0]);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url === '/bad') res.end(wrap(`<p>Bad page</p><img src="${GIF}" width="20" height="20"><button></button>`));
    else res.end(wrap('<p>Good page</p><button>Continue</button>'));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  dir = await mkdtemp(join(tmpdir(), 'eztest-a11y-'));
  await mkdir(join(dir, 'journeys'), { recursive: true });
  await writeFile(join(dir, 'eztest.config.yaml'), toYaml({ baseUrl: base, outputDir: 'results', healing: { enabled: false }, reporters: ['json'], screenshots: 'off' }));
  await writeFile(join(dir, 'journeys', 'good.ez'), 'Journey: Good page\n\nOpen /good\nCheck accessibility at WCAG 2.2 level AA\n');
  await writeFile(join(dir, 'journeys', 'bad.ez'), 'Journey: Bad page\n\nOpen /bad\nExpect the page to contain "Bad page"\n');
  await writeFile(join(dir, 'journeys', 'bad-step.ez'), 'Journey: Bad page checked\n\nOpen /bad\nCheck accessibility without dynamic checks\n');
  await writeFile(join(dir, 'policy.yaml'), toYaml({ gates: { a11yNoCritical: true } }));
});
afterAll(async () => {
  await new Promise((r) => server?.close(r));
});

describe('"Check accessibility" phrasings', () => {
  it('parse into the eztest.a11y step with level, scope and options', () => {
    expect(parseIntent('Check accessibility')).toMatchObject({ action: 'custom', handler: 'eztest.a11y' });
    expect(parseIntent('Check the page for accessibility issues at WCAG 2.2 level AA')).toMatchObject({ handler: 'eztest.a11y', args: { level: 'AA' } });
    expect(parseIntent('Audit accessibility to level AAA including best practices')).toMatchObject({ args: { level: 'AAA', bestPractice: 'true' } });
    expect(parseIntent('Scan for accessibility violations without dynamic checks failing on critical issues')).toMatchObject({ args: { dynamic: 'false', failOn: 'critical' } });
    const scoped = parseIntent('Check accessibility of the Checkout form');
    expect(scoped).toMatchObject({ handler: 'eztest.a11y' });
    expect(scoped.target?.description).toMatch(/Checkout form/);
    expect(parseIntent('Check accessibility of the page').target).toBeUndefined();
    expect(parseIntent('Expect the page to be accessible')).toMatchObject({ handler: 'eztest.a11y' });
    // Still a check box click and a plain assertion.
    expect(parseIntent('Check the Remember me checkbox').handler).toBeUndefined();
    expect(parseIntent('Check that the URL contains "/x"').action).toBe('assert');
  });

  it('are steps of their own (never post-conditions) and round-trip through .ez text', () => {
    const j = parseEzScript('Journey: A11y\n\nOpen /good\nExpect the page to be accessible to level A\nCheck accessibility in the Main menu without dynamic checks\n');
    expect(j.steps.map((s) => s.action)).toEqual(['navigate', 'custom', 'custom']);
    expect(j.steps[0].postconditions ?? []).toEqual([]);
    expect(j.steps[1].args).toEqual({ level: 'A' });
    const again = parseEzScript(journeyToEzScript(j));
    expect(again.steps.map((s) => [s.action, s.handler, s.args])).toEqual(j.steps.map((s) => [s.action, s.handler, s.args]));
  });
});

describe('accessibility in runs and release readiness', () => {
  it('passes a clean page and fails a broken one with the "Check accessibility" step', async () => {
    const good = await cli(dir, ['run', 'journeys/good.ez', '--no-analyze']);
    expect(good.exitCode, good.out + good.err).toBe(0);
    const runDir = await newestRun(dir);
    const evidence = await readEvidenceManifest(runDir);
    const ref = evidence.find(isA11yEvidence)!;
    expect(ref.path).toMatch(/^a11y\/.+\/lens-a11y-.+\.json$/);
    const stored = JSON.parse(await readFile(join(runDir, ref.path), 'utf8')) as Array<{ details: { violations: unknown[]; rules: string[] } }>;
    expect(stored[0].details.violations).toEqual([]);
    expect(stored[0].details.rules).toEqual(expect.arrayContaining(['keyboard.trap', 'layout.reflow', 'text.spacing']));
    expect(await a11yReadinessInputs(runDir, evidence)).toEqual({ a11y: [] });

    const bad = await cli(dir, ['run', 'journeys/bad-step.ez', '--no-analyze']);
    expect(bad.exitCode).toBe(1);
    const result = JSON.parse(await readFile(join(await newestRun(dir), 'run.json'), 'utf8')) as { journeys: Array<{ steps: Array<{ status: string; error?: { message: string } }> }> };
    const failed = result.journeys[0].steps.find((s) => s.status === 'failed');
    expect(failed?.error?.message).toMatch(/Accessibility check failed: .*text-alt\.img \(critical, 1 element\)/);
    expect(failed?.error?.message).toMatch(/name\.button \(critical/);
  }, 120_000);

  it('feeds lens findings to the a11yNoCritical gate, citing the evidence', async () => {
    const run = await cli(dir, ['run', 'journeys/bad.ez', '--lens', 'a11y:warn', '--no-analyze']);
    expect(run.exitCode, run.out + run.err).toBe(0);
    const runDir = await newestRun(dir);
    const evidence = await readEvidenceManifest(runDir);
    const inputs = await a11yReadinessInputs(runDir, evidence);
    expect(inputs.a11y?.map((i) => i.ruleId)).toEqual(expect.arrayContaining(['text-alt.img', 'name.button']));
    expect(inputs.a11y?.every((i) => i.journeyId === 'bad-page' && i.evidence?.length === 1)).toBe(true);
    const a = await analyzeRun(runDir, { readinessPolicyPath: join(dir, 'policy.yaml'), recordHistory: false, formats: ['json'] });
    const gate = a.readiness!.gates.find((g) => g.gate === 'a11yNoCritical')!;
    expect(gate.status).toBe('fail');
    expect(gate.summary).toMatch(/critical accessibility violation\(s\): .*text-alt\.img/);
    expect(gate.cites.evidence.length).toBeGreaterThan(0);
    expect(gate.cites.journeys).toEqual(['bad-page']);

    // A run without accessibility evidence has no data for the gate.
    const plain = await cli(dir, ['run', 'journeys/bad.ez', '--no-analyze']);
    expect(plain.exitCode).toBe(0);
    const plainDir = await newestRun(dir);
    expect(await a11yReadinessInputs(plainDir, await readEvidenceManifest(plainDir))).toEqual({});
    const b = await analyzeRun(plainDir, { readinessPolicyPath: join(dir, 'policy.yaml'), recordHistory: false, formats: ['json'] });
    expect(b.readiness!.gates.find((g) => g.gate === 'a11yNoCritical')!.status).toBe('no-data');
  }, 180_000);
});
