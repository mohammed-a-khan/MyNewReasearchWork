/**
 * Power Apps canvas pack: control-name steps through the player frame and
 * the app object model, galleries, Power Fx assertions, Dataverse
 * cross-checks (reusing the D365 add-on), app-version and Dataverse change
 * impact, and an app sharing / control visibility matrix.
 */
export { createPowerAppsSteps, canvasSnapshot, powerAppsLogin, APP_FRAME, POWERAPPS_STEP_NAMES, type PowerAppsStepsOptions, type PowerAppsStepName, type CanvasSnapshot, type CanvasAppRef } from './steps.js';
export { parsePowerFx, evaluatePowerFx, powerFxNames, PowerFxError, type FxValue } from './powerfx.js';
export { createPowerAppsIntentRules, POWERAPPS_INTENT_RULES, parsePowerAppsEzScript } from './intents.js';
export { parseCanvasSource, snapshotCanvasApp, canvasAppChanges, dataverseChangesForApp, powerAppsScoper, type CanvasSource, type CanvasSourceControl } from './impact.js';
export { PowerAppsConfigSchema, parsePowerAppsConfig, createPowerAppsIntegration, type PowerAppsConfig, type PowerAppsConfigInput, type PowerAppsIntegration, type PowerAppsPermissionCheck } from './config.js';
