/**
 * The report's inline script (plain ES2017, no dependencies). It reads the
 * embedded model and builds the test explorer and test details with DOM APIs
 * and textContent only; it never writes data through innerHTML.
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
var ICONS = __ICONS__;
var LABEL = { passed: 'Passed', healed: 'Healed', flaky: 'Flaky', failed: 'Failed', error: 'Error', skipped: 'Skipped' };
var STATE_ICON = { passed: 'check', healed: 'heal', flaky: 'retry', failed: 'x', error: 'alert', skipped: 'minus' };
var STEP = { P: ['passed', 'Passed'], H: ['healed', 'Passed (healed)'], F: ['failed', 'Failed'], S: ['skipped', 'Skipped'], B: ['error', 'Blocked'] };
var SEVERITY = { failed: 0, error: 1, flaky: 2, healed: 3, skipped: 4, passed: 5 };
var CAT = { product: 'Product defect', test: 'Test issue', environment: 'Environment', data: 'Test data', flaky: 'Flaky', unknown: 'Needs review' };
var byId = {};
for (var bi = 0; bi < T.length; bi++) byId[T[bi].id] = bi;

// ------------------------------------------------------------ helpers
var SVGNS = 'http://www.w3.org/2000/svg';
var iconCache = {};
function svgIcon(name) {
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
  return c.cloneNode(true);
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
function badge(state, label) { return el('span', { cls: 'badge b-' + state }, [svgIcon(STATE_ICON[state] || 'minus'), label || LABEL[state] || state]); }
function safeUrl(u) { return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null; }
function extLink(url, label, cls) {
  var u = safeUrl(url);
  if (!u) return el('span', { cls: cls, text: label });
  return el('a', { href: u, target: '_blank', rel: 'noopener noreferrer', cls: cls }, [label, el('span', { cls: 'sr-only', text: ' (opens in a new tab)' })]);
}
function panel(title, body, extra) {
  return el('section', { cls: 'panel' }, [el('h3', null, [title].concat(extra || [])), el('div', { cls: 'pb' }, body)]);
}
function dl(rows) {
  var d = el('dl', { cls: 'kv' });
  rows.forEach(function (r) { if (r[1] === undefined || r[1] === null || r[1] === '') return; d.appendChild(el('dt', { text: r[0] })); d.appendChild(el('dd', null, [r[1]])); });
  return d;
}
function pre(text, cls) { return el('pre', { cls: cls || 'code', text: text }); }
function walkSteps(steps, fn, depth) { (steps || []).forEach(function (s) { fn(s, depth || 0); walkSteps(s.ch, fn, (depth || 0) + 1); }); }
function copyText(text, btn) {
  function done() { if (btn) { var o = btn.getAttribute('data-label') || btn.textContent; btn.setAttribute('data-label', o); var note = el('span', { cls: 'copy-ok', role: 'status', text: ' Copied' }); btn.parentNode && btn.parentNode.insertBefore(note, btn.nextSibling); setTimeout(function () { note.remove(); }, 1600); } }
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

// ------------------------------------------------------------ theme, print, exports
var root = document.documentElement, tb = document.getElementById('theme-toggle');
function setTheme(t) {
  root.setAttribute('data-theme', t);
  if (tb) {
    tb.setAttribute('aria-pressed', String(t === 'dark'));
    while (tb.firstChild) tb.removeChild(tb.firstChild);
    tb.appendChild(svgIcon(t === 'dark' ? 'sun' : 'moon'));
    tb.appendChild(el('span', { text: t === 'dark' ? 'Light theme' : 'Dark theme' }));
  }
  store.set('ez-report-theme', t);
}
var savedTheme = store.get('ez-report-theme');
setTheme(savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
if (tb) tb.addEventListener('click', function () { setTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); });
var pb = document.getElementById('print-btn');
if (pb) pb.addEventListener('click', function () { document.querySelectorAll('.viz-table').forEach(function (d) { d.setAttribute('open', ''); }); window.print(); });
var xb = document.getElementById('exports-btn'), xl = document.getElementById('exports-list');
if (xb && xl) {
  xb.addEventListener('click', function () { var open = xl.hidden; xl.hidden = !open; xb.setAttribute('aria-expanded', String(open)); if (open) { var a = xl.querySelector('a'); if (a) a.focus(); } });
  document.addEventListener('click', function (ev) { if (!xl.hidden && !xb.contains(ev.target) && !xl.contains(ev.target)) { xl.hidden = true; xb.setAttribute('aria-expanded', 'false'); } });
  xl.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { xl.hidden = true; xb.setAttribute('aria-expanded', 'false'); xb.focus(); } });
}

// ------------------------------------------------------------ chart tooltips
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

// ------------------------------------------------------------ section nav
var navLinks = document.querySelectorAll('.sections a');
if ('IntersectionObserver' in window) {
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) { if (en.isIntersecting) navLinks.forEach(function (a) { a.setAttribute('aria-current', String(a.getAttribute('href') === '#' + en.target.id)); }); });
  }, { rootMargin: '-120px 0px -70% 0px' });
  ['summary', 'tests', 'failures', 'quality', 'comparison', 'integrations', 'context', 'evidence'].forEach(function (id) { var s = document.getElementById(id); if (s) io.observe(s); });
}

// ------------------------------------------------------------ explorer state
var q = document.getElementById('q'), vlist = document.getElementById('vlist'), vinner = document.getElementById('vinner'), countEl = document.getElementById('count');
var detail = document.getElementById('detail');
var groupSel = document.getElementById('group'), sortSel = document.getElementById('sort');
var fTag = document.getElementById('f-tag'), fOwner = document.getElementById('f-owner'), fBrowser = document.getElementById('f-browser'), fCat = document.getElementById('f-cat');
var st = { state: 'all', query: '', group: store.get('ez-report-group') || 'suite', sort: 'default', tag: '', owner: '', browser: '', cat: '', collapsed: {}, active: 0, open: null };
var ROW_H = 44, rows = [], searchIdx = null;

function facet(sel, values) {
  if (!sel) return;
  var counts = {};
  values.forEach(function (v) { counts[v] = (counts[v] || 0) + 1; });
  Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b); }).slice(0, 300).forEach(function (v) { sel.appendChild(el('option', { value: v, text: v + ' (' + counts[v] + ')' })); });
  if (!Object.keys(counts).length) sel.disabled = true;
}
facet(fTag, [].concat.apply([], T.map(function (t) { return t.tags.filter(function (g) { return !/^@?(TestCaseId|TestPlanId|TestSuiteId)\b/i.test(g); }); })));
facet(fOwner, [].concat.apply([], T.map(function (t) { return t.owners; })));
facet(fBrowser, T.map(function (t) { return t.browser; }).filter(Boolean));
if (fCat) {
  var catCounts = {};
  T.forEach(function (t) { if (t.cat) catCounts[t.cat.c] = (catCounts[t.cat.c] || 0) + 1; });
  Object.keys(CAT).forEach(function (c) { if (catCounts[c]) fCat.appendChild(el('option', { value: c, text: CAT[c] + ' (' + catCounts[c] + ')' })); });
  if (!Object.keys(catCounts).length) fCat.disabled = true;
}
if (groupSel) groupSel.value = st.group;

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
  if (st.sort === 'risk') return y.risk - x.risk || SEVERITY[x.state] - SEVERITY[y.state] || a - b;
  return a - b;
}

function groupKeys(t) {
  if (st.group === 'suite') return [t.suite.length ? t.suite : ['Ungrouped']];
  if (st.group === 'tag') { var tags = t.tags.filter(function (g) { return !/^@?(TestCaseId|TestPlanId|TestSuiteId)\b/i.test(g); }); return tags.length ? tags.map(function (g) { return [g]; }) : [['(no tag)']]; }
  if (st.group === 'owner') return t.owners.length ? t.owners.map(function (o) { return [o]; }) : [['(no owner)']];
  if (st.group === 'browser') return [[t.browser || '(single browser)']];
  if (st.group === 'category') return [[t.cat ? CAT[t.cat.c] : 'Not failing']];
  if (st.group === 'cluster') return [[t.cluster ? t.cluster + ': ' + (D.clusters[t.cluster] || '') : (t.state === 'failed' || t.state === 'error' ? 'Unclustered failures' : 'Not failing')]];
  return [[]];
}

function rebuild() {
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
  countEl.textContent = idx.length + ' of ' + T.length + ' tests' + (st.query ? ' matching "' + st.query + '"' : '');
  vinner.style.height = (rows.length * ROW_H) + 'px';
  if (st.active >= rows.length) st.active = Math.max(0, rows.length - 1);
  render(true);
}

var rendered = {};
function renderRow(r, i) {
  var top = i * ROW_H;
  if (r.g !== undefined) {
    var counts = el('span', { cls: 'gcount' });
    ['failed', 'error', 'flaky', 'healed', 'passed', 'skipped'].forEach(function (s) { if (r.node.counts[s]) counts.appendChild(el('span', { cls: 'badge b-' + s, title: LABEL[s], text: r.node.counts[s] })); });
    var g = el('div', { cls: 'row group', role: 'treeitem', 'aria-level': r.depth + 1, 'aria-expanded': String(r.open), 'data-row': i, tabindex: i === st.active ? '0' : '-1', style: 'top:' + top + 'px;padding-left:' + (10 + r.depth * 16) + 'px' },
      [(function () { var s = svgIcon('chevron'); s.setAttribute('class', 'twisty'); return s; })(), el('span', { cls: 'rname', text: r.name }), el('span', { cls: 'muted small', text: String(r.node.total) }), counts]);
    return g;
  }
  var t = T[r.t];
  var sub = [t.id];
  if (t.browser) sub.push(t.browser);
  if (t.state === 'failed' || t.state === 'error') sub.push(t.failedStep || (t.error ? t.error.message.split('\n')[0] : ''));
  else if (t.tags.length) sub.push(t.tags.slice(0, 3).join(' '));
  var icon = el('span', { cls: 'sicon si-' + t.state, title: LABEL[t.state] }, [svgIcon(STATE_ICON[t.state])]);
  var tail = el('span', { cls: 'rtail' }, [
    t.cat ? el('span', { cls: 'cat c-' + t.cat.c, title: t.cat.why, text: CAT[t.cat.c] }) : null,
    t.failure && !t.failure.known ? el('span', { cls: 'cat c-new', title: 'First failure with this error signature', text: 'new' }) : null,
    t.history && t.history.sequence ? spark(t.history.sequence.slice(-12), true) : null,
    el('span', { cls: 'rdur', text: fmtMs(t.durationMs) })]);
  return el('div', { cls: 'row' + (st.open === t.id ? ' active' : ''), role: 'treeitem', 'aria-level': r.depth + 1, 'aria-selected': String(st.open === t.id), 'data-row': i, 'data-id': t.id, tabindex: i === st.active ? '0' : '-1', style: 'top:' + top + 'px;padding-left:' + (10 + r.depth * 16) + 'px' },
    [icon, el('div', { cls: 'rmain' }, [el('div', { cls: 'rname' }, [t.name, el('span', { cls: 'sr-only', text: ', ' + LABEL[t.state] + (t.cat ? ', ' + CAT[t.cat.c] : '') })]), el('div', { cls: 'rsub', text: sub.join(' · ') })]), tail]);
}
function render(force) {
  var h = vlist.clientHeight || 600, sc = vlist.scrollTop;
  var start = Math.max(0, Math.floor(sc / ROW_H) - 8), end = Math.min(rows.length, Math.ceil((sc + h) / ROW_H) + 8);
  if (force) { vinner.textContent = ''; rendered = {}; }
  var keep = {};
  for (var i = start; i < end; i++) {
    keep[i] = 1;
    if (!rendered[i]) { rendered[i] = renderRow(rows[i], i); vinner.appendChild(rendered[i]); }
  }
  for (var k in rendered) if (!keep[k] && Number(k) !== st.active) { rendered[k].remove(); delete rendered[k]; }
}
vlist.addEventListener('scroll', function () { render(false); }, { passive: true });
window.addEventListener('resize', function () { render(false); });

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
  openTest(T[r.t].id, true);
}
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

document.querySelectorAll('.fchip[data-state]').forEach(function (b) {
  b.addEventListener('click', function () { setState(b.getAttribute('data-state')); });
});
function setState(s) {
  st.state = s;
  document.querySelectorAll('.fchip[data-state]').forEach(function (x) { x.setAttribute('aria-pressed', String(x.getAttribute('data-state') === s)); });
  st.active = 0; rebuild();
}
var qTimer;
q.addEventListener('input', function () { clearTimeout(qTimer); qTimer = setTimeout(function () { st.query = q.value.trim(); st.active = 0; rebuild(); }, T.length > 2000 ? 160 : 40); });
q.addEventListener('keydown', function (ev) { if (ev.key === 'ArrowDown') { ev.preventDefault(); focusRow(0); } else if (ev.key === 'Escape') { q.value = ''; st.query = ''; rebuild(); } });
if (groupSel) groupSel.addEventListener('change', function () { st.group = groupSel.value; store.set('ez-report-group', st.group); st.collapsed = {}; st.active = 0; rebuild(); });
if (sortSel) sortSel.addEventListener('change', function () { st.sort = sortSel.value; rebuild(); });
[[fTag, 'tag'], [fOwner, 'owner'], [fBrowser, 'browser'], [fCat, 'cat']].forEach(function (p) { if (p[0]) p[0].addEventListener('change', function () { st[p[1]] = p[0].value; st.active = 0; rebuild(); }); });

// ------------------------------------------------------------ lightbox
var lb = document.getElementById('lightbox'), lbImg = document.getElementById('lb-img'), lbCap = document.getElementById('lb-cap'), lbOpen = document.getElementById('lb-open');
var lbList = [], lbAt = 0, lbReturn = null, lbZoom = document.getElementById('lb-zoom');
if (lbZoom) lbZoom.addEventListener('click', function () { var on = !lbImg.classList.contains('actual'); lbImg.classList.toggle('actual', on); lbZoom.setAttribute('aria-pressed', String(on)); lbZoom.textContent = on ? 'Fit to screen' : 'Actual size'; });
function lbShow(i) {
  lbAt = (i + lbList.length) % lbList.length;
  var s = lbList[lbAt];
  lbImg.classList.remove('actual'); if (lbZoom) { lbZoom.setAttribute('aria-pressed', 'false'); lbZoom.textContent = 'Actual size'; }
  lbImg.src = s.url; lbImg.alt = s.alt; lbCap.textContent = s.alt + ' (' + (lbAt + 1) + ' of ' + lbList.length + ')'; lbOpen.href = s.url;
}
function openLightbox(list, i, from) {
  if (!lb || !list.length) return;
  lbList = list; lbReturn = from || document.activeElement; lbShow(i);
  if (typeof lb.showModal === 'function') lb.showModal(); else lb.setAttribute('open', '');
  document.getElementById('lb-close').focus();
}
function closeLightbox() { if (lb.open) { if (typeof lb.close === 'function') lb.close(); else lb.removeAttribute('open'); } if (lbReturn && lbReturn.focus) lbReturn.focus(); }
if (lb) {
  document.getElementById('lb-close').addEventListener('click', closeLightbox);
  document.getElementById('lb-prev').addEventListener('click', function () { lbShow(lbAt - 1); });
  document.getElementById('lb-next').addEventListener('click', function () { lbShow(lbAt + 1); });
  lb.addEventListener('keydown', function (ev) { if (ev.key === 'ArrowLeft') lbShow(lbAt - 1); else if (ev.key === 'ArrowRight') lbShow(lbAt + 1); });
  lb.addEventListener('close', function () { if (lbReturn && lbReturn.focus) lbReturn.focus(); });
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
function evName(r) { return (r.stepNo ? 'Step ' + r.stepNo + (r.step ? ': ' + r.step.n : '') : r.test ? 'Test' : 'Run') + ' – ' + r.label; }
function isImage(r) { return r.url && /\.(png|jpe?g|gif|webp|svg)$/i.test(r.path); }
function previewable(r) { return r.url && !/\.gz$/i.test(r.path); }
function evLink(id) {
  var r = evRef(id);
  if (!r) return el('span', { cls: 'mono muted', title: 'not in the evidence manifest', text: id });
  return r.url && previewable(r) ? el('a', { cls: 'chip', href: r.url, target: '_blank', rel: 'noopener', title: r.path }, [r.label, el('span', { cls: 'muted mono', text: ' ' + id })]) : el('span', { cls: 'chip', title: r.path }, [r.label, el('span', { cls: 'muted mono', text: ' ' + id })]);
}
function evActions(r) {
  var a = [];
  if (r.url && previewable(r)) a.push(el('a', { cls: 'btn quiet', href: r.url, target: '_blank', rel: 'noopener' }, [svgIcon('external'), 'Open', el('span', { cls: 'sr-only', text: ' ' + evName(r) + ' (opens in a new tab)' })]));
  if (r.url) a.push(el('a', { cls: 'btn quiet', href: r.url, download: r.path.split('/').pop() }, [svgIcon('download'), 'Download', el('span', { cls: 'sr-only', text: ' ' + evName(r) })]));
  return a;
}
/** A filterable evidence table: thumbnails, human names, kind, size, time, SHA-256, chain position, open and download. */
function evidenceBrowser(ids, opt) {
  opt = opt || {};
  var all = ids.map(evRef).filter(Boolean);
  var wrap = el('div', { cls: 'evb' });
  if (!all.length) { wrap.appendChild(el('p', { cls: 'muted', text: 'No evidence.' })); return wrap; }
  var kinds = {}; all.forEach(function (r) { kinds[r.label] = (kinds[r.label] || 0) + 1; });
  var fk = el('select', { 'aria-label': 'Filter evidence by kind' }, [el('option', { value: '', text: 'All kinds (' + all.length + ')' })].concat(Object.keys(kinds).sort().map(function (k) { return el('option', { value: k, text: k + ' (' + kinds[k] + ')' }); })));
  var scope = el('select', { 'aria-label': opt.runWide ? 'Filter evidence by test' : 'Filter evidence by step' }, [el('option', { value: '', text: opt.runWide ? 'All tests' : 'All steps' })]);
  var seen = {};
  all.forEach(function (r) {
    var key = opt.runWide ? (r.test ? r.test.id : '-') : String(r.stepNo);
    if (seen[key]) return; seen[key] = 1;
    scope.appendChild(el('option', { value: key, text: opt.runWide ? (r.test ? r.test.name : 'Run-level evidence') : (r.stepNo ? 'Step ' + r.stepNo + (r.step ? ': ' + r.step.n : '') : 'Whole test') }));
  });
  var qf = el('input', { type: 'search', placeholder: 'Find evidence (name, id, file, SHA-256)', 'aria-label': 'Find evidence' });
  var count = el('span', { cls: 'muted small', 'aria-live': 'polite' });
  var tbody = el('tbody');
  var more = el('button', { type: 'button', cls: 'btn', text: 'Show more' });
  var limit = opt.page || 50;
  function filtered() {
    var k = fk.value, sc = scope.value, qq = qf.value.trim().toLowerCase();
    return all.filter(function (r) {
      if (k && r.label !== k) return false;
      if (sc && (opt.runWide ? (r.test ? r.test.id : '-') : String(r.stepNo)) !== sc) return false;
      if (qq && (evName(r) + ' ' + r.id + ' ' + r.path + ' ' + r.sha + ' ' + r.desc).toLowerCase().indexOf(qq) < 0) return false;
      return true;
    });
  }
  function draw() {
    var list = filtered();
    tbody.textContent = '';
    list.slice(0, limit).forEach(function (r) {
      var thumb = isImage(r) ? (function () { var b = el('button', { type: 'button', cls: 'evthumb', 'aria-label': 'Preview ' + evName(r) }, [el('img', { src: r.url, alt: '', loading: 'lazy' })]); b.addEventListener('click', function () { var imgs = list.filter(isImage); openLightbox(imgs.map(function (x) { return { url: x.url, alt: evName(x) + ' (' + x.id + ')' }; }), imgs.indexOf(r), b); }); return b; })() : el('span', { cls: 'evkind', 'aria-hidden': 'true', text: r.label.slice(0, 3).toUpperCase() });
      tbody.appendChild(el('tr', null, [
        el('td', null, [thumb]),
        el('td', { cls: 'ev-name' }, [el('div', { text: evName(r) }), el('div', { cls: 'small muted mono ev-path', text: r.id + ' \u00b7 ' + r.path }), r.desc && r.desc !== r.label ? el('div', { cls: 'small muted', text: r.desc }) : null, el('div', { cls: 'small muted mono', title: r.sha }, ['SHA-256 ' + (r.sha ? r.sha.slice(0, 16) + '\u2026' : '-'), el('span', { cls: 'sr-only', text: ' (full: ' + r.sha + ')' }), ' \u00b7 chain #' + (r.seq !== null && r.seq !== undefined ? r.seq : '-')]), opt.runWide && r.test ? el('a', { cls: 'small', href: '#test/' + encodeURIComponent(r.test.id), text: r.test.name }) : null]),
        el('td', { cls: 'small ev-meta' }, [el('div', { cls: 'num', text: fmtBytes(r.size) }), el('div', { cls: 'muted', text: fmtAt(r.at) })]),
        el('td', null, [el('div', { cls: 'evacts' }, evActions(r))]),
      ]));
    });
    count.textContent = Math.min(limit, list.length) + ' of ' + list.length + ' shown';
    more.hidden = list.length <= limit;
  }
  more.addEventListener('click', function () { limit += 100; draw(); });
  [fk, scope].forEach(function (x) { x.addEventListener('change', function () { limit = opt.page || 50; draw(); }); });
  qf.addEventListener('input', function () { limit = opt.page || 50; draw(); });
  wrap.appendChild(el('div', { cls: 'evb-tools' }, [fk, scope, qf, count]));
  wrap.appendChild(el('div', { cls: 'tbl-wrap' }, [el('table', null, [el('caption', { cls: 'sr-only', text: 'Evidence: name, SHA-256 and position in the hash chain, size and time, open and download' }), el('thead', null, [el('tr', null, ['Preview', 'Evidence', 'Size and time', 'Open'].map(function (h) { return el('th', { scope: 'col', text: h }); }))]), tbody])]));
  wrap.appendChild(more);
  draw();
  return wrap;
}

