/**
 * Cancelling a run from the outside (Ctrl+C, a CI job timeout, a closed
 * terminal): SIGINT, SIGTERM and SIGHUP.
 *
 * The first signal aborts the run's AbortSignal: journeys not started are
 * recorded as cancelled, running ones stop at their next step boundary, the
 * browsers are closed and their temporary profiles and download folders
 * removed, and `run.json` is written with `cancelled` set. The process then
 * exits with 128 + the signal number (130 for SIGINT, 143 for SIGTERM, 129
 * for SIGHUP).
 *
 * When the run does not wind down within the grace period (default 15 s,
 * EZTEST_CANCEL_GRACE_MS), or on a second signal, the partial run is written
 * as it stands (see {@link registerPartialRunWriter}), the browsers are
 * killed, the temporary directories removed, and the process exits at once.
 */
import { cleanupBrowsersNow } from '../browser/launcher/launch.js';

export type CancelSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';
const SIGNALS: CancelSignal[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const NUMBER: Record<CancelSignal, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

/** The exit code of a run ended by a signal: 128 + its number. */
export function cancelExitCode(sig: CancelSignal): number {
  return 128 + NUMBER[sig];
}

/** Why a run was cancelled (the AbortSignal's reason). */
export class RunCancelledError extends Error {
  constructor(readonly signal: CancelSignal | 'max-failures' | string) {
    super(`Run cancelled (${signal})`);
    this.name = 'CancelledError';
  }
}

/** Writers of a partial run.json, used when a cancelled run cannot finish by itself. */
const partialWriters = new Set<() => void>();

/** Runner hook: `write` stores the run as it stands now (synchronously). Returns the unregister function. */
export function registerPartialRunWriter(write: () => void): () => void {
  partialWriters.add(write);
  return () => partialWriters.delete(write);
}

function writePartialRuns(): void {
  for (const w of [...partialWriters]) {
    try {
      w();
    } catch (e) {
      process.stderr.write(`could not write the partial run: ${(e as Error).message}\n`);
    }
  }
}

export interface RunCancellation {
  readonly signal: AbortSignal;
  /** The signal that cancelled the run, once one arrived. */
  readonly cancelledBy: CancelSignal | undefined;
  /** Exit code for the cancel (130 / 143 / 129), or undefined when not cancelled. */
  readonly exitCode: number | undefined;
  /** Remove the signal handlers (call when the run is over). */
  dispose(): void;
}

export interface RunCancellationOptions {
  /** Abort this controller (default: a new one). */
  controller?: AbortController;
  /** How long the run may take to wind down after the first signal. Default EZTEST_CANCEL_GRACE_MS or 15000. */
  graceMs?: number;
  /** Progress lines ("cancelling ..."). */
  log?: (line: string) => void;
  /** Exit the process (tests). Default process.exit. */
  exit?: (code: number) => void;
}

/** Install SIGINT / SIGTERM / SIGHUP handlers that cancel a run as described above. */
export function installRunCancellation(o: RunCancellationOptions = {}): RunCancellation {
  const controller = o.controller ?? new AbortController();
  const envGrace = Number(process.env.EZTEST_CANCEL_GRACE_MS);
  const graceMs = o.graceMs ?? (Number.isFinite(envGrace) && envGrace > 0 ? envGrace : 15_000);
  const exit = o.exit ?? ((code: number) => process.exit(code));
  let cancelledBy: CancelSignal | undefined;
  let timer: NodeJS.Timeout | undefined;
  const force = (sig: CancelSignal) => {
    o.log?.(`${sig}: stopping now; writing the partial results and removing temporary files`);
    writePartialRuns();
    cleanupBrowsersNow();
    exit(cancelExitCode(sig));
  };
  const handlers = new Map<CancelSignal, () => void>();
  for (const sig of SIGNALS) {
    if (process.platform === 'win32' && sig !== 'SIGINT') continue;
    const h = () => {
      if (cancelledBy) return force(sig);
      cancelledBy = sig;
      o.log?.(`${sig}: cancelling the run (journeys not started are skipped; send it again to stop at once)`);
      controller.abort(new RunCancelledError(sig));
      timer = setTimeout(() => force(sig), graceMs);
      timer.unref();
    };
    handlers.set(sig, h);
    process.on(sig, h);
  }
  return {
    signal: controller.signal,
    get cancelledBy() {
      return cancelledBy;
    },
    get exitCode() {
      return cancelledBy ? cancelExitCode(cancelledBy) : undefined;
    },
    dispose() {
      if (timer) clearTimeout(timer);
      for (const [sig, h] of handlers) process.removeListener(sig, h);
      handlers.clear();
    },
  };
}
