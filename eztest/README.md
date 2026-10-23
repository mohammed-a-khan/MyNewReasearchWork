# EZTest

**One package for verified, end-to-end test automation.** Web UI, native Android and iOS apps, APIs, databases, PDFs and reports, logins with MFA, test data, accessibility, security, performance and release readiness, in a single npm package with a single command.

```bash
npm install eztest        # one package, everything included
npx eztest init           # config, example journey, readiness policy
npx eztest run            # run, heal, triage, report, decide
```

### Browsers

EZTest drives browsers with its own driver, so there is no other test tool to install:

- **Chrome, Edge, Chromium and Electron** over the Chrome DevTools Protocol (CDP).
- **Firefox** over WebDriver BiDi, the remote protocol built into Firefox.
- **No Safari/WebKit.**

EZTest uses an installed Google Chrome or Microsoft Edge (`channel: chrome` / `msedge`), or a browser it downloads itself:

```bash
npx eztest install-browsers            # Chrome for Testing, into ~/.cache/eztest/browsers
npx eztest install-browsers firefox    # Firefox from Mozilla, same cache
npx eztest doctor                      # which browsers were found, and how to install the missing ones
```

`EZTEST_CHROMIUM_PATH` / `EZTEST_FIREFOX_PATH` point at a specific binary, and `EZTEST_BROWSERS_PATH` moves the cache. The Docker image ([docs/operations.md](docs/operations.md)) ships with Chrome for Testing installed.

## Why EZTest

