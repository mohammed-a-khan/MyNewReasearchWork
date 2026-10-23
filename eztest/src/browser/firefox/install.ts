/**
 * `eztest install-browsers firefox[@version]`: download a Firefox release
 * from Mozilla's official archive into the EZTest browser cache.
 *
 * - Version: `firefox@<version>` / `--browser-version` (e.g. 140.4.0esr),
 *   EZTEST_FIREFOX_VERSION, else the latest release (`firefox`) or the latest
 *   ESR (`firefox-esr`) from Mozilla's product-details index.
 * - Download: <base>/releases/<version>/<platform>/<locale>/<file>, base
 *   https://archive.mozilla.org/pub/firefox (--download-base /
 *   EZTEST_FIREFOX_DOWNLOAD_BASE for mirrors).
 * - Verification: the archive's SHA-512 must match its line in the release's
 *   SHA512SUMS file (same server). Without that line the install fails,
 *   unless --insecure-skip-checksum.
 * - Unpacking uses the platform's own tools: `tar` (Linux .tar.xz /
 *   .tar.bz2), `hdiutil` (macOS .dmg), the installer's /ExtractDir (Windows).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserCacheDir } from '../launcher/find.js';
import { httpGet } from '../launcher/install.js';
import { firefoxBinaryInInstall } from './launch.js';

export const MOZILLA_ARCHIVE = 'https://archive.mozilla.org/pub/firefox';
export const PRODUCT_DETAILS = 'https://product-details.mozilla.org/1.0/firefox_versions.json';

/** Mozilla's platform folder for this machine. */
export function mozillaPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  if (platform === 'linux') return arch === 'arm64' ? 'linux-aarch64' : arch === 'ia32' ? 'linux-i686' : 'linux-x86_64';
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return arch === 'arm64' ? 'win64-aarch64' : arch === 'ia32' ? 'win32' : 'win64';
  throw new Error(`Mozilla publishes no Firefox build for ${platform}/${arch}`);
}

/** Major version number of a Firefox version string ("140.4.0esr" -> 140). */
function major(version: string): number {
  return Number(/^(\d+)/.exec(version)?.[1] ?? 0);
}

/** Archive file name of a release on a platform. Linux builds are .tar.xz from Firefox 135 on (.tar.bz2 before). */
export function firefoxArchiveName(version: string, platform: NodeJS.Platform = process.platform, _arch: string = process.arch): string {
  if (platform === 'linux') return `firefox-${version}.${major(version) >= 135 ? 'tar.xz' : 'tar.bz2'}`;
  if (platform === 'darwin') return `Firefox ${version}.dmg`;
  if (platform === 'win32') return `Firefox Setup ${version}.exe`;
  throw new Error(`Mozilla publishes no Firefox build for ${platform}`);
}

/** Download URL, SHA512SUMS URL and the archive's key in SHA512SUMS. */
export function firefoxDownloadUrl(version: string, o: { platform?: NodeJS.Platform; arch?: string; locale?: string; base?: string } = {}): { url: string; sumsUrl: string; sumsKey: string } {
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const locale = o.locale ?? 'en-US';
  const base = (o.base ?? MOZILLA_ARCHIVE).replace(/\/+$/, '');
  const file = firefoxArchiveName(version, platform, arch);
  const sumsKey = `${mozillaPlatform(platform, arch)}/${locale}/${file}`;
  return {
    url: `${base}/releases/${encodeURIComponent(version)}/${sumsKey.split('/').map(encodeURIComponent).join('/')}`,
    sumsUrl: `${base}/releases/${encodeURIComponent(version)}/SHA512SUMS`,
    sumsKey,
  };
}

/** Parse a SHA512SUMS file ("<hex>  <path>" per line) into path -> hex. */
export function parseSha512Sums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{128})\s+\*?(.+?)\s*$/i.exec(line);
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

/** Check bytes against an expected SHA-512 (hex). Throws on mismatch. */
export function verifySha512(body: Buffer, expectedHex: string): true {
  const got = createHash('sha512').update(body).digest('hex');
  if (got !== expectedHex.toLowerCase()) throw new Error(`SHA-512 mismatch: expected ${expectedHex}, got ${got}`);
  return true;
}

export interface FirefoxInstallOptions {
  /** Exact version (e.g. 140.4.0esr); default: latest release, or latest ESR with `esr`. */
  version?: string;
  esr?: boolean;
  locale?: string;
  downloadBase?: string;
  insecureSkipChecksum?: boolean;
  dir?: string;
  force?: boolean;
  log?: (line: string) => void;
}

export interface FirefoxInstallResult {
  version: string;
  executablePath: string;
  dir: string;
  alreadyInstalled: boolean;
  verified: string[];
}

