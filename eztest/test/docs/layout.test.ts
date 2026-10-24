import { describe, expect, it } from '../support/testkit.js';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { autoFields, documentText, extractPdf, getField, mergeRulings, splitInlineLabel, tableRecords } from '../../src/docs/index.js';
import { INVOICE_TEMPLATE, fmt, makeInvoicePdf, sampleLines, sumTotals } from './helpers.js';

async function ruledTablePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595, 842]);
  page.drawText('Claims register', { x: 50, y: 790, size: 16, font });
  const xs = [50, 220, 320, 470];
  const top = 760;
  const rowH = 22;
  const rows = [['Claim', 'Status', 'Amount'], ['CL-100', 'Open', '1,200.00'], ['CL-101', 'Closed', '87.50'], ['CL-102', 'Pending review', '15,000.25']];
  for (let r = 0; r <= rows.length; r++) page.drawLine({ start: { x: xs[0], y: top - r * rowH }, end: { x: xs[3], y: top - r * rowH }, thickness: 0.8, color: rgb(0, 0, 0) });
  for (const x of xs) page.drawLine({ start: { x, y: top }, end: { x, y: top - rows.length * rowH }, thickness: 0.8, color: rgb(0, 0, 0) });
  rows.forEach((row, r) => row.forEach((cell, c) => page.drawText(cell, { x: xs[c] + 4, y: top - r * rowH - 15, size: 10, font })));
  page.drawText('Signed: Claims Desk', { x: 50, y: 600, size: 10, font });
  return pdf.save();
}

async function statementPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595, 842]);
  page.drawText('Account statement', { x: 50, y: 800, size: 14, font });
  page.drawText('Account: 0042-7781', { x: 50, y: 780, size: 10, font });
  const cols = [50, 140, 360, 460];
  const data = [['Date', 'Description', 'Debit', 'Balance'], ['2024-03-01', 'Opening balance', '0.00', '500.00'], ['2024-03-04', 'Card payment', '25.10', '474.90'], ['2024-03-09', 'Transfer to savings', '100.00', '374.90'], ['2024-03-15', 'Utility bill', '61.45', '313.45']];
  data.forEach((row, r) => row.forEach((cell, c) => page.drawText(cell, { x: cols[c], y: 740 - r * 16, size: 10, font })));
  page.drawText('Thank you for banking with us.', { x: 50, y: 600, size: 10, font });
  return pdf.save();
}

const LEFT = ['The insured shall notify the insurer of', 'any change in circumstances within the', 'thirty days that follow the event, in', 'writing, at the address shown in the', 'schedule attached to this policy wording.'];
const RIGHT = ['Claims are settled within fourteen days', 'after every document requested by the', 'insurer has been received, unless the', 'claim is disputed or fraud is suspected', 'by the claims handler for the account.'];

async function twoColumnPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595, 842]);
  page.drawText('Policy wording', { x: 50, y: 790, size: 16, font });
  LEFT.forEach((t, i) => page.drawText(t, { x: 50, y: 750 - i * 14, size: 10, font }));
  RIGHT.forEach((t, i) => page.drawText(t, { x: 320, y: 750 - i * 14, size: 10, font }));
  page.drawText('Page 1 of 1', { x: 270, y: 40, size: 8, font });
  return pdf.save();
}

