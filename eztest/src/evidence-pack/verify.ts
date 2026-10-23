/**
 * Verify an evidence pack offline with only the signer's public key:
 * signature over the canonical manifest, every file hash, no unlisted files,
 * and the embedded evidence hash chain (re-checked with core verifyEvidence).
 */
import { verify as verifySig } from 'node:crypto';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { verifyEvidence, type ManifestEntry } from '../core/index.js';
import { readZip, type ZipEntry } from './zip.js';
import { PACK_MANIFEST, PACK_SIGNATURE, canonicalManifestBytes, keyFingerprint, loadPublicKey, sha256Hex, type PackManifest } from './manifest.js';

export interface PackVerifyResult {
  ok: boolean;
  problems: string[];
  signatureValid: boolean;
  filesChecked: number;
  evidence?: { ok: boolean; entries: number; head: string; excluded: number };
  manifest?: PackManifest;
}

export async function verifyEvidencePack(zipFile: string, publicKeyPem: string): Promise<PackVerifyResult> {
  const problems: string[] = [];
  const result: PackVerifyResult = { ok: false, problems, signatureValid: false, filesChecked: 0 };
  let entries: ZipEntry[];
  try {
    entries = readZip(await readFile(zipFile));
  } catch (e) {
    problems.push(`cannot read pack: ${(e as Error).message}`);
    return result;
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  const manEntry = byName.get(PACK_MANIFEST);
  const sigEntry = byName.get(PACK_SIGNATURE);
  if (!manEntry) problems.push(`${PACK_MANIFEST} missing`);
  if (!sigEntry) problems.push(`${PACK_SIGNATURE} missing`);
  if (!manEntry || !sigEntry) return result;

  let manifest: PackManifest;
  try {
    manifest = JSON.parse(manEntry.data.toString('utf8')) as PackManifest;
  } catch (e) {
    problems.push(`${PACK_MANIFEST} is not valid JSON (${(e as Error).message})`);
    return result;
  }
  if (manifest?.format !== 'eztest-evidence-pack' || manifest.version !== 1 || !Array.isArray(manifest.files)) {
    problems.push(`${PACK_MANIFEST} is not an EZTest evidence pack manifest (v1)`);
    return result;
  }
  result.manifest = manifest;

  // Signature
  try {
    const key = loadPublicKey(publicKeyPem);
    const fp = keyFingerprint(key);
    const sig = Buffer.from(sigEntry.data.toString('utf8').trim(), 'base64');
    result.signatureValid = sig.length === 64 && verifySig(null, canonicalManifestBytes(manifest), key, sig);
    if (!result.signatureValid) {
      problems.push(
        fp !== manifest.key?.fingerprint
          ? `signature invalid: the pack names key ${manifest.key?.fingerprint?.slice(0, 16)}…, the given public key is ${fp.slice(0, 16)}… (wrong key or forged pack)`
          : 'signature invalid: the manifest was altered after signing',
      );
    }
  } catch (e) {
    problems.push(`signature check failed: ${(e as Error).message}`);
  }

  // Files
  const listed = new Set<string>();
  for (const f of manifest.files) {
    listed.add(f.path);
    const e = byName.get(f.path);
    if (!e) {
      problems.push(`file missing from pack: ${f.path}`);
      continue;
    }
    result.filesChecked += 1;
    if (e.data.length !== f.size) problems.push(`file size mismatch: ${f.path} (manifest ${f.size}, pack ${e.data.length})`);
    if (sha256Hex(e.data) !== f.sha256) problems.push(`file content altered: ${f.path} (sha256 mismatch)`);
  }
  for (const name of byName.keys()) {
    if (name !== PACK_MANIFEST && name !== PACK_SIGNATURE && !listed.has(name)) problems.push(`unlisted file in pack: ${name}`);
  }

  // Evidence chain: extract the run's files and reuse core verification.
  const chainFile = byName.get('evidence-manifest.jsonl');
  if (!chainFile) problems.push('evidence-manifest.jsonl missing');
  else {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-pack-verify-'));
    try {
      for (const e of entries) {
        if (e.name === PACK_MANIFEST || e.name === PACK_SIGNATURE) continue;
        const abs = join(dir, e.name);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, e.data);
      }
      const ev = await verifyEvidence(dir);
      const excluded = new Map((manifest.evidence?.excluded ?? []).map((x) => [x.path, x]));
      // Excluded files are absent by design; their hashes must still match the signed list.
      const chainEntries = chainFile.data
        .toString('utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l) as ManifestEntry;
          } catch {
            return undefined;
          }
        });
      for (const c of chainEntries) {
        const x = c && excluded.get(c.path);
        if (x && (x.sha256 !== c.sha256 || x.id !== c.id)) problems.push(`excluded evidence ${x.path}: hash/id differs from the chain`);
      }
      const chainProblems = ev.problems.filter((p) => {
        const m = /file missing (.+)$/.exec(p);
        return !(m && excluded.has(m[1]));
      });
      for (const p of chainProblems) problems.push(`evidence chain: ${p}`);
      if (ev.head !== manifest.evidence?.head) problems.push(`evidence chain head ${ev.head} does not match the signed head ${manifest.evidence?.head}`);
      if (ev.entries !== manifest.evidence?.entries) problems.push(`evidence chain has ${ev.entries} entries, the signed manifest says ${manifest.evidence?.entries}`);
      result.evidence = { ok: chainProblems.length === 0, entries: ev.entries, head: ev.head, excluded: excluded.size };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // run.json must be the run the manifest describes.
  const runEntry = byName.get('run.json');
  if (!runEntry) problems.push('run.json missing');
  else {
    try {
      const run = JSON.parse(runEntry.data.toString('utf8')) as { runId?: string; evidenceHead?: string };
      if (run.runId !== manifest.run?.runId) problems.push(`run.json runId ${run.runId} does not match the manifest ${manifest.run?.runId}`);
      if (run.evidenceHead && run.evidenceHead !== manifest.evidence?.head) problems.push('run.json evidenceHead does not match the evidence chain head');
    } catch {
      problems.push('run.json is not valid JSON');
    }
  }

  result.ok = problems.length === 0 && result.signatureValid;
  return result;
}
