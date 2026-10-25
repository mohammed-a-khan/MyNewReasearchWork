/**
 * Code journeys (eztest/sdk) in the Studio: listing, TypeScript editing with
 * SDK autocomplete, syntax diagnostics, line breakpoints and step over in the
 * debugger (edit-and-continue is .ez only), runs, results and traceability.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { cp, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { SHOP_FIXTURE } from '../sdk/helpers.js';

let project: string;
let app: DemoServer;
let studio: StudioHandle;
let browser: Browser;
let page: Page;
const saved: Record<string, string | undefined> = {};
const pageErrors: string[] = [];

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-eztest-token': studio.token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};

const dbgState = () => page.locator('#dbg-status').getAttribute('data-state');

beforeAll(async () => {
  project = await mkdtemp(join(tmpdir(), 'eztest-studio-code-'));
  await cp(SHOP_FIXTURE, project, { recursive: true });
  app = await startDemoApp({ dbFile: join(project, 'shop.db') });
  for (const [k, v] of Object.entries({ SHOP_URL: app.url, SHOP_DB: join(project, 'shop.db') })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  studio = await startStudio({ cwd: project, recordHeadless: true });
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(studio.url);
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  await app?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('Studio: code journeys', { timeout: 180_000 }, () => {
  it('lists code journeys (without running them), opens, validates and saves TypeScript', async () => {
    const list = (await api('GET', '/api/journeys')).json.journeys as Array<{ path: string; format: string; code?: Array<{ id: string; line: number }> }>;
    const orders = list.find((j) => j.path === 'journeys/orders.journey.ts')!;
    expect(orders.format).toBe('ts');
    expect(orders.code!.map((c) => c.id)).toEqual(['orders-per-customer', 'soft-and-error', 'code-calls-ez', 'throws']);
    expect(list.find((j) => j.path === 'journeys/login-as.ez')?.format).toBe('ez');
    const f = await api('GET', `/api/file?path=${encodeURIComponent('journeys/orders.journey.ts')}`);
    expect(f.json.format).toBe('ts');
    const bad = await api('POST', '/api/validate', { content: "import { journey } from 'eztest/sdk';\njourney('x', async () => {\n  await ui.click(;\n});\n", format: 'ts' });
    expect(bad.json.ok).toBe(false);
    expect(bad.json.errors[0].line).toBe(3);
    const created = await api('POST', '/api/journeys', { path: 'journeys/new-flow.journey.ts', name: 'New flow' });
    expect(created.status).toBe(201);
    expect(created.json.content).toContain("journey('New flow'");
    expect((await api('PUT', '/api/file', { path: 'steps/extra.steps.ts', content: 'export const x = 1;\n' })).status).toBe(200);
    expect((await api('PUT', '/api/file', { path: 'src/evil.ts', content: 'x' })).status).toBe(403);
    expect((await api('POST', '/api/convert', { content: f.json.content, from: 'ts', to: 'ez' })).status).toBe(422);
  });

  it('editor: TypeScript highlighting and SDK autocomplete after "ui."', async () => {
    await page.goto(`${studio.origin}/#/journeys/journeys/new-flow.journey.ts`);
    await page.locator('.cm-content').first().waitFor();
    await expect.poll(() => page.locator('.cm-content .tok-keyword').count(), { timeout: 20_000 }).toBeGreaterThan(0);
    const line = page.locator('.cm-line').nth(4);
    await line.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('    await ui.cl');
    await expect.poll(() => page.locator('.cm-tooltip-autocomplete li').allTextContents(), { timeout: 10_000 }).toEqual(expect.arrayContaining([expect.stringContaining('click')]));
    await page.keyboard.press('Escape');
    // The outline lists the SDK call lines.
    expect(pageErrors).toEqual([]);
  });

  it('debugger: a gutter breakpoint on a ui.* line pauses there, F10 steps to the next SDK call, edit-and-continue is .ez only', async () => {
    const text = await readFile(join(project, 'journeys', 'orders.journey.ts'), 'utf8');
    const lines = text.split('\n');
    const fillLine = lines.findIndex((l) => l.includes("ui.fill(Login.username, 'bob')")) + 1;
    await page.goto(`${studio.origin}/#/debug/journeys/orders.journey.ts`);
    await expect.poll(() => page.locator('.dbg-editor .cm-line').count(), { timeout: 20_000 }).toBeGreaterThan(10);
    await expect.poll(() => page.locator('.dbg-step').count()).toBeGreaterThan(5);
    // The outline lists the SDK call lines; F9 toggles a breakpoint on the step at the cursor.
    const toggleAt = async (line: number) => {
      await page.locator(`.dbg-step[data-id="L${line}"] .dbg-step-btn`).click();
      await page.keyboard.press('F9');
    };
    await toggleAt(fillLine);
    await expect.poll(() => page.locator('.dbg-editor .cm-bp-gutter .bp-dot').count()).toBe(1);
    expect((await page.evaluate(() => localStorage.getItem('ez-debug-breakpoints'))) ?? '').toContain(`"line":${fillLine}`);
    await page.keyboard.press('F5');
    await expect.poll(dbgState, { timeout: 60_000 }).toBe('paused');
    await expect.poll(() => page.locator('.dbg-editor [data-debug-current="paused"]').textContent()).toContain("ui.fill(Login.username, 'bob')");
    const s = (await api('GET', '/api/debug/session')).json;
    expect(s.debug).toMatchObject({ journeyId: 'orders-per-customer', source: { line: fillLine }, code: { name: 'Order for every EU customer' } });
    // Edit-and-continue is refused for code journeys.
    expect((await api('POST', '/api/debug/edit', { step: 'Click the "Sign in" button' })).status).toBe(409);
    await page.keyboard.press('F10');
    await expect.poll(() => page.locator('.dbg-editor [data-debug-current="paused"]').textContent(), { timeout: 30_000 }).toContain("ui.fill(Login.password");
    await toggleAt(fillLine);
    await expect.poll(() => page.locator('.dbg-editor .cm-bp-gutter .bp-dot').count()).toBe(0);
    await page.keyboard.press('F8');
    await expect.poll(dbgState, { timeout: 90_000 }).toBe('done');
    expect(await page.locator('#dbg-status').textContent()).toMatch(/Finished: passed/);
    expect(await page.locator('.dbg-step.st-passed').count()).toBeGreaterThan(5);
  });

  it('runs code journeys from the Studio; they appear in results and traceability like any other', async () => {
    const r = await api('POST', '/api/runs', { journeys: ['code-calls-ez', 'ez-calls-code'] });
    expect(r.status).toBe(202);
    let run: any;
    for (let i = 0; i < 400 && !run; i++) {
      const d = await api('GET', `/api/runs/${r.json.id}`);
      run = d.json.run;
      if (!run) await new Promise((x) => setTimeout(x, 300));
    }
    expect(run.journeys.map((j: any) => [j.journeyId, j.status]).sort()).toEqual([['code-calls-ez', 'passed'], ['ez-calls-code', 'passed']]);
    const t = (await api('GET', '/api/quality/traceability')).json;
    expect(JSON.stringify(t)).toContain('REQ-SDK-1');
    await page.goto(`${studio.origin}/#/runs/${r.json.id}`);
    // A run opens on its report, embedded in the page.
    await expect.poll(async () => `${await page.locator('body').textContent()} ${await page.frameLocator('iframe').locator('body').textContent({ timeout: 2000 }).catch(() => '')}`, { timeout: 20_000 }).toContain('Interop: code calls .ez');
    expect(pageErrors).toEqual([]);
  });
});
