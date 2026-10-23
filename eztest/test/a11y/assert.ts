/**
 * Accessibility assertion for EZTest's own UI tests (Studio, the HTML
 * report, the Azure DevOps results tab): no serious or critical violation
 * from EZTest's accessibility engine.
 */
import { expect } from '../support/testkit.js';
import type { Page } from '../../src/browser/index.js';
import { scanAccessibility, type A11yScanResult } from '../../src/a11y/index.js';

/** The rule set the UI tests hold Studio to: WCAG 2.0, 2.1 and 2.2 A/AA plus best practices. */
export const UI_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

export function describeViolations(label: string, r: A11yScanResult): string[] {
  return r.violations.map(
    (v) => `${label}: ${v.ruleId} (${v.impact}) ${v.help} at ${v.nodes.slice(0, 5).map((n) => `${n.target.join(' ')} [${n.failureSummary}]`).join(', ')}`,
  );
}

export async function expectNoSeriousA11y(page: Page, label: string, tags: string[] = UI_TAGS, opts: { dynamic?: boolean } = {}): Promise<A11yScanResult> {
  const r = await scanAccessibility(page, { tags, minImpact: 'serious', ...(opts.dynamic ? { dynamic: true, maxTabStops: 60 } : {}) });
  expect(describeViolations(label, r)).toEqual([]);
  return r;
}
