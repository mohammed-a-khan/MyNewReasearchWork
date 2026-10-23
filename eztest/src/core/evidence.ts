/**
 * Evidence Vault: every artifact a run produces is hashed and appended to a
 * hash-chained manifest. Changing, removing or reordering any artifact breaks
 * the chain, so an evidence pack can be verified long after the run.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, isAbsolute, resolve } from 'node:path';
import type { EvidenceKind, EvidenceRef } from './results.js';

export interface ManifestEntry extends EvidenceRef {
  seq: number;
  prevHash: string;
  entryHash: string;
}

const GENESIS = '0'.repeat(64);

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function entryHashOf(e: Omit<ManifestEntry, 'entryHash'>): string {
  const canonical = JSON.stringify([
    e.seq,
    e.prevHash,
    e.id,
    e.kind,
    e.path,
    e.sha256,
    e.stepId ?? null,
    e.journeyId ?? null,
    e.description ?? null,
    e.createdAt,
  ]);
  return sha256(canonical);
}

export class EvidenceVault {
  private seq = 0;
  private head = GENESIS;
  private counter = 0;
  readonly entries: ManifestEntry[] = [];
  readonly manifestPath: string;

  constructor(readonly runDir: string) {
    this.manifestPath = join(runDir, 'evidence-manifest.jsonl');
  }

  async init(): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
    if (!existsSync(this.manifestPath)) await writeFile(this.manifestPath, '');
  }

  /**
   * Open an existing run's vault to append to its chain (e.g. a later sign-off note).
   * The manifest must verify first, so nothing is appended to a broken chain.
   */
  static async resume(runDir: string): Promise<EvidenceVault> {
    const v = new EvidenceVault(runDir);
    const check = await verifyEvidence(runDir);
    if (!check.ok) throw new Error(`Evidence chain of ${runDir} does not verify: ${check.problems.slice(0, 3).join('; ')}`);
    const lines = (await readFile(v.manifestPath, 'utf8')).split('\n').filter((l) => l.trim());
    for (const l of lines) {
      const e = JSON.parse(l) as ManifestEntry;
      v.entries.push(e);
      v.seq = e.seq;
      v.head = e.entryHash;
      const n = /^E-(\d+)$/.exec(e.id);
      if (n) v.counter = Math.max(v.counter, Number(n[1]));
    }
    return v;
  }

  get headHash(): string {
    return this.head;
  }

  nextId(): string {
    this.counter += 1;
    return `E-${this.counter}`;
  }

  /** Write bytes into the run directory and record them. */
  async store(
    kind: EvidenceKind,
    relPath: string,
    data: string | Uint8Array,
    meta: { stepId?: string; journeyId?: string; description?: string } = {},
  ): Promise<EvidenceRef> {
    const safe = this.safeRelative(relPath);
    const abs = join(this.runDir, safe);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, data);
    return this.record(kind, safe, typeof data === 'string' ? Buffer.from(data) : data, meta);
  }

  /** Record a file that something else (e.g. the browser driver) already wrote inside the run directory. */
  async recordFile(
    kind: EvidenceKind,
    absOrRelPath: string,
    meta: { stepId?: string; journeyId?: string; description?: string } = {},
  ): Promise<EvidenceRef> {
    const abs = isAbsolute(absOrRelPath) ? absOrRelPath : join(this.runDir, absOrRelPath);
    const rel = this.safeRelative(relative(this.runDir, abs));
    const bytes = await readFile(abs);
    return this.record(kind, rel, bytes, meta);
  }

  private safeRelative(p: string): string {
    const abs = resolve(this.runDir, p);
    const rel = relative(this.runDir, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Evidence path escapes the run directory: ${p}`);
    }
    return rel.split('\\').join('/');
  }

  private async record(
    kind: EvidenceKind,
    rel: string,
    bytes: Uint8Array,
    meta: { stepId?: string; journeyId?: string; description?: string },
  ): Promise<EvidenceRef> {
    const base: Omit<ManifestEntry, 'entryHash'> = {
      seq: ++this.seq,
      prevHash: this.head,
      id: this.nextId(),
      kind,
      path: rel,
      sha256: sha256(bytes),
      stepId: meta.stepId,
      journeyId: meta.journeyId,
      description: meta.description,
      createdAt: new Date().toISOString(),
    };
    const entry: ManifestEntry = { ...base, entryHash: entryHashOf(base) };
    this.head = entry.entryHash;
    this.entries.push(entry);
    await appendFile(this.manifestPath, JSON.stringify(entry) + '\n');
    const { seq: _s, prevHash: _p, entryHash: _e, ...ref } = entry;
    return ref;
  }
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  head: string;
  problems: string[];
}

/** Re-hash every artifact and walk the chain. Any tampering is reported. */
export async function verifyEvidence(runDir: string): Promise<VerifyResult> {
  const manifestPath = join(runDir, 'evidence-manifest.jsonl');
  const problems: string[] = [];
  if (!existsSync(manifestPath)) {
    return { ok: false, entries: 0, head: GENESIS, problems: ['evidence-manifest.jsonl not found'] };
  }
  const lines = (await readFile(manifestPath, 'utf8')).split('\n').filter((l) => l.trim());
  let prev = GENESIS;
  let seq = 0;
  for (const line of lines) {
    let e: ManifestEntry;
    try {
      e = JSON.parse(line) as ManifestEntry;
    } catch {
      problems.push(`unparseable manifest line ${seq + 1}`);
      break;
    }
    seq += 1;
    if (e.seq !== seq) problems.push(`entry ${e.id}: sequence ${e.seq}, expected ${seq}`);
    if (e.prevHash !== prev) problems.push(`entry ${e.id}: chain broken (prevHash mismatch)`);
    const { entryHash, ...rest } = e;
    if (entryHashOf(rest) !== entryHash) problems.push(`entry ${e.id}: entry hash mismatch (metadata altered)`);
    const abs = join(runDir, e.path);
    if (!existsSync(abs)) problems.push(`entry ${e.id}: file missing ${e.path}`);
    else if (sha256(await readFile(abs)) !== e.sha256) problems.push(`entry ${e.id}: file content altered ${e.path}`);
    prev = entryHash;
  }
  return { ok: problems.length === 0, entries: seq, head: prev, problems };
}
