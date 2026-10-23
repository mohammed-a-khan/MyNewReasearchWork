/**
 * ARIA roles: explicit (`role` attribute, first valid token, WAI-ARIA 1.2
 * §5.4 / §7.4 fallback) and implicit (HTML-AAM element mappings), with the
 * presentational-role conflict rules (WAI-ARIA 1.2 §9.1) and the
 * inheritance of `none`/`presentation` by required owned elements.
 */
import { composedParent, lowerTag, style } from './dom.js';

/** Concrete WAI-ARIA 1.2 roles (abstract roles are not valid in content), plus Graphics-ARIA and DPUB-ARIA. */
const ARIA_ROLES = new Set(
  (
    'alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox ' +
    'complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid ' +
    'gridcell group heading img image insertion link list listbox listitem log main marquee math menu menubar menuitem ' +
    'menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup ' +
    'region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript ' +
    'superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem ' +
    'graphics-document graphics-object graphics-symbol mark comment suggestion ' +
    'doc-abstract doc-acknowledgments doc-afterword doc-appendix doc-backlink doc-biblioentry doc-bibliography ' +
    'doc-biblioref doc-chapter doc-colophon doc-conclusion doc-cover doc-credit doc-credits doc-dedication doc-endnote ' +
    'doc-endnotes doc-epigraph doc-epilogue doc-errata doc-example doc-footnote doc-foreword doc-glossary doc-glossref ' +
    'doc-index doc-introduction doc-noteref doc-notice doc-pagebreak doc-pagefooter doc-pageheader doc-pagelist doc-part ' +
    'doc-preface doc-prologue doc-pullquote doc-qna doc-subtitle doc-tip doc-toc'
  ).split(' '),
);

/** Global states and properties (WAI-ARIA 1.2 §6.4) — their presence defeats role="none". */
const GLOBAL_ARIA = [
  'aria-atomic', 'aria-busy', 'aria-controls', 'aria-current', 'aria-describedby', 'aria-description', 'aria-details',
  'aria-disabled', 'aria-dropeffect', 'aria-errormessage', 'aria-flowto', 'aria-grabbed', 'aria-haspopup',
  'aria-invalid', 'aria-keyshortcuts', 'aria-label', 'aria-labelledby', 'aria-live', 'aria-owns', 'aria-relevant',
  'aria-roledescription',
];

export function hasGlobalAria(el: Element): boolean {
  for (const a of GLOBAL_ARIA) if (el.hasAttribute(a)) return true;
  return false;
}

/** Focusable per HTML: tabindex present, or a natively focusable control that is not disabled. */
export function isFocusable(el: Element): boolean {
  if (el.hasAttribute('tabindex') && !Number.isNaN(parseInt(el.getAttribute('tabindex') as string, 10))) return true;
  const tag = lowerTag(el);
  if ((tag === 'a' || tag === 'area') && el.hasAttribute('href')) return true;
  if (/^(button|input|select|textarea)$/.test(tag)) return !(el as HTMLButtonElement).disabled && !(tag === 'input' && (el as HTMLInputElement).type === 'hidden');
  if (tag === 'iframe' || tag === 'summary') return true;
  if ((el as HTMLElement).isContentEditable && (el as HTMLElement).contentEditable !== 'inherit') return true;
  return false;
}

/** First valid token of the role attribute (lower-cased), or null. `image` is the ARIA 1.3 synonym of `img`. */
export function explicitRole(el: Element): string | null {
  const v = el.getAttribute('role');
  if (!v) return null;
  for (const raw of v.trim().split(/\s+/)) {
    const t = raw.toLowerCase();
    if (ARIA_ROLES.has(t)) return t === 'image' ? 'img' : t;
  }
  return null;
}

function hasName(el: Element): boolean {
  if ((el.getAttribute('aria-label') || '').trim()) return true;
  const lb = el.getAttribute('aria-labelledby');
  if (lb) {
    const root = el.getRootNode() as Document;
    for (const id of lb.split(/\s+/)) if (id && root.getElementById?.(id)) return true;
  }
  return !!(el.getAttribute('title') || '').trim();
}

/** Sectioning content or sectioning root ancestors make header/footer/aside generic. */
function scopedToSectioning(el: Element): boolean {
  for (let p = composedParent(el); p; p = composedParent(p)) {
    const t = lowerTag(p);
    if (t === 'article' || t === 'aside' || t === 'main' || t === 'nav' || t === 'section') return true;
    const r = p.getAttribute('role');
    if (r && /^(article|complementary|main|navigation|region)$/.test(r.trim().split(/\s+/)[0])) return true;
    if (t === 'body') return false;
  }
  return false;
}

function closestTag(el: Element, tags: string[]): Element | null {
  for (let p = composedParent(el); p; p = composedParent(p)) if (tags.includes(lowerTag(p))) return p;
  return null;
}

