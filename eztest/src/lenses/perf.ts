/**
 * Performance lens: Web Vitals (LCP, CLS, INP, FCP, TTFB) after every step,
 * judged against budgets (Core Web Vitals "good"/"poor" boundaries by
 * default). The collector is installed for later navigations and injected
 * into the current document on first use; its observers are buffered, so the
 * paint and layout-shift entries of the page already loaded are still seen.
 */
import type { Page } from '../browser/index.js';
import { DEFAULT_VITAL_BUDGETS, evaluateBudgets, type BudgetResult, type Threshold, type VitalName } from '../perf/budgets.js';
import { WEB_VITALS_INIT_SCRIPT, collectWebVitals, type WebVitals } from '../perf/vitals.js';
import { storeLensEvidence, type Lens, type LensContext, type LensResult, type LensStep } from './lens.js';

export interface PerfLensOptions {
  /** Budgets per vital (default: the published Core Web Vitals thresholds). */
  budgets?: Partial<Record<VitalName, Threshold>>;
  /** Which budget status fails the lens: "fail" (default) or "warn". */
  failOn?: 'warn' | 'fail';
}

export interface PerfLensResult {
  vitals: WebVitals;
  budgets: BudgetResult;
}

export function createPerfLens(opts: PerfLensOptions = {}): Lens<PerfLensResult> {
  const installed = new WeakSet<object>();
  const budgets = opts.budgets ?? DEFAULT_VITAL_BUDGETS;
  return {
    name: 'perf',
    async afterStep(page: Page, step: LensStep, ctx?: LensContext): Promise<LensResult<PerfLensResult>> {
      const context = page.context();
      if (!installed.has(context)) {
        installed.add(context);
        await context.addInitScript({ content: WEB_VITALS_INIT_SCRIPT });
      }
      // The current document predates the init script: inject it now (idempotent).
      await page.evaluate(WEB_VITALS_INIT_SCRIPT.trim().replace(/;$/, ''));
      const vitals = await collectWebVitals(page);
      const result = evaluateBudgets({ vitals }, { vitals: budgets });
      const failing = result.items.filter((i) => i.status === 'fail' || (opts.failOn === 'warn' && i.status === 'warn'));
      const fmt = (n: number | null) => (n === null ? 'n/a' : Math.round(n * 1000) / 1000);
      return {
        lens: 'perf',
        stepId: step.id,
        passed: failing.length === 0,
        summary: `LCP ${fmt(vitals.LCP)} ms, CLS ${fmt(vitals.CLS)}, INP ${fmt(vitals.INP)} ms, FCP ${fmt(vitals.FCP)} ms, TTFB ${fmt(vitals.TTFB)} ms` +
          (failing.length ? `; over budget: ${failing.map((f) => f.metric).join(', ')}` : ''),
        evidence: await storeLensEvidence(ctx, 'perf', step, { vitals, budgets: result }),
        data: { vitals, budgets: result },
      };
    },
  };
}
