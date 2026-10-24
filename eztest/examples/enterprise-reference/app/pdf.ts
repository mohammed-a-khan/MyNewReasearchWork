/**
 * A small PDF 1.4 writer (no library): one or more A4 pages of positioned
 * text in the standard Helvetica fonts, a compressed content stream (zlib),
 * document info and a correct cross-reference table.
 */
import { deflateSync } from 'node:zlib';

export interface TextRun {
  x: number;
  y: number;
  text: string;
  size?: number;
  bold?: boolean;
}

const pdfString = (s: string) =>
  `(${s
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')})`;

export function buildPdf(pages: TextRun[][], info: { title: string; author: string; subject?: string; created?: Date }): Buffer {
  const objects: Array<string | Buffer> = [];
  const add = (o: string | Buffer) => objects.push(o) as number; // returns the object number
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const runs of pages) {
    const ops = runs
      .map((r) => `BT /${r.bold ? 'F2' : 'F1'} ${r.size ?? 10} Tf ${r.x.toFixed(2)} ${r.y.toFixed(2)} Td ${pdfString(r.text)} Tj ET`)
      .join('\n');
    const data = deflateSync(Buffer.from(ops, 'latin1'));
    const content = add(Buffer.concat([Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`), data, Buffer.from('\nendstream')]));
    kids.push(
      add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const d = info.created ?? new Date();
  const pdfDate = `D:${d.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
  const infoObj = add(
    `<< /Title ${pdfString(info.title)} /Author ${pdfString(info.author)} /Subject ${pdfString(info.subject ?? '')} /Producer (Larkspur statement service) /CreationDate (${pdfDate}) >>`,
  );

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(offset);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), typeof o === 'string' ? Buffer.from(o, 'latin1') : o, Buffer.from('\nendobj\n')]);
    chunks.push(b);
    offset += b.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${infoObj} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
