/**
 * The in-page half of the recorder. It is plain JavaScript source (not a
 * serialized TypeScript function) so that no build tool can inject helpers
 * into it, and it is installed with `addInitScript` so it runs in every
 * document and frame, before page scripts.
 *
 * It does two things:
 *  - `info(el)`: computes everything needed to describe an element robustly
 *    (role, approximate accessible name, associated label, data-testid, id,
 *    a unique CSS path) plus uniqueness counts measured on the live page.
 *  - listens (capture phase) to user events and forwards them to Node through
 *    the exposed binding. Password values never leave the page: for a
 *    password field only the fact that it was typed into is reported.
 */

/** Uniqueness counts measured in the page for the strings that would locate an element. */
export interface ElementCounts {
  /** Visible elements with the same role and exact accessible name. */
  roleName: number;
  /** Elements whose label (aria-labelledby, aria-label or <label>) equals this element's label. */
  label: number;
  /** Elements with the same placeholder. */
  placeholder: number;
  /** Elements whose label equals this element's placeholder (would shadow a placeholder lookup). */
  placeholderAsLabel: number;
  /** Elements whose own normalized text equals this element's text. */
  text: number;
  /** Elements with the same data-testid. */
  testId: number;
  /** Elements with the same id. */
  id: number;
}

/** What the page reports about one element. */
export interface ElementInfo {
  /** Stable key for this element within its document (used to coalesce typing). */
  key: string;
  tag: string;
  type?: string;
  role?: string;
  /** Approximate ARIA accessible name. */
  name?: string;
  /** Associated label text (what getByLabel matches). */
  label?: string;
  placeholder?: string;
  /** Normalized visible text (truncated). */
  text?: string;
  testId?: string;
  id?: string;
  title?: string;
  alt?: string;
  href?: string;
  nameAttr?: string;
  classes: string[];
  /** A CSS selector that is unique on the page at record time. */
  css: string;
  /** True for text-entry controls (input/textarea, not buttons/checkboxes). */
  field: boolean;
  /** True for password inputs: their value is never reported. */
  secret: boolean;
  /** For custom role=checkbox/switch elements: aria-checked before the click. */
  ariaChecked?: string;
  box?: { x: number; y: number; width: number; height: number };
  counts: ElementCounts;
  /**
   * For a name that repeats (an Edit button per row): a text of the element's row
   * that picks it out (`in the row containing "<rowText>"`), measured on the page.
   */
  rowText?: string;
  /** 1-based position among elements with the same text, when the text is not unique. */
  textNth?: number;
  /** With rowText: the container (`#table1`) the row is looked up in, when the text repeats in another one. */
  rowWithin?: string;
  /** A named landmark around the element in which its name is unique (`the "Main" navigation`). */
  landmark?: { role: string; name: string; word: string };
  /** 1-based position among the visible elements with the same role and name, when the name is not unique. */
  roleNth?: number;
  /** For an unnamed checkbox or radio button: its 1-based position among the visible ones. */
  kindNth?: number;
  /** A contenteditable host (a rich-text editor): its text is what was typed. */
  editable?: boolean;
}

/** Events the page sends to Node. */
export type PageEvent =
  | { kind: 'click'; el: ElementInfo; button?: 'left' | 'right'; t: number; url: string }
  | { kind: 'dblclick'; el: ElementInfo; t: number; url: string }
  | { kind: 'fill'; el: ElementInfo; value?: string; secret: boolean; t: number; url: string }
  | { kind: 'select'; el: ElementInfo; labels: string[]; t: number; url: string }
  | { kind: 'check' | 'uncheck'; el: ElementInfo; t: number; url: string }
  | { kind: 'press'; el?: ElementInfo; key: string; t: number; url: string }
  | { kind: 'upload'; el: ElementInfo; files: string[]; t: number; url: string }
  /** The element a later click needs hovered first (a menu or overlay shown by :hover or a mouseenter handler). */
  | { kind: 'hover'; el: ElementInfo; t: number; url: string }
  /** The page is closing its own window (window.close()), so no "Close the tab" step is needed. */
  | { kind: 'closing'; t: number; url: string }
  /** A drag from `el` to `to` (HTML5 drag and drop, or a mouse drag), described as both were before it. */
  | { kind: 'drag'; el: ElementInfo; to: ElementInfo; t: number; url: string }
  | { kind: 'assert'; el: ElementInfo; text?: string; value?: string; t: number; url: string };

/**
 * Source of `function (BINDING) { ... }`. Called with the binding name (or
 * null to install only the inspection helpers, without listeners).
 */
