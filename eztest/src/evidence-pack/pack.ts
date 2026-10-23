/**
 * Signed, tamper-evident evidence packs: one ZIP per run holding the run
 * result, the hash-chained evidence manifest, evidence files and reports, plus
 * a signed pack manifest binding every file hash to a named signer.
 */
import { sign } from 'node:crypto';
import { readFile, readdir, stat, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EvidenceKind, JourneyResult, RunResult } from '../core/index.js';
import { EzTestError, verifyEvidence, type ManifestEntry } from '../core/index.js';
import { containsSecret, redactText } from '../mocks/redact.js';
import { writeZip, validateEntryName, type ZipInput } from './zip.js';
import { profileInfo, type RegulatoryProfileId } from './profiles.js';
import {
  PACK_MANIFEST,
  PACK_SIGNATURE,
  canonicalManifestBytes,
  keyFingerprint,
  loadPrivateKey,
  sha256Hex,
  type PackFile,
  type PackManifest,
  type TraceRow,
} from './manifest.js';

export interface EvidencePackOptions {
  privateKeyPem: string;
  signer: { name: string; role: string; meaning?: string };
  /** Evidence kinds to include (default: all). Excluded entries stay verifiable through the chain metadata. */
  include?: EvidenceKind[];
  /** Additional files (e.g. approved requirement specs), stored under `extra/`. */
  extraFiles?: Array<string | { path: string; as?: string }>;
  regulatoryProfile?: RegulatoryProfileId;
  /** What to do when a text file looks like it contains a live credential (default "refuse"). */
  secretPolicy?: 'refuse' | 'warn';
  /** Timestamp for the manifest and ZIP entries (default: now). */
  now?: Date;
}

export interface EvidencePackResult {
  outFile: string;
  /** SHA-256 of the ZIP file itself (for a register / ticket). */
  sha256: string;
  bytes: number;
  manifest: PackManifest;
}

const REPORT_EXT = new Set(['.html', '.htm', '.json', '.xml', '.md', '.csv', '.txt']);
const TEXT_EXT = new Set([...REPORT_EXT, '.jsonl', '.log', '.har', '.yaml', '.yml']);

function traceability(journeys: JourneyResult[]): { rows: TraceRow[]; untraced: PackManifest['untracedJourneys'] } {
  const rows: TraceRow[] = [];
  const untraced: PackManifest['untracedJourneys'] = [];
  for (const j of journeys) {
    if (!j.requirements?.length) untraced.push({ journeyId: j.journeyId, name: j.name, status: j.status });
    for (const r of j.requirements ?? []) rows.push({ requirement: r, journeyId: j.journeyId, journeyName: j.name, status: j.status, evidence: [...(j.evidence ?? [])] });
  }
  rows.sort((a, b) => a.requirement.localeCompare(b.requirement) || a.journeyId.localeCompare(b.journeyId));
  return { rows, untraced };
}

async function readManifestEntries(runDir: string): Promise<ManifestEntry[]> {
  const text = await readFile(join(runDir, 'evidence-manifest.jsonl'), 'utf8');
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as ManifestEntry);
}

