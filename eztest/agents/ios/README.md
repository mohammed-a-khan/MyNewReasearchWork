# EZTest iOS agent

An XCTest UI-test bundle that serves the EZTest agent protocol (the same JSON API as
the Android agent; see `docs/mobile.md`, "Agent protocol") from inside XCTest, using
only Apple's frameworks (XCTest, Network, CoreLocation).

**Status: untested.** It was written without access to macOS or Xcode, so it has
never been compiled or run. The EZTest host side (`src/mobile/ios.ts`,
`src/mobile/usbmux.ts`) is tested against an agent simulator and a fake usbmuxd.

## Build

```sh
cd agents/ios
xcodegen generate            # creates EZTestAgent.xcodeproj from project.yml
eztest mobile build-agent --ios            # simulator build
eztest mobile build-agent --ios --device   # device build (set your signing team in Xcode first)
```

Point `mobile.ios.xctestrun` at the `.xctestrun` file under `build/Build/Products`.
EZTest then launches the agent with `xcodebuild test-without-building` and connects
to it on `127.0.0.1:8790` (simulator) or through usbmuxd (device).

## What it does

- Elements: `accessibility id` / `id` (accessibility identifier), `predicate`
  (NSPredicate), `text` / `text contains` (label or value), `class` and a subset of
  XPath (`//Tag[...]`, absolute paths) over the snapshot hierarchy.
- Gestures: finger paths become taps, long presses, drags and two-finger pinches.
- Apps: launch, activate, terminate, background by bundle id; deep links and
  simulated location need iOS 16.4.
- Not available on iOS: lock/unlock, shake, the notification centre, network
  switches, web view attachment.
