/**
 * Tests mapped to deployment pipelines (docs/pipelines.md): the `pipelines:`
 * mapping of CI triggers and deployment stages to journey selections, CI
 * stage detection, explanations, tag reports and deployment test records.
 */
export * from './types.js';
export { parseTagExpression, matchesTags, explainTags, tagExpressionToText, TagExpressionError, type TagExpr } from './tags.js';
export { detectCi, detectVersion, type CiContext, type CiSystem, type CiReason } from './detect.js';
export {
  resolvePipeline, planPipeline, pipelineRunSettings, tagsReport, compileTags, PipelineError,
  type PipelineResolution, type PipelinePlan, type JourneyDecision, type PipelineRunSettings, type TagsReport,
} from './plan.js';
export {
  buildDeploymentRecord, checkRequires, deploymentMarkdown, deploymentPassed, reportDeploymentToAdo, writeDeploymentFiles,
  type BuildRecordInput, type ReadinessLike, type AdoDeploymentOptions, type AdoDeploymentReport,
} from './deployment.js';
