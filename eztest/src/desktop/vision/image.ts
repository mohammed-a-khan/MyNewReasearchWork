/** Grayscale images over pngjs (already an EZTest dependency): decode, resize, crop, annotate. */
import { PNG } from 'pngjs';

export interface Gray {
  width: number;
  height: number;
  /** Luma 0..255, row-major. */
  data: Float32Array;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function decodePng(png: Buffer): PNG {
  return PNG.sync.read(png);
}

export function toGray(img: { width: number; height: number; data: Uint8Array | Buffer }): Gray {
  const out = new Float32Array(img.width * img.height);
  const d = img.data;
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const a = d[p + 3] / 255;
    // Transparent pixels count as white (templates cut out with alpha).
    out[i] = (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) * a + 255 * (1 - a);
  }
  return { width: img.width, height: img.height, data: out };
}

export function grayFromPng(png: Buffer): Gray {
  return toGray(decodePng(png));
}

/** Area-averaging resize (good for downscaling) with bilinear sampling when upscaling. */
export function resize(g: Gray, width: number, height: number): Gray {
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));
  const out = new Float32Array(width * height);
  const sx = g.width / width;
  const sy = g.height / height;
  if (sx >= 1 && sy >= 1) {
    for (let y = 0; y < height; y++) {
      const y0 = Math.floor(y * sy);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      for (let x = 0; x < width; x++) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
        let s = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += g.data[yy * g.width + xx];
        out[y * width + x] = s / ((y1 - y0) * (x1 - x0));
      }
    }
    return { width, height, data: out };
  }
  for (let y = 0; y < height; y++) {
    const fy = Math.min(g.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(g.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(g.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(g.width - 1, x0 + 1);
      const tx = fx - x0;
      const a = g.data[y0 * g.width + x0] * (1 - tx) + g.data[y0 * g.width + x1] * tx;
      const b = g.data[y1 * g.width + x0] * (1 - tx) + g.data[y1 * g.width + x1] * tx;
      out[y * width + x] = a * (1 - ty) + b * ty;
    }
  }
  return { width, height, data: out };
}

/** A sub-image (clamped to the image). */
export function cropPng(png: Buffer, b: Box): Buffer {
  const src = decodePng(png);
  const x = Math.max(0, Math.floor(b.x));
  const y = Math.max(0, Math.floor(b.y));
  const w = Math.max(1, Math.min(src.width - x, Math.round(b.width)));
  const h = Math.max(1, Math.min(src.height - y, Math.round(b.height)));
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(src, out, x, y, w, h, 0, 0);
  return PNG.sync.write(out);
}

/** Draw rectangle outlines (evidence of what matched / where the click went). */
export function annotate(png: Buffer, boxes: Array<Box & { color?: [number, number, number] }>, marks: Array<{ x: number; y: number }> = []): Buffer {
  const img = decodePng(png);
  const put = (x: number, y: number, c: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const p = (Math.floor(y) * img.width + Math.floor(x)) * 4;
    img.data[p] = c[0];
    img.data[p + 1] = c[1];
    img.data[p + 2] = c[2];
    img.data[p + 3] = 255;
  };
  for (const b of boxes) {
    const c = b.color ?? [255, 0, 160];
    for (let t = 0; t < 2; t++) {
      for (let x = b.x - t; x <= b.x + b.width + t; x++) {
        put(x, b.y - t, c);
        put(x, b.y + b.height + t, c);
      }
      for (let y = b.y - t; y <= b.y + b.height + t; y++) {
        put(b.x - t, y, c);
        put(b.x + b.width + t, y, c);
      }
    }
  }
  for (const m of marks) {
    for (let d = -6; d <= 6; d++) {
      put(m.x + d, m.y, [0, 200, 255]);
      put(m.x, m.y + d, [0, 200, 255]);
    }
  }
  return PNG.sync.write(img);
}
