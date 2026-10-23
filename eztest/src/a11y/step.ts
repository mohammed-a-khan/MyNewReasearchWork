/**
 * The "Check accessibility" step (custom handler "eztest.a11y"):
 *
 *   Check accessibility
 *   Check the page for accessibility issues at WCAG 2.2 level AA
 *   Check accessibility in the Checkout form without dynamic checks
 *   Expect the page to be accessible to level AAA
 *
 * Unlike the a11y lens (static rules after every step), the step also runs
 * the dynamic checks by default: a keyboard walk, reflow at 320 CSS px and
 * text spacing. Findings are stored like lens findings, so Studio's
 * accessibility page and the a11yNoCritical readiness gate see them.
 */
import { randomBytes } from 'node:crypto';
import { EzTestError, slugify, type Step } from '../core/index.js';
import { resolveTarget, rootFor } from '../runner/locate.js';
import type { CustomStepHandler, StepContext } from '../runner/types.js';
import type { Page } from '../browser/index.js';
import { IMPACT_ORDER, type A11yImpact } from './catalogue.js';
import { scanAccessibility } from './scan.js';
import type { WcagLevel } from './wcag.js';

export const A11Y_STEP = 'eztest.a11y';

export interface A11yStepOptions {
  /** Impact at or above which the step fails (default "serious"). */
  failOn?: A11yImpact;
}

export function createA11yStepHandler(o: A11yStepOptions = {}): CustomStepHandler {
  return async (page: Page, step: Step, ctx: StepContext) => {
    const a = (step.args ?? {}) as Record<string, unknown>;
    const level = (typeof a.level === 'string' ? a.level.toUpperCase() : 'AA') as WcagLevel;
    if (!['A', 'AA', 'AAA'].includes(level)) throw new EzTestError(`Unknown WCAG level "${String(a.level)}"`, 'INVALID_INPUT');
    const failOn = (typeof a.failOn === 'string' ? a.failOn : o.failOn ?? 'serious') as A11yImpact;
    if (!IMPACT_ORDER.includes(failOn)) throw new EzTestError(`Unknown impact "${failOn}"`, 'INVALID_INPUT');
    const dynamic = a.dynamic !== 'false' && a.dynamic !== false;
    const bestPractice = a.bestPractice === 'true' || a.bestPractice === true;

    let scope: string | undefined;
    let cleanup: (() => Promise<void>) | undefined;
    if (step.target) {
      const r = await resolveTarget(rootFor(page, [...(ctx.session?.frames ?? []), ...(step.target.frames ?? [])]), step.target, ctx.vars(), step.timeoutMs ?? 10_000);
      if (!r.locator) throw new EzTestError(`${step.target.description}: not found exactly once (${r.notes.join('; ')})`, 'TARGET_NOT_FOUND');
      const token = randomBytes(6).toString('hex');
      const loc = r.locator;
      await loc.evaluate((el: Element, t: string) => el.setAttribute('data-eztest-a11y-scope', t), token);
      scope = `[data-eztest-a11y-scope="${token}"]`;
      cleanup = async () => {
        await loc.evaluate((el: Element) => el.removeAttribute('data-eztest-a11y-scope')).catch(() => undefined);
      };
    }
    let res;
    try {
      res = await scanAccessibility(page, { level, bestPractice, dynamic, ...(scope ? { include: [scope] } : {}) });
    } finally {
      await cleanup?.();
    }
    const blocking = res.violations.filter((v) => v.impact && IMPACT_ORDER.indexOf(v.impact) >= IMPACT_ORDER.indexOf(failOn));
    const message = `${res.violations.length} accessibility violation(s) at WCAG ${level}${bestPractice ? ' + best practices' : ''} (${blocking.length} at or above ${failOn}), ${res.needsReview.length} to review`;
    const findings = [{ lens: 'a11y', severity: blocking.length ? 'error' : 'info', message, details: res }];
    await ctx.evidence.store('data', `a11y/${slugify(ctx.journey.id)}/lens-a11y-${slugify(step.id)}.json`, JSON.stringify(findings, null, 2), {
      journeyId: ctx.journey.id, stepId: step.id, description: `accessibility check (WCAG ${level})`,
    });
    if (blocking.length) {
      throw new EzTestError(
        `Accessibility check failed: ${blocking.map((v) => `${v.ruleId} (${v.impact}, ${v.nodeCount} element${v.nodeCount === 1 ? '' : 's'}): ${v.help}`).join(' | ')}`,
        'A11Y_VIOLATIONS',
        { violations: blocking.map((v) => ({ ruleId: v.ruleId, impact: v.impact, sc: v.sc, targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) })) },
      );
    }
    return { violations: res.violations.length, needsReview: res.needsReview.length, passes: res.passes };
  };
}
