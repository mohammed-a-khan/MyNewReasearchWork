/**
 * WAI-ARIA 1.2 role and attribute characteristics used by the ARIA rules,
 * transcribed from the role definitions (§5.4) and the definitions of states
 * and properties (§6.6) of the specification. Where ARIA 1.2 deprecated a
 * state on a role that ARIA 1.1 supported (aria-expanded on most roles), it
 * is still accepted, so authors following 1.1 are not reported.
 */

export type ValueType = 'true/false' | 'true/false/undefined' | 'tristate' | 'token' | 'tokens' | 'integer' | 'number' | 'idref' | 'idrefs' | 'string';

export interface AttrDef {
  type: ValueType;
  /** Allowed tokens for token / tokens values. */
  values?: string[];
  /** Minimum for integers. */
  min?: number;
  global?: boolean;
  deprecated?: boolean;
}

const T = (type: ValueType, extra: Partial<AttrDef> = {}): AttrDef => ({ type, ...extra });

export const ATTRS: Record<string, AttrDef> = {
  // Global states and properties (§6.4), including those ARIA 1.2 deprecated as globals.
  'aria-atomic': T('true/false', { global: true }),
  'aria-busy': T('true/false', { global: true }),
  'aria-controls': T('idrefs', { global: true }),
  'aria-current': T('token', { global: true, values: ['page', 'step', 'location', 'date', 'time', 'true', 'false'] }),
  'aria-describedby': T('idrefs', { global: true }),
  'aria-description': T('string', { global: true }),
  'aria-details': T('idrefs', { global: true }),
  'aria-disabled': T('true/false', { global: true }),
  'aria-dropeffect': T('tokens', { global: true, deprecated: true, values: ['copy', 'execute', 'link', 'move', 'none', 'popup'] }),
  'aria-errormessage': T('idrefs', { global: true }),
  'aria-flowto': T('idrefs', { global: true }),
  'aria-grabbed': T('true/false/undefined', { global: true, deprecated: true }),
  'aria-haspopup': T('token', { global: true, values: ['false', 'true', 'menu', 'listbox', 'tree', 'grid', 'dialog'] }),
  'aria-hidden': T('true/false/undefined', { global: true }),
  'aria-invalid': T('string', { global: true }), // unknown values are treated as "true" (§6.6)
  'aria-keyshortcuts': T('string', { global: true }),
  'aria-label': T('string', { global: true }),
  'aria-labelledby': T('idrefs', { global: true }),
  'aria-live': T('token', { global: true, values: ['assertive', 'off', 'polite'] }),
  'aria-owns': T('idrefs', { global: true }),
  'aria-relevant': T('tokens', { global: true, values: ['additions', 'all', 'removals', 'text'] }),
  'aria-roledescription': T('string', { global: true }),
  'aria-braillelabel': T('string', { global: true }),
  'aria-brailleroledescription': T('string', { global: true }),
  // Widget, live-region, drag-and-drop and relationship attributes.
  'aria-activedescendant': T('idref'),
  'aria-autocomplete': T('token', { values: ['inline', 'list', 'both', 'none'] }),
  'aria-checked': T('tristate'),
  'aria-colcount': T('integer', { min: -1 }),
  'aria-colindex': T('integer', { min: 1 }),
  'aria-colindextext': T('string'),
  'aria-colspan': T('integer', { min: 1 }),
  'aria-expanded': T('true/false/undefined'),
  'aria-level': T('integer', { min: 1 }),
  'aria-modal': T('true/false'),
  'aria-multiline': T('true/false'),
  'aria-multiselectable': T('true/false'),
  'aria-orientation': T('token', { values: ['horizontal', 'vertical', 'undefined'] }),
  'aria-placeholder': T('string'),
  'aria-posinset': T('integer', { min: 1 }),
  'aria-pressed': T('tristate'),
  'aria-readonly': T('true/false'),
  'aria-required': T('true/false'),
  'aria-rowcount': T('integer', { min: -1 }),
  'aria-rowindex': T('integer', { min: 1 }),
  'aria-rowindextext': T('string'),
  'aria-rowspan': T('integer', { min: 0 }),
  'aria-selected': T('true/false/undefined'),
  'aria-setsize': T('integer', { min: -1 }),
  'aria-sort': T('token', { values: ['ascending', 'descending', 'none', 'other'] }),
  'aria-valuemax': T('number'),
  'aria-valuemin': T('number'),
  'aria-valuenow': T('number'),
  'aria-valuetext': T('string'),
};

