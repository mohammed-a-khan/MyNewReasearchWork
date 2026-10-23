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

export function parseAdoTags(tags: string[]): AdoTagInfo {
  const out: AdoTagInfo = { testCaseIds: [] };
  for (const tag of tags) {
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
