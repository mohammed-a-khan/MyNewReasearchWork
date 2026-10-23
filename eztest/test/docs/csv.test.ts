import { describe, expect, it } from '../support/testkit.js';
import { fromCsv, fromJson, fromUiLedger, fromXlsx, loadSource, parseCsv, parseCsvRecords } from '../../src/docs/index.js';
import { NotSupportedError } from '../../src/core/index.js';

describe('RFC 4180 CSV parser', () => {
  it('parses quoted fields with delimiters, escaped quotes and line breaks', () => {
    const text = '﻿id,name,notes\r\n1,"Smith, John","He said ""hi""\r\nand left"\r\n2,Jane,\n3,"",""\n';
    const t = parseCsv(text);
    expect(t.headers).toEqual(['id', 'name', 'notes']);
    expect(t.rows).toEqual([
      { id: '1', name: 'Smith, John', notes: 'He said "hi"\r\nand left' },
      { id: '2', name: 'Jane', notes: '' },
      { id: '3', name: '', notes: '' },
    ]);
  });

  it('handles no trailing newline, custom delimiters and CR-only line breaks', () => {
    expect(parseCsvRecords('a;b\r1;"x;y"', { delimiter: ';' })).toEqual([['a', 'b'], ['1', 'x;y']]);
    expect(parseCsvRecords('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsvRecords('a,\n')).toEqual([['a', '']]);
    expect(parseCsvRecords('"multi\nline\nvalue",z')).toEqual([['multi\nline\nvalue', 'z']]);
  });

  it('rejects malformed input instead of guessing', () => {
    expect(() => parseCsv('a,b\n"open,1\n')).toThrow(/unterminated/);
    expect(() => parseCsv('a,b\nx"y,1\n')).toThrow(/quote inside/);
    expect(() => parseCsv('a,b\n"x"y,1\n')).toThrow(/after closing quote/);
    expect(() => parseCsv('a,b\n1,2,3\n')).toThrow(/3 fields/);
    expect(() => parseCsv('a,a\n1,2\n')).toThrow(/more than once/);
    expect(parseCsv('a,b\n1,2,3\n', { relaxColumnCount: true }).rows).toEqual([{ a: '1', b: '2' }]);
  });
});

describe('sources', () => {
  it('builds record sets from CSV, JSON and UI ledgers', async () => {
    expect(fromCsv('k,v\n1,2').rows).toEqual([{ k: '1', v: '2' }]);
    const j = fromJson('{"data":{"items":[{"id":1,"customer":{"name":"A"},"tags":["x"]}]}}', { path: 'data.items' });
    expect(j.rows).toEqual([{ id: 1, 'customer.name': 'A', tags: '["x"]' }]);
    expect(() => fromJson('{"a":1}')).toThrow(/array/);
    expect(fromUiLedger({ total: '1.00' }).rows).toEqual([{ total: '1.00' }]);
    expect((await loadSource({ type: 'csv', text: 'a\n1' })).rows).toEqual([{ a: '1' }]);
  });

  it('reads XLSX sources (header row -> columns) and refuses empty sheets', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Report');
    ws.addRow(['Account', 'Amount']);
    ws.addRow(['A-1', 1250.5]);
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
    const set = await fromXlsx(bytes, { name: 'report.xlsx' });
    expect(set.kind).toBe('xlsx');
    expect(set.rows).toEqual([{ Account: 'A-1', Amount: '1250.5' }]);
    const empty = new ExcelJS.Workbook();
    empty.addWorksheet('E').addRow(['Only', 'Header']);
    await expect(fromXlsx(new Uint8Array(await empty.xlsx.writeBuffer()))).rejects.toThrow(/no data rows/);
    await expect(loadSource({ type: 'xlsx', path: '/nonexistent.xlsx' })).rejects.toThrow();
  });
});
