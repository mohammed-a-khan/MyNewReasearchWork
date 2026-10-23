/**
 * Journeys as production monitors: schedule, production-safety guard,
 * flap-guarded alerts on state change, persisted state and a status page.
 */
export { runMonitor, type MonitorOptions, type MonitorEvent } from './monitor.js';
export { assertMonitorSafe, findWriteSteps, isMonitorTagged, MONITOR_SAFE_TAGS, type MonitorSafetyOptions, type WriteFinding } from './guard.js';
export { buildAlert, deliverAlert, sendWebhook, validateChannels, type AlertChannel, type MonitorAlert } from './alerts.js';
export {
  applyResult,
  emptyMonitorState,
  loadMonitorState,
  saveMonitorState,
  percentile,
  type MonitorState,
  type MonitorHealth,
  type JourneyMonitorState,
  type AlertRecord,
} from './state.js';
export { summarizeMonitorState, renderStatusPage, type MonitorSummary, type MonitorSummaryJourney } from './status-page.js';
