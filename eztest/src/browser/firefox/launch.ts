/**
 * Finding and starting Firefox for WebDriver BiDi.
 *
 * Binary lookup order:
 *  1. `executablePath`.
 *  2. `channel` (firefox, firefox-esr, firefox-beta, firefox-nightly / nightly,
 *     firefox-developer-edition) at the standard install paths of Linux, macOS
 *     and Windows.
 *  3. EZTEST_FIREFOX_PATH, then FIREFOX_PATH.
 *  4. The EZTest browser cache (`eztest install-browsers firefox`), newest first.
 *  5. An installed Firefox (stable, then ESR, then Nightly).
 *
 * Start: `--remote-debugging-port=0` (Firefox picks a free port and prints
 * "WebDriver BiDi listening on ws://127.0.0.1:<port>" on stderr), a fresh
 * temporary profile whose `user.js` we write ourselves (no telemetry, no
 * updates, no first-run pages, no remote settings, the remote agent speaking
 * BiDi), `--no-remote --new-instance`, and its own process group so close()
 * takes every content process down.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { debugLog } from '../debug.js';
import { browserCacheDir } from '../launcher/find.js';
import { killTree, removeDir, trackLiveBrowser, type SignalHandling } from '../launcher/launch.js';
import { makeTempDir } from '../launcher/temp-dirs.js';
import { WebSocketTransport, type Transport } from '../transport/transport.js';
import { settleWithin } from '../util.js';

export interface FoundFirefox {
  executablePath: string;
  source: 'executablePath' | 'channel' | 'env' | 'eztest-cache' | 'system';
}

const CHANNEL_ALIASES: Record<string, string> = {
  firefox: 'firefox',
  'firefox-stable': 'firefox',
  'firefox-esr': 'firefox-esr',
  esr: 'firefox-esr',
  'firefox-beta': 'firefox-beta',
  beta: 'firefox-beta',
  nightly: 'firefox-nightly',
  'firefox-nightly': 'firefox-nightly',
  'firefox-developer-edition': 'firefox-developer-edition',
  'firefox-devedition': 'firefox-developer-edition',
};

/** Normalized Firefox channel name, or undefined for names that are not Firefox channels. */
export function firefoxChannel(name: string | undefined): string | undefined {
  return name ? CHANNEL_ALIASES[name.toLowerCase()] : undefined;
}

/** Standard install locations of a Firefox channel. */
export function firefoxChannelCandidates(channel: string, platform: NodeJS.Platform = process.platform): string[] {
  const ch = firefoxChannel(channel) ?? channel;
  if (platform === 'linux') {
    const linux: Record<string, string[]> = {
      firefox: ['/usr/lib/firefox/firefox', '/usr/lib64/firefox/firefox', '/opt/firefox/firefox', '/usr/bin/firefox', '/usr/local/bin/firefox', '/snap/bin/firefox'],
      'firefox-esr': ['/usr/lib/firefox-esr/firefox-esr', '/usr/lib64/firefox-esr/firefox-esr', '/opt/firefox-esr/firefox', '/usr/bin/firefox-esr'],
      'firefox-beta': ['/opt/firefox-beta/firefox', '/usr/lib/firefox-beta/firefox', '/usr/bin/firefox-beta'],
      'firefox-nightly': ['/opt/firefox-nightly/firefox', '/usr/lib/firefox-nightly/firefox', '/usr/bin/firefox-nightly'],
      'firefox-developer-edition': ['/opt/firefox-developer-edition/firefox', '/usr/lib/firefox-developer-edition/firefox', '/usr/bin/firefox-developer-edition'],
    };
    return linux[ch] ?? [];
  }
  if (platform === 'darwin') {
    const apps: Record<string, string[]> = {
      firefox: ['Firefox'],
      'firefox-esr': ['Firefox ESR', 'Firefox'],
      'firefox-beta': ['Firefox Beta', 'Firefox'],
      'firefox-nightly': ['Firefox Nightly'],
      'firefox-developer-edition': ['Firefox Developer Edition'],
    };
    return (apps[ch] ?? []).flatMap((app) => [`/Applications/${app}.app/Contents/MacOS/firefox`, join(homedir(), 'Applications', `${app}.app`, 'Contents', 'MacOS', 'firefox')]);
  }
  if (platform === 'win32') {
    const dirs: Record<string, string[]> = {
      firefox: ['Mozilla Firefox'],
      'firefox-esr': ['Mozilla Firefox ESR', 'Mozilla Firefox'],
      'firefox-beta': ['Mozilla Firefox Beta', 'Mozilla Firefox'],
      'firefox-nightly': ['Firefox Nightly'],
      'firefox-developer-edition': ['Firefox Developer Edition'],
    };
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA, 'C:\\Program Files', 'C:\\Program Files (x86)'];
    const out: string[] = [];
    for (const r of roots) if (r) for (const d of dirs[ch] ?? []) out.push(`${r}\\${d}\\firefox.exe`);
    return [...new Set(out)];
  }
  return [];
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Path of the Firefox binary inside an install folder of the EZTest cache. */
export function firefoxBinaryInInstall(dir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return join(dir, 'Firefox.app', 'Contents', 'MacOS', 'firefox');
  if (platform === 'win32') return join(dir, 'core', 'firefox.exe');
  return join(dir, 'firefox', 'firefox');
}

