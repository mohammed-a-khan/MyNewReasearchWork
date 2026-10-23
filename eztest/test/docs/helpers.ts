import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';

export interface InvoiceLine {
  sku: string;
  /** Item text; an array prints a wrapped cell (one entry per physical line). */
  item: string | string[];
  qty: string;
  price: string;
  total: string;
}

export interface InvoiceSpec {
  invoiceNo: string;
  customer: string;
  date: string;
  lines: InvoiceLine[];
  total: string;
  rowsPerPage?: number;
  /** Footer text printed on every page (e.g. "Generated 2024-05-01"). */
  footer?: string;
  extraText?: string[];
  title?: string;
  author?: string;
  /** Omit the table header (to test "missing header" handling). */
  noHeader?: boolean;
}

function right(page: PDFPage, font: PDFFont, s: string, xRight: number, y: number, size = 10) {
  page.drawText(s, { x: xRight - font.widthOfTextAtSize(s, size), y, size, font });
}

/** Invoice-like PDF: fields at the top, a line-item table that may span pages with a repeated header. */
export async function makeInvoicePdf(spec: InvoiceSpec): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(spec.title ?? `Invoice ${spec.invoiceNo}`);
  pdf.setAuthor(spec.author ?? 'EZ Test Suite');
  pdf.setCreationDate(new Date('2024-05-01T10:00:00Z'));
  pdf.setModificationDate(new Date('2024-05-01T10:00:00Z'));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const perPage = spec.rowsPerPage ?? 100;
  const pageCount = Math.max(1, Math.ceil(spec.lines.length / perPage));
  let page = pdf.addPage([595, 842]);
  let y = 790;
  const header = () => {
    if (spec.noHeader) return;
    page.drawText('SKU', { x: 50, y, size: 10, font: bold });
    page.drawText('Item', { x: 120, y, size: 10, font: bold });
    right(page, bold, 'Qty', 352, y);
    right(page, bold, 'Unit Price', 435, y);
    right(page, bold, 'Line Total', 535, y);
    y -= 16;
  };
  const footer = (n: number) => {
    if (spec.footer) page.drawText(`${spec.footer}   Page ${n} of ${pageCount}`, { x: 50, y: 30, size: 8, font });
  };
  page.drawText('ACME Corp - Invoice', { x: 50, y, size: 18, font: bold });
  y -= 30;
  page.drawText('Invoice No:', { x: 50, y, size: 10, font });
  page.drawText(spec.invoiceNo, { x: 150, y, size: 10, font });
  y -= 14;
  page.drawText('Customer:', { x: 50, y, size: 10, font });
  page.drawText(spec.customer, { x: 150, y, size: 10, font });
  y -= 14;
  page.drawText('Invoice Date:', { x: 50, y, size: 10, font });
  page.drawText(spec.date, { x: 150, y, size: 10, font });
  y -= 14;
  page.drawText('Bill To', { x: 350, y: 760, size: 10, font: bold });
  page.drawText('Accounts Payable Dept', { x: 350, y: 746, size: 10, font });
  y -= 20;
  for (const t of spec.extraText ?? []) {
    page.drawText(t, { x: 50, y, size: 10, font });
    y -= 14;
  }
  y -= 10;
  header();
  let pageNo = 1;
  spec.lines.forEach((l, i) => {
    if (i > 0 && i % perPage === 0) {
      footer(pageNo);
      page = pdf.addPage([595, 842]);
      pageNo++;
      y = 800;
      page.drawText(`Invoice ${spec.invoiceNo} (continued)`, { x: 50, y, size: 9, font });
      y -= 24;
      header();
    }
    page.drawText(l.sku, { x: 50, y, size: 10, font });
    const items = Array.isArray(l.item) ? l.item : [l.item];
    page.drawText(items[0], { x: 120, y, size: 10, font });
    right(page, font, l.qty, 352, y);
    right(page, font, l.price, 435, y);
    right(page, font, l.total, 535, y);
    y -= 12;
    for (const extra of items.slice(1)) {
      page.drawText(extra, { x: 120, y, size: 10, font });
      y -= 12;
    }
    y -= 2;
  });
  y -= 8;
  page.drawText('Total:', { x: 380, y, size: 10, font: bold });
  right(page, bold, spec.total, 535, y);
  y -= 30;
  page.drawText('Payment terms: 30 days net. Thank you for your business.', { x: 50, y, size: 9, font });
  footer(pageNo);
  return pdf.save();
}

export const INVOICE_TEMPLATE = `
name: acme-invoice
locale: en
fields:
  - { name: invoiceNo, label: "Invoice No", readFrom: right }
  - { name: customer, label: Customer, readFrom: right }
  - { name: date, label: "Invoice Date", type: date }
  - { name: total, label: Total, type: currency }
tables:
  - name: lines
    key: sku
    columns:
      - { name: sku, header: SKU }
      - { name: item, header: [Item, Description] }
      - { name: qty, header: Qty, type: number }
      - { name: price, header: "Unit Price", type: currency }
      - { name: lineTotal, header: "Line Total", type: currency }
    terminator: "^Payment terms"
`;

export function sampleLines(n: number): InvoiceLine[] {
  return Array.from({ length: n }, (_, i) => {
    const qty = (i % 4) + 1;
    const price = 10 + i * 1.25;
    return {
      sku: `SKU-${String(i + 1).padStart(3, '0')}`,
      item: `Item number ${i + 1}`,
      qty: String(qty),
      price: price.toFixed(2),
      total: (qty * price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    };
  });
}

export function sumTotals(lines: InvoiceLine[]): number {
  return Math.round(lines.reduce((s, l) => {
    const neg = /^\(.*\)$/.test(l.total);
    const v = Number(l.total.replace(/[(),]/g, ''));
    return s + (neg ? -v : v);
  }, 0) * 100) / 100;
}

export function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
