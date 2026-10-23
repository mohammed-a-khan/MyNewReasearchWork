import { afterEach, describe, expect, it } from '../support/testkit.js';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { extractPdf, reconcileThreeWay, renderHtml, toJson, type ThreeWayMapping } from '../../src/docs/index.js';

const DEMO_TEMPLATE = {
  fields: [
    { name: 'invoiceNo', label: 'Invoice No', readFrom: 'right' as const },
    { name: 'customer', label: 'Customer' },
    { name: 'date', label: 'Date', type: 'date' as const },
    { name: 'total', label: 'Total', type: 'currency' as const },
  ],
  tables: [
    {
      name: 'lines',
      key: 'SKU',
      columns: [
        'SKU',
        'Item',
        { name: 'Qty', type: 'number' as const },
        { name: 'Unit Price', type: 'currency' as const },
        { name: 'Line Total', type: 'currency' as const },
      ],
    },
  ],
};

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Drive the demo app over HTTP like a user: log in, create an order, read the page and download the invoice. */
async function placeOrder(app: DemoServer, product: string, qty: number) {
  const login = await fetch(`${app.url}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'bob', password: 'Builder#2' }),
    redirect: 'manual',
  });
  expect(login.status).toBe(302);
  expect(login.headers.get('location')).toBe('/dashboard');
  const sid = /ezsid=([a-f0-9]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1];
  expect(sid).toBeTruthy();
  const cookie = `ezsid=${sid}`;

  const created = await fetch(`${app.url}/orders/new`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ customer: '1', product, qty: String(qty) }),
    redirect: 'manual',
  });
  expect(created.status).toBe(302);
  const loc = created.headers.get('location') ?? '';
  const id = Number(/^\/orders\/(\d+)\?created=1$/.exec(loc)?.[1]);
  expect(id).toBeGreaterThan(0);

  const html = await (await fetch(`${app.url}${loc}`, { headers: { cookie } })).text();
  const ui: Record<string, string> = {};
  for (const m of html.matchAll(/data-testid="([^"]+)"[^>]*>([^<]*)</g)) ui[m[1]] = decodeEntities(m[2]).trim();
  expect(Object.keys(ui)).toEqual(expect.arrayContaining(['order-number', 'order-customer', 'order-status', 'order-total']));

  const pdfRes = await fetch(`${app.url}/orders/${id}/invoice.pdf`, { headers: { cookie } });
  expect(pdfRes.headers.get('content-type')).toBe('application/pdf');
  const pdf = new Uint8Array(await pdfRes.arrayBuffer());

  const order = app.db
    .prepare('SELECT o.id, c.name AS customer, o.status, o.total, o.created_at FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?')
    .get(id) as Record<string, unknown>;
  const lines = app.db.prepare('SELECT sku, name, qty, unit_price, line_total FROM order_lines WHERE order_id = ? ORDER BY id').all(id) as Array<
    Record<string, unknown>
  >;
  return { id, ui, pdf, order, lines };
}

function mapping(dbLines: Array<Record<string, unknown>>): ThreeWayMapping {
  return {
    fields: [
      { name: 'orderNumber', ui: { key: 'order-number', pattern: 'ORD-(\\d+)' }, pdf: { key: 'invoiceNo', pattern: 'INV-(\\d+)' }, db: 'id', type: 'number' },
      { name: 'customer', ui: 'order-customer', pdf: 'customer', db: 'customer', type: 'text' },
      { name: 'orderDate', pdf: 'date', db: 'created_at', type: 'date' },
      { name: 'total', ui: 'order-total', pdf: 'total', db: 'total', type: 'currency', tolerance: { abs: 0.005 } },
    ],
    lines: {
      pdfTable: 'lines',
      dbRows: dbLines,
      key: 'SKU',
      fieldMap: { SKU: 'sku', Item: 'name', Qty: 'qty', 'Unit Price': 'unit_price', 'Line Total': 'line_total' },
    },
    footing: { pdfTable: 'lines', column: 'Line Total' },
  };
}

describe('three-way reconciliation against the demo app (UI / PDF / DB)', () => {
  let app: DemoServer | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('normal mode: UI, document and DB all agree; line items reconcile; footing holds', async () => {
    app = await startDemoApp({ bug: 'none' });
    const { ui, pdf, order, lines } = await placeOrder(app, 'SKU-200', 3);
    const doc = await extractPdf(pdf, { template: DEMO_TEMPLATE, source: 'invoice.pdf' });
    expect(doc.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(doc.metadata.author).toBe('EZ Shop');

    const r = reconcileThreeWay({ ui, pdf: doc, db: order }, mapping(lines));
    expect(r.fields.map((f) => [f.name, f.verdict])).toEqual([
      ['orderNumber', 'ALL_AGREE'],
      ['customer', 'ALL_AGREE'],
      ['orderDate', 'ALL_AGREE'],
      ['total', 'ALL_AGREE'],
    ]);
    expect(r.fields[3].values).toMatchObject({ ui: { raw: '148.50' }, pdf: { raw: '148.50', page: 1 }, db: { raw: '148.5' } });
    expect(r.lines?.status).toBe('PASS');
    expect(r.lines?.summary.fieldsCompared).toBe(4);
    expect(r.footing?.passed).toBe(true);
    expect(r.diagnosis).toEqual([]);
    expect(r.status).toBe('PASS');
  });

  it('bug "invoice-total": the PDF is the odd one out -> document generation defect', async () => {
    app = await startDemoApp({ bug: 'invoice-total' });
    const { ui, pdf, order, lines } = await placeOrder(app, 'SKU-100', 2);
    const doc = await extractPdf(pdf, { template: DEMO_TEMPLATE, source: 'invoice.pdf' });
    const r = reconcileThreeWay({ ui, pdf: doc, db: order }, mapping(lines));
    const total = r.fields.find((f) => f.name === 'total')!;
    expect(total.verdict).toBe('ODD_ONE_OUT');
    expect(total.oddOneOut).toBe('pdf');
    expect(total.values.pdf.raw).toBe('49.98');
    expect(total.values.ui.raw).toBe('39.98');
    expect(total.diagnosis).toMatch(/document generation defect/);
    expect(r.fields.filter((f) => f.name !== 'total').every((f) => f.verdict === 'ALL_AGREE')).toBe(true);
    // the line items themselves are right; the printed total does not foot
    expect(r.lines?.status).toBe('PASS');
    expect(r.footing?.passed).toBe(false);
    expect(r.status).toBe('FAIL');
    expect(r.diagnosis.join('\n')).toMatch(/total: document generation defect/);

    const html = renderHtml(r);
    expect(html).toContain('ODD_ONE_OUT');
    expect(html).toContain('document generation defect');
    const masked = renderHtml(r, { maskValue: true });
    expect(masked).not.toContain('49.98');
    expect(JSON.parse(toJson(r)).fields[3].oddOneOut).toBe('pdf');
  });

  it('insufficient data never passes', async () => {
    app = await startDemoApp();
    const { ui } = await placeOrder(app, 'SKU-300', 1);
    const r = reconcileThreeWay({ ui }, { fields: [{ name: 'total', ui: 'order-total', pdf: 'total', db: 'total' }] });
    expect(r.fields[0].verdict).toBe('INSUFFICIENT_DATA');
    expect(r.status).toBe('FAIL');
  });
});
