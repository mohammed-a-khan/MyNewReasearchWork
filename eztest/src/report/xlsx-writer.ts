/**
 * A small writer for Office Open XML workbooks (.xlsx, ECMA-376 Part 1,
 * SpreadsheetML): several sheets of rows, inline strings, numbers and
 * booleans, a fixed set of cell styles (header, title, bold, percent,
 * decimals, links, wrapped text, status fills, muted), column widths, a
 * frozen header row, auto-filters and external hyperlinks. Written straight
 * to XML and zipped, so a workbook of 100,000 rows takes well under a second.
 */
import { writeZip } from '../browser/zip-writer.js';

/** Cell styles (index into cellXfs). */
export const XS = {
  none: 0, header: 1, title: 2, bold: 3, percent: 4, decimal: 5, link: 6, wrap: 7,
  passed: 8, healed: 9, flaky: 10, failed: 11, error: 12, skipped: 13, muted: 14, subtitle: 15,
} as const;
export type XStyle = keyof typeof XS;

export type XValue = string | number | boolean | null | undefined;
export type XCell = XValue | { v: XValue; s?: XStyle; link?: string };

export interface XSheet {
  name: string;
  /** Column widths in characters. */
  widths?: number[];
  rows: XCell[][];
  /** First row is a header: styled, frozen, with an auto-filter over the table. */
  header?: boolean;
  /** Style per column for the body rows (e.g. percent). */
  colStyles?: Array<XStyle | undefined>;
  gridLines?: boolean;
}

const esc = (s: string) => s
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Column letters of a 0-based column index (0 -> A, 26 -> AA). */
export function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const FILLS: Array<[XStyle, string]> = [['passed', 'FFE9F6E9'], ['healed', 'FFEFEDFB'], ['flaky', 'FFFDF4DD'], ['failed', 'FFFBEAEA'], ['error', 'FFFCEFE8'], ['skipped', 'FFF0EFEC']];

function stylesXml(): string {
  // fonts: 0 normal, 1 bold white, 2 bold 16, 3 bold, 4 link, 5 muted, 6 muted 11
  const fonts = [
    '<font><sz val="11"/><name val="Calibri"/></font>',
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>',
    '<font><b/><sz val="16"/><name val="Calibri"/></font>',
    '<font><b/><sz val="11"/><name val="Calibri"/></font>',
    '<font><u/><sz val="11"/><color rgb="FF1C5CAB"/><name val="Calibri"/></font>',
    '<font><sz val="11"/><color rgb="FF5F5E59"/><name val="Calibri"/></font>',
  ];
  // fills: 0 none, 1 gray125 (required), 2 header, 3.. status fills
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>', '<fill><patternFill patternType="solid"><fgColor rgb="FF1C5CAB"/><bgColor indexed="64"/></patternFill></fill>', ...FILLS.map(([, c]) => `<fill><patternFill patternType="solid"><fgColor rgb="${c}"/><bgColor indexed="64"/></patternFill></fill>`)];
  const xf = (font: number, fill: number, numFmt = 0, wrap = false) => `<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="0" xfId="0"${font ? ' applyFont="1"' : ''}${fill ? ' applyFill="1"' : ''}${numFmt ? ' applyNumberFormat="1"' : ''}${wrap ? ' applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>' : '/>'}`;
  const xfs = [
    xf(0, 0), xf(1, 2), xf(2, 0), xf(3, 0), xf(0, 0, 164), xf(0, 0, 165), xf(4, 0), xf(0, 0, 0, true),
    ...FILLS.map((_, i) => xf(0, 3 + i)), xf(5, 0), xf(5, 0),
  ];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="0.0%"/><numFmt numFmtId="165" formatCode="0.00"/></numFmts><fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}

