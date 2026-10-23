/**
 * Test plan structure: suites built from a tag (static suites kept in sync
 * with the journeys carrying the tag) or a query (query-based suites), test
 * case membership, and test configurations (browser / environment mapped to
 * an ADO configuration, created on demand).
 */
import { EzTestError } from '../core/index.js';
import type { AdoClient } from './client.js';

export interface AdoSuite {
  id: number;
  name: string;
  suiteType?: string;
  parentSuite?: { id: number };
  queryString?: string;
}

export interface AdoConfiguration {
  id: number;
  name: string;
  isDefault?: boolean;
  state?: string;
  values?: Array<{ name: string; value: string }>;
}

export async function listSuites(c: AdoClient, planId: number): Promise<AdoSuite[]> {
  return c.getAll<AdoSuite>(`/_apis/testplan/Plans/${planId}/suites`);
}

/** Root suite of a plan (the one without a parent). */
export async function rootSuiteId(c: AdoClient, planId: number): Promise<number> {
  const all = await listSuites(c, planId);
  const root = all.find((s) => !s.parentSuite);
  if (!root) throw new EzTestError(`Plan ${planId} has no root suite`, 'ADO_NO_SUITE');
  return root.id;
}

async function findChild(c: AdoClient, planId: number, parent: number, name: string): Promise<AdoSuite | undefined> {
  return (await listSuites(c, planId)).find((s) => s.parentSuite?.id === parent && s.name.toLowerCase() === name.toLowerCase());
}

export async function ensureStaticSuite(c: AdoClient, planId: number, name: string, parentSuiteId?: number): Promise<{ suite: AdoSuite; created: boolean }> {
  const parent = parentSuiteId ?? (await rootSuiteId(c, planId));
  const found = await findChild(c, planId, parent, name);
  if (found) return { suite: found, created: false };
  const r = await c.request<AdoSuite>('POST', `/_apis/testplan/Plans/${planId}/suites`, { body: { suiteType: 'staticTestSuite', name, parentSuite: { id: parent } } });
  return { suite: r.data, created: true };
}

/** A query-based suite with this WIQL (its query is updated when it changed). */
export async function ensureQuerySuite(c: AdoClient, planId: number, name: string, wiql: string, parentSuiteId?: number): Promise<{ suite: AdoSuite; action: 'created' | 'updated' | 'unchanged' }> {
  if (!/^\s*select\b/i.test(wiql)) throw new EzTestError('A query-based suite needs a WIQL SELECT', 'INVALID_INPUT');
  const parent = parentSuiteId ?? (await rootSuiteId(c, planId));
  const found = await findChild(c, planId, parent, name);
  if (found) {
    if (found.queryString === wiql) return { suite: found, action: 'unchanged' };
    const r = await c.request<AdoSuite>('PATCH', `/_apis/testplan/Plans/${planId}/suites/${found.id}`, { body: { queryString: wiql }, idempotent: true });
    return { suite: r.data, action: 'updated' };
  }
  const r = await c.request<AdoSuite>('POST', `/_apis/testplan/Plans/${planId}/suites`, { body: { suiteType: 'dynamicTestSuite', name, queryString: wiql, parentSuite: { id: parent } } });
  return { suite: r.data, action: 'created' };
}

export async function suiteTestCaseIds(c: AdoClient, planId: number, suiteId: number): Promise<number[]> {
  const list = await c.getAll<{ workItem: { id: number } }>(`/_apis/testplan/Plans/${planId}/Suites/${suiteId}/TestCase`);
  return list.map((x) => x.workItem.id);
}

/** Add test cases to a static suite (those already in it are skipped), optionally on given configurations. */
export async function addTestCasesToSuite(c: AdoClient, planId: number, suiteId: number, ids: number[], configurationIds: number[] = []): Promise<number[]> {
  const have = new Set(await suiteTestCaseIds(c, planId, suiteId));
  const add = [...new Set(ids)].filter((id) => !have.has(id));
  for (let i = 0; i < add.length; i += 100) {
    const body = add.slice(i, i + 100).map((id) => ({ workItem: { id }, ...(configurationIds.length ? { pointAssignments: configurationIds.map((configurationId) => ({ configurationId })) } : {}) }));
    await c.request('POST', `/_apis/testplan/Plans/${planId}/Suites/${suiteId}/TestCase`, { body });
  }
  return add;
}

