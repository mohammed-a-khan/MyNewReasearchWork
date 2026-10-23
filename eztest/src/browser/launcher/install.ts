/**
 * `eztest install-browsers`: download Chrome for Testing (or its headless
 * shell) into the EZTest browser cache, verifying the archive.
 *
 * Version source (first that applies):
 *   --version <v>                      exact version, e.g. 141.0.7390.54
 *   EZTEST_CFT_VERSION                 same, from the environment
 *   --versions-url / EZTEST_CFT_VERSIONS_URL
 *                                      a JSON index in the Chrome-for-Testing
 *                                      "last-known-good-versions" format
 *                                      (default: the public index on
 *                                      googlechromelabs.github.io)
 * Download base: --download-base / EZTEST_CFT_DOWNLOAD_BASE (default
 * https://storage.googleapis.com/chrome-for-testing-public), so mirrors work.
 *
 * Verification: the MD5 and CRC32C the storage server reports for the object
 * (x-goog-hash header) must match the downloaded bytes, and, when given,
 * the expected SHA-256 (--sha256). If the server reports no hash and no
 * SHA-256 is given, installation fails unless --insecure-skip-checksum.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { join } from 'node:path';
import { browserCacheDir, cftBinaryInArchive, cftPlatform } from './find.js';
import { extractZip } from './unzip.js';

export interface InstallOptions {
  /** 'chrome' (Chrome for Testing, default) or 'chrome-headless-shell'. */
  kind?: 'chrome' | 'chrome-headless-shell';
  version?: string;
  /** Release channel to take from the versions index. Default Stable. */
  channel?: 'Stable' | 'Beta' | 'Dev' | 'Canary';
  versionsUrl?: string;
  downloadBase?: string;
  sha256?: string;
  insecureSkipChecksum?: boolean;
  /** Install directory (default: the EZTest browser cache). */
  dir?: string;
  force?: boolean;
  log?: (line: string) => void;
}

export interface InstallResult {
  version: string;
  executablePath: string;
  dir: string;
  alreadyInstalled: boolean;
  verified: string[];
}

const DEFAULT_INDEX = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json';
const DEFAULT_BASE = 'https://storage.googleapis.com/chrome-for-testing-public';

function proxyFor(url: URL): URL | undefined {
  const noProxy = (process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const host = url.hostname;
  if (noProxy.some((n) => n === '*' || host === n || (n.startsWith('.') ? host.endsWith(n) : host.endsWith(`.${n}`)))) return undefined;
  const p = url.protocol === 'https:' ? (process.env.HTTPS_PROXY ?? process.env.https_proxy) : (process.env.HTTP_PROXY ?? process.env.http_proxy);
  return p ? new URL(p) : undefined;
}

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** GET with redirects and HTTP(S)_PROXY support (CONNECT tunnel for https). */
export async function httpGet(url: string, onProgress?: (received: number, total: number) => void, redirects = 5): Promise<HttpResult> {
  const u = new URL(url);
  const proxy = proxyFor(u);
  const res = await new Promise<HttpResult>((resolve, reject) => {
    const handle = (resp: import('node:http').IncomingMessage) => {
      const chunks: Buffer[] = [];
      let got = 0;
      const total = Number(resp.headers['content-length'] ?? 0);
      resp.on('data', (c: Buffer) => {
        chunks.push(c);
        got += c.length;
        onProgress?.(got, total);
      });
      resp.on('end', () => resolve({ status: resp.statusCode ?? 0, headers: resp.headers, body: Buffer.concat(chunks) }));
      resp.on('error', reject);
    };
    if (proxy && u.protocol === 'https:') {
      const connectReq = httpRequest({ host: proxy.hostname, port: Number(proxy.port || 80), method: 'CONNECT', path: `${u.hostname}:${u.port || 443}`, headers: { host: `${u.hostname}:${u.port || 443}` } });
      connectReq.on('connect', (cres, socket) => {
        if (cres.statusCode !== 200) {
          reject(new Error(`Proxy refused CONNECT to ${u.host}: ${cres.statusCode}`));
          socket.destroy();
          return;
        }
        const tlsSocket = tlsConnect({ socket, servername: u.hostname });
        const opts: RequestOptions = { host: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { host: u.host, 'user-agent': 'eztest-installer' }, createConnection: () => tlsSocket };
        const r = httpsRequest(opts, handle);
        r.on('error', reject);
        r.end();
      });
      connectReq.on('error', reject);
      connectReq.end();
    } else if (proxy) {
      const r = httpRequest({ host: proxy.hostname, port: Number(proxy.port || 80), path: u.href, method: 'GET', headers: { host: u.host } }, handle);
      r.on('error', reject);
      r.end();
    } else {
      const r = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, { headers: { 'user-agent': 'eztest-installer' } }, handle);
      r.on('error', reject);
      r.end();
    }
  });
  const loc = res.headers.location;
  if (res.status >= 300 && res.status < 400 && loc && redirects > 0) return httpGet(new URL(String(loc), u).href, onProgress, redirects - 1);
  return res;
}

