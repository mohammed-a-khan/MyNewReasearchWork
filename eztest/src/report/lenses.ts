/**
 * The quality lenses of a run, summarised for the report: accessibility
 * violations by rule, security findings by check, and performance budgets by
 * metric, each with the tests and pages it was seen on and the evidence it
 * came from. Read from the lens findings the runner records per step
 * (`lens-<name>-<step>.json`).
 */

export interface LensFile {
  journeyId: string;
  stepId?: string;
  evidenceId: string;
  /** The recorded findings: [{ lens, severity, message, details }]. */
  findings: unknown;
}

export interface LensSummary {
  /** Steps the lenses looked at (per lens). */
  scanned: Record<string, number>;
  a11y?: {
    counts: Record<'critical' | 'serious' | 'moderate' | 'minor', number>;
    rules: Array<{ id: string; impact: string; help: string; sc: string[]; helpUrl?: string; nodes: number; tests: string[]; pages: string[]; targets: string[]; ev: string[] }>;
  };
  security?: {
    counts: Record<'high' | 'medium' | 'low' | 'info', number>;
    findings: Array<{ id: string; severity: string; message: string; pages: string[]; tests: string[]; ev: string[] }>;
  };
  perf?: {
    metrics: Array<{ metric: string; status: string; worst: number; warn?: number; error?: number; samples: number; tests: string[]; ev: string[] }>;
  };
}

const IMPACT_RANK: Record<string, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const SEV_RANK: Record<string, number> = { high: 0, critical: 0, medium: 1, low: 2, info: 3 };
const STATUS_RANK: Record<string, number> = { fail: 0, warn: 1, pass: 2, 'no-data': 3 };

const add = (list: string[], v: string | undefined, cap = 50) => {
  if (v && !list.includes(v) && list.length < cap) list.push(v);
};
const path = (u: unknown) => {
  if (typeof u !== 'string') return undefined;
  try {
    const x = new URL(u);
    return /^https?:$/.test(x.protocol) ? `${x.host}${x.pathname}` : u.slice(0, 200);
  } catch {
    return u.slice(0, 200);
  }
};

/** Summarise lens findings. Returns undefined when no lens ran. */
export function summariseLenses(files: LensFile[]): LensSummary | undefined {
  if (!files.length) return undefined;
  const scanned: Record<string, number> = {};
  const a11y = new Map<string, NonNullable<LensSummary['a11y']>['rules'][number]>();
  const a11yCounts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  const sec = new Map<string, NonNullable<LensSummary['security']>['findings'][number]>();
  const secCounts = { high: 0, medium: 0, low: 0, info: 0 };
  const perf = new Map<string, NonNullable<LensSummary['perf']>['metrics'][number]>();
  let sawA11y = false;
  let sawSec = false;
  for (const f of files) {
    const list = Array.isArray(f.findings) ? (f.findings as Array<{ lens?: string; details?: Record<string, unknown> }>) : [];
    for (const x of list) {
      const lens = String(x?.lens ?? '');
      const d = x?.details;
      if (!lens || !d || typeof d !== 'object') continue;
      // A page check on a step without a web page (about:blank) says nothing about the application.
      if (typeof d.url === 'string' && /^about:/.test(d.url)) continue;
      scanned[lens] = (scanned[lens] ?? 0) + 1;
      if (lens === 'a11y' && Array.isArray(d.violations)) {
        sawA11y = true;
        const page = path(d.url);
        for (const v of d.violations as Array<{ ruleId?: string; impact?: string | null; help?: string; helpUrl?: string; sc?: string[]; nodeCount?: number; nodes?: Array<{ target?: string[] }> }>) {
          if (!v?.ruleId) continue;
          const impact = v.impact ?? 'minor';
          const r = a11y.get(v.ruleId) ?? { id: v.ruleId, impact, help: String(v.help ?? ''), sc: Array.isArray(v.sc) ? v.sc.slice(0, 6) : [], ...(v.helpUrl && /^https?:/.test(v.helpUrl) ? { helpUrl: v.helpUrl } : {}), nodes: 0, tests: [], pages: [], targets: [], ev: [] };
          r.nodes += Number(v.nodeCount ?? v.nodes?.length ?? 1) || 1;
          if ((IMPACT_RANK[impact] ?? 9) < (IMPACT_RANK[r.impact] ?? 9)) r.impact = impact;
          add(r.tests, f.journeyId);
          add(r.pages, page);
          for (const n of (v.nodes ?? []).slice(0, 3)) add(r.targets, (n.target ?? []).join(' ').slice(0, 160), 8);
          add(r.ev, f.evidenceId, 10);
          a11y.set(v.ruleId, r);
          if (impact in a11yCounts) a11yCounts[impact as keyof typeof a11yCounts] += Number(v.nodeCount ?? 1) || 1;
        }
      } else if (lens === 'security' && Array.isArray(d.findings)) {
        sawSec = true;
        for (const s of d.findings as Array<{ id?: string; severity?: string; message?: string; url?: string }>) {
          if (!s?.id) continue;
          const sev = String(s.severity ?? 'info');
          const r = sec.get(s.id) ?? { id: s.id, severity: sev, message: String(s.message ?? '').slice(0, 300), pages: [], tests: [], ev: [] };
          const firstForPage = !r.pages.includes(path(s.url) ?? '');
          add(r.pages, path(s.url));
          add(r.tests, f.journeyId);
          add(r.ev, f.evidenceId, 10);
          sec.set(s.id, r);
          if (firstForPage) {
            const k = sev === 'critical' ? 'high' : sev;
            if (k in secCounts) secCounts[k as keyof typeof secCounts]++;
          }
        }
      } else if (lens === 'perf' && d.budgets && typeof d.budgets === 'object') {
        for (const it of ((d.budgets as { items?: Array<{ metric?: string; status?: string; value?: number; warn?: number; error?: number }> }).items ?? [])) {
          if (!it?.metric || typeof it.value !== 'number') continue;
          const r = perf.get(it.metric) ?? { metric: it.metric, status: 'pass', worst: it.value, ...(it.warn !== undefined ? { warn: it.warn } : {}), ...(it.error !== undefined ? { error: it.error } : {}), samples: 0, tests: [], ev: [] };
          r.samples++;
          if (it.value > r.worst) r.worst = it.value;
          const s = String(it.status ?? 'pass');
          if ((STATUS_RANK[s] ?? 9) < (STATUS_RANK[r.status] ?? 9)) r.status = s;
          if (s === 'fail' || s === 'warn') {
            add(r.tests, f.journeyId);
            add(r.ev, f.evidenceId, 10);
          }
          perf.set(it.metric, r);
        }
      }
    }
  }
  const out: LensSummary = { scanned };
  if (sawA11y) out.a11y = { counts: a11yCounts, rules: [...a11y.values()].sort((a, b) => (IMPACT_RANK[a.impact] ?? 9) - (IMPACT_RANK[b.impact] ?? 9) || b.nodes - a.nodes) };
  if (sawSec) out.security = { counts: secCounts, findings: [...sec.values()].sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9) || b.pages.length - a.pages.length) };
  if (perf.size) out.perf = { metrics: [...perf.values()].sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || a.metric.localeCompare(b.metric)) };
  return Object.keys(scanned).length ? out : undefined;
}
