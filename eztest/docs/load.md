# EZTest Load: performance and load testing

EZTest Load is EZTest's own performance-testing engine (`src/load`, `eztest load …`, and the
Studio **Performance** workspace). It runs on Node core: no other load-testing tool is used,
embedded or targeted, and nothing reads or writes another tool's script format. The only
import format is **HAR**, the browsers' standard recording export.

| | |
|---|---|
| Scenario model | user paths (virtual-user scripts) from EZTest journeys, browser recordings through EZTest's driver, HAR files, a run's captured traffic, or hand-written YAML/JSON |
| Correlation | automatic: session ids, CSRF tokens, ASP.NET ViewState/EventValidation, JSF ViewState, Salesforce (Visualforce, Lightning), Dynamics 365, SAP (Web Dynpro, OData `x-csrf-token`), OAuth tokens, ids in redirects, JSON values; framework rule packs plus project rules (rule editor) |
| Data | CSV/JSON files, inline rows, SQL queries; sequential, random or unique rows, per iteration, per VU or per test |
| Behaviour | transactions (timed groups), think times (fixed, uniform, normal, exponential), pacing, conditions, loops, variables, per-request assertions and extractors |
| Load | constant, ramp (up/plateau/down), step, peak/spike, soak, custom curves; closed (VUs) and open (arrival rate) models; populations with shares; network emulation per population |
| Engine | HTTP/1.1 keep-alive pools and HTTP/2, cookies, redirects, Basic/Digest/NTLM/Negotiate/OAuth 2/Bearer, TLS client certificates; WebSocket, SSE, gRPC, SQL and messaging users; browser-level users through EZTest's driver |
| Measurement | HDR-style histograms (3 significant digits, exact merges), coordinated-omission-safe response times, service times kept alongside |
| Distribution | controller + agents over EZTest's own authenticated protocol (HMAC token and/or mutual TLS), data slicing, zones, live control, safe stop, Docker image, scaling hooks |
| Monitors | host (Linux /proc, Windows typeperf), remote host agent, JVM (jstat/jcmd), Oracle, SQL Server, PostgreSQL, HTTP health; one timeline with the load |
| Results | SLAs (live and final), analysis (knee, saturation, errors), baseline comparison, trends, HTML/JSON reports, evidence vault, results server, readiness gate `load`, CI exit codes |

## Quick start

```sh
eztest load har recording.har -o load/checkout.yaml     # or: eztest load record https://app.example.com
eztest load validate load/checkout.yaml                 # curves and populations
eztest load check load/checkout.yaml                    # one VU, one iteration: is every value correlated?
eztest load run load/checkout.yaml                      # here; report in eztest-results/<runId>/report.html
```

Exit codes: `0` SLAs met (warnings allowed unless `--fail-on-warn`), `1` an SLA failed, a
regression against `--baseline` with `--fail-on-regression`, or readiness `NO_GO` with
`--policy`, `2` the test could not run.

## Scenarios

```yaml
version: 1
name: Checkout
baseUrl: https://shop.example.com
model: closed                     # closed: the profile is virtual users; open: iterations per second
profile: { type: ramp, vus: 200, rampUp: 2m, plateau: 10m, rampDown: 1m }

data:
  users: { file: users.csv, order: unique, scope: vu, onExhausted: stopVu }
  skus:  { query: "SELECT sku FROM products WHERE active = 1", connection: shopdb, order: random }

connections:
  shopdb: { driver: postgres, host: db.example.com, database: shop, user: perf, password: env:SHOP_DB_PASSWORD }

userPaths:
  buyer:
    data: [users]
    init:                                         # once per VU
      - transaction:
          name: login
          actions:
            - request: { name: login page, url: /login, extract: [{ var: csrf, regex: 'name="csrf" value="([^"]+)"' }] }
            - request:
                name: sign in
                method: POST
                url: /login
                form: { csrf: "${csrf}", username: "${users.username}", password: "${users.password}" }
                assert: [{ status: 302 }]
    actions:                                      # every iteration
      - use: skus
      - transaction:
          name: add to cart
          actions:
            - request: { method: POST, url: /cart, json: { sku: "${skus.sku}", qty: 1 }, extract: [{ var: cartId, json: $.id }] }
      - if:
          cond: "cartId != ''"
          then:
            - transaction: { name: checkout, actions: [{ request: { method: POST, url: "/cart/${cartId}/checkout", assert: [{ status: 200 }, { json: $.status, equals: PLACED }] } }] }
    thinkTime: { min: 2s, max: 5s }               # between top-level steps
    pacing: 20s                                   # optional: start an iteration at most every 20 s per VU

populations:
  - { name: desktop, userPath: buyer, share: 70 }
  - { name: mobile-eu, userPath: buyer, share: 30, zone: eu-west, network: { latencyMs: 80, jitterMs: 10, downloadKbps: 8000, uploadKbps: 2000, lossPercent: 0.5 } }

sla:
  - { match: checkout, kind: transaction, p95: { warn: 800, fail: 1500 }, errorRate: { fail: 0.01 }, ignoreFirst: 2m }
  - { match: "*", kind: request, errorRate: { warn: 0.001, fail: 0.01 } }

monitors:
  - { type: host, name: load generator }
  - { type: host, name: app-1, url: http://app-1:7401, token: env-or-literal-token }
  - { type: jvm, pid: com.example.ShopApplication }
  - { type: db, connection: shopdb, topSql: 10 }
  - { type: http, url: https://shop.example.com/health }

options: { http: auto, timeoutMs: 30s, gracefulStop: 30s }
stopOnSlaFail: 1m                                 # stop the test when an SLA has failed live for a minute
```