/** The role of the table an element belongs to: 'table' | 'grid' | 'treegrid' | null (presentational). */
function tableRole(el: Element): string | null {
  const t = closestTag(el, ['table']);
  if (!t) return 'table';
  const r = getRole(t);
  if (r === 'grid' || r === 'treegrid') return r;
  if (r === 'none' || r === 'presentation') return null;
  return 'table';
}

function thRole(el: Element): string {
  const scope = (el.getAttribute('scope') || '').toLowerCase();
  if (scope === 'row' || scope === 'rowgroup') return 'rowheader';
  if (scope === 'col' || scope === 'colgroup') return 'columnheader';
  const row = el.parentElement;
  if (row && row.parentElement && lowerTag(row.parentElement) === 'thead') return 'columnheader';
  // A th in a row that also holds data cells heads that row.
  if (row) for (const c of Array.from(row.children)) if (lowerTag(c) === 'td') return 'rowheader';
  return 'columnheader';
}

const INPUT_ROLES: Record<string, string | null> = {
  button: 'button', image: 'button', reset: 'button', submit: 'button',
  checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
  color: null, date: null, 'datetime-local': null, month: null, time: null, week: null, file: null, hidden: null,
};

/** Implicit role from HTML-AAM, or null when the element has no corresponding role. */
export function implicitRole(el: Element): string | null {
  if (el.namespaceURI === 'http://www.w3.org/2000/svg') {
    const tag = lowerTag(el);
    if (tag === 'svg') return 'img';
    if (tag === 'a' && (el.hasAttribute('href') || el.hasAttribute('xlink:href'))) return 'link';
    return null;
  }
  const tag = lowerTag(el);
  switch (tag) {
    case 'a': return el.hasAttribute('href') ? 'link' : 'generic';
    case 'area': return el.hasAttribute('href') ? 'link' : null;
    case 'article': return 'article';
    case 'aside': return scopedToSectioning(el) && !hasName(el) ? 'generic' : 'complementary';
    case 'b': case 'bdi': case 'bdo': case 'body': case 'data': case 'div': case 'i': case 'pre': case 'q': case 'samp':
    case 'small': case 'span': case 'u': return 'generic';
    case 'blockquote': return 'blockquote';
    case 'button': return 'button';
    case 'caption': return 'caption';
    case 'code': return 'code';
    case 'datalist': return 'listbox';
    case 'del': case 's': return 'deletion';
    case 'details': return 'group';
    case 'dfn': case 'dt': return 'term';
    case 'dd': return 'definition';
    case 'dialog': return 'dialog';
    case 'em': return 'emphasis';
    case 'fieldset': case 'optgroup': case 'address': case 'hgroup': return 'group';
    case 'figure': return 'figure';
    case 'footer': return scopedToSectioning(el) ? 'generic' : 'contentinfo';
    case 'header': return scopedToSectioning(el) ? 'generic' : 'banner';
    case 'form': return hasName(el) ? 'form' : 'generic';
    case 'section': return hasName(el) ? 'region' : 'generic';
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
    case 'hr': return 'separator';
    case 'html': return 'document';
    case 'iframe': return null;
    case 'img': {
      const alt = el.getAttribute('alt');
      if (alt === '' && !hasName(el)) return 'presentation';
      return 'img';
    }
    case 'input': {
      const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
      const hasList = el.hasAttribute('list');
      if (type in INPUT_ROLES) return INPUT_ROLES[type];
      if (type === 'search') return hasList ? 'combobox' : 'searchbox';
      // text, email, tel, url, password and unknown types
      return hasList ? 'combobox' : 'textbox';
    }
    case 'ins': return 'insertion';
    case 'li': return 'listitem';
    case 'main': return 'main';
    case 'mark': return 'mark';
    case 'math': return 'math';
    case 'menu': case 'ol': case 'ul': return 'list';
    case 'meter': return 'meter';
    case 'nav': return 'navigation';
    case 'option': return 'option';
    case 'output': return 'status';
    case 'p': return 'paragraph';
    case 'progress': return 'progressbar';
    case 'search': return 'search';
    case 'select': {
      const s = el as HTMLSelectElement;
      return s.multiple || s.size > 1 ? 'listbox' : 'combobox';
    }
    case 'strong': return 'strong';
    case 'sub': return 'subscript';
    case 'sup': return 'superscript';
    case 'svg': return 'img';
    case 'table': return 'table';
    case 'tbody': case 'thead': case 'tfoot': return tableRole(el) ? 'rowgroup' : null;
    case 'tr': return tableRole(el) ? 'row' : null;
    case 'td': {
      const t = tableRole(el);
      return t === null ? null : t === 'table' ? 'cell' : 'gridcell';
    }
    case 'th': return tableRole(el) === null ? null : thRole(el);
    case 'textarea': return 'textbox';
    case 'time': return 'time';
    default: return null;
  }
}

/** Elements whose role is inherited as presentational when their required context is presentational. */
const REQUIRED_OWNED: Record<string, string[]> = {
  li: ['ul', 'ol', 'menu'],
  dt: ['dl'],
  dd: ['dl'],
  option: ['select', 'datalist'],
};

