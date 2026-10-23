/** Unit tests: safe expressions, SQL parameter binding, key normalisation, URL patterns, frame selectors, Examples expansion. */
import { describe, expect, it } from '../support/testkit.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ExpressionError, checkExpression, evaluateExpression, formatDate } from '../../src/core/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { bindSql, expandExamples, frameSelectorCandidates, normalizeKey, procedureSql, urlMatches } from '../../src/runner/index.js';
import { maskDeep } from '../../src/runner/dom.js';

const E = (s: string, vars: Record<string, unknown> = {}) => evaluateExpression(s, vars);

describe('safe expressions', () => {
  it('does arithmetic, comparison, logic, strings and the ternary', () => {
    expect(E('1 + 2 * 3')).toBe(7);
    expect(E('(1 + 2) * 3 - 4 / 2 % 3')).toBe(7);
    expect(E('-x + 1', { x: 3 })).toBe(-2);
    expect(E('"2" + 3')).toBe(5); // numeric text adds
    expect(E('"ORD-" + id', { id: 7 })).toBe('ORD-7');
    expect(E('${price} * ${qty}', { price: '19.99', qty: 2 })).toBeCloseTo(39.98);
    expect(E('a.b[1].c', { a: { b: [{}, { c: 'deep' }] } })).toBe('deep');
    expect(E('rows.0.name', { rows: [{ name: 'Contoso' }] })).toBe('Contoso');
    expect(E('x > 2 and not done or y == "z"', { x: 3, done: false, y: 'q' })).toBe(true);
    expect(E('x >= 10 ? "big" : "small"', { x: 3 })).toBe('small');
    expect(E('"abc" contains "b" && "x" in ["x", "y"] && "Hello" startsWith "He" && "a1" matches "^a\\\\d$"')).toBe(true);
    expect(E('total = 10', { total: '10.0' })).toBe(true);
    expect(E('"Hi ${name}"', { name: 'Ada' })).toBe('Hi Ada');
    expect(E('[1, 2] + 3')).toEqual([1, 2, 3]);
  });

  it('has a whitelisted function library (dates, strings, numbers, lists, random)', () => {
    expect(E('addDays("2026-01-30", 3)')).toBe('2026-02-02');
    expect(E('addMonths("2026-01-31", 1)')).toBe('2026-03-03');
    expect(E('format("2026-07-04", "DD/MM/YYYY")')).toBe('04/07/2026');
    expect(E('daysBetween("2026-01-01", "2026-01-31")')).toBe(30);
    expect(E('today()')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(E('now()')).toMatch(/T/);
    expect(E('upper(lower(trim("  Mixed ")))')).toBe('MIXED');
    expect(E('len("abcd") + len([1,2]) + len(o)', { o: { a: 1 } })).toBe(7);
    expect(E('substring("abcdef", 1, 3) + replace("a-b", "-", "+") + padStart("7", 3, "0")')).toBe('bca+b007');
    expect(E('join(split("a,b", ","), "|")')).toBe('a|b');
    expect(E('round(2.345, 2) + floor(1.9) + ceil(1.1) + abs(-1) + min(3, 1) + max([4, 9]) + sum([1, 2])')).toBeCloseTo(2.35 + 1 + 2 + 1 + 1 + 9 + 3);
    expect(E('formatNumber(3.14159, 2)')).toBe('3.14');
    expect(E('number("12") + int("7.9")')).toBe(19);
    expect(E('first(xs) + last(xs) + at(xs, 1)', { xs: [1, 2, 3] })).toBe(6);
    expect(E('pluck(rows, "id")', { rows: [{ id: 1 }, { id: 2 }] })).toEqual([1, 2]);
    expect(E('keys(o)', { o: { a: 1, b: 2 } })).toEqual(['a', 'b']);
    expect(E('match("Code: 482913", "(\\\\d{6})")')).toBe('482913');
    expect(E('coalesce(missing, "", "fallback")', { missing: null })).toBe('fallback');
    expect(E('isEmpty("") and isEmpty([])')).toBe(true);
    expect(E('range(3)')).toEqual([1, 2, 3]);
    expect(E('parseJson(json(o)).a', { o: { a: 5 } })).toBe(5);
    const r = E('random(1, 6)') as number;
    expect(r).toBeGreaterThanOrEqual(1);
    expect(r).toBeLessThanOrEqual(6);
    expect(E('uuid()')).toMatch(/^[0-9a-f-]{36}$/);
    expect(E('len(randomString(12))')).toBe(12);
    expect(formatDate(new Date('2026-03-04T05:06:07.008Z'), 'YYYY-MM-DD HH:mm:ss.SSS')).toBe('2026-03-04 05:06:07.008');
  });

  it('never evaluates code: unknown functions, bare words and syntax errors are clear errors', () => {
    expect(() => E('constructor("return 1")')).toThrow(/unknown function "constructor"/);
    expect(E('x.constructor', { x: {} })).toBeUndefined();
    expect(() => E('process.exit(1)')).toThrow(ExpressionError);
    expect(() => E('eval("1")')).toThrow(/unknown function "eval"/);
    expect(() => E('this is text')).toThrow(/unexpected "is"|unknown variable/);
    expect(() => E('missing + 1')).toThrow(/unknown variable "missing"/);
    expect(() => E('1 +')).toThrow(/unexpected end/);
    expect(() => E('"open')).toThrow(/unterminated string/);
    expect(() => E('1 / 0')).toThrow(/division by zero/);
    expect(() => E('"a" * 2')).toThrow(/needs numbers/);
    expect(() => E('x.__proto__.polluted', { x: {} })).not.toThrow();
    expect(checkExpression('a >')).toMatch(/unexpected end/);
    expect(checkExpression('len(rows) > 2')).toBeUndefined();
    expect(() => E('(' .repeat(100) + '1' + ')'.repeat(100))).toThrow(/nested too deeply/);
  });

  it('the Node-side "no eval / no new Function" rule holds for all of src/', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(new URL('../../src', import.meta.url).pathname);
    const offenders = files.filter((f) => /\beval\s*\(|new\s+Function\s*\(/.test(readFileSync(f, 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')));
    expect(offenders).toEqual([]);
  });
});

describe('SQL parameter binding', () => {
  it('turns ${vars} (and quoted literals containing them) into bound parameters per dialect', () => {
    expect(bindSql("SELECT * FROM t WHERE a = '${x}' AND b = ? AND c = ${n}", ['B'], { x: "O'Brien", n: 5 }, 'sqlite'))
      .toEqual({ sql: 'SELECT * FROM t WHERE a = ? AND b = ? AND c = ?', params: ["O'Brien", 'B', 5] });
    expect(bindSql("SELECT * FROM t WHERE name LIKE '%${q}%' AND note = 'it''s ${q}'", [], { q: 'ab' }, 'sqlite'))
      .toEqual({ sql: 'SELECT * FROM t WHERE name LIKE ? AND note = ?', params: ['%ab%', "it's ab"] });
    expect(bindSql('SELECT * FROM t WHERE id = ${id} AND s = $1', ['open'], { id: 9 }, 'postgres'))
      .toEqual({ sql: 'SELECT * FROM t WHERE id = $2 AND s = $1', params: ['open', 9] });
    expect(bindSql('SELECT * FROM t WHERE id = ${id}', [], { id: 9 }, 'mssql')).toEqual({ sql: 'SELECT * FROM t WHERE id = @p1', params: [9] });
    expect(bindSql("SELECT '?' AS q, ? AS p", [1], {}, 'sqlite')).toEqual({ sql: "SELECT '?' AS q, ? AS p", params: [1] });
    expect(bindSql('SELECT ${obj}', [], { obj: { a: 1 } }, 'sqlite').params).toEqual(['{"a":1}']);
    expect(() => bindSql('SELECT ${nope}', [], {}, 'sqlite')).toThrow(/no such variable/);
    expect(procedureSql('close_order', 2, 'postgres')).toBe('CALL close_order($1, $2)');
    expect(procedureSql('dbo.reset', 1, 'mssql')).toBe('EXEC dbo.reset @p1');
    expect(() => procedureSql('x; DROP', 0, 'postgres')).toThrow(/Invalid procedure name/);
    expect(() => procedureSql('p', 0, 'sqlite')).toThrow(/Not supported/);
  });
});

describe('masking captured values', () => {
  it('masks strings deep inside records and lists but keeps dates and buffers intact', () => {
    const d = new Date('2026-01-02T00:00:00Z');
    const buf = new Uint8Array([1, 2]);
    const out = maskDeep({ a: 'x secret y', list: ['secret'], when: d, bytes: buf, n: 1 }, (s) => s.split('secret').join('****')) as Record<string, unknown>;
    expect(out).toEqual({ a: 'x **** y', list: ['****'], when: d, bytes: buf, n: 1 });
    expect(out.when).toBe(d);
  });
});

describe('keys, URL patterns, frames and Examples', () => {
  it('normalises key names and platform-aware Mod', () => {
    expect(normalizeKey('ctrl+shift+k')).toBe('Control+Shift+K');
    expect(normalizeKey('Mod+S')).toBe('ControlOrMeta+S');
    expect(normalizeKey('cmd+option+esc')).toBe('Meta+Alt+Escape');
    expect(normalizeKey('PgDn')).toBe('PageDown');
    expect(normalizeKey('f5')).toBe('F5');
    expect(normalizeKey('Del')).toBe('Delete');
    expect(normalizeKey('keya')).toBe('KeyA');
    expect(normalizeKey('a')).toBe('a');
    expect(normalizeKey('+')).toBe('+');
  });

  it('matches URLs by substring, glob or /regex/', () => {
    expect(urlMatches('http://x/api/orders?a=1', '/api/orders')).toBe(true);
    expect(urlMatches('http://x/api/orders/7', '/api/*/7')).toBe(true);
    expect(urlMatches('http://x/api/orders/7', '**/orders/*')).toBe(true);
    expect(urlMatches('http://x/api/orders/7', '/orders/\\d+$/')).toBe(true);
    expect(urlMatches('http://x/other', '/api/*')).toBe(false);
  });

  it('builds frame selector candidates by name, id, title and src; passes selectors through', () => {
    expect(frameSelectorCandidates('payment')[0]).toBe('iframe[name="payment"]');
    expect(frameSelectorCandidates('#pay')).toEqual(['#pay']);
    expect(frameSelectorCandidates('css=iframe.x')).toEqual(['iframe.x']);
  });

  it('expands Examples into one journey per row with variables and <placeholders>', () => {
    const j = parseEzScript('Journey: Find <q>\nType "<q>" into the Search field\nExamples:\n| q |\n| a b |\n| c |\n');
    const [a, c] = expandExamples([j]);
    expect([a.id, a.name, a.variables, a.steps[0].value]).toEqual(['find-q-a-b', 'Find a b', { q: 'a b' }, 'a b']);
    expect([c.id, c.steps[0].value]).toEqual(['find-q-c', 'c']);
    expect(a.examples).toBeUndefined();
  });
});