### Actions

| Action | |
|---|---|
| `request` | `name`, `method`, `url` (relative to `baseUrl`), `headers`, `body` / `json` / `form`, `extract`, `assert`, `timeoutMs`, `followRedirects`, `resources` (page resources fetched in parallel), `captureAs` (keep `{status, headers, body}`), `thinkBefore`. Shorthand: `request: "POST /orders"` |
| `transaction` | a named, timed group of actions (its response time is the group's) |
| `think` | `2s`, `{ min, max }`, `{ mean, stdDev, distribution: normal \| exponential }` (`options.thinkTimeFactor` scales all) |
| `set` | variables from templates |
| `if` | `cond` (EZTest's safe expression language), `then`, `else` |
| `loop` | `times` or `while` (with `max`), `actions`; `${__loop}` is the index |
| `use` | take a row of a data set now |
| `browser` | a browser-level step: `goto`, `click`, `fill`+`value`, `select`, `check`, `press`+`key`, `waitFor`, `expectText`, `expectUrl`, `capture` |
| `ws` | WebSocket: `url`, `send` messages, `expect` texts in order |
| `sse` | Server-Sent Events: `url`, `until` text, `maxEvents`, `extract` |
| `grpc` | `address`, `proto`, `method` ("pkg.Service/Method"), `request`, `metadata`, `expectStatus` |
| `sql` | `connection`, `sql` with `?` parameters, `captureAs`, `minRows` |
| `message` | `bus` (from `buses`, EZTest's messaging drivers: kafka, amqp, mqtt, ibmmq, memory), `publish` and/or `consume` |

Templates: `${var}`, `${dataset.column}`, `${env.NAME}` (the load generator's environment, for
credentials), `${__vu}`, `${__iter}`, `${__uuid}`, `${__now}`, `${__rand(1,100)}`,
`${__randomString(12)}`, `${__urlencode(var)}`, `${__base64(var)}`, and any safe expression
(`${qty * 2}`). An unset variable is an error (type `template`): a correlation that did not
happen never sends a stale value.

`eztest load run` fills `${env.NAME}` from the suite's `.env` file (and `.env.<name>` with `-e <name>`),
as `eztest run` does; variables set in the real environment win. `baseUrl` is a template too, so one
scenario follows the environment: `baseUrl: "${env.API_URL}"`.

Extractors: `json` (JSONPath), `regex` (group 1 or `group`), `boundary` (`left`/`right`),
`from: header | headers | cookie | url | status` with `name`; `index: 0 | last | random | all`;
`default`; `decode: url | html | base64`. A required extractor that matches nothing fails the
request (type `extraction`). Assertions: `status` (one or a list), `contains`, `notContains`,
`regex`, `json` + `equals`/`exists`, `header`, `maxMs`, `minBytes`/`maxBytes`. Without a
status assertion any status of 400 or more is an error.

After a failed request the iteration ends (`options.onError: stopIteration`; `continue` goes on).

### Load profiles and models

| Type | Fields |
|---|---|
| `constant` | `vus` or `rate`, `duration` |
| `ramp` | `vus`/`rate`, `from`, `rampUp`, `plateau`, `rampDown` |
| `step` | `from`, `step`, `every`, `to`, `hold`, `rampWithin` |
| `peak` | `base`, `peak`, `duration`, `peakEvery`, `peakFor`, `rampWithin` (spike tests) |
| `soak` | `vus`/`rate`, `duration`, `rampUp`, `rampDown` (endurance) |
| `custom` | `points: [{ at, value }]`, linear in between |

In the **closed** model the curve is the number of concurrent VUs: VUs start to follow it and
stop (newest first, after their current iteration) when it falls. In the **open** model the
curve is iterations per second: arrivals are scheduled exactly from the curve's integral and
handed to a free VU (up to `options.maxVus` per load generator); an arrival with no free VU
waits in a queue (`options.maxQueue`) and its wait counts as latency; only beyond the queue is
it dropped (reported). Populations split the profile by `share`, or bring their own `profile`.

### Network emulation

Each population's `network` (latency, jitter, bandwidth up/down, packet loss) goes through
EZTest's connection shaper: a loopback relay per destination that delays every chunk by half the
round trip in each direction, releases bytes at the bandwidth cap per connection, and delivers a
lost packet one retransmission timeout (≥ 200 ms) later, the way TCP recovers it. Browser-level
users get Chromium's own network emulation through the DevTools protocol.

## User paths from recordings, HAR and journeys

```sh
eztest load record https://app.example.com -o load/app.yaml   # use the app in EZTest's browser, close it to finish
eztest load har session.har -o load/app.yaml --frameworks aspnet,generic
eztest load from-run eztest-results/run-2026-10-23-… --journey checkout -o load/checkout.yaml
eztest load from-journey journeys/orders-api.ez journeys/checkout.ez -o load/mixed.yaml
```

Journeys: API steps (`Call POST /api/orders …`) become protocol-level requests (their
`captureAs` results stay available, e.g. `${tok.body.access_token}`); UI steps become a
browser-level user (navigate, click, fill, select, check, press, text and URL expectations) run
by EZTest's driver.

### Correlation

The generator finds values that a response produced and a later request sent back, makes an
extractor on the producing request and a `${variable}` everywhere they are used (URL, headers,
body; URL-encoded where the request encoded them). Order of detection:

1. **Rule packs** (`--frameworks`, default all): `aspnet` (`__VIEWSTATE`, `__VIEWSTATEGENERATOR`,
   `__EVENTVALIDATION`, `__RequestVerificationToken`, UpdatePanel deltas), `jsf`
   (`javax/jakarta.faces.ViewState`, partial responses, ClientWindow), `salesforce`
   (Visualforce ViewState/Version/MAC/CSRF, Lightning `aura.token` and `fwuid`,
   `_CONFIRMATIONTOKEN`), `d365` (`CRMWRPCToken`, `CRMWRPCTokenTimeStamp`, request verification
   token, F&O session id), `sap` (`sap-contextid`, `sap-wd-secure-id`, `sap-login-XSRF`,
   OData `x-csrf-token`, Web Dynpro window id), `generic` (CSRF meta/hidden input/header,
   `XSRF-TOKEN` cookie, OAuth `access_token`/`id_token`/`refresh_token`, authorization codes,
   `jsessionid`).
2. **Project rules** in `load/correlation-rules.yaml` (the Studio rule editor writes it):
   `{ name, from: body|header|cookie, regex | json | boundary | header, urlMatch, var }`.
3. **Heuristics**: dynamic-looking JSON values and ids, hidden inputs, token-like headers, ids in
   redirect locations.

Values the client sent before the response produced them are inputs, not correlations.
Credentials that no response produced become `${env.EZ_…}` variables (the generator lists them).
`eztest load check` replays each path once with one VU and shows every request and the
variables it extracted: the correlation assistant's proof.

## Authentication and TLS

`options.auth` (or a user path's `auth`): `basic`, `digest` (MD5, SHA-256, `-sess`, qop=auth,
nonce counting), `ntlm` (NTLMv2; one connection per origin so the handshake stays on it),
`negotiate` (SPNEGO/Kerberos tokens from `tokenCommand`, e.g. a helper using the operating
system's GSS-API, or a fixed `token`: EZTest does not implement Kerberos itself), `oauth2`
(client credentials or password grant, cached and refreshed), `bearer`.
`options.tls`: `cert`/`key` or `pfx`/`passphrase` (client certificates), `ca`, `insecure`.
`options.http`: `1.1`, `2` (prior knowledge on `http://`, ALPN on `https://`) or `auto`.

## Measurement

Every sample goes into an HDR-style histogram (1 µs … 71 min, 3 significant digits, ~190 KB per
histogram, lossless merges). The **response time** of an iteration's first request (and of its
transaction and the iteration) is measured from the iteration's **intended** start: the open
model's scheduled arrival or the pacing slot. A generator that falls behind, an arrival waiting
for a VU, or a system that stalls shows up as latency, not as missing samples (coordinated
omission). The **service time** (from the actual send) is kept too; the report shows both.
Think time before the first request moves the intended start, so it is never counted as latency.

## Distributed tests

```sh
# controller (with the scenario); it waits for two agents, splits the load, merges the results
eztest load run load/checkout.yaml --agents 2 --listen 0.0.0.0:7400 --token "$EZTEST_LOAD_TOKEN"
# each load generator
eztest load agent --controller controller.example:7400 --token "$EZTEST_LOAD_TOKEN" --zone eu-west
```

- **Protocol**: newline-delimited JSON over TCP or TLS. With a token both sides prove it with an
  HMAC challenge-response (the token never crosses the wire); with `--tls-cert/--tls-key/--tls-ca`
  the controller requires agent client certificates (mutual TLS). Use both across networks.
- **Jobs**: each agent gets the scenario, its share of each population (by `--capacity`; zone
  populations only go to agents of that `--zone`), its slice of each sequential/unique data set
  (so unique rows stay unique across agents) and a common wall-clock start (run NTP). Closed-model
  VU counts are split so they add up exactly.
- **Metrics**: one encoded interval per second per agent (sparse histograms); the controller
  merges them exactly, runs the monitors and SLAs on the merged timeline and relays live control
  (add VUs, scale, stop). A lost agent is reported and the test continues.
- **Stop**: graceful (iterations finish within `gracefulStop`), then abort.
- **Docker**: the full image runs agents with browsers: `docker run eztest load agent …`. The slim
  agent image is one bundled file on Node:
  ```sh
  npm run build:load-agent
  docker build -f deploy/load-agent/Dockerfile -t eztest-load-agent .
  docker run --rm -e EZTEST_LOAD_CONTROLLER=controller:7400 -e EZTEST_LOAD_TOKEN=… -e EZTEST_LOAD_ZONE=eu-west eztest-load-agent
  ```
- **Elastic scaling**: agents dial the controller, so an autoscaler only has to start them.
  `--scale-up "<command>"` runs when the controller starts waiting and `--scale-down "<command>"`
  after the test, with `{agents}`, `{port}`, `{runId}` placeholders and `EZTEST_LOAD_TOKEN` in
  their environment. Examples:
  - Kubernetes: a Deployment of agent pods with `EZTEST_LOAD_CONTROLLER` pointing at the
    controller Service; `--scale-up "kubectl scale deployment/ez-load-agents --replicas={agents}"`,
    `--scale-down "kubectl scale deployment/ez-load-agents --replicas=0"`.
  - AWS ECS / Azure Container Apps / GCP Cloud Run jobs: the platform's "set desired count"
    command in the same two hooks.
  - Agents without `--once` reconnect after each job, so a standing pool serves test after test.

## Monitors

| Type | What |
|---|---|
| `host` | CPU, memory, swap, load, disk throughput and utilization, network throughput, and per-process CPU/RSS (`processes`). Linux reads /proc; Windows uses `typeperf`; elsewhere Node's `os` module. `url` + `token` poll a remote **host agent**: `eztest load monitor-agent --port 7401 --token …` on the server being tested |
| `jvm` | heap used/committed, eden/old/metaspace occupancy, young/full GC counts, GC time share, threads, by `pid` or a name matched in `jcmd -l`. JMX travels over Java RMI with Java serialization, which EZTest does not reimplement; it reads the JVM where it runs with the JDK's `jstat` and `jcmd` (locally, or via the host agent's `/jvm?pid=`) |
| `db` | Oracle (`v$session`, `v$system_event`, `v$sysstat`, `v$sqlarea`), SQL Server (`sys.dm_exec_sessions`, `sys.dm_os_wait_stats`, `sys.dm_os_performance_counters`, `sys.dm_exec_query_stats`), PostgreSQL (`pg_stat_activity`, `pg_stat_database`, `pg_stat_statements`): sessions, active sessions, wait time per class (ms per second), throughput, top SQL. Uses EZTest's drivers; the user needs SELECT_CATALOG_ROLE / VIEW SERVER STATE / pg_monitor (a user without them is reported in the monitor's errors, never as an empty series) |
| `http` | status and response time of a health endpoint |

Every monitor point carries the second of the test, so charts and analysis line monitors up with
throughput, latency and active VUs.

## SLAs, analysis and results

SLA profiles match transactions/requests by glob (`match`, `kind`) and bound `avg`, `p50`, `p90`,
`p95`, `p99`, `max`, `errorRate` (0..1) and `throughput` (minimum per second) with `warn`/`fail`.
Live, they are evaluated every second over `window` (conservative: the worst second's percentile)
and recorded as status changes; `stopOnSlaFail` stops the test. At the end they are evaluated
exactly on the merged histograms, optionally of the steady part only (`ignoreFirst`).

The analysis finds:

- **the knee**: a two-segment fit of p90 against load (VUs, or arrivals per second) locates where
  response time starts to climb steeply; throughput that stops scaling confirms saturation;
- **saturated resources**: monitored values at their limit (CPU ≥ 85%, memory ≥ 90%, disk ≥ 85%,
  JVM old generation, GC time) and values that move with the response time (Pearson r ≥ 0.7);
- **error patterns** per transaction, and dropped arrivals.

`--baseline <run>` compares per transaction/request: a regression is a p95 rise of more than 15%
and 20 ms (both configurable on `eztest load compare`), an error-rate rise above 1 point, or a
throughput drop above 15%. `.eztest/load-history.json` keeps every run for `eztest load trend`.

A run directory (`eztest-results/<runId>`) holds `load-results.json`, `report.html` (self-contained,
light and dark), `timeline.csv`, the scenario as run and a `run.json` whose journey records each
SLA verdict, all in the hash-chained **evidence vault** (`eztest verify`). It can be published to
the results server (`--server`, or `eztest publish`) and packed like any run.

### Readiness and CI

The readiness gate `load` (blocker by default) passes when the load SLAs held, warnings are
allowed (`allowWarnings: false` to refuse them), and regressions do not exceed `maxRegressions`:

```yaml
gates:
  load: { allowWarnings: true, maxRegressions: 0 }
```

`eztest load run … --policy readiness-policy.yaml` decides at the end (exit 1 on `NO_GO`);
`eztest load gate <runDir>` decides for an existing run; `eztest analyze <runDir> --policy …` and
the Azure DevOps gate see it like every other gate. A run directory that holds `load-results.json`
(for example a functional run with a load run's results copied in) feeds the gate too.

## Studio: the Performance workspace

- **Design**: pick or create a scenario; edit the model, the profile (with its curve preview, live),
  populations (share, zone, latency, bandwidth, loss) and SLAs; see each user path's outline and
  the YAML; save.
- **Correlation**: from a Studio run or a HAR upload, choose rule packs, see each correlated value
  (rule, source request, uses), exclude candidates, edit project rules, save the scenario and replay
  it once.
- **Run**: start a scenario here and watch the live dashboard: active VUs, throughput, errors,
  p50/p90/p95/p99, per-transaction table of the last second, SLA states, errors by type, monitors;
  add or remove VUs, stop or abort.
- **Results**: every load run with its verdict, SLA table, analysis findings, timeline and monitor
  charts, the transaction table, the HTML report, comparison with a chosen baseline and the trend.

## Measured here

On the 4-core development container, shared with other test suites (load average 17 to 47
while measuring), one load generator process against a two-process keep-alive target
(`scripts/bench/load-engine.ts`) ran 100 VUs at about 3,650 requests/s, 500 VUs at about
3,570 requests/s and 1,000 VUs at about 2,400 requests/s with zero think time and no errors;
the generator itself used about half a core (the rest of the time it waited for the target),
and plain Node `http` clients in the same setup were within 15% of it. With a 500 ms server
delay a generator held 5,000 concurrent VUs. The accuracy test (`test/load/engine.test.ts`)
measures p50, p90 and p99 within 5 ms or 5% of the server's own measurement of each answer.
Reproduce on your hardware with `npx tsx scripts/bench/load-engine.ts 100,500,1000 8 0` and
`npx tsx scripts/bench/load-distributed.ts 2 400 8`.

## Limits

- Kerberos/SPNEGO tokens come from a helper command; EZTest has no Kerberos implementation.
- JVM metrics need the JDK's `jstat`/`jcmd` on the monitored host (no JMX/RMI client).
- Bandwidth caps apply per connection; packet loss is emulated as retransmission delay.
- Agents need the files a scenario references for TLS client certificates and gRPC protos
  (data sets are shipped by the controller).
- Browser-level users cost a browser context each: plan tens to low hundreds per generator.
