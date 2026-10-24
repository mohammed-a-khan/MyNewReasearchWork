/**
 * Starting and stopping a Chromium-family browser process.
 *
 * - The protocol runs over `--remote-debugging-pipe` (fd 3 = commands to the
 *   browser, fd 4 = messages from it). No TCP port is opened.
 * - Each launch gets a fresh temporary profile, removed on close, on exit and
 *   on SIGINT / SIGTERM / SIGHUP (see temp-dirs.ts; stale ones are swept).
 * - The browser is started in its own process group (POSIX) so close() can
 *   take down every helper process (renderers, GPU, zygote) at once.
 * - `--no-sandbox` is NOT added by default. It is added only when running as
 *   root (uid 0), which is where Chromium refuses to start sandboxed - the usual
 *   case in Docker containers. EZTEST_CHROMIUM_SANDBOX=0 turns it off for
 *   unprivileged container users too (containers usually allow no user
 *   namespaces; the EZTest image sets it), =1 forces it. Pass
 *   `chromiumSandbox: true` to force the sandbox, or add `--no-sandbox` to
 *   args yourself.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import { debugLog } from '../debug.js';
import { PipeTransport, WebSocketTransport, type Transport } from '../transport/transport.js';
import { redactUrl } from '../transport/websocket.js';
import { findChromium, type FoundBrowser } from './find.js';
import { settleWithin } from '../util.js';
import { makeTempDir, removeTrackedTempDirsSync, sweepStaleTempDirsOnce, trackTempDir, untrackTempDir } from './temp-dirs.js';

export interface LaunchProcessOptions {
  executablePath?: string;
  channel?: string;
  /** Default true. 'shell' forces the old headless (headless shell semantics). */
  headless?: boolean;
  args?: string[];
  /** Drop some of the default flags (true = all of them). */
  ignoreDefaultArgs?: boolean | string[];
  env?: Record<string, string | undefined>;
  /** Use this profile directory instead of a temporary one (kept on close). */
  userDataDir?: string;
  /** Force (true) or disable (false) the sandbox. Default: sandbox unless running as root. */
  chromiumSandbox?: boolean;
  /** Milliseconds to wait for the browser to start. Default 180000. */
  timeout?: number;
  /** Where downloads go when not otherwise configured. */
  downloadsPath?: string;
  /** Proxy server, e.g. http://proxy:8080 */
  proxy?: { server: string; bypass?: string };
  /** Start maximized / devtools etc. are just args; nothing special. */
  devtools?: boolean;
  /** Called with stderr lines (e.g. for logs). */
  onStderr?: (line: string) => void;
  /** Kill the browser and remove its temporary profile on these signals (each default true). */
  handleSignals?: SignalHandling;
}

export interface LaunchedProcess {
  process: ChildProcess;
  transport: Transport;
  found: FoundBrowser;
  userDataDir: string;
  /** Close gracefully (the caller sends Browser.close first), then kill the process group. */
  kill(): Promise<void>;
  /** Resolves when the process has exited. */
  exited: Promise<number | null>;
}

/** Default flags: quiet, deterministic, no first-run UI, no background traffic. */
export function defaultChromiumArgs(): string[] {
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--no-service-autorun',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-breakpad',
    '--disable-client-side-phishing-detection',
    '--disable-component-extensions-with-background-pages',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-hang-monitor',
    '--disable-ipc-flooding-protection',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-sync',
    '--disable-search-engine-choice-screen',
    '--disable-domain-reliability',
    '--metrics-recording-only',
    '--password-store=basic',
    '--use-mock-keychain',
    '--force-color-profile=srgb',
    '--allow-pre-commit-input',
    // Features that add background traffic, prompts or nondeterminism to tests.
    '--disable-features=Translate,MediaRouter,DialMediaRouteProvider,OptimizationHints,InterestFeedContentSuggestions,CalculateNativeWinOcclusion,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,LensOverlay,AutofillServerCommunication,CertificateTransparencyComponentUpdater,PrivacySandboxSettings4,ThirdPartyStoragePartitioning,PaintHolding,AcceptCHFrame,DestroyProfileOnBrowserClose',
  ];
  if (process.platform === 'linux') args.push('--disable-dev-shm-usage');
  return args;
}

function isRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** EZTEST_CHROMIUM_SANDBOX=0|false turns the sandbox off, 1|true forces it; unset: undefined. */
export function sandboxFromEnv(v = process.env.EZTEST_CHROMIUM_SANDBOX): boolean | undefined {
  if (v === undefined || v === '') return undefined;
  return !/^(0|false|no|off)$/i.test(v.trim());
}

/** Which termination signals a launch wants handled (launch options handleSIGINT / handleSIGTERM / handleSIGHUP, default true). */
export interface SignalHandling {
  SIGINT?: boolean;
  SIGTERM?: boolean;
  SIGHUP?: boolean;
}

interface LiveBrowser {
  pid?: number;
  userDataDir?: string;
  temp: boolean;
  signals: Required<SignalHandling>;
}

const HANDLED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
type HandledSignal = (typeof HANDLED_SIGNALS)[number];
const SIGNAL_NUMBER: Record<HandledSignal, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

