/** Operations: structured logs, OTLP trace export, config schema migrations, version. */
export { createJsonLogger, redact, type JsonLogger, type JsonLoggerOptions, type LogLevel } from './log.js';
export { runToOtlp, exportRunTrace, traceIdForRun, otlpTracesUrl, type OtlpSpan } from './otlp.js';
export { upgradeConfigText, upgradeConfigFile, CONFIG_MIGRATIONS, type ConfigMigration, type UpgradeResult } from './config-migrate.js';
export { EZTEST_VERSION, PACKAGE_NAME } from './version.js';
export { startWebServer, splitCommand, type WebServerConfig, type WebServerHandle } from './webserver.js';