/** Firefox builds in the EZTest cache (`<cache>/firefox-<version>/...`), newest first. */
export function cachedFirefoxBuilds(dir = browserCacheDir()): Array<{ version: string; executablePath: string }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ version: string; executablePath: string }> = [];
  for (const name of readdirSync(dir)) {
    const m = /^firefox-(\d[\w.]*)$/.exec(name);
    if (!m) continue;
    const exe = firefoxBinaryInInstall(join(dir, name));
    if (isFile(exe)) out.push({ version: m[1], executablePath: exe });
  }
  const num = (v: string) => v.split(/[.a-z]+/i).map((x) => Number(x) || 0);
  return out.sort((a, b) => {
    const pa = num(a.version);
    const pb = num(b.version);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pb[i] ?? 0) !== (pa[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
    return 0;
  });
}

/** Find a Firefox binary, or throw an error that says how to get one. */
export function findFirefox(opts: { executablePath?: string; channel?: string } = {}): FoundFirefox {
  if (opts.executablePath) {
    if (!isFile(opts.executablePath)) throw new Error(`Browser executable not found at "${opts.executablePath}" (executablePath)`);
    return { executablePath: opts.executablePath, source: 'executablePath' };
  }
  const channel = firefoxChannel(opts.channel);
  if (opts.channel && !channel) throw new Error(`Unknown Firefox channel "${opts.channel}" (use firefox, firefox-esr, firefox-beta, firefox-nightly or firefox-developer-edition)`);
  if (channel && channel !== 'firefox') {
    const hit = firefoxChannelCandidates(channel).find(isFile);
    if (hit) return { executablePath: hit, source: 'channel' };
    throw new Error(`Firefox channel "${opts.channel}" is not installed (looked in: ${firefoxChannelCandidates(channel).join(', ') || 'nowhere on this platform'}). Install it or set executablePath.`);
  }
  for (const v of ['EZTEST_FIREFOX_PATH', 'FIREFOX_PATH']) {
    const p = process.env[v];
    if (p && isFile(p)) return { executablePath: p, source: 'env' };
  }
  const cached = cachedFirefoxBuilds()[0];
  if (cached) return { executablePath: cached.executablePath, source: 'eztest-cache' };
  for (const c of ['firefox', 'firefox-esr', 'firefox-nightly']) {
    const hit = firefoxChannelCandidates(c).find(isFile);
    if (hit) return { executablePath: hit, source: channel ? 'channel' : 'system' };
  }
  throw new Error(
    'No Firefox found. Run "eztest install-browsers firefox" to download it from Mozilla into ' +
      `${browserCacheDir()}, install Firefox (or Firefox ESR), or set executablePath / EZTEST_FIREFOX_PATH.`,
  );
}

