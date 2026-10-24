# Reports

Every `eztest run` (and `eztest analyze <runDir>`, `eztest merge`) writes its reports into the run
directory, next to the evidence they link to:

| File | What it is |
|---|---|
| `report.html` | The run report: one self-contained HTML file. Works offline and from `file://`, can be mailed or attached (Azure DevOps attaches it to the test run), prints as an executive summary, light and dark, accessible (WCAG 2.2 AA, checked with EZTest's own accessibility engine in both themes), and handles runs of 10,000+ tests (virtualised list). |
| `summary.html` | The one-page summary: verdict, key figures, outcome and trend charts, top failures and where the run was published, laid out for one A4 / Letter page. Print it to PDF. |
| `report.json` | The machine-readable report, versioned ([schema](#reportjson)). |
| `junit.xml` | JUnit XML for CI test tabs. |
| `tests.csv` | One row per test, for spreadsheets and BI tools. |
| `report-model.json` | The report model the files above are rendered from; `eztest report render` re-renders from it. |
| `context.json`, `integrations.json` | The run context, and what the integrations did (Azure DevOps, PR, Jira, Slack/Teams, results server). |

Formats: `reporters: [console, html, json, junit]` in the config, or `eztest run --reporter html,json,junit`. `html` also writes `tests.csv` and `summary.html` (`csv` and `summary` can be asked for on their own).

## What the report shows

**Executive summary first.**

- The readiness verdict (GO / GO WITH RISKS / NO GO) from the readiness policy, its score, each reason with the tests, requirements and evidence it cites, and the state of every gate. Without a policy, EZTest's built-in rule decides (failures are NO GO; flaky or healed tests are GO WITH RISKS), and the report says so.
- Key figures: total, passed, failed, flaky, healed, skipped, pass rate and duration, each with its change against the previous run in history. Each figure filters the test list.
- Charts (EZTest's own SVG, no chart library): the outcome donut; the pass-rate trend and the duration trend over the last runs (from `.eztest/history.json`); the duration distribution; the slowest tests; the top failure clusters; risk-weighted, requirements, API (`api.spec`) and UI coverage when the run has them; the execution timeline on parallel lanes. Every chart has a title, a text description and a data table, and a tooltip on hover and keyboard focus.

**Run context.** Environment, base URL, browsers and devices; CI system, pipeline, build number and link, release, branch, commit with its link, pull request, trigger and who ran it; EZTest and Node.js versions, machine, shard, start and end, time zone.

**Tests.** A tree of suites (from the journey folders, or from a runner-supplied suite path such as BDD feature and rule; group by tag, owner, browser or failure cluster instead), filters by state, full-text search (names, ids, tags, steps, errors, owners, test case ids), tag / owner / browser facets, sorting (failures first, slowest, risk, name). Every test has a permalink: `report.html#test/<id>`. Keyboard: `/` search, arrows to move, Enter to open, Left/Right to collapse or expand a group, Esc to close, `?` for the list.

**Each test.**

- Step timeline: every step with its status and duration, drawn where it ran within the test, nested blocks and sub-journeys indented. Each step row has a screenshot button (opens it in the lightbox) and, with a video, a play button that seeks the video to the step. Select a step for its post-conditions, locator, error and stack, diagnosis (expected / found, "did you mean", console errors and failed requests), API exchange (request and response, pretty-printed, masked), database query result (table, masked), heal, visual comparison, its screenshots, its DOM snapshot and its evidence.
- Screenshots: before / after the failing step in a compare slider (or side by side), a gallery, and a lightbox (Previous / Next, keyboard, fit to screen or actual size, so full-page screenshots scroll). A failed visual check shows the baseline and the actual image in the same slider, with the diff image as an overlay whose opacity you set.
- Video: the failing step's screenshot (else the last one) as the poster, step chapters that seek (embedded, so they work from `file://`), a marker for each step on a strip under the player with the failing step in red, "Jump to the failure", playback speed (0.25x to 2x), and a video picker when the test has several (one per attempt, actor or page). Without a video the panel says why: `video: off`, or `retain-on-failure` and the test passed.
- Trace: an "Open trace" button. It links to the time-travel trace in Studio (`report.studioUrl`; Studio must be running: `npx eztest studio`), gives the `eztest trace steps` command and the trace folder, and downloads the trace zip (`--trace`).
- DOM snapshots (`--time-travel`): inside the step, the page before and after the step as EZTest recorded it, in a sandboxed frame (scripts removed, no network access, the target outlined). Failing tests get every step; passing tests the after-snapshots while the size budget lasts (8 MB per report, snapshots over 900 KB are left out).
- Network (failed, errored and flaky tests): every request of the test as a waterfall: step, method, URL, status, type, size, time and a bar where it ran; expand a row for the timing phases and the request and response headers. Authorization, cookies, API keys and tokens in headers and URLs are masked. "Failed only" and a text filter.
- Console: every message with its time, level, step and source location; filter by level.
- Evidence vault: every evidence file of the test with a thumbnail (images), a name (step number and intent, and the kind: screenshot, DOM snapshot, aria snapshot, API exchange, network log, HAR, time-travel snapshot, trace, video, chapters, download, document, console log, accessibility findings, visual comparison, DB result, data), size, time, SHA-256, its position in the hash chain (`eztest evidence verify`), and Open / Download links. Filter by kind and step, search by name, id, file or hash. The links are relative to the run folder, so they work from the folder, from `file://` and after the folder is zipped and unzipped. The Evidence section has the same browser for the whole run.
- Healing: the old and the new locator, the tier, the confidence and whether the heal was verified, with its evidence. When healing tried and did not heal, the failing step lists what each tier found and why. T1 (fingerprint) can heal a step only after the step has passed once in the project, since it compares the element with the fingerprint learned then; in a project's first run, only T2 (semantic) can try, and it heals only above its threshold.
- Retries: each attempt's outcome and duration, and the steps whose outcome differs between attempts.
- Flakiness: the state from history and the recent outcomes as a sparkline; the flake cause when it passed only on retry.
- Triage: the probable cause with its confidence, the reasons and the cited evidence; second opinion; "needs human review".
- The data row (data-driven tests), the actors (multi-actor journeys), owners (CODEOWNERS), tags, requirements, the Azure DevOps test case, plan, suite and result, and the bugs filed for it.
- "Copy for bug": the title, steps, error, environment, data, probable cause, test case and permalink, ready to paste.

**Failure analysis.** Errors grouped by signature (normalised message and stack frames) with the number of tests, new or known (an earlier run in history failed the same way) and the run it was first seen in, the probable cause and the tests sharing it; clusters of similar failures (likely one root cause each); and a table of every failing and flaky test with its owners and bugs, for print and mail.

**Comparison.** This run against a baseline (`report.baseline`: the previous run in the output directory by default, `none`, or a run directory): newly failing, fixed, still failing, slower and faster (1.5 times and 500 ms apart), new and removed tests.

**Integrations.** Every integration EZTest has, linked:

- Azure DevOps: the test run (and whether publishing succeeded, partly succeeded or failed, and why), each test's test case, plan, suite and result, requirement work items, the bugs created or deduplicated, the pipeline build and release, the requirements commented on.
- The pull request, its summary comment and status (`eztest pr report`).
- Jira bugs.
- Slack and Teams messages sent.
- Git: repository, branch, commit; CODEOWNERS owners of the failing tests.
- The run on the EZTest results server (`--publish`).

Each publisher writes what it did into `integrations.json`, and the reports are rendered again with the links. With `ado.publishResults: true`, `eztest run` publishes the run to Azure Test Plans, re-renders the report with the test run, result, test case and bug links, and attaches that report (and the one-page summary) to the test run.

## Configuration

```yaml
report:
  name: Contoso Shop                 # header (default: package.json name, else the folder name)
  title: Shop web - regression       # report title (default: "<name> test report")
  logo: branding/logo.svg            # .svg/.png/.jpg/.gif/.webp under 512 KiB, embedded
  brandColor: "#0b5cad"              # header mark and accents (#rrggbb; the text on it stays readable)
  trendRuns: 20                      # runs in the trends
  baseline: previous                 # previous | none | <run directory>
  studioUrl: http://localhost:4400   # "open trace in Studio"
```

`eztest init` writes this section, commented, into a new project's `eztest.config.yaml`. The branch in the header is the CI branch when the run is in CI, else the checked-out branch (in a git worktree, the worktree's branch).

Azure DevOps links need `ado.organizationUrl` and `ado.project` (in Azure Pipelines they default to the pipeline's collection and project); Jira links use the `baseUrl` of the `jira` publisher.

## Commands

```bash
eztest report compare <baselineRunDir> <runDir> [-o compare.html] [--json cmp.json] [--fail-on-new-failures]
eztest report trends [-o eztest-trends.html] [--runs 50] [--branch main] [--json trends.json]
eztest report render <runDir>        # render again from report-model.json (after publishing elsewhere)
eztest report schema                 # the JSON Schema of report.json
```

`eztest report trends` is the cross-run portfolio dashboard: pass-rate and duration trends, readiness history, the flakiest, slowest and most failing tests, and a failure heat map by day and suite. It reads `.eztest/history.json` (and the run directories' report models for suite names).

## Chat cards

The `teams` publisher posts an Adaptive Card (1.5, full width): a header coloured by the verdict, the key figures, the change against the previous run, the environment, branch, commit and build, the top failures (each opening its permalink in the report) and buttons to the report, the Azure DevOps test run, the build and the pull request. The `slack` publisher posts the same summary as Block Kit. Give the report's URL with `reportUrl:` on the publisher; otherwise the results-server run is linked.

```yaml
publishers:
  - use: teams
    webhook: secret://env/TEAMS_WEBHOOK
    reportUrl: https://ci.example.com/artifacts/report.html
```

## report.json

`report.json` has `format: "eztest-report"` and `version: 2` (`$schema: "eztest:report/2"`; print the schema with `eztest report schema`, or import `REPORT_JSON_SCHEMA` from `eztest/report`):

- `run`: the run result (journeys, steps, evidence ids, environment), as in version 1;
- `insights`: triage, readiness, flaky scores, API coverage and heal proposals, as in version 1;
- `model`: the report model (`format: "eztest-report-model"`, `version: 2`): `kpis`, `previous`, `verdict`, `trend`, `slowest`, `failureGroups`, `clusters`, `coverage`, `comparison`, `integrations`, `context`, `browsers`, `evidence` and `tests`.

Each test in `model.tests` has `id`, `name`, `state` (`passed`, `healed`, `flaky`, `failed`, `error` or `skipped`, mutually exclusive), the journey's own `status`, `durationMs`, `startMs`, `tags`, `requirements`, `risk`, `attempt`, `browser`, `owners`, `file`, `suite` (outermost first), `error`, `failedStep`, `signature`, `cluster`, `failure` (`known`, `firstSeenRun`), `triage`, `history`, `flake`, `ado` (`testCases`, `plan`, `suite`, `results`, with links), `bugs`, `requirementLinks`, `row`, `actors`, `video`, `trace`, `attempts`, `network`, `console` and `steps`. Steps use short keys because a large run has hundreds of thousands of them: `n` intent, `s` status (`P` passed, `H` passed-healed, `F` failed, `S` skipped, `B` blocked), `d` duration ms, `t` start ms after the test started, `e` evidence ids, `x` error, `h` heal, `c` post-conditions, `l` locator, `a` actor, `i` iteration, `b` branch, `so` soft, `w` warnings, `dg` diagnosis, `db` query rows, `api` API exchanges, `im` locator suggestion, `m` manual verdict, `ch` child steps. `model.evidence` maps an evidence id to `[kind index into evidenceKinds, relative URL, description]`.

Readers of version 1 keep working: `run` and `insights` are unchanged.

## For runners: the suite tree

A runner that knows a richer hierarchy sets `JourneyResult.suitePath` (outermost first), for example `[{ kind: 'feature', name: 'Checkout' }, { kind: 'rule', name: 'Vouchers' }]`; the report then groups by it. Without it, the journey file's folders are the suites (a file with several journeys is a level of its own), and without a file the first tag is. Retried journeys carry `JourneyResult.attempts`, which the report compares.

## Size and speed

The static parts (summary, failure analysis, comparison, integrations, context) are plain HTML and SVG; tests are embedded once as JSON and the list renders only the rows in view. A synthetic run of 10,000 tests with 8 steps each gives a report of about 15 MB, rendered in about a second and interactive in a browser in about a second (`test/scale/report-perf.test.ts` holds the budget).

## Security

All dynamic content is escaped; the script builds the test details with DOM APIs and `textContent` only. The embedded model is JSON in a non-executable script element with `<`, `>`, `&` and line separators escaped. The page's Content Security Policy allows no network access; evidence is linked by relative path inside the run directory (absolute paths, schemes and `..` are refused), and links from integration records are rendered only when they are `http(s)`. API bodies, DB rows and notes are masked when they are recorded.
