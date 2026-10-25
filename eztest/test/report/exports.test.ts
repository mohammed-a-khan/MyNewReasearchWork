/**
 * The report's run-level analysis and its file exports, checked as a reader
 * sees them: failure categories with suggested next steps, what needs
 * attention, the quality lenses and the masked configuration in the HTML
 * report (Chromium, light and dark, desktop and phone); the e-mail summary
 * (table layout, no script or SVG) in the browser; the PDF drawn by pdf.js in
 * the browser; the Excel workbook read back; and the e-mail publisher
 * delivering over SMTP with the PDF attached.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import {
  attentionOf, categoriseFailure, causeGroups, configSnapshot, emailSubject, maskConfigValue, readReportModel, renderEmailHtml, renderEmailText, renderReportPdf, summariseLenses, writeReports,
  type ReportModel,
} from '../../src/report/index.js';
import { buildMime, parseMime, sendSmtp, SmtpSink } from '../../src/messaging/index.js';
import { publishEmail } from '../../src/plugins/publishers/email.js';
import type { EvidenceRef } from '../../src/core/index.js';
import { makeRichFixture, type RichFixture } from './rich-fixture.js';
import { renderPdfInBrowser } from './pdf-view.js';
import { expectNoSeriousA11y } from '../a11y/assert.js';

let rich: RichFixture;
let browser: Browser;
let model: ReportModel;
let out: Awaited<ReturnType<typeof writeReports>>;

const CONFIG = {
  baseUrl: 'https://shop.example.test',
  identity: { roles: { admin: { username: 'ada', password: 'hunter2-plain', totp: 'secret://env/ADA_TOTP', api: { tokenUrl: '/api/token', clientSecret: 'cs-123456' } } } },
  db: { connections: { shop: { driver: 'postgres', url: 'postgres://app:pa55word@db.example.test:5432/shop' } } },
  publishers: [{ use: 'teams', webhook: 'https://contoso.webhook.office.com/abc' }, { use: 'email', host: 'smtp.example.test', password: 'smtp-pass' }],
  headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk' },
  healing: { enabled: true, maxTier: 'T2-semantic' },
};

/** Lens findings for a few steps, as the runner records them (lens-<name>-<step>.json). */
async function addLensEvidence(f: RichFixture): Promise<EvidenceRef[]> {
  const refs: EvidenceRef[] = [];
  const put = async (journeyId: string, stepId: string, lens: string, findings: unknown) => {
    const path = `journeys/${journeyId}/lens-${lens}-${stepId}.json`;
    await mkdir(join(f.runDir, 'journeys', journeyId), { recursive: true });
    await writeFile(join(f.runDir, path), JSON.stringify(findings));
    refs.push({ id: `E-L${refs.length + 1}`, kind: 'data', path, sha256: '0'.repeat(64), journeyId, stepId, description: `lens ${lens} findings`, createdAt: f.run.startedAt });
  };
  const a11y = (url: string, n: number) => [{ lens: 'a11y', severity: 'warning', message: 'a11y', details: { url, violations: [
    { ruleId: 'contrast.text', impact: 'serious', help: 'Text has enough contrast', helpUrl: 'https://example.test/contrast', sc: ['1.4.3'], nodeCount: n, nodes: [{ target: ['.price'] }] },
    { ruleId: 'name.button', impact: 'critical', help: 'Buttons have a name', sc: ['4.1.2'], nodeCount: 1, nodes: [{ target: ['#pay'] }] },
  ] } }];
  await put('checkout-card', 's1', 'a11y', a11y('https://shop.example.test/cart', 3));
  await put('checkout-guest', 's2', 'a11y', a11y('https://shop.example.test/checkout', 2));
  await put('api-customers', 's1', 'a11y', [{ lens: 'a11y', severity: 'info', message: 'blank', details: { url: 'about:blank', violations: [{ ruleId: 'page.title', impact: 'serious', help: 'title', sc: [], nodeCount: 1 }] } }]);
  await put('checkout-card', 's1', 'security', [{ lens: 'security', severity: 'info', message: 'sec', details: { url: 'https://shop.example.test/cart', findings: [{ id: 'csp-missing', severity: 'medium', message: 'Content-Security-Policy header is missing', url: 'https://shop.example.test/cart' }, { id: 'cookie-insecure', severity: 'high', message: 'Session cookie without Secure', url: 'https://shop.example.test/cart' }] } }]);
  await put('search-basic', 's1', 'perf', [{ lens: 'perf', severity: 'warning', message: 'perf', details: { budgets: { status: 'fail', items: [{ metric: 'LCP', status: 'fail', value: 4800, warn: 2500, error: 4000 }, { metric: 'CLS', status: 'pass', value: 0.02, warn: 0.1, error: 0.25 }] } } }]);
  return refs;
}

