/**
 * The in-page half of the component adapters: one static script (never user
 * input) installed once per document as `window.__ezc`, then called with a
 * dialect (plain data describing a library's DOM) and arguments.
 *
 * Like the other in-page helpers it is kept as source text, so the
 * TypeScript toolchain never rewrites it. Everything here only reads the DOM,
 * scrolls widget viewports and marks elements with a `data-ezc` attribute so
 * the Node side can act on them through ordinary driver locators
 * (actionability checks, auto-wait, frames). Clicking and typing happen in
 * Node, never here.
 */
import type { Frame, Locator } from '../../browser/index.js';
import { EzTestError } from '../../core/index.js';

export const ENGINE_VERSION = 'ezc-1';

/** Attribute the engine marks elements with. */
export const MARK_ATTR = 'data-ezc';

const SOURCE = String.raw`(function () {
var V = '${ENGINE_VERSION}';
if (window.__ezc && window.__ezc.v === V) return;
var E = { v: V, n: 0 };
window.__ezc = E;

// ------------------------------------------------------------ basics
var INVIS = new RegExp('[' + [[0x200b, 0x200f], [0x2066, 0x2069], [0x202a, 0x202e], [0xfeff, 0xfeff]].map(function (r) { return String.fromCharCode(r[0]) + '-' + String.fromCharCode(r[1]); }).join('') + ']', 'g');
var NBSP = new RegExp('[' + String.fromCharCode(0xa0, 0x202f, 0x2007) + ']', 'g');
function norm(s) { return (s == null ? '' : String(s)).replace(INVIS, '').replace(NBSP, ' ').replace(/\s+/g, ' ').trim(); }
function qa(root, sel) { if (!sel || !root) return []; try { return Array.from(root.querySelectorAll(sel)); } catch (e) { throw new Error('bad selector ' + sel + ': ' + e.message); } }
function q1(root, sel) { return qa(root, sel)[0] || null; }
function matches(el, sel) { try { return !!sel && el.matches(sel); } catch (e) { return false; } }
function visible(el) {
  if (!el || !el.isConnected) return false;
  var r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  var cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
}
function text(el) { return el ? norm(el.textContent) : ''; }
function mark(el) {
  if (!el) return null;
  var t = el.getAttribute('${MARK_ATTR}');
  if (t) return t;
  t = 'm' + (++E.n) + '-' + Math.random().toString(36).slice(2, 7);
  el.setAttribute('${MARK_ATTR}', t);
  return t;
}
function deepQuery(sel, root) {
  root = root || document;
  var x = root.querySelector(sel);
  if (x) return x;
  var all = root.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) if (all[i].shadowRoot) { x = deepQuery(sel, all[i].shadowRoot); if (x) return x; }
  return null;
}
function byMark(t) { return t ? deepQuery('[${MARK_ATTR}="' + t + '"]') : null; }
E.clearMarks = function () { qa(document, '[${MARK_ATTR}]').forEach(function (e) { e.removeAttribute('${MARK_ATTR}'); }); };
// Real timers even when EZTest's browser clock is paused (src/browser/clock.ts).
var NT = window.__eztestClock ? window.__eztestClock.native : { requestAnimationFrame: requestAnimationFrame.bind(window), setTimeout: setTimeout.bind(window) };
function frame() { return new Promise(function (r) { NT.requestAnimationFrame(function () { NT.setTimeout(r, 0); }); }); }
function sleep(ms) { return new Promise(function (r) { NT.setTimeout(r, ms); }); }
function disabled(el) {
  if (!el) return true;
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return true;
  var c = el.className && el.className.baseVal === undefined ? String(el.className) : '';
  return /(^|\s)(k-disabled|k-state-disabled|dx-button-disable|dx-state-disabled|p-disabled|ui-state-disabled|Mui-disabled|mat-mdc-button-disabled|oj-disabled|sapMBtnDisabled|disabled)(\s|$)/.test(c);
}
function accName(el) {
  if (!el) return '';
  var lb = el.getAttribute('aria-labelledby');
  if (lb) { var s = lb.split(/\s+/).map(function (id) { var x = document.getElementById(id); return x ? text(x) : ''; }).join(' '); if (norm(s)) return norm(s); }
  var al = el.getAttribute('aria-label'); if (al) return norm(al);
  if (el.id) { var l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return text(l); }
  var t = text(el); if (t) return t;
  return norm(el.getAttribute('title') || el.getAttribute('placeholder') || '');
}
/** The widget root for el: el itself, an ancestor, or the single outermost descendant matching sel. */
/** closest() that also climbs out of shadow roots (web components render their widgets inside one). */
function closestDeep(el, sel) {
  for (var e = el; e; e = e.parentElement || (e.getRootNode && e.getRootNode() !== document ? e.getRootNode().host : null) || null) if (matches(e, sel)) return e;
  return null;
}
function rootFor(el, sel) {
  if (matches(el, sel)) return { el: el };
  var up = closestDeep(el, sel);
  if (up) return { el: up };
  var all = qa(el, sel).filter(function (x) { return !(x.parentElement && x.parentElement.closest(sel) && el.contains(x.parentElement.closest(sel))); });
  if (all.length === 1) return { el: all[0] };
  return { el: null, count: all.length };
}
E.detect = function (el, list) {
  return list.map(function (d) {
    try { var r = rootFor(el, d.root); return { id: d.id, found: !!r.el, count: r.el ? 1 : (r.count || 0) }; }
    catch (e) { return { id: d.id, found: false, count: 0, error: e.message }; }
  });
};
function need(el, d, what) {
  var r = rootFor(el, d.root);
  if (!r.el) throw new Error(r.count > 1 ? (r.count + ' ' + what + 's inside the target; name one') : ('no ' + what + ' (' + d.id + ') at the target'));
  if (d.shadowInner) { var inner = (r.el.shadowRoot || r.el).querySelector(d.shadowInner); if (inner) return inner; }
  return r.el;
}

// ------------------------------------------------------------ values
function parseNum(s) {
  var t = norm(s).replace(/[\s']/g, '');
  var neg = /^\(.*\)$/.test(t) || /^-|-$|^[^\d]*-/.test(t);
  t = t.replace(/[^0-9.,]/g, '');
  if (!/\d/.test(t)) return null;
  var lc = t.lastIndexOf(','), ld = t.lastIndexOf('.');
  if (lc >= 0 && ld >= 0) { if (lc > ld) t = t.replace(/\./g, '').replace(',', '.'); else t = t.replace(/,/g, ''); }
  else if (lc >= 0) { var after = t.length - lc - 1; t = (after === 3 && t.indexOf(',') === lc && lc > 0) || (t.split(',').length > 2) ? t.replace(/,/g, '') : t.replace(',', '.'); }
  else if (t.split('.').length > 2) t = t.replace(/\./g, '');
  var n = Number(t);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}
E.parseNum = parseNum;
function looksNumeric(s) { return /^[\s(+\-]*[^\d\s]{0,4}\s*[\d][\d.,'\s]*\s*[^\d\s]{0,4}[)\s]*$/.test(norm(s)) && parseNum(s) !== null; }
function same(actual, expected) {
  var a = norm(actual), b = norm(expected);
  if (a === b) return true;
  if (looksNumeric(a) && looksNumeric(b)) return parseNum(a) === parseNum(b);
  return false;
}
E.same = same;
function test(actual, op, expected) {
  var a = norm(actual), b = norm(expected);
  switch (op) {
    case 'equals': return same(a, b);
    case 'notEquals': return !same(a, b);
    case 'contains': return a.toLowerCase().indexOf(b.toLowerCase()) >= 0;
    case 'startsWith': return a.toLowerCase().indexOf(b.toLowerCase()) === 0;
    case 'endsWith': return a.toLowerCase().slice(-b.length) === b.toLowerCase();
    case 'matches': try { return new RegExp(b).test(a); } catch (e) { return false; }
    case 'empty': return a === '';
    case 'notEmpty': return a !== '';
    case 'gt': case 'gte': case 'lt': case 'lte': {
      var x = parseNum(a), y = parseNum(b);
      if (x === null || y === null) { var c = a.localeCompare(b, undefined, { numeric: true }); x = c; y = 0; }
      return op === 'gt' ? x > y : op === 'gte' ? x >= y : op === 'lt' ? x < y : x <= y;
    }
  }
  throw new Error('unknown comparison ' + op);
}
E.test = test;

// ------------------------------------------------------------ grids
function gridOwned(g, el, d) { var p = el.parentElement ? el.parentElement.closest(d.root) : null; return p === g || (!p && g.contains(el)); }
function headerCells(g, d) {
  var hs = qa(g, d.headerCell).filter(function (h) { return gridOwned(g, h, d) && !matches(h, d.headerExclude); });
  if (d.generic && !hs.length) {
    var firstRow = q1(g, 'thead tr') || q1(g, 'tr');
    if (firstRow) hs = Array.from(firstRow.children).filter(function (c) { return c.tagName === 'TH' || c.tagName === 'TD'; });
  }
  return hs;
}
function colIdOf(el, d, pos) {
  if (d.colIdAttr) { var v = el.getAttribute(d.colIdAttr); if (v !== null && v !== '') return v; }
  if (d.colIdClass) { var cl = Array.from(el.classList).filter(function (c) { return c.indexOf(d.colIdClass) === 0; })[0]; if (cl) return cl.slice(d.colIdClass.length); }
  return 'pos:' + pos;
}
function headerText(h, d) {
  var t = d.headerText ? h.querySelector(d.headerText) : null;
  var s = text(t || h);
  if (!s) s = norm(h.getAttribute('aria-label') || h.getAttribute('title') || h.getAttribute('data-title') || '');
  return s;
}
function columns(g, d) {
  var hs = headerCells(g, d);
  var cols = hs.map(function (h, i) {
    var r = h.getBoundingClientRect();
    var ci = Number(h.getAttribute('aria-colindex'));
    return { id: colIdOf(h, d, i), text: headerText(h, d), pos: i, colindex: isFinite(ci) && ci > 0 ? ci : null, left: r.left, width: r.width, el: h };
  });
  var seen = {};
  cols = cols.filter(function (c) { if (seen[c.id]) return false; seen[c.id] = 1; return true; });
  if (cols.length && cols.every(function (c) { return c.colindex !== null; })) cols.sort(function (a, b) { return a.colindex - b.colindex; });
  else if (cols.length && cols.every(function (c) { return c.width > 0; })) cols.sort(function (a, b) { return a.left - b.left; });
  cols.forEach(function (c, i) { c.order = i; });
  return cols;
}
function hSweepColumns(g, d) {
  var cols = columns(g, d);
  var hs = d.hViewport ? q1(g, d.hViewport) : null;
  if (!hs || hs.scrollWidth <= hs.clientWidth + 2) return Promise.resolve(cols);
  var start = hs.scrollLeft, all = {}, list = [];
  function add(cs, off) { cs.forEach(function (c) { if (!all[c.id]) { all[c.id] = c; c.hOffset = off; list.push(c); } }); }
  add(cols, start);
  return (async function () {
    for (var x = 0; x <= hs.scrollWidth; x += Math.max(50, hs.clientWidth * 0.8)) {
      hs.scrollLeft = x; await frame(); add(columns(g, d), hs.scrollLeft);
      if (hs.scrollLeft + hs.clientWidth >= hs.scrollWidth - 1) break;
    }
    hs.scrollLeft = start; await frame();
    var ordered = list.slice().sort(function (a, b) { return (a.colindex || 0) - (b.colindex || 0) || a.pos - b.pos; });
    ordered.forEach(function (c, i) { c.order = i; });
    return ordered;
  })();
}
/** Column virtualization: when known columns are missing from the rendered rows, sweep horizontally and merge. */
async function widen(g, d, cols, rows) {
  var hs = d.hViewport ? q1(g, d.hViewport) : null;
  if (!hs || hs.scrollWidth <= hs.clientWidth + 2 || !rows.length) return rows;
  var named = cols.filter(function (c) { return c.text; });
  var missing = function () { return rows.some(function (r) { return named.some(function (c) { return r.cells[c.id] === undefined; }); }); };
  if (!missing()) return rows;
  var byKey = {};
  rows.forEach(function (r) { byKey[r.key] = r; });
  var start = hs.scrollLeft;
  for (var x = 0; x <= hs.scrollWidth; x += Math.max(50, hs.clientWidth * 0.8)) {
    hs.scrollLeft = x; await frame();
    harvest(g, d, cols).forEach(function (r) { var t = byKey[r.key]; if (!t) return; Object.keys(r.cells).forEach(function (k) { if (t.cells[k] === undefined || t.cells[k] === '') t.cells[k] = r.cells[k]; }); });
    if (!missing() || hs.scrollLeft + hs.clientWidth >= hs.scrollWidth - 1) break;
  }
  hs.scrollLeft = start; await frame();
  return rows;
}
function dataRows(g, d) {
  var rs = qa(g, d.row).filter(function (r) { return gridOwned(g, r, d) && !matches(r, d.rowExclude) && !r.querySelector('[role=columnheader]') && !(r.parentElement && r.parentElement.tagName === 'THEAD'); });
  if (d.generic) {
    rs = rs.filter(function (r) { return r.querySelector('td,[role=gridcell],[role=cell]'); });
    // Rows in a header row group (column headers, filter rows) are not data rows.
    var groups = qa(g, '[role=rowgroup]').filter(function (x) { return gridOwned(g, x, d); });
    if (groups.length > 1) rs = rs.filter(function (r) { var rg = r.closest('[role=rowgroup]'); return !(rg && rg.querySelector('[role=columnheader]')); });
  }
  return rs;
}
function rowCells(row, d) {
  return qa(row, d.cell).filter(function (c) { return c.closest(d.rowClosest || d.row) === row; });
}
function cellText(c, d) {
  if (d.cellText) { var s = c.querySelector(d.cellText); if (s) return text(s); }
  var inp = c.querySelector('input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea, select');
  if (inp && !text(c)) return norm(inp.value);
  return text(c);
}
function harvest(g, d, cols) {
  var byId = {};
  cols.forEach(function (c) { byId[c.id] = c; });
  var out = {}, order = [];
  dataRows(g, d).forEach(function (r, i) {
    var cells = {};
    rowCells(r, d).forEach(function (c, ci) {
      var id = colIdOf(c, d, ci);
      if (!byId[id] && d.cellColAttr) { var v = c.getAttribute(d.cellColAttr); if (v) id = v; }
      if (cells[id] === undefined || cells[id] === '') cells[id] = cellText(c, d);
    });
    var key = d.rowKeyAttr ? r.getAttribute(d.rowKeyAttr) : null;
    var rawIdx = d.rowIndexAttr ? r.getAttribute(d.rowIndexAttr) : null;
    var idx = rawIdx !== null && rawIdx !== '' ? Number(rawIdx) : NaN;
    if (key === null || key === '') key = isFinite(idx) ? String(idx) : d._ck ? 'txt:' + cols.map(function (c) { return cells[c.id] || ''; }).join('' + String.fromCharCode(0x241f) + '') : (d._page ? 'p' + d._page + ':' : '') + 'dom:' + i;
    if (!isFinite(idx)) idx = d._ck ? NaN : i;
    var rec = out[key];
    if (!rec) { rec = out[key] = { key: key, index: idx, cells: {}, els: [] }; order.push(rec); }
    rec.els.push(r);
    Object.keys(cells).forEach(function (k) { if (rec.cells[k] === undefined || rec.cells[k] === '') rec.cells[k] = cells[k]; });
  });
  return order;
}
function scroller(g, d) {
  if (d.viewport) { var v = qa(g, d.viewport).filter(function (x) { return gridOwned(g, x, d) || x === g; })[0]; if (v && v.scrollHeight > v.clientHeight + 2) return v; if (v && !d.generic) return null; }
  var r = dataRows(g, d)[0];
  var el = r ? r.parentElement : null;
  while (el && el !== g.parentElement) {
    var cs = getComputedStyle(el);
    if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 2) return el;
    el = el.parentElement;
  }
  return null;
}
function scrollTo(sc, top) { sc.scrollTop = top; }
function rowSig(r) { return r ? r.key + '=' + Object.keys(r.cells).map(function (k) { return r.cells[k]; }).join('|') : ''; }
function sigOf(rows) { return rows.length + ':' + rowSig(rows[0]) + ':' + rowSig(rows[rows.length - 1]); }
function resolveColumn(cols, name) {
  var n = norm(name), lc = n.toLowerCase();
  var hit = cols.filter(function (c) { return c.text === n; });
  if (!hit.length) hit = cols.filter(function (c) { return c.text.toLowerCase() === lc; });
  if (!hit.length) hit = cols.filter(function (c) { return c.id === n || c.id.toLowerCase() === lc; });
  if (hit.length === 1) return hit[0];
  if (hit.length > 1) throw new Error('column "' + name + '" is ambiguous (' + hit.length + ' columns have that header)');
  throw new Error('no column "' + name + '" (columns: ' + cols.filter(function (c) { return c.text; }).map(function (c) { return '"' + c.text + '"'; }).join(', ') + ')');
}
function resolveWhere(where, cols) {
  return (where || []).map(function (w) { var c = resolveColumn(cols, w.column); return { id: c.id, column: c.text, op: w.op || 'equals', value: w.value }; });
}
function rowMatches(r, where) { return where.every(function (w) { return test(r.cells[w.id] === undefined ? '' : r.cells[w.id], w.op, w.value); }); }
function pub(r, cols) { var cells = {}; cols.forEach(function (c) { if (c.text && r.cells[c.id] !== undefined) cells[c.text] = r.cells[c.id]; }); return { key: r.key, index: isFinite(r.index) ? r.index : null, cells: cells }; }
function prep(g, d, a) { d._page = a && a.page; d._ck = !d.rowKeyAttr && !d.rowIndexAttr && !!scroller(g, d); }
function pubCols(cols) { return cols.map(function (c) { return { id: c.id, text: c.text, order: c.order }; }); }
function contiguous(rows) { if (!rows.length) return false; for (var i = 1; i < rows.length; i++) if (rows[i].index !== rows[i - 1].index + 1) return false; return true; }

function fullSig(rows) { return rows.map(function (r) { return r.key + '=' + Object.keys(r.cells).length + ':' + Object.keys(r.cells).map(function (k) { return r.cells[k]; }).join('|'); }).join('\n'); }
/** Every row has a cell for every column the header renders right now (cells are not still being created). */
function complete(g, d, rows) {
  var ids = columns(g, d).filter(function (c) { return c.text; }).map(function (c) { return c.id; });
  return rows.every(function (r) { return ids.every(function (id) { return r.cells[id] !== undefined; }); });
}
/**
 * After a scroll: wait until the rendered rows changed, then until they are
 * complete and stable (libraries render rows first and fill cells over the
 * next frames when scrolling fast).
 */
async function settleAfterScroll(g, d, cols, before, maxFrames) {
  var rows = null;
  for (var i = 0; i < (maxFrames || 30); i++) {
    await frame();
    rows = harvest(g, d, cols);
    if (sigOf(rows) !== before) break;
  }
  if (!d.extraFrame && complete(g, d, rows)) return rows;
  var prev = fullSig(rows);
  for (var k = 0; k < 20; k++) {
    await frame();
    var next = harvest(g, d, cols), sig = fullSig(next);
    if (complete(g, d, next) && (sig === prev || !d.extraFrame)) return next;
    rows = next; prev = sig;
  }
  return rows;
}
function advanceBy(sc, rows) {
  var step = sc.clientHeight * 0.8;
  var sorted = rows.slice().sort(function (a, b) { return a.index - b.index; });
  if (sorted.length > 2 && contiguous(sorted)) {
    // The rendered window (visible rows plus the library's buffer) moves with scrollTop:
    // shifting by (rendered - 1) rows makes the next window start at the last row read.
    var last = sorted[sorted.length - 1].els[0].getBoundingClientRect();
    var first = sorted[0].els[0].getBoundingClientRect();
    var h = (last.top - first.top) / (sorted.length - 1);
    var span = h * (sorted.length - 2);
    if (h > 0 && span > step) step = span;
  }
  return Math.max(10, step);
}
E.gridState = function (el, a) {
  var d = a.d, g = need(el, d, 'grid');
  prep(g, d, a);
  var cols = columns(g, d);
  var rows = harvest(g, d, cols);
  var busy = !!(d.busy && qa(g.parentElement || g, d.busy).some(visible)) || g.getAttribute('aria-busy') === 'true';
  return { columns: pubCols(cols), rows: rows.length, sig: sigOf(rows), busy: busy, scrollable: !!scroller(g, d), firstRows: rows.slice(0, 3).map(function (r) { return pub(r, cols); }) };
};
E.gridColumns = async function (el, a) {
  var d = a.d, g = need(el, d, 'grid');
  return pubCols(await hSweepColumns(g, d));
};
/** Scan the grid (scrolling virtualized content): find rows matching where, or collect all rows. */
E.gridScan = async function (el, a) {
  var d = a.d, g = need(el, d, 'grid');
  prep(g, d, a);
  var t0 = performance.now();
  var cols = await hSweepColumns(g, d);
  var where = resolveWhere(a.where, cols);
  var sc = scroller(g, d);
  var seen = {}, all = [], matches = [], steps = 0, truncated = false, gaps = 0;
  var deadline = t0 + (a.budgetMs || 20000);
  var matched = {};
  function take(rows) {
    rows.forEach(function (r) {
      var cur = seen[r.key];
      if (cur) {
        // Seen before: fill cells it lacked (column virtualization) and test it again.
        var grew = false;
        Object.keys(r.cells).forEach(function (k) { if (cur.cells[k] === undefined || cur.cells[k] === '') { if (r.cells[k] !== '' || cur.cells[k] === undefined) grew = true; cur.cells[k] = r.cells[k]; } });
        if (!grew || matched[cur.key]) return;
        r = cur;
      } else { seen[r.key] = r; all.push(r); }
      if (matched[r.key]) return;
      if (where.length ? rowMatches(r, where) : !!a.collect) { matched[r.key] = 1; matches.push(r); }
    });
  }
  var rows = harvest(g, d, cols);
  if (sc && a.fromTop !== false && sc.scrollTop > 0) { var b0 = sigOf(rows); scrollTo(sc, 0); rows = await settleAfterScroll(g, d, cols, b0, 10); }
  take(await widen(g, d, cols, rows));
  var maxIdx = rows.reduce(function (m, r) { return Math.max(m, r.index); }, -1);
  while (sc) {
    if (a.first && matches.length) break;
    if (all.length >= (a.maxRows || 1e9)) { truncated = true; break; }
    if (performance.now() > deadline) { truncated = true; break; }
    var atEnd = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
    if (atEnd) {
      if (!d.loadMoreWaitMs) break;
      var h0 = sc.scrollHeight, grown = false;
      for (var w = 0; w < d.loadMoreWaitMs / 50; w++) { await sleep(50); if (sc.scrollHeight > h0 + 2 || (d.busy && qa(g, d.busy).some(visible))) { grown = sc.scrollHeight > h0 + 2; if (grown) break; } }
      if (!grown) break;
    }
    var before = sigOf(rows), top = sc.scrollTop, step = advanceBy(sc, rows);
    scrollTo(sc, top + step);
    if (sc.scrollTop === top && !atEnd) break;
    rows = await settleAfterScroll(g, d, cols, before);
    steps++;
    var numeric = rows.length && rows.every(function (r) { return isFinite(r.index); });
    if (numeric && maxIdx >= 0) {
      var minIdx = rows.reduce(function (m, r) { return Math.min(m, r.index); }, Infinity);
      var back = step / 2;
      while (minIdx > maxIdx + 1 && back > 5) {
        gaps++; var b2 = sigOf(rows); scrollTo(sc, sc.scrollTop - back); rows = await settleAfterScroll(g, d, cols, b2); take(await widen(g, d, cols, rows));
        minIdx = rows.reduce(function (m, r) { return Math.min(m, r.index); }, Infinity);
        back = back / 2;
      }
    }
    take(await widen(g, d, cols, rows));
    maxIdx = all.reduce(function (m, r) { return Math.max(m, r.index); }, maxIdx);
  }
  var numericAll = all.every(function (r) { return isFinite(r.index); });
  if (numericAll) all.sort(function (x, y) { return x.index - y.index; });
  var res = {
    columns: pubCols(cols), total: all.length, where: where.map(function (w) { return { column: w.column, op: w.op, value: w.value }; }),
    matches: a.countOnly ? [] : matches.map(function (r) { return pub(r, cols); }), matchCount: matches.length,
    truncated: truncated, steps: steps, gaps: gaps, virtualized: !!sc, ms: Math.round(performance.now() - t0),
  };
  if (a.collect) res.rows = (where.length ? matches : all).map(function (r) { return pub(r, cols); });
  return res;
};
/** Bring the row with this key into view (scrolling virtualized content) and mark the row and its cells. */
E.gridReveal = async function (el, a) {
  var d = a.d, g = need(el, d, 'grid');
  prep(g, d, a);
  var cols = await hSweepColumns(g, d);
  var sc = scroller(g, d);
  function find() { return harvest(g, d, cols).filter(function (r) { return r.key === a.key; })[0]; }
  var r = find();
  if (!r && sc) {
    var rows = harvest(g, d, cols);
    if (isFinite(a.index) && rows.length && rows.every(function (x) { return isFinite(x.index); })) {
      for (var i = 0; i < 40 && !r; i++) {
        var sorted = rows.slice().sort(function (x, y) { return x.index - y.index; });
        var f = sorted[0], l = sorted[sorted.length - 1];
        var h = Math.max(1, (l.els[0].getBoundingClientRect().bottom - f.els[0].getBoundingClientRect().top) / sorted.length);
        var mid = (f.index + l.index) / 2;
        var before = sigOf(rows);
        sc.scrollTop = Math.max(0, sc.scrollTop + (a.index - mid) * h);
        rows = await settleAfterScroll(g, d, cols, before, 10);
        r = find();
      }
    }
    if (!r) {
      var b = sigOf(harvest(g, d, cols));
      sc.scrollTop = 0; await settleAfterScroll(g, d, cols, b, 10);
      for (var j = 0; j < 5000 && !(r = find()); j++) {
        var rs = harvest(g, d, cols), bf = sigOf(rs), t = sc.scrollTop;
        sc.scrollTop = t + advanceBy(sc, rs);
        if (sc.scrollTop === t) break;
        await settleAfterScroll(g, d, cols, bf);
      }
    }
  }
  if (!r) return { found: false };
  var target = r.els[r.els.length > 1 ? r.els.length - 1 : 0];
  if (sc) {
    var sr = sc.getBoundingClientRect(), rr = target.getBoundingClientRect();
    var head = 0;
    cols.forEach(function (c) { if (c.el && sc.contains(c.el)) { var hr = c.el.getBoundingClientRect(); head = Math.max(head, hr.bottom - sr.top); } });
    if (d.stickyHeader) head = Math.max(head, d.stickyHeader);
    if (rr.top < sr.top + head || rr.bottom > sr.bottom) {
      var bs = sigOf(harvest(g, d, cols));
      sc.scrollTop += rr.top - sr.top - head - Math.max(0, (sc.clientHeight - head) / 3);
      await settleAfterScroll(g, d, cols, bs, 4);
      r = find() || r;
    }
  }
  target.scrollIntoView && (function () { var rr2 = target.getBoundingClientRect(); if (rr2.top < 0 || rr2.bottom > innerHeight) target.scrollIntoView({ block: 'center' }); })();
  if (a.colId) {
    var hs = d.hViewport ? q1(g, d.hViewport) : null;
    var col = cols.filter(function (c) { return c.id === a.colId; })[0];
    var rendered = r.els.some(function (re) { return rowCells(re, d).some(function (c, ci) { return colIdOf(c, d, ci) === a.colId && visible(c); }); });
    if (hs && col && !rendered) {
      for (var x = 0; x <= hs.scrollWidth && !rendered; x += Math.max(50, hs.clientWidth * 0.6)) {
        hs.scrollLeft = x; await frame(); await frame();
        r = find() || r;
        rendered = r.els.some(function (re) { return rowCells(re, d).some(function (c, ci) { return colIdOf(c, d, ci) === a.colId && visible(c); }); });
      }
    }
  }
  var out = { found: true, key: r.key, index: r.index, rows: [], cells: {}, row: pub(r, cols) };
  r.els.forEach(function (re) { out.rows.push(mark(re)); rowCells(re, d).forEach(function (c, ci) { var id = colIdOf(c, d, ci); if (!out.cells[id] || visible(c)) out.cells[id] = mark(c); }); });
  out.columns = pubCols(cols);
  return out;
};
function rowEls(a) { return (a.rows || []).map(byMark).filter(Boolean); }
/** Read the marked row again (after an action): its cells by column id. */
E.gridRowNow = function (el, a) {
  var d = a.d, g = need(el, d, 'grid');
  prep(g, d, a);
  var cols = columns(g, d);
  var r = harvest(g, d, cols).filter(function (x) { return x.key === a.key; })[0];
  if (!r) return { found: false };
  var res = pub(r, cols);
  res.found = true;
  res.byId = r.cells;
  res.selected = r.els.some(function (re) { return re.getAttribute('aria-selected') === 'true' || matches(re, d.selectedRow) || !!(d.selectedRowInner && re.querySelector(d.selectedRowInner)); });
  var cb = null;
  r.els.forEach(function (re) { cb = cb || q1(re, d.rowCheckbox || 'input[type=checkbox], [role=checkbox]'); });
  if (cb) res.checked = cb.checked === true || cb.getAttribute('aria-checked') === 'true' || matches(cb, d.checkboxChecked);
  var ex = null;
  r.els.forEach(function (re) { ex = ex || (d.rowExpander ? q1(re, d.rowExpander) : null) || q1(re, '[aria-expanded]'); });
  if (ex) res.expanded = ex.getAttribute('aria-expanded') === 'true' || matches(ex, d.rowExpandedState);
  else if (r.els.some(function (re) { return re.getAttribute('aria-expanded') !== null; })) res.expanded = r.els.some(function (re) { return re.getAttribute('aria-expanded') === 'true'; });
  return res;
};
/** Mark a control inside a revealed row: its checkbox, its expander, or a button/link by name. */
E.gridRowControl = function (el, a) {
  var d = a.d;
  var rows = rowEls(a);
  if (!rows.length) return { error: 'the row is no longer rendered' };
  var hits = [];
  rows.forEach(function (re) {
    if (a.what === 'checkbox') hits = hits.concat(qa(re, d.rowCheckboxClick || d.rowCheckbox || 'input[type=checkbox], [role=checkbox]').slice(0, 1));
    else if (a.what === 'expander') hits = hits.concat(qa(re, d.rowExpander || '[aria-expanded]').slice(0, 1));
    else {
      var n = norm(a.name).toLowerCase();
      hits = hits.concat(qa(re, 'button, a, [role=button], [role=link], [role=menuitem], input[type=button], input[type=submit]').filter(function (b) { return visible(b) && (accName(b).toLowerCase() === n || text(b).toLowerCase() === n || norm(b.getAttribute('title')).toLowerCase() === n); }));
    }
  });
  if (hits.length === 0) return { error: a.what === 'name' ? 'no button or link "' + a.name + '" in the row' : 'the row has no ' + a.what };
  if (hits.length > 1 && a.what === 'name') return { error: hits.length + ' controls named "' + a.name + '" in the row' };
  return { tag: mark(hits[0]) };
};
E.gridHeader = function (el, a) {
  var d = a.d, g = need(el, d, 'grid');
  var cols = columns(g, d);
  var c = resolveColumn(cols, a.column);
  var h = c.el;
  var state = 'none';
  var as = h.getAttribute('aria-sort');
  if (as === 'ascending') state = 'asc'; else if (as === 'descending') state = 'desc';
  else {
    if (d.sortAsc && (matches(h, d.sortAsc) || qa(h, d.sortAsc).some(visible))) state = 'asc';
    if (d.sortDesc && (matches(h, d.sortDesc) || qa(h, d.sortDesc).some(visible))) state = 'desc';
  }
  var clickEl = (d.sortClick && qa(h, d.sortClick).filter(visible)[0]) || h;
  return { id: c.id, text: c.text, state: state, tag: mark(clickEl), header: mark(h) };
};
/** The filter input aligned under a column header (filter row), else the grid's quick filter. */
E.gridFilterTarget = function (el, a) {
  var d = a.d, g = need(el, d, 'grid');
  var cols = columns(g, d);
  var c = resolveColumn(cols, a.column);
  var hr = c.el.getBoundingClientRect();
  var rows = dataRows(g, d);
  var inRows = function (x) { return rows.some(function (r) { return r.contains(x); }); };
  var inputs = qa(g, 'input, textarea').filter(function (i) {
    if (!visible(i) || inRows(i) || /^(checkbox|radio|hidden|button|submit)$/i.test(i.type) || i.disabled) return false;
    var r = i.getBoundingClientRect(); var cx = r.left + r.width / 2;
    return cx >= hr.left - 1 && cx <= hr.right + 1 && r.top >= hr.top + hr.height / 2 - 2;
  });
  inputs.sort(function (x, y) { return x.getBoundingClientRect().top - y.getBoundingClientRect().top; });
  if (inputs.length) return { mode: 'column', tag: mark(inputs[0]), column: c.text };
  var scopes = [g]; var p = g.parentElement;
  for (var k = 0; k < 3 && p; k++) { scopes.push(p); p = p.parentElement; }
  for (var s = 0; s < scopes.length; s++) {
    var qf = qa(scopes[s], d.quickFilter || 'input[type=search], [role=searchbox], input[placeholder*="earch" i], input[placeholder*="ilter" i], input[aria-label*="earch" i], input[aria-label*="ilter" i]').filter(function (i) { return visible(i) && !inRows(i); });
    if (qf.length === 1) return { mode: 'quick', tag: mark(qf[0]), column: c.text };
    if (qf.length > 1) return { error: qf.length + ' search fields next to the grid; cannot pick one strictly' };
  }
  if (d.quickFilterOpen) { var op = qa(g, d.quickFilterOpen).filter(visible)[0]; if (op) return { mode: 'open', tag: mark(op) }; }
  return { error: 'the grid has no filter field for "' + c.text + '" and no search field' };
};
E.gridPager = function (el, a) {
  var d = a.d, g = need(el, d, 'grid');
  if (!d.pagerNext && !d.loadMore) return { pager: false };
  var scope = g, found = null;
  for (var k = 0; k < 3 && scope; k++) {
    var n = d.pagerNext ? qa(scope, d.pagerNext).filter(visible) : [];
    var m = d.loadMore ? qa(scope, d.loadMore).filter(visible) : [];
    if (n.length === 1 || m.length === 1) { found = { next: n[0] || null, more: m[0] || null, scope: scope }; break; }
    if (n.length > 1) return { pager: false, error: n.length + ' pagers near the grid' };
    scope = scope.parentElement;
  }
  if (!found) return { pager: false };
  var first = d.pagerFirst ? qa(found.scope, d.pagerFirst).filter(visible)[0] : null;
  var prev = d.pagerPrev ? qa(found.scope, d.pagerPrev).filter(visible)[0] : null;
  return {
    pager: true,
    next: found.next && !disabled(found.next) ? mark(found.next) : null,
    more: found.more && !disabled(found.more) ? mark(found.more) : null,
    first: first && !disabled(first) ? mark(first) : null,
    prev: prev && !disabled(prev) ? mark(prev) : null,
  };
};
E.gridEditor = function (el, a) {
  var d = a.d;
  var cell = byMark(a.cell);
  var sel = d.editor || 'input:not([type=checkbox]):not([type=hidden]), textarea, select, [contenteditable=true]';
  var ed = cell ? qa(cell, sel).filter(visible)[0] : null;
  if (!ed) { var ae = document.activeElement; if (ae && matches(ae, sel) && visible(ae)) ed = ae; }
  if (!ed && d.editorPopup) ed = qa(document, d.editorPopup).filter(visible).pop() || null;
  if (!ed) return { found: false };
  return { found: true, tag: mark(ed), tag2: ed.tagName.toLowerCase(), type: ed.type || '', contenteditable: ed.isContentEditable };
};

// ------------------------------------------------------------ combobox / select
function comboParts(el, d) {
  var root = need(el, d, 'combobox');
  var input = matches(root, d.input) ? root : q1(root, d.input);
  if (!input && matches(el, 'input') && root.contains(el)) input = el;
  var trigger = d.trigger ? qa(root, d.trigger).filter(visible)[0] : null;
  return { root: root, input: input, trigger: trigger };
}
function comboPopup(p, d) {
  var ids = [];
  [p.input, p.root].forEach(function (x) { if (!x) return; ['aria-controls', 'aria-owns'].forEach(function (at) { var v = x.getAttribute(at); if (v) ids = ids.concat(v.split(/\s+/)); }); });
  for (var i = 0; i < ids.length; i++) { var e = document.getElementById(ids[i]); if (e && visible(e)) return e; }
  if (d.popup) { var cands = qa(document, d.popup).filter(visible); return cands.length ? cands[cands.length - 1] : null; }
  var lists = qa(p.root, '[role=listbox]').filter(visible);
  return lists.length === 1 ? lists[0] : null;
}
function optionText(o, d) { var t = d.optionText ? o.querySelector(d.optionText) : null; return text(t || o) || norm(o.getAttribute('aria-label') || ''); }
function displayValue(p, d) {
  var vals = [];
  if (d.chips) qa(p.root, d.chips).forEach(function (c) { var t = text(c); if (t) vals.push(t); });
  var v = '';
  if (d.valueText) { var vt = qa(p.root, d.valueText).filter(function (x) { return !matches(x, d.placeholder); })[0]; v = vt ? text(vt) : ''; }
  if (!v && p.input && 'value' in p.input && p.input.tagName !== 'SELECT') v = norm(p.input.value);
  if (!v && p.root.tagName === 'SELECT') v = Array.from(p.root.selectedOptions).map(function (o) { return norm(o.label); }).join(', ');
  if (!v && !p.input && !d.valueText) v = text(p.root);
  return { text: v, chips: vals };
}
E.comboInfo = function (el, a) {
  var d = a.d, p = comboParts(el, d);
  var target = p.input || p.root;
  var editable = !!(p.input && p.input.tagName === 'INPUT' && !p.input.readOnly && !p.input.disabled && !/^(button|checkbox|hidden)$/.test(p.input.type));
  var pop = comboPopup(p, d);
  return {
    root: mark(p.root), input: p.input ? mark(p.input) : null, trigger: p.trigger ? mark(p.trigger) : null, click: mark(d.openClick ? (q1(p.root, d.openClick) || target) : target),
    native: p.root.tagName === 'SELECT', editable: editable, disabled: disabled(target) || disabled(p.root),
    multiple: !!(d.multiple && matches(p.root, d.multiple)) || p.root.getAttribute('aria-multiselectable') === 'true' || !!(p.root.tagName === 'SELECT' && p.root.multiple),
    open: !!pop, value: displayValue(p, d),
  };
};
E.comboOptions = function (el, a) {
  var d = a.d, p = comboParts(el, d);
  var pop = comboPopup(p, d);
  if (!pop) return { open: false, options: [] };
  var opts = qa(pop, d.option || '[role=option]').filter(visible);
  var loading = !!(d.loading && qa(pop.closest(d.popupRoot || '*') || pop, d.loading).some(visible)) || pop.getAttribute('aria-busy') === 'true' || (!opts.length && /loading|searching|wird geladen/i.test(text(pop)));
  var search = d.popupSearch ? qa(document, d.popupSearch).filter(function (x) { return visible(x); }).pop() : null;
  var res = { open: true, popup: mark(pop), loading: loading, search: search ? mark(search) : null, options: opts.map(function (o) { return { text: optionText(o, d), selected: o.getAttribute('aria-selected') === 'true' || matches(o, d.optionSelected), disabled: disabled(o) }; }) };
  if (a.want !== undefined) {
    var w = norm(a.want);
    var hits = opts.filter(function (o) { return optionText(o, d) === w && !disabled(o); });
    if (!hits.length) hits = opts.filter(function (o) { return optionText(o, d).toLowerCase() === w.toLowerCase() && !disabled(o); });
    res.hits = hits.length;
    if (hits.length === 1) { res.tag = mark(d.optionClick ? (q1(hits[0], d.optionClick) || hits[0]) : hits[0]); res.selectedAlready = res.options[opts.indexOf(hits[0])].selected; }
  }
  return res;
};

// ------------------------------------------------------------ date pickers
var MONTHS = {};
function monthNames(locale) {
  if (MONTHS[locale]) return MONTHS[locale];
  var out = [];
  for (var m = 0; m < 12; m++) {
    var dt = new Date(Date.UTC(2021, m, 15));
    var names = [];
    ['long', 'short'].forEach(function (s) { try { names.push(new Intl.DateTimeFormat(locale, { month: s, timeZone: 'UTC' }).format(dt).toLowerCase().replace(/\.$/, '')); } catch (e) {} });
    try { names.push(new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(dt).toLowerCase()); names.push(new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(dt).toLowerCase()); } catch (e) {}
    out.push(names);
  }
  MONTHS[locale] = out;
  return out;
}
function pageLocale(el) { var l = (el && el.closest('[lang]')) || document.documentElement; return (l && l.getAttribute('lang')) || navigator.language || 'en-US'; }
E.locale = function (el) { return pageLocale(el); };
function parseMonthYear(s, locale) {
  var t = norm(s).toLowerCase();
  var y = (t.match(/\b(\d{4})\b/) || [])[1];
  if (!y) return null;
  var names = monthNames(locale), best = -1, bestLen = 0;
  names.forEach(function (ns, i) { ns.forEach(function (n) { if (n && n.length > bestLen && new RegExp('(^|[^\\p{L}])' + n.replace(/[.*+?^$()|[\]\\]/g, '\\$&') + '($|[^\\p{L}])', 'u').test(t)) { best = i; bestLen = n.length; } }); });
  if (best < 0) { var mm = t.replace(y, '').match(/\b(\d{1,2})\b/); if (mm) best = Number(mm[1]) - 1; }
  return best >= 0 ? { year: Number(y), month: best } : null;
}
E.parseMonthYear = function (el, a) { return parseMonthYear(a.text, a.locale || pageLocale(el)); };
function cellDate(c, d) {
  var f = d.dayDate || {};
  var v = f.attr ? (c.getAttribute(f.attr) || (q1(c, '[' + f.attr + ']') || { getAttribute: function () { return null; } }).getAttribute(f.attr)) : null;
  if (v === null || v === undefined) return null;
  if (f.format === 'ms') { var dt = new Date(Number(v)); return { y: dt.getFullYear(), m: dt.getMonth(), d: dt.getDate() }; }
  if (f.format === 'compact') return { y: Number(v.slice(0, 4)), m: Number(v.slice(4, 6)) - 1, d: Number(v.slice(6, 8)) };
  var parts = v.match(/\d+/g);
  if (!parts || parts.length < 3) return null;
  return { y: Number(parts[0]), m: Number(parts[1]) - (f.monthBase === 0 ? 0 : 1), d: Number(parts[2]) };
}
function calendarPopup(el, d) {
  var root = rootFor(el, d.root).el || el;
  var ids = [];
  [root, q1(root, 'input'), q1(root, '[aria-controls]')].forEach(function (x) { if (x) ['aria-controls', 'aria-owns'].forEach(function (at) { var v = x.getAttribute(at); if (v) ids = ids.concat(v.split(/\s+/)); }); });
  for (var i = 0; i < ids.length; i++) { var e = document.getElementById(ids[i]); if (e && visible(e) && (!d.day || q1(e, d.day))) return e; }
  var cands = qa(document, d.popup).filter(function (x) { return visible(x) && (!d.day || q1(x, d.day)); });
  return cands.length ? cands[cands.length - 1] : null;
}
function dayCells(pop, d) { return qa(pop, d.day).filter(function (c) { return visible(c) && !matches(c, d.dayOutside) && !(d.dayOutside && c.closest(d.dayOutside)); }); }
E.dateInfo = function (el, a) {
  var d = a.d;
  var root = need(el, d, 'date picker');
  var input = matches(root, 'input') ? root : (qa(root, d.input || 'input').filter(function (i) { return i.type !== 'hidden' && (visible(i) || i.getAttribute('aria-hidden') !== 'true'); })[0] || null);
  var sections = d.sections ? qa(root, d.sections) : [];
  var value = sections.length ? sections.map(function (s) { return text(s); }).join(' ') : input ? norm(input.value) : '';
  var shown = d.valueText ? text(q1(root, d.valueText)) : '';
  var toggle = d.toggle ? qa(root, d.toggle).filter(visible)[0] : null;
  return {
    root: mark(root), input: input ? mark(input) : null, type: input ? input.type : '', placeholder: input ? norm(input.getAttribute('placeholder')) : '',
    sections: sections.map(function (s) { return { tag: mark(s), label: norm(s.getAttribute('aria-label')), text: text(s), placeholder: text(s) }; }),
    sectionsText: sections.length ? text(q1(root, d.sectionsRoot || '*') || root) : '',
    hiddenValue: d.hiddenValue ? norm((q1(root, d.hiddenValue) || {}).value) : '',
    value: value || shown, toggle: toggle ? mark(toggle) : null, readOnly: !!(input && input.readOnly), locale: pageLocale(root), open: !!calendarPopup(el, d),
  };
};
E.calendar = function (el, a) {
  var d = a.d;
  var pop = calendarPopup(el, d);
  if (!pop) return { open: false };
  var locale = a.locale || pageLocale(el);
  var cells = dayCells(pop, d);
  var counts = {}, shown = null;
  cells.forEach(function (c) { var cd = cellDate(c, d); if (cd) { var k = cd.y + '-' + cd.m; counts[k] = (counts[k] || 0) + 1; } });
  var best = Object.keys(counts).sort(function (x, y) { return counts[y] - counts[x]; })[0];
  if (best) shown = { year: Number(best.split('-')[0]), month: Number(best.split('-')[1]) };
  if (!shown && d.title) { var titles = qa(pop, d.title).filter(visible).map(text).join(' '); shown = parseMonthYear(titles, locale); }
  var prev = d.prev ? qa(pop, d.prev).filter(visible)[0] : null;
  var next = d.next ? qa(pop, d.next).filter(visible)[0] : null;
  var res = { open: true, popup: mark(pop), shown: shown, title: d.title ? qa(pop, d.title).filter(visible).map(text).join(' ') : '', prev: prev ? mark(prev) : null, next: next ? mark(next) : null };
  if (a.want) {
    var w = a.want, hit = cells.filter(function (c) { var cd = cellDate(c, d); return cd && cd.y === w.y && cd.m === w.m && cd.d === w.d; });
    if (!hit.length && d.dayLabel) {
      var long = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(w.y, w.m, w.d));
      hit = cells.filter(function (c) { var l = norm(c.getAttribute('aria-label') || (q1(c, '[aria-label]') || { getAttribute: function () { return ''; } }).getAttribute('aria-label')); return l === long || l.indexOf(long) >= 0; });
    }
    if (!hit.length && shown && shown.year === w.y && shown.month === w.m) hit = cells.filter(function (c) { return text(d.dayText ? (q1(c, d.dayText) || c) : c) === String(w.d); });
    res.hits = hit.length;
    if (hit.length === 1) res.tag = mark(d.dayClick ? (q1(hit[0], d.dayClick) || hit[0]) : hit[0]);
  }
  return res;
};

// ------------------------------------------------------------ trees
function treeLabel(it, d) {
  var lab = d.label ? qa(it, d.label).filter(function (x) { return x.closest(d.item) === it; })[0] : null;
  if (lab) return text(lab);
  var s = '';
  (function walk(n) { Array.from(n.childNodes).forEach(function (c) { if (c.nodeType === 3) s += c.textContent + ' '; else if (c.nodeType === 1 && !matches(c, d.item) && !matches(c, d.group || '[role=group]') && c.getAttribute('aria-hidden') !== 'true') walk(c); }); })(it);
  return norm(s);
}
E.treeItems = function (el, a) {
  var d = a.d, t = need(el, d, 'tree');
  var items = qa(t, d.item).filter(function (it) { return visible(it) || (d.labelVisible && qa(it, d.label).some(visible)); });
  return items.map(function (it) {
    var lvl = Number(it.getAttribute('aria-level'));
    if (!isFinite(lvl) || lvl <= 0) { lvl = 1; var p = it.parentElement; while (p && p !== t) { if (matches(p, d.item)) lvl++; p = p.parentElement; } }
    var exp = it.getAttribute('aria-expanded');
    if (exp === null && d.expandedState) exp = matches(it, d.expandedState) || !!q1(it, d.expandedState) ? 'true' : (d.collapsedState && (matches(it, d.collapsedState) || q1(it, d.collapsedState)) ? 'false' : null);
    var tog = d.toggle ? qa(it, d.toggle).filter(function (x) { return x.closest(d.item) === it && visible(x); })[0] : null;
    return { tag: mark(it), label: treeLabel(it, d), level: lvl, expanded: exp === 'true' ? true : exp === 'false' ? false : null, selected: it.getAttribute('aria-selected') === 'true' || matches(it, d.selectedState), toggle: tog ? mark(tog) : null, click: mark((d.label && qa(it, d.label).filter(function (x) { return x.closest(d.item) === it; })[0]) || it) };
  });
};

// ------------------------------------------------------------ tabs, accordions
E.tabs = function (el, a) {
  var d = a.d, root = need(el, d, 'tab set');
  var tabs = qa(root, d.tab).filter(function (t) { return visible(t) && (!d.tabOwner || t.closest(d.tabOwner) === (matches(root, d.tabOwner) ? root : t.closest(d.tabOwner))); });
  return tabs.map(function (t) {
    var panel = null, pid = t.getAttribute('aria-controls');
    if (pid) panel = document.getElementById(pid);
    return { tag: mark(t), label: d.tabLabel ? text(q1(t, d.tabLabel) || t) : (text(t) || accName(t)), selected: t.getAttribute('aria-selected') === 'true' || matches(t, d.tabSelected) || !!(t.parentElement && matches(t.parentElement, d.tabSelected)), disabled: disabled(t), panelVisible: panel ? visible(panel) : null };
  });
};
E.accordion = function (el, a) {
  var d = a.d, root = need(el, d, 'accordion');
  return qa(root, d.header).filter(visible).map(function (h) {
    var ex = h.getAttribute('aria-expanded'); var exEl = h;
    if (ex === null) { exEl = q1(h, '[aria-expanded]') || h; ex = exEl.getAttribute('aria-expanded'); }
    return { tag: mark(h), label: d.headerLabel ? text(q1(h, d.headerLabel) || h) : text(h), expanded: ex === 'true' || matches(h, d.expandedState) };
  });
};

// ------------------------------------------------------------ dialogs
function zOf(el) { var z = 0; for (var p = el; p && p !== document.documentElement; p = p.parentElement) { var v = Number(getComputedStyle(p).zIndex); if (isFinite(v) && v > z) z = v; } return z; }
function dialogTitle(dl, d) {
  var lb = dl.getAttribute('aria-labelledby');
  if (lb) { var s = lb.split(/\s+/).map(function (id) { var x = document.getElementById(id); return x ? text(x) : ''; }).join(' '); if (norm(s)) return norm(s); }
  if (dl.getAttribute('aria-label')) return norm(dl.getAttribute('aria-label'));
  var t = q1(dl, d.title || 'h1, h2, h3, [role=heading]');
  return t ? text(t) : '';
}
E.dialogs = function (el, a) {
  var d = a.d;
  var list = qa(document, d.dialog).filter(visible);
  list = list.filter(function (x) { return !list.some(function (o) { return o !== x && o.contains(x); }); });
  var items = list.map(function (dl, i) { return { el: dl, z: zOf(dl), i: i }; });
  items.sort(function (x, y) { return x.z - y.z || x.i - y.i; });
  return items.map(function (it, k) { return { tag: mark(it.el), title: dialogTitle(it.el, d), level: k + 1 }; });
};
E.dialogControl = function (el, a) {
  var d = a.d, dl = byMark(a.dialog);
  if (!dl) return { error: 'the dialog is gone' };
  if (a.what === 'close') {
    var c = qa(dl, d.close || '[aria-label="Close" i], [title="Close" i], button.close').filter(function (b) { return visible(b) && b.closest(d.dialog) === dl; })[0];
    return c ? { tag: mark(c) } : { error: 'no close button' };
  }
  var n = norm(a.name).toLowerCase();
  var hits = qa(dl, 'button, a, [role=button], input[type=button], input[type=submit], [role=menuitem], [role=link], [role=tab], [role=checkbox]').filter(function (b) {
    if (!visible(b)) return false;
    var inner = b.closest(d.dialog); if (inner !== dl) return false;
    return accName(b).toLowerCase() === n || text(b).toLowerCase() === n || norm(b.value || '').toLowerCase() === n;
  });
  if (!hits.length) return { error: 'no button or link "' + a.name + '" in the dialog' };
  if (hits.length > 1) return { error: hits.length + ' controls named "' + a.name + '" in the dialog' };
  return { tag: mark(hits[0]) };
};

// ------------------------------------------------------------ toasts
E.toastWatch = function (el, a) {
  if (window.__ezcToasts && window.__ezcToasts.sel === a.selector) return true;
  var seen = window.__ezcToasts = { sel: a.selector, items: [] };
  function rec(n) {
    if (n.nodeType !== 1) return;
    var hits = matches(n, a.selector) ? [n] : qa(n, a.selector);
    hits.forEach(function (h) { setTimeout(function () { var t = text(h); if (t && !seen.items.some(function (x) { return x.text === t && Date.now() - x.at < 50; })) seen.items.push({ text: t, at: Date.now() }); if (seen.items.length > 200) seen.items.shift(); }, 30); });
  }
  new MutationObserver(function (ms) { ms.forEach(function (m) { if (m.type === 'childList') m.addedNodes.forEach(rec); else if (m.type === 'characterData' && m.target.parentElement) rec(m.target.parentElement.closest(a.selector) || document.createElement('i')); }); })
    .observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  qa(document, a.selector).forEach(rec);
  return true;
};
E.toasts = function (el, a) {
  var vis = qa(document, a.selector).filter(visible).map(text).filter(Boolean);
  var seen = window.__ezcToasts ? window.__ezcToasts.items.map(function (x) { return x.text; }) : [];
  return { visible: vis, seen: seen, watching: !!window.__ezcToasts };
};

// ------------------------------------------------------------ rich text
E.editorInfo = function (el, a) {
  var d = a.d, root = need(el, d, 'editor');
  if (d.iframe) {
    var f = qa(root, d.iframe).filter(visible)[0];
    if (f) { var body = null; try { body = f.contentDocument && f.contentDocument.body; } catch (e) {} return { kind: 'iframe', tag: mark(f), text: body ? text(body) : '', html: body ? body.innerHTML : '' }; }
  }
  var ed = matches(root, d.editable) ? root : qa(root, d.editable).filter(visible)[0];
  if (!ed && root.isContentEditable) ed = root;
  if (!ed) return { error: 'no editable area found in the ' + d.id + ' editor' };
  return { kind: 'contenteditable', tag: mark(ed), text: text(ed), html: ed.innerHTML };
};

// ------------------------------------------------------------ sliders
E.sliderInfo = function (el, a) {
  var d = a.d, root = need(el, d, 'slider');
  var hs = qa(root, d.handle).filter(function (h) { return visible(h) || (h.tagName === 'INPUT' && h.type === 'range'); });
  if (matches(root, d.handle) && !hs.length) hs = [root];
  return hs.map(function (h) {
    var range = h.tagName === 'INPUT' && h.type === 'range';
    var now = range ? Number(h.value) : Number(h.getAttribute('aria-valuenow'));
    return { tag: mark(h), kind: range ? 'range' : 'aria', now: now, min: Number(range ? h.min || 0 : h.getAttribute('aria-valuemin')), max: Number(range ? h.max || 100 : h.getAttribute('aria-valuemax')), step: range ? Number(h.step || 1) : null, visible: visible(h), text: norm(h.getAttribute('aria-valuetext') || '') };
  });
};
E.setRange = function (el, a) {
  var h = byMark(a.tag);
  var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(h, String(a.value));
  h.dispatchEvent(new Event('input', { bubbles: true }));
  h.dispatchEvent(new Event('change', { bubbles: true }));
  return Number(h.value);
};

// ------------------------------------------------------------ drop zones
E.dropzoneInfo = function (el, a) {
  var d = a.d, root = need(el, d, 'drop zone');
  var inp = q1(root, 'input[type=file]');
  if (!inp && root.id) inp = document.querySelector('input[type=file][aria-controls="' + CSS.escape(root.id) + '"]');
  return { root: mark(root), input: inp ? mark(inp) : null, multiple: !!(inp && inp.multiple), text: text(root), files: d.fileName ? qa(root.closest(d.fileScope || '*') || root, d.fileName).map(text) : [] };
};

// ------------------------------------------------------------ charts
function seriesFromTable(t) {
  var head = Array.from((q1(t, 'thead tr') || q1(t, 'tr')).children).map(text);
  var body = qa(t, 'tbody tr').filter(function (r) { return r.querySelector('td'); });
  if (!body.length) body = qa(t, 'tr').slice(1);
  var labels = body.map(function (r) { return text(r.children[0]); });
  var series = head.slice(1).map(function (h, i) { return { name: h, values: body.map(function (r) { var c = r.children[i + 1]; var n = c ? parseNum(text(c)) : null; return n === null ? (c ? text(c) : null) : n; }) }; });
  return { source: 'table', labels: labels, series: series };
}
E.chartData = function (el, a) {
  var root = el;
  var canvas = matches(root, 'canvas') ? root : q1(root, 'canvas');
  var Ch = window.Chart;
  if (canvas && Ch && typeof Ch.getChart === 'function') {
    var ch = Ch.getChart(canvas);
    if (ch) return { source: 'chart.js', labels: (ch.data.labels || []).map(String), series: ch.data.datasets.map(function (ds, i) { return { name: String(ds.label || ('Series ' + (i + 1))), values: (ds.data || []).map(function (v) { return v && typeof v === 'object' ? (v.y !== undefined ? v.y : v.value) : v; }) }; }) };
  }
  var ec = window.echarts;
  if (ec && typeof ec.getInstanceByDom === 'function') {
    var host = root.hasAttribute('_echarts_instance_') ? root : (q1(root, '[_echarts_instance_]') || root.closest('[_echarts_instance_]'));
    var inst = host ? ec.getInstanceByDom(host) : null;
    if (inst) {
      var o = inst.getOption();
      var xa = (o.xAxis && o.xAxis[0] && o.xAxis[0].data) || (o.yAxis && o.yAxis[0] && o.yAxis[0].data) || [];
      return { source: 'echarts', labels: xa.map(String), series: (o.series || []).map(function (s, i) { return { name: String(s.name || ('Series ' + (i + 1))), values: (s.data || []).map(function (v) { return v && typeof v === 'object' ? (Array.isArray(v.value) ? v.value[1] : v.value) : Array.isArray(v) ? v[1] : v; }) }; }) };
    }
  }
  var hc = window.Highcharts;
  if (hc && hc.charts) {
    var c = hc.charts.filter(function (x) { return x && x.renderTo && (root.contains(x.renderTo) || x.renderTo.contains(root)); })[0];
    if (c) return { source: 'highcharts', labels: (c.xAxis && c.xAxis[0] && c.xAxis[0].categories || []).map(String), series: c.series.map(function (s) { return { name: String(s.name), values: (s.points || s.data || []).map(function (p) { return p && typeof p === 'object' ? p.y : p; }) }; }) };
  }
  var ref = null;
  ['aria-describedby', 'aria-details', 'data-table'].forEach(function (at) { var v = (canvas || root).getAttribute(at) || root.getAttribute(at); if (v && !ref) v.split(/\s+/).forEach(function (id) { var e = document.getElementById(id); if (e && !ref) ref = e.tagName === 'TABLE' ? e : q1(e, 'table'); }); });
  if (!ref) ref = q1(root, 'table');
  if (!ref && canvas) ref = q1(canvas, 'table');
  if (ref) return seriesFromTable(ref);
  return { error: canvas ? 'canvas chart is not inspectable: no Chart.js, ECharts or Highcharts instance is reachable from the page, and the chart has no accessible data table' : 'no chart (canvas or svg) at the target' };
};

// ------------------------------------------------------------ infinite lists
E.listLoad = async function (el, a) {
  var root = el, t0 = performance.now();
  var itemSel = a.item || ':scope > [role=listitem], :scope > [role=article], :scope > article, :scope > [role=option], :scope > li, :scope > [role=row], :scope > [data-index]';
  // The scroll container is found again each round: a list that has not received its first batch yet is not
  // scrollable, and choosing the window then would never trigger the list's own "load more".
  var sc = root, win = false;
  function findScroller() {
    var c = root;
    if (/(auto|scroll)/.test(getComputedStyle(c).overflowY)) { sc = c; win = false; return; }
    while (c && c !== document.body && !(/(auto|scroll)/.test(getComputedStyle(c).overflowY) && c.scrollHeight > c.clientHeight + 2)) c = c.parentElement;
    sc = c; win = !c || c === document.body;
  }
  var seen = {}, items = [], idle = 0, rounds = 0, truncated = false;
  function take() { qa(root, itemSel).forEach(function (it, i) { var k = it.getAttribute('aria-posinset') || it.getAttribute('data-index') || it.getAttribute('data-id') || ('t:' + text(it)); if (!seen[k]) { seen[k] = 1; items.push(text(it)); } }); }
  take();
  while (true) {
    if (items.length >= (a.max || 1e9)) { truncated = true; break; }
    if (performance.now() - t0 > (a.budgetMs || 20000)) { truncated = true; break; }
    findScroller();
    var n0 = items.length, h0 = win ? document.documentElement.scrollHeight : sc.scrollHeight;
    if (win) window.scrollTo(0, document.documentElement.scrollHeight); else sc.scrollTop = sc.scrollHeight;
    var grew = false;
    for (var w = 0; w < (a.idleMs || 1500) / 50; w++) { await sleep(50); take(); var h1 = win ? document.documentElement.scrollHeight : sc.scrollHeight; if (items.length > n0 || h1 > h0 + 2) { grew = true; break; } }
    rounds++;
    if (!grew) { idle++; if (idle >= 2) break; } else idle = 0;
  }
  return { items: items, rounds: rounds, truncated: truncated, ms: Math.round(performance.now() - t0) };
};

// ------------------------------------------------------------ healing: every widget of a kind on the page
function cssPath(el) {
  var parts = [];
  for (var e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
    if (e.id && /^[A-Za-z][\w-]*$/.test(e.id) && document.querySelectorAll('#' + e.id).length === 1) { parts.unshift('#' + e.id); break; }
    var i = 1, s = e;
    while ((s = s.previousElementSibling)) if (s.tagName === e.tagName) i++;
    parts.unshift(e.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
  }
  return parts.join(' > ');
}
function contextName(el) {
  var n = accName(el);
  if (n && n.length < 80 && !/^\d/.test(n)) return n;
  for (var p = el.parentElement, k = 0; p && k < 4; p = p.parentElement, k++) {
    if (p.getAttribute('aria-labelledby') || p.getAttribute('aria-label')) return accName(p);
    var h = Array.from(p.children).filter(function (c) { return /^(H[1-6]|LEGEND|LABEL|FIGCAPTION)$/.test(c.tagName) || c.getAttribute('role') === 'heading'; })[0];
    if (h) return text(h);
  }
  return '';
}
E.widgetCandidates = function (el, a) {
  var seen = [];
  var out = [];
  a.roots.forEach(function (sel) {
    qa(document, sel).forEach(function (w) {
      if (!visible(w) || seen.some(function (x) { return x === w || x.contains(w) || w.contains(x); })) return;
      seen.push(w);
      out.push({ tag: mark(w), name: contextName(w), id: w.id || '', testid: w.getAttribute('data-testid') || '', ariaLabel: w.getAttribute('aria-label') || '', role: w.getAttribute('role') || '', path: cssPath(w) });
    });
  });
  return out;
};

E.run = function (el, op, arg) {
  var f = E[op];
  if (typeof f !== 'function') throw new Error('unknown engine op ' + op);
  return f(el, arg || {});
};
})();`;

