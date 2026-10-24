/**
 * EZTest's own browser driver (`eztest/browser`): Chromium-family browsers
 * (Chrome, Edge, Chromium, Electron) over the Chrome DevTools Protocol, and
 * Firefox over WebDriver BiDi, the remote protocol built into Firefox. No
 * Safari/WebKit.
 *
 *   import { chromium, firefox } from '@eztech/eztest/browser';
 *   const browser = await chromium.launch();            // or firefox.launch()
 *   const page = await (await browser.newContext()).newPage();
 *   await page.goto('https://example.com');
 *   await page.getByRole('link', { name: 'More information' }).click();
 *
 * Browser binaries are found by `findChromium` / `findFirefox`: an explicit
 * executablePath or channel, EZTEST_CHROMIUM_PATH / EZTEST_FIREFOX_PATH, the
 * EZTest browser cache (`eztest install-browsers`, EZTEST_BROWSERS_PATH), then
 * an installed Chrome, Edge or Firefox.
 */
import { ChromiumBrowserType } from './chromium/browser.js';
import { FirefoxBrowserType } from './firefox/browser.js';
import { ElectronLauncher } from './electron.js';
import type { LaunchOptions } from './types.js';

export { devices } from './devices.js';
export { selectors } from './locator.js';
export { TimeoutError, TargetClosedError, ProtocolError } from './errors.js';

/** Chrome, Edge and Chromium over the Chrome DevTools Protocol. */
export const chromium = new ChromiumBrowserType();

/** A browser EZTest does not drive: every entry point rejects with a clear message. */
class UnavailableBrowserType {
  constructor(private readonly name_: string, private readonly message: string) {}
  name(): string {
    return this.name_;
  }
  executablePath(): string {
    throw new Error(this.message);
  }
  async launch(_options?: LaunchOptions): Promise<never> {
    throw new Error(this.message);
  }
  async launchPersistentContext(_dir: string, _options?: unknown): Promise<never> {
    throw new Error(this.message);
  }
  async connect(_endpoint: unknown, _options?: unknown): Promise<never> {
    throw new Error(this.message);
  }
  async connectOverCDP(_endpoint: unknown, _options?: unknown): Promise<never> {
    throw new Error(this.message);
  }
}

/**
 * Firefox over WebDriver BiDi. Its objects implement the same API as the
 * Chromium ones (minus the CDP-only members: CDP sessions, connectOverCDP),
 * so it is typed as the same BrowserType.
 */
export const firefox = new FirefoxBrowserType() as unknown as ChromiumBrowserType;

/** Safari/WebKit is not supported; `browser: webkit` fails with this message. */
export const webkit = new UnavailableBrowserType('webkit', 'WebKit is not supported by EZTest (use chromium, chrome, msedge or firefox)');

/** Electron apps: renderer windows over CDP, the main process over the Node inspector. */
export const electron = new ElectronLauncher(chromium);

export type BrowserType = ChromiumBrowserType;
export type { ChromiumBrowser as Browser, ChromiumContext as BrowserContext, Download } from './chromium/browser.js';
export type { ChromiumPage as Page, ConsoleMessage, Dialog, Worker, FileChooser } from './chromium/page.js';
export type { ChromiumFrame as Frame } from './chromium/frame.js';
export type { JSHandle, ElementHandle } from './chromium/handles.js';
export type { Request, Response, Route, WebSocket } from './chromium/network.js';
export type { Locator, FrameLocator } from './locator.js';
export type { CDPSession } from './transport/connection.js';
export type { Keyboard, Mouse, Touchscreen } from './chromium/input.js';
export type { Video } from './chromium/video.js';
export { videoChaptersVtt, type VideoChapter } from './video/webm.js';
export { OVERLAY_SCRIPT, type OverlayBox } from './video/overlay.js';
export type { Tracing } from './tracing.js';
export { BROWSER_TRACE_FORMAT, BROWSER_TRACE_VERSION, type BrowserTraceManifest, type BrowserTraceAction, type BrowserTraceRequest, type BrowserTraceSnapshot, type BrowserTraceNode } from './trace-format.js';
export type { APIRequestContext } from './request.js';
export type { FetchedResponse as APIResponse } from './chromium/network.js';
export type { ElectronApplication } from './electron.js';
export type {
  BrowserContextOptions,
  LaunchOptions,
  Cookie,
  Geolocation,
  ViewportSize,
  HTTPCredentials,
  StorageState,
  DeviceDescriptor,
} from './types.js';

// The driver's building blocks.
export { CDPConnection } from './transport/connection.js';
export { PipeTransport, WebSocketTransport, type Transport } from './transport/transport.js';
export { launchChromiumProcess, defaultChromiumArgs, chromiumCommandLine, connectWebSocket, resolveBrowserWsEndpoint } from './launcher/launch.js';
export { findChromium, browserCacheDir, channelCandidates, cachedBuilds, type FoundBrowser } from './launcher/find.js';
export { installBrowser, type InstallOptions, type InstallResult } from './launcher/install.js';
export { BidiConnection } from './firefox/connection.js';
export { FirefoxBrowserType } from './firefox/browser.js';
export { findFirefox, launchFirefoxProcess, firefoxPreferences, firefoxCommandLine, type FoundFirefox } from './firefox/launch.js';
export { parseSelector } from './selector-parser.js';
export { contextClock, installedClock, BrowserClock, parseClockTime, parseClockDuration, type ClockTime } from './clock.js';
export type { LayoutOptions } from './locator.js';
export type { SelectorChain, SelectorStep, InjectedEngine, ActionKind, ActionabilityResult } from './injected/contract.js';