/** Every live browser, so a crashing, exiting or interrupted process does not leave browsers or profiles behind. */
const live = new Set<LiveBrowser>();
let exitHookInstalled = false;
const signalHooks = new Map<HandledSignal, () => void>();

function removeProfile(b: LiveBrowser): void {
  if (!b.temp || !b.userDataDir) return;
  try {
    rmSync(b.userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* best effort; a later sweep removes it */
  }
  untrackTempDir(b.userDataDir);
}

/** Kill every live browser and remove every temporary profile and download folder of this process, now. */
export function cleanupBrowsersNow(only?: (b: LiveBrowser) => boolean): void {
  for (const b of [...live]) {
    if (only && !only(b)) continue;
    killTree(b.pid);
    removeProfile(b);
    live.delete(b);
  }
  // Download folders and other tracked dirs belong to the browsers just killed; with some browsers
  // left running (they opted out of this signal) they stay.
  if (!live.size) removeTrackedTempDirsSync();
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => cleanupBrowsersNow());
}

/**
 * On SIGINT / SIGTERM / SIGHUP: kill the browsers that handle that signal and remove their
 * temporary directories. When nothing else listens for the signal, the signal is raised again
 * so the process ends the way it would have without EZTest (exit status 128 + signal number);
 * a host that listens itself (the `eztest run` command) decides how to finish.
 */
function installSignalHook(sig: HandledSignal): void {
  if (signalHooks.has(sig)) return;
  const handler = () => {
    debugLog('browser', `${sig}: closing ${live.size} browser(s) and removing temporary profiles`);
    cleanupBrowsersNow((b) => b.signals[sig]);
    if (process.listenerCount(sig) <= 1) {
      process.removeListener(sig, handler);
      signalHooks.delete(sig);
      try {
        process.kill(process.pid, sig);
      } catch {
        process.exit(128 + SIGNAL_NUMBER[sig]);
      }
    }
  };
  signalHooks.set(sig, handler);
  process.on(sig, handler);
}

/** Internal: remember a launched browser so it is killed (and its temporary profile removed) when this process exits or is interrupted. */
export function trackLiveBrowser(record: { pid?: number; userDataDir?: string; temp: boolean }, signals: SignalHandling = {}): () => void {
  const entry: LiveBrowser = { ...record, signals: { SIGINT: signals.SIGINT ?? true, SIGTERM: signals.SIGTERM ?? true, SIGHUP: signals.SIGHUP ?? true } };
  live.add(entry);
  if (record.temp && record.userDataDir) trackTempDir(record.userDataDir);
  installExitHook();
  for (const sig of HANDLED_SIGNALS) if (entry.signals[sig] && (process.platform !== 'win32' || sig === 'SIGINT')) installSignalHook(sig);
  sweepStaleTempDirsOnce();
  return () => {
    live.delete(entry);
  };
}

/** Kill a process and its process group (all helper processes). */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/** Build the full command line for a launch. */
export function chromiumCommandLine(opts: LaunchProcessOptions, found: FoundBrowser, userDataDir: string): string[] {
  const ignore = opts.ignoreDefaultArgs;
  let args = ignore === true ? [] : defaultChromiumArgs();
  if (Array.isArray(ignore)) args = args.filter((a) => !ignore.includes(a));
  args.push('--remote-debugging-pipe', `--user-data-dir=${userDataDir}`);
  const headless = opts.headless ?? !opts.devtools;
  if (headless) {
    args.push(found.headlessShell ? '--headless' : '--headless=new', '--hide-scrollbars', '--mute-audio');
    // Headless has no real pointer: report a mouse so hover media queries behave like a desktop.
    args.push('--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4');
  }
  if (opts.devtools) args.push('--auto-open-devtools-for-tabs');
  const userArgs = opts.args ?? [];
  const sandbox = opts.chromiumSandbox ?? sandboxFromEnv() ?? !isRoot();
  if (!sandbox && !userArgs.includes('--no-sandbox')) args.push('--no-sandbox');
  if (opts.proxy) {
    args.push(`--proxy-server=${opts.proxy.server}`);
    if (opts.proxy.bypass) args.push(`--proxy-bypass-list=${opts.proxy.bypass}`);
  }
  args.push(...userArgs);
  // Start without any window: pages are created per context through the protocol.
  if (!userArgs.some((a) => !a.startsWith('-'))) args.push('--no-startup-window');
  return args;
}

