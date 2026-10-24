import { describe, expect, it } from '../support/testkit.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { Step } from '../../src/core/index.js';
import { compareDocumentsVisually, parseMasks, renderPdfPages, renderVisualHtml } from '../../src/docs/index.js';
import { visualDocumentCheck } from '../../src/docs/visual-step.js';
import { parseEzScript, parseIntent } from '../../src/intent/index.js';
import { stepToText } from '../../src/intent/ezscript.js';
import { makeInvoicePdf, sampleLines } from './helpers.js';

const base = { invoiceNo: 'INV-1', customer: 'Contoso Ltd', date: '2024-05-01', lines: sampleLines(3), total: '71.25' };

describe('visual PDF comparison', () => {
  it('renders pages and passes identical documents', async () => {
    const a = await makeInvoicePdf(base);
    const pages = await renderPdfPages(a, { dpi: 72 });
    expect(pages).toHaveLength(1);
    expect([pages[0].width, pages[0].height]).toEqual([595, 842]);
    expect(PNG.sync.read(pages[0].png()).width).toBe(595);
    const r = await compareDocumentsVisually(a, await makeInvoicePdf(base));
    expect(r.passed).toBe(true);
    expect(r.pages[0].diffPixels).toBe(0);
    expect(r.summary).toContain('look alike');
  });

  it('fails on a changed amount, with a diff image that marks the change', async () => {
    const a = await makeInvoicePdf(base);
    const b = await makeInvoicePdf({ ...base, total: '71.75' });
    const r = await compareDocumentsVisually(b, a);
    expect(r.passed).toBe(false);
    const p = r.pages[0];
    expect(p.diffPixels).toBeGreaterThan(5);
    expect(p.diffRatio).toBeLessThan(0.01);
    expect(r.summary).toMatch(/page 1 differs in \d+ pixels/);
    // Red diff pixels sit where the total is printed (right edge, lower part of the table).
    const png = PNG.sync.read(p.diffPng!);
    let minX = Infinity;
    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      if (png.data[i] === 220 && png.data[i + 1] === 0) minX = Math.min(minX, x);
    }
    expect(minX / 100 * 72).toBeGreaterThan(450);
  });

  it('masks ignore a region; tolerance lets small differences pass', async () => {
    const a = await makeInvoicePdf(base);
    const b = await makeInvoicePdf({ ...base, date: '2024-05-02' });
    expect((await compareDocumentsVisually(b, a)).passed).toBe(false);
    // "Invoice Date:" value printed at x=150, baseline 790-30-28 = 732 -> top ~ 100pt from the top.
    const masked = await compareDocumentsVisually(b, a, { masks: [{ page: 1, x: 145, y: 95, width: 80, height: 16 }] });
    expect(masked.passed).toBe(true);
    expect(masked.pages[0].diffPixels).toBe(0);
    // A mask on another page does not apply.
    expect((await compareDocumentsVisually(b, a, { masks: [{ page: 2, x: 145, y: 95, width: 80, height: 16 }] })).passed).toBe(false);
    const loose = await compareDocumentsVisually(b, a, { maxDiffRatio: 0.01 });
    expect(loose.passed).toBe(true);
    expect(loose.pages[0].diffPixels).toBeGreaterThan(0);
    expect((await compareDocumentsVisually(b, a, { maxDiffPixels: 1 })).passed).toBe(false);
  });

  it('reports page count differences', async () => {
    const one = await makeInvoicePdf({ ...base, lines: sampleLines(4), rowsPerPage: 10 });
    const two = await makeInvoicePdf({ ...base, lines: sampleLines(14), rowsPerPage: 10 });
    const r = await compareDocumentsVisually(two, one);
    expect(r.passed).toBe(false);
    expect(r.pageCount).toEqual({ actual: 2, expected: 1 });
    expect(r.pages[1]).toMatchObject({ page: 2, problem: 'missing-in-expected', passed: false });
    expect(r.summary).toContain('page count differs');
    const html = renderVisualHtml(r, { title: 'two vs one' });
    expect(html).toContain('<title>two vs one</title>');
    expect(html).toContain('data:image/png;base64,');
  });

  it('parses masks', () => {
    expect(parseMasks('page 1 400,40,150,20 and 10.5, 20, 30, 40 on page 2; 1,2,3,4')).toEqual([
      { page: 1, x: 400, y: 40, width: 150, height: 20 },
      { page: 2, x: 10.5, y: 20, width: 30, height: 40 },
      { x: 1, y: 2, width: 3, height: 4 },
    ]);
    expect(() => parseMasks('the logo')).toThrow(/x,y,width,height/);
  });
});

