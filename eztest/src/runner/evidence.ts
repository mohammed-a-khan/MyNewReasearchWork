/**
 * Serialised access to the EvidenceVault. Journeys run concurrently, but the
 * manifest is a hash chain whose lines must be appended strictly in order, so
 * every write goes through one queue.
 */
import type { EvidenceKind, EvidenceRef, EvidenceVault } from '../core/index.js';

type Meta = { stepId?: string; journeyId?: string; description?: string };

export class EvidenceWriter {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly used = new Set<string>();

  /** `mask`, when given, is applied to every text artifact (secrets never reach the vault). */
  constructor(readonly vault: EvidenceVault, private readonly mask?: (s: string) => string) {}

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * A run-unique relative path: a step that runs more than once (loops,
   * retries, sub-journeys) gets "-2", "-3" ... so earlier artifacts are never
   * overwritten (which would break the hash chain).
   */
  reserve(relPath: string): string {
    let p = relPath;
    for (let n = 2; this.used.has(p); n++) p = relPath.replace(/(\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)?)?$/, (ext) => `-${n}${ext}`);
    this.used.add(p);
    return p;
  }

  store(kind: EvidenceKind, relPath: string, data: string | Uint8Array, meta: Meta = {}): Promise<EvidenceRef> {
    const path = this.reserve(relPath);
    const body = typeof data === 'string' && this.mask ? this.mask(data) : data;
    return this.enqueue(() => this.vault.store(kind, path, body, meta));
  }

  recordFile(kind: EvidenceKind, path: string, meta: Meta = {}): Promise<EvidenceRef> {
    return this.enqueue(() => this.vault.recordFile(kind, path, meta));
  }

  /** Wait for all pending writes; returns the manifest head. */
  async flush(): Promise<string> {
    await this.queue;
    return this.vault.headHash;
  }

  get runDir(): string {
    return this.vault.runDir;
  }
}

/** Safe file-name fragment. */
export function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'x';
}
