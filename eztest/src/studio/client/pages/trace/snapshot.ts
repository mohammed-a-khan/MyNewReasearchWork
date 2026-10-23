/**
 * DOM snapshot viewer: the server-rendered, self-contained snapshot in a
 * sandboxed iframe (`sandbox=""`: no scripts, no same-origin access; the
 * response carries its own CSP), Before/After and side-by-side, zoom,
 * viewport size, the target outlined and scrolled into view, and a pick mode
 * that ranks locator candidates against the snapshot (a headless page on the
 * server loads the same HTML).
 */
import { api } from '../../core/api.js';
import { announce, clear, h, uid } from '../../core/dom.js';
import { kitIcon, toolButton } from '../debug/kit.js';
import { candidateList, type PickResult } from '../debug/live.js';
import { refOf, snapshotUrl, type Box, type SnapshotRef, type TraceSource, type TraceStep } from './model.js';

const VIEWPORTS = [
  { id: 'recorded', label: 'Recorded size' },
  { id: '1280x800', label: 'Desktop 1280×800' },
  { id: '1024x768', label: 'Laptop 1024×768' },
  { id: '768x1024', label: 'Tablet 768×1024' },
  { id: '390x844', label: 'Phone 390×844' },
];

const ZOOMS = [
  { id: 'fit', label: 'Fit' },
  { id: '0.5', label: '50%' },
  { id: '0.75', label: '75%' },
  { id: '1', label: '100%' },
  { id: '1.25', label: '125%' },
];

export interface SnapshotViewer {
  el: HTMLElement;
  show(source: TraceSource, step: TraceStep | undefined, pos: number): void;
  setPhase(p: 'before' | 'after'): void;
  togglePhase(): void;
  toggleSide(): void;
  togglePick(): void;
  readonly phase: 'before' | 'after';
}

interface Pane {
  el: HTMLElement;
  frame: HTMLElement;
  label: HTMLElement;
}

/** A sandboxed snapshot frame for a URL, sized to the viewport and scrolled to the target. */
export function snapshotFrame(url: string, ref: SnapshotRef | undefined, title: string, opts: { zoom: string; viewport: string; host: HTMLElement }): HTMLElement {
  const vw = opts.viewport === 'recorded' ? ref?.viewport.width || 1280 : Number(opts.viewport.split('x')[0]);
  const vh = opts.viewport === 'recorded' ? ref?.viewport.height || 800 : Number(opts.viewport.split('x')[1]);
  const t = ref?.target?.box;
  const ih = Math.min(8000, Math.max(vh, t ? Math.ceil(t.y + t.height + vh / 2) : vh));
  const frame = h('iframe', { class: 'snap-iframe', sandbox: '', src: url, title, referrerpolicy: 'no-referrer', loading: 'lazy', width: vw, height: ih, tabindex: '0' });
  const scaler = h('div', { class: 'snap-scaler' }, frame);
  const wrap = h('div', { class: 'snap-scroll', tabindex: '-1' }, scaler);
  const apply = () => {
    const avail = Math.max(120, opts.host.clientWidth - 24);
    const s = opts.zoom === 'fit' ? Math.min(1, avail / vw) : Number(opts.zoom);
    frame.style.transform = `scale(${s})`;
    scaler.style.width = `${Math.round(vw * s)}px`;
    scaler.style.height = `${Math.round(ih * s)}px`;
    wrap.dataset.scale = String(s);
    if (t) wrap.scrollTop = Math.max(0, (t.y - vh / 3) * s);
  };
  requestAnimationFrame(apply);
  frame.addEventListener('load', () => requestAnimationFrame(apply));
  const ro = new ResizeObserver(() => {
    if (!wrap.isConnected) ro.disconnect();
    else if (opts.zoom === 'fit') apply();
  });
  ro.observe(opts.host);
  return wrap;
}

