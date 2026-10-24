# EZTest browser driver

<!-- Two sections: the driver (transport, launcher, pages, network, input,
     locators) and the selector engine. Keep both when merging. -->

<!-- BEGIN SECTION: driver -->
## Driver

EZTest drives browsers with its own code in `src/browser/`. Chromium-family
browsers (Chromium, Chrome, Edge, Electron) are driven over the **Chrome
DevTools Protocol (CDP)**. Firefox is driven over **WebDriver BiDi**, the
W3C protocol built into Firefox, behind the same interfaces (see "Firefox
engine" below). Safari / WebKit is not supported.

EZTest depends on no other testing or automation tool (no Playwright,
Selenium, Puppeteer, WebdriverIO, Appium): the driver uses only Node
built-ins, plus the page-side selector engine described below. The browsers
themselves are the only outside programs it starts.

    import { chromium, firefox, electron, devices, type Page } from '@eztech/eztest/browser';

### Layers

```
index.ts           the public module @eztech/eztest/browser: chromium, firefox, webkit (unsupported), electron, devices, selectors, types
locator.ts         Locator / FrameLocator: lazy, strict, chainable, auto-waiting
actions.ts         resolve -> engine actionability check -> real input events, with retries and call logs
firefox/           the WebDriver BiDi engine (see "Firefox engine")
chromium/          the CDP engine
  browser.ts       ChromiumBrowser, ChromiumContext (Target.createBrowserContext), downloads, ChromiumBrowserType
  page.ts          ChromiumPage: its target sessions (page + out-of-process iframes), events, emulation, screenshots
  frame.ts         ChromiumFrame: lifecycle, execution contexts (main world + isolated engine world), navigation
  exec-context.ts  evaluate via Runtime.callFunctionOn with the tagged-JSON codec (serializer.ts)
  handles.ts       JSHandle, ElementHandle
  network.ts       Request / Response / Route / WebSocket, Fetch-domain interception, HTTP auth
  input.ts         Keyboard (US layout in input/us-layout.ts), Mouse, Touchscreen
  client-certs.ts  TLS client certificates (see "Known differences")
  video.ts         recordVideo
transport/         pipe and WebSocket transports, CDPConnection with flat sessions
launcher/          find.ts (binary lookup), launch.ts (process), install.ts + unzip.ts (eztest install-browsers)
injected/          page-side code: contract.ts (driver <-> engine), engine.ts (selector engine), driver-helpers.ts
tracing.ts har.ts request.ts electron.ts devices.ts video/webm.ts zip-writer.ts
```

- **Transport.** By default the browser is started with
  `--remote-debugging-pipe` (fd 3 to the browser, fd 4 back, NUL-delimited
  JSON). No TCP port is opened. `connectOverCDP(http://host:port | ws://...)`
  and Electron use the WebSocket transport: our own small RFC 6455 client
  (`transport/websocket.ts`, on `node:http`). Node 22's global `WebSocket`
  is not used: on Node 22.22 a process stops being able to talk over it
  after about 4096 sent messages in total (connections drop with code 1006,
  new ones too), which a long run reaches easily.
- **Sessions.** Every target is attached in flat mode (`Target.setAutoAttach`
  with `flatten: true` and `waitForDebuggerOnStart`), so new pages, popups,
  out-of-process iframes and workers are set up (emulation, init scripts,
  routes) before they run their first script.
- **Protocol tracing.** `EZTEST_DEBUG=protocol` logs every message to stderr
  (`browser` logs launches and targets, `*` everything; `EZTEST_DEBUG_MAX`
  caps the line length).
- **Worlds.** Locators and actions run in an isolated world
  (`__eztest_engine_world__`) where the selector engine and the driver helpers are
  installed. Page scripts cannot see or change them. `evaluate()` runs in the
  page's main world.
- **Evaluate.** Arguments and results travel as tagged JSON: `undefined`,
  `NaN`, `±Infinity`, `-0`, BigInt, Date, RegExp, URL, Error, Map, Set, typed
  arrays, cycles and shared references survive. Handles inside arguments
  arrive as the objects they point to. A string is evaluated as an
  expression (or as statements); if it evaluates to a function, that
  function is called with the argument.
- **Load states.** `load` and `domcontentloaded` come from the frame's
  lifecycle events for its current document. `networkidle` is **our own
  rule**: the document reached `load` and the page has had no request in
  flight for 500 ms. EventSource streams and requests pending for more than
  10 s (long-polls) are not counted.
- **Actions.** Each attempt re-resolves the locator (strict: exactly one
  element), asks the engine whether the action can happen, scrolls into view,
  takes the click point from the engine, adds the iframe offsets, and sends
  real input events. A click waits for a navigation it starts to commit,
  also one the page starts after async work (the context's
  `navigationWindow`, default 150 ms of quiet, at most 2 s); one that never
  commits fails the click. Timeouts end with `locator.click: timed out after
  5000 ms` and what EZTest was doing (for example `div#cover covers the
  element and would receive the pointer event`).

### Supported browsers

| Browser                  | How                                                   |
|--------------------------|-------------------------------------------------------|
| Chromium / Chrome for Testing | `eztest install-browsers`, or any binary          |
| Google Chrome            | `channel: chrome` (also chrome-beta, -dev, -canary)  |
| Microsoft Edge           | `channel: msedge` (also msedge-beta, -dev, -canary)  |
| Chrome headless shell    | `eztest install-browsers chrome-headless-shell`       |
| Electron                 | `electron.launch({ executablePath, args })`           |
| Firefox (release, ESR 128+, Beta, Nightly) | `browser: firefox`, `firefox.launch()`, `eztest install-browsers firefox` |
| WebKit / Safari          | not supported                                         |

Binary lookup order: `executablePath`; `channel` at the standard install
paths of Windows, macOS and Linux; `EZTEST_CHROMIUM_PATH` / `CHROME_PATH`;
the EZTest browser cache (`EZTEST_BROWSERS_PATH`, default
`~/.cache/eztest/browsers`, `~/Library/Caches/eztest/browsers`,
`%LOCALAPPDATA%\eztest\browsers`); an installed Chrome or Edge; on Linux,
a system Chromium (`/usr/bin/chromium`, `/usr/bin/chromium-browser`, snap).
Firefox: `executablePath`; `channel` (firefox, firefox-esr, firefox-beta,
firefox-nightly, firefox-developer-edition); `EZTEST_FIREFOX_PATH` /
`FIREFOX_PATH`; the EZTest cache; an installed Firefox. `eztest doctor`
prints what it found (and from where) and how to install what is missing.

### Installation

```
eztest install-browsers                       # Chrome for Testing, latest Stable
eztest install-browsers chromium@141.0.7390.54
eztest install-browsers chrome-headless-shell --browser-version 141.0.7390.54
eztest install-browsers msedge-check          # is Edge installed? where?
eztest install-browsers firefox               # latest Firefox release from archive.mozilla.org (firefox-esr, firefox@140.4.0esr)
eztest install-browsers --list
```

- The version comes from `chromium@<version>` / `--browser-version`,
  `EZTEST_CFT_VERSION`, or a version index in the Chrome-for-Testing
  `last-known-good-versions` format (`--versions-url`,
  `EZTEST_CFT_VERSIONS_URL`; default the public index). Mirrors: 
  `--download-base` / `EZTEST_CFT_DOWNLOAD_BASE`.
- The archive is verified against the MD5 and CRC32C the storage server
  reports (`x-goog-hash`) and, with `--sha256`, against an expected SHA-256.
  Without any checksum the install fails unless `--insecure-skip-checksum`.
- `HTTPS_PROXY` / `NO_PROXY` are honoured. (`--version` belongs to the
  `eztest` CLI itself, hence `--browser-version`.)

### Launch defaults

- A fresh temporary profile per launch, removed on close. The browser runs
  in its own process group; `close()` sends `Browser.close`, then kills the
  whole group, so no renderer or GPU process is left behind (also when the
  test process exits).
- Headless by default. A headless launch without `executablePath` /
  `channel` prefers a **chrome-headless-shell** build when one is installed
  (lighter and about twice as fast to navigate); otherwise the full browser
  runs with `--headless=new`. `EZTEST_HEADLESS_SHELL=0` turns the preference
  off. The headless shell does not isolate sites by default; pass
  `args: ['--site-per-process']` to get out-of-process iframes there. Quiet flags: no first-run UI, no background networking, component
  updates, sync, translation or popup blocking.
- **No `--no-sandbox` by default.** It is added only when running as root
  (uid 0), the usual case in Docker containers, where Chromium cannot start
  sandboxed. `EZTEST_CHROMIUM_SANDBOX=0` turns it off for a non-root user
  too (the Docker image sets it: containers allow no unprivileged user
  namespaces); `=1` or `chromiumSandbox: true` forces the sandbox.
- `slowMo` slows input actions down.

### The module and the test suite

`src/browser/index.ts` (`@eztech/eztest/browser`) exports the browser types
`chromium`, `firefox` and `webkit` (which rejects with a clear message),
`electron`, `devices`, `selectors`, `TimeoutError`, the driver's building
blocks (transports, launchers, finders, the installer) and the types `Page`,
`Locator`, `BrowserContext`, `Browser`, `Frame`, `FrameLocator`,
`ElementHandle`, `JSHandle`, `Request`, `Response`, `Route`, `Dialog`,
`ConsoleMessage`, `CDPSession`, `Download`, `BrowserContextOptions` ...
Every EZTest module that touches a page imports it.

- `npm run typecheck` checks `src`, `test` and `examples` against it.
- `npm test` runs the whole suite on it (Chromium by default).
  When the machine's binaries live outside EZTest's lookup,
  `testkit.config.mjs` links them into a temporary folder laid out like the
  `install-browsers` cache (`EZTEST_TEST_BROWSER_DIRS`; headless launches
  then use the headless shell and headed ones full Chrome, as in a real
  install) and sets `EZTEST_FIREFOX_PATH`.
- `npm run test:acceptance` runs `test/acceptance` against real sites and
  apps, under `xvfb-run -a` when there is no display (recording needs a
  visible browser). `test/acceptance/web` covers seven public practice sites
  (the-internet, demoqa, practicetestautomation, rahulshettyacademy,
  saucedemo, parabank, automationexercise): each scenario is recorded by
  driving the visible browser with the mouse and keyboard, written by hand
  in `.ez` (`test/acceptance/web/journeys/<site>`) and as code journeys, and
  each must replay green. They run only with `EZTEST_ONLINE=1` (the script
  sets it); a site that does not answer is skipped with the reason, nothing
  is retried. `EZTEST_BROWSER=firefox` runs them on Firefox.
- `test/legal/no-testing-tools.test.ts` fails if a testing tool appears in
  `package.json`, the lockfile, the source, `dist/` or the tarball.

### Known differences

- **The mouse leaving the page (Firefox).** WebDriver BiDi keeps the pointer
  inside the viewport. A move to a point outside it moves to the edge and
  then dispatches the `mouseout` (no related target) and `mouseleave` events
  a browser fires when the pointer leaves the document, with the requested
  coordinates; they are untrusted events. Chromium fires them itself.

- **HTML5 drag and drop with the mouse (Firefox).** Firefox starts the drag
  and fires `dragover` as the mouse moves, but its WebDriver ends the drag on
  release without a `drop`. On release the driver fires the `drop` (with the
  data the page put in the drag) on the element under the pointer when its
  last `dragover` was cancelled, and then the `dragend`; both are untrusted
  events. Drags inside a child frame are not covered. Chromium drops by itself.

- **Client certificates.** Chromium has no protocol command to present a
  TLS client certificate. Requests to an origin with a configured certificate
  are intercepted and performed from Node (with the certificate), and the
  browser gets the response. The server certificate is then verified by
  Node's trust store (system CAs, `NODE_EXTRA_CA_CERTS`,
  `tls.setDefaultCACertificates`), not the browser's; responses are buffered
  (no streaming), HTTP/1.1 only; WebSockets to that origin are not covered.
