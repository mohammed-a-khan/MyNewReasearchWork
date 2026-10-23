import { describe, expect, it } from '../support/testkit.js';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { cellText, importManualCsv, importManualXlsx, parseCsv, readXlsx, readXlsxTable } from '../../src/importers/index.js';

const CSV = readFileSync(fileURLToPath(new URL('./fixtures/manual-tests.csv', import.meta.url)), 'utf8');
const body = (ez: string) => ez.split('\n').filter((l) => l && (!l.startsWith('#') || l.startsWith('# TODO')) && !/^(?:Journey|Tags|Id|Risk|Description):/.test(l));

/** A manual test workbook: merged ID/Title cells, a merged Expected Result, rich text, a formula, a date. */
async function workbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Cases');
  wb.addWorksheet('Other').addRow(['x']);
  ws.addRow(['Test Case ID', 'Test Case Title', 'Action', 'Expected Outcome', 'Labels', 'Priority', 'Created']);
  ws.addRow(['TC-10', 'Order a gadget', 'Open /login', '', 'web', 'Critical', new Date(Date.UTC(2026, 0, 15))]);
  ws.addRow(['', '', 'Type "bob" into the Username field', '', '', '', '']);
  ws.addRow(['', '', { richText: [{ text: 'Type "Builder#2" ' }, { font: { bold: true }, text: 'into the Password field' }] }, '', '', '', '']);
  ws.addRow(['', '', 'Click the "Sign in" button', 'The URL contains "/dashboard"', '', '', '']);
  // Expected result merged across rows 6-8: it applies once, after the last of those steps.
  ws.addRow(['TC-11', 'Fill the order form', 'Go to /orders/new', 'Expect the "Quantity" field has value "3"', 'orders', 'P2', '']);
  ws.addRow(['', '', 'Select "Gadget (49.50)" from the Product dropdown', '', '', '', '']);
  ws.addRow(['', '', { formula: 'CONCATENATE("Fill the Quantity field with ", 3)', result: 'Fill the Quantity field with 3' }, '', '', '', '']);
  ws.mergeCells('D6:D8');
  // ID merged vertically: rows 9-10 belong to one case.
  ws.addRow(['TC-12', 'Unclear', 'Make sure things are fine', 'Everything is fine', '', '', '']);
  ws.addRow(['', '', 'Reload the page', '', '', '', '']);
  ws.mergeCells('A9:A10');
  ws.mergeCells('B9:B10');
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('manual test case import', () => {
  it('CSV: groups rows by ID (blank ID continues), splits multi-line cells, maps expected results to post-conditions', () => {
    const r = importManualCsv(CSV, { file: 'manual-tests.csv' });
    expect(r.converted.map((c) => [c.id, c.name, c.line])).toEqual([['tc-001', 'Bob signs in', 2], ['tc-002', 'Create an order', 7], ['tc-003', 'Vague case', 10]]);
    expect(body(r.converted[0].ez)).toEqual([
      'Open /login',
      'Type "bob" into the Username field',
      'Type "Builder#2" into the Password field',
      'Click the "Sign in" button',
      '  Expect the URL contains "/dashboard"',
      '# TODO (not converted): User is greeted warmly',
    ]);
    expect(r.converted[0].ez).toContain('Tags: @smoke @priority-high');
    expect(r.converted[0].ez).toContain('Risk: 4');
    expect(r.journeys[0].steps[3].postconditions).toEqual([{ type: 'urlContains', value: '/dashboard' }]);
    expect(body(r.converted[1].ez)).toEqual([
      'Go to /orders/new',
      '# TODO (not converted): Pick a nice product',
      'Assert that the page contains "New order"',
      'Click the "Submit order" button',
      '  Expect page contains "created"',
    ]);
    expect(r.converted[1].ez).toContain('Tags: @orders @regression @priority-2');
    expect(r.converted[2].journey).toBeUndefined();
    expect(r.todo.map((t) => [t.line, t.original])).toEqual([
      [5, 'User is greeted warmly'], [8, 'Pick a nice product'], [10, 'Do the thing'], [10, 'It works'],
    ]);
    expect(r.coverage).toEqual({ sourceSteps: 8, convertedSteps: 6, assertions: 5, convertedAssertions: 3 });
  });

  it('CSV: custom column names and quoting', () => {
    const csv = 'Case;Name;Do;Check\nA1;One;Open /x;the page contains "ok"\n';
    const r = importManualCsv(csv, { file: 'c.csv', columns: { id: 'Case', title: 'Name', step: 'Do', expected: 'Check' } });
    expect(body(r.converted[0].ez)).toEqual(['Open /x', '  Expect the page contains "ok"']);
    expect(() => importManualCsv(csv, { columns: { step: 'Missing' } })).toThrow(/column "Missing"/);
    expect(parseCsv('a,"b ""q""\nc",d\r\n1,2,3')).toEqual([['a', 'b "q"\nc', 'd'], ['1', '2', '3']]);
  });

  it('readXlsx: header-keyed string records (rich text, formula results, dates, merged cells repeated)', async () => {
    const buf = await workbook();
    const rows = await readXlsx(buf, { sheet: 'Cases' });
    expect(rows).toHaveLength(9);
    expect(rows[0]).toMatchObject({ 'Test Case ID': 'TC-10', Created: '2026-01-15', Priority: 'Critical' });
    expect(rows[2].Action).toBe('Type "Builder#2" into the Password field');
    expect(rows[6].Action).toBe('Fill the Quantity field with 3');
    expect(rows[5]['Expected Outcome']).toBe('Expect the "Quantity" field has value "3"'); // merged slave repeats the master value
    expect(rows[8]['Test Case ID']).toBe('TC-12');
    const t = await readXlsxTable(buf, { sheet: 1 });
    expect(t.rows[4].merged['Expected Outcome']).toBe('first');
    expect(t.rows[6].merged['Expected Outcome']).toBe('last');
    await expect(readXlsx(buf, { sheet: 'Nope' })).rejects.toThrow(/worksheet "Nope" not found/);
    expect(cellText({ error: '#N/A' })).toBe('#N/A');
    expect(cellText({ text: 'link', hyperlink: 'http://x' })).toBe('link');
    expect(cellText(new Date(Date.UTC(2026, 1, 2, 10, 30)))).toBe('2026-02-02T10:30:00Z');
  });

  it('XLSX: multi-row cases with merged expected results and merged IDs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-xlsx-'));
    const path = join(dir, 'cases.xlsx');
    await writeFile(path, await workbook());
    const r = await importManualXlsx(path, { file: 'cases.xlsx' });
    expect(r.converted.map((c) => [c.id, c.name, c.kind])).toEqual([
      ['tc-10', 'Order a gadget', 'manual-xlsx'], ['tc-11', 'Fill the order form', 'manual-xlsx'], ['tc-12', 'Unclear', 'manual-xlsx'],
    ]);
    expect(body(r.converted[0].ez)).toEqual([
      'Open /login', 'Type "bob" into the Username field', 'Type "Builder#2" into the Password field', 'Click the "Sign in" button',
      '  Expect the URL contains "/dashboard"',
    ]);
    expect(r.converted[0].ez).toContain('Risk: 5');
    // The merged expected result is applied once, after the last merged step.
    expect(body(r.converted[1].ez)).toEqual([
      'Go to /orders/new', 'Select "Gadget (49.50)" from the Product dropdown', 'Fill the Quantity field with 3',
      '  Expect the "Quantity" field has value "3"',
    ]);
    expect(body(r.converted[2].ez)).toEqual([
      '# TODO (not converted): Make sure things are fine', '# TODO (not converted): Everything is fine', 'Reload the page',
    ]);
    expect(r.todo.map((t) => t.line)).toEqual([9, 9]);
    expect(r.coverage).toEqual({ sourceSteps: 9, convertedSteps: 8, assertions: 3, convertedAssertions: 2 });
  });
});
