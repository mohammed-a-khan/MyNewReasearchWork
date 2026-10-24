# Architecture

EZTest is one npm package (`@eztech/eztest`, with the `eztest` command) made of internal modules. Each module has a public barrel (`src/<module>/index.ts`) and is published as a namespace (`import { docs } from '@eztech/eztest'`) and as a subpath (`@eztech/eztest/docs`).

```
            .ez / YAML / JSON journeys          eztest.config.yaml (+ env layers)
                       │                                   │
                  intent (grammar)                    config (validate, ENC, masking)
                       │                                   │
                       └──────────────► engine ◄──────────┘
                                          │  wires handlers from config
         ┌──────────────┬─────────────┬───┴──────────┬──────────────┬─────────────┐
     identity         data         surfaces         docs           lenses        heal
  (login, MFA,    (find/lease/   (API, SOAP,    (PDF extract,   (a11y,       (verified
   sessions,        create,       GraphQL,       reconcile,      security,     T0→T2
   tokens)          cleanup)      WS, DB)        three-way)      visual)       ladder)
         └──────────────┴─────────────┴───┬──────────┴──────────────┴─────────────┘
                                          │
                                       runner  (strict locators; post-conditions;
                                          │      evidence vault; ledger; events)
                                          │
                                       browser (EZTest's own driver: CDP for Chrome, Edge,
                                          │      Chromium, Electron; WebDriver BiDi for Firefox)
                                          ▼
                          run dir: run.json, evidence-manifest.jsonl (hash chain),
                          screenshots, aria/html, network/console logs, traces, downloads
                                          │
                     insights (history, flaky, clustering, triage, readiness, impact)
                                          │
                     report (HTML, JSON, JUnit XML)     alm-ado (publish)   perf (Web Vitals)   load (EZTest Load, docs/load.md)
```

## Browser driver

`src/browser` (`@eztech/eztest/browser`) is EZTest's own browser driver; every module that touches a page imports it (`import { chromium, type Page } from '../browser/index.js'`).

- **Chrome, Edge, Chromium and Electron** over the Chrome DevTools Protocol, through a pipe or a WebSocket.
- **Firefox** over WebDriver BiDi, the remote protocol built into Firefox.
- **No Safari/WebKit**: `browser: webkit` fails with a clear message.

It has its own selector engine (CSS, XPath, text, role, label, test id, chained and shadow-piercing), actionability checks and auto-wait, network interception, HAR, tracing, video and device emulation. Binaries come from `EZTEST_CHROMIUM_PATH` / `EZTEST_FIREFOX_PATH`, the cache filled by `eztest install-browsers` (`EZTEST_BROWSERS_PATH`, default `~/.cache/eztest/browsers`), or an installed Chrome, Edge or Firefox. See [browser-driver.md](browser-driver.md).

## Design rules

1. **Verified, not assumed.** A healed step counts only when its post-conditions hold. Comparisons fail on empty input: zero rows extracted, zero fields compared or no data are failures, never passes.
2. **No silent no-ops.** Unsupported options throw `NotSupportedError`. Unknown lenses or handlers fail clearly.
3. **Evidence is tamper-evident.** Each artifact's SHA-256 is chained into `evidence-manifest.jsonl`. Triage and readiness may only cite evidence ids that exist.
4. **Secrets stay out of output.** Secret handles are resolved only when used. A masker covers logs, reports and errors. EZTest has no hard-coded keys.
5. **Safe by default.** No `eval` or `new Function`. Shell commands use argument arrays. TLS verification cannot be disabled. Only idempotent requests are retried. Cached sessions are re-checked before use.
6. **Deterministic.** EZTest uses no AI provider. Synthetic data is seeded. Reports are sorted deterministically.
7. **No other testing tool.** EZTest depends on no Playwright, Selenium, Puppeteer, WebdriverIO, Appium, WinAppDriver, Cypress, Sikuli or AutoIt, in code, packages or the Docker image. `test/legal/no-testing-tools.test.ts` checks `package.json`, the lockfile, the source, `dist/` and the published tarball. It also fails when product code (the CLI, the config schema, Studio, `src/`) names a testing tool it would export to, import from or call: EZTest has no Pact, WireMock, Xray, Zephyr, TestRail, qTest, Octane, Mailpit, MailHog, CTRF or Playwright-trace integration, and builds its own (EZTest contracts on the results server, its own mock server, SMTP sink, traces and reports). The owner-approved migration importers may read other tools' test *files* to migrate them; they import nothing from the tools.

