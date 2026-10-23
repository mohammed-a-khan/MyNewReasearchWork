import { describe, expect, it } from '../support/testkit.js';
import { escapeHtml, reconcile, renderHtml, toJson } from '../../src/docs/index.js';

const expected = [
  { id: 'A1', name: '<script>alert(1)</script>', amount: '1,000.00' },
  { id: 'A2', name: 'Carol', amount: '50.00' },
];
const actual = [
  { id: 'A1', name: 'Bob & "Co"', amount: 1250 },
  { id: 'A3', name: 'x', amount: 1 },
];

describe('reports', () => {
  it('HTML is self-contained, escaped and filterable by finding type', () => {
    const r = reconcile(expected, actual, { key: 'id', footing: [{ side: 'expected', column: 'amount', printedTotal: '1,050.00' }] });
    const html = renderHtml(r, { title: 'Recon <1>' });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Recon &lt;1&gt;</title>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Bob &amp; &quot;Co&quot;');
    expect(html).not.toMatch(/<(link|img)\b|src=|href="http/);
    expect(html).toContain('data-filter="MISMATCH"');
    expect(html).toContain('data-filter="MISSING"');
    expect(html).toContain('data-filter="EXTRA"');
    expect(html).toMatch(/<tr data-type="MISMATCH">/);
    expect(escapeHtml(`'"&<>\``)).toBe('&#39;&quot;&amp;&lt;&gt;&#96;');
  });

  it('maskValue hides business values in HTML and JSON', () => {
    const r = reconcile(expected, actual, { key: 'id', footing: [{ side: 'actual', column: 'amount', printedTotal: '9,999.00' }] });
    const html = renderHtml(r, { maskValue: true });
    const json = toJson(r, { maskValue: true });
    for (const v of ['1,000.00', '1250', '9999', 'alert(1)']) {
      expect(html).not.toContain(v);
      expect(json).not.toContain(v);
    }
    expect(html).toContain('•••');
    const custom = toJson(r, { maskValue: (v, { field }) => `[${field}:${v.length}]` });
    expect(custom).toContain('[amount:8]');
    // unmasked JSON keeps values
    expect(toJson(r)).toContain('1,000.00');
  });

  it('JSON output is deterministic (sorted keys, sorted findings)', () => {
    const a = toJson(reconcile(expected, actual, { key: 'id' }));
    const b = toJson(reconcile([...expected].reverse(), [...actual].reverse(), { key: 'id' }));
    expect(a).toBe(b);
    const parsed = JSON.parse(a);
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
    expect(parsed.findings.map((f: { key: string }) => f.key)).toEqual(['a1', 'a1', 'a2', 'a3']);
  });
});
