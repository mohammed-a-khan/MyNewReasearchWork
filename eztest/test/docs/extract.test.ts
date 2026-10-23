import { describe, expect, it } from '../support/testkit.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  applyTemplate,
  extractFields,
  extractPdf,
  extractTables,
  footingFromTable,
  getField,
  parseTemplate,
  tableRecords,
} from '../../src/docs/index.js';
import { NotSupportedError } from '../../src/core/index.js';
import { INVOICE_TEMPLATE, fmt, makeInvoicePdf, sampleLines, sumTotals } from './helpers.js';

describe('extractPdf: layout and metadata', () => {
  it('reads positioned items, lines, segments and metadata', async () => {
    const bytes = await makeInvoicePdf({ invoiceNo: 'INV-1001', customer: 'Contoso Ltd', date: '2024-05-01', lines: sampleLines(2), total: '0.00' });
    const doc = await extractPdf(bytes, { source: 'inv.pdf' });
    expect(doc.source).toBe('inv.pdf');
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.metadata).toMatchObject({ title: 'Invoice INV-1001', author: 'EZ Test Suite', pageCount: 1, encrypted: false });
    expect(doc.metadata.producer).toContain('pdf-lib');
    expect(doc.metadata.creationDate).toBe('2024-05-01T10:00:00.000Z');
    expect(doc.metadata.pageSizes).toEqual([{ width: 595, height: 842 }]);
    const lines = doc.pages[0].lines;
    expect(lines[0].text).toBe('ACME Corp - Invoice');
    const first = lines[0].segments[0].items[0];
    expect(first.fontName).toBe('Helvetica-Bold');
    expect(first.fontSize).toBe(18);
    expect(first.x).toBe(50);
    expect(first.y).toBeGreaterThan(0);
    // "Invoice No:", value and the "Bill To" block share a baseline but are separate segments, in x order.
    const invLine = lines.find((l) => l.text.startsWith('Invoice No:'))!;
    expect(invLine.segments.map((s) => s.text)).toEqual(['Invoice No:', 'INV-1001', 'Bill To']);
    // Reading order: top to bottom.
    for (let i = 1; i < lines.length; i++) expect(lines[i].bbox.y).toBeGreaterThanOrEqual(lines[i - 1].bbox.y);
  });

  it('reads from a file path and flags documents without text', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 300]);
    const dir = await mkdtemp(join(tmpdir(), 'ezdocs-'));
    const p = join(dir, 'blank.pdf');
    await writeFile(p, await pdf.save());
    const doc = await extractPdf(p);
    expect(doc.source).toBe('blank.pdf');
    expect(doc.findings.map((f) => f.code)).toContain('NO_TEXT_LAYER');
  });

  it('throws NotSupportedError for OCR/vision methods', async () => {
    const bytes = await makeInvoicePdf({ invoiceNo: 'X', customer: 'Y', date: '2024-01-01', lines: [], total: '0' });
    await expect(extractPdf(bytes, { method: 'ocr' })).rejects.toBeInstanceOf(NotSupportedError);
  });
});

