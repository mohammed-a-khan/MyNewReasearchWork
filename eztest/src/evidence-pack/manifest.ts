/** Pack manifest model, canonical bytes and key helpers shared by pack and verify. */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { EvidenceKind, JourneyStatus, RunSummary } from '../core/index.js';
import { EzTestError } from '../core/index.js';
import type { RegulatoryProfileId } from './profiles.js';

export const PACK_MANIFEST = 'pack-manifest.json';
export const PACK_SIGNATURE = 'pack-manifest.sig';

export interface PackFile {
  path: string;
  sha256: string;
  size: number;
  role: 'run' | 'evidence-manifest' | 'evidence' | 'report' | 'extra';
  kind?: EvidenceKind;
  evidenceId?: string;
}

export interface TraceRow {
  requirement: string;
  journeyId: string;
  journeyName: string;
  status: JourneyStatus;
  evidence: string[];
}

export interface PackManifest {
  format: 'eztest-evidence-pack';
  version: 1;
  createdAt: string;
  tool: { name: 'eztest' };
  signer: { name: string; role: string; meaning: string };
  key: { algorithm: 'ed25519'; fingerprint: string };
  profile: { id: RegulatoryProfileId; title: string; statements: string[]; requirementLabel: string; warnings: string[] };
  run: {
    runId: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    summary: RunSummary;
    environment: Record<string, string>;
    journeys: Array<{ journeyId: string; name: string; status: JourneyStatus; requirements: string[] }>;
  };
  evidence: {
    head: string;
    entries: number;
    included: number;
    /** Kinds filter used when packing (absent = all kinds). */
    kinds?: EvidenceKind[];
    /** Chain entries whose files were intentionally left out; their chain metadata is still verified. */
    excluded: Array<{ id: string; path: string; kind: EvidenceKind; sha256: string }>;
  };
  files: PackFile[];
  traceability: TraceRow[];
  untracedJourneys: Array<{ journeyId: string; name: string; status: JourneyStatus }>;
}

/** Deterministic JSON: sorted keys, no whitespace, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
  return JSON.stringify(value) ?? 'null';
}

export function canonicalManifestBytes(m: PackManifest): Buffer {
  return Buffer.from(canonicalJson(m), 'utf8');
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function generateSigningKey(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

export function loadPrivateKey(pem: string): KeyObject {
  let k: KeyObject;
  try {
    k = createPrivateKey(pem);
  } catch (e) {
    throw new EzTestError(`Invalid private key: ${(e as Error).message}`, 'PACK_KEY_INVALID');
  }
  if (k.asymmetricKeyType !== 'ed25519') throw new EzTestError(`Signing key must be ed25519, got ${k.asymmetricKeyType}`, 'PACK_KEY_INVALID');
  return k;
}

export function loadPublicKey(pem: string): KeyObject {
  let k: KeyObject;
  try {
    k = createPublicKey(pem);
  } catch (e) {
    throw new EzTestError(`Invalid public key: ${(e as Error).message}`, 'PACK_KEY_INVALID');
  }
  if (k.asymmetricKeyType !== 'ed25519') throw new EzTestError(`Public key must be ed25519, got ${k.asymmetricKeyType}`, 'PACK_KEY_INVALID');
  return k;
}

/** SHA-256 over the DER SubjectPublicKeyInfo: a stable id for a key. */
export function keyFingerprint(key: KeyObject): string {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  return sha256Hex(pub.export({ type: 'spki', format: 'der' }));
}
