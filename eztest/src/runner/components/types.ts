/**
 * The component adapter layer: semantic operations on complex widgets
 * (grids, combo boxes, date pickers, trees, tabs, dialogs, rich text,
 * sliders, masked inputs, drop zones, charts, infinite lists), found
 * automatically per target so one plain-English sentence works whatever
 * library renders the widget.
 *
 * An adapter is a library's knowledge of one widget kind. Most adapters are a
 * *dialect*: plain data (selectors, attribute names) that a shared engine
 * interprets in the page, plus optional Node-side overrides. Custom libraries
 * plug in with `registerComponentAdapter`.
 */
import type { Locator } from '../../browser/index.js';

export type WidgetKind =
  | 'grid' | 'combobox' | 'datepicker' | 'tree' | 'tabs' | 'accordion' | 'dialog' | 'toast'
  | 'richtext' | 'slider' | 'masked' | 'dropzone' | 'chart' | 'list';

export const WIDGET_KINDS: readonly WidgetKind[] = [
  'grid', 'combobox', 'datepicker', 'tree', 'tabs', 'accordion', 'dialog', 'toast', 'richtext', 'slider', 'masked', 'dropzone', 'chart', 'list',
];

/** How an adapter was validated (documented in docs/components.md). */
export type AdapterFixture = 'real' | 'emulated' | 'aria' | 'reused';

/** Dialect fields every kind shares. */
export interface BaseDialect {
  /** Adapter id, e.g. "ag-grid". */
  id: string;
  /** CSS selector of the widget root (matched at, above or inside the target). */
  root: string;
}

export interface GridDialect extends BaseDialect {
  headerCell: string;
  headerExclude?: string;
  headerText?: string;
  /** Attribute holding the column id on header cells (and cells when cellColAttr is not set). */
  colIdAttr?: string;
  /** Class prefix holding the column id (Angular Material: "mat-column-"). */
  colIdClass?: string;
  row: string;
  /** Selector used with closest() to find a cell's row (defaults to `row`). */
  rowClosest?: string;
  rowExclude?: string;
  cell: string;
  cellColAttr?: string;
  cellText?: string;
  rowKeyAttr?: string;
  rowIndexAttr?: string;
  /** Vertical scroll container (auto-detected when omitted). */
  viewport?: string;
  /** Horizontal scroll container for column virtualization. */
  hViewport?: string;
  busy?: string;
  sortClick?: string;
  sortAsc?: string;
  sortDesc?: string;
  /** False when the library has no built-in sorting UI. */
  sortable?: boolean;
  selectedRow?: string;
  selectedRowInner?: string;
  rowCheckbox?: string;
  rowCheckboxClick?: string;
  checkboxChecked?: string;
  rowExpander?: string;
  rowExpandedState?: string;
  editTrigger?: 'dblclick' | 'click' | 'enter' | 'none';
  editor?: string;
  editorPopup?: string;
  /** Key that commits an inline edit (default Enter). */
  editCommit?: string;
  pagerNext?: string;
  pagerPrev?: string;
  pagerFirst?: string;
  /** A "More" / load-more button (growing lists). */
  loadMore?: string;
  /** Wait this long at the end of the scroll range for more rows (load-more-on-scroll grids). */
  loadMoreWaitMs?: number;
  quickFilter?: string;
  quickFilterOpen?: string;
  /** Wait one more frame after rows change (React re-render in two passes). */
  extraFrame?: boolean;
  stickyHeader?: number;
  /** Use generic header/row heuristics (ARIA / native tables). */
  generic?: boolean;
  /** The grid lives in this element inside the root's open shadow root (Lightning web components). */
  shadowInner?: string;
}

export interface ComboDialect extends BaseDialect {
  input: string;
  trigger?: string;
  /** What to click to open when the widget is not editable. */
  openClick?: string;
  /** Global selector of the popup (body-level overlays). */
  popup?: string;
  popupRoot?: string;
  /** A search box inside the popup (PrimeNG filter, Kendo list filter). */
  popupSearch?: string;
  option?: string;
  optionText?: string;
  optionClick?: string;
  optionSelected?: string;
  loading?: string;
  /** Selected value text inside the root (when not the input value). */
  valueText?: string;
  placeholder?: string;
  /** Chips/tags of a multi-select. */
  chips?: string;
  /** Root selector that marks a multi-select. */
  multiple?: string;
  /** Close the popup after choosing (Escape) - multi-selects keep it open. */
  closeAfter?: boolean;
}

