import { describe, expect, it } from '../support/testkit.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  examplesSourceToText, journeyToEzScript, matchRow, normalizeJourneyInput, parseEzScript, parseExamplesSource, parseRowFilter, rowFilterToText,
} from '../../src/intent/index.js';
import { expandExamples, loadExamplesRows, resolveExamplesSources, validateExamplesSource } from '../../src/runner/index.js';

describe('row filter language', () => {
  it('parses comparisons with AND binding tighter than OR, and parentheses', () => {
    expect(parseRowFilter('a = 1 or b = 2 and c = 3')).toEqual({
      type: 'or', left: { type: 'cmp', column: 'a', op: '=', value: '1' },
      right: { type: 'and', left: { type: 'cmp', column: 'b', op: '=', value: '2' }, right: { type: 'cmp', column: 'c', op: '=', value: '3' } },
    });
    const f = parseRowFilter('(id = A OR id = "B c") AND runFlag=Yes');
    expect(rowFilterToText(f)).toBe('(id = A or id = "B c") and runFlag = Yes');
    expect(parseRowFilter(rowFilterToText(f))).toEqual(f);
  });

  it('evaluates =, !=, >, <, >=, <=, ~ with case-insensitive columns and numeric comparison', () => {
    const row = { ScenarioId: 'TS_1', RunFlag: 'Yes', amount: '120', name: 'Contoso Ltd' };
    const t = (s: string) => matchRow(parseRowFilter(s), row);
    expect(t('scenarioid = ts_1 and runflag = yes')).toBe(true);
    expect(t('runFlag != No')).toBe(true);
    expect(t('amount > 99')).toBe(true); // numeric, not text ("120" < "99" as text)
    expect(t('amount >= 120 and amount <= 120')).toBe(true);
    expect(t('amount < 100')).toBe(false);
    expect(t('name ~ contoso')).toBe(true);
    expect(t('not (name ~ fabrikam)')).toBe(true);
    expect(t('missing = x')).toBe(false);
    expect(t('(scenarioId = X or scenarioId = TS_1) and runFlag = Yes')).toBe(true);
    expect(matchRow(parseRowFilter('name = ${who}'), row, (s) => s.replace('${who}', 'Contoso Ltd'))).toBe(true);
  });

  it('reports malformed filters', () => {
    expect(() => parseRowFilter('a =')).toThrow(/expected a value/);
    expect(() => parseRowFilter('(a = 1')).toThrow(/missing "\)"/);
    expect(() => parseRowFilter('a 1')).toThrow(/expected an operator/);
  });
});

