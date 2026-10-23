/**
 * Visual diff viewer: baseline vs actual as a slider, onion skin, side by
 * side or the diff image; ignore regions shown and drawn (mouse or keyboard
 * coordinates) and saved into the visual lens's masks file; approve a new
 * baseline (single or batch), recorded in a hash-chained approvals vault.
 * Differences are listed grouped by the DOM change behind them (one CSS
 * change = one finding), and a group is approved in one action.
 */
import { api } from '../core/api.js';
import { clear, h, uid } from '../core/dom.js';
import { dateTime } from '../core/format.js';
import { link, navigate } from '../core/router.js';
import { button, card, emptyState } from '../ui/badge.js';
import { icon } from '../ui/icons.js';
import { confirmDialog } from '../ui/modal.js';
import { toast, toastError } from '../ui/toast.js';
import { dataTable, field, pageHeader, runPicker, segmented, sevBadge, withStates, type SubPageDef } from './assurance-ui.js';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  global?: boolean;
}

export interface VisualItem {
  journeyId: string;
  journeyName: string;
  stepId: string;
  intent: string;
  name: string;
  status: string;
  passed?: boolean;
  diffPixels?: number;
  diffRatio?: number;
  width?: number;
  height?: number;
  baselineSize?: { width: number; height: number };
  maskedBoxes?: Box[];
  savedMasks?: Box[];
  baseline?: string;
  actual?: string;
  diff?: string;
  message?: string;
  /** Comparison mode (strict, layout, content, ignore-colors) and the keyed baseline name. */
  mode?: string;
  key?: string;
  viewport?: { width: number; height: number };
  browser?: string;
  branch?: string;
  fallbackFrom?: string;
  /** Pixel differences grouped by the DOM change behind them. */
  groups?: ChangeGroupView[];
}

export interface ChangeGroupView {
  id: string;
  kind: string;
  summary: string;
  elements?: string[];
  diffPixels: number;
}

/** A DOM change seen in one or more comparisons of the run. */
export interface RunGroup {
  id: string;
  kind: string;
  summary: string;
  diffPixels: number;
  items: string[];
}

type Mode = 'slider' | 'onion' | 'side' | 'diff';

const approveItem = (i: VisualItem, runId: string, group?: string) => ({ name: i.name, runId, journeyId: i.journeyId, stepId: i.stepId, ...(i.branch ? { branch: i.branch } : {}), ...(group ? { group } : {}) });

const STATUS_LABEL: Record<string, string> = { match: 'Matches', mismatch: 'Changed', 'size-mismatch': 'Size changed', 'missing-baseline': 'New (no baseline)', 'baseline-updated': 'Baseline updated', error: 'Error' };

function pct(n: number | undefined): string {
  return n === undefined ? '' : `${(n * 100).toFixed(2)}%`;
}

