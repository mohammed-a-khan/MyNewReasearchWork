/**
 * Inline or process workers for a run (RunOptions.workers, EZTEST_WORKERS), and why a run that asked
 * for process workers stays inline.
 */
import type { Logger } from '../../core/index.js';
import type { RunOptions } from '../types.js';
import { planTransfer, type TransferPlan } from './protocol.js';

export type WorkerModeChoice = { kind: 'inline'; reason?: string } | { kind: 'process'; plan: TransferPlan };

/** The mode asked for: EZTEST_WORKERS (process | inline) wins over RunOptions.workers; default inline. */
export function requestedWorkerMode(options: Pick<RunOptions, 'workers'>, env: Record<string, string | undefined> = process.env): 'inline' | 'process' {
  const e = env.EZTEST_WORKERS?.trim().toLowerCase();
  if (e === 'process' || e === 'inline') return e;
  return options.workers ?? 'inline';
}

export function workerMode(options: RunOptions, _concurrency: number, logger: Logger): WorkerModeChoice {
  if (requestedWorkerMode(options) !== 'process') return { kind: 'inline' };
  const inline = (reason: string): WorkerModeChoice => {
    logger.warn(`process workers not used, journeys run inline: ${reason}`);
    return { kind: 'inline', reason };
  };
  if (options.debug) return inline('the debugger drives the journeys in this process');
  if (options.manual) return inline('manual steps ask for verdicts in this process');
  const plan = planTransfer(options);
  if (plan.blocked.length && !options.workerSetup) {
    return inline(`these run options cannot be rebuilt in a worker process: ${plan.blocked.join(', ')} (give RunOptions.workerSetup, see docs/scale.md)`);
  }
  return { kind: 'process', plan };
}
