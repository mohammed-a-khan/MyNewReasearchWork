# Reports

Every `eztest run` (and `eztest analyze <runDir>`, `eztest merge`) writes its reports into the run
directory, next to the evidence they link to:

| File | What it is |
|---|---|
| `report.html` | The run report: one self-contained HTML file in tabs (below). Works offline and from `file://`, can be mailed or attached (Azure DevOps attaches it to the test run), prints every section, light and dark, accessible (WCAG 2.2 AA, checked with EZTest's own accessibility engine in both themes, on desktop and at 390 px), and handles runs of 10,000+ tests (virtualised list). |
| `summary.html` | The one-page summary: the result counts, the outcome and pass-rate trend, the top failure causes and where the run was published, laid out for one A4 / Letter page. Print it to PDF. |
| `report.pdf` | The PDF report, written by EZTest's own PDF writer (no browser needed), with sections that mirror the tabs: Overview, Failures (by cause, with the next step), Tests (each failing test with its failing step, error, expected and actual, screenshot and steps; then every test), Trends, Quality and Environment. Bookmarks per section, page numbers, the brand's footer, and test names that link to their permalink in `report.html`. |
| `report.xlsx` | The Excel workbook, written by EZTest's own SpreadsheetML writer: Overview, Tests, Steps, Failures (by cause), Requirements, Trends, Quality, Configuration and Environment sheets, with frozen headers, filters, number formats, state colours and a link from each test to its permalink in `report.html`. |
| `email.html` | The run summary as an e-mail: the counts, the outcome bar, the failures by cause with their next step and permalinks, the pass-rate trend, the environment, and buttons to the report, the Azure DevOps test run, the build and the pull request. Tables and inline styles only (no script, SVG or external images), so it reads the same in desktop and web mail clients, on a phone and in dark mode. The `email` publisher sends it. |
| `report.json` | The machine-readable report, versioned ([schema](#reportjson)). |
| `junit.xml` | JUnit XML for CI test tabs. |
| `tests.csv` | One row per test, for spreadsheets and BI tools. |
| `report-model.json` | The report model the files above are rendered from; `eztest report render` re-renders from it. |
| `context.json`, `integrations.json` | The run context, and what the integrations did (Azure DevOps, PR, Jira, Slack/Teams, results server). |

Formats: `reporters: [console, html, json, junit]` in the config, or `eztest run --reporter html,json,junit`. `html` also writes `tests.csv`, `summary.html`, `email.html`, `report.xlsx` and `report.pdf` (each can be asked for on its own: `csv`, `summary`, `email`, `xlsx`, `pdf`).

There is no verdict in any of them by default: the report shows what happened and readers decide. A release gate is an explicit opt-in ([below](#readiness-policy-opt-in)).

## The report

**Header** (shown once; the title rows scroll away, the result counts and the tabs stay at the top). The brand (logo or mark, company, title and subtitle), the run (project and environment, date and time, duration, browsers) and the result counts as a status bar: tests, passed, failed, flaky and skipped (errors and healed when there are any), each with its change against the previous run, each opening the Tests tab filtered to it. Export menu, Print, light / dark theme.

**Tabs.** A WAI-ARIA tablist: one panel at a time, Left / Right / Home / End to move between tabs, deep links (`#overview`, `#tests`, `#tests/<id>`, `#tests?state=failed`, `#tests?cat=product`, `#failures`, `#failures/<cause>`, `#trends`, `#quality`, `#environment`), back and forward work, and the last tab is remembered. Each fact is in exactly one tab.

- **Overview**: the outcome donut (pass rate in the centre, the share of each result), results by feature or module and by tag (tests, failing, a bar and the pass rate per row), results by browser in a cross-browser run, the slowest tests, and the top failure reasons, each once with its count, linking to its cause in Failures. A banner when the environment was down or the circuit breaker stopped the run.
- **Tests**: the virtualised list grouped by feature (a BDD feature and rule, else the journey's folders), file, tag, browser, owner or failure category; filter chips by result, full-text search (names, ids, tags, steps, errors, owners, test case ids, data-row values), a tag filter, more filters (owner, browser, category), sorting (run order, failures first, slowest, name). Selecting a test opens its detail beside the list (on a phone, full screen with a Back button). Keyboard: `/` search, arrows to move, Enter to open, Left / Right to collapse or expand a group, Esc to close, `?` for the list.
- **Failures** (when something failed or was flaky): failing and flaky tests grouped by cause - the category (product defect, test issue, environment, test data, flaky, needs review), then similar errors (one failure cluster, else one error signature) - each group with its message, whether it is new or was seen before, the suggested next step, "Copy for bug" and its tests, each listed once and opening in Tests.
- **Trends** (when history or a baseline exists): pass rate, duration and flaky tests over the last runs (`report.trendRuns`, from `.eztest/history.json`), and the changes since the baseline run (`report.baseline`): newly failing, fixed, slower, new and removed tests. A test's own history is in its detail.
- **Quality** (when lenses, coverage or API contract checks ran): accessibility violations by rule (impact, WCAG criteria, elements, pages, tests), security findings, web-vital budgets, requirements / risk / API / UI coverage, and the API contract coverage tables.
- **Environment**: the run (id, start and end, time zone, trigger, who ran it, shard), the target (environment, base URL, devices), source and pipeline (CI system, pipeline, build, release, repository, branch, commit, pull request, owners of the failing tests), the machine (host, OS, CPUs, memory, Node.js, EZTest version), browsers and versions, the filters used, then collapsed: the effective configuration (filterable, secrets masked: passwords, secrets, tokens, API keys, credentials, cookies, TOTP, webhooks, connection strings, credentials in URLs, token-shaped values; `secret://` references stay), publishing (Azure DevOps test run, bugs, build and release; pull request; Jira; Slack / Teams / e-mail; results server; other publishers), and the evidence vault of the whole run.

**The test detail.** The title, result, duration, browser, feature, file, owners, tags, the data row of a data-driven test, requirements, the Azure DevOps test case, plan, suite and result, and the bugs filed; "Copy for bug" (title, steps, error, environment, data, category, next step, test case and permalink, ready to paste), "Copy link", close. Then:

- the cause, once: the category, new or seen before, the next step, the other tests with the same cause, and the triage's reasons behind a disclosure;
- attempts as a segmented control when the test was retried: an earlier attempt shows its steps with the ones whose outcome differs from the final attempt marked;
- sub-tabs, one at a time (arrow keys move between them): **Steps**, **Logs** (console: time, level, step, source; filter by level), **Network** (a waterfall with method, URL, status, type, size and time, expandable for timing and masked headers; "Failed only" and a filter), **Video** (chapters per step that seek, a marker per step with the failing one in red, "Jump to the failure", speed, one video per attempt, actor or page; or why there is none), **Trace** (open the time-travel trace in Studio, the `eztest trace steps` command, the trace download), **Evidence** (every evidence file with a thumbnail, name, size, time, SHA-256 and chain position, Open / Download, filters) and **History** (recent outcomes, state, failure rate).

The **Steps** timeline: each step with its status, number and duration, nested blocks indented, a thumbnail of its screenshot (opens the lightbox: Previous / Next, keyboard, fit or actual size) and, with a video, a play button that seeks the video. The failing step opens by itself with the error and stack, expected and actual, and the screenshots before and after it in a compare slider (or side by side). Any step opens for its post-conditions, locator, heal (old and new locator, tier, confidence, verified), what healing tried, API exchange (request and response, masked), database rows (masked), visual comparison (baseline, actual, diff overlay), DOM snapshot before and after (sandboxed: scripts removed, no network) and its other evidence.

**Print.** Every tab's content prints in order without the tabs; the Tests tab prints one section per test (failing tests start a page).

**Charts** are EZTest's own SVG (no chart library), with a title and description and a tooltip on hover and keyboard focus; small explanations sit behind info buttons.

## Configuration

```yaml
report:
  name: Contoso Shop                 # the project name in the header (default: package.json name, else the folder)
  title: Shop web - regression       # report title (default: "<name> test report")
  trendRuns: 20                      # runs in the trends
  baseline: previous                 # previous | none | <run directory>
  studioUrl: http://localhost:4400   # "open trace in Studio"
  readiness: false                   # true adds the secondary Policy tab (below)
  brand: { ... }                     # white-label branding (below)
  brandFile: branding.yaml           # a brand file that overrides report.brand
```

`eztest init` writes this section, commented, into a new project's `eztest.config.yaml`. Azure DevOps links need `ado.organizationUrl` and `ado.project` (in Azure Pipelines they default to the pipeline's collection and project); Jira links use the `baseUrl` of the `jira` publisher. The older `report.logo` and `report.brandColor` still work (`report.brand.logo` and `report.brand.colors.primary` win).

## Branding

Every output - `report.html`, the PDF, the e-mail summary, the workbook, the one-page summary, the chat cards and Studio's Results view (which shows the report) - carries the brand:

```yaml
report:
  brand:
    company: Northwind QA                       # header eyebrow, PDF author, e-mail, chat cards
    title: Nightly regression                   # the report title (wins over report.title)
    subtitle: Shop web                          # "Nightly regression — Shop web"
    preparedBy: QA Platform team (qa@northwind.example)
    footer: Confidential - Northwind internal use only.   # every output's footer
    logo: branding/logo.svg                     # light theme: .svg .png .jpg .webp, at most 512 KiB
    logoDark: branding/logo-dark.svg            # dark theme (default: the light logo)
    favicon: branding/favicon.png               # .svg .png .ico, at most 128 KiB
    mark: branding/mark.svg                     # small square mark when there is no logo (and the PDF), at most 256 KiB
    colors:
      primary: "#0b6e4f"                        # accents, links, the selected tab, buttons
      secondary: "#c2410c"                      # the second chart series
      headerBackground: "#0b1f3a"               # optional header colours
      headerText: "#ffffff"
      failed: "#c0262d"                         # status colours: passed failed flaky skipped error healed
    font:
      family: Northwind Sans                    # a system font stack follows it
      file: branding/northwind-sans.woff2       # optional, embedded, at most 1 MiB
    labels:
      tabs: { tests: Test cases }               # overview tests failures trends quality environment policy
      test: test case                           # what a test is called in running text
      tests: test cases
      sections: { byFeature: Results by module }   # outcome byFeature byTag byBrowser slowest topFailures
    hide: [trends, quality, environment]        # sections left out of every output (also failures, policy)
    whiteLabel: true                            # no "EZTest" name or "generated by" mark anywhere
    theme: light                                # light | dark | system (the reader's own choice is remembered)
```

- **Assets** are read from the project (or the brand file's folder) and embedded as `data:` URIs, so `report.html` stays one self-contained file. A file of the wrong type, with the wrong content (an SVG with scripts or event handlers, a `.png` that is not a PNG, a `.woff2` that is not WOFF2) or over its size limit is rejected with an error that names the setting, the file and the limit; the run's reports are written without it and the error is printed as a warning.
- **Colours.** From each colour the report derives the shades it needs: a text shade for links and labels (at least 4.5:1 on the report's light and dark surfaces), a soft tint, a button colour with readable text on it, status marks (at least 3:1) and their text shades (4.5:1). A colour that would fail WCAG AA is replaced by the closest accessible shade, and the build says so (`report.brand.colors.primary #ffd400 has a contrast of 1.3:1 ...; links and labels use the accessible shade #7a6600`). A header text colour that is unreadable on the header background falls back to black or white.
- **Per project and per environment**: `report.brand` follows the normal config layers, so `projects.<app>.report.brand` and `config/<env>.yaml` override it.
- **For CI**: a brand file (YAML or JSON with the `report.brand` keys, optionally under `brand:`) overrides `report.brand`: `eztest run --brand-file branding.yaml`, `eztest analyze <runDir> --brand-file branding.yaml`, `EZTEST_BRAND_FILE=branding.yaml`, or `report.brandFile`.

## Readiness policy (opt-in)

The report has no verdict by default. Teams that want a release gate use the readiness policy ([configuration.md](configuration.md#readiness-policy)) explicitly:

- in a pipeline, `eztest analyze <runDir> --policy readiness-policy.yaml` (or `eztest run --policy ...`, `eztest merge ... --policy ...`) evaluates it; `eztest analyze --policy` exits with 1 on NO_GO, and `eztest gate <runDir>` turns the recorded decision into CI annotations;
- `report.readiness: true` adds a secondary **Policy** tab with the decision, its reasons and gates, and the decision to the exports (PDF, workbook, e-mail, summary, trends). Without it, the decision stays in `report.json` (`insights.readiness`) only.

## In Studio

Studio's Results page opens a run on its report: the **Report** tab (first and selected) shows `report.html` in place, with the PDF, Excel and e-mail files. Studio keeps only its own tools next to it (Timeline with step deep links, Features with step bindings, heal proposals, the verified evidence vault); a journey deep link opens the report on that test ([docs/studio.md](studio.md)).

## Commands

```bash
eztest report compare <baselineRunDir> <runDir> [-o compare.html] [--json cmp.json] [--fail-on-new-failures]
# default output: <outputDir>/compare/<baseline>--<run>.html (run folders are evidence and are not written to)
eztest report trends [-o eztest-trends.html] [--runs 50] [--branch main] [--json trends.json]
eztest report render <runDir>        # render again from report-model.json (after publishing elsewhere)
eztest report schema                 # the JSON Schema of report.json
```

`eztest report trends` is the cross-run portfolio dashboard: pass-rate and duration trends, the flakiest, slowest and most failing tests, and a failure heat map by day and suite (the readiness history too with `report.readiness: true`). It reads `.eztest/history.json` (and the run directories' report models for suite names).

## E-mail

The `email` publisher mails `email.html` (with a plain-text alternative) after the run, with the PDF attached:

```yaml
publishers:
  - use: email
    host: smtp.example.com
    port: 587                          # STARTTLS when the server offers it; 465 = TLS from the start
    username: secret://env/SMTP_USER
    password: secret://env/SMTP_PASSWORD
    from: "Test reports <qa@example.com>"
    to: [team@example.com]             # also cc, bcc
    attach: [pdf, xlsx]                # pdf (default), xlsx, html, summary; [] for none (15 MiB in all)
    when: always                       # always | failed | not-go (not-go: the policy's NO_GO, else any failure)
    reportUrl: https://ci.example.com/artifacts/report.html
    # starttls: required, secure: true, subjectPrefix: "[Shop]", dryRun: true
```

The subject is `<title>: 3 of 40 tests failed (<run id>)`. With `reportUrl`, every test in the mail links to its permalink in the report. AUTH PLAIN or LOGIN is used as the server offers; what was sent is recorded in `integrations.json` and shown in the report's Environment tab.

## Chat cards

The `teams` publisher posts an Adaptive Card (1.5, full width): a header coloured by the result (failures, flaky, all passed), the key figures, the change against the previous run, the environment, branch, commit and build, the top failures (each opening its permalink in the report) and buttons to the report, the Azure DevOps test run, the build and the pull request. The `slack` publisher posts the same summary as Block Kit. Give the report's URL with `reportUrl:` on the publisher; otherwise the results-server run is linked.

```yaml
publishers:
  - use: teams
    webhook: secret://env/TEAMS_WEBHOOK
    reportUrl: https://ci.example.com/artifacts/report.html
```

## report.json

`report.json` has `format: "eztest-report"` and `version: 2` (`$schema: "eztest:report/2"`; print the schema with `eztest report schema`, or import `REPORT_JSON_SCHEMA` from `@eztech.com/eztest/report`):

- `run`: the run result (journeys, steps, evidence ids, environment), as in version 1;
- `insights`: triage, readiness (when a policy ran), flaky scores, API coverage and heal proposals, as in version 1;
- `model`: the report model (`format: "eztest-report-model"`, `version: 2`): `brand`, `kpis`, `previous`, `trend`, `slowest`, `failureGroups`, `clusters`, `coverage`, `comparison`, `integrations`, `context`, `browsers`, `evidence`, `categories`, `lenses`, `config`, `tests` and, only with `report.readiness: true`, `verdict`.

Each test in `model.tests` has `id`, `name`, `state` (`passed`, `healed`, `flaky`, `failed`, `error` or `skipped`, mutually exclusive), the journey's own `status`, `durationMs`, `startMs`, `tags`, `requirements`, `risk`, `attempt`, `browser`, `owners`, `file`, `suite` (outermost first), `error`, `failedStep`, `signature`, `cluster`, `failure` (`known`, `firstSeenRun`), `triage`, `history`, `cat` (failure category: `c`, `src`, `why`, `fix`), `flake`, `ado` (`testCases`, `plan`, `suite`, `results`, with links), `bugs`, `requirementLinks`, `row`, `actors`, `video`, `trace`, `attempts`, `network`, `console` and `steps`. Steps use short keys because a large run has hundreds of thousands of them: `n` intent, `s` status (`P` passed, `H` passed-healed, `F` failed, `S` skipped, `B` blocked), `d` duration ms, `t` start ms after the test started, `e` evidence ids, `x` error, `h` heal, `c` post-conditions, `l` locator, `a` actor, `i` iteration, `b` branch, `so` soft, `w` warnings, `dg` diagnosis, `db` query rows, `api` API exchanges, `im` locator suggestion, `m` manual verdict, `ch` child steps. `model.evidence` maps an evidence id to `[kind index into evidenceKinds, relative URL, description]`.

Readers of version 1 keep working: `run` and `insights` are unchanged.

## For runners: the suite tree

A runner that knows a richer hierarchy sets `JourneyResult.suitePath` (outermost first), for example `[{ kind: 'feature', name: 'Checkout' }, { kind: 'rule', name: 'Vouchers' }]`; the report then groups by it. Without it, the journey file's folders are the suites (a file with several journeys is a level of its own), and without a file the first tag is. Retried journeys carry `JourneyResult.attempts`, which the report compares.

## Size and speed

The static parts (Overview, Failures, Trends, Quality, Environment) are plain HTML and SVG; tests are embedded once as JSON, the list renders only the rows in view, and a test's detail is built when it is opened (each sub-tab when it is selected). A synthetic run of 5,000 tests is interactive in a browser in about half a second; one of 10,000 tests with 8 steps each gives a report of about 23 MB, rendered in about a second and interactive in well under a second; its Excel workbook (90,000 step rows) is written in about a second, the PDF in half a second and the e-mail in milliseconds (`test/scale/report-perf.test.ts` holds the budgets). The PDF details the first 60 failing tests and embeds at most 40 screenshots; the e-mail lists the first 8 causes.

## Security

All dynamic content is escaped; the script builds the test details with DOM APIs and `textContent` only. The embedded model is JSON in a non-executable script element with `<`, `>`, `&` and line separators escaped. The page's Content Security Policy allows no network access; evidence is linked by relative path inside the run directory (absolute paths, schemes and `..` are refused), links from integration records are rendered only when they are `http(s)`, and brand assets are embedded only as checked `data:` URIs. API bodies, DB rows and notes are masked when they are recorded.