export interface RoleDef {
  /** Role-specific supported states/properties (globals are always supported). */
  attrs?: string[];
  required?: string[];
  /** Required context roles (accessibility parent). */
  context?: string[];
  /** Required owned element roles. */
  owned?: string[];
  /** Naming prohibited (§5.2.8.6). */
  nameProhibited?: boolean;
  /** Children presentational (§5.2.10). */
  presentationalChildren?: boolean;
  abstract?: boolean;
  deprecated?: boolean;
}

const CELL = ['aria-colindex', 'aria-colspan', 'aria-rowindex', 'aria-rowspan', 'aria-colindextext', 'aria-rowindextext'];
const RANGE = ['aria-valuemax', 'aria-valuemin', 'aria-valuenow', 'aria-valuetext'];
const SET = ['aria-posinset', 'aria-setsize'];
const MENUITEM = ['aria-expanded', ...SET];
const GRID = ['aria-activedescendant', 'aria-colcount', 'aria-multiselectable', 'aria-readonly', 'aria-rowcount'];
const TEXTBOX = ['aria-activedescendant', 'aria-autocomplete', 'aria-multiline', 'aria-placeholder', 'aria-readonly', 'aria-required'];
const HEADER = [...CELL, 'aria-sort', 'aria-readonly', 'aria-required', 'aria-selected', 'aria-expanded'];
const MENU_ITEMS = ['menuitem', 'menuitemcheckbox', 'menuitemradio', 'group'];

