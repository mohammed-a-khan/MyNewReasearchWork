# Live debugger and time-travel trace: engine APIs and Studio wiring

This page is for the people building the Studio UI and anyone driving EZTest
programmatically. It covers the runner capabilities, the programmatic API, the
Studio route modules and how to mount them. There are no UI pages here.

Both features are **opt-in**. A run without `timeTravel.enabled` and without
`debug` takes exactly the old code path. The only extra cost is one `WeakMap` lookup per step.

## 1. Time-travel trace

### Enabling it

```ts
await runJourneys(journeys, {
  outputDir, baseUrl,
  timeTravel: { enabled: true, dom: true, network: true, console: true, screenshots: true, maxBodyBytes: 65536, masker },
});
```

You can also enable it in config (`eztest.config.yaml`). The engine passes the config `SecretMasker` through for you:

```yaml
trace:
  timeTravel:
    enabled: true
    maxBodyBytes: 65536   # 0 keeps no bodies
```

### What is recorded per step

| Area | Content |
|---|---|
| DOM | A snapshot **before** the action, taken after the target is located, so the target is known. A snapshot **after** the step. Each snapshot is self-contained HTML: scripts, `on*` handlers and `javascript:` URLs are removed, while form values, checked and selected state, open shadow roots (as declarative shadow DOM), same-origin iframes (as `srcdoc`) and scroll offsets (`data-ez-scroll`) are kept. Every element gets a `data-ez-nid`. |
| Target | `nid`, page-coordinate bounding box (iframe offsets included), tag, `sensitive` flag, and the text of the surrounding region (form, section, dialog and so on). |
| Resources | Same-origin stylesheets, plus stylesheets, images and fonts seen on the network. Each is stored once per run by SHA-256 under `trace/resources/` and referenced from the snapshot as `ezres:<sha>.<ext>`. |
| Network | Method, URL (secret query parameters redacted), status, timing split, sizes, request and response headers (`Authorization`, `Cookie`, `Set-Cookie` and token-like headers become `****`), and text or JSON bodies up to `maxBodyBytes`. Form and JSON fields that look secret are redacted. |
| Console | Messages and page errors with their location. |
| Action | The resolved locator, every candidate tried with its match count, heal-ladder attempts (tier, locator, confidence, reason, matches) with notes, post-conditions (text, expected, actual, passed), timings for locate, act, verify, heal and snapshot, the runner's screenshot evidence id, and the trace's own viewport JPEG. |

**Secrets.** Every string goes through the configured masker. Values typed
into password-like fields (by type, autocomplete, name or description) are
learned during the run and masked everywhere: intent, value, DOM, bodies and
console. The masking is applied when the trace is written, so a password
typed in step 3 is also masked in step 1's data. Password inputs are always
blanked inside the snapshot (`value="" data-ez-redacted="1"`).

**Evidence.** Every trace file is written through the Evidence Vault (kind
`trace`), so `verifyEvidence(runDir)` covers it. The `trace.json` evidence
id is added to `JourneyResult.evidence`.

### On-disk format

```
<runDir>/trace/
  resources/<sha256>.<ext>.gz                  run-level, deduplicated (CSS, images, fonts, bodies, JPEGs)
  <journeyId>-<attempt>/
    trace.json                                 the index (TraceFile, see src/runner/trace/types.ts)
    snapshots/<index>-<execution>-<before|after>.html.gz
```

`trace.json` (`format: "eztest-trace"`, `version: 1`) holds:

- `runId`, `journeyId`, `journeyName`, `attempt`, `browser`, `status`, `viewport`;
- the start and finish times and the duration;
- `steps[]`, where each entry is a `TraceStep`: `index` and `execution` (above 1 when the debugger re-ran an edited step), `stepId`, `intent`, `action`, `value`, `status`, `error`, `timings`, `locator`, `heal`, `conditions`, `snapshots`, `network`, `console`, `screenshot`, `url` and `edited`;
- `unattributed`, for network and console activity between steps;
- `resources`, mapping each `ezres` key to `{ path, contentType, size }`.

### Browser traces (`trace.browser`)

