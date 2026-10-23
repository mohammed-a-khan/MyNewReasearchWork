/** Public option and value types of the EZTest browser driver. */

export interface ViewportSize {
  width: number;
  height: number;
}

export interface Geolocation {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

export interface HTTPCredentials {
  username: string;
  password: string;
  /** Only send credentials to this origin. */
  origin?: string;
  /** 'always' sends them up-front (no 401 round trip); 'unauthorized' (default) answers challenges. */
  send?: 'unauthorized' | 'always';
}

export type ColorScheme = 'light' | 'dark' | 'no-preference' | null;
export type ReducedMotion = 'reduce' | 'no-preference' | null;
export type ForcedColors = 'active' | 'none' | null;
export type Contrast = 'more' | 'no-preference' | null;

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix time in seconds; -1 for session cookies. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
  partitionKey?: string;
}

export interface SetCookie {
  name: string;
  value: string;
  /** Either url, or domain + path. */
  url?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  partitionKey?: string;
}

export interface StorageState {
  cookies: Cookie[];
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

export interface ClientCertificate {
  /** Exact origin (scheme://host[:port]) the certificate is presented to. */
  origin: string;
  certPath?: string;
  cert?: Buffer;
  keyPath?: string;
  key?: Buffer;
  pfxPath?: string;
  pfx?: Buffer;
  passphrase?: string;
}

export interface RecordVideoOptions {
  dir: string;
  size?: ViewportSize;
}

export interface RecordHarOptions {
  path: string;
  content?: 'omit' | 'embed' | 'attach';
  urlFilter?: string | RegExp;
}

export interface BrowserContextOptions {
  acceptDownloads?: boolean;
  baseURL?: string;
  bypassCSP?: boolean;
  clientCertificates?: ClientCertificate[];
  colorScheme?: ColorScheme;
  contrast?: Contrast;
  deviceScaleFactor?: number;
  extraHTTPHeaders?: Record<string, string>;
  forcedColors?: ForcedColors;
  geolocation?: Geolocation;
  hasTouch?: boolean;
  httpCredentials?: HTTPCredentials;
  ignoreHTTPSErrors?: boolean;
  isMobile?: boolean;
  javaScriptEnabled?: boolean;
  locale?: string;
  offline?: boolean;
  permissions?: string[];
  proxy?: { server: string; bypass?: string; username?: string; password?: string };
  recordHar?: RecordHarOptions;
  recordVideo?: RecordVideoOptions;
  reducedMotion?: ReducedMotion;
  screen?: ViewportSize;
  serviceWorkers?: 'allow' | 'block';
  /** A StorageState object or the path of a JSON file holding one. */
  storageState?: string | StorageState;
  strictSelectors?: boolean;
  timezoneId?: string;
  userAgent?: string;
  /** null disables the viewport override (the window size is used). Default 1280x720. */
  viewport?: ViewportSize | null;
}

export interface LaunchOptions {
  headless?: boolean;
  executablePath?: string;
  /** chrome, chrome-beta, chrome-dev, chrome-canary, msedge, msedge-beta, msedge-dev, msedge-canary, chromium. */
  channel?: string;
  args?: string[];
  ignoreDefaultArgs?: boolean | string[];
  env?: Record<string, string | undefined>;
  /** Slow every input action down by this many milliseconds. */
  slowMo?: number;
  timeout?: number;
  chromiumSandbox?: boolean;
  downloadsPath?: string;
  proxy?: { server: string; bypass?: string; username?: string; password?: string };
  devtools?: boolean;
  /** Accepted for compatibility; signals are always handled. */
  handleSIGINT?: boolean;
  handleSIGTERM?: boolean;
  handleSIGHUP?: boolean;
  /** Write a browser log here. */
  logger?: unknown;
  tracesDir?: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LifecycleEvent = 'load' | 'domcontentloaded' | 'networkidle' | 'commit';

export type MouseButton = 'left' | 'right' | 'middle';
export type KeyboardModifier = 'Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift';

export interface FilePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

/** URL matcher accepted by route, waitForURL, waitForRequest ... */
export type URLMatch = string | RegExp | ((url: URL) => boolean);

export type AriaRole =
  | 'alert' | 'alertdialog' | 'application' | 'article' | 'banner' | 'blockquote' | 'button' | 'caption' | 'cell' | 'checkbox'
  | 'code' | 'columnheader' | 'combobox' | 'complementary' | 'contentinfo' | 'definition' | 'deletion' | 'dialog' | 'directory'
  | 'document' | 'emphasis' | 'feed' | 'figure' | 'form' | 'generic' | 'grid' | 'gridcell' | 'group' | 'heading' | 'img'
  | 'insertion' | 'link' | 'list' | 'listbox' | 'listitem' | 'log' | 'main' | 'marquee' | 'math' | 'meter' | 'menu' | 'menubar'
  | 'menuitem' | 'menuitemcheckbox' | 'menuitemradio' | 'navigation' | 'none' | 'note' | 'option' | 'paragraph' | 'presentation'
  | 'progressbar' | 'radio' | 'radiogroup' | 'region' | 'row' | 'rowgroup' | 'rowheader' | 'scrollbar' | 'search' | 'searchbox'
  | 'separator' | 'slider' | 'spinbutton' | 'status' | 'strong' | 'subscript' | 'superscript' | 'switch' | 'tab' | 'table'
  | 'tablist' | 'tabpanel' | 'term' | 'textbox' | 'time' | 'timer' | 'toolbar' | 'tooltip' | 'tree' | 'treegrid' | 'treeitem';

export interface DeviceDescriptor {
  userAgent: string;
  viewport: ViewportSize;
  screen?: ViewportSize;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  defaultBrowserType: 'chromium' | 'firefox' | 'webkit';
}
