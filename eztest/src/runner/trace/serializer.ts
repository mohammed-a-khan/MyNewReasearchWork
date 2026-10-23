/**
 * DOM snapshot serializer. Runs read-only in the page and produces a
 * self-contained HTML document: scripts, event handler attributes and
 * `javascript:` URLs removed; form values, checked and selected state baked
 * into attributes; open shadow roots emitted as declarative shadow DOM;
 * same-origin iframes inlined as `srcdoc`; scroll offsets kept as
 * `data-ez-scroll`; every element numbered with `data-ez-nid`.
 *
 * Stylesheets are returned separately (placeholders `ezres:N` in the HTML) so
 * the recorder can store them once per run by content hash. Password and
 * other secret inputs never leave the page with their value.
 *
 * Works in Chromium and Firefox. The source is static text shipped
 * with EZTest (never user input), handed to the browser driver verbatim.
 */
import type { ElementHandle, Page } from '../../browser/index.js';
import { pageFunction } from '../../heal/fingerprint.js';

export interface RawSnapshot {
  html: string;
  styles: string[];
  url: string;
  title: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  scroll: { x: number; y: number };
  nodeCount: number;
  text: string;
  target: null | {
    nid: number;
    box: { x: number; y: number; width: number; height: number };
    tag: string;
    sensitive: boolean;
    regionText: string;
  };
}

interface SerializeArg {
  target: Node | null;
  maxText: number;
}

