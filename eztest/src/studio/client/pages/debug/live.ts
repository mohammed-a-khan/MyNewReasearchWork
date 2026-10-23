/**
 * The live browser view: a canvas fed by the debug session's SSE screencast
 * (decoded off the main thread with createImageBitmap, drawn at most once per
 * animation frame), an FPS and latency readout, input forwarding while paused
 * (click, wheel, keys, text), the element picker ("inspect": hover to
 * outline, click for ranked locator candidates) and live locator validation.
 */
import { api } from '../../core/api.js';
import { announce, clear, h, uid } from '../../core/dom.js';
import { copyText } from '../../ui/badge.js';
import { toastError } from '../../ui/toast.js';
import { base64Bytes, kitIcon, meter, toolButton } from './kit.js';
import { dbg, isPaused } from './state.js';

interface FrameMeta {
  deviceWidth?: number;
  deviceHeight?: number;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Candidate {
  candidate: { strategy: string; value: string; name?: string };
  description: string;
  count: number;
  unique: boolean;
  stability: number;
  notes: string[];
  ezTarget: string;
  ezStep?: string;
  ezResolves: boolean;
}

export interface PickResult {
  tag: string;
  box?: Box;
  candidates: Candidate[];
}

export interface LiveViewOptions {
  /** Insert an `.ez` step line into the journey (after the cursor / current step). */
  insertStep(text: string): void;
}

export interface LiveView {
  el: HTMLElement;
  /** Connect the frame stream (while a session runs). */
  connect(): void;
  disconnect(): void;
  toggleInspect(on?: boolean): void;
  readonly frames: number;
}

/** Ranked candidate list, shared with the trace viewer's snapshot picker. */
export function candidateList(result: PickResult, opts: { insertStep?(text: string): void; scope: string }): HTMLElement {
  const listId = uid('cands');
  return h(
    'div',
    { class: 'cand-panel' },
    h('p', { class: 'cand-head', id: listId }, h('strong', { text: `<${result.tag}>` }), ` · ${result.candidates.length} locator candidates, best first (${opts.scope})`),
    h(
      'ol',
      { class: 'cand-list', 'aria-labelledby': listId },
      result.candidates.map((c, i) => {
        const phrase = c.ezStep ?? c.ezTarget;
        const copy = h('button', { type: 'button', class: 'btn btn-sm', 'aria-label': `Copy candidate ${i + 1}: ${phrase}` }, kitIcon('copy', { size: 13 }), h('span', { text: 'Copy' }));
        copy.addEventListener('click', () => void copyText(phrase, copy));
        return h(
          'li',
          { class: ['cand', c.unique ? 'unique' : 'ambiguous'], dataset: { rank: i + 1 } },
          h(
            'div',
            { class: 'cand-main' },
            h('code', { class: 'cand-phrase', text: phrase }),
            h(
              'div',
              { class: 'cand-meta' },
              h('span', { class: ['pill', c.unique ? 'pill-ok' : c.count === 0 ? 'pill-bad' : 'pill-warn'], text: c.unique ? 'unique' : c.count < 0 ? 'invalid' : `${c.count} matches` }),
              meter(c.stability, 'Stability'),
              c.ezResolves ? h('span', { class: 'pill pill-ok', title: 'The .ez phrase resolves to this element', text: '.ez ✓' }) : h('span', { class: 'pill pill-warn', title: 'The .ez phrase does not resolve strictly to this element', text: '.ez ?' }),
              h('span', { class: 'cand-loc mono', text: c.description }),
            ),
            c.notes.length ? h('p', { class: 'cand-notes', text: c.notes.join(' · ') }) : null,
          ),
          h(
            'div',
            { class: 'cand-actions' },
            opts.insertStep && c.ezStep
              ? h('button', { type: 'button', class: 'btn btn-sm btn-primary', 'aria-label': `Insert as step: ${c.ezStep}`, onclick: () => opts.insertStep!(c.ezStep!) }, kitIcon('insert', { size: 13 }), h('span', { text: 'Insert as step' }))
              : null,
            copy,
          ),
        );
      }),
    ),
  );
}

export function createLiveView(o: LiveViewOptions): LiveView {
  const canvas = h('canvas', { class: 'lv-canvas', tabindex: '0', 'aria-label': 'Live browser view. While paused, clicks, scrolling and typing go to the page.', role: 'img', width: 1280, height: 800 }) as HTMLCanvasElement;
  const overlay = h('div', { class: 'lv-overlay', 'aria-hidden': 'true' });
  const frameBox = h('div', { class: 'lv-frame' }, canvas, overlay);
  const placeholder = h('div', { class: 'lv-placeholder' }, kitIcon('bug', { size: 28 }), h('p', { text: 'Start debugging (F5) to see the browser live.' }));
  const stage = h('div', { class: 'lv-stage' }, frameBox, placeholder);
  const fps = h('span', { class: 'lv-stat', id: 'lv-fps', title: 'Frames per second received from the browser', text: '0 fps' });
  const latency = h('span', { class: 'lv-stat', id: 'lv-latency', title: 'Time from capture to display', text: '– ms' });
  const hint = h('span', { class: 'lv-hint', role: 'status', 'aria-live': 'polite' });
  const inspectBtn = toolButton('Inspect element', 'crosshair', () => toggleInspect(), { id: 'dbg-inspect', shortcut: 'Alt+I', pressed: false, text: true });
  const valId = uid('val');
  const valInput = h('input', { id: valId, class: 'input input-sm mono lv-validate', placeholder: 'the "Sign in" button', autocomplete: 'off', spellcheck: 'false' });
  const valCount = h('span', { class: 'lv-valcount', id: 'lv-valcount', role: 'status', 'aria-live': 'polite' });
  const toolbar = h(
    'div',
    { class: 'lv-toolbar', role: 'toolbar', 'aria-label': 'Live view' },
    inspectBtn,
    h('label', { class: 'lv-vlabel', for: valId, text: 'Validate locator' }),
    valInput,
    valCount,
    h('span', { class: 'tb-spacer' }),
    hint,
    fps,
    latency,
  );
  const picks = h('div', { class: 'lv-picks', id: 'lv-picks', hidden: true, 'aria-label': 'Picked element', role: 'region' });
  const el = h('section', { class: 'live-view', 'aria-label': 'Live browser' }, toolbar, h('div', { class: 'lv-body' }, stage, picks));

  let src: EventSource | undefined;
  let meta: FrameMeta = {};
  let pending: ImageBitmap | undefined;
  let rafScheduled = false;
  let frames = 0;
  const arrivals: number[] = [];
  let lastLatency = 0;
  let inspecting = false;
  let hitTimer = 0;
  let hitInflight = false;
  let validateBoxes: Box[] = [];
  let hoverBox: { box: Box; label: string } | undefined;
  let pickedBox: Box | undefined;

  const cssSize = () => ({ w: meta.deviceWidth || canvas.width, h: meta.deviceHeight || canvas.height });

  const fit = () => {
    const sw = stage.clientWidth - 16;
    const sh = stage.clientHeight - 16;
    if (sw <= 0 || sh <= 0) return;
    const s = Math.min(sw / canvas.width, sh / canvas.height, 1.5);
    frameBox.style.width = `${Math.floor(canvas.width * s)}px`;
    frameBox.style.height = `${Math.floor(canvas.height * s)}px`;
  };
  new ResizeObserver(fit).observe(stage);

  const draw = () => {
    rafScheduled = false;
    const bmp = pending;
    pending = undefined;
    if (!bmp) return;
    if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      fit();
    }
    canvas.getContext('2d')?.drawImage(bmp, 0, 0);
    bmp.close();
    frames++;
    canvas.dataset.frames = String(frames);
    const { w, h: hh } = cssSize();
    canvas.dataset.deviceWidth = String(w);
    canvas.dataset.deviceHeight = String(hh);
    stage.classList.add('has-frame');
  };

