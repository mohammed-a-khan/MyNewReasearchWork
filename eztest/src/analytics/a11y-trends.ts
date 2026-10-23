/**
 * Accessibility trends across runs: the a11y lens findings of every run
 * (EZTest accessibility engine violations per step) reduced to issues keyed
 * by rule + element fingerprint (the node's selector path) + route, then
 * compared run over run:
 * new, fixed and persisting issues per rule and per component.
 *
 * Components and per-component rule configuration come from
 * `accessibility.scopes` in eztest.config.yaml: a scope names a part of the
 * UI by selectors (`include`), and may turn rules off or down to warnings
 * there (e.g. a third-party widget's known contrast issue).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvidenceRef } from '../core/index.js';
import { readEvidenceManifest } from '../insights/artifacts.js';
import { routeTemplate } from './ui-coverage.js';

export interface A11yScope {
  name: string;
  /** CSS selectors (as the accessibility engine reports them) whose elements belong to the scope; matched as a prefix or contained part of the target. */
  include: string[];
  exclude?: string[];
  /** Rule overrides inside the scope. */
  rules?: Record<string, 'off' | 'warn' | 'error'>;
}

export interface A11yIssue {
  /** rule|route|target */
  key: string;
  ruleId: string;
  impact: string | null;
  help: string;
  route: string;
  target: string;
  component: string;
  /** Downgraded by a scope rule override. */
  level: 'error' | 'warn';
  journeys: string[];
  evidence: string[];
}

export interface A11yRunIssues {
  runId: string;
  startedAt?: string;
  issues: A11yIssue[];
  scannedSteps: number;
}

interface LensFindingFile {
  lens?: string;
  details?: { url?: string; violations?: Array<{ ruleId: string; impact: string | null; help: string; nodes: Array<{ target: string[] }> }> };
}

function scopeOf(target: string, scopes: A11yScope[]): A11yScope | undefined {
  const hit = (sel: string) => target === sel || target.startsWith(`${sel} `) || target.startsWith(`${sel}>`) || target.includes(sel);
  return scopes.find((s) => s.include.some(hit) && !(s.exclude ?? []).some(hit));
}