async function resolveFirefoxVersion(o: FirefoxInstallOptions): Promise<string> {
  const explicit = o.version ?? process.env.EZTEST_FIREFOX_VERSION;
  if (explicit) return explicit;
  const res = await httpGet(process.env.EZTEST_FIREFOX_VERSIONS_URL ?? PRODUCT_DETAILS).catch((e: Error) => {
    throw new Error(`Could not read Mozilla's version index: ${e.message}. Pass firefox@<version> (e.g. firefox@140.4.0esr).`);
  });
  if (res.status !== 200) throw new Error(`Mozilla's version index answered ${res.status}. Pass firefox@<version>.`);
  const json = JSON.parse(res.body.toString('utf8')) as Record<string, string>;
  const v = o.esr ? json.FIREFOX_ESR : json.LATEST_FIREFOX_VERSION;
  if (!v) throw new Error('Mozilla\'s version index has no such version');
  return v;
}

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) throw new Error(`${cmd} failed to start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${r.stderr.toString().trim()}`);
}

/** Unpack an archive into `dest` with the platform's tools (see the module comment). */
async function unpack(archive: string, dest: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'linux') {
    run('tar', ['-xf', archive, '-C', dest]);
    return;
  }
  if (platform === 'darwin') {
    const mount = await mkdtemp(join(tmpdir(), 'eztest-ff-dmg-'));
    run('hdiutil', ['attach', '-nobrowse', '-noautoopen', '-mountpoint', mount, archive]);
    try {
      const app = (await readdir(mount)).find((n) => n.endsWith('.app'));
      if (!app) throw new Error('The disk image holds no .app');
      await cp(join(mount, app), join(dest, 'Firefox.app'), { recursive: true, verbatimSymlinks: true });
    } finally {
      spawnSync('hdiutil', ['detach', mount, '-quiet']);
      await rm(mount, { recursive: true, force: true });
    }
    return;
  }
  run(archive, [`/ExtractDir=${dest}`]);
}

export async function installFirefox(o: FirefoxInstallOptions = {}): Promise<FirefoxInstallResult> {
  const log = o.log ?? (() => undefined);
  const version = await resolveFirefoxVersion(o);
  const platform = process.platform;
  const root = o.dir ?? browserCacheDir();
  const dir = join(root, `firefox-${version}`);
  const exe = firefoxBinaryInInstall(dir, platform);
  if (existsSync(exe) && !o.force) {
    log(`firefox ${version} is already installed at ${exe}`);
    return { version, executablePath: exe, dir, alreadyInstalled: true, verified: [] };
  }
  const { url, sumsUrl, sumsKey } = firefoxDownloadUrl(version, { locale: o.locale, base: o.downloadBase ?? process.env.EZTEST_FIREFOX_DOWNLOAD_BASE });
  const verified: string[] = [];
  let expected: string | undefined;
  const sums = await httpGet(sumsUrl).catch(() => undefined);
  if (sums?.status === 200) expected = parseSha512Sums(sums.body.toString('utf8')).get(sumsKey);
  if (!expected && !o.insecureSkipChecksum) throw new Error(`No SHA-512 for ${sumsKey} in ${sumsUrl} (pass --insecure-skip-checksum to install unverified)`);
  log(`downloading ${url}`);
  let lastPct = -1;
  const res = await httpGet(url, (got, total) => {
    if (!total) return;
    const pct = Math.floor((got / total) * 10) * 10;
    if (pct !== lastPct) {
      lastPct = pct;
      log(`  ${pct}% of ${(total / 1048576).toFixed(0)} MB`);
    }
  });
  if (res.status !== 200) throw new Error(`Download failed: ${url} answered ${res.status}`);
  if (expected) {
    verifySha512(res.body, expected);
    verified.push('sha512 (SHA512SUMS)');
  }
  log(`verified: ${verified.join(', ') || 'nothing (skipped)'}`);
  const tmp = `${dir}.partial-${process.pid}`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const archive = join(tmp, url.split('/').pop()!.replace(/%20/g, ' '));
  await writeFile(archive, res.body);
  await unpack(archive, tmp, platform);
  await rm(archive, { force: true });
  await rm(dir, { recursive: true, force: true });
  await rename(tmp, dir);
  if (!existsSync(exe)) throw new Error(`The archive did not contain ${exe}`);
  await writeFile(join(dir, 'eztest-install.json'), JSON.stringify({ kind: 'firefox', version, platform, url, sha512: expected, verified, installedAt: new Date().toISOString() }, null, 2));
  return { version, executablePath: exe, dir, alreadyInstalled: false, verified };
}