function sheetXml(sh: XSheet): { xml: string; links: Array<{ ref: string; target: string }> } {
  const links: Array<{ ref: string; target: string }> = [];
  const width = Math.max(1, ...sh.rows.map((r) => r.length));
  const parts: string[] = [];
  sh.rows.forEach((row, ri) => {
    const r = ri + 1;
    const cells: string[] = [];
    row.forEach((cell, ci) => {
      const o = cell !== null && typeof cell === 'object' ? cell : { v: cell };
      const v = o.v;
      const ref = `${colName(ci)}${r}`;
      const styleName: XStyle | undefined = o.s ?? (sh.header && ri === 0 ? 'header' : o.link ? 'link' : ri > 0 ? sh.colStyles?.[ci] : undefined);
      const s = styleName ? ` s="${XS[styleName]}"` : '';
      if (o.link) links.push({ ref, target: o.link });
      if (v === null || v === undefined || v === '') {
        if (s) cells.push(`<c r="${ref}"${s}/>`);
      } else if (typeof v === 'number') cells.push(Number.isFinite(v) ? `<c r="${ref}"${s}><v>${v}</v></c>` : `<c r="${ref}"${s} t="inlineStr"><is><t>${String(v)}</t></is></c>`);
      else if (typeof v === 'boolean') cells.push(`<c r="${ref}"${s} t="b"><v>${v ? 1 : 0}</v></c>`);
      else {
        const t = String(v).slice(0, 32_767);
        cells.push(`<c r="${ref}"${s} t="inlineStr"><is><t${/^\s|\s$/.test(t) ? ' xml:space="preserve"' : ''}>${esc(t)}</t></is></c>`);
      }
    });
    parts.push(`<row r="${r}">${cells.join('')}</row>`);
  });
  const last = `${colName(width - 1)}${Math.max(1, sh.rows.length)}`;
  const view = `<sheetViews><sheetView workbookViewId="0"${sh.gridLines === false ? ' showGridLines="0"' : ''}>${sh.header ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' : ''}</sheetView></sheetViews>`;
  const cols = sh.widths?.length ? `<cols>${sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  const filter = sh.header && sh.rows.length > 1 ? `<autoFilter ref="A1:${last}"/>` : '';
  const hl = links.length ? `<hyperlinks>${links.map((l, i) => `<hyperlink ref="${l.ref}" r:id="rId${i + 1}"/>`).join('')}</hyperlinks>` : '';
  return {
    xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:${last}"/>${view}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${parts.join('')}</sheetData>${filter}${hl}</worksheet>`,
    links,
  };
}

/** Sheet names: at most 31 characters, none of []:*?/\, unique. */
function sheetName(n: string, used: Set<string>): string {
  let base = n.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet';
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 28)} ${i}`;
  used.add(name.toLowerCase());
  base = name;
  return base;
}

/** Write a workbook. */
export function writeXlsx(sheets: XSheet[], o: { title?: string; creator?: string; created?: Date } = {}): Buffer {
  if (!sheets.length) throw new Error('writeXlsx: no sheets');
  const used = new Set<string>();
  const names = sheets.map((s) => sheetName(s.name, used));
  const files: Array<{ name: string; data: Buffer }> = [];
  const put = (name: string, s: string) => files.push({ name, data: Buffer.from(s, 'utf8') });
  put('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);
  put('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  const created = (o.created ?? new Date()).toISOString().replace(/\.\d+Z$/, 'Z');
  put('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${o.title ? `<dc:title>${esc(o.title)}</dc:title>` : ''}<dc:creator>${esc(o.creator ?? 'EZTest')}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified></cp:coreProperties>`);
  put('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>EZTest</Application></Properties>`);
  const defined = sheets.map((s, i) => (s.header && s.rows.length > 1 ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${names[i].replace(/'/g, "''")}'!$A$1:$${colName(Math.max(1, ...s.rows.map((r) => r.length)) - 1)}$${s.rows.length}</definedName>` : '')).join('');
  put('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${defined ? `<definedNames>${defined}</definedNames>` : ''}</workbook>`);
  put('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  put('xl/styles.xml', stylesXml());
  sheets.forEach((sh, i) => {
    const { xml, links } = sheetXml(sh);
    put(`xl/worksheets/sheet${i + 1}.xml`, xml);
    if (links.length) put(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${links.map((l, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(l.target)}" TargetMode="External"/>`).join('')}</Relationships>`);
  });
  return writeZip(files);
}
