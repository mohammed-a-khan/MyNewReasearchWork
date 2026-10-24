/**
 * Rebuilds data/rating-matrix.xlsx, the rating scenarios the underwriting team maintains in Excel
 * (one sheet per product plus a read-me sheet). Run after editing the rows below:
 *
 *   npx tsx data/build-workbooks.ts
 */
import ExcelJS from 'exceljs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const columns = ['caseId', 'product', 'sumInsured', 'region', 'regionLabel', 'riskAge', 'noClaimsYears', 'runFlag', 'note'];

const home = [
  ['HOME-01', 'HOME', 250000, 'NORTH', 'North', 12, 0, 'Y', 'new build, no history'],
  ['HOME-02', 'HOME', 450000, 'COAST', 'Coast', 42, 3, 'Y', 'old property loading'],
  ['HOME-03', 'HOME', 600000, 'METRO', 'Metro', 31, 6, 'Y', 'no-claims capped at 5 years'],
  ['HOME-04', 'HOME', 60000, 'SOUTH', 'South', 5, 5, 'Y', 'minimum premium applies'],
  ['HOME-05', 'HOME', 980000, 'COAST', 'Coast', 80, 1, 'N', 'listed building: referred, not rated online'],
];
const motor = [
  ['MOTOR-01', 'MOTOR', 18500, 'METRO', 'Metro', 22, 0, 'Y', 'young driver loading'],
  ['MOTOR-02', 'MOTOR', 32000, 'COAST', 'Coast', 45, 4, 'Y', 'experienced driver'],
  ['MOTOR-03', 'MOTOR', 9000, 'NORTH', 'North', 25, 2, 'Y', 'loading ends at 25'],
  ['MOTOR-04', 'MOTOR', 54000, 'SOUTH', 'South', 61, 9, 'N', 'fleet: rated by underwriter'],
];

const wb = new ExcelJS.Workbook();
wb.creator = 'Larkspur underwriting';
const readme = wb.addWorksheet('ReadMe');
readme.addRow(['Larkspur rating scenarios']);
readme.addRow(['One sheet per product. runFlag Y rows run in the regression suite; N rows are documented but not rated online.']);
for (const [name, rows] of [['Home', home], ['Motor', motor]] as const) {
  const ws = wb.addWorksheet(name);
  ws.addRow(columns);
  for (const r of rows) ws.addRow(r);
  ws.getRow(1).font = { bold: true };
}
await wb.xlsx.writeFile(join(here, 'rating-matrix.xlsx'));
console.log('wrote data/rating-matrix.xlsx');
