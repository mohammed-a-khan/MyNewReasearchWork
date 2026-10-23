# Component adapters

Enterprise apps are built from component libraries whose widgets defeat naive automation: virtualized data grids (only the visible rows exist in the DOM, columns reorder, pin and virtualize too), combo boxes whose options appear in a popup at the end of `<body>` after an async search, date pickers with locale formats, trees that load children lazily, modals stacked over modals, toasts that are gone before anyone looks, editors inside iframes, canvas charts. Teams end up writing a helper class per widget per library.

EZTest's component layer (`src/runner/components/`, exported as `eztest/components`) does that work once. A plain-English sentence names a widget and what to do with it:

```text
In the Orders grid, click the row where Customer is "Contoso" and Status is "Open"
Edit the Amount of the row where Id is "42" in the Orders grid to 150
Choose "Berlin" in the City combobox
Pick 15 March 2027 in the Due date picker
Expand "Europe > Germany" in the Regions tree
```

The same sentence works whatever library renders the widget. The phrasings are listed in [ez-language.md, Components](ez-language.md#components-45-phrasings).

## How a component step runs

1. **Find the widget.** The description becomes ordered locator candidates: the widget role named like the description (`role=grid "Orders"`), a region or group of that name, a `<label>`, an `aria-label`, or the section that a heading, legend or label of that name introduces. As everywhere in EZTest, a candidate is used only when it matches exactly one element. The widget may be at that element, around it, or the single widget inside it.
2. **Detect the library.** Each adapter knows its widget's root (`.ag-root-wrapper`, `.MuiDataGrid-root`, `.k-grid`, `.dx-datagrid`, `[role=grid]`, ...). Custom adapters are tried first, then the library adapters, then the generic WAI-ARIA / native adapter.
3. **Act semantically.** Rows are found by their cell values, never by position. Virtualized grids are scrolled (and columns swept horizontally when they are virtualized too), paged grids are paged, load-more grids are grown. A row condition must match exactly one row; say "the first row where ..." to take the first match. Popups are found through `aria-controls`/`aria-owns` or the library's overlay container.
4. **Verify.** Every write reads the widget back: an edited cell must show the new value (numbers compare as numbers, so `150` matches `150.00`), a chosen option must show in the combo box, a picked date must be in the field in its display format, a tree node must be expanded, a closed dialog must be gone while the ones beneath stay open. A failure says what the widget shows instead.
5. **Record evidence.** Each step stores `components/<journey>/attempt-<n>/<step>.json` in the Evidence Vault with the adapter, the library, the resolved row key and row values, what was verified, and timings (rows scanned, pages, whether the content was virtualized).

The in-page half of the layer is one static script (never user input) installed per document. It reads the DOM, scrolls widget viewports and marks elements with a `data-ezc` attribute. Clicking and typing happen through ordinary drivert locators, with their actionability checks, in the widget's own frame.

## Operations

| Widget | Operations | Step `args.op` |
|---|---|---|
| Grid | click / double-click / right-click a row, click a control in a row, expand or collapse a row, edit a cell, read a cell, check a cell, count rows (all pages, all virtualized rows), sort, filter (filter row aligned under the header, or the grid's quick filter), select rows, scroll to a row, read all rows, check sort order, check columns | `clickRow` `doubleClickRow` `rightClickRow` `clickInRow` `expandRow` `collapseRow` `editCell` `readCell` `expectCell` `expectRows` `sort` `filter` `selectRows` `scrollToRow` `readAll` `expectSorted` `expectColumns` |
| Combo box / select / multi-select | choose one or several options (type-ahead for editable ones, a search box in the popup, async options), check what it shows; native `<select>` too | `choose` `expect` |
| Date picker | pick a date through the calendar (month navigation; day found by its date attribute, its localized accessible label or its number), fall back to typing in the display format (placeholder, explicit format, or the page locale; MUI section fields), check the date | `pick` `expect` |
| Tree | expand, collapse or select a path (`Europe > Germany > Berlin`), waiting for lazily loaded children; check a node | `expand` `collapse` `select` `expect` |
| Tabs, accordion | select a tab (and see its panel), expand or collapse a section | `select` `expect`, `expand` `collapse` |
| Dialog | click a control in a named or the top dialog, close a dialog, check that a dialog is open or closed, count open dialogs | `click` `close` `expectOpen` `expectClosed` `expectCount` |
| Toast | watch for toasts (records every toast from then on, also after navigation), expect a toast, expect none | `watch` `expect` `expectNone` |
| Rich text | replace, append, clear, check (contenteditable, Quill, CKEditor, TinyMCE inside its iframe) | `replace` `append` `clear` `expect` |
| Slider | set one handle or both handles of a range slider (keyboard, or the range input), check | `set` `expect` |
| Masked input | type keystroke by keystroke, verify the unmasked characters | `type` |
| Drop zone | put files in through the zone's file input, else a real drag-and-drop event; verify the names appear | `drop` |
| Chart | count points (categories or a series), check a value, capture the data | `expectPoints` `expectValue` `capture` |
| Infinite list | load everything by scrolling until it stops growing (bounded), count, capture | `capture` `expectCount` |

Scans of virtualized or paged content are bounded by 60 seconds, or by the step's `timeout=` when that is longer. A scan that hits the bound fails and says how many rows it read; it never reports a partial result as complete.

## Adapter matrix

What each adapter was tested against. **Real** means the real library from npm runs in the example app; **emulated** means a hand-written fixture that reproduces the library's documented DOM and class structure (for commercial or proprietary libraries, which are never installed, and for libraries that need their own framework compiler or loader); **reused** means the selectors the add-on already relies on, tested against the add-on's mock; **ARIA** means the WAI-ARIA Authoring Practices pattern. "dialect only" marks adapters that exist but are not exercised by a test.

| Library | Grid | Combo / select | Date picker | Tree | Tabs | Dialog | Other |
|---|---|---|---|---|---|---|---|
| ag-Grid Community 36 (MIT) | **real**: 10,000-row virtualization, pinned column, column reorder, column virtualization (20 columns), floating filters, selection column, inline edit, sort | | | | | | |
| MUI 9 / MUI X 9 (MIT) | **real**: X Data Grid, 300 rows over 12 pages, toolbar quick filter, edit, sort, select | **real**: Autocomplete (async, multiple), Select | **real**: X DatePicker (en-US, de-DE; calendar and section typing) | (MUI X Tree View not installed) | **real**: Tabs | **real**: Dialog (stacked), Snackbar | **real**: Accordion, Slider |
| Kendo UI (jQuery / Angular) | emulated: pager, filter row, in-cell edit, sort, select | emulated: ComboBox (async), DropDownList (filter box in popup), MultiSelect | emulated: DatePicker (en-US, de-DE) | emulated: TreeView | emulated: TabStrip | emulated: Window / Dialog, Notification | Slider, Upload: dialect only |
| Telerik / DevExtreme | emulated: dxDataGrid with pager, filter row, cell edit, sort, selection checkboxes | emulated: dxSelectBox (async and static), dxTagBox | emulated: dxDateBox (en-US, de-DE) | emulated: dxTreeView | emulated: dxTabPanel | emulated: dxPopup, dxToast | FileUploader: dialect only |
| PrimeNG | emulated: p-table with paginator, column filter row, cell edit, sort, checkbox selection | emulated: p-dropdown (filter in the overlay) | emulated: p-calendar (en-US, de-DE) | emulated: p-tree | emulated: p-tabView | emulated: p-dialog, p-toast | p-autocomplete, p-fileUpload: dialect only |
| PrimeFaces | emulated: DataTable with paginator, sort, row selection | emulated: selectOneMenu | (WAI-ARIA picker on the page) | | | | |
| Angular Material | emulated: mat-table with mat-paginator, mat-sort, filter input, checkbox selection | emulated: mat-select (single, multiple; CDK overlay) | emulated: mat-datepicker (localized day labels; en-US, de-DE) | emulated: mat-tree (flat) | emulated: mat-tab-group | emulated: mat-dialog, snack bar | mat-autocomplete, mat-accordion: dialect only |
| Oracle JET | emulated: oj-table with load-more-on-scroll, sort, selection | emulated: oj-select-single (async) | | | | emulated: oj-dialog, messages | |
| SAP UI5 (sap.m) | emulated: sap.m.Table with growing "More" trigger, SearchField, MultiSelect checkboxes (no built-in sort UI) | emulated: sap.m.Select | emulated: sap.m.DatePicker (en-US "MMM d, y", de-DE) | emulated: sap.m.Tree | emulated: IconTabBar | emulated: sap.m.Dialog, MessageToast | |
| Salesforce Lightning | reused: lightning-datatable inside its shadow root (Salesforce mock) | lightning-combobox: dialect only | | | | | |
| Dynamics 365 | reused: UCI view grid (D365 mock) | | | | | | |
| WAI-ARIA / native | ARIA: 10,000-row virtualized grid with aria-rowindex/colindex, column reorder, filter row, edit, sort; native `<table>` | ARIA: combobox with list autocomplete (async); native `<select>` | ARIA: APG date picker dialog (en-US, de-DE); native `<input type=date>` | ARIA: tree | ARIA: tabs | ARIA: dialog, `role=status` toasts | ARIA: accordion, slider, feed, generic drop zone, contenteditable |

Rich text, sliders, inputs and charts:

| Library | Status |
|---|---|
| TinyMCE (tested with 6, MIT; version 7+ is GPL) | **real**, editor inside its iframe. The adapter targets TinyMCE's DOM generically (`.tox-tinymce` and the body of its `iframe.tox-edit-area__iframe`, used by TinyMCE 5 to 8), not version 6: TinyMCE 6 is only a devDependency of the example app, never a dependency of EZTest |
| CKEditor 5 (GPL / commercial) | emulated DOM (`.ck-editor__editable[contenteditable]`); CKEditor 4 iframe: dialect only |
| Quill (BSD-3-Clause) | emulated DOM (`.ql-editor`) |
| noUiSlider 15 (MIT) | **real**, single handle and range |
| IMask 7 (MIT) | **real**, card number and phone masks |
| Dropzone.js | emulated DOM (hidden file input, `.dz-filename`) |
| Chart.js 4 (MIT) | **real**, read through `Chart.getChart(canvas)` when `window.Chart` is exposed |
| Apache ECharts 6 (Apache-2.0) | **real**, read through `echarts.getInstanceByDom()` when `window.echarts` is exposed |
| Highcharts (commercial) | emulated `window.Highcharts.charts` global |
| Charts with an accessible data table | ARIA: the table referenced by `aria-describedby` / `aria-details`, or inside the chart |
| Opaque canvas | explicit error: "canvas chart is not inspectable: ..." |

Licenses: only MIT and Apache-2.0 libraries are installed, as devDependencies used by the example app (they are not part of the published package, so `THIRD_PARTY_NOTICES.md` is unchanged). Kendo UI, Telerik, DevExtreme, Highcharts and CKEditor are commercial or copyleft and are never installed. Angular Material, PrimeNG, Oracle JET and SAP UI5 need the Angular compiler or their own module loader, so they are emulated as well; their adapters are tested against the documented DOM, not the real runtime. Emulated fixtures can drift from real releases: treat those adapters as a well-founded starting point, and add a custom adapter (below) when your version renders differently.

## Using it from code

In a code journey (`eztest/sdk`), `ui.component(widget, name, op, args)` runs a component step on the runner path, with the same lookup, verification, healing and evidence as the `.ez` phrasing:

```ts
journey('Adjust an order', async ({ ui }) => {
  await ui.open('/orders');
  await ui.component('grid', 'the Orders grid', 'editCell', { where: { Id: 42 }, column: 'Amount', value: 150 });
  const amount = await ui.component<string>('grid', 'the Orders grid', 'readCell', { where: { Id: 42 }, column: 'Amount' });
  await ui.component('combobox', 'the City combobox', 'choose', { values: ['Berlin'] });
  await ui.component('tree', 'the Regions tree', 'expand', { path: 'Europe > Germany' });
  await ui.component('dialog', 'Edit order', 'close');
});
```

The `op` names and arguments are the step's `args` (table above; `where` takes `{ column: value }`, `value` the value to write).

Outside a journey,

`eztest/components` exports plain functions over `eztest/browser` locators, for a code journey or a custom step (these are not runner steps: no healing or evidence vault).

```ts
import { locateWidget, clickGridRow, editGridCell, readGridRows, chooseOptions, pickDate, parseDateText, treeAction, treePath } from 'eztest/components';

const orders = await locateWidget(page, 'the Orders grid', 'grid');     // strict, like a .ez step
await clickGridRow(orders, { Customer: 'Contoso', Status: 'Open' });
const r = await editGridCell(orders, { Id: 42 }, 'Amount', 150);        // r.adapter, r.rowKey, r.verified
const all = await readGridRows(orders);                                  // { columns, rows, total, pages, virtualized, ms }
await chooseOptions(await locateWidget(page, 'the City combobox', 'combobox'), ['Berlin']);
await pickDate(await locateWidget(page, 'the Due date picker', 'datepicker'), parseDateText('15 March 2027'));
await treeAction(await locateWidget(page, 'the Regions tree', 'tree'), treePath('Europe > Germany'), 'expand');
```

Grids: `openGrid`, `gridColumns`, `findGridRow`, `clickGridRow`, `clickInGridRow`, `readGridCell`, `editGridCell`, `sortGrid`, `filterGrid`, `selectGridRows`, `scrollGridToRow`, `expandGridRow`, `readGridRows`, `countGridRows`, `expectGridSorted` (or the `Grid` class). Others: `chooseOptions`, `readCombo`, `expectCombo`, `pickDate`, `expectDate`, `treeAction`, `selectTab`, `expectTab`, `toggleSection`, `clickInDialog`, `closeDialog`, `expectDialog`, `watchToasts`, `expectToast`, `typeInEditor`, `readEditor`, `expectEditor`, `setSlider`, `readSlider`, `typeMasked`, `dropIntoZone`, `readChart`, `expectChartPoints`, `chartValue`, `loadList`. Each returns a report (`kind`, `adapter`, `library`, `op`, `rowKey`, `verified`, `ms`) or the value read, and throws a `ComponentError` that says what the widget shows. Options: `timeoutMs` (waits), `budgetMs` (scans), `adapter` (force one).

## Custom adapters

An in-house grid, or a library version whose markup differs, gets an adapter of its own. Most adapters are a dialect: plain data the engine interprets.

```ts
import { DialectAdapter, registerComponentAdapter } from 'eztest/components';

registerComponentAdapter(new DialectAdapter('grid', 'acme', 'ACME grid', 'emulated', {
  id: 'acme-grid',
  root: '.acme-grid',                    // widget root, matched at, above or inside the target
  headerCell: '.acme-grid__th',          // column headers
  colIdAttr: 'data-col',                 // links headers to cells (else: by position)
  row: '.acme-grid__tr', cell: '.acme-grid__td',
  rowKeyAttr: 'data-row-id',             // stable row identity (else: index or content)
  viewport: '.acme-grid__body',          // the vertical scroller (auto-detected when omitted)
  pagerNext: '.acme-pager__next',
  editTrigger: 'dblclick',
}));
```

Custom adapters are tried before the built-in ones; `registerComponentAdapter` returns a function that removes it. The dialect fields for each widget kind are documented in `src/runner/components/types.ts` (`GridDialect`, `ComboDialect`, `DateDialect`, `TreeDialect`, ...); the built-in ones in `src/runner/components/dialects.ts` are examples of every field.

## Healing and evidence

When a component step's widget no longer resolves (the grid was renamed, restyled, re-tested-id'd), the standard healing ladder runs first, then a component tier: it ranks every widget of the step's kind on the page by how well its accessible name or heading matches the description and, for grid steps that name a row by its values, by whether that row is in the grid. The heal is accepted only when the step's own verification passes (the row is found by its values; the edit is read back), so a heal can never act on a different row silently, and a row that is gone fails the step instead. The heal record says why, for example `component grid: name "Customer orders" ~ "Orders" 0.62; the only grid on the page; holds the row where Customer equals "Proseware" and Id equals "1500"`.

## The example app

`examples/enterprise-app/` is the test target: a small Node server (`npx tsx examples/enterprise-app/server.ts`) whose client code is bundled with esbuild on first request, as the Studio does.

| Page | What is on it |
|---|---|
| `/grid/aggrid` | ag-Grid: Orders (10,000 rows, pinned Id, editable Amount, floating filters, selection column, "Move Amount first" reorder button) and Shipments (20 columns in a narrow viewport) |
| `/mui` | MUI: X Data Grid (300 rows, pages of 25, quick filter, editable Amount), Autocomplete (async City, multiple Skills), X DatePicker, Tabs, Accordion, stacked Dialogs, Snackbar, Slider |
| `/lib/kendo`, `/lib/devextreme`, `/lib/primeng`, `/lib/primefaces`, `/lib/material`, `/lib/jet`, `/lib/ui5`, `/lib/aria` | The same sections for each library: Orders grid (60 rows), City combobox, Status drop-down list, Skills multi-select, Due date picker, Regions tree, Settings tabs, Edit order / Confirm delete dialogs, toasts |
| `/grid/aria` | A 10,000-row WAI-ARIA virtualized grid |
| `/editors` | contenteditable, Quill DOM, CKEditor 5 DOM, real TinyMCE |
| `/widgets` | noUiSlider (single, range), WAI-ARIA slider, IMask card and phone fields, drop zones |
| `/charts` | Chart.js, ECharts, a Highcharts-style chart, a chart with a data table, an opaque canvas |
| `/list` | An infinite feed of 250 items |
| `/heal?v=1`, `/heal?v=2` | The same grid in two markup versions (healing) |

Query parameters: `locale=de-DE` (date formats), `rows=N` (grid size), `v=2` (markup version).

## Performance

Reading a virtualized grid costs one animation frame per scroll step plus the library's own rendering, so it scales with the number of rows, not with what EZTest does per row. The step size is the library's whole rendered window (visible rows plus its buffer), and a gap check backs off if a step ever skips rows. Measured on the 4-core test container:

| Scan | Rows | Time |
|---|---|---|
| ag-Grid, all 10,000 rows (358 scroll steps) | 10,000 | about 10 s unloaded; 50 to 95 s while the machine ran other test suites (load average 35 on 4 cores) |
| ag-Grid, strict find of row 9,500 by value | 10,000 scanned | about 10 s unloaded |
| WAI-ARIA grid, all rows | 10,000 | about 11 s |
| MUI X Data Grid, 12 pages | 300 | under 2 s |
| Infinite feed until it stops growing | 250 | about 5 s (most of it the idle wait that proves the end) |

Prefer filtering a large grid before acting on it, and use "the first row where ..." when uniqueness is guaranteed by the data (an id column): a strict match has to read every row to prove there is only one.

## Known gaps

- Emulated adapters (Kendo, DevExtreme, PrimeNG, PrimeFaces, Angular Material, Oracle JET, SAP UI5, CKEditor, Quill, Highcharts) are tested against hand-written DOM, not the real libraries.
- Kendo locked columns and DevExtreme fixed columns split a row across two tables; cells are matched by position there, so those layouts are not supported yet.
- Grid filtering types into the filter row or the quick filter; library filter menus (operators such as "greater than") are not driven. Use `Expect ... rows where Amount > 100` to check instead.
- SAP UI5 sap.m.Table has no built-in sort UI (it is a ViewSettingsDialog in apps), so sorting it fails with a clear message.
- Grids without a stable row key and with virtualization key rows by their content; two identical rows merge.
- Date pickers: time pickers and date ranges are not covered; month navigation is one month per click (up to 600 steps).
- Charts are inspectable only through an instance the page exposes (`window.Chart`, `window.echarts`, `window.Highcharts`) or an accessible data table; bundled charts without a global are reported as not inspectable.
- Rich text: only plain text is typed and checked; formatting (bold, lists) is not.


## Single stories in isolation (the component harness)

`eztest stories` mounts a component on its own page and runs a journey against it, with the visual and a11y lenses — EZTest's own harness, no Storybook test-runner and no Playwright component testing.

- It reads **Storybook story files** (Component Story Format) as input: the default export gives the title and shared args, each named export is a story. Reading the format is all it borrows.
- It mounts the component from **your bundler output** (esbuild, already used for code journeys): the story file is bundled for the browser and served one isolated page per story. The built-in DOM renderer mounts a story whose `render(args)`/`component(args)` returns an `HTMLElement` or an HTML string; point `--renderer` at a small module exporting `mount(root, component, args)` to mount React/Vue/etc.
- A journey reaches a story through a `Story:` header; `Variables:`/`Examples:` rows set the story's args (passed as URL parameters).

```text
Journey: Primary button
Story: example-button--primary
Variables: label=Save, variant=primary
Expect the "Save" button to be visible
Expect the "data-variant" attribute of the "Save" button is "primary"
```

```
eztest stories --stories "src/**/*.stories.ts" --lens a11y,visual journeys/components
eztest stories list --stories "src/**/*.stories.tsx"
```

Exported from `eztest/stories` (`StoryHarness`, `listStoryFiles`) for use in code.
