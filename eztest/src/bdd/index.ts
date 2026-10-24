/**
 * Native BDD (`@eztech/eztest/bdd`): run Gherkin `.feature` files as they are, with
 * TypeScript step definitions, on EZTest's runner. See docs/bdd.md.
 *
 *   import { Given, When, Then, Before, defineParameterType } from '@eztech/eztest/bdd';
 *
 *   Given('the customer {string} has {int} orders', async ({ db, world }, name, n) => { ... });
 *
 * Everything here is EZTest's own: the Gherkin parser, the step expressions,
 * the tag expressions and the runner integration.
 */
export {
  Given, When, Then, Step, Before, After, BeforeStep, AfterStep, BeforeAll, AfterAll, defineParameterType, setWorldConstructor, pending, PendingStepError,
  glueOf, matchStep, hooksFor, resetBddRegistry,
  type BddContext, type BddAllContext, type AllHookFn, type World, type ScenarioInfo, type StepInfo, type HookResult, type StepFn, type HookFn, type StepDefinition,
  type StepDefinitionOptions, type HookDefinition, type HookOptions, type HookKind, type Glue, type StepMatch, type WorldConstructor,
} from './registry.js';
export { DataTable } from './datatable.js';
export {
  stepExpression, ParameterTypeRegistry, ExpressionSyntaxError, groupCount,
  type StepExpression, type ParameterTypeSpec, type ParameterType, type ExpressionMatch,
} from './expressions.js';
export { parseTagExpression, evaluateTags, tagMatcher, tagFilterFrom, isTagExpression, tagExpressionToText, TagExpressionError, type TagExpression } from './tags.js';
export { snippet, snippetExpression, type SnippetInput } from './snippets.js';
export { ezFallback, type FallbackInput, type FallbackStep } from './fallback.js';
export {
  featureJourneys, loadFeatureJourneys, loadGlue, findGlueFiles, featureDirsFrom, featureIdBase, isFeatureFile, FEATURE_RE, DEFAULT_STEP_GLOBS,
  type BddOptions,
} from './load.js';
export { parseGherkin, parseGherkinLenient, splitTableRow, GherkinParseError, type GherkinIssue, type ParseGherkinOptions } from './gherkin/parser.js';
export { compilePickles, type Pickle, type PickleStep, type PickleExamples, type CompileResult } from './gherkin/compile.js';
export { DIALECTS, dialectFor, languages, stepKeywords, type GherkinDialect, type KeywordType } from './gherkin/languages.js';
export type * from './gherkin/ast.js';
export { formatFeature } from './format.js';
export { validateFeature, type FeatureProblem, type FeatureValidation } from './validate.js';
export { analyzeFeature, scanStepDefinitions, type FeatureDiagnostic, type StaticDefinition } from './diagnostics.js';