describe('Examples: from data / from query', () => {
  it('parses and renders the .ez grammar', () => {
    const src = parseExamplesSource('Examples: from data "data/x.xlsx" sheet "Active" where runFlag = Yes and (id = A or id = B)');
    expect(src).toEqual({ from: 'data/x.xlsx', sheet: 'Active', where: 'runFlag = Yes and (id = A or id = B)' });
    expect(examplesSourceToText(src)).toBe('Examples: from data "data/x.xlsx" sheet "Active" where runFlag = Yes and (id = A or id = B)');
    expect(parseExamplesSource('Examples: from data "x.json" path "$.rows"')).toEqual({ from: 'x.json', path: '$.rows' });
    expect(parseExamplesSource('Examples: from query "OPEN_ORDERS" on shop with region="EU" where status != closed'))
      .toEqual({ query: 'OPEN_ORDERS', connection: 'shop', params: { region: 'EU' }, where: 'status != closed' });
    expect(() => parseExamplesSource('Examples: from data "x.json" where a =')).toThrow(/Invalid filter/);
    expect(() => parseExamplesSource('Examples: from somewhere')).toThrow(/expected 'from data/);
  });

  it('is part of .ez journeys and YAML/JSON journeys, and round-trips', () => {
    const j = parseEzScript('Journey: J\nType "${user}" into the Username field\nExamples: from data "users.csv" where active = yes\n');
    expect(j.examplesFrom).toEqual({ from: 'users.csv', where: 'active = yes' });
    expect(parseEzScript(journeyToEzScript(j))).toEqual(j);
    const y = normalizeJourneyInput({ name: 'Y', steps: ['Open /'], examples: { from: 'users.json', path: '$.users', where: 'active = yes' } });
    expect(y.examplesFrom).toEqual({ from: 'users.json', path: '$.users', where: 'active = yes' });
    expect(() => parseEzScript('Journey: J\nOpen /\nExamples: from data "a.csv"\nExamples:\n| a |\n| 1 |\n')).toThrow(/only one Examples/);
  });

  it('expands rows into journey instances at run time (json, csv) and reports sources without rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-examples-'));
    await writeFile(join(dir, 'users.json'), JSON.stringify({ users: [{ user: 'ann', active: 'Yes' }, { user: 'bo', active: 'No' }, { user: 'cy', active: 'yes', n: 3 }] }));
    await writeFile(join(dir, 'users.csv'), 'user,active\nann,Yes\nbo,No\n');
    const json = parseEzScript('Journey: Login <user>\nType "${user}" into the Username field\nExamples: from data "users.json" path "$.users" where active = yes\n');
    const csv = parseEzScript('Journey: Csv\nId: csv\nOpen /\nExamples: from data "users.csv" where active = Yes\n');
    const none = parseEzScript('Journey: None\nOpen /\nExamples: from data "users.csv" where active = Maybe\n');
    const missing = parseEzScript('Journey: Missing\nOpen /\nExamples: from data "nope.json"\n');
    const r = await resolveExamplesSources([json, csv, none, missing], { baseDir: dir });
    const expanded = expandExamples(r.journeys);
    expect(expanded.map((j) => j.name)).toEqual(['Login ann', 'Login cy', 'Csv [user=ann, active=Yes]']);
    expect(expanded[1].variables).toMatchObject({ user: 'cy', n: '3' });
    expect(r.empty.map((e) => e.journey.name)).toEqual(['None', 'Missing']);
    expect(r.empty[1].reason).toMatch(/not found/);
    expect(await loadExamplesRows({ from: 'users.csv' }, { baseDir: dir })).toHaveLength(2);
  });

  it('resolves query sources through the DataSourceResolver hook', async () => {
    const j = parseEzScript('Journey: Q\nOpen /\nExamples: from query "OPEN" on shop where n > 1\n');
    await expect(resolveExamplesSources([j])).resolves.toMatchObject({ empty: [{ reason: expect.stringMatching(/no data source resolver/) }] });
    const r = await resolveExamplesSources([j], { resolver: async (src) => (src.query === 'OPEN' ? [{ n: 1 }, { n: 2 }] : undefined) });
    expect(r.journeys[0].examples).toEqual([{ n: '2' }]);
  });

  it('validates sources: missing files, filters matching nothing, unknown columns and placeholders', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-examples-v-'));
    await writeFile(join(dir, 'd.json'), JSON.stringify([{ id: 'A', runFlag: 'Yes', pw: 'REPLACE_WITH_LEGACY_PW' }]));
    expect(await validateExamplesSource({ from: 'gone.json' }, { baseDir: dir })).toMatchObject([{ kind: 'missing-file', severity: 'error' }]);
    const v = await validateExamplesSource({ from: 'd.json', where: 'id = B or colour = red' }, { baseDir: dir });
    expect(v.map((i) => i.kind)).toEqual(['unknown-column', 'no-rows']);
    const p = await validateExamplesSource({ from: 'd.json', where: 'runFlag = Yes' }, { baseDir: dir });
    expect(p).toMatchObject([{ kind: 'placeholder', message: expect.stringContaining('pw=REPLACE_WITH_LEGACY_PW') }]);
    expect(await validateExamplesSource({ from: 'd.json' }, { baseDir: dir, placeholder: /NOTHING_MATCHES/ })).toEqual([]);
  });
});
