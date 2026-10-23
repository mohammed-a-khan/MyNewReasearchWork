/**
 * Shared element repository (`eztest/elements`): named elements defined once
 * in `elements/*.yaml` (or read from SDK TypeScript screens),
 * bound into journeys, healed once for every journey. See docs/elements.md.
 */
export { ElementRepository, parseElementFile, elementFromEntry, locatorFromString, normalizeDescription, screenId, type RepoElement, type RepositoryProblem, type LoadRepositoryOptions } from './repository.js';
export { bindTarget, bindStep, bindJourney, elementUsages, duplicateElements, type ElementUsage, type DuplicateGroup } from './bind.js';
export { planElementHeal, elementHealFile, locatorToString, type ElementHealPlan, type ElementPlanInput } from './heal.js';
export { readScreenModule } from './screens.js';
export { renderElementFile } from './render.js';
