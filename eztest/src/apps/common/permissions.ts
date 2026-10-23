/**
 * Permission/role matrix runner shared by the packs: for every configured
 * user and every check, ask the pack's probe what the platform API reports
 * (and optionally what the UI shows), compare with the expectation and list
 * the violations. Packs decide what a check means (a ServiceNow table/field
 * ACL, a Fiori app tile + OData entity set, a Workday task/domain, an Oracle
 * role and REST resource, a Dataverse privilege or canvas control).
 */
import { EzTestError, nowIso } from '../../core/index.js';
import type { PackId } from './kit.js';

export interface PermissionCheckBase {
  /** Expected level, or per-user levels: { rep: read, admin: edit }. */
  expect: string | Record<string, string>;
  /** Only these users (default: every configured user, or the keys of `expect`). */
  users?: string[];
  [k: string]: unknown;
}

export interface ProbeResult {
  /** What the API says, e.g. "edit", "read", "none", "hidden", "visible". */
  api?: string;
  /** What the UI shows, when the probe looked. */
  ui?: string;
  detail?: string;
}

export interface MatrixResult {
  user: string;
  subject: string;
  expected: string;
  api?: string;
  ui?: string;
  passed: boolean;
  detail?: string;
}

export interface MatrixReport {
  schema: 'eztest.apps.permissions/v1';
  pack: PackId;
  generatedAt: string;
  users: string[];
  results: MatrixResult[];
  violations: MatrixResult[];
  passed: boolean;
}

/** Levels that satisfy an expectation ("edit" satisfies "read"? no: expectations are exact unless written "read+"). */
export function levelMatches(expected: string, actual: string | undefined, order: string[]): boolean {
  if (actual === undefined) return false;
  const e = expected.trim().toLowerCase();
  const a = actual.trim().toLowerCase();
  if (e.endsWith('+')) {
    const ei = order.indexOf(e.slice(0, -1));
    const ai = order.indexOf(a);
    return ei >= 0 && ai >= ei;
  }
  return e === a;
}

export async function runMatrix<C extends PermissionCheckBase>(o: {
  pack: PackId;
  users: string[];
  checks: C[];
  subject: (c: C) => string;
  probe: (user: string, c: C) => Promise<ProbeResult>;
  /** Levels from weakest to strongest, for "read+" style expectations. */
  order: string[];
  /** What the API can show for an expectation (e.g. "write" is seen as "read" by a read-only probe). Default: the expectation itself. */
  apiLevel?: (expected: string, c: C) => string;
  /** The same for the UI probe (e.g. any app role is seen as "opens" in the player). */
  uiLevel?: (expected: string, c: C) => string;
}): Promise<MatrixReport> {
  if (!o.users.length) throw new EzTestError(`The ${o.pack} permission matrix needs users (one entry per role)`, 'APP_CONFIG');
  if (!Array.isArray(o.checks) || !o.checks.length) throw new EzTestError('The permission matrix needs at least one check', 'INVALID_INPUT');
  const results: MatrixResult[] = [];
  for (const c of o.checks) {
    const users = c.users ?? (typeof c.expect === 'object' ? Object.keys(c.expect) : o.users);
    for (const u of users) {
      if (!o.users.includes(u)) throw new EzTestError(`Permission check "${o.subject(c)}" names unknown user "${u}" (configured: ${o.users.join(', ')})`, 'APP_CONFIG');
      const expected = typeof c.expect === 'string' ? c.expect : c.expect[u];
      if (!expected) continue;
      const r = await o.probe(u, c);
      const apiOk = r.api === undefined || levelMatches(o.apiLevel ? o.apiLevel(expected, c) : expected, r.api, o.order);
      const uiOk = r.ui === undefined || levelMatches(o.uiLevel ? o.uiLevel(expected, c) : expected, r.ui, o.order);
      results.push({ user: u, subject: o.subject(c), expected, ...(r.api !== undefined ? { api: r.api } : {}), ...(r.ui !== undefined ? { ui: r.ui } : {}), passed: apiOk && uiOk && (r.api !== undefined || r.ui !== undefined), ...(r.detail ? { detail: r.detail } : {}) });
    }
  }
  const violations = results.filter((r) => !r.passed);
  return { schema: 'eztest.apps.permissions/v1', pack: o.pack, generatedAt: nowIso(), users: o.users, results, violations, passed: violations.length === 0 };
}