beforeAll(async () => {
  rich = await makeRichFixture();
  const lensRefs = await addLensEvidence(rich);
  out = await writeReports(rich.runDir, rich.run, { ...rich.insights, evidence: [...rich.evidence, ...lensRefs], config: CONFIG, formats: ['html', 'json', 'junit'] });
  model = (await readReportModel(rich.runDir))!;
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

async function open(file: string, o: { width?: number; scheme?: 'light' | 'dark'; hash?: string } = {}): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: o.width ?? 1400, height: 900 }, colorScheme: o.scheme ?? 'light' });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(pathToFileURL(file).href + (o.hash ?? ''));
  return { page, errors };
}

describe('failure categories', () => {
  it('puts each failure in one category with the rule that decided and a next step', () => {
    const c = (message: string, extra: Partial<Parameters<typeof categoriseFailure>[0]> = {}) => categoriseFailure({ state: 'failed', error: { message }, ...extra })!;
    expect(c('connect ECONNREFUSED 127.0.0.1:8080').c).toBe('environment');
    expect(c('page.goto: net::ERR_NAME_NOT_RESOLVED at https://x').c).toBe('environment');
    expect(c('SqliteError: UNIQUE constraint failed: customers.email').c).toBe('data');
    expect(c('no locator candidate matched exactly one element for the "Export" button').c).toBe('test');
    expect(c("locator.fill: Timeout 5000ms exceeded.\nwaiting for getByLabel('First name')").c).toBe('test');
    expect(c('post-condition failed: pageContainsText: page does not contain "Delivery date"').c).toBe('product');
    expect(c('API POST /api/orders returned 500').c).toBe('product');
    expect(c('lens security: lens failed: scanPageSecurity: page is not on an http(s) URL (about:blank)').c).toBe('test');
    expect(c('something odd happened').c).toBe('unknown');
    // A confident triage verdict decides; a weak one yields to a matching rule.
    expect(c('something odd happened', { triage: { category: 'environment', confidence: 0.8 } })).toMatchObject({ c: 'environment', src: 'triage' });
    expect(c('page does not contain "Total"', { triage: { category: 'test-issue', confidence: 0.2 } })).toMatchObject({ c: 'product', src: 'rule' });
    expect(categoriseFailure({ state: 'flaky', flakeReason: 'grid re-rendered' })).toMatchObject({ c: 'flaky' });
    expect(categoriseFailure({ state: 'passed' })).toBeUndefined();
    for (const x of [c('ECONNREFUSED'), c('UNIQUE constraint failed'), c('strict mode violation'), c('expected 2 to equal 3')]) expect(x.fix.length).toBeGreaterThan(40);
  });

  it('counts the run per category and tags each failure group and cluster with its suggested fix', () => {
    const failing = model.tests.filter((t) => t.state === 'failed' || t.state === 'error' || t.state === 'flaky');
    expect(failing.every((t) => t.cat)).toBe(true);
    expect(Object.values(model.categories ?? {}).reduce((n, x) => n + (x ?? 0), 0)).toBe(failing.length);
    expect(model.tests.find((t) => t.id === 'data-import')!.cat!.c).toBe('data');
    expect(model.failureGroups.every((g) => g.cat && g.fix)).toBe(true);
    expect(model.clusters.every((c) => c.cat && c.fix)).toBe(true);
    const a = attentionOf(model);
    expect(a.regressions.map((t) => t.id).sort()).toEqual(['account-profile', 'api-orders']);
    expect(a.fixed.map((t) => t.id)).toContain('search-sort');
    expect(a.flaky.map((t) => t.id)).toEqual(expect.arrayContaining(['checkout-split', 'search-sort']));
  });
});

