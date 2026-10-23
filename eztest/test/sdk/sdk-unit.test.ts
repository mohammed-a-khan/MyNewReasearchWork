/** Unit tests of the SDK building blocks (no browser). */
import { describe, expect, it } from '../support/testkit.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { journeyToEzScript, normalizeJourneyInput, parseEzScript, parseIntent } from '../../src/intent/index.js';
import { compareRows, dates, db, el, screen, toTarget, ui, vars, SdkContextError } from '../../src/sdk/index.js';
import { conditionsFrom, literal, literalDeep } from '../../src/sdk/internal.js';
import { decodeSourceMap, mapPosition } from '../../src/sdk/callsite.js';
import { loadCodeJourneys, parseCodeRef, resolveCodeTarget, eztestModulePath } from '../../src/runner/code-journeys.js';
import { interpolate } from '../../src/core/index.js';
import { tempDir } from '../runner/fixtures.js';

describe('screens and targets', () => {
  it('builds ordered locator candidates from element specs, in the order written', () => {
    const S = screen('Orders', {
      search: { css: '#q', label: 'Search' },
      byXpathFirst: { xpath: '//button[@id="go"]', css: 'button#go', description: 'Go button' },
      save: { role: 'button', name: 'Save' },
      row: (id: string) => ({ xpath: `//tr[td='${id}']`, description: `order ${id}` }),
      plain: 'the "Sign in" button',
    });
    expect(S.$name).toBe('Orders');
    expect(S.search.target).toEqual({ description: 'Search', locators: [{ strategy: 'css', value: '#q' }, { strategy: 'label', value: 'Search' }] });
    expect(S.byXpathFirst.target.locators.map((l) => l.strategy)).toEqual(['xpath', 'css']);
    expect(S.save.target.locators[0]).toEqual({ strategy: 'role', value: 'button', name: 'Save', exact: true });
    expect(S.row('ORD-7').target).toEqual({ description: 'order ORD-7', locators: [{ strategy: 'xpath', value: "//tr[td='ORD-7']" }] });
    expect(S.row('ORD-7')).toMatchObject({ screen: 'Orders', key: 'row' });
    // Plain English goes through the .ez target parser.
    expect(S.plain.target.locators[0]).toMatchObject({ strategy: 'role', value: 'button', name: 'Sign in' });
    expect(toTarget('testid=order-number').locators).toEqual([{ strategy: 'testId', value: 'order-number' }]);
    expect(toTarget({ testId: 'x', candidates: [{ strategy: 'css', value: '.x' }] }).locators).toHaveLength(2);
    expect(el({ css: '.a' }, 'thing').target.description).toBe('thing');
    expect(() => toTarget({ description: 'nothing' })).toThrow(/has no locator/);
    expect(() => toTarget('  ')).toThrow(/must not be empty/);
  });

  it('values from code are literal: ${...} is escaped for the runner', () => {
    const v = 'price ${total} and $${x}';
    expect(interpolate(literal(v), { total: 5, x: 1 })).toBe(v);
    expect(literalDeep({ a: ['${a}'], b: 1 })).toEqual({ a: ['$${a}'], b: 1 });
  });

  it('post-conditions from objects, .ez phrases and raw conditions', () => {
    const c = conditionsFrom({ visible: 'Invoice details', url: '/done', text: 'Saved', count: ['testid=row', 3] });
    expect(c.map((x) => x.type)).toEqual(['visible', 'urlContains', 'pageContainsText', 'count']);
    expect(conditionsFrom('the URL contains "/dashboard"')).toEqual([{ type: 'urlContains', value: '/dashboard' }]);
    expect(conditionsFrom(['the page contains "x"', { type: 'titleContains', value: 'T' }]).map((x) => x.type)).toEqual(['pageContainsText', 'titleContains']);
    expect(conditionsFrom(undefined)).toEqual([]);
  });
});

describe('row comparison', () => {
  const ui = [{ ID: '1', Name: 'Contoso', Total: '10.00' }, { ID: '2', Name: 'Fabrikam', Total: '5' }];
  it('compares by key, case-insensitive columns, numeric tolerance', () => {
    const db = [{ id: 1, name: 'Contoso', total: 10 }, { id: 2, name: 'Fabrikam', total: 5.001 }];
    expect(compareRows(ui, db, { key: 'id', tolerance: 0.01 })).toEqual([]);
    expect(compareRows(ui, db, { key: 'id' })).toEqual([{ type: 'MISMATCH', key: '2', column: 'total', expected: 5.001, actual: '5' }]);
  });
  it('reports missing, extra and duplicate keys', () => {
    const f = compareRows([...ui, { ID: '3', Name: 'X', Total: '1' }, { ID: '3', Name: 'Y', Total: '1' }], [{ id: '1', name: 'Contoso' }, { id: '9', name: 'Gone' }], { key: 'id' });
    expect(f.map((x) => `${x.type}:${x.key}`).sort()).toEqual(['DUPLICATE_KEY:3', 'EXTRA:2', 'EXTRA:3', 'MISSING:9']);
  });
});

