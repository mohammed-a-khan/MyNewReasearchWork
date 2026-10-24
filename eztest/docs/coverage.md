# Coverage analytics

EZTest answers "what did we actually test?" in one place, along six
dimensions:

| Dimension | Covered when | Data comes from |
|---|---|---|
| UI elements | an interactive element (button, link, input, ... by accessible role and name) was interacted with or asserted on | time-travel trace DOM snapshots and step targets |
| Requirements | a requirement has a passing journey | `Requirements:` headers, a requirements list (CSV or Azure DevOps query) |
| API operations | a spec operation was called | `api.spec` (see [api-contracts.md](api-contracts.md)) |
| Risk-weighted | the risk points of journeys whose latest result passed | `Risk:` headers |
| Changed code | a changed file is mapped to a journey that passed | `selection.impactMapping` and git |
| Manual verification | a manual step has a tester's verdict | manual and hybrid journeys ([manual-testing.md](manual-testing.md)) |

The view is computed from the **latest result of every journey** across
recent runs, so a suite split over several runs (shards, tags, a nightly and a
smoke run) still adds up. Everything is deterministic: snapshots are
tokenized, never executed or rendered on the server, and no AI provider is
involved.

```text
eztest coverage                       the combined view (alias: eztest coverage summary)
eztest coverage --json                the same as JSON (UI map included)
eztest coverage --changed-since main  with change coverage against a git ref
eztest coverage --min 70              exit 1 when the overall coverage is below 70%
eztest coverage ui                    the UI coverage map: pages, untested elements, unvisited links
eztest coverage ui <runDir> --all     one run, tested elements listed too
eztest coverage ui --page /orders/:id --min 80
eztest coverage a11y                  accessibility trend: new, fixed and persisting issues
```

In the Studio: **Quality › Coverage** (`#/quality/coverage`).

## The UI coverage map

### Recording the data

The map is built from the DOM snapshots of the time-travel trace. Turn it on
for the runs that should count:

```yaml
trace:
  timeTravel:
    enabled: true          # or: eztest run --time-travel, or timeTravel: true on a Studio run
```

Each step stores the page before and after it, and the node the step acted
on. `eztest run` (and every Studio run) then writes `ui-coverage.json` into
the run directory and records it in the run's evidence chain, so the
`uiCoverage` readiness gate can cite it.

### How elements are found and matched

- **Pages** are grouped by route template: numeric, UUID and id-like path
  segments become `:id` (`/orders/12` and `/orders/13` are `/orders/:id`). Add
  your own patterns with `coverage.ui.routes` (`/teams/:team/members`). Hash
  routes (`#/orders/7`) count. A page on another host is shown as
  `//host/path`.
- **Interactive elements** are the visible elements whose ARIA role (explicit
  `role`, or the implicit role of `a[href]`, `button`, `input`, `select`,
  `textarea`, `summary`, `[contenteditable]`) is one of button, link, textbox,
  searchbox, checkbox, radio, combobox, listbox, option, menuitem(…), tab,
  switch, slider, spinbutton, treeitem. Hidden elements (`hidden`,
  `aria-hidden`, `display:none`, collapsed `<details>`, and anything the
  browser did not render at capture time) are left out. Same-origin iframes
  are included.
- **Names** follow the accessible-name rules: `aria-labelledby`, `aria-label`,
  the `<label>`, the content, `title`, `placeholder`, the value of submit
  buttons. Unnamed elements are named by test id, `#id` or `[name=…]`.
- **Grouping**: elements are grouped per page by role and name, with numbers
  normalised, so the 20 `ORD-…` links of an order table are one group
  ("link ORD-# ×20"). Turn this off with `coverage.ui.normalizeNumbers: false`.
- **Interacted**: the trace records the node a step acted on in its
  before-snapshot; a click on a `<span>` inside a button counts for the button.
  Steps whose target was not captured (e.g. inside a frame) match by the
  locator that resolved them.
- **Asserted**: post-conditions and assertions whose targets (`Expect the
  "Download invoice" link is visible`) match an element on the page after the
  step, by role and name, label, text, test id or `#id`.
- **Unvisited links**: link targets (same host) whose route never appears as a
  visited page.

