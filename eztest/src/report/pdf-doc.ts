/**
 * A small PDF 1.7 document writer for reports: text in the standard Helvetica
 * and Courier fonts (WinAnsi encoding, measured with the fonts' own metrics so
 * lines wrap correctly), filled and stroked shapes (rectangles, lines, arcs for
 * donut charts), RGB images (PNG decoded and down-scaled, JPEG passed through),
 * link annotations, a document outline (bookmarks) and page numbers.
 *
 * Written from the PDF specification (ISO 32000-1: file structure 7.5, text
 * 9, graphics 8, images 8.9, annotations 12.5, outlines 12.3.3); no
 * dependency beyond pngjs for decoding screenshots.
 */
import { deflateSync } from 'node:zlib';
import { PNG } from 'pngjs';

export type FontKey = 'R' | 'B' | 'M';
export type Rgb = [number, number, number];

/** Advance widths (1/1000 em) of WinAnsi codes 32..255 in the standard fonts. */
const HELVETICA = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,0,556,0,222,556,333,1000,556,556,333,1000,667,333,1000,0,611,0,0,222,222,333,333,350,556,1000,333,1000,500,333,944,0,500,500,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500];
const HELVETICA_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,0,556,0,278,556,500,1000,556,556,333,1000,667,333,1000,0,611,0,0,278,278,500,500,350,556,1000,333,1000,556,333,944,0,500,556,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556];
const FONT_NAME: Record<FontKey, string> = { R: 'Helvetica', B: 'Helvetica-Bold', M: 'Courier' };

/** Unicode code points that WinAnsi (Windows-1252) places at 0x80..0x9f. */
const WIN_HIGH: Record<number, number> = { 0x20ac: 0x80, 0x201a: 0x82, 0x192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x2c6: 0x88, 0x2030: 0x89, 0x160: 0x8a, 0x2039: 0x8b, 0x152: 0x8c, 0x17d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2dc: 0x98, 0x2122: 0x99, 0x161: 0x9a, 0x203a: 0x9b, 0x153: 0x9c, 0x17e: 0x9e, 0x178: 0x9f };
const FALLBACK: Record<number, string> = { 0x2192: '->', 0x2190: '<-', 0x2264: '<=', 0x2265: '>=', 0x2212: '-', 0x00a0: ' ', 0x2713: 'v', 0x2717: 'x', 0x00b7: '·' };

/** Text to WinAnsi codes (characters outside the encoding become close equivalents or "?"). */
export function winAnsi(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 9) out.push(32, 32);
    else if (cp >= 32 && cp < 127) out.push(cp);
    else if (cp >= 0xa0 && cp <= 0xff) out.push(cp);
    else if (WIN_HIGH[cp] !== undefined) out.push(WIN_HIGH[cp]);
    else if (FALLBACK[cp] !== undefined) for (const c of FALLBACK[cp]) out.push(c.charCodeAt(0));
    else if (cp >= 32) out.push(63);
  }
  return out;
}

/** Width of a text in points. */
export function textWidth(s: string, size: number, font: FontKey = 'R'): number {
  if (font === 'M') return winAnsi(s).length * 600 * size / 1000;
  const t = font === 'B' ? HELVETICA_BOLD : HELVETICA;
  let w = 0;
  for (const c of winAnsi(s)) w += t[c - 32] ?? 556;
  return (w * size) / 1000;
}

/** Wrap a text to lines no wider than `width` (words, then characters for long tokens). */
export function wrapText(s: string, width: number, size: number, font: FontKey = 'R', maxLines = Infinity): string[] {
  const lines: string[] = [];
  for (const para of s.replace(/\r/g, '').split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      const cand = line + word;
      if (textWidth(cand, size, font) <= width) {
        line = cand;
        continue;
      }
      if (line.trim()) lines.push(line.trimEnd());
      line = word.trimStart();
      while (textWidth(line, size, font) > width && line.length > 1) {
        let n = line.length;
        while (n > 1 && textWidth(line.slice(0, n), size, font) > width) n--;
        lines.push(line.slice(0, n));
        line = line.slice(n);
      }
    }
    lines.push(line.trimEnd());
    if (lines.length >= maxLines) break;
  }
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    cut[maxLines - 1] = `${cut[maxLines - 1].slice(0, Math.max(0, cut[maxLines - 1].length - 2))}…`;
    return cut;
  }
  return lines;
}

