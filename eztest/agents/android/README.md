# EZTest Android agent

An instrumentation APK (`io.eztest.agent`) that serves the EZTest agent protocol
(see `docs/mobile.md`, "Agent protocol") on the device loopback, using Google's
`androidx.test.uiautomator` and `UiAutomation`. EZTest installs it with its own ADB
client, starts it with `am instrument -e port <port> -e token <random>`, forwards its
port and talks to it. The agent answers only requests carrying that session token
(`X-EZTest-Agent-Token`); for an agent you start yourself, set the same token as
`mobile.android.agentToken`.

- `app/src/main/java/io/eztest/agent/core/`: the protocol (router, finders over the
  hierarchy XML with XPath, HTTP server, JSON). Plain Java: tested on the JVM.
- `app/src/main/java/io/eztest/agent/`: the Android side (`UiAutomatorDevice`,
  `AgentInstrumentation`).
- `app/src/test/java/`: JVM checks (`AgentCoreChecks`, also run by EZTest's test
  suite with `javac`) and a fixture device.

## Build

Needs the Android SDK (platform 35) and Gradle 8.9+:

```sh
eztest mobile build-agent                 # gradle :app:assembleRelease + copy to prebuilt/
# or, without a local SDK:
docker run --rm -v "$PWD:/project" -w /project mingc/android-build-box gradle :app:assembleRelease
```

The APK lands in `prebuilt/eztest-agent.apk` (with a `.sha256` file); EZTest uses it
automatically, or set `mobile.android.agentApk`.

**Status:** the protocol core is compiled and tested on the JVM. The Android half
has not been compiled or run on a device in EZTest's development environment (no
Android SDK or emulator there); no prebuilt APK is shipped yet.