describe('configuration snapshot', () => {
  it('flattens the effective configuration and masks secrets by key, in URLs and as tokens', () => {
    const rows = new Map(configSnapshot(CONFIG));
    expect(rows.get('baseUrl')).toBe('https://shop.example.test');
    expect(rows.get('identity.roles.admin.password')).toBe('****');
    expect(rows.get('identity.roles.admin.totp')).toBe('secret://env/ADA_TOTP');
    expect(rows.get('identity.roles.admin.api.tokenUrl')).toBe('/api/token');
    expect(rows.get('identity.roles.admin.api.clientSecret')).toBe('****');
    expect(rows.get('db.connections.shop.url')).toBe('postgres://app:****@db.example.test:5432/shop');
    expect(rows.get('publishers[0].webhook')).toBe('****');
    expect(rows.get('headers.Authorization')).toBe('****');
    expect(rows.get('healing.maxTier')).toBe('T2-semantic');
    expect(maskConfigValue('note', 'call with Bearer abcdefghijklmnop please')).toBe('call with **** please');
    expect(maskConfigValue('endpoint', 'https://x.test/hook?token=abc&x=1')).toBe('https://x.test/hook?token=****&x=1');
    const all = JSON.stringify(model.config);
    for (const s of ['hunter2-plain', 'cs-123456', 'pa55word', 'smtp-pass', 'webhook.office.com/abc', 'eyJhbGci']) expect(all).not.toContain(s);
  });
});

describe('quality lenses', () => {
  it('summarises accessibility by rule, security by finding and performance by metric, ignoring pages that are not web pages', () => {
    const q = model.lenses!;
    expect(q.a11y!.rules.map((r) => r.id)).toEqual(['name.button', 'contrast.text']);
    expect(q.a11y!.rules.find((r) => r.id === 'contrast.text')).toMatchObject({ nodes: 5, tests: ['checkout-card', 'checkout-guest'], pages: ['shop.example.test/cart', 'shop.example.test/checkout'] });
    expect(q.a11y!.counts).toMatchObject({ critical: 2, serious: 5 });
    expect(q.scanned.a11y).toBe(2);
    expect(q.security!.findings[0]).toMatchObject({ id: 'cookie-insecure', severity: 'high' });
    expect(q.perf!.metrics[0]).toMatchObject({ metric: 'LCP', status: 'fail', worst: 4800, tests: ['search-basic'] });
    expect(summariseLenses([])).toBeUndefined();
  });
});

