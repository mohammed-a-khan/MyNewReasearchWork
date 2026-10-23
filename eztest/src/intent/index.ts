/**
 * Plain-English authoring: a deterministic grammar from English lines to
 * Journey steps, element descriptions to locator candidates, and the `.ez`
 * script format.
 */
export { parseIntent, IntentParseError, defaultStepId, suggest, registerIntentRules, matchesPluginRule, matchedRule, type ParseIntentOptions, type StepAnnotations } from './parse.js';
export { INTENT_RULES, parseDuration, parseKeyValues, type IntentRule, type StepBody } from './rules.js';
export { QUERY_RULES, queryStepToText, parseQueryArgs } from './rules-queries.js';
export { VISUAL_RULES, isVisualExpectation } from './rules-visual.js';
export { A11Y_RULES, isA11yExpectation } from './rules-a11y.js';
export { MANUAL_RULES, MANUAL_LINE, EXPECTED_LINE, ATTACHMENT_LINE, isManualLine } from './rules-manual.js';
export { KEYBOARD_RULES, isKeyboardExpectation } from './rules-keyboard.js';
export { COMPONENT_RULES, isComponentExpectation, componentStepToText, widgetTarget, widgetName, widgetNames, parseWhere, whereToText, type ComponentWidget, type CellCondition } from './rules-components.js';
export { CONDITION_RULES, parseCondition, tryParseCondition, conditionToText, tableRowsTarget } from './conditions.js';
export { describeTarget, analyzeDescription, candidatesFor, KIND_ROLE, type TargetKind, type DescribedTarget } from './target.js';
export { parseEzScript, journeyToEzScript, stepToText, type ParseEzOptions } from './ezscript.js';
export { loadJourneyFile, normalizeJourneyInput } from './load.js';
export { protectQuotes, restoreQuotes, quoteText } from './quotes.js';
export {
  parseExamplesSource, examplesSourceToText, examplesSourceFromObject, isExamplesFromLine,
  parseRowFilter, matchRow, rowFilterColumns, rowFilterComparisons, rowFilterToText, rowValue, FilterSyntaxError,
  type ExamplesSource, type RowFilter, type FilterOp,
} from './examples-source.js';
