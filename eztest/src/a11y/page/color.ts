/**
 * Colours and contrast. Relative luminance and contrast ratio follow the
 * WCAG 2.2 definitions (sRGB, linearised with the 0.04045 threshold;
 * (L1 + 0.05) / (L2 + 0.05)). CSS colours in any syntax the browser knows
 * (rgb, hsl, hwb, lab, oklch, color(), color-mix, system colours) are
 * resolved to sRGB through a 1x1 canvas.
 */
import { composedParent, lowerTag, style } from '../../browser/injected/page/dom.js';

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 1 };
const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };

const cache = new Map<string, RGBA | null>();
let canvasCtx: CanvasRenderingContext2D | null | undefined;

function viaCanvas(css: string): RGBA | null {
  if (canvasCtx === undefined) {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      canvasCtx = c.getContext('2d', { willReadFrequently: true });
    } catch {
      canvasCtx = null;
    }
  }
  const ctx = canvasCtx;
  if (!ctx) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = '#010203';
  const sentinel = ctx.fillStyle;
  ctx.fillStyle = css;
  if (ctx.fillStyle === sentinel && css.replace(/\s/g, '') !== 'rgb(1,2,3)') return null;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
}

/** Parse a computed CSS colour. null when the browser cannot resolve it. */
export function parseColor(css: string): RGBA | null {
  const key = css.trim();
  if (cache.has(key)) return cache.get(key) ?? null;
  let out: RGBA | null = null;
  if (key === 'transparent') out = TRANSPARENT;
  else {
    const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(key);
    if (m) {
      const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      out = { r: +m[1], g: +m[2], b: +m[3], a };
    } else out = viaCanvas(key);
  }
  cache.set(key, out);
  return out;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function luminance(c: RGBA): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

export function contrast(a: RGBA, b: RGBA): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Source-over composition of `top` onto `bottom`. */
export function blend(top: RGBA, bottom: RGBA): RGBA {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return TRANSPARENT;
  const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

export function toCss(c: RGBA): string {
  const h = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${c.a < 1 ? h(c.a * 255) : ''}`;
}

export function round2(n: number): number {
  return Math.floor(n * 100) / 100;
}

/** Product of the opacity of the element and its ancestors (flat tree). */
export function effectiveOpacity(el: Element): number {
  let o = 1;
  for (let p: Element | null = el; p; p = composedParent(p)) {
    const v = parseFloat(style(p).opacity);
    if (!Number.isNaN(v)) o *= v;
    if (o === 0) return 0;
  }
  return o;
}

export interface Background {
  color: RGBA;
  /** Why the background cannot be determined exactly (image, gradient, overlap, blending). */
  uncertain?: string;
  /** Colours a gradient passes through (all composited), for best/worst-case checks. */
  stops?: RGBA[];
}

const REPLACED = new Set(['img', 'video', 'canvas', 'svg', 'picture', 'iframe', 'object', 'embed']);

function canvasColor(doc: Document): RGBA {
  // The root background, or the canvas (white unless a dark colour scheme is in force).
  const root = doc.documentElement;
  const scheme = root ? style(root).colorScheme || '' : '';
  if (/\bdark\b/.test(scheme) && !/\blight\b/.test(scheme)) return parseColor('Canvas') ?? WHITE;
  return WHITE;
}

function gradientStops(image: string): RGBA[] {
  const out: RGBA[] = [];
  const re = /(rgba?\([^)]*\)|#[0-9a-f]{3,8}\b|\b(?:transparent|white|black)\b|(?:oklch|oklab|lab|lch|hsla?|hwb|color)\([^)]*\))/gi;
  for (const m of image.matchAll(re)) {
    const c = parseColor(m[1]);
    if (c) out.push(c);
  }
  return out;
}

/**
 * The background behind an element's content. Layers come from the
 * hit-test stack at `point` when the point is in the viewport (catching
 * positioned overlays), otherwise from the ancestor chain.
 */
export function backgroundOf(el: Element, point?: { x: number; y: number }): Background {
  if (!point) return chainBackground(el);
  const doc = el.ownerDocument;
  let layers: Element[] = [];
  let uncertain: string | undefined;
  if (point) {
    const root = el.getRootNode() as Document | ShadowRoot;
    let stack: Element[] = [];
    try {
      stack = (root.elementsFromPoint ? root.elementsFromPoint(point.x, point.y) : doc.elementsFromPoint(point.x, point.y)) as Element[];
    } catch {
      stack = [];
    }
    const i = stack.indexOf(el);
    if (i >= 0) {
      for (const above of stack.slice(0, i)) {
        if (el.contains(above) || (above as Element).shadowRoot?.contains(el)) continue;
        const s = style(above);
        const bg = parseColor(s.backgroundColor);
        if ((bg && bg.a > 0) || s.backgroundImage !== 'none') {
          uncertain = 'the text is overlapped by another element';
          break;
        }
      }
      layers = stack.slice(i);
    }
  }
  if (!layers.length) for (let p: Element | null = el; p; p = composedParent(p)) layers.push(p);

  const collected: RGBA[] = [];
  let stops: RGBA[] | undefined;
  for (const layer of layers) {
    const tag = lowerTag(layer);
    const s = style(layer);
    if (layer !== el && REPLACED.has(tag)) {
      uncertain ??= `an image or embedded content (<${tag}>) is behind the text`;
      break;
    }
    const img = s.backgroundImage;
    const bg = parseColor(s.backgroundColor) ?? TRANSPARENT;
    const op = layer === el ? 1 : parseFloat(s.opacity) || 1;
    if (bg.a > 0) collected.push({ ...bg, a: bg.a * op });
    if (img && img !== 'none') {
      if (/gradient\(/.test(img) && !/url\(/.test(img)) {
        stops = gradientStops(img);
        uncertain ??= 'the background is a gradient';
      } else uncertain ??= 'the background is an image';
      break;
    }
    if (s.mixBlendMode && s.mixBlendMode !== 'normal') uncertain ??= 'a blend mode changes the colours';
    if (bg.a >= 1) break;
  }
  const base = canvasColor(doc);
  const above = (under: RGBA) => {
    let c = under;
    for (let i = collected.length - 1; i >= 0; i--) c = blend(collected[i], c);
    return c;
  };
  if (stops?.length) {
    stops = stops.map((c) => above(blend(c, base)));
    return { color: stops[0], uncertain, stops };
  }
  return { color: above(base), uncertain };
}

let chainMemo = new WeakMap<Element, Background>();

/** Forget memoised backgrounds (styles may have changed since the last run). */
export function resetBackgroundMemo(): void {
  chainMemo = new WeakMap();
}

/**
 * The background from the ancestor chain alone (no overlap detection),
 * memoised per element: an element's background is its own layer over its
 * parent's.
 */
export function chainBackground(el: Element): Background {
  const cached = chainMemo.get(el);
  if (cached) return cached;
  const parent = composedParent(el);
  const under: Background = parent ? chainBackground(parent) : { color: canvasColor(el.ownerDocument) };
  const s = style(el);
  const tag = lowerTag(el);
  let out: Background;
  const own = parseColor(s.backgroundColor) ?? TRANSPARENT;
  const op = parseFloat(s.opacity);
  const fill = { ...own, a: own.a * (Number.isNaN(op) ? 1 : op) };
  const img = s.backgroundImage;
  if (img && img !== 'none') {
    const base = fill.a > 0 ? blend(fill, under.color) : under.color;
    if (/gradient\(/.test(img) && !/url\(/.test(img)) {
      const stops = gradientStops(img).map((c) => blend(c, base));
      out = { color: stops[0] ?? base, uncertain: 'the background is a gradient', stops: stops.length ? stops : undefined };
    } else out = { color: base, uncertain: 'the background is an image' };
  } else if (fill.a >= 1) out = { color: fill };
  else if (fill.a > 0) out = { color: blend(fill, under.color), uncertain: under.uncertain, stops: under.stops?.map((c) => blend(fill, c)) };
  else out = under;
  if (tag !== 'html' && s.mixBlendMode && s.mixBlendMode !== 'normal') out = { ...out, uncertain: out.uncertain ?? 'a blend mode changes the colours' };
  chainMemo.set(el, out);
  return out;
}
