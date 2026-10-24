/**
 * The Debugger and the Time-Travel Trace Viewer in a real Chromium, driving
 * the real Studio against the demo app: a gutter breakpoint set in the
 * Journeys editor and F5, the live canvas receiving frames, the element
 * picker inserting a step, locator validation and the step console;
 * pause on failure, edit-and-continue and "Apply to file" (the file changes
 * and the journey then passes); the trace tab with filmstrip navigation,
 * before/after snapshots in a sandboxed iframe, the network waterfall and a
 * comparison with the last passing run (demo app variant b); bundle export
 * and import with an integrity check; the accessibility engine in light and dark.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdirSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '../../src/browser/index.js';
import { startDemoApp, DEMO_TOTP_SECRET, type DemoServer } from '../../examples/demo-app/server.js';
import { readZip, writeZip } from '../../src/runner/index.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { copyShopProject, SHOP_ENV_KEYS } from './helpers.js';
import { expectNoSeriousA11y } from '../a11y/assert.js';

const SHOTS = process.env.EZ_STUDIO_SHOTS;

let app: DemoServer;
let appB: DemoServer;
let studio: StudioHandle;
let project: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];
const saved: Record<string, string | undefined> = {};

const SIGNIN = `Journey: Sign in as bob
Id: signin
Tags: @debug

Open /login
Type "bob" into the Username field
Type "Builder#2" into the Password field
Click the "Sign in" button
Expect the URL contains "/dashboard"
`;

const LOOP = `Journey: Loop and branch
Id: loop-branch

Open /login
Repeat 2 times
  Type "bob" into the Username field
End
If the page contains "Sign in to EZ Shop" then
  Type "Builder#2" into the Password field
End
Click the "Sign in" button
Expect the URL contains "/dashboard"
`;

const BROKEN = `Journey: Broken welcome check
Id: broken-check

Open /login
Type "bob" into the Username field
Type "Builder#2" into the Password field
Click the "Sign in" button
Open "/dashboard"
Expect the page to contain "Welcome, zed"
`;


const checkA11y = (p: Page, label: string) => expectNoSeriousA11y(p, label);

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-eztest-token': studio.token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};

/** Run journeys through the Run API and wait for the run to finish. */
async function runJourney(id: string): Promise<{ runId: string; status: string }> {
  const r = await api('POST', '/api/runs', { journeys: [id] });
  expect(r.status).toBe(202);
  for (let i = 0; i < 400; i++) {
    const d = await api('GET', `/api/runs/${r.json.id}`);
    if (d.json.run) return { runId: r.json.id, status: d.json.run.journeys[0].status };
    await new Promise((x) => setTimeout(x, 300));
  }
  throw new Error('run did not finish');
}

/** Click the breakpoint gutter next to a 1-based line of a CodeMirror editor. */
async function clickGutter(editor: string, line: number): Promise<void> {
  const lineBox = (await page.locator(`${editor} .cm-line`).nth(line - 1).boundingBox())!;
  const gutter = (await page.locator(`${editor} .cm-bp-gutter`).boundingBox())!;
  await page.mouse.click(gutter.x + gutter.width / 2, lineBox.y + Math.min(10, lineBox.height / 2));
}

const editorText = (sel: string) => page.locator(`${sel} .cm-line`).allTextContents().then((l) => l.join('\n'));
const dbgState = () => page.locator('#dbg-status').getAttribute('data-state');

async function shot(name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  // Screenshots for documentation are taken in dark mode.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, name) });
  await page.emulateMedia({ colorScheme: 'light' });
}

