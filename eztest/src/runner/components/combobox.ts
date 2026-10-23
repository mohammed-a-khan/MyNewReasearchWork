/**
 * Combo boxes, autocompletes, drop-down lists and multi-selects: open the
 * widget, type ahead when it is editable (async options are waited for), find
 * the option in its popup (often rendered at body level, found through
 * aria-controls or the library's overlay), click it, and verify the widget
 * now shows the value. Native <select> elements use selectOption.
 */
import type { Locator } from '../../browser/index.js';
import { ComponentError } from './engine.js';
import { detectAdapter } from './registry.js';
import type { ComboDialect, ComponentReport } from './types.js';
import { DEFAULT_TIMEOUT, ms, normText, poll, Scope, type OpOptions } from './util.js';

interface ComboInfo {
  root: string;
  input: string | null;
  trigger: string | null;
  click: string;
  native: boolean;
  editable: boolean;
  disabled: boolean;
  multiple: boolean;
  open: boolean;
  value: { text: string; chips: string[] };
}

interface ComboOptions {
  open: boolean;
  popup?: string;
  loading?: boolean;
  search?: string | null;
  options: Array<{ text: string; selected: boolean; disabled: boolean }>;
  hits?: number;
  tag?: string;
  selectedAlready?: boolean;
}

export interface ComboHandle {
  scope: Scope;
  label: string;
  library: string;
  d: ComboDialect;
}

async function open(loc: Locator, opts: OpOptions): Promise<ComboHandle> {
  const scope = await Scope.of(loc, opts.timeoutMs);
  await scope.call('clearMarks');
  const a = await detectAdapter<ComboDialect>('combobox', scope.loc, opts.adapter);
  return { scope, label: a.label, library: a.id, d: a.dialect };
}

function shows(info: ComboInfo, value: string): boolean {
  const v = normText(value).toLowerCase();
  const t = normText(info.value.text).toLowerCase();
  return t === v || info.value.chips.some((c) => normText(c).toLowerCase() === v) || (info.multiple && t.split(/\s*,\s*/).includes(v));
}