function viewerFor(item: VisualItem, runId: string, onChanged: () => void): HTMLElement {
  let mode: Mode = item.actual && item.baseline ? 'slider' : item.diff ? 'diff' : 'side';
  let showMasks = true;
  let drawing = false;
  const pending: Box[] = [];
  const saved = (item.savedMasks ?? []).filter((m) => !m.global);
  const globals = (item.savedMasks ?? []).filter((m) => m.global);
  const natW = item.width ?? item.baselineSize?.width ?? 1280;
  const natH = item.height ?? item.baselineSize?.height ?? 720;
  const stage = h('div', { class: 'vis-stage', tabindex: '0', role: 'group', 'aria-label': 'Comparison image' });
  const slider = h('input', { type: 'range', min: '0', max: '100', value: '50', 'aria-label': 'Slider position (percent of actual shown)', oninput: () => update() });
  const sliderRow = h('div', { class: 'range-row' }, h('span', { class: 'small', text: 'Baseline' }), slider, h('span', { class: 'small', text: 'Actual' }));
  const pendingList = h('ul', { class: 'pill-list', 'aria-label': 'New ignore regions' });

  const img = (src: string | undefined, alt: string) => (src ? h('img', { src, alt, draggable: 'false' }) : null);
  const maskLayer = () => {
    const layer = h('div', { class: 'mask-layer', 'aria-hidden': drawing ? undefined : 'true' });
    if (showMasks) {
      for (const [list, cls] of [[globals, 'global'], [saved, ''], [pending, 'pending'], [item.maskedBoxes ?? [], 'applied']] as Array<[Box[], string]>) {
        for (const b of list) {
          if (cls === 'applied' && [...globals, ...saved].some((s) => s.x === b.x && s.y === b.y && s.width === b.width)) continue;
          const el = h('div', { class: ['mask-box', cls], title: b.label ?? (cls === 'pending' ? 'new ignore region' : 'ignore region') }, b.label ? h('span', { class: 'mask-box-label', text: b.label }) : null);
          Object.assign(el.style, { left: `${(b.x / natW) * 100}%`, top: `${(b.y / natH) * 100}%`, width: `${(b.width / natW) * 100}%`, height: `${(b.height / natH) * 100}%` });
          layer.appendChild(el);
        }
      }
    }
    if (drawing) attachDrawing(layer);
    return layer;
  };

  const attachDrawing = (layer: HTMLElement) => {
    let start: { x: number; y: number } | undefined;
    let ghost: HTMLElement | undefined;
    const pos = (e: PointerEvent) => {
      const r = layer.getBoundingClientRect();
      return { x: Math.max(0, Math.min(natW, ((e.clientX - r.left) / r.width) * natW)), y: Math.max(0, Math.min(natH, ((e.clientY - r.top) / r.height) * natH)) };
    };
    layer.addEventListener('pointerdown', (e) => {
      start = pos(e);
      layer.setPointerCapture(e.pointerId);
      ghost = h('div', { class: 'mask-box pending' });
      layer.appendChild(ghost);
    });
    layer.addEventListener('pointermove', (e) => {
      if (!start || !ghost) return;
      const p = pos(e);
      Object.assign(ghost.style, { left: `${(Math.min(start.x, p.x) / natW) * 100}%`, top: `${(Math.min(start.y, p.y) / natH) * 100}%`, width: `${(Math.abs(p.x - start.x) / natW) * 100}%`, height: `${(Math.abs(p.y - start.y) / natH) * 100}%` });
    });
    layer.addEventListener('pointerup', (e) => {
      if (!start) return;
      const p = pos(e);
      const b = { x: Math.round(Math.min(start.x, p.x)), y: Math.round(Math.min(start.y, p.y)), width: Math.round(Math.abs(p.x - start.x)), height: Math.round(Math.abs(p.y - start.y)) };
      start = undefined;
      if (b.width >= 4 && b.height >= 4) addPending(b);
      else update();
    });
  };

  const addPending = (b: Box) => {
    pending.push(b);
    renderPending();
    update();
  };

  const renderPending = () => {
    clear(pendingList);
    pending.forEach((b, i) => {
      const lbl = h('input', { class: 'input input-sm', value: b.label ?? '', placeholder: 'label', 'aria-label': `Label of new region ${i + 1}`, oninput: () => (b.label = lbl.value) });
      pendingList.appendChild(h('li', { class: 'pill' }, h('span', { text: `${b.x},${b.y} ${b.width}×${b.height}` }), lbl, h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove new region ${i + 1}`, onclick: () => (pending.splice(i, 1), renderPending(), update()) }, icon('close', { size: 12 }))));
    });
    saveBtn.disabled = pending.length === 0;
  };

  const update = () => {
    clear(stage);
    sliderRow.hidden = !(mode === 'slider' || mode === 'onion') || !item.actual || !item.baseline;
    slider.setAttribute('aria-label', mode === 'onion' ? 'Opacity of the actual screenshot' : 'Slider position (percent of actual shown)');
    if (mode === 'side') {
      stage.appendChild(h('div', { class: 'vis-side' },
        h('figure', null, h('figcaption', { text: 'Baseline' }), h('div', { class: 'vis-canvas' }, img(item.baseline, `Baseline of ${item.name}`) ?? h('p', { class: 'muted', text: 'No baseline yet' }), maskLayer())),
        h('figure', null, h('figcaption', { text: 'Actual' }), h('div', { class: 'vis-canvas' }, img(item.actual, `Actual screenshot of ${item.name}`) ?? h('p', { class: 'muted', text: 'Matches the baseline (no actual screenshot kept)' }), maskLayer()))));
      return;
    }
    if (mode === 'diff') {
      stage.appendChild(h('div', { class: 'vis-canvas' }, img(item.diff, `Pixel difference of ${item.name}`) ?? h('p', { class: 'muted pad', text: 'No differing pixels.' }), maskLayer()));
      return;
    }
    const base = item.baseline ?? item.actual;
    const canvas = h('div', { class: 'vis-canvas' }, img(base, `${item.baseline ? 'Baseline' : 'Actual'} of ${item.name}`));
    if (item.baseline && item.actual) {
      const top = h('div', { class: 'vis-top' }, img(item.actual, `Actual screenshot of ${item.name}`));
      const v = Number(slider.value);
      if (mode === 'slider') {
        top.style.clipPath = `inset(0 0 0 ${v}%)`;
        const div = h('div', { class: 'vis-divider' });
        div.style.left = `${v}%`;
        canvas.append(top, div);
      } else {
        top.style.opacity = String(v / 100);
        canvas.appendChild(top);
      }
    }
    canvas.appendChild(maskLayer());
    stage.appendChild(canvas);
  };

  const modes = segmented<Mode>({
    label: 'Comparison mode',
    value: mode,
    options: [
      { value: 'slider', label: 'Slider' },
      { value: 'onion', label: 'Onion skin' },
      { value: 'side', label: 'Side by side' },
      { value: 'diff', label: 'Diff' },
    ],
    onChange: (m) => {
      mode = m;
      slider.value = m === 'onion' ? '50' : '50';
      update();
    },
  });
  const maskToggleId = uid('masks');
  const maskToggle = h('input', { type: 'checkbox', id: maskToggleId, checked: true, onchange: () => ((showMasks = maskToggle.checked), update()) });
  const drawBtn = button('Draw ignore region', { small: true, icon: 'plus', onclick: () => {
    drawing = !drawing;
    drawBtn.setAttribute('aria-pressed', String(drawing));
    stage.classList.toggle('draw-mode', drawing);
    if (drawing) toast('Drag on the image to mark a region to ignore, or type its coordinates below.');
    update();
  } });
  drawBtn.setAttribute('aria-pressed', 'false');
  const coords = ['x', 'y', 'width', 'height'].map((k) => h('input', { type: 'number', min: '0', class: 'input input-sm', 'aria-label': `Region ${k} (pixels)`, placeholder: k, dataset: { k } }));
  const addCoords = button('Add region', { small: true, onclick: () => {
    const [x, y, w, hh] = coords.map((c) => Number(c.value));
    if (![x, y, w, hh].every((n) => Number.isFinite(n) && n >= 0) || w < 1 || hh < 1) {
      toastError('Give x, y, width and height in pixels');
      return;
    }
    addPending({ x, y, width: w, height: hh });
    for (const c of coords) c.value = '';
  } });
  const saveBtn = button('Save ignore regions', { small: true, kind: 'primary', icon: 'save', disabled: true, onclick: async () => {
    if (!(await confirmDialog({ title: 'Save ignore regions?', message: `Save ${pending.length} new region(s) for "${item.name}" into the visual lens masks (.eztest/baselines/masks.json)? Future runs ignore these pixels.`, confirm: 'Save regions' }))) return;
    try {
      await api.put('/api/assurance/visual/masks', { name: item.name, boxes: [...saved, ...pending].map(({ x, y, width, height, label }) => ({ x, y, width, height, label })) });
      toast('Ignore regions saved', { kind: 'success' });
      onChanged();
    } catch (e) {
      toastError((e as Error).message);
    }
  } });
  const approveBtn = item.actual
    ? button('Approve as new baseline', { kind: 'primary', icon: 'check', onclick: async () => {
        if (!(await confirmDialog({ title: 'Approve new baseline?', message: `Replace the baseline of "${item.name}" with this run's screenshot? The approval is recorded in the approvals evidence vault.`, confirm: 'Approve' }))) return;
        try {
          const r = await api.post<{ approved: unknown[]; vault?: string; verified?: boolean }>('/api/assurance/visual/approve', { items: [approveItem(item, runId)] });
          toast(`Baseline approved${r.vault ? ` · recorded in ${r.vault}${r.verified ? ' (chain verified)' : ''}` : ''}`, { kind: 'success' });
          onChanged();
        } catch (e) {
          toastError((e as Error).message);
        }
      } })
    : null;
  update();
  return h('div', { class: 'stack', dataset: { name: item.name } },
    h('div', { class: 'row-between' },
      h('div', null, h('h2', { class: 'h3', text: `${item.journeyName} › ${item.intent}` }), h('p', { class: 'row wrap small' }, sevBadge(item.status === 'match' ? 'ok' : item.status === 'missing-baseline' ? 'warn' : 'fail', STATUS_LABEL[item.status] ?? item.status), h('code', { text: item.name }), item.diffPixels !== undefined && item.status !== 'missing-baseline' ? h('span', { class: 'muted', text: `${item.diffPixels} px differ (${pct(item.diffRatio)})` }) : null, item.baselineSize ? h('span', { class: 'warn-text', text: `baseline ${item.baselineSize.width}×${item.baselineSize.height} vs actual ${item.width}×${item.height}` }) : null)),
      approveBtn),
    h('p', { class: 'row wrap small' },
      item.mode ? h('span', { class: 'badge', text: `${item.mode} mode` }) : null,
      item.browser ? h('span', { class: 'muted', text: `${item.browser}${item.viewport ? ` · ${item.viewport.width}×${item.viewport.height}` : ''}` }) : null,
      item.branch ? h('span', { class: 'badge', text: `branch ${item.branch}` }) : null,
      item.fallbackFrom ? h('span', { class: 'warn-text', text: `baseline from ${item.fallbackFrom} (browser update)` }) : null),
    item.groups?.length
      ? h('div', { class: 'stack-sm' }, h('h3', { class: 'h4', text: 'What changed (grouped by DOM change)' }),
        h('ul', { class: 'vis-groups', 'aria-label': 'Changes behind the differences' }, item.groups.map((g) => h('li', { dataset: { group: g.id, kind: g.kind } }, h('span', { text: g.summary }), g.diffPixels ? h('span', { class: 'small muted', text: ` · ${g.diffPixels} px` }) : null))))
      : null,
    h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Visual comparison' }, modes.el, h('label', { class: 'check', for: maskToggleId }, maskToggle, h('span', { text: 'Show ignore regions' })), h('span', { class: 'sep', 'aria-hidden': 'true' }), drawBtn, saveBtn),
    sliderRow,
    stage,
    h('details', { class: 'fs' }, h('summary', { text: 'Add an ignore region by coordinates (keyboard)' }), h('div', { class: 'row wrap' }, coords, addCoords)),
    pendingList,
    saved.length || globals.length ? h('p', { class: 'small muted', text: `${saved.length} saved region(s) for this baseline, ${globals.length} global.` }) : null,
  );
}

/** The visual comparisons of one run: list, batch approval and the viewer. */
export async function mountVisualRun(el: HTMLElement, runId: string, opts: { selected?: string; onSelect?(name: string): void } = {}): Promise<void> {
  const r = await withStates(el, () => api.get<{ items: VisualItem[]; groups?: RunGroup[] }>(`/api/assurance/visual/runs/${encodeURIComponent(runId)}`), { retry: () => void mountVisualRun(el, runId, opts) });
  if (!r) return;
  if (!r.items.length) {
    el.appendChild(emptyState('No visual comparisons', 'Run with the visual lens ("lenses: [visual]" in the configuration, or pick it on the Run page) to compare screenshots with baselines.'));
    return;
  }
  type Filter = 'all' | 'changed' | 'new' | 'match';
  let filter: Filter = 'all' as Filter;
  let current = r.items.find((i) => i.name === opts.selected) ?? r.items.find((i) => i.status !== 'match') ?? r.items[0];
  const chosen = new Set<string>();
  const listEl = h('ul', { class: 'vis-list', 'aria-label': 'Visual comparisons' });
  const viewer = h('div', { class: 'vis-viewer' });
  const approveSel = button('Approve selected', { kind: 'primary', icon: 'check', disabled: true, onclick: async () => {
    const items = r.items.filter((i) => chosen.has(i.name));
    if (!(await confirmDialog({ title: `Approve ${items.length} baseline(s)?`, message: `Replace ${items.length} baseline(s) with this run's screenshots. One approval record is written to the evidence vault.`, confirm: 'Approve all' }))) return;
    try {
      const res = await api.post<{ approved: unknown[]; skipped: unknown[]; vault?: string }>('/api/assurance/visual/approve', { items: items.map((i) => approveItem(i, runId)) });
      toast(`${res.approved.length} baseline(s) approved${res.skipped.length ? `, ${res.skipped.length} skipped` : ''}`, { kind: 'success' });
      await mountVisualRun(el, runId, opts);
    } catch (e) {
      toastError((e as Error).message);
    }
  } });
  const renderList = () => {
    clear(listEl);
    const visible = r.items.filter((i) => filter === 'all' || (filter === 'changed' && (i.status === 'mismatch' || i.status === 'size-mismatch')) || (filter === 'new' && i.status === 'missing-baseline') || (filter === 'match' && i.status === 'match'));
    if (!visible.length) listEl.appendChild(h('li', { class: 'muted', text: 'Nothing in this filter.' }));
    for (const i of visible) {
      const id = uid('vis-sel');
      const cb: HTMLInputElement | HTMLSpanElement = i.actual ? h('input', { type: 'checkbox', id, checked: chosen.has(i.name), 'aria-label': `Select ${i.intent} for batch approval`, onchange: (e: Event) => ((e.target as HTMLInputElement).checked ? chosen.add(i.name) : chosen.delete(i.name), (approveSel.disabled = chosen.size === 0), (approveSel.querySelector('span')!.textContent = `Approve selected (${chosen.size})`)) }) : h('span', { 'aria-hidden': 'true' });
      listEl.appendChild(h('li', { class: 'vis-item', 'aria-current': String(i === current), dataset: { name: i.name, status: i.status } },
        cb,
        h('img', { src: i.actual ?? i.baseline ?? '', alt: '' }),
        h('button', { type: 'button', class: 'vis-item-main', onclick: () => select(i) }, h('span', { text: i.intent }), h('span', { class: 'small muted', text: `${i.journeyName}` }), h('span', { class: 'row' }, sevBadge(i.status === 'match' ? 'ok' : i.status === 'missing-baseline' ? 'warn' : 'fail', STATUS_LABEL[i.status] ?? i.status), i.diffRatio && i.status !== 'missing-baseline' ? h('span', { class: 'small muted', text: pct(i.diffRatio) }) : null))));
    }
  };
  const select = (i: VisualItem) => {
    current = i;
    opts.onSelect?.(i.name);
    renderList();
    clear(viewer).appendChild(viewerFor(i, runId, () => void mountVisualRun(el, runId, { ...opts, selected: i.name })));
  };
  const filters = segmented<Filter>({ label: 'Filter', value: filter, options: [{ value: 'all', label: `All (${r.items.length})` }, { value: 'changed', label: 'Changed' }, { value: 'new', label: 'New' }, { value: 'match', label: 'Matching' }], onChange: (v) => ((filter = v), renderList()) });
  const groupsCard = (r.groups ?? []).length
    ? card('Changes in this run, grouped by the DOM change behind them', h('ul', { class: 'vis-groups', 'aria-label': 'Change groups' }, (r.groups ?? []).map((g) => {
        const members = r.items.filter((i) => g.items.includes(i.name) && i.actual);
        return h('li', { class: 'row-between', dataset: { group: g.id } },
          h('span', null, h('span', { text: g.summary }), h('span', { class: 'small muted', text: ` · ${g.items.length} comparison(s), ${g.diffPixels} px` })),
          members.length ? button(`Approve group (${members.length})`, { small: true, icon: 'check', onclick: async () => {
            if (!(await confirmDialog({ title: 'Approve this change everywhere?', message: `"${g.summary}" changes ${members.length} baseline(s). Approve them all as new baselines? One approval record is written to the evidence vault.`, confirm: 'Approve group' }))) return;
            try {
              const res = await api.post<{ approved: unknown[]; skipped: unknown[] }>('/api/assurance/visual/approve', { items: members.map((i) => approveItem(i, runId, g.id)), comment: `group: ${g.summary}` });
              toast(`${res.approved.length} baseline(s) approved`, { kind: 'success' });
              await mountVisualRun(el, runId, opts);
            } catch (e) {
              toastError((e as Error).message);
            }
          } }) : null);
      })))
    : null;
  el.append(...(groupsCard ? [groupsCard] : []), h('div', { class: 'row-between' }, filters.el, approveSel), h('div', { class: 'vis-grid' }, listEl, viewer));
  select(current);
}

async function approvalsCard(): Promise<HTMLElement> {
  const body = h('div');
  const c = card('Baseline approvals (evidence vault)', body);
  const r = await withStates(body, () => api.get<{ approvals: Array<{ id: string; approvedAt?: string; approver?: string; approved?: Array<{ name: string }>; verified: boolean; problems: string[] }> }>('/api/assurance/visual/approvals'));
  if (r) body.appendChild(dataTable({
    caption: 'Baseline approvals',
    rows: r.approvals,
    empty: 'No baseline has been approved from the Studio yet.',
    columns: [
      { title: 'When', render: (a) => dateTime(a.approvedAt) },
      { title: 'By', render: (a) => a.approver ?? '' },
      { title: 'Baselines', render: (a) => (a.approved ?? []).map((x) => x.name).join(', ') },
      { title: 'Chain', render: (a) => sevBadge(a.verified ? 'ok' : 'fail', a.verified ? 'verified' : `broken: ${a.problems[0] ?? ''}`) },
      { title: 'Record', render: (a) => h('code', { text: `.eztest/approvals/${a.id}` }) },
    ],
  }));
  return c;
}

export const visualSection: SubPageDef = {
  id: 'visual',
  title: 'Visual diff',
  icon: 'image',
  description: 'Baselines, diffs, ignore regions, approvals',
  mount(root) {
    const body = h('div', { class: 'stack' });
    const history = h('div');
    const picker = runPicker({ label: 'Run', lens: 'visual', onChange: (id) => navigate(link('assurance', 'visual', id)) });
    root.appendChild(h('div', { class: 'page-inner' }, pageHeader('Visual diff', 'Baseline against actual: slider, onion skin, side by side and the pixel diff. Draw regions to ignore, approve new baselines one by one or in a batch.', picker.el), body, history));
    return {
      show: async (segs) => {
        const runId = await picker.set(segs[0]);
        if (!runId) {
          clear(body).appendChild(emptyState('No visual comparisons yet', 'Add "visual" to the lenses (eztest.config.yaml "lenses: [visual]", or the Run page) and run a journey: the first run creates baselines, later runs are compared.'));
        } else await mountVisualRun(body, runId, { selected: segs[1], onSelect: (n) => history && navigate(link('assurance', 'visual', runId, n), { replace: true }) });
        clear(history).appendChild(await approvalsCard());
      },
    };
  },
};

export { field };
