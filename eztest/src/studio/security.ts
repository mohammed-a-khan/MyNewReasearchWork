/**
 * Studio security helpers: session tokens, DNS-rebinding / origin guards and
 * path confinement. Everything the Studio reads or writes goes through
 * `confinePath`, which rejects absolute paths, `..` escapes and symlinks that
 * point outside the allowed root.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { realpathSync, existsSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep, basename } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { isCodePath } from './code.js';

export const COOKIE_NAME = 'eztest_studio';
export const TOKEN_HEADER = 'x-eztest-token';

/** A fresh random session token (256 bits, hex). */
export function newToken(): string {
  return randomBytes(32).toString('hex');
}

/** Constant-time token comparison. */
export function tokenMatches(expected: string, given: string | undefined | null): boolean {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** Token sent as `Authorization: Bearer`, `X-EZTest-Token`, or (for GET only) the session cookie. */
export function requestToken(req: IncomingMessage, opts: { allowCookie: boolean }): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const h = req.headers[TOKEN_HEADER];
  if (typeof h === 'string') return h;
  if (opts.allowCookie) return parseCookies(req.headers.cookie)[COOKIE_NAME];
  return undefined;
}

/** Hostnames the Studio answers to (DNS-rebinding guard). */
export function allowedHostnames(bindHost: string): Set<string> {
  const s = new Set(['127.0.0.1', 'localhost']);
  if (bindHost && bindHost !== '0.0.0.0' && bindHost !== '::') s.add(bindHost.toLowerCase());
  return s;
}

/** Split a Host header into hostname and port ("[::1]:80" aware). */
export function parseHostHeader(host: string | undefined): { hostname: string; port?: string } | undefined {
  if (!host) return undefined;
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host.trim().toLowerCase());
  if (!m) return undefined;
  return { hostname: m[1], port: m[2] };
}

export function hostAllowed(req: IncomingMessage, hostnames: Set<string>, port: number): boolean {
  const h = parseHostHeader(req.headers.host);
  if (!h || !hostnames.has(h.hostname)) return false;
  return h.port === undefined ? port === 80 : Number(h.port) === port;
}

/** A present Origin must be the Studio itself; cross-site fetch metadata is refused too. */
export function originAllowed(req: IncomingMessage, hostnames: Set<string>, port: number): boolean {
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (origin === 'null') return false;
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      return false;
    }
    if (u.protocol !== 'http:') return false;
    if (!hostnames.has(u.hostname.toLowerCase())) return false;
    if (Number(u.port || 80) !== port) return false;
  }
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') return false;
  return true;
}

export class PathError extends Error {
  constructor(
    message: string,
    readonly status = 403,
  ) {
    super(message);
    this.name = 'PathError';
  }
}

function within(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

function realOrNearest(p: string): string {
  // realpath of the nearest existing ancestor, with the missing tail appended.
  let cur = p;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.unshift(basename(cur));
    cur = parent;
  }
  const real = realpathSync(cur);
  return tail.length ? resolve(real, ...tail) : real;
}

/**
 * Resolve a user-supplied relative path inside `root`. Rejects absolute paths,
 * NUL bytes, `..` escapes and symlinks (at any level) that lead outside `root`.
 * Returns the absolute real path (which may not exist yet).
 */
export function confinePath(root: string, userPath: string): string {
  if (typeof userPath !== 'string' || userPath.length === 0) throw new PathError('A path is required', 400);
  if (userPath.includes('\0')) throw new PathError('Invalid path');
  if (isAbsolute(userPath) || /^[a-zA-Z]:[\\/]/.test(userPath) || userPath.startsWith('\\')) {
    throw new PathError('Absolute paths are not allowed; use a path relative to the project');
  }
  const realRoot = realpathSync(root);
  const abs = resolve(realRoot, userPath);
  if (!within(realRoot, abs)) throw new PathError('Path is outside the project');
  const real = realOrNearest(abs);
  if (!within(realRoot, real)) throw new PathError('Path resolves outside the project (symbolic link)');
  return real;
}

/** Project-relative POSIX path for display. */
export function relPosix(root: string, abs: string): string {
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    // keep root
  }
  return relative(realRoot, abs).split(sep).join('/');
}

export const JOURNEY_EXTENSIONS = new Set(['.ez', '.yaml', '.yml', '.json']);
const NOT_JOURNEYS = /^(?:import-report\.json|package(?:-lock)?\.json|tsconfig.*\.json|eztest\.config\.(?:ya?ml|json)|readiness-policy\.ya?ml|.*\.template\.ya?ml)$/i;
const SECRET_NAMES = /^(?:\.env.*|.*\.(?:pem|key|p12|pfx|crt|cer|der|jks|keystore)|id_(?:rsa|dsa|ecdsa|ed25519).*|.*secrets?\..*|\.npmrc|\.netrc)$/i;
const BLOCKED_DIRS = new Set(['node_modules', '.git', '.eztest']);

/** True when a project-relative path names a sensitive file (never served or written). */
export function isSensitive(rel: string): boolean {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (parts.some((p) => BLOCKED_DIRS.has(p) || (p.startsWith('.') && p !== '.'))) return true;
  return SECRET_NAMES.test(parts[parts.length - 1] ?? '');
}

/**
 * Check that a project-relative path may be read or written as a journey:
 * journey extension, not a config/report file, not hidden, not a secret, and
 * not inside the results directory.
 */
export function confineJourneyPath(root: string, userPath: string, opts: { outputDir?: string } = {}): string {
  const abs = confinePath(root, userPath);
  const rel = relPosix(root, abs);
  if (!JOURNEY_EXTENSIONS.has(extname(abs).toLowerCase()) && !isCodePath(rel) && extname(abs).toLowerCase() !== '.feature') {
    throw new PathError('Only journey files (.ez, .yaml, .yml, .json), feature files (.feature) and code files (*.journey.ts, *.steps.ts, step_definitions/*.ts, screens/*.ts) can be opened or saved here');
  }
  if (isSensitive(rel)) throw new PathError('This file is not editable from the Studio');
  if (NOT_JOURNEYS.test(basename(abs))) throw new PathError('Configuration and report files are not journeys');
  if (opts.outputDir) {
    const out = resolve(realpathSync(root), opts.outputDir);
    if (within(out, abs)) throw new PathError('Files in the results directory are read-only');
  }
  return abs;
}
