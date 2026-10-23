/**
 * Tabs, accordions, dialogs (stacked modals) and toasts.
 *
 * Dialogs are found document-wide (they are portals) and ordered by stacking
 * (z-index, then DOM order): "the top dialog" is the one in front, and a named
 * dialog is matched by its title. Toasts vanish, so a watcher records every
 * toast that appears from the moment it is armed ("Watch for toasts", or the
 * first toast step); expectations look at both visible and recorded toasts.
 */
import type { Locator, Page } from '../../browser/index.js';
import { ALL_DIALOG_CLOSE, ALL_DIALOG_TITLES, ALL_DIALOGS, ALL_TOASTS, DIALOG_DIALECTS } from './dialects.js';
import { ComponentError, engine, toastInitScript } from './engine.js';
import { detectAdapter } from './registry.js';
import type { AccordionDialect, ComponentReport, TabsDialect } from './types.js';
import { DEFAULT_TIMEOUT, ms, normText, poll, Scope, type OpOptions } from './util.js';

// ------------------------------------------------------------------ tabs

interface TabInfo {
  tag: string;
  label: string;
  selected: boolean;
  disabled: boolean;
  panelVisible: boolean | null;
}

export async function selectTab(loc: Locator, label: string, opts: OpOptions = {}): Promise<ComponentReport> {
  const t0 = Date.now();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const scope = await Scope.of(loc, timeout);
  await scope.call('clearMarks');
  const a = await detectAdapter<TabsDialect>('tabs', scope.loc, opts.adapter);
  const list = () => scope.call<TabInfo[]>('tabs', { d: a.dialect });
  const pick = (tabs: TabInfo[]) => {
    const n = normText(label).toLowerCase();
    const hits = tabs.filter((t) => t.label.toLowerCase() === n);
    if (hits.length > 1) throw new ComponentError(`${hits.length} tabs are labelled "${label}"`, 'COMPONENT_AMBIGUOUS');
    return hits[0];
  };
  const tabs = await list();
  const tab = pick(tabs);
  if (!tab) throw new ComponentError(`no tab "${label}" (tabs: ${tabs.map((t) => `"${t.label}"`).join(', ')})`, 'COMPONENT_NO_TAB');
  if (tab.disabled) throw new ComponentError(`tab "${label}" is disabled`, 'COMPONENT_DISABLED');
  if (!tab.selected) await scope.el(tab.tag, 'tab').click({ timeout });
  const ok = await poll(async () => {
    const t = pick(await list());
    return t?.selected && t.panelVisible !== false ? t : undefined;
  }, timeout);
  if (!ok) throw new ComponentError(`tab "${label}" did not become selected`, 'COMPONENT_VERIFY');
  return { kind: 'tabs', adapter: a.dialect.id, library: a.id, op: 'select', ms: ms(t0), verified: `tab "${ok.label}" is selected${ok.panelVisible ? ' and its panel is shown' : ''} (${a.label})` };
}