export async function createEvidencePack(runDir: string, outFile: string, opts: EvidencePackOptions): Promise<EvidencePackResult> {
  if (!opts.signer?.name?.trim() || !opts.signer?.role?.trim()) throw new EzTestError('Evidence pack: signer name and role are required', 'PACK_SIGNER_REQUIRED');
  const key = loadPrivateKey(opts.privateKeyPem);
  const profile = profileInfo(opts.regulatoryProfile);
  const secretPolicy = opts.secretPolicy ?? 'refuse';
  if (opts.include && opts.include.length === 0) throw new EzTestError('Evidence pack: include must list at least one kind', 'PACK_CONFIG');

  // 1. The run's own chain must be intact before we attest to it.
  const runJsonPath = join(runDir, 'run.json');
  if (!existsSync(runJsonPath)) throw new EzTestError(`Evidence pack: ${runJsonPath} not found`, 'PACK_NO_RUN');
  const chain = await verifyEvidence(runDir);
  if (!chain.ok) throw new EzTestError(`Evidence pack refused: the run's evidence chain is broken:\n- ${chain.problems.join('\n- ')}`, 'PACK_CHAIN_BROKEN', { problems: chain.problems });
  if (chain.entries === 0) throw new EzTestError('Evidence pack refused: the run has no recorded evidence', 'PACK_EMPTY');
  const runBytes = await readFile(runJsonPath);
  let run: RunResult;
  try {
    run = JSON.parse(runBytes.toString('utf8')) as RunResult;
  } catch (e) {
    throw new EzTestError(`Evidence pack: run.json is not valid JSON (${(e as Error).message})`, 'PACK_NO_RUN');
  }
  if (!run.runId || !Array.isArray(run.journeys)) throw new EzTestError('Evidence pack: run.json is not an EZTest run result', 'PACK_NO_RUN');
  if (run.evidenceHead && run.evidenceHead !== chain.head) {
    throw new EzTestError(`Evidence pack refused: run.json evidenceHead ${run.evidenceHead} does not match the chain head ${chain.head}`, 'PACK_CHAIN_BROKEN');
  }

  // 2. Collect files.
  const zipFiles: ZipInput[] = [];
  const files: PackFile[] = [];
  const warnings: string[] = [];
  const add = async (path: string, data: Buffer, meta: Omit<PackFile, 'path' | 'sha256' | 'size'>) => {
    validateEntryName(path);
    if (TEXT_EXT.has(extname(path).toLowerCase()) && meta.role !== 'evidence-manifest') {
      const hit = containsSecret(data.toString('utf8'));
      if (hit) {
        const msg = `${path} appears to contain a live credential (${hit})`;
        if (secretPolicy === 'refuse') {
          throw new EzTestError(`Evidence pack refused: ${msg}. Redact it at the source, or pass secretPolicy "warn" after review.`, 'PACK_SECRET');
        }
        warnings.push(msg);
      }
    }
    zipFiles.push({ name: path, data });
    files.push({ path, sha256: sha256Hex(data), size: data.length, ...meta });
  };

  await add('run.json', runBytes, { role: 'run' });
  await add('evidence-manifest.jsonl', await readFile(join(runDir, 'evidence-manifest.jsonl')), { role: 'evidence-manifest' });
  const entries = await readManifestEntries(runDir);
  const excluded: PackManifest['evidence']['excluded'] = [];
  const evidencePaths = new Set<string>();
  for (const e of entries) {
    evidencePaths.add(e.path);
    if (opts.include && !opts.include.includes(e.kind)) {
      excluded.push({ id: e.id, path: e.path, kind: e.kind, sha256: e.sha256 });
      continue;
    }
    if (files.some((f) => f.path === e.path)) continue; // same file recorded twice
    await add(e.path, await readFile(join(runDir, e.path)), { role: 'evidence', kind: e.kind, evidenceId: e.id });
  }
  // Top-level reports that are not chain entries (report.html, junit.xml, ...).
  for (const name of (await readdir(runDir)).sort()) {
    if (name === 'run.json' || name === 'evidence-manifest.jsonl' || evidencePaths.has(name)) continue;
    if (!REPORT_EXT.has(extname(name).toLowerCase())) continue;
    const abs = join(runDir, name);
    if (!(await stat(abs)).isFile()) continue;
    await add(name, await readFile(abs), { role: 'report' });
  }
  for (const x of opts.extraFiles ?? []) {
    const src = typeof x === 'string' ? x : x.path;
    const as = typeof x === 'string' ? basename(x) : (x.as ?? basename(x.path));
    if (!existsSync(src)) throw new EzTestError(`Evidence pack: extra file not found: ${src}`, 'PACK_EXTRA_MISSING');
    const path = `extra/${as}`;
    if (files.some((f) => f.path === path)) throw new EzTestError(`Evidence pack: duplicate extra file ${path}`, 'PACK_CONFIG');
    await add(path, await readFile(src), { role: 'extra' });
  }

  // 3. Manifest.
  const trace = traceability(run.journeys);
  if (profile.requireTraceability && trace.untraced.length) {
    warnings.push(`${trace.untraced.length} journey(s) have no ${profile.requirementLabel.toLowerCase()}: ${trace.untraced.map((u) => u.journeyId).join(', ')}`);
  }
  if (excluded.length) warnings.push(`${excluded.length} evidence file(s) intentionally excluded by kind filter (hashes still listed)`);
  const createdAt = (opts.now ?? new Date()).toISOString();
  const environment: Record<string, string> = {};
  for (const [k, v] of Object.entries(run.environment ?? {})) environment[k] = redactText(String(v));
  const manifest: PackManifest = {
    format: 'eztest-evidence-pack',
    version: 1,
    createdAt,
    tool: { name: 'eztest' },
    signer: { name: opts.signer.name.trim(), role: opts.signer.role.trim(), meaning: opts.signer.meaning?.trim() || profile.signatureMeaning },
    key: { algorithm: 'ed25519', fingerprint: keyFingerprint(key) },
    profile: { id: profile.id, title: profile.title, statements: profile.statements, requirementLabel: profile.requirementLabel, warnings },
    run: {
      runId: run.runId,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      summary: run.summary,
      environment,
      journeys: run.journeys.map((j) => ({ journeyId: j.journeyId, name: j.name, status: j.status, requirements: j.requirements ?? [] })),
    },
    evidence: { head: chain.head, entries: chain.entries, included: chain.entries - excluded.length, kinds: opts.include, excluded },
    files,
    traceability: trace.rows,
    untracedJourneys: trace.untraced,
  };
  const canonical = canonicalManifestBytes(manifest);
  const signature = sign(null, canonical, key).toString('base64');
  zipFiles.push({ name: PACK_MANIFEST, data: canonical }, { name: PACK_SIGNATURE, data: Buffer.from(signature + '\n', 'utf8') });

  // 4. Write atomically.
  const zip = writeZip(zipFiles, { mtime: opts.now ?? new Date() });
  await mkdir(dirname(outFile), { recursive: true });
  const tmp = `${outFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, zip);
  await rename(tmp, outFile);
  return { outFile, sha256: sha256Hex(zip), bytes: zip.length, manifest };
}
