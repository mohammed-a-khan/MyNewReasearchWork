/**
 * `log`: notes in the run log and on the current step. EZTest reports every
 * step automatically, so logging is for extra context only. Secrets are masked.
 */
import { callSite } from './callsite.js';
import { currentHost } from './runtime.js';

type Data = Record<string, unknown>;

export const log = {
  debug(message: string, data?: Data): void {
    currentHost('log').log('debug', message, data);
  },
  info(message: string, data?: Data): void {
    currentHost('log').log('info', message, data);
  },
  warn(message: string, data?: Data): void {
    currentHost('log').log('warn', message, data);
  },
  error(message: string, data?: Data): void {
    currentHost('log').log('error', message, data);
  },
  /** A passed check of its own in the report (for a verification done in plain code): `log.pass('the invoice total matches')`. */
  async pass(message: string, data?: Data): Promise<void> {
    await currentHost('log').record(message, async (rec) => {
      if (data) for (const [k, v] of Object.entries(data)) rec.capture(k, v);
    }, { kind: 'assert', ...(callSite() ? { source: callSite()! } : {}) });
  },
};

export type Log = typeof log;
