/** The small script of the standalone pages (comparison, trends, ...): chart tooltips and the theme toggle. */
export const MINI_SCRIPT = String.raw`
(function () {
'use strict';
var root = document.documentElement, tb = document.getElementById('theme-toggle');
function get() { try { return localStorage.getItem('ez-report-theme'); } catch (e) { return null; } }
function setTheme(t) { root.setAttribute('data-theme', t); if (tb) { tb.setAttribute('aria-pressed', String(t === 'dark')); tb.textContent = t === 'dark' ? 'Light theme' : 'Dark theme'; } try { localStorage.setItem('ez-report-theme', t); } catch (e) { /* private mode */ } }
var s = get();
setTheme(s === 'dark' || s === 'light' ? s : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
if (tb) tb.addEventListener('click', function () { setTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); });
var tip = document.getElementById('tip');
function show(t, x, y) { var v = t.getAttribute('data-tip'); if (!v || !tip) return; tip.textContent = v; tip.hidden = false; var w = tip.offsetWidth, h = tip.offsetHeight; tip.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, x + 12)) + 'px'; tip.style.top = (y - h - 12 < 8 ? y + 16 : y - h - 12) + 'px'; }
document.addEventListener('pointermove', function (ev) { var t = ev.target && ev.target.closest ? ev.target.closest('[data-tip]') : null; if (t) show(t, ev.clientX, ev.clientY); else if (tip) tip.hidden = true; });
document.addEventListener('focusin', function (ev) { var t = ev.target && ev.target.closest ? ev.target.closest('[data-tip]') : null; if (t) { var r = t.getBoundingClientRect(); show(t, r.left + r.width / 2, r.top); } else if (tip) tip.hidden = true; });
})();
`;
