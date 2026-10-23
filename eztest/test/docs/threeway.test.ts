import { describe, expect, it } from '../support/testkit.js';
import { normalizeValue, reconcileThreeWay, type CanonicalDocument } from '../../src/docs/index.js';

function docWith(fields: Record<string, string>): CanonicalDocument {
  return {
    source: 'fake.pdf',
    sha256: '0'.repeat(64),
    metadata: { pageCount: 1, pageSizes: [{ width: 595, height: 842 }], encrypted: false },
    pages: [],
    tables: [],
    findings: [],
    fields: Object.entries(fields).map(([name, raw]) => ({
      name,
      type: 'text',
      value: { raw, normalized: normalizeValue(raw), page: 1, bbox: { x: 0, y: 0, width: 1, height: 1 }, method: 'text-layer', confidence: 0.9 },
    })),
  };
}

const mapping = { fields: [{ name: 'total', ui: 'total', pdf: 'total', db: 'total', type: 'currency' as const }] };

describe('three-way verdicts', () => {
  it('names the odd source and the defect class', () => {
    const ui = reconcileThreeWay({ ui: { total: '12.00' }, pdf: docWith({ total: '$10.00' }), db: { total: 10 } }, mapping);
    expect(ui.fields[0]).toMatchObject({ verdict: 'ODD_ONE_OUT', oddOneOut: 'ui' });
    expect(ui.fields[0].diagnosis).toMatch(/UI display/);
    const db = reconcileThreeWay({ ui: { total: '10.00' }, pdf: docWith({ total: '10.00' }), db: { total: 11 } }, mapping);
    expect(db.fields[0]).toMatchObject({ verdict: 'ODD_ONE_OUT', oddOneOut: 'db' });
    expect(db.fields[0].diagnosis).toMatch(/persistence defect/);
    const all = reconcileThreeWay({ ui: { total: '1' }, pdf: docWith({ total: '2' }), db: { total: 3 } }, mapping);
    expect(all.fields[0].verdict).toBe('ALL_DISAGREE');
    expect(all.status).toBe('FAIL');
  });

  it('three agreeing sources say so (not "inconclusive")', () => {
    const r = reconcileThreeWay({ ui: { total: '10.00' }, pdf: docWith({ total: '$10.00' }), db: { total: 10 } }, mapping);
    expect(r.fields[0]).toMatchObject({ verdict: 'ALL_AGREE', diagnosis: 'UI, document and DB agree' });
    expect(r.status).toBe('PASS');
  });

  it('two sources: agreement passes, disagreement is reported without guessing', () => {
    const two = reconcileThreeWay({ ui: { total: '10.00' }, db: { total: 10 } }, mapping);
    expect(two.fields[0].verdict).toBe('ALL_AGREE');
    expect(two.fields[0].values.pdf.note).toBe('source not provided');
    expect(two.status).toBe('PASS');
    const dis = reconcileThreeWay({ ui: { total: '10.00' }, db: { total: 12 } }, mapping);
    expect(dis.fields[0].verdict).toBe('DISAGREE');
    expect(dis.fields[0].oddOneOut).toBeUndefined();
  });

  it('pattern refs extract ids; a non-matching pattern is reported', () => {
    const m = { fields: [{ name: 'id', ui: { key: 'n', pattern: 'ORD-(\\d+)' }, pdf: { key: 'n', pattern: 'INV-(\\d+)' }, db: 'id', type: 'number' as const }] };
    const ok = reconcileThreeWay({ ui: { n: 'ORD-7' }, pdf: docWith({ n: 'INV-7' }), db: { id: 7 } }, m);
    expect(ok.status).toBe('PASS');
    const bad = reconcileThreeWay({ ui: { n: 'ORDER 7' }, pdf: docWith({ n: 'INV-7' }), db: { id: 7 } }, m);
    expect(bad.fields[0].values.ui.note).toBe('pattern did not match');
    expect(bad.fields[0].verdict).toBe('ALL_AGREE');
  });
});