describe('fields and tables', () => {
  it('extracts a multi-page table with repeated headers, accounting negatives and wrapped cells', async () => {
    const lines = sampleLines(45);
    lines[3] = { ...lines[3], item: ['Premium widget with an extended', 'warranty and on-site service'] };
    lines.push({ sku: 'DISC-01', item: 'Loyalty discount', qty: '1', price: '(25.00)', total: '(25.00)' });
    const total = sumTotals(lines);
    const bytes = await makeInvoicePdf({
      invoiceNo: 'INV-2002',
      customer: 'Fabrikam Inc',
      date: '2024-05-01',
      lines,
      total: fmt(total),
      rowsPerPage: 20,
      footer: 'Generated 2024-05-01 10:00',
    });
    const doc = await extractPdf(bytes, { template: INVOICE_TEMPLATE });
    expect(doc.metadata.pageCount).toBe(3);
    expect(doc.findings.filter((f) => f.severity === 'error')).toEqual([]);

    expect(getField(doc, 'invoiceNo')?.value.raw).toBe('INV-2002');
    expect(getField(doc, 'customer')?.value.raw).toBe('Fabrikam Inc');
    const date = getField(doc, 'date')!;
    expect(date.value.normalized).toEqual({ kind: 'date', value: '2024-05-01' });
    expect(date.value.method).toBe('text-layer');
    expect(date.value.page).toBe(1);
    const tot = getField(doc, 'total')!;
    expect(tot.value.normalized.value).toBe(total);
    expect(tot.value.page).toBe(3);

    const t = doc.tables[0];
    expect(t.name).toBe('lines');
    expect(t.columns).toEqual(['sku', 'item', 'qty', 'price', 'lineTotal']);
    expect(t.headers.map((h) => h.page)).toEqual([1, 2, 3]);
    expect(t.pages).toEqual([1, 2, 3]);
    const data = t.rows.filter((r) => r.kind === 'data');
    expect(data).toHaveLength(46);
    expect(data.map((r) => r.cells.sku.raw)).toEqual(lines.map((l) => l.sku));
    // wrapped cell stitched
    expect(data[3].cells.item.raw).toBe('Premium widget with an extended warranty and on-site service');
    expect(data[3].lineCount).toBe(2);
    // accounting negative
    const disc = data[45];
    expect(disc.cells.price.raw).toBe('(25.00)');
    expect(disc.cells.lineTotal.normalized.value).toBe(-25);
    // typed cells, right-aligned numbers assigned to the right columns
    expect(data[0].cells.qty.normalized).toEqual({ kind: 'number', value: 1 });
    expect(data[10].cells.lineTotal.raw).toBe(lines[10].total);
    expect(data[0].cells.sku.bbox.x).toBe(50);
    // total row tagged, footer and "continued" lines not part of the table
    expect(t.rows.at(-1)!.kind).toBe('total');
    expect(t.rows.some((r) => Object.values(r.cells).some((c) => /Generated|continued/.test(c.raw)))).toBe(false);
    // footing
    const foot = footingFromTable(t, 'lineTotal');
    expect(foot.passed).toBe(true);
    expect(tableRecords(t)[0]).toEqual({ sku: 'SKU-001', item: 'Item number 1', qty: '1', price: '10.00', lineTotal: '10.00' });
  });

  it('stops at a terminator and reads values below labels', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([595, 842]);
    const f = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText('Account Holder', { x: 50, y: 800, size: 10, font: f });
    page.drawText('Jane Q. Public', { x: 50, y: 786, size: 10, font: f });
    page.drawText('Code', { x: 50, y: 740, size: 10, font: f });
    page.drawText('Amount', { x: 200, y: 740, size: 10, font: f });
    page.drawText('A1', { x: 50, y: 724, size: 10, font: f });
    page.drawText('1.234,50', { x: 200, y: 724, size: 10, font: f });
    page.drawText('A2', { x: 50, y: 710, size: 10, font: f });
    page.drawText('-7,00', { x: 200, y: 710, size: 10, font: f });
    page.drawText('Notes', { x: 50, y: 696, size: 10, font: f });
    page.drawText('B9', { x: 50, y: 682, size: 10, font: f });
    page.drawText('99,00', { x: 200, y: 682, size: 10, font: f });
    const doc = await extractPdf(await pdf.save());
    const { fields, findings } = extractFields(doc, [{ name: 'holder', label: 'Account Holder', readFrom: 'below' }]);
    expect(findings).toEqual([]);
    expect(fields[0].value.raw).toBe('Jane Q. Public');
    const { tables } = extractTables(doc, [{ name: 't', columns: [{ name: 'Code' }, { name: 'Amount', type: 'number' }], terminator: '^Notes' }], { locale: 'de' });
    expect(tables[0].rows.map((r) => r.cells.Amount.normalized.value)).toEqual([1234.5, -7]);
    expect(tables[0].terminatedBy).toContain('Notes');
  });

  it('missing header / missing field / empty table are error findings, never silent', async () => {
    const bytes = await makeInvoicePdf({ invoiceNo: 'INV-1', customer: 'C', date: '2024-01-01', lines: sampleLines(2), total: '0.00', noHeader: true });
    const doc = await extractPdf(bytes);
    applyTemplate(doc, parseTemplate(INVOICE_TEMPLATE));
    expect(doc.findings.map((f) => f.code)).toContain('TABLE_HEADER_NOT_FOUND');
    expect(doc.tables).toHaveLength(0);
    const r = extractFields(doc, [{ name: 'po', label: 'PO Number' }]);
    expect(r.findings[0]).toMatchObject({ code: 'FIELD_NOT_FOUND', severity: 'error' });

    const empty = await extractPdf(await makeInvoicePdf({ invoiceNo: 'INV-2', customer: 'C', date: '2024-01-01', lines: [], total: '0.00' }));
    const t = extractTables(empty, parseTemplate(INVOICE_TEMPLATE).tables);
    expect(t.findings.map((f) => f.code)).toContain('TABLE_EMPTY');
  });

  it('rejects invalid templates with a clear error', () => {
    expect(() => parseTemplate('fields: [{ name: x }]')).toThrow(/label.*regex/);
    expect(() => parseTemplate('fields: [{ name: x, regex: "(" }]')).toThrow(/Invalid regex/);
  });

  it('regex field specs read named groups', async () => {
    const bytes = await makeInvoicePdf({ invoiceNo: 'INV-77', customer: 'C', date: '2024-01-01', lines: [], total: '0.00', extraText: ['Reference: PO-55-AB (urgent)'] });
    const doc = await extractPdf(bytes);
    const r = extractFields(doc, [{ name: 'po', regex: 'Reference:\\s*(?<value>PO-[\\w-]+)' }]);
    expect(r.fields[0].value.raw).toBe('PO-55-AB');
  });
});
