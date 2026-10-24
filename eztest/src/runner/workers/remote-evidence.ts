/**
 * Evidence from a process worker. The worker writes each artifact into the run directory itself
 * (bytes never cross the IPC channel) and asks the run to record it: the run hashes the file and
 * appends it to the one hash-chained manifest, so the chain stays a single ordered sequence
 * whatever the number of workers.
 *
 * Paths are reserved with an exclusive create (O_EXCL), so two workers can never pick the same
 * file: a retry of a journey on another worker gets "-2", "-3" ... like a repeat in one process.
 */
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { EvidenceKind, EvidenceRef, EvidenceVault } from '../../core/index.js';
import { EvidenceWriter } from '../evidence.js';

type Meta = { stepId?: string; journeyId?: string; description?: string };

export type RecordFn = (kind: EvidenceKind, relPath: string, meta: Meta) => Promise<EvidenceRef>;

export class RemoteEvidenceWriter extends EvidenceWriter {
  private pending = new Set<Promise<unknown>>();
  private readonly mine = new Set<string>();
  private readonly mirror: { entries: EvidenceRef[]; runDir: string; headHash: string };

  constructor(private readonly dir: string, private readonly recordRemote: RecordFn, private readonly maskText?: (s: string) => string) {
    const mirror = { entries: [] as EvidenceRef[], runDir: dir, headHash: '' };
    super(mirror as unknown as EvidenceVault, maskText);
    this.mirror = mirror;
  }

  private safeRelative(p: string): string {
    const rel = relative(this.dir, resolve(this.dir, p));
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Evidence path escapes the run directory: ${p}`);
    return rel.split('\\').join('/');
  }

  /** A run-unique path, claimed on disk so no other worker takes it. */
  override reserve(relPath: string): string {
    for (let n = 1; ; n++) {
      const p = this.safeRelative(n === 1 ? relPath : relPath.replace(/(\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)?)?$/, (ext) => `-${n}${ext}`));
      if (this.mine.has(p)) continue;
      const abs = join(this.dir, p);
      try {
        mkdirSync(dirname(abs), { recursive: true });
        closeSync(openSync(abs, 'wx'));
        this.mine.add(p);
        return p;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p)).catch(() => undefined);
    return p;
  }

  override store(kind: EvidenceKind, relPath: string, data: string | Uint8Array, meta: Meta = {}): Promise<EvidenceRef> {
    const path = this.reserve(relPath);
    const body = typeof data === 'string' && this.maskText ? this.maskText(data) : data;
    return this.track((async () => {
      const abs = join(this.dir, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, body);
      const ref = await this.recordRemote(kind, path, meta);
      this.mirror.entries.push(ref);
      return ref;
    })());
  }

  override recordFile(kind: EvidenceKind, path: string, meta: Meta = {}): Promise<EvidenceRef> {
    const rel = this.safeRelative(isAbsolute(path) ? relative(this.dir, path) : path);
    return this.track((async () => {
      const ref = await this.recordRemote(kind, rel, meta);
      this.mirror.entries.push(ref);
      return ref;
    })());
  }

  override async flush(): Promise<string> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    return '';
  }
}
