/**
 * Locating a Chromium-family browser binary.
 *
 * Order:
 *  1. `executablePath` (explicit).
 *  2. `channel`: an installed Google Chrome / Microsoft Edge build at its
 *     standard install location on Windows, macOS or Linux.
 *  3. Environment: EZTEST_CHROMIUM_PATH, then CHROME_PATH.
 *  4. The EZTest browser cache (EZTEST_BROWSERS_PATH, default
 *     ~/.cache/eztest/browsers on Linux, ~/Library/Caches/eztest/browsers on
 *     macOS, %LOCALAPPDATA%\eztest\browsers on Windows), newest version first.
 *  5. An installed Google Chrome (stable), then Microsoft Edge (stable), then
 *     a system Chromium (Linux).
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ChromiumChannel =
  | 'chromium'
  | 'chromium-headless-shell'
  | 'chrome'
  | 'chrome-beta'
  | 'chrome-dev'
  | 'chrome-canary'
  | 'msedge'
  | 'msedge-beta'
  | 'msedge-dev'
  | 'msedge-canary';

export interface FindOptions {
  executablePath?: string;
  channel?: string;
  /** Prefer the headless shell build when looking in caches (default false). */
  headlessShell?: boolean;
}

export interface FoundBrowser {
  executablePath: string;
  /** Where it was found, for messages and `eztest doctor`. */
  source: 'executablePath' | 'channel' | 'env' | 'eztest-cache' | 'system';
  /** True for a chrome-headless-shell binary (old headless; no --headless=new). */
  headlessShell: boolean;
}

/** The EZTest browser cache directory. */
export function browserCacheDir(): string {
  if (process.env.EZTEST_BROWSERS_PATH) return process.env.EZTEST_BROWSERS_PATH;
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'eztest', 'browsers');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'eztest', 'browsers');
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'eztest', 'browsers');
}

/** Chrome-for-Testing platform key for this machine. */
export function cftPlatform(): 'linux64' | 'mac-arm64' | 'mac-x64' | 'win64' | 'win32' {
  if (process.platform === 'linux') return 'linux64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (process.platform === 'win32') return process.arch === 'ia32' ? 'win32' : 'win64';
  throw new Error(`Chrome for Testing has no build for ${process.platform}/${process.arch}`);
}