// ------------------------------------------------------------ test detail
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
  lines.push('[' + (D.brand || 'EZTest') + '] ' + t.name + (t.failedStep ? ' - fails at: ' + t.failedStep : ''));
  lines.push('');
  lines.push('Test: ' + t.name + ' (' + t.id + ')');
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
  if (t.triage) { lines.push(''); lines.push('Probable cause: ' + t.triage.category + ' (' + Math.round(t.triage.confidence * 100) + '%) - ' + t.triage.reasons.join('; ')); }
  if (t.signature) lines.push('Failure signature: ' + t.signature + (t.failure && t.failure.known ? ' (known since ' + (t.failure.firstSeenRun || '?') + ')' : ' (new in this run)'));
  if (t.ado && t.ado.testCases.length) lines.push('Test case: ' + t.ado.testCases.map(function (c) { return '#' + c.id + (c.url ? ' ' + c.url : ''); }).join(', '));
  if (t.owners.length) lines.push('Owners: ' + t.owners.join(', '));
  lines.push('Report: ' + location.href.split('#')[0] + '#test/' + encodeURIComponent(t.id));
  return lines.join('\n');
}

/** Before / after compare: a slider reveals the after image over the before image; or side by side. */
function compareView(a, b, labels, overlay) {
  var wrap = el('div', { cls: 'cmp' });
  var stage = el('div', { cls: 'cmp-stage' });
  // The left part shows the first image (before, baseline) over the second (after, actual).
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
    side.appendChild(el('figure', { cls: 'shot' }, [el('div', { cls: 'lbl', text: p[1] }), btn]));
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
  var tabs = el('div', { cls: 'chips', role: 'group', 'aria-label': 'Snapshot' });
  phases.forEach(function (p, i) {
    var b = el('button', { type: 'button', cls: 'fchip', 'aria-pressed': String(i === phases.length - 1), text: p[0] });
    b.addEventListener('click', function () { frame.srcdoc = SNAP[p[1]]; tabs.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); });
    tabs.appendChild(b);
  });
  var big = el('button', { type: 'button', cls: 'fchip', 'aria-pressed': 'false', text: 'Taller' });
  big.addEventListener('click', function () { var on = !frame.classList.contains('tall'); frame.classList.toggle('tall', on); big.setAttribute('aria-pressed', String(on)); });
  tabs.appendChild(big);
  return el('div', { cls: 'snap' }, [el('h4', { text: 'DOM snapshot (time-travel)' }), tabs, frame, el('p', { cls: 'small muted', text: 'The page as EZTest recorded it: scripts removed, no network access, the step’s target outlined.' })]);
}
var HEAL_HINT = { 'no stored fingerprint': 'T1 learns an element’s fingerprint the first time the step passes; this step has not passed in this project yet, so only the semantic tier (T2) could try.', 'below threshold': 'The closest element by name was not similar enough to heal safely (for example a renamed button whose new text means the same but reads differently).' };
function healNotesView(notes) {
  var hint = null;
  Object.keys(HEAL_HINT).forEach(function (k) { if (!hint && notes.some(function (n) { return n.indexOf(k) >= 0; })) hint = HEAL_HINT[k]; });
  return el('div', { cls: 'panel', style: 'margin:6px 0' }, [el('div', { cls: 'ph' }, ['Self-healing tried, did not heal']), el('div', { cls: 'pb' }, [el('ul', { cls: 'small' }, notes.map(function (n) { return el('li', { text: n }); })), hint ? el('p', { cls: 'small muted', text: hint }) : null])]);
}
function visualView(vd) {
  return el('div', null, vd.map(function (v) {
    var kids = [el('p', { cls: 'small' }, [el('strong', { text: 'Visual check ' + v.key + ': ' }), v.message + (v.ratio !== undefined ? ' (' + (v.ratio * 100).toFixed(2) + '% of pixels differ)' : '')])];
    if (v.baseline && v.actual) kids.push(compareView({ url: v.baseline, alt: 'baseline ' + v.key }, { url: v.actual, alt: 'actual ' + v.key }, ['Baseline', 'Actual'], v.diff));
    else if (v.actual) kids.push(el('img', { src: v.actual, alt: 'Actual ' + v.key, style: 'max-width:100%' }));
    return el('div', { cls: 'panel', style: 'margin:6px 0' }, [el('div', { cls: 'pb' }, kids)]);
  }));
}

