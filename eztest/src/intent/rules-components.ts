/**
 * Plain-English phrasings for complex widgets (grammar category
 * "Components"): grids, combo boxes, date pickers, trees, tabs, accordions,
 * dialogs, toasts, rich-text editors, sliders, masked inputs, drop zones,
 * charts and infinite lists. Every rule builds an `action: component` step
 * whose target is the widget container and whose args say what to do
 * (args.widget + args.op); the runner finds the library adapter at run time,
 * so the same sentence works for ag-Grid, MUI, Kendo, DevExtreme, ...
 *
 * These rules are tried before the generic ones and only claim lines that
 * name a widget kind ("... grid", "... combobox", "... date picker", ...),
 * so ordinary phrasings keep their meaning.
 */
import type { LocatorCandidate, Step, Target } from '../core/index.js';
import { literal, protectQuotes, quoteText, restoreQuotes } from './quotes.js';
import type { IntentRule, StepBody } from './rules.js';
import { describeTarget } from './target.js';

export type ComponentWidget =
  | 'grid' | 'combobox' | 'datepicker' | 'tree' | 'tabs' | 'accordion' | 'dialog' | 'toast' | 'richtext' | 'slider' | 'masked' | 'dropzone' | 'chart' | 'list';

const Q = String.raw`⟦\d+⟧`;
const KEY = String.raw`([A-Za-z_][\w.-]*)`;
const EXPECT = String.raw`(?:expect|verify|assert|check\s+that|ensure|confirm|make\s+sure)\s+(?:that\s+)?`;
const NUM = String.raw`(-?\d+(?:\.\d+)?|\$\{[\w.]+\})`;

/** Kind nouns per widget (longest first). */
const NOUNS: Record<Exclude<ComponentWidget, 'dialog' | 'toast'>, string> = {
  grid: String.raw`(?:data\s*grid|grid|data\s+table|table|list\s+view)`,
  combobox: String.raw`(?:combo\s*box|autocomplete|auto-complete|lookup|multi[-\s]?select|multiselect|select\s+box|drop-?down\s+list|picklist|type-?ahead)`,
  datepicker: String.raw`(?:date\s*picker|date\s+field|date\s*box|date\s+input|calendar)`,
  tree: String.raw`(?:tree\s*view|tree)`,
  tabs: String.raw`(?:tabs|tab\s*bar|tab\s*strip|tab\s*set|tab\s*view|tab\s+group|tab\s*panel)`,
  accordion: String.raw`(?:accordion|expansion\s+panels?|panel\s*bar)`,
  richtext: String.raw`(?:rich[-\s]?text(?:\s+(?:editor|field|box|area))?|text\s+editor|wysiwyg(?:\s+editor)?|editor)`,
  slider: String.raw`(?:range\s+slider|slider)`,
  masked: String.raw`(?:masked\s+(?:input|field|text\s*box))`,
  dropzone: String.raw`(?:drop\s*zone|drop\s+area|upload\s+area|drop\s+target)`,
  chart: String.raw`(?:chart|graph)`,
  list: String.raw`(?:infinite\s+list|feed|list)`,
};

/** "(the Orders grid)" capture for a widget kind. */
const W = (kind: keyof typeof NOUNS) => String.raw`((?:the\s+)?(?:${Q}|[^,]+?)\s+${NOUNS[kind]})`;

// ------------------------------------------------------------------ targets

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** An XPath string literal for any text (concat() when it holds both quote kinds). */
export function xpathLiteral(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat(${s.split("'").map((p) => `'${p}'`).join(`, "'", `)})`;
}

const ROLE_OF: Partial<Record<ComponentWidget, string[]>> = {
  grid: ['grid', 'treegrid', 'table', 'region'],
  combobox: ['combobox', 'listbox', 'group'],
  datepicker: ['group', 'combobox', 'textbox'],
  tree: ['tree', 'region', 'group'],
  tabs: ['tablist', 'region', 'group'],
  accordion: ['region', 'group'],
  richtext: ['textbox', 'region', 'group', 'application'],
  slider: ['slider', 'group', 'region'],
  masked: ['textbox'],
  dropzone: ['region', 'group', 'button'],
  chart: ['img', 'figure', 'region', 'group'],
  list: ['list', 'feed', 'listbox', 'region'],
};

const LABELLED = new Set<ComponentWidget>(['combobox', 'datepicker', 'richtext', 'slider', 'masked', 'dropzone']);

/**
 * The names a widget description can mean: "the Orders grid" -> ["Orders"],
 * 'the "Due date" date picker' -> ["Due date"]. "the Due date picker" is
 * ambiguous English ("Due date" picker or "Due" date picker), so both are
 * returned, the longer first.
 */
export function widgetNames(description: string, kind: ComponentWidget): string[] {
  const { text, quotes } = protectQuotes(description.trim());
  const base = text.replace(/^(?:the|a|an)\s+/i, '').replace(/^(?:chart|graph)\s+/i, '');
  const out: string[] = [];
  const add = (s: string) => {
    const n = literal(s.trim(), quotes);
    if (n && !out.includes(n)) out.push(n);
  };
  const quoted = /^(⟦\d+⟧)\s/.exec(base);
  if (kind === 'dialog' || kind === 'toast') add(base);
  else if (quoted) add(quoted[1]);
  else {
    if (kind === 'datepicker') {
      const partial = base.replace(/\s+(?:picker|field|box|input)$/i, '');
      if (partial !== base && /\bdate$/i.test(partial) && !/^date$/i.test(partial.trim())) add(partial);
    }
    if (kind === 'slider') {
      // "the Price range slider": a slider named "Price range", or a range slider named "Price".
      const partial = base.replace(/\s+slider$/i, '');
      if (partial !== base && /\brange$/i.test(partial) && !/^range$/i.test(partial.trim())) add(partial);
    }
    add(base.replace(new RegExp(String.raw`\s+${NOUNS[kind]}$`, 'i'), ''));
  }
  return out;
}

/** The main name of a widget description. */
export function widgetName(description: string, kind: ComponentWidget): string | undefined {
  return widgetNames(description, kind)[0];
}

function nameCandidates(name: string, kind: ComponentWidget): LocatorCandidate[] {
  const locators: LocatorCandidate[] = [];
  for (const role of ROLE_OF[kind] ?? []) locators.push({ strategy: 'role', value: role, name, exact: true });
  if (LABELLED.has(kind)) locators.push({ strategy: 'label', value: name, exact: true });
  locators.push({ strategy: 'css', value: `[aria-label="${esc(name)}"]` });
  if (kind === 'masked') locators.push({ strategy: 'placeholder', value: name, exact: true });
  if (kind === 'grid') locators.push({ strategy: 'css', value: `table:has(> caption:text-is("${esc(name)}"))` });
  const lit = xpathLiteral(name);
  locators.push({
    strategy: 'xpath',
    value: `//*[self::section or self::div or self::article or self::aside or self::fieldset or self::form or self::figure or self::li or self::mat-form-field][*[self::h1 or self::h2 or self::h3 or self::h4 or self::h5 or self::h6 or self::legend or self::label or self::figcaption or @role='heading'][normalize-space(.)=${lit}]]`,
  });
  return locators;
}