const INSTALL = `(el) => { ${SOURCE}; return true; }`;

/** Init script: install the engine and record toasts from the first moment of every document. */
export function toastInitScript(selector: string): string {
  return `${SOURCE};\n(function () { try { window.__ezc.toastWatch(null, { selector: ${JSON.stringify(selector)} }); } catch (e) {} })();`;
}
const CALL = `(el, a) => (window.__ezc && window.__ezc.v === '${ENGINE_VERSION}') ? Promise.resolve(window.__ezc.run(el, a.op, a.arg)).then(function (v) { return { ok: true, v: v }; }, function (e) { return { ok: false, error: String(e && e.message || e) }; }) : { missing: true }`;

function fn<A, R>(source: string): (el: Element, arg: A) => R {
  const f = (() => {
    throw new Error('in-page function must run in the browser');
  }) as unknown as (el: Element, arg: A) => R;
  Object.defineProperty(f, 'toString', { value: () => source });
  return f;
}

const installFn = fn<undefined, boolean>(INSTALL);
const callFn = fn<{ op: string; arg: unknown }, { ok?: boolean; v?: unknown; error?: string; missing?: boolean }>(CALL);

/** An engine-side failure (bad column, no widget, ...), reported to the user as is. */
export class ComponentError extends EzTestError {
  constructor(message: string, code = 'COMPONENT', details?: Record<string, unknown>) {
    super(message, code, details);
    this.name = 'ComponentError';
  }
}

