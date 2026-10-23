/**
 * Run-level trace resource store: content-addressed (SHA-256), gzip-compressed
 * blobs under `trace/resources/`, each written once per run and registered in
 * the Evidence Vault. Shared by every journey of the run, so the same CSS,
 * image or response body is stored once however many snapshots use it.
 */
import { gzipSync } from 'node:zlib';
import { sha256 } from '../../core/index.js';
import type { EvidenceWriter } from '../evidence.js';

export const TRACE_ROOT = 'trace';
export const RESOURCE_DIR = `${TRACE_ROOT}/resources`;

const EXT: Record<string, string> = {
  'text/css': 'css',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'application/json': 'json',
  'text/html': 'html',
  'text/plain': 'txt',
};

/** File extension for a content type ("bin" when unknown). */
export function extFor(contentType: string): string {
  const base = contentType.split(';')[0].trim().toLowerCase();
  return EXT[base] ?? (base.startsWith('text/') ? 'txt' : base.includes('json') ? 'json' : 'bin');
}

export interface StoredResource {
  /** `ezres:` token: `<sha256>.<ext>`. */
  key: string;
  /** Path relative to the run directory. */
  path: string;
  sha256: string;
  size: number;
  contentType: string;
}

export class TraceResourceStore {
  private readonly written = new Map<string, Promise<StoredResource>>();

  constructor(private readonly evidence: EvidenceWriter) {}

  /** Store bytes once (gzip) and return their reference. */
  put(data: string | Uint8Array, contentType: string, meta: { journeyId?: string; description?: string } = {}): Promise<StoredResource> {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const hash = sha256(bytes);
    const key = `${hash}.${extFor(contentType)}`;
    let p = this.written.get(key);
    if (!p) {
      const path = `${RESOURCE_DIR}/${key}.gz`;
      p = this.evidence
        .store('trace', path, gzipSync(bytes), { ...meta, description: meta.description ?? `trace resource ${contentType}` })
        .then(() => ({ key, path, sha256: hash, size: bytes.length, contentType }));
      p.catch(() => this.written.delete(key));
      this.written.set(key, p);
    }
    return p;
  }

  get size(): number {
    return this.written.size;
  }
}