describe('HTML report: run-level analysis in the browser', () => {
  it('groups the failures by cause with the next step, filters the list by category, and shows the quality lenses and the masked configuration', async () => {
    const { page, errors } = await open(out.html!);
    // Overview: the top failure reasons, each once with its count, link to the Failures tab.
    const reasons = page.locator('#p-overview .reason');
    expect(await reasons.count()).toBeGreaterThan(0);
    await reasons.first().locator('a').click();
    await expect.poll(() => page.evaluate('location.hash')).toMatch(/^#failures\//);
    expect(await page.locator('#p-failures').isVisible()).toBe(true);
    // Failures: by category, every failing test exactly once, each cause with its next step.
    const listed = await page.locator('#p-failures .group-tests a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    const failing = model.tests.filter((t) => ['failed', 'error', 'flaky'].includes(t.state));
    expect(listed.sort()).toEqual(failing.map((t) => `#tests/${encodeURIComponent(t.id)}`).sort());
    expect(await page.locator('#p-failures .cat-sec h3 .cat').allTextContents()).toEqual(expect.arrayContaining(['Product defect', 'Test data', 'Flaky']));
    expect(await page.locator('#p-failures .cause-card').count()).toBe(await page.locator('#p-failures .cause-card .next').count());
    // A category filter in the list (deep link), and grouping by category.
    await page.goto(pathToFileURL(out.html!).href + '#tests?cat=data');
    await expect.poll(() => page.locator('#f-cat').evaluate((x) => (x as HTMLSelectElement).value)).toBe('data');
    await expect.poll(() => page.locator('#count').textContent()).toBe('1 shown');
    expect(await page.locator('#vinner .row[data-id] .cat').first().textContent()).toBe('Test data');
    await page.locator('#f-cat').selectOption('');
    await page.locator('#group').selectOption('category');
    expect(await page.locator('#vinner .row.group .rname').first().textContent()).toBe('Product defect');
    // Quality lenses.
    await page.locator('#tab-quality').click();
    const q = page.locator('#p-quality');
    expect(await q.getByRole('heading', { name: 'Accessibility' }).count()).toBe(1);
    expect(await q.locator('table').filter({ hasText: 'name.button' }).first().textContent()).toMatch(/name\.button[\s\S]*critical[\s\S]*contrast\.text/);
    expect(await q.textContent()).toMatch(/cookie-insecure[\s\S]*high/);
    expect(await q.textContent()).toMatch(/LCP[\s\S]*fail[\s\S]*4800 ms/);
    // Environment: the configuration, masked and filterable, behind a collapsed section.
    await page.locator('#tab-environment').click();
    await page.locator('#env-config summary').click();
    const cfg = page.locator('#cfg-table');
    expect(await cfg.textContent()).toMatch(/identity\.roles\.admin\.password\s*\*\*\*\*/);
    expect(await page.content()).not.toContain('hunter2-plain');
    await page.locator('#cfg-q').fill('healing');
    await expect.poll(() => cfg.locator('tbody tr:not([hidden])').count()).toBe(2);
    expect(await page.locator('#cfg-count').textContent()).toMatch(/^2 of \d+$/);
    // The export menu lists the files.
    await page.locator('#exports-btn').click();
    expect(await page.locator('#exports-list a').allTextContents()).toEqual(expect.arrayContaining(['PDF report', 'Excel workbook', 'E-mail summary (HTML)']));
    expect(errors).toEqual([]);
    await page.close();
  });

  it('gives each failing test its category and next step once, and copies them into the bug text', async () => {
    const { page } = await open(out.html!, { hash: '#tests/data-import' });
    const cause = page.locator('#detail .cause');
    await expect.poll(() => cause.count()).toBe(1);
    expect(await cause.textContent()).toMatch(/Test data[\s\S]*Next step: Reset or regenerate the data/);
    expect((await page.locator('#detail').textContent())!.match(/Reset or regenerate the data/g)).toHaveLength(1);
    await page.close();
  });

  it('has no serious accessibility violations and fits a phone, in light and dark, on every tab', async () => {
    for (const scheme of ['light', 'dark'] as const) {
      for (const width of [1400, 390]) {
        const { page } = await open(out.html!, { width, scheme });
        for (const tab of ['overview', 'failures', 'trends', 'quality', 'environment']) {
          await page.evaluate(`location.hash = '#${tab}'`);
          await expect.poll(() => page.locator(`#p-${tab}`).isVisible()).toBe(true);
          if (tab === 'environment') await page.locator('#env-config summary').click();
          await expectNoSeriousA11y(page, `report-${scheme}-${width}-${tab}`);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          expect(overflow, `${tab} at ${width}px`).toBeLessThanOrEqual(1);
        }
        await page.close();
      }
    }
  });
});

describe('e-mail summary', () => {
  it('is mail-client safe: tables and inline styles, no script, SVG, grid or external resources', async () => {
    const html = await readFile(out.email!, 'utf8');
    expect(html).not.toMatch(/<script|<svg|<link |@import|display:\s*grid|<img/i);
    expect(html).toMatch(/role="presentation"/);
    expect(html).not.toMatch(/src="https?:/);
    // No verdict: the subject says what happened.
    expect(emailSubject(model)).toBe(`Shop web - end-to-end regression: 5 of 20 tests failed (${model.runId})`);
    expect(html).not.toMatch(/READINESS|NO GO|GO WITH RISKS/);
    const text = renderEmailText(model, { reportUrl: 'https://ci.example.test/r/report.html' });
    expect(text).toMatch(/Failures by cause:/);
    expect(text).not.toMatch(/NO GO|readiness/i);
    expect(text).toContain('https://ci.example.test/r/report.html#tests/checkout-card');
    expect(text).toMatch(/next step: /);
  });

  it('renders the counts once, the outcome, the failures by cause with permalinks and the environment, on desktop and phone, light and dark', async () => {
    const file = join(rich.runDir, 'email-linked.html');
    await writeFile(file, renderEmailHtml(model, { reportUrl: 'https://ci.example.test/r/report.html' }));
    for (const scheme of ['light', 'dark'] as const) {
      for (const width of [800, 390]) {
        const { page } = await open(file, { width, scheme });
        const body = (await page.locator('body').textContent()) ?? '';
        expect(body).not.toMatch(/READINESS|NO GO/);
        expect(body).toMatch(/Outcome · 72\.2% pass rate/);
        expect(body).toMatch(/Failures by cause[\s\S]*Product defect[\s\S]*Next step:/);
        expect(body).toMatch(/Environment[\s\S]*Run id/);
        expect(await page.getByRole('link', { name: 'Checkout with a saved card' }).first().getAttribute('href')).toBe('https://ci.example.test/r/report.html#tests/checkout-card');
        expect(await page.getByRole('link', { name: 'Open the full report' }).getAttribute('href')).toBe('https://ci.example.test/r/report.html');
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
        // Text keeps its contrast on the dark background too.
        await expectNoSeriousA11y(page, `email-${scheme}-${width}`);
        await page.close();
      }
    }
  });
});

describe('PDF report', () => {
  it('is drawn by pdf.js with sections that mirror the tabs, failures by cause, screenshots, every test, bookmarks and permalinks', async () => {
    const pdf = await readFile(out.pdf!);
    expect(pdf.subarray(0, 8).toString('latin1')).toBe('%PDF-1.7');
    const r = await renderPdfInBrowser(browser, pdf);
    try {
      const pages = r.pdf.pages;
      expect(pages.length).toBeGreaterThanOrEqual(4);
      expect(r.pdf.title).toBe(`Shop web - end-to-end regression - ${model.runId}`);
      // The sections mirror the report's tabs; no verdict without report.readiness.
      expect(r.pdf.outline).toEqual(['Overview', 'Failures', 'Tests', 'Trends', 'Quality', 'Environment']);
      const all = pages.map((p) => p.text).join('\n').replace(/[ ]{2,}/g, ' ');
      expect(all).not.toMatch(/READINESS|NO GO/);
      expect(pages[0].text).toMatch(/Overview[\s\S]*Outcome[\s\S]*Results by feature/);
      expect(pages[0].text).toMatch(/Top failure reasons[\s\S]*Product defect/);
      expect(all).toMatch(/Expected the order total "42.00" but the page shows "40.00"/);
      expect(all).toMatch(/Next step: /);
      expect(all).toMatch(/identity\.roles\.admin\.password\s+\*\*\*\*/);
      expect(all).not.toContain('hunter2-plain');
      expect(pages.flatMap((p) => p.links)).toEqual(expect.arrayContaining(['report.html#tests/checkout-card']));
      // Every page has visible content; the failures page carries embedded screenshots.
      for (const p of pages) expect(p.ink).toBeGreaterThan(0.01);
      expect((pdf.toString('latin1').match(/\/Subtype \/Image/g) ?? []).length).toBeGreaterThan(0);
      await r.page.locator('#p1').screenshot();
    } finally {
      await r.close();
    }
  });

  it('writes non-ASCII names and long errors without breaking the layout', async () => {
    const m: ReportModel = JSON.parse(JSON.stringify(model));
    m.tests[0].name = 'Kasse – Gutschein “SAVE10” für 42,00 € ✓';
    m.tests[0].error = { message: 'x'.repeat(5000) };
    const r = await renderPdfInBrowser(browser, renderReportPdf(m, { runDir: rich.runDir }));
    try {
      const all = r.pdf.pages.map((p) => p.text).join('\n');
      expect(all).toContain('Kasse – Gutschein “SAVE10” für 42,00 €');
    } finally {
      await r.close();
    }
  });
});

describe('Excel workbook', () => {
  it('has one sheet per tab with filters, links to the report and masked configuration, and no verdict', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out.xlsx!);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Overview', 'Tests', 'Steps', 'Failures', 'Requirements', 'Trends', 'Quality', 'Configuration', 'Environment']);
    const tests = wb.getWorksheet('Tests')!;
    expect(tests.rowCount).toBe(21);
    expect(tests.autoFilter).toBeTruthy();
    expect(tests.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    const head = (tests.getRow(1).values as unknown[]).slice(1);
    const col = (name: string) => head.indexOf(name) + 1;
    const row = [...Array(20).keys()].map((i) => tests.getRow(i + 2)).find((r) => r.getCell(1).value === 'data-import')!;
    expect(row.getCell(col('State')).value).toBe('Error');
    expect(row.getCell(col('Category')).value).toBe('Test data');
    expect(String(row.getCell(col('Suggested next step')).value)).toMatch(/Reset or regenerate/);
    expect((row.getCell(col('Report')).value as { hyperlink: string }).hyperlink).toBe('report.html#tests/data-import');
    expect((row.getCell(col('State')).fill as { fgColor?: { argb?: string } }).fgColor?.argb).toBe('FFFCEFE8');
    const steps = wb.getWorksheet('Steps')!;
    expect(steps.rowCount - 1).toBe(model.tests.reduce((n, t) => n + t.steps.length, 0));
    const failures = wb.getWorksheet('Failures')!;
    expect(failures.rowCount - 1).toBe(causeGroups(model).length);
    const cfg = wb.getWorksheet('Configuration')!;
    const cfgText = JSON.stringify(cfg.getSheetValues());
    expect(cfgText).toContain('identity.roles.admin.password');
    expect(cfgText).not.toContain('hunter2-plain');
    expect(JSON.stringify(wb.getWorksheet('Quality')!.getSheetValues())).toMatch(/contrast\.text/);
    const overview = JSON.stringify(wb.getWorksheet('Overview')!.getSheetValues());
    expect(overview).toMatch(/Top failure reasons/);
    expect(JSON.stringify(wb.worksheets.map((w) => w.getSheetValues()))).not.toMatch(/NO GO|Release readiness/);
  });
});

/** A small SMTP server that records the session and supports AUTH PLAIN and LOGIN. */
async function recordingSmtp(): Promise<{ port: number; sessions: Array<{ commands: string[]; data: string }>; close: () => Promise<void> }> {
  const sessions: Array<{ commands: string[]; data: string }> = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    const s = { commands: [] as string[], data: '' };
    sessions.push(s);
    let buf = '';
    let inData = false;
    let login = 0;
    sock.write('220 test ESMTP\r\n');
    sock.on('data', (c) => {
      buf += c.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          s.data = buf.slice(0, end).replace(/^\.\./gm, '.');
          buf = buf.slice(end + 5);
          inData = false;
          sock.write('250 2.0.0 queued as T1\r\n');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        s.commands.push(line);
        if (login === 1) { login = 2; sock.write('334 UGFzc3dvcmQ6\r\n'); continue; }
        if (login === 2) { login = 0; sock.write('235 ok\r\n'); continue; }
        const cmd = line.split(' ')[0].toUpperCase();
        if (cmd === 'EHLO') sock.write('250-test\r\n250-AUTH LOGIN\r\n250 SIZE 10000000\r\n');
        else if (cmd === 'AUTH') { login = 1; sock.write('334 VXNlcm5hbWU6\r\n'); }
        else if (cmd === 'MAIL' || cmd === 'RCPT') sock.write('250 ok\r\n');
        else if (cmd === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); return; }
        else sock.write('502 no\r\n');
      }
    });
    sock.on('close', () => sockets.delete(sock));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { port: (server.address() as AddressInfo).port, sessions, close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); } };
}