With `trace.browser: on` (or `on-failure` / `retain-on-failure`), EZTest's browser driver writes a zip per journey attempt (`traces/<journey>-attempt<n>.zip`, evidence kind `trace`) in EZTest's own browser trace format (`format: eztest-browser-trace`, see `src/browser/trace-format.ts`): a `manifest.json` with every file's SHA-256, `actions.jsonl`, `network.jsonl`, `console.jsonl`, `frames.jsonl`, `snapshots/<action>-<phase>.json` (DOM trees with live form state and the action's target marked) and `resources/<sha256>`. Studio opens these in the time-travel viewer: from a run's Trace tab ("Browser traces"), or with "Open trace…" for a file. `readBrowserTrace(zip)` turns one into the trace model from code; password-like values are masked and a file that does not match the manifest is reported.

### Reading, rendering, bundles, diff

```ts
import {
  readTrace, listTraces, renderSnapshot, runDirSource,
  exportTraceBundle, readTraceBundle, diffTraces,
} from '@eztech/eztest/runner';

const trace = await readTrace(runDir, 'bob-order', 1);
const html = await renderSnapshot(runDirSource(runDir), trace, trace.steps[3].snapshots.before!); // inlined, CSP'd, target outlined
const zip = await exportTraceBundle(runDir, 'bob-order', 1, 'bob-order.eztrace.zip');          // one file, with SHA-256 list
const { trace: t2, source, problems } = readTraceBundle(zip);                                    // problems: altered or missing files
const diff = diffTraces(lastGreen, current);   // per step: status, locator, timing deltas, region text diff, URL, conditions, network
```

Serve rendered snapshots in a sandboxed iframe. `SNAPSHOT_CSP` (exported from
`@eztech/eztest/studio`) is the header the trace routes use.

## 2. Live debugger

```ts
const dbg = new DebugController({ pauseAtStart: true, pauseOnFailure: true, breakpoints: [{ stepId: 'click-the-sign-in-button' }] });
const running = runJourneys([journey], { outputDir, baseUrl, debug: dbg, timeTravel: { enabled: true } }); // concurrency forced to 1
const state = await dbg.waitForPause();   // { status, journeyId, stepIndex, stepId, phase, reason, url, vars, ledger (masked), steps, lastResult, breakpoints }
dbg.stepOver(); dbg.stepInto(); dbg.runToStep({ stepIndex: 7 }); dbg.resume(); dbg.pause();
dbg.addBreakpoint({ stepIndex: 8, condition: { type: 'pageContainsText', value: 'created' } }); // declarative, no eval
// Paused on failure (phase "failed"):
dbg.retry('Click the "Sign in" button\n  Expect the URL contains "/dashboard"'); // edit-and-continue (keeps the step id)
dbg.skip();
dbg.replaceStep('Verify the page contains "Saved"', { index: 9 });              // edit an upcoming step
await dbg.evaluate('Verify the page contains "Sign in"');                       // ad-hoc step against the live page; not added to the journey
await dbg.pick({ x, y });                     // ranked locator candidates
await dbg.validate('the "Sign in" button', { highlight: true }); // match count plus an overlay, removed on resume
await dbg.input({ type: 'mouse', action: 'click', x, y });       // CDP Input.dispatch* on Chromium
dbg.disarm();                                 // no more pauses; let the run finish
```

Pause phases:

- `before-step` covers breakpoints, `pause`, step-over, run-to-step and `pauseAtStart`;
- `before-verify` and `before-heal` are reached only through `stepInto`;
- `failed` is pause on failure, which happens before the journey fails.

`retry` and `skip` are valid only in `before-step` and `failed`. A command
that is not valid in the current state throws `DebugStateError` (HTTP 409 in
routes).

These events go on the run's `EventBus`, typed as `DebugEvent` in core:

- `debug.attached` and `debug.detached`;
- `debug.paused` and `debug.resumed`;
- `debug.stepStarted`, `debug.stepFinished`, `debug.stepSkipped` and `debug.stepEdited`;
- `debug.evaluated`;
- `debug.finished`.

**Live view.** Call `startScreencast(page, { maxFps, quality, onFrame })`.
On Chromium this uses CDP `Page.startScreencast` (JPEG). Acks are delayed to
cap the frame rate, which is Chromium's own backpressure. If `onFrame`
returns `false`, the frame is dropped. On Firefox and WebKit (or with
`mode: 'screenshot'`) it falls back to periodic screenshots. Frame
`metadata` (`deviceWidth`, `deviceHeight`, `pageScaleFactor`, scroll
offsets) maps client coordinates to CSS pixels for `input`.

**Picker.** Each candidate has the following fields:

- `candidate` and `description`;
- `count`, the number of live matches;
- `unique`, true when it matches exactly one element and that element is the picked one;
- `stability` (0 to 1), which penalises generated ids and classes, `nth-of-type`, long chains and text with digits;
- `notes`;
- `ezTarget` (for example `the "Submit order" button`) and `ezStep` (for example `Click the "Submit order" button`, parsed to check it);
- `ezResolves`, which is true when `describeTarget(ezTarget)` resolves strictly to the same element.

The order is: unique before non-unique, then by stability, with XPath always last.

## 3. Studio routes

`src/studio/routes/` exports framework-agnostic route definitions:

```ts
interface RouteDef { method: 'GET'|'POST'|'PUT'|'DELETE'; path: string | RegExp; handler(ctx: RouteContext): RouteResponse | Promise<RouteResponse> }
// ctx: { method, path, params (RegExp groups, decoded), query, body (parsed JSON) }
// RouteResponse: { status?, json } | { status?, body, contentType, headers? } | { sse(sink) => unsubscribe }
```

Handlers throw `HttpError` from `runs.ts`. Engine errors are mapped as follows:

- 409 for the debugger state;
- 400 for bad input or an unparseable `.ez` line;
- 404 when something is missing;
- 422 when an uploaded bundle cannot be opened.

### Wiring into `server.ts`

Wiring takes about ten lines. Mount the routes inside `api()`, after the
existing auth, `Content-Type` and body parsing, so they keep the current
model: the token is required, a GET may use the cookie, and a write needs
the token header plus `application/json`.

```ts
import { DebugSessionManager, debugRoutes, traceRoutes, serveRoute } from './index.js';

const debug = new DebugSessionManager(ctx);
const extraRoutes = [
  ...debugRoutes(debug),
  ...traceRoutes({ outputDir: () => outputDirOf(ctx), cwd }),
];
// in api(), right after `const body = isWrite ? await readJson(req) : {};`
if (await serveRoute(extraRoutes, req, res, url, body)) return;
// in close():
await debug.close();
```

The SSE frames of `serveRoute` are `id:`, optionally `event:`, then `data: <json>`.
SSE `send()` returns `false` when the socket buffer is full, and the frame
stream then drops frames for that client.

### Debug routes

| Method | Path | Body or query | Result |
|---|---|---|---|
| POST | `/api/debug/sessions` | `{ journey, breakpoints?, pauseOnFailure?, pauseAtStart? (default true), timeTravel? (default true), browser?, headed? }` | 202 `{ id, journeyId, events, frames }`; 409 if a session is running |
| GET | `/api/debug/session` | | `{ id, journeyId, state, result, debug: DebugState }` or `{ state: 'idle' }` |
| POST | `/api/debug/stop` | | Disarms the debugger and lets the run finish |
| POST | `/api/debug/command` | `{ command: pause, resume, stepOver, stepInto, runToStep, retry or skip; stepIndex?, stepId?, step? }` | `{ ok, debug }` |
| GET, POST | `/api/debug/breakpoints` | POST: `{ journeyId?, stepIndex? or stepId?, condition? (".ez" condition text or a Condition object), enabled? }` | List / 201 `Breakpoint` |
| DELETE | `/api/debug/breakpoints/:id` | | `{ ok }` |
| POST | `/api/debug/edit` | `{ step: ".ez text" or Step, index?, retry? }` | `{ step, debug }` |
| POST | `/api/debug/evaluate` | `{ step: ".ez text", commit? }` | `{ result: StepResult }` (masked) |
| POST | `/api/debug/pick` | `{ x, y, action?, value? }` | `PickResult` |
| POST | `/api/debug/validate` | `{ target: ".ez target" }` or `{ candidate }`, plus `highlight?` | `ValidateResult` |
| POST | `/api/debug/input` | `{ type: 'mouse', action, x, y, button?, clickCount? }`, `{ type: 'wheel', ... }`, `{ type: 'key', action, key }` or `{ type: 'text', text }` | `{ ok }` |
| GET | `/api/debug/events?after=N` | | SSE: replay, then live, ending with `done` |
| GET | `/api/debug/frames?fps=5` | | SSE `event: frame`, `data: { seq, at, metadata, jpeg (base64) }`, capped at 1 to 15 fps per client |

Picking, validation, input and evaluation are accepted **only while paused**.
Highlights are removed when the run resumes.

### Trace routes

