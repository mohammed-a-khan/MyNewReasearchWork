# Native mobile (Android and iOS)

The same plain-English journeys (`.ez`, YAML or JSON) that drive browsers also
drive native Android and iOS apps, hybrid apps (their web views) and mobile web in
the device browser. Mobile journeys keep EZTest's guarantees: strict locators
(a target must match exactly one element), post-conditions, verified healing,
the hash-chained Evidence Vault, time-travel traces and Studio results.

EZTest drives devices with **its own drivers** and nothing else:

| Platform | Host side (TypeScript, in EZTest) | On the device |
|---|---|---|
| Android | EZTest's ADB client: the adb server's smart-socket protocol on `localhost:5037` (devices, transport, shell, forward, sync push/pull, install) | the **EZTest Android agent** (`agents/android`): an instrumentation APK using Google's `androidx.test.uiautomator` / `UiAutomation` |
| iOS | EZTest's usbmuxd client (real devices) or the loopback (simulators); Apple's `xcrun simctl` / `devicectl` / `xcodebuild` only to build and launch the agent and for simulator services | the **EZTest iOS agent** (`agents/ios`): an XCTest UI-test runner |
| Web views | `adb forward` to the app's `webview_devtools_remote_<pid>` socket, then the Chrome DevTools Protocol | the WebView itself (debugging enabled in the app) |

Both agents serve the same **EZTest agent protocol** (JSON over HTTP, described
below) on the device's loopback; the host reaches it through a port forward.

## Quick start (Android)

1. Start an emulator or connect a device (`adb devices` lists it). EZTest talks to the adb server; it does not need other tools.
2. Build the agent once: `eztest mobile build-agent` (Gradle + Android SDK, or the Docker command it prints). The APK lands in `agents/android/prebuilt/`.
3. Configure:

   ```yaml
   # eztest.config.yaml
   mobile:
     app: com.shop.app          # default app (package id, or an .apk to install)
     android:
       devices: [emulator-5554] # optional: a pool for concurrent journeys
   ```

4. Write the journey:

   ```
   Journey: Shop login
   Platform: android
   App: "com.shop.app"
   Device: Pixel 8 (Android 15)

   Type "alice" into the Username field
   Tap the "Log in" button
     Expect an alert saying "Signed in as alice"
   Accept the system alert
   Swipe up until "Settings" is visible
   Expect the screen to contain "ORD-"
   ```

5. `eztest run journeys/shop-login.ez`. EZTest installs the agent if it is missing (sync push + `pm install`), starts it with `am instrument`, forwards its port, restarts the app for every journey attempt and runs the steps.

## Headers

| Header | Meaning |
|---|---|
| `Platform: android` / `ios` / `web` | where the journey runs (config `mobile.platform` sets a default) |
| `App: "com.shop.app"` | the app under test: an installed package / bundle id, or a file (`apps/shop.apk`, `Shop.app`) installed once per device per run |
| `Device: Pixel 8 (Android 15)` | recorded with the run (device selection is by serial / UDID) |
| `Capabilities: serial="emulator-5556", appId="com.shop.app", clearData=true, launch=false` | per-journey launch settings: `serial` / `udid` pick a device of the pool, `appId` names the package an `.apk` installs, `clearData` runs `pm clear`, `launch=false` leaves the app alone |

YAML/JSON: `platform:`, `app:`, `capabilities: { ... }` on the journey.

