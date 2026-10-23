import { afterEach, describe, expect, it } from '../support/testkit.js';
import { evaluateExpression as ev, getBusinessCalendar, renderTemplate, setBusinessCalendar } from '../../src/core/index.js';

afterEach(() => setBusinessCalendar({}));

describe('business days', () => {
  // 2026-10-23 is a Friday; 2026-12-25 a Friday; 2026-12-28 a Monday.
  it('skips weekends in both directions and keeps the time of day', () => {
    expect(ev('addBusinessDays("2026-10-23", 1)', {})).toBe('2026-10-26');
    expect(ev('addBusinessDays("2026-10-23", 5)', {})).toBe('2026-10-30');
    expect(ev('addBusinessDays("2026-10-26", -1)', {})).toBe('2026-10-23');
    expect(ev('addBusinessDays("2026-10-24", 1)', {})).toBe('2026-10-26'); // from a Saturday
    expect(ev('addBusinessDays("2026-10-24", 0)', {})).toBe('2026-10-26'); // 0 rolls forward to a business day
    expect(ev('addBusinessDays("2026-10-22", 0)', {})).toBe('2026-10-22');
    expect(ev('addBusinessDays("2026-10-23T15:30:00Z", 1)', {})).toBe('2026-10-26T15:30:00.000Z');
    expect(ev('isBusinessDay("2026-10-24")', {})).toBe(false);
    expect(ev('isBusinessDay("2026-10-23")', {})).toBe(true);
    expect(ev('nextBusinessDay("2026-10-23")', {})).toBe('2026-10-26');
    expect(ev('previousBusinessDay("2026-10-26")', {})).toBe('2026-10-23');
    expect(() => ev('addBusinessDays("2026-10-23", 1.5)', {})).toThrow(/whole number/);
  });

  it('skips holidays from an argument and from the configured calendar', () => {
    expect(ev('addBusinessDays("2026-12-24", 1, ["2026-12-25"])', {})).toBe('2026-12-28');
    expect(ev('addBusinessDays("2026-12-24", 1)', {})).toBe('2026-12-25');
    setBusinessCalendar({ holidays: ['2026-12-25', '2026-12-28'] });
    expect(getBusinessCalendar().holidays).toEqual(['2026-12-25', '2026-12-28']);
    expect(ev('addBusinessDays("2026-12-24", 1)', {})).toBe('2026-12-29');
    expect(ev('addBusinessDays("2026-12-29", -1)', {})).toBe('2026-12-24');
    expect(ev('isBusinessDay("2026-12-28")', {})).toBe(false);
    expect(ev('nextBusinessDay("2026-12-24", ["2026-12-29"])', {})).toBe('2026-12-30');
    expect(() => ev('addBusinessDays("2026-12-24", 1, ["25/12/2026"])', {})).toThrow(/YYYY-MM-DD/);
    setBusinessCalendar({ weekend: [5, 6] }); // Friday-Saturday weekend
    expect(ev('addBusinessDays("2026-10-22", 1)', {})).toBe('2026-10-25');
  });
});

describe('time zones', () => {
  it('formats an instant in a zone, across DST changes, and leaves date-only values alone', () => {
    expect(ev('format("2026-01-15T03:00:00Z", "YYYY-MM-DD HH:mm", "America/New_York")', {})).toBe('2026-01-14 22:00');
    expect(ev('format("2026-07-15T03:00:00Z", "YYYY-MM-DD HH:mm", "America/New_York")', {})).toBe('2026-07-14 23:00'); // EDT
    expect(ev('format("2026-07-15T03:00:00Z", "HH:mm", "Asia/Kolkata")', {})).toBe('08:30');
    expect(ev('format("2026-07-15", "DD/MM/YYYY", "Pacific/Auckland")', {})).toBe('15/07/2026');
    expect(ev('format("2026-07-15T03:00:00Z", "YYYY-MM-DD")', {})).toBe('2026-07-15'); // no zone: UTC as before
    expect(() => ev('format("2026-07-15T03:00:00Z", "HH", "Mars/Olympus")', {})).toThrow(/unknown time zone/);
  });

  it('now(tz) and today(tz) give local wall-clock values with the right offset', () => {
    const ny = String(ev('now("America/New_York")', {}));
    expect(ny).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}-0[45]:00$/);
    expect(Math.abs(Date.parse(ny) - Date.now())).toBeLessThan(5000);
    expect(String(ev('now("Asia/Kolkata")', {}))).toMatch(/\+05:30$/);
    expect(String(ev('now()', {}))).toMatch(/Z$/);
    const tokyo = String(ev('today("Asia/Tokyo")', {}));
    const expected = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
    expect(tokyo).toBe(expected);
    expect(ev('addBusinessDays(today("UTC"), 0)', {})).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('json() and body templates', () => {
  const vars = { codes: ['A', 'B'], name: 'O\'Brien "Jr"', n: 3, order: { id: 7 } };

  it('json() encodes values for templates', () => {
    expect(ev('json(codes)', vars)).toBe('["A","B"]');
    expect(ev('json(name)', vars)).toBe('"O\'Brien \\"Jr\\""');
    expect(ev('jsonEncode(order)', vars)).toBe('{"id":7}');
  });

  it('renders ${expressions} by default and {{...}} only with the mustache syntax', () => {
    const t = '{"codes": ${json(codes)}, "n": ${n}, "due": "${addBusinessDays("2026-10-23", 1)}", "keep": "{{name}}", "lit": "$${x}", "missing": "${nope}"}';
    expect(renderTemplate(t, vars)).toBe('{"codes": ["A","B"], "n": 3, "due": "2026-10-26", "keep": "{{name}}", "lit": "${x}", "missing": "${nope}"}');
    const m = '{"codes": {{json(codes)}}, "name": {{jsonEncode(name)}}, "id": {{order.id}}, "plain": "{{n}}", "unknown": "{{nope}}", "obj": {{ order }}}';
    expect(JSON.parse(renderTemplate(m, vars, { syntax: 'mustache' }).replace('"{{nope}}"', '"?"'))).toEqual({ codes: ['A', 'B'], name: 'O\'Brien "Jr"', id: 7, plain: '3', unknown: '?', obj: { id: 7 } });
  });

  it('reports real mistakes instead of hiding them', () => {
    expect(() => renderTemplate('${noSuchFunction(1)}', vars)).toThrow(/unknown function/);
    expect(renderTemplate('no placeholders', vars)).toBe('no placeholders');
    expect(renderTemplate('${"a}b"}', vars)).toBe('a}b'); // braces inside strings do not end the placeholder
  });
});
