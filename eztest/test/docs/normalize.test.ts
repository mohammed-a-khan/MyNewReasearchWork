import { describe, expect, it } from '../support/testkit.js';
import {
  foldText,
  normalizeValue,
  parseDate,
  parseDateWithFormat,
  parseNumber,
  similarity,
  valuesEqual,
} from '../../src/docs/index.js';

describe('parseNumber', () => {
  it('handles accounting negatives, trailing minus and signs', () => {
    expect(parseNumber('(1,234.50)')?.value).toBe(-1234.5);
    expect(parseNumber('1,234.50-')?.value).toBe(-1234.5);
    expect(parseNumber('−42')?.value).toBe(-42);
    expect(parseNumber('+3.5')?.value).toBe(3.5);
    expect(parseNumber('$(1,234.50)')).toEqual({ value: -1234.5, currency: 'USD' });
    expect(parseNumber('-$12.00')).toEqual({ value: -12, currency: 'USD' });
    expect(parseNumber('((5))')).toBeUndefined();
  });

  it('handles currency symbols and ISO codes', () => {
    expect(parseNumber('€ 1.234,50', 'de')).toEqual({ value: 1234.5, currency: 'EUR' });
    expect(parseNumber('1.234,50 €')).toEqual({ value: 1234.5, currency: 'EUR' });
    expect(parseNumber('USD 99.99')).toEqual({ value: 99.99, currency: 'USD' });
    expect(parseNumber('99.99 CHF')).toEqual({ value: 99.99, currency: 'CHF' });
    expect(parseNumber('£0.5')).toEqual({ value: 0.5, currency: 'GBP' });
    expect(parseNumber('ABC 12')).toBeUndefined();
  });

  it('respects en / de / fr grouping and validates groups of three', () => {
    expect(parseNumber('1.234,50', 'de')?.value).toBe(1234.5);
    expect(parseNumber('1 234,50', 'fr')?.value).toBe(1234.5);
    expect(parseNumber('1 234,50', 'fr')?.value).toBe(1234.5);
    expect(parseNumber('1,234,567.8', 'en')?.value).toBe(1234567.8);
    expect(parseNumber("1'234.50", 'en')?.value).toBe(1234.5);
    expect(parseNumber('1.234,50', 'auto')?.value).toBe(1234.5);
    expect(parseNumber('12,5', 'auto')?.value).toBe(12.5);
    expect(parseNumber('1,234', 'auto')?.value).toBe(1234);
    expect(parseNumber('1,23,4', 'en')).toBeUndefined();
    expect(parseNumber('1.234,50', 'en')).toBeUndefined();
    expect(parseNumber('12a')).toBeUndefined();
  });

  it('parses percents', () => {
    expect(parseNumber('12.5%')).toEqual({ value: 12.5, percent: true });
    expect(normalizeValue('(3,5 %)', { locale: 'de', type: 'percent' })).toEqual({ kind: 'number', value: -3.5, percent: true });
  });
});

describe('dates', () => {
  it('never treats a date as a number', () => {
    for (const d of ['2024-01-15', '15.01.2024', '01/15/2024', '15 Jan 2024']) {
      expect(normalizeValue(d).kind).toBe('date');
      expect(parseNumber(d, 'de')).toBeUndefined();
      expect(parseNumber(d, 'en')).toBeUndefined();
    }
    expect(normalizeValue('15.01.2024', { type: 'number', locale: 'de' }).kind).toBe('text');
  });

  it('different dates are never equal; equal dates in different formats are', () => {
    const a = normalizeValue('2024-01-15');
    const b = normalizeValue('2024-01-16');
    expect(valuesEqual(a, b)).toBe(false);
    expect(valuesEqual(a, normalizeValue('15 January 2024'))).toBe(true);
    expect(valuesEqual(a, normalizeValue('Jan 15, 2024'))).toBe(true);
    expect(valuesEqual(a, normalizeValue('15.01.2024'))).toBe(true);
    expect(valuesEqual(a, normalizeValue(20240115))).toBe(false);
  });

  it('does not guess ambiguous day/month order without an explicit format', () => {
    expect(parseDate('01/02/2024')).toEqual({ ambiguous: true });
    const v = normalizeValue('01/02/2024');
    expect(v.kind).toBe('text');
    expect(v.ambiguousDate).toBe(true);
    expect(normalizeValue('01/02/2024', { dateFormats: ['DD/MM/YYYY'] })).toEqual({ kind: 'date', value: '2024-02-01' });
    expect(normalizeValue('01/02/2024', { dateFormats: ['MM/DD/YYYY'] })).toEqual({ kind: 'date', value: '2024-01-02' });
  });

  it('validates calendar dates and supports explicit formats with month names', () => {
    expect(parseDate('2023-02-29').iso).toBeUndefined();
    expect(parseDate('2024-02-29').iso).toBe('2024-02-29');
    expect(parseDateWithFormat('3. März 2024', 'D. MMMM YYYY')).toBe('2024-03-03');
    expect(parseDateWithFormat('24-12-31', 'YY-MM-DD')).toBe('2024-12-31');
    expect(parseDateWithFormat('31/04/2024', 'DD/MM/YYYY')).toBeUndefined();
  });
});

describe('normalizeValue', () => {
  it('maps null tokens to null', () => {
    for (const t of ['', '  ', 'n/a', 'N/A', '-', '—', '–', 'null', null, undefined]) {
      expect(normalizeValue(t).kind).toBe('null');
    }
  });

  it('folds whitespace, case and Unicode compatibility forms', () => {
    expect(foldText('  Ｃｏｎｔｏｓｏ   LTD ')).toBe('contoso ltd');
    expect(normalizeValue('ﬁnance  Dept')).toEqual({ kind: 'text', value: 'finance dept' });
    expect(normalizeValue('ABC', { caseFold: false })).toEqual({ kind: 'text', value: 'ABC' });
  });

  it('treats DB numbers and printed numbers alike', () => {
    expect(valuesEqual(normalizeValue(1234.5), normalizeValue('1,234.50'))).toBe(true);
    expect(valuesEqual(normalizeValue('$5'), normalizeValue('€5'))).toBe(false);
    expect(valuesEqual(normalizeValue('5%'), normalizeValue('5'))).toBe(false);
  });

  it('similarity is case/space insensitive', () => {
    expect(similarity('Contoso  Ltd', 'contoso ltd')).toBe(1);
    expect(similarity('Contoso Ltd', 'Contoso Ltd.')).toBeGreaterThan(0.9);
    expect(similarity('abc', 'xyz')).toBe(0);
  });
});
