/**
 * Resizable split pane: two children and a focusable separator (ARIA
 * "separator" with a value). Drag with the pointer, or focus the separator and
 * use the arrow keys (Home/End collapse/expand). The size of the first pane
 * (or the second, with `sizeSecond`) is remembered per `storageKey`.
 */
import { h } from '../core/dom.js';

export interface SplitOptions {
  direction: 'row' | 'column';
  first: HTMLElement;
  second: HTMLElement;
  /** Initial size in px of the sized pane. */
  size: number;
  min?: number;
  max?: number;
  /** Size the second pane instead of the first (e.g. a bottom panel). */
  sizeSecond?: boolean;
  storageKey?: string;
  label: string;
  class?: string;
}

export interface SplitHandle {
  el: HTMLElement;
  setSize(px: number): void;
  getSize(): number;
  /** Collapse the sized pane to 0 / restore it. */
  toggle(show?: boolean): void;
  readonly collapsed: boolean;
}

function load(key: string | undefined, fallback: number): number {
  if (!key) return fallback;
  try {
    const v = Number(localStorage.getItem(`ez-split:${key}`));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

export function createSplit(o: SplitOptions): SplitHandle {
  const min = o.min ?? 120;
  const max = o.max ?? 2000;
  let size = load(o.storageKey, o.size);
  let collapsed = false;
  const sized = o.sizeSecond ? o.second : o.first;
  const grow = o.sizeSecond ? o.first : o.second;
  const sep = h('div', {
    class: 'split-sep',
    role: 'separator',
    tabindex: '0',
    'aria-orientation': o.direction === 'row' ? 'vertical' : 'horizontal',
    'aria-label': o.label,
    'aria-valuemin': String(min),
    'aria-valuemax': String(max),
  });
  const el = h('div', { class: ['split', `split-${o.direction}`, o.class] }, o.first, sep, o.second);
  sized.classList.add('split-sized');
  grow.classList.add('split-grow');

  const apply = () => {
    sized.style.flexBasis = collapsed ? '0px' : `${size}px`;
    sized.hidden = collapsed;
    sep.setAttribute('aria-valuenow', String(collapsed ? 0 : Math.round(size)));
    try {
      if (o.storageKey) localStorage.setItem(`ez-split:${o.storageKey}`, String(Math.round(size)));
    } catch {
      // ignore
    }
  };
  const setSize = (px: number) => {
    const total = o.direction === 'row' ? el.clientWidth : el.clientHeight;
    const limit = total > 0 ? Math.min(max, total - min) : max;
    size = Math.max(min, Math.min(limit, px));
    collapsed = false;
    apply();
  };

  sep.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    sep.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    const rect = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const pos = o.direction === 'row' ? ev.clientX - rect.left : ev.clientY - rect.top;
      const total = o.direction === 'row' ? rect.width : rect.height;
      setSize(o.sizeSecond ? total - pos : pos);
    };
    const up = () => {
      el.classList.remove('dragging');
      sep.removeEventListener('pointermove', move);
      sep.removeEventListener('pointerup', up);
    };
    sep.addEventListener('pointermove', move);
    sep.addEventListener('pointerup', up);
  });
  sep.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 64 : 16;
    const growKey = o.direction === 'row' ? 'ArrowRight' : 'ArrowDown';
    const shrinkKey = o.direction === 'row' ? 'ArrowLeft' : 'ArrowUp';
    const sign = o.sizeSecond ? -1 : 1;
    if (e.key === growKey) setSize(size + step * sign);
    else if (e.key === shrinkKey) setSize(size - step * sign);
    else if (e.key === 'Home') handle.toggle(false);
    else if (e.key === 'End') handle.toggle(true);
    else return;
    e.preventDefault();
  });
  sep.addEventListener('dblclick', () => setSize(o.size));
  apply();

  const handle: SplitHandle = {
    el,
    setSize,
    getSize: () => size,
    toggle(show?: boolean) {
      collapsed = show === undefined ? !collapsed : !show;
      apply();
    },
    get collapsed() {
      return collapsed;
    },
  };
  return handle;
}