| Method | Path | Result |
|---|---|---|
| GET | `/api/runs/:runId/traces` | `{ traces: TraceListItem[] }` |
| GET | `/api/runs/:runId/traces/:journeyId/:attempt` | `TraceFile` |
| GET | `/api/runs/:runId/traces/:journeyId/:attempt/steps/:pos/(before\|after)` | Self-contained HTML with the `SNAPSHOT_CSP` header (`sandbox`, no scripts, no network) |
| GET | `/api/runs/:runId/traces/:journeyId/:attempt/asset?path=` | Any file the trace references (gunzipped), and nothing else |
| GET | `/api/runs/:runId/traces/:journeyId/:attempt/bundle` | `application/zip` |
| GET | `/api/traces/diff?a=run/journey/attempt&b=run/journey/attempt` | `TraceDiff` |

Run ids go through `assertRunId`, journey ids must be slugs, and asset paths
must be listed in the trace, so no route can read outside the run directory.

## 4. Studio pages

The UI on top of these routes lives in `src/studio/client/pages/debug/` and
`src/studio/client/pages/trace/`.

- **Debugger** (`#/debug/<journey path>`, or F5 in the Journeys editor):
  gutter breakpoints (conditions are picked from the declarative condition
  types), F5/F8 continue, F6 pause, F10 step over, F11 step into, Ctrl+F10 run
  to cursor, Shift+F5 stop, Ctrl+Shift+F5 restart, F9 toggle breakpoint; the
  live screencast with input forwarding, the element picker (Alt+I) and
  locator validation; Variables, Step, Console, Network, Stack and
  Breakpoints panels; edit-and-continue ("Retry with this step", "Skip",
  "Apply to file", which keeps the step id) and the step console.
- **Trace viewer** (`#/trace`, `#/trace/run/<runId>/<journeyId>/<attempt>[/<stepId>]`,
  `#/trace/uploaded/<id>`, and the run-detail tab `#/runs/<runId>/<journeyId>/<stepId>/trace`):
  filmstrip, step list, sandboxed snapshots (before/after, side by side,
  zoom, viewport, pick), Action/Conditions/Network/Console/Evidence tabs,
  compare with another run (default: the last passing one), bundle export
  and "Open trace…" (Alt+O) for `.eztrace.zip` bundles and EZTest browser trace zips. Keys: `[` `]`
  previous/next step, `b` before/after, `s` side by side, `p` pick, `c` compare.

Extra routes used by these pages:

| Method | Path | Result |
|---|---|---|
| GET | `/api/debug/details?index=N` | Live details of a step: resolved locator, candidates tried, heal ladder, conditions, its network and console (masked) |
| POST | `/api/debug/hit` | `{ x, y }`: the element under the point (tag, label, box), paused only |
| GET | `/api/traces/journey/:journeyId` | Runs holding a trace of the journey, newest first |
| POST | `/api/traces/upload` | `{ name, data: base64 }`: opens an EZTest trace bundle or browser trace (integrity checked), kept in memory |
| POST | `/api/runs/:runId/browser-trace` | `{ path }` of a run's `trace` evidence zip: opens that browser trace like an upload |
| GET | `/api/traces/uploaded/:id[/steps/:pos/(before\|after)\|/asset?path=]` | An uploaded trace |
| POST | `/api/traces/inspect`, `/inspect/hit`, `/inspect/pick`, `/inspect/close` | Element picking on a static snapshot loaded in a headless page |

The Studio page CSP allows `frame-src 'self'` so snapshot iframes can load.

## Known limits

- Snapshots use an in-page serializer on every engine (no CDP `DOMSnapshot`). Closed shadow roots, canvas pixels, CSS `url()` backgrounds and cross-origin iframes are not captured, and `<img srcset>` is dropped.
- The element picker resolves inside open shadow roots but not into iframes: a point over an iframe yields the iframe element.
- Cancelling a debug run waits for the planned `RunOptions.signal`. Until then, `stop` disarms the debugger and lets the run finish.

## Reading traces from the command line

`eztest trace` prints a time-travel trace without Studio. It works in terminals, CI logs and coding agents:

```bash
eztest trace list eztest-results/run-…                      # journeys with a trace
eztest trace steps eztest-results/run-… bob-order           # n, status, duration, intent, error
eztest trace step eztest-results/run-… bob-order 4          # locators tried, heal, checks, URLs
eztest trace snapshot eztest-results/run-… bob-order 4 --before -o step4.html
eztest trace network eztest-results/run-… bob-order [4]     # requests (one step or all)
```

A step is given by its number from `steps` or by its step id. `--json` prints JSON for scripting. Snapshots are written as the same self-contained, script-free HTML that the Studio trace viewer shows.