/** Path of the browser binary inside an extracted Chrome-for-Testing archive folder. */
export function cftBinaryInArchive(kind: 'chrome' | 'chrome-headless-shell', platform = cftPlatform()): string {
  const dir = `${kind}-${platform}`;
  if (kind === 'chrome-headless-shell') return join(dir, platform.startsWith('win') ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
  if (platform.startsWith('mac')) return join(dir, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
  if (platform.startsWith('win')) return join(dir, 'chrome.exe');
  return join(dir, 'chrome');
}

/** Standard install locations of branded channels. */
export function channelCandidates(channel: string, platform: NodeJS.Platform = process.platform): string[] {
  const linux: Record<string, string[]> = {
    chrome: ['/opt/google/chrome/chrome'],
    'chrome-beta': ['/opt/google/chrome-beta/chrome'],
    'chrome-dev': ['/opt/google/chrome-unstable/chrome'],
    'chrome-canary': ['/opt/google/chrome-canary/chrome'],
    msedge: ['/opt/microsoft/msedge/msedge'],
    'msedge-beta': ['/opt/microsoft/msedge-beta/msedge'],
    'msedge-dev': ['/opt/microsoft/msedge-dev/msedge'],
    'msedge-canary': ['/opt/microsoft/msedge-canary/msedge'],
  };
  const mac: Record<string, string> = {
    chrome: 'Google Chrome',
    'chrome-beta': 'Google Chrome Beta',
    'chrome-dev': 'Google Chrome Dev',
    'chrome-canary': 'Google Chrome Canary',
    msedge: 'Microsoft Edge',
    'msedge-beta': 'Microsoft Edge Beta',
    'msedge-dev': 'Microsoft Edge Dev',
    'msedge-canary': 'Microsoft Edge Canary',
  };
  const win: Record<string, string> = {
    chrome: 'Google\\Chrome\\Application\\chrome.exe',
    'chrome-beta': 'Google\\Chrome Beta\\Application\\chrome.exe',
    'chrome-dev': 'Google\\Chrome Dev\\Application\\chrome.exe',
    'chrome-canary': 'Google\\Chrome SxS\\Application\\chrome.exe',
    msedge: 'Microsoft\\Edge\\Application\\msedge.exe',
    'msedge-beta': 'Microsoft\\Edge Beta\\Application\\msedge.exe',
    'msedge-dev': 'Microsoft\\Edge Dev\\Application\\msedge.exe',
    'msedge-canary': 'Microsoft\\Edge SxS\\Application\\msedge.exe',
  };
  if (platform === 'linux') return linux[channel] ?? [];
  if (platform === 'darwin') {
    const app = mac[channel];
    return app ? [`/Applications/${app}.app/Contents/MacOS/${app}`, join(homedir(), 'Applications', `${app}.app`, 'Contents', 'MacOS', app)] : [];
  }
  if (platform === 'win32') {
    const rel = win[channel];
    if (!rel) return [];
    const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], 'C:\\Program Files', 'C:\\Program Files (x86)'];
    return [...new Set(roots.filter((r): r is string => !!r).map((r) => `${r}\\${rel}`))];
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

/** Compare dotted versions numerically, descending. */
function byVersionDesc(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Installed builds in the EZTest cache: `<cache>/<kind>-<version>/<archive folder>/...`. */
export function cachedBuilds(kind: 'chrome' | 'chrome-headless-shell', dir = browserCacheDir()): Array<{ version: string; executablePath: string }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ version: string; executablePath: string }> = [];
  for (const name of readdirSync(dir)) {
    const m = new RegExp(`^${kind}-(\\d[\\d.]*)$`).exec(name);
    if (!m) continue;
    const exe = join(dir, name, cftBinaryInArchive(kind));
    if (isFile(exe)) out.push({ version: m[1], executablePath: exe });
  }
  return out.sort((a, b) => byVersionDesc(a.version, b.version));
}

/** Find a browser binary, or throw an error that says how to get one. */
export function findChromium(opts: FindOptions = {}): FoundBrowser {
  if (opts.executablePath) {
    if (!isFile(opts.executablePath)) throw new Error(`Browser executable not found at "${opts.executablePath}" (executablePath)`);
    return { executablePath: opts.executablePath, source: 'executablePath', headlessShell: /headless[-_]shell/i.test(opts.executablePath) };
  }
  const channel = opts.channel && opts.channel !== 'chromium' ? opts.channel : undefined;
  const wantShell = opts.headlessShell === true || channel === 'chromium-headless-shell';
  if (channel && channel !== 'chromium-headless-shell') {
    const hit = channelCandidates(channel).find(isFile);
    if (hit) return { executablePath: hit, source: 'channel', headlessShell: false };
    const tried = channelCandidates(channel);
    throw new Error(
      `Browser channel "${channel}" is not installed${tried.length ? ` (looked in: ${tried.join(', ')})` : ' (unknown channel on this platform)'}. ` +
        `Install it, set executablePath, or use the bundled Chromium (run "eztest install-browsers").`,
    );
  }
  for (const v of ['EZTEST_CHROMIUM_PATH', 'CHROME_PATH']) {
    const p = process.env[v];
    if (p && isFile(p)) return { executablePath: p, source: 'env', headlessShell: /headless[-_]shell/i.test(p) };
  }
  const kinds: Array<'chrome' | 'chrome-headless-shell'> = wantShell ? ['chrome-headless-shell', 'chrome'] : ['chrome', 'chrome-headless-shell'];
  for (const k of kinds) {
    const b = cachedBuilds(k)[0];
    if (b) return { executablePath: b.executablePath, source: 'eztest-cache', headlessShell: k === 'chrome-headless-shell' };
  }
  for (const c of ['chrome', 'msedge']) {
    const hit = channelCandidates(c).find(isFile);
    if (hit) return { executablePath: hit, source: 'system', headlessShell: false };
  }
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/snap/bin/chromium']) {
    if (process.platform === 'linux' && isFile(p)) return { executablePath: p, source: 'system', headlessShell: false };
  }
  throw new Error(
    'No Chromium-family browser found. Run "eztest install-browsers" to download Chrome for Testing into ' +
      `${browserCacheDir()}, install Google Chrome or Microsoft Edge (and set channel), or set executablePath / EZTEST_CHROMIUM_PATH.`,
  );
}
