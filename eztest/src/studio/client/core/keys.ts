/**
 * Global keyboard shortcuts. Combos are written like "Mod+K", "Mod+Shift+P",
 * "Alt+1" or "?"; "Mod" is Ctrl, or Cmd on macOS. Shortcuts do not fire while
 * typing in a field unless `inInputs` is set (e.g. Mod+S, Mod+K).
 */
import { store } from './store.js';

export interface ShortcutDef {
  keys: string;
  title: string;
  group?: string;
  inInputs?: boolean;
  when?(): boolean;
  run(e: KeyboardEvent): void;
}

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export const shortcuts = store<ShortcutDef[]>([]);

export function registerShortcut(def: ShortcutDef): () => void {
  shortcuts.update((list) => [...list, def]);
  return () => shortcuts.update((list) => list.filter((s) => s !== def));
}

interface Combo {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

function parseCombo(keys: string): Combo {
  const parts = keys.split('+');
  const key = parts.pop()!.toLowerCase();
  const has = (k: string) => parts.some((p) => p.toLowerCase() === k);
  return { mod: has('mod'), ctrl: has('ctrl'), alt: has('alt'), shift: has('shift'), key };
}

function eventKey(e: KeyboardEvent): string {
  // Alt+digit gives other characters on some layouts; use the physical key for digits and letters.
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  if (/^Key[A-Z]$/.test(e.code) && (e.altKey || e.ctrlKey || e.metaKey)) return e.code.slice(3).toLowerCase();
  return e.key.toLowerCase();
}

export function matches(def: string, e: KeyboardEvent): boolean {
  const c = parseCombo(def);
  const k = eventKey(e);
  const modDown = IS_MAC ? e.metaKey : e.ctrlKey;
  if (c.mod !== modDown) return false;
  if (!c.mod && !c.ctrl && (e.ctrlKey || e.metaKey)) return false;
  if (c.ctrl && !e.ctrlKey) return false;
  if (c.alt !== e.altKey) return false;
  // "?" is Shift+/ on most layouts: do not require Shift to be declared for punctuation.
  if (/^[a-z0-9]$|^arrow|^enter$|^escape$|^f\d+$/.test(c.key) && c.shift !== e.shiftKey) return false;
  return k === c.key;
}

/** Human label for a combo, e.g. "Ctrl+Shift+P" or "⌘⇧P". */
export function keyLabel(keys: string): string {
  return keys
    .split('+')
    .map((p) => {
      const l = p.toLowerCase();
      if (l === 'mod') return IS_MAC ? '⌘' : 'Ctrl';
      if (l === 'shift') return IS_MAC ? '⇧' : 'Shift';
      if (l === 'alt') return IS_MAC ? '⌥' : 'Alt';
      if (l === 'enter') return 'Enter';
      if (l === 'escape') return 'Esc';
      return p.length === 1 ? p.toUpperCase() : p;
    })
    .join(IS_MAC ? '' : '+');
}

function inField(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.closest?.('.cm-editor');
}

export function startShortcuts(): void {
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const typing = inField(e.target);
    // Inside a modal dialog only shortcuts that work in inputs apply (e.g. the palette's own keys are local).
    for (const s of [...shortcuts.get()].reverse()) {
      if (typing && !s.inInputs) continue;
      if (!matches(s.keys, e)) continue;
      if (s.when && !s.when()) continue;
      e.preventDefault();
      s.run(e);
      return;
    }
  });
}
