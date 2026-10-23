/**
 * Verified self-healing: a deterministic ladder (T0 cache, T1 fingerprint,
 * T2 semantic) that proposes locators; the runner accepts a heal only when
 * the step's post-conditions hold afterwards.
 */
export { createHealer, resolveHealPolicy, robustCandidates, buildLocatorFor, REJECTED_HEAL_NOTE, type HealerOptions } from './healer.js';
export { HealDecisions, healKey, locatorKey, type HealDecision, type HealDecisionKind, type ReviewTier } from './decisions.js';
export { DEFAULT_HEAL_POLICY, HEAL_TIERS, type HealPolicy, type HealCandidate, type HealContext, type Healer } from './types.js';
export { FingerprintStore, type StepMemory, type CachedHeal } from './store.js';
export { captureFingerprint, scanElements, poolSelector, ROLE_SELECTORS, type ScannedElement } from './fingerprint.js';
export { scoreFingerprint, pickBest, FEATURE_WEIGHTS, type FingerprintScore, type Feature, type Ranked, type PickResult } from './score.js';
export { jaroWinkler, tokenOverlap, textSimilarity, jaccard, tokens } from './similarity.js';
export { collectHealProposals, promoteVerifiedHeals, type HealProposal, type HealProposalFile, type ImprovementProposal } from './proposals.js';
export { planHealRewrite, rewriteStepLine, phrasesFor, unifiedDiff, ezStepLine, sidecarPath, SIDECAR_RE, applyLocatorSidecar, loadLocatorSidecar, type HealRewritePlan, type HealRewriteMethod, type FileChange, type DiffLine, type LocatorSidecar, type PlanInput } from './apply.js';