// ---------------------------------------------------------------------- preferences

export interface FirefoxPrefsOptions {
  /** Proxy for the whole browser (contexts may set their own). */
  proxy?: { server: string; bypass?: string };
  /** Extra / overriding preferences (firefoxUserPrefs). */
  userPrefs?: Record<string, string | number | boolean>;
}

/**
 * Preferences for an automation profile: quiet (no telemetry, updates,
 * remote settings, safe browsing or first-run pages), deterministic (no
 * popup blocking, prompts or session restore) and with the remote agent
 * speaking WebDriver BiDi.
 */
/** Whether the environment names a proxy (the variables Firefox's system mode reads on Linux). */
function envProxy(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy);
}

export function firefoxPreferences(opts: FirefoxPrefsOptions = {}): Record<string, string | number | boolean> {
  const prefs: Record<string, string | number | boolean> = {
    // Remote agent: WebDriver BiDi only (1 = BiDi).
    'remote.active-protocols': 1,
    'remote.log.level': 'Warn',
    // Startup and first-run UI.
    'browser.shell.checkDefaultBrowser': false,
    'browser.startup.page': 0,
    'browser.startup.homepage': 'about:blank',
    'browser.startup.homepage_override.mstone': 'ignore',
    'startup.homepage_welcome_url': '',
    'startup.homepage_welcome_url.additional': '',
    'browser.aboutwelcome.enabled': false,
    'browser.newtabpage.enabled': false,
    'browser.newtab.preload': false,
    'browser.uitour.enabled': false,
    'browser.usedOnWindows10.introURL': '',
    'browser.tabs.warnOnClose': false,
    'browser.tabs.warnOnCloseOtherTabs': false,
    'browser.tabs.warnOnOpen': false,
    'browser.warnOnQuit': false,
    'browser.sessionstore.resume_from_crash': false,
    'browser.sessionstore.max_resumed_crashes': 0,
    'toolkit.startup.max_resumed_crashes': -1,
    'browser.tabs.unloadOnLowMemory': false,
    'browser.tabs.closeWindowWithLastTab': false,
    'browser.pagethumbnails.capturing_disabled': true,
    'browser.translations.automaticallyPopup': false,
    'browser.translations.enable': false,
    'browser.ml.enable': false,
    // Telemetry, studies, crash reports.
    'datareporting.policy.dataSubmissionEnabled': false,
    'datareporting.policy.dataSubmissionPolicyBypassNotification': true,
    'datareporting.healthreport.uploadEnabled': false,
    'toolkit.telemetry.enabled': false,
    'toolkit.telemetry.unified': false,
    'toolkit.telemetry.archive.enabled': false,
    'toolkit.telemetry.server': 'data:,',
    'toolkit.telemetry.shutdownPingSender.enabled': false,
    'toolkit.telemetry.newProfilePing.enabled': false,
    'toolkit.telemetry.firstShutdownPing.enabled': false,
    'app.normandy.enabled': false,
    'app.normandy.api_url': '',
    'app.shield.optoutstudies.enabled': false,
    'browser.crashReports.unsubmittedCheck.autoSubmit2': false,
    'browser.ping-centre.telemetry': false,
    'browser.newtabpage.activity-stream.feeds.telemetry': false,
    'browser.newtabpage.activity-stream.telemetry': false,
    // Updates and background services.
    'app.update.disabledForTesting': true,
    'app.update.auto': false,
    'app.update.checkInstallTime': false,
    'app.update.staging.enabled': false,
    'extensions.update.enabled': false,
    'extensions.update.notifyUser': false,
    'extensions.getAddons.cache.enabled': false,
    'extensions.blocklist.enabled': false,
    'extensions.autoDisableScopes': 0,
    'extensions.enabledScopes': 5,
    'extensions.installDistroAddons': false,
    'extensions.systemAddon.update.enabled': false,
    'services.settings.server': 'data:,',
    'browser.safebrowsing.malware.enabled': false,
    'browser.safebrowsing.phishing.enabled': false,
    'browser.safebrowsing.downloads.enabled': false,
    'browser.safebrowsing.blockedURIs.enabled': false,
    'browser.safebrowsing.provider.mozilla.updateURL': '',
    'browser.safebrowsing.provider.google.updateURL': '',
    'browser.safebrowsing.provider.google4.updateURL': '',
    'network.captive-portal-service.enabled': false,
    'network.connectivity-service.enabled': false,
    'network.dns.disablePrefetch': true,
    'network.prefetch-next': false,
    'network.http.speculative-parallel-limit': 0,
    'browser.urlbar.suggest.searches': false,
    'browser.search.update': false,
    'browser.topsites.contile.enabled': false,
    'geo.provider.network.url': '',
    'geo.provider.use_gpsd': false,
    'geo.provider.use_geoclue': false,
    'media.gmp-manager.url': '',
    'media.gmp-provider.enabled': false,
    'security.certerrors.mitm.priming.enabled': false,
    'privacy.trackingprotection.enabled': false,
    'privacy.trackingprotection.socialtracking.enabled': false,
    'browser.contentblocking.category': 'standard',
    // Behaviour tests expect from a browser under automation.
    'dom.disable_open_during_load': false,
    'dom.max_script_run_time': 0,
    'dom.max_chrome_script_run_time': 0,
    'dom.ipc.reportProcessHangs': false,
    'hangmonitor.timeout': 0,
    'dom.disable_beforeunload': false,
    'network.http.prompt-temp-redirect': false,
    'network.cookie.cookieBehavior': 0,
    'signon.rememberSignons': false,
    'signon.autofillForms': false,
    'browser.formfill.enable': false,
    'media.autoplay.default': 0,
    'media.navigator.streams.fake': true,
    'media.navigator.permission.disabled': true,
    'permissions.isolateBy.userContext': true,
    'browser.download.panel.shown': true,
    'browser.download.manager.showWhenStarting': false,
    'browser.download.always_ask_before_handling_new_types': false,
    'browser.download.useDownloadDir': true,
    'browser.download.folderList': 2,
    'pdfjs.disabled': true,
    // No back-forward cache: every history navigation loads (and reports) a document.
    'browser.sessionhistory.max_total_viewers': 0,
    // Headless has no real pointer: report a mouse (fine pointer with hover), as the Chromium launch does.
    'ui.primaryPointerCapabilities': 6,
    'ui.allPointerCapabilities': 6,
    // Lazy images and iframes start loading within about 1250px of a 720px viewport (175%), as in
    // Chromium; Firefox's own margin is much smaller. (Pixel values of these prefs are not honoured.)
    'dom.lazy-loading.margin.top': 175,
    'dom.lazy-loading.margin.bottom': 175,
    'dom.lazy-loading.margin.left': 175,
    'dom.lazy-loading.margin.right': 175,
    'dom.lazy-loading.margin.top.percentage': true,
    'dom.lazy-loading.margin.bottom.percentage': true,
    'dom.lazy-loading.margin.left.percentage': true,
    'dom.lazy-loading.margin.right.percentage': true,
    // No favicon requests (they would show up as page requests).
    'browser.chrome.site_icons': false,
    // Every page is its own window (and so the active tab): no background throttling of timers or rAF.
    'dom.timeout.enable_budget_timer_throttling': false,
    'dom.min_background_timeout_value': 4,
    'dom.suspend_inactive.enabled': false,
    'browser.link.open_newwindow': 2,
    'browser.link.open_newwindow.restriction': 0,
    'focusmanager.testmode': true,
    'ui.prefersReducedMotion': 0,
    'layout.css.prefers-color-scheme.content-override': 1,
  };
  if (opts.proxy) {
    const u = new URL(/^[a-z0-9+.-]+:\/\//i.test(opts.proxy.server) ? opts.proxy.server : `http://${opts.proxy.server}`);
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : u.protocol.startsWith('socks') ? 1080 : 80));
    prefs['network.proxy.type'] = 1;
    if (u.protocol.startsWith('socks')) {
      prefs['network.proxy.socks'] = u.hostname;
      prefs['network.proxy.socks_port'] = port;
      prefs['network.proxy.socks_version'] = u.protocol === 'socks4:' ? 4 : 5;
      prefs['network.proxy.socks_remote_dns'] = true;
    } else {
      prefs['network.proxy.http'] = u.hostname;
      prefs['network.proxy.http_port'] = port;
      prefs['network.proxy.ssl'] = u.hostname;
      prefs['network.proxy.ssl_port'] = port;
    }
    prefs['network.proxy.no_proxies_on'] = opts.proxy.bypass ?? '';
    prefs['network.proxy.allow_hijacking_localhost'] = !opts.proxy.bypass?.split(',').some((b) => /localhost|127\.0\.0\.1|<-loopback>/.test(b));
  } else if (envProxy()) {
    // Like Chromium, follow the machine's proxy (HTTPS_PROXY / HTTP_PROXY / NO_PROXY, read by Firefox's
    // "system" mode on Linux): a direct connection fails on networks that only allow the proxy.
    prefs['network.proxy.type'] = 5;
  } else {
    prefs['network.proxy.type'] = 0;
  }
  return { ...prefs, ...(opts.userPrefs ?? {}) };
}

