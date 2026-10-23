/**
 * ARIA in HTML (W3C Recommendation), the author conformance requirements:
 * which explicit roles each HTML element may take, and which non-global
 * states and properties elements with no ARIA role may carry. Transcribed
 * from the specification's "Document conformance requirements" table.
 */

/** 'any' = any role; [] = no role attribute at all. Tags not listed (and custom elements) accept any role. */
export type AllowedRoles = string[] | 'any';

const LINKISH = ['button', 'checkbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'switch', 'tab', 'treeitem'];
const BUTTONISH = ['checkbox', 'combobox', 'gridcell', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'separator', 'slider', 'switch', 'tab', 'treeitem'];
const LISTISH = ['directory', 'group', 'listbox', 'menu', 'menubar', 'none', 'presentation', 'radiogroup', 'tablist', 'toolbar', 'tree'];
const NONE = ['none', 'presentation'];
const NO_ROLE: string[] = [];
const HEADING = ['none', 'presentation', 'tab'];
const MEDIA = ['application', 'document', 'img', 'image', 'none', 'presentation'];

const BY_TAG: Record<string, AllowedRoles> = {
  article: ['application', 'document', 'feed', 'main', 'none', 'presentation', 'region'],
  aside: ['feed', 'none', 'note', 'presentation', 'region', 'search'],
  audio: ['application'],
  video: ['application'],
  base: NO_ROLE, col: NO_ROLE, colgroup: NO_ROLE, datalist: NO_ROLE, head: NO_ROLE, html: NO_ROLE, link: NO_ROLE, main: NO_ROLE,
  map: NO_ROLE, meta: NO_ROLE, noscript: NO_ROLE, param: NO_ROLE, picture: NO_ROLE, script: NO_ROLE, slot: NO_ROLE, source: NO_ROLE,
  style: NO_ROLE, template: NO_ROLE, title: NO_ROLE, track: NO_ROLE, body: NO_ROLE, caption: NO_ROLE, details: NO_ROLE, summary: NO_ROLE,
  label: NO_ROLE, legend: NO_ROLE, optgroup: NO_ROLE, option: NO_ROLE, textarea: NO_ROLE, meter: NO_ROLE, progress: NO_ROLE,
  br: NONE, wbr: NONE, hr: NONE, dd: NONE,
  button: BUTTONISH,
  dialog: ['alertdialog'],
  dt: ['listitem'],
  dl: ['group', 'list', 'none', 'presentation'],
  embed: MEDIA,
  iframe: MEDIA,
  object: ['application', 'document', 'img', 'image'],
  fieldset: ['none', 'presentation', 'radiogroup'],
  figcaption: ['group', 'none', 'presentation'],
  footer: ['group', 'none', 'presentation'],
  header: ['group', 'none', 'presentation'],
  form: ['none', 'presentation', 'search'],
  h1: HEADING, h2: HEADING, h3: HEADING, h4: HEADING, h5: HEADING, h6: HEADING,
  li: ['menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'none', 'presentation', 'radio', 'separator', 'tab', 'treeitem'],
  nav: ['menu', 'menubar', 'none', 'presentation', 'tablist'],
  ol: LISTISH, ul: LISTISH, menu: LISTISH,
  section: ['alert', 'alertdialog', 'application', 'banner', 'complementary', 'contentinfo', 'dialog', 'document', 'feed', 'group', 'log', 'main', 'marquee', 'navigation', 'none', 'note', 'presentation', 'region', 'search', 'status', 'tabpanel'],
};

/** Roles an author may set on an element (some depend on its attributes). */
export function allowedRolesFor(el: Element, tag: string): AllowedRoles {
  switch (tag) {
    case 'a': return el.hasAttribute('href') ? LINKISH : 'any';
    case 'area': return el.hasAttribute('href') ? NO_ROLE : 'any';
    case 'img': {
      const alt = el.getAttribute('alt');
      if (alt === '') return NONE;
      if (alt === null) return 'any';
      return ['button', 'checkbox', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter', 'option', 'progressbar', 'radio', 'scrollbar', 'separator', 'slider', 'switch', 'tab', 'treeitem'];
    }
    case 'select': {
      const s = el as HTMLSelectElement;
      return s.multiple || s.size > 1 ? NO_ROLE : ['menu'];
    }
    case 'input': {
      const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
      const list = el.hasAttribute('list');
      switch (type) {
        case 'button': case 'submit': case 'reset': return BUTTONISH;
        case 'checkbox': return ['button', 'menuitemcheckbox', 'option', 'switch'];
        case 'radio': return ['menuitemradio'];
        case 'image': return ['link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'radio', 'switch'];
        case 'text': return list ? NO_ROLE : ['combobox', 'searchbox', 'spinbutton'];
        case 'search': case 'tel': case 'url': case 'email': return list ? NO_ROLE : ['combobox'];
        default: return NO_ROLE;
      }
    }
    default: return BY_TAG[tag] ?? 'any';
  }
}

const TEXTISH = ['aria-autocomplete', 'aria-readonly', 'aria-required', 'aria-placeholder', 'aria-activedescendant'];

/** Non-global states and properties ARIA in HTML allows on elements with no ARIA role (input types). */
export const NO_ROLE_ATTRS: Record<string, string[]> = {
  date: TEXTISH, 'datetime-local': TEXTISH, month: TEXTISH, week: TEXTISH, time: TEXTISH,
  color: ['aria-readonly', 'aria-required'],
  file: ['aria-required'],
  password: [...TEXTISH, 'aria-multiline'],
};
