/**
 * `--fast`: the run options that remove the tool's own overhead on passing
 * steps while keeping full evidence for failures:
 *  - screenshots on failure only (no screenshot per passing step),
 *  - no lenses (a11y, visual, security scans after every step),
 *  - element fingerprints captured only for steps that have none yet,
 *  - console and network logs kept as evidence only for attempts that did not pass.
 * Reliability features (actionability, re-render safety, diagnosis) stay on:
 * they are what keeps a fast run correct.
 */
import type { RunOptions } from '../types.js';

export function fastRunOptions(): Pick<RunOptions, 'screenshots' | 'lenses' | 'fingerprints' | 'passingLogs'> {
  return { screenshots: 'on-failure', lenses: [], fingerprints: 'missing', passingLogs: false };
}
