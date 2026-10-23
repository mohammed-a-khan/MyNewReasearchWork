/**
 * Shared helpers for the Assurance and Project routes: reading a run's
 * result and evidence, lens findings per step, confined project files and a
 * small in-memory store for uploaded files (documents, evidence packs).
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import type { EvidenceRef, RunResult } from '../../core/index.js';
import type { LoadedConfig } from '../../config/index.js';
import { createSecretRegistry, identityVaultFromConfig, type IdentityVault } from '../../identity/index.js';
import { readEvidenceManifest } from '../../insights/index.js';
import type { StudioApp } from '../app.js';
import { HttpError } from '../http.js';
import { assertRunId, listRuns } from '../runs.js';
import { PathError, confinePath, isSensitive, relPosix } from '../security.js';

export interface LoadedRun {
  id: string;
  dir: string;
  run: RunResult;
  evidence: Map<string, EvidenceRef>;
}

export async function loadRun(app: StudioApp, runId: string): Promise<LoadedRun> {
  assertRunId(runId);
  const dir = join(await app.outputDir(), runId);
  const runJson = join(dir, 'run.json');
  if (!existsSync(runJson)) throw new HttpError(404, `Run ${runId} not found`);
  const run = JSON.parse(await readFile(runJson, 'utf8')) as RunResult;
  const evidence = new Map((await readEvidenceManifest(dir)).map((e) => [e.id, e]));
  return { id: runId, dir, run, evidence };
}

/** Read a JSON evidence file of a run (confined to the run directory). */
export async function readRunJson<T>(r: LoadedRun, rel: string): Promise<T | undefined> {
  const abs = confinePath(r.dir, rel);
  if (!existsSync(abs)) return undefined;
  try {
    return JSON.parse(await readFile(abs, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** `/runs/<id>/<path>` URL of a run artifact (served read-only by the asset route). */
export function runAssetUrl(runId: string, path: string): string {
  return `/runs/${encodeURIComponent(runId)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export interface StepRef {
  journeyId: string;
  journeyName: string;
  stepId: string;
  intent: string;
  status: string;
}

export interface LensStepFindings<T = unknown> extends StepRef {
  evidencePath: string;
  findings: Array<{ lens: string; severity: string; message: string; details?: T }>;
  screenshot?: string;
}

/** Lens findings recorded by the runner (`lens-<name>-<step>.json`) for every step of a run. */
export async function lensFindings<T = unknown>(r: LoadedRun, lens: string): Promise<Array<LensStepFindings<T>>> {
  const out: Array<LensStepFindings<T>> = [];
  const marker = `/lens-${lens}-`;
  for (const j of r.run.journeys) {
    for (const s of j.steps) {
      const refs = (s.evidence ?? []).map((id) => r.evidence.get(id)).filter((e): e is EvidenceRef => !!e);
      const lensRef = refs.find((e) => e.kind === 'data' && `/${e.path}`.includes(marker));
      if (!lensRef) continue;
      const findings = (await readRunJson<LensStepFindings<T>['findings']>(r, lensRef.path)) ?? [];
      const shot = refs.find((e) => e.kind === 'screenshot');
      out.push({
        journeyId: j.journeyId, journeyName: j.name, stepId: s.stepId, intent: s.intent, status: s.status,
        evidencePath: lensRef.path, findings, screenshot: shot ? runAssetUrl(r.id, shot.path) : undefined,
      });
    }
  }
  return out;
}

/** Which lenses produced findings in a run (cheap: evidence paths only). */
export function lensesInRun(r: { evidence: Map<string, EvidenceRef> | EvidenceRef[] }): string[] {
  const list = r.evidence instanceof Map ? [...r.evidence.values()] : r.evidence;
  const found = new Set<string>();
  for (const e of list) {
    const m = /(?:^|\/)lens-([a-z0-9]+)-/.exec(e.path);
    if (m && e.kind === 'data') found.add(m[1]);
    if (e.kind === 'data' && /^compare\//.test(e.path)) found.add('documents');
  }
  return [...found].sort();
}

/** Recent runs with the assurance data they hold (newest first). */
export async function assuranceRuns(app: StudioApp, limit = 40): Promise<Array<{ runId: string; startedAt?: string; summary?: unknown; lenses: string[] }>> {
  const out = await app.outputDir();
  const runs = (await listRuns(out)).filter((x) => x.summary).slice(0, limit);
  const res: Array<{ runId: string; startedAt?: string; summary?: unknown; lenses: string[] }> = [];
  for (const x of runs) {
    let lenses: string[] = [];
    try {
      lenses = lensesInRun({ evidence: await readEvidenceManifest(join(out, x.runId)) });
    } catch {
      lenses = [];
    }
    res.push({ runId: x.runId, startedAt: x.startedAt, summary: x.summary, lenses });
  }
  return res;
}

// ------------------------------------------------------------------ project files

/** Resolve a project-relative path that may be read from the Studio (confined, not sensitive). */
export function projectPath(app: StudioApp, rel: unknown, opts: { exts?: string[]; allowOutput?: boolean } = {}): string {
  if (typeof rel !== 'string' || !rel) throw new HttpError(400, '"path" is required');
  const abs = confinePath(app.cwd, rel);
  const r = relPosix(app.cwd, abs);
  if (isSensitive(r)) throw new PathError('This file is not accessible from the Studio');
  if (opts.exts && !opts.exts.includes(extname(abs).toLowerCase())) throw new PathError(`Only ${opts.exts.join(', ')} files are allowed here`);
  return abs;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.eztest', 'dist', 'coverage']);

/** Walk the project for files with the given extensions (bounded depth and count). */
export async function findProjectFiles(app: StudioApp, exts: string[], opts: { maxDepth?: number; max?: number; includeOutput?: boolean } = {}): Promise<Array<{ path: string; size: number; mtime: string }>> {
  const out: Array<{ path: string; size: number; mtime: string }> = [];
  const max = opts.max ?? 400;
  const outputDir = await app.outputDir();
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= max || depth > (opts.maxDepth ?? 5)) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= max) return;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        if (!opts.includeOutput && resolve(abs) === resolve(outputDir)) continue;
        await walk(abs, depth + 1);
      } else if (e.isFile() && exts.includes(extname(e.name).toLowerCase())) {
        const rel = relPosix(app.cwd, abs);
        if (isSensitive(rel)) continue;
        const st = await stat(abs);
        out.push({ path: rel, size: st.size, mtime: st.mtime.toISOString() });
      }
    }
  };
  await walk(app.cwd, 0);
  return out;
}

export function isInside(root: string, abs: string): boolean {
  const r = relative(root, abs);
  return r === '' || (!r.startsWith('..') && !r.startsWith('/') && !/^[a-zA-Z]:/.test(r));
}

// ------------------------------------------------------------------ uploads

interface Blob {
  name: string;
  bytes: Buffer;
  at: number;
}

const MAX_BLOBS = 24;
const MAX_TOTAL = 96 * 1024 * 1024;

/** Uploaded files kept in memory for this Studio process (never written to disk). */
export class BlobStore {
  private readonly blobs = new Map<string, Blob>();

  put(name: string, bytes: Buffer): string {
    const id = randomBytes(12).toString('hex');
    this.blobs.set(id, { name, bytes, at: Date.now() });
    let total = [...this.blobs.values()].reduce((n, b) => n + b.bytes.length, 0);
    for (const [k, b] of this.blobs) {
      if (this.blobs.size <= MAX_BLOBS && total <= MAX_TOTAL) break;
      if (k === id) continue;
      this.blobs.delete(k);
      total -= b.bytes.length;
    }
    return id;
  }

  get(id: unknown): Blob {
    if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) throw new HttpError(400, 'Invalid upload id');
    const b = this.blobs.get(id);
    if (!b) throw new HttpError(404, 'The upload expired; upload the file again');
    return b;
  }
}

export const uploads = new BlobStore();

/** Decode a base64 upload from a JSON body (the Studio API only takes JSON). */
export function decodeUpload(data: unknown, maxBytes = 3_600_000): Buffer {
  if (typeof data !== 'string' || !data) throw new HttpError(400, '"data" (base64) is required');
  const b64 = data.replace(/^data:[^,]*,/, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new HttpError(400, '"data" must be base64');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new HttpError(400, 'The uploaded file is empty');
  if (buf.length > maxBytes) throw new HttpError(413, `The file is too large for upload (${Math.round(maxBytes / 1024 / 1024 * 10) / 10} MB max); pick it from the project instead`);
  return buf;
}

export function safeFileName(name: unknown, fallback: string): string {
  const s = typeof name === 'string' ? name.split(/[\\/]/).pop() ?? '' : '';
  const clean = s.replace(/[^\w.() -]/g, '_').slice(0, 120);
  return clean || fallback;
}

/** Mask with the loaded config's masker when available. */
export async function masker(app: StudioApp): Promise<{ mask(s: string): string; maskDeep<T>(v: T): T }> {
  try {
    const l = await app.config();
    return { mask: (s) => l.masker.mask(s), maskDeep: (v) => l.masker.maskDeep(v) };
  } catch {
    return { mask: (s) => s, maskDeep: (v) => v };
  }
}

/** An Identity Vault for the current config, with secret stores reading the Studio's (possibly switched) environment. */
export function vaultFor(app: StudioApp, loaded: LoadedConfig, opts: { sessionDir?: string } = {}): IdentityVault {
  const registry = createSecretRegistry(loaded.config.identity.secretStores, { cwd: app.cwd, masker: loaded.masker, env: app.ctx.env });
  const cfg = opts.sessionDir ? { ...loaded.config, identity: { ...loaded.config.identity, sessionDir: opts.sessionDir } } : loaded.config;
  return identityVaultFromConfig(cfg, { cwd: app.cwd, masker: loaded.masker, registry });
}
