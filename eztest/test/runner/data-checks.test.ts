/**
 * Data files are read without silent losses: a CSV (or an Examples table)
 * with two columns of one name is an error naming the column, instead of
 * keeping only the last column's values; XLSX numbers come as the cell shows
 * them (its number format's decimals, else Excel's 15 significant digits),
 * not as binary floating-point noise.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from '../support/testkit.js';
import { readDataRows } from '../../src/runner/flow.js';
import { parseEzScript } from '../../src/intent/index.js';
import { numberText, readXlsx } from '../../src/importers/index.js';

describe('duplicate column names', () => {
  it('a CSV header with a repeated column is an error that names it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-data-'));
    const f = join(dir, 'users.csv');
    await writeFile(f, 'user,amount, user ,note\nada,1,bob,x\n');
    await expect(readDataRows(f)).rejects.toThrow(/users\.csv: the column "user" appears twice in the header \(columns 1 and 3\); give every column its own name/);
    const ok = join(dir, 'ok.csv');
    await writeFile(ok, 'user,amount\nada,1\n');
    expect(await readDataRows(ok)).toEqual([{ user: 'ada', amount: '1' }]);
  });

  it('an Examples table with a repeated column is a parse error that names it', () => {
    expect(() => parseEzScript('Journey: Dup\nWait 1 ms\nExamples:\n| user | pass | user |\n| ada | x | bob |\n')).toThrow(/the column "user" appears twice in the header \(columns 1 and 3\)/);
  });
});

describe('XLSX numbers', () => {
  it('rounds to the displayed precision of the cell', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Data');
    ws.addRow(['General', 'TwoDecimals', 'Percent', 'Integer', 'Text', 'Formula']);
    const r = ws.addRow([0.1 + 0.2, 1.005, 0.12345, 2.4, 'keep 0.30000000000000004', { formula: 'A2*3', result: 0.30000000000000004 * 3 }]);
    r.getCell(2).numFmt = '0.00';
    r.getCell(3).numFmt = '0.0%';
    r.getCell(4).numFmt = '#,##0';
    r.getCell(6).numFmt = '0.000';
    const dir = await mkdtemp(join(tmpdir(), 'ez-xlsx-'));
    const f = join(dir, 'data.xlsx');
    await wb.xlsx.writeFile(f);
    expect(await readXlsx(f)).toEqual([{ General: '0.3', TwoDecimals: '1.01', Percent: '0.123', Integer: '2', Text: 'keep 0.30000000000000004', Formula: '0.9' }]);
    expect(await readDataRows(f)).toEqual([{ General: '0.3', TwoDecimals: '1.01', Percent: '0.123', Integer: '2', Text: 'keep 0.30000000000000004', Formula: '0.9' }]);
  });

  it('formats numbers like Excel shows them', () => {
    expect(numberText(0.1 + 0.2)).toBe('0.3');
    expect(numberText(1234.5678, '#,##0.00')).toBe('1234.57');
    expect(numberText(0.5, '0%')).toBe('0.5');
    expect(numberText(1e21)).toBe('1e+21');
    expect(numberText(12.5, '0.00E+00')).toBe('12.5');
    expect(numberText(3.14159, '"€"#,##0.00;[Red]-"€"#,##0.00')).toBe('3.14');
    expect(numberText(42, 'General')).toBe('42');
  });
});
