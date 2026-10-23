/**
 * The fingerprint store: per `journeyId/stepId`, the fingerprint of the
 * element the step last acted on successfully, the last good locator, and the
 * last verified heal (the T0 cache). Persisted as JSON; writes are serialised
 * and atomic (write temp file, then rename).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ElementFingerprint, HealTier, LocatorCandidate } from '../core/index.js';

/** Journey id under which repository elements are kept: `@elements/<element id>`. */
export const ELEMENTS_JOURNEY = '@elements';

export interface CachedHeal {
  locator: LocatorCandidate;
  original: LocatorCandidate[];
  tier: HealTier;
  confidence: number;
  verifiedAt: string;
  runId?: string;
}

export interface StepMemory {
  fingerprint?: ElementFingerprint;
  lastGood?: LocatorCandidate;
  healed?: CachedHeal;
  updatedAt: string;
}

interface StoreFile {
  version: 1;
  steps: Record<string, StepMemory>;
}

export class FingerprintStore {
  private data: StoreFile = { version: 1, steps: {} };
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  private constructor(readonly path: string) {}

  /** Open (or start) a store at `path`. A corrupt file is an error, not silently reset. */
  static async open(path: string): Promise<FingerprintStore> {
    const s = new FingerprintStore(path);
    if (existsSync(path)) {
      const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<StoreFile>;
      if (raw.version !== 1 || typeof raw.steps !== 'object' || raw.steps === null) {
        throw new Error(`Fingerprint store ${path} has an unknown format`);
      }
      s.data = { version: 1, steps: raw.steps };
    }
    return s;
  }

  static key(journeyId: string, stepId: string): string {
    return `${journeyId}/${stepId}`;
  }

  get(journeyId: string, stepId: string): StepMemory | undefined {
    return this.data.steps[FingerprintStore.key(journeyId, stepId)];
  }

  /** Record that a step passed using `locator` on an element with `fingerprint`. */
  recordSuccess(journeyId: string, stepId: string, fingerprint: ElementFingerprint | undefined, locator: LocatorCandidate | undefined): void {
    const k = FingerprintStore.key(journeyId, stepId);
    const prev = this.data.steps[k];
    this.data.steps[k] = {
      ...prev,
      ...(fingerprint ? { fingerprint } : {}),
      ...(locator ? { lastGood: locator } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.dirty = true;
  }

  /** Promote a verified heal into the T0 cache. */
  recordHeal(journeyId: string, stepId: string, heal: CachedHeal): void {
    const k = FingerprintStore.key(journeyId, stepId);
    this.data.steps[k] = { ...this.data.steps[k], healed: heal, updatedAt: new Date().toISOString() };
    this.dirty = true;
  }

  /**
   * Forget the T0 cached heal of a step (a reviewer rejected it, or accepted it into the
   * journey file so it is no longer a heal). Returns whether one was cached.
   */
  clearHeal(journeyId: string, stepId: string): boolean {
    const k = FingerprintStore.key(journeyId, stepId);
    const prev = this.data.steps[k];
    if (!prev?.healed) return false;
    const { healed: _h, ...rest } = prev;
    this.data.steps[k] = { ...rest, updatedAt: new Date().toISOString() };
    this.dirty = true;
    return true;
  }

  /** Replace the last good locator of a step (e.g. after a reviewed heal was written into the journey). */
  setLastGood(journeyId: string, stepId: string, locator: LocatorCandidate | undefined): void {
    const k = FingerprintStore.key(journeyId, stepId);
    const prev = this.data.steps[k] ?? { updatedAt: '' };
    const { lastGood: _l, ...rest } = prev;
    this.data.steps[k] = { ...rest, ...(locator ? { lastGood: locator } : {}), updatedAt: new Date().toISOString() };
    this.dirty = true;
  }

  /** All entries (read-only view), keyed `journeyId/stepId`. */
  entries(): Readonly<Record<string, StepMemory>> {
    return this.data.steps;
  }

  /** Persist if anything changed. Concurrent calls are serialised. */
  save(): Promise<void> {
    this.writing = this.writing.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      await mkdir(dirname(this.path), { recursive: true });
      // Parallel runs (shards, other processes) share this file: keep their newer entries instead of overwriting them.
      if (existsSync(this.path)) {
        try {
          const disk = JSON.parse(await readFile(this.path, 'utf8')) as Partial<StoreFile>;
          for (const [k, v] of Object.entries(disk.steps ?? {})) {
            const mine = this.data.steps[k];
            if (!mine || (v?.updatedAt ?? '') > (mine.updatedAt ?? '')) this.data.steps[k] = v;
          }
        } catch {
          // being replaced right now: our copy is written as is
        }
      }
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data, null, 2));
      await rename(tmp, this.path);
    });
    return this.writing;
  }
}