var videoCtl = null;
function stepNode(s, t, num, ctx) {
  var code = STEP[s.s] || STEP.S;
  var no = ++ctx.n;
  var startPct = t.durationMs ? Math.min(100, s.t / t.durationMs * 100) : 0;
  var wPct = t.durationMs ? Math.max(0.5, Math.min(100 - startPct, s.d / t.durationMs * 100)) : 0;
  var bar = el('span', { cls: s.s === 'F' || s.s === 'B' ? 'f' : s.s === 'H' ? 'h' : '', style: 'left:' + startPct.toFixed(2) + '%;width:' + wPct.toFixed(2) + '%' });
  var hasBody = s.x || s.h || (s.c && s.c.length) || s.l || s.dg || s.db || s.api || s.im || s.m || (s.w && s.w.length) || (s.e && s.e.length) || s.sn || s.hn || s.vd;
  var body = null;
  var bodyId = 'sb-' + Math.random().toString(36).slice(2);
  var row = el('button', { type: 'button', cls: 'step-row', 'aria-expanded': hasBody ? 'false' : null, 'aria-controls': hasBody ? bodyId : null, disabled: hasBody ? null : true },
    [el('span', { cls: 'sicon si-' + code[0], title: code[1] }, [svgIcon(STATE_ICON[code[0]])]),
     el('span', { cls: 'step-int' }, [el('span', { cls: 'muted num', text: num + '. ' }), s.n, s.a ? el('span', { cls: 'chip', style: 'margin-left:6px', text: 'as ' + s.a }) : null, s.i ? el('span', { cls: 'chip', style: 'margin-left:6px', text: '#' + s.i }) : null, s.b ? el('span', { cls: 'chip', style: 'margin-left:6px', text: s.b }) : null, s.h ? el('span', { cls: 'badge b-healed', style: 'margin-left:6px', text: 'healed' }) : null, s.so ? el('span', { cls: 'chip', style: 'margin-left:6px', text: 'soft' }) : null, el('span', { cls: 'sr-only', text: ', ' + code[1] })]),
     el('span', { cls: 'step-bar', 'aria-hidden': 'true' }, [bar]),
     el('span', { cls: 'step-dur', text: fmtMs(s.d) })]);
  // Quick actions next to the step: its screenshot, and its moment in the video.
  var acts = el('span', { cls: 'step-acts' });
  var myShots = ctx.shots.filter(function (x) { return x.step === s; });
  if (myShots.length) {
    var sb = el('button', { type: 'button', cls: 'iconbtn', title: 'Screenshot of step ' + num, 'aria-label': 'Screenshot of step ' + num }, [svgIcon('image')]);
    sb.addEventListener('click', function () { openLightbox(ctx.shots, ctx.shots.indexOf(myShots[myShots.length - 1]), sb); });
    acts.appendChild(sb);
  }
  var cue = ctx.cueFor(s);
  if (cue) {
    var vb = el('button', { type: 'button', cls: 'iconbtn', title: 'Play step ' + num + ' in the video', 'aria-label': 'Play step ' + num + ' in the video' }, [svgIcon('play')]);
    vb.addEventListener('click', function () { if (videoCtl) videoCtl.seek(cue[0], true); });
    acts.appendChild(vb);
  }
  var li = el('li', { cls: 'step', 'data-step': no }, [el('div', { cls: 'step-line' }, [row, acts])]);
  function buildBody() {
    var kids = [];
    if (s.x) kids.push(el('div', { cls: 'err', role: 'note' }, [el('strong', { text: s.x.name || 'Error' }), pre(s.x.message, ' '), s.x.stack ? el('details', null, [el('summary', { cls: 'small', text: 'Stack trace' }), pre(s.x.stack)]) : null]));
    if (s.h) kids.push(healView(s.h));
    if (s.hn) kids.push(healNotesView(s.hn));
    if (s.dg) kids.push(dl([['Expected', s.dg.expected], ['Found', s.dg.found], ['Did you mean', s.dg.similar.join('; ')], ['Console errors', s.dg.consoleErrors.join('\n')], ['Failed requests', s.dg.failedRequests.join('\n')], ['Page', s.dg.url]]));
    if (s.c && s.c.length) {
      var tb = el('tbody');
      s.c.forEach(function (c) { tb.appendChild(el('tr', null, [el('td', null, [el('code', { text: c[0] })]), el('td', null, [badge(c[1] ? 'passed' : 'failed', c[1] ? 'held' : 'failed')]), el('td', { text: c[2] })])); });
      kids.push(el('table', null, [el('caption', { text: 'Post-conditions' }), el('thead', null, [el('tr', null, [el('th', { scope: 'col', text: 'Condition' }), el('th', { scope: 'col', text: 'Result' }), el('th', { scope: 'col', text: 'Actual' })])]), tb]));
    }
    if (s.l) kids.push(el('p', { cls: 'small' }, ['Locator: ', el('code', { text: s.l })]));
    if (s.im) kids.push(el('p', { cls: 'small' }, ['More robust locator suggested: ', el('code', { text: s.im.suggested }), ' - ' + s.im.reason]));
    if (s.w && s.w.length) kids.push(el('ul', { cls: 'small' }, s.w.map(function (w) { return el('li', { text: w }); })));
    if (s.m) kids.push(dl([['Manual verdict', s.m.verdict], ['Tester', s.m.tester], ['Observed', s.m.actual], ['Notes', s.m.notes]]));
    if (s.api) s.api.forEach(function (a) { kids.push(apiView(a)); });
    if (s.db) kids.push(dbView(s.db));
    if (s.vd) kids.push(visualView(s.vd));
    if (myShots.length) {
      var g = el('div', { cls: 'shots step-shots' });
      myShots.forEach(function (x) {
        var b = el('button', { type: 'button', 'aria-label': 'Enlarge: ' + x.alt }, [el('img', { src: x.url, alt: x.alt, loading: 'lazy' })]);
        b.addEventListener('click', function () { openLightbox(ctx.shots, ctx.shots.indexOf(x), b); });
        g.appendChild(el('figure', { cls: 'shot' }, [b, el('figcaption', { text: x.alt })]));
      });
      kids.push(g);
    }
    if (s.sn) { var sv = snapshotView(s); if (sv) kids.push(sv); }
    if (s.e && s.e.length) kids.push(el('div', null, [el('h4', { text: 'Evidence of this step' }), evidenceBrowser(s.e, { page: 20 })]));
    return el('div', { cls: 'step-body', id: bodyId }, kids);
  }
  if (hasBody) row.addEventListener('click', function () {
    var open = row.getAttribute('aria-expanded') === 'true';
    if (!body) { body = buildBody(); li.insertBefore(body, li.firstChild.nextSibling); }
    body.hidden = open; row.setAttribute('aria-expanded', String(!open));
  });
  if (s.ch && s.ch.length) {
    var ol = el('ol', { cls: 'step-children', 'aria-label': 'Steps inside ' + s.n });
    s.ch.forEach(function (c, i) { ol.appendChild(stepNode(c, t, num + '.' + (i + 1), ctx)); });
    li.appendChild(ol);
  }
  return li;
}
function healView(h) {
  return el('div', { cls: 'panel', style: 'margin:6px 0' }, [el('div', { cls: 'ph' }, ['Self-healing ', badge(h.verified ? 'passed' : 'failed', h.verified ? 'verified' : 'not verified'), el('span', { cls: 'chip', text: h.tier }), el('span', { cls: 'chip', text: 'confidence ' + Math.round(h.confidence * 100) + '%' })]),
    el('div', { cls: 'pb' }, [el('div', { cls: 'heal-diff' }, [el('code', { cls: 'old', text: h.from.join(' | ') }), el('span', { 'aria-hidden': 'true', text: '→' }), el('code', { cls: 'new', text: h.to })]), el('span', { cls: 'sr-only', text: 'Old locator ' + h.from.join(' | ') + ', new locator ' + h.to }), el('p', { cls: 'small', text: h.reason + (h.element ? ' (shared element ' + h.element + ')' : '') }), h.evidence.length ? el('div', { cls: 'chips' }, ['Verification evidence: '].concat(h.evidence.map(evLink))) : null])]);
}
function prettyBody(b) {
  if (b === undefined) return '';
  try { return JSON.stringify(JSON.parse(b), null, 2); } catch (e) { return b; }
}
function headersText(h) { return Object.keys(h || {}).map(function (k) { return k + ': ' + h[k]; }).join('\n'); }
function apiView(a) {
  var ok = a.status && a.status < 400;
  return el('div', { cls: 'panel', style: 'margin:6px 0' }, [el('div', { cls: 'ph' }, [el('code', { text: a.method + ' ' + a.url }), badge(ok ? 'passed' : 'failed', String(a.status)), a.ms !== undefined ? el('span', { cls: 'muted small', text: fmtMs(a.ms) }) : null]),
    el('div', { cls: 'pb' }, [a.requestBody !== undefined ? el('details', null, [el('summary', { cls: 'small', text: 'Request body' }), pre(prettyBody(a.requestBody))]) : null,
      a.responseHeaders ? el('details', null, [el('summary', { cls: 'small', text: 'Response headers' }), pre(headersText(a.responseHeaders))]) : null,
      a.responseBody !== undefined ? el('details', { open: true }, [el('summary', { cls: 'small', text: 'Response body (masked)' }), pre(prettyBody(a.responseBody))]) : null])]);
}
function dbView(db) {
  var head = el('tr', null, db.columns.map(function (c) { return el('th', { scope: 'col', text: c }); }));
  var tb = el('tbody', null, db.rows.map(function (r) { return el('tr', null, r.map(function (c) { return el('td', { cls: 'mono', text: c === null ? 'NULL' : String(c) }); })); }));
  return el('div', null, [el('div', { cls: 'tbl-wrap' }, [el('table', null, [el('caption', { text: 'Query result ' + db.key + ' (' + db.total + ' row' + (db.total === 1 ? '' : 's') + (db.total > db.rows.length ? ', first ' + db.rows.length + ' shown' : '') + ', masked)' }), el('thead', null, [head]), tb])])]);
}
function spark(seq, small) {
  var s = el('span', { cls: 'spark' + (small ? ' sm' : ''), role: 'img', title: small ? 'Last ' + seq.length + ' runs, oldest first' : null, 'aria-label': 'History, oldest first: ' + seq.split('').map(function (c) { return c === 'P' ? 'pass' : c === 'H' ? 'healed pass' : 'fail'; }).join(', ') });
  seq.split('').forEach(function (c) { s.appendChild(el('i', { cls: c === 'P' || c === 'H' || c === 'F' ? c : 'F' })); });
  return s;
}
function attemptsView(t) {
  var as = t.attempts;
  var names = [];
  as.forEach(function (a) { a.steps.forEach(function (s) { if (names.indexOf(s[0]) < 0) names.push(s[0]); }); });
  var head = el('tr', null, [el('th', { scope: 'col', text: 'Step' })].concat(as.map(function (a) { return el('th', { scope: 'col', text: 'Attempt ' + a.attempt }); })));
  var tb = el('tbody');
  names.forEach(function (n) {
    var cells = as.map(function (a) { var s = a.steps.filter(function (x) { return x[0] === n; })[0]; return s; });
    var codes = cells.map(function (c) { return c ? c[1] : '-'; });
    var differs = codes.some(function (c) { return c !== codes[0]; });
    tb.appendChild(el('tr', null, [el('th', { scope: 'row', text: n, cls: differs ? 'diff' : null })].concat(cells.map(function (c) { return el('td', { cls: differs ? 'diff' : null }, c ? [badge(STEP[c[1]][0], STEP[c[1]][1]), ' ' + fmtMs(c[2])] : ['-']); }))));
  });
  var sum = as.map(function (a) { return 'Attempt ' + a.attempt + ': ' + a.status + ' in ' + fmtMs(a.durationMs) + (a.error ? ' - ' + a.error.split('\n')[0] : ''); });
  return [el('ul', { cls: 'small' }, sum.map(function (x) { return el('li', { text: x }); })), el('div', { cls: 'tbl-wrap attempts' }, [el('table', null, [el('caption', { cls: 'sr-only', text: 'Step outcome per attempt; rows that differ are marked' }), el('thead', null, [head]), tb])]), el('p', { cls: 'small muted', text: 'Steps whose outcome differs between attempts are marked in red.' })];
}
function fmtClock(s) { s = Math.max(0, s || 0); var m = Math.floor(s / 60); var r = s % 60; return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1); }