let roleCache: Map<Element, string | null> | null = null;
export function withRoleCache<T>(fn: () => T): T {
  if (roleCache) return fn();
  roleCache = new Map();
  try {
    return fn();
  } finally {
    roleCache = null;
  }
}

/**
 * The computed role: explicit if valid; `none`/`presentation` ignored for
 * focusable elements or elements with global ARIA attributes; children
 * required by a presentational list/table inherit `none`. Returns
 * 'presentation' or 'none' as authored for presentational elements.
 */
export function getRole(el: Element): string | null {
  if (roleCache) {
    const c = roleCache.get(el);
    if (c !== undefined) return c;
    const r = computeRole(el);
    roleCache.set(el, r);
    return r;
  }
  return computeRole(el);
}

function computeRole(el: Element): string | null {
  const explicit = explicitRole(el);
  if (explicit && explicit !== 'none' && explicit !== 'presentation') return explicit;
  const implicit = implicitRole(el);
  if (explicit) {
    // §9.1 Presentational role conflict resolution.
    if (isFocusable(el) || hasGlobalAria(el)) return implicit;
    return explicit;
  }
  if (implicit === 'presentation') return isFocusable(el) || hasGlobalAria(el) ? 'img' : 'presentation';
  const tag = lowerTag(el);
  const ctx = REQUIRED_OWNED[tag];
  if (ctx && implicit) {
    const parent = el.parentElement;
    if (parent && ctx.includes(lowerTag(parent))) {
      const pr = explicitRole(parent);
      if ((pr === 'none' || pr === 'presentation') && !isFocusable(parent) && !hasGlobalAria(parent)) return 'none';
    }
  }
  return implicit;
}

export function isPresentational(role: string | null): boolean {
  return role === 'none' || role === 'presentation';
}

/** Roles that may take their name from content (WAI-ARIA 1.2 §5.2.8.4 "name from: contents"). */
export const NAME_FROM_CONTENT = new Set([
  'button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading', 'link', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'radio', 'row', 'rowheader', 'switch', 'tab', 'tooltip', 'treeitem',
  'doc-backlink', 'doc-biblioref', 'doc-glossref', 'doc-noteref', 'comment', 'suggestion',
]);

/** Roles named from content only when they are part of another element's name (§4.3.2 2F). */
export const NAME_FROM_CONTENT_IN_RECURSION = new Set([
  'caption', 'code', 'deletion', 'emphasis', 'generic', 'insertion', 'mark', 'paragraph', 'strong', 'subscript',
  'superscript', 'term', 'time', 'definition', 'none', 'presentation', 'listitem', 'blockquote', 'group',
]);

/** Display value used to decide whether a child adds word separation in name-from-content. */
export function isInlineLevel(el: Element): boolean {
  const d = style(el).display;
  return d === 'inline' || d === 'contents' || d === '';
}

/**
 * Elements that may have each implicit role (the tags of the HTML-AAM
 * mapping in `implicitRole`). Role queries only compute roles for these and
 * for elements with a `role` attribute.
 */
const IMPLICIT_TAGS: Record<string, string> = {
  link: 'a,area',
  generic: 'a,b,bdi,bdo,body,data,div,i,pre,q,samp,small,span,u,aside,footer,header,form,section',
  article: 'article',
  complementary: 'aside',
  blockquote: 'blockquote',
  button: 'button,input',
  caption: 'caption',
  code: 'code',
  listbox: 'datalist,select',
  deletion: 'del,s',
  group: 'details,fieldset,optgroup,address,hgroup',
  term: 'dfn,dt',
  definition: 'dd',
  dialog: 'dialog',
  emphasis: 'em',
  figure: 'figure',
  contentinfo: 'footer',
  banner: 'header',
  form: 'form',
  region: 'section',
  heading: 'h1,h2,h3,h4,h5,h6',
  separator: 'hr',
  document: 'html',
  img: 'img,svg',
  presentation: 'img,li,dt,dd,option',
  none: 'img,li,dt,dd,option',
  checkbox: 'input',
  radio: 'input',
  slider: 'input',
  spinbutton: 'input',
  searchbox: 'input',
  textbox: 'input,textarea',
  combobox: 'input,select',
  insertion: 'ins',
  listitem: 'li',
  main: 'main',
  mark: 'mark',
  math: 'math',
  list: 'menu,ol,ul',
  meter: 'meter',
  navigation: 'nav',
  option: 'option',
  status: 'output',
  paragraph: 'p',
  progressbar: 'progress',
  search: 'search',
  strong: 'strong',
  subscript: 'sub',
  superscript: 'sup',
  table: 'table',
  rowgroup: 'tbody,thead,tfoot',
  row: 'tr',
  cell: 'td',
  gridcell: 'td',
  columnheader: 'th',
  rowheader: 'th',
  time: 'time',
};

/** CSS selector for every element that can have `role`. */
export function roleCandidates(role: string): string {
  const tags = IMPLICIT_TAGS[role];
  return tags ? `${tags},[role]` : '[role]';
}
