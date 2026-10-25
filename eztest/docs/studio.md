# EZTest Studio: architecture and extension points

EZTest Studio (`eztest studio`) is a local web app served by the `eztest`
package itself. It has no runtime UI dependencies and works offline. This page
is for the people adding features to it: the live debugger, the time-travel
trace viewer, heal review, triage and so on.

Recording opens a visible browser. On a machine without a display (a
container, CI, an SSH session: no `DISPLAY` or `WAYLAND_DISPLAY`), start the
Studio with `eztest studio --record-headless`; without the flag the Studio
prints a note at start, and a recording that cannot open its window says why.

## Layout

```
src/studio/
  server.ts          startStudio(): composes services + route registry, Host/Origin guard
  router.ts          Router + dispatch(): matching, access policy, body parsing
  http.ts            HttpError, sendJson/sendError, readJson, CSPs, content types
  app.ts             StudioApp: services shared by routes (ctx.app)
  events.ts          EventHub (topics, replay) + SSE streaming
  watch.ts           JourneyWatcher (journeys dir → files/problems topics)
  runs.ts record.ts  RunManager (incl. cancellation), RecordManager
  authoring.ts language.ts model.ts   validation, formatting, hover docs, visual step model
  bundle.ts          client bundle: prebuilt (dist) or built on the fly with esbuild (source)
  routes/            one module per feature: journeys, runs, insights, record, import,
                     settings, session, events, assets, static, debug, trace, quality-*,
                     scm (Source Control, see docs/git.md)
  scm.ts             Source Control service: git status/diff/blame/conflicts, branch filter, PR proposals
  quality/           Quality Center data (heals, triage, readiness, analytics, traceability); see docs/quality.md
  client/            the browser app (TypeScript, bundled by esbuild into app.js + app.css)
    core/            dom (h), store, api, events (hub client), router, registry, keys, theme, state
    ui/              shell, palette, modal, toast, split, tabs, table (virtual), tree, badge, sparkline, help, icons
    pages/           dashboard, journeys/ (CodeMirror editor, visual steps), run, results, insights,
                     record, import, settings, panels (Problems, Output, status bar)
    styles/          tokens.css (light/dark colour tokens), base, shell, components, editor, pages
```

**Build.** `npm run build` runs `tsc` and then `scripts/build-studio.mjs`. That
script bundles `src/studio/client/main.ts` and `styles/index.css` into
`dist/studio/client/app.{js,css}`. Under tsx or EZTest's testkit (`npm test`) there is no prebuilt
bundle, so the server bundles the sources in memory with esbuild on the first
request. If neither is possible, the error says what to run.
`npm run typecheck` checks the Node code (`tsconfig.json`) and the client
(`tsconfig.client.json`, DOM lib, bundler resolution). The client is excluded
from the Node build.

**Security model** (keep it when you extend the Studio):

- The server binds to 127.0.0.1 and serves only `Host` and `Origin` values that match.
- Every request needs the session token (64 hex characters).
  - A read accepts the header, a bearer token or the HttpOnly SameSite=Strict cookie.
  - A write needs the header and `Content-Type: application/json`.
- The CSP is `script-src 'self'` with no inline script. Styles are `'self'`, plus a per-response nonce for CodeMirror's own `<style>` element (`EditorView.cspNonce`). The token and nonce reach the client through `<meta>` tags.
- Client code renders data only through `h()`, so it goes through text nodes and attribute setters. The client never uses `innerHTML`, `eval` or `new Function`, and `test/studio/bundle.test.ts` enforces this.
- File access goes through `confinePath` or `confineJourneyPath`, and sensitive files are never listed or served.

## 1. Add a server route module

Create `src/studio/routes/<feature>.ts`:

```ts
import { HttpError, sendJson, str } from '../http.js';
import type { StudioRoute } from './route.js';

export const triageRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: /^\/api\/triage\/([^/]+)$/,         // capture groups → ctx.params (URI-decoded)
    summary: 'Triage board of a run',          // listed by GET /api/routes
    async handler({ res, app, params, query }) {
      sendJson(res, 200, await buildBoard(await app.outputDir(), params[0]));
    },
  },
  {
    method: 'POST',
    path: '/api/triage/label',
    async handler({ res, body }) {             // body: parsed JSON object (writes only)
      if (!body.label) throw new HttpError(400, '"label" is required');   // → { error } with status
      sendJson(res, 200, { ok: true, label: str(body.label, 'label') });
    },
  },
];
```

Then add it to `coreRoutes()` in `routes/index.ts`. The router applies the
access policy for you (`auth: 'session'` is the default; use `auth: 'public'`
only for static assets). Later registrations win, so a module can override a
core route. When the same path exists only for other methods, the router
answers 405 with an `Allow` header.

