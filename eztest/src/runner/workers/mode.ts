/**
 * Inline or process workers for a run (RunOptions.workers, EZTEST_WORKERS), and why a run that asked
 * for process workers stays inline.
 */
import type { Logger } from '../../core/index.js';
import type { RunOptions } from '../types.js';
import { planTransfer, type TransferPlan } from './protocol.js';
import { localRegistrations } from './local.js';

export type WorkerModeChoice = { kind: 'inline'; reason?: string } | { kind: 'process'; plan: TransferPlan };

/** The mode asked for: RunOptions.workers, else EZTEST_WORKERS (process | inline), else inline. */
export function requestedWorkerMode(options: Pick<RunOptions, 'workers'>, env: Record<string, string | undefined> = process.env): 'inline' | 'process' {
  if (options.workers) return options.workers;
  const e = env.EZTEST_WORKERS?.trim().toLowerCase();
  return e === 'process' || e === 'inline' ? e : 'inline';
}

export function workerMode(options: RunOptions, _concurrency: number, logger: Logger): WorkerModeChoice {
  if (requestedWorkerMode(options) !== 'process') return { kind: 'inline' };
  const inline = (reason: string): WorkerModeChoice => {
    // A warning when this run asked for them; a note when only EZTEST_WORKERS did (it applies to every run of the process).
    logger[options.workers === 'process' ? 'warn' : 'info'](`process workers not used, journeys run inline: ${reason}`);
    return { kind: 'inline', reason };
  };
  if (options.debug) return inline('the debugger drives the journeys in this process');
  if (options.manual) return inline('manual steps ask for verdicts in this process');
  const plan = planTransfer(options);
  const local = localRegistrations();
  if (local.length && !options.workerSetup) return inline(`${local.join(', ')} registered in this process (a worker would not have it; give RunOptions.workerSetup)`);
  if (plan.blocked.length && !options.workerSetup) {
    return inline(`these run options cannot be rebuilt in a worker process: ${plan.blocked.join(', ')} (give RunOptions.workerSetup, see docs/scale.md)`);
  }
  return { kind: 'process', plan };
}
