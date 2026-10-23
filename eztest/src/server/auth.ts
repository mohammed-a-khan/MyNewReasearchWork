/**
 * Results-server identity and access.
 *
 * Principals:
 * - API tokens (`ezt_...`, sent as `Authorization: Bearer`) for CI. Only a
 *   SHA-256 of the token is stored; each token carries its own grants.
 * - People signed in with OIDC (see oidc.ts), holding a session cookie.
 *   Their grants come from `ez_grants` (subject `user:<email>`,
 *   `sub:<subject>` or `group:<name>`) and from the server config `access`.
 *
 * RBAC: roles are ordered viewer < tester < approver < admin and granted per
 * project (`*` = every project). What each role may do is listed in
 * PERMISSIONS; routes ask `can(principal, project, action)`.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { num, optStr, type Store } from './store.js';

export const ROLES = ['viewer', 'tester', 'approver', 'admin'] as const;
export type Role = (typeof ROLES)[number];
export const roleRank = (r: Role | undefined): number => (r ? ROLES.indexOf(r) + 1 : 0);
export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v);

/** Minimum role per action. */
export const PERMISSIONS = {
  'read': 'viewer',
  'run.publish': 'tester',
  'lock.use': 'tester',
  'triage.override': 'tester',
  'heal.decide': 'approver',
  'quarantine.change': 'approver',
  'readiness.sign': 'approver',
  /** Record that a version is released to an environment (feeds can-release); the release manager's role. */
  'contracts.release': 'approver',
  'pack.upload': 'approver',
  'audit.read': 'approver',
  'token.manage': 'admin',
  'access.manage': 'admin',
  'retention.manage': 'admin',
} as const satisfies Record<string, Role>;
export type Action = keyof typeof PERMISSIONS;

export interface Grant {
  project: string;
  role: Role;
}

export interface Principal {
  kind: 'token' | 'user' | 'anonymous';
  /** Stable id for the audit log: `token:<id>:<name>` or `user:<email or sub>`. */
  id: string;
  name: string;
  grants: Grant[];
  /** Session CSRF token (cookie sessions only). */
  csrf?: string;
}

export function roleFor(p: Principal, project: string): Role | undefined {
  let best: Role | undefined;
  for (const g of p.grants) {
    if (g.project !== project && g.project !== '*') continue;
    if (roleRank(g.role) > roleRank(best)) best = g.role;
  }
  return best;
}

export function can(p: Principal, project: string, action: Action): boolean {
  return roleRank(roleFor(p, project)) >= roleRank(PERMISSIONS[action]);
}

export const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const b64url = (b: Buffer) => b.toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ------------------------------------------------------------------ API tokens

export interface TokenRecord {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
  expiresAt?: string;
  revoked: boolean;
  lastUsedAt?: string;
  grants: Grant[];
}

export async function createToken(store: Store, o: { name: string; grants: Grant[]; createdBy: string; expiresAt?: string }): Promise<{ token: string; record: TokenRecord }> {
  const id = b64url(randomBytes(6));
  const token = `ezt_${id}_${b64url(randomBytes(32))}`;
  const record: TokenRecord = { id, name: o.name, createdBy: o.createdBy, createdAt: new Date().toISOString(), expiresAt: o.expiresAt, revoked: false, grants: o.grants };
  await store.run('INSERT INTO ez_tokens (id, name, hash, created_by, created_at, expires_at, revoked, grants) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    id, o.name, sha256hex(token), o.createdBy, record.createdAt, o.expiresAt ?? null, 0, JSON.stringify(o.grants),
  ]);
  return { token, record };
}

function tokenFromRow(r: Record<string, unknown>): TokenRecord {
  return {
    id: String(r.id), name: String(r.name ?? ''), createdBy: String(r.created_by ?? ''), createdAt: String(r.created_at ?? ''),
    expiresAt: optStr(r.expires_at), revoked: num(r.revoked) === 1, lastUsedAt: optStr(r.last_used_at),
    grants: JSON.parse(String(r.grants ?? '[]')) as Grant[],
  };
}

export async function listTokens(store: Store): Promise<TokenRecord[]> {
  return (await store.all('SELECT * FROM ez_tokens ORDER BY created_at')).map(tokenFromRow);
}

export async function revokeToken(store: Store, id: string): Promise<boolean> {
  return (await store.run('UPDATE ez_tokens SET revoked = 1 WHERE id = ?', [id])) > 0;
}

export async function principalFromToken(store: Store, token: string, bootstrapHash?: string): Promise<Principal | undefined> {
  if (!/^ezt_[\w-]+$/.test(token) && !bootstrapHash) return undefined;
  const h = sha256hex(token);
  if (bootstrapHash && safeEqual(h, bootstrapHash)) return { kind: 'token', id: 'token:bootstrap', name: 'bootstrap admin token', grants: [{ project: '*', role: 'admin' }] };
  const r = await store.one('SELECT * FROM ez_tokens WHERE hash = ?', [h]);
  if (!r) return undefined;
  const t = tokenFromRow(r);
  if (t.revoked) return undefined;
  if (t.expiresAt && Date.parse(t.expiresAt) < Date.now()) return undefined;
  await store.run('UPDATE ez_tokens SET last_used_at = ? WHERE id = ?', [new Date().toISOString(), t.id]).catch(() => 0);
  return { kind: 'token', id: `token:${t.id}:${t.name}`, name: t.name, grants: t.grants };
}