/** The a11y issues of one run (per-scope rule overrides applied; "off" rules dropped). */
export async function a11yIssuesOfRun(runDir: string, runId: string, scopes: A11yScope[] = [], opts: { evidence?: EvidenceRef[]; routes?: string[]; startedAt?: string } = {}): Promise<A11yRunIssues> {
  const evidence = opts.evidence ?? (await readEvidenceManifest(runDir));
  const issues = new Map<string, A11yIssue>();
  let scanned = 0;
  for (const e of evidence) {
    if (e.kind !== 'data' || !/(?:^|\/)lens-a11y-/.test(e.path)) continue;
    let findings: LensFindingFile[];
    try {
      findings = JSON.parse(await readFile(join(runDir, e.path), 'utf8')) as LensFindingFile[];
    } catch {
      continue;
    }
    scanned++;
    for (const f of Array.isArray(findings) ? findings : []) {
      const scan = f.details;
      if (!scan?.violations) continue;
      const route = scan.url ? routeTemplate(scan.url, { routes: opts.routes }) : '(unknown page)';
      for (const v of scan.violations) {
        for (const n of v.nodes ?? []) {
          const target = (n.target ?? []).join(' >>> ');
          const scope = scopeOf(target, scopes);
          const override = scope?.rules?.[v.ruleId];
          if (override === 'off') continue;
          const key = `${v.ruleId}|${route}|${target}`;
          const cur = issues.get(key) ?? {
            key, ruleId: v.ruleId, impact: v.impact, help: v.help, route, target, component: scope?.name ?? route,
            level: override === 'warn' ? 'warn' as const : 'error' as const, journeys: [], evidence: [],
          };
          if (e.journeyId && !cur.journeys.includes(e.journeyId)) cur.journeys.push(e.journeyId);
          if (!cur.evidence.includes(e.id)) cur.evidence.push(e.id);
          issues.set(key, cur);
        }
      }
    }
  }
  return { runId, ...(opts.startedAt ? { startedAt: opts.startedAt } : {}), scannedSteps: scanned, issues: [...issues.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

export interface A11yTrend {
  /** Oldest first. */
  points: Array<{ runId: string; startedAt?: string; total: number; byImpact: Record<string, number>; scannedSteps: number; new: number; fixed: number }>;
  /** Latest run against the one before it. */
  latest?: { runId: string; previous?: string; new: A11yIssue[]; fixed: A11yIssue[]; persisting: A11yIssue[] };
  byRule: Array<{ ruleId: string; help: string; impact: string | null; open: number; new: number; fixed: number }>;
  byComponent: Array<{ component: string; open: number; new: number; fixed: number; rules: string[] }>;
}

/** Compare consecutive runs (oldest first). Runs with no a11y scans are left out. */
export function a11yTrend(runs: A11yRunIssues[]): A11yTrend {
  const scanned = runs.filter((r) => r.scannedSteps > 0);
  const points: A11yTrend['points'] = [];
  let prev: A11yRunIssues | undefined;
  for (const r of scanned) {
    const keys = new Set(r.issues.map((i) => i.key));
    const before = new Set(prev?.issues.map((i) => i.key) ?? []);
    const byImpact: Record<string, number> = {};
    for (const i of r.issues) byImpact[i.impact ?? 'unknown'] = (byImpact[i.impact ?? 'unknown'] ?? 0) + 1;
    points.push({
      runId: r.runId, ...(r.startedAt ? { startedAt: r.startedAt } : {}), total: r.issues.length, byImpact, scannedSteps: r.scannedSteps,
      new: prev ? [...keys].filter((k) => !before.has(k)).length : 0, fixed: prev ? [...before].filter((k) => !keys.has(k)).length : 0,
    });
    prev = r;
  }
  const last = scanned[scanned.length - 1];
  const prior = scanned[scanned.length - 2];
  let latest: A11yTrend['latest'];
  if (last) {
    const was = new Map((prior?.issues ?? []).map((i) => [i.key, i]));
    const now = new Map(last.issues.map((i) => [i.key, i]));
    latest = {
      runId: last.runId, ...(prior ? { previous: prior.runId } : {}),
      new: prior ? last.issues.filter((i) => !was.has(i.key)) : [],
      fixed: prior ? prior.issues.filter((i) => !now.has(i.key)) : [],
      persisting: prior ? last.issues.filter((i) => was.has(i.key)) : last.issues,
    };
  }
  const rules = new Map<string, A11yTrend['byRule'][number]>();
  const comps = new Map<string, A11yTrend['byComponent'][number] & { ruleSet: Set<string> }>();
  const add = (i: A11yIssue, field: 'open' | 'new' | 'fixed') => {
    const r = rules.get(i.ruleId) ?? { ruleId: i.ruleId, help: i.help, impact: i.impact, open: 0, new: 0, fixed: 0 };
    r[field]++;
    rules.set(i.ruleId, r);
    const c = comps.get(i.component) ?? { component: i.component, open: 0, new: 0, fixed: 0, rules: [], ruleSet: new Set<string>() };
    c[field]++;
    c.ruleSet.add(i.ruleId);
    comps.set(i.component, c);
  };
  for (const i of last?.issues ?? []) add(i, 'open');
  for (const i of latest?.new ?? []) add(i, 'new');
  for (const i of latest?.fixed ?? []) add(i, 'fixed');
  return {
    points,
    ...(latest ? { latest } : {}),
    byRule: [...rules.values()].sort((a, b) => b.open - a.open || a.ruleId.localeCompare(b.ruleId)),
    byComponent: [...comps.values()].map(({ ruleSet, ...c }) => ({ ...c, rules: [...ruleSet].sort() })).sort((a, b) => b.open - a.open || a.component.localeCompare(b.component)),
  };
}
