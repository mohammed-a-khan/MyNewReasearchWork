/**
 * End to end on the EZ Shop demo app: `Expect ... to look like the baseline`
 * steps through `eztest run` (element-level, layout mode, masks, several
 * viewports, browser/viewport keyed baselines), a real change grouped by the
 * DOM change behind it, and the Studio approval of a whole group recorded in
 * the approvals vault.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { existsSync, readdirSync } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { buildProgram } from '../../src/cli/index.js';
import { verifyEvidence, type RunResult } from '../../src/core/index.js';
import { startStudio } from '../../src/studio/index.js';
import { client } from '../studio/helpers.js';

/** The native suite on Firefox (EZTEST_BROWSER=firefox): tests that only make sense on Chromium skip, saying why. */
const onFirefox = process.env.EZTEST_BROWSER === 'firefox';
const chromiumOnly = (title: string, reason: string) => (onFirefox ? `${title} [skipped on Firefox: ${reason}]` : title);

const EXAMPLE = resolve(__dirname, '../../examples/shop-project');
const JOURNEY = `Journey: Dashboard looks right
Tags: @visual
Log in as manager
Open /dashboard
  Expect the page contains "Recent orders"
Expect the "Main" navigation to look like the baseline
Expect the "Recent orders" table to look like baseline "orders-grid" in layout mode
Expect the page to look like the baseline masking "table" at viewports 1280x720 and 800x600
`;

async function cli(cwd: string, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const before = process.exitCode;
  process.exitCode = 0;
  await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: process.env }).exitOverride().parseAsync(['node', 'eztest', ...args]);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = before;
  return { out: out.join('\n'), err: err.join('\n'), code };
}

async function latestRun(project: string): Promise<{ id: string; run: RunResult }> {
  const root = join(project, 'eztest-results');
  const id = (await readdir(root)).filter((d) => d.startsWith('run-')).sort().pop()!;
  return { id, run: JSON.parse(await readFile(join(root, id, 'run.json'), 'utf8')) as RunResult };
}

