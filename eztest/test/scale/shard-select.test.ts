import { describe, expect, it } from '../support/testkit.js';
import {
  autoShardCount, ciMatrix, durationsFromRuns, estimateDuration, parseBudget, parseRisk, parseShard, planShards, selectJourneys, selectShard, type DurationTable,
} from '../../src/scale/index.js';
import type { RunHistoryEntry } from '../../src/insights/index.js';

const history = (durations: Record<string, number[]>): RunHistoryEntry[] => {
  const n = Math.max(...Object.values(durations).map((d) => d.length));
  return Array.from({ length: n }, (_, i) => ({
    runId: `r${i}`,
    startedAt: `2026-10-0${i + 1}T00:00:00Z`,
    outcomes: Object.entries(durations).filter(([, d]) => d[i] !== undefined).map(([journeyId, d]) => ({ journeyId, status: 'passed' as const, durationMs: d[i], attempt: 1 })),
  }));
};

describe('durations', () => {
  it('takes the median of recent runs and estimates unknown journeys from the median of known ones', () => {
    const t = durationsFromRuns(history({ a: [100, 300, 200], b: [1000, 1000, 5000], c: [50] }));
    expect(t.known).toEqual({ a: 200, b: 1000, c: 50 });
    expect(t.defaultMs).toBe(200);
    expect(estimateDuration(t, 'zzz')).toEqual({ ms: 200, source: 'estimate' });
    expect(estimateDuration(t, 'zzz', { rows: 3 }).ms).toBe(600);
  });

  it('sums Examples rows recorded as <id>-<row> for a data-driven journey', () => {
    const t = durationsFromRuns(history({ 'orders-eu': [100], 'orders-us': [300] }));
    expect(estimateDuration(t, 'orders')).toEqual({ ms: 400, source: 'rows' });
  });
});

describe('sharding by historical duration', () => {
  const table: DurationTable = { known: { slow1: 600, slow2: 500, m1: 200, m2: 200, m3: 200, f1: 50, f2: 50, f3: 50, f4: 50 }, defaultMs: 100 };
  const journeys = Object.keys(table.known).map((id) => ({ id }));

  it('balances by duration, not by count', () => {
    const plan = planShards(journeys, 2, table);
    const loads = plan.shards.map((s) => s.estimatedMs);
    expect(Math.abs(loads[0] - loads[1])).toBeLessThanOrEqual(100);
    // By count, a naive split would put both slow journeys together half the time; LPT never does.
    const withSlow = plan.shards.map((s) => s.journeyIds.filter((j) => j.startsWith('slow')).length);
    expect(withSlow).toEqual([1, 1]);
    expect(plan.imbalance).toBeLessThan(1.1);
    expect(plan.shards.flatMap((s) => s.journeyIds).sort()).toEqual(Object.keys(table.known).sort());
  });

  it('is deterministic: every machine computes the same plan, whatever the input order', () => {
    const a = planShards(journeys, 3, table);
    const b = planShards([...journeys].reverse(), 3, table);
    expect(a.shards.map((s) => [...s.journeyIds].sort())).toEqual(b.shards.map((s) => [...s.journeyIds].sort()));
    expect(planShards(journeys, 3, table)).toEqual(a);
  });

  it('selectShard returns disjoint shards that together cover the suite, in the original order', () => {
    const all: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const { journeys: mine } = selectShard(journeys, parseShard(`${i}/4`), table);
      const order = mine.map((j) => journeys.findIndex((x) => x.id === j.id));
      expect(order).toEqual([...order].sort((x, y) => x - y));
      all.push(...mine.map((j) => j.id));
    }
    expect(all.sort()).toEqual(journeys.map((j) => j.id).sort());
  });

  it('keeps journeys that share a static lock in one shard when the group fits', () => {
    const js = [{ id: 'a', locks: ['account-1'] }, { id: 'b', locks: ['account-1'] }, { id: 'c' }, { id: 'd' }, { id: 'e', locks: ['acct-<row>'] }];
    const t: DurationTable = { known: { a: 100, b: 100, c: 100, d: 100, e: 100 }, defaultMs: 100 };
    const plan = planShards(js, 2, t);
    const shardOf = (id: string) => plan.shards.findIndex((s) => s.journeyIds.includes(id));
    expect(shardOf('a')).toBe(shardOf('b'));
  });

  it('parses shard specs strictly', () => {
    expect(parseShard('2/5')).toEqual({ index: 2, total: 5 });
    expect(() => parseShard('0/5')).toThrow();
    expect(() => parseShard('6/5')).toThrow();
    expect(() => parseShard('two')).toThrow();
  });
});

