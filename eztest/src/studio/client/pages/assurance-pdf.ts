/**
 * PDF viewer for document assurance: pages rendered by pdf.js (self-hosted
 * ES module + module worker, loaded on first use; opened with
 * isEvalSupported: false so the strict CSP holds), page thumbnails, zoom,
 * and highlight boxes drawn at the positions EZTest extracted (PDF points,
 * top-left origin, placed in percent of the page so zoom never moves them).
 * Highlights are buttons: keyboard reachable, labelled, and clickable.
 */
import { TOKEN } from '../core/api.js';
import { clear, h } from '../core/dom.js';

interface PdfViewport {
  width: number;
  height: number;
}
interface PdfRenderTask {
  promise: Promise<void>;
  cancel(): void;
}
interface PdfPageProxy {
  getViewport(o: { scale: number }): PdfViewport;
  render(o: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport; transform?: number[] }): PdfRenderTask;
}
interface PdfDocumentProxy {
  numPages: number;
  getPage(n: number): Promise<PdfPageProxy>;
  destroy(): Promise<void>;
}
interface PdfJsLib {
  getDocument(src: Record<string, unknown>): { promise: Promise<PdfDocumentProxy> };
  GlobalWorkerOptions: { workerSrc: string };
}

const LIB_URL = '/assets/pdfjs/pdf.mjs';
let libPromise: Promise<PdfJsLib> | undefined;

/** Load pdf.js from the Studio itself (never a CDN). */
export function loadPdfJs(): Promise<PdfJsLib> {
  if (!libPromise) {
    const url: string = LIB_URL;
    libPromise = (import(url) as Promise<PdfJsLib>).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = '/assets/pdfjs/pdf.worker.mjs';
      return lib;
    });
    libPromise.catch(() => (libPromise = undefined));
  }
  return libPromise;
}

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewerHighlight {
  page: number;
  bbox: BBox;
  kind: string;
  ref: string;
  severity: 'error' | 'warning' | 'info';
  label: string;
  item?: number;
  /** "mismatch" (default), "pii" or "field" (an agreeing field, shown faintly). */
  layer?: 'mismatch' | 'pii' | 'field';
}

export interface PdfViewerHandle {
  el: HTMLElement;
  scroller: HTMLElement;
  ready: Promise<void>;
  readonly scale: number;
  readonly pageCount: number;
  setScale(scale: number | 'fit'): void;
  setHighlights(list: ViewerHighlight[]): void;
  setLayers(hidden: string[]): void;
  /** Scroll to and pulse the n-th highlight matching `pred`; returns it. */
  reveal(pred: (h: ViewerHighlight) => boolean, opts?: { focus?: boolean }): ViewerHighlight | undefined;
  goToPage(n: number): void;
  destroy(): void;
}

interface PageSlot {
  n: number;
  wPt: number;
  hPt: number;
  box: HTMLElement;
  canvas: HTMLCanvasElement;
  layer: HTMLElement;
  renderedAt?: number;
  task?: PdfRenderTask;
}