/** The `user.js` text for a set of preferences. */
export function userJs(prefs: Record<string, string | number | boolean>): string {
  return Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n') + '\n';
}

// ---------------------------------------------------------------------- process

export interface FirefoxLaunchOptions extends FirefoxPrefsOptions {
  executablePath?: string;
  channel?: string;
  headless?: boolean;
  args?: string[];
  /** Drop the default arguments (true) or some of them. */
  ignoreDefaultArgs?: boolean | string[];
  env?: Record<string, string | undefined>;
  /** Use this profile directory instead of a temporary one (kept on close). */
  userDataDir?: string;
  timeout?: number;
  devtools?: boolean;
  /** Kill Firefox and remove its temporary profile on these signals (each default true). */
  handleSignals?: SignalHandling;
}

export interface LaunchedFirefox {
  process: import('node:child_process').ChildProcess;
  transport: Transport;
  found: FoundFirefox;
  userDataDir: string;
  wsEndpoint: string;
  kill(): Promise<void>;
  exited: Promise<number | null>;
  stderrTail: string[];
}

/** Command line for a launch (without the binary). */
export function firefoxCommandLine(opts: FirefoxLaunchOptions, profileDir: string): string[] {
  const ignore = opts.ignoreDefaultArgs;
  let args = ignore === true ? [] : ['--no-remote', '--new-instance'];
  if (Array.isArray(ignore)) args = args.filter((a) => !ignore.includes(a));
  args.push('--remote-debugging-port=0', '--profile', profileDir);
  const headless = opts.headless ?? !opts.devtools;
  if (headless) args.push('--headless');
  if (opts.devtools) args.push('--devtools');
  const userArgs = opts.args ?? [];
  args.push(...userArgs);
  if (!userArgs.some((a) => !a.startsWith('-'))) args.push('about:blank');
  return args;
}