**Framework-agnostic routes.** A handler can return `{json}`, `{body, contentType}`
or `{sse}` instead of writing to `res` (see `RouteDef` in `routes/types.ts`, as
the debugger and trace modules do). Mount those with `fromRouteDefs(defs)`.
From outside the package, pass them to `startStudio({ routeDefs })`. For
`StudioRoute`s, use `startStudio({ routes })`, and use
`startStudio({ setup(app) { … } })` to register topics or cleanups
(`app.onClose`).

`ctx.app` (`StudioApp`) gives you `cwd`, `config()`, `journeysDir()`,
`outputDir()`, `journeyPath()` (confined), `hub`, `runs`, `recorder`, `watcher`,
`debug` and `problems()`.

## 2. Publish on an SSE topic

All live data goes through one multiplexed stream, `GET /api/events?topics=a,b&since=<seq>`.
Each frame carries `{ seq, topic, at, type, ...data }`. The browser
reconnects with `Last-Event-ID`, and the hub replays the last N events of each
topic.

Server side:

```ts
// Optional: declare it (replay depth, description). Publishing also declares it.
app.hub.registerTopic('triage', { replay: 200, description: 'Triage board changes' });
app.hub.publish('triage', { type: 'labelled', runId, journeyId, label });
```

To type the payload, extend the topic map:

```ts
declare module '../events.js' {
  interface StudioTopics { triage: { type: 'labelled'; runId: string; journeyId: string; label: string } }
}
```

Client side:

```ts
import { onTopic } from '../core/events.js';
const off = onTopic('triage', (m) => { /* m.type, m.runId, ... */ });
```

Built-in topics:

| Topic | Carries |
|---|---|
| `run` | Runner events, `queued`, `cancelling`, `cancelled`, `analysis`, `done` |
| `recorder` | `started`, `line`, `stopped` |
| `files` | `added`, `changed` or `removed` for a journey file on disk |
| `problems` | The validation errors of one file |
| `system` | Hub housekeeping |

Per-resource logs with full replay also remain available, such as
`/api/runs/:id/events`.

## 3. Add a page

```ts
import { registerPage } from '../core/registry.js';
import { h } from '../core/dom.js';

registerPage({
  id: 'triage', title: 'Triage', icon: 'shield',
  route: 'triage',            // #/triage/<rest>; the page parses route.rest / route.segments
  group: 'primary', order: 45, shortcut: 'Alt+8',
  mount(ctx) {                // called once; the page is kept alive while hidden
    const heading = h('h1', { class: 'page-title', tabindex: '-1', text: 'Triage' });
    ctx.root.classList.add('page-scroll');
    ctx.root.append(h('div', { class: 'page-inner' }, heading));
    return {
      show(route) { /* (re)load for route.segments */ },
      hide() {},
      focus: () => heading.focus(),
    };
  },
});
```

Call your `register…()` from `client/main.ts`. The activity bar, the
"Go to …" palette entries and the `Alt+N` shortcut all come from the
registration.

Building blocks:

- `ui/`: `createSplit`, `createTabs`, `createTable` (virtualized, sortable, filterable), `createTree`, `openModal`, `confirmDialog`, `promptDialog`, `toast`, `badge`, `statusIcon`, `card`, `stat`, `trendChart`.
- `core/`: `store`, `derived` and `h`.

Shared state lives in `core/state.ts`: `journeys`, `problems`, `activeRun` and `session`.

Deep links use `link(page, ...segments)` and `navigate(hash)`. Built-in links
look like `#/journeys/<path>:<line>` and `#/runs/<runId>/<journeyId>/<stepId>`.

## 4. Add a command-palette command (and a shortcut)

```ts
import { registerCommand, registerCommandProvider } from '../core/registry.js';
import { registerShortcut } from '../core/keys.js';

registerCommand({ id: 'triage.open', title: 'Open triage board', group: 'Triage', icon: 'shield',
  shortcut: 'Mod+Shift+T', when: () => true, run: () => navigate(link('triage')) });
registerShortcut({ keys: 'Mod+Shift+T', title: 'Open triage board', group: 'Triage', inInputs: true,
  run: () => navigate(link('triage')) });

// Dynamic items, optionally behind a prefix (built-in: ">" commands, "@" steps, "#" runs).
registerCommandProvider({ id: 'verdicts', prefix: '!', hint: 'Triage verdicts',
  items: async (query) => [{ id: 'v1', title: 'login: product bug', group: 'Verdicts', run: () => {} }] });
```

`Mod` means Ctrl, or Cmd on macOS. The shortcuts overlay (`?`) lists every
command that has a shortcut.

