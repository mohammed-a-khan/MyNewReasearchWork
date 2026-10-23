/** Component adapters without a browser: dates and formats, values, sorting, the adapter catalogue and registry. */
import { describe, expect, it } from '../support/testkit.js';
import {
  adaptersFor, allAdapters, formatDate, formatFromPlaceholder, isoOf, localeFormat, parseDateText, parseWithFormat, registerComponentAdapter, DialectAdapter, toConditions, WIDGET_KINDS,
} from '../../src/runner/components/index.js';
import { normalizeFormat } from '../../src/runner/components/dates.js';
import { describeWhere, isSorted, parseNumber, sameValue } from '../../src/runner/components/util.js';
import { ENGINE_VERSION } from '../../src/runner/components/engine.js';

describe('dates', () => {
  const now = new Date(2026, 9, 22);
  it.each([
    ['15 March 2027', '2027-03-15'],
    ['March 15, 2027', '2027-03-15'],
    ['15th of March 2027', '2027-03-15'],
    ['Mar 15 2027', '2027-03-15'],
    ['2027-03-15', '2027-03-15'],
    ['2027/3/5', '2027-03-05'],
    ['15.03.2027', '2027-03-15'],
    ['25/12/2027', '2027-12-25'],
    ['12/25/2027', '2027-12-25'],
    ['today', '2026-10-22'],
    ['tomorrow', '2026-10-23'],
    ['today + 3 days', '2026-10-25'],
    ['today - 1 week', '2026-10-15'],
    ['in 2 months', '2026-12-22'],
  ])('reads "%s"', (text, iso) => {
    expect(isoOf(parseDateText(text, now))).toBe(iso);
  });

  it('refuses ambiguous and impossible dates', () => {
    expect(() => parseDateText('03/04/2027')).toThrow(/ambiguous/);
    expect(() => parseDateText('31 February 2027')).toThrow(/not a valid date/);
    expect(() => parseDateText('soon')).toThrow(/cannot read "soon" as a date/);
  });

  it('normalises display formats from placeholders and locales', () => {
    expect(formatFromPlaceholder('MM/DD/YYYY')).toBe('MM/dd/yyyy');
    expect(formatFromPlaceholder('TT.MM.JJJJ')).toBe('dd.MM.yyyy');
    expect(formatFromPlaceholder('dd.mm.yyyy')).toBe('dd.MM.yyyy');
    expect(formatFromPlaceholder('MMM d, y')).toBe('MMM d, yyyy');
    expect(formatFromPlaceholder('Search')).toBeUndefined();
    expect(normalizeFormat('d.M.y')).toBe('d.M.yyyy');
    expect(localeFormat('en-US')).toBe('MM/dd/yyyy');
    expect(localeFormat('de-DE')).toBe('dd.MM.yyyy');
    expect(localeFormat('en-GB')).toBe('dd/MM/yyyy');
  });

  it('formats and parses in a format and locale', () => {
    const d = { y: 2027, m: 2, d: 5 };
    expect(formatDate(d, 'M/d/yyyy', 'en-US')).toBe('3/5/2027');
    expect(formatDate(d, 'dd.MM.yyyy', 'de-DE')).toBe('05.03.2027');
    expect(formatDate(d, 'MMM d, yyyy', 'en-US')).toBe('Mar 5, 2027');
    expect(formatDate(d, 'd. MMMM yyyy', 'de-DE')).toBe('5. März 2027');
    expect(parseWithFormat('5. März 2027', 'd. MMMM yyyy', 'de-DE')).toEqual(d);
    expect(parseWithFormat('03/05/2027', 'MM/dd/yyyy')).toEqual(d);
    expect(parseWithFormat('3/5/2027', 'MM/dd/yyyy')).toEqual(d);
    expect(parseWithFormat('2027-03-05', 'MM/dd/yyyy')).toBeUndefined();
  });
});

describe('values and order', () => {
  it('compares numbers by value whatever the formatting', () => {
    expect(sameValue('150.00', '150')).toBe(true);
    expect(sameValue('$1,234.50', '1234.5')).toBe(true);
    expect(sameValue('1.234,50 €', '1234.50')).toBe(true);
    expect(sameValue('Contoso', 'contoso')).toBe(false);
    expect(sameValue('  Contoso Ltd ', 'Contoso Ltd')).toBe(true);
    expect(parseNumber('(42)')).toBe(-42);
    expect(parseNumber('1,234')).toBe(1234);
    expect(parseNumber('1,5')).toBe(1.5);
    expect(parseNumber('n/a')).toBeNull();
  });

  it('checks sort order numerically or by text', () => {
    expect(isSorted(['9.00', '10.00', '100.00'], 'asc').ok).toBe(true);
    expect(isSorted(['b', 'a'], 'asc')).toEqual({ ok: false, at: 1 });
    expect(isSorted(['Zeta', 'alpha'], 'desc').ok).toBe(true);
    expect(isSorted(['item 2', 'item 10'], 'asc').ok).toBe(true);
  });

  it('describes and builds row conditions', () => {
    expect(describeWhere([{ column: 'Customer', value: 'Contoso' }, { column: 'Amount', op: 'gt', value: '10' }])).toBe('Customer = "Contoso" and Amount > "10"');
    expect(toConditions({ Id: 42, Status: 'Open' })).toEqual([{ column: 'Id', op: 'equals', value: '42' }, { column: 'Status', op: 'equals', value: 'Open' }]);
  });
});

describe('adapter catalogue', () => {
  it('has adapters for every widget kind the docs list, generic ARIA last', () => {
    for (const kind of ['grid', 'combobox', 'datepicker', 'tree', 'tabs', 'accordion', 'richtext', 'slider', 'dropzone'] as const) {
      const list = adaptersFor(kind);
      expect(list.length, kind).toBeGreaterThan(1);
      expect(list[list.length - 1].fixture === 'aria' || list[list.length - 1].id === 'native' || list[list.length - 1].id === 'aria', kind).toBe(true);
    }
    const libs = new Set(allAdapters().map((a) => a.id));
    for (const lib of ['ag-grid', 'mui', 'kendo', 'devextreme', 'primeng', 'primefaces', 'angular-material', 'oracle-jet', 'sap-ui5', 'salesforce', 'd365', 'tinymce', 'quill', 'ckeditor', 'nouislider', 'aria']) expect(libs.has(lib), lib).toBe(true);
    expect(WIDGET_KINDS).toContain('chart');
    expect(ENGINE_VERSION).toMatch(/^ezc-/);
  });

  it('tries custom adapters first and can remove them', () => {
    const custom = new DialectAdapter('grid', 'acme', 'ACME Grid', 'emulated', { id: 'acme-grid', root: '.acme-grid', headerCell: '.acme-h', row: '.acme-r', cell: '.acme-c' });
    const off = registerComponentAdapter(custom);
    expect(adaptersFor('grid')[0]).toBe(custom);
    off();
    expect(adaptersFor('grid')).not.toContain(custom);
  });
});
