/**
 * Duration-balanced sharding. `eztest run --shard i/n` runs one of n slices of
 * the suite; every machine computes the same plan from the same inputs (the
 * journey ids and the duration table), so no coordination is needed.
 *
 * Algorithm: longest-processing-time-first. Units are sorted by estimated
 * duration (descending, ties by id) and each goes to the currently lightest
 * shard (ties to the lowest index). Journeys that share a static resource lock
 * (`Locks:`) are kept in one unit when that unit is not larger than a fair
 * shard, so they serialise inside one machine instead of waiting on each other
 * across machines.
 */
import { EzTestError } from '../core/index.js';
import { estimateDuration, type DurationTable } from './durations.js';

export interface ShardSpec {
  /** 1-based shard index. */
  index: number;
  total: number;
}

export interface ShardableJourney {
  id: string;
  locks?: string[];
  /** Inline Examples rows (each row runs as its own journey). */
  rows?: number;
}

export interface ShardPlanEntry {
  index: number;
  journeyIds: string[];
  estimatedMs: number;
}

export interface ShardPlan {
  total: number;
  shards: ShardPlanEntry[];
  /** Estimated duration and its source per journey id. */
  estimates: Record<string, { ms: number; source: 'history' | 'rows' | 'estimate' }>;
  /** Longest shard / mean shard (1 = perfect balance). */
  imbalance: number;
}

export function parseShard(spec: string): ShardSpec {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(spec);
  if (!m) throw new EzTestError(`--shard must look like i/n (e.g. 2/4), got "${spec}"`, 'INVALID_INPUT');
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (total < 1 || index < 1 || index > total) throw new EzTestError(`--shard ${spec}: index must be between 1 and ${total}`, 'INVALID_INPUT');
  return { index, total };
}

/** A lock key is static when it has no per-row or per-variable placeholder. */
const staticLock = (k: string) => !/[<$]/.test(k);

function lockGroups(journeys: ShardableJourney[]): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (const j of journeys) parent.set(j.id, j.id);
  const owner = new Map<string, string>();
  for (const j of journeys) {
    for (const k of (j.locks ?? []).filter(staticLock)) {
      const o = owner.get(k);
      if (o) union(o, j.id);
      else owner.set(k, j.id);
    }
  }
  const groups = new Map<string, string[]>();
  for (const j of journeys) {
    const r = find(j.id);
    groups.set(r, [...(groups.get(r) ?? []), j.id]);
  }
  return [...groups.values()];
}

export function planShards(journeys: ShardableJourney[], total: number, table: DurationTable): ShardPlan {
  if (!Number.isInteger(total) || total < 1) throw new EzTestError('Shard count must be a positive integer', 'INVALID_INPUT');
  const ids = new Set<string>();
  for (const j of journeys) {
    if (ids.has(j.id)) throw new EzTestError(`Duplicate journey id "${j.id}"`, 'INVALID_INPUT');
    ids.add(j.id);
  }
  const estimates: ShardPlan['estimates'] = {};
  for (const j of journeys) estimates[j.id] = estimateDuration(table, j.id, { rows: j.rows });
  const sum = Object.values(estimates).reduce((a, e) => a + e.ms, 0);
  const fair = sum / total;

  // Units: lock groups that fit a fair shard stay together; larger groups are split.
  const units: Array<{ ids: string[]; ms: number }> = [];
  for (const g of lockGroups(journeys)) {
    const ms = g.reduce((a, id) => a + estimates[id].ms, 0);
    if (g.length > 1 && ms <= fair) units.push({ ids: [...g].sort(), ms });
    else for (const id of g) units.push({ ids: [id], ms: estimates[id].ms });
  }
  units.sort((a, b) => b.ms - a.ms || a.ids[0].localeCompare(b.ids[0]));

  const shards: ShardPlanEntry[] = Array.from({ length: total }, (_, i) => ({ index: i + 1, journeyIds: [], estimatedMs: 0 }));
  for (const u of units) {
    let best = shards[0];
    for (const s of shards) if (s.estimatedMs < best.estimatedMs) best = s;
    best.journeyIds.push(...u.ids);
    best.estimatedMs += u.ms;
  }
  // Keep the original (file) order inside a shard so runs read naturally.
  const order = new Map(journeys.map((j, i) => [j.id, i]));
  for (const s of shards) s.journeyIds.sort((a, b) => order.get(a)! - order.get(b)!);
  const mean = sum / total;
  const longest = Math.max(...shards.map((s) => s.estimatedMs));
  return { total, shards, estimates, imbalance: mean > 0 ? Math.round((longest / mean) * 1000) / 1000 : 1 };
}

/** The journeys of one shard, in their original order. */
export function selectShard<T extends ShardableJourney>(journeys: T[], spec: ShardSpec, table: DurationTable): { journeys: T[]; plan: ShardPlan } {
  const plan = planShards(journeys, spec.total, table);
  const mine = new Set(plan.shards[spec.index - 1].journeyIds);
  return { journeys: journeys.filter((j) => mine.has(j.id)), plan };
}
