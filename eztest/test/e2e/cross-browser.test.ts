/**
 * Cross-browser runs (docs/browser-driver.md): `--browsers chromium,firefox`
 * expands the run plan into journey x browser units on real Chromium (CDP) and
 * Firefox (WebDriver BiDi). Result ids, history, flaky scores, reports and
 * readiness are per browser, with the combined view next to them; shards split
 * units and agree on every machine; `Browsers:` limits a journey.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import type { RunResult } from '../../src/core/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { HistoryStore } from '../../src/insights/index.js';
import { browserOfId, expandBrowserMatrix, resolveBrowserTarget, runBrowsers, stripBrowser } from '../../src/runner/index.js';
import { baseJourneyId, lastFailedIds, lastStatuses } from '../../src/scale/runflags.js';
import { cli, latestRun } from '../sdk/helpers.js';

let app: DemoServer;
let project: string;

const EVERYWHERE = `Journey: Sign in to chat
Tags: @chat
Risk: 4
Open /chat/login
Type "anna" into the Your name field
Click the "Join the chat" button
  Expect the page contains "Signed in as anna"
`;
// Signs in as the browser's own name and expects "chromium": fails on Firefox only.
const CHROMIUM_ONLY_BUG = `Journey: Browser name greeting
Tags: @chat
Risk: 4
Open /chat/login
Type "\${browser}" into the Your name field
Click the "Join the chat" button
  Expect the page contains "Signed in as chromium"
`;
const LIMITED = `Journey: Chromium only feature
Browsers: chromium
Open /chat/login
  Expect the page contains "Your name"
`;

beforeAll(async () => {
  app = await startDemoApp();
  project = await mkdtemp(join(tmpdir(), 'eztest-xbrowser-'));
  await mkdir(join(project, 'journeys'));
  await writeFile(join(project, 'eztest.config.yaml'), `baseUrl: ${app.url}
journeysDir: journeys
outputDir: eztest-results
reporters: [html, json]
timeouts:
  step: 6000
readiness:
  policyPath: readiness-policy.yaml
`);
  await writeFile(join(project, 'readiness-policy.yaml'), 'version: 1\ngates:\n  noFailedCriticalJourneys: { minRisk: 4 }\n  minPassRate: { min: 0.9 }\nexceptions: []\n');
  await writeFile(join(project, 'journeys', 'everywhere.ez'), EVERYWHERE);
  await writeFile(join(project, 'journeys', 'greeting.ez'), CHROMIUM_ONLY_BUG);
  await writeFile(join(project, 'journeys', 'limited.ez'), LIMITED);
});
afterAll(async () => {
  await app.close();
});

describe('run plan: journey x browser units', () => {
  it('names browsers, rejects webkit and protocol mismatches, expands units with Depends on and Browsers:', () => {
    expect(runBrowsers({ browsers: ['chromium', 'firefox', 'msedge'] }).map((b) => [b.id, b.engine, b.channel])).toEqual([['chromium', 'chromium', undefined], ['firefox', 'firefox', undefined], ['msedge', 'chromium', 'msedge']]);
    expect(runBrowsers({ browser: 'chromium', channel: 'msedge' })).toEqual([{ id: 'chromium', engine: 'chromium', channel: 'msedge' }]);
    expect(() => runBrowsers({ browsers: ['webkit'] })).toThrow(/webkit/);
    expect(() => runBrowsers({ browsers: ['chromium', 'chromium'] })).toThrow(/twice/);
    expect(() => resolveBrowserTarget({ name: 'firefox', connect: { cdpEndpoint: 'http://x:9222' } })).toThrow(/bidiEndpoint/);
    expect(() => resolveBrowserTarget({ name: 'msedge', connect: { bidiEndpoint: 'ws://x:9222' } })).toThrow(/cdpEndpoint/);
    const login = parseEzScript('Journey: Login\nOpen /');
    const order = parseEzScript('Journey: Order\nDepends on: Login\nOpen /');
    const only = parseEzScript('Journey: Edge only\nBrowsers: msedge\nOpen /');
    const m = expandBrowserMatrix([login, order, only], ['chromium', 'firefox']);
    expect(m.journeys.map((j) => j.id)).toEqual(['login@chromium', 'login@firefox', 'order@chromium', 'order@firefox']);
    expect(m.journeys[3]).toMatchObject({ browser: 'firefox', name: 'Order [firefox]', dependsOn: [{ journey: 'login@firefox' }], variables: { browser: 'firefox' } });
    expect(m.excluded.map((x) => x.journey.id)).toEqual(['edge-only']);
    // One browser: nothing changes (ids, history and baselines of existing projects stay as they were).
    expect(expandBrowserMatrix([login], ['chromium']).journeys).toEqual([login]);
    // Ids: units fold back to their journey for selection; repeats and Examples rows keep the browser last.
    expect(stripBrowser('checkout@firefox')).toBe('checkout');
    expect(stripBrowser('checkout-row1@msedge')).toBe('checkout-row1');
    expect(stripBrowser('user@example')).toBe('user@example');
    expect(browserOfId('checkout@firefox~rep2')).toBe('firefox');
    expect(baseJourneyId('checkout@firefox~rep2')).toBe('checkout@firefox');
    const runs = [{ runId: 'r1', startedAt: '', outcomes: [{ journeyId: 'order@firefox', status: 'failed' as const, durationMs: 1, attempt: 1 }, { journeyId: 'order@chromium', status: 'passed' as const, durationMs: 1, attempt: 1 }] }];
    expect(lastFailedIds(runs, [order]).ids).toEqual(['order']);
    expect(lastStatuses(runs, ['order']).get('order')).toBe('failed');
    expect(lastStatuses(runs, ['order@chromium', 'order@firefox']).get('order@chromium')).toBe('passed');
  });
});

describe('cross-browser run on real Chromium and Firefox', () => {
  it('runs every journey per browser with per-browser results, reports, history and readiness (plus combined)', async () => {
    const r = await cli(project, ['run', '--browsers', 'chromium,firefox']);
    const { dir, run } = await latestRun(project);
    const byId = Object.fromEntries(run.journeys.map((j) => [j.journeyId, j]));
    expect(Object.keys(byId).sort()).toEqual([
      'browser-name-greeting@chromium', 'browser-name-greeting@firefox',
      'chromium-only-feature@chromium', 'chromium-only-feature@firefox',
      'sign-in-to-chat@chromium', 'sign-in-to-chat@firefox',
    ].filter((id) => id !== 'chromium-only-feature@firefox'));
    expect(byId['sign-in-to-chat@chromium']).toMatchObject({ status: 'passed', browser: 'chromium', name: 'Sign in to chat [chromium]' });
    expect(byId['sign-in-to-chat@firefox']).toMatchObject({ status: 'passed', browser: 'firefox' });
    expect(byId['browser-name-greeting@chromium'].status).toBe('passed');
    expect(byId['browser-name-greeting@firefox'].status).toBe('failed');
    expect(byId['chromium-only-feature@chromium'].status).toBe('passed');
    expect(r.exitCode).toBe(1);
    // Per-browser summaries, versions from each browser, combined summary.
    expect(run.browsers?.chromium).toMatchObject({ total: 3, passed: 3, failed: 0 });
    expect(run.browsers?.firefox).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(run.browsers?.firefox.version).toMatch(/^\d+/);
    expect(run.summary).toMatchObject({ total: 5, passed: 4, failed: 1 });
    expect(run.environment.browser).toBe('chromium,firefox');
    expect(run.environment.browserVersion).toMatch(/^chromium \d.*, firefox \d/);
    // Readiness: the combined decision and one per browser; the Firefox-only failure is a NO_GO on Firefox only.
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as { insights: { readiness: { decision: string; browsers: Record<string, { decision: string; failed: string[] }> } } };
    expect(report.insights.readiness.decision).toBe('NO_GO');
    expect(report.insights.readiness.browsers.chromium.decision).toBe('GO');
    expect(report.insights.readiness.browsers.firefox).toMatchObject({ decision: 'NO_GO', failed: ['browser-name-greeting@firefox'] });
    const html = readFileSync(join(dir, 'report.html'), 'utf8');
    expect(html).toContain('id="browsers-h"');
    expect(html).toContain('fails on firefox only');
    // History keeps one outcome per unit: flaky scoring and trends are per browser.
    const history = await HistoryStore.open(join(project, '.eztest', 'history.json'));
    expect(history.journeyIds().sort()).toEqual(Object.keys(byId).sort());
    expect(history.outcomesFor('browser-name-greeting@firefox').map((o) => o.status)).toEqual(['failed']);
    expect(history.outcomesFor('browser-name-greeting@chromium').map((o) => o.status)).toEqual(['passed']);
  });

  it('shards split journey x browser units, every machine agrees, and --last-failed reruns the failing journey', async () => {
    const plans: string[][] = [];
    for (const s of ['1/2', '2/2']) {
      const p = await cli(project, ['run', '--browsers', 'chromium,firefox', '--shard', s, '--plan']);
      const line = p.out.find((l) => l.startsWith('would run')) ?? '';
      plans.push(line.replace(/^would run \d+ journeys: /, '').split(', ').filter(Boolean));
      expect(p.out.some((l) => l.startsWith('browsers: chromium, firefox'))).toBe(true);
    }
    const union = [...plans[0], ...plans[1]];
    // Units, not journeys, are dealt out; nothing is run twice or dropped.
    expect(new Set(union).size).toBe(union.length);
    expect(union.sort()).toEqual(['browser-name-greeting@chromium', 'browser-name-greeting@firefox', 'chromium-only-feature@chromium', 'sign-in-to-chat@chromium', 'sign-in-to-chat@firefox']);
    const lf = await cli(project, ['run', '--browsers', 'chromium,firefox', '--last-failed', '--plan']);
    expect(lf.out.find((l) => l.startsWith('would run'))).toBe('would run 2 journeys: browser-name-greeting@chromium, browser-name-greeting@firefox');
  });

  it('a single-browser run keeps plain ids (no @browser suffix)', async () => {
    await cli(project, ['run', '--grep', 'sign-in-to-chat', '--no-analyze']);
    const { run } = await latestRun(project) as { run: RunResult };
    expect(run.journeys.map((j) => j.journeyId)).toEqual(['sign-in-to-chat']);
    expect(run.browsers).toBeUndefined();
  });
});
