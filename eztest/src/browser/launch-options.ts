/** Checks and mappings of launch options shared by the Chromium and Firefox browser types. */
import type { SignalHandling } from './launcher/launch.js';
import type { LaunchOptions } from './types.js';

/**
 * Reject launch options the driver does not implement, with what to use instead, so they never
 * pass silently: `logger` (the driver log is EZTEST_DEBUG) and `tracesDir` (traces are written
 * where `tracing.stop({ path })` says).
 */
export function checkLaunchOptions(options: LaunchOptions, api: string): void {
  if (options.logger !== undefined) {
    throw new Error(`${api}: the "logger" option is not supported; set EZTEST_DEBUG=browser,protocol (or *) to get the driver log on stderr`);
  }
  if (options.tracesDir !== undefined) {
    throw new Error(`${api}: the "tracesDir" option is not supported; a trace is written to the path given to context.tracing.stop({ path })`);
  }
}

/** handleSIGINT / handleSIGTERM / handleSIGHUP (each default true). */
export function signalHandlingOf(options: LaunchOptions): SignalHandling {
  return { SIGINT: options.handleSIGINT ?? true, SIGTERM: options.handleSIGTERM ?? true, SIGHUP: options.handleSIGHUP ?? true };
}
