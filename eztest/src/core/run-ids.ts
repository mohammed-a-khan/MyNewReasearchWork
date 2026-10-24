/**
 * Run ids. Runs are `run-<stamp>-<hex>`; Studio debug sessions are `debug-<stamp>-<hex>`. A debug session
 * stops, skips and edits steps by hand, so it is shown in Results (with a "debug" badge) but left out of
 * history, triage, readiness, comparisons, flaky scores and trends.
 */
export const DEBUG_RUN_PREFIX = 'debug-';

export function isDebugRunId(id: string | undefined): boolean {
  return typeof id === 'string' && id.startsWith(DEBUG_RUN_PREFIX);
}
