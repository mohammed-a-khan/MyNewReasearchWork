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
    var norm = function (s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); };
    var lower = function (el) { return el.tagName ? el.tagName.toLowerCase() : ''; };
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
    var idsText = function (ids) {
      var parts = [];
      norm(ids).split(' ').forEach(function (id) {
        var e = id && document.getElementById(id);
        if (e) parts.push(norm(textOf(e, false)));
      });
      return norm(parts.join(' '));
    };
    var labelsList = function (el) {
      var out = [];
      var lb = el.getAttribute('aria-labelledby');
      if (lb) { var t = idsText(lb); if (t) out.push(t); }
      var al = norm(el.getAttribute('aria-label'));
      if (al) out.push(al);
      if (el.labels) {
        for (var i = 0; i < el.labels.length; i++) {
          var lt = norm(textOf(el.labels[i], true));
          if (lt) out.push(lt);
        }
      }
      return out;
    };
    var labelOf = function (el) { var l = labelsList(el); return l.length ? l[0] : ''; };
    var NAME_FROM_CONTENT = { button: 1, link: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, option: 1,
      heading: 1, cell: 1, columnheader: 1, rowheader: 1, checkbox: 1, radio: 1, switch: 1, treeitem: 1, tooltip: 1, row: 1 };
    var nameOf = function (el, role) {
      var lb = el.getAttribute('aria-labelledby');
      if (lb) { var t = idsText(lb); if (t) return t; }
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
      cell: 'td,[role=cell]'
    };
    var countRoleName = function (role, name) {
      var q = ROLE_QUERY[role] || ('[role="' + role + '"]');
      var n = 0;
      var all = document.querySelectorAll(q);
      for (var i = 0; i < all.length; i++) {
        var e = all[i];
        if (roleOf(e) !== role || isHidden(e)) continue;
        if (nameOf(e, role) === name) n++;
      }
      return n;
    };
    var countLabel = function (text) {
      if (!text) return 0;
      var n = 0;
      var all = document.querySelectorAll('input,select,textarea,button,meter,output,progress,[aria-label],[aria-labelledby]');
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
      var all = document.querySelectorAll('[' + attr + ']');
      for (var i = 0; i < all.length; i++) if (all[i].getAttribute(attr) === value) n++;
      return n;
    };
    var countText = function (text) {
      if (!text || !document.body) return 0;
      var n = 0;
      var all = document.body.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var e = all[i];
        var t = lower(e);
        if (t === 'script' || t === 'style' || t === 'template') continue;
        var raw = e.textContent || '';
        if (raw.length < text.length) continue;
        if (norm(raw) !== text) continue;
        var childHas = false;
        for (var j = 0; j < e.children.length; j++) if (norm(e.children[j].textContent) === text) { childHas = true; break; }
        if (!childHas) n++;
      }
      return n;
    };
    var safeAttr = function (v) { return typeof v === 'string' && v.length > 0 && v.length <= 120 && !/["'\x60\\“”\n\r]/.test(v); };
    var attrSel = function (name, v) { return '[' + name + '="' + v + '"]'; };
    var cssId = function (id) { return (W.CSS && W.CSS.escape) ? W.CSS.escape(id) : id.replace(/([^\w-])/g, '\\$1'); };
    var uniqueSel = function (sel, el) {
      try { var m = document.querySelectorAll(sel); return m.length === 1 && m[0] === el; } catch (e) { return false; }
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
      var tid = el.getAttribute('data-testid');
      if (safeAttr(tid)) return tag + attrSel('data-testid', tid);
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
      var tid = a.getAttribute('data-testid');
      if (safeAttr(tid)) return tag + attrSel('data-testid', tid);
      var cls = classesOf(a);
      return cls.length ? tag + '.' + cls[0] : tag;
    };
    var cssPath = function (el) {
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
    // The row of an element (tr, li, role=row/listitem) and a short text of another cell that only this row has.
    var rowOf = function (el) {
      for (var p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        var t = lower(p), rr = p.getAttribute('role');
        if (t === 'tr' || t === 'li' || rr === 'row' || rr === 'listitem') return p;
      }
      return null;
    };
    var rowTextOf = function (el, role, name) {
      var row = rowOf(el);
      if (!row) return '';
      var cells = row.children;
      for (var i = 0; i < cells.length; i++) {
        if (cells[i].contains(el)) continue;
        var t = norm(cells[i].innerText != null ? cells[i].innerText : cells[i].textContent);
        if (!t || t.length > 40) continue;
        // Unique: no other element with this role and name sits in a row containing the text.
        var q = ROLE_QUERY[role] || ('[role="' + role + '"]');
        var all = document.querySelectorAll(q), hits = 0;
        for (var k = 0; k < all.length; k++) {
          var e = all[k];
          if (roleOf(e) !== role || isHidden(e) || nameOf(e, role) !== name) continue;
          var er = rowOf(e);
          if (er && norm(er.innerText != null ? er.innerText : er.textContent).toLowerCase().indexOf(t.toLowerCase()) >= 0) hits++;
        }
        if (hits === 1) return t;
      }
      return '';
    };
    var info = function (el) {
      var tag = lower(el);
      var role = roleOf(el);
      var name = nameOf(el, role);
      var label = (tag === 'input' || tag === 'select' || tag === 'textarea' || el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) ? labelOf(el) : '';
      var placeholder = norm(el.getAttribute('placeholder'));
      var field = isField(el);
      var secret = tag === 'input' && inputType(el) === 'password';
      var text = (field || tag === 'select') ? '' : norm(el.innerText != null ? el.innerText : el.textContent);
      if (text.length > 200) text = text.slice(0, 200);
      var testId = el.getAttribute('data-testid') || '';
      var r = el.getBoundingClientRect();
      var out = {
        key: keyOf(el), tag: tag, classes: classesOf(el), css: cssPath(el), field: field, secret: secret,
        counts: {
          roleName: role && name ? countRoleName(role, name) : 0,
          label: label ? countLabel(label) : 0,
          placeholder: placeholder ? countAttr('placeholder', el.getAttribute('placeholder')) : 0,
          placeholderAsLabel: placeholder ? countLabel(placeholder) : 0,
          text: text && text.length <= 80 && !role ? countText(text) : 0,
          testId: testId ? countAttr('data-testid', testId) : 0,
          id: el.id ? countAttr('id', el.id) : 0
        },
        box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
      };
      if (tag === 'input') out.type = inputType(el);
      if (role && name && out.counts.roleName > 1) { var rt = rowTextOf(el, role, name); if (rt) out.rowText = rt; }
      if (role) out.role = role;
      if (name) out.name = name;
      if (label) out.label = label;
      if (placeholder) out.placeholder = placeholder;
      if (text) out.text = text;
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
      return el.closest(ACTIONABLE) || el.closest('[data-testid]') || el;
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
    var mk = function (ev) { ev.t = Date.now(); ev.url = location.href; return ev; };
    var send = function (ev) {
      if (!R.binding || typeof W[R.binding] !== 'function') return;
      try { var p = W[R.binding](mk(ev)); if (p && p.catch) p.catch(function () {}); } catch (e) { /* page is going away */ }
    };
    var fillEvent = function (el) {
      pending.delete(el);
      var v = el.value;
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
    R.flush = flushPending;
    var targetOf = function (e) { var p = e.composedPath ? e.composedPath() : []; return (p && p[0]) || e.target; };
    R.attach = function () {
      if (R.listening) return;
      R.listening = true;
      W.addEventListener('input', function (e) {
        var el = targetOf(e);
        if (isField(el)) pending.add(el);
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
      W.addEventListener('focusout', function (e) {
        var el = targetOf(e);
        if (pending.has(el)) { var ev = fillEvent(el); if (ev) send(ev); }
      }, true);
      W.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || !e.isTrusted) return;
        var el = targetOf(e);
        if (!isField(el) || lower(el) === 'textarea') return;
        var ev = fillEvent(el);
        if (ev) send(ev);
        lastEnter = Date.now();
        send({ kind: 'press', key: 'Enter', el: info(el) });
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
        if (e.detail === 0 && Date.now() - lastEnter < 1000) return;
        var el = actionable(raw);
        if (!el) return;
        var tag = lower(el);
        if (tag === 'select' || tag === 'option' || tag === 'textarea') return;
        if (tag === 'input' && (isField(el) || NON_FIELD_TYPES[inputType(el)] && !BUTTON_TYPES[inputType(el)])) return;
        if (tag === 'label' && el.control) return;
        if (el.isContentEditable) return;
        var role = roleOf(el);
        if ((role === 'checkbox' || role === 'switch') && tag !== 'input') {
          var was = el.getAttribute('aria-checked') === 'true';
          send({ kind: was ? 'uncheck' : 'check', el: info(el) });
          return;
        }
        if (role === 'radio' && tag !== 'input') { send({ kind: 'check', el: info(el) }); return; }
        send({ kind: 'click', el: info(el) });
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
