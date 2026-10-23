/**
 * Rich-text editors (contenteditable, Quill, CKEditor, TinyMCE in its
 * iframe), sliders, masked inputs, file drop zones, canvas charts and
 * infinite lists.
 */
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { Locator } from '../../browser/index.js';
import { dropFiles } from '../inpage.js';
import { ComponentError } from './engine.js';
import { detectAdapter } from './registry.js';
import type { ComponentReport, DropzoneDialect, EditorDialect, SliderDialect } from './types.js';
import { DEFAULT_BUDGET, DEFAULT_TIMEOUT, ms, normText, parseNumber, poll, Scope, type OpOptions } from './util.js';

// ------------------------------------------------------------------ rich text

interface EditorInfo {
  kind?: 'iframe' | 'contenteditable';
  tag?: string;
  text?: string;
  html?: string;
  error?: string;
}

async function editor(loc: Locator, opts: OpOptions) {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const scope = await Scope.of(loc, timeout);
  await scope.call('clearMarks');
  const a = await detectAdapter<EditorDialect>('richtext', scope.loc, opts.adapter);
  const info = async (): Promise<EditorInfo> => scope.call<EditorInfo>('editorInfo', { d: a.dialect });
  const first = await info();
  if (!first.tag) throw new ComponentError(first.error ?? 'no editable area', 'COMPONENT_NO_EDITOR');
  const area = (i: EditorInfo): Locator => (i.kind === 'iframe' ? scope.el(i.tag, 'editor frame').contentFrame().locator('body') : scope.el(i.tag, 'editor'));
  /** The text of the editing area (read inside the iframe when there is one). */
  const textNow = async (): Promise<string> => {
    const i = await info();
    if (i.kind === 'iframe') return normText(await area(i).textContent({ timeout }));
    return normText(i.text);
  };
  return { scope, a, first, area, textNow, timeout };
}

export type EditorOp = 'replace' | 'append' | 'clear';

/** Type into a rich-text editor: replace its content (default), append, or clear it. Verified by reading the text back. */
export async function typeInEditor(loc: Locator, text: string, op: EditorOp = 'replace', opts: OpOptions = {}): Promise<ComponentReport> {
  const t0 = Date.now();
  const e = await editor(loc, opts);
  const area = e.area(e.first);
  await area.click({ timeout: e.timeout });
  if (op === 'append') await area.press('ControlOrMeta+End');
  else {
    await area.press('ControlOrMeta+a');
    await area.press('Delete');
  }
  if (text) await area.pressSequentially(text, { delay: 5, timeout: Math.max(e.timeout, text.length * 50) });
  let last = '';
  const ok = await poll(async () => {
    last = await e.textNow();
    if (op === 'clear') return last === '' ? true : undefined;
    return last.includes(normText(text)) && (op === 'append' || last === normText(text)) ? true : undefined;
  }, e.timeout);
  if (!ok) throw new ComponentError(`the ${e.a.label} editor holds "${last.slice(0, 120)}" after typing`, 'COMPONENT_VERIFY');
  return { kind: 'richtext', adapter: e.a.dialect.id, library: e.a.id, op, ms: ms(t0), value: last, verified: `${e.a.label} editor ${op === 'clear' ? 'is empty' : `holds "${last.slice(0, 80)}"`}${e.first.kind === 'iframe' ? ' (inside its iframe)' : ''}` };
}

export async function expectEditor(loc: Locator, text: string, mode: 'contains' | 'equals' | 'empty' = 'contains', opts: OpOptions = {}): Promise<ComponentReport> {
  const t0 = Date.now();
  const e = await editor(loc, opts);
  let last = '';
  const ok = await poll(async () => {
    last = await e.textNow();
    const hit = mode === 'empty' ? last === '' : mode === 'equals' ? last === normText(text) : last.includes(normText(text));
    return hit ? true : undefined;
  }, e.timeout);
  if (!ok) throw new ComponentError(`the ${e.a.label} editor holds "${last.slice(0, 160)}"`, 'COMPONENT_ASSERT');
  return { kind: 'richtext', adapter: e.a.dialect.id, library: e.a.id, op: 'expect', ms: ms(t0), verified: `${e.a.label} editor ${mode === 'empty' ? 'is empty' : `${mode} "${text}"`}` };
}

export async function readEditor(loc: Locator, opts: OpOptions = {}): Promise<{ text: string; html: string; library: string }> {
  const e = await editor(loc, opts);
  const i = await e.scope.call<EditorInfo>('editorInfo', { d: e.a.dialect });
  const html = i.kind === 'iframe' ? await e.area(i).innerHTML() : i.html ?? '';
  return { text: await e.textNow(), html, library: e.a.id };
}

// ------------------------------------------------------------------ sliders

interface Handle {
  tag: string;
  kind: 'range' | 'aria';
  now: number;
  min: number;
  max: number;
  step: number | null;
  visible: boolean;
}