export function createPdfViewer(opts: { url: string; name: string; label: string; highlights?: ViewerHighlight[]; thumbnails?: boolean; onHighlight?(h: ViewerHighlight): void }): PdfViewerHandle {
  const scroller = h('div', { class: 'pdfv-scroll', tabindex: '0', role: 'group', 'aria-label': `${opts.label}: pages` });
  const thumbs = h('ul', { class: 'pdfv-thumbs', 'aria-label': `${opts.label}: page thumbnails` });
  const pageInfo = h('span', { class: 'muted', 'aria-live': 'polite' });
  const head = h('div', { class: 'pdfv-head' }, h('strong', { class: 'grow', title: opts.name, text: opts.name }), pageInfo);
  const el = h('div', { class: ['pdfv', opts.thumbnails === false && 'no-thumbs'], role: 'region', 'aria-label': opts.label, dataset: { doc: opts.name } }, head, opts.thumbnails === false ? null : thumbs, scroller);
  if (opts.thumbnails === false) thumbs.remove();
  let scale = 1;
  let fit = true;
  let doc: PdfDocumentProxy | undefined;
  const slots: PageSlot[] = [];
  let highlights: ViewerHighlight[] = opts.highlights ?? [];
  let destroyed = false;

  const placeHighlights = () => {
    for (const s of slots) clear(s.layer);
    highlights.forEach((hl, i) => {
      const s = slots[hl.page - 1];
      if (!s) return;
      const layer = hl.layer ?? (hl.kind === 'pii' ? 'pii' : 'mismatch');
      const pad = 1.5;
      const b = h('button', {
        type: 'button',
        class: ['hl', layer === 'pii' ? 'hl-pii' : layer === 'field' ? 'hl-field-ok' : `hl-${hl.severity}`, layer === 'mismatch' && 'hl-kind-mismatch'],
        'aria-label': `Page ${hl.page}: ${hl.label}`,
        title: hl.label,
        dataset: { ref: hl.ref, kind: hl.kind, index: i, severity: hl.severity, layer },
        onclick: () => opts.onHighlight?.(hl),
      });
      Object.assign(b.style, {
        left: `${((hl.bbox.x - pad) / s.wPt) * 100}%`,
        top: `${((hl.bbox.y - pad) / s.hPt) * 100}%`,
        width: `${((hl.bbox.width + pad * 2) / s.wPt) * 100}%`,
        height: `${((hl.bbox.height + pad * 2) / s.hPt) * 100}%`,
      });
      s.layer.appendChild(b);
    });
    for (const t of thumbs.querySelectorAll<HTMLElement>('[data-page]')) {
      const n = Number(t.dataset.page);
      const count = highlights.filter((x) => x.page === n && (x.layer ?? 'mismatch') === 'mismatch').length;
      const marks = t.querySelector('.thumb-marks');
      if (marks) {
        marks.textContent = '';
        if (count) marks.append(`${count} `, h('span', { class: 'sr-only', text: `mismatch${count === 1 ? '' : 'es'}` }), h('span', { 'aria-hidden': 'true', text: '⚑' }));
      }
    }
  };

  const sizePages = () => {
    for (const s of slots) {
      s.box.style.width = `${Math.round(s.wPt * scale)}px`;
      s.box.style.height = `${Math.round(s.hPt * scale)}px`;
    }
  };

  const render = async (s: PageSlot) => {
    if (!doc || destroyed || s.renderedAt === scale) return;
    s.task?.cancel();
    const page = await doc.getPage(s.n);
    const dpr = window.devicePixelRatio || 1;
    const vp = page.getViewport({ scale: scale * dpr });
    s.canvas.width = Math.floor(vp.width);
    s.canvas.height = Math.floor(vp.height);
    const ctx = s.canvas.getContext('2d');
    if (!ctx) return;
    const target = scale;
    s.task = page.render({ canvasContext: ctx, viewport: vp });
    try {
      await s.task.promise;
      s.renderedAt = target;
    } catch {
      // cancelled by a newer render
    }
  };

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const s = slots.find((x) => x.box === e.target);
        if (s) void render(s);
      }
    },
    { root: scroller, rootMargin: '300px 0px' },
  );

  const visiblePage = () => {
    const top = scroller.scrollTop + scroller.clientHeight / 3;
    let cur = 1;
    for (const s of slots) if (s.box.offsetTop <= top) cur = s.n;
    return cur;
  };

  const updatePageInfo = () => {
    if (!slots.length) return;
    const n = visiblePage();
    pageInfo.textContent = `Page ${n} / ${slots.length} · ${Math.round(scale * 100)}%`;
    for (const t of thumbs.querySelectorAll<HTMLElement>('[data-page]')) t.setAttribute('aria-current', String(Number(t.dataset.page) === n));
  };
  scroller.addEventListener('scroll', () => updatePageInfo(), { passive: true });

  const applyScale = (next: number) => {
    scale = Math.max(0.25, Math.min(4, next));
    sizePages();
    for (const s of slots) {
      s.renderedAt = undefined;
      io.unobserve(s.box);
      io.observe(s.box);
    }
    updatePageInfo();
  };

  const fitScale = () => {
    const w = Math.max(...slots.map((s) => s.wPt), 1);
    return Math.max(0.25, (scroller.clientWidth - 30) / w);
  };

  const ro = new ResizeObserver(() => {
    if (fit && slots.length) applyScale(fitScale());
  });

  const ready = (async () => {
    const lib = await loadPdfJs();
    const res = await fetch(opts.url, { credentials: 'same-origin', headers: { 'X-EZTest-Token': TOKEN } });
    if (!res.ok) throw new Error(`Could not load the document (HTTP ${res.status})`);
    const data = new Uint8Array(await res.arrayBuffer());
    doc = await lib.getDocument({
      data,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      standardFontDataUrl: '/assets/pdfjs/standard_fonts/',
      verbosity: 0,
    }).promise;
    if (destroyed) {
      await doc.destroy();
      return;
    }
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const canvas = h('canvas', { role: 'img', 'aria-label': `${opts.name}, page ${n} of ${doc.numPages}` });
      const layer = h('div', { class: 'pdfv-layer' });
      const box = h('div', { class: 'pdfv-page', dataset: { page: n } }, canvas, layer, h('span', { class: 'pdfv-page-no', 'aria-hidden': 'true', text: String(n) }));
      scroller.appendChild(box);
      slots.push({ n, wPt: vp.width, hPt: vp.height, box, canvas, layer });
      if (opts.thumbnails !== false) {
        const tc = h('canvas', { 'aria-hidden': 'true' });
        const tb = h('button', { type: 'button', class: 'pdfv-thumb', dataset: { page: n }, onclick: () => goToPage(n) }, tc, h('span', { text: `Page ${n}` }), h('span', { class: 'thumb-marks' }));
        thumbs.appendChild(h('li', null, tb));
        const tvp = page.getViewport({ scale: 72 / vp.width });
        tc.width = Math.floor(tvp.width);
        tc.height = Math.floor(tvp.height);
        const tctx = tc.getContext('2d');
        if (tctx) void page.render({ canvasContext: tctx, viewport: tvp }).promise.catch(() => undefined);
      }
    }
    applyScale(fit ? fitScale() : scale);
    placeHighlights();
    ro.observe(scroller);
    updatePageInfo();
  })();

  const goToPage = (n: number) => {
    const s = slots[n - 1];
    if (!s) return;
    scroller.scrollTo({ top: s.box.offsetTop - 10, behavior: 'smooth' });
  };

  return {
    el,
    scroller,
    ready,
    get scale() {
      return scale;
    },
    get pageCount() {
      return slots.length;
    },
    setScale(v) {
      if (v === 'fit') {
        fit = true;
        if (slots.length) applyScale(fitScale());
      } else {
        fit = false;
        applyScale(v);
      }
    },
    setHighlights(list) {
      highlights = list;
      placeHighlights();
    },
    setLayers(hidden) {
      el.dataset.layers = hidden.map((x) => `no-${x}`).join(' ');
    },
    reveal(pred, o = {}) {
      const i = highlights.findIndex(pred);
      if (i < 0) return undefined;
      const hl = highlights[i];
      const s = slots[hl.page - 1];
      const b = s?.layer.querySelector<HTMLElement>(`[data-index="${i}"]`);
      if (s && b) {
        const top = s.box.offsetTop + (hl.bbox.y / s.hPt) * s.box.offsetHeight - scroller.clientHeight / 3;
        const left = s.box.offsetLeft + (hl.bbox.x / s.wPt) * s.box.offsetWidth - scroller.clientWidth / 3;
        scroller.scrollTo({ top: Math.max(0, top), left: Math.max(0, left), behavior: 'smooth' });
        b.classList.remove('pulse');
        void b.offsetWidth;
        b.classList.add('pulse');
        if (o.focus) b.focus({ preventScroll: true });
      }
      return hl;
    },
    goToPage,
    destroy() {
      destroyed = true;
      io.disconnect();
      ro.disconnect();
      for (const s of slots) s.task?.cancel();
      void doc?.destroy();
    },
  };
}

/** Keep two viewers scrolled to the same relative position (and optionally the same zoom). */
export function syncScroll(a: PdfViewerHandle, b: PdfViewerHandle, enabled: () => boolean): () => void {
  let lock = false;
  const bind = (from: PdfViewerHandle, to: PdfViewerHandle) => () => {
    if (lock || !enabled()) return;
    lock = true;
    const f = from.scroller;
    const t = to.scroller;
    const ry = f.scrollHeight > f.clientHeight ? f.scrollTop / (f.scrollHeight - f.clientHeight) : 0;
    const rx = f.scrollWidth > f.clientWidth ? f.scrollLeft / (f.scrollWidth - f.clientWidth) : 0;
    t.scrollTop = ry * (t.scrollHeight - t.clientHeight);
    t.scrollLeft = rx * (t.scrollWidth - t.clientWidth);
    requestAnimationFrame(() => (lock = false));
  };
  const fa = bind(a, b);
  const fb = bind(b, a);
  a.scroller.addEventListener('scroll', fa, { passive: true });
  b.scroller.addEventListener('scroll', fb, { passive: true });
  return () => {
    a.scroller.removeEventListener('scroll', fa);
    b.scroller.removeEventListener('scroll', fb);
  };
}