/** The video player: poster, chapters (steps) that seek, the failing moment, playback speed, one source per attempt. */
function videoView(t, failCueIdx) {
  var list = t.videos && t.videos.length ? t.videos : [t.video];
  var cur = 0;
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
    cur = i; var v = list[i];
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
  var rows = t.waterfall;
  var span = Math.max(t.durationMs, rows.reduce(function (m, r) { return Math.max(m, r.st + (r.d || 0)); }, 1));
  var onlyBad = false, qq = '';
  var tbody = el('tbody');
  var cnt = el('span', { cls: 'muted small', 'aria-live': 'polite' });
  function draw() {
    tbody.textContent = '';
    var shown = rows.filter(function (r) { return (!onlyBad || r.f || (r.s && r.s >= 400)) && (!qq || (r.m + ' ' + r.u + ' ' + (r.s || '')).toLowerCase().indexOf(qq) >= 0); });
    shown.forEach(function (r, i) {
      var bad = r.f || (r.s && r.s >= 400);
      var left = Math.min(100, r.st / span * 100), w = Math.max(0.6, Math.min(100 - left, (r.d || 0) / span * 100));
      var tr = el('tr', { cls: bad ? 'net-bad' : null });
      var tg = el('button', { type: 'button', cls: 'iconbtn', 'aria-expanded': 'false', 'aria-label': 'Details of ' + r.m + ' ' + r.u }, [svgIcon('chevron')]);
      var det = null;
      tg.addEventListener('click', function () {
        var open = tg.getAttribute('aria-expanded') === 'true';
        if (!det) {
          det = el('tr', { cls: 'net-det' }, [el('td', { colspan: '9' }, [dl([['URL', r.u], ['Type', [r.ty, r.mime].filter(Boolean).join(', ')], ['Timing', r.w ? Object.keys(r.w).map(function (k) { return k.replace('Ms', '') + ' ' + fmtMs(r.w[k]); }).join(', ') : (r.d !== undefined ? fmtMs(r.d) : '')], ['Failure', r.f]]), r.rq ? el('details', null, [el('summary', { cls: 'small', text: 'Request headers (credentials masked)' }), pre(headersText(r.rq))]) : null, r.rs ? el('details', null, [el('summary', { cls: 'small', text: 'Response headers' }), pre(headersText(r.rs))]) : null])]);
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
    cnt.textContent = shown.length + ' of ' + rows.length + ' requests';
  }
  var fb = el('button', { type: 'button', cls: 'fchip', 'aria-pressed': 'false', text: 'Failed only' });
  fb.addEventListener('click', function () { onlyBad = !onlyBad; fb.setAttribute('aria-pressed', String(onlyBad)); draw(); });
  var qf = el('input', { type: 'search', placeholder: 'Filter requests', 'aria-label': 'Filter requests' });
  qf.addEventListener('input', function () { qq = qf.value.trim().toLowerCase(); draw(); });
  draw();
  return el('div', null, [el('div', { cls: 'evb-tools' }, [fb, qf, cnt]), el('div', { cls: 'tbl-wrap' }, [el('table', { cls: 'net' }, [el('caption', { cls: 'sr-only', text: 'Requests of the test with their timing' }), el('thead', null, [el('tr', null, ['', 'Step', 'Method', 'URL', 'Status', 'Type', 'Size', 'Time', 'Waterfall'].map(function (h, i) { return el('th', { scope: 'col', text: h, cls: i === 8 ? 'wf' : null }, i === 0 ? [el('span', { cls: 'sr-only', text: 'Details' })] : null); }))]), tbody])])]);
}
var LEVEL_STATE = { error: 'failed', warning: 'flaky', warn: 'flaky', info: 'passed', log: 'skipped', debug: 'skipped' };
function consoleView(t) {
  var rows = t.console;
  var levels = {}; rows.forEach(function (c) { levels[c.l] = (levels[c.l] || 0) + 1; });
  var on = {}; Object.keys(levels).forEach(function (l) { on[l] = true; });
  var tbody = el('tbody');
  function draw() {
    tbody.textContent = '';
    rows.filter(function (c) { return on[c.l]; }).forEach(function (c) {
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
  if (tr.studio) kids.push(el('p', null, [extLink(tr.studio, 'Open the time-travel trace in EZTest Studio', 'btn'), el('span', { cls: 'small muted', text: ' (needs Studio running: eztest studio, in the project folder)' })]));
  var ol = el('ol', { cls: 'small' });
  ol.appendChild(el('li', null, ['In the project folder run ', el('code', { text: 'npx eztest studio' }), ', open Results, this run, this test, then the Trace tab.']));
  if (tr.cmd) ol.appendChild(el('li', null, ['Or read it in a terminal: ', el('code', { text: tr.cmd.replace('<runDir>', 'eztest-results/' + D.runId) })]));
  if (tr.dir) ol.appendChild(el('li', null, ['Time-travel data: ', el('code', { text: 'eztest-results/' + D.runId + '/' + tr.dir })]));
  kids.push(ol);
  if (tr.file) kids.push(el('p', null, [el('a', { cls: 'btn', href: tr.file, download: tr.file.split('/').pop() }, [svgIcon('download'), 'Download the trace file']), el('span', { cls: 'small muted mono', text: ' ' + decodeURIComponent(tr.file) })]));
  return kids;
}

function renderDetail(t) {
  var kids = [];
  videoCtl = null;
  var link = location.href.split('#')[0] + '#test/' + encodeURIComponent(t.id);
  var copyBtn = el('button', { type: 'button', cls: 'btn', onclick: function () { copyText(link, copyBtn); } }, [svgIcon('link'), 'Copy link']);
  var bugBtn = (t.state === 'failed' || t.state === 'error' || t.state === 'flaky') ? el('button', { type: 'button', cls: 'btn', onclick: function () { copyText(bugText(t), bugBtn); } }, [svgIcon('copy'), 'Copy for bug']) : null;
  var traceBtn = t.trace ? el('button', { type: 'button', cls: 'btn', onclick: function () { var p = document.getElementById('d-trace'); if (p) { p.hidden = false; p.scrollIntoView({ block: 'nearest' }); var f = p.querySelector('a,button'); if (f) f.focus(); } } }, [svgIcon('trace'), 'Open trace']) : null;
  var closeBtn = el('button', { type: 'button', cls: 'btn quiet', 'aria-label': 'Close test details', onclick: function () { closeTest(); } }, [svgIcon('close')]);
  kids.push(el('div', { cls: 'd-head' }, [el('div', null, [badge(t.state), el('h3', { cls: 'd-title', id: 'd-title', text: t.name }), el('div', { cls: 'd-id', text: t.id })]), el('div', { cls: 'chips no-print' }, [traceBtn, copyBtn, bugBtn, closeBtn])]));
  var meta = el('div', { cls: 'd-meta' });
  function m(label, v) { if (v === undefined || v === null || v === '') return; meta.appendChild(el('span', null, [label + ' ', el('b', null, [v])])); }
  m('Duration', fmtMs(t.durationMs)); m('Browser', t.browser); m('Attempt', t.attempt > 1 ? String(t.attempt) : null); m('Risk', String(t.risk));
  m('Owners', t.owners.join(', ')); m('File', t.file ? t.file.split(/[\\/]/).slice(-3).join('/') : null); m('Suite', t.suite.join(' › ')); m('Actors', t.actors.join(', '));
  if (t.manual) m('Manual', t.manual.type + (t.manual.testers.length ? ' by ' + t.manual.testers.join(', ') : '') + (t.manual.pending ? ', ' + t.manual.pending + ' step(s) not executed' : ''));
  kids.push(meta);
  var links = el('div', { cls: 'chips', style: 'margin-bottom:14px' });
  t.tags.forEach(function (g) { links.appendChild(el('span', { cls: 'chip mono', text: g })); });
  t.requirementLinks.forEach(function (r) { links.appendChild(extLink(r.url, 'Requirement ' + r.id, 'chip')); });
  if (t.ado) {
    t.ado.testCases.forEach(function (c) { links.appendChild(extLink(c.url, 'Test case #' + c.id, 'chip')); });
    if (t.ado.plan) links.appendChild(extLink(t.ado.plan.url, 'Plan ' + t.ado.plan.id, 'chip'));
    if (t.ado.suite) links.appendChild(extLink(t.ado.suite.url, 'Suite ' + t.ado.suite.id, 'chip'));
    t.ado.results.forEach(function (r) { links.appendChild(extLink(r.url, 'ADO result' + (r.resultId ? ' ' + r.resultId : '') + (r.outcome ? ': ' + r.outcome : ''), 'chip')); });
  }
  t.bugs.forEach(function (b) { links.appendChild(extLink(b.url, (b.system === 'ado' ? 'Bug ' : 'Jira ') + b.id + ' (' + b.action + ')', 'chip')); });
  if (links.childNodes.length) kids.push(links);
  if (t.trace) { var tp = panel('Trace', traceView(t)); tp.id = 'd-trace'; kids.push(tp); }

  var fs = failingStep(t.steps);
  if (t.state === 'failed' || t.state === 'error' || t.state === 'flaky') {
    var fk = [];
    if (t.error) fk.push(el('div', { cls: 'err', role: 'note' }, [el('strong', { text: (t.error.name || 'Error') + (t.failedStep ? ' in step: ' + t.failedStep : '') }), pre(t.error.message, ' '), t.error.stack ? el('details', null, [el('summary', { cls: 'small', text: 'Stack trace' }), pre(t.error.stack)]) : null]));
    if (t.cat) fk.push(el('div', { cls: 'catbox c-' + t.cat.c, role: 'note' }, [el('div', null, [el('span', { cls: 'cat c-' + t.cat.c, text: CAT[t.cat.c] }), ' ', el('span', { cls: 'small muted', text: (t.cat.src === 'triage' ? 'decided by ' : 'rule: ') + t.cat.why })]), el('p', null, [el('strong', { text: 'Suggested next step: ' }), t.cat.fix])]));
    if (t.flake) fk.push(el('p', null, [el('strong', { text: 'Flaky: ' }), 'failed first, passed on retry. Cause ' + t.flake.cause + ' (' + Math.round(t.flake.confidence * 100) + '%): ' + t.flake.reason]));
    if (t.failure) fk.push(el('p', { cls: 'small' }, [t.failure.known ? badge('skipped', 'known failure') : badge('failed', 'new failure'), ' ', t.failure.firstSeenRun ? 'First seen in run ' + t.failure.firstSeenRun + (t.failure.firstSeenAt ? ' (' + t.failure.firstSeenAt.slice(0, 10) + ')' : '') : 'First seen in this run', t.failure.tags.length ? ' · ' + t.failure.tags.join(', ') : '', t.failure.streak ? ' · failing ' + t.failure.streak + ' run(s) in a row' : '', t.signature ? ' · signature ' + t.signature : '']));
    if (t.cluster) {
      var sharing = T.filter(function (x) { return x.cluster === t.cluster && x.id !== t.id; });
      if (sharing.length) fk.push(el('p', { cls: 'small' }, ['Shares a root cause with ' + sharing.length + ' other test(s): '].concat(sharing.slice(0, 8).map(function (x) { return el('a', { cls: 'chip', href: '#test/' + encodeURIComponent(x.id), text: x.name }); }))));
    }
    if (t.triage) {
      fk.push(el('div', { cls: 'panel', style: 'margin:8px 0 0' }, [el('div', { cls: 'ph' }, ['Probable cause: ', el('strong', { text: t.triage.category }), el('span', { cls: 'chip', text: Math.round(t.triage.confidence * 100) + '% confidence' }), t.triage.status === 'needs-human' ? badge('flaky', 'needs human review') : null]),
        el('div', { cls: 'pb' }, [el('ul', null, t.triage.reasons.map(function (r) { return el('li', { text: r }); })), t.triage.secondOpinion ? el('p', { cls: 'small muted', text: 'Second opinion: ' + t.triage.secondOpinion }) : null, t.triage.evidence.length ? el('div', { cls: 'chips' }, ['Cited evidence: '].concat(t.triage.evidence.map(evLink))) : null])]));
    }
    if (fs && fs.dg) fk.push(el('div', { style: 'margin-top:8px' }, [dl([['Expected', fs.dg.expected], ['Found', fs.dg.found], ['Did you mean', fs.dg.similar.join('; ')], ['Page', fs.dg.url]])]));
    if (fs && fs.hn) fk.push(healNotesView(fs.hn));
    kids.push(panel(t.state === 'flaky' ? 'Why it was flaky' : 'Failure', fk));
  }

  var shots = stepShots(t);
  if (shots.length) {
    var body = [];
    if (fs && (t.state === 'failed' || t.state === 'error')) {
      var after = shots.filter(function (x) { return x.step === fs; }).pop();
      var afterIdx = after ? shots.indexOf(after) : -1;
      var before = afterIdx > 0 ? shots[afterIdx - 1] : null;
      if (after && before) body.push(el('div', null, [el('h4', { text: 'Before and after the failing step' }), compareView(before, after, ['Before', 'After'])]));
      else if (after) {
        var ab = el('button', { type: 'button', cls: 'shot-big', 'aria-label': 'Enlarge: ' + after.alt }, [el('img', { src: after.url, alt: after.alt })]);
        ab.addEventListener('click', function () { openLightbox(shots, afterIdx, ab); });
        body.push(el('div', null, [el('h4', { text: 'The failing step' }), ab]));
      }
    }
    var grid = el('div', { cls: 'shots', style: body.length ? 'margin-top:12px' : null });
    shots.slice(0, 120).forEach(function (s, i) {
      var btn = el('button', { type: 'button', 'aria-label': 'Enlarge: ' + s.alt }, [el('img', { src: s.url, alt: s.alt, loading: 'lazy' })]);
      btn.addEventListener('click', function () { openLightbox(shots, i, btn); });
      grid.appendChild(el('figure', { cls: 'shot' }, [btn, el('figcaption', { text: s.n + '. ' + s.step.n })]));
    });
    body.push(grid);
    kids.push(panel('Screenshots', body, [el('span', { cls: 'muted small', text: String(shots.length) })]));
  }

  // The step order of the video's chapters: the n-th executed step is the n-th chapter.
  var cueList = (t.video && t.video.cues) || [];
  var flat = []; walkSteps(t.steps, function (s) { if (s.s !== 'S') flat.push(s); });
  var used = {};
  function cueFor(s) {
    for (var i = 0; i < cueList.length; i++) if (!used[i] && cueList[i][2] === s.n) { used[i] = 1; return cueList[i]; }
    return null;
  }
  var failCue = -1;
  if (fs) for (var ci = 0; ci < cueList.length; ci++) if (cueList[ci][2] === fs.n) failCue = ci;
  if (t.video) kids.push(panel('Video', videoView(t, failCue)));
  else if (t.videoNote) kids.push(panel('Video', [el('p', { cls: 'muted', text: t.videoNote })]));
  void flat;

  var steps = el('ol', { cls: 'steps', 'aria-label': 'Steps of ' + t.name });
  var ctx = { n: 0, shots: shots, cueFor: cueFor };
  t.steps.forEach(function (s, i) { steps.appendChild(stepNode(s, t, String(i + 1), ctx)); });
  kids.push(panel('Steps', [el('p', { cls: 'small muted', text: 'Bars show when each step ran within the test (' + fmtMs(t.durationMs) + '). Select a step for its details, screenshot, DOM snapshot and evidence.' }), steps], [el('span', { cls: 'muted small', text: String(ctx.n) })]));

  if (t.waterfall && t.waterfall.length) kids.push(panel('Network', [waterfallView(t)], [el('span', { cls: 'muted small', text: t.waterfall.length + ' requests' })]));
  else if (t.network && t.network.length) {
    var ntb = el('tbody', null, t.network.map(function (n) { return el('tr', null, [el('td', { cls: 'mono', text: n.method }), el('td', { cls: 'mono', style: 'word-break:break-all', text: n.url }), el('td', null, [n.failure ? badge('failed', n.failure) : badge(n.status >= 400 ? 'failed' : 'passed', String(n.status))]), el('td', { cls: 'num', text: n.ms !== undefined ? fmtMs(n.ms) : '-' })]); }));
    kids.push(panel('Network', [el('div', { cls: 'tbl-wrap' }, [el('table', null, [el('caption', { text: 'Network around the failing step' }), el('thead', null, [el('tr', null, [el('th', { scope: 'col', text: 'Method' }), el('th', { scope: 'col', text: 'URL' }), el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Time' })])]), ntb])])]));
  }
  if (t.console && t.console.length) kids.push(panel('Console', [consoleView(t)], [el('span', { cls: 'muted small', text: t.console.length + ' messages' })]));
  if (t.attempts && t.attempts.length > 1) kids.push(panel('Retries', attemptsView(t), [el('span', { cls: 'muted small', text: t.attempts.length + ' attempts' })]));
  if (t.history) kids.push(panel('History', [el('p', null, ['Recent outcomes (oldest first): ', spark(t.history.sequence)]), dl([['State', t.history.state], ['Failure rate', Math.round(t.history.failRate * 100) + '% of ' + t.history.samples + ' runs'], ['Why', t.history.reasons.join('; ')]])]));
  if (t.row) {
    var keys = Object.keys(t.row);
    kids.push(panel('Data row', [el('div', { cls: 'tbl-wrap' }, [el('table', null, [el('caption', { cls: 'sr-only', text: 'Data used by this test' }), el('thead', null, [el('tr', null, keys.map(function (k) { return el('th', { scope: 'col', text: k }); }))]), el('tbody', null, [el('tr', null, keys.map(function (k) { return el('td', { cls: 'mono', text: t.row[k] }); }))])])])]));
  }
  var ti = byId[t.id];
  var allEv = Object.keys(EV).filter(function (id) { return EV[id][7] === ti; });
  if (allEv.length) kids.push(panel('Evidence vault', [evidenceBrowser(allEv, { page: 50 }), el('p', { cls: 'small muted', text: 'Every file is hash-chained in the run’s evidence manifest: its SHA-256 and chain position are verified by eztest evidence verify. Links are relative to the run folder, so they work from the folder, from file:// and after unzipping it.' })], [el('span', { cls: 'muted small', text: String(allEv.length) })]));
  detail.textContent = '';
  kids.forEach(function (k) { detail.appendChild(k); });
  detail.classList.remove('closed');
}

function openTest(id, fromList) {
  var i = byId[id];
  if (i === undefined) return false;
  st.open = id;
  renderDetail(T[i]);
  var h = '#test/' + encodeURIComponent(id);
  if (location.hash !== h) { try { history.replaceState(null, '', h); } catch (e) { location.hash = h; } }
  var ri = -1;
  for (var r = 0; r < rows.length; r++) if (rows[r].t === i) { ri = r; break; }
  if (ri < 0) {
    // make it visible: clear filters that hide it, expand its groups
    if (!matches(i)) { st.state = 'all'; st.query = ''; q.value = ''; st.tag = st.owner = st.browser = ''; if (fTag) fTag.value = ''; if (fOwner) fOwner.value = ''; if (fBrowser) fBrowser.value = ''; document.querySelectorAll('.fchip[data-state]').forEach(function (x) { x.setAttribute('aria-pressed', String(x.getAttribute('data-state') === 'all')); }); }
    st.collapsed = {}; rebuild();
    for (r = 0; r < rows.length; r++) if (rows[r].t === i) { ri = r; break; }
  }
  if (ri >= 0) { st.active = ri; focusRowNoFocus(ri); }
  if (!fromList) { document.getElementById('tests').scrollIntoView({ block: 'start' }); detail.focus({ preventScroll: true }); }
  else render(true);
  return true;
}
function focusRowNoFocus(i) {
  var top = i * ROW_H;
  if (top < vlist.scrollTop || top + ROW_H > vlist.scrollTop + vlist.clientHeight) vlist.scrollTop = Math.max(0, top - vlist.clientHeight / 2);
  render(true);
}
function closeTest() {
  st.open = null;
  detail.textContent = '';
  detail.appendChild(el('div', { cls: 'empty' }, [el('p', { text: 'Select a test to see its steps, evidence and failure details.' })]));
  detail.classList.add('closed');
  try { history.replaceState(null, '', location.pathname + location.search + '#tests'); } catch (e) { /* ignore */ }
  render(true);
  var n = rendered[st.active]; if (n) n.focus();
}

function route() {
  var h = location.hash || '';
  var m = /^#test\/(.+)$/.exec(h);
  if (m) { var id; try { id = decodeURIComponent(m[1]); } catch (e) { id = m[1]; } openTest(id, false); return; }
  var f = /^#filter\/([a-z]+)$/.exec(h);
  if (f) { setState(f[1] === 'failed' ? 'failed' : f[1]); document.getElementById('tests').scrollIntoView({ block: 'start' }); return; }
  var c = /^#category\/([a-z]+)$/.exec(h);
  if (c && fCat && CAT[c[1]]) { st.cat = c[1]; fCat.value = c[1]; st.active = 0; rebuild(); document.getElementById('tests').scrollIntoView({ block: 'start' }); }
}
window.addEventListener('hashchange', route);
document.addEventListener('click', function (ev) {
  var b = ev.target.closest ? ev.target.closest('[data-copy-bug]') : null;
  if (b) { var t = T[byId[b.getAttribute('data-copy-bug')]]; if (t) copyText(bugText(t), b); }
});

// ------------------------------------------------------------ global shortcuts
document.addEventListener('keydown', function (ev) {
  var tag = (ev.target && ev.target.tagName) || '';
  var editing = /INPUT|TEXTAREA|SELECT/.test(tag) || (ev.target && ev.target.isContentEditable);
  if (ev.key === '/' && !editing) { ev.preventDefault(); document.getElementById('tests').scrollIntoView({ block: 'start' }); q.focus(); }
  else if (ev.key === 'Escape' && !editing && st.open && !(lb && lb.open)) { closeTest(); }
  else if (ev.key === '?' && !editing) { alert('Keyboard shortcuts\n\n/  search tests\nUp / Down  move in the list\nEnter  open the test or group\nLeft / Right  collapse / expand a group\nEsc  close the test or the screenshot\nPrint button  executive summary as PDF'); }
});

// ------------------------------------------------------------ configuration filter
var cfgQ = document.getElementById('cfg-q');
if (cfgQ) cfgQ.addEventListener('input', function () {
  var v = cfgQ.value.trim().toLowerCase(), shown = 0, rowsC = document.querySelectorAll('#cfg-table tbody tr');
  rowsC.forEach(function (tr) { var on = !v || (tr.textContent || '').toLowerCase().indexOf(v) >= 0; tr.hidden = !on; if (on) shown++; });
  var n = document.getElementById('cfg-count'); if (n) n.textContent = shown + ' of ' + rowsC.length + ' settings';
});

var evHost = document.getElementById('ev-browser');
if (evHost) { evHost.textContent = ''; evHost.appendChild(evidenceBrowser(Object.keys(EV), { runWide: true, page: 50 })); }
rebuild();
route();
window.__ezReport = { tests: T.length, rows: function () { return rows.length; }, open: openTest };
})();
`;

export const REPORT_SCRIPT = SCRIPT.replace('__ICONS__', () => JSON.stringify(ICON_PATHS).replace(/</g, '\\u003c'));