/** Set a slider (or one handle of a range slider) to a value; verified by aria-valuenow / the input value. */
export async function setSlider(loc: Locator, value: number, opts: OpOptions & { handle?: number } = {}): Promise<ComponentReport> {
  const t0 = Date.now();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const scope = await Scope.of(loc, timeout);
  await scope.call('clearMarks');
  const a = await detectAdapter<SliderDialect>('slider', scope.loc, opts.adapter);
  const handles = () => scope.call<Handle[]>('sliderInfo', { d: a.dialect });
  const idx = opts.handle ?? 0;
  let h = (await handles())[idx];
  if (!h) throw new ComponentError(`the ${a.label} has no handle ${idx + 1}`, 'COMPONENT_NO_HANDLE');
  if (value < h.min || value > h.max) throw new ComponentError(`${value} is outside the slider range ${h.min}..${h.max}`, 'COMPONENT_RANGE');
  const el = scope.el(h.tag, 'slider handle');
  if (h.kind === 'range') {
    await scope.call('setRange', { tag: h.tag, value });
    h = (await handles())[idx];
  }
  // Keyboard (works for every WAI-ARIA slider): learn the step from one key press, then step.
  for (let round = 0; round < 3 && Math.abs(h.now - value) > 1e-9; round++) {
    await el.focus({ timeout });
    const key = value > h.now ? 'ArrowRight' : 'ArrowLeft';
    const before = h.now;
    await el.press(key, { timeout });
    h = (await handles())[idx];
    const step = Math.abs(h.now - before) || (h.step ?? 1);
    let n = Math.round(Math.abs(value - h.now) / step);
    if (n > 5000) throw new ComponentError(`the slider would need ${n} key presses`, 'COMPONENT_RANGE');
    while (n-- > 0) await el.press(value > h.now ? 'ArrowRight' : 'ArrowLeft', { timeout });
    h = (await handles())[idx];
  }
  const ok = await poll(async () => {
    h = (await handles())[idx];
    return Math.abs(h.now - value) < 1e-9 ? true : undefined;
  }, timeout);
  if (!ok) throw new ComponentError(`the ${a.label} shows ${h.now}, not ${value}`, 'COMPONENT_VERIFY');
  return { kind: 'slider', adapter: a.dialect.id, library: a.id, op: 'set', ms: ms(t0), value, verified: `${a.label} is at ${h.now}` };
}

export async function readSlider(loc: Locator, opts: OpOptions = {}): Promise<number[]> {
  const scope = await Scope.of(loc, opts.timeoutMs);
  const a = await detectAdapter<SliderDialect>('slider', scope.loc, opts.adapter);
  return (await scope.call<Handle[]>('sliderInfo', { d: a.dialect })).map((h) => h.now);
}

// ------------------------------------------------------------------ masked inputs

const alnum = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '');

