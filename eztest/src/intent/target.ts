/**
 * describeTarget: turns a human element description ("the Sign in button",
 * 'the "Username" field', "#login-btn", "testid=order-number") into a Target
 * with ordered locator candidates. The human description is always kept, so
 * healing and reports can still say what the element was meant to be.
 */
import type { LocatorCandidate, Target, TargetScope } from '../core/index.js';
import { isQuoted, literal, protectQuotes, restoreQuotes } from './quotes.js';

/** Element kinds a description can name, mapped to how they are located. */
export type TargetKind =
  | 'button' | 'link' | 'textbox' | 'combobox' | 'checkbox' | 'radio' | 'switch' | 'slider'
  | 'tab' | 'heading' | 'img' | 'table' | 'row' | 'cell' | 'option' | 'dialog' | 'message'
  | 'text' | 'menuitem' | 'menu' | 'region' | 'navigation' | 'list' | 'generic';

/** Kind words, longest phrases first so "radio button" wins over "button". */
const KIND_WORDS: Array<[string, TargetKind]> = [
  ['menu item', 'menuitem'], ['radio button', 'radio'], ['check box', 'checkbox'], ['text box', 'textbox'],
  ['text field', 'textbox'], ['text area', 'textbox'], ['input field', 'textbox'], ['input box', 'textbox'],
  ['drop-down', 'combobox'], ['drop down', 'combobox'], ['combo box', 'combobox'], ['list box', 'combobox'],
  ['checkbox', 'checkbox'], ['textbox', 'textbox'], ['textarea', 'textbox'], ['field', 'textbox'],
  ['input', 'textbox'], ['box', 'textbox'], ['dropdown', 'combobox'], ['select', 'combobox'],
  ['combobox', 'combobox'], ['picker', 'combobox'], ['button', 'button'], ['btn', 'button'],
  ['link', 'link'], ['tab', 'tab'], ['heading', 'heading'], ['header', 'heading'], ['title', 'heading'],
  ['image', 'img'], ['icon', 'img'], ['logo', 'img'], ['picture', 'img'], ['table', 'table'],
  ['grid', 'table'], ['row', 'row'], ['cell', 'cell'], ['option', 'option'], ['dialog', 'dialog'],
  ['modal', 'dialog'], ['popup', 'dialog'], ['message', 'message'], ['toast', 'message'],
  ['notification', 'message'], ['banner', 'message'], ['alert', 'message'], ['error', 'message'],
  ['text', 'text'], ['label', 'text'], ['switch', 'switch'], ['toggle', 'switch'], ['slider', 'slider'],
  ['menu', 'menu'], ['section', 'region'], ['region', 'region'], ['panel', 'region'],
  ['navigation', 'navigation'], ['nav', 'navigation'], ['list', 'list'], ['element', 'generic'],
  ['item', 'generic'],
];

/** Implied ARIA role for a kind (undefined for kinds located by text only). */
export const KIND_ROLE: Partial<Record<TargetKind, string>> = {
  button: 'button', link: 'link', textbox: 'textbox', combobox: 'combobox', checkbox: 'checkbox',
  radio: 'radio', switch: 'switch', slider: 'slider', tab: 'tab', heading: 'heading', img: 'img',
  table: 'table', row: 'row', cell: 'cell', option: 'option', dialog: 'dialog', menuitem: 'menuitem',
  menu: 'menu', region: 'region', navigation: 'navigation', list: 'list',
};

/** Text-entry controls of any input type, for unnamed fields ("the field below Email"). */
export const TEXT_ENTRY_CSS =
  'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]):not([type=file]):not([type=range]):not([type=color]), textarea, [contenteditable=""], [contenteditable="true"], [role=textbox], [role=searchbox], [role=spinbutton]';

/** Parsed form of a description, also used by the semantic healer. */
export interface DescribedTarget {
  kind: TargetKind;
  /** Accessible name / visible text the description refers to, if any. */
  name?: string;
}

function stripArticle(s: string): string {
  return s.replace(/^(?:the|a|an|that|this)\s+/i, '').trim();
}