| What other tools do | What EZTest does |
|---|---|
| A framework layered on another tool's browser library | **Its own browser driver.** Chrome, Edge, Chromium and Electron over CDP, Firefox over WebDriver BiDi, with EZTest's own selector engine, auto-wait and tracing. EZTest depends on no other testing tool (no Playwright, Selenium, Puppeteer, WebdriverIO, Appium, Cypress), and a test (`test/legal/no-testing-tools.test.ts`) keeps it that way. |
| "Self-healing" quietly patches a broken locator | **Verified healing.** A heal counts only if the step's expected outcome still happens. Healed steps get their own status, `passed-healed`, and a reviewable proposal file. If the element is found but the outcome is wrong, the step fails as a **suspected regression** rather than being hidden. |
| Screenshots in a folder | **Evidence Vault.** Every artifact is hashed into a tamper-evident chain. `eztest evidence verify` proves nothing was changed. |
| PDF checks are a separate tool | **Document Assurance.** Compares a downloaded PDF against the values shown on screen and the database, field by field and line by line, and names which one is wrong (for example "document generation defect"). Also PDF-to-PDF diffs, bulk comparison with clustered differences, and PII checks. |
| Login code copied into every suite | **Identity Vault.** Roles with secrets kept as references, TOTP MFA, sessions reused safely and re-checked before use, OAuth tokens for API steps, passkeys through a virtual authenticator. |
| Shared test data that breaks parallel runs | **Test Data Fabric.** Journeys declare the data they need. EZTest finds, leases or creates it, and cleans up afterwards. |
| A red/green dashboard | **Triage and readiness.** Every failure is classified (product bug, test issue, environment, data, flaky) with cited evidence ids. A policy-as-code gate gives `GO`, `GO_WITH_RISKS` or `NO_GO` with reasons. |
| Separate tools for a11y, security, performance | **Lenses** run after every step (EZTest's own WCAG 2.2 accessibility engine, security headers and cookies, visual diff). **EZTest Load** is EZTest's own load-testing engine: journeys, recordings or HAR files become correlated user paths, run by protocol-level and browser-level virtual users on one machine or distributed agents, with monitors, SLAs and analysis ([docs/load.md](docs/load.md)). |
| Proprietary formats | Plain-English `.ez` files, YAML or JSON, all in your repo. Results in HTML, JSON and JUnit XML. Publishes to **Azure DevOps** Test Plans. |

EZTest uses no AI provider. Everything is deterministic and runs locally.

## Write tests in plain English

```text
Journey: Create an order and verify the invoice three ways
Tags: @smoke @orders
Risk: 5
Requirements: ORD-1

Log in as manager
Go to /orders/new
Select "Gadget (49.50)" from the Product dropdown
Fill the Quantity field with 3
Click the "Submit order" button
Expect the page to contain "created"
Capture the text of testid=order-number as orderNumber
Capture the text of testid=order-total as orderTotal
Download the "Download invoice" link as invoice
Compare document invoice to the order using invoice-vs-order
```

`Expect …` lines attach to the step before them as **post-conditions**, the outcome the step must produce. Post-conditions are what make healing verifiable. See [docs/ez-language.md](docs/ez-language.md) for all 359 action phrasings and 70 expectation phrasings (plus 73 packaged-app phrasings for SAP Fiori, ServiceNow, Workday, Oracle and Power Apps, which are active when their config block is present), including multi-actor journeys, relative and scoped targets ("the Edit button in the row containing Acme"), browser clock control, accessible-name and aria snapshot assertions, native mobile gestures and device operations, tabs and popups, frames, dialogs, keyboard and mouse gestures, network mocking, browser state, API/GraphQL/SOAP/WebSocket, databases, email/SMS, variables and flow control (If, loops, Retry, Try, sub-journeys, Examples tables).

## Commands

| Command | What it does |
|---|---|
| `eztest studio` | **EZTest Studio**: a local, offline IDE-style web UI. It has a journey editor with autocomplete, inline diagnostics and quick fixes, a visual step view, a command palette, and live runs with cancellation. It also covers results with a screenshot gallery, a dashboard, a Problems panel, recording, importing and flaky trends. See [docs/studio.md](docs/studio.md) |
| `eztest lsp --stdio` | The `.ez` **language server** for VS Code and other editors. It provides diagnostics with the closest phrasing, quick fixes and completion. It also gives hover docs, go to definition for `Run journey`, named queries, roles and variables, an outline, formatting and rename. The **VS Code extension** in `editors/vscode` adds highlighting, a Test Explorer with run and debug, and opening Studio. See [docs/vscode.md](docs/vscode.md) |
| `eztest init` | Scaffold `eztest.config.yaml`, an example journey and a readiness policy |
| `eztest run [paths] [-t tags] [--lens a11y] [--headed] [-w 4]` | Run journeys, heal, analyze, write reports; exit code 0 only if nothing failed |
| `eztest record <url> [-o journeys/x.ez] [--verify]` | Record a journey by using the app (Alt+Click to assert text); writes plain-English `.ez` and can replay it to prove it works |
| `eztest import <files> [-o journeys/imported] [--verify]` | Migrate tests from Cucumber, Playwright, Selenium (Java/C#/Python), Excel/CSV manual test cases, D365 RSAT Task Recorder, OpenAPI 3.x/Swagger 2 specs (`--kind openapi --role <role>`) and Postman v2 collections (`--postman-env env.json`); importer plugins add more formats (`--from <name>`, e.g. for a private framework; see [docs/plugins.md](docs/plugins.md#importer-plugins)); `--verify` replays them; nothing is dropped silently (TODO lines, coverage report and source-suite diagnostics) |
| `eztest validate [paths]` | Parse journeys and report errors with line numbers and suggestions |
| `eztest convert <file> --to ez\|yaml\|json` | Convert journeys between formats |
| `eztest analyze <runDir> [--policy]` | Re-run history, flaky scoring, triage, readiness and reports |
| `eztest report compare <a> <b>` / `eztest report trends` | This run against a baseline (newly failing, fixed, slower, new); the portfolio dashboard over many runs ([docs/reports.md](docs/reports.md)) |
| `eztest evidence verify <runDir>` | Verify the tamper-evident evidence chain |
| `eztest docs extract\|compare\|bulk\|check` | Document assurance from the command line |
| `eztest d365 snapshot` / `eztest d365 impact --before a.json --after b.json` | Dynamics 365: snapshot Dataverse metadata, list journeys a release wave breaks |
| `eztest salesforce snapshot\|impact\|permissions` | Salesforce Lightning: snapshot describe metadata, list journeys a release (Spring/Summer/Winter) breaks, check object/field/tab access per user |
| `eztest apps snapshot\|impact\|permissions <pack>` | Packaged-app packs (`sap`, `servicenow`, `workday`, `oracle`, `powerapps`): metadata snapshots, the journeys a change breaks, and role matrices. The changes covered are SAP transports, ServiceNow update sets and skipped upgrade records, Workday tenant previews and What's New, Oracle quarterly updates, and Power Apps app versions and Dataverse waves ([docs/apps/](docs/apps/servicenow.md)) |
| `eztest impact --mapping m.yaml --since origin/main` | Journeys affected by a change, and changed areas no journey covers |
| `eztest load run <scenario> [--agents N]` | Run a load test here or as the controller of distributed agents (`eztest load agent`); SLAs, report, readiness gate `load` ([docs/load.md](docs/load.md)) |
| `eztest load record <url>` · `load har <file>` · `load from-journey` · `load check` | Build correlated user paths from a browser recording, a HAR file, journeys or a run; replay them once to verify correlation |
| `eztest ado publish <runDir>` | Publish to Azure Test Plans: results with per-step action results and iterations, screenshots and traces on the failing step, the evidence pack, healed steps, build/release links, flaky marking, bugs linked to test cases and requirements ([docs/azure-devops.md](docs/azure-devops.md)) |
| `eztest ado import --plan P --suite S` / `--query <wiql>` | Import manual test cases (steps, expected results, shared steps, parameters) into `.ez` journeys; unknown steps become TODOs linked to the test case |
| `eztest ado sync [paths] [--dry-run\|--write]` | Create or update test cases from journeys with associated automation; writes `@TestCaseId` back (diff first) |
| `eztest ado suite --plan P --tag smoke` / `--query` · `ado configurations` · `ado requirements` | Suites by tag or query, test configurations, requirements by WIQL into traceability |
| `eztest ado gate <runDir>` · `ado summary` · `ado whoami` | The readiness gate for a pipeline stage, the pipeline results tab data, a credential check (PAT, `System.AccessToken`, Entra ID service principal, workload identity, managed identity) |
| `eztest pr report <runDir>` | "EZTest: GO / NO_GO" status or check with annotations on the failing journey lines, and one PR comment updated in place: Azure Repos, GitHub, GitLab, Bitbucket ([docs/git.md](docs/git.md)) |
| `eztest pr propose <files> --title …` | Branch + commit + pull request with CODEOWNERS reviewers, without touching your checkout |
| `eztest hooks install [--pre-push]` | Git hooks: validate and lint staged journeys; run the journeys a push impacts |
| `eztest bisect <journey> --good <sha> --bad <sha>` | Find the commit that broke a journey, in a separate git worktree |
| `eztest git promote` · `git owners <paths>` | Promote branch-scoped baselines and history after a merge; journey owners from CODEOWNERS |
| `eztest secret encrypt <value>` | Encrypt a value as `ENC(...)` for config files (key from `EZTEST_MASTER_KEY`) |
| `eztest totp <secret>` | Current TOTP code, for debugging MFA test users |
| `eztest trace list\|steps\|step\|snapshot\|network <runDir> <journey>` | Read time-travel traces from the terminal, CI logs or a coding agent: steps with status and timings, one step's locators, heals and checks, a DOM snapshot as self-contained HTML (`--before`/`--after`, `-o`), network requests; `--json` for scripting |
| `eztest visual branches` / `eztest visual merge <branch>` | Visual baselines per git branch: list them, and merge a branch's approved baselines into the main set (recorded in the approvals vault) |
| `eztest monitor [--interval 300] [--webhook url]` | Run `@monitor` journeys against a live environment on a schedule, alert on changes, write a status page |
| `eztest keys generate` | Create an ed25519 signing key pair for evidence packs |
| `eztest evidence pack <runDir> --key k.pem --signer "Name" [--profile csa-part11\|sox]` | Signed, tamper-evident compliance pack (ZIP) with a traceability table |
| `eztest evidence verify-pack <zip> --pub k.pub.pem` | Verify the signature, every file hash and the evidence chain |
| `eztest mock record\|replay --store m.json [--target url] [--faults f.yaml]` | Record and replay HTTP services, inject latency, errors and dropped connections |
| `eztest mock drift --store m.json --target url` | Detect when recorded mocks no longer match the real service |
| `eztest mock from-openapi spec.yaml [--seed 42] [--store m.json]` | Serve a mock generated from an OpenAPI spec (examples or seeded data; invalid requests get 400 naming the rule) |
| `eztest mock grpc --proto x.proto --responses r.yaml` | Serve a gRPC mock from proto files and declarative responses |
| `eztest contracts lint\|coverage` | OpenAPI governance rules and the API coverage of a run (operations, status codes, parameters) ([docs/api-contracts.md](docs/api-contracts.md)) |
| `eztest contracts publish\|verify\|can-release\|record-release\|from-mocks` | EZTest contracts: publish contract files to the results server, verify a running provider (provider states as data hooks) and record the results, ask whether a version can be released to an environment; results feed the `contracts` readiness gate |
| `eztest api-scan [scan.yaml] --spec <spec> --yes [--readiness <runDir>]` | Deterministic API security scan pack (OWASP API Top 10): auth bypass, BOLA/IDOR, mass assignment, injection (safe payloads), rate limits, headers, CORS, verbose errors; safe by default (allow-listed non-production hosts, opt-in) and an `apiSecurity` readiness gate ([docs/api-security.md](docs/api-security.md)) |
| `eztest sessions import <files> [--against journeys]` / `eztest sessions snippet` | Turn captured user sessions (EZTest capture, HAR, rrweb JSON) into ranked `.ez` journeys with a coverage gap; the opt-in, privacy-safe capture snippet ([docs/sessions.md](docs/sessions.md)) |
| `eztest stories [run\|list] --stories <globs>` | Run journeys against single component stories on EZTest's own harness, with the visual and a11y lenses ([docs/components.md](docs/components.md)) |
| `eztest init --ci github\|azure` | Also add a CI pipeline |
| `eztest mobile devices\|build-agent\|install-agent\|inspect` | Native mobile: list Android/iOS devices, build and install the EZTest device agents, dump a screen's hierarchy and screenshot ([docs/mobile.md](docs/mobile.md)) |
| `eztest doctor [--project p] [--env e] [--json]` | Check Node, browsers, config, databases, plugins and the results server; `--json` for machine-readable health |
| `eztest run --shard 2/4` / `eztest merge <shard runs> -o merged` | Duration-balanced shards across machines, merged into one run whose evidence chain links every shard chain ([docs/scale.md](docs/scale.md)) |
| `eztest run --changed-since origin/main \| --last-failed \| --risk 4 \| --budget 15m` | Select journeys by change impact, earlier failures, risk or a time budget (highest risk per minute), with an explanation of every decision |
| `eztest run --failed-first --shuffle [seed] --repeat-each 5 --burn-in --max-failures 3 --retry-strategy isolated --fail-on-flaky --watch` | Ordering, burn-in, fail-fast, isolated retries, flakiness gates and watch mode |
| `eztest ci matrix --shards auto` | A GitHub Actions / Azure DevOps matrix sized from historical durations |
| `eztest server` | Optional results server for teams: dashboards, shared heal decisions and quarantine, locks, OIDC + RBAC, hash-chained audit log, retention ([docs/server.md](docs/server.md)) |
| `eztest publish <runDir> [--dry-run]` | Publish to the results server and to Slack, Teams, Jira or plugin publishers ([docs/plugins.md](docs/plugins.md)) |
| `eztest jira requirements --jql "..."` | Requirements from Jira that no journey covers |
| `eztest trends [-o trends.csv]` | Run trends from history as CSV |
| `eztest upgrade-config [--dry-run]` | Migrate `eztest.config.*` to the current `configVersion` ([docs/versioning.md](docs/versioning.md)) |

## Use it from code

```ts
import { runEzTest, parseEzScript, docs } from 'eztest';

const { run, analysis } = await runEzTest({ cwd: process.cwd() });
console.log(run.summary, analysis?.readiness?.decision);

const doc = await docs.extractPdf('invoice.pdf', { template: 'fields: [{ name: total, label: Total }]' });
```

Every module is available as a namespace (`docs`, `insights`, `identity`, `data`, `surfaces`, `perf`, `lenses`, `ado`, …) and as a subpath import (`eztest/docs`).

### Code journeys (`eztest/sdk`)

When a journey needs loops over query rows, `switch`, date math or file round trips, write it in TypeScript:

```ts
// journeys/orders.journey.ts
import { journey, step, expect } from 'eztest/sdk';
import { NewOrder, Order } from '../screens/shop.js';

journey('Order for every EU customer', { tags: ['@orders'] }, async ({ ui, db }) => {
  for (const c of await db.query<{ name: string }>('CUSTOMERS_BY_REGION', { region: 'EU' })) {
    await step(`Order for ${c.name}`, async () => {
      await ui.open('/orders/new');
      await ui.select(NewOrder.customer, c.name);
      await ui.click(NewOrder.submit, { expect: { text: 'created' } });
      await expect.ui.text(Order.customer).toBe(c.name);
    });
  }
});
```

What you get with code journeys:

- **One runner path.** Every `ui.*` call goes through the same runner as an `.ez` step: strict locating, verified healing, post-conditions, evidence, trace and debugger.
- **Discovery.** `*.journey.ts` files are discovered by `eztest run`.
- **Same treatment as `.ez`.** Tags, grep, retries, quarantine, readiness and Azure DevOps handle them like `.ez` journeys.
- **Interop both ways.**
  - `.ez` calls code with `Run code "steps/billing.steps.ts#orderTotals" with region="EU" as totals`.
  - Code calls `.ez` with `run('login-as', { user: 'bob' })`.
- **Studio support.** The Studio edits them with TypeScript highlighting and SDK autocomplete, and debugs them with line breakpoints.

Importer plugins can write logic that `.ez` cannot express as SDK code. See [docs/sdk.md](docs/sdk.md).

## What's inside

| Area | Capabilities |
|---|---|
| Authoring | `.ez` plain-English grammar, YAML/JSON journeys, round-trip conversion |
| Runner | Chrome, Edge, Chromium and Electron (CDP) and Firefox (WebDriver BiDi) on EZTest's own browser driver, `eztest/browser` ([docs/browser-driver.md](docs/browser-driver.md)); Safari/WebKit is not supported; strict locators, all actions and post-conditions, retries, parallel journeys, traces, downloads, run ledger |
| Native mobile | `Platform: android\|ios` journeys on EZTest's own drivers: an ADB client (smart-socket protocol) plus the EZTest Android agent (androidx.test.uiautomator), and the EZTest iOS XCTest agent over usbmuxd; taps, typing, gestures (swipe-until, long press, pinch, drag), app lifecycle, deep links, permissions, connectivity, files, hybrid web views over the DevTools socket, verified healing over the page source, screenshots and page-source evidence, native time-travel traces and a Studio Device tab ([docs/mobile.md](docs/mobile.md)) |
| Pages and frames | Tabs, windows and popups (open, follow, switch by number/title/URL, close, count), nested iframes by name/id/title/URL/selector with frame blocks; evidence, conditions and healing follow the current tab and frame |
| Dialogs | Accept, dismiss or answer the next alert/confirm/prompt/beforeunload, expect and capture dialog text; unexpected dialogs are recorded, handled by policy and never hang a run |
| Input | Key combos with platform-aware `Mod`, hold/release, slow typing, full named-key set; right/middle/modifier/offset/triple clicks, mouse down/up/move/wheel, drag and drop (mouse and HTML5 DataTransfer fallback), drag-to-upload, scrolling incl. infinite lists, focus/blur, touch tap and swipe |
| Events and DOM | Dispatch DOM/custom events, wait for events; console, page-error, request/response and WebSocket capture and assertions; declarative DOM queries (attribute, property, CSS, box, count, texts, tables as records); states, classes, regex, count comparisons, sort order, soft assertions; shadow DOM piercing |
| Network and browser state | Mock/stub/delay/block routes, request headers, offline, throttling, masked HAR recording and replay; cookies, local/session storage, permissions, geolocation, timezone, locale, color scheme, reduced motion, devices, viewport, clipboard, basic auth, extra headers, user agent |
| Flow control and reuse | If/Otherwise, Repeat, For each (lists, CSV, JSON, Excel), While with a cap, Retry, Try/On failure, groups, sub-journeys with params and return values, hooks, Examples tables; a safe expression language (no eval) for variables, dates and conditions; nested results in reports |
| Page scripts | Opt-in (`security.allowPageScripts`) inline or file scripts run in the browser page with captured results; never evaluated in Node |
| Email and SMS | Built-in SMTP sink, Twilio SMS; extract links and one-time codes and continue the journey |
| API contracts | OpenAPI 3.0/3.1 and Swagger 2 validation of every API step (`api.spec`), spec lint rules, API coverage in reports, Studio and the `apiCoverage` readiness gate, spec-driven mocks, EZTest contracts (consumer journeys record them, provider verification with data-hook provider states, publish and can-release through the results server) ([docs/api-contracts.md](docs/api-contracts.md)) |
| Messaging and integration | Kafka, RabbitMQ (AMQP 0-9-1), MQTT 3.1.1/5 and IBM MQ (REST messaging API) steps: publish, listen, filtered waits with JSONPath/header/correlation id, schema checks, expect-none; gRPC calls and mocks; SFTP and folder file drops; allow-listed SSH commands and batch jobs; X12/EDIFACT parsing; phone-call (voice) verification with DTMF and spoken-code checks through a provider (Twilio) or a local mock ([docs/messaging.md](docs/messaging.md)). Client libraries are optional peers loaded on first use |
| Healing | T0 cache → T1 element fingerprint → T2 semantic match; verified by post-conditions; heal proposals |
| Identity | TOTP (RFC 6238), secret handles, env/file/Azure Key Vault stores, OAuth2 client credentials, form + MFA login, verified session reuse, passkeys |
| Data | Declared data needs, leases for parallel safety, cleanup, SQL/API/synthetic providers (seeded), deterministic masking |
| Surfaces | REST client (safe retries), JSONPath, JSON Schema (ajv), GraphQL, SOAP 1.1/1.2, WebSocket, SQLite/Postgres/SQL Server, typed row comparison; all as plain-English steps (form, multipart, file bodies, retry-until, response time, bound SQL parameters, stored procedures, query polling, query-vs-UI comparison) |
| Documents | PDF text-layer extraction, field and table templates, normalization, key-based reconciliation with tolerances, coverage/footing gates, three-way ledger, PDF diff, bulk clustering, PII/masking checks |
| Insights | History, flip-based flaky scoring, failure clustering, rule-based triage with cited evidence, readiness policy, change impact |
| Reports | A self-contained, accessible, executive-ready HTML report (readiness verdict, key figures against the previous run, trend, duration, failure-cluster and coverage charts, a test tree with search, facets and permalinks, step timelines, screenshots with before/after, video chapters, API/DB detail, heal diffs, retries, triage, failure analysis by signature, comparison with a baseline), linked to Azure DevOps (test run, results, test cases, bugs, build, PR), Jira, Slack/Teams, git/CODEOWNERS and the results server; a one-page PDF-ready summary, versioned JSON, JUnit XML and CSV; `eztest report compare` and the cross-run `eztest report trends` dashboard ([docs/reports.md](docs/reports.md)) |
| Performance | Web Vitals (LCP, CLS, INP, FCP, TTFB), budgets, and **EZTest Load**: HTTP/1.1 + HTTP/2, WebSocket, SSE, gRPC, SQL, messaging and browser-level virtual users, closed and open models, coordinated-omission-safe HDR histograms, automatic correlation (ASP.NET, JSF, Salesforce, Dynamics 365, SAP), network emulation, distributed agents, host/JVM/database monitors, SLAs, knee and saturation analysis, baselines and trends ([docs/load.md](docs/load.md)) |
| Lenses | Accessibility (EZTest's own engine: 79 rules written from WCAG 2.2, WAI-ARIA 1.2, HTML-AAM and accname 1.2, with keyboard, reflow and text-spacing checks and a `Check accessibility` step; [docs/accessibility.md](docs/accessibility.md)), visual diff with masks, security headers and cookies, authorization matrix, IDOR probe |
| Visual | Element and page assertions (`Expect the Header to look like the baseline`) in strict, ignore-colors, layout and content modes with anti-alias tolerance. Differences are **grouped by the DOM change behind them**, so one CSS change is one finding. Baselines are keyed per browser (and version) and viewport, several viewports can be checked in one step, dynamic content is masked by selector, and baselines branch per git branch. Studio approves a whole group at once ([details](docs/ez-language.md#visual-assertions-element-or-page-against-a-baseline)) |
| ALM | Azure DevOps (Services and Server): PAT, `System.AccessToken`, Entra ID service principal and workload identity federation, managed identity; Test Plans import and sync (associated automation), suites, configurations, step results and iterations, attachments, flaky marking; Boards links, requirement comments, area/iteration mapping; Repos PR status and comments; a pipeline task with the readiness gate and a results tab; Jira (deduplicated bugs with evidence, JQL requirements), Slack and Teams publishers ([docs/azure-devops.md](docs/azure-devops.md)) |
| Git | Studio Source Control (status, word diffs, stage, commit, branches, pull/push, history and blame per step, conflict resolution), branch-aware runs, history and baselines, CODEOWNERS, hooks, bisect, PR status and comments on GitHub, GitLab, Bitbucket and Azure Repos ([docs/git.md](docs/git.md)) |
| Scale | Duration-balanced sharding and merge, resource locks across machines, test selection and budgets, burn-in and fail-fast flags, CI matrix generation, virtualised reports for thousands of journeys ([docs/scale.md](docs/scale.md)) |
| Team server | Results server with dashboards, shared state, OIDC/PKCE sign-in, per-project RBAC, audit log and retention ([docs/server.md](docs/server.md)) |
| Extensibility | Typed plugin API (`eztest/plugins`) with an API version check ([docs/plugins.md](docs/plugins.md)) |
| Operations | Docker image and compose example, `doctor --json`, JSON logs, OpenTelemetry traces, config schema versioning ([docs/operations.md](docs/operations.md)) |
| Dynamics 365 | Metadata-aware steps (`Set "Account Name" to "Contoso" on the form`, lookups, save, process stages, views), Dataverse Web API cross-checks, release-wave impact analysis |
| Desktop and legacy | One journey language over a driver ladder: Electron (own CDP), Windows UI Automation and Java Swing through EZTest's own agents, SAP GUI Scripting (own bridge; VA01-style status-bar capture), TypeScript TN3270 and TN5250 clients (labels, row/column, AID/function keys, IBM Z TSO and IBM i sign-on, shared phrasings), and an image + OCR rung for Citrix/VDI and canvas (NCC template matching across DPI scales, tesseract.js, own VNC client); fingerprint healing verified by post-conditions, screen evidence with match boxes. See [docs/desktop-and-legacy.md](docs/desktop-and-legacy.md) |
| Salesforce | Lightning steps that see through shadow DOM (`Set Salesforce field "Industry" to "Energy"`, picklists and dependent picklists, strict lookups, path stages, toasts, validation errors, list views, related lists), SOQL cross-checks through a metadata-validated builder (no string-built queries), permission matrix per user via API and UI, release impact analysis |
| Packaged apps | Each pack has a role and permission matrix. **SAP Fiori/UI5**: OData-aware Smart Fields resolved through the page's UI5 bindings, value helps and the message popover; OData V2/V4 cross-checks; transport impact for Fiori and SAP GUI journeys. **ServiceNow**: UI16 forms by dictionary label, UI actions, related lists and Service Portal catalog variables; Table API cross-checks; update-set and skipped-upgrade impact. **Workday**: prompts, the date widget, related actions and the business process inbox; WQL, REST and SOAP cross-checks; tenant-preview impact. **Oracle**: Fusion Redwood LOVs and tables, EBS OA Framework LOVs; Fusion REST cross-checks; quarterly-update impact. **Power Apps canvas**: controls by name through the player's object model, galleries and Power Fx assertions; Dataverse cross-checks through the D365 add-on; app-version impact. These packs are tested against emulations of each product, not real tenants. See [docs/apps/sap.md](docs/apps/sap.md), [servicenow](docs/apps/servicenow.md), [workday](docs/apps/workday.md), [oracle](docs/apps/oracle.md) and [powerapps](docs/apps/powerapps.md) |
| Components | Library-aware widget steps that work whatever renders the widget: virtualized and paged data grids (`In the Orders grid, click the row where Customer is "Contoso"`, edit, sort, filter, select, read all rows), combo boxes with async popups, locale-aware date pickers, trees, tabs, accordions, stacked dialogs, toasts, rich text (TinyMCE iframe, Quill, CKEditor), sliders, masked inputs, drop zones, canvas charts, infinite lists. Adapters for ag-Grid, MUI, Kendo, DevExtreme, PrimeNG/PrimeFaces, Angular Material, Oracle JET, SAP UI5 and WAI-ARIA; also a function API (`eztest/components`). See [docs/components.md](docs/components.md) |
| Migration | Importers with replay verification and a coverage-equivalence report |
| Monitoring | Production-safe scheduled journeys, flap-guarded alerts, uptime and latency, status page |
| Compliance | ed25519-signed evidence packs (generic, CSA/Part 11, SOX profiles) with requirement traceability |
| Service virtualization | Record/replay mock servers, fault injection, drift detection |

## Try it on the demo app

```bash
npm run demo                          # EZ Shop on http://127.0.0.1:4600
cd examples/shop-project
export SHOP_ALICE_PASSWORD='Wonderland#1' SHOP_ALICE_TOTP=JBSWY3DPEHPK3PXP \
       SHOP_BOB_PASSWORD='Builder#2' SHOP_API_CLIENT_SECRET=ez-client-secret
npx eztest run
```

Restart the demo app with `DEMO_BUG=invoice-total` to watch EZTest catch a document defect three ways. Restart it with `DEMO_VARIANT=b` to watch verified healing.

## Run from a clone (Windows, macOS, Linux)

```bash
cd eztest
npm install                    # once
npm run build                  # once, and after pulling changes
npx eztest install-browsers    # once, if Chrome is not installed
npx eztest studio              # or: node dist/cli/bin.js studio
```

To type `eztest` without `npx` from any folder, run `npm link` once in `eztest/` (on Windows, open the terminal as the same user that installed Node.js).

## Develop

```bash
npm install
npm test            # 3000+ tests, incl. real Chromium against the demo app
npm run test:firefox               # the same suite on Firefox (EZTEST_BROWSER=firefox npm test)
npm test -- test/core -t "parses"  # files whose path contains test/core, tests whose name matches
npm run test:ci                    # also writes JUnit XML (eztest-results/testkit-junit.xml) for Azure DevOps
npm run typecheck
npm run build       # compiles to dist/
```

Requires Node.js 20.11+. Run `eztest install-browsers` (Chrome for Testing) or `eztest install-browsers firefox` once if no browser is installed.

The tests run on EZTest's own test runner, the testkit in `tools/testkit` (a development tool of this repository, not shipped): each test file runs in its own worker process, TypeScript is compiled with esbuild through a Node module hook, and `expect`, mocks and spies are its own. Options: `npm test -- --help` (`--workers`, `-t`, `--reporter default|verbose|dot|junit`, `--retry`, `--bail`, `--timeout`). The suite's settings are in `testkit.config.mjs`.

EZTest is original code. The open-source packages it builds on, and their licenses, are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). None of them is a testing tool, and neither is any development dependency: EZTest's own tests run on its own runner (`tools/testkit`).

More: [Configuration](docs/configuration.md) · [Databases](docs/databases.md) · [The .ez language](docs/ez-language.md) · [Accessibility](docs/accessibility.md) · [Architecture](docs/architecture.md) · [Studio](docs/studio.md) · [Code journeys (SDK)](docs/sdk.md) · [Multi-actor journeys](docs/multi-actor.md) · [Browser driver, cross-browser runs and remote browsers](docs/browser-driver.md) · [Mobile](docs/mobile.md) · [VS Code and the language server](docs/vscode.md) · [Components](docs/components.md) · [Desktop and legacy apps](docs/desktop-and-legacy.md) · [Packaged apps: SAP Fiori](docs/apps/sap.md), [ServiceNow](docs/apps/servicenow.md), [Workday](docs/apps/workday.md), [Oracle](docs/apps/oracle.md), [Power Apps](docs/apps/powerapps.md) · [Azure DevOps](docs/azure-devops.md) · [Git](docs/git.md) · [Journeys from sessions](docs/sessions.md) · [API security scans](docs/api-security.md)
