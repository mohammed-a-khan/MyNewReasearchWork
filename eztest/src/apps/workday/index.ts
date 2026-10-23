/**
 * Workday pack: data-automation-id driven steps (prompts, date widget,
 * related actions, business process inbox), REST/WQL/SOAP cross-checks,
 * release (tenant preview) impact and a task/data-source role matrix.
 */
export { WorkdayClient, buildWql, wqlString, assertAlias, flattenXml, type WqlField, type WqlRow, type WorkdayClientOptions } from './client.js';
export { createWorkdaySteps, workdayLogin, workdaySearch, dateParts, WORKDAY_STEP_NAMES, type WorkdayStepsOptions, type WorkdayStepName, type WorkdayCredentials } from './steps.js';
export { createWorkdayIntentRules, WORKDAY_INTENT_RULES, parseWorkdayEzScript } from './intents.js';
export { snapshotWorkday, crawlTask, whatsNewChanges, workdayScoper } from './impact.js';
export { WorkdayConfigSchema, parseWorkdayConfig, createWorkdayIntegration, type WorkdayConfig, type WorkdayConfigInput, type WorkdayIntegration, type WorkdayPermissionCheck } from './config.js';