describe('visual assertions on the demo app (eztest run + Studio approval)', () => {
  let a: DemoServer;
  let b: DemoServer;
  let project: string;
  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };

  beforeAll(async () => {
    project = await mkdtemp(join(tmpdir(), 'eztest-visual-'));
    await cp(EXAMPLE, project, { recursive: true });
    await writeFile(join(project, 'journeys', 'visual.ez'), JOURNEY);
    const db = join(project, 'shop.db');
    a = await startDemoApp({ dbFile: db });
    b = await startDemoApp({ dbFile: db, variant: 'b' });
    // One order up front, so the dashboard shows its table (not "No orders yet") from the first baseline on.
    a.db.prepare("INSERT INTO orders (customer_id, created_by, status, total, created_at) VALUES (2, 'bob', 'Submitted', 19.99, '2026-09-01T10:00:00Z')").run();
    for (const [k, v] of Object.entries({ SHOP_DB: db, SHOP_BOB_PASSWORD: 'Builder#2', SHOP_API_CLIENT_SECRET: 'ez-client-secret', EZTEST_BASELINE_BRANCH: '', EZTEST_UPDATE_BASELINES: undefined })) setEnv(k, v);
  });
  afterAll(async () => {
    await a?.close();
    await b?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it.skipIf(onFirefox)(chromiumOnly('creates keyed baselines, passes against them, and survives a class rename (variant b)', 'the expected baseline keys name chromium'), async () => {
    setEnv('SHOP_URL', a.url);
    const made = await cli(project, ['run', 'journeys/visual.ez', '--update-baselines', '--no-analyze']);
    expect(made.out).toContain('=> passed');
    setEnv('EZTEST_UPDATE_BASELINES', undefined);
    const files = readdirSync(join(project, '.eztest', 'baselines')).sort();
    expect(files).toEqual(expect.arrayContaining([
      'dashboard-looks-right-expect-the-main-navigation-to-look-like-the-baseline--chromium--1280x720.png',
      'orders-grid--chromium--1280x720.png',
      'orders-grid--chromium--1280x720.dom.json',
      expect.stringMatching(/--chromium--800x600\.png$/),
    ]));
    const again = await cli(project, ['run', 'journeys/visual.ez', '--no-analyze']);
    expect(again.out).toContain('=> passed');
    // Variant b renames the grid's CSS class: layout and masked page checks still pass.
    setEnv('SHOP_URL', b.url);
    const renamed = await cli(project, ['run', 'journeys/visual.ez', '--no-analyze']);
    expect(renamed.out).toContain('=> passed');
  }, 180_000);

  it.skipIf(onFirefox)(chromiumOnly('a new order row fails the layout check with the change named, and Studio approves the group into the vault', 'the expected baseline keys name chromium'), async () => {
    setEnv('SHOP_URL', a.url);
    a.db.prepare("INSERT INTO orders (customer_id, created_by, status, total, created_at) VALUES (1, 'bob', 'Submitted', 49.5, '2026-10-01T10:00:00Z')").run();
    const failed = await cli(project, ['run', 'journeys/visual.ez', '--no-analyze']);
    expect(failed.out).toContain('=> failed');
    const { id, run } = await latestRun(project);
    const step = run.journeys[0].steps.find((s) => s.stepId.startsWith('expect-the-recent-orders-table'))!;
    expect(step.status).toBe('failed');
    expect(step.error?.message).toMatch(/orders-grid--chromium--1280x720 \(layout\) differs: tr added \(with 5 descendants\);.*table\.orders-table resized by \d+, \d+ px/);

    const studio = await startStudio({ cwd: project, watch: false });
    try {
      const c = client(studio.port, studio.token);
      const vis = (await c.get(`/api/assurance/visual/runs/${id}`)).json() as {
        items: Array<{ name: string; status: string; mode?: string; key?: string; groups?: Array<{ id: string; summary: string }>; actual?: string; journeyId: string; stepId: string }>;
        groups: Array<{ id: string; kind: string; summary: string; items: string[] }>;
      };
      const grid = vis.items.find((i) => i.name === 'orders-grid--chromium--1280x720')!;
      expect(grid).toMatchObject({ status: 'mismatch', mode: 'layout', key: 'orders-grid--chromium--1280x720' });
      expect(grid.actual).toBeDefined();
      expect(grid.groups!.length).toBeGreaterThan(0);
      // The navigation matched; the page check did not run after the failed step.
      expect(vis.items.map((i) => [i.name.split('--')[0], i.status])).toEqual([['dashboard-looks-right-expect-the-main-navigation-to-look-like-the-baseline', 'match'], ['orders-grid', 'mismatch']]);
      const group = vis.groups.find((g) => g.items.includes(grid.name) && g.kind === 'added')!;
      expect(group.summary).toBe('tr added (with 5 descendants)');
      // Approve every comparison the group touches in one action.
      const members = vis.items.filter((i) => group.items.includes(i.name) && i.actual);
      const res = (await c.post('/api/assurance/visual/approve', { items: members.map((i) => ({ name: i.name, runId: id, journeyId: i.journeyId, stepId: i.stepId, group: group.id })), comment: `group: ${group.summary}` })).json() as { approved: Array<{ name: string; group?: string }>; vault: string; verified: boolean };
      expect(res.approved.map((x) => x.name)).toContain(grid.name);
      expect(res.approved.every((x) => x.group === group.id)).toBe(true);
      expect(res.verified).toBe(true);
      expect((await verifyEvidence(join(project, res.vault))).ok).toBe(true);
      // The DOM snapshot was approved with the screenshot.
      expect(existsSync(join(project, '.eztest', 'baselines', 'orders-grid--chromium--1280x720.dom.json'))).toBe(true);
    } finally {
      await studio.close();
    }
    const after = await cli(project, ['run', 'journeys/visual.ez', '--no-analyze']);
    expect(after.out).toContain('=> passed');
  }, 180_000);
});