/** Run an engine op on the element `loc` resolves to (installing the engine in its document first). */
export async function engine<R>(loc: Locator, op: string, arg: unknown = {}, timeout = 10_000): Promise<R> {
  for (let i = 0; i < 2; i++) {
    const r = await loc.evaluate(callFn, { op, arg }, { timeout });
    if (r.missing) {
      await loc.evaluate(installFn, undefined, { timeout });
      continue;
    }
    if (!r.ok) throw new ComponentError(r.error ?? `engine op ${op} failed`, 'COMPONENT');
    return r.v as R;
  }
  throw new ComponentError('could not install the component engine in the page', 'COMPONENT');
}

/** The frame (main page or iframe) the element of `loc` lives in: body-level popups are looked up there. */
export async function frameOf(loc: Locator, timeout = 10_000): Promise<Frame> {
  const h = await loc.elementHandle({ timeout });
  if (!h) throw new ComponentError('the widget is no longer in the page', 'COMPONENT');
  try {
    const f = await h.ownerFrame();
    if (!f) throw new ComponentError('the widget is detached from its frame', 'COMPONENT');
    return f;
  } finally {
    await h.dispose();
  }
}

/** A locator for an element the engine marked. */
export function marked(frame: Frame, tag: string): Locator {
  return frame.locator(`[${MARK_ATTR}="${tag}"]`);
}