/** Choose one or more options (several values: a multi-select). */
export async function chooseOptions(loc: Locator, values: string[], opts: OpOptions = {}): Promise<ComponentReport> {
  const t0 = Date.now();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const h = await open(loc, opts);
  const { scope, d } = h;
  let info = await scope.call<ComboInfo>('comboInfo', { d });
  if (info.disabled) throw new ComponentError(`the ${h.label} is disabled`, 'COMPONENT_DISABLED');
  if (info.native) {
    const sel = scope.el(info.root, 'select');
    const got = await sel.selectOption(values.map((label) => ({ label })), { timeout });
    if (got.length < values.length) throw new ComponentError(`the select has no option ${values.map((v) => `"${v}"`).join(', ')}`, 'COMPONENT_NO_OPTION');
    info = await scope.call<ComboInfo>('comboInfo', { d });
    const missing = values.filter((v) => !normText(info.value.text).split(/\s*,\s*/).includes(normText(v)));
    if (missing.length) throw new ComponentError(`after choosing, the select shows "${info.value.text}"`, 'COMPONENT_VERIFY');
    return { kind: 'combobox', adapter: d.id, library: 'native', op: 'choose', verified: `native select shows ${values.map((v) => `"${v}"`).join(', ')}`, ms: ms(t0), value: values.length > 1 ? values : values[0] };
  }
  for (const value of values) {
    info = await scope.call<ComboInfo>('comboInfo', { d });
    if (info.multiple && shows(info, value)) continue;
    let typed = false;
    if (info.editable && info.input) {
      const input = scope.el(info.input, 'combobox input');
      await input.click({ timeout });
      await input.fill('', { timeout });
      await input.pressSequentially(value, { delay: 15, timeout });
      typed = true;
    } else {
      const now = await scope.call<ComboOptions>('comboOptions', { d });
      if (!now.open) await scope.el(info.click, 'combobox').click({ timeout });
    }
    // Wait for the popup and its (possibly async) options.
    let seen: ComboOptions | undefined;
    let firstList: string[] | undefined;
    let searched = false;
    const ready = await poll(async () => {
      const o = await scope.call<ComboOptions>('comboOptions', { d, want: value });
      seen = o;
      if (o.open && !o.loading && o.options.length && !firstList) firstList = o.options.map((x) => x.text);
      if (!o.open) return undefined;
      if (!typed && !searched && o.search && (o.hits ?? 0) !== 1) {
        // Drop-down lists with a filter box in the popup (PrimeNG, Kendo): search there.
        await scope.el(o.search, 'popup search').fill(value, { timeout });
        searched = true;
        return undefined;
      }
      if (o.loading) return undefined;
      return (o.hits ?? 0) >= 1 ? o : undefined;
    }, timeout, 80);
    if (!ready?.tag) {
      const shown = (seen?.options.length ? seen.options.map((o) => o.text) : firstList ?? []).map((t) => `"${t}"`).slice(0, 15).join(', ') || 'none';
      if (seen?.hits && seen.hits > 1) throw new ComponentError(`${seen.hits} options are named "${value}" in the ${h.label}`, 'COMPONENT_AMBIGUOUS');
      throw new ComponentError(seen?.open ? `the ${h.label} offers no option "${value}" (options: ${shown})` : `the ${h.label} did not open its list`, 'COMPONENT_NO_OPTION');
    }
    await scope.el(ready.tag, 'option').click({ timeout });
  }
  // Close a popup left open (multi-selects keep theirs open).
  const after = await scope.call<ComboOptions>('comboOptions', { d });
  if (after.open) {
    const info2 = await scope.call<ComboInfo>('comboInfo', { d });
    await scope.el(info2.input ?? info2.click).press('Escape').catch(() => undefined);
  }
  let last: ComboInfo | undefined;
  const ok = await poll(async () => {
    last = await scope.call<ComboInfo>('comboInfo', { d });
    return values.every((v) => shows(last!, v)) ? true : undefined;
  }, timeout);
  if (!ok) {
    const now = last ? [last.value.text, ...last.value.chips].filter(Boolean).map((x) => `"${x}"`).join(', ') : 'nothing';
    throw new ComponentError(`after choosing, the ${h.label} shows ${now || 'nothing'}, not ${values.map((v) => `"${v}"`).join(', ')}`, 'COMPONENT_VERIFY');
  }
  return {
    kind: 'combobox', adapter: d.id, library: h.library, op: 'choose', ms: ms(t0), value: values.length > 1 ? values : values[0],
    verified: `${h.label} shows ${values.map((v) => `"${v}"`).join(', ')}`,
  };
}

/** What the widget shows now (text and chips). */
export async function readCombo(loc: Locator, opts: OpOptions = {}): Promise<{ text: string; chips: string[]; library: string; adapter: string }> {
  const h = await open(loc, opts);
  const info = await h.scope.call<ComboInfo>('comboInfo', { d: h.d });
  return { ...info.value, library: h.library, adapter: h.d.id };
}

/** Expect the widget to show a value (or every value of a multi-select). */
export async function expectCombo(loc: Locator, values: string[], opts: OpOptions = {}): Promise<ComponentReport> {
  const t0 = Date.now();
  const h = await open(loc, opts);
  let last: ComboInfo | undefined;
  const ok = await poll(async () => {
    last = await h.scope.call<ComboInfo>('comboInfo', { d: h.d });
    return values.every((v) => shows(last!, v)) ? true : undefined;
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT);
  if (!ok) throw new ComponentError(`the ${h.label} shows ${[last?.value.text, ...(last?.value.chips ?? [])].filter(Boolean).map((x) => `"${x}"`).join(', ') || 'nothing'}, expected ${values.map((v) => `"${v}"`).join(', ')}`, 'COMPONENT_ASSERT');
  return { kind: 'combobox', adapter: h.d.id, library: h.library, op: 'expect', verified: `${h.label} shows ${values.map((v) => `"${v}"`).join(', ')}`, ms: ms(t0) };
}
