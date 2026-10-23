/**
 * Native mobile with EZTest's own drivers: the same `.ez` journeys drive
 * Android apps (EZTest ADB client + EZTest Android agent), iOS apps (EZTest
 * XCTest agent), hybrid web views (DevTools socket) and mobile web, with
 * strict locators, verified healing over the page source, gestures, device
 * operations, evidence and time-travel traces. See docs/mobile.md.
 */
export { MobileDriver, createMobileDriver, type MobileDriverOptions, type AndroidSettings, type IosSettings } from './driver.js';
export { MobileConfigSchema, parseMobileConfig, driverOptionsFromConfig, mobileRunOptions, type MobileConfig, type MobileConfigInput, type MobileDriverDeps } from './config.js';
export { DeviceError, type DeviceSession, type ElementBackend, type WebViewSession, type WebViewInfo, type FindStrategy, type Gesture, type GesturePoint, type Rect } from './session.js';
export { AdbClient, AdbConnection, AdbError, parseDevices, shellQuote, type AdbDevice, type AdbClientOptions, type ShellResult, type ShellStream } from './adb.js';
export { AgentClient, waitForAgent, AGENT_PROTOCOL_VERSION, type AgentStatus, type AgentClientOptions, type AgentCommandLog } from './agent.js';
export { AndroidDevice, pickAndroidDevice, freePort, ANDROID_AGENT_PACKAGE, ANDROID_AGENT_INSTRUMENTATION, ANDROID_AGENT_PORT, type AndroidConnectOptions } from './android.js';
export { IosDevice, bootedSimulator, defaultToolRunner, IOS_AGENT_PORT, type IosConnectOptions, type ToolRunner } from './ios.js';
export { UsbmuxClient, encodeUsbmux, htons, type UsbmuxEndpoint, type UsbmuxDevice } from './usbmux.js';
export { buildPlist, parsePlist, type PlistValue } from './plist.js';
export { CdpWebView, CdpConnection, listCdpTargets } from './webview.js';
export { NativeContext, isWebContext, interpolateCandidate, NATIVE_CONTEXT, type NativeResolution, type TriedFinder, type GestureLogEntry } from './native.js';
export { findersFor, describeFinder, kindPredicate, kindOfCandidate, NATIVE_STRATEGY, type Finder } from './locators.js';
export {
  parseSource, boundsOf, fingerprintOf, screenText, nodesAt, kindOf, nameOf, textOf, idOf, hintOf, isNodeVisible, robustNativeCandidates, xpathLiteral, KIND_TAGS,
  type NativeNode, type PageSource, type NativeKind, type NativePlatform,
} from './source.js';
export { tap, doubleTap, longPress, swipe, drag, directionalSwipe, pinch, center, intersects, type Point, type Direction } from './gestures.js';
export { nativeHealCandidates, type NativeHealContext } from './heal.js';
export { evaluateNativeConditions, evaluateNativeConditionOnce, type NativeConditionEnv } from './conditions.js';
export { performDeviceOp, switchToWebview, orUnsupported, type DeviceOpContext, type DeviceOpOutcome } from './device.js';
export { runNativeJourney, executeNativeStepCore, performNative, needsNativeTarget, type NativeExecEnv, type NativeRunSettings } from './executor.js';
export { NativeTraceRecorder, snapshotHtml } from './trace.js';
export { registerMobileCommands, buildAndroidAgent, buildIosAgent, agentsDir, PREBUILT_APK, type MobileCliIO } from './cli.js';