/** CRC32C (Castagnoli), as used by Google Cloud Storage object hashes. */
export function crc32c(buf: Buffer): number {
  let table = (crc32c as unknown as { table?: Uint32Array }).table;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    (crc32c as unknown as { table?: Uint32Array }).table = table;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Verify a download against x-goog-hash and an optional SHA-256. Returns what was checked. */
export function verifyArchive(body: Buffer, googHash: string | string[] | undefined, sha256?: string): string[] {
  const checked: string[] = [];
  const hashes = (Array.isArray(googHash) ? googHash.join(',') : googHash ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const h of hashes) {
    const i = h.indexOf('=');
    const algo = h.slice(0, i);
    const value = h.slice(i + 1);
    if (algo === 'md5') {
      const got = createHash('md5').update(body).digest('base64');
      if (got !== value) throw new Error(`Checksum mismatch (md5): expected ${value}, got ${got}`);
      checked.push('md5');
    } else if (algo === 'crc32c') {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(crc32c(body));
      const got = b.toString('base64');
      if (got !== value) throw new Error(`Checksum mismatch (crc32c): expected ${value}, got ${got}`);
      checked.push('crc32c');
    }
  }
  if (sha256) {
    const got = createHash('sha256').update(body).digest('hex');
    if (got.toLowerCase() !== sha256.toLowerCase()) throw new Error(`Checksum mismatch (sha256): expected ${sha256}, got ${got}`);
    checked.push('sha256');
  }
  return checked;
}

async function resolveVersion(o: InstallOptions): Promise<string> {
  const explicit = o.version ?? process.env.EZTEST_CFT_VERSION;
  if (explicit) return explicit;
  const url = o.versionsUrl ?? process.env.EZTEST_CFT_VERSIONS_URL ?? DEFAULT_INDEX;
  let res: HttpResult;
  try {
    res = await httpGet(url);
  } catch (e) {
    throw new Error(`Could not read the Chrome for Testing version index ${url}: ${(e as Error).message}. Pass --version <x.y.z.w> or set EZTEST_CFT_VERSIONS_URL.`);
  }
  if (res.status !== 200) throw new Error(`Version index ${url} answered ${res.status}. Pass --version <x.y.z.w> or set EZTEST_CFT_VERSIONS_URL.`);
  const json = JSON.parse(res.body.toString('utf8')) as { channels?: Record<string, { version: string }> };
  const v = json.channels?.[o.channel ?? 'Stable']?.version;
  if (!v) throw new Error(`Version index ${url} has no ${o.channel ?? 'Stable'} channel`);
  return v;
}

export async function installBrowser(o: InstallOptions = {}): Promise<InstallResult> {
  const log = o.log ?? (() => undefined);
  const kind = o.kind ?? 'chrome';
  const version = await resolveVersion(o);
  const platform = cftPlatform();
  const root = o.dir ?? browserCacheDir();
  const dir = join(root, `${kind}-${version}`);
  const exe = join(dir, cftBinaryInArchive(kind, platform));
  if (existsSync(exe) && !o.force) {
    log(`${kind} ${version} is already installed at ${exe}`);
    return { version, executablePath: exe, dir, alreadyInstalled: true, verified: [] };
  }
  const base = (o.downloadBase ?? process.env.EZTEST_CFT_DOWNLOAD_BASE ?? DEFAULT_BASE).replace(/\/+$/, '');
  const url = `${base}/${version}/${platform}/${kind}-${platform}.zip`;
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
  const checked = verifyArchive(res.body, res.headers['x-goog-hash'], o.sha256);
  if (!checked.length && !o.insecureSkipChecksum) {
    throw new Error(`The server reported no checksum for ${url}; pass --sha256 <hex> (or --insecure-skip-checksum to install unverified)`);
  }
  log(`verified: ${checked.join(', ') || 'nothing (skipped)'}`);
  const tmp = `${dir}.partial-${process.pid}`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const n = await extractZip(res.body, tmp);
  log(`extracted ${n} files`);
  await rm(dir, { recursive: true, force: true });
  await rename(tmp, dir);
  if (!existsSync(exe)) throw new Error(`Archive did not contain ${cftBinaryInArchive(kind, platform)}`);
  const sha = createHash('sha256').update(res.body).digest('hex');
  await writeFile(join(dir, 'eztest-install.json'), JSON.stringify({ kind, version, platform, url, sha256: sha, verified: checked, installedAt: new Date().toISOString() }, null, 2));
  return { version, executablePath: exe, dir, alreadyInstalled: false, verified: checked };
}

/** Read the install manifest of a cached build, if any. */
export async function installManifest(dir: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, 'eztest-install.json'), 'utf8'));
  } catch {
    return undefined;
  }
}
