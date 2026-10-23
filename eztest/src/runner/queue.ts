/**
 * The run's work queue. Workers take journeys in order; with resource locks a
 * worker takes the first pending journey whose lock keys it can acquire, so
 * a journey blocked on a lock never idles a worker while other work is ready.
 * When every pending journey is blocked, workers wait for a local release or
 * poll (locks may be held by another process or machine).
 */
import type { Journey } from '../core/index.js';
import type { RunLocks } from './types.js';

export interface QueueItem {
  index: number;
  journey: Journey;
  /** Release the journey's locks (no-op without locks). */
  release: () => Promise<void>;
  /** Set when the journey's locks could not be acquired in time. */
  lockError?: string;
}

const noop = async () => {};

export class JourneyQueue {
  private readonly pending: number[];
  private readonly waitingSince = new Map<number, number>();
  private wake: Array<() => void> = [];
  private busy: Promise<void> = Promise.resolve();

  constructor(
    private readonly journeys: Journey[],
    private readonly locks?: RunLocks,
    private readonly signal?: AbortSignal,
    /** Only journeys for which this holds may start now (e.g. their `Depends on:` prerequisites are done). */
    private readonly isReady: (index: number) => boolean = () => true,
  ) {
    this.pending = journeys.map((_, i) => i);
  }

  get remaining(): number {
    return this.pending.length;
  }

  /** The next runnable journey, or undefined when the queue is empty. */
  async next(): Promise<QueueItem | undefined> {
    for (;;) {
      if (!this.pending.length) return undefined;
      const item = await this.serial(() => this.pick());
      if (item) return item;
      if (!this.pending.length) return undefined;
      await this.waitForChange();
    }
  }

  /** One worker scans at a time, so two workers never race for the same journey. */
  private async serial<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.busy;
    let done!: () => void;
    this.busy = new Promise<void>((r) => (done = r));
    await prev;
    try {
      return await fn();
    } finally {
      done();
    }
  }

  private async pick(): Promise<QueueItem | undefined> {
    if (!this.locks || this.signal?.aborted) {
      if (!this.pending.length) return undefined;
      const p = this.signal?.aborted ? 0 : this.pending.findIndex((i) => this.isReady(i));
      if (p < 0) return undefined;
      const [index] = this.pending.splice(p, 1);
      return { index, journey: this.journeys[index], release: noop };
    }
    const now = Date.now();
    const timeout = this.locks.timeoutMs ?? 30 * 60_000;
    for (let p = 0; p < this.pending.length; p++) {
      const index = this.pending[p];
      const journey = this.journeys[index];
      if (!this.isReady(index)) continue; // waiting for a prerequisite, not for a lock
      const release = await this.locks.tryAcquire(journey);
      if (release) {
        this.pending.splice(p, 1);
        this.waitingSince.delete(index);
        return {
          index,
          journey,
          release: async () => {
            await release();
            this.notify();
          },
        };
      }
      const since = this.waitingSince.get(index) ?? now;
      this.waitingSince.set(index, since);
      if (now - since >= timeout) {
        this.pending.splice(p, 1);
        const who = (await this.locks.describeHolders?.(journey).catch(() => '')) || 'its lock keys';
        return { index, journey, release: noop, lockError: `Gave up after ${Math.round(timeout / 1000)} s waiting for resource locks: ${who}` };
      }
    }
    return undefined;
  }

  /** Something changed outside the queue (a prerequisite finished): wake waiting workers. */
  changed(): void {
    this.notify();
  }

  private notify(): void {
    const w = this.wake;
    this.wake = [];
    for (const f of w) f();
  }

  private waitForChange(): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(done, this.locks?.pollMs ?? 250);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.wake.push(done);
    });
  }
}

/** Wait for a journey's locks (used by isolated retries, which run one at a time). */
export async function acquireBlocking(locks: RunLocks, journey: Journey): Promise<() => Promise<void>> {
  const deadline = Date.now() + (locks.timeoutMs ?? 30 * 60_000);
  for (;;) {
    const release = await locks.tryAcquire(journey);
    if (release) return release;
    if (Date.now() > deadline) throw new Error(`Gave up waiting for resource locks of ${journey.id}`);
    await new Promise((r) => setTimeout(r, locks.pollMs ?? 250));
  }
}