/** Current grants of a token by id (undefined when revoked, expired or unknown). */
export async function tokenGrants(store: Store, id: string, bootstrapEnabled: boolean): Promise<Grant[] | undefined> {
  if (id === 'bootstrap') return bootstrapEnabled ? [{ project: '*', role: 'admin' }] : undefined;
  const r = await store.one('SELECT * FROM ez_tokens WHERE id = ?', [id]);
  if (!r) return undefined;
  const t = tokenFromRow(r);
  if (t.revoked || (t.expiresAt && Date.parse(t.expiresAt) < Date.now())) return undefined;
  return t.grants;
}

// ------------------------------------------------------------------ grants for people

export interface AccessRule {
  /** `user:<email>`, `sub:<oidc subject>`, `group:<name>` or `*` (every signed-in user). */
  subject: string;
  project: string;
  role: Role;
}

export async function setGrant(store: Store, g: AccessRule & { by: string }): Promise<void> {
  await store.run('DELETE FROM ez_grants WHERE subject = ? AND project = ?', [g.subject, g.project]);
  await store.run('INSERT INTO ez_grants (subject, project, role, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)', [g.subject, g.project, g.role, g.by, new Date().toISOString()]);
}

export async function grantsForSubjects(store: Store, subjects: string[], configRules: AccessRule[] = []): Promise<Grant[]> {
  const out: Grant[] = configRules.filter((r) => r.subject === '*' || subjects.includes(r.subject)).map((r) => ({ project: r.project, role: r.role }));
  for (const s of subjects) {
    for (const r of await store.all('SELECT project, role FROM ez_grants WHERE subject = ?', [s])) {
      if (isRole(r.role)) out.push({ project: String(r.project), role: r.role });
    }
  }
  return out;
}

// ------------------------------------------------------------------ sessions

export const SESSION_COOKIE = 'ezs';
export const CSRF_COOKIE = 'ezs_csrf';

export interface UserProfile {
  sub: string;
  email?: string;
  name?: string;
  groups: string[];
}

export const subjectsOf = (u: UserProfile): string[] => [`sub:${u.sub}`, ...(u.email ? [`user:${u.email.toLowerCase()}`] : []), ...u.groups.map((g) => `group:${g}`)];

export async function createSession(store: Store, subject: string, profile: unknown, ttlMs: number): Promise<{ id: string; csrf: string }> {
  const id = b64url(randomBytes(32));
  const csrf = b64url(randomBytes(24));
  await store.run('INSERT INTO ez_sessions (id_hash, subject, profile, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', [
    sha256hex(id), subject, JSON.stringify(profile), csrf, new Date().toISOString(), Date.now() + ttlMs,
  ]);
  return { id, csrf };
}

export async function loadSession(store: Store, id: string): Promise<{ subject: string; profile: Record<string, unknown>; csrf: string } | undefined> {
  const r = await store.one('SELECT * FROM ez_sessions WHERE id_hash = ?', [sha256hex(id)]);
  if (!r) return undefined;
  if (num(r.expires_at) < Date.now()) {
    await store.run('DELETE FROM ez_sessions WHERE id_hash = ?', [sha256hex(id)]);
    return undefined;
  }
  return { subject: String(r.subject), profile: JSON.parse(String(r.profile ?? '{}')) as Record<string, unknown>, csrf: String(r.csrf) };
}

export async function deleteSession(store: Store, id: string): Promise<void> {
  await store.run('DELETE FROM ez_sessions WHERE id_hash = ?', [sha256hex(id)]);
}

export function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookieHeader(name: string, value: string, o: { secure: boolean; maxAgeS?: number; httpOnly?: boolean; path?: string }): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${o.path ?? '/'}`,
    o.httpOnly === false ? '' : 'HttpOnly',
    'SameSite=Lax',
    o.secure ? 'Secure' : '',
    o.maxAgeS !== undefined ? `Max-Age=${o.maxAgeS}` : '',
  ].filter(Boolean).join('; ');
}

// ------------------------------------------------------------------ rate limiting

/** Token bucket per key (client address): `burst` requests, refilled at `perMinute`. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    readonly perMinute: number,
    readonly burst = perMinute,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: t };
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.at) / 60_000) * this.perMinute);
    b.at = t;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) {
      for (const [k, v] of this.buckets) if (t - v.at > 600_000) this.buckets.delete(k);
    }
    return ok;
  }
}

export function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xf = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xf) ? xf[0] : xf)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}