describe('selection', () => {
  const table: DurationTable = { known: { login: 60_000, checkout: 300_000, refund: 240_000, search: 30_000, profile: 120_000 }, defaultMs: 60_000 };
  const js = [
    { id: 'login', risk: 5 },
    { id: 'checkout', risk: 5 },
    { id: 'refund', risk: 4 },
    { id: 'search', risk: 2 },
    { id: 'profile', risk: 1 },
  ];

  it('picks the highest risk-per-minute set that fits the budget, and explains every decision', () => {
    const s = selectJourneys(js, { budgetMs: parseBudget('7m') }, table);
    // risk^2 per minute: login 25, search 8, refund 4, checkout 5, profile 0.5 -> login(1m) + search(0.5m) + checkout(5m) = 6.5m
    expect(s.selected.sort()).toEqual(['checkout', 'login', 'search']);
    expect(s.estimatedMs).toBe(390_000);
    expect(s.estimatedMs).toBeLessThanOrEqual(7 * 60_000);
    const refund = s.decisions.find((d) => d.journeyId === 'refund')!;
    expect(refund.selected).toBe(false);
    expect(refund.reasons.join(' ')).toMatch(/over budget/);
    expect(s.summary).toMatch(/Selected 3 of 5 journeys.*budget 7\.0m/);
  });

  it('combines risk, previously failed and changed-file criteria as filters', () => {
    const s = selectJourneys(js, { minRisk: parseRisk('>=4'), failed: { runId: 'run-1', journeyIds: ['refund', 'search'] } }, table);
    expect(s.selected).toEqual(['refund']);
    expect(s.decisions.find((d) => d.journeyId === 'search')!.reasons).toContain('risk 2 < 4');
    const c = selectJourneys(js, {
      changedSince: 'origin/main', changedJourneyIds: ['profile'],
      impact: { changedFiles: ['src/cart.ts'], ignoredFiles: [], uncovered: [], impacted: [{ journeyId: 'checkout', score: 5, risk: 5, via: [{ file: 'src/cart.ts', mapping: 'cart', match: 'journey', value: 'checkout' }] }] } as never,
    }, table);
    expect(c.selected.sort()).toEqual(['checkout', 'profile']);
    expect(c.decisions.find((d) => d.journeyId === 'checkout')!.reasons[0]).toMatch(/impacted by src\/cart.ts/);
  });

  it('parses budgets and risk thresholds', () => {
    expect(parseBudget('15m')).toBe(900_000);
    expect(parseBudget('90s')).toBe(90_000);
    expect(parseBudget('1.5h')).toBe(5_400_000);
    expect(parseRisk('4')).toBe(4);
    expect(parseRisk('>=3')).toBe(3);
    expect(parseRisk('≥4')).toBe(4);
    expect(() => parseBudget('soon')).toThrow();
  });
});

describe('CI matrix', () => {
  const table: DurationTable = { known: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`j${i}`, 60_000])), defaultMs: 60_000 };
  const js = Object.keys(table.known).map((id) => ({ id }));

  it('sizes "auto" from history: ~10 minutes per shard', () => {
    expect(autoShardCount(js, table)).toBe(4);
    expect(autoShardCount(js, table, { targetMs: 5 * 60_000 })).toBe(8);
    expect(autoShardCount(js, table, { targetMs: 60_000, max: 6 })).toBe(6);
  });

  it('emits GitHub Actions and Azure DevOps matrix shapes', () => {
    const gh = ciMatrix('github', js, table, { shards: 'auto' });
    expect(gh.matrix).toEqual({ include: [1, 2, 3, 4].map((i) => ({ shard: `${i}/4`, index: i, total: 4, estimatedMinutes: 10 })) });
    const az = ciMatrix('azure', js, table, { shards: 2 });
    expect(az.matrix).toEqual({ shard_1: { SHARD: '1/2', SHARD_INDEX: '1', SHARD_TOTAL: '2' }, shard_2: { SHARD: '2/2', SHARD_INDEX: '2', SHARD_TOTAL: '2' } });
  });
});
