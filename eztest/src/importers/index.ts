/**
 * The Migration Factory: import tests from Gherkin, Playwright Test, Selenium
 * (Java/C#/Python), manual test cases (CSV/XLSX) and Dynamics 365 Task
 * Recorder recordings into EZTest journeys, with an honest TODO list and
 * replay verification. Deterministic: no AI is involved. Further source
 * formats come from importer plugins (docs/plugins.md); the building blocks
 * they need (JourneyDraft, the Gherkin importer and its hooks, report
 * assembly) are exported here.
 */
export type {
  ImportKind, BuiltinImportKind, ImportReport, ImportCoverage, ConvertedJourney, TodoItem, ImporterOptions, SourceDiagnostic, ImporterPlugin, ImporterContext,
} from './types.js';
export { BUILTIN_IMPORT_KINDS, emptyCoverage, addCoverage } from './types.js';
export { JourneyDraft, oneLine, tidy, looksLikeLocation, splitPageContext, tabClick, leadingVerb, type SourceRef, type StepCheck, type ConditionCheck } from './builder.js';
export { describeLocator, type TargetHint } from './locators.js';
export { assembleReport, mergeReports } from './report.js';
export {
  importGherkin, parseFeature, tableCells,
  type GherkinImportOptions, type StepHookInput, type ExternalExamples, type ExternalExamplesInput, type GStep, type GScenario, type GExamples,
} from './gherkin.js';
export { loadTypeScript, type Ts } from './typescript.js';
export { importPlaywright, selectorCandidate, globToRegex } from './playwright.js';
export { importSelenium, detectSeleniumLanguage, byCandidate, type SeleniumOptions } from './selenium.js';
export {
  importManualCsv, importManualXlsx, importManualRows, parseCsv, DEFAULT_MANUAL_COLUMNS,
  type ManualOptions, type ManualColumns, type ManualRow,
} from './manual.js';
export { readXlsx, readXlsxTable, cellText, numberText, type ReadXlsxOptions, type XlsxRow, type XlsxTable, type MergePosition } from './xlsx.js';
export { importTaskRecorder, type TaskRecorderOptions } from './task-recorder.js';
export {
  verifyImported, coverageEquivalence, verifiedRunOf,
  type ImportVerification, type VerifiedJourney, type VerifiedStep, type CoverageEquivalence, type JourneyEquivalence, type EquivalenceStatus,
} from './verify.js';
export {
  importFiles, detectImportKind, importerPlugins, importFormats, writeImported, writeImportAssets, importReportMarkdown, type ImportFilesOptions, type WrittenImport,
} from './dispatch.js';
export { importOpenApi, looksLikeOpenApi, type OpenApiImportOptions } from './openapi.js';
export { importPostman, looksLikePostman, postmanVars, type PostmanImportOptions } from './postman.js';
export { detectApiKind } from './api-files.js';
