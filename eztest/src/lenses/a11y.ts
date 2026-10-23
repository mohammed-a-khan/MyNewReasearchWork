/**
 * Accessibility lens: runs EZTest's own accessibility engine (src/a11y)
 * against the page after a step. Findings carry the rule, its WCAG success
 * criteria, impact, help, the offending nodes with selectors, explanations
 * and boxes; tags / level / include / exclude choose what is checked.
 */
import type { Page } from '../browser/index.js';
import { IMPACT_ORDER, type A11yImpact } from '../a11y/catalogue.js';
import { scanAccessibility } from '../a11y/scan.js';
import type { A11yScanOptions, A11yScanResult } from '../a11y/types.js';
import { storeLensEvidence, type Lens, type LensContext, type LensResult, type LensStep } from './lens.js';

export { scanAccessibility };
export type { A11yImpact, A11yNode, A11yFinding, A11yScanOptions, A11yScanResult } from '../a11y/types.js';

export interface A11yLensOptions extends A11yScanOptions {
  /** The step fails the lens when a finding at or above this impact exists. Default "serious". */
  failOn?: A11yImpact;
}

export function createA11yLens(opts: A11yLensOptions = {}): Lens<A11yScanResult> {
  const { failOn: failOnName = 'serious', ...scan } = opts;
  const failOn = IMPACT_ORDER.indexOf(failOnName);
  return {
    name: 'a11y',
    async afterStep(page: Page, step: LensStep, ctx?: LensContext): Promise<LensResult<A11yScanResult>> {
      const res = await scanAccessibility(page, scan);
      const blocking = res.violations.filter((v) => v.impact && IMPACT_ORDER.indexOf(v.impact) >= failOn);
      const evidence = await storeLensEvidence(ctx, 'a11y', step, res);
      return {
        lens: 'a11y',
        stepId: step.id,
        passed: blocking.length === 0,
        summary: `${res.violations.length} violation(s) (${blocking.length} at or above ${failOnName}), ${res.needsReview.length} to review, on ${res.url}`,
        evidence,
        data: res,
      };
    },
  };
}