/** Split a (quote-protected) description into kind and name. */
export function analyzeDescription(description: string): DescribedTarget {
  const { text, quotes } = protectQuotes(description.trim());
  let rest = stripArticle(text);
  // "<kind> with text/labelled/named X"
  const lower = rest.toLowerCase();
  for (const [word, kind] of KIND_WORDS) {
    if (lower.startsWith(word + ' ')) {
      const m = /^(?:with\s+(?:the\s+)?(?:text|label|name|caption)|labell?ed|named|called|titled|saying|reading)\s+(.+)$/i.exec(
        rest.slice(word.length + 1).trim(),
      );
      if (m) return { kind, name: literal(m[1], quotes) };
    }
  }
  for (const [word, kind] of KIND_WORDS) {
    // Plurals count too ("there are 3 "Edit" buttons").
    const re = new RegExp(`(?:^|\\s)${word.replace(/[-]/g, '\\-')}(e?s)?$`, 'i');
    const pm = re.exec(rest);
    // A bare plural ("the Options", "the Items") stays a name.
    if (pm && (!pm[1] || rest.length > word.length + pm[1].length)) {
      rest = rest.slice(0, rest.length - word.length - (pm[1]?.length ?? 0)).trim();
      const name = rest ? literal(stripArticle(rest), quotes) : undefined;
      return { kind, name: name || undefined };
    }
  }
  return { kind: 'generic', name: literal(rest, quotes) || undefined };
}

const role = (value: string, name?: string): LocatorCandidate =>
  name === undefined ? { strategy: 'role', value } : { strategy: 'role', value, name, exact: true };
const by = (strategy: LocatorCandidate['strategy'], value: string, exact = true): LocatorCandidate => ({
  strategy,
  value,
  exact,
});

/** Locator candidates for a kind + name, in preference order. */
export function candidatesFor(kind: TargetKind, name?: string): LocatorCandidate[] {
  const r = KIND_ROLE[kind];
  if (name === undefined) {
    // "the field below Email": any text-entry control (number, search and email inputs have other roles).
    if (kind === 'textbox') return [{ strategy: 'css', value: TEXT_ENTRY_CSS }];
    if (r) return [role(r)];
    throw new Error(`Cannot locate an unnamed ${kind}; add its text, label or a selector`);
  }
  switch (kind) {
    case 'button':
    case 'link':
    case 'tab':
    case 'heading':
    case 'option':
    case 'cell':
    case 'menuitem':
      return [role(r!, name), by('text', name)];
    case 'textbox':
      return [by('label', name), by('placeholder', name), role('textbox', name)];
    case 'combobox':
      return [by('label', name), role('combobox', name)];
    case 'checkbox':
    case 'radio':
    case 'switch':
    case 'slider':
      return [role(r!, name), by('label', name)];
    case 'img':
      return [role('img', name), by('altText', name)];
    case 'table':
      return [role('table', name), { strategy: 'css', value: `table[aria-label="${name.replace(/"/g, '\\"')}"]` }];
    case 'row':
      return [{ strategy: 'role', value: 'row', name, exact: false }, by('text', name, false)];
    case 'message':
      return [by('text', name, false), role('alert', name), role('status', name)];
    case 'text':
      return [by('text', name)];
    case 'region':
      return [role('region', name), { strategy: 'section', value: name, exact: true }];
    case 'dialog':
    case 'menu':
    case 'navigation':
    case 'list':
      return [role(r!, name)];
    case 'generic':
      return [by('text', name), by('label', name), by('placeholder', name), by('title', name)];
  }
}

/**
 * Build a Target from a human description. Selector passthroughs:
 * `#id`, `.class`, `tag[attr]`, `a > b`, `css=...`, `xpath=...`/`//...`,
 * `testid=foo`, `text=...`, `role=button[name="Save"]`.
 */
export function describeTarget(text: string): Target {
  const description = text.trim();
  if (!description) throw new Error('Empty target description');
  return describeScoped(description) ?? describePlain(description);
}

// ------------------------------------------------------------------ relative and scoped targets

