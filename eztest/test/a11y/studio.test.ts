/**
 * Regression: every Studio view passes EZTest's accessibility engine at
 * WCAG 2.2 AA (plus best practices) in light and dark, including the
 * dynamic checks: a keyboard walk (traps, visible focus, invisible or
 * covered tab stops), reflow at 320 CSS px and WCAG 1.4.12 text spacing.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { copyShopProject, SHOP_ENV_KEYS } from '../studio/helpers.js';
import { expectNoSeriousA11y } from './assert.js';

const ROUTES = [
  '', '#/journeys', '#/run', '#/runs', '#/insights', '#/record', '#/import', '#/settings', '#/workbench', '#/debug', '#/scm', '#/contracts',
  '#/assurance/documents', '#/assurance/compare', '#/assurance/visual', '#/assurance/a11y', '#/assurance/security',
  '#/project/environments', '#/project/identity', '#/project/data', '#/project/mocks', '#/project/monitors', '#/project/perf', '#/project/compliance',
  '#/quality/heals', '#/quality/triage', '#/quality/flaky', '#/quality/readiness', '#/quality/traceability', '#/quality/compare', '#/quality/trends',
];

let app: DemoServer;
let studio: StudioHandle;
let browser: Browser;
let page: Page;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  const project = await copyShopProject();
  app = await startDemoApp({ dbFile: join(project, 'shop.db') });
  const env: Record<string, string> = { SHOP_URL: app.url, SHOP_DB: join(project, 'shop.db') };
  for (const k of SHOP_ENV_KEYS) {
    saved[k] = process.env[k];
    if (env[k] !== undefined) process.env[k] = env[k];
  }
  studio = await startStudio({ cwd: project, recordHeadless: true });
  browser = await chromium.launch();
  // The real CSP: the engine runs through the driver, nothing is injected.
  page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
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

describe('Studio at WCAG 2.2 AA with the dynamic checks', () => {
  for (const scheme of ['light', 'dark'] as const) {
    it(`has no serious violations on any view (${scheme})`, async () => {
      await page.emulateMedia({ colorScheme: scheme });
      const base = studio.url.split('#')[0];
      for (const route of ROUTES) {
        await page.goto(base + route);
        await expect.poll(() => page.locator('h1').count(), { timeout: 20_000 }).toBeGreaterThan(0);
        await expect.poll(() => page.locator('[aria-busy="true"]').count(), { timeout: 30_000 }).toBe(0);
        const r = await expectNoSeriousA11y(page, `${route || '#/'}-${scheme}`, undefined, { dynamic: true });
        expect(r.rules).toEqual(expect.arrayContaining(['keyboard.trap', 'focus.visible', 'layout.reflow', 'text.spacing', 'target.size']));
      }
    }, 300_000);
  }
});