export async function expectTab(loc: Locator, label: string, opts: OpOptions = {}): Promise<ComponentReport> {
  const t0 = Date.now();
  const scope = await Scope.of(loc, opts.timeoutMs);
  const a = await detectAdapter<TabsDialect>('tabs', scope.loc, opts.adapter);
  let tabs: TabInfo[] = [];
  const ok = await poll(async () => {
    tabs = await scope.call<TabInfo[]>('tabs', { d: a.dialect });
    return tabs.find((t) => t.selected && t.label.toLowerCase() === normText(label).toLowerCase()) ? true : undefined;
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT);
  if (!ok) throw new ComponentError(`tab "${label}" is not selected (selected: ${tabs.filter((t) => t.selected).map((t) => `"${t.label}"`).join(', ') || 'none'})`, 'COMPONENT_ASSERT');
  return { kind: 'tabs', adapter: a.dialect.id, library: a.id, op: 'expect', ms: ms(t0), verified: `tab "${label}" is selected` };
}

// ------------------------------------------------------------------ accordions

interface AccHeader {
  tag: string;
  label: string;
  expanded: boolean;
}

export async function toggleSection(loc: Locator, label: string, expand: boolean, opts: OpOptions = {}): Promise<ComponentReport> {
  const t0 = Date.now();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const scope = await Scope.of(loc, timeout);
  await scope.call('clearMarks');
  const a = await detectAdapter<AccordionDialect>('accordion', scope.loc, opts.adapter);
  const pick = async () => {
    const hs = await scope.call<AccHeader[]>('accordion', { d: a.dialect });
    const hits = hs.filter((h) => h.label.toLowerCase() === normText(label).toLowerCase());
    if (hits.length > 1) throw new ComponentError(`${hits.length} sections are labelled "${label}"`, 'COMPONENT_AMBIGUOUS');
    if (!hits.length) throw new ComponentError(`no section "${label}" (sections: ${hs.map((h) => `"${h.label}"`).join(', ')})`, 'COMPONENT_NO_SECTION');
    return hits[0];
  };
  const h = await pick();
  if (h.expanded !== expand) await scope.el(h.tag, 'section header').click({ timeout });
  const ok = await poll(async () => ((await pick()).expanded === expand ? true : undefined), timeout);
  if (!ok) throw new ComponentError(`section "${label}" did not ${expand ? 'expand' : 'collapse'}`, 'COMPONENT_VERIFY');
  return { kind: 'accordion', adapter: a.dialect.id, library: a.id, op: expand ? 'expand' : 'collapse', ms: ms(t0), verified: `section "${label}" is ${expand ? 'expanded' : 'collapsed'} (${a.label})` };
}

// ------------------------------------------------------------------ dialogs

interface DialogInfo {
  tag: string;
  title: string;
  level: number;
}

const DIALOG_D = { id: 'dialogs', root: '*', dialog: ALL_DIALOGS, title: ALL_DIALOG_TITLES, close: ALL_DIALOG_CLOSE };

/** A page, or any locator inside the document (frame) whose dialogs and toasts are meant. */
export type DocScope = Page | Locator;

function bodyOf(doc: DocScope): Locator {
  return 'goto' in doc ? doc.locator('body') : doc;
}

async function dialogs(scope: Scope): Promise<DialogInfo[]> {
  return scope.call<DialogInfo[]>('dialogs', { d: DIALOG_D });
}

function libraryOfDialog(classes: string): { id: string; label: string } {
  for (const d of DIALOG_DIALECTS) {
    const cls = d.dialect.root.match(/\.([\w-]+)/)?.[1];
    if (cls && classes.split(/\s+/).includes(cls)) return { id: d.library, label: d.label };
  }
  return { id: 'aria', label: 'WAI-ARIA dialog' };
}

async function pickDialog(scope: Scope, name: string | undefined, timeout: number): Promise<DialogInfo & { library: { id: string; label: string }; all: DialogInfo[] }> {
  let all: DialogInfo[] = [];
  const hit = await poll(async () => {
    all = await dialogs(scope);
    if (!all.length) return undefined;
    if (!name) return all[all.length - 1];
    const n = normText(name).toLowerCase();
    const hits = all.filter((d) => d.title.toLowerCase() === n);
    if (hits.length > 1) throw new ComponentError(`${hits.length} open dialogs are titled "${name}"`, 'COMPONENT_AMBIGUOUS');
    return hits[0];
  }, timeout);
  if (!hit) throw new ComponentError(name ? `no open dialog "${name}" (open: ${all.map((d) => `"${d.title}"`).join(', ') || 'none'})` : 'no dialog is open', 'COMPONENT_NO_DIALOG');
  const cls = (await scope.el(hit.tag, 'dialog').getAttribute('class')) ?? '';
  return { ...hit, library: libraryOfDialog(cls), all };
}

async function pageScope(doc: DocScope, timeout: number): Promise<Scope> {
  return Scope.of(bodyOf(doc), timeout);
}

/** Click a button or link inside a dialog (the named one, or the top one). */
export async function clickInDialog(doc: DocScope, name: string | undefined, control: string, opts: OpOptions = {}): Promise<ComponentReport> {
  const t0 = Date.now();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const scope = await pageScope(doc, timeout);
  await scope.call('clearMarks');
  const dl = await pickDialog(scope, name, timeout);
  const c = await scope.call<{ tag?: string; error?: string }>('dialogControl', { d: DIALOG_D, dialog: dl.tag, name: control });
  if (!c.tag) throw new ComponentError(`${c.error} "${dl.title}"`, 'COMPONENT_NO_CONTROL');
  await scope.el(c.tag, 'dialog button').click({ timeout });
  return {
    kind: 'dialog', adapter: dl.library.id, library: dl.library.id, op: 'click', ms: ms(t0),
    verified: `clicked "${control}" in dialog "${dl.title}" (level ${dl.level} of ${dl.all.length} open)`, details: { stack: dl.all.map((x) => x.title) },
  };
}

/** Close a dialog (its close button, else Escape) and verify it is gone while the ones beneath stay open. */
export async function closeDialog(doc: DocScope, name: string | undefined, opts: OpOptions = {}): Promise<ComponentReport> {
  const t0 = Date.now();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const scope = await pageScope(doc, timeout);
  await scope.call('clearMarks');
  const dl = await pickDialog(scope, name, timeout);
  const below = dl.all.filter((x) => x.tag !== dl.tag).map((x) => x.title);
  const c = await scope.call<{ tag?: string }>('dialogControl', { d: DIALOG_D, dialog: dl.tag, what: 'close' });
  if (c.tag) await scope.el(c.tag, 'close button').click({ timeout });
  else await scope.loc.page().keyboard.press('Escape');
  const ok = await poll(async () => {
    const now = await dialogs(scope);
    return now.some((x) => x.tag === dl.tag) ? undefined : now;
  }, timeout);
  if (!ok) throw new ComponentError(`dialog "${dl.title}" is still open`, 'COMPONENT_VERIFY');
  const lost = below.filter((t) => !ok.some((x) => x.title === t));
  if (lost.length) throw new ComponentError(`closing "${dl.title}" also closed ${lost.map((t) => `"${t}"`).join(', ')}`, 'COMPONENT_VERIFY');
  return { kind: 'dialog', adapter: dl.library.id, library: dl.library.id, op: 'close', ms: ms(t0), verified: `dialog "${dl.title}" closed${below.length ? `; ${below.map((t) => `"${t}"`).join(', ')} still open` : ''}` };
}

/** Expect a dialog to be open/closed, or N dialogs to be open. */
export async function expectDialog(doc: DocScope, name: string | undefined, state: 'open' | 'closed' | { count: number }, opts: OpOptions = {}): Promise<ComponentReport> {
  const t0 = Date.now();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const scope = await pageScope(doc, timeout);
  let all: DialogInfo[] = [];
  const test = (list: DialogInfo[]) => {
    if (typeof state === 'object') return list.length === state.count;
    const has = name ? list.some((d) => d.title.toLowerCase() === normText(name).toLowerCase()) : list.length > 0;
    return state === 'open' ? has : !has;
  };
  const ok = await poll(async () => {
    all = await dialogs(scope);
    return test(all) ? true : undefined;
  }, timeout);
  const what = typeof state === 'object' ? `${state.count} dialog(s) open` : `${name ? `dialog "${name}"` : 'a dialog'} ${state}`;
  if (!ok) throw new ComponentError(`expected ${what}; open: ${all.map((d) => `"${d.title}"`).join(', ') || 'none'}`, 'COMPONENT_ASSERT');
  return { kind: 'dialog', adapter: 'dialogs', library: 'any', op: 'expect', ms: ms(t0), verified: `${what} (stack: ${all.map((d) => `"${d.title}"`).join(' < ') || 'empty'})` };
}

// ------------------------------------------------------------------ toasts

const armed = new WeakSet<object>();

/**
 * Start recording toasts on this page, and (an init script) on every page and
 * navigation of its browser context, so a toast that vanishes before it is
 * checked is still seen.
 */
export async function watchToasts(doc: DocScope): Promise<void> {
  const scope = await pageScope(doc, DEFAULT_TIMEOUT);
  const ctx = scope.loc.page().context();
  if (!armed.has(ctx)) {
    armed.add(ctx);
    await ctx.addInitScript({ content: toastInitScript(ALL_TOASTS) });
  }
  await scope.call('toastWatch', { selector: ALL_TOASTS });
}

export async function expectToast(doc: DocScope, text: string, opts: OpOptions & { match?: 'contains' | 'equals'; negate?: boolean } = {}): Promise<ComponentReport> {
  const t0 = Date.now();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const scope = await pageScope(doc, timeout);
  await scope.call('toastWatch', { selector: ALL_TOASTS });
  const want = normText(text).toLowerCase();
  const hit = (t: string) => (opts.match === 'equals' ? normText(t).toLowerCase() === want : normText(t).toLowerCase().includes(want));
  let last: { visible: string[]; seen: string[] } = { visible: [], seen: [] };
  const found = await poll(async () => {
    last = await scope.call<{ visible: string[]; seen: string[] }>('toasts', { selector: ALL_TOASTS });
    const any = [...last.visible, ...last.seen].some(hit);
    return opts.negate ? (any ? undefined : true) : any ? true : undefined;
  }, opts.negate ? Math.min(timeout, 1000) : timeout);
  const shown = [...new Set([...last.seen, ...last.visible])].map((t) => `"${t}"`).join(', ') || 'none';
  if (opts.negate) {
    if (!found) throw new ComponentError(`a toast ${opts.match === 'equals' ? 'saying' : 'containing'} "${text}" appeared (toasts: ${shown})`, 'COMPONENT_ASSERT');
  } else if (!found) throw new ComponentError(`no toast ${opts.match === 'equals' ? 'saying' : 'containing'} "${text}" (toasts seen: ${shown})`, 'COMPONENT_ASSERT');
  return { kind: 'toast', adapter: 'toasts', library: 'any', op: opts.negate ? 'expectNone' : 'expect', ms: ms(t0), verified: opts.negate ? `no toast containing "${text}"` : `toast "${[...last.seen, ...last.visible].find(hit)}" appeared${last.visible.some(hit) ? '' : ' (recorded; already gone)'}` };
}

/** Engine call on a plain locator (used by the SDK). */
export function engineCall<R>(loc: Locator, op: string, arg: unknown): Promise<R> {
  return engine<R>(loc, op, arg);
}