## Run directory

| File | Content |
|---|---|
| `run.json` | Full `RunResult`: journeys, steps, statuses (incl. `passed-healed`), conditions, ledger |
| `evidence-manifest.jsonl` | Hash-chained evidence entries (`eztest evidence verify`) |
| `journeys/<id>/attempt-N/...` | Screenshots, aria snapshots, HTML, console and network logs |
| `heal-proposals.json` | Verified heals ready for review (old → new locator) |
| `report.html` / `report.json` / `junit.xml` | Reports |
| `documents/*.html` | Three-way document check reports |

## Extending

- **Studio:** route modules, SSE topics, pages, palette commands and run-detail tabs are covered in [studio.md](studio.md).

- **Platform drivers:** journeys with `Platform: android|ios` (or another platform) run through a `PlatformDriver` (`src/runner/platform.ts`; `RunOptions.platformDrivers` or `registerPlatformDriver`). The mobile driver and its reusable executor are described in [mobile.md](mobile.md#writing-a-platform-driver).
- **Non-browser surfaces:** `RunOptions.stepInterceptors` see every step first, and `setActiveSurface()` lets an active surface answer conditions. The desktop and legacy ladder (`@eztech/eztest/desktop`, `@eztech/eztest/legacy`: Electron, Windows/Java agents, SAP GUI, TN3270, image/OCR) is built on these; see [desktop-and-legacy.md](desktop-and-legacy.md).

- **Custom steps:** pass `customSteps` to `createEngine(..., { runOptions })`, then call them with `Run step "name" with a=1`.
- **Lenses:** implement `{ name, afterStep(page, step, ctx) }` and pass it in `runOptions.lenses`.
- **Data providers:** implement `DataProvider` (`supports`, `find`, `create`, `delete`) and register it with `DataFabric`.
- **Secret stores:** implement `SecretStore` (`get(key)`) and register it with the `SecretRegistry`.

## EZTest's own tests

EZTest's test suite (`test/**/*.test.ts`) runs on its own test runner, the testkit in `tools/testkit`. It is a development tool of this repository: it is not in `files`, not compiled into `dist/` and not part of the published package. No other test runner, assertion or mocking library is a dependency of any kind (`test/legal/no-testing-tools.test.ts`).

| Part | File | Role |
|---|---|---|
| Test API | `tools/testkit/index.ts` (tests import `test/support/testkit.ts`) | `describe` / `it` (`.skip`, `.only`, `.todo`, `.each`, `.skipIf`, `.runIf`), hooks, `onTestFinished`, `expect`, `vi` |
| Assertions | `expect.ts`, `equals.ts`, `asymmetric.ts`, `format.ts`, `diff.ts` | Matchers, `.not` / `.resolves` / `.rejects`, `expect.poll` / `expect.soft`, deep equality, value printing and the "- Expected / + Received" line diff |
| Mocks | `mock.ts` | `vi.fn`, `vi.spyOn`, `vi.waitFor`, `vi.stubEnv` (no module mocking or fake timers: the suite uses real modules and clocks) |
| Loader | `loader.mjs`, `register.mjs` | Node module hooks: TypeScript through esbuild (cached), `.js` imports of `.ts` files, `__dirname` / `require` for project files, the config's module swaps |
| Worker | `worker.mjs`, `runtime.ts` | One process per test file (a fresh module graph): collect, run hooks and tests with timeouts and retries, report over IPC, report open handles |
| Runner | `cli.mjs` | Discovery (include / exclude, path filters, `-t`), scheduling over `--workers` (slowest files first), watchdog for stuck workers, reporters (default, verbose, dot, JUnit), summary and exit code |

`testkit.config.mjs` holds the suite's settings: include pattern, 60 s test and hook timeouts, the sandbox browser links (`globalSetup`) and, with `EZTEST_BROWSER=firefox`, the swap of `src/browser/index.ts` for `test/support/firefox-as-chromium.ts`. The testkit's own tests are in `test/testkit/`.
