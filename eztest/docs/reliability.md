# Reliability

EZTest's defences against the problems that make enterprise suites flaky,
slow and hard to diagnose. Each one fixes a root cause instead of adding
retries, records what it did as evidence, and is covered by tests against
pages of the demo app that misbehave on purpose (`examples/demo-app/reliability.ts`,
served under `/rel`).

| Problem | What EZTest does | Config / syntax |
|---|---|---|
| Element covered by a spinner, cookie banner, toast or modal | Waits for it to go; if it stays, the error names it | `reliability.actionability` (on) |
| Element moving or animating | Waits until its box is stable and finite animations have ended | `reliability.actionability` |
| Clicks lost before the SPA has hydrated, captures of "Loading..." | Optional "app idle" wait: pending fetch/XHR, Angular, AngularJS, jQuery, `aria-busy`, an app hook | `reliability.appIdle` (off) |
| SPA re-render wipes typed values or replaces elements | Verifies fill/select survived, re-types into the re-rendered field; re-resolves detached targets once | `reliability.verifyFill`, `reliability.reresolve` (on) |
| "It passed on retry" with no explanation | Flake classifier records *why* (timing, overlay, detached, network, data, environment) | automatic with `retries` |
| Hard sleeps, fragile XPath, unchecked state changes, plain-text secrets | `eztest lint` with fixes, SARIF for CI | `lint:` |
| XPath with quotes in values | `concat()` literals wherever a value goes into an XPath | automatic |
| Weak locators | Locator quality score; verified "improvement" proposals in the heal inbox | `reliability.suggestLocators` (on) |
| Parallel workers sharing one user; sessions expiring; account lockouts | Account pools, sessions refreshed before expiry, lockout protection, mid-journey re-login | `identity.pools`, `identity.lockout`, `reliability.sessionExpiry` |
| Data missing, used up or left behind | `Requires:` preconditions, durable cleanup journal + orphan sweep, `unique()` | `Requires:`, `reliability.orphanSweep` |
| Cross-feature state | `Depends on:` with explicit ledger handoff | `Depends on:` |
| Environment down | Pre-flight health checks, environment classification, circuit breaker | `healthChecks:`, `reliability.circuitBreaker` |
| Slow failure analysis | Diagnosis: expected/found, candidate counts, "did you mean", outlined screenshot, console and network errors | `diagnose` (on) |
| Tool overhead | `--fast`, `--reuse-context` | CLI |
| Locale, time zone, RTL | Locale-aware assertions, pinned time zone, layout direction | `locale:`, `timezone:` |

## 1. Flakiness root causes

### Actionability

Before every pointer action (click, double-click, check, hover, download) and
every input action (fill, clear, select, press) the runner probes the target in
the page: attached, visible, enabled, same bounding box across an animation
frame, no finite CSS/Web animation running on it or an ancestor, and, for
pointer actions, the element at its center is the element itself (or its
label). It polls until all hold. When the step timeout passes:

- an element still covered by something that looks like an overlay (fixed
  layer, dialog, `aria-modal`, backdrop/spinner/cookie/toast classes) fails with
  the overlay named:
  `the "Save" button is covered by <div#cookie-banner.overlay.cookie-consent role=dialog> "Cookie consent" (an overlay); the click would land on it - waited 3023 ms`;
- a disabled or hidden element fails with that reason;
- for animations, instability and decorative covering elements, the driver's own
  checks make the final call.

Every wait longer than a few milliseconds is recorded on the step
(`StepResult.reliability.waits`: cause, ms, detail), so a pass that only
worked because the runner waited out an overlay is visible.

`reliability.slowMo` (ms) pauses before every action. It is for watching a run;
it never fixes timing and the lint/doc say so.

### App idle (opt-in)

`reliability.appIdle: true` (or `{ timeoutMs, quietMs, ignoreUrls }`) installs
an init script that counts pending `fetch()` and `XMLHttpRequest` calls in
every page and frame, and before each action waits until:

