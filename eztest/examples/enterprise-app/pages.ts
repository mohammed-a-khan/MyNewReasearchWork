/**
 * HTML shells of the enterprise example app. Each page names the client
 * bundle that renders its widgets and passes page options as JSON
 * (`window.__PAGE`). Query parameters: `locale` (e.g. de-DE), `v` (markup
 * version, for healing scenarios), `rows` (grid size).
 */

const BASE_CSS = `
* { box-sizing: border-box; }
body { font: 14px/1.4 system-ui, sans-serif; margin: 16px; color: #222; }
h1 { font-size: 20px; margin: 0 0 12px; }
h2 { font-size: 16px; margin: 16px 0 8px; }
section { margin-bottom: 24px; }
label { display: inline-block; margin-right: 8px; }
button { cursor: pointer; }
.hidden { display: none !important; }
#log { font: 12px monospace; color: #555; white-space: pre-wrap; }
/* Icon elements of the emulated libraries (the real ones size them with icon fonts / SVG). */
[class*="k-icon"], [class*="k-svg-i-"], .dx-dropdowneditor-icon, .dx-treeview-toggle-item-visibility, .dx-navigate-button, .dx-checkbox-icon,
.dx-select-checkbox, .dx-sort, .p-checkbox-box, .p-sortable-column-icon, .sapMCbBg, .sapMCb, .sapMSltArrow, .mat-sort-header-arrow, .mat-mdc-select-arrow,
.mat-calendar-previous-button, .mat-calendar-next-button, .dx-tag-remove-button, .ui-icon, .oj-searchselect-arrow, .p-dropdown-trigger-icon, .pi {
  display: inline-block; min-width: 14px; min-height: 14px; background: #ddd; vertical-align: middle; cursor: pointer;
}
`;

export interface PageDef {
  title: string;
  /** Client bundles to load, in order. */
  scripts: string[];
  /** Static body HTML (bundles fill the placeholders). */
  body: (q: URLSearchParams) => string;
  /** Extra <head> HTML. */
  head?: string;
  /** Static CSS for the page. */
  css?: string;
}

export const PAGES: Record<string, PageDef> = {};

export function definePage(path: string, def: PageDef): void {
  PAGES[path] = def;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function renderPage(path: string, q: URLSearchParams): string | undefined {
  if (path === '/') return index();
  const def = PAGES[path];
  if (!def) return undefined;
  const locale = q.get('locale') ?? 'en-US';
  const opts = { path, locale, v: q.get('v') ?? '1', rows: q.get('rows') ? Number(q.get('rows')) : undefined, params: Object.fromEntries(q) };
  return `<!doctype html>
<html lang="${esc(locale)}">
<head><meta charset="utf-8"><title>${esc(def.title)}</title>
<style>${BASE_CSS}${def.css ?? ''}</style>${def.head ?? ''}</head>
<body>
<h1>${esc(def.title)}</h1>
${def.body(q)}
<script>window.__PAGE = ${JSON.stringify(opts).replace(/</g, '\\u003c')};</script>
${def.scripts.map((s) => `<script src="/assets/${s}.js"></script>`).join('\n')}
</body></html>`;
}

function index(): string {
  const links = Object.entries(PAGES).map(([p, d]) => `<li><a href="${p}">${esc(d.title)}</a> <code>${p}</code></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>EZ Enterprise</title><style>${BASE_CSS}</style></head>
<body><h1>EZ Enterprise</h1><p>Widgets that defeat naive automation. Real libraries where the license allows; faithful DOM emulations otherwise.</p><ul>${links}</ul></body></html>`;
}

// ------------------------------------------------------------------ real libraries

definePage('/grid/aggrid', {
  title: 'Orders (ag-Grid Community)',
  scripts: ['aggrid'],
  body: () => `<section aria-labelledby="h-orders"><h2 id="h-orders">Orders</h2>
<p><button id="reorder">Move Amount first</button> <button id="refresh">Reload data</button></p>
<div id="grid" style="height: 480px; width: 900px"></div></section>
<section aria-labelledby="h-wide"><h2 id="h-wide">Shipments</h2><div id="wide" style="height: 300px; width: 600px"></div></section>
<div id="log"></div>`,
});

definePage('/mui', {
  title: 'MUI widgets',
  scripts: ['mui'],
  body: () => `<div id="root"></div>`,
});

// ------------------------------------------------------------------ emulated libraries (same sections on every page)

const LIBS: Record<string, string> = {
  kendo: 'Kendo UI (emulated DOM)',
  devextreme: 'DevExtreme (emulated DOM)',
  primeng: 'PrimeNG (emulated DOM)',
  primefaces: 'PrimeFaces (emulated DOM)',
  material: 'Angular Material (emulated DOM)',
  jet: 'Oracle JET (emulated DOM)',
  ui5: 'SAP UI5 (emulated DOM)',
  aria: 'WAI-ARIA widgets',
};
for (const [lib, title] of Object.entries(LIBS)) definePage(`/lib/${lib}`, { title, scripts: ['emulated'], body: () => '<div id="root"></div>' });

definePage('/grid/aria', { title: 'Orders (10,000-row WAI-ARIA grid)', scripts: ['emulated'], body: () => '<div id="root"></div>' });
definePage('/heal', { title: 'Orders (markup version from ?v=)', scripts: ['emulated'], body: () => '<div id="root"></div>' });
definePage('/list', { title: 'Infinite feed', scripts: ['emulated'], body: () => '<div id="root"></div>' });
definePage('/charts', { title: 'Charts', scripts: ['charts'], body: () => '<div id="root"></div>' });
definePage('/widgets', { title: 'Sliders, masked inputs, drop zones', scripts: ['widgets'], body: () => '<div id="root"></div>' });
definePage('/editors', {
  title: 'Rich-text editors',
  scripts: ['emulated'],
  head: '<script src="/vendor/tinymce/tinymce.min.js"></script>',
  body: () => `<div id="root"></div>
<section aria-labelledby="h-description"><h2 id="h-description">Description</h2><textarea id="description"></textarea></section>
<script>
tinymce.init({ selector: '#description', base_url: '/vendor/tinymce', suffix: '.min', menubar: false, statusbar: false, promotion: false, branding: false, height: 200, toolbar: 'bold italic' });
</script>`,
});