  const onFrame = async (ev: MessageEvent) => {
    let f: { seq: number; at: number; metadata: FrameMeta; jpeg: string };
    try {
      f = JSON.parse(ev.data);
    } catch {
      return;
    }
    const now = Date.now();
    arrivals.push(now);
    while (arrivals.length && now - arrivals[0] > 2000) arrivals.shift();
    lastLatency = Math.max(0, now - f.at);
    meta = f.metadata ?? {};
    try {
      const bmp = await createImageBitmap(new Blob([base64Bytes(f.jpeg) as BlobPart], { type: 'image/jpeg' }));
      pending?.close();
      pending = bmp;
      if (!rafScheduled) {
        rafScheduled = true;
        requestAnimationFrame(draw);
      }
    } catch {
      // a corrupt frame is skipped
    }
  };

  setInterval(() => {
    if (!src) return;
    const now = Date.now();
    while (arrivals.length && now - arrivals[0] > 2000) arrivals.shift();
    fps.textContent = `${(arrivals.length / 2).toFixed(1)} fps`;
    latency.textContent = arrivals.length ? `${lastLatency} ms` : '– ms';
  }, 500);

  // ---------------------------------------------------------- coordinates and overlays

  const toPage = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    const { w, h: hh } = cssSize();
    return { x: Math.round(((e.clientX - r.left) / r.width) * w), y: Math.round(((e.clientY - r.top) / r.height) * hh) };
  };

  const boxEl = (b: Box, cls: string, label?: string) => {
    const { w, h: hh } = cssSize();
    const d = h('div', { class: ['lv-box', cls] }, label ? h('span', { class: 'lv-box-label', text: label }) : null);
    d.style.left = `${(b.x / w) * 100}%`;
    d.style.top = `${(b.y / hh) * 100}%`;
    d.style.width = `${(b.width / w) * 100}%`;
    d.style.height = `${(b.height / hh) * 100}%`;
    return d;
  };

  const renderOverlay = () => {
    clear(overlay);
    validateBoxes.forEach((b, i) => overlay.appendChild(boxEl(b, 'validate', String(i + 1))));
    if (pickedBox) overlay.appendChild(boxEl(pickedBox, 'picked'));
    if (hoverBox && inspecting) overlay.appendChild(boxEl(hoverBox.box, 'hover', hoverBox.label));
  };

  // ---------------------------------------------------------- inspect / pick

  function toggleInspect(on = !inspecting): void {
    inspecting = on && isPaused();
    if (on && !isPaused()) hint.textContent = 'Inspect works while paused';
    inspectBtn.setAttribute('aria-pressed', String(inspecting));
    frameBox.classList.toggle('inspecting', inspecting);
    if (!inspecting) hoverBox = undefined;
    else hint.textContent = 'Hover to outline an element, click to rank its locators. Esc leaves inspect mode.';
    renderOverlay();
    if (inspecting) canvas.focus();
  }

  const hit = (pt: { x: number; y: number }) => {
    if (hitInflight) return;
    hitInflight = true;
    void api
      .post<{ hit: { tag: string; label: string; box: Box } | null }>('/api/debug/hit', pt)
      .then((r) => {
        hoverBox = r.hit ? { box: r.hit.box, label: r.hit.label } : undefined;
        renderOverlay();
      })
      .catch(() => undefined)
      .finally(() => (hitInflight = false));
  };

  const pick = async (pt: { x: number; y: number }) => {
    hint.textContent = 'Ranking locators…';
    try {
      const r = await api.post<PickResult>('/api/debug/pick', pt);
      pickedBox = r.box;
      renderOverlay();
      clear(picks).append(
        h('div', { class: 'lv-picks-head' }, h('h3', { class: 'kit-h', text: 'Locator candidates' }), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close candidates', onclick: () => ((picks.hidden = true), (pickedBox = undefined), renderOverlay()) }, kitIcon('x'))),
        candidateList(r, { insertStep: o.insertStep, scope: 'counted on the live page' }),
      );
      picks.hidden = false;
      hint.textContent = '';
      announce(`${r.candidates.length} locator candidates for the ${r.tag} element`);
      picks.querySelector<HTMLElement>('.cand-actions button')?.focus();
    } catch (e) {
      hint.textContent = (e as Error).message;
    }
  };

  // ---------------------------------------------------------- input forwarding

  const send = (body: Record<string, unknown>) => {
    if (!isPaused()) return;
    void api.post('/api/debug/input', body).catch((e) => toastError(`Input: ${(e as Error).message}`));
  };

  canvas.addEventListener('mousemove', (e) => {
    if (!isPaused() || !inspecting) return;
    const pt = toPage(e);
    window.clearTimeout(hitTimer);
    hitTimer = window.setTimeout(() => hit(pt), 40);
  });
  canvas.addEventListener('mouseleave', () => {
    hoverBox = undefined;
    renderOverlay();
  });
  canvas.addEventListener('click', (e) => {
    if (!isPaused()) {
      hint.textContent = 'The page takes input while paused';
      return;
    }
    const pt = toPage(e);
    if (inspecting) {
      void pick(pt);
      return;
    }
    canvas.focus();
    send({ type: 'mouse', action: 'click', ...pt, button: 'left', clickCount: e.detail || 1 });
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!isPaused()) return;
      e.preventDefault();
      send({ type: 'wheel', ...toPage(e), deltaX: e.deltaX, deltaY: e.deltaY });
    },
    { passive: false },
  );
  canvas.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && inspecting) {
      e.preventDefault();
      toggleInspect(false);
      return;
    }
    if (!isPaused() || inspecting || e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.key) || e.key === 'Tab') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key.length === 1) send({ type: 'text', text: e.key });
    else send({ type: 'key', action: 'press', key: e.key });
  });

  // ---------------------------------------------------------- validate

  let valTimer = 0;
  const validate = async () => {
    const t = valInput.value.trim();
    if (!t) {
      validateBoxes = [];
      valCount.textContent = '';
      renderOverlay();
      return;
    }
    if (!isPaused()) {
      valCount.textContent = 'Pause to validate';
      return;
    }
    try {
      const r = await api.post<{ count: number; boxes: Box[]; resolved?: { strategy: string; value: string } }>('/api/debug/validate', { target: t, highlight: true });
      validateBoxes = r.boxes;
      valCount.className = ['lv-valcount', r.count === 1 ? 'ok' : r.count === 0 ? 'bad' : 'warn'].join(' ');
      valCount.textContent = r.count === 1 ? '1 match (unique)' : `${r.count} matches`;
      valCount.title = r.resolved ? `${r.resolved.strategy}=${r.resolved.value}` : 'No locator matched';
    } catch (e) {
      validateBoxes = [];
      valCount.className = 'lv-valcount bad';
      valCount.textContent = (e as Error).message.replace(/^Cannot understand target "[^"]*":\s*/, 'Not a target: ');
    }
    renderOverlay();
  };
  valInput.addEventListener('input', () => {
    window.clearTimeout(valTimer);
    valTimer = window.setTimeout(() => void validate(), 300);
  });

  // Overlays from a previous pause are stale once the page moves on.
  dbg.select((d) => d.phase).subscribe((p) => {
    if (p !== 'paused') {
      validateBoxes = [];
      pickedBox = undefined;
      hoverBox = undefined;
      picks.hidden = true;
      valCount.textContent = '';
      if (inspecting) toggleInspect(false);
      renderOverlay();
      el.classList.remove('paused');
    } else {
      el.classList.add('paused');
      if (valInput.value.trim()) void validate();
    }
  });

  return {
    el,
    connect() {
      if (src || !dbg.get().id || !['running', 'paused'].includes(dbg.get().phase)) return;
      const es = new EventSource('/api/debug/frames?fps=10', { withCredentials: true });
      src = es;
      es.addEventListener('frame', (ev) => void onFrame(ev as MessageEvent));
      es.onerror = () => {
        if (es.readyState !== EventSource.CLOSED) return;
        if (src === es) src = undefined;
        // The session may not have been ready yet: try again while it runs.
        if (['starting', 'running', 'paused'].includes(dbg.get().phase)) setTimeout(() => this.connect(), 800);
      };
      placeholder.hidden = true;
    },
    disconnect() {
      src?.close();
      src = undefined;
      fps.textContent = '0 fps';
      latency.textContent = '– ms';
    },
    toggleInspect,
    get frames() {
      return frames;
    },
  };
}