- **Video.** `recordVideo` writes WebM (VP8). Frames come from the
  screencast; they are encoded by the browser under test itself (WebCodecs
  `VideoEncoder` in a scratch page) and muxed by our own WebM writer when
  the page closes. Frame timing follows screencast frames (pages that do not
  repaint produce few frames).
- **Action overlays and chapters.** While recording, each step burns a caption
  (its text) and a highlighted box around its target into the frames, drawn
  through EZTest's own overlay script and removed before any evidence
  screenshot. A WebVTT chapters track (one cue per step) is written next to the
  `.webm` and recorded as `video-chapters` evidence; the HTML report and the
  Studio results **Video** tab play the video with a clickable step list that
  seeks to each step.
- **Tracing.** `context.tracing` records actions with DOM snapshots
  (before / after, target marked), network with bodies, console messages and
  screencast frames in the zip layout EZTest's trace importer reads. It is not
  meant for other trace viewers; sources and action logs are not recorded.
- **HAR.** `routeFromHAR` replays HAR 1.2 files (and HAR zips). Recording
  (`update: true`) is not implemented.
- **storageState** saves the localStorage of origins open in the context's
  pages (not of every origin ever visited); loading visits each origin on a
  scratch page whose document the driver serves itself.
- **ariaSnapshot** comes from the selector engine and is a simpler YAML than
  other tools produce.