describe('step: Expect document A to look like document B', () => {
  it('parses and prints back', () => {
    const s = Step.parse(parseIntent('Expect document invoice to look like "baselines/invoice.pdf" within 0.5% ignoring page 1 145,95,80,16 and store as look'));
    expect(s).toMatchObject({ action: 'compareDocument', captureAs: 'look', args: { mode: 'visual', document: 'invoice', expected: 'baselines/invoice.pdf', tolerancePercent: 0.5, masks: 'page 1 145,95,80,16' } });
    expect(stepToText(s)).toBe('Expect document invoice to look like "baselines/invoice.pdf" within 0.5% ignoring page 1 145,95,80,16 and store as look');
    expect(Step.parse(parseIntent('Verify the pdf statement looks like the baseline expected.pdf within 40 pixels')).args).toMatchObject({ mode: 'visual', document: 'statement', expected: 'expected.pdf', maxDiffPixels: 40 });
    // In a journey file it is a step of its own, not a post-condition of the download step.
    const j = parseEzScript('Journey: J\nDownload the "Invoice" link as invoice\nExpect document invoice to look like "base.pdf"\n');
    expect(j.steps.map((x) => x.action)).toEqual(['download', 'compareDocument']);
    // Element visual assertions keep their meaning.
    expect(Step.parse(parseIntent('Expect the report to look like the baseline')).action).not.toBe('compareDocument');
    expect(Step.parse(parseIntent('Expect the Header to look like the baseline')).action).not.toBe('compareDocument');
  });

  it('runs against a downloaded file and stores diff images and an HTML report as evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezvis-'));
    await writeFile(join(dir, 'baseline.pdf'), await makeInvoicePdf(base));
    await writeFile(join(dir, 'download.pdf'), await makeInvoicePdf({ ...base, date: '2024-05-02' }));
    const stored: Array<{ kind: string; path: string; bytes: number }> = [];
    const ledger = new Map<string, unknown>([['invoice', { path: join(dir, 'download.pdf') }]]);
    const ctx = {
      ledger: { get: (k: string) => ledger.get(k), set: (k: string, v: unknown) => ledger.set(k, v) },
      journey: { id: 'J1' }, step: { id: 's3' },
      evidence: { store: async (kind: string, path: string, data: string | Uint8Array) => { stored.push({ kind, path, bytes: data.length }); return { id: `E-${stored.length}` }; } },
    } as never;
    const fail = await visualDocumentCheck({ mode: 'visual', document: 'invoice', expected: 'baseline.pdf' }, ctx, dir).catch((e: Error & { code?: string }) => e);
    expect((fail as { code?: string }).code).toBe('DOCS_VISUAL_MISMATCH');
    expect((fail as Error).message).toMatch(/Document invoice does not look like baseline\.pdf: page 1 differs/);
    expect(stored.map((s) => [s.kind, s.path])).toEqual([
      ['screenshot', 'documents/J1-s3/page-1-diff.png'], ['screenshot', 'documents/J1-s3/page-1-actual.png'], ['screenshot', 'documents/J1-s3/page-1-expected.png'], ['report', 'documents/J1-s3/visual.html'],
    ]);
    stored.length = 0;
    const ok = await visualDocumentCheck({ mode: 'visual', document: 'invoice', expected: 'baseline.pdf', masks: 'page 1 145,95,80,16' }, ctx, dir);
    expect(ok.passed).toBe(true);
    expect(ok.details).toMatchObject({ passed: true, pageCount: { actual: 1, expected: 1 }, evidence: ['E-1', 'E-2'] });
    await expect(visualDocumentCheck({ mode: 'visual', document: 'nope', expected: 'baseline.pdf' }, ctx, dir)).rejects.toThrow(/neither a downloaded file/);
  });
});
