import { describe, expect, it } from '../support/testkit.js';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bulkCompare, changeSignature, COMMON_MASKS, diffPdfs, diffSequences, extractPdf, renderHtml } from '../../src/docs/index.js';
import { INVOICE_TEMPLATE, makeInvoicePdf, sampleLines, type InvoiceSpec } from './helpers.js';

const base = (over: Partial<InvoiceSpec> = {}): InvoiceSpec => ({
  invoiceNo: 'INV-5001',
  customer: 'Contoso Ltd',
  date: '2024-05-01',
  lines: sampleLines(3),
  total: '1,200.00',
  footer: 'Generated 2024-05-01 10:00',
  ...over,
});

describe('diffPdfs', () => {
  it('identical documents (except masked footer date) have no significant changes', async () => {
    const a = await makeInvoicePdf(base());
    const b = await makeInvoicePdf(base({ footer: 'Generated 2024-06-30 23:59' }));
    const unmasked = await diffPdfs(a, b);
    expect(unmasked.identical).toBe(false);
    expect(unmasked.changes.map((c) => c.category)).toEqual(['text-changed']);

    const r = await diffPdfs(a, b, { masks: [COMMON_MASKS.isoDate, COMMON_MASKS.time] });
    expect(r.identical).toBe(true);
    expect(r.summary.masked).toBe(1);
    expect(r.changes[0].description).toContain('Generated ‹date› ‹time›');
  });

  it('reports field-level, table-row and metadata changes with values', async () => {
    const lines = sampleLines(3);
    const a = await extractPdf(await makeInvoicePdf(base({ lines })), { template: INVOICE_TEMPLATE });
    const changedLines = [lines[0], { ...lines[1], qty: '9' }, { sku: 'SKU-777', item: 'New thing', qty: '1', price: '5.00', total: '5.00' }];
    const b = await extractPdf(await makeInvoicePdf(base({ lines: changedLines, total: '1,250.00', title: 'Invoice INV-5001 (rev 2)' })), {
      template: INVOICE_TEMPLATE,
    });
    const r = await diffPdfs(a, b, { tableKeys: { lines: 'sku' } });
    const d = r.changes.map((c) => `${c.category}|${c.description}`);
    expect(d).toContain('metadata|Metadata title: "Invoice INV-5001" → "Invoice INV-5001 (rev 2)"');
    expect(d).toContain('field-changed|total: 1,200.00 → 1,250.00');
    expect(d).toContain('row-changed|lines[sku-002].qty: 2 → 9');
    expect(d).toContain('row-removed|lines: row sku-003 removed');
    expect(d).toContain('row-added|lines: row sku-777 added');
    // lines covered by field/row changes are not reported again as text changes
    expect(r.summary['text-changed']).toBe(0);
    expect(r.identical).toBe(false);
  });

  it('auto-detects "Label: value" fields without a template', async () => {
    const a = await makeInvoicePdf(base());
    const b = await makeInvoicePdf(base({ customer: 'Fabrikam Inc', total: '1,250.00' }));
    const r = await diffPdfs(a, b);
    const d = r.changes.map((c) => c.description);
    expect(d).toContain('Customer: Contoso Ltd → Fabrikam Inc');
    expect(d).toContain('Total: 1,200.00 → 1,250.00');
  });

  it('reports page count changes', async () => {
    const a = await makeInvoicePdf(base({ lines: sampleLines(5), rowsPerPage: 10 }));
    const b = await makeInvoicePdf(base({ lines: sampleLines(15), rowsPerPage: 10 }));
    const r = await diffPdfs(a, b, { masks: [COMMON_MASKS.isoDate] });
    expect(r.changes[0]).toMatchObject({ category: 'page-count', description: 'Page count: 1 → 2' });
    const html = renderHtml(r);
    expect(html).toContain('page-count');
  });

  it('LCS line diff', () => {
    const ops = diffSequences(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']);
    const a = ['a', 'b', 'c', 'd'];
    const b = ['a', 'x', 'c', 'd', 'e'];
    // Replaying the script on A yields B.
    const rebuilt = ops.flatMap((o) => (o.op === 'eq' ? [a[o.i]] : o.op === 'ins' ? [b[o.j]] : []));
    expect(rebuilt).toEqual(b);
    const eq = ops.filter((o) => o.op === 'eq').length;
    expect(eq).toBe(3);
    expect(ops.filter((o) => o.op === 'ins').length).toBe(2);
    expect(ops.filter((o) => o.op === 'del').length).toBe(1);
  });
});

describe('bulkCompare', () => {
  it('pairs files by name and clusters changes by pattern signature', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezbulk-'));
    const A = join(root, 'a');
    const B = join(root, 'b');
    await mkdir(A);
    await mkdir(B);
    // 6 documents: all get a new footer timestamp (masked); 2 also get a changed total; one only in A.
    for (let i = 1; i <= 6; i++) {
      const spec = base({ invoiceNo: `INV-${6000 + i}`, customer: `Customer ${i}`, total: `${i},000.00` });
      await writeFile(join(A, `inv-${i}.pdf`), await makeInvoicePdf(spec));
      const changed = i === 2 || i === 5 ? { total: `${i},010.00` } : {};
      await writeFile(join(B, `inv-${i}.pdf`), await makeInvoicePdf({ ...spec, footer: `Generated 2024-07-0${i} 08:1${i}`, ...changed }));
    }
    await writeFile(join(A, 'orphan.pdf'), await makeInvoicePdf(base()));
    await writeFile(join(A, 'notes.txt'), 'ignored');

    const r = await bulkCompare(A, B, { masks: [COMMON_MASKS.isoDate, COMMON_MASKS.time] });
    expect(r.pairs).toBe(6);
    expect(r.identical).toBe(4);
    expect(r.different).toBe(2);
    expect(r.onlyInA).toEqual(['orphan.pdf']);
    expect(r.status).toBe('FAIL');
    const desc = r.clusters.map((c) => c.description);
    expect(desc[0]).toMatch(/^6 documents: masked: Line changed only in masked parts: "Generated ‹date› ‹time› Page <n> of <n>" \(masked\)$/);
    const total = r.clusters.find((c) => c.category === 'field-changed')!;
    expect(total.count).toBe(2);
    expect(total.signature).toBe('field-changed: Total: <n> → <n>');
    expect(total.examples).toEqual(['inv-2.pdf', 'inv-5.pdf']);
    expect(r.clusters.find((c) => c.category === 'only-in-a')!.documents).toEqual(['orphan.pdf']);
    const html = renderHtml(r);
    expect(html).toContain('6 documents: masked');
    expect(html).toContain('data-filter="field-changed"');
  });

  it('change signatures generalize numbers, dates and ids', () => {
    expect(
      changeSignature({ category: 'text-changed', subject: 'x', description: 'Line changed: "INV-123 on 2024-01-01 total 1,200.00" → "INV-456 on 2024-02-02 total 9.99"' }),
    ).toBe('text-changed: Line changed: "<id> on <date> total <n>" → "<id> on <date> total <n>"');
  });
});
