/** E2E (real Chromium): flow control, variables and expressions, data-driven loops, sub-journeys, hooks and Examples tables. */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { flattenStepResults } from '../../src/core/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys } from '../../src/runner/index.js';
import { writeReports } from '../../src/report/index.js';
import { FAST, describeSteps, expectPasses, outDir, runEz } from './advanced-helpers.js';

let server: DemoServer;
let dir: string;
beforeAll(async () => {
  server = await startDemoApp();
  dir = await mkdtemp(join(tmpdir(), 'eztest-flow-'));
  await writeFile(join(dir, 'terms.csv'), 'term,expected\nlaptop,laptop\n"desk, oak",desk\n');
  await writeFile(join(dir, 'terms.json'), JSON.stringify([{ term: 'one' }, { term: 'two' }, { term: 'three' }]));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Terms');
  ws.addRow(['term']);
  ws.addRow(['alpha']);
  ws.addRow(['beta']);
  await wb.xlsx.writeFile(join(dir, 'terms.xlsx'));
});
afterAll(async () => {
  await server.close();
});

describe('flow control', () => {
  it('if / otherwise if / otherwise / unless, single-line blocks, and expressions', async () => {
    const { j } = await expectPasses(server.url, `Journey: Branches
Open /lab/form
Set variable count to 2
If the "Save" button is disabled then
  Type "first" into the Name field
Otherwise
  Type "never" into the Name field
End
  Expect the Name field has value "first"
If \${count} > 5 then
  Set variable size to "big"
Otherwise if \${count} > 1 then
  Set variable size to "medium"
Otherwise
  Set variable size to "small"
End
Unless the "Accept terms" checkbox is checked then check the "Accept terms" checkbox
If #missing-thing is visible: click #missing-thing
Set variable greeting to upper("hi ") + trim("  ada ") + "!"
Set variable due to addDays("2026-01-30", 3)
Set variable label to format(due, "DD/MM/YYYY")
Increment count by 3
`);
    expect(j.ledger).toMatchObject({ size: 'medium', greeting: 'HI ada!', due: '2026-02-02', label: '02/02/2026', count: 5 });
    const ifStep = j.steps[2];
    expect(ifStep.children?.map((c) => [c.stepId, c.branch])).toEqual([['type-first-into-the-name-field', 'then']]);
    expect(ifStep.captured).toMatchObject({ branch: 'then' });
  });

  it('repeat, for each over lists and data files (csv, json, xlsx), while with a safety cap', async () => {
    const { j } = await expectPasses(server.url, `Journey: Loops
Open /lab/keys
Repeat 3 times
  Press Tab
End
Set variable seen to ""
For each word in ["red", "green"]
  Set variable seen to seen + word + ","
End
  Expect \${seen} equals "red,green,"
For each row in data "terms.csv"
  Fill the Search field with \${row.term}
    Expect the Search field has value "\${row.term}"
End
For each row in data "terms.json": set variable last to row.term
For each row in data "terms.xlsx" sheet "Terms" as r: set variable lastX to r.term
Set variable n to 0
While \${n} < 4
  Increment n
End
Repeat until n >= 6 at most 10 times
  Increment n
End
Repeat \${n} times as i: set variable lastI to i
`, { baseDir: dir });
    expect(j.ledger).toMatchObject({ seen: 'red,green,', last: 'three', lastX: 'beta', n: 6, lastI: 6 });
    expect(j.ledger.row).toBeUndefined(); // loop variables are unbound afterwards
    const csvLoop = j.steps[4];
    expect(csvLoop.children?.map((c) => c.iteration)).toEqual([1, 2]);
    const capped = await runEz(server.url, `Journey: Runaway loop
Set variable n to 0
While \${n} >= 0 at most 5 times: increment n`);
    expect(capped.j.steps[1].error?.message).toMatch(/still running after 5 iterations/);
  });

  it('retry blocks until they pass, try / on failure handles errors, nested blocks report their nesting', async () => {
    const out = await outDir('flow-report');
    const { j, run } = await expectPasses(server.url, `Journey: Retry and try
Open /lab/events
Retry up to 5 times every 100 ms
  Call API "GET /lab/api/jobs/7" and store as job
    Expect response job "$.status" equals "done"
End
Try
  Click #does-not-exist [timeout=500ms]
On failure
  Set variable handled to error
  Click the "Load orders" button
    Expect #orders has text "3 orders"
End
Group "Checkout"
  Repeat 2 times
    If \${index} == 2 then set variable second to "yes"
  End
End
`, { outputDir: out });
    expect(j.steps[1].children?.map((c) => [c.iteration, c.status])).toEqual([[1, 'failed'], [2, 'failed'], [3, 'passed']]);
    expect(String(j.ledger.handled)).toMatch(/no locator candidate matched/);
    expect(j.ledger.second).toBe('yes');
    const depths = flattenStepResults(j.steps).map((r) => r.depth);
    expect(Math.max(...depths)).toBe(3);
    // The report keeps nested steps nested (the HTML report renders them indented under their block).
    const paths = await writeReports(join(out, run.runId), run, { formats: ['html'] });
    const model = JSON.parse(await readFile(join(out, run.runId, 'report-model.json'), 'utf8'));
    const depth = (steps: Array<{ ch?: unknown[] }>, d = 0): number => Math.max(d, ...steps.map((s) => (s.ch ? depth(s.ch as Array<{ ch?: unknown[] }>, d + 1) : d)));
    expect(depth(model.tests[0].steps)).toBe(3);
    expect(await readFile(paths.html!, 'utf8')).toContain('"ch":[');
  });

  it('runs sub-journeys with parameters and return values, and hooks before/after each journey and all journeys', async () => {
    const lib = parseEzScript(`Journey: Fill name
Id: fill-name
Tags: @library
Params: who
Returns: typed
Variables: greeting=Hello
Type "\${greeting} \${who}" into the Name field
Capture the value of the Name field as typed
`);
    const before = parseEzScript(`Journey: Open the form\nId: open-form\nOpen /lab/form`);
    const after = parseEzScript(`Journey: Check the form\nId: check-form\nExpect the page contains "Form lab"`);
    const all = parseEzScript(`Journey: Warm up\nId: warm-up\nCall API "GET /lab/api/orders" and store as warm`);
    const main = parseEzScript(`Journey: Uses a sub-journey
Run journey "fill-name" with who=Ada and store the result as filled
  Expect \${filled.typed} equals "Hello Ada"
Run the "Fill name" journey with who="Bob", greeting=Hi
  Expect \${typed} equals "Hi Bob"
`);
    const run = await runJourneys([main], {
      ...FAST, baseUrl: server.url, outputDir: await outDir('sub'), library: [lib],
      hooks: { beforeAll: [all], beforeEach: [before], afterEach: [after], afterAll: [all] },
    });
    expect(run.journeys.map((r) => [r.journeyId, r.status])).toEqual([['warm-up', 'passed'], ['uses-a-sub-journey', 'passed'], ['warm-up', 'passed']]);
    const r = run.journeys[1];
    expect(r.steps.map((s) => s.stepId), describeSteps(r)).toEqual(['before-each-open-form', 'run-journey-fill-name-with-who-ada-and-store-the-result-as-f', 'run-the-fill-name-journey-with-who-bob-greeting-hi', 'after-each-check-form']);
    expect(r.ledger.filled).toEqual({ typed: 'Hello Ada' });
    const missing = await runEz(server.url, `Journey: Missing param\nRun journey "fill-name"`, { library: [lib] });
    expect(missing.j.steps[0].error?.message).toMatch(/needs parameter\(s\): who/);
  });

  it('expands Examples tables into one journey per row', async () => {
    const j = parseEzScript(`Journey: Search for <term>
Open /lab/keys
Type "<term>" into the Search field
  Expect the Search field has value "\${term}"

Examples:
  | term   |
  | laptop |
  | desk   |
`);
    expect(j.examples).toEqual([{ term: 'laptop' }, { term: 'desk' }]);
    const run = await runJourneys([j], { ...FAST, baseUrl: server.url, outputDir: await outDir('examples') });
    expect(run.journeys.map((r) => [r.journeyId, r.name, r.status])).toEqual([
      ['search-for-term-laptop', 'Search for laptop', 'passed'],
      ['search-for-term-desk', 'Search for desk', 'passed'],
    ]);
  });
});