/** Words that end a container description: `in the "Billing" section`, `in the Orders table`. */
const CONTAINER_WORDS = 'section|panel|region|card|group|form|fieldset|dialog|modal|popup|window|table|grid|list|toolbar|menu|navigation|sidebar|area|block|container|tab\\s*panel|pane';
const CONTAINER_RE = new RegExp(`^(?:the\\s+|a\\s+|an\\s+)?(.+?)\\s+(${CONTAINER_WORDS})$`, 'i');
const ROW_RE = /^(?:the\s+|a\s+)?(?:table\s+|grid\s+|list\s+)?(?:row|line|entry|item|record)\s+(?:containing|that\s+contains|which\s+contains|with|for|having|that\s+has|showing|that\s+shows)\s+(?:the\s+text\s+)?(.+)$/i;
const ROW_NAMED_RE = /^(?:the\s+)?(⟦\d+⟧)\s+(?:row|line|entry|record)$/i;
/** Relation keywords between a target and its anchor or container, matched on quote-protected text. */
const RELATION_RE = /\s(?:(?:to\s+the\s+|on\s+the\s+)?(right|left)\s+of|(?:directly\s+|just\s+|immediately\s+)?(below|under|underneath|beneath|above)|(near|next\s+to|beside|close\s+to)|within\s+(\d+(?:\.\d+)?)\s*(?:px|pixels?)\s+of|(inside|within)|(in|on))\s+/gi;

/** Candidates for a named container (`the "Billing" section`, `the Orders table`, `the "Edit" dialog`). */
function containerCandidates(name: string, word: string): LocatorCandidate[] {
  const w = word.toLowerCase().replace(/\s+/g, '');
  const sec: LocatorCandidate = { strategy: 'section', value: name, exact: true };
  switch (w) {
    case 'dialog': case 'modal': case 'popup': case 'window': return [role('dialog', name), role('alertdialog', name), sec];
    case 'table': case 'grid': return [role('table', name), role('grid', name), sec];
    case 'list': return [role('list', name), role('listbox', name), sec];
    case 'form': return [role('form', name), sec];
    case 'toolbar': case 'menu': case 'navigation': return [role(w, name), sec];
    case 'tabpanel': return [role('tabpanel', name), sec];
    case 'group': case 'fieldset': return [role('group', name), sec];
    default: return [role('region', name), sec];
  }
}

/** The container a scope phrase names, or undefined when it does not read as one. */
function containerTarget(rest: string, quotes: string[], loose: boolean): Target | undefined {
  const m = CONTAINER_RE.exec(rest);
  if (m) {
    const nameText = stripArticle(m[1]);
    // `in the "Billing" section`, `inside the Billing panel`; a selector stays a selector (`inside #billing`).
    if (!passthrough(restoreQuotes(nameText, quotes)) && !/\s(?:of|in|inside|within|below|above|near)\s/i.test(nameText)) {
      const name = literal(nameText, quotes);
      if (name) return { description: restoreQuotes(rest, quotes).trim(), locators: containerCandidates(name, m[2]) };
    }
  }
  if (!loose) return undefined;
  try {
    const t = describeTarget(restoreQuotes(rest, quotes));
    return t.locators.length || t.element ? t : undefined;
  } catch {
    return undefined;
  }
}

/** True when an anchor description names something (text, label, selector or repository element), not just a kind. */
function namedAnchor(t: Target, raw: string): boolean {
  if (t.element) return true;
  if (passthrough(raw.trim())) return true;
  const a = analyzeDescription(raw);
  return !!a.name || !!t.scope?.length;
}

/**
 * Split a description at its LAST relation keyword (`below "Email"`, `in the row
 * containing "Acme"`, `inside the "Billing" section`), so the outermost scope comes
 * first: `the field below "Email" inside the "Billing" section` looks for "Email" and
 * the field inside Billing. Returns undefined when no relation reads as one.
 */