/**
 * On Linux, Chromium trusts the certificates in the user's shared NSS database (`~/.pki/nssdb`), which is
 * where a company's TLS-inspecting proxy CA is installed. A fresh Firefox profile has its own empty database,
 * so it rejects every site behind that proxy. Start the temporary profile from a copy of the shared database
 * (`EZTEST_NSSDB` points at another one), so both browsers trust the same certificates.
 */
export function adoptSharedCertificates(profileDir: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'linux' && !env.EZTEST_NSSDB) return false;
  const db = env.EZTEST_NSSDB || join(homedir(), '.pki', 'nssdb');
  if (!isFile(join(db, 'cert9.db'))) return false;
  try {
    for (const f of ['cert9.db', 'key4.db']) if (isFile(join(db, f))) copyFileSync(join(db, f), join(profileDir, f));
    return true;
  } catch (e) {
    debugLog('browser', `shared certificates not copied from ${db}: ${(e as Error).message}`);
    return false;
  }
}

/** Start Firefox and connect to its WebDriver BiDi endpoint. */
export async function launchFirefoxProcess(opts: FirefoxLaunchOptions = {}): Promise<LaunchedFirefox> {
  const found = findFirefox({ executablePath: opts.executablePath, channel: opts.channel });
  const temp = !opts.userDataDir;
  const profileDir = opts.userDataDir ?? makeTempDir('firefox-profile');
  writeFileSync(join(profileDir, 'user.js'), userJs(firefoxPreferences(opts)));
  if (temp) adoptSharedCertificates(profileDir);
  const args = firefoxCommandLine(opts, profileDir);
  debugLog('browser', `launch ${found.executablePath} ${args.join(' ')}`);
  const env: Record<string, string | undefined> = {
    ...process.env,
    MOZ_CRASHREPORTER_DISABLE: '1',
    MOZ_CRASHREPORTER_SHUTDOWN: '1',
    MOZ_DISABLE_AUTO_SAFE_MODE: '1',
    ...(opts.env ?? {}),
  };
  const child = spawn(found.executablePath, args, {
    detached: process.platform !== 'win32',
    env: env as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const untrack = trackLiveBrowser({ pid: child.pid, userDataDir: profileDir, temp }, opts.handleSignals);
  const stderrTail: string[] = [];
  let resolveWs!: (u: string) => void;
  const wsUrl = new Promise<string>((r) => {
    resolveWs = r;
  });
  let partial = '';
  const onData = (d: Buffer) => {
    const lines = (partial + d.toString('utf8')).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      stderrTail.push(line);
      if (stderrTail.length > 40) stderrTail.shift();
      debugLog('browser', `stderr: ${line}`);
      const m = /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(line);
      if (m) resolveWs(m[1]);
    }
  };
  child.stderr?.on('data', onData);
  child.stdout?.on('data', onData);
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      debugLog('browser', `process ${child.pid} exited with ${code}`);
      untrack();
      resolve(code);
    });
    child.once('error', () => resolve(null));
  });
  const fail = async (message: string): Promise<never> => {
    killTree(child.pid);
    untrack();
    if (temp) await removeDir(profileDir);
    throw new Error(`${message}${stderrTail.length ? `\nBrowser output:\n${stderrTail.slice(-15).join('\n')}` : ''}`);
  };
  const spawnError = await new Promise<Error | undefined>((resolve) => {
    child.once('spawn', () => resolve(undefined));
    child.once('error', (e) => resolve(e));
  });
  if (spawnError) return fail(`Failed to start Firefox at ${found.executablePath}: ${spawnError.message}`);
  const timeout = opts.timeout ?? 180_000;
  let timer: NodeJS.Timeout | undefined;
  const endpoint = await Promise.race([
    wsUrl,
    exited.then((code) => `exit:${code}`),
    new Promise<string>((r) => {
      timer = setTimeout(() => r('timeout'), timeout > 0 ? timeout : 180_000);
    }),
  ]);
  clearTimeout(timer);
  if (endpoint === 'timeout') return fail(`browserType.launch: timed out after ${timeout} ms waiting for the WebDriver BiDi endpoint`);
  if (endpoint.startsWith('exit:')) return fail(`browserType.launch: Firefox exited (code ${endpoint.slice(5)}) before its WebDriver BiDi endpoint was ready`);
  let transport: Transport;
  try {
    transport = await WebSocketTransport.connect(`${endpoint.replace(/\/$/, '')}/session`, 30_000);
  } catch (e) {
    return fail(`browserType.launch: ${(e as Error).message}`);
  }
  let killed = false;
  const kill = async () => {
    if (killed) return;
    killed = true;
    // Grace timers are cleared once the browser exits (they would keep the host process alive).
    const done = await settleWithin(exited.then(() => true), 3000, false);
    killTree(child.pid);
    if (!done) await settleWithin(exited, 2000, undefined);
    untrack();
    if (temp) await removeDir(profileDir);
  };
  return { process: child, transport, found, userDataDir: profileDir, wsEndpoint: endpoint, kill, exited, stderrTail };
}
