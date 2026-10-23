import { describe, expect, it } from '../support/testkit.js';
import { checkFooting, compareValues, fromCsv, fromDbRows, reconcile } from '../../src/docs/index.js';

const db = [
  { order_id: 1, line: 1, sku: 'SKU-100', name: 'Widget', qty: 2, amount: 39.98, ship_date: '2024-01-15' },
  { order_id: 1, line: 2, sku: 'SKU-200', name: 'Gadget Pro', qty: 1, amount: 49.5, ship_date: '2024-01-16' },
  { order_id: 2, line: 1, sku: 'SKU-300', name: 'Doohickey', qty: 4, amount: 21, ship_date: '2024-01-17' },
];

describe('reconcile', () => {
  it('joins on composite keys across differently named columns; formatting differences pass', () => {
    const csv = fromCsv(
      'Order,Line,Item,Description,Quantity,Amount,Shipped\n1,1,SKU-100,Widget,2,"$39.98",15 Jan 2024\n1,2,SKU-200,Gadget Pro,1,49.50,2024-01-16\n2,1,SKU-300,Doohickey,4,"21.00",17.01.2024\n',
    );
    const r = reconcile(fromDbRows(db), csv, {
      key: ['order_id', 'line'],
      fieldMap: { order_id: 'Order', line: 'Line', sku: 'Item', name: 'Description', qty: 'Quantity', amount: 'Amount', ship_date: 'Shipped' },
      types: { amount: 'currency', ship_date: 'date' },
    });
    expect(r.status).toBe('PASS');
    expect(r.summary.matchedRows).toBe(3);
    expect(r.summary.fieldsCompared).toBe(15);
    expect(r.summary.counts.MISMATCH).toBe(0);
    expect(r.summary.counts.FORMAT_ONLY).toBeGreaterThan(0);
    expect(r.findings.find((f) => f.key === '1|1' && f.column === 'ship_date')?.type).toBe('FORMAT_ONLY');
    expect(r.gates[0]).toMatchObject({ name: 'coverage', passed: true });
  });

  it('applies tolerances (absolute and relative) and fuzzy text thresholds', () => {
    const actual = [
      { order_id: 1, line: 1, sku: 'SKU-100', name: 'Widget', qty: 2, amount: 39.99, ship_date: '2024-01-15' },
      { order_id: 1, line: 2, sku: 'SKU-200', name: 'Gadget-Pro', qty: 1, amount: 49.6, ship_date: '2024-01-16' },
      { order_id: 2, line: 1, sku: 'SKU-300', name: 'Thingamajig', qty: 4, amount: 25, ship_date: '2024-01-17' },
    ];
    const r = reconcile(db, actual, {
      key: ['order_id', 'line'],
      tolerances: { amount: { abs: 0.01, rel: 0.003 } },
      fuzzy: { name: 0.85 },
    });
    const by = (k: string, c: string) => r.findings.find((f) => f.key === k && f.column === c)!;
    expect(by('1|1', 'amount')).toMatchObject({ type: 'WITHIN_TOLERANCE', delta: 0.01 });
    expect(by('1|2', 'amount').type).toBe('WITHIN_TOLERANCE'); // 0.1 <= 0.3% of 49.5
    expect(by('2|1', 'amount')).toMatchObject({ type: 'MISMATCH', delta: 4 });
    expect(by('1|2', 'name').type).toBe('WITHIN_TOLERANCE');
    expect(by('1|2', 'name').similarity).toBeGreaterThanOrEqual(0.85);
    expect(by('2|1', 'name').type).toBe('MISMATCH');
    expect(r.status).toBe('FAIL');
  });

  it('reports missing, extra and duplicate keys, and honours known differences', () => {
    const actual = [
      { order_id: 1, line: 1, sku: 'SKU-100', name: 'Widget', qty: 3, amount: 39.98, ship_date: '2024-01-15' },
      { order_id: 9, line: 1, sku: 'SKU-900', name: 'Extra', qty: 1, amount: 1, ship_date: '2024-01-15' },
      { order_id: 2, line: 1, sku: 'SKU-300', name: 'Doohickey', qty: 4, amount: 21, ship_date: '2024-01-17' },
      { order_id: 2, line: 1, sku: 'SKU-300', name: 'Doohickey', qty: 4, amount: 21, ship_date: '2024-01-17' },
    ];
    const r = reconcile(db, actual, { key: ['order_id', 'line'] });
    const types = r.findings.filter((f) => f.type !== 'MATCH').map((f) => `${f.type}:${f.key}${f.column ? ':' + f.column : ''}`);
    expect(types).toEqual(['MISMATCH:1|1:qty', 'MISSING:1|2', 'DUPLICATE_KEY:2|1', 'EXTRA:9|1']);
    expect(r.status).toBe('FAIL');

    const r2 = reconcile(db, actual.slice(0, 1).concat(actual.slice(2, 3)), {
      key: ['order_id', 'line'],
      knownDifferences: [
        { key: '^1\\|1$', column: 'qty', reason: 'JIRA-12: qty rounding in legacy export' },
        { key: '^1\\|2$', column: '*', reason: 'line 2 not migrated yet' },
      ],
    });
    expect(r2.status).toBe('PASS');
    const kd = r2.findings.filter((f) => f.type === 'KNOWN_DIFFERENCE');
    expect(kd.map((f) => f.reason)).toEqual(['JIRA-12: qty rounding in legacy export', 'line 2 not migrated yet']);
  });

  it('empty extraction fails: nothing passes on zero rows or zero compared fields', () => {
    const r = reconcile(db, [], { key: ['order_id', 'line'] });
    expect(r.status).toBe('FAIL');
    expect(r.gates[0]).toMatchObject({ name: 'coverage', passed: false });
    expect(r.gates[0].message).toMatch(/actual has no rows/);

    const both = reconcile([], [], { key: 'id' });
    expect(both.status).toBe('FAIL');
    expect(both.summary.fieldsCompared).toBe(0);

    // rows join, but no column overlaps -> zero fields compared -> FAIL
    const noCols = reconcile([{ id: 1, a: 1 }], [{ id: 1, b: 1 }], { key: 'id' });
    expect(noCols.status).toBe('FAIL');
    expect(noCols.gates[0].message).toMatch(/zero fields compared/);
    expect(noCols.summary.skippedColumns).toEqual(['a']);
  });

  it('detects footing failures and checksum differences', () => {
    const r = reconcile(db, db, {
      key: ['order_id', 'line'],
      footing: [{ column: 'amount', printedTotal: '120.48' }],
      checksum: [{ column: 'amount' }],
    });
    const foot = r.gates.find((g) => g.name.startsWith('footing'))!;
    expect(foot.passed).toBe(false);
    expect(foot.details).toMatchObject({ printedTotal: 120.48, sum: 110.48, delta: 10 });
    expect(r.gates.find((g) => g.name === 'checksum:amount')!.passed).toBe(true);
    expect(r.status).toBe('FAIL');

    expect(checkFooting(db, 'amount', '110.48').passed).toBe(true);
    expect(checkFooting([], 'amount', '0.00').passed).toBe(false);
    expect(checkFooting(db, 'amount', 'n/a').passed).toBe(false);
  });

  it('findings are sorted deterministically by key then column', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: `R${12 - i}`, v: i }));
    const r = reconcile(rows, rows, { key: 'id' });
    expect(r.findings.map((f) => f.key)).toEqual(Array.from({ length: 12 }, (_, i) => `r${i + 1}`));
  });

  it('compareValues never equates a date with a number', () => {
    expect(compareValues('2024-01-15', 20240115).type).toBe('MISMATCH');
    expect(compareValues('(1,234.50)', -1234.5).type).toBe('FORMAT_ONLY');
    expect(compareValues('n/a', null).type).toBe('FORMAT_ONLY');
    expect(compareValues('1.234,50', '1234.5', { locale: 'de' }).type).toBe('MISMATCH');
    expect(compareValues('1.234,50', '1234.5', { locale: 'de', actualLocale: 'en' }).type).toBe('FORMAT_ONLY');
  });
});
