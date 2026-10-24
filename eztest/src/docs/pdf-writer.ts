/**
 * A minimal PDF 1.4 writer for image-only documents (what a scanner produces):
 * one Flate-compressed DeviceGray or DeviceRGB image per page, scaled to the
 * page, no text layer. Written from the PDF specification (ISO 32000-1:
 * file structure 7.5, image XObjects 8.9); used to build scanned test
 * documents and to save rendered pages as PDF evidence.
 */
import { deflateSync } from 'node:zlib';

export interface PdfImagePage {
  /** Page size in points (1/72 inch). */
  widthPt: number;
  heightPt: number;
  /** Pixel size of the image. */
  width: number;
  height: number;
  /** 1 byte per pixel (gray) or 3 (RGB), row by row from the top. */
  pixels: Uint8Array;
  channels: 1 | 3;
}

export interface ImagePdfOptions {
  title?: string;
  producer?: string;
}

function pdfString(s: string): string {
  return `(${s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '?')})`;
}

/** Build an image-only PDF. */
export function writeImagePdf(pages: PdfImagePage[], o: ImagePdfOptions = {}): Uint8Array {
  if (!pages.length) throw new Error('writeImagePdf: no pages');
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (b: Buffer | string) => {
    const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
    chunks.push(buf);
    length += buf.length;
  };
  const obj = (n: number, body: Buffer | string, stream?: Buffer) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    push(body);
    if (stream) {
      push('\nstream\n');
      push(stream);
      push('\nendstream');
    }
    push('\nendobj\n');
  };
  // 1 catalog, 2 pages, 3 info, then per page: page, content, image.
  const pageIds = pages.map((_, i) => 4 + i * 3);
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  obj(3, `<< /Producer ${pdfString(o.producer ?? 'EZTest image PDF writer')}${o.title ? ` /Title ${pdfString(o.title)}` : ''} >>`);
  pages.forEach((p, i) => {
    if (p.pixels.length !== p.width * p.height * p.channels) throw new Error(`writeImagePdf: page ${i + 1} has ${p.pixels.length} bytes, expected ${p.width * p.height * p.channels}`);
    const id = pageIds[i];
    const w = +p.widthPt.toFixed(3);
    const h = +p.heightPt.toFixed(3);
    const content = Buffer.from(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`, 'latin1');
    obj(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);
    obj(id + 1, `<< /Length ${content.length} >>`, content);
    const data = deflateSync(Buffer.from(p.pixels.buffer, p.pixels.byteOffset, p.pixels.byteLength));
    obj(id + 2, `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /${p.channels === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>`, data);
  });
  const size = 4 + pages.length * 3;
  const xref = length;
  push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let n = 1; n < size; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(chunks));
}

/** RGBA pixels to 8-bit gray (ITU-R BT.601 luma). */
export function rgbaToGray(rgba: Uint8Array | Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
  return out;
}
