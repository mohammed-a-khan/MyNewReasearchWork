/**
 * EZTest's accessibility engine (`eztest/a11y`): rules written from WCAG
 * 2.2, WAI-ARIA 1.2, HTML-AAM and accname 1.2, run in the page through
 * EZTest's own browser driver. See docs/accessibility.md.
 */
export { scanAccessibility, selectRules } from './scan.js';
export { RULES, RULES_BY_ID, IMPACT_ORDER, ruleTags, ruleLevel, ruleUrl, type RuleMeta, type RuleCategory, type DynamicKind } from './catalogue.js';
export { SUCCESS_CRITERIA, criterion, understandingUrl, type SuccessCriterion, type WcagLevel } from './wcag.js';
export { A11Y_STEP, createA11yStepHandler, type A11yStepOptions } from './step.js';
export { a11yReadinessInputs, isA11yEvidence } from './readiness.js';
export { a11ySource, buildA11ySource, PREBUILT_A11Y, A11Y_GLOBAL } from './bundle.js';
export type { A11yImpact, A11yNode, A11yFinding, A11yScanOptions, A11yScanResult, A11yDynamicOptions } from './types.js';
