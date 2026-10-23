/**
 * CI matrix generation (`eztest ci matrix`). `--shards auto` sizes the matrix
 * from historical durations: enough shards that each takes about the target
 * time, never more shards than journeys, capped at `max`.
 */
import { estimateDuration, type DurationTable } from './durations.js';
import { planShards, type ShardableJourney, type ShardPlan } from './shard.js';

export type CiProvider = 'github' | 'azure';

export interface MatrixOptions {
  /** A fixed shard count, or 'auto'. */
  shards: number | 'auto';
  /** Target wall time per shard for 'auto' (default 10 min). */
  targetMs?: number;
  /** Upper bound for 'auto' (default 20). */
  max?: number;
}

export function autoShardCount(journeys: ShardableJourney[], table: DurationTable, o: { targetMs?: number; max?: number } = {}): number {
  const total = journeys.reduce((a, j) => a + estimateDuration(table, j.id, { rows: j.rows }).ms, 0);
  const target = o.targetMs ?? 10 * 60_000;
  const max = o.max ?? 20;
  return Math.max(1, Math.min(max, journeys.length, Math.ceil(total / target)));
}

export interface CiMatrix {
  provider: CiProvider;
  shards: number;
  /** The matrix JSON for the provider. */
  matrix: unknown;
  plan: ShardPlan;
}

/**
 * GitHub Actions: `{ "include": [{ "shard": "1/3", "index": 1, "total": 3 }, ...] }`
 * (use with `strategy.matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}`).
 * Azure DevOps: `{ "shard_1": { "SHARD": "1/3" }, ... }` (use with `strategy.matrix: $[ dependencies.plan.outputs['m.matrix'] ]`).
 */
export function ciMatrix(provider: CiProvider, journeys: ShardableJourney[], table: DurationTable, o: MatrixOptions): CiMatrix {
  const n = o.shards === 'auto' ? autoShardCount(journeys, table, o) : Math.max(1, Math.floor(o.shards));
  const plan = planShards(journeys, n, table);
  const rows = plan.shards.map((s) => ({ shard: `${s.index}/${n}`, index: s.index, total: n, estimatedMinutes: Math.round((s.estimatedMs / 60_000) * 10) / 10 }));
  const matrix = provider === 'github'
    ? { include: rows }
    : Object.fromEntries(rows.map((r) => [`shard_${r.index}`, { SHARD: r.shard, SHARD_INDEX: String(r.index), SHARD_TOTAL: String(n) }]));
  return { provider, shards: n, matrix, plan };
}