## 5. Add a run-detail tab

```ts
import { registerRunDetailTab } from '../core/registry.js';

registerRunDetailTab({
  id: 'trace', title: 'Trace', order: 35,
  when: (detail) => detail.run.journeys.length > 0,      // hide when irrelevant
  badge: (detail) => detail.run.journeys.length,
  mount(el, detail, ctx) {                               // ctx.journeyId / ctx.stepId from the deep link
    el.append(/* ... */);
    return () => { /* cleanup */ };
  },
});
```

Built-in tabs: Report (5), Overview (10), Timeline (20), Screenshots (30), Video (35), Heal
proposals (40), Quality (45), Triage (50), Features and Evidence (60).

A run with its HTML report opens on the **Report** tab: the run's `report.html` in place (served with
`frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`, so only Studio can frame it), with the
report's files (`detail.exports`: PDF, Excel workbook, e-mail summary, one-page summary, JSON,
JUnit, CSV). The report carries the overview, the tests, the failures by cause, the trends, the
quality findings and the environment, in the project's branding, so Studio shows no overview of
its own for such a run: Overview, Screenshots, Video and Triage appear only for a run without a
report, and the Timeline (step deep links), Features (step bindings), Heal proposals and the
verified Evidence vault stay. `#/runs/<runId>/<journeyId>/<stepId>/report` opens the report on
that test. Neither the run detail, the Run page nor Home shows a readiness decision; the Quality
Center's Readiness page is there for teams that use a readiness policy (docs/reports.md#readiness-policy-opt-in).
`detail.reportSummary` (from the run's `report-model.json`) keeps the figures, categories and
attention lists for extensions.

Pages can join the "Quality" activity-bar group with `group: 'quality'`, and a
two-segment route (`route: 'quality/heals'`) is matched before its first
segment. `registerDashboardCard({ id, order, render })` adds a card to Home.

## 6. Bottom panel and status bar

`registerPanel({ id, title, order, badge?: Readable<number>, mount(el) })` adds a
tab next to Problems and Output. `showPanel(id)` opens it.

`registerStatusItem({ id, align: 'left' | 'right', order, mount(el) })` adds
an item to the status bar.

## 7. Runner cancellation

`DELETE /api/runs/:id` aborts `RunOptions.signal`. The runner checks it
between journeys and between steps. Steps and journeys that have not run are
recorded as `skipped`, and a cancelled journey carries
`error.name === 'CancelledError'`. A paused debugger is disarmed. The browser
closes as usual, and the run ends with `done { state: 'cancelled' }`. Cancelled
runs are kept on disk but are not analyzed, so they never skew history.
`/api/runs` marks them `cancelled: true`.

## 8. Assurance, Workbench and Project pages

Three pages use section navigation (`registerSectionPage` in
`client/pages/assurance-ui.ts`): `#/assurance/<section>/<runId>/...`,
`#/workbench` and `#/project/<section>/...`. Routes live in
`routes/assurance-*.ts`, `routes/workbench.ts` and `routes/project-*.ts`,
mounted together by `assuranceRoutes()`.

- **Documents** (`/api/assurance/documents/*`): the evidence of `compareDocument`
  steps is re-extracted with the check's template so every mismatch carries
  its PDF position (points, top-left origin). The viewer renders pages with
  pdf.js, bundled by esbuild into `/assets/pdfjs/pdf.mjs` and `pdf.worker.mjs`
  (public, self-hosted, `dist/studio/client/pdfjs` after a build) and opened
  with `isEvalSupported: false`, so the page CSP needs no change. Ad-hoc
  compare takes uploads (kept in memory only), project PDFs or run downloads.
- **Visual**: ignore regions are saved in `.eztest/baselines/masks.json`, which
  the visual lens applies to every comparison. Approving a baseline copies the
  actual screenshot and records it in a new hash-chained vault under
  `.eztest/approvals/<stamp>/` (run folders are never modified, so their
  evidence packs stay valid).
  The page lists every comparison of a run: the per-step lens and the
  `Expect … to look like the baseline` steps, one item per viewport, with
  their mode, browser and viewport key and branch. It also lists the
  differences **grouped by the DOM change behind them**. A group that spans
  several comparisons, such as one CSS change on several pages, is approved
  in one action (**Approve group**). The DOM snapshot is approved with the
  screenshot, and baselines approved on a git branch go to
  `.eztest/baselines/branches/<branch>/` (see the visual section of
  [ez-language.md](ez-language.md)).
- **Accessibility**: the a11y lens records each offending element's box
  (document coordinates), drawn over the full-page step screenshot.
- **Workbench**: requests go through `ApiClient` on the server; a role's
  token is resolved by the Identity Vault there and only "Bearer ••••" reaches
  the browser. SQL is read-only unless writes are enabled for the session and
  each write is confirmed; reads use a read-only SQLite connection, a READ
  ONLY transaction (Postgres; Oracle, always rolled back) or a rolled-back
  transaction (SQL Server). The **Queries** panel lists the named-query
  catalogue (`db.queries`), runs a query with bound params through the same
  read-only path, and saves it as a `Run query "NAME" ...` step. "Save as
  step" uses `stepToText` and validates the lines with the parser before
  inserting them.
- **Project**: the active environment can be switched for the Studio session
  (`POST /api/project/environments/active`); every page, run and workbench
  call then loads that environment. **Project > Elements**
  (`GET /api/project/elements`) lists the shared element repository: each
  element's locators, the file and line that define it, its usages per
  journey and step (by `@reference` or by description), unused elements,
  unknown references, likely duplicates and loading problems (see
  [elements.md](elements.md)).
- **Performance** (`#/load/<section>`, `routes/load.ts`, `client/pages/load.ts`): the
  EZTest Load workspace. Design edits scenario files under `load/` (`/api/load/scenario`,
  validated and previewed by `/api/load/preview`); Correlation runs the user-path
  generator on a run's network evidence or an uploaded HAR (`/api/load/correlate`),
  keeps project rules in `load/correlation-rules.yaml` and replays a path once
  (`/api/load/check`); Run starts one load test at a time (`/api/load/runs`) and streams
  live snapshots on the `load` event topic, with stop/abort/add-VUs/scale through
  `/api/load/active/control`; Results reads the load runs of the results directory,
  compares two (`/api/load/compare`) and shows the trend. See [load.md](load.md).

## Tests

`test/studio/*`:

| File | Covers |
|---|---|
| `router.test.ts` | Registry and policy |
| `events.test.ts` | Hub and SSE |
| `watch.test.ts` | Live files and problems |
| `cancel.test.ts` | Real run cancelled mid-journey |
| `bundle.test.ts` | Bundle build, safety and CSP |
| `model.test.ts` | Visual step round trips |
| `ui.test.ts` | EZTest browser driver and EZTest's accessibility engine, light and dark |
| `assurance-routes.test.ts` | Assurance, Workbench and Project routes |
| `assurance-ui.test.ts` | Document viewer, visual approval, a11y overlay, workbench, project pages, accessibility checks and the real CSP |
| `scm-routes.test.ts` | Source Control routes on a real git checkout: status, diffs, commits, branches, push/pull, blame, conflicts, branch filter, PR proposals |
| `scm-ui.test.ts` | Source Control page: word diff, stage and commit, blame, conflict resolver, accessibility checks light and dark, the real CSP |
| `manual-routes.test.ts` | Test management and coverage routes: case save, verdict validation, ending runs, plans, reference files |
| `manual-ui.test.ts` | Case editor, guided manual run (upload and paste), hybrid pause and resume, cycles and dashboard, recorder conversion, Quality › Coverage overlay, accessibility checks light and dark |

## 9. Source Control

The Source Control page (`pages/source-control.ts`, `#/scm/<path>`) is built on
the same extension points: `registerPage`, a command (`scm.open`), a status bar
item (changes and the conflict indicator) and the `scm` SSE topic. Its routes
(`routes/scm.ts`) call `scm.ts`, which uses `src/git` (the `git` program, no
library). `attachScm(app)` listens on the `quality` and `assurance` topics: an
accepted heal, approved baselines or a quarantine change becomes a pull
request proposal (see [git.md](git.md#pull-requests-from-studio)).

## 10. Test management and coverage

**Test management** (`#/manual/<section>`, `client/pages/manual/`) is a section
page: Dashboard, Cases (list and case editor), Run (the guided runner),
Cycles and Automate. Its routes are `routes/manual.ts` over `manual-service.ts`.
Manual steps reach the browser through `ManualHub` (`manual-hub.ts`), the
run's `ManualVerdictProvider`: a step waiting for a verdict is published on
the `manual` topic (`waiting`, `answered`, `released`, `ended`, `plans`,
`case-saved`, `run-started`) and answered by `POST /api/manual/verdict`. See
[manual-testing.md](manual-testing.md).

**Quality › Coverage** (`client/pages/quality/coverage.ts`, routes
`routes/quality-coverage.ts`, data `quality/coverage.ts`) serves the combined
coverage view and the UI coverage map; the heat overlay is a stored DOM
snapshot rendered like the trace viewer's (`SNAPSHOT_CSP`, sandboxed iframe)
with outline CSS added. See [coverage.md](coverage.md).