/** Type into a masked input keystroke by keystroke and verify the unmasked characters. */
export async function typeMasked(loc: Locator, text: string, opts: OpOptions = {}): Promise<ComponentReport> {
  const t0 = Date.now();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const input = (await loc.evaluate((el) => el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) ? loc : loc.locator('input:not([type=hidden])');
  if ((await input.count()) !== 1) throw new ComponentError('the masked field holds no single text input', 'COMPONENT_NO_INPUT');
  await input.click({ timeout });
  await input.press('ControlOrMeta+a');
  await input.press('Backspace');
  await input.pressSequentially(text, { delay: 20, timeout: Math.max(timeout, text.length * 100) });
  let shown = '';
  const ok = await poll(async () => {
    shown = await input.inputValue();
    // Masks add fixed characters ("+1 (", ") ", "-"): the typed characters must all be there, in order.
    return shown === text || alnum(shown) === alnum(text) || (alnum(text).length > 0 && alnum(shown).endsWith(alnum(text))) ? true : undefined;
  }, Math.min(timeout, 3000));
  if (!ok) throw new ComponentError(`the masked field shows "${shown}" after typing "${text}"`, 'COMPONENT_VERIFY');
  return { kind: 'masked', adapter: 'keystrokes', library: 'any', op: 'type', ms: ms(t0), value: shown, verified: `masked field shows "${shown}"` };
}

// ------------------------------------------------------------------ drop zones

const MIME: Record<string, string> = { '.pdf': 'application/pdf', '.csv': 'text/csv', '.json': 'application/json', '.txt': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

/** Put files into a drop zone: its file input when it has one, else a real drag-and-drop event. Verified by the file names appearing. */
export async function dropIntoZone(loc: Locator, files: string[], opts: OpOptions = {}): Promise<ComponentReport> {
  const t0 = Date.now();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const scope = await Scope.of(loc, timeout);
  await scope.call('clearMarks');
  const a = await detectAdapter<DropzoneDialect>('dropzone', scope.loc, opts.adapter);
  type Z = { root: string; input: string | null; multiple: boolean; text: string; files: string[] };
  const info = () => scope.call<Z>('dropzoneInfo', { d: a.dialect });
  const z = await info();
  const names = files.map((f) => basename(f));
  let how: string;
  if (z.input) {
    await scope.el(z.input, 'file input').setInputFiles(files, { timeout });
    how = 'its file input';
  } else {
    const payload = await Promise.all(files.map(async (f) => ({ name: basename(f), type: MIME[extname(f).toLowerCase()] ?? 'application/octet-stream', b64: (await readFile(f)).toString('base64') })));
    await scope.el(z.root, 'drop zone').evaluate(dropFiles, payload, { timeout });
    how = 'a drop event';
  }
  let last: Z = z;
  const ok = await poll(async () => {
    last = await info();
    return names.every((n) => last.files.some((f) => f.includes(n)) || last.text.includes(n)) ? true : undefined;
  }, timeout);
  if (!ok) throw new ComponentError(`after dropping ${names.join(', ')} the ${a.label} lists ${last.files.length ? last.files.join(', ') : `"${last.text.slice(0, 100)}"`}`, 'COMPONENT_VERIFY');
  return { kind: 'dropzone', adapter: a.dialect.id, library: a.id, op: 'drop', ms: ms(t0), value: names, verified: `${a.label} lists ${names.map((n) => `"${n}"`).join(', ')} (via ${how})` };
}

// ------------------------------------------------------------------ charts

export interface ChartData {
  source: 'chart.js' | 'echarts' | 'highcharts' | 'table';
  labels: string[];
  series: Array<{ name: string; values: Array<number | string | null> }>;
}

export async function readChart(loc: Locator, opts: OpOptions = {}): Promise<ChartData> {
  const scope = await Scope.of(loc, opts.timeoutMs);
  let last: ChartData & { error?: string } = { source: 'table', labels: [], series: [] };
  const ok = await poll(async () => {
    last = await scope.call<ChartData & { error?: string }>('chartData', {});
    return last.error ? undefined : true;
  }, Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT, 3000), 100);
  if (!ok) throw new ComponentError(last.error ?? 'chart is not inspectable', 'COMPONENT_NOT_INSPECTABLE');
  return last;
}

/** Count points (of one series, or of the chart: its category labels, else its first series). */
export async function expectChartPoints(loc: Locator, count: number, opts: OpOptions & { series?: string } = {}): Promise<ComponentReport> {
  const t0 = Date.now();
  let data = await readChart(loc, opts);
  const countOf = (dd: ChartData): { n: number; what: string } => {
    if (opts.series) {
      const s = dd.series.find((x) => normText(x.name).toLowerCase() === normText(opts.series!).toLowerCase());
      if (!s) throw new ComponentError(`the chart has no series "${opts.series}" (series: ${dd.series.map((x) => `"${x.name}"`).join(', ')})`, 'COMPONENT_NO_SERIES');
      return { n: s.values.length, what: `series "${s.name}"` };
    }
    return dd.labels.length ? { n: dd.labels.length, what: 'categories' } : { n: dd.series[0]?.values.length ?? 0, what: `series "${dd.series[0]?.name ?? ''}"` };
  };
  let c = countOf(data);
  const ok = await poll(async () => {
    data = await readChart(loc, opts);
    c = countOf(data);
    return c.n === count ? true : undefined;
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT, 100);
  if (!ok) throw new ComponentError(`the chart has ${c.n} points (${c.what}, read via ${data.source}), not ${count}`, 'COMPONENT_ASSERT');
  return { kind: 'chart', adapter: data.source, library: data.source, op: 'expectPoints', ms: ms(t0), value: data, verified: `chart has ${count} points (${c.what}, read via ${data.source})` };
}

/** A value of the chart at a category label (first series, or a named one). */
export async function chartValue(loc: Locator, label: string, opts: OpOptions & { series?: string } = {}): Promise<{ value: number | string | null; source: string }> {
  const data = await readChart(loc, opts);
  const i = data.labels.findIndex((l) => normText(l).toLowerCase() === normText(label).toLowerCase());
  if (i < 0) throw new ComponentError(`the chart has no category "${label}" (categories: ${data.labels.slice(0, 20).join(', ')})`, 'COMPONENT_NO_POINT');
  const s = opts.series ? data.series.find((x) => x.name.toLowerCase() === opts.series!.toLowerCase()) : data.series[0];
  if (!s) throw new ComponentError(`the chart has no series "${opts.series}"`, 'COMPONENT_NO_SERIES');
  return { value: s.values[i] ?? null, source: data.source };
}

export function numericEquals(a: number | string | null, b: string): boolean {
  if (a === null) return false;
  const x = typeof a === 'number' ? a : parseNumber(a);
  const y = parseNumber(b);
  return x !== null && y !== null ? x === y : String(a) === b;
}

// ------------------------------------------------------------------ infinite lists

/** Scroll an infinite list until it stops growing (bounded); returns every item's text. */
export async function loadList(loc: Locator, opts: OpOptions & { max?: number; item?: string } = {}): Promise<{ items: string[]; rounds: number; truncated: boolean; ms: number }> {
  const budget = opts.budgetMs ?? DEFAULT_BUDGET;
  const scope = await Scope.of(loc, opts.timeoutMs);
  return scope.call('listLoad', { max: opts.max, budgetMs: budget, item: opts.item }, budget + (opts.timeoutMs ?? DEFAULT_TIMEOUT));
}
