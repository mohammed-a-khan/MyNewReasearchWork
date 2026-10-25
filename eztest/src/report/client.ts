/**
 * The report's inline script (plain ES2017, no dependencies): tabs with deep
 * links and history, the virtualised test explorer, the test detail (steps
 * timeline, attempts, logs, network, video, trace, evidence, history), the
 * lightbox, the theme and print. It reads the embedded model and builds
 * everything with DOM APIs and textContent; it never writes data through
 * innerHTML.
 */
import { ICON_PATHS } from './icons.js';

const SCRIPT = String.raw`
(function () {
'use strict';
var dataEl = document.getElementById('ez-data');
if (!dataEl) return;
var D = JSON.parse(dataEl.textContent || '{}');
var T = D.tests || [];
var EV = D.evidence || {};
var EK = D.evidenceKinds || [];
var NOUN = D.labels || { test: 'test', tests: 'tests' };
var ICONS = __ICONS__;
var LABEL = { passed: 'Passed', healed: 'Healed', flaky: 'Flaky', failed: 'Failed', error: 'Error', skipped: 'Skipped' };
var STATE_ICON = { passed: 'check', healed: 'heal', flaky: 'retry', failed: 'x', error: 'alert', skipped: 'minus' };
var STEP = { P: ['passed', 'Passed'], H: ['healed', 'Passed (healed)'], F: ['failed', 'Failed'], S: ['skipped', 'Skipped'], B: ['error', 'Blocked'] };
var SEVERITY = { failed: 0, error: 1, flaky: 2, healed: 3, skipped: 4, passed: 5 };
var CAT = { product: 'Product defect', test: 'Test issue', environment: 'Environment', data: 'Test data', flaky: 'Flaky', unknown: 'Needs review' };
var ORDER = ['passed', 'healed', 'flaky', 'failed', 'error', 'skipped'];
var byId = {};
for (var bi = 0; bi < T.length; bi++) byId[T[bi].id] = bi;
var ADO_TAG = /^@?(TestCaseId|TestPlanId|TestSuiteId)\b/i;
var Product = D.whiteLabel ? '' : 'EZTest';

// ------------------------------------------------------------ helpers
var SVGNS = 'http://www.w3.org/2000/svg';
var iconCache = {};
function svgIcon(name, cls) {
  var c = iconCache[name];
  if (!c) {
    c = document.createElementNS(SVGNS, 'svg');
    c.setAttribute('viewBox', '0 0 24 24'); c.setAttribute('fill', 'none'); c.setAttribute('stroke', 'currentColor');
    c.setAttribute('stroke-width', '2'); c.setAttribute('stroke-linecap', 'round'); c.setAttribute('stroke-linejoin', 'round');
    c.setAttribute('aria-hidden', 'true'); c.setAttribute('focusable', 'false');
    var tmp = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg">' + (ICONS[name] || ICONS.minus) + '</svg>', 'image/svg+xml');
    var kids = tmp.documentElement.childNodes;
    for (var i = 0; i < kids.length; i++) c.appendChild(document.importNode(kids[i], true));
    iconCache[name] = c;
  }
  var n = c.cloneNode(true);
  if (cls) n.setAttribute('class', cls);
  return n;
}
function el(tag, attrs, kids) {
  var n = document.createElement(tag);
  if (attrs) for (var k in attrs) {
    if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
    var v = attrs[k];
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') n.textContent = String(v);
    else if (k === 'cls') n.className = v;
    else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  if (kids) for (var i = 0; i < kids.length; i++) { var c = kids[i]; if (c === null || c === undefined || c === false) continue; n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c); }
  return n;
}
function fmtMs(ms) {
  if (!isFinite(ms)) return '-';
  if (ms < 1000) return Math.round(ms) + ' ms';
  var s = ms / 1000;
  if (s < 60) return (s < 10 ? s.toFixed(1) : Math.round(s)) + ' s';
  var m = Math.floor(s / 60), rs = Math.round(s % 60);
  if (m < 60) return m + ' min' + (rs ? ' ' + rs + ' s' : '');
  return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function badge(state, label) { return el('span', { cls: 'badge b-' + state }, [svgIcon(STATE_ICON[state] || 'minus'), label || LABEL[state] || state]); }
function sicon(state, title) { return el('span', { cls: 'sicon si-' + state, title: title || LABEL[state] }, [svgIcon(STATE_ICON[state] || 'minus')]); }
function safeUrl(u) { return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null; }
function extLink(url, label, cls) {
  var u = safeUrl(url);
  if (!u) return el('span', { cls: cls, text: label });
  return el('a', { href: u, target: '_blank', rel: 'noopener noreferrer', cls: cls }, [label, el('span', { cls: 'sr-only', text: ' (opens in a new tab)' })]);
}
function box(title, body, extra) { return el('div', { cls: 'box' }, [title ? el('div', { cls: 'box-h' }, [title].concat(extra || [])) : null].concat(body)); }
function dl(rows) {
  var d = el('dl', { cls: 'kv' });
  rows.forEach(function (r) { if (r[1] === undefined || r[1] === null || r[1] === '') return; d.appendChild(el('dt', { text: r[0] })); d.appendChild(el('dd', null, [r[1]])); });
  return d;
}
function pre(text, cls) { return el('pre', { cls: cls || 'code', text: text }); }
function walkSteps(steps, fn, depth) { (steps || []).forEach(function (s) { fn(s, depth || 0); walkSteps(s.ch, fn, (depth || 0) + 1); }); }
function testHash(id) { return '#tests/' + encodeURIComponent(id); }
function copyText(text, btn) {
  function done() { if (btn && btn.parentNode) { var note = el('span', { cls: 'copy-ok', role: 'status', text: 'Copied' }); btn.parentNode.insertBefore(note, btn.nextSibling); setTimeout(function () { note.remove(); }, 1600); } }
  try {
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(done, fallback); return; }
  } catch (e) { /* fall back */ }
  fallback();
  function fallback() {
    var ta = el('textarea', { 'aria-hidden': 'true', style: 'position:fixed;left:-9999px;top:0' });
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove(); done();
  }
}
var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };

/** A WAI-ARIA tablist: one panel visible, arrow keys / Home / End move and select. */
function tablist(listEl, onSelect) {
  function tabs() { return Array.prototype.slice.call(listEl.querySelectorAll('[role=tab]')); }
  function select(tab, focus) {
    tabs().forEach(function (t) { var on = t === tab; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
    if (focus) tab.focus();
    onSelect(tab);
  }
  listEl.addEventListener('click', function (ev) { var t = ev.target.closest('[role=tab]'); if (t && listEl.contains(t)) select(t, false); });
  listEl.addEventListener('keydown', function (ev) {
    var list = tabs(), i = list.indexOf(document.activeElement);
    if (i < 0) return;
    var j = ev.key === 'ArrowRight' ? (i + 1) % list.length : ev.key === 'ArrowLeft' ? (i - 1 + list.length) % list.length : ev.key === 'Home' ? 0 : ev.key === 'End' ? list.length - 1 : -1;
    if (j < 0) return;
    ev.preventDefault(); select(list[j], true);
  });
  return { select: select, tabs: tabs };
}

// ------------------------------------------------------------ theme, print, exports
var root = document.documentElement, tb = document.getElementById('theme-toggle');
function setTheme(t, save) {
  root.setAttribute('data-theme', t);
  if (tb) {
    tb.setAttribute('aria-pressed', String(t === 'dark'));
    while (tb.firstChild) tb.removeChild(tb.firstChild);
    tb.appendChild(svgIcon(t === 'dark' ? 'sun' : 'moon'));
    tb.appendChild(el('span', { text: t === 'dark' ? 'Light theme' : 'Dark theme' }));
  }
  if (save) store.set('ez-report-theme', t);
}
var qTheme = /[?&]theme=(light|dark)/.exec(location.search);
var savedTheme = qTheme ? qTheme[1] : store.get('ez-report-theme');
setTheme(savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : D.theme === 'dark' || D.theme === 'light' ? D.theme : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'), false);
if (tb) tb.addEventListener('click', function () { setTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark', true); });
var pbtn = document.getElementById('print-btn');
if (pbtn) pbtn.addEventListener('click', function () { window.print(); });
var xb = document.getElementById('exports-btn'), xl = document.getElementById('exports-list');
if (xb && xl) {
  xb.addEventListener('click', function () { var open = xl.hidden; xl.hidden = !open; xb.setAttribute('aria-expanded', String(open)); if (open) { var a = xl.querySelector('a'); if (a) a.focus(); } });
  document.addEventListener('click', function (ev) { if (!xl.hidden && !xb.contains(ev.target) && !xl.contains(ev.target)) { xl.hidden = true; xb.setAttribute('aria-expanded', 'false'); } });
  xl.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { xl.hidden = true; xb.setAttribute('aria-expanded', 'false'); xb.focus(); } });
}

// ------------------------------------------------------------ tooltips
var tip = document.getElementById('tip');
function showTip(target, x, y) {
  var t = target.getAttribute('data-tip'); if (!t || !tip) return;
  tip.textContent = t; tip.hidden = false;
  var w = tip.offsetWidth, h = tip.offsetHeight;
  var left = Math.min(window.innerWidth - w - 8, Math.max(8, x + 12)), top = y - h - 12;
  if (top < 8) top = y + 16;
  tip.style.left = left + 'px'; tip.style.top = top + 'px';
}
function hideTip() { if (tip) tip.hidden = true; }
document.addEventListener('pointermove', function (ev) { var t = ev.target && ev.target.closest ? ev.target.closest('[data-tip]') : null; if (t) showTip(t, ev.clientX, ev.clientY); else hideTip(); });
document.addEventListener('focusin', function (ev) { var t = ev.target && ev.target.closest ? ev.target.closest('[data-tip]') : null; if (t) { var r = t.getBoundingClientRect(); showTip(t, r.left + r.width / 2, r.top); } else hideTip(); });
document.addEventListener('scroll', hideTip, true);
document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') hideTip(); });

// ------------------------------------------------------------ sticky header: the title rows scroll away, results and tabs stay
var topbar = document.getElementById('top');
function layoutHeader() {
  if (!topbar) return;
  var a = topbar.querySelector('.head-top'), b = topbar.querySelector('.run-meta');
  var away = (a ? a.offsetHeight : 0) + (b ? b.offsetHeight : 0);
  topbar.style.top = (-away) + 'px';
  root.style.setProperty('--stick', Math.max(60, topbar.offsetHeight - away + 12) + 'px');
}
layoutHeader();
window.addEventListener('resize', layoutHeader);

// ------------------------------------------------------------ explorer state
var q = document.getElementById('q'), vlist = document.getElementById('vlist'), vinner = document.getElementById('vinner'), countEl = document.getElementById('count');
var detail = document.getElementById('detail');
var groupSel = document.getElementById('group'), sortSel = document.getElementById('sort');
var fTag = document.getElementById('f-tag'), fOwner = document.getElementById('f-owner'), fBrowser = document.getElementById('f-browser'), fCat = document.getElementById('f-cat');
var st = { state: 'all', query: '', group: store.get('ez-report-group') || 'suite', sort: 'default', tag: '', owner: '', browser: '', cat: '', collapsed: {}, active: 0, open: null, sub: 'steps' };
var ROW_H = 52, rows = [], searchIdx = null;
var hasExplorer = !!(vlist && vinner && countEl && q);

function facet(sel, values) {
  if (!sel) return;
  var counts = {};
  values.forEach(function (v) { counts[v] = (counts[v] || 0) + 1; });
  Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b); }).slice(0, 300).forEach(function (v) { sel.appendChild(el('option', { value: v, text: v })); });
  if (!Object.keys(counts).length) { sel.disabled = true; var l = sel.closest('label'); if (l && sel !== fTag) l.hidden = true; }
}
if (hasExplorer) {
  facet(fTag, [].concat.apply([], T.map(function (t) { return t.tags.filter(function (g) { return !ADO_TAG.test(g); }); })));
  facet(fOwner, [].concat.apply([], T.map(function (t) { return t.owners; })));
  facet(fBrowser, T.map(function (t) { return t.browser; }).filter(Boolean));
  if (fCat) {
    var catSeen = {};
    T.forEach(function (t) { if (t.cat) catSeen[t.cat.c] = 1; });
    Object.keys(CAT).forEach(function (c) { if (catSeen[c]) fCat.appendChild(el('option', { value: c, text: CAT[c] })); });
    if (!Object.keys(catSeen).length) { fCat.disabled = true; fCat.closest('label').hidden = true; }
  }
  var more = document.getElementById('more-filters');
  if (more && !more.querySelector('label:not([hidden])')) more.hidden = true;
  if (groupSel) {
    if (!T.some(function (t) { return t.browser; })) { var ob = groupSel.querySelector('option[value=browser]'); if (ob) ob.remove(); }
    if (!T.some(function (t) { return t.owners.length; })) { var oo = groupSel.querySelector('option[value=owner]'); if (oo) oo.remove(); }
    if (!T.some(function (t) { return t.cat; })) { var oc = groupSel.querySelector('option[value=category]'); if (oc) oc.remove(); }
    if (!groupSel.querySelector('option[value="' + st.group + '"]')) st.group = 'suite';
    groupSel.value = st.group;
  }
}

function buildSearchIndex() {
  searchIdx = T.map(function (t) {
    var parts = [t.name, t.id, t.tags.join(' '), t.owners.join(' '), t.file || '', t.suite.join(' '), t.failedStep || '', t.error ? t.error.message : '', t.requirements.join(' '), t.browser || '', t.state, t.cat ? CAT[t.cat.c] : '', t.row ? Object.keys(t.row).map(function (k) { return k + '=' + t.row[k]; }).join(' ') : ''];
    var n = 0;
    walkSteps(t.steps, function (s) { if (n++ < 60) parts.push(s.n); });
    if (t.ado) t.ado.testCases.forEach(function (c) { parts.push('#' + c.id); });
    return parts.join('\n').toLowerCase();
  });
}

function matches(i) {
  var t = T[i];
  if (st.state !== 'all' && t.state !== st.state) return false;
  if (st.tag && t.tags.indexOf(st.tag) < 0) return false;
  if (st.owner && t.owners.indexOf(st.owner) < 0) return false;
  if (st.browser && t.browser !== st.browser) return false;
  if (st.cat && (!t.cat || t.cat.c !== st.cat)) return false;
  if (st.query) {
    if (!searchIdx) buildSearchIndex();
    var terms = st.query.toLowerCase().split(/\s+/).filter(Boolean);
    for (var k = 0; k < terms.length; k++) if (searchIdx[i].indexOf(terms[k]) < 0) return false;
  }
  return true;
}

function sorter(a, b) {
  var x = T[a], y = T[b];
  if (st.sort === 'severity') return SEVERITY[x.state] - SEVERITY[y.state] || y.risk - x.risk || a - b;
  if (st.sort === 'duration') return y.durationMs - x.durationMs || a - b;
  if (st.sort === 'name') return x.name.localeCompare(y.name);
  return a - b;
}

function groupKeys(t) {
  if (st.group === 'suite') return [t.suite.length ? t.suite : ['Ungrouped']];
  if (st.group === 'file') return [[t.file ? t.file.split(/[\\/]/).slice(-2).join('/') : '(no file)']];
  if (st.group === 'tag') { var tags = t.tags.filter(function (g) { return !ADO_TAG.test(g); }); return tags.length ? tags.map(function (g) { return [g]; }) : [['(no tag)']]; }
  if (st.group === 'owner') return t.owners.length ? t.owners.map(function (o) { return [o]; }) : [['(no owner)']];
  if (st.group === 'browser') return [[t.browser || '(single browser)']];
  if (st.group === 'category') return [[t.cat ? CAT[t.cat.c] : 'Not failing']];
  return [[]];
}

function filtered() { return st.state !== 'all' || st.query || st.tag || st.owner || st.browser || st.cat; }
function rebuild() {
  if (!hasExplorer) return;
  var idx = [];
  for (var i = 0; i < T.length; i++) if (matches(i)) idx.push(i);
  idx.sort(sorter);
  rows = [];
  if (st.group === 'none') {
    idx.forEach(function (i) { rows.push({ t: i, depth: 0 }); });
  } else {
    var tree = { kids: {}, order: [], tests: [], counts: {} };
    idx.forEach(function (i) {
      groupKeys(T[i]).forEach(function (path) {
        var node = tree;
        path.forEach(function (seg) {
          if (!node.kids[seg]) { node.kids[seg] = { name: seg, kids: {}, order: [], tests: [], counts: {}, total: 0 }; node.order.push(seg); }
          node = node.kids[seg];
          node.total++; node.counts[T[i].state] = (node.counts[T[i].state] || 0) + 1;
        });
        node.tests.push(i);
      });
    });
    var walk = function (node, depth, key) {
      node.order.forEach(function (name) {
        var k = key + '\u0000' + name, n = node.kids[name];
        var open = !st.collapsed[k];
        rows.push({ g: k, name: name, depth: depth, node: n, open: open });
        if (open) { walk(n, depth + 1, k); n.tests.forEach(function (i) { rows.push({ t: i, depth: depth + 1 }); }); }
      });
    };
    walk(tree, 0, st.group);
  }
  countEl.textContent = filtered() ? idx.length + ' shown' + (st.query ? ' for "' + st.query + '"' : '') : 'Showing all';
  vinner.style.height = (rows.length * ROW_H) + 'px';
  if (st.active >= rows.length) st.active = Math.max(0, rows.length - 1);
  if (!rows.length) { vinner.textContent = ''; rendered = {}; vinner.appendChild(el('div', { cls: 'd-empty', style: 'min-height:200px' }, [el('p', { text: 'No ' + NOUN.tests + ' match these filters.' })])); return; }
  render(true);
}

var rendered = {};
function groupBar(counts) {
  var total = 0; ORDER.forEach(function (s) { total += counts[s] || 0; });
  var bar = el('span', { cls: 'gbar', 'aria-hidden': 'true' });
  ORDER.forEach(function (s) { if (counts[s]) bar.appendChild(el('span', { cls: 'st-' + s, style: 'width:' + (counts[s] / total * 100).toFixed(1) + '%' })); });
  return bar;
}
function renderRow(r, i) {
  var top = i * ROW_H;
  if (r.g !== undefined) {
    var desc = ORDER.filter(function (s) { return r.node.counts[s]; }).map(function (s) { return r.node.counts[s] + ' ' + LABEL[s].toLowerCase(); }).join(', ');
    return el('div', { cls: 'row group', role: 'treeitem', 'aria-level': r.depth + 1, 'aria-expanded': String(r.open), 'data-row': i, tabindex: i === st.active ? '0' : '-1', title: desc, style: 'top:' + top + 'px;padding-left:' + (12 + r.depth * 16) + 'px' },
      [svgIcon('chevron', 'twisty'), el('span', { cls: 'rname rmain', text: r.name }), el('span', { cls: 'sr-only', text: ', ' + desc }), groupBar(r.node.counts), el('span', { cls: 'rdur', text: String(r.node.total) })]);
  }
  var t = T[r.t];
  var sub = [];
  if (t.state === 'failed' || t.state === 'error') sub.push(t.failedStep || (t.error ? t.error.message.split('\n')[0] : ''));
  else { if (t.row) sub.push(Object.keys(t.row).map(function (k) { return k + '=' + t.row[k]; }).join(', ')); else if (t.tags.length) sub.push(t.tags.filter(function (g) { return !ADO_TAG.test(g); }).slice(0, 3).join(' ')); }
  if (t.browser) sub.push(t.browser);
  var tail = el('span', { cls: 'rtail' }, [
    t.cat ? el('span', { cls: 'cat c-' + t.cat.c, title: t.cat.why, text: CAT[t.cat.c] }) : null,
    el('span', { cls: 'rdur', text: fmtMs(t.durationMs) })]);
  return el('div', { cls: 'row' + (st.open === t.id ? ' active' : ''), role: 'treeitem', 'aria-level': r.depth + 1, 'aria-selected': String(st.open === t.id), 'data-row': i, 'data-id': t.id, tabindex: i === st.active ? '0' : '-1', style: 'top:' + top + 'px;padding-left:' + (12 + r.depth * 16) + 'px' },
    [sicon(t.state), el('div', { cls: 'rmain' }, [el('div', { cls: 'rname' }, [t.name, el('span', { cls: 'sr-only', text: ', ' + LABEL[t.state] + (t.cat ? ', ' + CAT[t.cat.c] : '') })]), sub.length && sub[0] ? el('div', { cls: 'rsub', text: sub.join(' · ') }) : null]), tail]);
}
function render(force) {
  if (!hasExplorer || !rows.length) return;
  var h = vlist.clientHeight || 600, sc = vlist.scrollTop;
  var start = Math.max(0, Math.floor(sc / ROW_H) - 8), end = Math.min(rows.length, Math.ceil((sc + h) / ROW_H) + 8);
  if (force) { vinner.textContent = ''; rendered = {}; }
  var keep = {};
  for (var i = start; i < end; i++) {
    keep[i] = 1;
    if (!rendered[i]) { rendered[i] = renderRow(rows[i], i); vinner.appendChild(rendered[i]); }
  }
  if (!keep[st.active] && rows[st.active] && !rendered[st.active]) { rendered[st.active] = renderRow(rows[st.active], st.active); vinner.appendChild(rendered[st.active]); }
  for (var k in rendered) if (!keep[k] && Number(k) !== st.active) { rendered[k].remove(); delete rendered[k]; }
}
function focusRow(i, scroll) {
  if (!rows.length) return;
  st.active = Math.max(0, Math.min(rows.length - 1, i));
  if (scroll !== false) {
    var top = st.active * ROW_H;
    if (top < vlist.scrollTop) vlist.scrollTop = top;
    else if (top + ROW_H > vlist.scrollTop + vlist.clientHeight) vlist.scrollTop = top + ROW_H - vlist.clientHeight;
  }
  render(true);
  var n = rendered[st.active]; if (n) n.focus({ preventScroll: true });
}
function activate(i) {
  var r = rows[i]; if (!r) return;
  if (r.g !== undefined) { st.collapsed[r.g] = r.open; st.active = i; rebuild(); focusRow(i); return; }
  go(testHash(T[r.t].id));
}
if (hasExplorer) {
  vlist.addEventListener('scroll', function () { render(false); }, { passive: true });
  window.addEventListener('resize', function () { render(false); });
  vinner.addEventListener('click', function (ev) { var n = ev.target.closest('[data-row]'); if (n) { st.active = Number(n.getAttribute('data-row')); activate(st.active); } });
  vlist.addEventListener('keydown', function (ev) {
    var k = ev.key, page = Math.max(1, Math.floor(vlist.clientHeight / ROW_H) - 1), r = rows[st.active];
    if (k === 'ArrowDown') { ev.preventDefault(); focusRow(st.active + 1); }
    else if (k === 'ArrowUp') { ev.preventDefault(); focusRow(st.active - 1); }
    else if (k === 'PageDown') { ev.preventDefault(); focusRow(st.active + page); }
    else if (k === 'PageUp') { ev.preventDefault(); focusRow(st.active - page); }
    else if (k === 'Home') { ev.preventDefault(); focusRow(0); }
    else if (k === 'End') { ev.preventDefault(); focusRow(rows.length - 1); }
    else if (k === 'Enter' || k === ' ') { ev.preventDefault(); activate(st.active); }
    else if (k === 'ArrowRight' && r && r.g !== undefined && !r.open) { ev.preventDefault(); activate(st.active); }
    else if (k === 'ArrowLeft' && r && r.g !== undefined && r.open) { ev.preventDefault(); activate(st.active); }
  });
  vlist.addEventListener('focus', function (ev) { if (ev.target === vlist) focusRow(st.active, false); });
  document.querySelectorAll('.fchip[data-state]').forEach(function (b) { b.addEventListener('click', function () { setState(b.getAttribute('data-state')); }); });
  var qTimer;
  q.addEventListener('input', function () { clearTimeout(qTimer); qTimer = setTimeout(function () { st.query = q.value.trim(); st.active = 0; rebuild(); }, T.length > 2000 ? 160 : 40); });
  q.addEventListener('keydown', function (ev) { if (ev.key === 'ArrowDown') { ev.preventDefault(); focusRow(0); } else if (ev.key === 'Escape') { q.value = ''; st.query = ''; rebuild(); } });
  if (groupSel) groupSel.addEventListener('change', function () { st.group = groupSel.value; store.set('ez-report-group', st.group); st.collapsed = {}; st.active = 0; rebuild(); });
  if (sortSel) sortSel.addEventListener('change', function () { st.sort = sortSel.value; rebuild(); });
  [[fTag, 'tag'], [fOwner, 'owner'], [fBrowser, 'browser'], [fCat, 'cat']].forEach(function (p) { if (p[0]) p[0].addEventListener('change', function () { st[p[1]] = p[0].value; st.active = 0; rebuild(); }); });
}
function setState(s) {
  if (!document.querySelector('.fchip[data-state="' + s + '"]')) s = 'all';
  st.state = s;
  document.querySelectorAll('.fchip[data-state]').forEach(function (x) { x.setAttribute('aria-pressed', String(x.getAttribute('data-state') === s)); });
  st.active = 0; rebuild();
}

// ------------------------------------------------------------ lightbox
var lb = document.getElementById('lightbox'), lbImg = document.getElementById('lb-img'), lbCap = document.getElementById('lb-cap'), lbOpen = document.getElementById('lb-open');
var lbList = [], lbAt = 0, lbReturn = null, lbClosedAt = 0, lbZoom = document.getElementById('lb-zoom');
if (lbZoom) lbZoom.addEventListener('click', function () { var on = !lbImg.classList.contains('actual'); lbImg.classList.toggle('actual', on); lbZoom.setAttribute('aria-pressed', String(on)); lbZoom.textContent = on ? 'Fit to screen' : 'Actual size'; });
function lbShow(i) {
  lbAt = (i + lbList.length) % lbList.length;
  var s = lbList[lbAt];
  lbImg.classList.remove('actual'); if (lbZoom) { lbZoom.setAttribute('aria-pressed', 'false'); lbZoom.textContent = 'Actual size'; }
  lbImg.src = s.url; lbImg.alt = s.alt; lbCap.textContent = s.alt + ' (' + (lbAt + 1) + ' of ' + lbList.length + ')'; lbOpen.href = s.url;
  document.getElementById('lb-prev').hidden = document.getElementById('lb-next').hidden = lbList.length < 2;
}
function openLightbox(list, i, from) {
  if (!lb || !list.length) return;
  lbList = list; lbReturn = from || document.activeElement; lbShow(Math.max(0, i));
  if (typeof lb.showModal === 'function') lb.showModal(); else lb.setAttribute('open', '');
  document.getElementById('lb-close').focus();
}
function closeLightbox() { if (lb.open) { if (typeof lb.close === 'function') lb.close(); else lb.removeAttribute('open'); } if (lbReturn && lbReturn.focus) lbReturn.focus(); }
if (lb) {
  document.getElementById('lb-close').addEventListener('click', closeLightbox);
  document.getElementById('lb-prev').addEventListener('click', function () { lbShow(lbAt - 1); });
  document.getElementById('lb-next').addEventListener('click', function () { lbShow(lbAt + 1); });
  lb.addEventListener('keydown', function (ev) { if (ev.key === 'ArrowLeft') lbShow(lbAt - 1); else if (ev.key === 'ArrowRight') lbShow(lbAt + 1); });
  lb.addEventListener('close', function () { lbClosedAt = Date.now(); if (lbReturn && lbReturn.focus) lbReturn.focus(); });
  lb.addEventListener('click', function (ev) { if (ev.target === lb) closeLightbox(); });
}

// ------------------------------------------------------------ evidence
var SNAP = D.snapshots || {};
function fmtBytes(n) { if (n === null || n === undefined) return '-'; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }
function fmtAt(ms) { if (ms === null || ms === undefined) return '-'; var t0 = Date.parse(D.startedAt); var abs = isFinite(t0) ? new Date(t0 + ms).toISOString().slice(11, 19) + ' UTC' : ''; return '+' + fmtMs(ms) + (abs ? ' (' + abs + ')' : ''); }
function stepAt(t, no) { var n = 0, hit = null; walkSteps(t.steps, function (s) { n++; if (n === no) hit = s; }); return hit; }
function kindLabel(kind, path, desc) {
  var p = (path || '').toLowerCase(), d = (desc || '').toLowerCase();
  if (kind === 'screenshot') return /before-assert/.test(p) ? 'Screenshot before the assertion' : /manual-pause/.test(p) ? 'Screenshot at the manual pause' : 'Screenshot';
  if (kind === 'dom') return 'DOM snapshot (HTML)';
  if (kind === 'aria') return 'Aria snapshot';
  if (kind === 'network') return /(^|\/)api\//.test(p) ? 'API exchange' : /\.har$/.test(p) ? 'HAR (network archive)' : /websocket/.test(p) ? 'WebSocket messages' : 'Network log';
  if (kind === 'trace') return /\.zip$/.test(p) ? 'Trace' : /snapshots\/.*before/.test(p) ? 'Time-travel snapshot (before)' : /snapshots\/.*after/.test(p) ? 'Time-travel snapshot (after)' : 'Trace resource';
  if (kind === 'video') return 'Video';
  if (kind === 'video-chapters') return 'Video chapters';
  if (kind === 'download') return 'Download';
  if (kind === 'document') return /\.pdf$/.test(p) ? 'Document (PDF)' : 'Document';
  if (kind === 'console') return 'Console log';
  if (kind === 'log') return 'Log';
  if (kind === 'report') return /coverage/.test(p) ? 'Coverage map' : 'Report';
  if (kind === 'data') return /lens-a11y|a11y\//.test(p) ? 'Accessibility findings' : /visual/.test(p) ? 'Visual comparison' : /compare\//.test(p) ? 'Data comparison' : /messages\//.test(p) ? 'Messages' : /flake-cause/.test(p) ? 'Flake analysis' : /query|db|rows/.test(p + d) ? 'DB result' : /health/.test(p) ? 'Health checks' : /\.manual\./.test(p) ? 'Manual verdict' : 'Data';
  return kind;
}
function evRef(id) {
  var r = EV[id];
  if (!r) return null;
  var kind = EK[r[0]] || '';
  var t = r[7] >= 0 ? T[r[7]] : null;
  var s = t && r[8] ? stepAt(t, r[8]) : null;
  var path = r[1] ? decodeURIComponent(r[1]) : '';
  return { id: id, kind: kind, url: r[1], desc: r[2] || '', size: r[3], at: r[4], sha: r[5] || '', seq: r[6], test: t, stepNo: r[8] || 0, step: s, path: path, label: kindLabel(kind, path, r[2]) };
}
function evName(r) { return (r.stepNo ? 'Step ' + r.stepNo + (r.step ? ': ' + r.step.n : '') : r.test ? cap(NOUN.test) : 'Run') + ' – ' + r.label; }
function isImage(r) { return r.url && /\.(png|jpe?g|gif|webp|svg)$/i.test(r.path); }
function previewable(r) { return r.url && !/\.gz$/i.test(r.path); }
function evLink(id) {
  var r = evRef(id);
  if (!r) return el('span', { cls: 'chip mono', title: 'not in the evidence manifest', text: id });
  return r.url && previewable(r) ? el('a', { cls: 'chip', href: r.url, target: '_blank', rel: 'noopener', title: r.path }, [r.label]) : el('span', { cls: 'chip', title: r.path }, [r.label]);
}
function evActions(r) {
  var a = [];
  if (r.url && previewable(r)) a.push(el('a', { cls: 'btn quiet', href: r.url, target: '_blank', rel: 'noopener' }, [svgIcon('external'), 'Open', el('span', { cls: 'sr-only', text: ' ' + evName(r) + ' (opens in a new tab)' })]));
  if (r.url) a.push(el('a', { cls: 'btn quiet', href: r.url, download: r.path.split('/').pop() }, [svgIcon('download'), 'Download', el('span', { cls: 'sr-only', text: ' ' + evName(r) })]));
  return a;
}
/** A filterable evidence table: thumbnails, names, kind, size, time, SHA-256, chain position, open and download. */
function evidenceBrowser(ids, opt) {
  opt = opt || {};
  var all = ids.map(evRef).filter(Boolean);
  var wrap = el('div', { cls: 'evb' });
  if (!all.length) { wrap.appendChild(el('p', { cls: 'muted', text: 'No evidence.' })); return wrap; }
  var kinds = {}; all.forEach(function (r) { kinds[r.label] = (kinds[r.label] || 0) + 1; });
  var fk = el('select', { 'aria-label': 'Filter evidence by kind' }, [el('option', { value: '', text: 'All kinds' })].concat(Object.keys(kinds).sort().map(function (k) { return el('option', { value: k, text: k + ' (' + kinds[k] + ')' }); })));
  var scope = el('select', { 'aria-label': opt.runWide ? 'Filter evidence by ' + NOUN.test : 'Filter evidence by step' }, [el('option', { value: '', text: opt.runWide ? 'All ' + NOUN.tests : 'All steps' })]);
  var seen = {};
  all.forEach(function (r) {
    var key = opt.runWide ? (r.test ? r.test.id : '-') : String(r.stepNo);
    if (seen[key]) return; seen[key] = 1;
    scope.appendChild(el('option', { value: key, text: opt.runWide ? (r.test ? r.test.name : 'Run-level evidence') : (r.stepNo ? 'Step ' + r.stepNo + (r.step ? ': ' + r.step.n : '') : 'Whole ' + NOUN.test) }));
  });
  var qf = el('input', { type: 'search', placeholder: 'Find evidence (name, file, SHA-256)', 'aria-label': 'Find evidence' });
  var count = el('span', { cls: 'muted small', 'aria-live': 'polite' });
  var tbody = el('tbody');
  var moreBtn = el('button', { type: 'button', cls: 'btn', text: 'Show more' });
  var limit = opt.page || 50;
  function list() {
    var k = fk.value, sc = scope.value, qq = qf.value.trim().toLowerCase();
    return all.filter(function (r) {
      if (k && r.label !== k) return false;
      if (sc && (opt.runWide ? (r.test ? r.test.id : '-') : String(r.stepNo)) !== sc) return false;
      if (qq && (evName(r) + ' ' + r.id + ' ' + r.path + ' ' + r.sha + ' ' + r.desc).toLowerCase().indexOf(qq) < 0) return false;
      return true;
    });
  }
  function draw() {
    var ls = list();
    tbody.textContent = '';
    ls.slice(0, limit).forEach(function (r) {
      var thumb = isImage(r) ? (function () { var b = el('button', { type: 'button', cls: 'evthumb', 'aria-label': 'Preview ' + evName(r) }, [el('img', { src: r.url, alt: '', loading: 'lazy' })]); b.addEventListener('click', function () { var imgs = ls.filter(isImage); openLightbox(imgs.map(function (x) { return { url: x.url, alt: evName(x) }; }), imgs.indexOf(r), b); }); return b; })() : el('span', { cls: 'evkind', 'aria-hidden': 'true', text: r.label.slice(0, 3).toUpperCase() });
      tbody.appendChild(el('tr', null, [
        el('td', null, [thumb]),
        el('td', null, [el('div', { text: evName(r) }), el('div', { cls: 'small muted mono ev-path', text: r.path }), r.desc && r.desc !== r.label ? el('div', { cls: 'small muted', text: r.desc }) : null, el('div', { cls: 'small muted mono', title: r.sha }, ['SHA-256 ' + (r.sha ? r.sha.slice(0, 16) + '…' : '-'), el('span', { cls: 'sr-only', text: ' (full: ' + r.sha + ')' }), ' · chain #' + (r.seq !== null && r.seq !== undefined ? r.seq : '-')]), opt.runWide && r.test ? el('a', { cls: 'small', href: testHash(r.test.id), text: r.test.name }) : null]),
        el('td', { cls: 'small' }, [el('div', { cls: 'num', text: fmtBytes(r.size) }), el('div', { cls: 'muted', text: fmtAt(r.at) })]),
        el('td', null, [el('div', { cls: 'evacts' }, evActions(r))]),
      ]));
    });
    count.textContent = Math.min(limit, ls.length) + ' of ' + ls.length;
    moreBtn.hidden = ls.length <= limit;
  }
  moreBtn.addEventListener('click', function () { limit += 100; draw(); });
  [fk, scope].forEach(function (x) { x.addEventListener('change', function () { limit = opt.page || 50; draw(); }); });
  qf.addEventListener('input', function () { limit = opt.page || 50; draw(); });
  wrap.appendChild(el('div', { cls: 'evb-tools' }, [fk, scope, qf, count]));
  wrap.appendChild(el('div', { cls: 'tbl-wrap' }, [el('table', null, [el('caption', { cls: 'sr-only', text: 'Evidence: name, SHA-256 and position in the hash chain, size and time, open and download' }), el('thead', null, [el('tr', null, ['Preview', 'Evidence', 'Size and time', 'Open'].map(function (h) { return el('th', { scope: 'col', text: h }); }))]), tbody])]));
  wrap.appendChild(moreBtn);
  draw();
  return wrap;
}

// ------------------------------------------------------------ test detail parts
function stepShots(t) {
  var list = [], n = 0;
  walkSteps(t.steps, function (s) {
    n++;
    (s.e || []).forEach(function (id) { var r = evRef(id); if (r && r.kind === 'screenshot' && r.url) list.push({ id: id, url: r.url, step: s, n: n, alt: 'Step ' + n + ': ' + s.n + ' – ' + r.label }); });
    if (s.dg && s.dg.screenshot) { var d = evRef(s.dg.screenshot); if (d && d.url && !list.some(function (x) { return x.id === d.id; })) list.push({ id: d.id, url: d.url, step: s, n: n, alt: 'Step ' + n + ': ' + s.n + ' (target highlighted)' }); }
  });
  return list;
}
function failingStep(steps) {
  for (var i = 0; i < (steps || []).length; i++) { var s = steps[i]; if ((s.s === 'F' || s.s === 'B') && !s.so) return failingStep(s.ch) || s; }
  return null;
}
function bugText(t) {
  var lines = [];
  lines.push('[' + (D.brand || 'Test report') + '] ' + t.name + (t.failedStep ? ' - fails at: ' + t.failedStep : ''));
  lines.push('');
  lines.push(cap(NOUN.test) + ': ' + t.name + ' (' + t.id + ')');
  lines.push('Run: ' + D.runId + ' at ' + D.startedAt);
  if (D.environment) lines.push('Environment: ' + D.environment);
  if (D.baseUrl) lines.push('Base URL: ' + D.baseUrl);
  if (t.browser || (D.browsers && D.browsers.length)) lines.push('Browser: ' + (t.browser || D.browsers.join(', ')));
  if (D.branch) lines.push('Branch: ' + D.branch + (D.commit ? ' @ ' + D.commit.slice(0, 12) : ''));
  if (t.row) lines.push('Data: ' + Object.keys(t.row).map(function (k) { return k + '=' + t.row[k]; }).join(', '));
  lines.push('');
  lines.push('Steps:');
  var n = 0;
  walkSteps(t.steps, function (s, depth) { n++; lines.push(new Array(depth + 1).join('  ') + n + '. [' + STEP[s.s][1] + '] ' + s.n); });
  if (t.error) { lines.push(''); lines.push('Error:'); lines.push(t.error.message); }
  if (t.cat) { lines.push(''); lines.push('Category: ' + CAT[t.cat.c] + ' (' + t.cat.why + ')'); lines.push('Suggested next step: ' + t.cat.fix); }
  if (t.signature) lines.push('Failure signature: ' + t.signature + (t.failure && t.failure.known ? ' (known since ' + (t.failure.firstSeenRun || '?') + ')' : ' (new in this run)'));
  if (t.ado && t.ado.testCases.length) lines.push('Test case: ' + t.ado.testCases.map(function (c) { return '#' + c.id + (c.url ? ' ' + c.url : ''); }).join(', '));
  if (t.owners.length) lines.push('Owners: ' + t.owners.join(', '));
  lines.push('Report: ' + location.href.split('#')[0] + testHash(t.id));
  return lines.join('\n');
}
/** Before / after compare: a slider reveals the after image over the before image; or side by side. */
function compareView(a, b, labels, overlay) {
  var wrap = el('div', { cls: 'cmp' });
  var stage = el('div', { cls: 'cmp-stage' });
  var imgA = el('img', { src: b.url, alt: labels[1] + ': ' + b.alt, cls: 'cmp-a' });
  var top = el('div', { cls: 'cmp-top', style: 'width:50%' }, [el('img', { src: a.url, alt: labels[0] + ': ' + a.alt })]);
  var ov = overlay ? el('img', { src: overlay, alt: 'Pixel differences', cls: 'cmp-diff', style: 'opacity:0' }) : null;
  stage.appendChild(imgA); stage.appendChild(top); if (ov) stage.appendChild(ov);
  var topImg = top.firstChild;
  function fit() { var w = stage.clientWidth; if (w) topImg.style.width = w + 'px'; }
  if (typeof ResizeObserver === 'function') new ResizeObserver(fit).observe(stage);
  imgA.addEventListener('load', fit);
  stage.appendChild(el('span', { cls: 'cmp-lbl l', text: labels[0] })); stage.appendChild(el('span', { cls: 'cmp-lbl r', text: labels[1] }));
  var range = el('input', { type: 'range', min: '0', max: '100', value: '50', 'aria-label': 'Compare: share of ' + labels[0] + ' shown' });
  range.addEventListener('input', function () { top.style.width = range.value + '%'; });
  var tools = el('div', { cls: 'cmp-tools' }, [el('label', { cls: 'small' }, ['Compare ', range])]);
  if (ov) {
    var dr = el('input', { type: 'range', min: '0', max: '100', value: '0', 'aria-label': 'Diff overlay opacity' });
    dr.addEventListener('input', function () { ov.style.opacity = String(dr.value / 100); });
    tools.appendChild(el('label', { cls: 'small' }, ['Diff overlay ', dr]));
  }
  var side = el('div', { cls: 'ba', hidden: true });
  [[a, labels[0]], [b, labels[1]]].forEach(function (p) {
    var btn = el('button', { type: 'button', 'aria-label': 'Enlarge: ' + p[1] }, [el('img', { src: p[0].url, alt: p[1] + ': ' + p[0].alt })]);
    btn.addEventListener('click', function () { openLightbox([{ url: a.url, alt: labels[0] + ': ' + a.alt }, { url: b.url, alt: labels[1] + ': ' + b.alt }], p[0] === a ? 0 : 1, btn); });
    side.appendChild(el('figure', null, [el('div', { cls: 'lbl', text: p[1] }), btn]));
  });
  var mode = el('button', { type: 'button', cls: 'btn', 'aria-pressed': 'false', text: 'Side by side' });
  mode.addEventListener('click', function () { var sideOn = side.hidden; side.hidden = !sideOn; stage.hidden = sideOn; tools.hidden = sideOn; mode.setAttribute('aria-pressed', String(sideOn)); mode.textContent = sideOn ? 'Slider' : 'Side by side'; });
  var zoom = el('button', { type: 'button', cls: 'btn', text: 'Enlarge' });
  zoom.addEventListener('click', function () { openLightbox([{ url: a.url, alt: labels[0] + ': ' + a.alt }, { url: b.url, alt: labels[1] + ': ' + b.alt }], 1, zoom); });
  wrap.appendChild(el('div', { cls: 'cmp-bar' }, [mode, zoom]));
  wrap.appendChild(stage); wrap.appendChild(tools); wrap.appendChild(side);
  return wrap;
}
function snapshotView(s) {
  var phases = [];
  if (s.sn.b && SNAP[s.sn.b]) phases.push(['Before the step', s.sn.b]);
  if (s.sn.a && SNAP[s.sn.a]) phases.push(['After the step', s.sn.a]);
  if (!phases.length) return null;
  var frame = el('iframe', { sandbox: '', title: 'DOM snapshot of the step (sanitised, scripts disabled)', cls: 'snapframe', referrerpolicy: 'no-referrer' });
  frame.srcdoc = SNAP[phases[phases.length - 1][1]];
  var tabsEl = el('div', { cls: 'seg', role: 'group', 'aria-label': 'Snapshot' });
  phases.forEach(function (p, i) {
    var b = el('button', { type: 'button', 'aria-pressed': String(i === phases.length - 1), text: p[0] });
    b.addEventListener('click', function () { frame.srcdoc = SNAP[p[1]]; tabsEl.querySelectorAll('button').forEach(function (x) { if (x !== big) x.setAttribute('aria-pressed', String(x === b)); }); });
    tabsEl.appendChild(b);
  });
  var big = el('button', { type: 'button', 'aria-pressed': 'false', text: 'Taller' });
  big.addEventListener('click', function () { var on = !frame.classList.contains('tall'); frame.classList.toggle('tall', on); big.setAttribute('aria-pressed', String(on)); });
  tabsEl.appendChild(big);
  return el('div', null, [el('h4', { text: 'DOM snapshot' }), el('p', { cls: 'small muted', text: 'The page as recorded: scripts removed, no network access, the step’s target outlined.' }), tabsEl, frame]);
}
var HEAL_HINT = { 'no stored fingerprint': 'The fingerprint tier learns an element the first time the step passes; this step has not passed in this project yet, so only the semantic tier could try.', 'below threshold': 'The closest element by name was not similar enough to heal safely.' };
function healNotesView(notes) {
  var hint = null;
  Object.keys(HEAL_HINT).forEach(function (k) { if (!hint && notes.some(function (n) { return n.indexOf(k) >= 0; })) hint = HEAL_HINT[k]; });
  return box('Self-healing tried, did not heal', [el('ul', { cls: 'small', style: 'margin:0' }, notes.map(function (n) { return el('li', { text: n }); })), hint ? el('p', { cls: 'small muted', style: 'margin:0', text: hint }) : null]);
}
function healView(h) {
  return box('Self-healing', [el('div', { cls: 'heal-diff' }, [el('code', { cls: 'old', text: h.from.join(' | ') }), el('span', { 'aria-hidden': 'true', text: '→' }), el('code', { cls: 'new', text: h.to })]), el('span', { cls: 'sr-only', text: 'Old locator ' + h.from.join(' | ') + ', new locator ' + h.to }), el('p', { cls: 'small', style: 'margin:0', text: h.reason + (h.element ? ' (shared element ' + h.element + ')' : '') }), h.evidence.length ? el('div', { cls: 'chips' }, h.evidence.map(evLink)) : null],
    [badge(h.verified ? 'passed' : 'failed', h.verified ? 'verified' : 'not verified'), el('span', { cls: 'chip', text: h.tier }), el('span', { cls: 'chip', text: Math.round(h.confidence * 100) + '% confidence' })]);
}
function visualView(vd) {
  return el('div', null, vd.map(function (v) {
    var kids = [el('p', { cls: 'small', style: 'margin:0' }, [el('strong', { text: 'Visual check ' + v.key + ': ' }), v.message + (v.ratio !== undefined ? ' (' + (v.ratio * 100).toFixed(2) + '% of pixels differ)' : '')])];
    if (v.baseline && v.actual) kids.push(compareView({ url: v.baseline, alt: 'baseline ' + v.key }, { url: v.actual, alt: 'actual ' + v.key }, ['Baseline', 'Actual'], v.diff));
    else if (v.actual) kids.push(el('img', { src: v.actual, alt: 'Actual ' + v.key, style: 'max-width:100%' }));
    return box(null, kids);
  }));
}
function prettyBody(b) { if (b === undefined) return ''; try { return JSON.stringify(JSON.parse(b), null, 2); } catch (e) { return b; } }
function headersText(h) { return Object.keys(h || {}).map(function (k) { return k + ': ' + h[k]; }).join('\n'); }
function apiView(a) {
  var ok = a.status && a.status < 400;
  return el('div', { cls: 'box' }, [el('div', { cls: 'box-h' }, [el('code', { text: a.method + ' ' + a.url }), badge(ok ? 'passed' : 'failed', String(a.status)), a.ms !== undefined ? el('span', { cls: 'muted small', text: fmtMs(a.ms) }) : null]),
    a.requestBody !== undefined ? el('details', null, [el('summary', { text: 'Request body' }), pre(prettyBody(a.requestBody))]) : null,
    a.responseHeaders ? el('details', null, [el('summary', { text: 'Response headers' }), pre(headersText(a.responseHeaders))]) : null,
    a.responseBody !== undefined ? el('details', { open: true }, [el('summary', { text: 'Response body (masked)' }), pre(prettyBody(a.responseBody))]) : null]);
}
function dbView(db) {
  var head = el('tr', null, db.columns.map(function (c) { return el('th', { scope: 'col', text: c }); }));
  var tbd = el('tbody', null, db.rows.map(function (r) { return el('tr', null, r.map(function (c) { return el('td', { cls: 'mono', text: c === null ? 'NULL' : String(c) }); })); }));
  return el('div', { cls: 'tbl-wrap' }, [el('table', null, [el('caption', { text: 'Query result ' + db.key + ' (' + db.total + ' row' + (db.total === 1 ? '' : 's') + (db.total > db.rows.length ? ', first ' + db.rows.length + ' shown' : '') + ', masked)' }), el('thead', null, [head]), tbd])]);
}
function spark(seq) {
  var s = el('span', { cls: 'spark', role: 'img', 'aria-label': 'History, oldest first: ' + seq.split('').map(function (c) { return c === 'P' ? 'pass' : c === 'H' ? 'healed pass' : 'fail'; }).join(', ') });
  seq.split('').forEach(function (c) { s.appendChild(el('i', { cls: c === 'P' || c === 'H' || c === 'F' ? c : 'F' })); });
  return s;
}
function fmtClock(s) { s = Math.max(0, s || 0); var m = Math.floor(s / 60); var r = s % 60; return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1); }

var videoCtl = null;
/** The video player: chapters (steps) that seek, the failing moment, playback speed, one source per attempt. */
function videoView(t, failCueIdx) {
  var list = t.videos && t.videos.length ? t.videos : [t.video];
  var vid = el('video', { controls: true, preload: 'metadata', playsinline: true, src: list[0].src, poster: t.poster || null, cls: 'vplayer' });
  var chapters = el('ol', { cls: 'vchapters', 'aria-label': 'Video chapters (steps)' });
  var marks = el('div', { cls: 'vmarks', 'aria-hidden': 'true' });
  var cues = [];
  function buildChapters(cs) {
    cues = cs; chapters.textContent = ''; marks.textContent = '';
    cs.forEach(function (c, n) {
      var failing = n === failCueIdx;
      var b = el('button', { type: 'button', cls: 'fchip' + (failing ? ' vfail' : ''), 'aria-current': 'false' }, [el('span', { cls: 'mono small', text: fmtClock(c[0]) + ' ' }), (n + 1) + '. ' + c[2], failing ? el('span', { cls: 'sr-only', text: ' (the failing step)' }) : null]);
      b.addEventListener('click', function () { seek(c[0], true); });
      chapters.appendChild(el('li', null, [b]));
    });
    vid.addEventListener('loadedmetadata', drawMarks);
    if (vid.readyState >= 1) drawMarks();
  }
  function drawMarks() {
    marks.textContent = '';
    var dur = vid.duration;
    if (!isFinite(dur) || !dur) return;
    cues.forEach(function (c, n) { marks.appendChild(el('span', { cls: 'vmark' + (n === failCueIdx ? ' f' : ''), style: 'left:' + Math.min(100, c[0] / dur * 100).toFixed(2) + '%', title: (n + 1) + '. ' + c[2] })); });
  }
  function seek(sec, play) { vid.currentTime = sec + 0.001; if (play) vid.play().catch(function () { /* autoplay blocked */ }); vid.scrollIntoView({ block: 'nearest' }); }
  vid.addEventListener('timeupdate', function () {
    var tt = vid.currentTime, btns = chapters.querySelectorAll('button');
    cues.forEach(function (c, k) { if (btns[k]) btns[k].setAttribute('aria-current', String(tt >= c[0] && tt < c[1])); });
  });
  function load(i) {
    var v = list[i];
    vid.src = v.src;
    while (vid.firstChild) vid.removeChild(vid.firstChild);
    if (v.chapters) vid.appendChild(el('track', { kind: 'chapters', src: v.chapters, srclang: 'en', label: 'Steps' }));
    buildChapters(v.cues || (i === 0 && t.video.cues) || []);
  }
  var speed = el('select', { 'aria-label': 'Playback speed' }, ['0.25', '0.5', '1', '1.5', '2'].map(function (x) { return el('option', { value: x, text: x + 'x', selected: x === '1' }); }));
  speed.addEventListener('change', function () { vid.playbackRate = Number(speed.value); });
  var tools = el('div', { cls: 'vtools' }, [el('label', { cls: 'small' }, ['Speed ', speed])]);
  if (list.length > 1) {
    var pick = el('select', { 'aria-label': 'Which video' }, list.map(function (v, i) { return el('option', { value: String(i), text: v.label || ('Video ' + (i + 1)) }); }));
    pick.addEventListener('change', function () { load(Number(pick.value)); });
    tools.appendChild(el('label', { cls: 'small' }, ['Video ', pick]));
  }
  if (failCueIdx >= 0) {
    var jf = el('button', { type: 'button', cls: 'btn', text: 'Jump to the failure' });
    jf.addEventListener('click', function () { if (cues[failCueIdx]) seek(Math.max(0, cues[failCueIdx][1] - 1.5), false); });
    tools.appendChild(jf);
  }
  load(0);
  videoCtl = { seek: seek };
  return [el('div', { cls: 'vwrap' }, [vid, marks]), tools, chapters];
}
function waterfallView(t) {
  var rws = t.waterfall;
  var span = Math.max(t.durationMs, rws.reduce(function (m, r) { return Math.max(m, r.st + (r.d || 0)); }, 1));
  var onlyBad = false, qq = '';
  var tbody = el('tbody');
  var cnt = el('span', { cls: 'muted small', 'aria-live': 'polite' });
  function draw() {
    tbody.textContent = '';
    var shown = rws.filter(function (r) { return (!onlyBad || r.f || (r.s && r.s >= 400)) && (!qq || (r.m + ' ' + r.u + ' ' + (r.s || '')).toLowerCase().indexOf(qq) >= 0); });
    shown.forEach(function (r) {
      var bad = r.f || (r.s && r.s >= 400);
      var left = Math.min(100, r.st / span * 100), w = Math.max(0.6, Math.min(100 - left, (r.d || 0) / span * 100));
      var tr = el('tr', { cls: bad ? 'net-bad' : null });
      var tg = el('button', { type: 'button', cls: 'iconbtn', 'aria-expanded': 'false', 'aria-label': 'Details of ' + r.m + ' ' + r.u }, [svgIcon('chevron')]);
      var det = null;
      tg.addEventListener('click', function () {
        var open = tg.getAttribute('aria-expanded') === 'true';
        if (!det) {
          det = el('tr', null, [el('td', { colspan: '9' }, [dl([['URL', r.u], ['Type', [r.ty, r.mime].filter(Boolean).join(', ')], ['Timing', r.w ? Object.keys(r.w).map(function (k) { return k.replace('Ms', '') + ' ' + fmtMs(r.w[k]); }).join(', ') : (r.d !== undefined ? fmtMs(r.d) : '')], ['Failure', r.f]]), r.rq ? el('details', null, [el('summary', { cls: 'small', text: 'Request headers (credentials masked)' }), pre(headersText(r.rq))]) : null, r.rs ? el('details', null, [el('summary', { cls: 'small', text: 'Response headers' }), pre(headersText(r.rs))]) : null])]);
          tr.parentNode.insertBefore(det, tr.nextSibling);
        }
        det.hidden = open; tg.setAttribute('aria-expanded', String(!open));
      });
      tr.appendChild(el('td', null, [tg]));
      tr.appendChild(el('td', { cls: 'num', text: r.step ? String(r.step) : '-' }));
      tr.appendChild(el('td', { cls: 'mono', text: r.m }));
      tr.appendChild(el('td', { cls: 'mono net-url', title: r.u, text: r.u.replace(/^https?:\/\/[^/]+/, '') || r.u }));
      tr.appendChild(el('td', null, [r.f ? badge('failed', 'failed') : badge(bad ? 'failed' : 'passed', r.s ? String(r.s) : '-')]));
      tr.appendChild(el('td', { cls: 'small', text: r.ty || '' }));
      tr.appendChild(el('td', { cls: 'num', text: r.sz !== undefined ? fmtBytes(r.sz) : '-' }));
      tr.appendChild(el('td', { cls: 'num', text: r.d !== undefined ? fmtMs(r.d) : '-' }));
      tr.appendChild(el('td', { cls: 'wf' }, [el('span', { cls: 'wf-bar' + (bad ? ' bad' : ''), style: 'left:' + left.toFixed(2) + '%;width:' + w.toFixed(2) + '%', title: '+' + fmtMs(r.st) })]));
      tbody.appendChild(tr);
    });
    cnt.textContent = shown.length + ' of ' + rws.length + ' requests';
  }
  var fb = el('button', { type: 'button', cls: 'fchip', 'aria-pressed': 'false', text: 'Failed only' });
  fb.addEventListener('click', function () { onlyBad = !onlyBad; fb.setAttribute('aria-pressed', String(onlyBad)); draw(); });
  var qf = el('input', { type: 'search', placeholder: 'Filter requests', 'aria-label': 'Filter requests' });
  qf.addEventListener('input', function () { qq = qf.value.trim().toLowerCase(); draw(); });
  draw();
  return el('div', null, [el('div', { cls: 'evb-tools' }, [fb, qf, cnt]), el('div', { cls: 'tbl-wrap' }, [el('table', { cls: 'net' }, [el('caption', { cls: 'sr-only', text: 'Requests with their timing' }), el('thead', null, [el('tr', null, ['', 'Step', 'Method', 'URL', 'Status', 'Type', 'Size', 'Time', 'Waterfall'].map(function (h, i) { return el('th', { scope: 'col', text: h, cls: i === 8 ? 'wf' : null }, i === 0 ? [el('span', { cls: 'sr-only', text: 'Details' })] : null); }))]), tbody])])]);
}
function networkTable(t) {
  var ntb = el('tbody', null, t.network.map(function (n) { return el('tr', null, [el('td', { cls: 'mono', text: n.method }), el('td', { cls: 'mono', style: 'word-break:break-all', text: n.url }), el('td', null, [n.failure ? badge('failed', n.failure) : badge(n.status >= 400 ? 'failed' : 'passed', String(n.status))]), el('td', { cls: 'num', text: n.ms !== undefined ? fmtMs(n.ms) : '-' })]); }));
  return el('div', { cls: 'tbl-wrap' }, [el('table', null, [el('caption', { text: 'Requests around the failing step' }), el('thead', null, [el('tr', null, ['Method', 'URL', 'Status', 'Time'].map(function (h) { return el('th', { scope: 'col', text: h }); }))]), ntb])]);
}
var LEVEL_STATE = { error: 'failed', warning: 'flaky', warn: 'flaky', info: 'passed', log: 'skipped', debug: 'skipped' };
function consoleView(t) {
  var rws = t.console;
  var levels = {}; rws.forEach(function (c) { levels[c.l] = (levels[c.l] || 0) + 1; });
  var on = {}; Object.keys(levels).forEach(function (l) { on[l] = true; });
  var tbody = el('tbody');
  function draw() {
    tbody.textContent = '';
    rws.filter(function (c) { return on[c.l]; }).forEach(function (c) {
      tbody.appendChild(el('tr', null, [el('td', { cls: 'num small', text: c.at !== undefined ? '+' + fmtMs(c.at) : '-' }), el('td', null, [badge(LEVEL_STATE[c.l] || 'skipped', c.l)]), el('td', { cls: 'num', text: c.step ? String(c.step) : '-' }), el('td', null, [el('span', { cls: 'mono small', text: c.t }), c.loc ? el('div', { cls: 'small muted mono', text: c.loc }) : null])]));
    });
  }
  var chips = el('div', { cls: 'chips', role: 'group', 'aria-label': 'Console levels' }, Object.keys(levels).map(function (l) {
    var b = el('button', { type: 'button', cls: 'fchip', 'aria-pressed': 'true', text: l + ' ' + levels[l] });
    b.addEventListener('click', function () { on[l] = !on[l]; b.setAttribute('aria-pressed', String(on[l])); draw(); });
    return b;
  }));
  draw();
  return el('div', null, [chips, el('div', { cls: 'tbl-wrap', style: 'margin-top:8px' }, [el('table', null, [el('caption', { cls: 'sr-only', text: 'Browser console' }), el('thead', null, [el('tr', null, ['Time', 'Level', 'Step', 'Message'].map(function (h) { return el('th', { scope: 'col', text: h }); }))]), tbody])])]);
}
function traceView(t) {
  var tr = t.trace || {};
  var kids = [];
  if (tr.studio) kids.push(el('p', null, [extLink(tr.studio, 'Open the time-travel trace in ' + (Product ? Product + ' ' : '') + 'Studio', 'btn primary'), el('span', { cls: 'small muted', text: ' (Studio must be running in the project folder)' })]));
  var ol = el('ol', { cls: 'small' });
  ol.appendChild(el('li', null, ['In the project folder run ', el('code', { text: 'npx eztest studio' }), ', open Results, this run, this ' + NOUN.test + ', then Trace.']));
  if (tr.cmd) ol.appendChild(el('li', null, ['Or read it in a terminal: ', el('code', { text: tr.cmd.replace('<runDir>', 'eztest-results/' + D.runId) })]));
  if (tr.dir) ol.appendChild(el('li', null, ['Time-travel data: ', el('code', { text: 'eztest-results/' + D.runId + '/' + tr.dir })]));
  kids.push(ol);
  if (tr.file) kids.push(el('p', null, [el('a', { cls: 'btn', href: tr.file, download: tr.file.split('/').pop() }, [svgIcon('download'), 'Download the trace file']), el('span', { cls: 'small muted mono', text: ' ' + decodeURIComponent(tr.file) })]));
  return kids;
}

/** Expected / found of a failing step's diagnosis. */
function expectedActual(dg, errMsg) {
  var cells = [];
  var norm = function (x) { return String(x || '').replace(/\s+/g, ' ').trim(); };
  // The error already says what was found: the Actual cell would repeat it.
  var sameAsError = errMsg && dg.found && norm(errMsg).indexOf(norm(dg.found)) >= 0;
  if (dg.expected) cells.push(el('div', { cls: 'exp' }, [el('div', { cls: 'k', text: 'Expected' }), el('div', { cls: 'v', text: dg.expected })]));
  if (dg.found && !sameAsError) cells.push(el('div', { cls: 'act' }, [el('div', { cls: 'k', text: 'Actual' }), el('div', { cls: 'v', text: dg.found })]));
  var extra = dl([['Did you mean', dg.similar.join('; ')], ['Console errors', dg.consoleErrors.join('\n')], ['Failed requests', dg.failedRequests.join('\n')], ['Page', dg.url]]);
  return el('div', null, [cells.length ? el('div', { cls: 'ea' }, cells) : null, extra.childNodes.length ? el('div', { style: 'margin-top:8px' }, [extra]) : null]);
}

function stepNode(s, t, num, ctx) {
  var code = STEP[s.s] || STEP.S;
  var no = ++ctx.n;
  var isFailing = s === ctx.fs;
  var gs = ctx.g; ctx.g = null;
  var BIND = { definition: 'step definition', ez: 'built-in phrasing', undefined: 'undefined step', ambiguous: 'ambiguous step' };
  var myShots = ctx.shots.filter(function (x) { return x.step === s; });
  var hasBody = isFailing || (gs && gs[2]) || s.x || s.h || (s.c && s.c.length) || s.l || s.dg || s.db || s.api || s.im || s.m || (s.w && s.w.length) || (s.e && s.e.length) || s.sn || s.hn || s.vd || myShots.length;
  var body = null;
  var bodyId = 'sb-' + ctx.uid + '-' + no;
  var row = el('button', { type: 'button', cls: 'step-row', 'aria-expanded': hasBody ? 'false' : null, 'aria-controls': hasBody ? bodyId : null, disabled: hasBody ? null : true },
    [el('span', { cls: 'step-int' }, [el('span', { cls: 'no', text: num + '.' }), gs ? el('strong', { text: gs[0] + ' ' }) : null, s.n, gs && (gs[2] === 'undefined' || gs[2] === 'ambiguous') ? el('span', { cls: 'cat c-unknown', style: 'margin-left:6px', text: BIND[gs[2]] }) : null, s.a ? el('span', { cls: 'chip', style: 'margin-left:6px', text: 'as ' + s.a }) : null, s.i ? el('span', { cls: 'chip', style: 'margin-left:6px', text: '#' + s.i }) : null, s.b ? el('span', { cls: 'chip', style: 'margin-left:6px', text: s.b }) : null, s.h ? el('span', { cls: 'badge b-healed', style: 'margin-left:6px', text: 'healed' }) : null, s.so ? el('span', { cls: 'chip', style: 'margin-left:6px', text: 'soft' }) : null, el('span', { cls: 'sr-only', text: ', ' + code[1] })]),
     el('span', { cls: 'step-dur', text: fmtMs(s.d) }), svgIcon('chevron', 'chev')]);
  var line = el('div', { cls: 'step-line' }, [sicon(code[0], code[1]), row]);
  if (myShots.length) {
    var last = myShots[myShots.length - 1];
    var sb = el('button', { type: 'button', cls: 'step-thumb', 'aria-label': 'Screenshot of step ' + num }, [el('img', { src: last.url, alt: '', loading: 'lazy' })]);
    sb.addEventListener('click', function () { openLightbox(ctx.shots, ctx.shots.indexOf(last), sb); });
    line.appendChild(sb);
  }
  var cue = ctx.cueFor(s);
  if (cue) {
    var vb = el('button', { type: 'button', cls: 'iconbtn', title: 'Play step ' + num + ' in the video', 'aria-label': 'Play step ' + num + ' in the video' }, [svgIcon('play')]);
    vb.addEventListener('click', function () { ctx.showVideo(cue[0]); });
    line.appendChild(vb);
  }
  var li = el('li', { cls: 'step' + (code[0] === 'failed' || code[0] === 'error' ? ' failed' : ''), 'data-step': no }, [line]);
  function buildBody() {
    var kids = [];
    var err = s.x || (isFailing && t.error ? t.error : null);
    if (err) kids.push(el('div', { cls: 'err', role: 'note' }, [el('strong', { text: err.name || 'Error' }), pre(err.message, ' '), err.stack ? el('details', null, [el('summary', { text: 'Stack trace' }), pre(err.stack)]) : null]));
    if (s.dg) kids.push(expectedActual(s.dg, err && err.message));
    if (isFailing && myShots.length) {
      var after = myShots[myShots.length - 1];
      var ai = ctx.shots.indexOf(after);
      var before = null;
      for (var bi2 = ai - 1; bi2 >= 0; bi2--) if (ctx.shots[bi2].step !== s) { before = ctx.shots[bi2]; break; }
      if (before) kids.push(el('div', null, [el('h4', { text: 'Before and after this step' }), compareView(before, after, ['Before', 'After'])]));
      else { var ab = el('button', { type: 'button', cls: 'shot-big', 'aria-label': 'Enlarge: ' + after.alt }, [el('img', { src: after.url, alt: after.alt })]); ab.addEventListener('click', function () { openLightbox(ctx.shots, ai, ab); }); kids.push(el('div', null, [el('h4', { text: 'Screenshot' }), ab])); }
    } else if (myShots.length) {
      var shot = myShots[myShots.length - 1];
      var sbig = el('button', { type: 'button', cls: 'shot-big', 'aria-label': 'Enlarge: ' + shot.alt }, [el('img', { src: shot.url, alt: shot.alt, loading: 'lazy' })]);
      sbig.addEventListener('click', function () { openLightbox(ctx.shots, ctx.shots.indexOf(shot), sbig); });
      kids.push(sbig);
    }
    if (s.h) kids.push(healView(s.h));
    if (s.hn) kids.push(healNotesView(s.hn));
    if (s.c && s.c.length) {
      var pc = el('tbody');
      s.c.forEach(function (c) { pc.appendChild(el('tr', null, [el('td', null, [el('code', { text: c[0] })]), el('td', null, [badge(c[1] ? 'passed' : 'failed', c[1] ? 'held' : 'failed')]), el('td', { text: c[2] })])); });
      kids.push(el('div', { cls: 'tbl-wrap' }, [el('table', null, [el('caption', { text: 'Post-conditions' }), el('thead', null, [el('tr', null, [el('th', { scope: 'col', text: 'Condition' }), el('th', { scope: 'col', text: 'Result' }), el('th', { scope: 'col', text: 'Actual' })])]), pc])]));
    }
    var facts = dl([['Bound to', gs && gs[2] ? (BIND[gs[2]] || gs[2]) + (gs[3] ? ' \u00b7 ' + gs[3] : '') : null], ['Locator', s.l ? el('code', { text: s.l }) : null], ['Better locator', s.im ? el('span', null, [el('code', { text: s.im.suggested }), ' – ' + s.im.reason]) : null], ['Manual result', s.m ? s.m.verdict + (s.m.tester ? ' by ' + s.m.tester : '') : null], ['Observed', s.m ? s.m.actual : null], ['Notes', s.m ? s.m.notes : null]]);
    if (facts.childNodes.length) kids.push(facts);
    if (s.w && s.w.length) kids.push(el('ul', { cls: 'small', style: 'margin:0' }, s.w.map(function (w) { return el('li', { text: w }); })));
    if (s.api) s.api.forEach(function (a) { kids.push(apiView(a)); });
    if (s.db) kids.push(dbView(s.db));
    if (s.vd) kids.push(visualView(s.vd));
    if (s.sn) { var sv = snapshotView(s); if (sv) kids.push(sv); }
    var other = (s.e || []).filter(function (id) { var r = evRef(id); return !r || r.kind !== 'screenshot'; });
    if (other.length) kids.push(el('div', { cls: 'chips' }, [el('span', { cls: 'small muted', text: 'Evidence:' })].concat(other.map(evLink))));
    return el('div', { cls: 'step-body', id: bodyId }, kids);
  }
  function toggle(open) {
    if (!body) { body = buildBody(); li.insertBefore(body, line.nextSibling); }
    body.hidden = !open; row.setAttribute('aria-expanded', String(open));
  }
  if (hasBody) row.addEventListener('click', function () { toggle(row.getAttribute('aria-expanded') !== 'true'); });
  if (s.ch && s.ch.length) {
    var ol = el('ol', { cls: 'step-children', 'aria-label': 'Steps inside ' + s.n });
    s.ch.forEach(function (c, i) { ol.appendChild(stepNode(c, t, num + '.' + (i + 1), ctx)); });
    li.appendChild(ol);
  }
  if (isFailing) ctx.expand.push(function () { toggle(true); });
  return li;
}

function attemptSteps(t, a, final) {
  var fin = {};
  if (final) final.steps.forEach(function (s) { fin[s[0]] = s[1]; });
  var ul = el('ul', { cls: 'attempt-steps', 'aria-label': 'Steps of attempt ' + a.attempt });
  a.steps.forEach(function (s) {
    var differs = final && fin[s[0]] !== undefined && fin[s[0]] !== s[1];
    var c = STEP[s[1]] || STEP.S;
    ul.appendChild(el('li', { cls: differs ? 'diff' : null }, [sicon(c[0], c[1]), el('span', { cls: 'grow', text: s[0] }), differs ? el('span', { cls: 'chip', text: 'differs from the final attempt' }) : null, el('span', { cls: 'step-dur', text: fmtMs(s[2]) })]));
  });
  return el('div', null, [el('p', { cls: 'small' }, [el('strong', { text: 'Attempt ' + a.attempt + ': ' + a.status }), ' in ' + fmtMs(a.durationMs) + (a.failedStep ? ', failed at ' + a.failedStep : '')]), a.error ? el('div', { cls: 'err', role: 'note', style: 'margin-bottom:10px' }, [pre(a.error, ' ')]) : null, ul]);
}

function renderDetail(t) {
  videoCtl = null;
  detail.textContent = '';
  var isF = t.state === 'failed' || t.state === 'error';
  var link = location.href.split('#')[0] + testHash(t.id);
  var copyBtn = el('button', { type: 'button', cls: 'iconbtn', title: 'Copy link', 'aria-label': 'Copy link to this ' + NOUN.test }, [svgIcon('link')]);
  copyBtn.addEventListener('click', function () { copyText(link, copyBtn); });
  var bugBtn = (isF || t.state === 'flaky') ? el('button', { type: 'button', cls: 'btn', title: 'Copy a bug report with the steps, error and links' }, [svgIcon('copy'), 'Copy for bug']) : null;
  if (bugBtn) bugBtn.addEventListener('click', function () { copyText(bugText(t), bugBtn); });
  var closeBtn = el('button', { type: 'button', cls: 'iconbtn', 'aria-label': 'Close ' + NOUN.test + ' details', title: 'Close (Esc)' }, [svgIcon('close')]);
  closeBtn.addEventListener('click', function () { go('#tests'); });
  var backBtn = el('button', { type: 'button', cls: 'btn quiet d-back', 'aria-label': 'Back to the list' }, [svgIcon('back'), 'Back']);
  backBtn.addEventListener('click', function () { go('#tests'); });
  var meta = el('ul', { cls: 'd-meta', 'aria-label': 'About this ' + NOUN.test });
  function m(label, v) { if (v === undefined || v === null || v === '') return; meta.appendChild(el('li', null, [label + ' ', el('b', null, [v])])); }
  m('Duration', fmtMs(t.durationMs)); m('Browser', t.browser); m('Attempts', t.attempt > 1 && !(t.attempts && t.attempts.length > 1) ? String(t.attempt) : null);
  m('Suite', t.suite.join(' › ')); m('File', t.file ? t.file.split(/[\\/]/).slice(-2).join('/') : null); m('Owners', t.owners.join(', ')); m('Actors', t.actors.join(', '));
  if (t.manual) m('Manual', t.manual.type + (t.manual.testers.length ? ' by ' + t.manual.testers.join(', ') : '') + (t.manual.pending ? ', ' + t.manual.pending + ' step(s) not executed' : ''));
  var chips = el('div', { cls: 'chips' });
  t.tags.forEach(function (g) { chips.appendChild(el('span', { cls: 'chip mono', text: g })); });
  if (t.row) Object.keys(t.row).forEach(function (k) { chips.appendChild(el('span', { cls: 'chip', title: 'Data row' }, [el('span', { cls: 'muted', text: k + ' ' }), el('strong', { text: t.row[k] })])); });
  t.requirementLinks.forEach(function (r) { chips.appendChild(extLink(r.url, 'Requirement ' + r.id, 'chip')); });
  if (t.ado) {
    t.ado.testCases.forEach(function (c) { chips.appendChild(extLink(c.url, 'Test case #' + c.id, 'chip')); });
    if (t.ado.plan) chips.appendChild(extLink(t.ado.plan.url, 'Plan ' + t.ado.plan.id, 'chip'));
    if (t.ado.suite) chips.appendChild(extLink(t.ado.suite.url, 'Suite ' + t.ado.suite.id, 'chip'));
    t.ado.results.forEach(function (r) { chips.appendChild(extLink(r.url, 'Azure DevOps result' + (r.resultId ? ' ' + r.resultId : '') + (r.outcome ? ': ' + r.outcome : ''), 'chip')); });
  }
  t.bugs.forEach(function (b) { chips.appendChild(extLink(b.url, (b.system === 'ado' ? 'Bug ' : 'Jira ') + b.id + ' (' + b.action + ')', 'chip')); });
  var head = el('div', { cls: 'd-head' }, [
    el('div', { cls: 'd-top' }, [backBtn, el('div', { cls: 'grow' }, [badge(t.state), el('h2', { cls: 'd-title', id: 'd-title', text: t.name })]), el('div', { cls: 'd-actions' }, [bugBtn, copyBtn, closeBtn])]),
    meta, chips.childNodes.length ? chips : null]);
  detail.appendChild(head);
  // attempts: a segmented control; the final attempt shows the full timeline
  var attempts = t.attempts && t.attempts.length > 1 ? t.attempts : null;
  var shownAttempt = attempts ? attempts.length - 1 : 0;
  var seg = null;
  if (attempts) {
    seg = el('div', { cls: 'seg', role: 'group', 'aria-label': 'Attempts' });
    attempts.forEach(function (a, i) {
      var ok = /pass/.test(a.status);
      var b = el('button', { type: 'button', 'aria-pressed': String(i === shownAttempt) }, [sicon(ok ? 'passed' : 'failed', a.status), 'Attempt ' + a.attempt + (i === attempts.length - 1 ? ' (final)' : '')]);
      b.addEventListener('click', function () { shownAttempt = i; seg.querySelectorAll('button').forEach(function (x, k) { x.setAttribute('aria-pressed', String(k === i)); }); selectSub('steps', false, true); });
      seg.appendChild(b);
    });
    head.appendChild(seg);
  }
  // the cause, once: category, new or known, next step, shared root cause
  if (isF || t.state === 'flaky') {
    var parts = [];
    var r1 = el('div', { cls: 'row1' }, [t.cat ? el('span', { cls: 'cat c-' + t.cat.c, text: CAT[t.cat.c] }) : null, t.failure ? el('span', { cls: 'cat ' + (t.failure.known ? 'c-unknown' : 'c-new'), text: t.failure.known ? 'seen before' + (t.failure.streak ? ', ' + t.failure.streak + ' runs in a row' : '') : 'new' }) : null, t.state === 'flaky' && t.flake ? el('span', { cls: 'small', text: 'Passed on retry. Cause: ' + t.flake.cause + ' (' + Math.round(t.flake.confidence * 100) + '%) – ' + t.flake.reason }) : null]);
    parts.push(r1);
    if (t.cat) parts.push(el('div', null, [el('strong', { text: 'Next step: ' }), t.cat.fix]));
    if (t.cluster) {
      var sharing = T.filter(function (x) { return x.cluster === t.cluster && x.id !== t.id; });
      if (sharing.length) parts.push(el('div', { cls: 'chips' }, [el('span', { cls: 'small', text: 'Same cause as ' + sharing.length + ' other ' + (sharing.length === 1 ? NOUN.test : NOUN.tests) + ':' })].concat(sharing.slice(0, 6).map(function (x) { return el('a', { cls: 'chip', href: testHash(x.id), text: x.name }); }))));
    }
    if (t.triage) parts.push(el('details', null, [el('summary', { text: 'Probable cause: ' + t.triage.category + ' (' + Math.round(t.triage.confidence * 100) + '% confidence)' + (t.triage.status === 'needs-human' ? ', needs review' : '') }), el('ul', { style: 'margin:6px 0 0' }, t.triage.reasons.map(function (r) { return el('li', { text: r }); })), t.triage.secondOpinion ? el('p', { cls: 'muted', text: 'Second opinion: ' + t.triage.secondOpinion }) : null, t.triage.evidence.length ? el('div', { cls: 'chips' }, t.triage.evidence.map(evLink)) : null]));
    detail.appendChild(el('div', { cls: 'cause' + (t.state === 'flaky' ? ' flaky' : ''), role: 'note', 'aria-label': 'Cause' }, parts));
  }
  // sub-tabs
  var fs = failingStep(t.steps);
  var shots = stepShots(t);
  var cueList = (t.video && t.video.cues) || [];
  var used = {};
  function cueFor(s) { for (var i = 0; i < cueList.length; i++) if (!used[i] && cueList[i][2] === s.n) { used[i] = 1; return cueList[i]; } return null; }
  var failCue = -1;
  if (fs) for (var ci = 0; ci < cueList.length; ci++) if (cueList[ci][2] === fs.n) failCue = ci;
  var ti = byId[t.id];
  var allEv = Object.keys(EV).filter(function (id) { return EV[id][7] === ti; });
  var stepCount = 0; walkSteps(t.steps, function () { stepCount++; });
  var subs = [['steps', 'Steps', stepCount]];
  if (t.console && t.console.length) subs.push(['logs', 'Logs', t.console.length]);
  if ((t.waterfall && t.waterfall.length) || (t.network && t.network.length)) subs.push(['network', 'Network', (t.waterfall || t.network).length]);
  if (t.video || t.videoNote) subs.push(['video', 'Video', null]);
  if (t.trace) subs.push(['trace', 'Trace', null]);
  if (allEv.length) subs.push(['evidence', 'Evidence', allEv.length]);
  if (t.history) subs.push(['history', 'History', null]);
  var uid = String(ti);
  var bar = el('div', { cls: 'subtabs', role: 'tablist', 'aria-label': cap(NOUN.test) + ' details' });
  var panes = {};
  subs.forEach(function (s, i) {
    bar.appendChild(el('button', { type: 'button', role: 'tab', cls: 'subtab', id: 'st-' + uid + '-' + s[0], 'aria-controls': 'sp-' + uid + '-' + s[0], 'aria-selected': 'false', tabindex: '-1', 'data-sub': s[0] }, [s[1], s[2] !== null ? el('span', { cls: 'n', text: String(s[2]) }) : null]));
    panes[s[0]] = el('div', { cls: 'subpanel', role: 'tabpanel', id: 'sp-' + uid + '-' + s[0], 'aria-labelledby': 'st-' + uid + '-' + s[0], tabindex: '0', hidden: true });
  });
  detail.appendChild(bar);
  subs.forEach(function (s) { detail.appendChild(panes[s[0]]); });
  var built = {};
  function build(id) {
    var p = panes[id];
    p.textContent = '';
    if (id === 'steps') {
      if (attempts && shownAttempt < attempts.length - 1) { p.appendChild(attemptSteps(t, attempts[shownAttempt], attempts[attempts.length - 1])); return; }
      if (t.error && !fs) p.appendChild(el('div', { cls: 'err', role: 'note', style: 'margin-bottom:12px' }, [el('strong', { text: t.error.name || 'Error' }), pre(t.error.message, ' '), t.error.stack ? el('details', null, [el('summary', { text: 'Stack trace' }), pre(t.error.stack)]) : null]));
      var ol = el('ol', { cls: 'steps', 'aria-label': 'Steps of ' + t.name });
      var ctx = { n: 0, shots: shots, cueFor: cueFor, fs: fs, expand: [], uid: uid, showVideo: function (sec) { selectSub('video', true); if (videoCtl) videoCtl.seek(sec, true); } };
      if (t.gherkin) {
        var gk = t.gherkin;
        p.appendChild(el('p', { cls: 'small muted', style: 'margin:0 0 10px' }, [el('strong', { text: gk.keyword + ' ' }), gk.file + ':' + gk.line + (gk.examples ? ' \u00b7 ' + gk.examples : '')]));
      }
      t.steps.forEach(function (s, i) { ctx.g = t.gherkin && t.gherkin.steps[i] && s.n.indexOf(t.gherkin.steps[i][1]) >= 0 ? t.gherkin.steps[i] : null; ol.appendChild(stepNode(s, t, String(i + 1), ctx)); });
      p.appendChild(ol);
      ctx.expand.forEach(function (f) { f(); });
      if (!t.steps.length) p.appendChild(el('p', { cls: 'muted', text: 'No steps recorded.' }));
    } else if (id === 'logs') p.appendChild(consoleView(t));
    else if (id === 'network') p.appendChild(t.waterfall && t.waterfall.length ? waterfallView(t) : networkTable(t));
    else if (id === 'video') { if (t.video) videoView(t, failCue).forEach(function (k) { p.appendChild(k); }); else p.appendChild(el('p', { cls: 'muted', text: t.videoNote })); }
    else if (id === 'trace') traceView(t).forEach(function (k) { p.appendChild(k); });
    else if (id === 'evidence') { p.appendChild(evidenceBrowser(allEv, { page: 50 })); p.appendChild(el('p', { cls: 'small muted', text: 'Every file is hash-chained in the run’s evidence manifest. Links are relative to the run folder, so they work from the folder, from file:// and after unzipping it.' })); }
    else if (id === 'history') { var h = t.history; p.appendChild(el('div', { style: 'display:grid;gap:12px' }, [el('div', null, [el('span', { cls: 'small muted', text: 'Recent outcomes, oldest first ' }), spark(h.sequence)]), dl([['State', h.state], ['Failure rate', Math.round(h.failRate * 100) + '% of ' + h.samples + ' runs'], ['Flips', h.flips !== undefined ? String(h.flips) : null], ['Why', h.reasons.join('; ')]])])); }
    built[id] = true;
  }
  function selectSub(id, focus, rebuildIt) {
    if (!panes[id]) id = 'steps';
    st.sub = id;
    bar.querySelectorAll('[role=tab]').forEach(function (b) { var on = b.getAttribute('data-sub') === id; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); });
    Object.keys(panes).forEach(function (k) { panes[k].hidden = k !== id; });
    if (!built[id] || rebuildIt) build(id);
  }
  tablist(bar, function (tab) { selectSub(tab.getAttribute('data-sub'), false); });
  selectSub(panes[st.sub] && st.sub !== 'video' ? st.sub : 'steps', false);
  detail.classList.add('open');
}

function openTest(id) {
  var i = byId[id];
  if (i === undefined || !hasExplorer) return false;
  st.open = id;
  renderDetail(T[i]);
  var ri = -1;
  for (var r = 0; r < rows.length; r++) if (rows[r].t === i) { ri = r; break; }
  if (ri < 0) {
    if (!matches(i)) { st.state = 'all'; st.query = ''; q.value = ''; st.tag = st.owner = st.browser = st.cat = ''; [fTag, fOwner, fBrowser, fCat].forEach(function (s) { if (s) s.value = ''; }); document.querySelectorAll('.fchip[data-state]').forEach(function (x) { x.setAttribute('aria-pressed', String(x.getAttribute('data-state') === 'all')); }); }
    st.collapsed = {}; rebuild();
    for (r = 0; r < rows.length; r++) if (rows[r].t === i) { ri = r; break; }
  }
  if (ri >= 0) { st.active = ri; var top = ri * ROW_H; if (top < vlist.scrollTop || top + ROW_H > vlist.scrollTop + vlist.clientHeight) vlist.scrollTop = Math.max(0, top - vlist.clientHeight / 2); }
  render(true);
  document.body.classList.toggle('detail-open', true);
  return true;
}
function closeTest(focusList) {
  if (!st.open) return;
  st.open = null;
  detail.textContent = '';
  detail.appendChild(el('div', { cls: 'd-empty' }, [el('div', null, [svgIcon('list'), el('p', { text: 'Select a ' + NOUN.test + ' to see its steps, logs and evidence.' })])]));
  detail.classList.remove('open');
  document.body.classList.remove('detail-open');
  render(true);
  if (focusList) { var n = rendered[st.active]; if (n) n.focus(); }
}

// ------------------------------------------------------------ tabs and routing
var tabListEl = document.getElementById('tablist');
var TABS = D.tabs || [];
var currentTab = null;
var tabsCtl = tabListEl ? tablist(tabListEl, function (tab) { var id = tab.getAttribute('data-tab'); if (id !== currentTab || (id === 'tests' && st.open)) go(id === 'tests' && st.open ? testHash(st.open) : '#' + id); }) : null;
function showTab(id) {
  if (TABS.indexOf(id) < 0) id = TABS[0];
  var changed = id !== currentTab;
  currentTab = id;
  document.querySelectorAll('[role=tabpanel].tabpanel').forEach(function (p) { var on = p.getAttribute('data-tab') === id; p.classList.toggle('is-active', on); });
  if (tabListEl) tabListEl.querySelectorAll('[role=tab]').forEach(function (t) { var on = t.getAttribute('data-tab') === id; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; if (on && t.scrollIntoView && changed) t.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
  store.set('ez-report-tab', id);
  if (id === 'tests' && changed) { layoutHeader(); render(true); }
  return changed;
}
function go(hash) {
  if (location.hash === hash) { route(); return; }
  try { history.pushState(null, '', hash); } catch (e) { location.hash = hash; return; }
  route();
}
function parseParams(s) { var o = {}; (s || '').split('&').forEach(function (kv) { var p = kv.split('='); if (p[0]) { try { o[p[0]] = decodeURIComponent(p[1] || ''); } catch (e) { o[p[0]] = p[1] || ''; } } }); return o; }
function route() {
  var h = location.hash || '';
  var legacy = { '#summary': 'overview', '#context': 'environment', '#integrations': 'environment', '#evidence': 'environment', '#comparison': 'trends', '#features': 'tests' };
  var m;
  if (legacy[h]) { replace('#' + legacy[h]); return; }
  if ((m = /^#test\/(.+)$/.exec(h))) { replace('#tests/' + m[1]); return; }
  if ((m = /^#filter\/([a-z]+)$/.exec(h))) { replace('#tests?state=' + m[1]); return; }
  if ((m = /^#category\/([a-z]+)$/.exec(h))) { replace('#tests?cat=' + m[1]); return; }
  if ((m = /^#tests\/(.+)$/.exec(h))) {
    var id; try { id = decodeURIComponent(m[1]); } catch (e) { id = m[1]; }
    var changed = showTab('tests');
    if (st.open !== id || !detail.querySelector('#d-title')) openTest(id);
    if (changed) window.scrollTo(0, 0);
    detail.focus({ preventScroll: true });
    return;
  }
  if ((m = /^#tests\?(.*)$/.exec(h))) {
    showTab('tests'); closeTest(false);
    var p = parseParams(m[1]);
    if (p.cat !== undefined && fCat) { st.cat = CAT[p.cat] ? p.cat : ''; fCat.value = st.cat; if (st.cat) { var mf = document.getElementById('more-filters'); if (mf) mf.open = true; } }
    if (p.tag !== undefined && fTag) { st.tag = p.tag; fTag.value = p.tag; }
    if (p.q !== undefined) { st.query = p.q; q.value = p.q; }
    setState(p.state || 'all');
    window.scrollTo(0, 0);
    return;
  }
  if ((m = /^#failures\/(.+)$/.exec(h))) {
    showTab('failures');
    var g = document.getElementById('failures/' + decodeURIComponent(m[1]));
    if (g) { g.scrollIntoView({ block: 'start' }); window.scrollBy(0, -parseInt(getComputedStyle(root).getPropertyValue('--stick') || '0', 10)); g.focus({ preventScroll: true }); }
    return;
  }
  var tab = h.slice(1);
  if (tab === 'tests') { showTab('tests'); closeTest(true); return; }
  if (TABS.indexOf(tab) >= 0) { if (showTab(tab)) window.scrollTo(0, 0); return; }
  if (h) { var target = document.getElementById(tab); var panel = target && target.closest('.tabpanel'); if (panel) { showTab(panel.getAttribute('data-tab')); target.scrollIntoView({ block: 'start' }); return; } }
  var saved = store.get('ez-report-tab');
  showTab(TABS.indexOf(saved) >= 0 ? saved : TABS[0]);
}
function replace(hash) { try { history.replaceState(null, '', hash); } catch (e) { /* ignore */ } route(); }
window.addEventListener('popstate', route);
window.addEventListener('hashchange', route);
document.addEventListener('click', function (ev) {
  var b = ev.target.closest ? ev.target.closest('[data-copy-bug]') : null;
  if (b) { var t = T[byId[b.getAttribute('data-copy-bug')]]; if (t) copyText(bugText(t), b); }
});

// ------------------------------------------------------------ keyboard shortcuts
var help = null;
function showHelp() {
  if (!help) {
    var rowsH = [['/', 'Search ' + NOUN.tests], ['↑ ↓', 'Move in the list'], ['Enter', 'Open the ' + NOUN.test + ' or group'], ['← →', 'Switch tabs (on a tab), collapse / expand a group'], ['Esc', 'Close the ' + NOUN.test + ' or the screenshot'], ['?', 'These shortcuts']];
    var closeH = el('button', { type: 'button', cls: 'btn', text: 'Close' });
    help = el('dialog', { cls: 'lightbox', 'aria-label': 'Keyboard shortcuts' }, [el('div', { cls: 'lb-in', style: 'min-width:min(420px,90vw)' }, [el('h2', { text: 'Keyboard shortcuts' }), el('table', null, [el('tbody', null, rowsH.map(function (r) { return el('tr', null, [el('th', { scope: 'row' }, [el('span', { cls: 'kbd', text: r[0] })]), el('td', { text: r[1] })]); }))]), el('div', null, [closeH])])]);
    closeH.addEventListener('click', function () { help.close(); });
    document.body.appendChild(help);
  }
  if (typeof help.showModal === 'function') help.showModal();
}
document.addEventListener('keydown', function (ev) {
  var tag = (ev.target && ev.target.tagName) || '';
  var editing = /INPUT|TEXTAREA|SELECT/.test(tag) || (ev.target && ev.target.isContentEditable);
  if (ev.key === '/' && !editing && hasExplorer) { ev.preventDefault(); if (currentTab !== 'tests') go(st.open ? testHash(st.open) : '#tests'); q.focus(); }
  else if (ev.key === 'Escape' && !editing && st.open && !(lb && lb.open) && !(help && help.open) && Date.now() - lbClosedAt > 300) { go('#tests'); }
  else if (ev.key === '?' && !editing) { showHelp(); }
});

// ------------------------------------------------------------ environment: configuration filter, run-wide evidence
var cfgQ = document.getElementById('cfg-q');
if (cfgQ) cfgQ.addEventListener('input', function () {
  var v = cfgQ.value.trim().toLowerCase(), shown = 0, rowsC = document.querySelectorAll('#cfg-table tbody tr');
  rowsC.forEach(function (tr) { var on = !v || (tr.textContent || '').toLowerCase().indexOf(v) >= 0; tr.hidden = !on; if (on) shown++; });
  var n = document.getElementById('cfg-count'); if (n) n.textContent = shown + ' of ' + rowsC.length;
});
var evLoad = document.getElementById('ev-load');
if (evLoad) evLoad.addEventListener('click', function () { var host = document.getElementById('ev-browser'); host.textContent = ''; host.appendChild(evidenceBrowser(Object.keys(EV), { runWide: true, page: 50 })); });

// ------------------------------------------------------------ print: one section per test
var printHost = document.getElementById('print-tests');
window.addEventListener('beforeprint', function () {
  if (!printHost || printHost.childNodes.length) return;
  var list = T.slice().sort(function (a, b) { return SEVERITY[a.state] - SEVERITY[b.state]; }).slice(0, 2000);
  list.forEach(function (t) {
    var isF = t.state === 'failed' || t.state === 'error' || t.state === 'flaky';
    var ol = el('ol');
    var n = 0;
    walkSteps(t.steps, function (s) { if (n++ < 80) ol.appendChild(el('li', null, [STEP[s.s][1] + ' – ' + s.n + ' (' + fmtMs(s.d) + ')'])); });
    printHost.appendChild(el('section', { cls: 'ptest' + (isF ? ' fail' : '') }, [el('h3', null, [badge(t.state), ' ', t.name]), el('p', { cls: 'small muted', text: [fmtMs(t.durationMs), t.browser, t.suite.join(' / '), t.tags.join(' ')].filter(Boolean).join(' · ') }), t.error ? pre(t.error.message) : null, t.cat ? el('p', { cls: 'small' }, [el('strong', { text: 'Next step: ' }), t.cat.fix]) : null, ol]));
  });
  if (T.length > list.length) printHost.appendChild(el('p', { cls: 'muted', text: (T.length - list.length) + ' more ' + NOUN.tests + ' in the report.' }));
});

rebuild();
route();
window.__ezReport = { tests: T.length, rows: function () { return rows.length; }, open: function (id) { go(testHash(id)); }, tab: function () { return currentTab; } };
})();
`;

export const REPORT_SCRIPT = SCRIPT.replace('__ICONS__', () => JSON.stringify(ICON_PATHS).replace(/</g, '\\u003c'));
