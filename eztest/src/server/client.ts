/**
 * Client for the results server, used by `eztest run --publish`,
 * `eztest publish`, shared-state sync, server-backed locks and
 * history/duration lookups. Plain fetch; the token is sent only as a bearer
 * header and never logged.
 */
import { existsSync, createReadStream, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { RunResult } from '../core/index.js';
import type { RunHistoryEntry } from '../insights/index.js';
import type { CanReleaseResult, PublishedContract, ReleaseRecord, VerificationRecord } from '../contracts/release.js';
import type { DurationTable } from '../scale/durations.js';
import type { LockBackend, LockHandle } from '../scale/locks.js';

export interface ResultsClientOptions {
  url: string;
  token?: string;
  project: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class ServerRequestError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) {
    super(message);
  }
}

export const OPTIONAL_REPORTS = ['report.html', 'report.json', 'junit.xml', 'selection.json'];

export class ResultsClient {
  readonly base: string;
  private readonly f: typeof fetch;

  constructor(readonly o: ResultsClientOptions) {
    this.base = o.url.replace(/\/+$/, '');
    this.f = o.fetch ?? fetch;
  }

  get project(): string {
    return this.o.project;
  }

  private async req<T>(method: string, path: string, body?: unknown, raw?: { stream: Readable | Buffer; length?: number; type?: string }): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.o.token) headers.authorization = `Bearer ${this.o.token}`;
    let payload: BodyInit | undefined;
    if (raw) {
      headers['content-type'] = raw.type ?? 'application/octet-stream';
      if (raw.length !== undefined) headers['content-length'] = String(raw.length);
      payload = (Buffer.isBuffer(raw.stream) ? raw.stream : (Readable.toWeb(raw.stream) as unknown as BodyInit)) as BodyInit;
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const init: RequestInit & { duplex?: 'half' } = { method, headers, body: payload, signal: AbortSignal.timeout(raw ? Math.max(this.o.timeoutMs ?? 15_000, 600_000) : (this.o.timeoutMs ?? 15_000)) };
    if (raw && !Buffer.isBuffer(raw.stream)) init.duplex = 'half';
    let r: Response;
    try {
      r = await this.f(`${this.base}${path}`, init);
    } catch (e) {
      throw new ServerRequestError(0, `Results server ${this.base} unreachable: ${(e as Error).message}`);
    }
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // not JSON (CSV, HTML)
    }
    if (!r.ok && !(r.status === 409 && path.includes('/locks/'))) {
      const msg = (parsed as { error?: string } | undefined)?.error ?? `HTTP ${r.status}`;
      throw new ServerRequestError(r.status, `${method} ${path}: ${msg}`, parsed);
    }
    return parsed as T;
  }

  private p(path = ''): string {
    return `/api/projects/${encodeURIComponent(this.o.project)}${path}`;
  }

  health(): Promise<{ status: string }> {
    return this.req('GET', '/healthz');
  }

  me(): Promise<{ id: string; grants: Array<{ project: string; role: string }> }> {
    return this.req('GET', '/api/me');
  }

  /** Publish a run directory: register it, upload every evidence file and the reports, then let the server verify the chain. */
  async publishRun(runDir: string, o: { analysis?: Record<string, unknown>; meta?: Record<string, unknown>; concurrency?: number } = {}): Promise<{ runId: string; uploaded: number; bytes: number; verified: boolean; problems: string[] }> {
    const run = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as RunResult;
    const manifestPath = join(runDir, 'evidence-manifest.jsonl');
    const manifest = existsSync(manifestPath) ? await readFile(manifestPath, 'utf8') : '';
    const start = await this.req<{ runId: string; needed: Array<{ path: string }>; optional: string[] }>('POST', this.p('/runs'), { run, manifest, analysis: o.analysis, meta: o.meta });
    const files = [...start.needed.map((n) => n.path), ...start.optional.filter((f) => existsSync(join(runDir, f)))];
    let bytes = 0;
    let i = 0;
    const worker = async () => {
      while (i < files.length) {
        const rel = files[i++];
        const abs = join(runDir, rel);
        if (!existsSync(abs)) throw new ServerRequestError(0, `${rel} is in the evidence manifest but missing from ${runDir}`);
        const size = statSync(abs).size;
        bytes += size;
        await this.req('PUT', this.p(`/runs/${encodeURIComponent(run.runId)}/files?path=${encodeURIComponent(rel)}`), undefined, { stream: size < 1_000_000 ? await readFile(abs) : createReadStream(abs), length: size });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 4, files.length || 1)) }, worker));
    const done = await this.req<{ verified: boolean; problems: string[] }>('POST', this.p(`/runs/${encodeURIComponent(run.runId)}/complete`), {});
    return { runId: run.runId, uploaded: files.length, bytes, verified: done.verified, problems: done.problems };
  }

  getState<T = Record<string, unknown>>(kind: string): Promise<{ data: T; updatedAt?: string; updatedBy?: string }> {
    return this.req('GET', this.p(`/state/${kind}`));
  }

  changeState<T = Record<string, unknown>>(kind: string, change: { upsert?: unknown[]; remove?: string[] }): Promise<{ data: T; changes: number }> {
    return this.req('POST', this.p(`/state/${kind}`), change);
  }

  async history(): Promise<RunHistoryEntry[]> {
    return (await this.req<{ runs: RunHistoryEntry[] }>('GET', this.p('/history'))).runs;
  }

  durations(window = 10): Promise<DurationTable> {
    return this.req('GET', this.p(`/durations?window=${window}`));
  }

  signReadiness(runId: string, note = ''): Promise<unknown> {
    return this.req('POST', this.p(`/runs/${encodeURIComponent(runId)}/sign`), { note });
  }

  async uploadPack(runId: string, zipFile: string): Promise<{ bytes: number; sha256: string }> {
    return this.req('PUT', this.p(`/runs/${encodeURIComponent(runId)}/pack`), undefined, { stream: createReadStream(zipFile), length: statSync(zipFile).size, type: 'application/zip' });
  }

  // ---------------------------------------------------------------- EZTest contracts

  publishContract(contract: Record<string, unknown>, version: string, branch?: string): Promise<PublishedContract & { created: boolean }> {
    return this.req('POST', this.p('/contracts'), { contract, version, ...(branch ? { branch } : {}) });
  }

  contracts(q: { provider?: string; consumer?: string; branch?: string; environment?: string; contracts?: 'false' } = {}): Promise<PublishedContract[]> {
    const qs = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));
    return this.req('GET', this.p(`/contracts${qs.toString() ? `?${qs}` : ''}`));
  }

  recordVerification(v: { provider: string; providerVersion: string; hash: string; consumerVersion?: string; branch?: string; passed: boolean; failed?: string[] }): Promise<VerificationRecord> {
    return this.req('POST', this.p('/verifications'), v);
  }

  verifications(q: { provider?: string; providerVersion?: string } = {}): Promise<VerificationRecord[]> {
    const qs = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));
    return this.req('GET', this.p(`/verifications${qs.toString() ? `?${qs}` : ''}`));
  }

  recordRelease(r: { app: string; version: string; environment: string }): Promise<ReleaseRecord> {
    return this.req('POST', this.p('/releases'), r);
  }

  releases(): Promise<ReleaseRecord[]> {
    return this.req('GET', this.p('/releases'));
  }

  canRelease(q: { app: string; version: string; environment: string }): Promise<CanReleaseResult> {
    return this.req('GET', this.p(`/can-release?${new URLSearchParams(q)}`));
  }

  acquireLock(key: string, owner: string, ttlMs: number): Promise<{ acquired: boolean; token?: string; holder?: string; expiresAt: number }> {
    return this.req('POST', this.p('/locks/acquire'), { key, owner, ttlMs });
  }

  renewLock(key: string, token: string, ttlMs: number): Promise<{ renewed: boolean }> {
    return this.req('POST', this.p('/locks/renew'), { key, token, ttlMs });
  }

  releaseLock(key: string, token: string): Promise<{ released: boolean }> {
    return this.req('POST', this.p('/locks/release'), { key, token });
  }
}

/** Resource locks held on the results server (for shards on machines that share no file system). */
export class ServerLockBackend implements LockBackend {
  readonly name = 'server';
  private readonly holders = new Map<string, string>();

  constructor(private readonly client: ResultsClient, private readonly owner: string, private readonly ttlMs = 120_000) {}

  async tryAcquire(key: string): Promise<LockHandle | undefined> {
    const r = await this.client.acquireLock(key, this.owner, this.ttlMs);
    if (!r.acquired || !r.token) {
      if (r.holder) this.holders.set(key, r.holder);
      return undefined;
    }
    const token = r.token;
    const timer = setInterval(() => void this.client.renewLock(key, token, this.ttlMs).catch(() => undefined), Math.max(1000, Math.floor(this.ttlMs / 3)));
    timer.unref();
    return {
      key,
      release: async () => {
        clearInterval(timer);
        await this.client.releaseLock(key, token).catch(() => undefined);
      },
    };
  }

  async holder(key: string): Promise<string | undefined> {
    return this.holders.get(key);
  }
}