```yaml
coverage:
  ui:
    routes: [/teams/:team/members]
    ignore: ["link:Skip to content", "button:Close*"]   # role or role:name, * wildcard
    ignoreRoutes: [/logout, /admin/*]
    normalizeNumbers: true
    testIdAttribute: data-testid
```

### Heat overlay

Quality › Coverage lists every page with its coverage; selecting one shows
its stored DOM snapshot (the one with the most elements) in a sandboxed
iframe, exactly as the trace viewer serves snapshots (`sandbox`, no scripts,
no network, `default-src 'none'`), with:

- tested elements outlined **solid green**, darker the more they are used;
- untested elements outlined **dashed red**;
- the element picked in the list ringed in blue.

Next to it, the untested elements of the page (or all, with their
interaction and assertion counts and the journeys that use them). The legend
uses line style as well as colour.

### Trend and gate

Quality › Coverage charts UI coverage per run (and accessibility issues),
from each run's `ui-coverage.json`. Gate releases on it in the readiness
policy:

```yaml
gates:
  uiCoverage: 0.6                                       # at least 60% of interactive elements
  # or
  uiCoverage: { min: 0.6, minPerPage: 0.4, pages: [/checkout, /orders/:id], severity: blocker }
```

`pages` narrows the gate to some routes (a listed route no journey visited
fails the gate); `minPerPage` fails on any page below it. Without snapshots
the gate reports `no-data`, never a pass.

## Accessibility trends

The a11y lens (`lenses: [a11y]`) stores EZTest accessibility engine results per step. Across runs,
each issue is keyed by rule, route and element (the node's selector path), so
`eztest coverage a11y` and Quality › Coverage show what is **new**, **fixed**
and **persisting**, by rule and by component. Gate on regressions with
`a11yNoNewViolations: true`.

Components and per-component rules come from `accessibility.scopes`; global
lens options (WCAG tags, include/exclude, disabled rules, the impact that
fails a step) from the same block:

```yaml
accessibility:
  tags: [wcag2a, wcag2aa, wcag21aa]
  exclude: ["#third-party-chat"]
  failOn: serious
  scopes:
    - name: Payment widget
      include: ["#payment"]
      rules: { contrast.text: warn }      # off drops it, warn keeps it visible (rule ids: docs/accessibility.md)
    - name: Navigation
      include: ["nav"]
```

### Keyboard operability

`Expect the page to be keyboard operable` (or `Verify the "Checkout" region
is keyboard accessible within 40 tabs`) drives the real keyboard: it Tabs
through the page or the element from the top and fails, naming elements,
when:

- a focusable element is never reached;
- Tab does not move focus away from an element, even after Escape (a
  keyboard trap, WCAG 2.1.2);
- focus cycles inside part of the page and never reaches the rest (for
  example a modal that keeps focus while the page behind it is still
  operable);
- the focused element shows no visible focus indicator (WCAG 2.4.7).

A positive `tabindex` that reorders focus is reported as a warning. The
result (order, problems, warnings) is stored as evidence.

## Failure tags

Every analysis tags failing journeys from the run history (smart tags):

| Tag | Meaning |
|---|---|
| New failure | fails now, did not fail in its previous 10 runs |
| Always failing | failed with the same failure signature in its last 3 runs |
| Regressed | fails now, passed in the run before |
| Flaky | fails now, and its recent history flips between pass and fail |

Failures of one run are also grouped into **unique errors** by signature.
The tags appear on the triage board, in Quality › Coverage and in the
`eztest run` output; gate on them with `noNewFailures: true`
(`{ includeRegressed: false }` to ignore regressions).

## Readiness gates added here

| Gate | Default severity | Fails when |
|---|---|---|
| `uiCoverage` | risk | UI coverage below `min` (or a page below `minPerPage`, or a listed page not visited) |
| `noNewFailures` | risk | a journey is tagged new failure (or regressed) |
| `manualVerified` | blocker | a manual or hybrid journey has manual steps without a verdict |
| `a11yNoNewViolations` | risk | an accessibility issue appeared that the previous scanned run did not have |

## API

```ts
import { analytics, insights } from '@mohammed-a-khan/eztest';

const map = await analytics.computeRunUiCoverage(runDir, runId, journeys, { routes: ['/orders/:id'] });
console.log(analytics.uiCoverageText(map));
const all = await analytics.projectCoverage({ outputDir, journeys });   // combined view + UI map
const tags = insights.failureTags(history.runs, runId);
```
