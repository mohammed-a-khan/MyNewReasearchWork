/**
 * Failing and flaky tests grouped by cause, the one grouping the report's
 * Overview and Failures tab, the PDF, the e-mail summary and the workbook use.
 */
import type { ReportModel, TestModel } from './data.js';
import { FAILURE_CATEGORIES, type FailureCategory } from './categorise.js';
import { failureHeadline } from './headline.js';

const isFail = (t: { state: string }) => t.state === 'failed' || t.state === 'error';

export interface CauseGroup {
  id: string;
  kind: 'failure' | 'flaky';
  cat: FailureCategory;
  /** The raw message (first line) the group was formed on. */
  message: string;
  /** The message as a short human sentence (headline.ts). */
  headline: string;
  tests: TestModel[];
  known: boolean;
  firstSeenRun?: string;
  firstSeenAt?: string;
  fix?: string;
}

/**
 * Failing tests grouped by cause: tests of one failure cluster (similar message and stack) form
 * one group, otherwise tests with the same error signature; flaky tests are grouped by the flake
 * cause. Each test is in exactly one group. Ordered by category, then by size.
 */
export function causeGroups(m: ReportModel): CauseGroup[] {
  const clusters = new Map(m.clusters.map((c) => [c.id, c]));
  const groups = new Map<string, CauseGroup>();
  for (const t of m.tests) {
    if (!isFail(t) && t.state !== 'flaky') continue;
    let key: string;
    let g: CauseGroup | undefined;
    if (t.state === 'flaky') {
      key = `flaky-${(t.flake?.cause ?? 'retry').replace(/[^\w-]/g, '-')}`;
      g = groups.get(key) ?? { id: key, kind: 'flaky', cat: 'flaky', message: t.flake ? `Passed only on retry (${t.flake.cause}): ${t.flake.reason.split('\n')[0]}` : 'Passed only on retry', headline: t.flake ? `Passed only on retry: ${t.flake.reason.split('\n')[0]}` : 'Passed only on retry', tests: [], known: true, fix: t.cat?.fix };
    } else {
      const c = t.cluster ? clusters.get(t.cluster) : undefined;
      key = c ? c.id : t.signature ? `sig-${t.signature}` : `test-${t.id}`;
      g = groups.get(key) ?? {
        id: key.replace(/[^\w-]/g, '-'), kind: 'failure', cat: c?.cat ?? t.cat?.c ?? 'unknown', message: (c?.message ?? t.error?.message ?? 'Failed').split('\n')[0], headline: failureHeadline(c?.message ?? t.error?.message ?? 'Failed'),
        tests: [], known: !!t.failure?.known, ...(t.failure?.firstSeenRun ? { firstSeenRun: t.failure.firstSeenRun } : {}), ...(t.failure?.firstSeenAt ? { firstSeenAt: t.failure.firstSeenAt } : {}), fix: c?.fix ?? t.cat?.fix,
      };
    }
    g.tests.push(t);
    groups.set(key, g);
  }
  const rank = (c: FailureCategory) => FAILURE_CATEGORIES.indexOf(c);
  return [...groups.values()].sort((a, b) => Number(a.kind === 'flaky') - Number(b.kind === 'flaky') || rank(a.cat) - rank(b.cat) || b.tests.length - a.tests.length || a.message.localeCompare(b.message));
}

