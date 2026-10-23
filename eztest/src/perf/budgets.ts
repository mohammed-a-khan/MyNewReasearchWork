/**
 * Performance budgets: warn / error thresholds for Web Vitals (incl. INP) and
 * API timings. A budget that has no measurement is "no-data", never "pass".
 */
import { EzTestError } from '../core/index.js';
import { urlMatches } from '../insights/glob.js';
import { entryDuration, type NetworkEntry } from './network.js';
import type { WebVitals } from './vitals.js';
import { percentile } from './stats.js';

export interface Threshold {
  warn?: number;
  error?: number;
}

export type VitalName = 'LCP' | 'CLS' | 'INP' | 'FCP' | 'TTFB';

export interface ApiBudget {
  name?: string;
  /** URL pattern (see urlMatches), e.g. "127.0.0.1:4600/api/**". */
  match: string;
  method?: string;
  p50?: Threshold;
  p95?: Threshold;
  max?: Threshold;
  /** Fraction 0..1 of responses with status >= 400 or network failure. */
  errorRate?: Threshold;
}

export interface PerfBudgets {
  vitals?: Partial<Record<VitalName, Threshold>>;
  api?: ApiBudget[];
}

/** "Good" / "poor" boundaries published for Core Web Vitals. */
export const DEFAULT_VITAL_BUDGETS: Record<VitalName, Required<Threshold>> = {
  LCP: { warn: 2500, error: 4000 },
  CLS: { warn: 0.1, error: 0.25 },
  INP: { warn: 200, error: 500 },
  FCP: { warn: 1800, error: 3000 },
  TTFB: { warn: 800, error: 1800 },
};

export type BudgetStatus = 'pass' | 'warn' | 'fail' | 'no-data';

export interface BudgetItem {
  metric: string;
  status: BudgetStatus;
  value?: number;
  warn?: number;
  error?: number;
  samples?: number;
  journeyId?: string;
  evidence?: string[];
}

export interface BudgetResult {
  status: BudgetStatus;
  items: BudgetItem[];
}

function judge(value: number | null | undefined, t: Threshold): BudgetStatus {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'no-data';
  if (t.error !== undefined && value > t.error) return 'fail';
  if (t.warn !== undefined && value > t.warn) return 'warn';
  return 'pass';
}

const RANK: Record<BudgetStatus, number> = { pass: 0, warn: 1, 'no-data': 2, fail: 3 };

export function evaluateBudgets(
  measured: { vitals?: WebVitals | Partial<Record<VitalName, number | null>>; network?: NetworkEntry[] },
  budgets: PerfBudgets,
  ctx: { journeyId?: string; evidence?: string[] } = {},
): BudgetResult {
  const items: BudgetItem[] = [];
  const vb = budgets.vitals ?? {};
  const apis = budgets.api ?? [];
  if (Object.keys(vb).length === 0 && apis.length === 0) throw new EzTestError('evaluateBudgets: no budgets defined', 'INVALID_INPUT');
  for (const t of [...Object.values(vb), ...apis.flatMap((a) => [a.p50, a.p95, a.max, a.errorRate])]) {
    if (t && t.warn !== undefined && t.error !== undefined && t.warn > t.error) throw new EzTestError('budget warn threshold exceeds error threshold', 'INVALID_INPUT');
  }
  const base = { journeyId: ctx.journeyId, evidence: ctx.evidence };
  for (const [name, t] of Object.entries(vb) as Array<[VitalName, Threshold]>) {
    const value = measured.vitals ? (measured.vitals as Record<string, number | null | undefined>)[name] : undefined;
    items.push({ metric: name, status: judge(value, t), value: value ?? undefined, warn: t.warn, error: t.error, ...base });
  }
  for (const a of apis) {
    const label = a.name ?? `${a.method ? a.method.toUpperCase() + ' ' : ''}${a.match}`;
    const hits = (measured.network ?? []).filter((e) => urlMatches(a.match, e.url) && (!a.method || e.method.toUpperCase() === a.method.toUpperCase()));
    const durs = hits.map(entryDuration).filter((d): d is number => typeof d === 'number' && Number.isFinite(d));
    const add = (metric: string, value: number | undefined, t: Threshold | undefined) => {
      if (!t) return;
      items.push({ metric: `${label} ${metric}`, status: judge(value, t), value, warn: t.warn, error: t.error, samples: hits.length, ...base });
    };
    add('p50', durs.length ? percentile(durs, 50) : undefined, a.p50);
    add('p95', durs.length ? percentile(durs, 95) : undefined, a.p95);
    add('max', durs.length ? Math.max(...durs) : undefined, a.max);
    add('errorRate', hits.length ? hits.filter((e) => e.status >= 400 || e.status === 0).length / hits.length : undefined, a.errorRate);
  }
  const status = items.reduce<BudgetStatus>((acc, i) => (RANK[i.status] > RANK[acc] ? i.status : acc), 'pass');
  return { status, items };
}
