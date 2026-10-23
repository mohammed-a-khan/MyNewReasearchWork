/**
 * The Studio's manual verdict provider: a manual step of a running journey
 * becomes a pending request, published on the `manual` topic, until the
 * guided runner (#/manual/run/<runId>) answers it with a verdict. The run
 * (browser and all, for hybrid journeys) waits meanwhile. Ending a manual run
 * releases every pending request of it; the remaining manual steps are
 * recorded as not executed.
 */
import { randomBytes } from 'node:crypto';
import { ManualRunEnded, type ManualStepRequest, type ManualVerdict, type ManualVerdictProvider } from '../runner/manual.js';
import type { EventHub } from './events.js';

export interface PendingManual {
  /** Opaque id the guided runner answers with. */
  key: string;
  request: ManualStepRequest;
  since: string;
}

interface Waiter extends PendingManual {
  resolve(v: ManualVerdict): void;
  reject(e: Error): void;
}

export class ManualHub implements ManualVerdictProvider {
  private readonly waiting = new Map<string, Waiter>();
  private readonly ended = new Set<string>();
  /** Verdicts given in this Studio session, per run (for the runner's step list). */
  private readonly answered = new Map<string, Array<{ journeyId: string; stepId: string; status: string; tester?: string; at: string }>>();

  constructor(private readonly hub?: EventHub) {
    hub?.registerTopic('manual', { replay: 200, description: 'Manual steps waiting for a verdict, and verdicts given' });
  }

  verdict(request: ManualStepRequest, signal?: AbortSignal): Promise<ManualVerdict> {
    if (this.ended.has(request.runId)) return Promise.reject(new ManualRunEnded());
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('run cancelled'), { name: 'CancelledError' }));
    const key = randomBytes(12).toString('hex');
    return new Promise<ManualVerdict>((resolve, reject) => {
      const onAbort = () => {
        this.waiting.delete(key);
        this.hub?.publish('manual', { type: 'released', key, runId: request.runId, reason: 'cancelled' });
        reject(Object.assign(new Error('run cancelled'), { name: 'CancelledError' }));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const w: Waiter = {
        key, request, since: new Date().toISOString(),
        resolve: (v) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(v);
        },
        reject: (e) => {
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        },
      };
      this.waiting.set(key, w);
      this.hub?.publish('manual', { type: 'waiting', key, runId: request.runId, journeyId: request.journeyId, stepId: request.stepId, request });
    });
  }

  /** Pending requests (of one run, or all), oldest first. */
  pending(runId?: string): PendingManual[] {
    return [...this.waiting.values()].filter((w) => !runId || w.request.runId === runId).map(({ key, request, since }) => ({ key, request, since }));
  }

  get(key: string): PendingManual | undefined {
    const w = this.waiting.get(key);
    return w ? { key: w.key, request: w.request, since: w.since } : undefined;
  }

  /** Answer a pending request. Returns false when it is no longer pending (answered elsewhere, run ended). */
  answer(key: string, v: ManualVerdict): boolean {
    const w = this.waiting.get(key);
    if (!w) return false;
    this.waiting.delete(key);
    const at = new Date().toISOString();
    const list = this.answered.get(w.request.runId) ?? [];
    list.push({ journeyId: w.request.journeyId, stepId: w.request.stepId, status: v.status, ...(v.tester ? { tester: v.tester } : {}), at });
    this.answered.set(w.request.runId, list);
    if (this.answered.size > 50) this.answered.delete(this.answered.keys().next().value as string);
    this.hub?.publish('manual', { type: 'answered', key, runId: w.request.runId, journeyId: w.request.journeyId, stepId: w.request.stepId, status: v.status });
    w.resolve(v);
    return true;
  }

  answers(runId: string) {
    return this.answered.get(runId) ?? [];
  }

  /** End a manual run: pending and later manual steps of it are not executed. */
  end(runId: string): number {
    this.ended.add(runId);
    let n = 0;
    for (const w of [...this.waiting.values()]) {
      if (w.request.runId !== runId) continue;
      this.waiting.delete(w.key);
      w.reject(new ManualRunEnded());
      n++;
    }
    this.hub?.publish('manual', { type: 'ended', runId, released: n });
    return n;
  }

  close(): void {
    for (const w of this.waiting.values()) w.reject(new ManualRunEnded('Studio closed'));
    this.waiting.clear();
  }
}