- **Network throttling** is `context.setNetworkConditions({ latency,
  downloadThroughput, uploadThroughput })` (driver API).
- **evaluate across navigations.** A main-world `evaluate()` whose document
  is replaced while it runs is retried on the new document (up to twice)
  instead of failing with "Execution context was destroyed".
- **Clock:** there is no `page.clock`; `contextClock(context)` (`src/browser/clock.ts`)
  is EZTest's own fake time for a whole context (Chromium and Firefox): `install`,
  `setSystemTime`, `setFixedTime`, `pause`, `pauseAt`, `resume`, `fastForward`,
  `runFor`, `runAll`, `runToLast`, `useRealTime`. It is an init script that replaces
  `Date`, timers, `requestAnimationFrame`, `requestIdleCallback` and `performance.now`
  in every document; `__eztestClock.native` keeps the real timers for EZTest's own
  in-page helpers. See [ez-language.md](ez-language.md#clock-and-time).
- **Not implemented:** custom selector engines (`selectors.register`),
  `page.accessibility`, `page.coverage`, HAR recording, the
  `connect()` wire protocol of other tools, `locator.or()` / `locator.and()`.
### Firefox engine (WebDriver BiDi)

`src/browser/firefox/` drives Firefox over WebDriver BiDi with our own
client (no packages; the WebSocket transport above). It was written from the
W3C WebDriver BiDi specification and Mozilla's documentation; tested on
Firefox 157 (ESR 128+ is the minimum for the commands used).

```
firefox/
  connection.ts    BiDi message correlation ({id, method, params} / success / error / event)
  launch.ts        binary lookup, user.js preferences, process start, ws URL from stderr
  install.ts       eztest install-browsers firefox: Mozilla archive + SHA512SUMS
  browser.ts       FirefoxBrowser (session, subscriptions, event routing), FirefoxContext (user context), FirefoxBrowserType
  page.ts          FirefoxPage: frame tree, lifecycle, realms, dialogs, console, bindings, screenshots, PDF
  frame.ts         FirefoxFrame: navigate, engine sandbox, owner element
  realm.ts         FirefoxRealm: evaluate / callEngine over script.callFunction, LocalValue / RemoteValue mapping
  network.ts       requests, responses, bodies, interception, auth, net error names
  input.ts         keyboard / mouse / wheel / touch over input.performActions
```

**Design.** The engine-independent code is shared, not copied: `FirefoxPage`,
`FirefoxFrame`, `FirefoxContext` and `FirefoxRealm` subclass the classes in
`chromium/` (which hold the page, frame, context and handle API) and
override their protocol members; the Chromium classes route their few CDP
calls through hooks for this (`createEngineWorld`, `startNavigation`,
`navigationError`, `requestMainWorld`, `getProperties`, `releaseHandle`,
`contentFrameOf`, `setInputFilePaths`, `RouteBackend`, `runRouteChain`,
`browserVp8Encoder`). `locator.ts` and `actions.ts` are unchanged on
Firefox; `elementScreenshot` now reads the scroll offset from the page
(`visualViewport`) instead of CDP, so no engine leaks remain there. Anything
that still reaches for CDP on Firefox fails with "... uses the Chrome
DevTools Protocol, which is not available in Firefox".

**Launch.** Binary: `executablePath`; `channel` (firefox, firefox-esr,
firefox-beta, firefox-nightly / nightly, firefox-developer-edition) at the
standard paths of Linux, macOS and Windows; `EZTEST_FIREFOX_PATH` /
`FIREFOX_PATH`; the EZTest cache (`<cache>/firefox-<version>/`); an
installed Firefox. Started with `--remote-debugging-port=0 --profile <tmp>
--no-remote --new-instance [--headless] --remote-allow-system-access`; the
WebSocket URL is read from stderr ("WebDriver BiDi listening on ..."). The
temporary profile gets our own `user.js` (`firefoxPreferences()`): no
telemetry, studies, updates, remote settings, safe browsing, first-run or
welcome pages, session restore, favicon requests or back-forward cache;
popups allowed; a mouse-like pointer (`ui.primaryPointerCapabilities`, as
the Chromium launch reports a fine pointer with hover); lazy images loading
within about 1250px as in Chromium; the remote agent speaking BiDi
(`remote.active-protocols`).
Without a `proxy` option the profile follows `HTTPS_PROXY` / `HTTP_PROXY` /
`NO_PROXY` (Firefox's system mode), as Chromium does, and connects directly
when none is set. On Linux the temporary profile starts from a copy of the
user's shared NSS certificate database (`~/.pki/nssdb`, or `EZTEST_NSSDB`),
the one Chromium trusts, so a company's TLS-inspecting proxy CA is trusted
by both browsers.
`firefoxUserPrefs` adds or overrides preferences. The browser runs in its
own process group; `close()` sends `browser.close`, then kills the group and
removes the profile. `EZTEST_FIREFOX_SYSTEM_ACCESS=0` drops
`--remote-allow-system-access` (see emulation below).

**Install.** `eztest install-browsers firefox` (latest release),
`firefox-esr` (latest ESR) or `firefox@140.4.0esr` downloads
`https://archive.mozilla.org/pub/firefox/releases/<v>/<platform>/<locale>/<file>`
(`--download-base` / `EZTEST_FIREFOX_DOWNLOAD_BASE` for mirrors,
`--locale`), and checks its SHA-512 against the release's `SHA512SUMS`
(without a matching line it refuses, unless `--insecure-skip-checksum`).
Unpacking uses `tar` (Linux .tar.xz / .tar.bz2), `hdiutil` (macOS .dmg) or
the installer's `/ExtractDir` (Windows). The SHA512SUMS file itself is not
GPG-verified; it comes over HTTPS from the same server.

**Object model.**

| Driver | WebDriver BiDi |
|--------|----------------|
| BrowserContext | user context (`browser.createUserContext`, with `acceptInsecureCerts` and `proxy`) |
| Page | top-level browsing context, each in its own window (`browsingContext.create {type: window}`), so it is never a throttled background tab |
| Frame | child browsing context (`contextCreated` / `contextDestroyed`) |
| main world / engine world | window realm / sandbox realm `__eztest_engine_world__` (`script.realmCreated`), selector engine installed on first use |
| JSHandle / ElementHandle | `handle` (resultOwnership root, freed with `script.disown`) / `sharedId` (valid in every realm of the document, so moving an element between worlds is free) |
| evaluate | `script.callFunction` with our tagged JSON as LocalValue / RemoteValue arrays and objects; by-value results carry exceptions with name, message and stack |
| addInitScript | `script.addPreloadScript` (page: `contexts`, context: `userContexts`) |
| exposeBinding / exposeFunction | preload script with a `channel` argument; `script.message` -> callback -> answer by `script.callFunction` in the calling realm |
| goto / reload / goBack | `browsingContext.navigate` / `reload` (`wait: none`) / `traverseHistory`, then our lifecycle: `navigationCommitted`, `domContentLoaded`, `load`, `fragmentNavigated`, `historyUpdated`, `navigationFailed` |
| mouse / keyboard / wheel / touch | `input.performActions` (pointer `mouse` / `touch`, key, wheel); key values from the US layout table: characters, and the WebDriver code points (U+E000 block) for named keys |
| keyboard.insertText | `execCommand('insertText')` in the focused frame (like an IME commit: input events, no key events); key actions when nothing editable is focused |
| setInputFiles (paths) | `input.setFiles`; buffers go through the page-side DataTransfer helper as on Chromium |
| filechooser | `input.fileDialogOpened`; the session dismisses file dialogs (`unhandledPromptBehavior.file: dismiss`), like Chromium's file chooser interception |
| screenshot | `browsingContext.captureScreenshot` (`origin: viewport`, `document` for full page, `clip: box` for clip and element shots) |
| pdf | `browsingContext.print` |
| dialogs | `userPromptOpened` -> Dialog -> `browsingContext.handleUserPrompt` (unhandled: dismissed, beforeunload accepted) |
| console / pageerror | `log.entryAdded` (console / javascript) |
| downloads | `browser.setDownloadBehavior` + `downloadWillBegin` / `downloadEnd` |
| requests / responses | `network.beforeRequestSent` / `responseStarted` / `responseCompleted` / `fetchError`; a redirect is a new hop of the same BiDi request (`redirectCount`) |
| bodies | `network.addDataCollector` (response and request data) + `network.getData` |
| route | one `network.addIntercept` (beforeRequestSent) while any context has routes; `continueRequest` / `provideResponse` / `failRequest`; the same route chain as Chromium |
| httpCredentials | intercept `authRequired` + `network.continueWithAuth` (no credentials: cancel, the page gets the 401) |
| cookies | `storage.getCookies` / `setCookie` / `deleteCookies` with the user context partition |
| extra headers | `network.setExtraHeaders` (user context / page) |
| bypassCSP | a `responseStarted` intercept drops `Content-Security-Policy` headers (and `X-Frame-Options` where the CSP had `frame-ancestors`); `addScriptTag({content})` blocked by a `<meta>` CSP runs as a script of the main world |
| page.on('websocket') | BiDi has no WebSocket events: a preload script wraps the page's `WebSocket` class (a subclass of the original) and reports creation, frames sent / received, errors and close on a channel |
| offline | `emulation.setNetworkConditions {type: offline}` |
| locale / timezone / UA / geolocation / screen | `emulation.setLocaleOverride` (+ Accept-Language) / `setTimezoneOverride` / `setUserAgentOverride` / `setGeolocationOverride` / `setScreenSettingsOverride` |
| permissions | `permissions.setPermission` per origin; grants without an origin are applied to each origin before its document loads |
| viewport / deviceScaleFactor | `browsingContext.setViewport` |
| colorScheme, reducedMotion, forcedColors, media print, hasTouch, javaScriptEnabled: false | BiDi has no command: set on the top browsing context from Firefox's privileged scope (`prefersColorSchemeOverride`, `prefersReducedMotionOverride`, `forcedColorsOverride`, `mediumOverride`, `touchEventsOverride`, `allowJavascript`), which needs `--remote-allow-system-access` |
| recordVideo / tracing screenshots | BiDi has no frame stream: viewport captures about 10 times a second, encoded by the same WebM path as Chromium (WebCodecs VP8 in a scratch page of the browser under test) |

**Error texts.** Network errors are reported with Chromium's names where an
equivalent exists (`NS_ERROR_CONNECTION_REFUSED` -> `net::ERR_CONNECTION_REFUSED`,
`NS_ERROR_UNKNOWN_HOST` -> `net::ERR_NAME_NOT_RESOLVED`, blocked ports ->
`net::ERR_UNSAFE_PORT`, `route.abort(reason)` -> the reason's `net::ERR_*`), so
messages and assertions read the same on both engines. Unknown Firefox
names are passed through.

**Known differences and limits on Firefox.**

- **System access.** Color scheme, reduced motion, forced colors, print
  media, touch events and `javaScriptEnabled: false` use Firefox's
  privileged scope (`--remote-allow-system-access`, on for browsers EZTest
  launches). Without it those options are ignored with a warning. The BiDi
  port listens on 127.0.0.1 only and Firefox accepts one session, which
  EZTest holds.
- **javaScriptEnabled: false.** Firefox then runs no script in the page's
  realm, not even ours, so `evaluate()` runs in a sandbox of the document
  (same DOM, no page globals - there are none without JavaScript).
- **Not available (CDP only):** `newCDPSession`, `page.cdpSession()`,
  `connectOverCDP`, `newBrowserCDPSession`, the CDP screencast stream
  (`startScreencast` is emulated by polling captureScreenshot), the WebAuthn
  virtual authenticator, `Download.cancel()` (no BiDi command; a no-op).
- **Workers.** `page.on('worker')` and `worker.url()` work (BiDi
  `dedicated-worker` realms); Firefox 157 does not evaluate in worker realms
  over BiDi, so `worker.evaluate()` rejects saying so.
- **WebSockets** are observed from inside the page (see the table): sockets
  created in workers are not seen, and `window.WebSocket` is our subclass of
  the original.
- **Throttling.** `setNetworkConditions({ latency })` holds each request for
  `latency` ms (interception); throughput limits are not supported (warning).
- **Screenshots.** `omitBackground` and `scale: 'css'` with a
  deviceScaleFactor other than 1 are not supported (captures are in device
  pixels with Firefox's background). `contrast` emulation and `isMobile`
  (meta viewport) are not available; `serviceWorkers: 'block'` is not
  available per context; `bypassCSP` covers CSP headers and inline
  `addScriptTag`, not other effects of a `<meta>` CSP.
- **PDF.** `browsingContext.print` has no header / footer templates.
- **Client certificates** use the same Node-side fetch as on Chromium (the
  page's cookies come from `context.cookies()`).
- **Request postData** comes from the data collector; Firefox may not keep
  bodies of very large uploads (over 20 MB per resource).
- Attaching to a running Firefox is `firefox.connectOverBiDi(ws://host:port)`
  (see "Remote browsers" below); Firefox allows one BiDi session at a time.
- **Script errors that are not exceptions** (for example a `postMessage` to
  the wrong origin) are console errors, not `pageerror`, as in Chromium.
- **Runner steps that use CDP directly** (network throttling and mid-journey
  timezone / locale / user agent / device changes in `.ez`, touch swipe) say
  they need Chromium; use the journey headers (Timezone:, Locale:, Device:)
  on Firefox.

**Tests.** `test/browser/firefox-driver.test.ts` mirrors `driver.test.ts`
on Firefox (unit tests always; browser tests when a Firefox is found).
`npm run test:firefox` (`EZTEST_BROWSER=firefox npm test`) runs the whole suite with
`chromium` resolving to Firefox (`test/support/firefox-as-chromium.ts`,
which also drops Chromium command-line switches); tests that only make sense on Chromium skip themselves with the
reason in their title ("[skipped on Firefox: ...]"):

- `test/identity/vault.test.ts`: the WebAuthn virtual authenticator (CDP);
- `test/e2e/advanced-network.test.ts`: throttling and mid-journey emulation
  (the runner uses a CDP session);
- `test/lenses/visual-depth.test.ts` (3) and `test/e2e/visual-demo.test.ts`
  (2): the expected baseline keys name chromium (on Firefox the keys
  correctly say firefox);
- `test/browser/engine-conformance.test.ts` runs the spec expectations on
  Firefox but not the Chromium accessibility-tree oracle (CDP).

### Cross-browser runs

One run can cover several browsers:

```yaml
# eztest.config.yaml
browsers: [chromium, firefox, msedge]   # or: eztest run --browsers chromium,firefox
```

Entries are `chromium`, `chrome`, `msedge`, `firefox` and the channels
(`chrome-beta`, `msedge-dev`, ...); `webkit` is rejected. `browsers:` with two
or more entries overrides `browser:` / `channel:`. What changes:

- **The run plan** expands every journey into journey x browser units. A
  unit's id is `<journey id>@<browser>` (`checkout@firefox`), its name ends
  in ` [firefox]`, `JourneyResult.browser` says which browser ran it, and
  `${browser}` is a variable in its steps. `Depends on:` points at the
  prerequisite's unit on the same browser. Examples rows keep the browser
  last (`checkout-row1@firefox`), burn-in copies too (`checkout@firefox~rep2`).
  A run with one browser keeps plain ids, so existing history and
  baselines are unchanged.
- **`Browsers:`** (journey header; `browsers:` in YAML/JSON and the SDK)
  limits a journey to some browsers: `Browsers: chromium, msedge` for a
  Chromium-only feature. A journey whose list leaves out every browser of
  the run is recorded as skipped, with the reason.
- **Launching.** Each browser is launched (or attached to, below) once, up
  front, with its own context pool. In a cross-browser run a browser that
  does not start turns only its own units into errors
  (`BrowserLaunchError`); the other browsers run.
- **Sharding and locks.** `--shard i/n` deals out units, not journeys, so
  shards balance browsers too, and every machine computes the same plan
  (`eztest run --browsers chromium,firefox --shard 1/2 --plan` prints it).
  Resource locks (`Locks:`) are shared by a journey's units: two browsers
  never touch the same locked record at once.
- **Results.** `run.json` has the combined `summary` plus
  `browsers: { chromium: {...summary, version}, firefox: {...} }`;
  `environment.browser` lists the browsers and `environment.browserVersion`
  each version. The HTML report adds a Browsers section: per-browser
  counts and readiness, and a journey x browser grid that flags a failure on
  one browser only ("fails on firefox only").
- **History, flaky scores, triage, quarantine** work on unit ids, so each
  browser has its own history and flip rate. The Studio Quality Center's
  flaky board lists the units and a combined row per journey (the worst
  state over its browsers). `--last-failed` / `--only-failed` /
  `--failed-first` map units back to their journey.
- **Readiness** is decided for the whole run and, in `readiness.browsers`,
  for each browser's units alone: a Firefox-only failure is a NO_GO on
  Firefox and a GO on Chromium, and NO_GO combined.
- **Visual baselines** are keyed by the browser engine already
  (`--chromium-141`, `--firefox-157`); Chrome and Edge are Chromium builds and
  share the `chromium` key unless the key includes the version.
- **The Studio Run page** has a "Cross-browser run" group of checkboxes.

### Remote browsers

The runner can attach to a browser that is already running instead of
launching one. Remote browsers are reached over **the browser's own
protocol only**: the Chrome DevTools Protocol of Chrome / Edge / Chromium, or
WebDriver BiDi, the remote protocol built into Firefox. EZTest does not speak
other test tools' wire protocols, so it does not connect to a test-tool
server or to a WebDriver Grid session. A vendor grid works when it exposes
the browser's native CDP or BiDi endpoint (many offer a raw CDP WebSocket);
check the vendor's documentation for that endpoint.

```yaml
browser:
  name: chromium            # or msedge / chrome
  connect:
    cdpEndpoint: http://chrome-host:9222      # resolved via /json/version, or ws://.../devtools/browser/<id>
    headers:
      x-team: qa
    auth:
      token: secret://env/GRID_TOKEN           # Authorization: Bearer <token>
      # queryParam: token                      # ...or as ?token=<token> on the endpoint URL
      # username: qa / password: secret://...  # ...or HTTP basic authentication
    timeoutMs: 30000
```

```yaml
browser:
  name: firefox
  connect:
    bidiEndpoint: ws://firefox-host:9222      # the /session path is added when missing
```

A matrix can mix launched and remote browsers:

```yaml
browsers:
  - chromium
  - name: firefox
    connect: { bidiEndpoint: ws://firefox-host:9222 }
```

- **Start the remote browser** with its own flags: Chrome / Edge
  `--remote-debugging-port=9222` (add `--remote-debugging-address=0.0.0.0`
  or a port forward to reach it from another machine; a container such as
  `chromedp/headless-shell` does both); Firefox
  `--remote-debugging-port=9222` (and `--remote-allow-hosts` /
  `--remote-allow-origins` when it is not on localhost;
  `--remote-allow-system-access` for the emulation EZTest does in Firefox's
  privileged scope: colour scheme, touch, JavaScript off).
- **Headers and auth** go on the HTTP discovery request (`/json/version`)
  and on the WebSocket handshake. Values may be `secret://` references; they
  are resolved through the Identity Vault and masked everywhere.
  Credentials in the URL (`wss://user:pass@host`) become basic
  authentication.
- **Address rewriting.** A browser behind a port mapping or a proxy reports
  its own address in `/json/version` (`ws://127.0.0.1:9222/...`); the host,
  port and scheme are then taken from the endpoint that was asked, and the
  endpoint's query (a vendor token) is carried over.
- **Closing only what the run created.** The run creates its own browser
  contexts (Chrome: `Target.createBrowserContext`; Firefox: user contexts)
  and closes those, then disconnects (Firefox: `session.end`). The remote
  browser keeps running and its own tabs stay open.
- **run.json** records `environment.browserEndpoint` (`chromium: cdp
  http://chrome-host:9222`) without credentials or query values.
- **Limits of a remote browser:** downloads land on the remote machine
  (the run's download folder is local), and file uploads need the files at
  the same path on the remote machine. Firefox accepts one BiDi session at a
  time: a second client gets "session not created".

Driver API: `chromium.connectOverCDP(endpoint, { headers, timeout })`,
`firefox.connectOverBiDi(endpoint, { headers, timeout })`. Tests:
`test/browser/remote.test.ts` (a Chrome started separately, the same behind a
gateway that wants a token, a headless Chrome in Docker, a Firefox started
with `--remote-debugging-port`, and a matrix of a remote Firefox and a
launched Chromium) and `test/e2e/cross-browser.test.ts`.

<!-- END SECTION: driver -->

<!-- BEGIN SECTION: selector-engine -->
## Selector engine

The selector engine is the page-side half of the driver. It finds elements,
computes roles and accessible names, and decides whether an element is ready
for an action. The driver installs it as one self-contained script in an
isolated world of every frame, so page scripts can neither see nor change it.
It has no runtime dependencies and is written from the W3C specifications:

- WAI-ARIA 1.2 roles, states and the presentational-role conflict rules;
- HTML-AAM for implicit roles and native text alternatives;
- Accessible Name and Description Computation 1.2 (accname);
- CSS selectors, run by the browser's own `querySelectorAll`;
- XPath, run by `document.evaluate`.

### Where the code lives

| Path | What |
|------|------|
| `src/browser/injected/contract.ts` | Types shared with the driver: selector chains, `TextMatch`, actions, `InjectedEngine`, `ENGINE_GLOBAL`. |
| `src/browser/injected/engine-api.ts` | `EztestEngine`, the full engine surface (the contract plus the extras below). |
| `src/browser/injected/engine.ts` | Node side: `engineSource()` returns the engine as one JavaScript expression. |
| `src/browser/injected/page/*.ts` | The page side: `dom`, `roles`, `accname`, `states`, `visibility`, `selector`, `actionability`, `describe`, `values`, `main`. |
| `scripts/build-injected.mjs` | Writes `dist/browser/injected/engine.bundle.js` during `npm run build`. |

`engineSource()` reads the prebuilt `engine.bundle.js` when it exists, which
is the case in the published package. When it doesn't, as when running from
source with tsx or EZTest's testkit (`npm test`), it bundles `page/main.ts` in memory once per
process with esbuild (a devDependency). This works the same way as the
Studio client bundle. The result is an IIFE expression, about 36 KiB
minified, that evaluates to a fresh engine object. The driver stores that
object at `globalThis.__eztestEngine` in the engine world.

To switch the driver from its interim stub to this engine, change the one
line in `src/browser/injected/index.ts` to
`export { engineSource } from './engine.js';`.

### Selector chains

A locator is a chain of steps applied left to right to a working set that
starts as `[scope ?? document]`.

| Step | Matches |
|------|---------|
| `{css}` | `querySelectorAll` in each tree. Open shadow roots are pierced: each tree is queried separately, and the results are merged in shadow-including order. One selector does not cross a shadow boundary, so chain two css steps to go through a host. |
| `{xpath}` | `document.evaluate` with the scope as the context node: `//x` is global and `.//x` is scoped. XPath does not pierce shadow roots, which matches browser semantics. |
| `{role, name?, exact?, checked?, pressed?, expanded?, selected?, disabled?, level?, includeHidden?}` | Elements whose computed role matches. `none` and `presentation` are treated as the same role, and `image` is an alias of `img`. Elements hidden from assistive technology are skipped unless `includeHidden` is set. `name` is matched against the accessible name. |
| `{text, exact?}` | Elements whose rendered text matches. That text is the flat tree's text (shadow DOM and slots included, `script`/`style`/`template` ignored). `input[type=button|submit|reset]` match by their value. Only the innermost matches are kept: an element is dropped when one of its descendants matches. |
| `{label, exact?}` | Controls labelled by `<label for>`, a wrapping `<label>`, `aria-labelledby` or `aria-label`. |
| `{placeholder}`, `{altText}`, `{title}` | Elements whose `placeholder`, `alt` or `title` attribute matches. |
| `{testId, attr}` | Elements whose `attr` (default `data-testid`) equals the string exactly, or matches the regex. |
| `{nth}` | Keeps the n-th element (0-based). `-1` keeps the last one, and an index out of range gives an empty set. |
| `{hasText}` / `{hasNotText}` | Keeps elements whose text matches, or doesn't. |
| `{has: chain}` / `{hasNot: chain}` | Keeps elements that contain a match of the chain among their descendants, or don't. |
| `{visible: boolean}` | Keeps visible elements, or hidden ones. |
| `{section, exact?}` | Containers labelled by the text: a landmark or group (`region`, `form`, `group`, `dialog`, `navigation`, `table` ...) by accessible name, a `fieldset` by its `legend`, or an element whose first heading (`h1`-`h6`, `role=heading`, `legend`, `summary`, `caption`) has the text and which holds more than that heading. Innermost only. Selector: `section="Billing"`; locator: `getBySection(text)`. |
| `{row, exact?}` | For each innermost element whose text matches, its row-like ancestor: `tr`, `li`, `role=row`/`listitem`/`option`/`article`/`treeitem`, or an element repeated among its siblings with the same tag and classes. Selector: `row="Acme"`; locator: `getByRow(text)`. |
| `{layout, anchor, maxDistance?, nearest?}` | Layout filter: keeps elements `above`, `below`, `leftOf`, `rightOf` or `near` (default 50 px) the elements of the `anchor` chain, measured with bounding boxes. With `nearest` (the default), only the closest elements are kept, and the off-axis gap of a directional relation counts three times. The anchor, its ancestors and its descendants never match. Locator: `below(anchor, { maxDistance?, nearest? })`, `above`, `rightOf`, `leftOf`, `near`. |
| `{frame: true \| css}` | Frame boundary. `queryDetailed` stops there and returns the frame elements, with `frameAt` and `rest`. The driver then continues in each frame's document, because the engine never crosses frames. |

Selection steps search the descendants of each element in the working set.
Results always come back in document order with no duplicates. `query`
throws only for a malformed selector, such as invalid CSS, invalid XPath, an
invalid regex or an unknown step. It never throws when nothing matches.

**Text matching** (`TextMatch = string | {regex, flags}`) normalises
whitespace on both sides first, collapsing runs of whitespace, NBSP and
zero-width spaces to one space. A string is a case-insensitive substring
match. With `exact`, a string is a case-sensitive match on the full text. A
regex runs against the normalised text.

### Roles, names and states

- `role(el)` returns the explicit role, which is the first valid token of
  the `role` attribute (abstract roles are not valid). Otherwise it returns
  the implicit role from HTML-AAM:
  - `input` maps by type: textbox, searchbox, combobox (with `list`),
    spinbutton, slider, checkbox, radio or button. `color`, `date`, `file`
    and `hidden` have no role.
  - `section` and `form` map to region and form only when they have a name;
    otherwise they are generic.
  - `header`, `footer` and `aside` are generic inside sectioning content.
  - `img` with `alt=""` is presentation.
  - `th` is a columnheader or rowheader from `scope` and its position.
  - `td` is a cell in a table and a gridcell in a grid or treegrid.
  - `svg` is img.

  `none` and `presentation` are ignored on focusable elements and on
  elements with global ARIA attributes. List items and table parts inherit
  `none` from a presentational list or table.
- `accessibleName(el)` implements accname 1.2, steps 2A to 2I:
  - Hidden nodes are skipped, unless the traversal started at a hidden node
    referenced by `aria-labelledby` or `aria-describedby`. A
    `visibility: visible` child of a hidden parent still counts.
  - `aria-labelledby` is followed one level deep, with protection against
    cycles, and a self-reference is allowed.
  - Embedded controls inside a label give their value. Textboxes give their
    text, selects give the selected options, and range widgets give
    `aria-valuetext`, then `aria-valuenow`, then their value.
  - Then come `aria-label` and the native alternatives: `label`, `alt`,
    `value`, the submit/reset defaults, `legend`, `figcaption`, `caption`,
    the SVG `<title>`, and `optgroup` and `option` labels.
  - Name from content includes CSS `::before`/`::after` (`content` strings,
    `attr()`, and the alt text after `/`), `aria-owns`, shadow DOM and
    slots. A block-level child adds a word break.
  - The last fallbacks are `title`, then `placeholder`/`aria-placeholder`
    for text fields.
- `accessibleDescription(el)` uses `aria-describedby`, then
  `aria-description`, then `title` when `title` was not already used as the
  name.
- The state helpers are:
  - `checked(el)`: native `checked`, `indeterminate` (which gives `'mixed'`),
    or `aria-checked` on checkable roles.
  - `pressed(el)`: `aria-pressed` on buttons.
  - `expanded(el)`: `aria-expanded`, or an open `<details>`.
  - `selected(el)`: `aria-selected`, or a selected `<option>`.
  - `disabled(el)`: the browser's `:disabled` (which covers fieldset and
    optgroup inheritance and the first-legend exemption), plus
    `aria-disabled="true"` on the element or an ancestor.
  - `level(el)`: `aria-level`, or the h1–h6 number, with 2 as the default
    for `role=heading`.

### Visibility and actionability

`isVisible(el)` is true when the element has a non-empty box and is not
`visibility: hidden` or `collapse`. It is false inside a `display: none`
element and inside a `content-visibility: hidden` subtree. A
`display: contents` element is visible when one of its children is.
`opacity: 0` counts as visible. An `<option>` is visible when its `<select>`
is. `isHiddenForAria(el)` is the accessibility-tree notion: `aria-hidden`,
`inert`, not rendered, or `visibility: hidden`. Zero-size elements are not
hidden for ARIA.

`actionability(el, action, {position?, force?})` resolves to
`{ok: true, point?}` or `{ok: false, reason, retry, blocker?}`. These checks
apply:

| action | visible | stable | enabled | editable | receives events |
|--------|---------|--------|---------|----------|-----------------|
| click, dblclick, tap, check, uncheck, dragTo | ✓ | ✓ | ✓ | | ✓ |
| hover | ✓ | ✓ | | | ✓ |
| fill, type, clear | ✓ | | ✓ | ✓ | |
| selectOption (alias `select`) | ✓ | | ✓ | | |
| selectText, scrollIntoView (alias `scroll`), screenshot | ✓ | ✓ | | | |
| focus, setInputFiles | | | | | |

- **Stable**: the bounding box is the same over two animation frames. A
  timer stands in where requestAnimationFrame is throttled.
- **Receives events**: the engine scrolls the element into view if needed
  and takes the centre of the first client rect inside the viewport, or
  `position` from the border-box corner. It hit-tests that point with
  `elementFromPoint`, descending into open shadow roots. The test passes
  when the hit is the element, one of its flat-tree descendants, or a
  `<label>` of it. Otherwise the reason names the blocker, for example
  `div.modal-backdrop covers the target`, with
  `blocker: "div.modal-backdrop"`.
- `point` is in CSS pixels relative to the element's own frame viewport.
  The driver adds the iframe offsets.
- Some failures are permanent and return `retry: false`: filling a checkbox
  or a `<div>`, an unknown action, or text in `input[type=number]`.
  Everything else can be retried.
- `force: true` skips every check except "attached", and still scrolls into
  view and reports the point.

### Descriptions, fingerprints, values

- `describe(el)` returns `role "name"` when the element has a meaningful
  role and a name, such as `button "Submit order"`. Otherwise it returns a
  CSS-like form such as `input#qty[name=quantity]`, `div.card.selected` or
  `span "Total: 5"`. The output is stable for the same element.
- `fingerprint(el)` and `scan(els)` capture the healer's `ElementFingerprint`
  fields: `tag`, `role`, `name`, `text`, `id`, `testId`, `classes`,
  `attributes`, `label`, `placeholder`, `path` and `box`. The field names,
  the attribute allow-list, the label rules and the ancestry path are the
  same as `src/heal/fingerprint.ts`. `role` and `name` now come from the
  spec-based computations, and the `generic` and `none` roles are omitted,
  as before.
- The value helpers are:
  - `innerText`, `textContent`, `elementText` and `normalizeWhitespace` for
    text.
  - `inputValue` for the value of an input, textarea or select.
  - `selectOptions(el, [value | label | {value, label, index}])`, which
    fires `input` and `change`.
  - `setChecked(el, bool)`, which clicks only when the state differs.
  - `fill` and `clear`. For `input` and `textarea`, `fill` focuses the
    element and fires `beforeinput`. It then writes through the
    prototype's native value setter, so framework value trackers such as
    React's notice the change, and fires `input` and `change`. For
    `contenteditable` it uses the editing commands.
  - `selectText` and `focus`.
  - `dispatchEvent(el, type, init)`, which creates the right event class
    (Mouse, Pointer, Keyboard, Focus, Input, Drag, Touch, Wheel or Custom)
    with bubbling, cancelable and composed defaults.
- `checkState(el, state)` and `ariaSnapshot(el)` complete the driver
  contract.

### Tests and numbers

`test/browser/` runs the engine in a real Chromium, loaded by the EZTest
driver (`test/browser/harness.ts`).

- `engine-unit.test.ts` (30 tests) covers chains, shadow piercing,
  visibility, actionability, describe, fingerprints and the value helpers.
- `engine-conformance.test.ts` runs 242 role and accname fixtures from
  `fixtures/aria-cases.ts`. They are adapted from the spec examples, plus
  Material, Bootstrap and React-style markup, custom elements with shadow
  DOM, and tables vs grids.
  - Every fixture must match its spec-derived expectation (currently 100%),
    and a `{role}` query must find every fixture element.
  - Chromium's own accessibility tree (CDP
    `Accessibility.getPartialAXTree`) serves as an oracle. Its differences
    are reported to `$TMPDIR/eztest-engine-conformance.json`, and each one
    has a documented reason in the fixture's `chromium` note: layout-table
    heuristics, the ARIA 1.3 draft roles `sectionheader`/`sectionfooter`,
    image-map areas, `figure` names, NBSP and the per-node hidden rule.
- `engine-perf.test.ts` sets a budget of under 50 ms for css, text and role
  queries over a 10k-element DOM with 100 shadow roots. Medians are about
  2 ms for css, 15–25 ms for text, 15–25 ms for role with a name, and 6 ms
  for role without a name. The first role query after building a DOM also
  pays the browser's first style resolution.

### Known gaps

- A single CSS selector does not match across a shadow boundary. Chain css
  steps instead.
- Closed shadow roots are not reachable.
- Form-associated custom elements are not labelled through
  `ElementInternals`, because the engine cannot read their labels.
- The engine reports `{frame}` steps but does not resolve them.
- Some HTML-AAM rules are simplified:
  - `password` maps to textbox, as browsers do.
  - `svg` maps to img rather than graphics-document.
  - `aside` naming in sectioning content follows `aria-label`,
    `aria-labelledby` and `title` only.
<!-- END SECTION: selector-engine -->
