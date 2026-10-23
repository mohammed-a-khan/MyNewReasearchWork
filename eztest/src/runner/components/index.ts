/**
 * Component adapters: semantic operations on complex widgets, whatever
 * library renders them. Plain functions over EZTest driver locators, so code
 * (the EZTest SDK, a code journey, a custom step) can use them directly:
 *
 *   import { locateWidget, clickGridRow, chooseOptions, pickDate } from 'eztest/components';
 *   const orders = await locateWidget(page, 'the Orders grid', 'grid');
 *   await clickGridRow(orders, { Customer: 'Contoso', Status: 'Open' });
 *   await chooseOptions(await locateWidget(page, 'the City combobox', 'combobox'), ['Berlin']);
 *   await pickDate(await locateWidget(page, 'the Due date picker', 'datepicker'), parseDateText('15 March 2027'));
 *
 * Every function detects the adapter (ag-Grid, MUI, Kendo, DevExtreme,
 * PrimeNG, Angular Material, Oracle JET, SAP UI5, ARIA, ...), acts, verifies
 * by reading the widget back, and returns a report naming the adapter used.
 */
import type { Locator, Page } from '../../browser/index.js';
import { widgetTarget, type ComponentWidget } from '../../intent/rules-components.js';
import { resolveTarget } from '../locate.js';
import { ComponentError } from './engine.js';
import { Grid, type FindOptions } from './grid.js';
import type { CellCondition, CompareOp } from './types.js';
import type { OpOptions } from './util.js';

export * from './types.js';
export { Grid, type FoundRow, type FindOptions } from './grid.js';
export { chooseOptions, readCombo, expectCombo } from './combobox.js';
export { pickDate, expectDate, type PickOptions } from './datepicker.js';
export { parseDateText, formatDate, parseWithFormat, localeFormat, formatFromPlaceholder, isoOf, type YMD } from './dates.js';
export { treeAction, treePath, type TreeAction } from './tree.js';
export { selectTab, expectTab, toggleSection, clickInDialog, closeDialog, expectDialog, watchToasts, expectToast, type DocScope } from './panels.js';
export {
  typeInEditor, expectEditor, readEditor, setSlider, readSlider, typeMasked, dropIntoZone, readChart, expectChartPoints, chartValue, loadList,
  type ChartData, type EditorOp,
} from './inputs.js';
export { registerComponentAdapter, adaptersFor, allAdapters, detectAdapter, DialectAdapter } from './registry.js';
export { GRID_DIALECTS, COMBO_DIALECTS, DATE_DIALECTS, TREE_DIALECTS, TABS_DIALECTS, ACCORDION_DIALECTS, DIALOG_DIALECTS, EDITOR_DIALECTS, SLIDER_DIALECTS, DROPZONE_DIALECTS, TOAST_SELECTORS, type DialectEntry } from './dialects.js';
export { ComponentError, ENGINE_VERSION } from './engine.js';
export { componentAction, type ComponentOutcome } from './action.js';
export { componentCandidates, withComponentCandidates } from './heal.js';
export type { OpOptions } from './util.js';

/** Row conditions: a list, or { Column: value } meaning "Column is value". */
export type Where = CellCondition[] | Record<string, string | number>;

export function toConditions(where: Where): CellCondition[] {
  if (Array.isArray(where)) return where.map((w) => ({ column: w.column, op: (w.op ?? 'equals') as CompareOp, value: String(w.value) }));
  return Object.entries(where).map(([column, value]) => ({ column, op: 'equals' as CompareOp, value: String(value) }));
}

/**
 * Find a widget by its plain-English description ("the Orders grid", "the
 * City combobox"), strictly (exactly one element), like a .ez step would.
 */
export async function locateWidget(page: Page | Locator, description: string, kind: ComponentWidget, timeoutMs = 10_000): Promise<Locator> {
  const target = widgetTarget(description, kind);
  const root = 'goto' in page ? page : page;
  const r = await resolveTarget(root as Page, target, {}, timeoutMs);
  if (!r.locator) throw new ComponentError(`no single element for ${description} (${r.notes.join('; ')})`, 'COMPONENT_NOT_FOUND');
  return r.locator;
}

// ------------------------------------------------------------------ grid functions

export const openGrid = (loc: Locator, opts: OpOptions = {}) => Grid.open(loc, opts);
export const gridColumns = async (loc: Locator, opts: OpOptions = {}) => (await Grid.open(loc, opts)).columns();
export const findGridRow = async (loc: Locator, where: Where, opts: OpOptions & FindOptions = {}) => (await Grid.open(loc, opts)).findRow(toConditions(where), opts);
export const clickGridRow = async (loc: Locator, where: Where, opts: OpOptions & FindOptions & { double?: boolean; button?: 'left' | 'right' } = {}) =>
  (await Grid.open(loc, opts)).clickRow(toConditions(where), opts);
export const clickInGridRow = async (loc: Locator, where: Where, control: string, opts: OpOptions & FindOptions = {}) => (await Grid.open(loc, opts)).clickInRow(toConditions(where), control, opts);
export const readGridCell = async (loc: Locator, where: Where, column: string, opts: OpOptions & FindOptions = {}) => (await Grid.open(loc, opts)).readCell(toConditions(where), column, opts);
export const editGridCell = async (loc: Locator, where: Where, column: string, value: string | number, opts: OpOptions & FindOptions = {}) =>
  (await Grid.open(loc, opts)).editCell(toConditions(where), column, String(value), opts);
export const sortGrid = async (loc: Locator, column: string, order: 'asc' | 'desc' = 'asc', opts: OpOptions = {}) => (await Grid.open(loc, opts)).sort(column, order);
export const filterGrid = async (loc: Locator, column: string, value: string, opts: OpOptions & { match?: 'equals' | 'contains' } = {}) => (await Grid.open(loc, opts)).filter(column, opts.match ?? 'equals', value);
export const selectGridRows = async (loc: Locator, where: Where, opts: OpOptions & { all?: boolean; first?: boolean } = {}) => (await Grid.open(loc, opts)).selectRows(toConditions(where), opts);
export const scrollGridToRow = async (loc: Locator, where: Where, opts: OpOptions & FindOptions = {}) => (await Grid.open(loc, opts)).scrollToRow(toConditions(where), opts);
export const expandGridRow = async (loc: Locator, where: Where, expand = true, opts: OpOptions & FindOptions = {}) => (await Grid.open(loc, opts)).expandRow(toConditions(where), expand, opts);
export const readGridRows = async (loc: Locator, opts: OpOptions & { where?: Where; maxRows?: number } = {}) => (await Grid.open(loc, opts)).readAll(opts.where ? toConditions(opts.where) : [], opts.maxRows);
export const countGridRows = async (loc: Locator, where: Where = [], opts: OpOptions = {}) => (await Grid.open(loc, opts)).countRows(toConditions(where));
export const expectGridSorted = async (loc: Locator, column: string, order: 'asc' | 'desc' = 'asc', opts: OpOptions = {}) => (await Grid.open(loc, opts)).assertSorted(column, order);