export function createSnapshotViewer(o: { onPhase?(p: 'before' | 'after'): void } = {}): SnapshotViewer {
  let phase: 'before' | 'after' = 'before';
  let side = false;
  let picking = false;
  let zoom = 'fit';
  let viewport = 'recorded';
  let source: TraceSource | undefined;
  let step: TraceStep | undefined;
  let pos = 0;

  const before = h('button', { type: 'button', class: 'seg snap-before', 'aria-pressed': 'true', onclick: () => setPhase('before') }, h('span', { text: 'Before' }));
  const after = h('button', { type: 'button', class: 'seg snap-after', 'aria-pressed': 'false', onclick: () => setPhase('after') }, h('span', { text: 'After' }));
  const sideBtn = toolButton('Side by side', 'columns', () => toggleSide(), { kind: 'side', pressed: false, shortcut: 'S', text: true });
  const pickBtn = toolButton('Pick element', 'crosshair', () => togglePick(), { kind: 'pick', pressed: false, shortcut: 'P', text: true });
  const zoomId = uid('zoom');
  const vpId = uid('vp');
  const zoomSel = h('select', { id: zoomId, class: 'input input-sm' }, ZOOMS.map((z) => h('option', { value: z.id, text: z.label })));
  const vpSel = h('select', { id: vpId, class: 'input input-sm' }, VIEWPORTS.map((v) => h('option', { value: v.id, text: v.label })));
  zoomSel.addEventListener('change', () => ((zoom = zoomSel.value), render()));
  vpSel.addEventListener('change', () => ((viewport = vpSel.value), render()));
  const openLink = h('a', { class: 'btn btn-sm', target: '_blank', rel: 'noopener noreferrer', href: '#' }, kitIcon('external', { size: 13 }), h('span', { text: 'Open' }));
  const info = h('p', { class: 'snap-info' });
  const toolbar = h(
    'div',
    { class: 'snap-toolbar', role: 'toolbar', 'aria-label': 'Snapshot' },
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Snapshot phase (B toggles)' }, before, after),
    sideBtn,
    pickBtn,
    h('label', { class: 'sr-only', for: zoomId, text: 'Zoom' }),
    zoomSel,
    h('label', { class: 'sr-only', for: vpId, text: 'Viewport size' }),
    vpSel,
    h('span', { class: 'tb-spacer' }),
    openLink,
  );
  const panes = h('div', { class: 'snap-panes' });
  const picks = h('aside', { class: 'snap-picks', hidden: true, 'aria-label': 'Picked element in the snapshot' });
  const el = h('section', { class: 'snap-viewer', 'aria-label': 'DOM snapshot' }, toolbar, info, h('div', { class: 'snap-body' }, panes, picks));

  const pane = (title: string): Pane => {
    const label = h('p', { class: 'snap-label', text: title });
    const frame = h('div', { class: 'snap-frame' });
    return { el: h('div', { class: 'snap-pane' }, label, frame), frame, label };
  };

  function setPhase(p: 'before' | 'after'): void {
    phase = p;
    before.setAttribute('aria-pressed', String(p === 'before'));
    after.setAttribute('aria-pressed', String(p === 'after'));
    o.onPhase?.(p);
    render();
  }

  function toggleSide(): void {
    side = !side;
    sideBtn.setAttribute('aria-pressed', String(side));
    if (side && picking) togglePick();
    render();
  }

  function togglePick(): void {
    picking = !picking;
    pickBtn.setAttribute('aria-pressed', String(picking));
    if (picking && side) {
      side = false;
      sideBtn.setAttribute('aria-pressed', 'false');
    }
    if (!picking) picks.hidden = true;
    render();
  }

  const describe = (ref: SnapshotRef | undefined) =>
    ref ? `${ref.title || '(untitled)'} · ${ref.url} · ${ref.viewport.width}×${ref.viewport.height} · ${ref.nodeCount} nodes${ref.target ? ` · target <${ref.target.tag}>${ref.target.sensitive ? ' (sensitive, value redacted)' : ''}` : ''}` : '';

  function render(): void {
    clear(panes);
    if (!source || !step) {
      panes.appendChild(h('p', { class: 'panel-empty', text: 'Select a step to see its DOM snapshot.' }));
      info.textContent = '';
      return;
    }
    const phases: Array<'before' | 'after'> = side ? ['before', 'after'] : [phase];
    panes.classList.toggle('side', side);
    const ref = step.snapshots[phase];
    info.textContent = describe(ref);
    openLink.href = ref ? snapshotUrl(source, pos, phase) : '#';
    openLink.hidden = !ref;
    if (picking) {
      void renderPick();
      return;
    }
    for (const p of phases) {
      const r = step.snapshots[p];
      const pn = pane(p === 'before' ? 'Before the action' : 'After the step');
      if (!side) pn.label.hidden = true;
      panes.appendChild(pn.el);
      if (!r) {
        pn.frame.appendChild(h('p', { class: 'panel-empty', text: `No ${p} snapshot for this step.` }));
        continue;
      }
      pn.frame.appendChild(snapshotFrame(snapshotUrl(source, pos, p), r, `Snapshot ${p} step ${step.index + 1}: ${step.intent}`, { zoom, viewport, host: side ? pn.frame : panes }));
    }
  }

  // ---------------------------------------------------------- pick mode

  let inspectId: string | undefined;
  let inspectKey = '';

  async function renderPick(): Promise<void> {
    if (!source || !step) return;
    const key = `${JSON.stringify(refOf(source))}|${pos}|${phase}`;
    const holder = h('div', { class: 'snap-pick-stage' }, h('p', { class: 'panel-empty', role: 'status', text: 'Loading the snapshot for picking…' }));
    panes.appendChild(holder);
    let r: { id: string; width: number; height: number; image: string; target: Box | null };
    try {
      r = await api.post('/api/traces/inspect', { source: refOf(source), pos, phase });
    } catch (e) {
      clear(holder).appendChild(h('p', { class: 'bad-text', text: `Cannot pick in this snapshot: ${(e as Error).message}` }));
      return;
    }
    if (!picking) return;
    if (inspectId && inspectKey !== key) void api.post('/api/traces/inspect/close', { id: inspectId }).catch(() => undefined);
    inspectId = r.id;
    inspectKey = key;
    const img = h('img', { class: 'snap-pick-img', src: `data:image/jpeg;base64,${r.image}`, alt: `Snapshot of step ${step.index + 1} for picking elements`, width: r.width, height: r.height, draggable: 'false' });
    const overlay = h('div', { class: 'snap-pick-overlay', 'aria-hidden': 'true' });
    const surface = h('div', { class: 'snap-pick-surface', tabindex: '0', role: 'application', 'aria-label': 'Pick an element: hover to outline, click for locator candidates' }, img, overlay);
    const scroller = h('div', { class: 'snap-scroll' }, surface);
    clear(holder).append(h('p', { class: 'snap-hint', text: 'Hover to outline an element, click to rank locators counted against this snapshot.' }), scroller);
    const fit = () => {
      const avail = Math.max(120, panes.clientWidth - 24);
      const s = zoom === 'fit' ? Math.min(1, avail / r.width) : Number(zoom);
      surface.style.width = `${Math.round(r.width * s)}px`;
      surface.style.height = `${Math.round(r.height * s)}px`;
      surface.dataset.scale = String(s);
    };
    fit();
    const toPage = (e: MouseEvent) => {
      const rect = surface.getBoundingClientRect();
      return { x: Math.round(((e.clientX - rect.left) / rect.width) * r.width), y: Math.round(((e.clientY - rect.top) / rect.height) * r.height) };
    };
    const boxEl = (b: Box, cls: string, label?: string) => {
      const d = h('div', { class: ['lv-box', cls] }, label ? h('span', { class: 'lv-box-label', text: label }) : null);
      d.style.left = `${(b.x / r.width) * 100}%`;
      d.style.top = `${(b.y / r.height) * 100}%`;
      d.style.width = `${(b.width / r.width) * 100}%`;
      d.style.height = `${(b.height / r.height) * 100}%`;
      return d;
    };
    let busy = false;
    let timer = 0;
    let picked: Box | undefined;
    const draw = (hover?: { box: Box; label: string }) => {
      clear(overlay);
      if (r.target) overlay.appendChild(boxEl(r.target, 'target'));
      if (picked) overlay.appendChild(boxEl(picked, 'picked'));
      if (hover) overlay.appendChild(boxEl(hover.box, 'hover', hover.label));
    };
    draw();
    surface.addEventListener('mousemove', (e) => {
      const pt = toPage(e);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (busy) return;
        busy = true;
        void api
          .post<{ hit: { box: Box; label: string } | null }>('/api/traces/inspect/hit', { id: r.id, ...pt })
          .then((x) => draw(x.hit ?? undefined))
          .catch(() => undefined)
          .finally(() => (busy = false));
      }, 40);
    });
    surface.addEventListener('click', async (e) => {
      try {
        const res = await api.post<PickResult>('/api/traces/inspect/pick', { id: r.id, ...toPage(e) });
        picked = res.box;
        draw();
        clear(picks).append(
          h('div', { class: 'lv-picks-head' }, h('h3', { class: 'kit-h', text: 'Locator candidates' }), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close candidates', onclick: () => (picks.hidden = true) }, kitIcon('x'))),
          candidateList(res, { scope: 'counted against this snapshot' }),
        );
        picks.hidden = false;
        announce(`${res.candidates.length} locator candidates`);
      } catch (err) {
        clear(picks).append(h('p', { class: 'bad-text', text: (err as Error).message }));
        picks.hidden = false;
      }
    });
  }

  return {
    el,
    show(s, st, p) {
      source = s;
      step = st;
      pos = p;
      picks.hidden = true;
      render();
    },
    setPhase,
    togglePhase: () => setPhase(phase === 'before' ? 'after' : 'before'),
    toggleSide,
    togglePick,
    get phase() {
      return phase;
    },
  };
}