export const ROLES: Record<string, RoleDef> = {
  alert: {},
  alertdialog: { attrs: ['aria-modal'] },
  application: { attrs: ['aria-activedescendant'] },
  article: { attrs: SET },
  banner: {},
  blockquote: {},
  button: { attrs: ['aria-pressed'], presentationalChildren: true },
  caption: { context: ['figure', 'grid', 'table', 'treegrid'], nameProhibited: true },
  cell: { attrs: CELL, context: ['row'] },
  checkbox: { attrs: ['aria-checked', 'aria-readonly', 'aria-required'], required: ['aria-checked'], presentationalChildren: true },
  code: { nameProhibited: true },
  columnheader: { attrs: HEADER, context: ['row'] },
  combobox: { attrs: ['aria-activedescendant', 'aria-autocomplete', 'aria-readonly', 'aria-required'], required: ['aria-expanded'] },
  comment: { attrs: SET },
  complementary: {},
  contentinfo: {},
  definition: {},
  deletion: { nameProhibited: true },
  dialog: { attrs: ['aria-modal'] },
  directory: { deprecated: true },
  document: {},
  emphasis: { nameProhibited: true },
  feed: { owned: ['article'] },
  figure: {},
  form: {},
  generic: { nameProhibited: true },
  grid: { attrs: GRID, owned: ['row', 'rowgroup'] },
  gridcell: { attrs: [...CELL, 'aria-readonly', 'aria-required', 'aria-selected'], context: ['row'] },
  group: { attrs: ['aria-activedescendant'] },
  heading: { attrs: ['aria-level'], required: ['aria-level'] },
  img: { presentationalChildren: true },
  insertion: { nameProhibited: true },
  link: {},
  list: { owned: ['listitem'] },
  listbox: { attrs: ['aria-activedescendant', 'aria-multiselectable', 'aria-orientation', 'aria-readonly', 'aria-required'], owned: ['group', 'option'] },
  listitem: { attrs: ['aria-level', ...SET], context: ['list', 'directory'] },
  log: {},
  main: {},
  mark: {},
  marquee: {},
  math: {},
  menu: { attrs: ['aria-activedescendant', 'aria-orientation'], owned: MENU_ITEMS },
  menubar: { attrs: ['aria-activedescendant', 'aria-orientation'], owned: MENU_ITEMS },
  menuitem: { attrs: MENUITEM, context: ['group', 'menu', 'menubar'] },
  menuitemcheckbox: { attrs: [...MENUITEM, 'aria-checked'], required: ['aria-checked'], context: ['group', 'menu', 'menubar'], presentationalChildren: true },
  menuitemradio: { attrs: [...MENUITEM, 'aria-checked'], required: ['aria-checked'], context: ['group', 'menu', 'menubar'], presentationalChildren: true },
  meter: { attrs: RANGE, required: ['aria-valuenow'], presentationalChildren: true },
  navigation: {},
  none: {},
  note: {},
  option: { attrs: ['aria-checked', 'aria-selected', ...SET], context: ['group', 'listbox'], presentationalChildren: true },
  paragraph: { nameProhibited: true },
  presentation: {},
  progressbar: { attrs: RANGE, presentationalChildren: true },
  radio: { attrs: ['aria-checked', 'aria-required', ...SET], required: ['aria-checked'], presentationalChildren: true },
  radiogroup: { attrs: ['aria-activedescendant', 'aria-orientation', 'aria-readonly', 'aria-required'] },
  region: {},
  row: { attrs: ['aria-activedescendant', 'aria-colindex', 'aria-level', 'aria-rowindex', 'aria-selected', 'aria-colindextext', 'aria-rowindextext', ...SET], context: ['grid', 'rowgroup', 'table', 'treegrid'], owned: ['cell', 'columnheader', 'gridcell', 'rowheader'] },
  rowgroup: { context: ['grid', 'table', 'treegrid'], owned: ['row'] },
  rowheader: { attrs: HEADER, context: ['row'] },
  scrollbar: { attrs: ['aria-orientation', ...RANGE], required: ['aria-controls', 'aria-valuenow'], presentationalChildren: true },
  search: {},
  searchbox: { attrs: TEXTBOX },
  separator: { attrs: ['aria-orientation', ...RANGE], presentationalChildren: true },
  slider: { attrs: ['aria-orientation', 'aria-readonly', 'aria-required', ...RANGE], required: ['aria-valuenow'], presentationalChildren: true },
  spinbutton: { attrs: ['aria-activedescendant', 'aria-readonly', 'aria-required', ...RANGE] },
  status: {},
  strong: { nameProhibited: true },
  subscript: { nameProhibited: true },
  suggestion: {},
  superscript: { nameProhibited: true },
  switch: { attrs: ['aria-checked', 'aria-readonly', 'aria-required'], required: ['aria-checked'], presentationalChildren: true },
  tab: { attrs: ['aria-selected', ...SET], context: ['tablist'], presentationalChildren: true },
  table: { attrs: ['aria-colcount', 'aria-rowcount'], owned: ['row', 'rowgroup'] },
  tablist: { attrs: ['aria-activedescendant', 'aria-multiselectable', 'aria-orientation'], owned: ['tab'] },
  tabpanel: {},
  term: {},
  textbox: { attrs: TEXTBOX },
  time: {},
  timer: {},
  toolbar: { attrs: ['aria-activedescendant', 'aria-orientation'] },
  tooltip: {},
  tree: { attrs: ['aria-activedescendant', 'aria-multiselectable', 'aria-orientation', 'aria-required'], owned: ['group', 'treeitem'] },
  treegrid: { attrs: [...GRID, 'aria-orientation', 'aria-required'], owned: ['row', 'rowgroup'] },
  treeitem: { attrs: ['aria-checked', 'aria-level', 'aria-selected', ...SET], context: ['group', 'tree'] },
  // Abstract roles (§5.3.2): never valid in content.
  command: { abstract: true }, composite: { abstract: true }, input: { abstract: true }, landmark: { abstract: true },
  range: { abstract: true }, roletype: { abstract: true }, section: { abstract: true }, sectionhead: { abstract: true },
  select: { abstract: true }, structure: { abstract: true }, widget: { abstract: true }, window: { abstract: true },
};

/** Roles ARIA 1.2 requires a name for, checked by name.widget (buttons, links, fields and images have their own rules). */
export const NAME_REQUIRED_WIDGETS = new Set(['alertdialog', 'dialog', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter', 'option', 'progressbar', 'scrollbar', 'tab', 'tooltip', 'treeitem']);

/** Composite and structural roles ARIA 1.2 requires a name for (name.container). */
export const NAME_REQUIRED_CONTAINERS = new Set(['grid', 'radiogroup', 'region', 'tabpanel', 'tree', 'treegrid', 'table', 'menu', 'menubar', 'toolbar']);

export const LANDMARKS = new Set(['banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation', 'region', 'search']);

/** Roles of form fields (name.form-field). */
export const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton']);

export function isValidRoleToken(t: string): boolean {
  const d = ROLES[t];
  return !!d && !d.abstract;
}

export function supportsAttr(role: string, attr: string): boolean {
  const a = ATTRS[attr];
  if (!a) return false;
  if (a.global) return true;
  if (attr === 'aria-expanded') return role !== 'none' && role !== 'presentation' && role !== 'generic';
  const d = ROLES[role];
  if (!d) return true;
  if (d.attrs?.includes(attr)) return true;
  // treegrid and grid rows inside trees take tree attributes; separators are only ranges when focusable (checked by the caller).
  return false;
}