/** Launch a browser over the protocol pipe. */
export async function launchChromiumProcess(opts: LaunchProcessOptions = {}): Promise<LaunchedProcess> {
  // Headless runs prefer the headless shell build when one is installed (lighter and faster); headed runs need the full browser.
  const headless = opts.headless ?? !opts.devtools;
  const found = findChromium({ executablePath: opts.executablePath, channel: opts.channel, headlessShell: headless && process.env.EZTEST_HEADLESS_SHELL !== '0' });
  const temp = !opts.userDataDir;
  const userDataDir = opts.userDataDir ?? makeTempDir('profile');
  const args = chromiumCommandLine(opts, found, userDataDir);
  debugLog('browser', `launch ${found.executablePath} ${args.join(' ')}`);
  const env = { ...process.env, ...(opts.env ?? {}) };
  const child = spawn(found.executablePath, args, {
    detached: process.platform !== 'win32',
    env: env as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const untrack = trackLiveBrowser({ pid: child.pid, userDataDir, temp }, opts.handleSignals);
  const stderrTail: string[] = [];
  const onLine = (line: string) => {
    if (!line) return;
    stderrTail.push(line);
    if (stderrTail.length > 40) stderrTail.shift();
    opts.onStderr?.(line);
    debugLog('browser', `stderr: ${line}`);
  };
  let partial = '';
  child.stderr?.on('data', (d: Buffer) => {
    const lines = (partial + d.toString('utf8')).split('\n');
    partial = lines.pop() ?? '';
    lines.forEach(onLine);
  });
  child.stdout?.on('data', () => undefined);
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      debugLog('browser', `process ${child.pid} exited with ${code}`);
      untrack();
      resolve(code);
    });
    child.once('error', () => resolve(null));
  });
  const spawnError = await new Promise<Error | undefined>((resolve) => {
    child.once('spawn', () => resolve(undefined));
    child.once('error', (e) => resolve(e));
  });
  if (spawnError) {
    untrack();
    if (temp) await removeDir(userDataDir);
    throw new Error(`Failed to start the browser at ${found.executablePath}: ${spawnError.message}`);
  }
  const stdio = child.stdio as unknown as [unknown, Readable, Readable, Writable, Readable];
  const transport = new PipeTransport(stdio[3], stdio[4]);
  let killed = false;
  const kill = async () => {
    if (!killed) {
      killed = true;
      // Give the browser a moment to exit by itself (Browser.close was sent), then kill the group.
      // The grace timers are cleared as soon as the browser exits: a pending timer would keep the
      // host process (a CLI run, a test worker) alive for seconds after the browser is gone.
      const done = await settleWithin(exited.then(() => true), 3000, false);
      killTree(child.pid);
      if (!done) await settleWithin(exited, 2000, undefined);
      untrack();
      if (temp) await removeDir(userDataDir);
    }
  };
  return {
    process: child,
    transport,
    found,
    userDataDir,
    kill,
    exited,
    // Exposed for error messages.
    ...{ stderrTail },
  } as LaunchedProcess;
}

/** Last stderr lines of a launched process (for launch failure messages). */
export function stderrTailOf(p: LaunchedProcess): string {
  return ((p as unknown as { stderrTail?: string[] }).stderrTail ?? []).slice(-15).join('\n');
}

/** Remove a directory, retrying while a dying browser still holds files in it. */
export async function removeDir(dir: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      untrackTempDir(dir);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
  }
}

/** Connect to an already running browser's WebSocket endpoint (ws://host:port/devtools/browser/<id>). */
export async function connectWebSocket(wsEndpoint: string, timeoutMs = 30_000, headers?: Record<string, string>): Promise<Transport> {
  return WebSocketTransport.connect(wsEndpoint, timeoutMs, headers);
}

/**
 * Resolve an http(s)://host:port DevTools endpoint to its browser WebSocket URL via /json/version
 * (`headers` go on that request). A browser behind a port mapping or a proxy reports its own
 * address (ws://127.0.0.1:9222/... or ws://0.0.0.0:9222/...); the host, port and scheme are then
 * taken from the endpoint that was asked, keeping the browser's path.
 */
export async function resolveBrowserWsEndpoint(endpoint: string, headers?: Record<string, string>, timeoutMs = 30_000): Promise<string> {
  if (/^wss?:/i.test(endpoint)) return endpoint;
  const base = new URL(endpoint);
  const url = new URL(`${base.pathname.replace(/\/+$/, '')}/json/version${base.search}`, base);
  const auth: Record<string, string> = base.username ? { Authorization: `Basic ${Buffer.from(`${decodeURIComponent(base.username)}:${decodeURIComponent(base.password)}`).toString('base64')}` } : {};
  url.username = '';
  url.password = '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { headers: { ...auth, ...(headers ?? {}) }, signal: ctrl.signal });
  } catch (e) {
    throw new Error(`Could not reach the DevTools endpoint ${redactUrl(url.toString())}: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`${redactUrl(url.toString())} answered ${res.status}`);
  const body = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!body.webSocketDebuggerUrl) throw new Error(`${redactUrl(url.toString())} did not report webSocketDebuggerUrl`);
  const ws = new URL(body.webSocketDebuggerUrl);
  const local = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])$/i.test(ws.hostname);
  if (local && (ws.host !== base.host || base.protocol === 'https:')) {
    ws.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    ws.host = base.host;
  }
  // Credentials and query (a vendor token) of the endpoint carry over to the WebSocket.
  if (base.username) {
    ws.username = base.username;
    ws.password = base.password;
  }
  for (const [k, v] of base.searchParams) if (!ws.searchParams.has(k)) ws.searchParams.set(k, v);
  return ws.toString();
}