const num = (n: number) => (Math.round(n * 100) / 100).toString();
const color = (c: Rgb) => c.map((x) => num(x / 255)).join(' ');
const pdfStr = (s: string) => {
  const bytes = winAnsi(s);
  let out = '(';
  for (const b of bytes) out += b === 0x28 || b === 0x29 || b === 0x5c ? `\\${String.fromCharCode(b)}` : b < 32 || b > 126 ? `\\${b.toString(8).padStart(3, '0')}` : String.fromCharCode(b);
  return `${out})`;
};
/** A text string for document metadata and outlines (UTF-16BE with BOM). */
const pdfText = (s: string) => `<FEFF${[...s].map((c) => { const cp = c.codePointAt(0)!; if (cp > 0xffff) { const v = cp - 0x10000; return ((0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0')); } return cp.toString(16).padStart(4, '0'); }).join('').toUpperCase()}>`;

export interface PdfImage {
  id: number;
  width: number;
  height: number;
}

interface ImageData {
  width: number;
  height: number;
  data: Buffer;
  filter: 'DCTDecode' | 'FlateDecode';
  colorSpace: 'DeviceRGB' | 'DeviceGray';
  blank?: boolean;
}

interface Page {
  ops: string[];
  links: Array<{ x: number; y: number; w: number; h: number; uri: string }>;
  images: Set<number>;
}

/** Decode a PNG to RGB on white, down-scaled (box filter) to at most `maxWidth` pixels wide. */
function pngToRgb(buf: Buffer, maxWidth: number, maxHeight: number): ImageData {
  const png = PNG.sync.read(buf);
  const scale = Math.min(1, maxWidth / png.width, maxHeight / png.height);
  const w = Math.max(1, Math.round(png.width * scale));
  const h = Math.max(1, Math.round(png.height * scale));
  const out = Buffer.alloc(w * h * 3);
  const sx = png.width / w;
  const sy = png.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1 && yy < png.height; yy += y1 - y0 > 4 ? 2 : 1) {
        for (let xx = x0; xx < x1 && xx < png.width; xx += x1 - x0 > 4 ? 2 : 1) {
          const i = (yy * png.width + xx) * 4;
          const a = png.data[i + 3] / 255;
          r += png.data[i] * a + 255 * (1 - a);
          g += png.data[i + 1] * a + 255 * (1 - a);
          b += png.data[i + 2] * a + 255 * (1 - a);
          n++;
        }
      }
      const o = (y * w + x) * 3;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
    }
  }
  return { width: w, height: h, data: deflateSync(out, { level: 6 }), filter: 'FlateDecode', colorSpace: 'DeviceRGB', blank: isBlank(out) };
}

/** True when (almost) every pixel has the same colour: a blank page says nothing. */
function isBlank(rgb: Buffer): boolean {
  const r0 = rgb[0];
  const g0 = rgb[1];
  const b0 = rgb[2];
  let differ = 0;
  const n = rgb.length / 3;
  for (let i = 0; i < rgb.length; i += 3 * 7) if (Math.abs(rgb[i] - r0) + Math.abs(rgb[i + 1] - g0) + Math.abs(rgb[i + 2] - b0) > 24) differ++;
  return differ / (n / 7) < 0.002;
}

/** Size and components of a baseline or progressive JPEG (from its SOF marker). */
function jpegInfo(buf: Buffer): ImageData {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error('not a JPEG');
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      const comps = buf[i + 9];
      return { width, height, data: buf, filter: 'DCTDecode', colorSpace: comps === 1 ? 'DeviceGray' : 'DeviceRGB' };
    }
    i += 2 + len;
  }
  throw new Error('JPEG without a frame header');
}

export interface PdfDocOptions {
  title: string;
  author?: string;
  subject?: string;
  /** Page size in points (default A4 portrait). */
  width?: number;
  height?: number;
  margin?: number;
  lang?: string;
}

