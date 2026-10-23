/**
 * The runner side of `action: component` steps: interpolate the step's
 * arguments, run the widget operation through the detected adapter, record
 * evidence (adapter, library, resolved row key, timings) and report what was
 * verified, which the runner uses to accept a heal.
 */
import { resolve as resolvePath } from 'node:path';
import type { Locator } from '../../browser/index.js';
import { EzTestError, NotSupportedError, type Step } from '../../core/index.js';
import { safeName } from '../evidence.js';
import { rootFor } from '../locate.js';
import type { RunOptions, StepContext } from '../types.js';
import { chooseOptions, expectCombo } from './combobox.js';
import { parseDateText } from './dates.js';
import { expectDate, pickDate } from './datepicker.js';
import { ComponentError } from './engine.js';
import { Grid } from './grid.js';
import { chartValue, dropIntoZone, expectChartPoints, expectEditor, loadList, numericEquals, readChart, readSlider, setSlider, typeInEditor, typeMasked } from './inputs.js';
import { clickInDialog, closeDialog, expectDialog, expectToast, selectTab, expectTab, toggleSection, watchToasts } from './panels.js';
import { treeAction, treePath } from './tree.js';
import type { CellCondition, CompareOp, ComponentReport } from './types.js';
import { DEFAULT_BUDGET, describeWhere, sameValue, type OpOptions } from './util.js';

export interface ComponentOutcome {
  captured?: Record<string, unknown>;
  evidence?: string[];
  verified?: { ok: boolean; message: string };
}

type A = Record<string, unknown>;

function compare(count: number, op: string, want: number): boolean {
  switch (op) {
    case 'gte': return count >= want;
    case 'lte': return count <= want;
    case 'gt': return count > want;
    case 'lt': return count < want;
    default: return count === want;
  }
}
const OP_WORD: Record<string, string> = { eq: '', gte: 'at least ', lte: 'at most ', gt: 'more than ', lt: 'fewer than ' };