- no request is pending and the network has been quiet for `quietMs` (50 ms),
- `getAllAngularTestabilities()` are stable (Angular), `$http.pendingRequests`
  is empty (AngularJS), `jQuery.active` is 0,
- `window.__EZTEST_BUSY__` (a boolean or function the app may expose) is not true,
- `<html>`/`<body>` are not `aria-busy="true"` and `document.readyState` is complete.

React and Vue have no public quiescence API, so for them the request counter
(and the optional app hook) is the signal. Long-polling or analytics calls go in
`ignoreUrls`. Reaching `timeoutMs` (10 s) is not an error: the step goes ahead
and the wait is recorded with cause `network`.

### Clicks the page did not see yet

A server-rendered page shows its buttons before its scripts wire them; a click then does nothing. A click
that must have an effect (it has post-conditions, or opens a tab) is watched: when nothing at all happens
within 2 s (no change in the element's document, no navigation, request, new tab, dialog or download) and
its post-conditions do not already hold, it is clicked once more and the log says so. Checkboxes, radio
buttons, switches, selects, labels and file inputs are never clicked twice. The same goes for a click whose
handler threw an error in the page's own script while its post-conditions still fail 2 s later. A
`Download ...` step whose click started no download within 5 s clicks once more.

### Ads and consent walls in front of the page

Google's full-screen "vignette" ad (shown after a link click, the address ending in `#google_vignette`)
and Google's consent dialog (Funding Choices) are closed before each action and while post-conditions
are polled, with a line in the log; the link then goes where it was going. The recorder ignores what is
done inside ad frames. An app's own dialogs and banners are never dismissed automatically: they are part
of what is tested.

### Re-render safety

- **Lost values.** After `fill` and `select` the runner waits for the app to
  settle (with app idle on) and checks the value is still there. A
  re-rendered field is resolved again and typed into again (once), recorded as
  `recovered: { cause: 'detached', detail: '... lost its value after a re-render ...' }`.
  Input masks that reformat the value are not treated as a re-render.
- **Detached elements.** When an action fails with "element is not attached",
  the target is resolved again with the same strict candidates and the action
  is retried once.

### Flake classifier

With `retries`, when an attempt fails and a later one passes, the runner
classifies the failed attempt (`JourneyResult.reliability.flake`):

| Cause | Evidence used |
|---|---|
| `overlay` | the step had to wait for / was blocked by an overlay; "covered by", "intercepts pointer events" |
| `detached` | a recovery (re-resolve, re-type); "not attached", "detached" |
| `network` | the page or a gateway returned 5xx, network-level failures, DNS |
| `data` | a failed `Requires:`/data need; constraint violations; "already exists" |
| `timing` | timeouts, post-conditions that did not hold in time, animations |
| `environment` | session expiry and other environment signals |
| `unknown` | nothing matched (the evidence is still stored) |

The record (`flake-cause.json`, cited by id) lists every failed attempt's
failing steps, errors and reliability records. History stores the cause with
the outcome; flaky scoring folds retried passes in (a journey that passed only
on retry twice in the window is `flaky` even if every final status was a pass)
and names the dominant **root cause** with advice. The Quality Center's Flaky
page shows it under the state badge (`cause: overlay (67% of 3)`).

## 2. Lint: `eztest lint`

```
eztest lint [paths...] [--format text|json|sarif|junit] [-o file] [--max-warnings N] [--translated] [--rule name=severity] [--project app]
```

Lints journeys (`.ez`, `.yaml`, `.json`), Gherkin features, code (`.ts`, `.js`,
`.java`, `.py`, `.cs`, `.kt`), test data (CSV, TSV, XLSX, JSON), the config
layers and `.env.example`. Every finding has a file, line, rule, message, a fix
suggestion and the section of the [EZTest Project Guide](project-guide.md#lint-rules)
that explains the rule. Exit code 1 on errors (or more warnings than
`--max-warnings` / `lint.maxWarnings`), so it runs in CI; `--format sarif -o
lint.sarif` feeds GitHub / Azure DevOps code scanning and `--format junit` gives
the CI's test view one test case per file. Without paths it lints the journeys
folder, the feature folders, and `shared/`, `config/`, `eztest.config.*` and
`.env.example` when they exist. Step definitions and code are read as text,
never executed.

| Rule | Default | Finds |
|---|---|---|
| `hard-wait` | warning | `Wait 3 seconds`, `Pause for 500 ms`; `waitForTimeout`, `Thread.sleep`, `time.sleep`, `cy.wait(ms)`, a Promise around `setTimeout` |
| `absolute-xpath` | warning | `/html/body/div[2]/...` |
| `positional-xpath` | warning | `[3]`, `position()`, `last()` |
| `text-only-locator` | warning | targets found only by visible text, when the UI is translated (`--translated`, `lint.translatedUi`, or a journey with `Locale:`) |
| `raw-selector` | warning | targets found only by CSS or XPath, with no name, label or test id |
| `repeated-selector` | warning | one raw selector (`css=`, `xpath=`, `testid=`) written in several steps instead of one element entry (only selectors written in the journey; not the ones EZTest builds from plain English) |
| `missing-postcondition` | warning | Save/Submit/Delete/Pay/Sign in/Search... clicks, link clicks, Enter in a field, non-GET API calls and INSERT/UPDATE/DELETE with nothing checked after them |
| `no-assertion` | warning | a journey that checks nothing |
| `plaintext-secret` | error | secret-named variables, fields, data columns and config keys with literal values, typed passwords, JWTs, AWS/GitHub/Slack tokens, private keys, credentials in URLs, values in `.env.example` (values are redacted in the report) |
| `weak-locator` | info | targets whose best candidate scores below 40 |
| `unsafe-xpath-quotes` | error | `\'` "escaping" (not valid XPath 1.0) and values pasted inside XPath quotes in code |
| `missing-tags`, `missing-id` | warning | journeys, scenarios and code journeys without tags or an explicit id |
| `duplicate-id` | error | two journeys with one id, across folders and styles |
| `undefined-step`, `ambiguous-step` | error | Gherkin steps that no definition (and no EZTest phrasing) matches, or that several match; each project's features against that project's `bdd.steps` |
| `undeclared-dependency` | warning | a journey using `${value}` that only another journey captures, without `Depends on:` |
| `hardcoded-host` | warning | absolute URLs in steps, `Base URL:` headers, feature steps and `ui.open()` / `api.*()` calls |
| `outside-layout` | warning | test files outside the [project layout](project-guide.md#the-project-layout), in projects with an `apps/` folder |

Config:

```yaml
lint:
  translatedUi: true
  maxWarnings: 0
  rules: { hard-wait: error, weak-locator: off, outside-layout: off }
```

The Studio editor shows the same findings as warnings while you type
(`/api/validate` returns `lint` and `locatorScores`).

## 3. Locators

### Quality score

`scoreLocator` / `scoreTarget` (`@eztech.com/eztest/lint`) rate a locator 0-100:
test id 95, role + accessible name 90, label 85, placeholder/alt 70, title 62,
CSS id 78, visible text 55, CSS classes 45, structural CSS 18, XPath by test id
88 / id 72 / text 45, positional XPath at most 20, absolute XPath under 10.
Generated-looking values (`ember123`, `ctl00_`, `:r5:`, `j_idt42`, hashed CSS
classes, long numbers) cost 30-40 points. A target scores by its best candidate
plus up to 5 for fallbacks. Grades: robust ≥ 85, good ≥ 70, fair ≥ 50, weak ≥ 30, fragile.

### Improvement proposals

When a step's target scores below 70 and the element's fingerprint offers a
candidate at least 15 points better (test id, role + name, label, placeholder,
alt, title), the runner checks it on the live page *before acting*: it must
match exactly one element and be the same element. If the step then passes, the
result carries `improvement: { suggested, score, currentScore, reason }`; the
run's `heal-proposals.json` lists it under `improvements`; the Studio heal
inbox shows it as kind **Improvement** with both scores. Accepting writes it
into the journey (diff first, hash-checked); rejecting records a decision with
tier `improvement`. Nothing is applied without review.

### XPath literals

XPath 1.0 has no escape character. Every value EZTest puts into an XPath
(`${var}` in `xpath=` candidates, `<column>` Examples placeholders) is placed as
a literal: `'text'`, `"it's"`, or `concat('Bob', "'", 's "best" deal')` when it
contains both quote kinds. `xpathLiteral()` is exported for custom steps.

## 4. Authentication at scale

```yaml
identity:
  sessionMaxAgeMinutes: 30
  sessionRefreshMarginMinutes: 5        # refresh a cached session 5 min before it expires
  roles:
    manager: { username: x, password: secret://env/MGR, loginUrl: /login, successUrl: /dashboard, verifyUrl: /dashboard }
  pools:
    manager:
      waitSeconds: 60
      accounts:
        - { username: mgr1, password: secret://env/MGR1 }
        - { username: mgr2, password: secret://env/MGR2 }
  lockout: { maxFailures: 3, windowMinutes: 30, backoffMs: 2000 }
reliability:
  sessionExpiry: { text: ["Your session has expired"], statuses: [401, 440] }   # role login pages are added automatically
```

- **Account pools.** Each pooled account is a vault role of its own
  (`manager#1`, `manager#2`) with its own cached session. A journey that logs in
  as `manager` leases one account through the data fabric's lease registry
  (atomic across workers and processes), keeps it for the attempt and releases it
  at the end. When all are leased it waits up to `waitSeconds`, then fails with
  "All 2 account(s) of role manager are in use". The account a journey used is
  recorded on its result (`reliability.account`).
- **Session pool health.** A cached session is verified before reuse
  (`verifyUrl`), and replaced once it is within `sessionRefreshMarginMinutes` of
  its max age, so it cannot expire mid-journey.
- **Lockout protection.** Login failures (`LOGIN_FAILED`, `LOGIN_FIELD`) are
  counted per environment/role/account in `.eztest/lockout.json`. After a failure
  the next attempt backs off (`backoffMs`, doubling). At `maxFailures` within the
  window EZTest stops trying (`LOGIN_LOCKOUT_PROTECTION`) and logs an alert, so a
  rotated password does not lock the account in the identity provider. Delete the
  account's entry after fixing the credentials.
- **Session expired mid-journey.** With `reliability.sessionExpiry`, when a step
  fails and the page is a sign-in page, says the session expired, or the step's
  calls got 401/440, the runner signs the role in again (same leased account,
  fresh session), returns to the URL where the step started and re-runs the step,
  once per journey. The step gets a warning, the journey
  `reliability.relogins`, and a `*.relogin.json` evidence record.

## 5. Test data

### Preconditions: `Requires:`

```
Requires: db demo "SELECT id FROM customers WHERE region = ${region}" has at least 2 rows
Requires: query "eligible_deals" on crm has rows; api GET /api/health returns 200
Requires: data Customer as buyer where region=EU; variable PAYMENT_KEY; that ${limit} > 100
```

All checks run before the first step (SQL values are bound, never spliced). If
any fails, the journey is an **error with name `DataPrecondition`**, its steps are
`not run: data problem`, the message lists every failed check
(`data problem: db demo ... (0 row(s), at least 2 needed); variable PAYMENT_KEY (PAYMENT_KEY is not set)`),
and triage classifies it as `data` (confidence 0.95). A `Data:` need that cannot
be found or created is reported the same way.

### Cleanup that survives crashes

Records the data fabric creates are written to a journal
(`.eztest/cleanup/<host>-<pid>-<id>.jsonl`) *before* the run continues, and
marked done when deleted. If the process dies, the next run (engine start,
`reliability.orphanSweep`, on) claims journals whose owner process is gone
(same host) or that are older than 6 h (other hosts) with an atomic rename,
deletes their records through the providers, and keeps anything it could not
delete for a later sweep. `CleanupRegistry` still attempts every undo even when
some fail.

### Unique data

`unique("ORD-")`, `unique("C", 12)` (max length) and `uniqueEmail()` in
expressions (and `uniqueValue()` in code) combine time, a per-process token
(host, pid, CI shard: `EZTEST_SHARD`, `CI_NODE_INDEX`, `BUILDKITE_PARALLEL_JOB`,
`SYSTEM_JOBPOSITIONINPHASE`, `CIRCLE_NODE_INDEX`, plus random bits) and a
counter: no collisions across workers, processes, shards or machines (tested
with 4 processes x 2000 values).

### Dependencies: `Depends on:`

```
Journey: Approve the order
Depends on: create-order with orderNumber, invoice
Open /orders/${orderNumber}
```

The runner orders prerequisites first (also with several workers), hands the
named ledger values to the dependent (default: the prerequisite's `Returns:`),
and skips a dependent with `not run: depends on "create-order", which failed (...)`
when a prerequisite did not pass, did not produce a value, is not part of the
run, or is in a cycle. The handoff is recorded in `reliability.dependsOn`.
Dependencies work with resource locks (`Locks:`): the lock queue only offers a journey whose prerequisites are done. With `--retry-strategy isolated`, a prerequisite is still retried inline, so its dependents see its final result; other failures are retried after the main pass, and either way the flake classifier records why a retried pass failed first.

## 6. Environment

```yaml
healthChecks:
  - { name: app, url: /health, contains: ready }
  - { name: orders api, api: /api/status, status: 200 }
  - { name: crm db, db: crm }                   # SELECT 1 (FROM DUAL on Oracle)
reliability:
  circuitBreaker: { enabled: true, threshold: 3 }
```

- **Pre-flight.** Checks run in parallel before the browser starts. If one
  fails, nothing runs: every journey is `skipped` with
  `not run: environment unavailable (pre-flight health check failed: app: HTTP 503 from ...)`,
  `run.health.preflight` holds the results, and `health-checks.json` is stored as evidence.
- **Behind a proxy.** URL and API checks (and the circuit breaker's probe) go
  through `HTTPS_PROXY` / `HTTP_PROXY`, except the hosts of `NO_PROXY`, like the
  browser and the API steps; nothing to configure.
- **Classification.** A failed journey whose page came back 5xx, or whose error
  is DNS, refused/reset connections, TLS, navigation timeouts or a 502/503/504,
  gets `reliability.environment` with the reason and the network log as evidence;
  triage reports it as `environment` (0.9), not a product bug.
- **Circuit breaker.** After `threshold` consecutive environment failures the
  runner probes (the health checks, else the base URL). Only if the probe
  confirms the outage does the circuit open: the remaining journeys are
  `not run: environment unavailable (...)` and `run.health.circuit` says after
  which journey. A product bug that looks like an outage never stops the run.

## 7. Failure diagnosis

Every failed step carries `diagnosis`:

```json
{
  "expected": "exactly one element for the \"Save settings\" button to click",
  "found": "no locator candidate matched exactly one element ...",
  "candidates": [{ "locator": "role=button \"Save settings\"", "matches": 0 }, { "locator": "text=\"Save settings\"", "matches": 0 }],
  "similar": [{ "locator": "role=button \"Save\"", "description": "button \"Save\"", "score": 0.79 }],
  "consoleErrors": ["ReportService failed: TypeError: cannot read total"],
  "failedRequests": ["GET 127.0.0.1/rel/api/broken -> HTTP 503"],
  "screenshot": "E-12", "outlined": 1, "url": "..."
}
```

The failure screenshot outlines what the candidates matched (red, amber) or,
when nothing matched, the nearest similar element; the outline is removed
before the HTML and aria snapshots. The step's error message gets one line of
hints: `did you mean role=button "Save" (0.79)?`, the failed calls, the last
console error. Query strings are never shown (they may carry tokens).

Failure **clustering across runs** (`clusterAcrossRuns`) groups failures by
signatures that ignore ids, numbers, URLs, timings, quoted values and generated
ids (`btn-8f3a2c91`, `ember1234`, `:r5:`), with runs, journeys, first and last seen.

## 8. Speed

- `eztest run --fast`: screenshots on failure only, no lenses, element
  fingerprints captured only for steps that have none, console/network logs
  kept only for attempts that did not pass. Actionability, re-render safety and
  diagnosis stay on.
- `reliability.recycleBrowserAfter`: new journeys start on a fresh browser after this many, and the
  old one closes when its last journey ends. The default is 15 on Firefox, whose parent process keeps
  about 30 MB for every closed window (a 4-worker suite of ~45 journeys reached 10 GB and was killed
  out of memory), and off on Chromium. A browser that dies mid-run (a crash, an out-of-memory kill) is
  launched again for the journeys still to run; the journeys it took down are reported as environment
  failures, and the run goes on and writes its results.
- `eztest run --reuse-context` (`reliability.reuseContext`): one browser context
  per worker, reset between journeys: pages closed, the previous journey's
  listeners removed, cookies, permissions, routes, extra headers, geolocation and
  offline mode cleared; sessionStorage ends with the closed tabs; and every
  origin that still holds localStorage or IndexedDB, or registered a service
  worker, is cleared (localStorage, IndexedDB, Cache Storage, service workers)
  on a blank document served by a route (the app is never loaded). A journey
  that stored nothing costs no extra navigation. A context that received
  an init script or exposed binding is closed instead (those cannot be removed).
  Journeys with their own emulation, video or trace always get a fresh context.

## 9. Locale, time zone, RTL

```yaml
locale: de-DE
timezone: Europe/Berlin
```

- `timezone` pins the browser (`timezoneId`) and the expression functions
  `today()`, `now()`, `format()` when no zone is given; `locale` sets the browser
  locale and the default for locale functions. A journey's `Locale:` / `Timezone:` still wins.
- Assertions:
  `Expect the Total shows the amount "1234.50" in EUR for locale de-DE`,
  `Expect testid=units shows the number "1234567.891"`,
  `Expect the Due date shows the date "2026-03-01"`
  parse the element's text with the locale's separators, digits (Arabic-Indic,
  Persian, Devanagari, ...), grouping (including narrow no-break spaces and Swiss
  apostrophes) and day/month/year order or month names; bidi marks are ignored.
  Without `for locale` the browser's locale is used.
- `Expect the page is right-to-left` / `Expect the Sidebar is left-to-right` check the computed `direction`.
- Expressions: `formatCurrency(1234.5, "EUR", "de-DE")`, `formatLocaleNumber(x, "fr-FR", 2)`,
  `formatLocaleDate("2026-03-01", "en-GB", "long")`, `parseLocaleNumber("1.234,50", "de-DE")`, `parseLocaleDate("1. März 2026", "de-DE")`.

## Native journeys (`Platform: android` / `ios`)

Journeys that run on a platform driver ([mobile.md](mobile.md)) take part in
the run-level features:

- `Depends on:` ordering and skipping. Handed-over ledger values arrive as
  journey variables, as strings (JSON for objects), because drivers have no
  ledger hook.
- Resource locks.
- Pre-flight health checks.
- The circuit breaker. Failures are classified as environment from the error
  text only, since drivers keep no browser network log.
- Retries, isolated retries and the flake classifier.
- Triage.

These are web-only: actionability, app idle and re-render safety; the failure
diagnosis ("did you mean", outlined screenshot, console and network); locator
improvement proposals; `Requires:` preconditions and session-expiry re-login
(both live in the web journey runner); context reuse; and locale/time-zone
emulation of the browser. Expression functions still use the pinned time zone.

## Waits under load

A wait given 5 s on an idle machine gets much less than 5 s of real work when the machine's CPUs
are oversubscribed: the browser renders and runs scripts at a fraction of its speed and the runner
is descheduled. The runner does not fail such a wait, or heal an element that is only slow to
appear: it measures how loaded the machine was while the wait ran and extends the deadline in
proportion, up to 3x (`EZTEST_ADAPTIVE_MAX`, 1 to 10; `EZTEST_ADAPTIVE_WAITS=0` turns it off).

| Measured | How | Deadline factor |
|---|---|---|
| CPU saturation | CPU busy share of the machine over the wait (from the CPU times) and the run queue: runnable tasks per CPU (`/proc/loadavg`, sampled each second; elsewhere the 1-minute load average) | runnable tasks per CPU, when the CPUs were at least 85% busy |
| The runner's own starvation | a 50 ms timer adds up how late it fires: time the process could not run | 1 / (1 - starved share), from 10% |
| Browser responsiveness | the round trip of a trivial evaluation in the page (a few ms when idle) | 1 + round trip / 250 ms, from 60 ms |

The factor is the largest of the three, and 1 on an idle machine. Locating a target and
post-conditions check it when their deadline comes and keep polling while it allows; waits inside
the browser driver (an action's actionability wait, a navigation) get a timeout scaled by the load
of the three seconds before they start. Every extension is recorded on the step and logged:

```json
"reliability": { "waits": [], "recovered": [], "extended": [
  { "what": "locate the \"Go\" button", "baseMs": 1000, "ms": 3000, "reason": "CPUs 100% busy with 3.0 runnable tasks per CPU" } ] }
```

so a run that took longer on a busy machine says why. EZTest's own test suite does the same for its
`expect.poll` waits (tools/testkit/load.ts).

Measured on the 4-core development container, with one busy-loop process per core added on top of
the other suites sharing it (load average 15 to 35): `test/browser`, `test/runner`, `test/e2e` and
`test/studio/ui.test.ts` on Chromium.

| | Tests passed | Failed |
|---|---|---|
| Before (fixed deadlines) | 377 | 5 (Studio UI: a 1 s poll for the first page, then the tests that depend on it) |
| After (adaptive deadlines) | 387 (10 new) | 0 |
| After, second run (load average about 30) | 381 | 7, all passing when run again: the two new process-worker cancel tests (their wait for two workers to start was then raised), four Studio UI tests, and one 50 ms query-speed check |

## Measurements

All numbers come from scripts in `scripts/bench/`, run on one shared CI-like
Linux container (Chromium headless, 4 workers). Other jobs kept the machine's
load average around 35-45 during the runs, so wall times vary by roughly
+/- 25 % from one run to the next. Evidence went to a RAM disk (`TMPDIR=/dev/shm`)
because the shared disk was full, so disk-write cost is understated.

**Flake rate** (`npx tsx scripts/bench/flake-rate.ts 20`): 8 timing-sensitive
journeys on `/rel` pages with random delays (hydration up to 900 ms, re-render
up to 700 ms, slow XHR, cookie banner up to 1.2 s, sliding button), 20 runs each,
no retries:

| Mode | Failed executions | Flake rate |
|---|---|---|
| Before: reliability layer off (driver auto-wait + polled post-conditions only) | 70 / 160 | **43.8 %** |
| Defaults: actionability, verifyFill, re-resolve (app idle off) | 46 / 160 | 28.8 % |
| After: defaults + `reliability.appIdle: true` | 0 / 160 | **0 %** |

App idle is what fixes hydration, slow-XHR captures and re-renders. Without it
the defaults help with overlays and animations, but the re-render-after-typing
journey got *worse* (4 to 16 failures): the extra actionability probe delays the
click until the re-render has happened, and `verifyFill` cannot see a re-render
that has not started yet. For SPAs, turn on `appIdle`.

**Time to understand a failure** (`scripts/bench/diagnosis.ts`): 7 planted
defects (renamed button, stuck overlay, backend 503, console error, missing data,
environment 503, expired session). Model, not a user study: reading time at
200 words per minute, plus 45 s for every artifact (screenshot, HTML, network
log, console log, a database query) a person has to open when the message does
not state the cause.

| | Root cause stated in the failure | Median time to understand |
|---|---|---|
| Before (no diagnosis, no `Requires:`) | 0 / 7 | **50 s** |
| After | 7 / 7 | **8 s** |

**Tool overhead** (`scripts/bench/perf-300.ts 300 4`): 300 sign-in + order
journeys (8 steps each), 2400 steps:

| Configuration | Wall time | Journeys/min | Evidence |
|---|---|---|---|
| every-step screenshots + a11y lens | 976 s | 18 | 5401 files, 275 MB |
| every-step screenshots (the CLI default) | 875 s | 21 | 2851 files, 350 MB |
| screenshots on failure | 218 s | 82 | 602 files, 1.9 MB |
| `--fast` | 173 s (re-run: 214 s) | 104 (84) | 2 files, 1.2 MB |
| `--fast --reuse-context` | 320 s, after the reset fix 244 s | 56, 74 | 2 files |
| `--fast`, reliability guard off | 233 s (re-run: 171 s) | 77 (105) | 2 files |

- Full-page screenshots on every step are the main cost: about 75 % of the CLI
  default run. `--fast` is **4.0x to 5.1x faster** than the CLI default
  (875 s to 173-214 s). Fingerprint capture and per-journey console/network
  evidence are a further ~20 % on top of "screenshots on failure".
- The a11y lens adds about 100 s (11 %) over every-step screenshots.
- The reliability guard's cost could not be told apart from noise
  (171-233 s with it off, 173-214 s with it on).
- Context reuse did **not** pay off here. Chromium creates a context in a few
  milliseconds, and resetting one takes longer: closing pages, clearing
  cookies, permissions, headers, geolocation and offline mode, and reading
  storage state. After the reset was changed to skip the clearing document when
  nothing was stored, reuse was still about 14 % slower than `--fast`. Keep it
  for setups where creating a context is expensive (client certificates,
  extensions, heavy `storageState`), and measure first.

## Limits

- React and Vue expose no quiescence API. App idle relies on the request
  counter and the optional `window.__EZTEST_BUSY__` hook. Work driven only by
  timers (`setTimeout` animations, debounced renders) is not seen.
- `verifyFill` catches a re-render that happens while EZTest waits for the app
  to settle. With app idle off, that is only during the fill itself.
- Driver locators re-query on every action, so "detached" errors are rare.
  The re-resolve retry is unit-tested with a fake locator; the demo app does not
  produce a live detached error.
- Overlay detection is a heuristic (fixed layers, dialogs, `aria-modal`, and
  backdrop, spinner, cookie and toast class names). An unmarked covering
  element gets the driver's own message.
- Session expiry is detected from the URL, page text and 401/440 responses. The
  runner re-logs in once per journey and re-runs only the failed step, so earlier
  steps whose effects were lost are not replayed.
- Account pools lease per journey attempt. API tokens (`apiAuth`) are still per
  role, not per pooled account. The lockout state lives in `.eztest/lockout.json`
  in the project, so machines share it only when they share that directory.
- The orphan sweep deletes through providers that implement `delete`. Journals
  from other hosts are swept only after 6 hours.
- `eztest lint` scans code with patterns, not a parser. It can miss a hard wait
  hidden behind a helper, and can flag a mock server's delay. Text-only locator
  findings are off unless the UI is marked as translated.
- Locale parsing: numeric dates follow the order `Intl` reports for the locale,
  and two-digit years are taken as 20xx. RTL support covers layout direction and
  parsing that is safe with bidi marks and native digits, not mirrored-layout
  visual checks.
- The flake suite and planted defects are synthetic pages built to misbehave.
  Time to understand is a model. The overhead numbers come from one loaded
  machine.
