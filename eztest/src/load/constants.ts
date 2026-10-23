/** File names and identifiers of EZTest Load results (kept dependency-free: readiness imports them). */
import { slugify } from '../core/util.js';

export const RESULTS_FORMAT = 'eztest-load-results';
export const LOAD_RESULTS_FILE = 'load-results.json';
export const LOAD_REPORT_FILE = 'report.html';

/** The journey id a load run is recorded under in run.json. */
export function loadJourneyId(r: { scenario: { name: string } }): string {
  return `load-${slugify(r.scenario.name) || 'scenario'}`;
}
