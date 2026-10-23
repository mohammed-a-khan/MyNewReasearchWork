/**
 * Small building blocks shared by the Debugger and the Trace Viewer: their own
 * icons (drawn like ui/icons), a keyboard-accessible popup menu, a compact
 * CodeMirror line editor with `.ez` autocomplete, JSON pretty-printing and a
 * word diff rendered with text nodes only.
 */
import { autocompletion, closeBrackets, completionKeymap, completionStatus } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import { h, svg, uid } from '../../core/dom.js';
import { ezCompletions } from '../journeys/assist.js';
import { ezLanguage } from '../journeys/ezlang.js';

// ------------------------------------------------------------------ icons

const PATHS = {
  bug: ['M8 9h8v7a4 4 0 0 1-8 0z', 'M9 9V7a3 3 0 0 1 6 0v2', 'M4 13h4', 'M16 13h4', 'M5 8l3 2', 'M19 8l-3 2', 'M5 19l3-2', 'M19 19l-3-2', 'M12 12v6'],
  play: ['M7 4.5v15l12-7.5z'],
  pause: ['M8 5v14', 'M16 5v14'],
  stepOver: ['M4 14a8 8 0 0 1 15-4', 'M19 4v6h-6', 'M12 19h.01'],
  stepInto: ['M12 4v11', 'm7 10 5 5 5-5', 'M12 20h.01'],
  runToCursor: ['M4 12h10', 'm10 7 5 5-5 5', 'M19 5v14'],
  restart: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'],
  stop: ['M6 6h12v12H6z'],
  crosshair: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 3v4', 'M12 17v4', 'M3 12h4', 'M17 12h4'],
  breakpoint: ['M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z'],
  film: ['M4 4h16v16H4z', 'M8 4v16', 'M16 4v16', 'M4 8h4', 'M4 12h4', 'M4 16h4', 'M16 8h4', 'M16 12h4', 'M16 16h4'],
  columns: ['M4 4h16v16H4z', 'M12 4v16'],
  compare: ['M9 4v16', 'M15 4v16', 'm5 8-2 2 2 2', 'm19 12 2 2-2 2'],
  download: ['M12 4v11', 'm7 10 5 5 5-5', 'M5 20h14'],
  upload: ['M12 20V9', 'm7 14 5-5 5 5', 'M5 4h14'],
  zoomIn: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'm20 20-4-4', 'M11 8v6', 'M8 11h6'],
  zoomOut: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'm20 20-4-4', 'M8 11h6'],
  terminal: ['M4 5h16v14H4z', 'm7 9 3 3-3 3', 'M12 15h5'],
  network: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M3 12h18', 'M12 3a14 14 0 0 1 0 18', 'M12 3a14 14 0 0 0 0 18'],
  layers: ['m12 3 9 5-9 5-9-5z', 'm3 13 9 5 9-5'],
  check: ['m5 12 5 5L20 7'],
  x: ['M6 6l12 12', 'M18 6 6 18'],
  insert: ['M12 5v14', 'M5 12h14'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  external: ['M14 4h6v6', 'M20 4 10 14', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  shield: ['M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z', 'm9 12 2 2 4-4'],
  edit: ['M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17z', 'm14 8 2 2'],
  skip: ['M5 5l8 7-8 7z', 'M17 5v14'],
  save: ['M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M7 3v5h8V3', 'M7 21v-7h10v7'],
} satisfies Record<string, string[]>;

export type KitIcon = keyof typeof PATHS;

export function kitIcon(name: KitIcon, opts: { label?: string; size?: number; class?: string } = {}): SVGSVGElement {
  const size = opts.size ?? 16;
  return svg(
    'svg',
    {
      class: `icon kicon-${name}${opts.class ? ` ${opts.class}` : ''}`,
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: name === 'breakpoint' || name === 'play' ? 'currentColor' : 'none',
      stroke: 'currentColor',
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      focusable: 'false',
      ...(opts.label ? { role: 'img', 'aria-label': opts.label } : { 'aria-hidden': 'true' }),
    },
    PATHS[name].map((d) => svg('path', { d })),
  );
}

/** A toolbar button with a kit icon, a visible or screen-reader label and a shortcut hint. */
export function toolButton(label: string, ic: KitIcon, onclick: () => void, opts: { id?: string; shortcut?: string; text?: boolean; kind?: string; pressed?: boolean } = {}): HTMLButtonElement {
  const title = opts.shortcut ? `${label} (${opts.shortcut})` : label;
  return h(
    'button',
    {
      type: 'button',
      id: opts.id,
      class: ['dbg-btn', opts.kind && `dbg-btn-${opts.kind}`, opts.text && 'with-text'],
      title,
      'aria-label': opts.text ? undefined : label,
      'aria-keyshortcuts': opts.shortcut,
      'aria-pressed': opts.pressed === undefined ? undefined : String(opts.pressed),
      onclick,
    },
    kitIcon(ic),
    opts.text ? h('span', { text: label }) : null,
  );
}

// ------------------------------------------------------------------ popup menu

export interface MenuItem {
  label: string;
  run(): void;
  disabled?: boolean;
  danger?: boolean;
}

let openMenuEl: HTMLElement | undefined;

/** A popup menu (ARIA menu) at a point; arrow keys move, Enter runs, Escape closes and restores focus. */
export function openMenu(x: number, y: number, items: MenuItem[], label = 'Actions'): void {
  openMenuEl?.remove();
  const previous = document.activeElement as HTMLElement | null;
  const menu = h('div', { class: 'ez-menu', role: 'menu', 'aria-label': label, tabindex: '-1' });
  const buttons = items.map((it) =>
    h('button', {
      type: 'button',
      role: 'menuitem',
      class: ['ez-menu-item', it.danger && 'danger'],
      disabled: it.disabled,
      tabindex: '-1',
      text: it.label,
      onclick: () => {
        close();
        it.run();
      },
    }),
  );
  menu.append(...buttons);
  const close = () => {
    menu.remove();
    document.removeEventListener('mousedown', outside, true);
    if (openMenuEl === menu) openMenuEl = undefined;
    if (previous && document.contains(previous)) previous.focus();
  };
  const outside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  menu.addEventListener('keydown', (e) => {
    const enabled = buttons.filter((b) => !b.disabled);
    const i = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') enabled[(i + 1) % enabled.length]?.focus();
    else if (e.key === 'ArrowUp') enabled[(i - 1 + enabled.length) % enabled.length]?.focus();
    else if (e.key === 'Home') enabled[0]?.focus();
    else if (e.key === 'End') enabled[enabled.length - 1]?.focus();
    else if (e.key === 'Escape' || e.key === 'Tab') close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  openMenuEl = menu;
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  buttons.find((b) => !b.disabled)?.focus();
}

// ------------------------------------------------------------------ mini editor

const STYLE_NONCE = document.querySelector<HTMLMetaElement>('meta[name="eztest-style-nonce"]')?.content ?? '';

const miniTheme = EditorView.theme({
  '&': { fontSize: 'var(--editor-font-size)', backgroundColor: 'var(--editor-bg)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: '6px' },
  '&.cm-focused': { outline: '2px solid var(--focus)', outlineOffset: '0' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '4px 0' },
  '.cm-line': { padding: '0 8px' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-placeholder': { color: 'var(--text-muted) !important' },
  '.cm-tooltip': { backgroundColor: 'var(--surface-overlay)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '6px', boxShadow: 'var(--shadow-lg)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--text)' },
  '.cm-completionDetail': { color: 'var(--text-muted)', fontStyle: 'normal', marginLeft: '1em' },
});

export interface MiniEditor {
  view: EditorView;
  el: HTMLElement;
  get(): string;
  set(text: string): void;
  focus(): void;
  setEnabled(on: boolean): void;
}

/**
 * A small `.ez` editor with the Studio's autocomplete. Single-line mode runs
 * `onSubmit` on Enter (when no completion is open) and walks `history` with
 * the arrow keys; multi-line mode submits with Mod+Enter.
 */
export function createMiniEditor(o: {
  label: string;
  doc?: string;
  multiline?: boolean;
  placeholder?: string;
  onSubmit?(text: string): void;
  onChange?(text: string): void;
  history?: () => string[];
  class?: string;
}): MiniEditor {
  const el = h('div', { class: ['mini-editor', o.multiline && 'multi', o.class] });
  let histPos = -1;
  const submit = (view: EditorView) => {
    if (completionStatus(view.state) === 'active') return false;
    o.onSubmit?.(view.state.doc.toString());
    histPos = -1;
    return true;
  };
  const walk = (view: EditorView, dir: number) => {
    const list = o.history?.() ?? [];
    if (!list.length || completionStatus(view.state) === 'active') return false;
    histPos = Math.max(-1, Math.min(list.length - 1, histPos + dir));
    const text = histPos < 0 ? '' : list[list.length - 1 - histPos];
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length } });
    return true;
  };
  const editable = new Compartment();
  const keys: Extension = Prec.high(
    keymap.of([
      ...completionKeymap,
      o.multiline ? { key: 'Mod-Enter', run: submit } : { key: 'Enter', run: submit },
      ...(o.multiline ? [] : [{ key: 'ArrowUp', run: (v: EditorView) => walk(v, 1) }, { key: 'ArrowDown', run: (v: EditorView) => walk(v, -1) }]),
    ]),
  );
  const view = new EditorView({
    parent: el,
    state: EditorState.create({
      doc: o.doc ?? '',
      extensions: [
        keys,
        history(),
        closeBrackets(),
        ezLanguage,
        syntaxHighlighting(classHighlighter),
        autocompletion({ override: [ezCompletions], activateOnTyping: true, icons: true, maxRenderedOptions: 40 }),
        o.placeholder ? cmPlaceholder(o.placeholder) : [],
        miniTheme,
        EditorView.cspNonce.of(STYLE_NONCE),
        o.multiline ? EditorView.lineWrapping : EditorState.transactionFilter.of((tr) => (tr.newDoc.lines > 1 ? [] : tr)),
        EditorView.contentAttributes.of({ 'aria-label': o.label, 'aria-multiline': String(!!o.multiline), spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
        editable.of(EditorView.editable.of(true)),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) o.onChange?.(u.state.doc.toString());
        }),
      ],
    }),
  });
  return {
    view,
    el,
    get: () => view.state.doc.toString(),
    set(text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length } });
    },
    focus: () => view.focus(),
    setEnabled(on) {
      el.classList.toggle('disabled', !on);
      view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(on)) });
    },
  };
}