export interface DayDate {
  attr: string;
  /** ms (timestamp), compact (yyyyMMdd), or parts (y m d in any separators). */
  format: 'ms' | 'compact' | 'parts';
  /** Month numbering in the attribute (Kendo, PrimeNG: 0). Default 1. */
  monthBase?: 0 | 1;
}

export interface DateDialect extends BaseDialect {
  input?: string;
  toggle?: string;
  popup: string;
  title?: string;
  prev?: string;
  next?: string;
  day: string;
  dayOutside?: string;
  dayDate?: DayDate;
  dayLabel?: boolean;
  dayText?: string;
  dayClick?: string;
  /** MUI-style section fields (contenteditable spans) instead of one text input. */
  sections?: string;
  sectionsRoot?: string;
  hiddenValue?: string;
  valueText?: string;
  /** Display format when the input has no placeholder (tokens: d dd M MM MMM MMMM yy yyyy). */
  format?: string;
  /** Prefer typing over the calendar (e.g. native <input type=date>). */
  typeFirst?: boolean;
  native?: boolean;
}

export interface TreeDialect extends BaseDialect {
  item: string;
  group?: string;
  label?: string;
  labelVisible?: boolean;
  toggle?: string;
  expandedState?: string;
  collapsedState?: string;
  selectedState?: string;
}

export interface TabsDialect extends BaseDialect {
  tab: string;
  tabOwner?: string;
  tabLabel?: string;
  tabSelected?: string;
}

export interface AccordionDialect extends BaseDialect {
  header: string;
  headerLabel?: string;
  expandedState?: string;
}

export interface DialogDialect extends BaseDialect {
  dialog: string;
  title?: string;
  close?: string;
}

export interface EditorDialect extends BaseDialect {
  editable: string;
  iframe?: string;
}

export interface SliderDialect extends BaseDialect {
  handle: string;
}

export interface DropzoneDialect extends BaseDialect {
  fileName?: string;
  fileScope?: string;
}

export type AnyDialect =
  | GridDialect | ComboDialect | DateDialect | TreeDialect | TabsDialect | AccordionDialect | DialogDialect | EditorDialect | SliderDialect | DropzoneDialect | BaseDialect;

/** Generic adapter: identity plus detection. */
export interface ComponentAdapter<D extends BaseDialect = BaseDialect> {
  readonly kind: WidgetKind;
  /** Library / adapter id, e.g. "ag-grid", "mui", "kendo", "aria". */
  readonly id: string;
  /** Human label, e.g. "ag-Grid". */
  readonly label: string;
  readonly fixture: AdapterFixture;
  readonly dialect: D;
  /** True when the target is (or contains exactly one, or sits inside) this adapter's widget. */
  detect(root: Locator): Promise<boolean>;
}

// ------------------------------------------------------------ grid model

export type CompareOp = 'equals' | 'notEquals' | 'contains' | 'startsWith' | 'endsWith' | 'matches' | 'gt' | 'gte' | 'lt' | 'lte' | 'empty' | 'notEmpty';

/** One condition on a row: `Customer is "Contoso"`. */
export interface CellCondition {
  column: string;
  op?: CompareOp;
  value: string;
}

export interface GridColumn {
  id: string;
  text: string;
  order: number;
}

export interface GridRow {
  /** Stable row key (row id / row index / DOM position) used to find the row again. */
  key: string;
  index: number;
  /** Cell texts by header text. */
  cells: Record<string, string>;
}

export interface GridReadResult {
  columns: GridColumn[];
  rows: GridRow[];
  total: number;
  pages: number;
  virtualized: boolean;
  ms: number;
}

export interface GridAdapter extends ComponentAdapter<GridDialect> {
  readonly kind: 'grid';
}

export interface ComboAdapter extends ComponentAdapter<ComboDialect> {
  readonly kind: 'combobox';
}

export interface DateAdapter extends ComponentAdapter<DateDialect> {
  readonly kind: 'datepicker';
}

/** What a component operation reports (evidence, verification, captured value). */
export interface ComponentReport {
  kind: WidgetKind;
  adapter: string;
  library: string;
  op: string;
  /** Resolved row key (grids). */
  rowKey?: string;
  row?: GridRow;
  /** Human sentence of what was verified after the action. */
  verified: string;
  /** Value to capture (reads). */
  value?: unknown;
  details?: Record<string, unknown>;
  ms: number;
}
