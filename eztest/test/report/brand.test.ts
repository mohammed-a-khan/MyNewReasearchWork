/**
 * White-label branding of every output: report.brand (and a brand file)
 * puts the company, title, subtitle, logos, favicon, colours, font, labels,
 * footer and "prepared by" line into report.html, the PDF, the e-mail
 * summary, the workbook and the one-page summary; hidden sections are left
 * out everywhere; white label removes EZTest's own name; invalid or
 * oversized assets are rejected with a clear error; a colour that fails WCAG
 * AA is replaced by an accessible shade, with a warning.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import ExcelJS from 'exceljs';
import { chromium, type Browser } from '../../src/browser/index.js';
import { brandPalette, contrastRatio, loadBrand, loadBrandAsset, readBrandFile, renderEmailHtml, renderEmailText, renderReportPdf, writeReports, BrandSchema, SURFACE, type ReportBrand } from '../../src/report/index.js';
import { reportOptionsFromConfig } from '../../src/engine/analyze.js';
import { loadConfig, SecretMasker } from '../../src/config/index.js';
import { makeRichFixture, type RichFixture } from './rich-fixture.js';
import { renderPdfInBrowser } from './pdf-view.js';
import { expectNoSeriousA11y } from '../a11y/assert.js';

let dir: string;
let rich: RichFixture;
let browser: Browser;
let brand: ReportBrand;
let warnings: string[];

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 32"><rect width="32" height="32" rx="8" fill="#0b6e4f"/><text x="40" y="22" font-size="16">Northwind</text></svg>';
const png = (w: number, h: number, rgb: [number, number, number]) => {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) p.data.set([...rgb, 255], i * 4);
  return PNG.sync.write(p);
};
/** A minimal file with the woff2 signature (the report embeds it; browsers ignore a font they cannot decode). */
const WOFF2 = Buffer.concat([Buffer.from('wOF2', 'latin1'), Buffer.alloc(60)]);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ez-brand-'));
  await writeFile(join(dir, 'logo.svg'), SVG);
  await writeFile(join(dir, 'logo-dark.png'), png(120, 32, [240, 240, 240]));
  await writeFile(join(dir, 'favicon.png'), png(32, 32, [11, 110, 79]));
  await writeFile(join(dir, 'mark.png'), png(64, 64, [11, 110, 79]));
  await writeFile(join(dir, 'brand.woff2'), WOFF2);
  const loaded = await loadBrand({
    brand: {
      company: 'Northwind QA', title: 'Nightly regression', subtitle: 'Shop web', preparedBy: 'QA Platform team (qa@northwind.example)', footer: 'Confidential - Northwind internal use only.',
      logo: 'logo.svg', logoDark: 'logo-dark.png', favicon: 'favicon.png', mark: 'mark.png',
      colors: { primary: '#0b6e4f', secondary: '#c2410c' }, font: { family: 'Northwind Sans', file: 'brand.woff2' },
      labels: { tabs: { tests: 'Test cases' }, test: 'test case', tests: 'test cases' },
    },
  }, { cwd: dir, defaultName: 'Shop' });
  brand = loaded.brand;
  warnings = loaded.warnings;
  rich = await makeRichFixture();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('brand configuration', () => {
  it('loads and embeds the assets, derives the palette, and the schema validates it', () => {
    expect(warnings).toEqual([]);
    expect(brand).toMatchObject({ name: 'Shop', company: 'Northwind QA', subtitle: 'Shop web', footer: 'Confidential - Northwind internal use only.', color: '#0b6e4f' });
    expect(brand.logo).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(brand.logoDark).toMatch(/^data:image\/png;base64,/);
    expect(brand.favicon).toMatch(/^data:image\/png;base64,/);
    expect(brand.font).toMatchObject({ family: 'Northwind Sans', src: expect.stringMatching(/^data:font\/woff2;base64,/) });
    expect(contrastRatio(brand.palette!.light['brand-ink'], SURFACE.light)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(brand.palette!.dark['brand-ink'], SURFACE.dark)).toBeGreaterThanOrEqual(4.5);
    expect(BrandSchema.safeParse({ colors: { primary: 'green' } }).success).toBe(false);
    expect(BrandSchema.safeParse({ hide: ['tests'] }).success).toBe(false);
    expect(BrandSchema.safeParse({ unknownKey: 1 }).success).toBe(false);
  });

  it('replaces a colour that fails WCAG AA by an accessible shade, with a warning', () => {
    const w: string[] = [];
    const p = brandPalette({ primary: '#ffd400', passed: '#a3e635', headerBackground: '#0b1f3a', headerText: '#334155' }, w);
    expect(w.join('\n')).toMatch(/colors\.primary #ffd400 has a contrast of 1\.\d+:1[\s\S]*accessible shade #[0-9a-f]{6}/);
    expect(w.join('\n')).toMatch(/colors\.passed #a3e635[\s\S]*3:1/);
    expect(w.join('\n')).toMatch(/colors\.headerText #334155[\s\S]*#ffffff is used/);
    expect(contrastRatio(p.light['brand-ink'], SURFACE.light)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.light['on-brand'], p.light['brand-btn'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.light['st-passed'], SURFACE.light)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(p.light['ink-passed'], SURFACE.light)).toBeGreaterThanOrEqual(4.5);
    expect(p.header).toMatchObject({ bg: '#0b1f3a', text: '#ffffff' });
    expect(brandPalette({ primary: '#0b6e4f' }, [])).toBeTruthy();
  });

  it('rejects invalid and oversized logos and fonts with a clear error, and keeps the run going', async () => {
    await writeFile(join(dir, 'big.png'), Buffer.concat([png(4, 4, [0, 0, 0]), Buffer.alloc(600 * 1024)]));
    await writeFile(join(dir, 'fake.png'), 'not a png');
    await writeFile(join(dir, 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');
    await writeFile(join(dir, 'font.ttf'), 'x');
    await writeFile(join(dir, 'fake.woff2'), 'not a font');
    await writeFile(join(dir, 'big.woff2'), Buffer.concat([WOFF2, Buffer.alloc(1100 * 1024)]));
    await expect(loadBrandAsset(join(dir, 'big.png'), 'logo')).rejects.toThrow(/report\.brand\.logo .*big\.png is 6\d\d KiB; the limit is 512 KiB/);
    await expect(loadBrandAsset(join(dir, 'fake.png'), 'logo')).rejects.toThrow(/is not a valid PNG file/);
    await expect(loadBrandAsset(join(dir, 'evil.svg'), 'mark')).rejects.toThrow(/SVG files must not contain scripts or event handlers/);
    await expect(loadBrandAsset(join(dir, 'font.ttf'), 'font')).rejects.toThrow(/report\.brand\.font\.file .*use \.woff2/);
    await expect(loadBrandAsset(join(dir, 'fake.woff2'), 'font')).rejects.toThrow(/is not a valid WOFF2 file/);
    await expect(loadBrandAsset(join(dir, 'big.woff2'), 'font')).rejects.toThrow(/the limit is 1024 KiB/);
    await expect(loadBrandAsset(join(dir, 'missing.png'), 'favicon')).rejects.toThrow(/file not found/);
    // In a run, a bad asset is left out with the error as a warning; the report is still written.
    const r = await loadBrand({ brand: { logo: 'big.png', font: { family: 'X', file: 'fake.woff2' } } }, { cwd: dir, defaultName: 'Shop' });
    expect(r.brand.logo).toBeUndefined();
    expect(r.warnings.join('\n')).toMatch(/big\.png[\s\S]*fake\.woff2/);
    // A brand file with an unknown key is rejected with the key named.
    await writeFile(join(dir, 'bad-brand.yaml'), 'brand:\n  company: X\n  colour: "#fff"\n');
    await expect(readBrandFile(join(dir, 'bad-brand.yaml'))).rejects.toThrow(/bad-brand\.yaml: .*colour/);
  });

  it('is set per project and per environment through the config layers, and overridden by a brand file (--brand-file, EZTEST_BRAND_FILE)', async () => {
    const proj = await mkdtemp(join(tmpdir(), 'ez-brand-proj-'));
    try {
      await writeFile(join(proj, 'eztest.config.yaml'), 'report:\n  brand:\n    company: Northwind QA\n    colors: { primary: "#0b6e4f" }\nprojects:\n  billing:\n    report:\n      brand:\n        company: Northwind Billing QA\n        hide: [trends]\n');
      await writeFile(join(proj, 'branding.yaml'), 'company: Contoso Release Team\ntitle: Release candidate\nwhiteLabel: true\n');
      const base = await loadConfig({ cwd: proj, environment: {}, masker: new SecretMasker() });
      expect(base.config.report.brand).toMatchObject({ company: 'Northwind QA' });
      expect(base.config.report.readiness).toBe(false);
      const billing = await loadConfig({ cwd: proj, project: 'billing', environment: {}, masker: new SecretMasker() });
      expect(billing.config.report.brand).toMatchObject({ company: 'Northwind Billing QA', hide: ['trends'] });
      await writeFile(join(proj, 'eztest.config.yaml'), 'report:\n  brand:\n    company: Northwind QA\n    colour: x\n');
      await expect(loadConfig({ cwd: proj, environment: {}, masker: new SecretMasker() })).rejects.toThrow(/report\.brand/);
      // A brand file wins over report.brand; EZTEST_BRAND_FILE points at one for CI.
      const opts = reportOptionsFromConfig(billing.config, proj, { EZTEST_BRAND_FILE: 'branding.yaml' });
      const b = await loadBrand(opts.report!, { cwd: proj, defaultName: 'Proj' });
      expect(b.brand).toMatchObject({ company: 'Contoso Release Team', whiteLabel: true, hide: ['trends'] });
      expect(b.title).toBe('Release candidate');
    } finally {
      await rm(proj, { recursive: true, force: true });
    }
  });
});

describe('the brand in every output', () => {
  it('report.html: header, title, favicon, logos, font, labels, colours and footer; accessible in light and dark', async () => {
    const out = await writeReports(rich.runDir, rich.run, { ...rich.insights, brand, title: 'Nightly regression', formats: ['html', 'json'] });
    const html = await readFile(out.html!, 'utf8');
    expect(html).toMatch(/<title>Nightly regression - Shop web - /);
    expect(html).toContain(`<link rel="icon" href="${brand.favicon}">`);
    expect(html).toContain('@font-face{font-family:"Northwind Sans"');
    expect(html).toContain('--brand:#0b6e4f');
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(pathToFileURL(out.html!).href);
    expect(await page.locator('.brand-eyebrow').textContent()).toBe('Northwind QA');
    expect(await page.locator('.brand-title').textContent()).toBe('Nightly regression — Shop web');
    expect(await page.locator('img.brand-logo.light').isVisible()).toBe(true);
    expect(await page.locator('#tab-tests').textContent()).toBe('Test cases');
    expect(await page.locator('[data-count=all]').textContent()).toMatch(/20\s*test cases/);
    expect(await page.locator('footer').textContent()).toMatch(/Confidential - Northwind internal use only\.[\s\S]*Prepared by QA Platform team/);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^"Northwind Sans"/);
    await expectNoSeriousA11y(page, 'brand-light');
    await page.locator('#theme-toggle').click();
    expect(await page.locator('img.brand-logo.dark').isVisible()).toBe(true);
    expect(await page.locator('img.brand-logo.light').isVisible()).toBe(false);
    await expectNoSeriousA11y(page, 'brand-dark');
    await page.evaluate('localStorage.clear()');
    await page.close();
  });

  it('PDF: header, metadata and footer; e-mail: header, colours and footer; workbook: title rows and creator', async () => {
    const out = await writeReports(rich.runDir, rich.run, { ...rich.insights, brand, title: 'Nightly regression', formats: ['html', 'json'] });
    const pdf = await readFile(out.pdf!);
    const r = await renderPdfInBrowser(browser, pdf);
    try {
      expect(r.pdf.title).toBe(`Nightly regression - Shop web - ${rich.run.runId}`);
      const text = r.pdf.pages.map((p) => p.text).join('\n').replace(/ {2,}/g, ' ');
      expect(r.pdf.pages[0].text).toMatch(/NORTHWIND QA[\s\S]*Nightly regression[\s\S]*Shop web/);
      expect(text).toContain('Confidential - Northwind internal use only.');
      expect(text).toMatch(/Prepared by QA Platform team/);
      expect(r.pdf.outline).toContain('Test cases');
    } finally {
      await r.close();
    }
    expect(pdf.toString('latin1')).toMatch(/\/Author /);
    const model = JSON.parse(await readFile(join(rich.runDir, 'report-model.json'), 'utf8'));
    const mail = renderEmailHtml(model);
    expect(mail).toContain('Northwind QA');
    expect(mail).toContain('Nightly regression');
    expect(mail).toContain('bgcolor="#0b6e4f"');
    expect(mail).toContain('Confidential - Northwind internal use only.');
    expect(renderEmailText(model)).toMatch(/^Northwind QA - Nightly regression - Shop web/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out.xlsx!);
    const first = wb.worksheets[0];
    expect(first.getCell('A1').value).toBe('Northwind QA');
    expect(first.getCell('A2').value).toBe('Nightly regression - Shop web');
    expect(JSON.stringify(first.getSheetValues())).toContain('Prepared by QA Platform team');
    expect(wb.title).toBe('Nightly regression - Shop web');
  });

  it('hidden sections are absent from the report, the PDF, the workbook and the e-mail', async () => {
    const hidden = { ...brand, hide: ['trends', 'quality', 'environment'] as ReportBrand['hide'] };
    const out = await writeReports(rich.runDir, rich.run, { ...rich.insights, brand: hidden, formats: ['html', 'json'] });
    const html = await readFile(out.html!, 'utf8');
    for (const id of ['trends', 'quality', 'environment']) {
      expect(html).not.toContain(`id="tab-${id}"`);
      expect(html).not.toContain(`id="p-${id}"`);
    }
    expect(html).toContain('id="tab-failures"');
    const r = await renderPdfInBrowser(browser, await readFile(out.pdf!));
    try {
      expect(r.pdf.outline).toEqual(['Overview', 'Failures', 'Test cases']);
    } finally {
      await r.close();
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out.xlsx!);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Overview', 'Tests', 'Steps', 'Failures']);
    const model = JSON.parse(await readFile(join(rich.runDir, 'report-model.json'), 'utf8'));
    const mail = renderEmailHtml(model);
    expect(mail).not.toMatch(/>Environment<|Pass rate, last/);
  });

  it('white label removes EZTest\'s name from every output', async () => {
    const wl = { ...brand, whiteLabel: true };
    const out = await writeReports(rich.runDir, rich.run, { ...rich.insights, brand: wl, formats: ['html', 'json'] });
    const html = await readFile(out.html!, 'utf8');
    const page = await browser.newPage();
    await page.goto(pathToFileURL(out.html!).href);
    const visible: string[] = [];
    for (const tab of ['overview', 'tests', 'failures', 'trends', 'quality', 'environment']) {
      await page.evaluate(`location.hash = '#${tab}'`);
      visible.push(await page.locator('body').evaluate((b) => (b as HTMLElement).innerText));
    }
    await page.goto(pathToFileURL(out.html!).href + '#tests/checkout-card');
    await expect.poll(() => page.locator('#d-title').count()).toBe(1);
    const trace = page.locator('#detail [role=tab][data-sub=trace]');
    if (await trace.count()) await trace.click();
    visible.push(await page.locator('body').evaluate((b) => (b as HTMLElement).innerText));
    await page.close();
    expect(visible.join('\n')).not.toMatch(/EZTest/);
    expect(html).not.toMatch(/<meta name="generator"|Generated by EZTest/);
    const model = JSON.parse(await readFile(join(rich.runDir, 'report-model.json'), 'utf8'));
    expect(renderEmailHtml(model)).not.toMatch(/EZTest/);
    expect(renderEmailText(model)).not.toMatch(/EZTest/);
    const pdf = renderReportPdf(model);
    expect(pdf.toString('latin1')).not.toMatch(/EZTest/);
    const r = await renderPdfInBrowser(browser, pdf);
    try {
      expect(r.pdf.pages.map((p) => p.text).join('\n')).not.toMatch(/EZTest/);
    } finally {
      await r.close();
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out.xlsx!);
    expect(wb.creator).not.toMatch(/EZTest/);
    expect(JSON.stringify(wb.worksheets.map((w) => w.getSheetValues()))).not.toMatch(/EZTest/);
    const summary = await readFile(out.summary!, 'utf8');
    expect(summary.replace(/<style>[\s\S]*?<\/style>/, '')).not.toMatch(/EZTest/);
  });
});