/** A PDF being written page by page, with a top-down cursor (`y`) for flowing content. */
export class PdfDoc {
  readonly width: number;
  readonly height: number;
  readonly margin: number;
  /** Cursor: the top of the next block, in points from the bottom of the page. */
  y = 0;
  private pages: Page[] = [];
  private imagesData: ImageData[] = [];
  private outline: Array<{ title: string; page: number; y: number }> = [];
  private onNewPage?: (doc: PdfDoc) => void;

  constructor(private o: PdfDocOptions) {
    this.width = o.width ?? 595.28;
    this.height = o.height ?? 841.89;
    this.margin = o.margin ?? 40;
    this.addPage();
  }

  get contentWidth(): number {
    return this.width - 2 * this.margin;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  /** Called on every new page after the first (running header). */
  setPageHeader(fn: (doc: PdfDoc) => void): void {
    this.onNewPage = fn;
  }

  private get page(): Page {
    return this.pages[this.pages.length - 1];
  }

  addPage(): void {
    this.pages.push({ ops: [], links: [], images: new Set() });
    this.y = this.height - this.margin;
    if (this.pages.length > 1) this.onNewPage?.(this);
  }

  /** Start a new page when fewer than `h` points are left above the bottom margin (plus the footer). */
  ensure(h: number): void {
    if (this.y - h < this.margin + 18) this.addPage();
  }

  /** A bookmark to the current position. */
  bookmark(title: string): void {
    this.outline.push({ title, page: this.pages.length - 1, y: Math.min(this.height, this.y + 14) });
  }

  text(x: number, y: number, s: string, o: { size?: number; font?: FontKey; color?: Rgb } = {}): void {
    const size = o.size ?? 10;
    this.page.ops.push(`BT /F${o.font ?? 'R'} ${num(size)} Tf ${color(o.color ?? [20, 20, 19])} rg ${num(x)} ${num(y)} Td ${pdfStr(s)} Tj ET`);
  }

  rect(x: number, y: number, w: number, h: number, o: { fill?: Rgb; stroke?: Rgb; lineWidth?: number } = {}): void {
    const parts = [`${num(x)} ${num(y)} ${num(w)} ${num(h)} re`];
    const op = o.fill && o.stroke ? 'B' : o.fill ? 'f' : 'S';
    this.page.ops.push(`q ${o.fill ? `${color(o.fill)} rg ` : ''}${o.stroke ? `${color(o.stroke)} RG ${num(o.lineWidth ?? 0.75)} w ` : ''}${parts[0]} ${op} Q`);
  }

  line(x1: number, y1: number, x2: number, y2: number, o: { stroke?: Rgb; lineWidth?: number } = {}): void {
    this.page.ops.push(`q ${color(o.stroke ?? [195, 194, 183])} RG ${num(o.lineWidth ?? 0.5)} w ${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S Q`);
  }

  /** A polyline (chart series). */
  polyline(points: Array<[number, number]>, o: { stroke: Rgb; lineWidth?: number; fill?: Rgb; baseline?: number }): void {
    if (points.length < 2) return;
    const path = points.map(([x, y], i) => `${num(x)} ${num(y)} ${i ? 'l' : 'm'}`).join(' ');
    if (o.fill && o.baseline !== undefined) {
      const area = `${path} ${num(points[points.length - 1][0])} ${num(o.baseline)} l ${num(points[0][0])} ${num(o.baseline)} l h`;
      this.page.ops.push(`q ${color(o.fill)} rg ${area} f Q`);
    }
    this.page.ops.push(`q ${color(o.stroke)} RG ${num(o.lineWidth ?? 1.5)} w 1 j ${path} S Q`);
  }

  /** A ring segment (donut chart) from angle a0 to a1 (radians, clockwise from 12 o'clock). */
  ringSegment(cx: number, cy: number, r: number, inner: number, a0: number, a1: number, fill: Rgb): void {
    const pt = (rad: number, a: number): [number, number] => [cx + rad * Math.sin(a), cy + rad * Math.cos(a)];
    const arc = (rad: number, from: number, to: number): string => {
      const segs = Math.max(1, Math.ceil(Math.abs(to - from) / (Math.PI / 2)));
      const step = (to - from) / segs;
      let out = '';
      for (let i = 0; i < segs; i++) {
        const s = from + i * step;
        const e = s + step;
        const k = (4 / 3) * Math.tan((e - s) / 4);
        const [x0, y0] = pt(rad, s);
        const [x3, y3] = pt(rad, e);
        const c1: [number, number] = [x0 + k * rad * Math.cos(s), y0 - k * rad * Math.sin(s)];
        const c2: [number, number] = [x3 - k * rad * Math.cos(e), y3 + k * rad * Math.sin(e)];
        out += ` ${num(c1[0])} ${num(c1[1])} ${num(c2[0])} ${num(c2[1])} ${num(x3)} ${num(y3)} c`;
      }
      return out;
    };
    const [sx, sy] = pt(r, a0);
    const [ix, iy] = pt(inner, a1);
    this.page.ops.push(`q ${color(fill)} rg ${num(sx)} ${num(sy)} m${arc(r, a0, a1)} ${num(ix)} ${num(iy)} l${arc(inner, a1, a0)} h f Q`);
  }

  /** Register an image (PNG or JPEG bytes); undefined when it cannot be decoded. */
  addImage(bytes: Buffer, o: { maxWidth?: number; maxHeight?: number; skipBlank?: boolean } = {}): PdfImage | undefined {
    try {
      let img: ImageData;
      if (bytes[0] === 0x89 && bytes[1] === 0x50) img = pngToRgb(bytes, o.maxWidth ?? 1000, o.maxHeight ?? 3000);
      else if (bytes[0] === 0xff && bytes[1] === 0xd8) img = jpegInfo(bytes);
      else return undefined;
      if (o.skipBlank && img.blank) return undefined;
      this.imagesData.push(img);
      return { id: this.imagesData.length - 1, width: img.width, height: img.height };
    } catch {
      return undefined;
    }
  }

  image(img: PdfImage, x: number, y: number, w: number, h: number): void {
    this.page.images.add(img.id);
    this.page.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm /Im${img.id} Do Q`);
  }

  /** A clickable area opening `uri` (http(s) or a relative file such as report.html#test/x). */
  link(x: number, y: number, w: number, h: number, uri: string): void {
    this.page.links.push({ x, y, w, h, uri });
  }

  /** Write wrapped text at the cursor and move the cursor down. Returns the lines written. */
  paragraph(s: string, o: { x?: number; width?: number; size?: number; font?: FontKey; color?: Rgb; leading?: number; maxLines?: number; gap?: number } = {}): number {
    const size = o.size ?? 10;
    const lead = o.leading ?? size * 1.35;
    const x = o.x ?? this.margin;
    const lines = wrapText(s, o.width ?? this.width - this.margin - x, size, o.font ?? 'R', o.maxLines);
    for (const l of lines) {
      this.ensure(lead);
      this.y -= lead;
      this.text(x, this.y + (lead - size) / 2 + 1, l, { size, font: o.font, color: o.color });
    }
    this.y -= o.gap ?? 0;
    return lines.length;
  }

  /** Serialise the document. */
  build(): Buffer {
    const chunks: Buffer[] = [];
    const offsets: number[] = [];
    let length = 0;
    const push = (b: Buffer | string) => {
      const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
      chunks.push(buf);
      length += buf.length;
    };
    let next = 1;
    const alloc = () => next++;
    const body: Array<{ id: number; dict: string; stream?: Buffer }> = [];
    const catalogId = alloc();
    const pagesId = alloc();
    const infoId = alloc();
    const fontIds: Record<FontKey, number> = { R: alloc(), B: alloc(), M: alloc() };
    for (const k of Object.keys(fontIds) as FontKey[]) body.push({ id: fontIds[k], dict: `<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_NAME[k]} /Encoding /WinAnsiEncoding >>` });
    const imageIds = this.imagesData.map((img) => {
      const id = alloc();
      body.push({ id, dict: `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /${img.colorSpace} /BitsPerComponent 8 /Filter /${img.filter} /Length ${img.data.length} >>`, stream: img.data });
      return id;
    });
    const fonts = `/Font << /FR ${fontIds.R} 0 R /FB ${fontIds.B} 0 R /FM ${fontIds.M} 0 R >>`;
    const pageIds: number[] = [];
    const total = this.pages.length;
    this.pages.forEach((p, i) => {
      // Footer: page number, on every page.
      const footer = `Page ${i + 1} of ${total}`;
      const fw = textWidth(footer, 8);
      p.ops.push(`BT /FR 8 Tf ${color([95, 94, 89])} rg ${num(this.width - this.margin - fw)} ${num(this.margin - 16)} Td ${pdfStr(footer)} Tj ET`);
      p.ops.push(`BT /FR 8 Tf ${color([95, 94, 89])} rg ${num(this.margin)} ${num(this.margin - 16)} Td ${pdfStr(this.o.title.slice(0, 90))} Tj ET`);
      const content = deflateSync(Buffer.from(p.ops.join('\n'), 'latin1'));
      const contentId = alloc();
      body.push({ id: contentId, dict: `<< /Length ${content.length} /Filter /FlateDecode >>`, stream: content });
      const annots = p.links.map((l) => {
        const id = alloc();
        body.push({ id, dict: `<< /Type /Annot /Subtype /Link /Rect [${num(l.x)} ${num(l.y)} ${num(l.x + l.w)} ${num(l.y + l.h)}] /Border [0 0 0] /A << /S /URI /URI ${pdfStr(l.uri)} >> >>` });
        return id;
      });
      const xobj = [...p.images].map((n) => `/Im${n} ${imageIds[n]} 0 R`).join(' ');
      const pageId = alloc();
      pageIds.push(pageId);
      body.push({ id: pageId, dict: `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] /Resources << ${fonts}${xobj ? ` /XObject << ${xobj} >>` : ''} >> /Contents ${contentId} 0 R${annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}]` : ''} >>` });
    });
    let outlinesRef = '';
    if (this.outline.length) {
      const rootId = alloc();
      const ids = this.outline.map(() => alloc());
      this.outline.forEach((b, i) => {
        body.push({ id: ids[i], dict: `<< /Title ${pdfText(b.title)} /Parent ${rootId} 0 R${i ? ` /Prev ${ids[i - 1]} 0 R` : ''}${i < ids.length - 1 ? ` /Next ${ids[i + 1]} 0 R` : ''} /Dest [${pageIds[b.page]} 0 R /XYZ 0 ${num(b.y)} 0] >>` });
      });
      body.push({ id: rootId, dict: `<< /Type /Outlines /First ${ids[0]} 0 R /Last ${ids[ids.length - 1]} 0 R /Count ${ids.length} >>` });
      outlinesRef = ` /Outlines ${rootId} 0 R /PageMode /UseOutlines`;
    }
    body.push({ id: catalogId, dict: `<< /Type /Catalog /Pages ${pagesId} 0 R${outlinesRef} /Lang ${pdfText(this.o.lang ?? 'en')} /ViewerPreferences << /DisplayDocTitle true >> >>` });
    body.push({ id: pagesId, dict: `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>` });
    const date = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    body.push({ id: infoId, dict: `<< /Title ${pdfText(this.o.title)}${this.o.author ? ` /Author ${pdfText(this.o.author)}` : ''}${this.o.subject ? ` /Subject ${pdfText(this.o.subject)}` : ''} /Producer ${pdfText('EZTest report PDF writer')} /CreationDate (D:${date}Z) >>` });

    push('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
    for (const o of body.sort((a, b) => a.id - b.id)) {
      offsets[o.id] = length;
      push(`${o.id} 0 obj\n`);
      push(o.dict);
      if (o.stream) {
        push('\nstream\n');
        push(o.stream);
        push('\nendstream');
      }
      push('\nendobj\n');
    }
    const xref = length;
    push(`xref\n0 ${next}\n0000000000 65535 f \n`);
    for (let n = 1; n < next; n++) push(`${String(offsets[n] ?? 0).padStart(10, '0')} 00000 n \n`);
    push(`trailer\n<< /Size ${next} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return Buffer.concat(chunks);
  }
}
