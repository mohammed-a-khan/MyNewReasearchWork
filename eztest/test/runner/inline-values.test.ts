/**
 * Inline expressions in step text, cells and Examples values (evaluated once per attempt), and the Examples
 * clauses: filter operators `in`, `^=`, `$=`, derived columns (`with name = expression`) and live data per row
 * (`resolve with query ... as pet when ... [or keep row values]`), parsed and written back.
 */
import { describe, expect, it } from '../support/testkit.js';
import { EXPRESSIONS_KEY, inlineExpressions, interpolateInline, isSecretValue, type ExpressionRecord } from '../../src/runner/inline-values.js';
import { examplesSourceToText, matchRow, parseExamplesSource, parseRowFilter, rowFilterToText } from '../../src/intent/examples-source.js';
import { prepareRows, DATA_PROBLEM_KEY } from '../../src/runner/examples-source.js';
import { parseIntent } from '../../src/intent/index.js';

const rec = (): ExpressionRecord => ({ values: new Map() });

describe('inline expressions', () => {
  it('evaluates each distinct expression once per record, keeps escapes and leaves unknown names', () => {
    const r = rec();
    const seen: string[] = [];
    r.onEvaluate = (e) => seen.push(e);
    const vars = { pet: { names: ['Biscuit', 'Pepper'] }, city: 'Lyon' };
    const a = interpolateInline('ref ${unique("VIS-")} for ${pet.names.1} in ${city}', vars, r);
    const b = interpolateInline('again ${unique("VIS-")}', vars, r);
    expect(a).toMatch(/^ref VIS-\S+ for Pepper in Lyon$/);
    expect(b.slice(6)).toBe(a.split(' ')[1]);
    expect(seen).toEqual(['unique("VIS-")']);
    expect(interpolateInline('$${unique("x")} and $${city} and ${nobody} and ${nobody:-n/a}', vars, r)).toBe('${unique("x")} and ${city} and ${nobody} and n/a');
    expect(interpolateInline('${upper(city)}-${format(addDays("2026-01-30", 3), "YYYY-MM-DD")}', vars, rec())).toBe('LYON-2026-02-02');
    // A value that holds "${" stays literal text.
    expect(interpolateInline('${concat("$", "{x}")}', vars, rec())).toBe('${x}');
    expect(inlineExpressions('a ${uuid()} b ${x} $${skip()} ${uuid()}')).toEqual(['uuid()']);
    expect(EXPRESSIONS_KEY).toBe('$expressions');
    expect(isSecretValue('secret://env/VET_PW')).toBe(true);
    expect(isSecretValue('ENC(v1:a:b:c:d)')).toBe(true);
    expect(isSecretValue('the secret://env/X')).toBe(false);
  });
});

describe('Examples clauses', () => {
  it('filters with in, ^= and $=', () => {
    const f = parseRowFilter('species in (cat, "guinea pig") and name ^= pe and city $= "on"');
    expect(rowFilterToText(f)).toBe('species in (cat, "guinea pig") and name ^= pe and city $= on');
    expect(matchRow(f, { species: 'Cat', name: 'Pepper', city: 'Lyon' })).toBe(true);
    expect(matchRow(f, { species: 'dog', name: 'Pepper', city: 'Lyon' })).toBe(false);
    expect(matchRow(f, { species: 'guinea pig', name: 'Pebble', city: 'Oslo' })).toBe(false);
    expect(matchRow(parseRowFilter('weight in (2, 4.1)'), { weight: '2.0' })).toBe(true);
    expect(() => parseRowFilter('species in cat')).toThrow(/expected "\(" after "species in"/);
  });

  it('parses derived columns and live data, and writes them back', () => {
    const src = parseExamplesSource('Examples: from data "data/visits.csv" where state != closed with ref = unique("VIS-"), due = addDays(today(), 14) resolve with query "FIND_PET_FOR_STATE" on clinic with state=<requiredState> as pet when dataMode = live or keep row values');
    expect(src).toEqual({
      from: 'data/visits.csv', where: 'state != closed',
      derive: [{ name: 'ref', expr: "unique('VIS-')" }, { name: 'due', expr: 'addDays(today(), 14)' }],
      resolve: { query: 'FIND_PET_FOR_STATE', connection: 'clinic', binds: { state: '<requiredState>' }, as: 'pet', when: 'dataMode = live', keepRowValues: true },
    });
    expect(parseExamplesSource(examplesSourceToText(src))).toEqual(src);
    const q = parseExamplesSource('Examples: from query "OPEN_VISITS" on clinic with city="Lyon" with ref = uuid()');
    expect(q).toMatchObject({ query: 'OPEN_VISITS', params: { city: 'Lyon' }, derive: [{ name: 'ref', expr: 'uuid()' }] });
    expect(() => parseExamplesSource('Examples: from data "x.csv" with ref = unique(')).toThrow(/derived column ref/);
    expect(() => parseExamplesSource('Examples: from data "x.csv" resolve with query "Q" on clinic')).toThrow(/as <name>/);
  });

  it('prepares rows: live data joins matching rows as <as>.<column>; no row is a data problem unless kept', async () => {
    const calls: Array<Record<string, string>> = [];
    const resolver = async (s: { params?: Record<string, string> }) => {
      calls.push(s.params ?? {});
      return s.params?.state === 'in-treatment' ? [{ pet_id: 11, name: 'Pepper' }] : [];
    };
    const src = parseExamplesSource('Examples: from data "x.csv" with ref = unique("V-") resolve with query "FIND_PET_FOR_STATE" on clinic with state=<requiredState> as pet when mode = live');
    const rows = await prepareRows(src, [
      { requiredState: 'in-treatment', mode: 'live' },
      { requiredState: 'healthy', mode: 'offline' },
      { requiredState: 'discharged', mode: 'live' },
    ], { resolver: resolver as never });
    expect(calls).toEqual([{ state: 'in-treatment' }, { state: 'discharged' }]);
    expect(rows[0]).toEqual({ requiredState: 'in-treatment', mode: 'live', 'pet.pet_id': '11', 'pet.name': 'Pepper', ref: "${unique('V-')}" });
    expect(rows[1]).toEqual({ requiredState: 'healthy', mode: 'offline', ref: "${unique('V-')}" });
    expect(rows[2][DATA_PROBLEM_KEY]).toBe('no test data: query FIND_PET_FOR_STATE on clinic with state=discharged returned no row for pet');
  });

  it('reads the cleanup, snapshot, transaction and store-fallback phrasings', () => {
    expect(parseIntent('On cleanup run query "DELETE_VISIT" on clinic with visit_id=${visitId}')).toMatchObject({ action: 'cleanup', args: { op: 'query', query: 'DELETE_VISIT', connection: 'clinic', binds: { visit_id: '${visitId}' } } });
    expect(parseIntent('Snapshot query "PET_ROW" on clinic with pet_id=${petId} and restore it with "RESTORE_PET" after the journey')).toMatchObject({ action: 'cleanup', args: { op: 'snapshot', query: 'PET_ROW', restore: 'RESTORE_PET', binds: { pet_id: '${petId}' } } });
    expect(parseIntent('In a transaction on clinic')).toMatchObject({ action: 'transaction', args: { connection: 'clinic' } });
    expect(parseIntent('Load "open-visit" from the shared store as visitId or run query "ANY_OPEN_VISIT" on clinic as visit')).toMatchObject({
      action: 'store', captureAs: 'visitId', args: { op: 'load', key: 'open-visit', orQuery: { query: 'ANY_OPEN_VISIT', connection: 'clinic', binds: {}, as: 'visit' } },
    });
  });
});