/** Run a component step. `loc` is the resolved widget container (undefined for document-level dialogs and toasts). */
export async function componentAction(step: Step, loc: Locator | undefined, ctx: StepContext, opts: RunOptions, timeout: number): Promise<ComponentOutcome> {
  const a: A = step.args ?? {};
  const widget = String(a.widget ?? '');
  const op = String(a.op ?? '');
  const I = (v: unknown) => ctx.interpolate(String(v ?? ''));
  const value = step.value !== undefined ? I(step.value) : undefined;
  const o: OpOptions = {
    timeoutMs: timeout,
    budgetMs: typeof a.budgetMs === 'number' ? a.budgetMs : Math.max(DEFAULT_BUDGET, step.timeoutMs ?? 0),
    ...(a.adapter ? { adapter: String(a.adapter) } : {}),
  };
  const where: CellCondition[] = Array.isArray(a.where) ? (a.where as Array<A>).map((w) => ({ column: I(w.column), op: (w.op ?? 'equals') as CompareOp, value: I(w.value) })) : [];
  const need = (): Locator => {
    if (!loc) throw new EzTestError(`Step "${step.intent}" needs the ${widget} it acts on`, 'MISSING_TARGET');
    return loc;
  };
  const doc = (): Locator => rootFor(ctx.page, ctx.session?.frames ?? []).locator('body');
  let report: ComponentReport;
  let capture: unknown;
  let hasCapture = false;
  const setCapture = (v: unknown) => {
    capture = v;
    hasCapture = true;
  };

  switch (`${widget}.${op}`) {
    // ---------------------------------------------------------------- grids
    case 'grid.clickRow': case 'grid.doubleClickRow': case 'grid.rightClickRow':
      report = await (await Grid.open(need(), o)).clickRow(where, { first: a.first === true, double: op === 'doubleClickRow', button: op === 'rightClickRow' ? 'right' : 'left' });
      break;
    case 'grid.clickInRow':
      report = await (await Grid.open(need(), o)).clickInRow(where, I(a.name), { first: a.first === true });
      break;
    case 'grid.editCell':
      if (value === undefined) throw new EzTestError('editCell needs a value', 'MISSING_VALUE');
      report = await (await Grid.open(need(), o)).editCell(where, I(a.column), value, { first: a.first === true });
      break;
    case 'grid.readCell':
      report = await (await Grid.open(need(), o)).readCell(where, I(a.column), { first: a.first === true });
      setCapture(report.value);
      break;
    case 'grid.expectCell': {
      const g = await Grid.open(need(), o);
      report = await g.readCell(where, I(a.column), { first: a.first === true });
      const got = String(report.value ?? '');
      const match = String(a.match ?? 'equals');
      const ok = match === 'empty' ? got.trim() === '' : match === 'contains' ? got.toLowerCase().includes((value ?? '').toLowerCase()) : sameValue(got, value ?? '');
      if (!ok) throw new ComponentError(`${I(a.column)} of the row where ${describeWhere(where)} is "${got}", expected ${match === 'empty' ? 'empty' : `${match === 'contains' ? 'to contain ' : ''}"${value}"`}`, 'COMPONENT_ASSERT');
      report.verified = `${I(a.column)} of the row where ${describeWhere(where)} is "${got}"`;
      break;
    }
    case 'grid.expectRows': {
      const g = await Grid.open(need(), o);
      const want = Number(I(a.count));
      if (!Number.isFinite(want)) throw new EzTestError(`row count "${String(a.count)}" is not a number`, 'BAD_VALUE');
      const r = await g.countRows(where);
      const cop = String(a.countOp ?? 'eq');
      const what = `${OP_WORD[cop] ?? ''}${want} row(s)${where.length ? ` where ${describeWhere(where)}` : ''}`;
      if (!compare(r.count, cop, want)) throw new ComponentError(`expected ${what}; found ${r.count} (read ${r.total} rows${r.pages > 1 ? ` on ${r.pages} pages` : ''} in ${r.ms} ms)`, 'COMPONENT_ASSERT');
      report = { kind: 'grid', adapter: g.d.id, library: g.library, op, ms: r.ms, verified: `${r.count} row(s)${where.length ? ` where ${describeWhere(where)}` : ''} (expected ${what}; read ${r.total} rows${r.virtualized ? ', virtualized' : ''}${r.pages > 1 ? `, ${r.pages} pages` : ''})`, details: r };
      break;
    }
    case 'grid.sort':
      report = await (await Grid.open(need(), o)).sort(I(a.column), a.order === 'desc' ? 'desc' : 'asc');
      break;
    case 'grid.filter':
      if (value === undefined) throw new EzTestError('filter needs a value', 'MISSING_VALUE');
      report = await (await Grid.open(need(), o)).filter(I(a.column), a.match === 'contains' ? 'contains' : 'equals', value);
      break;
    case 'grid.readAll': {
      const g = await Grid.open(need(), o);
      const r = await g.readAll(where);
      report = { kind: 'grid', adapter: g.d.id, library: g.library, op, ms: r.ms, verified: `read ${r.total} rows${where.length ? ` where ${describeWhere(where)}` : ''} (${r.columns.length} columns${r.virtualized ? ', virtualized' : ''}${r.pages > 1 ? `, ${r.pages} pages` : ''}) in ${r.ms} ms`, details: { rows: r.total, pages: r.pages, virtualized: r.virtualized, ms: r.ms, columns: r.columns.map((c) => c.text) } };
      setCapture(r.rows.map((x) => x.cells));
      break;
    }
    case 'grid.expectSorted':
      report = await (await Grid.open(need(), o)).assertSorted(I(a.column), a.order === 'desc' ? 'desc' : 'asc');
      break;
    case 'grid.expectColumns': {
      const g = await Grid.open(need(), o);
      const cols = (await g.columns()).filter((c) => c.text).map((c) => c.text);
      const want = (a.columns as unknown[]).map(I);
      const missing = want.filter((w) => !cols.some((c) => c.toLowerCase() === w.toLowerCase()));
      if (missing.length) throw new ComponentError(`the grid has no column ${missing.map((m) => `"${m}"`).join(', ')} (columns: ${cols.map((c) => `"${c}"`).join(', ')})`, 'COMPONENT_ASSERT');
      if (a.ordered) {
        const pos = want.map((w) => cols.findIndex((c) => c.toLowerCase() === w.toLowerCase()));
        if (pos.some((p, i) => i > 0 && p < pos[i - 1])) throw new ComponentError(`columns are in the order ${cols.map((c) => `"${c}"`).join(', ')}`, 'COMPONENT_ASSERT');
      }
      report = { kind: 'grid', adapter: g.d.id, library: g.library, op, ms: 0, verified: `columns ${want.map((w) => `"${w}"`).join(', ')} present${a.ordered ? ' in this order' : ''} (all: ${cols.join(', ')})` };
      break;
    }
    case 'grid.selectRows':
      report = await (await Grid.open(need(), o)).selectRows(where, { all: a.all === true, first: a.first === true });
      break;
    case 'grid.scrollToRow':
      report = await (await Grid.open(need(), o)).scrollToRow(where, { first: a.first === true });
      break;
    case 'grid.expandRow': case 'grid.collapseRow':
      report = await (await Grid.open(need(), o)).expandRow(where, op === 'expandRow', { first: a.first === true });
      break;

    // ---------------------------------------------------------------- combo boxes
    case 'combobox.choose':
      report = await chooseOptions(need(), (a.values as unknown[]).map(I), o);
      break;
    case 'combobox.expect':
      report = await expectCombo(need(), (a.values as unknown[]).map(I), o);
      break;

    // ---------------------------------------------------------------- dates
    case 'datepicker.pick':
      report = await pickDate(need(), parseDateText(I(a.date)), { ...o, ...(a.typing ? { typing: true } : {}), ...(a.calendar ? { calendarOnly: true } : {}), ...(a.format ? { format: I(a.format) } : {}) });
      break;
    case 'datepicker.expect':
      report = await expectDate(need(), parseDateText(I(a.date)), o);
      break;

    // ---------------------------------------------------------------- trees, tabs, accordions
    case 'tree.expand': case 'tree.collapse': case 'tree.select':
      report = await treeAction(need(), treePath(I(a.path)), op as 'expand', o);
      break;
    case 'tree.expect': {
      const state = String(a.state ?? 'visible');
      report = await treeAction(need(), treePath(I(a.path)), state === 'visible' ? 'reveal' : (state === 'selected' ? 'select' : state === 'collapsed' ? 'collapse' : 'expand') as 'expand', { ...o });
      break;
    }
    case 'tabs.select':
      report = await selectTab(need(), I(a.tab), o);
      break;
    case 'tabs.expect':
      report = await expectTab(need(), I(a.tab), o);
      break;
    case 'accordion.expand': case 'accordion.collapse':
      report = await toggleSection(need(), I(a.section), op === 'expand', o);
      break;

    // ---------------------------------------------------------------- dialogs and toasts (document level)
    case 'dialog.click':
      report = await clickInDialog(loc ?? doc(), a.dialog === undefined ? undefined : I(a.dialog), I(a.name), o);
      break;
    case 'dialog.close':
      report = await closeDialog(loc ?? doc(), a.dialog === undefined ? undefined : I(a.dialog), o);
      break;
    case 'dialog.expectOpen': case 'dialog.expectClosed':
      report = await expectDialog(loc ?? doc(), I(a.dialog), op === 'expectOpen' ? 'open' : 'closed', o);
      break;
    case 'dialog.expectCount':
      report = await expectDialog(loc ?? doc(), undefined, { count: Number(a.count) }, o);
      break;
    case 'toast.watch':
      await watchToasts(loc ?? doc());
      report = { kind: 'toast', adapter: 'toasts', library: 'any', op, ms: 0, verified: 'recording toasts on this page and every later page of the session' };
      break;
    case 'toast.expect': case 'toast.expectNone':
      report = await expectToast(loc ?? doc(), I(a.text), { ...o, match: a.match === 'equals' ? 'equals' : 'contains', negate: op === 'expectNone' });
      break;

    // ---------------------------------------------------------------- rich text, sliders, masked inputs, drop zones
    case 'richtext.replace': case 'richtext.append': case 'richtext.clear':
      report = await typeInEditor(need(), value ?? '', op as 'replace', o);
      break;
    case 'richtext.expect':
      report = await expectEditor(need(), value ?? '', (a.match ?? 'contains') as 'contains', o);
      break;
    case 'slider.set': {
      const v = Number(value);
      if (!Number.isFinite(v)) throw new EzTestError(`slider value "${value}" is not a number`, 'BAD_VALUE');
      report = await setSlider(need(), v, o);
      if (a.upper !== undefined) {
        const up = Number(I(a.upper));
        const r2 = await setSlider(need(), up, { ...o, handle: 1 });
        report = { ...report, value: [v, up], verified: `${report.verified}; ${r2.verified} (upper handle)` };
      }
      break;
    }
    case 'slider.expect': {
      const want = Number(value);
      const now = await readSlider(need(), o);
      if (!now.some((n) => n === want)) throw new ComponentError(`the slider is at ${now.join(' / ')}, not ${want}`, 'COMPONENT_ASSERT');
      report = { kind: 'slider', adapter: 'slider', library: 'any', op, ms: 0, verified: `slider is at ${want}` };
      break;
    }
    case 'masked.type':
      report = await typeMasked(need(), value ?? '', o);
      break;
    case 'dropzone.drop': {
      const base = opts.baseDir ?? process.cwd();
      report = await dropIntoZone(need(), (a.files as unknown[]).map((f) => resolvePath(base, I(f))), o);
      break;
    }

    // ---------------------------------------------------------------- charts and lists
    case 'chart.expectPoints': {
      const n = Number(I(a.count));
      report = await expectChartPoints(need(), n, { ...o, ...(a.series !== undefined ? { series: I(a.series) } : {}) });
      break;
    }
    case 'chart.expectValue': {
      const r = await chartValue(need(), I(a.label), { ...o, ...(a.series !== undefined ? { series: I(a.series) } : {}) });
      if (!numericEquals(r.value, value ?? '')) throw new ComponentError(`the chart value for "${I(a.label)}" is ${String(r.value)}, not ${value} (read via ${r.source})`, 'COMPONENT_ASSERT');
      report = { kind: 'chart', adapter: r.source, library: r.source, op, ms: 0, verified: `chart value for "${I(a.label)}" is ${String(r.value)} (read via ${r.source})` };
      break;
    }
    case 'chart.capture': {
      const data = await readChart(need(), o);
      report = { kind: 'chart', adapter: data.source, library: data.source, op, ms: 0, verified: `read ${data.series.length} series, ${data.labels.length} categories via ${data.source}` };
      setCapture(data);
      break;
    }
    case 'list.capture': case 'list.expectCount': {
      const r = await loadList(need(), { ...o, ...(a.max !== undefined ? { max: Number(a.max) } : {}) });
      if (r.truncated && op === 'expectCount') throw new ComponentError(`the list was still growing after ${r.ms} ms (${r.items.length} items)`, 'COMPONENT_BUDGET');
      if (op === 'expectCount') {
        const want = Number(a.count);
        const cop = String(a.countOp ?? 'eq');
        if (!compare(r.items.length, cop, want)) throw new ComponentError(`the list has ${r.items.length} items when fully loaded, expected ${OP_WORD[cop] ?? ''}${want}`, 'COMPONENT_ASSERT');
      } else setCapture(r.items);
      report = { kind: 'list', adapter: 'infinite-list', library: 'any', op, ms: r.ms, verified: `loaded ${r.items.length} items in ${r.rounds} scroll rounds (${r.ms} ms)${r.truncated ? ', stopped at the bound' : ''}` };
      break;
    }
    default:
      throw new NotSupportedError(`component operation "${widget}.${op}"`);
  }

  const captured: Record<string, unknown> = {};
  if (hasCapture) {
    const key = step.captureAs;
    if (!key) throw new EzTestError(`Step "${step.intent}" needs captureAs`, 'MISSING_CAPTURE_KEY');
    ctx.ledger.set(key, capture);
    captured[key] = capture;
  }
  const evidenceDoc = { step: step.id, widget, op, adapter: report.adapter, library: report.library, rowKey: report.rowKey, row: report.row, verified: report.verified, ms: report.ms, details: report.details };
  ctx.logger.info('component', { journeyId: ctx.journey.id, stepId: step.id, widget, op, adapter: report.adapter, rowKey: report.rowKey, ms: report.ms });
  const ref = await ctx.evidence.store('data', `components/${safeName(ctx.journey.id)}/attempt-${ctx.attempt}/${safeName(step.id)}.json`, JSON.stringify(evidenceDoc, null, 2), {
    journeyId: ctx.journey.id, stepId: step.id, description: `component ${widget}.${op} via ${report.adapter}${report.rowKey ? ` (row ${report.rowKey})` : ''}`,
  });
  return {
    ...(hasCapture ? { captured } : {}),
    evidence: [ref.id],
    verified: { ok: true, message: `${report.verified} [adapter ${report.adapter}${report.rowKey ? `, row key ${report.rowKey}` : ''}]` },
  };
}
