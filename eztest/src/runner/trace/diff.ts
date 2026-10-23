/**
 * Trace comparison: two traces of the same journey, step by step ("what
 * changed since the last green run"). Steps are matched by step id (the last
 * execution of each step counts). Per step: status, the locator that resolved
 * the target (and heals), timing deltas by phase, a word diff of the target
 * region's text, URL, post-conditions and network differences (requests are
 * compared by method and path with numeric ids normalised).
 */
import type { TraceFile, TraceNetworkEntry, TraceStep } from './types.js';

export interface TextDiff {
  changed: boolean;
  /** Phrases only in A / only in B. */
  removed: string[];
  added: string[];
}

export interface NetworkDiff {
  /** Request keys ("POST /orders/new") only in B / only in A. */
  added: string[];
  removed: string[];
  statusChanged: Array<{ request: string; a?: number; b?: number }>;
}

export interface StepDiff {
  stepId: string;
  intent: string;
  index: { a?: number; b?: number };
  presence: 'both' | 'only-a' | 'only-b';
  status: { a?: string; b?: string; changed: boolean };
  locator: { a?: string; b?: string; changed: boolean; healTier?: { a?: string; b?: string } };
  timing: {
    a?: number;
    b?: number;
    deltaMs?: number;
    phases: { locateMs?: number; actMs?: number; verifyMs?: number };
  };
  url: { a?: string; b?: string; changed: boolean };
  conditions: Array<{ text: string; a?: boolean; b?: boolean }>;
  text: TextDiff;
  network: NetworkDiff;
  /** Why this step counts as changed. */
  reasons: string[];
}

export interface TraceDiff {
  journeyId: string;
  a: { runId: string; attempt: number; status: string };
  b: { runId: string; attempt: number; status: string };
  steps: StepDiff[];
  summary: {
    changedSteps: number;
    firstDivergence?: { stepId: string; reasons: string[] };
    statusChanges: string[];
    locatorChanges: string[];
    /** Steps at least 50% and 250 ms slower in B. */
    slower: string[];
    totalDeltaMs: number;
  };
}

/** Compare trace B (e.g. the failing run) against trace A (e.g. the last green run). */
export function diffTraces(a: TraceFile, b: TraceFile): TraceDiff {
  const lastExec = (t: TraceFile) => {
    const m = new Map<string, TraceStep>();
    for (const s of t.steps) {
      const prev = m.get(s.stepId);
      if (!prev || s.execution >= prev.execution) m.set(s.stepId, s);
    }
    return m;
  };
  const sa = lastExec(a);
  const sb = lastExec(b);
  const order: string[] = [...sa.keys()];
  for (const k of sb.keys()) if (!sa.has(k)) order.push(k);
  const steps = order.map((id) => diffStep(id, sa.get(id), sb.get(id)));
  const changed = steps.filter((s) => s.reasons.length);
  const first = changed[0];
  return {
    journeyId: b.journeyId,
    a: { runId: a.runId, attempt: a.attempt, status: a.status },
    b: { runId: b.runId, attempt: b.attempt, status: b.status },
    steps,
    summary: {
      changedSteps: changed.length,
      ...(first ? { firstDivergence: { stepId: first.stepId, reasons: first.reasons } } : {}),
      statusChanges: steps.filter((s) => s.status.changed).map((s) => s.stepId),
      locatorChanges: steps.filter((s) => s.locator.changed).map((s) => s.stepId),
      slower: steps.filter((s) => s.timing.deltaMs !== undefined && s.timing.a !== undefined && s.timing.deltaMs >= 250 && s.timing.deltaMs >= 0.5 * s.timing.a).map((s) => s.stepId),
      totalDeltaMs: b.durationMs - a.durationMs,
    },
  };
}

