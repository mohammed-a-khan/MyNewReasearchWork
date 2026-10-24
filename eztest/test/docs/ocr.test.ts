import { describe, expect, it } from '../support/testkit.js';
import { PDFDocument } from 'pdf-lib';
import { NotSupportedError } from '../../src/core/index.js';
import { documentText, extractPdf, getField, ocrWordsToItems, tableRecords, type DocOcrEngine, type OcrWordBox } from '../../src/docs/index.js';
import { INVOICE_TEMPLATE, fmt, makeInvoicePdf, sampleLines, sumTotals } from './helpers.js';
import { editDistance, scanPdf } from './scan.js';

const num = (s: unknown) => Number(String(s).replace(/,/g, ''));

describe('scanned PDFs: OCR (tesseract.js + @napi-rs/canvas)', () => {
  it('auto-detects an image-only page, OCRs it and reads fields and amounts through the template', async () => {
    const lines = sampleLines(12);
    const total = fmt(sumTotals(lines));
    const original = await makeInvoicePdf({ invoiceNo: 'INV-20417', customer: 'Contoso Ltd', date: '2024-05-01', lines, total });
    const scanned = await scanPdf(original);

    // The scan has no text layer at all.
    const plain = await extractPdf(scanned);
    expect(plain.findings.map((f) => f.code)).toContain('NO_TEXT_LAYER');
    expect(plain.findings.find((f) => f.code === 'NO_TEXT_LAYER')!.message).toContain('"ocr"');

    const doc = await extractPdf(scanned, { method: 'auto', template: INVOICE_TEMPLATE });
    expect(doc.pages[0].method).toBe('ocr');
    expect(doc.findings.filter((f) => f.severity === 'error')).toEqual([]);

    // Fields: exact values after normalisation.
    expect(getField(doc, 'invoiceNo')!.value.raw).toBe('INV-20417');
    expect(getField(doc, 'customer')!.value.raw).toBe('Contoso Ltd');
    expect(getField(doc, 'date')!.value.normalized.value).toBe('2024-05-01');
    expect(getField(doc, 'total')!.value.normalized.value).toBe(num(total));
    for (const f of doc.fields) {
      expect(f.value.method).toBe('ocr');
      expect(f.value.confidence).toBeGreaterThan(0.5);
      expect(f.value.confidence).toBeLessThanOrEqual(1);
    }

    // Amounts: every quantity, unit price and line total of the table.
    const rows = tableRecords(doc.tables.find((t) => t.name === 'lines')!).filter((r) => r.sku);
    expect(rows).toHaveLength(12);
    let amounts = 0;
    let right = 0;
    lines.forEach((l, i) => {
      for (const [got, want] of [[rows[i].qty, l.qty], [rows[i].price, l.price], [rows[i].lineTotal, l.total]] as const) {
        amounts++;
        if (num(got) === num(want)) right++;
      }
    });
    const skus = rows.filter((r, i) => r.sku === lines[i].sku).length;

    // Character accuracy of the whole page against the original text layer.
    const truth = documentText(await extractPdf(original)).replace(/\s+/g, ' ').trim();
    const read = documentText(doc).replace(/\s+/g, ' ').trim();
    const charAccuracy = 1 - editDistance(read, truth) / truth.length;
    console.log(`OCR accuracy (200 dpi noisy scan, OCR at 300 dpi): fields 4/4, amounts ${right}/${amounts}, keys ${skus}/12, characters ${(charAccuracy * 100).toFixed(2)}%`);
    expect(right / amounts).toBeGreaterThanOrEqual(0.97);
    expect(skus).toBeGreaterThanOrEqual(11);
    expect(charAccuracy).toBeGreaterThanOrEqual(0.97);
  }, 120_000);

  it('auto mode keeps the text layer where there is one and OCRs only the scanned page', async () => {
    const lines = sampleLines(14);
    const original = await makeInvoicePdf({ invoiceNo: 'INV-7', customer: 'Fabrikam', date: '2024-02-03', lines, total: fmt(sumTotals(lines)), rowsPerPage: 8 });
    const scanned = await scanPdf(original);
    // Page 1 born-digital, page 2 scanned.
    const mixed = await PDFDocument.create();
    const [p1] = await mixed.copyPages(await PDFDocument.load(original), [0]);
    const [p2] = await mixed.copyPages(await PDFDocument.load(scanned), [1]);
    mixed.addPage(p1);
    mixed.addPage(p2);
    const doc = await extractPdf(await mixed.save(), { method: 'auto', template: INVOICE_TEMPLATE });
    expect(doc.pages[0].method).toBeUndefined();
    expect(doc.pages[1].method).toBe('ocr');
    const table = doc.tables.find((t) => t.name === 'lines')!;
    expect(table.pages).toEqual([1, 2]);
    const rows = table.rows.filter((r) => r.kind === 'data');
    expect(rows).toHaveLength(14);
    expect(rows[0].cells.lineTotal.method).toBe('text-layer');
    expect(rows[13].cells.lineTotal.method).toBe('ocr');
    expect(num(rows[13].cells.lineTotal.raw)).toBe(num(lines[13].total));
    expect(getField(doc, 'total')!.value.normalized.value).toBe(num(fmt(sumTotals(lines))));
  }, 120_000);

  it('"vision" is not supported, with a clear message', async () => {
    const bytes = await makeInvoicePdf({ invoiceNo: 'X', customer: 'Y', date: '2024-01-01', lines: [], total: '0' });
    const err = await extractPdf(bytes, { method: 'vision' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(NotSupportedError);
    expect((err as Error).message).toContain('model service');
  });
});

describe('OCR words to the document model (engine-independent)', () => {
  // A fake engine: words of a 2x scaled page (pixels), as a recogniser reports them.
  const words: OcrWordBox[] = [
    { text: 'Policy', confidence: 96, x0: 100, y0: 100, x1: 160, y1: 120, line: 0 },
    { text: 'No:', confidence: 95, x0: 166, y0: 100, x1: 196, y1: 120, line: 0 },
    { text: 'PX-991', confidence: 88, x0: 300, y0: 101, x1: 370, y1: 120, line: 0 },
    { text: 'Premium:', confidence: 93, x0: 100, y0: 140, x1: 190, y1: 160, line: 1 },
    { text: '$1,250.00', confidence: 72, x0: 300, y0: 139, x1: 390, y1: 162, line: 1 },
  ];
  const engine: DocOcrEngine = { recognize: async () => words, close: async () => undefined };

  it('maps pixel boxes to points with one baseline per line', () => {
    const items = ocrWordsToItems(words, { page: 1, scale: 2, heightPt: 400 });
    expect(items[0]).toMatchObject({ text: 'Policy', x: 50, y: 50, width: 30, height: 10, confidence: 0.96, fontName: 'OCR' });
    expect(new Set(items.slice(0, 3).map((i) => i.baseline)).size).toBe(1);
    expect(items[0].baseline).toBe(340);
  });

  it('a pluggable engine feeds templates; low-confidence words lower the value confidence', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 400]);
    const doc = await extractPdf(await pdf.save(), {
      method: 'ocr', ocr: { engine, dpi: 144 },
      template: { fields: [{ name: 'policy', label: 'Policy No' }, { name: 'premium', label: 'Premium', type: 'currency' }] },
    });
    expect(doc.pages[0].method).toBe('ocr');
    expect(getField(doc, 'policy')!.value).toMatchObject({ raw: 'PX-991', method: 'ocr', confidence: 0.88 });
    const premium = getField(doc, 'premium')!.value;
    expect(premium.normalized).toMatchObject({ kind: 'number', value: 1250, currency: 'USD' });
    expect(premium.confidence).toBe(0.72);
  });
});