// ------------------------------------------------------------------ data helpers

/** Pretty-print JSON text; other text comes back unchanged. */
export function pretty(text: string | undefined, contentType = ''): string {
  if (!text) return '';
  if (/json/i.test(contentType) || /^\s*[[{]/.test(text)) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
  return text;
}

/** Word-level diff of two strings as removed/added/same runs (LCS, capped). */
export function wordDiff(a: string, b: string): Array<{ kind: 'same' | 'add' | 'del'; text: string }> {
  const wa = a.split(/(\s+)/).filter((x) => x !== '').slice(0, 400);
  const wb = b.split(/(\s+)/).filter((x) => x !== '').slice(0, 400);
  const n = wa.length;
  const m = wb.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = wa[i] === wb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Array<{ kind: 'same' | 'add' | 'del'; text: string }> = [];
  const push = (kind: 'same' | 'add' | 'del', text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && wa[i] === wb[j]) {
      push('same', wa[i]);
      i++;
      j++;
    } else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) push('add', wb[j++]);
    else push('del', wa[i++]);
  }
  return out;
}

/** Render a diff with <del>/<ins> (text nodes only). */
export function diffView(a: string, b: string, label: string): HTMLElement {
  return h(
    'p',
    { class: 'word-diff' },
    // A paragraph cannot be named (WAI-ARIA 1.2): the label is visually hidden text in front of the diff.
    h('span', { class: 'sr-only', text: `${label}: ` }),
    wordDiff(a, b).map((p) => (p.kind === 'same' ? p.text : h(p.kind === 'add' ? 'ins' : 'del', { text: p.text }))),
  );
}

/** A labelled meter bar (0..1) with a text value; never colour alone. */
export function meter(value: number, label: string): HTMLElement {
  const pctv = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const bar = h('span', { class: 'kit-meter-fill' });
  bar.style.width = `${pctv}%`;
  return h(
    'span',
    { class: ['kit-meter', pctv >= 70 ? 'good' : pctv >= 40 ? 'mid' : 'low'], role: 'img', 'aria-label': `${label} ${pctv}%`, title: `${label} ${pctv}%` },
    h('span', { class: 'kit-meter-track', 'aria-hidden': 'true' }, bar),
    h('span', { class: 'kit-meter-val', 'aria-hidden': 'true', text: `${pctv}%` }),
  );
}

/** A definition list section with a heading. */
export function section(title: string, ...body: Array<Node | string | null | false | undefined>): HTMLElement {
  const id = uid('sec');
  return h('section', { class: 'kit-section', 'aria-labelledby': id }, h('h3', { class: 'kit-h', id, text: title }), ...body.filter(Boolean).map((b) => b as Node | string));
}

/** Base64 of a file's bytes (for JSON uploads). */
export async function fileToBase64(file: Blob): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Bytes of a base64 string. */
export function base64Bytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
