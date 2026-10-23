/**
 * Record a journey by using the app: user actions in a real browser become
 * plain-English steps with robust targets, URL post-conditions and
 * Alt+Click expectations, ready to replay and heal.
 */
export { startRecording, recordJourney, Recorder, type RecorderOptions } from './recorder.js';
export { verifyRecording, type VerificationReport, type VerifiedStep, type VerifyOptions } from './verify.js';
export { JourneyComposer, diffJourneys, type RecordingResult, type ComposerEvent, type ComposerOptions, type FramedPageEvent } from './compose.js';
export { buildTarget, kindOf, phrase, type RecordedTarget } from './target.js';
export { inspectElement, describeElement } from './inspect.js';
export { pageScript, type ElementInfo, type ElementCounts, type PageEvent } from './page-script.js';
