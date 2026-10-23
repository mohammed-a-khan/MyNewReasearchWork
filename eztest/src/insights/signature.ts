/**
 * Failure signatures and clustering. Messages are normalized (numbers, ids,
 * urls, timings, quoted strings) so the "same" failure from different runs
 * produces the same signature; stacks contribute their top frames.
 * Clustering uses weighted Jaccard similarity and union-find; each cluster's
 * representative is its medoid.
 */
import { sha256, EzTestError } from '../core/index.js';

export interface FailureInput {
  message: string;
  stack?: string;
  name?: string;
}

export interface FailureSignature {
  /** Short stable hash (16 hex chars) of the normalized message + frames. */
  hash: string;
  normalized: string;
  frames: string[];
  /** Weighted tokens used for similarity. */
  tokens: Map<string, number>;
}

/** Normalize a failure message so incidental values do not split signatures. */
export function normalizeMessage(message: string): string {
  return (
    message
      // strip ANSI colour codes
      .replace(/\u001b\[[0-9;]*m/g, '')
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)]+/gi, '<url>')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
      .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
      .replace(/\b(?:0x)?[0-9a-f]{12,}\b/gi, '<hex>')
      .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds|milliseconds|m|min)\b/gi, '<duration>')
      .replace(/"[^"\n]*"/g, '"<str>"')
      .replace(/'[^'\n]*'/g, "'<str>'")
      .replace(/`[^`\n]*`/g, '`<str>`')
      .replace(/\b[A-Z]{2,}-\d+\b/g, '<id>')
      // Generated ids that mix letters and digits (btn-8f3a2c91, ember1234, ctl00_Main_x12, :r5:, j_idt42).
      .replace(/:r[0-9a-z]+:/g, '<id>')
      .replace(/\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[A-Za-z_][\w-]*\d[\w-]*\b/g, (t) => (t.length >= 5 ? '<id>' : t))
      .replace(/\d+(?:\.\d+)?/g, '<n>')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Extract the top `n` stack frames as "function@file" with line numbers removed. */
export function topFrames(stack: string | undefined, n = 3): string[] {
  if (!stack) return [];
  const frames: string[] = [];
  for (const line of stack.split('\n')) {
    const m = /^\s*at\s+(?:(.+?)\s+\()?(.+?)(?::\d+)?(?::\d+)?\)?\s*$/.exec(line);
    if (!m) continue;
    const fn = (m[1] ?? '<anonymous>').trim();
    const file = m[2]
      .replace(/^file:\/\//, '')
      .replace(/:\d+(?::\d+)?$/, '')
      .split(/[\\/]/)
      .slice(-2)
      .join('/');
    if (/node:internal|tools[\\/]testkit[\\/]/.test(m[2])) continue;
    frames.push(`${fn}@${file}`);
    if (frames.length >= n) break;
  }
  return frames;
}

function tokenize(normalized: string): string[] {
  return normalized
    .toLowerCase()
    .split(/[^a-z0-9<>_#.-]+/)
    .filter((t) => t.length > 1);
}

export function failureSignature(f: FailureInput, opts: { frames?: number } = {}): FailureSignature {
  if (typeof f.message !== 'string' || f.message.trim() === '') {
    throw new EzTestError('failureSignature requires a non-empty message', 'INVALID_INPUT');
  }
  const normalized = normalizeMessage(f.message);
  const frames = topFrames(f.stack, opts.frames ?? 3);
  const tokens = new Map<string, number>();
  for (const t of tokenize(normalized)) tokens.set(`m:${t}`, (tokens.get(`m:${t}`) ?? 0) + 1);
  frames.forEach((fr, i) => tokens.set(`f:${fr}`, 3 / (i + 1)));
  if (f.name) tokens.set(`n:${f.name}`, 2);
  const hash = sha256([f.name ?? '', normalized, ...frames].join('\n')).slice(0, 16);
  return { hash, normalized, frames, tokens };
}

/** Weighted Jaccard similarity: sum(min) / sum(max) over the union of tokens. */
export function weightedJaccard(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let num = 0;
  let den = 0;
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    const x = a.get(k) ?? 0;
    const y = b.get(k) ?? 0;
    num += Math.min(x, y);
    den += Math.max(x, y);
  }
  return den === 0 ? 0 : num / den;
}

export interface ClusterItem extends FailureInput {
  id: string;
}

export interface FailureCluster {
  id: string;
  /** Signature hash of the medoid. */
  signature: string;
  representative: ClusterItem;
  normalized: string;
  members: string[];
  size: number;
  /** Mean similarity of members to the medoid. */
  cohesion: number;
}

class UnionFind {
  private parent: number[];
  private rank: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb;
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
    else {
      this.parent[rb] = ra;
      this.rank[ra]++;
    }
  }
}

/** Cluster failures. Pairs with similarity >= threshold (default 0.6) or equal hashes are merged. */
export function clusterFailures(items: ClusterItem[], opts: { threshold?: number; frames?: number } = {}): FailureCluster[] {
  if (items.length === 0) return [];
  const threshold = opts.threshold ?? 0.6;
  if (!(threshold > 0 && threshold <= 1)) throw new EzTestError('threshold must be in (0, 1]', 'INVALID_OPTIONS');
  const sigs = items.map((it) => failureSignature(it, { frames: opts.frames }));
  const n = items.length;
  const sim: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const uf = new UnionFind(n);
  for (let i = 0; i < n; i++) {
    sim[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const s = sigs[i].hash === sigs[j].hash ? 1 : weightedJaccard(sigs[i].tokens, sigs[j].tokens);
      sim[i][j] = sim[j][i] = s;
      if (s >= threshold) uf.union(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    const g = groups.get(r) ?? [];
    g.push(i);
    groups.set(r, g);
  }
  const clusters: FailureCluster[] = [];
  for (const members of groups.values()) {
    let best = members[0];
    let bestSum = -1;
    for (const i of members) {
      let sum = 0;
      for (const j of members) sum += sim[i][j];
      if (sum > bestSum) {
        bestSum = sum;
        best = i;
      }
    }
    const cohesion = members.reduce((acc, j) => acc + sim[best][j], 0) / members.length;
    clusters.push({
      id: `C-${sigs[best].hash.slice(0, 8)}`,
      signature: sigs[best].hash,
      representative: items[best],
      normalized: sigs[best].normalized,
      members: members.map((i) => items[i].id),
      size: members.length,
      cohesion,
    });
  }
  return clusters.sort((a, b) => b.size - a.size || a.id.localeCompare(b.id));
}