function describeScoped(description: string): Target | undefined {
  const { text: prot, quotes } = protectQuotes(description);
  const matches = [...prot.matchAll(RELATION_RE)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const base = prot.slice(0, m.index).trim();
    const rest = prot.slice(m.index! + m[0].length).trim();
    if (!base || !rest || /^(?:the|a|an)$/i.test(base)) continue;
    let scope: TargetScope | undefined;
    if (m[1] || m[2] || m[3] || m[4]) {
      const relation: TargetScope['relation'] = m[1] ? (m[1].toLowerCase() === 'right' ? 'rightOf' : 'leftOf')
        : m[2] ? (/above/i.test(m[2]) ? 'above' : 'below') : 'near';
      const rawAnchor = restoreQuotes(rest, quotes);
      let anchor: Target;
      try {
        anchor = describeTarget(rawAnchor);
      } catch {
        continue;
      }
      if (!namedAnchor(anchor, rawAnchor)) continue;
      scope = { relation, anchor, ...(m[4] ? { maxDistance: Number(m[4]) } : {}) };
    } else {
      const word = (m[5] ?? m[6]).toLowerCase();
      const row = ROW_RE.exec(rest) ?? ROW_NAMED_RE.exec(rest);
      if (row) {
        const text = literal(row[1], quotes);
        if (!text) continue;
        scope = { relation: 'row', text };
      } else if (word !== 'on') {
        const container = containerTarget(rest, quotes, word !== 'in');
        if (!container) continue;
        scope = { relation: 'within', anchor: container };
      } else continue;
    }
    let inner: Target;
    try {
      inner = describeTarget(restoreQuotes(base, quotes));
    } catch {
      continue;
    }
    return { ...inner, description, scope: [scope, ...(inner.scope ?? [])] };
  }
  return undefined;
}

const ORDINAL_WORDS: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, sixth: 5, seventh: 6, eighth: 7, ninth: 8, tenth: 9, last: -1 };
const KIND_ALTERNATION = KIND_WORDS.map(([w]) => w.replace(/[-]/g, '\\-').replace(/\s+/g, '\\s+')).join('|');
const ORDINAL_RE = new RegExp(`^(?:the\\s+)?(?:(\\d+)(?:st|nd|rd|th)|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last))\\s+(.+)$`, 'i');
const KIND_START = new RegExp(`^(?:${KIND_ALTERNATION})\\b`, 'i');
/** A repository element reference: `@Checkout.placeOrder` (optionally inside a phrase: `the @Checkout.placeOrder button`). */
export const ELEMENT_REF_RE = /(?:^|\s)@([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)+)(?=$|\s)/;

function describePlain(description: string): Target {
  const { text: prot, quotes } = protectQuotes(description);
  const ref = ELEMENT_REF_RE.exec(prot);
  if (ref) {
    const rest = prot.replace(ref[0], ' ').replace(/\s+/g, ' ').trim();
    // Whatever else the phrase says is a kind word ("the @Checkout.placeOrder button"); the repository has the locators.
    if (/^(?:the\s+|a\s+|an\s+)?(?:[a-z][a-z -]*)?$/i.test(rest)) return { description, locators: [], element: ref[1] };
  }
  const ord = ORDINAL_RE.exec(prot);
  if (ord && !passthrough(description)) {
    const n = ord[1] !== undefined ? Number(ord[1]) - 1 : ORDINAL_WORDS[ord[2].toLowerCase()];
    // Word ordinals only before a quoted name or a kind word: "the first name field" stays the "first name" field.
    if (n >= -1 && (ord[1] !== undefined || /^⟦\d+⟧/.test(ord[3]) || KIND_START.test(ord[3]))) {
      const inner = describePlain(`the ${restoreQuotes(ord[3], quotes)}`);
      if (inner.locators.length || inner.element) return { ...inner, description, nth: n };
    }
  }
  return describeLocators(description);
}

