/**
 * The device seam: what the mobile executor needs from a device, whatever
 * drives it. Android is driven by EZTest's own ADB client plus the EZTest
 * Android agent (androidx.test.uiautomator on the device); iOS by the EZTest
 * XCTest agent; hybrid web views by the WebView bridge (Chrome DevTools
 * Protocol over the forwarded DevTools socket). Desktop drivers (src/desktop)
 * implement the same interfaces.
 *
 * Every method either does what it says or throws (NotSupportedError for an
 * operation a platform does not have); nothing is a silent no-op.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Element find strategies of the EZTest agent protocol:
 *  - id: Android resource-id (exact, or the part after ":id/"); iOS identifier
 *  - accessibility id: Android content-desc; iOS accessibility identifier / name
 *  - text / text contains: Android text; iOS label or value
 *  - class: Android class name; iOS XCUIElementType name
 *  - xpath: XPath 1.0 over the hierarchy XML the agent serves at GET /source
 *  - predicate: iOS NSPredicate (XCTest)
 *  - css: CSS selector (web views only)
 */
export type FindStrategy = 'id' | 'accessibility id' | 'text' | 'text contains' | 'class' | 'xpath' | 'predicate' | 'css';

/** One finger: touch down at the first point, move through the rest (t = ms from gesture start), lift at the last. */
export interface GesturePoint {
  x: number;
  y: number;
  t: number;
}

export interface Gesture {
  fingers: GesturePoint[][];
}

/** Element operations in the current context (native screen or web view). Element ids are opaque. */
export interface ElementBackend {
  findElements(using: FindStrategy, value: string): Promise<string[]>;
  click(el: string): Promise<void>;
  clear(el: string): Promise<void>;
  type(el: string, text: string): Promise<void>;
  text(el: string): Promise<string>;
  attribute(el: string, name: string): Promise<string | null>;
  rect(el: string): Promise<Rect>;
  displayed(el: string): Promise<boolean>;
  enabled(el: string): Promise<boolean>;
  selected(el: string): Promise<boolean>;
  /** The UI hierarchy as XML (native) or the DOM as HTML (web view). */
  source(): Promise<string>;
}

export interface WebViewInfo {
  /** Context name shown to users, e.g. WEBVIEW_com.shop.app. */
  name: string;
  /** Android: the DevTools socket (localabstract name); iOS: not available. */
  socket?: string;
  pid?: number;
  package?: string;
}

/** A web view attached for element access (DevTools Protocol). */
export interface WebViewSession extends ElementBackend {
  readonly name: string;
  url(): Promise<string>;
  title(): Promise<string>;
  navigate(url: string): Promise<void>;
  back(): Promise<void>;
  close(): Promise<void>;
}

export interface DeviceSession extends ElementBackend {
  readonly platform: 'android' | 'ios';
  /** Device serial / UDID. */
  readonly deviceId: string;
  /** Device facts for evidence (model, OS version, agent version, ...). No secrets. */
  readonly info: Record<string, unknown>;
  /** App under test (package / bundle id), when known. */
  readonly appId?: string;

  screenshot(): Promise<Buffer>;
  window(): Promise<Rect>;
  gesture(g: Gesture): Promise<void>;
  /** Named key: enter, back, home, tab, delete, space, escape, arrows, volume_up, ... */
  pressKey(key: string): Promise<void>;
  /** Type into the focused element. */
  typeText(text: string): Promise<void>;
  orientation(): Promise<'portrait' | 'landscape'>;
  setOrientation(o: 'portrait' | 'landscape'): Promise<void>;
  /** Text of an open system alert, or undefined when none is open. */
  alertText(): Promise<string | undefined>;
  acceptAlert(): Promise<void>;
  dismissAlert(): Promise<void>;
  hideKeyboard(): Promise<void>;

  launchApp(appId: string): Promise<void>;
  activateApp(appId: string): Promise<void>;
  terminateApp(appId: string): Promise<void>;
  /** Send the app to the background; seconds < 0 leaves it there. */
  backgroundApp(seconds: number): Promise<void>;
  installApp(path: string): Promise<void>;
  removeApp(appId: string): Promise<void>;
  deepLink(url: string, appId?: string): Promise<void>;
  pushFile(remotePath: string, data: Buffer): Promise<void>;
  pullFile(remotePath: string): Promise<Buffer>;
  setPermissions(appId: string, permissions: string[], grant: boolean): Promise<void>;
  setNetwork(state: { wifi?: boolean; data?: boolean; airplane?: boolean }): Promise<void>;
  lock(seconds?: number): Promise<void>;
  unlock(): Promise<void>;
  openNotifications(): Promise<void>;
  setGeolocation(latitude: number, longitude: number): Promise<void>;
  shake(): Promise<void>;

  /** Web views of the app (hybrid apps) that can be attached. */
  webviews(): Promise<WebViewInfo[]>;
  attachWebView(info: WebViewInfo): Promise<WebViewSession>;

  /** Device logs (e.g. logcat) for evidence. */
  logs?(kind: string): Promise<string>;
  /** End the session: stop the agent connection, remove port forwards. */
  close(): Promise<void>;
}

/** Thrown by the agent protocol and device clients; `code` is the agent error code. */
export class DeviceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'DeviceError';
  }

  /** The agent does not implement this command or strategy on this platform. */
  get unsupported(): boolean {
    return this.code === 'not supported' || this.code === 'unknown command';
  }
}