export async function removeTestCasesFromSuite(c: AdoClient, planId: number, suiteId: number, ids: number[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 100) {
    await c.request('DELETE', `/_apis/testplan/Plans/${planId}/Suites/${suiteId}/TestCase`, { query: { testIds: ids.slice(i, i + 100).join(',') } });
  }
}

/**
 * A static suite named after a tag, holding exactly the test cases of the
 * journeys that carry the tag (`prune` removes the ones that no longer do).
 */
export async function syncSuiteByTag(
  c: AdoClient,
  o: { planId: number; parentSuiteId?: number; name?: string; tag: string; journeys: Array<{ tags: string[]; testCaseIds: number[] }>; prune?: boolean; configurationIds?: number[] },
): Promise<{ suiteId: number; created: boolean; added: number[]; removed: number[] }> {
  const tag = o.tag.replace(/^@/, '').toLowerCase();
  const want = [...new Set(o.journeys.filter((j) => j.tags.some((t) => t.replace(/^@/, '').toLowerCase() === tag)).flatMap((j) => j.testCaseIds))];
  const { suite, created } = await ensureStaticSuite(c, o.planId, o.name ?? `@${o.tag.replace(/^@/, '')}`, o.parentSuiteId);
  const added = await addTestCasesToSuite(c, o.planId, suite.id, want, o.configurationIds);
  let removed: number[] = [];
  if (o.prune) {
    const now = await suiteTestCaseIds(c, o.planId, suite.id);
    removed = now.filter((id) => !want.includes(id));
    if (removed.length) await removeTestCasesFromSuite(c, o.planId, suite.id, removed);
  }
  return { suiteId: suite.id, created, added, removed };
}

// ------------------------------------------------------------------ configurations

export async function listConfigurations(c: AdoClient): Promise<AdoConfiguration[]> {
  return c.getAll<AdoConfiguration>('/_apis/testplan/configurations');
}

/** Browser names EZTest uses -> the value of ADO's "Browser" test variable. */
export const BROWSER_VALUE: Record<string, string> = { chromium: 'Chrome', chrome: 'Chrome', msedge: 'Edge', edge: 'Edge', firefox: 'Firefox', webkit: 'Safari', safari: 'Safari' };

/** A configuration by name, created (with its test variable values) when missing. */
export async function ensureConfiguration(c: AdoClient, name: string, values: Record<string, string> = {}): Promise<{ configuration: AdoConfiguration; created: boolean }> {
  const all = await listConfigurations(c);
  const found = all.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (found) return { configuration: found, created: false };
  // Test variables must exist with the value before a configuration can use it.
  if (Object.keys(values).length) {
    const vars = await c.getAll<{ id: number; name: string; values: string[] }>('/_apis/testplan/variables');
    for (const [k, v] of Object.entries(values)) {
      const tv = vars.find((x) => x.name.toLowerCase() === k.toLowerCase());
      if (!tv) await c.request('POST', '/_apis/testplan/variables', { body: { name: k, values: [v] } });
      else if (!tv.values.includes(v)) await c.request('PATCH', `/_apis/testplan/variables/${tv.id}`, { body: { name: tv.name, values: [...tv.values, v] }, idempotent: true });
    }
  }
  const r = await c.request<AdoConfiguration>('POST', '/_apis/testplan/configurations', {
    body: { name, state: 'active', values: Object.entries(values).map(([n, value]) => ({ name: n, value })) },
  });
  return { configuration: r.data, created: true };
}

/**
 * The configuration for a run: `mapping[env]`, then `mapping[browser]`
 * (an id, or a name looked up among the project's configurations).
 */
export async function resolveConfiguration(c: AdoClient, mapping: Record<string, number | string>, keys: Array<string | undefined>): Promise<AdoConfiguration | undefined> {
  for (const k of keys) {
    if (!k) continue;
    const v = mapping[k];
    if (v === undefined) continue;
    if (typeof v === 'number') return { id: v, name: String(v) };
    const found = (await listConfigurations(c)).find((x) => x.name.toLowerCase() === v.toLowerCase());
    if (!found) throw new EzTestError(`ADO test configuration "${v}" (ado.configurations.${k}) does not exist`, 'ADO_CONFIGURATION');
    return found;
  }
  return undefined;
}
