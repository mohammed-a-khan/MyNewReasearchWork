/**
 * Journey tag parsing for ADO links:
 *   @TestCaseId:123   @TestCaseId:{1,2,3}   @TestPlanId:7   @TestSuiteId:9
 * The leading "@" is optional and the key is case-insensitive.
 */
import { EzTestError } from '../core/index.js';

export interface AdoTagInfo {
  testCaseIds: number[];
  planId?: number;
  suiteId?: number;
}

const TAG = /^@?(TestCaseId|TestPlanId|TestSuiteId)\s*[:=]\s*(.+)$/i;

function ids(raw: string, tag: string): number[] {
  const v = raw.trim();
  const list = /^\{(.*)\}$/.exec(v)?.[1] ?? v;
  const parts = list.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new EzTestError(`Tag ${tag} has no id`, 'INVALID_TAG');
  return parts.map((p) => {
    if (!/^\d+$/.test(p) || Number(p) <= 0) throw new EzTestError(`Tag ${tag}: "${p}" is not a positive integer id`, 'INVALID_TAG');
    return Number(p);
  });
}

/**
 * Custom test-id tags (config `ado.testCaseTag`): tags matching `pattern` (its first group is the key) are
 * looked up in `map` (key -> test case id) when publishing. `@TC-ABC_1` with pattern `@TC-([A-Z0-9_]+)` and a map
 * entry `TC-ABC_1: 1234` (or `ABC_1: 1234`) links to test case 1234.
 */
export interface TestCaseTagMap {
  pattern: RegExp;
  map: Record<string, number>;
  /** The map file (for messages). */
  file?: string;
}

/** The test case id of a custom test-id tag, or undefined when the tag does not match or is not in the map. */
export function mappedTestCase(tag: string, m: TestCaseTagMap): number | undefined {
  const t = tag.trim();
  const at = t.startsWith('@') ? t : `@${t}`;
  const hit = m.pattern.exec(at) ?? m.pattern.exec(t.replace(/^@/, ''));
  if (!hit) return undefined;
  const keys = [at.slice(1), ...(hit[1] !== undefined ? [hit[1]] : []), hit[0].replace(/^@/, '')];
  for (const k of keys) {
    const v = m.map[k] ?? m.map[Object.keys(m.map).find((x) => x.toLowerCase() === k.toLowerCase()) ?? ''];
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Read `ado.testCaseTag` ({ pattern, map: file }) into a matcher; undefined when it is not configured. */
export async function loadTestCaseTagMap(spec: { pattern: string; map: string } | undefined, cwd: string): Promise<TestCaseTagMap | undefined> {
  if (!spec) return undefined;
  const { readFile } = await import('node:fs/promises');
  const { isAbsolute, resolve } = await import('node:path');
  const { parse } = await import('yaml');
  const file = isAbsolute(spec.map) ? spec.map : resolve(cwd, spec.map);
  let raw: unknown;
  try {
    raw = parse(await readFile(file, 'utf8'));
  } catch (e) {
    throw new EzTestError(`ado.testCaseTag.map: ${file} could not be read: ${(e as Error).message}`, 'ADO_CONFIG');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new EzTestError(`ado.testCaseTag.map: ${file} must map test ids to test case ids (TC-ABC_1: 1234)`, 'ADO_CONFIG');
  const map: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new EzTestError(`ado.testCaseTag.map: ${k}: "${String(v)}" is not a test case id`, 'ADO_CONFIG');
    map[k] = n;
  }
  return { pattern: new RegExp(spec.pattern, 'i'), map, file };
}

export function parseAdoTags(tags: string[], custom?: TestCaseTagMap): AdoTagInfo {
  const out: AdoTagInfo = { testCaseIds: [] };
  for (const tag of tags) {
    const mapped = custom ? mappedTestCase(tag, custom) : undefined;
    if (mapped !== undefined) {
      if (!out.testCaseIds.includes(mapped)) out.testCaseIds.push(mapped);
      continue;
    }
    const m = TAG.exec(tag.trim());
    if (!m) continue;
    const key = m[1].toLowerCase();
    const values = ids(m[2], tag);
    if (key === 'testcaseid') {
      for (const v of values) if (!out.testCaseIds.includes(v)) out.testCaseIds.push(v);
    } else {
      if (values.length !== 1) throw new EzTestError(`Tag ${tag}: exactly one id expected`, 'INVALID_TAG');
      const field = key === 'testplanid' ? 'planId' : 'suiteId';
      if (out[field] !== undefined && out[field] !== values[0]) throw new EzTestError(`Conflicting ${m[1]} tags (${out[field]} vs ${values[0]})`, 'INVALID_TAG');
      out[field] = values[0];
    }
  }
  return out;
}
