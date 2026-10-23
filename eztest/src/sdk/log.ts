/**
 * `log`: notes in the run log and on the current step. EZTest reports every
 * step automatically, so logging is for extra context only. Secrets are masked.
 */
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
};

export type Log = typeof log;