`App:` is shared with desktop journeys. `App: electron <main.js or app dir>` starts a desktop Electron app (see [desktop-and-legacy.md](desktop-and-legacy.md#electron-apps)); any other value is the mobile app and is used with `Platform: android` or `ios`.

## Steps

Ordinary phrasings work on devices: `Tap the "Log in" button`, `Type ... into the
Username field`, `Check the "Remember me" checkbox`, `Capture the text of ... as x`,
`Swipe left on the Carousel`, `Go back`, `Press Enter`, `Open "shop://orders"`
(a deep link), waits, assertions, API/DB/data steps and every flow block.
Mobile-specific phrasings (category **Mobile** in the Studio palette):

| Phrasing | What it does |
|---|---|
| `Swipe up until "Settings" is visible [at most 5 times]` · `Scroll down until the "Help" item is visible` | swipe until the target is on screen and displayed |
| `Long press the "Photo" image [for 2 seconds]` | long press |
| `Pinch in on the Map` · `Pinch out` · `Zoom in on the Map` | two-finger pinch |
| `Swipe from 200, 700 to 200, 200` · `Tap at 120, 640` | coordinate gestures |
| `Rotate to landscape` · `Set the screen orientation to portrait` | orientation |
| `Press the device back button` · `Press the device home button` · `Go to the home screen` | device keys |
| `Put the app in the background for 3 seconds` · `Bring the app to the foreground` · `Activate the app "com.x"` · `Close the app` · `Restart the app` | app lifecycle |
| `Install the app "apps/shop.apk"` · `Uninstall the app "com.x"` | install / remove |
| `Open the deep link "shop://orders/42"` | deep link (Android `am start -a VIEW`, iOS simulator `simctl openurl`, device: XCTest) |
| `Switch to the web view [ "WEBVIEW_com.shop.app" ]` · `Switch to the native app` | hybrid app contexts |
| `Push file "fixtures/a.jpg" to "/sdcard/a.jpg"` · `Pull file "/sdcard/report.pdf" from the device as report` | files (sync protocol; the pulled file becomes evidence) |
| `Grant the app permission "android.permission.CAMERA"` · `Revoke the app permission "camera"` | runtime permissions (`pm grant`; iOS simulator `simctl privacy`) |
| `Turn on airplane mode` · `Turn off wifi` · `Turn on mobile data` · `Go offline` | connectivity (Android) |
| `Hide the keyboard` · `Lock the device [for 2 seconds]` · `Unlock the device` · `Open the notifications` · `Shake the device` | device |
| `Accept the system alert` · `Dismiss the permission dialog` · `Accept the next dialog` (armed) | system alerts |

An operation a platform cannot do fails the step with `Not supported: ...`; nothing
is silently skipped (e.g. network switches and lock on iOS, shake on Android).

## Code journeys (@eztech.com/eztest/sdk)

Code journeys target a device with `platform` (and `app`, `capabilities`) in
their options; `ui.*` calls then run on the device with the same strict
targets, post-conditions, healing and evidence:

```ts
journey('Login on Android', { platform: 'android', app: 'com.shop.app' }, async ({ ui }) => {
  await ui.fill('the Username field', 'alice');
  await ui.click('the "Log in" button', { expect: 'an alert saying "Signed in as alice"' });
  await ui.screenshot('after-login');          // a device screenshot
});
```

Supported on devices: actions, `ui.text` / `value` / `attribute` / `count` /
`texts`, `ui.is*` probes, `ui.screenshot`, expectations and every non-UI
surface. Browser-only calls fail clearly: `ui.page()` (there is no browser
page; use a custom step with `ctx.platform.session`, the DeviceSession),
tables, downloads and uploads, tabs, frames, network mocking. Mobile-only
operations (swipe-until, rotate, deep links, ...) have no `ui.*` method yet: put them
in a small `.ez` journey and call it from code with `run('rotate-and-check')` (@eztech.com/eztest/sdk).

## Targets on devices

Descriptions map to the agent's find strategies, most specific first, and a
finder counts only when it matches exactly one element:

- `the "Log in" button` (Android): accessibility id `Log in` (content-desc) → exact text → XPath over the hierarchy restricted to button-like classes → XPath on any naming attribute.
- On iOS the second finder is an NSPredicate (`label == "Log in" OR name == ... OR value == ...`).
- Native selectors: `accessibility id=Log in` (or `~Log in`), `id=com.shop:id/login` (or just `id=login`), `class=android.widget.Button`, `predicate=label BEGINSWITH "Ord"` (iOS), `xpath=//android.widget.Button[@text="OK"]`, `testid=buy` (React Native testID).
- In a web view, targets are web targets again (roles, text, placeholder, CSS, XPath).

`eztest mobile inspect` writes the current screen's hierarchy XML and a screenshot; the Studio **Device** tab shows the same for every step of a run with an element picker that suggests targets.

## Verified healing on devices

Every passing step records the element's fingerprint (class, resource id, text,
content-desc, hint, ancestry, bounds) from the page source. When a target stops
matching (e.g. the id changed in a new build), the ladder runs over the page-source
XML: **T0** the last verified heal or last good locator, **T1** fingerprint
similarity, **T2** the description's words against element names, texts and hints,
with the same thresholds and margin as on the web. A candidate is confirmed on the
device (exactly one match, same bounds) and the step only counts as
`passed-healed` when its post-conditions (or the action's implied check: the field
holds the typed text, the box is checked) hold. Otherwise it fails as a suspected
regression. Heals go to `heal-proposals.json` and the Studio heal inbox as usual.
(Healing inside web views is limited to T0, because their DOM is not mapped to
screen bounds.)

## Evidence and traces

Per journey attempt, in the Evidence Vault: `device.json` (device, agent version,
app), screenshots per the screenshot policy (and on heals), the page source XML on
failures and heals (`mobile.pageSource: every-step` keeps one per step),
`gestures.json` (every finger path sent), `agent-commands.json` (each agent request
with status and timing), pulled files, and device logs (`mobile.logs: [logcat]`).
With `trace.timeTravel.enabled`, mobile journeys write a regular EZTest trace: each
step's before/after "DOM snapshot" is the screenshot with every element of the page
source drawn at its bounds, and the step's target outlined, so the Studio Trace
viewer, trace diffs and bundles work unchanged.

## Configuration

```yaml
mobile:
  platform: android          # default for journeys without Platform: (omit to keep web the default)
  app: com.shop.app
  android:
    adb: { host: 127.0.0.1, port: 5037 }
    devices: [emulator-5554, emulator-5556]   # pool: concurrent journeys lease one device each
    agentApk: agents/android/prebuilt/eztest-agent.apk
    agentPort: 6790          # device-side port of the agent
    clearData: false
  ios:
    devices: [00008110-001A2B3C4D5E6F]       # or omit: the booted simulator
    simulator: true
    xctestrun: agents/ios/build/Build/Products/EZTestAgent_iphonesimulator.xctestrun
    agentPort: 8790
  screenshots: every-step     # default: the run's policy
  pageSource: on-failure      # every-step | on-failure | off
  logs: [logcat]
  webviewTimeoutMs: 10000
  agentTimeoutMs: 30000
```

## CLI

- `eztest mobile devices` — Android devices (adb) and iOS devices (usbmuxd).
- `eztest mobile build-agent [--ios [--device]]` — build the Android APK (Gradle + Android SDK; prints a Docker command when they are missing) or the iOS runner (Xcode).
- `eztest mobile install-agent [-s serial]` — install the Android agent.
- `eztest mobile inspect [-s serial] [-o screen]` — hierarchy XML + screenshot of the current screen.

## Agent protocol (version 1)

JSON over HTTP on the device loopback. Success: `{ "value": ... }` (or the named
fields below); failure: a 4xx/5xx status with `{ "error": { "code", "message" } }`,
codes `no such element`, `stale element`, `no such alert`, `invalid argument`,
`not supported`, `unknown command`, `timeout`, `internal`, `unauthorized`.

Every request carries the session token in `X-EZTest-Agent-Token`; an agent
answers nothing else (401 `unauthorized`). EZTest starts each agent with a fresh
random token; for an agent started by hand, set `mobile.android.agentToken` /
`mobile.ios.agentToken` to the token it was started with.

| Route | Body / result |
|---|---|
| `GET /status` | `{ ready, agent, version, protocol, platform, device }` |
| `POST /find` | `{ using, value }` → `{ elements: [id] }`; `using`: `id`, `accessibility id`, `text`, `text contains`, `class`, `xpath`, `predicate` (iOS) |
| `POST /element/:id/click` · `/clear` · `/type {text}` | act on an element |
| `GET /element/:id/text` · `/rect` · `/displayed` · `/enabled` · `/selected` · `/attribute/:name` | element facts |
| `GET /source` · `GET /screenshot` (base64 PNG) · `GET /window` | screen |
| `POST /gesture {fingers: [[{x, y, t}, ...], ...]}` | each finger touches down at its first point, moves through the rest (t in ms from the gesture start) and lifts at the last |
| `POST /key {key}` · `POST /keys {text}` | named keys (`enter`, `back`, `home`, `tab`, `delete`, arrows, ...) and text into the focused field |
| `GET` / `POST /orientation {value}` | `portrait` / `landscape` |
| `GET /alert` · `POST /alert/accept` · `POST /alert/dismiss` | system alerts and permission prompts |
| `POST /keyboard/hide` · `POST /app/launch` · `/app/activate` · `/app/terminate {appId}` · `POST /app/background {seconds}` | keyboard and apps |
| `POST /deeplink {url, appId}` · `POST /notifications/open` · `POST /lock {seconds}` · `POST /unlock` · `POST /shake` · `POST /geolocation {latitude, longitude}` · `POST /shutdown` | device |

The Android agent builds the hierarchy itself from the accessibility tree: tags
are class names, with `text`, `resource-id`, `content-desc`, `hint`, `checked`,
`clickable`, `displayed`, `bounds` and friends; every finder is XPath over that XML
with the value bound as an XPath variable (never spliced into the query). The iOS
agent's hierarchy uses `XCUIElementType*` tags with `name`, `label`, `value`,
`x/y/width/height`, and supports the XPath subset EZTest generates.

## Writing a platform driver

`src/runner/platform.ts` is the driver abstraction: a `PlatformDriver` has
`name`, `platforms`, `runAttempt(journey, attempt, env)` (never throws; returns a
`JourneyResult`), optional `environment()` and `close()`. The run loop picks it by
the journey's platform (`RunOptions.platformDrivers`, then
`registerPlatformDriver`), and keeps retries, concurrency, hooks, cancellation, the
fingerprint store, the Evidence Vault and `run.json` shared. The mobile executor
(`src/mobile/executor.ts`) is reusable for any UI tree: implement `DeviceSession`
(`src/mobile/session.ts`: element finds and actions, source XML, screenshot,
gestures, keys, apps) and pass it through `MobileDriverOptions.connect`, or build
your own driver around `runNativeJourney`. Flow blocks use
`FlowEnv.evaluateConditions` so If/While conditions work on the device.

## What was tested, and how

There is no Android emulator (no KVM) and no macOS in EZTest's development
environment, so:

- **Tested for real:** the ADB client byte for byte against a fake adb server that implements the smart-socket protocol (including real TCP port forwards and the sync protocol); the Android agent's protocol core (router, finders, HTTP server, JSON) compiled with `javac` and run on the JVM, both by its own checks and end to end by an EZTest journey through the fake adb forward; the web view bridge against a real headless Chromium DevTools endpoint reached through the fake adb forward; the usbmuxd client and plist codec against a fake usbmuxd.
- **Tested against simulators only:** journeys, healing, gestures, device operations, evidence and traces run against a device-agent simulator that implements the agent protocol over fixture hierarchies (Android and iOS).
- **Compile-checked only:** the Android half of the agent (`UiAutomatorDevice`, `AgentInstrumentation`) compiles against the Android 14 framework classes; the `androidx.test.uiautomator` calls were checked against hand-written API stubs, because Google's Maven artifacts are not reachable here. No APK has been built or run on a device yet.
- **Untested:** the iOS agent (Swift) has never been compiled or run.
- **Not provided:** remote device clouds; support for them may come later through a different integration.