/**
 * Locator candidates for a widget container, most semantic first: an
 * accessible name on the widget role or a labelled region, an aria-label, a
 * <label>, or the section a heading/legend/label of that name introduces.
 * The runner then finds the widget at, around or inside the resolved element.
 */
export function widgetTarget(description: string, kind: ComponentWidget): Target {
  const d = description.trim();
  const pass = describeTarget(d);
  const looksSelector = pass.locators.length === 1 && ['css', 'xpath', 'testId'].includes(pass.locators[0].strategy) && !/\s/.test(d.replace(/^(css|xpath|testid)\s*=\s*/i, ''));
  if (looksSelector || /^(?:css|xpath|testid|test-id|data-testid|role|text)\s*=/i.test(d) || /\s(?:at|located\s+by)\s+(?:css|xpath|testid|role|text)\s*=/i.test(d)) return pass;
  const names = widgetNames(d, kind);
  if (!names.length) throw new Error(`Name the ${kind} (e.g. "the Orders ${kind === 'grid' ? 'grid' : kind}") or give a selector`);
  return { description: d, locators: names.flatMap((n) => nameCandidates(n, kind)) };
}

// ------------------------------------------------------------------ row conditions

export interface CellCondition {
  column: string;
  op: string;
  value: string;
}

const OPS: Array<[RegExp, string, boolean]> = [
  [/^is\s+not\s+empty$/i, 'notEmpty', false],
  [/^is\s+empty$/i, 'empty', false],
  [/^(?:is\s+not|isn't|!=|<>|does\s+not\s+equal)$/i, 'notEquals', true],
  [/^(?:is\s+greater\s+than|is\s+more\s+than|is\s+above|>)$/i, 'gt', true],
  [/^(?:is\s+less\s+than|is\s+below|<)$/i, 'lt', true],
  [/^(?:is\s+at\s+least|>=)$/i, 'gte', true],
  [/^(?:is\s+at\s+most|<=)$/i, 'lte', true],
  [/^(?:contains|includes|has)$/i, 'contains', true],
  [/^(?:starts\s+with|begins\s+with)$/i, 'startsWith', true],
  [/^ends\s+with$/i, 'endsWith', true],
  [/^matches$/i, 'matches', true],
  [/^(?:is|equals|=|==)$/i, 'equals', true],
];
const OP_WORDS = String.raw`is\s+not\s+empty|is\s+empty|is\s+not|isn't|does\s+not\s+equal|is\s+greater\s+than|is\s+more\s+than|is\s+above|is\s+less\s+than|is\s+below|is\s+at\s+least|is\s+at\s+most|contains|includes|starts\s+with|begins\s+with|ends\s+with|matches|equals|is|!=|<>|>=|<=|==|=|>|<`;

/** Parse 'Customer is "Contoso" and Status is "Open"' (quote-protected) into conditions. */
export function parseWhere(s: string, q: string[]): CellCondition[] {
  const out: CellCondition[] = [];
  for (const part of s.split(/\s+and\s+/i)) {
    const m = new RegExp(String.raw`^(?:the\s+)?(.+?)\s+(${OP_WORDS})(?:\s+(.+))?$`, 'i').exec(part.trim());
    if (!m) throw new Error(`Expected a condition like Column is "value", got "${restoreQuotes(part, q)}"`);
    const op = OPS.find(([re]) => re.test(m[2].replace(/\s+/g, ' ')));
    if (!op) throw new Error(`Unknown comparison "${m[2]}"`);
    if (op[2] && m[3] === undefined) throw new Error(`Condition "${restoreQuotes(part, q)}" needs a value`);
    out.push({ column: literal(m[1].trim(), q), op: op[1], value: op[2] ? literal(m[3].trim(), q) : '' });
  }
  return out;
}

const OP_TEXT: Record<string, string> = {
  equals: 'is', notEquals: 'is not', gt: 'is greater than', lt: 'is less than', gte: 'is at least', lte: 'is at most',
  contains: 'contains', startsWith: 'starts with', endsWith: 'ends with', matches: 'matches', empty: 'is empty', notEmpty: 'is not empty',
};

function columnText(c: string): string {
  return /^[A-Za-z][\w .#/-]*$/.test(c) && !new RegExp(String.raw`\s(?:${OP_WORDS}|and)(?:\s|$)`, 'i').test(` ${c} `) ? c : quoteText(c);
}

export function whereToText(where: CellCondition[]): string {
  return where.map((w) => `${columnText(w.column)} ${OP_TEXT[w.op] ?? 'is'}${w.op === 'empty' || w.op === 'notEmpty' ? '' : ` ${quoteText(w.value)}`}`).join(' and ');
}

/** "Id", "Customer" and "Amount" -> list. */
function quotedList(s: string, q: string[]): string[] {
  return s.split(/\s*(?:,|\band\b)\s*/i).map((x) => x.trim()).filter(Boolean).map((x) => literal(x, q));
}

// ------------------------------------------------------------------ builders

function comp(widget: ComponentWidget, op: string, target: Target | undefined, args: Record<string, unknown>, extra: Partial<StepBody> = {}): StepBody {
  return { action: 'component', ...(target ? { target } : {}), args: { widget, op, ...args }, ...extra } as StepBody;
}

const T = (kind: ComponentWidget, s: string, q: string[]) => widgetTarget(restoreQuotes(s.trim(), q), kind);
const V = (s: string, q: string[]) => literal(s.trim(), q);

function sortOrder(s: string | undefined): 'asc' | 'desc' {
  return s && /^(?:desc|descending|z\s*-\s*a|high(?:est)?\s+to\s+low(?:est)?|newest\s+first|largest\s+first)$/i.test(s.trim()) ? 'desc' : 'asc';
}
const ORDER = String.raw`(ascending|descending|asc|desc|a\s*-\s*z|z\s*-\s*a|high(?:est)?\s+to\s+low(?:est)?|low(?:est)?\s+to\s+high(?:est)?|newest\s+first|oldest\s+first|largest\s+first|smallest\s+first)`;

function countSpec(qual: string | undefined, n: string): { count: number; countOp: string } {
  const word = n.toLowerCase();
  const num = word === 'no' ? 0 : word === 'a' || word === 'an' || word === 'one' ? 1 : Number(n);
  const qq = (qual ?? '').trim().toLowerCase();
  if (word === 'no') return { count: 0, countOp: 'eq' };
  if (!qq && (word === 'a' || word === 'an')) return { count: 1, countOp: 'gte' };
  const op = /^at\s+least/.test(qq) ? 'gte' : /^at\s+most/.test(qq) ? 'lte' : /^more\s+than/.test(qq) ? 'gt' : /^(?:fewer|less)\s+than/.test(qq) ? 'lt' : 'eq';
  return { count: num, countOp: op };
}

const ROW = String.raw`(?:the\s+)?(first\s+)?row\s+(?:where|with|whose)\s+`;
const IN = String.raw`\s+(?:in|of|on|from)\s+`;

// ------------------------------------------------------------------ rules

const R = (r: Omit<IntentRule, 'category'> & { expect?: boolean }): IntentRule & { expect?: boolean } => ({ ...r, category: 'Components' });

export const COMPONENT_RULES: Array<IntentRule & { expect?: boolean }> = [
  // ================================================================ grids
  R({ name: 'grid-in-click-row', keywords: ['in', 'click', 'grid'], example: 'In the Orders grid, click the row where Customer is "Contoso" and Status is "Open"',
    re: new RegExp(String.raw`^in\s+${W('grid')},?\s+(double[-\s]?click|right[-\s]?click|click|tap)\s+(?:on\s+)?${ROW}(.+)$`, 'i'),
    build: (m, q) => comp('grid', /double/i.test(m[2]) ? 'doubleClickRow' : /right/i.test(m[2]) ? 'rightClickRow' : 'clickRow', T('grid', m[1], q), { where: parseWhere(m[4], q), ...(m[3] ? { first: true } : {}) }) }),
  R({ name: 'grid-in-click-control', keywords: ['in', 'click', 'grid'], example: 'In the Orders grid, click "Edit" in the row where Id is "42"',
    re: new RegExp(String.raw`^in\s+${W('grid')},?\s+click\s+(?:on\s+)?(?:the\s+)?(${Q}|.+?)(?:\s+(?:button|link|icon|action))?\s+(?:in|on|of|for)\s+${ROW}(.+)$`, 'i'),
    build: (m, q) => comp('grid', 'clickInRow', T('grid', m[1], q), { name: V(m[2], q), where: parseWhere(m[4], q), ...(m[3] ? { first: true } : {}) }) }),
  R({ name: 'grid-click-row', keywords: ['click', 'row'], example: 'Click the row where Id is "42" in the Orders grid',
    re: new RegExp(String.raw`^(double[-\s]?click|right[-\s]?click|click|tap)\s+(?:on\s+)?${ROW}(.+?)${IN}${W('grid')}$`, 'i'),
    build: (m, q) => comp('grid', /double/i.test(m[1]) ? 'doubleClickRow' : /right/i.test(m[1]) ? 'rightClickRow' : 'clickRow', T('grid', m[4], q), { where: parseWhere(m[3], q), ...(m[2] ? { first: true } : {}) }) }),
  R({ name: 'grid-edit-cell', keywords: ['edit', 'set', 'change', 'update'], example: 'Edit the Amount of the row where Id is "42" in the Orders grid to 150',
    re: new RegExp(String.raw`^(?:edit|set|change|update)\s+(?:the\s+)?(${Q}|.+?)\s+(?:of|in|for)\s+${ROW}(.+?)${IN}${W('grid')}\s+to\s+(.+)$`, 'i'),
    build: (m, q) => comp('grid', 'editCell', T('grid', m[4], q), { column: V(m[1], q), where: parseWhere(m[3], q), ...(m[2] ? { first: true } : {}) }, { value: V(m[5], q) }) }),
  R({ name: 'grid-read-cell', keywords: ['capture', 'read', 'store', 'get'], example: 'Capture the Amount of the row where Id is "42" in the Orders grid as amount',
    re: new RegExp(String.raw`^(?:capture|read|store|save|get|remember|grab)\s+(?:the\s+)?(${Q}|.+?)\s+(?:of|from|in)\s+${ROW}(.+?)${IN}${W('grid')}\s+(?:as|into)\s+${KEY}$`, 'i'),
    build: (m, q) => comp('grid', 'readCell', T('grid', m[4], q), { column: V(m[1], q), where: parseWhere(m[3], q), ...(m[2] ? { first: true } : {}) }, { captureAs: m[5] }) }),
  R({ name: 'grid-expect-cell', keywords: ['expect', 'verify'], expect: true, example: 'Expect the Amount of the row where Id is "42" in the Orders grid to be "150.00"',
    re: new RegExp(String.raw`^${EXPECT}(?:the\s+)?(${Q}|.+?)\s+(?:of|in)\s+${ROW}(.+?)${IN}${W('grid')}\s+(to\s+be\s+empty|is\s+empty|to\s+be|is|equals|to\s+equal|to\s+contain|contains)(?:\s+(.+))?$`, 'i'),
    build: (m, q) => {
      const empty = /empty/i.test(m[5]);
      if (!empty && m[6] === undefined) return undefined;
      return comp('grid', 'expectCell', T('grid', m[4], q), { column: V(m[1], q), where: parseWhere(m[3], q), match: empty ? 'empty' : /contain/i.test(m[5]) ? 'contains' : 'equals', ...(m[2] ? { first: true } : {}) }, empty ? {} : { value: V(m[6], q) });
    } }),
  R({ name: 'grid-expect-rows', keywords: ['expect', 'verify'], expect: true, example: 'Expect the Orders grid to have 3 rows where Status is "Open"',
    re: new RegExp(String.raw`^${EXPECT}${W('grid')}\s+(?:to\s+have|has|have|contains?|should\s+have|to\s+contain)\s+(exactly\s+|at\s+least\s+|at\s+most\s+|more\s+than\s+|fewer\s+than\s+|less\s+than\s+)?(\d+|no|an?|one|\$\{[\w.]+\})\s+rows?(?:\s+(?:where|with|whose)\s+(.+))?$`, 'i'),
    build: (m, q) => {
      // "Expect the Orders table to have 2 rows" keeps its classic meaning (rendered <table> rows).
      if (!m[4] && /\btable$/i.test(m[1])) return undefined;
      const c = /^\$\{/.test(m[3]) ? { count: m[3], countOp: m[2] ? countSpec(m[2], '1').countOp : 'eq' } : countSpec(m[2], m[3]);
      return comp('grid', 'expectRows', T('grid', m[1], q), { ...(m[4] ? { where: parseWhere(m[4], q) } : {}), ...c });
    } }),
  R({ name: 'grid-sort', keywords: ['sort', 'order'], example: 'Sort the Orders grid by Amount descending',
    re: new RegExp(String.raw`^(?:sort|order)\s+${W('grid')}\s+by\s+(?:the\s+)?(${Q}|.+?)(?:\s+column)?(?:\s+${ORDER})?$`, 'i'),
    build: (m, q) => comp('grid', 'sort', T('grid', m[1], q), { column: V(m[2], q), order: sortOrder(m[3]) }) }),
  R({ name: 'grid-filter', keywords: ['filter'], example: 'Filter the Orders grid where Region is "EU"',
    re: new RegExp(String.raw`^filter\s+${W('grid')}\s+(?:where|by|on|so\s+that)\s+(?:the\s+)?(${Q}|.+?)\s+(is|equals|=|contains|includes)\s+(.+)$`, 'i'),
    build: (m, q) => comp('grid', 'filter', T('grid', m[1], q), { column: V(m[2], q), match: /contain|include/i.test(m[3]) ? 'contains' : 'equals' }, { value: V(m[4], q) }) }),
  R({ name: 'grid-read-all', keywords: ['capture', 'read', 'collect'], example: 'Capture all rows of the Orders grid as orders',
    re: new RegExp(String.raw`^(?:capture|read|store|save|get|collect|export)\s+all\s+(?:the\s+)?rows\s+(?:of|from|in)\s+${W('grid')}(?:\s+(?:where|with|whose)\s+(.+?))?\s+(?:as|into)\s+${KEY}$`, 'i'),
    build: (m, q) => comp('grid', 'readAll', T('grid', m[1], q), { ...(m[2] ? { where: parseWhere(m[2], q) } : {}) }, { captureAs: m[3] }) }),
  R({ name: 'grid-expect-sorted', keywords: ['expect', 'verify'], expect: true, example: 'Expect the Orders grid column Amount is sorted descending',
    re: new RegExp(String.raw`^${EXPECT}${W('grid')}(?:'s)?\s+column\s+(${Q}|.+?)\s+(?:is|to\s+be|should\s+be)\s+sorted(?:\s+${ORDER})?$`, 'i'),
    build: (m, q) => comp('grid', 'expectSorted', T('grid', m[1], q), { column: V(m[2], q), order: sortOrder(m[3]) }) }),
  R({ name: 'grid-expect-sorted-of', keywords: ['expect', 'verify'], expect: true, example: 'Expect the Amount column of the Orders grid to be sorted descending',
    re: new RegExp(String.raw`^${EXPECT}(?:the\s+)?(${Q}|.+?)\s+column\s+(?:of|in)\s+${W('grid')}\s+(?:is|to\s+be|should\s+be)\s+sorted(?:\s+${ORDER})?$`, 'i'),
    build: (m, q) => comp('grid', 'expectSorted', T('grid', m[2], q), { column: V(m[1], q), order: sortOrder(m[3]) }) }),
  R({ name: 'grid-expect-columns', keywords: ['expect', 'verify'], expect: true, example: 'Expect the Orders grid to have columns "Id", "Customer" and "Amount"',
    re: new RegExp(String.raw`^${EXPECT}${W('grid')}\s+(?:to\s+have|has|have|to\s+show|shows)\s+(?:the\s+)?columns?\s+((?:${Q}|[^,]+?)(?:\s*(?:,|\band\b)\s*(?:${Q}|[^,]+?))*?)(\s+in\s+(?:this|that)\s+order)?$`, 'i'),
    build: (m, q) => comp('grid', 'expectColumns', T('grid', m[1], q), { columns: quotedList(m[2], q), ...(m[3] ? { ordered: true } : {}) }) }),
  R({ name: 'grid-select-rows', keywords: ['select'], example: 'Select the rows where Status is "Open" in the Orders grid',
    re: new RegExp(String.raw`^(?:select|check|tick)\s+(?:the\s+|all\s+(?:the\s+)?)?(rows|row|first\s+row)\s+(?:where|with|whose)\s+(.+?)${IN}${W('grid')}$`, 'i'),
    build: (m, q) => comp('grid', 'selectRows', T('grid', m[3], q), { where: parseWhere(m[2], q), ...(/^rows$/i.test(m[1]) ? { all: true } : {}), ...(/first/i.test(m[1]) ? { first: true } : {}) }) }),
  R({ name: 'grid-scroll-to-row', keywords: ['scroll'], example: 'Scroll the Orders grid to the row where Id is "9500"',
    re: new RegExp(String.raw`^scroll\s+${W('grid')}\s+to\s+${ROW}(.+)$`, 'i'),
    build: (m, q) => comp('grid', 'scrollToRow', T('grid', m[1], q), { where: parseWhere(m[3], q), ...(m[2] ? { first: true } : {}) }) }),
  R({ name: 'grid-expand-row', keywords: ['expand', 'collapse'], example: 'Expand the row where Id is "42" in the Orders grid',
    re: new RegExp(String.raw`^(expand|collapse)\s+${ROW}(.+?)${IN}${W('grid')}$`, 'i'),
    build: (m, q) => comp('grid', /collapse/i.test(m[1]) ? 'collapseRow' : 'expandRow', T('grid', m[4], q), { where: parseWhere(m[3], q), ...(m[2] ? { first: true } : {}) }) }),

  // ================================================================ combo boxes
  R({ name: 'combo-choose', keywords: ['choose', 'pick', 'select'], example: 'Choose "Berlin" in the City combobox',
    re: new RegExp(String.raw`^(?:choose|pick|select)\s+(.+?)\s+(?:in|from|on|for)\s+${W('combobox')}$`, 'i'),
    build: (m, q) => comp('combobox', 'choose', T('combobox', m[2], q), { values: quotedList(m[1], q) }) }),
  R({ name: 'combo-expect', keywords: ['expect', 'verify'], expect: true, example: 'Expect the City combobox to show "Berlin"',
    re: new RegExp(String.raw`^${EXPECT}${W('combobox')}\s+(?:to\s+(?:show|have|contain|display)|shows|has|displays|contains)\s+(.+?)(?:\s+selected)?$`, 'i'),
    build: (m, q) => comp('combobox', 'expect', T('combobox', m[1], q), { values: quotedList(m[2], q) }) }),

  // ================================================================ date pickers
  R({ name: 'date-pick', keywords: ['pick', 'choose', 'select', 'enter'], example: 'Pick 15 March 2027 in the Due date picker',
    re: new RegExp(String.raw`^(?:pick|choose|select|enter|type)\s+(?:the\s+date\s+)?(.+?)\s+(?:in|on|for|into)\s+${W('datepicker')}(?:\s+(by\s+typing|using\s+the\s+calendar|(?:using|in)\s+(?:the\s+)?format\s+${Q}))?$`, 'i'),
    build: (m, q) => comp('datepicker', 'pick', T('datepicker', m[2], q), { date: V(m[1], q), ...(m[3] && /typing/i.test(m[3]) ? { typing: true } : {}), ...(m[3] && /calendar/i.test(m[3]) ? { calendar: true } : {}), ...(m[3] && /format/i.test(m[3]) ? { format: V(m[3].replace(/^.*format\s+/i, ''), q) } : {}) }) }),
  R({ name: 'date-set', keywords: ['set'], example: 'Set the Due date picker to 2027-03-15',
    re: new RegExp(String.raw`^(?:set|change)\s+${W('datepicker')}\s+to\s+(.+)$`, 'i'),
    build: (m, q) => comp('datepicker', 'pick', T('datepicker', m[1], q), { date: V(m[2], q) }) }),
  R({ name: 'date-expect', keywords: ['expect', 'verify'], expect: true, example: 'Expect the Due date picker to show 15 March 2027',
    re: new RegExp(String.raw`^${EXPECT}${W('datepicker')}\s+(?:to\s+(?:show|have|hold|be)|shows|holds|is)\s+(.+)$`, 'i'),
    build: (m, q) => comp('datepicker', 'expect', T('datepicker', m[1], q), { date: V(m[2], q) }) }),

  // ================================================================ trees
  R({ name: 'tree-node', keywords: ['expand', 'collapse', 'select'], example: 'Expand "Europe > Germany" in the Regions tree',
    re: new RegExp(String.raw`^(expand|open|collapse|close|select|click)\s+(?:the\s+)?(?:node\s+)?(${Q}|.+?)\s+(?:in|of|on)\s+${W('tree')}$`, 'i'),
    build: (m, q) => comp('tree', /expand|open/i.test(m[1]) ? 'expand' : /collapse|close/i.test(m[1]) ? 'collapse' : 'select', T('tree', m[3], q), { path: V(m[2], q) }) }),
  R({ name: 'tree-expect', keywords: ['expect', 'verify'], expect: true, example: 'Expect "Europe > Germany > Berlin" in the Regions tree to be visible',
    re: new RegExp(String.raw`^${EXPECT}(?:the\s+)?(?:node\s+)?(${Q})\s+(?:in|of)\s+${W('tree')}\s+(?:to\s+be|is)\s+(expanded|collapsed|selected|visible|shown)$`, 'i'),
    build: (m, q) => comp('tree', 'expect', T('tree', m[2], q), { path: V(m[1], q), state: m[3].toLowerCase() === 'shown' ? 'visible' : m[3].toLowerCase() }) }),

  // ================================================================ tabs and accordions
  R({ name: 'tabs-open', keywords: ['open', 'select', 'switch'], example: 'Open the "Billing" tab in the Settings tabs',
    re: new RegExp(String.raw`^(?:open|select|click|switch\s+to|go\s+to|activate)\s+(?:the\s+)?(${Q}|.+?)\s+tab\s+(?:in|of|on)\s+${W('tabs')}$`, 'i'),
    build: (m, q) => comp('tabs', 'select', T('tabs', m[2], q), { tab: V(m[1], q) }) }),
  R({ name: 'tabs-expect', keywords: ['expect', 'verify'], expect: true, example: 'Expect the "Billing" tab in the Settings tabs to be selected',
    re: new RegExp(String.raw`^${EXPECT}(?:the\s+)?(${Q}|.+?)\s+tab\s+(?:in|of)\s+${W('tabs')}\s+(?:to\s+be|is)\s+(?:selected|active|open)$`, 'i'),
    build: (m, q) => comp('tabs', 'expect', T('tabs', m[2], q), { tab: V(m[1], q) }) }),
  R({ name: 'accordion-toggle', keywords: ['expand', 'collapse'], example: 'Expand the "Shipping" section in the Details accordion',
    re: new RegExp(String.raw`^(expand|open|collapse|close)\s+(?:the\s+)?(${Q}|.+?)\s+(?:section|panel|pane|item)\s+(?:in|of|on)\s+${W('accordion')}$`, 'i'),
    build: (m, q) => comp('accordion', /expand|open/i.test(m[1]) ? 'expand' : 'collapse', T('accordion', m[3], q), { section: V(m[2], q) }) }),

  // ================================================================ dialogs (modals, stacked)
  R({ name: 'dialog-click', keywords: ['in', 'click', 'dialog'], example: 'In the "Confirm delete" dialog, click "Delete"',
    re: new RegExp(String.raw`^in\s+the\s+(${Q}|top(?:most)?|front|current|open|last)\s+(?:dialog|modal|popup\s+dialog),?\s+click\s+(?:on\s+)?(?:the\s+)?(${Q}|.+?)(?:\s+(?:button|link))?$`, 'i'),
    build: (m, q) => comp('dialog', 'click', undefined, { ...(m[1].startsWith('⟦') ? { dialog: V(m[1], q) } : {}), name: V(m[2], q) }) }),
  R({ name: 'dialog-close', keywords: ['close', 'dismiss'], example: 'Close the "Confirm delete" dialog',
    re: new RegExp(String.raw`^(?:close|dismiss)\s+the\s+(${Q}|top(?:most)?|front|current|last)\s+(?:dialog|modal|popup\s+dialog)$`, 'i'),
    build: (m, q) => comp('dialog', 'close', undefined, m[1].startsWith('⟦') ? { dialog: V(m[1], q) } : {}) }),
  R({ name: 'dialog-expect', keywords: ['expect', 'verify'], expect: true, example: 'Expect the "Confirm delete" dialog to be open',
    re: new RegExp(String.raw`^${EXPECT}the\s+(${Q})\s+(?:dialog|modal)\s+(?:to\s+be|is)\s+(open|shown|visible|closed|gone|hidden)$`, 'i'),
    build: (m, q) => comp('dialog', /open|shown|visible/i.test(m[2]) ? 'expectOpen' : 'expectClosed', undefined, { dialog: V(m[1], q) }) }),
  R({ name: 'dialog-expect-count', keywords: ['expect', 'verify'], expect: true, example: 'Expect 2 dialogs to be open',
    re: new RegExp(String.raw`^${EXPECT}(\d+|no|one)\s+(?:dialogs?|modals?)\s+(?:to\s+be|are|is)\s+open$`, 'i'),
    build: (m) => comp('dialog', 'expectCount', undefined, { count: /^no$/i.test(m[1]) ? 0 : /^one$/i.test(m[1]) ? 1 : Number(m[1]) }) }),

  // ================================================================ toasts
  R({ name: 'toast-watch', keywords: ['watch', 'record'], example: 'Watch for toasts',
    re: /^(?:watch|listen|record)\s+(?:for\s+)?(?:the\s+)?(?:toasts?|notifications?|snackbars?|toast\s+messages?)$/i,
    build: () => comp('toast', 'watch', undefined, {}) }),
  R({ name: 'toast-expect', keywords: ['expect', 'verify'], expect: true, example: 'Expect a toast containing "saved"',
    re: new RegExp(String.raw`^${EXPECT}(an?|the|no)\s+(?:toast|snackbar|notification)(?:\s+message)?\s+(?:(saying|that\s+says|with\s+(?:the\s+)?text|reading)|containing|contains|with)?\s*(${Q})(?:\s+(?:to\s+)?(?:appears?|appeared|is\s+shown|was\s+shown|to\s+be\s+shown|to\s+appear))?$`, 'i'),
    build: (m, q) => comp('toast', /^no$/i.test(m[1]) ? 'expectNone' : 'expect', undefined, { text: V(m[3], q), match: m[2] ? 'equals' : 'contains' }) }),

  // ================================================================ rich text
  R({ name: 'editor-type', keywords: ['type', 'enter', 'write'], example: 'Type "Hello" in the Notes editor',
    re: new RegExp(String.raw`^(?:type|enter|write|put)\s+(${Q}|\$\{[\w.]+\})\s+(?:in|into|in\s+to)\s+${W('richtext')}$`, 'i'),
    build: (m, q) => comp('richtext', 'replace', T('richtext', m[2], q), {}, { value: V(m[1], q) }) }),
  R({ name: 'editor-append', keywords: ['append', 'add'], example: 'Append " and goodbye" to the Notes editor',
    re: new RegExp(String.raw`^(?:append|add)\s+(${Q}|\$\{[\w.]+\})\s+to\s+${W('richtext')}$`, 'i'),
    build: (m, q) => comp('richtext', 'append', T('richtext', m[2], q), {}, { value: V(m[1], q) }) }),
  R({ name: 'editor-clear', keywords: ['clear', 'empty'], example: 'Clear the Notes editor',
    re: new RegExp(String.raw`^(?:clear|empty|erase)\s+${W('richtext')}$`, 'i'),
    build: (m, q) => comp('richtext', 'clear', T('richtext', m[1], q), {}) }),
  R({ name: 'editor-expect', keywords: ['expect', 'verify'], expect: true, example: 'Expect the Notes editor to contain "Hello"',
    re: new RegExp(String.raw`^${EXPECT}${W('richtext')}\s+(to\s+contain|contains|to\s+(?:be|equal|read)|reads|equals|to\s+be\s+empty|is\s+empty)\s*(${Q}|\$\{[\w.]+\})?$`, 'i'),
    build: (m, q) => {
      const empty = /empty/i.test(m[2]);
      if (!empty && !m[3]) return undefined;
      return comp('richtext', 'expect', T('richtext', m[1], q), { match: empty ? 'empty' : /contain/i.test(m[2]) ? 'contains' : 'equals' }, empty ? {} : { value: V(m[3], q) });
    } }),

  // ================================================================ sliders, masked inputs, drop zones
  R({ name: 'slider-set', keywords: ['set', 'move', 'slide'], example: 'Set the Price slider to 40',
    re: new RegExp(String.raw`^(?:set|move|slide|drag)\s+${W('slider')}\s+to\s+${NUM}(?:\s+(?:and|-|to|–)\s+${NUM})?$`, 'i'),
    build: (m, q) => comp('slider', 'set', T('slider', m[1], q), { ...(m[3] ? { upper: m[3] } : {}) }, { value: m[2] }) }),
  R({ name: 'slider-expect', keywords: ['expect', 'verify'], expect: true, example: 'Expect the Price slider to be 40',
    re: new RegExp(String.raw`^${EXPECT}${W('slider')}\s+(?:to\s+be(?:\s+at)?|is(?:\s+at)?|to\s+show|shows)\s+${NUM}$`, 'i'),
    build: (m, q) => comp('slider', 'expect', T('slider', m[1], q), {}, { value: m[2] }) }),
  R({ name: 'masked-type', keywords: ['type', 'enter'], example: 'Type "4111111111111111" into the Card number masked input',
    re: new RegExp(String.raw`^(?:type|enter|key\s+in)\s+(${Q}|\$\{[\w.]+\})\s+(?:in|into)\s+${W('masked')}$`, 'i'),
    build: (m, q) => comp('masked', 'type', T('masked', m[2], q), {}, { value: V(m[1], q) }) }),
  R({ name: 'dropzone-drop', keywords: ['upload', 'drop', 'attach'], example: 'Drop "fixtures/po.pdf" onto the Attachments drop zone',
    re: new RegExp(String.raw`^(?:upload|drop|attach)\s+((?:${Q})(?:\s*(?:,|and)\s*${Q})*)\s+(?:to|into|onto|on|in)\s+${W('dropzone')}$`, 'i'),
    build: (m, q) => comp('dropzone', 'drop', T('dropzone', m[2], q), { files: quotedList(m[1], q) }) }),

  // ================================================================ charts
  R({ name: 'chart-expect-points', keywords: ['expect', 'verify'], expect: true, example: 'Expect the chart Revenue to have 12 points',
    re: new RegExp(String.raw`^${EXPECT}(?:the\s+)?(?:(?:chart|graph)\s+(${Q}|[^"]+?)|(.+?\s+(?:chart|graph)))(?:\s+series\s+(${Q}))?\s+(?:to\s+have|has|should\s+have)\s+(\d+|\$\{[\w.]+\})\s+(?:data\s+)?points?$`, 'i'),
    build: (m, q) => comp('chart', 'expectPoints', chartTarget(m[1], m[2], q), { count: /^\d+$/.test(m[4]) ? Number(m[4]) : m[4], ...(m[3] ? { series: V(m[3], q) } : {}) }) }),
  R({ name: 'chart-expect-value', keywords: ['expect', 'verify'], expect: true, example: 'Expect the Revenue chart value for "Mar" to be 101',
    re: new RegExp(String.raw`^${EXPECT}(?:the\s+)?(?:(?:chart|graph)\s+(${Q}|[^"]+?)|(.+?\s+(?:chart|graph)))\s+value\s+(?:for|at|of)\s+(${Q})(?:\s+in\s+series\s+(${Q}))?\s+(?:to\s+be|is|equals)\s+(.+)$`, 'i'),
    build: (m, q) => comp('chart', 'expectValue', chartTarget(m[1], m[2], q), { label: V(m[3], q), ...(m[4] ? { series: V(m[4], q) } : {}) }, { value: V(m[5], q) }) }),
  R({ name: 'chart-capture', keywords: ['capture', 'read'], example: 'Capture the data of the Revenue chart as revenue',
    re: new RegExp(String.raw`^(?:capture|read|store|save|get)\s+(?:the\s+)?(?:data|points|values|series)\s+(?:of|from|in)\s+(?:the\s+)?(?:(?:chart|graph)\s+(${Q}|[^"]+?)|(.+?\s+(?:chart|graph)))\s+(?:as|into)\s+${KEY}$`, 'i'),
    build: (m, q) => comp('chart', 'capture', chartTarget(m[1], m[2], q), {}, { captureAs: m[3] }) }),

  // ================================================================ infinite lists
  R({ name: 'list-capture-all', keywords: ['capture', 'collect', 'load'], example: 'Capture all items of the Feed list as items',
    re: new RegExp(String.raw`^(?:capture|read|collect|store|get|load)\s+all\s+(?:the\s+)?(?:items|entries|posts|cards|rows)\s+(?:of|from|in)\s+${W('list')}(?:\s+up\s+to\s+(\d+))?\s+(?:as|into)\s+${KEY}$`, 'i'),
    build: (m, q) => comp('list', 'capture', T('list', m[1], q), { ...(m[2] ? { max: Number(m[2]) } : {}) }, { captureAs: m[3] }) }),
  R({ name: 'list-expect-count', keywords: ['expect', 'verify'], expect: true, example: 'Expect the Feed list to have 250 items in total',
    re: new RegExp(String.raw`^${EXPECT}${W('list')}\s+(?:to\s+have|has)\s+(at\s+least\s+|at\s+most\s+|exactly\s+)?(\d+)\s+(?:items|entries|posts|cards)\s+(?:in\s+total|when\s+fully\s+loaded|after\s+(?:loading\s+all|scrolling(?:\s+to\s+the\s+end)?))$`, 'i'),
    build: (m, q) => comp('list', 'expectCount', T('list', m[1], q), { ...countSpec(m[2], m[3]) }) }),
];

function chartTarget(named: string | undefined, phrase: string | undefined, q: string[]): Target {
  if (phrase) return widgetTarget(restoreQuotes(phrase.trim(), q), 'chart');
  const name = literal((named ?? '').trim(), q);
  return widgetTarget(`the ${quoteText(name)} chart`, 'chart');
}

/** True for a component phrasing that starts with Expect/Verify (a step of its own, never a post-condition). */
export function isComponentExpectation(line: string): boolean {
  const { text, quotes } = protectQuotes(line.trim().replace(/\s*\[[^\]]*\]\s*$/, '').replace(/[.;]+$/, ''));
  return COMPONENT_RULES.some((r) => {
    if (!r.expect) return false;
    const m = r.re.exec(text);
    if (!m) return false;
    try {
      return r.build(m, quotes) !== undefined;
    } catch {
      return false;
    }
  });
}

// ------------------------------------------------------------------ rendering (inverse of the rules)

type A = Record<string, unknown>;
const qt = (v: unknown) => quoteText(String(v));

function orderText(o: unknown): string {
  return o === 'desc' ? 'descending' : 'ascending';
}

function countText(a: A): string {
  const n = a.count;
  if (n === 0 && a.countOp === 'eq') return 'no';
  const qual = a.countOp === 'gte' ? 'at least ' : a.countOp === 'lte' ? 'at most ' : a.countOp === 'gt' ? 'more than ' : a.countOp === 'lt' ? 'fewer than ' : '';
  return `${qual}${String(n)}`;
}

/** Canonical .ez line for a component step. */
export function componentStepToText(s: Step): string {
  const a: A = s.args ?? {};
  const d = s.target?.description ?? '';
  const where = Array.isArray(a.where) ? whereToText(a.where as CellCondition[]) : '';
  const row = `the ${a.first ? 'first ' : ''}row where ${where}`;
  const v = s.value ?? '';
  switch (`${String(a.widget)}.${String(a.op)}`) {
    case 'grid.clickRow': return `Click ${row} in ${d}`;
    case 'grid.doubleClickRow': return `Double-click ${row} in ${d}`;
    case 'grid.rightClickRow': return `Right-click ${row} in ${d}`;
    case 'grid.clickInRow': return `In ${d}, click ${qt(a.name)} in ${row}`;
    case 'grid.editCell': return `Edit the ${columnText(String(a.column))} of ${row} in ${d} to ${qt(v)}`;
    case 'grid.readCell': return `Capture the ${columnText(String(a.column))} of ${row} in ${d} as ${s.captureAs}`;
    case 'grid.expectCell': return a.match === 'empty' ? `Expect the ${columnText(String(a.column))} of ${row} in ${d} to be empty` : `Expect the ${columnText(String(a.column))} of ${row} in ${d} ${a.match === 'contains' ? 'to contain' : 'to be'} ${qt(v)}`;
    case 'grid.expectRows': return `Expect ${d} to have ${countText(a)} rows${where ? ` where ${where}` : ''}`;
    case 'grid.sort': return `Sort ${d} by ${columnText(String(a.column))} ${orderText(a.order)}`;
    case 'grid.filter': return `Filter ${d} where ${columnText(String(a.column))} ${a.match === 'contains' ? 'contains' : 'is'} ${qt(v)}`;
    case 'grid.readAll': return `Capture all rows of ${d}${where ? ` where ${where}` : ''} as ${s.captureAs}`;
    case 'grid.expectSorted': return `Expect the ${columnText(String(a.column))} column of ${d} to be sorted ${orderText(a.order)}`;
    case 'grid.expectColumns': return `Expect ${d} to have columns ${(a.columns as string[]).map((c) => qt(c)).join(', ')}${a.ordered ? ' in this order' : ''}`;
    case 'grid.selectRows': return `Select ${a.all ? 'the rows' : a.first ? 'the first row' : 'the row'} where ${where} in ${d}`;
    case 'grid.scrollToRow': return `Scroll ${d} to ${row}`;
    case 'grid.expandRow': return `Expand ${row} in ${d}`;
    case 'grid.collapseRow': return `Collapse ${row} in ${d}`;
    case 'combobox.choose': return `Choose ${(a.values as string[]).map((x) => qt(x)).join(', ')} in ${d}`;
    case 'combobox.expect': return `Expect ${d} to show ${(a.values as string[]).map((x) => qt(x)).join(', ')}`;
    case 'datepicker.pick': return `Pick ${qt(a.date)} in ${d}${a.typing ? ' by typing' : a.calendar ? ' using the calendar' : a.format ? ` using format ${qt(a.format)}` : ''}`;
    case 'datepicker.expect': return `Expect ${d} to show ${qt(a.date)}`;
    case 'tree.expand': return `Expand ${qt(a.path)} in ${d}`;
    case 'tree.collapse': return `Collapse ${qt(a.path)} in ${d}`;
    case 'tree.select': return `Select ${qt(a.path)} in ${d}`;
    case 'tree.expect': return `Expect ${qt(a.path)} in ${d} to be ${String(a.state)}`;
    case 'tabs.select': return `Open the ${qt(a.tab)} tab in ${d}`;
    case 'tabs.expect': return `Expect the ${qt(a.tab)} tab in ${d} to be selected`;
    case 'accordion.expand': return `Expand the ${qt(a.section)} section in ${d}`;
    case 'accordion.collapse': return `Collapse the ${qt(a.section)} section in ${d}`;
    case 'dialog.click': return `In the ${a.dialog !== undefined ? qt(a.dialog) : 'top'} dialog, click ${qt(a.name)}`;
    case 'dialog.close': return `Close the ${a.dialog !== undefined ? qt(a.dialog) : 'top'} dialog`;
    case 'dialog.expectOpen': return `Expect the ${qt(a.dialog)} dialog to be open`;
    case 'dialog.expectClosed': return `Expect the ${qt(a.dialog)} dialog to be closed`;
    case 'dialog.expectCount': return `Expect ${String(a.count)} dialogs to be open`;
    case 'toast.watch': return 'Watch for toasts';
    case 'toast.expect': return `Expect a toast ${a.match === 'equals' ? 'saying' : 'containing'} ${qt(a.text)}`;
    case 'toast.expectNone': return `Expect no toast ${a.match === 'equals' ? 'saying' : 'containing'} ${qt(a.text)}`;
    case 'richtext.replace': return `Type ${qt(v)} in ${d}`;
    case 'richtext.append': return `Append ${qt(v)} to ${d}`;
    case 'richtext.clear': return `Clear ${d}`;
    case 'richtext.expect': return a.match === 'empty' ? `Expect ${d} to be empty` : `Expect ${d} ${a.match === 'equals' ? 'to be' : 'to contain'} ${qt(v)}`;
    case 'slider.set': return `Set ${d} to ${v}${a.upper !== undefined ? ` and ${String(a.upper)}` : ''}`;
    case 'slider.expect': return `Expect ${d} to be ${v}`;
    case 'masked.type': return `Type ${qt(v)} into ${d}`;
    case 'dropzone.drop': return `Drop ${(a.files as string[]).map((f) => qt(f)).join(', ')} onto ${d}`;
    case 'chart.expectPoints': return `Expect ${d}${a.series !== undefined ? ` series ${qt(a.series)}` : ''} to have ${String(a.count)} points`;
    case 'chart.expectValue': return `Expect ${d} value for ${qt(a.label)}${a.series !== undefined ? ` in series ${qt(a.series)}` : ''} to be ${qt(v)}`;
    case 'chart.capture': return `Capture the data of ${d} as ${s.captureAs}`;
    case 'list.capture': return `Capture all items of ${d}${a.max !== undefined ? ` up to ${String(a.max)}` : ''} as ${s.captureAs}`;
    case 'list.expectCount': return `Expect ${d} to have ${countText(a)} items in total`;
    default: throw new Error(`Step ${s.id}: no .ez phrasing for component ${String(a.widget)}.${String(a.op)}`);
  }
}