describe('layout method: rulings, tables and columns', () => {
  it('finds ruling lines and reads a ruled table without a template', async () => {
    const doc = await extractPdf(await ruledTablePdf(), { method: 'layout' });
    const page = doc.pages[0];
    expect(page.method).toBe('layout');
    expect(page.rulings!.filter((r) => r.orientation === 'h')).toHaveLength(5);
    expect(page.rulings!.filter((r) => r.orientation === 'v')).toHaveLength(4);
    expect(doc.tables).toHaveLength(1);
    const t = doc.tables[0];
    expect(t.columns).toEqual(['Claim', 'Status', 'Amount']);
    expect(tableRecords(t)).toEqual([
      { Claim: 'CL-100', Status: 'Open', Amount: '1,200.00' },
      { Claim: 'CL-101', Status: 'Closed', Amount: '87.50' },
      { Claim: 'CL-102', Status: 'Pending review', Amount: '15,000.25' },
    ]);
    expect(t.rows[2].cells.Amount.normalized).toMatchObject({ kind: 'number', value: 15000.25 });
    expect(t.rows[0].cells.Amount.method).toBe('layout');
  });

  it('detects a borderless table from aligned text positions', async () => {
    const doc = await extractPdf(await statementPdf(), { method: 'layout' });
    expect(doc.tables).toHaveLength(1);
    const t = doc.tables[0];
    expect(t.columns).toEqual(['Date', 'Description', 'Debit', 'Balance']);
    const recs = tableRecords(t);
    expect(recs).toHaveLength(4);
    expect(recs[2]).toEqual({ Date: '2024-03-09', Description: 'Transfer to savings', Debit: '100.00', Balance: '374.90' });
    expect(t.rows[3].cells.Balance.normalized.value).toBe(313.45);
    // The "Account:" line and the closing sentence are not part of it.
    expect(recs.some((r) => Object.values(r).some((v) => /Thank you|0042/.test(v)))).toBe(false);
  });

  it('reads two-column text column by column', async () => {
    const bytes = await twoColumnPdf();
    const plain = documentText(await extractPdf(bytes));
    // The text layer reads straight across the gutter.
    expect(plain).toContain(`${LEFT[0]} ${RIGHT[0]}`);
    const doc = await extractPdf(bytes, { method: 'layout' });
    const lines = doc.pages[0].lines.map((l) => l.text);
    expect(lines).toEqual(['Policy wording', ...LEFT, ...RIGHT, 'Page 1 of 1']);
    expect(doc.pages[0].lines.map((l) => l.index)).toEqual(lines.map((_, i) => i));
  });

  it('templates work the same on the layout method', async () => {
    const lines = sampleLines(5);
    const bytes = await makeInvoicePdf({ invoiceNo: 'INV-9', customer: 'Northwind', date: '2024-07-01', lines, total: fmt(sumTotals(lines)) });
    const a = await extractPdf(bytes, { template: INVOICE_TEMPLATE });
    const b = await extractPdf(bytes, { method: 'layout', template: INVOICE_TEMPLATE });
    expect(b.fields.map((f) => [f.name, f.value.raw])).toEqual(a.fields.map((f) => [f.name, f.value.raw]));
    expect(tableRecords(b.tables[0])).toEqual(tableRecords(a.tables[0]));
    expect(getField(b, 'total')!.value.method).toBe('layout');
    // A template with tables suppresses template-free detection.
    expect(b.tables.map((t) => t.name)).toEqual(['lines']);
  });

  it('merges collinear ruling pieces', () => {
    expect(mergeRulings([
      { orientation: 'h', x: 10, y: 100, length: 50 },
      { orientation: 'h', x: 59, y: 100.5, length: 40 },
      { orientation: 'v', x: 10, y: 100, length: 30 },
    ])).toEqual([{ orientation: 'h', x: 10, y: 100.25, length: 89 }, { orientation: 'v', x: 10, y: 100, length: 30 }]);
  });
});

describe('field auto-detection: "Label: value" in one text run', () => {
  it('splits inline labels, not times or URLs', () => {
    expect(splitInlineLabel('Invoice No: INV-1001')).toEqual({ label: 'Invoice No', value: 'INV-1001', valueStart: 12 });
    expect(splitInlineLabel('Total due: $1,200.00')).toMatchObject({ label: 'Total due', value: '$1,200.00' });
    expect(splitInlineLabel('Meeting at 10:30 today')).toBeUndefined();
    expect(splitInlineLabel('See https://example.com/a')).toBeUndefined();
    expect(splitInlineLabel('Ratio 3: 4')).toBeUndefined();
    expect(splitInlineLabel('Just a sentence.')).toBeUndefined();
  });

  it('autoFields reads single-run "Label: value" lines with a value box', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([400, 300]);
    page.drawText('Policy No: PX-44120', { x: 40, y: 250, size: 10, font });
    page.drawText('Premium: 1,250.00', { x: 40, y: 230, size: 10, font });
    page.drawText('Holder:', { x: 40, y: 210, size: 10, font });
    page.drawText('Jane Roe', { x: 140, y: 210, size: 10, font });
    const doc = await extractPdf(await pdf.save());
    const fields = autoFields(doc);
    expect(fields.map((f) => [f.name, f.value.raw])).toEqual([['Policy No', 'PX-44120'], ['Premium', '1,250.00'], ['Holder', 'Jane Roe']]);
    const premium = fields[1].value;
    expect(premium.normalized).toMatchObject({ kind: 'number', value: 1250 });
    // The value box starts after the label, inside the run.
    expect(premium.bbox.x).toBeGreaterThan(60);
    expect(premium.bbox.x + premium.bbox.width).toBeLessThanOrEqual(doc.pages[0].lines[1].bbox.x + doc.pages[0].lines[1].bbox.width + 0.5);
  });
});
