/**
 * Scanned-document fixtures: a text PDF is rendered to pixels, degraded like a
 * cheap office scan (gray, slightly dimmed, noise) and written back as an
 * image-only PDF with EZTest's own minimal PDF writer. The result has no text
 * layer at all, exactly like a scanner's output.
 */
import { renderPdfPages, rgbaToGray, writeImagePdf } from '../../src/docs/index.js';

export async function scanPdf(bytes: Uint8Array, o: { dpi?: number; noise?: number; seed?: number } = {}): Promise<Uint8Array> {
  const pages = await renderPdfPages(bytes, { dpi: o.dpi ?? 200 });
  let seed = o.seed ?? 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const noise = o.noise ?? 40;
  return writeImagePdf(pages.map((p) => {
    const g = rgbaToGray(p.rgba);
    for (let i = 0; i < g.length; i++) g[i] = Math.max(0, Math.min(255, Math.round(g[i] * 0.92 + 10 + (rnd() - 0.5) * noise)));
    return { widthPt: p.widthPt, heightPt: p.heightPt, width: p.width, height: p.height, pixels: g, channels: 1 as const };
  }), { title: 'scan' });
}

/** Levenshtein distance (character accuracy of OCR text). */
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}
