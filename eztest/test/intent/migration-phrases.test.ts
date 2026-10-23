import { describe, expect, it } from '../support/testkit.js';
import { journeyToEzScript, parseEzScript, parseIntent } from '../../src/intent/index.js';

describe('migration phrases', () => {
  it('parses loader waits, rows from downloads, rows-vs-query expectations and client certificates', () => {
    expect(parseIntent('Wait for loaders to disappear')).toMatchObject({ action: 'wait', args: { for: 'loaders' } });
    expect(parseIntent('Wait for spinners ".busy", "#mask" to disappear within 5 s')).toMatchObject({ args: { for: 'loaders', selectors: ['.busy', '#mask'], timeoutMs: 5000 } });
    expect(parseIntent('Read the download invoice as rows into r')).toMatchObject({ action: 'set', captureAs: 'r', args: { extract: { from: 'invoice', kind: 'rows' } } });
    expect(parseIntent('Read the download book sheet "Data" as rows into r with delimiter ";"')).toMatchObject({ args: { extract: { sheet: 'Data', delimiter: ';' } } });
    expect(parseIntent('Expect rows r equal query "LINES" on ledger with params "OPEN", ${deal} by key "Id", "Line" ignoring columns "Updated" with tolerance 0.5 ignoring case')).toMatchObject({
      action: 'compareData',
      args: { actual: 'r', expectedQuery: { name: 'LINES', connection: 'ledger', params: ['OPEN', '${deal}'] }, key: ['Id', 'Line'], ignore: ['Updated'], tolerance: 0.5, ignoreCase: true },
    });
    expect(parseIntent('Verify rows ui match rows db by key id')).toMatchObject({ action: 'compareData', args: { actual: 'ui', expected: 'db', key: 'id' } });
    expect(parseIntent('Call API "POST /pay" with client certificate "partner" with body from file "p.json" and store as pay')).toMatchObject({
      action: 'api', api: { method: 'POST', url: '/pay', clientCertificate: 'partner', bodyFile: 'p.json' }, captureAs: 'pay',
    });
  });

  it('keeps "Expect rows ..." as its own step in .ez files and round-trips everything', () => {
    const j = parseEzScript([
      'Journey: Round trip',
      'Loaders: ".spinner", "xpath=//div[@aria-busy=\'true\']"',
      'Open /',
      'Read the download export as rows into r',
      'Expect rows r equal query "LINES" on demo by key "Id" ignoring columns "Note" with tolerance 0.01',
      'Wait for loaders to disappear',
      'Call API "GET /x" with client certificate "c1" and store as x',
      '',
    ].join('\n'));
    expect(j.loaders).toEqual(['.spinner', "xpath=//div[@aria-busy='true']"]);
    expect(j.steps.map((s) => s.action)).toEqual(['navigate', 'set', 'compareData', 'wait', 'api']);
    const text = journeyToEzScript(j);
    expect(text).toContain('Loaders: ".spinner", "xpath=//div[@aria-busy=\'true\']"');
    expect(text).toContain('Expect rows r equal query "LINES" on demo by key "Id" ignoring columns "Note" with tolerance 0.01');
    expect(text).toContain('with client certificate "c1"');
    const again = parseEzScript(text);
    expect(again.steps.map((s) => [s.action, s.args ?? null, s.api ?? null])).toEqual(j.steps.map((s) => [s.action, s.args ?? null, s.api ?? null]));
    expect(again.loaders).toEqual(j.loaders);
  });
});