const IN_PAGE = String.raw`(arg) => {
  var target = arg && arg.target;
  var maxText = (arg && arg.maxText) || 4000;
  var nid = 0;
  var styles = [];
  var targetInfo = null;
  var SECRET = /pass(?:word|wd|phrase)?|secret|token|api[-_]?key|otp|one[-_]?time|cvv|cvc|credential|\bpin\b/i;
  var VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1 };
  var DROP = { script: 1, noscript: 1, object: 1, embed: 1, applet: 1, base: 1 };
  var CONTROL = { a: 1, button: 1, input: 1, select: 1, textarea: 1, summary: 1 };
  var escText = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  var escAttr = function (s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  var clean = function (s) { return (s || '').replace(/\s+/g, ' ').trim(); };
  var sensitive = function (el) {
    var tag = el.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return false;
    var t = (el.getAttribute('type') || '').toLowerCase();
    if (t === 'password') return true;
    var ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (/password|one-time-code|cc-number|cc-csc/.test(ac)) return true;
    return SECRET.test((el.getAttribute('name') || '') + ' ' + (el.id || ''));
  };
  var sheetText = function (sheet) {
    try {
      var rules = sheet.cssRules;
      var out = [];
      for (var i = 0; i < rules.length; i++) out.push(rules[i].cssText);
      return out.join('\n');
    } catch (e) { return null; }
  };
  var addStyle = function (text) { styles.push(text); return 'ezres:' + (styles.length - 1); };
  var adopted = function (root) {
    var out = '';
    var list = root.adoptedStyleSheets || [];
    for (var i = 0; i < list.length; i++) {
      var t = sheetText(list[i]);
      if (t) out += '<link rel="stylesheet" href="' + addStyle(t) + '" data-ez-adopted="1">';
    }
    return out;
  };
  var regionOf = function (el) {
    var r = el.closest && el.closest('form, fieldset, section, article, dialog, table, nav, header, footer, [role=dialog], [role=region], [role=form], main');
    if (!r) r = (el.parentElement && el.parentElement.parentElement) || el.parentElement || el;
    return clean(r.innerText || r.textContent).slice(0, 2000);
  };
  var serializeChildren = function (node, ox, oy) {
    var out = '';
    for (var c = node.firstChild; c; c = c.nextSibling) out += serializeNode(c, ox, oy);
    return out;
  };
  var serializeNode = function (n, ox, oy) {
    if (n.nodeType === 3) {
      var p = n.parentNode && n.parentNode.nodeName ? n.parentNode.nodeName.toLowerCase() : '';
      return p === 'style' ? n.nodeValue : escText(n.nodeValue);
    }
    if (n.nodeType === 11) return serializeChildren(n, ox, oy);
    if (n.nodeType !== 1) return '';
    var el = n;
    var tag = el.tagName.toLowerCase();
    if (DROP[tag]) return '';
    if (tag === 'meta' && (el.getAttribute('http-equiv') || '').toLowerCase() === 'refresh') return '';
    if (tag === 'link') {
      var rel = (el.getAttribute('rel') || '').toLowerCase();
      if (rel.split(/\s+/).indexOf('stylesheet') < 0) return '';
      var t = el.sheet ? sheetText(el.sheet) : null;
      nid++;
      if (t !== null) return '<link rel="stylesheet" data-ez-nid="' + nid + '" data-ez-href="' + escAttr(el.href) + '" href="' + addStyle(t) + '">';
      return '<link rel="stylesheet" data-ez-nid="' + nid + '" href="ezurl:' + escAttr(el.href) + '">';
    }
    var id = ++nid;
    var attrs = ' data-ez-nid="' + id + '"';
    var secret = sensitive(el);
    var formTag = tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'option';
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      var name = a.name.toLowerCase();
      var v = a.value;
      if (name.indexOf('on') === 0 || name === 'srcset' || name === 'integrity' || name === 'nonce' || name.indexOf('data-ez-') === 0) continue;
      if (formTag && (name === 'value' || name === 'checked' || name === 'selected')) continue;
      if (tag === 'iframe' && (name === 'src' || name === 'srcdoc')) continue;
      if (/^\s*(javascript|vbscript|data:text\/html)/i.test(v) && (name === 'href' || name === 'src' || name === 'action' || name === 'formaction' || name === 'xlink:href')) v = '#';
      if (name === 'src' && tag === 'img') { attrs += ' src="ezurl:' + escAttr(el.currentSrc || el.src) + '"'; continue; }
      attrs += ' ' + a.name + '="' + escAttr(v) + '"';
    }
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        if (el.value) attrs += ' value="' + escAttr(el.value) + '"';
        if (el.checked) attrs += ' checked';
      } else if (type !== 'file') {
        if (secret) attrs += ' value="" data-ez-redacted="1"';
        else attrs += ' value="' + escAttr(el.value) + '"';
      }
    }
    if (tag === 'option') {
      attrs += ' value="' + escAttr(el.value) + '"';
      if (el.selected) attrs += ' selected';
    }
    if (el.scrollTop || el.scrollLeft) attrs += ' data-ez-scroll="' + Math.round(el.scrollLeft) + ',' + Math.round(el.scrollTop) + '"';
    // Interactive elements that are not rendered (display:none, visibility:hidden, collapsed) are marked for the UI coverage map.
    if (CONTROL[tag] || el.hasAttribute('role') || el.hasAttribute('tabindex') || el.hasAttribute('contenteditable')) {
      try {
        if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') attrs += ' data-ez-hidden="1"';
      } catch (e) { /* detached */ }
    }
    if (el === target) {
      var r = el.getBoundingClientRect();
      targetInfo = {
        nid: id,
        box: { x: Math.round((r.x + ox) * 100) / 100, y: Math.round((r.y + oy) * 100) / 100, width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100 },
        tag: tag,
        sensitive: secret,
        regionText: regionOf(el)
      };
    }
    var inner = '';
    if (el.shadowRoot) inner += '<template shadowrootmode="open">' + adopted(el.shadowRoot) + serializeChildren(el.shadowRoot, ox, oy) + '</template>';
    if (tag === 'textarea') inner += secret ? '' : escText(el.value);
    else if (tag === 'iframe') {
      var doc = null;
      try { doc = el.contentDocument; } catch (e) { doc = null; }
      if (doc && doc.documentElement) {
        var fr = el.getBoundingClientRect();
        var sub = '<!DOCTYPE html>' + adopted(doc) + serializeNode(doc.documentElement, ox + fr.x + (el.clientLeft || 0), oy + fr.y + (el.clientTop || 0));
        attrs += ' srcdoc="' + escAttr(sub) + '"';
      } else {
        attrs += ' data-ez-cross-origin="1"';
      }
    } else if (tag === 'style') {
      var st = el.textContent || '';
      if (!st.trim() && el.sheet) st = sheetText(el.sheet) || '';
      if (st.length > 1024) return '<link rel="stylesheet" data-ez-nid="' + id + '" href="' + addStyle(st) + '">';
      inner += st.replace(/<\/style/gi, '<\\/style');
    } else if (tag === 'template') {
      inner += serializeChildren(el.content, ox, oy);
    } else {
      inner += serializeChildren(el, ox, oy);
    }
    if (VOID[tag]) return '<' + tag + attrs + '>';
    return '<' + tag + attrs + '>' + inner + '</' + tag + '>';
  };
  var root = document.documentElement;
  var html = '<!DOCTYPE html>' + serializeNode(root, window.scrollX || 0, window.scrollY || 0);
  if (document.adoptedStyleSheets && document.adoptedStyleSheets.length) {
    html = html.replace(/<head([^>]*)>/i, function (m) { return m + adopted(document); });
  }
  var bodyText = document.body ? clean(document.body.innerText || document.body.textContent) : '';
  return {
    html: html,
    styles: styles,
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio || 1 },
    scroll: { x: Math.round(window.scrollX || 0), y: Math.round(window.scrollY || 0) },
    nodeCount: nid,
    text: bodyText.slice(0, maxText),
    target: targetInfo
  };
}`;

const serializeFn = pageFunction<SerializeArg, RawSnapshot>(IN_PAGE);

/** Serialize the page's main frame (read-only). `target` is highlighted when it is in the snapshot. */
export async function serializePage(page: Page, target?: ElementHandle | null, maxText = 4000): Promise<RawSnapshot> {
  return page.evaluate(serializeFn, { target: target ?? null, maxText });
}