function describeLocators(description: string): Target {
  const pass = passthrough(description);
  if (pass) return { description, locators: [pass] };

  const { text: prot, quotes } = protectQuotes(description);
  // `the "Search" button at xpath=//input[@value='Search'] or css=input.search`: a described
  // element with exact, ordered locator candidates (imported page objects keep their selectors).
  const at = new RegExp(`^(.*?\\S)\\s+(?:at|located\\s+by)\\s+(${SELECTOR_START}.*)$`, 'i').exec(prot);
  if (at) {
    const parts = at[2].split(new RegExp(`\\s+or\\s+(?:at\\s+)?(?=${SELECTOR_START})`, 'i'));
    const locators = parts.map((p) => passthrough(restoreQuotes(p, quotes).trim()));
    if (locators.every((l): l is LocatorCandidate => !!l)) {
      return { description: restoreQuotes(at[1], quotes).trim(), locators };
    }
  }
  const stripped = stripArticle(prot);
  // "element with id foo" / "element with test id foo"
  const idm = /^(?:element|item|\w+)\s+with\s+(?:the\s+)?(test\s*id|data-testid|id)\s+(.+)$/i.exec(stripped);
  if (idm) {
    const v = literal(idm[2], quotes);
    return {
      description,
      locators: [/test/i.test(idm[1]) ? { strategy: 'testId', value: v } : { strategy: 'css', value: `#${cssEscapeId(v)}` }],
    };
  }
  if (isQuoted(stripped)) {
    const name = literal(stripped, quotes);
    return { description, locators: candidatesFor('generic', name) };
  }
  const { kind, name } = analyzeDescription(description);
  return { description, locators: candidatesFor(kind, name) };
}

/** Start of an explicit selector in a multi-candidate target (`xpath=`, `css=`, `text=`, `testid=`, `role=`). */
const SELECTOR_START = '(?:xpath|css|text|testid|test-id|data-testid|role|accessibility\\s*id|aid|id|class|predicate)\\s*=';

function cssEscapeId(id: string): string {
  return id.replace(/([^\w-])/g, '\\$1');
}

/** Native-app selectors: `accessibility id=login` (or `~login`), `id=...`, `class=...`, `predicate=...` (iOS). */
function nativePassthrough(d: string): LocatorCandidate | undefined {
  let m: RegExpExecArray | null;
  if ((m = /^(?:accessibility\s*id|aid)\s*=\s*(.+)$/i.exec(d))) return { strategy: 'accessibilityId', value: unquote(m[1]) };
  if ((m = /^~(\S.*)$/.exec(d))) return { strategy: 'accessibilityId', value: m[1].trim() };
  if ((m = /^id\s*=\s*(.+)$/i.exec(d))) return { strategy: 'id', value: unquote(m[1]) };
  if ((m = /^class\s*=\s*(.+)$/i.exec(d))) return { strategy: 'className', value: unquote(m[1]) };
  if ((m = /^predicate\s*=\s*(.+)$/i.exec(d))) return { strategy: 'iosPredicate', value: m[1].trim() };
  return undefined;
}

function unquote(v: string): string {
  const t = v.trim();
  return /^(["']).*\1$/.test(t) && t.length >= 2 ? t.slice(1, -1) : t;
}

function passthrough(d: string): LocatorCandidate | undefined {
  let m: RegExpExecArray | null;
  const native = nativePassthrough(d);
  if (native) return native;
  if ((m = /^css\s*=\s*(.+)$/i.exec(d))) return { strategy: 'css', value: m[1].trim() };
  if ((m = /^xpath\s*=\s*(.+)$/i.exec(d))) return { strategy: 'xpath', value: m[1].trim() };
  if (/^\(?\/\//.test(d)) return { strategy: 'xpath', value: d };
  if ((m = /^(?:testid|test-id|data-testid)\s*[=:]\s*["']?([^"']+)["']?$/i.exec(d))) return { strategy: 'testId', value: m[1].trim() };
  if ((m = /^text\s*=\s*["']?(.+?)["']?$/i.exec(d))) return { strategy: 'text', value: m[1], exact: true };
  if ((m = /^role\s*=\s*([a-z]+)(?:\s*\[\s*name\s*=\s*["'](.+)["']\s*\])?$/i.exec(d)))
    return m[2] ? { strategy: 'role', value: m[1], name: m[2], exact: true } : { strategy: 'role', value: m[1] };
  if (/^[#.[]/.test(d)) return { strategy: 'css', value: d };
  if (/^[a-z][a-z0-9-]*[#.[]\S*(?:\s*[>+~]?\s*[a-z#.[*]\S*)*$/i.test(d)) return { strategy: 'css', value: d };
  if (/^[a-z][a-z0-9-]*(?:\s*>\s*[a-z#.[]\S*)+$/i.test(d)) return { strategy: 'css', value: d };
  return undefined;
}