const ctxFor = (options: Record<string, unknown>) => ({
  run: rich.run, runDir: rich.runDir, analysis: {}, options, runUrl: undefined, fetch, logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
  resolveSecret: async (v: string) => (v === 'secret://env/SMTP_PASSWORD' ? 's3cret' : v),
});

describe('e-mail publisher', () => {
  it('mails the summary with a text alternative and the PDF attached, after AUTH LOGIN', async () => {
    const smtp = await recordingSmtp();
    try {
      const r = await publishEmail(ctxFor({ host: '127.0.0.1', port: smtp.port, starttls: false, username: 'reports', password: 'secret://env/SMTP_PASSWORD', from: 'EZTest <qa@example.test>', to: ['team@example.test', 'lead@example.test'], cc: 'pm@example.test', attach: ['pdf', 'xlsx'], reportUrl: 'https://ci.example.test/r/report.html' }));
      expect(r).toMatchObject({ ok: true });
      expect(r.message).toMatch(/mailed to 3 recipient\(s\) with report\.pdf, report\.xlsx/);
      const s = smtp.sessions[0];
      expect(s.commands).toEqual(expect.arrayContaining(['AUTH LOGIN', Buffer.from('reports').toString('base64'), Buffer.from('s3cret').toString('base64'), 'MAIL FROM:<qa@example.test>', 'RCPT TO:<team@example.test>', 'RCPT TO:<lead@example.test>', 'RCPT TO:<pm@example.test>']));
      const mime = parseMime(s.data);
      expect(mime.headers.subject).toBe(emailSubject(model));
      expect(mime.html).toMatch(/Failures by cause/);
      expect(mime.html).not.toMatch(/READINESS/);
      expect(mime.text).toMatch(/Full report: https:\/\/ci\.example\.test\/r\/report\.html/);
      const pdfPart = /Content-Disposition: attachment; filename="report\.pdf"\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(s.data);
      expect(Buffer.from(pdfPart![1].replace(/\r\n/g, ''), 'base64').subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(s.data).toMatch(/filename="report\.xlsx"/);
    } finally {
      await smtp.close();
    }
  });

  it('is delivered to EZTest\'s SMTP sink, honours "when", and explains what it needs', async () => {
    const sink = await new SmtpSink().start();
    try {
      const r = await publishEmail(ctxFor({ host: sink.host, port: sink.port, from: 'qa@example.test', to: 'team@example.test' }));
      expect(r.ok).toBe(true);
      const m = await sink.latest({ to: 'team@example.test', timeoutMs: 5000 });
      expect(m.subject).toMatch(/^Shop web - end-to-end regression: /);
      expect(m.html).toMatch(/Failures by cause/);
      expect((await publishEmail(ctxFor({ host: sink.host, port: sink.port, from: 'qa@example.test', to: 'x@example.test', when: 'not-go' }))).ok).toBe(true);
      const dry = await publishEmail(ctxFor({ from: 'qa@example.test', to: 'x@example.test', dryRun: true, attach: ['pdf', 'nope'] }));
      expect(dry.details).toMatchObject({ attachments: ['report.pdf'], skipped: [expect.stringMatching(/^nope/)] });
      expect((await publishEmail(ctxFor({ from: 'qa@example.test' }))).message).toMatch(/needs "to"/);
      expect((await publishEmail(ctxFor({ to: 'a@example.test' }))).message).toMatch(/needs "from"/);
      await expect(sendSmtp({ host: sink.host, port: sink.port }, { from: 'qa@example.test', to: ['not an address'], subject: 's', text: 't' })).rejects.toThrow(/not an e-mail address/);
    } finally {
      await sink.stop();
    }
  });

  it('builds RFC 2047 subjects and base64 parts that decode to the original text', () => {
    const raw = buildMime({ from: 'a@example.test', to: ['b@example.test'], subject: 'Lauf grün – 3 Fehler', text: 'Grüße', html: '<p>Grüße</p>' }, { date: new Date('2026-10-22T08:00:00Z'), messageId: 'm1@example.test' });
    expect(raw).toMatch(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m);
    const p = parseMime(raw);
    expect(p.headers.subject).toBe('Lauf grün – 3 Fehler');
    expect(p.text).toBe('Grüße');
    expect(p.html).toBe('<p>Grüße</p>');
  });
});
