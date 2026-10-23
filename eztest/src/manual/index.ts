/**
 * Manual and hybrid test management (docs/manual-testing.md): manual cases
 * as `.ez`, the terminal verdict prompt, suites / cycles / assignments with
 * progress, and conversion of manual cases into automated journeys.
 * Execution lives in the runner (runner/manual.ts).
 */
export * from './cases.js';
export * from './plans.js';
export * from './terminal.js';
export {
  journeyKind, isManualJourney, manualStepCount, manualSummary, ManualRunEnded,
  type JourneyKind, type ManualStepRequest, type ManualVerdict, type ManualVerdictProvider, type ManualVerdictStatus, type ManualAttachment,
} from '../runner/manual.js';