function diffStep(stepId: string, a?: TraceStep, b?: TraceStep): StepDiff {
  const reasons: string[] = [];
  const presence = a && b ? 'both' : a ? 'only-a' : 'only-b';
  if (presence !== 'both') reasons.push(presence === 'only-a' ? 'step missing in B' : 'step new in B');
  const status = { a: a?.status, b: b?.status, changed: !!a && !!b && a.status !== b.status };
  if (status.changed) reasons.push(`status ${a!.status} -> ${b!.status}`);
  const la = a?.locator.usedDescription;
  const lb = b?.locator.usedDescription;
  const ta = a?.heal?.record?.tier;
  const tb = b?.heal?.record?.tier;
  const locator = { a: la, b: lb, changed: !!a && !!b && la !== lb, ...(ta || tb ? { healTier: { a: ta, b: tb } } : {}) };
  if (locator.changed) reasons.push(`locator ${la ?? 'none'} -> ${lb ?? 'none'}`);
  const delta = (x?: number, y?: number) => (x !== undefined && y !== undefined ? y - x : undefined);
  const timing = {
    a: a?.durationMs,
    b: b?.durationMs,
    deltaMs: delta(a?.durationMs, b?.durationMs),
    phases: {
      locateMs: delta(a?.timings.locateMs, b?.timings.locateMs),
      actMs: delta(a?.timings.actMs, b?.timings.actMs),
      verifyMs: delta(a?.timings.verifyMs, b?.timings.verifyMs),
    },
  };
  const ua = normUrl(a?.url.after);
  const ub = normUrl(b?.url.after);
  const url = { a: a?.url.after, b: b?.url.after, changed: !!a && !!b && ua !== ub };
  if (url.changed) reasons.push('page URL after the step differs');
  const conds = new Map<string, { text: string; a?: boolean; b?: boolean }>();
  for (const c of a?.conditions ?? []) conds.set(c.text, { text: c.text, a: c.passed });
  for (const c of b?.conditions ?? []) conds.set(c.text, { ...(conds.get(c.text) ?? { text: c.text }), b: c.passed });
  const conditions = [...conds.values()].filter((c) => c.a !== c.b);
  if (conditions.length) reasons.push(`${conditions.length} post-condition(s) changed`);
  const text = diffText(regionText(a), regionText(b));
  if (a && b && text.changed) reasons.push(hasTarget(a) || hasTarget(b) ? 'target region text changed' : 'page text changed');
  const network = diffNetwork(a?.network ?? [], b?.network ?? []);
  if (a && b && (network.added.length || network.removed.length || network.statusChanged.length)) reasons.push('network requests differ');
  return { stepId, intent: (b ?? a)!.intent, index: { a: a?.index, b: b?.index }, presence, status, locator, timing, url, conditions, text, network, reasons };
}

function hasTarget(s: TraceStep): boolean {
  return !!(s.snapshots.before?.target ?? s.snapshots.after?.target);
}

function regionText(s?: TraceStep): string {
  if (!s) return '';
  const snap = s.snapshots.before ?? s.snapshots.after;
  return snap?.target?.regionText ?? s.snapshots.after?.text ?? snap?.text ?? '';
}

function normUrl(u?: string): string | undefined {
  if (!u) return u;
  try {
    const x = new URL(u);
    return `${x.pathname.replace(/\d+/g, ':n')}`;
  } catch {
    return u;
  }
}

function netKey(n: TraceNetworkEntry): string {
  return `${n.method} ${normUrl(n.url) ?? n.url}`;
}

export function diffNetwork(a: TraceNetworkEntry[], b: TraceNetworkEntry[]): NetworkDiff {
  const count = (list: TraceNetworkEntry[]) => {
    const m = new Map<string, TraceNetworkEntry[]>();
    for (const n of list) m.set(netKey(n), [...(m.get(netKey(n)) ?? []), n]);
    return m;
  };
  const ma = count(a);
  const mb = count(b);
  const added: string[] = [];
  const removed: string[] = [];
  const statusChanged: NetworkDiff['statusChanged'] = [];
  for (const [k, list] of mb) {
    const other = ma.get(k) ?? [];
    for (let i = other.length; i < list.length; i++) added.push(k);
    for (let i = 0; i < Math.min(other.length, list.length); i++) {
      if (other[i].status !== list[i].status) statusChanged.push({ request: k, a: other[i].status, b: list[i].status });
    }
  }
  for (const [k, list] of ma) {
    const other = mb.get(k) ?? [];
    for (let i = other.length; i < list.length; i++) removed.push(k);
  }
  return { added, removed, statusChanged };
}

/** Word-level diff (LCS) of two texts, returned as removed/added phrases. */
export function diffText(a: string, b: string): TextDiff {
  if (a === b) return { changed: false, removed: [], added: [] };
  const wa = a.split(/\s+/).filter(Boolean).slice(0, 800);
  const wb = b.split(/\s+/).filter(Boolean).slice(0, 800);
  const n = wa.length;
  const m = wb.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = wa[i] === wb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const removed: string[] = [];
  const added: string[] = [];
  let cr: string[] = [];
  let ca: string[] = [];
  const flush = () => {
    if (cr.length) removed.push(cr.join(' '));
    if (ca.length) added.push(ca.join(' '));
    cr = [];
    ca = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && wa[i] === wb[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) ca.push(wb[j++]);
    else cr.push(wa[i++]);
  }
  flush();
  return { changed: removed.length > 0 || added.length > 0, removed, added };
}