beforeAll(async () => {
  project = await copyShopProject();
  await appendFile(join(project, 'eztest.config.yaml'), '\ntrace:\n  timeTravel:\n    enabled: true\ntimeouts:\n  step: 4000\n');
  await writeFile(join(project, 'journeys', 'signin.ez'), SIGNIN);
  await writeFile(join(project, 'journeys', 'broken.ez'), BROKEN);
  await writeFile(join(project, 'journeys', 'loop.ez'), LOOP);
  app = await startDemoApp({ dbFile: join(project, 'shop.db') });
  appB = await startDemoApp({ dbFile: join(project, 'shop-b.db'), variant: 'b' });
  const env: Record<string, string> = {
    SHOP_URL: app.url,
    SHOP_DB: join(project, 'shop.db'),
    SHOP_ALICE_PASSWORD: 'Wonderland#1',
    SHOP_ALICE_TOTP: DEMO_TOTP_SECRET,
    SHOP_BOB_PASSWORD: 'Builder#2',
    SHOP_API_CLIENT_SECRET: 'ez-client-secret',
  };
  for (const k of SHOP_ENV_KEYS) {
    saved[k] = process.env[k];
    process.env[k] = env[k];
  }
  studio = await startStudio({ cwd: project, recordHeadless: true });
  browser = await chromium.launch();
  // No bypassCSP: EZTest's accessibility engine runs through the driver, under the page's real CSP.
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(studio.url);
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  await app?.close();
  await appB?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('Studio debugger (Chromium)', { timeout: 180_000 }, () => {
  it('sets a gutter breakpoint in the Journeys editor, F5 starts debugging, pauses there and streams the live view', async () => {
    await page.goto(`${studio.origin}/#/journeys/journeys/signin.ez`);
    await expect.poll(() => editorText('#editor-host')).toContain('Click the "Sign in" button');
    await clickGutter('#editor-host', 8);
    await expect.poll(() => page.locator('#editor-host .cm-bp-gutter .bp-dot').count()).toBe(1);
    // A click next to a non-step line does nothing.
    await clickGutter('#editor-host', 2);
    expect(await page.locator('#editor-host .cm-bp-gutter .bp-dot').count()).toBe(1);

    await page.locator('#editor-host .cm-content').click();
    await page.keyboard.press('F5');
    await expect.poll(() => page.url()).toContain('#/debug/journeys/signin.ez');
    await expect.poll(dbgState, { timeout: 60_000 }).toBe('paused');
    await expect.poll(() => page.locator('#dbg-status').textContent()).toMatch(/Paused before step 4 \(breakpoint\)/);
    // The breakpoint is shown in the debugger's own editor and the current step is highlighted there and in the outline.
    await expect.poll(() => page.locator('.dbg-editor .cm-bp-gutter .bp-dot').count()).toBe(1);
    await expect.poll(() => page.locator('.dbg-editor [data-debug-current="paused"]').textContent()).toBe('Click the "Sign in" button');
    expect(await page.locator('.dbg-step.current').textContent()).toMatch(/Click the "Sign in" button/);
    expect(await page.locator('.dbg-step').evaluateAll((els) => els.map((e) => e.getAttribute('data-status')))).toEqual(['passed', 'passed', 'passed', 'pending']);
    // Frames arrive on the canvas.
    await expect.poll(async () => Number(await page.locator('.lv-canvas').getAttribute('data-frames')), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(() => page.locator('#lv-fps').textContent()).toMatch(/fps/);
    // The breakpoints panel lists it, with its hit count.
    await page.getByRole('tab', { name: 'Breakpoints' }).click();
    await expect.poll(() => page.locator('#dbg-bp-list').textContent()).toMatch(/Step 4: Click the "Sign in" button.*hit 1×/);
    await checkA11y(page, 'debugger-paused');
  });

  it('inspects the live page: ranked locator candidates, insert as step, validate a locator, run a line in the step console', async () => {
    const ctl = studio.app.debug!.current!.controller;
    const target = (await ctl.page!.locator('#username').boundingBox())!;
    const canvas = page.locator('.lv-canvas');
    const at = async () => {
      const r = (await canvas.boundingBox())!;
      const dw = Number(await canvas.getAttribute('data-device-width'));
      const dh = Number(await canvas.getAttribute('data-device-height'));
      return { x: ((target.x + 6) / dw) * r.width, y: ((target.y + 6) / dh) * r.height };
    };
    await page.keyboard.press('Alt+i');
    await expect.poll(() => page.locator('#dbg-inspect').getAttribute('aria-pressed')).toBe('true');
    await canvas.hover({ position: await at() });
    await expect.poll(() => page.locator('.lv-box.hover .lv-box-label').textContent()).toMatch(/input#username/);
    await canvas.click({ position: await at() });
    const cands = page.locator('#lv-picks .cand');
    await expect.poll(() => cands.count(), { timeout: 20_000 }).toBeGreaterThan(2);
    const first = await cands.first().textContent();
    expect(first).toMatch(/testid=username/);
    expect(first).toMatch(/unique/);
    expect(first).toMatch(/100%/);
    expect(await cands.last().textContent()).toMatch(/xpath=/);
    const phrase = (await cands.nth(1).locator('.cand-phrase').textContent())!;
    expect(phrase).toMatch(/^Type "…" into the "Username" field$/);
    await cands.nth(1).getByRole('button', { name: /Insert as step/ }).click();
    await expect.poll(() => editorText('.dbg-editor')).toContain(phrase);
    await expect.poll(() => page.locator('#dbg-save').isDisabled()).toBe(false);
    await checkA11y(page, 'debugger-picker');
    // Undo the insertion (it was never saved).
    await page.locator('.dbg-editor .cm-content').click();
    await page.keyboard.press('Control+z');
    await expect.poll(() => editorText('.dbg-editor')).not.toContain(phrase);

    // Validate a locator: matches are counted (and outlined).
    await page.getByLabel('Validate locator').fill('the "Sign in" button');
    await expect.poll(() => page.locator('#lv-valcount').textContent()).toBe('1 match (unique)');
    await expect.poll(() => page.locator('.lv-box.validate').count()).toBe(1);
    await page.getByLabel('Validate locator').fill('testid=nothing-here');
    await expect.poll(() => page.locator('#lv-valcount').textContent()).toBe('0 matches');

    // Step console with autocomplete from the grammar; the step runs against the live page.
    await page.locator('.repl-input .cm-content').click();
    await page.keyboard.type('Verify the page con');
    await expect.poll(() => page.locator('.cm-tooltip-autocomplete').isVisible()).toBe(true);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+a');
    await page.keyboard.insertText('Verify the page contains "Sign in to EZ Shop"');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#repl-log .repl-entry').last().textContent(), { timeout: 20_000 }).toMatch(/Passed.*Verify the page contains "Sign in to EZ Shop"/);
    await page.locator('.repl-input .cm-content').click();
    await page.keyboard.insertText('Verify the page contains "Nope, not here"');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#repl-log .repl-entry').last().textContent(), { timeout: 30_000 }).toMatch(/Failed/);

    // Variables and call stack while paused.
    await page.getByRole('tab', { name: 'Stack' }).click();
    expect(await page.locator('.call-stack').textContent()).toMatch(/Step 4 \(before step\).*Step 3.*Sign in as bob/);
    // Each step that ran is listed once (a pause before a step used to add it a second time).
    const frames = await page.locator('.call-stack .cs-label').allTextContents();
    expect(frames.slice(0, 4)).toEqual(['Step 4 (before step)', 'Step 3', 'Step 2', 'Step 1']);
    expect(new Set(frames).size).toBe(frames.length);
    await shot('debugger-paused.png');

    // Continue (F8) finishes the run.
    await page.keyboard.press('F8');
    await expect.poll(dbgState, { timeout: 60_000 }).toBe('done');
    expect(await page.locator('#dbg-status').textContent()).toMatch(/Finished: passed/);
    expect(await page.locator('.dbg-step').evaluateAll((els) => els.map((e) => e.getAttribute('data-status')))).toEqual(['passed', 'passed', 'passed', 'passed']);
    // Step details of the clicked step: resolved locator and candidates tried.
    await page.getByRole('tab', { name: 'Step' }).click();
    await expect.poll(() => page.locator('#dbg-step-details').textContent()).toMatch(/Resolved locator.*role=button "Sign in".*Candidates tried.*1 \(unique\).*URL contains "\/dashboard"/);
  });

  it('pauses on a failure, edits the step and applies the fix to the file, then retries to a pass', async () => {
    await page.locator('#dbg-journey').selectOption('journeys/broken.ez');
    await expect.poll(() => editorText('.dbg-editor')).toContain('Welcome, zed');
    await page.locator('.dbg-editor .cm-content').click();
    await page.keyboard.press('F5');
    // No breakpoints here: it stops before the first step.
    await expect.poll(dbgState, { timeout: 60_000 }).toBe('paused');
    expect(await page.locator('#dbg-status').textContent()).toMatch(/Paused before step 1/);
    await page.locator('#dbg-start').click();
    await expect.poll(() => page.locator('#dbg-status').getAttribute('data-tone'), { timeout: 90_000 }).toBe('failed');
    expect(await page.locator('#dbg-status').textContent()).toMatch(/Paused on failure at step 5/);
    const panel = page.locator('#edit-continue');
    await expect.poll(() => panel.isVisible()).toBe(true);
    expect(await panel.locator('.ec-error').textContent()).toMatch(/Welcome, zed/);
    await expect.poll(() => panel.locator('.ec-editor .cm-content').textContent()).toMatch(/Open "\/dashboard".*Expect the page to contain "Welcome, zed"/);
    expect(await page.locator('.dbg-editor [data-debug-current="failed"]').textContent()).toBe('Open "/dashboard"');
    await checkA11y(page, 'debugger-failed');
    await shot('debugger-edit-continue.png');

    // A broken edit is refused with the parser's message.
    await panel.locator('.ec-editor .cm-content').click();
    await page.keyboard.press('Control+a');
    await page.keyboard.insertText('Opne the dashbord');
    await expect.poll(() => page.locator('#ec-status').textContent()).toMatch(/✖/);
    expect(await page.locator('#ec-apply').isDisabled()).toBe(true);
    await page.keyboard.press('Control+a');
    await page.keyboard.insertText('Open "/dashboard"\n  Expect the page to contain "Welcome, bob"');
    await expect.poll(() => page.locator('#ec-status').textContent()).toMatch(/Valid step/);
    await page.locator('#ec-apply').click();
    await expect.poll(() => readFile(join(project, 'journeys', 'broken.ez'), 'utf8')).toContain('Expect the page to contain "Welcome, bob"');
    const onDisk = await readFile(join(project, 'journeys', 'broken.ez'), 'utf8');
    expect(onDisk).not.toContain('zed');
    // Everything else stays byte for byte.
    const norm = (t: string) => t.split('\n').map((l) => l.trim()).join('\n');
    expect(norm(onDisk)).toBe(norm(BROKEN.replace('Welcome, zed', 'Welcome, bob')));
    await expect.poll(() => page.locator('#ec-status').textContent()).toMatch(/Applied to the journey file/);
    await page.locator('#ec-retry').click();
    await expect.poll(dbgState, { timeout: 60_000 }).toBe('done');
    expect(await page.locator('#dbg-status').textContent()).toMatch(/Finished: passed/);
    // The fixed journey passes in a normal run too.
    expect((await runJourney('broken-check')).status).toBe('passed');
  });
});

describe('Studio debugger: nested blocks (Chromium)', { timeout: 180_000 }, () => {
  it('pauses on a breakpoint inside a loop in every iteration, with the outline, highlight and call stack following the nesting', async () => {
    await page.goto(`${studio.origin}/#/debug/journeys/loop.ez`);
    await expect.poll(() => editorText('.dbg-editor'), { timeout: 20_000 }).toContain('Repeat 2 times');
    await expect.poll(() => page.locator('.dbg-step.nested').count()).toBe(2);
    expect(await page.locator('.dbg-step.block').count()).toBe(2);
    // A breakpoint on the nested step; "End" lines are not steps.
    await clickGutter('.dbg-editor', 6);
    await expect.poll(() => page.locator('.dbg-editor .cm-bp-gutter .bp-dot').count()).toBe(1);
    await clickGutter('.dbg-editor', 7);
    expect(await page.locator('.dbg-editor .cm-bp-gutter .bp-dot').count()).toBe(1);
    await page.locator('.dbg-editor .cm-content').click();
    await page.keyboard.press('F5');
    await expect.poll(dbgState, { timeout: 60_000 }).toBe('paused');
    await expect.poll(() => page.locator('#dbg-status').textContent()).toMatch(/Paused before nested step "Type "bob" into the Username field" \(breakpoint\)/);
    await expect.poll(() => page.locator('.dbg-editor [data-debug-current="paused"]').textContent()).toBe('  Type "bob" into the Username field');
    const row = page.locator('.dbg-step[data-id="type-bob-into-the-username-field"]');
    await expect.poll(() => row.getAttribute('class')).toMatch(/\bcurrent\b/);
    await page.getByRole('tab', { name: 'Stack' }).click();
    await expect.poll(() => page.locator('.call-stack').textContent()).toMatch(/Nested step \(before step\).*in block.*Repeat 2 times.*Step 1/);
    await checkA11y(page, 'debugger-nested');
    // Continue: the second iteration stops at the same breakpoint.
    await page.keyboard.press('F8');
    await expect.poll(() => row.locator('.pill-run').textContent(), { timeout: 30_000 }).toBe('×2');
    await expect.poll(dbgState).toBe('paused');
    // Remove the breakpoint and finish.
    await clickGutter('.dbg-editor', 6);
    await expect.poll(() => page.locator('.dbg-editor .cm-bp-gutter .bp-dot').count()).toBe(0);
    await page.keyboard.press('F8');
    await expect.poll(dbgState, { timeout: 60_000 }).toBe('done');
    expect(await page.locator('#dbg-status').textContent()).toMatch(/Finished: passed/);
    expect(await page.locator('.dbg-step').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-id')}:${e.getAttribute('data-status')}`))).toEqual([
      'open-login:passed',
      'repeat-2-times:passed',
      'type-bob-into-the-username-field:passed',
      'if-the-page-contains-sign-in-to-ez-shop-then:passed',
      'type-builder-2-into-the-password-field:passed',
      'click-the-sign-in-button:passed',
    ]);
  });

  it('shows loop iterations and block nesting in the trace', async () => {
    const r = await runJourney('loop-branch');
    expect(r.status).toBe('passed');
    await page.goto(`${studio.origin}/#/trace/run/${r.runId}/loop-branch/1`);
    const view = page.locator('.page-trace');
    await expect.poll(() => view.locator('.film-item').count(), { timeout: 20_000 }).toBe(5);
    await expect.poll(() => view.locator('.film-item.nested').count()).toBe(3);
    expect(await view.locator('.film-item').nth(2).locator('.film-label').textContent()).toMatch(/in Repeat 2 times · iteration 2/);
    expect(await view.locator('.trace-steps .vt-spacer .vt-row').nth(2).textContent()).toMatch(/#2.*Type "bob"/);
    await view.locator('.film-item').nth(3).click();
    await view.getByRole('tab', { name: 'Action' }).click();
    await expect.poll(() => view.locator('.trace-tab-body').first().textContent()).toMatch(/Nesting.*in If the page contains "Sign in to EZ Shop" then/);
  });
});

describe('Studio trace viewer (Chromium)', { timeout: 180_000 }, () => {
  let runA: string;
  let runB: string;

  it('opens the Trace tab from a deep link: filmstrip, keyboard navigation, before/after in a sandboxed iframe, network', async () => {
    runA = (await runJourney('signin')).runId;
    process.env.SHOP_URL = appB.url;
    try {
      const b = await runJourney('signin');
      runB = b.runId;
      expect(b.status).toBe('passed-healed');
    } finally {
      process.env.SHOP_URL = app.url;
    }
    await page.goto(`${studio.origin}/#/runs/${runB}/signin/click-the-sign-in-button/trace`);
    const tab = page.locator('#run-detail');
    await expect.poll(() => tab.getByRole('tab', { name: 'Trace' }).getAttribute('aria-selected'), { timeout: 20_000 }).toBe('true');
    const film = tab.locator('.film-item');
    await expect.poll(() => film.count(), { timeout: 20_000 }).toBe(4);
    await expect.poll(() => tab.locator('.film-item[aria-selected="true"]').getAttribute('data-pos')).toBe('3');
    expect(await film.nth(3).locator('.film-label').textContent()).toMatch(/Step 4: Click the "Sign in" button, passed-healed, .*healed/);
    // Images are the trace's own viewport JPEGs.
    await expect.poll(() => film.nth(0).locator('img').evaluate((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0)).toBe(true);
    // Arrow keys move along the filmstrip.
    await tab.locator('.filmstrip').focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => tab.locator('.film-item[aria-selected="true"]').getAttribute('data-pos')).toBe('2');
    await page.keyboard.press('Home');
    await expect.poll(() => tab.locator('.film-item[aria-selected="true"]').getAttribute('data-pos')).toBe('0');
    // The step list follows.
    await expect.poll(() => tab.locator('.trace-steps .vt-row.selected').textContent()).toMatch(/Open \/login/);

    // Before / after snapshots: sandboxed, no scripts, served with their own CSP.
    const iframe = tab.locator('.snap-iframe').first();
    await expect.poll(() => iframe.getAttribute('src')).toMatch(/\/steps\/0\/before$/);
    expect(await iframe.getAttribute('sandbox')).toBe('');
    await tab.locator('.snap-after').click();
    await expect.poll(() => tab.locator('.snap-iframe').first().getAttribute('src')).toMatch(/\/steps\/0\/after$/);
    await expect.poll(async () => {
      const f = page.frames().find((x) => x.url().endsWith('/steps/0/after'));
      return f ? f.content() : '';
    }).toContain('Sign in to EZ Shop');
    const res = await page.request.get(`${studio.origin}/api/runs/${runB}/traces/signin/1/steps/0/after`, { headers: { 'x-eztest-token': studio.token } });
    expect(res.headers()['content-security-policy']).toMatch(/^sandbox; default-src 'none'/);
    // Side by side shows both.
    await tab.locator('.dbg-btn-side').click();
    await expect.poll(() => tab.locator('.snap-iframe').count()).toBe(2);
    await tab.locator('.dbg-btn-side').click();

    // Network of the first step: the document request, with headers.
    await tab.getByRole('tab', { name: /Network/ }).click();
    const rows = tab.locator('.trace-details .vt-spacer .vt-row');
    await expect.poll(() => rows.count()).toBeGreaterThan(0);
    expect(await rows.first().textContent()).toMatch(/GET.*200.*\/login/);
    await rows.first().click();
    await expect.poll(() => tab.locator('.trace-details .net-detail').textContent()).toMatch(/Response headers.*content-type/i);
    // Action tab of the healed step: tried candidates and the heal ladder.
    await film.nth(3).click();
    await tab.getByRole('tab', { name: 'Action' }).click();
    await expect.poll(() => tab.locator('.trace-tab-body').first().textContent()).toMatch(/Candidates tried.*role=button "Sign in".*0.*Heal ladder.*T1-fingerprint/);
    await checkA11y(page, 'trace-tab');
  });

  it('compares with the last passing run: first divergence, locator change and the step side by side', async () => {
    const tab = page.locator('#run-detail');
    await tab.locator('.dbg-btn-compare').click();
    const callout = tab.locator('.cmp-callout .callout');
    await expect.poll(() => callout.textContent(), { timeout: 20_000 }).toMatch(/First divergence at step \d/);
    expect(await tab.locator('.compare select').evaluate((s) => (s as HTMLSelectElement).selectedOptions[0].textContent)).toMatch(new RegExp(`Last passing · ${runA}`));
    const rows = tab.locator('.compare .vt-spacer .vt-row');
    await expect.poll(() => rows.count()).toBe(4);
    expect(await rows.nth(3).textContent()).toMatch(/Click the "Sign in" button.*locator role=button "Sign in" -> role=button "Log in"/);
    await rows.nth(3).click();
    await expect.poll(() => tab.locator('.cmp-detail').textContent()).toMatch(/Locator.*role=button "Sign in".*role=button "Log in"/);
    await expect.poll(() => tab.locator('.cmp-detail .snap-iframe').count()).toBe(2);
    expect(await tab.locator('.cmp-detail .text-diff').textContent()).toMatch(/Sign.*Log/);
    await checkA11y(page, 'trace-compare');
    // Jump to the diverging step.
    await tab.getByRole('button', { name: 'Show this step' }).click();
    await expect.poll(() => tab.locator('.trace-main').isVisible()).toBe(true);
  });

  it('exports a trace bundle and imports it again, verifying its integrity (and flags a tampered one)', async () => {
    const href = await page.locator('#run-detail .trace-export').getAttribute('href');
    expect(href).toBe(`/api/runs/${runB}/traces/signin/1/bundle`);
    const download = await Promise.all([page.waitForEvent('download'), page.locator('#run-detail .trace-export').click()]).then(([d]) => d);
    expect(download.suggestedFilename()).toBe('signin-1.eztrace.zip');
    const bundle = await readFile((await download.path())!);
    expect(readZip(bundle).has('bundle.json')).toBe(true);

    const upload = async (name: string, buffer: Buffer) => {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Alt+o')]);
      await chooser.setFiles({ name, mimeType: 'application/zip', buffer });
    };
    await upload('signin.eztrace.zip', bundle);
    await expect.poll(() => page.url()).toMatch(/#\/trace\/uploaded\/up-\d+$/);
    const view = page.locator('.page-trace');
    await expect.poll(() => view.locator('.trace-meta').textContent(), { timeout: 20_000 }).toMatch(/Integrity verified/);
    await expect.poll(() => view.locator('.film-item').count()).toBe(4);
    await expect.poll(() => view.locator('.snap-iframe').first().getAttribute('src')).toMatch(/^\/api\/traces\/uploaded\/up-\d+\/steps\/\d\/before$/);
    await view.getByRole('tab', { name: 'Evidence' }).click();
    await expect.poll(() => view.locator('.trace-tab-body').last().textContent()).toMatch(/Bundle integrity verified/);
    await checkA11y(page, 'trace-uploaded');

    // Tamper with one snapshot: the bundle still opens, with the problem shown.
    const files = readZip(bundle);
    const victim = [...files.keys()].find((k) => k.includes('/snapshots/'))!;
    const altered = writeZip([...files.entries()].map(([name, data]) => ({ name, data: name === victim ? Buffer.concat([data, Buffer.from('x')]) : data })));
    await upload('tampered.eztrace.zip', altered);
    await expect.poll(() => view.locator('.trace-meta').textContent(), { timeout: 20_000 }).toMatch(/1 integrity problem/);
    expect(await view.locator('.callout-warn').textContent()).toContain(`altered ${victim}`);
  });

  it('picks an element in a static snapshot and ranks locators against it', async () => {
    await page.goto(`${studio.origin}/#/trace/run/${runA}/signin/1/click-the-sign-in-button`);
    const view = page.locator('.page-trace');
    await expect.poll(() => view.locator('.film-item').count(), { timeout: 20_000 }).toBe(4);
    await page.keyboard.press('p');
    const surface = view.locator('.snap-pick-surface');
    await expect.poll(() => surface.isVisible(), { timeout: 30_000 }).toBe(true);
    // The target of this step (the Sign in button) is outlined; click on it.
    const target = view.locator('.snap-pick-overlay .lv-box.target');
    await expect.poll(() => target.count()).toBe(1);
    const tb = (await target.boundingBox())!;
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await expect.poll(() => view.locator('.snap-pick-overlay .lv-box.hover .lv-box-label').textContent()).toMatch(/button/);
    await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await expect.poll(() => view.locator('.snap-picks .cand').count(), { timeout: 20_000 }).toBeGreaterThan(1);
    expect(await view.locator('.snap-picks .cand-phrase').first().textContent()).toMatch(/Click (the "Sign in" button|testid=login-btn|css=#login-btn)/);
    expect(await view.locator('.snap-picks').textContent()).toMatch(/counted against this snapshot/);
  });

  it('has no serious accessibility violations on the debugger and the trace viewer, light and dark', async () => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`${studio.origin}/#/debug/journeys/signin.ez`);
      await expect.poll(() => editorText('.dbg-editor'), { timeout: 20_000 }).toContain('Sign in');
      await checkA11y(page, `debugger-${scheme}`);
      await page.goto(`${studio.origin}/#/trace/run/${runB}/signin/1/click-the-sign-in-button`);
      await expect.poll(() => page.locator('.page-trace .film-item').count(), { timeout: 20_000 }).toBe(4);
      await checkA11y(page, `trace-${scheme}`);
      if (scheme === 'dark') {
        await shot('trace-viewer.png');
        await page.locator('.page-trace .dbg-btn-compare').click();
        await expect.poll(() => page.locator('.page-trace .cmp-callout .callout').count(), { timeout: 20_000 }).toBe(1);
        await expect.poll(() => page.locator('.page-trace .cmp-detail .snap-iframe').count()).toBe(2);
        await checkA11y(page, 'trace-compare-dark');
        await shot('trace-compare.png');
      }
      await page.goto(`${studio.origin}/#/trace`);
      await expect.poll(() => page.locator('.trace-recent-item').count(), { timeout: 20_000 }).toBeGreaterThan(0);
      await checkA11y(page, `trace-landing-${scheme}`);
    }
    await page.emulateMedia({ colorScheme: 'light' });
    expect(pageErrors).toEqual([]);
  });

  it('runs the debugger and trace pages under the real CSP without violations', async () => {
    const strict = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await strict.newPage();
    const problems: string[] = [];
    p.on('console', (m) => {
      if (m.type() === 'error' || /Content Security Policy/.test(m.text())) problems.push(m.text());
    });
    p.on('pageerror', (e) => problems.push(e.message));
    await p.goto(studio.url);
    await expect.poll(() => p.getByRole('heading', { name: 'Dashboard' }).isVisible()).toBe(true);
    await p.goto(`${studio.origin}/#/debug/journeys/signin.ez`);
    await expect.poll(() => p.locator('.dbg-editor .cm-line').count()).toBeGreaterThan(3);
    await p.goto(`${studio.origin}/#/trace/run/${runB}/signin/1`);
    await expect.poll(async () => ((await p.locator('.page-trace .film-item').count()) === 4 ? 4 : `${p.url()} ${await p.locator('.page:not([hidden])').first().innerText().catch(() => '')}`.slice(0, 400)), { timeout: 20_000 }).toBe(4);
    // The snapshot frame is allowed by the page CSP (frame-src 'self') and renders.
    await expect.poll(async () => {
      const f = p.frames().find((x) => /\/steps\/\d\/(before|after)$/.test(x.url()));
      return f ? f.content() : `frames: ${p.frames().map((x) => x.url()).join(' ')} problems: ${problems.join(' | ')}`;
    }).toMatch(/EZ Shop/);
    await strict.close();
    expect(problems).toEqual([]);
  });
});