export const PAGE_SCRIPT_SOURCE = String.raw`function (BINDING) {
  var W = window;
  var R = W.__ezRecorder;
  if (!R) {
    R = { binding: null, listening: false };
    try { Object.defineProperty(W, '__ezRecorder', { value: R, enumerable: false, configurable: true, writable: true }); }
    catch (e) { W.__ezRecorder = R; }
    var docId = Math.random().toString(36).slice(2, 10);
    var keys = new WeakMap();
    var seq = 0;
    var keyOf = function (el) {
      var k = keys.get(el);
      if (!k) { seq += 1; k = docId + ':' + seq; keys.set(el, k); }
      return k;
    };
    // Icon-font glyphs (Private Use Area characters) are not words: the runner ignores them in names and text too.
    var norm = function (s) { return String(s == null ? '' : s).replace(/[\uE000-\uF8FF]|[\uDB80-\uDBFF][\uDC00-\uDFFF]/g, '').replace(/\s+/g, ' ').trim(); };
    var lower = function (el) { return el.tagName ? el.tagName.toLowerCase() : ''; };
    // Open shadow roots are searched as well: the runner's role, label, text and CSS locators pierce them.
    var rootsCache = null;
    var shadowRoots = function () {
      if (rootsCache) return rootsCache;
      var out = [];
      var walk = function (root) {
        var all = root.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          var sr = all[i].shadowRoot;
          if (sr) { out.push(sr); walk(sr); }
        }
      };
      walk(document);
      return out;
    };
    var deepAll = function (sel, base) {
      var out = Array.prototype.slice.call((base || document).querySelectorAll(sel));
      var roots = shadowRoots();
      for (var i = 0; i < roots.length; i++) {
        if (base && base !== document && !(base.contains(roots[i].host) || base === roots[i].host)) continue;
        out = out.concat(Array.prototype.slice.call(roots[i].querySelectorAll(sel)));
      }
      return out;
    };
    var treeOf = function (el) { var r = el.getRootNode ? el.getRootNode() : document; return r && r.getElementById ? r : document; };
    var inShadow = function (el) { return !!(el.getRootNode && el.getRootNode() !== document && el.getRootNode().host); };
    var inputType = function (el) { return (el.getAttribute('type') || 'text').toLowerCase(); };
    var BUTTON_TYPES = { button: 1, submit: 1, reset: 1, image: 1 };
    var NON_FIELD_TYPES = { button: 1, submit: 1, reset: 1, image: 1, checkbox: 1, radio: 1, file: 1, hidden: 1 };
    var isField = function (el) {
      if (!el || !el.tagName) return false;
      var t = lower(el);
      if (t === 'textarea') return true;
      if (t === 'input') return !NON_FIELD_TYPES[inputType(el)];
      return false;
    };
    var isHidden = function (el) {
      for (var e = el; e && e.nodeType === 1; e = e.parentElement) {
        if (e.getAttribute('aria-hidden') === 'true') return true;
      }
      if (typeof el.checkVisibility === 'function') {
        if (lower(el) === 'option') return false;
        return !el.checkVisibility({ visibilityProperty: true });
      }
      var cs = getComputedStyle(el);
      return cs.visibility === 'hidden' || el.getClientRects().length === 0;
    };
    var roleOf = function (el) {
      var explicit = norm(el.getAttribute('role')).split(' ')[0];
      if (explicit) return explicit;
      var t = lower(el);
      switch (t) {
        case 'a': case 'area': return el.hasAttribute('href') ? 'link' : '';
        case 'button': case 'summary': return 'button';
        case 'select': return (el.multiple || el.size > 1) ? 'listbox' : 'combobox';
        case 'textarea': return 'textbox';
        case 'option': return 'option';
        case 'img': return el.getAttribute('alt') === '' ? 'presentation' : 'img';
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
        case 'nav': return 'navigation';
        case 'section': return (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) ? 'region' : '';
        case 'form': return (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') || el.hasAttribute('title')) ? 'form' : '';
        case 'main': return 'main';
        case 'table': return 'table';
        case 'tr': return 'row';
        case 'td': return 'cell';
        case 'th': return 'columnheader';
        case 'ul': case 'ol': return 'list';
        case 'li': return 'listitem';
        case 'dialog': return 'dialog';
        case 'input': {
          var ty = inputType(el);
          if (BUTTON_TYPES[ty]) return 'button';
          if (ty === 'checkbox') return 'checkbox';
          if (ty === 'radio') return 'radio';
          if (ty === 'range') return 'slider';
          if (ty === 'number') return 'spinbutton';
          if (ty === 'search') return el.hasAttribute('list') ? 'combobox' : 'searchbox';
          if (ty === 'text' || ty === 'email' || ty === 'tel' || ty === 'url' || ty === 'password' || ty === '') {
            return el.hasAttribute('list') ? 'combobox' : 'textbox';
          }
          return '';
        }
      }
      return '';
    };
    var textOf = function (node, skipControls) {
      var out = '';
      var kids = node.childNodes;
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (c.nodeType === 3) { out += c.nodeValue; continue; }
        if (c.nodeType !== 1) continue;
        var t = lower(c);
        if (t === 'script' || t === 'style' || t === 'template' || t === 'noscript') continue;
        if (c.getAttribute('aria-hidden') === 'true') continue;
        if (skipControls && (t === 'select' || t === 'textarea' || t === 'input' || t === 'button')) continue;
        if (t === 'img') { out += ' ' + (c.getAttribute('alt') || '') + ' '; continue; }
        var cs = getComputedStyle(c);
        if (cs.display === 'none') continue;
        var inner = textOf(c, skipControls);
        out += (cs.display.indexOf('inline') === 0) ? inner : ' ' + inner + ' ';
      }
      return out;
    };
    var idsText = function (ids, from) {
      var parts = [];
      var tree = from ? treeOf(from) : document;
      norm(ids).split(' ').forEach(function (id) {
        var e = id && tree.getElementById(id);
        if (e) parts.push(norm(textOf(e, false)));
      });
      return norm(parts.join(' '));
    };
    var labelsList = function (el) {
      var out = [];
      var lb = el.getAttribute('aria-labelledby');
      if (lb) { var t = idsText(lb, el); if (t) out.push(t); }
      var al = norm(el.getAttribute('aria-label'));
      if (al) out.push(al);
      if (el.labels) {
        for (var i = 0; i < el.labels.length; i++) {
          var lt = norm(textOf(el.labels[i], true));
          if (lt) out.push(lt);
        }
      }
      var wrap = brokenLabel(el);
      if (wrap) { var wt = norm(textOf(wrap, true)); if (wt) out.push(wt); }
      if (!out.length) { var seen = visualLabel(el); if (seen) out.push(seen); }
      return out;
    };
    // A <label for="x"> around a control without that id: HTML gives it no label, the runner's getByLabel reads it.
    var brokenLabel = function (el) {
      if (!el.tagName || (el.labels && el.labels.length)) return null;
      var t = lower(el);
      if (t !== 'input' && t !== 'select' && t !== 'textarea') return null;
      var l = el.parentElement && el.parentElement.closest ? el.parentElement.closest('label') : null;
      if (!l) return null;
      var f = l.getAttribute('for');
      if (!f || treeOf(el).getElementById(f)) return null;
      return l.querySelectorAll('input,select,textarea').length === 1 ? l : null;
    };
    // The words a person reads as a field's label when there is no <label> (the runner's getByLabel reads them too):
    // the table cell before the field's cell ("First Name:"), or the text right before the field.
    var LABELLABLE = { input: 1, select: 1, textarea: 1 };
    var controlsText = function (el) {
      var s = '';
      for (var c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) s += c.data;
        else if (c.nodeType === 1 && !LABELLABLE[lower(c)] && lower(c) !== 'button' && lower(c) !== 'script' && lower(c) !== 'style') s += controlsText(c);
      }
      return s;
    };
    var visualLabel = function (el) {
      var t = lower(el);
      if (!LABELLABLE[t]) return '';
      if (t === 'input' && /^(hidden|submit|button|reset|image)$/.test(inputType(el))) return '';
      if (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') || (el.labels && el.labels.length)) return '';
      var clean = function (s) { return norm(s).replace(/^[*\s]+/, '').replace(/[\s:*]+$/, ''); };
      var cell = el.parentElement && el.parentElement.closest ? el.parentElement.closest('td,th') : null;
      if (cell && !clean(controlsText(cell)) && cell.querySelectorAll('input,select,textarea').length === 1) {
        for (var prev = cell.previousElementSibling; prev; prev = prev.previousElementSibling) {
          if (prev.querySelector('input,select,textarea')) return '';
          var pt = clean(controlsText(prev));
          if (pt) return pt.length <= 60 ? pt : '';
        }
        return '';
      }
      var box = t === 'input' && (inputType(el) === 'checkbox' || inputType(el) === 'radio');
      for (var n = box ? el.nextSibling : el.previousSibling; n; n = box ? n.nextSibling : n.previousSibling) {
        if (n.nodeType === 1) {
          if (LABELLABLE[lower(n)] || n.querySelector('input,select,textarea')) return '';
          if (lower(n) === 'br') { if (box) return ''; continue; }
        }
        var nt = clean(n.nodeType === 3 ? n.data : n.nodeType === 1 ? controlsText(n) : '');
        if (nt) return nt.length <= 60 ? nt : '';
      }
      return '';
    };
    var labelOf = function (el) { var l = labelsList(el); return l.length ? l[0] : ''; };
    var NAME_FROM_CONTENT = { button: 1, link: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, option: 1,
      heading: 1, cell: 1, columnheader: 1, rowheader: 1, checkbox: 1, radio: 1, switch: 1, treeitem: 1, tooltip: 1, row: 1 };
    var nameOf = function (el, role) {
      var lb = el.getAttribute('aria-labelledby');
      if (lb) { var t = idsText(lb, el); if (t) return t; }
      var al = norm(el.getAttribute('aria-label'));
      if (al) return al;
      var tag = lower(el);
      if (tag === 'input') {
        var ty = inputType(el);
        if (ty === 'button' || ty === 'submit' || ty === 'reset') {
          return norm(el.value) || (ty === 'submit' ? 'Submit' : ty === 'reset' ? 'Reset' : '');
        }
        if (ty === 'image') return norm(el.getAttribute('alt')) || norm(el.getAttribute('title')) || 'Submit';
      }
      if (tag === 'input' || tag === 'select' || tag === 'textarea') {
        var labs = [];
        if (el.labels) for (var i = 0; i < el.labels.length; i++) labs.push(norm(textOf(el.labels[i], true)));
        var l = norm(labs.join(' '));
        if (l) return l;
        return norm(el.getAttribute('title')) || norm(el.getAttribute('placeholder'));
      }
      if (tag === 'img') return norm(el.getAttribute('alt')) || norm(el.getAttribute('title'));
      if (role && NAME_FROM_CONTENT[role]) { var c = norm(textOf(el, false)); if (c) return c; }
      if (tag === 'table') { var cap = el.querySelector('caption'); if (cap) return norm(cap.textContent); }
      if (tag === 'fieldset') { var lg = el.querySelector('legend'); if (lg) return norm(lg.textContent); }
      return norm(el.getAttribute('title'));
    };
    var ROLE_QUERY = {
      button: 'button,summary,input[type=submit],input[type=button],input[type=reset],input[type=image],[role=button]',
      link: 'a[href],area[href],[role=link]',
      checkbox: 'input[type=checkbox],[role=checkbox]',
      radio: 'input[type=radio],[role=radio]',
      textbox: 'input,textarea,[role=textbox]',
      searchbox: 'input,[role=searchbox]',
      spinbutton: 'input,[role=spinbutton]',
      combobox: 'select,input,[role=combobox]',
      listbox: 'select,[role=listbox]',
      heading: 'h1,h2,h3,h4,h5,h6,[role=heading]',
      img: 'img,[role=img]',
      option: 'option,[role=option]',
      slider: 'input[type=range],[role=slider]',
      cell: 'td,[role=cell]',
      navigation: 'nav,[role=navigation]',
      region: 'section,[role=region]',
      form: 'form,[role=form]',
      dialog: 'dialog,[role=dialog]',
      alertdialog: '[role=alertdialog]'
    };
    var countRoleName = function (role, name) {
      var q = ROLE_QUERY[role] || ('[role="' + role + '"]');
      var n = 0;
      var all = deepAll(q);
      for (var i = 0; i < all.length; i++) {
        var e = all[i];
        if (roleOf(e) !== role || isHidden(e)) continue;
        if (nameOf(e, role) === name) n++;
      }
      return n;
    };
    // 1-based position of el among the visible elements with this role and name (what "the 2nd ... button" picks).
    var roleNth = function (el, role, name) {
      var q = ROLE_QUERY[role] || ('[role="' + role + '"]');
      var all = deepAll(q), n = 0;
      for (var i = 0; i < all.length; i++) {
        var e = all[i];
        if (roleOf(e) !== role || isHidden(e)) continue;
        if (name !== null && nameOf(e, role) !== name) continue;
        n++;
        if (e === el) return n;
      }
      return 0;
    };
    var countLabel = function (text) {
      if (!text) return 0;
      var n = 0;
      var all = deepAll('input,select,textarea,button,meter,output,progress,[aria-label],[aria-labelledby]');
      for (var i = 0; i < all.length; i++) {
        var e = all[i];
        if (lower(e) === 'input' && inputType(e) === 'hidden') continue;
        if (labelsList(e).indexOf(text) >= 0) n++;
      }
      return n;
    };
    var countAttr = function (attr, value) {
      if (!value) return 0;
      var n = 0;
      var all = deepAll('[' + attr + ']');
      for (var i = 0; i < all.length; i++) if (all[i].getAttribute(attr) === value) n++;
      return n;
    };
    // The text engine of the runner, in miniature: the rendered (flat-tree) text of each element, shadow trees and
    // slots included, and only the innermost elements whose whole text is the given text, in shadow-including order.
    var NO_TEXT_TAGS = { script: 1, style: 1, template: 1, noscript: 1, head: 1 };
    var flatText = function (el, cache) {
      var c = cache.get(el);
      if (c !== undefined) return c;
      var tag = lower(el), s = '';
      if (NO_TEXT_TAGS[tag]) s = '';
      else if (tag === 'input' && /^(button|submit|reset)$/i.test(el.type || '')) s = el.value;
      else {
        var kids = el.shadowRoot ? el.shadowRoot.childNodes : null;
        if (!kids && tag === 'slot' && el.assignedNodes && el.assignedNodes().length) kids = el.assignedNodes();
        if (!kids) kids = el.childNodes;
        for (var i = 0; i < kids.length; i++) {
          var k = kids[i];
          if (k.nodeType === 3) s += k.data;
          else if (k.nodeType === 1) s += flatText(k, cache);
        }
      }
      cache.set(el, s);
      return s;
    };
    var deepOrder = function (root, out) {
      for (var c = root.firstElementChild; c; c = c.nextElementSibling) {
        out.push(c);
        if (c.shadowRoot) deepOrder(c.shadowRoot, out);
        deepOrder(c, out);
      }
      return out;
    };
    var renderedParent = function (el) {
      if (el.assignedSlot) return el.assignedSlot;
      var p = el.parentNode;
      if (!p) return null;
      if (p.nodeType === 11) return p.host || null;
      return p.nodeType === 1 && !p.shadowRoot ? p : null;
    };
    var containsFlat = function (anc, node) {
      for (var n = node; n; ) {
        if (n === anc) return true;
        if (n.assignedSlot) { n = n.assignedSlot; continue; }
        var p = n.parentNode;
        n = p && p.nodeType === 11 ? p.host : p;
      }
      return false;
    };
    var textHits = function (text) {
      if (!text || !document.body) return [];
      var all = deepOrder(document, []);
      var cache = new Map(), covered = new Set(), hits = [];
      for (var i = all.length - 1; i >= 0; i--) {
        var e = all[i], hit = false;
        if (covered.has(e)) hit = true;
        else if (!NO_TEXT_TAGS[lower(e)]) {
          var raw = flatText(e, cache);
          if (raw.length >= text.length && norm(raw) === text) { hits.push(e); hit = true; }
        }
        if (hit) { var rp = renderedParent(e); if (rp) covered.add(rp); }
      }
      return hits.reverse();
    };
    var countText = function (text) { return textHits(text).length; };
    // The test-id attributes a testid= target matches (the runner looks for all of them).
    var TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];
    var TEST_ID_SEL = '[data-testid],[data-test-id],[data-test],[data-qa],[data-cy]';
    var testIdAttr = function (el) {
      for (var i = 0; i < TEST_ID_ATTRS.length; i++) if (el.hasAttribute(TEST_ID_ATTRS[i])) return TEST_ID_ATTRS[i];
      return '';
    };
    var countTestId = function (v) {
      var n = 0;
      for (var i = 0; i < TEST_ID_ATTRS.length; i++) n += countAttr(TEST_ID_ATTRS[i], v);
      return n;
    };
    var safeAttr = function (v) { return typeof v === 'string' && v.length > 0 && v.length <= 120 && !/["'\x60\\“”\n\r]/.test(v); };
    var attrSel = function (name, v) { return '[' + name + '="' + v + '"]'; };
    var cssId = function (id) { return (W.CSS && W.CSS.escape) ? W.CSS.escape(id) : id.replace(/([^\w-])/g, '\\$1'); };
    var uniqueSel = function (sel, el) {
      try { var m = deepAll(sel); return m.length === 1 && m[0] === el; } catch (e) { return false; }
    };
    var classesOf = function (el) {
      var out = [];
      if (!el.classList) return out;
      for (var i = 0; i < el.classList.length && out.length < 5; i++) {
        var c = el.classList[i];
        if (/^[A-Za-z_-][\w-]*$/.test(c) && !/\d{3,}/.test(c)) out.push(c);
      }
      return out;
    };
    var baseSel = function (el) {
      var tag = lower(el);
      if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return tag + '#' + el.id;
      var ta = testIdAttr(el);
      if (ta && safeAttr(el.getAttribute(ta))) return tag + attrSel(ta, el.getAttribute(ta));
      var attrs = ['name', 'aria-label', 'href', 'for', 'placeholder', 'title', 'type', 'role'];
      for (var i = 0; i < attrs.length; i++) {
        var v = el.getAttribute(attrs[i]);
        if (safeAttr(v)) return tag + attrSel(attrs[i], v);
      }
      var cls = classesOf(el);
      return cls.length ? tag + '.' + cls.slice(0, 2).join('.') : tag;
    };
    var ancSel = function (a) {
      var tag = lower(a);
      if (a.id && /^[A-Za-z][\w-]*$/.test(a.id)) return '#' + a.id;
      var al = a.getAttribute('aria-label');
      if (safeAttr(al)) return tag + attrSel('aria-label', al);
      var tb = testIdAttr(a);
      if (tb && safeAttr(a.getAttribute(tb))) return tag + attrSel(tb, a.getAttribute(tb));
      var cls = classesOf(a);
      return cls.length ? tag + '.' + cls[0] : tag;
    };
    // A path inside el's own tree (the document or one shadow root).
    var treePath = function (el) {
      var base = baseSel(el);
      if (uniqueSel(base, el)) return base;
      for (var a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        var s = ancSel(a) + ' ' + base;
        if (uniqueSel(s, el)) return s;
      }
      var parts = [];
      for (var e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
        if (e !== el && e.id && /^[A-Za-z][\w-]*$/.test(e.id) && uniqueSel('#' + e.id, e)) { parts.unshift('#' + e.id); break; }
        var idx = 1;
        for (var sib = e.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === e.tagName) idx++;
        parts.unshift(lower(e) + ':nth-of-type(' + idx + ')');
      }
      return parts.join(' > ');
    };
    // Matches of a chain "a >> css=b >> css=c": each step searched inside the previous matches (and their shadow roots).
    var chainAll = function (sels) {
      var cur = deepAll(sels[0]);
      for (var i = 1; i < sels.length; i++) {
        var next = [];
        for (var j = 0; j < cur.length; j++) {
          var inner = deepAll(sels[i], cur[j]);
          if (cur[j].shadowRoot) inner = inner.concat(Array.prototype.slice.call(cur[j].shadowRoot.querySelectorAll(sels[i])));
          for (var k = 0; k < inner.length; k++) if (next.indexOf(inner[k]) < 0) next.push(inner[k]);
        }
        cur = next;
      }
      return cur;
    };
    // A unique CSS selector; inside a shadow root the host's path is chained in front ("my-card >> css=button.save").
    var cssPath = function (el) {
      var own = treePath(el);
      if (!inShadow(el) || uniqueSel(own, el)) return own;
      var sels = [own];
      for (var host = el.getRootNode().host; host; host = inShadow(host) ? host.getRootNode().host : null) {
        sels.unshift(treePath(host));
        var m;
        try { m = chainAll(sels); } catch (e) { m = []; }
        if (m.length === 1 && m[0] === el) return sels.join(' >> css=');
        if (!inShadow(host)) break;
      }
      return sels.join(' >> css=');
    };
    // The row of an element (tr, li, role=row/listitem) and a short text of another cell that only this row has.
    // Row-like, as the runner's row= engine sees it: a table row, list item, ARIA row, listitem, option, article,
    // treeitem or menuitem, or an element repeated among its siblings (product cards).
    var ROW_ROLES = { row: 1, listitem: 1, option: 1, article: 1, treeitem: 1, menuitem: 1 };
    var signatureOf = function (e) { return lower(e) + '.' + Array.prototype.slice.call(e.classList || []).sort().join('.'); };
    var isRowLike = function (p) {
      var t = lower(p), rr = p.getAttribute('role');
      if (t === 'tr' || t === 'li' || (rr && ROW_ROLES[rr])) return true;
      var parent = p.parentElement;
      if (!parent || t === 'body' || lower(parent) === 'body' || t === 'html') return false;
      var sig = signatureOf(p), same = 0;
      for (var i = 0; i < parent.children.length; i++) if (signatureOf(parent.children[i]) === sig) same++;
      return same >= 2 && p.children.length > 0;
    };
    var rowOf = function (el) {
      for (var p = el.parentElement; p && p !== document.body; p = p.parentElement) if (isRowLike(p)) return p;
      return null;
    };
    var visibleText = function (e) { return norm(e.innerText != null ? e.innerText : e.textContent); };
    // Short texts of a row other than the element's own, first ones first (the name of a product card, a cell).
    var rowTexts = function (row, el) {
      var out = [];
      var all = row.querySelectorAll('*');
      for (var i = 0; i < all.length && out.length < 12; i++) {
        var c = all[i];
        if (c.contains(el) || el.contains(c) || NO_TEXT_TAGS[lower(c)]) continue;
        var t = visibleText(c);
        if (!t || t.length > 40 || out.indexOf(t) >= 0) continue;
        var inner = false;
        for (var j = 0; j < c.children.length; j++) if (visibleText(c.children[j]) === t) { inner = true; break; }
        if (!inner) out.push(t);
      }
      return out;
    };
    // The rows the runner's row= engine finds for a text: from each innermost element whose text contains it, the
    // first row-like element at or above it (inside "within" when given).
    var rowsFor = function (t, within, cache) {
      var root = within || document.body;
      var want = t.toLowerCase();
      var all = deepOrder(root, []);
      var rows = [];
      for (var i = 0; i < all.length; i++) {
        var c = all[i];
        if (NO_TEXT_TAGS[lower(c)]) continue;
        if (norm(flatText(c, cache)).toLowerCase().indexOf(want) < 0) continue;
        var innermost = true;
        for (var j = 0; j < c.children.length; j++) {
          if (norm(flatText(c.children[j], cache)).toLowerCase().indexOf(want) >= 0) { innermost = false; break; }
        }
        if (!innermost) continue;
        for (var p = c; p && p !== root; p = p.parentElement) {
          if (isRowLike(p)) { if (rows.indexOf(p) < 0) rows.push(p); break; }
        }
      }
      return rows;
    };
    // A text of one of the element's rows that picks out exactly one row, in which the element's name is unique.
    var rowTextOf = function (el, role, name, within) {
      var cache = new Map();
      var q = ROLE_QUERY[role] || ('[role="' + role + '"]');
      for (var r = rowOf(el); r && r !== document.body && (!within || within.contains(r)); r = r.parentElement) {
        if (!isRowLike(r)) continue;
        var texts = rowTexts(r, el);
        for (var i = 0; i < texts.length; i++) {
          var rows = rowsFor(texts[i], within, cache);
          if (rows.length !== 1 || !rows[0].contains(el)) continue;
          var inside = rows[0].querySelectorAll(q), n = 0;
          for (var k = 0; k < inside.length; k++) if (roleOf(inside[k]) === role && !isHidden(inside[k]) && nameOf(inside[k], role) === name) n++;
          if (n === 1) return texts[i];
        }
      }
      return '';
    };
    // The same names in two tables (or two forms): the nearest container with a unique id that tells them apart.
    var idContainerOf = function (el) {
      for (var p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (p.id && /^[A-Za-z][\w-]*$/.test(p.id) && uniqueSel('#' + p.id, p)) return p;
      }
      return null;
    };
    // A named landmark around the element in which its role and name are unique ("the "Main" navigation").
    var LANDMARK_WORDS = { navigation: 'navigation', region: 'section', form: 'form', dialog: 'dialog', alertdialog: 'dialog' };
    var landmarkOf = function (el, role, name) {
      for (var p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        var lr = roleOf(p);
        if (!LANDMARK_WORDS[lr]) continue;
        var ln = nameOf(p, lr);
        if (!ln || ln.length > 60) continue;
        if (countRoleName(lr, ln) !== 1) continue;
        var q = ROLE_QUERY[role] || ('[role="' + role + '"]');
        var inside = p.querySelectorAll(q), n = 0;
        for (var i = 0; i < inside.length; i++) if (roleOf(inside[i]) === role && !isHidden(inside[i]) && nameOf(inside[i], role) === name) n++;
        if (n === 1) return { role: lr, name: ln, word: LANDMARK_WORDS[lr] };
      }
      return null;
    };
    // A click on a plain container whose text is exactly one labelled control or heading inside it (a title bar
    // div around an <h6>): describe that element instead, so the step reads "the "Dashboard" heading", not a CSS path.
    var meaningful = function (el) {
      if (roleOf(el)) return el;
      var own = norm(el.innerText != null ? el.innerText : el.textContent);
      if (!own || own.length > 80) return el;
      var all = el.querySelectorAll('h1,h2,h3,h4,h5,h6,a[href],button,label,[role]');
      var pick = null, n = 0;
      for (var i = 0; i < all.length; i++) {
        var c = all[i];
        if (!roleOf(c) || isHidden(c)) continue;
        if (norm(c.innerText != null ? c.innerText : c.textContent) === own) { pick = c; n++; }
      }
      return n === 1 ? pick : el;
    };
    // 1-based position of el among the elements countText counts, for "the 2nd "Dashboard" text".
    var textNth = function (el, text) {
      var hits = textHits(text);
      for (var i = 0; i < hits.length; i++) if (hits[i] === el || containsFlat(el, hits[i])) return i + 1;
      return 0;
    };
    var info = function (el) {
      rootsCache = null;
      rootsCache = shadowRoots();
      try { return infoOf(el); } finally { rootsCache = null; }
    };
    var infoOf = function (el) {
      el = meaningful(el);
      var tag = lower(el);
      var role = roleOf(el);
      var name = nameOf(el, role);
      var label = (tag === 'input' || tag === 'select' || tag === 'textarea' || el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) ? labelOf(el) : '';
      var placeholder = norm(el.getAttribute('placeholder'));
      var field = isField(el);
      var secret = tag === 'input' && inputType(el) === 'password';
      var text = (field || tag === 'select') ? '' : norm(el.innerText != null ? el.innerText : el.textContent);
      // In a web component the rendered text comes through slots and shadow trees, which innerText leaves out.
      if (!field && tag !== 'select' && (inShadow(el) || el.shadowRoot || el.querySelector('slot'))) text = norm(flatText(el, new Map()));
      if (text.length > 200) text = text.slice(0, 200);
      var testAttr = testIdAttr(el);
      var testId = testAttr ? el.getAttribute(testAttr) || '' : '';
      var r = el.getBoundingClientRect();
      var out = {
        key: keyOf(el), tag: tag, classes: classesOf(el), css: cssPath(el), field: field, secret: secret,
        counts: {
          roleName: role && name ? countRoleName(role, name) : 0,
          label: label ? countLabel(label) : 0,
          placeholder: placeholder ? countAttr('placeholder', el.getAttribute('placeholder')) : 0,
          placeholderAsLabel: placeholder ? countLabel(placeholder) : 0,
          text: text && text.length <= 80 && !role ? countText(text) : 0,
          testId: testId ? countTestId(testId) : 0,
          id: el.id ? countAttr('id', el.id) : 0
        },
        box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
      };
      if (tag === 'input') out.type = inputType(el);
      if (role && name && out.counts.roleName > 1) {
        var rt = rowTextOf(el, role, name);
        if (rt) out.rowText = rt;
        else {
          var box = idContainerOf(el);
          var rt2 = box ? rowTextOf(el, role, name, box) : '';
          if (rt2) { out.rowText = rt2; out.rowWithin = '#' + box.id; }
        }
        var lm = landmarkOf(el, role, name);
        if (lm) out.landmark = lm;
        var rn = roleNth(el, role, name); if (rn) out.roleNth = rn;
      }
      if (role && !name && (role === 'checkbox' || role === 'radio')) { var kn = roleNth(el, role, null); if (kn) out.kindNth = kn; }
      if (el.isContentEditable) out.editable = true;
      if (role) out.role = role;
      if (name) out.name = name;
      if (label) out.label = label;
      if (placeholder) out.placeholder = placeholder;
      if (text) out.text = text;
      if (text && !role && out.counts.text > 1) { var nth = textNth(el, text); if (nth) out.textNth = nth; }
      if (testId) out.testId = testId;
      if (el.id) out.id = el.id;
      var title = norm(el.getAttribute('title')); if (title) out.title = title;
      var alt = norm(el.getAttribute('alt')); if (alt) out.alt = alt;
      if (tag === 'a' && el.getAttribute('href')) out.href = el.getAttribute('href');
      var na = el.getAttribute('name'); if (na) out.nameAttr = na;
      if ((role === 'checkbox' || role === 'switch' || role === 'radio') && tag !== 'input') out.ariaChecked = el.getAttribute('aria-checked') || 'false';
      return out;
    };
    var ACTIONABLE = 'a[href],button,summary,input,select,textarea,label,option,[role=button],[role=link],[role=tab],[role=menuitem],' +
      '[role=menuitemcheckbox],[role=menuitemradio],[role=checkbox],[role=radio],[role=switch],[role=option],[role=treeitem]';
    var actionable = function (target) {
      var el = target && target.nodeType === 1 ? target : (target && target.parentElement);
      if (!el || !el.closest) return null;
      return el.closest(ACTIONABLE) || el.closest(TEST_ID_SEL) || el;
    };
    R.info = info;
    R.roleOf = roleOf;
    R.nameOf = nameOf;
    R.isField = isField;
    R.actionable = actionable;

    // ---------------------------------------------------------------- listeners
    var pending = new Set();
    var lastSent = new WeakMap();
    var lastEnter = 0;
    // The chain of frames this document sits in, outermost first, named as a tester names a frame (see
    // frameChain in recorder.ts, which the Node side uses when a parent is on another origin).
    var frameName = function (fe) {
      var root = fe.getRootNode();
      var frames = Array.prototype.slice.call(root.querySelectorAll('iframe,frame'));
      var plain = function (v) { return !!v && v.length <= 80 && !/["\\\n\r]/.test(v) && v.trim() === v && !/^(?:css\s*=|[#.[]|i?frame(?:$|[\s#.[:>~+]))/i.test(v); };
      var count = function (attr, v) { var n = 0; for (var i = 0; i < frames.length; i++) if ((attr === 'id' ? frames[i].id : frames[i].getAttribute(attr)) === v) n++; return n; };
      var name = fe.getAttribute('name');
      if (plain(name) && count('name', name) === 1) return name;
      var title = fe.getAttribute('title');
      if (plain(title) && count('title', title) === 1 && count('name', title) === 0 && count('id', title) === 0) return title;
      if (plain(fe.id) && count('id', fe.id) === 1 && count('name', fe.id) === 0) return fe.id;
      var src = fe.getAttribute('src') || '', path = '';
      try { path = src && !/^(?:about|data|javascript|blob):/i.test(src) ? new URL(src, location.href).pathname : ''; } catch (e) { path = ''; }
      if (plain(path) && path.length > 1 && count('name', path) + count('id', path) + count('title', path) === 0) {
        var hits = 0;
        for (var j = 0; j < frames.length; j++) if ((frames[j].getAttribute('src') || '').indexOf(path) >= 0) hits++;
        if (hits === 1) return path;
      }
      var tag = lower(fe);
      if (root.querySelectorAll(tag).length === 1) return tag;
      var idx = 1;
      for (var sib = fe.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === fe.tagName) idx++;
      var sel = tag + ':nth-of-type(' + idx + ')';
      if (root.querySelectorAll(sel).length === 1) return sel;
      var p = fe.parentElement;
      var scoped = p && p.id && /^[A-Za-z][\w-]*$/.test(p.id) ? '#' + p.id + ' > ' + sel : '';
      return scoped && root.querySelectorAll(scoped).length === 1 ? scoped : 'css=' + sel;
    };
    var frameChainHere = function () {
      var out = [];
      try {
        for (var w = W; w !== w.top; w = w.parent) {
          var fe = w.frameElement;
          if (!fe) return null;
          out.unshift(frameName(fe));
        }
      } catch (e) { return null; }
      return out;
    };
    var mk = function (ev) {
      if (!ev.t) ev.t = Date.now();
      ev.url = location.href;
      if (W !== W.top) { var fc = frameChainHere(); if (fc) ev.frameChain = fc; }
      return ev;
    };
    var send = function (ev) {
      if (!R.binding || typeof W[R.binding] !== 'function') return;
      try { var p = W[R.binding](mk(ev)); if (p && p.catch) p.catch(function () {}); } catch (e) { /* page is going away */ }
    };
    // The element whose text a person edits: a field, or the host of a contenteditable region (a rich-text editor).
    var editHost = function (el) {
      if (!el || !el.tagName) return null;
      if (isField(el)) return el;
      if (!el.isContentEditable) return null;
      var h = el;
      while (h.parentElement && h.parentElement.isContentEditable) h = h.parentElement;
      return h;
    };
    var editedText = function (el) {
      if (isField(el)) return el.value;
      return String(el.innerText != null ? el.innerText : el.textContent).replace(/\n+$/, '');
    };
    var fillEvent = function (el) {
      pending.delete(el);
      var v = editedText(el);
      if (lastSent.get(el) === v) return null;
      lastSent.set(el, v);
      var secret = lower(el) === 'input' && inputType(el) === 'password';
      var ev = { kind: 'fill', el: info(el), secret: secret };
      if (!secret) ev.value = v;
      return ev;
    };
    var flushPending = function () {
      var out = [];
      pending.forEach(function (el) { if (el.isConnected) { var ev = fillEvent(el); if (ev) out.push(mk(ev)); } });
      pending.clear();
      return out;
    };
    var sendPending = function (el) { if (pending.has(el)) { var ev = fillEvent(el); if (ev) send(ev); } };
    R.flush = flushPending;
    var targetOf = function (e) { var p = e.composedPath ? e.composedPath() : []; return (p && p[0]) || e.target; };

    // ------------------------------------------------ hover: menus and overlays that only show while hovered
    // A CSS rule "A:hover B { display: block }" (or visibility, opacity, ...) shows B while A is hovered. A click on
    // something inside B needs a hover over A first, or the replay finds it hidden.
    var REVEALS = /(?:^|;)\s*(?:display|visibility|opacity|max-height|height|width|transform|clip|clip-path|left|top|right|bottom|z-index|pointer-events)\s*:/i;
    var hoverRules = function () {
      var out = [];
      var collect = function (rules) {
        for (var i = 0; i < rules.length; i++) {
          var r = rules[i];
          if (r.cssRules && !r.selectorText) { try { collect(r.cssRules); } catch (e) { /* unreadable */ } continue; }
          var st = r.selectorText;
          if (!st || st.indexOf(':hover') < 0 || !r.style || !REVEALS.test(r.style.cssText)) continue;
          var sels = st.split(',');
          for (var j = 0; j < sels.length; j++) {
            var sel = sels[j].trim();
            var k = sel.lastIndexOf(':hover');
            if (k < 0) continue;
            var tail = /^[^\s>+~]*/.exec(sel.slice(k + 6))[0];
            var hovered = (sel.slice(0, k) + tail).replace(/:hover/g, '').trim();
            var shown = sel.replace(/:hover/g, '').trim();
            if (!hovered || hovered === shown || /::?(?:before|after|placeholder|marker|selection)/.test(shown)) continue;
            out.push({ hovered: hovered, shown: shown });
          }
        }
      };
      for (var i = 0; i < document.styleSheets.length; i++) {
        try { collect(document.styleSheets[i].cssRules); } catch (e) { /* a cross-origin style sheet cannot be read */ }
      }
      return out;
    };
    // Something to describe for a hovered container: its first named element that is not part of what the hover shows.
    var hoverPick = function (h, shown) {
      if (roleOf(h) && nameOf(h, roleOf(h))) return h;
      var all = h.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var c = all[i];
        if (shown && (shown === c || shown.contains(c))) continue;
        var r = roleOf(c);
        if (r && r !== 'presentation' && nameOf(c, r) && !isHidden(c)) return c;
      }
      return h;
    };
    var lastOver = null, lastOverT = 0;
    var shownBy = [];
    var hoverAnchors = function (el) {
      var anchors = [];
      var add = function (h, shown) {
        for (var i = 0; i < anchors.length; i++) if (anchors[i].h === h) return;
        anchors.push({ h: h, shown: shown });
      };
      var rules = hoverRules();
      for (var r = 0; r < rules.length; r++) {
        var shown = null;
        try { shown = el.closest(rules[r].shown); } catch (e) { continue; }
        if (!shown) continue;
        for (var a = shown.parentElement; a; a = a.parentElement) {
          var ok = false;
          try { ok = a.matches(rules[r].hovered) && a.matches(':hover'); } catch (e) { break; }
          if (ok) { add(a, shown); break; }
        }
      }
      // Script menus (mouseenter handlers): the hovered element changed a container that holds the clicked one.
      for (var s = shownBy.length - 1; s >= 0; s--) {
        var rec = shownBy[s];
        if (Date.now() - rec.t > 10000) break;
        if (!rec.node.isConnected || !rec.node.contains(el) || !rec.by.isConnected) continue;
        if (rec.by === el || el.contains(rec.by)) continue;
        var by = actionable(rec.by) || rec.by;
        if (by === el || el.contains(by)) continue;
        add(by, rec.node.contains(by) ? null : rec.node);
        break;
      }
      // Outermost first: an inner menu shows only while the outer one is open.
      anchors.sort(function (x, y) { return x.h.contains(y.h) ? -1 : y.h.contains(x.h) ? 1 : 0; });
      var out = [];
      for (var i = 0; i < anchors.length; i++) {
        var pick = hoverPick(anchors[i].h, anchors[i].shown);
        if (pick !== el && !pick.contains(el)) out.push(pick);
        else if (anchors[i].h !== el && !anchors[i].h.contains(el)) out.push(anchors[i].h);
      }
      return out;
    };
    var watchShown = function () {
      if (typeof MutationObserver !== 'function' || !document.documentElement) return;
      new MutationObserver(function (records) {
        if (!lastOver || Date.now() - lastOverT > 1000) return;
        for (var i = 0; i < records.length; i++) {
          var r = records[i];
          var nodes = r.type === 'childList' ? r.addedNodes : [r.target];
          for (var j = 0; j < nodes.length; j++) {
            var n = nodes[j];
            if (!n || n.nodeType !== 1) continue;
            var t = lower(n);
            if (t === 'html' || t === 'body' || t === 'head' || t === 'script' || t === 'style') continue;
            if (n.contains(lastOver) && n.getElementsByTagName('*').length > 400) continue;
            shownBy.push({ node: n, by: lastOver, t: Date.now() });
          }
        }
        if (shownBy.length > 300) shownBy.splice(0, shownBy.length - 300);
      }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'aria-expanded', 'open'] });
    };

    // ------------------------------------------------ keys
    var NAMED_KEYS = { Tab: 1, Escape: 1, Enter: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, PageUp: 1, PageDown: 1,
      Home: 1, End: 1, Delete: 1, Backspace: 1, Insert: 1, F1: 1, F2: 1, F3: 1, F4: 1, F5: 1, F6: 1, F7: 1, F8: 1, F9: 1, F10: 1, F11: 1, F12: 1 };
    var MODIFIER_KEYS = { Shift: 1, Control: 1, Alt: 1, Meta: 1, AltGraph: 1, CapsLock: 1, NumLock: 1, Dead: 1, Unidentified: 1, Process: 1, OS: 1, Fn: 1 };
    var keyName = function (e) {
      var k = e.key === ' ' ? 'Space' : e.key;
      var mods = [];
      if (e.ctrlKey) mods.push('Control');
      if (e.altKey) mods.push('Alt');
      if (e.metaKey) mods.push('Meta');
      if (e.shiftKey && (NAMED_KEYS[k] || k === 'Space' || mods.length)) mods.push('Shift');
      if (k.length === 1 && mods.length) k = k.toUpperCase() === k.toLowerCase() ? k : k.toLowerCase();
      return mods.concat([k]).join('+');
    };
    // Keys whose effect is recorded as another step: activating a control (its click or check) or moving a choice (its change).
    var keyRecordedElsewhere = function (el, k) {
      var tag = lower(el), role = roleOf(el);
      if (k === 'Enter' || k === ' ') {
        if (tag === 'button' || tag === 'a' || tag === 'summary' || tag === 'select' || tag === 'option') return true;
        if (tag === 'input') return true;
        if (role === 'button' || role === 'link' || role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'tab' ||
          role === 'menuitem' || role === 'option' || role === 'menuitemcheckbox' || role === 'menuitemradio' || role === 'treeitem') return true;
      }
      if (k.indexOf('Arrow') === 0 || k === 'Home' || k === 'End' || k === 'PageUp' || k === 'PageDown') {
        if (tag === 'select') return true;
        if (tag === 'input' && (inputType(el) === 'radio' || inputType(el) === 'range')) return true;
      }
      return false;
    };

    // ------------------------------------------------ drag and drop
    var dragFrom = null;
    var nativeDrag = false;
    var down = null;
    var suppressClickUntil = 0;
    var dropTarget = function (el) {
      if (!el || !el.closest) return el;
      return el.closest('[draggable="true"]') || actionable(el) || el;
    };

    R.attach = function () {
      if (R.listening) return;
      R.listening = true;
      watchShown();
      try {
        var closeWindow = W.close;
        W.close = function () { send({ kind: 'closing' }); return closeWindow.apply(W, arguments); };
      } catch (e) { /* not replaceable */ }
      W.addEventListener('pointerover', function (e) {
        if (!e.isTrusted) return;
        lastOver = targetOf(e);
        lastOverT = Date.now();
      }, true);
      W.addEventListener('input', function (e) {
        var el = editHost(targetOf(e));
        if (el) pending.add(el);
      }, true);
      W.addEventListener('change', function (e) {
        var el = targetOf(e);
        if (!el || !el.tagName) return;
        var tag = lower(el);
        if (tag === 'select') {
          var labels = [];
          for (var i = 0; i < el.options.length; i++) if (el.options[i].selected) labels.push(norm(el.options[i].label || el.options[i].text));
          send({ kind: 'select', el: info(el), labels: labels });
          return;
        }
        if (tag === 'input') {
          var ty = inputType(el);
          if (ty === 'checkbox') { send({ kind: el.checked ? 'check' : 'uncheck', el: info(el) }); return; }
          if (ty === 'radio') { if (el.checked) send({ kind: 'check', el: info(el) }); return; }
          if (ty === 'file') {
            var files = [];
            for (var f = 0; el.files && f < el.files.length; f++) files.push(el.files[f].name);
            send({ kind: 'upload', el: info(el), files: files });
            return;
          }
        }
        if (isField(el)) { var ev = fillEvent(el); if (ev) send(ev); }
      }, true);
      W.addEventListener('focusout', function (e) { sendPending(editHost(targetOf(e))); }, true);
      // Leaving a frame (a rich-text editor's iframe) moves focus out of its window, not out of an element in it.
      W.addEventListener('blur', function (e) { if (e.target === W) flushPending().forEach(function (ev) { send(ev); }); }, true);
      W.addEventListener('keydown', function (e) {
        if (!e.isTrusted || e.isComposing || e.repeat || MODIFIER_KEYS[e.key]) return;
        var el = targetOf(e);
        if (el && el.nodeType !== 1) el = el.parentElement;
        var host = editHost(el);
        var plain = !e.ctrlKey && !e.metaKey && !e.altKey;
        if (host) {
          // Typing and editing shortcuts are recorded as the text they produce; only keys that leave or drive the field are steps.
          if (!plain) return;
          var k = e.key;
          var tag = lower(host);
          if (k === 'Enter') {
            if (tag === 'textarea' || !isField(host) || e.shiftKey) return;
          } else if (k === 'Tab' || k === 'Escape') {
            // a step of its own
          } else if ((k === 'ArrowDown' || k === 'ArrowUp') && tag === 'input' && !e.shiftKey) {
            // choosing from a suggestion list
          } else return;
          sendPending(host);
          if (k === 'Enter') lastEnter = Date.now();
          send({ kind: 'press', key: keyName(e), el: info(host) });
          return;
        }
        var k2 = e.key;
        if (!NAMED_KEYS[k2] && k2 !== ' ' && k2.length !== 1) return;
        if (plain && k2.length === 1 && k2 !== ' ' && el && (lower(el) === 'select' || lower(el) === 'input')) return;
        if (el && keyRecordedElsewhere(el, k2)) return;
        var target = el && el !== document.body && el !== document.documentElement && el.tagName ? el : null;
        send({ kind: 'press', key: keyName(e), el: target ? info(target) : undefined });
      }, true);
      W.addEventListener('dragstart', function (e) {
        if (!e.isTrusted) return;
        var el = targetOf(e);
        if (el && el.nodeType !== 1) el = el.parentElement;
        var src = el && el.closest ? (el.closest('[draggable="true"]') || el) : el;
        if (!src || isField(src)) { dragFrom = null; return; }
        nativeDrag = true;
        dragFrom = { info: info(src), t: Date.now() };
      }, true);
      W.addEventListener('drop', function (e) {
        if (!e.isTrusted || !dragFrom) return;
        var to = dropTarget(targetOf(e));
        if (to && to.tagName) send({ kind: 'drag', el: dragFrom.info, to: info(to), t: dragFrom.t });
        dragFrom = null;
      }, true);
      W.addEventListener('dragend', function () { dragFrom = null; nativeDrag = false; suppressClickUntil = Date.now() + 300; down = null; }, true);
      W.addEventListener('mousedown', function (e) {
        if (!e.isTrusted || e.button !== 0) { down = null; return; }
        var el = targetOf(e);
        if (el && el.nodeType !== 1) el = el.parentElement;
        nativeDrag = false;
        if (!el || !el.tagName || editHost(el) || lower(el) === 'select' || lower(el) === 'option' || (lower(el) === 'input')) { down = null; return; }
        down = { x: e.clientX, y: e.clientY, el: el, info: null, moved: false, t: Date.now() };
      }, true);
      W.addEventListener('mousemove', function (e) {
        if (!down || down.moved || !e.isTrusted || !(e.buttons & 1)) return;
        if (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) < 12) return;
        down.moved = true;
        var src = actionable(down.el) || down.el;
        down.src = src;
        // Described as it was before it moved.
        try { var r = src.getBoundingClientRect(); src.__ezBox = r; } catch (err) { /* detached */ }
        down.info = info(src);
      }, true);
      W.addEventListener('mouseup', function (e) {
        var d = down;
        down = null;
        if (!d || !d.moved || nativeDrag || !e.isTrusted) return;
        var sel = W.getSelection && W.getSelection();
        if (sel && String(sel).trim()) return;
        var hits = document.elementsFromPoint ? document.elementsFromPoint(e.clientX, e.clientY) : [];
        var to = null;
        for (var i = 0; i < hits.length; i++) {
          var h = hits[i];
          if (h === document.documentElement || h === document.body || d.src.contains(h) || h.contains(d.src)) continue;
          to = h;
          break;
        }
        suppressClickUntil = Date.now() + 300;
        if (to) send({ kind: 'drag', el: d.info, to: info(dropTarget(to)), t: d.t });
      }, true);
      W.addEventListener('click', function (e) {
        if (!e.isTrusted) return;
        var raw = targetOf(e);
        if (e.altKey) {
          e.preventDefault();
          e.stopImmediatePropagation();
          var t = actionable(raw);
          if (!t) return;
          var a = { kind: 'assert', el: info(t) };
          if (isField(t) || lower(t) === 'select') {
            if (!(lower(t) === 'input' && inputType(t) === 'password')) {
              a.value = lower(t) === 'select' ? norm(t.options[t.selectedIndex] ? (t.options[t.selectedIndex].label || t.options[t.selectedIndex].text) : '') : t.value;
            }
          } else {
            a.text = norm(t.innerText != null ? t.innerText : t.textContent);
          }
          send(a);
          return;
        }
        if (Date.now() < suppressClickUntil) return;
        if (e.detail === 0 && Date.now() - lastEnter < 1000) return;
        var el = actionable(raw);
        if (!el) return;
        var tag = lower(el);
        if (tag === 'select' || tag === 'option' || tag === 'textarea') return;
        if (tag === 'input' && (isField(el) || NON_FIELD_TYPES[inputType(el)] && !BUTTON_TYPES[inputType(el)])) return;
        if (tag === 'label' && el.control) return;
        if (el.isContentEditable) return;
        var t0 = Date.now();
        if (e.detail > 0) {
          var hovers = [];
          try { hovers = hoverAnchors(el); } catch (err) { hovers = []; }
          for (var hv = 0; hv < hovers.length; hv++) send({ kind: 'hover', el: info(hovers[hv]), t: t0 - hovers.length + hv });
        }
        var role = roleOf(el);
        if ((role === 'checkbox' || role === 'switch') && tag !== 'input') {
          var was = el.getAttribute('aria-checked') === 'true';
          send({ kind: was ? 'uncheck' : 'check', el: info(el), t: t0 });
          return;
        }
        if (role === 'radio' && tag !== 'input') { send({ kind: 'check', el: info(el), t: t0 }); return; }
        send({ kind: 'click', el: info(el), t: t0 });
      }, true);
      W.addEventListener('contextmenu', function (e) {
        if (!e.isTrusted || e.altKey) return;
        var el = actionable(targetOf(e));
        if (el && !isField(el)) send({ kind: 'click', button: 'right', el: info(el) });
      }, true);
      W.addEventListener('dblclick', function (e) {
        if (!e.isTrusted || e.altKey) return;
        var el = actionable(targetOf(e));
        if (!el || isField(el) || lower(el) === 'select') return;
        send({ kind: 'dblclick', el: info(el) });
      }, true);
      W.addEventListener('pagehide', function () { flushPending().forEach(function (ev) { send(ev); }); }, true);
    };
  }
  if (BINDING) {
    R.binding = BINDING;
    R.attach();
  }
}`;

/** Script content for `addInitScript`: installs helpers and, with a binding name, the listeners. */
export function pageScript(binding: string | null): string {
  return `(${PAGE_SCRIPT_SOURCE})(${JSON.stringify(binding)});`;
}