describe('dates (same functions as .ez expressions)', () => {
  it('business days, months, formatting and zones', () => {
    expect(dates.addBusinessDays('2026-10-23', 3)).toBe('2026-10-28');
    expect(dates.addBusinessDays('2026-10-23', 1, ['2026-10-26'])).toBe('2026-10-27');
    expect(dates.isBusinessDay('2026-10-24')).toBe(false);
    expect(dates.addMonths('2026-01-31', 1)).toBe('2026-03-03');
    expect(dates.startOfMonth('2026-10-23')).toBe('2026-10-01');
    expect(dates.endOfMonth('2026-02-10')).toBe('2026-02-28');
    expect(dates.toUSDate('2026-10-23')).toBe('10/23/2026');
    expect(dates.format('2026-10-23T03:30:00Z', 'YYYY-MM-DD HH:mm', 'America/New_York')).toBe('2026-10-22 23:30');
    expect(dates.inZone('2026-01-15T12:00:00Z', 'Europe/Berlin')).toBe('2026-01-15T13:00:00.000+01:00');
    expect(dates.daysBetween('2026-10-01', '2026-10-23')).toBe(22);
    expect(dates.today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(() => dates.parse('nope')).toThrow(/not a date/);
  });
});

describe('outside a journey', () => {
  it('SDK calls say they need a running journey', async () => {
    await expect(ui.click('the "Save" button')).rejects.toThrow(SdkContextError);
    expect(() => vars.get('x')).toThrow(/only be used while EZTest runs a code journey/);
  });
  it('db never takes SQL text: catalogue names or tagged templates only', async () => {
    await expect(db.query("SELECT * FROM t WHERE id = '1'")).rejects.toThrow(/catalogue query name/);
    const fake = ['SELECT 1'] as unknown as TemplateStringsArray;
    await expect(db.on('shop').sql(fake)).rejects.toThrow(/tagged template/);
  });
});

describe('source maps', () => {
  it('decodes VLQ mappings and maps generated positions back', () => {
    // "AAAA" = [0,0,0,0]; ";;AAEA" = line 3 maps to source line 3 (0-based 2).
    const m = decodeSourceMap({ sources: ['a.ts'], mappings: 'AAAA;;AAEA,IAAI' }, (s) => `/abs/${s}`);
    expect(mapPosition(m, 1, 0)).toEqual({ file: '/abs/a.ts', line: 1, column: 0 });
    expect(mapPosition(m, 3, 5)).toEqual({ file: '/abs/a.ts', line: 3, column: 4 });
    expect(mapPosition(m, 2, 0)).toBeUndefined();
  });
});

describe('Run code (grammar, references, loading)', () => {
  it('parses and renders "Run code" lines', () => {
    expect(parseIntent('Run code "steps/billing.ts#settleOverdue" with region="EU" as result')).toMatchObject({
      action: 'code', value: 'steps/billing.ts#settleOverdue', args: { region: 'EU' }, captureAs: 'result',
    });
    const j = parseEzScript('Journey: x\nRun code "a.steps.ts#b" with n=1 and store the result as r\n');
    const again = parseEzScript(journeyToEzScript(j));
    expect(again.steps[0]).toMatchObject({ action: 'code', value: 'a.steps.ts#b', args: { n: '1' }, captureAs: 'r' });
    const y = normalizeJourneyInput({ name: 'y', steps: [{ runCode: 'a.steps.ts#b', with: { region: 'EU' }, as: 'r' }] });
    expect(y.steps[0]).toMatchObject({ action: 'code', value: 'a.steps.ts#b', args: { region: 'EU' }, captureAs: 'r' });
    expect(parseCodeRef('steps/x.ts')).toEqual({ file: 'steps/x.ts', name: 'default', journey: false });
    expect(parseCodeRef('/a/x.journey.ts#journey:My flow')).toEqual({ file: '/a/x.journey.ts', name: 'My flow', journey: true });
    expect(eztestModulePath('eztest/sdk')).toMatch(/[\\/]sdk[\\/]index\.(?:js|ts)$/);
    expect(eztestModulePath('eztest/../x')).toBeUndefined();
  });

  it('loads plain .js code journeys and exported code steps; reports what is missing', async () => {
    const dir = await tempDir('sdk-js');
    await mkdir(join(dir, 'journeys'), { recursive: true });
    const sdkUrl = new URL('../../src/sdk/index.ts', import.meta.url).href;
    await writeFile(join(dir, 'journeys', 'a.journey.mjs'), `import { journey } from ${JSON.stringify(sdkUrl)};\njourney('First', { tags: ['@x'] }, async () => {});\njourney('Second', async () => {});\nexport async function helper(ctx, p) { return p; }\n`);
    await writeFile(join(dir, 'journeys', 'empty.journey.mjs'), 'export const nothing = 1;\n');
    const js = await loadCodeJourneys(join(dir, 'journeys', 'a.journey.mjs'), { cwd: dir });
    expect(js.map((j) => [j.id, j.tags])).toEqual([['first', ['x']], ['second', []]]);
    const t = await resolveCodeTarget('journeys/a.journey.mjs#helper', [dir], { cwd: dir });
    expect(t).toMatchObject({ kind: 'export', name: 'helper' });
    await expect(resolveCodeTarget('journeys/a.journey.mjs#nope', [dir], { cwd: dir })).rejects.toThrow(/no exported function "nope" \(exports: helper\)/);
    await expect(resolveCodeTarget('journeys/missing.ts#x', [dir], { cwd: dir })).rejects.toThrow(/no file/);
    await expect(loadCodeJourneys(join(dir, 'journeys', 'empty.journey.mjs'), { cwd: dir })).rejects.toThrow(/declares no journey/);
  });
});
