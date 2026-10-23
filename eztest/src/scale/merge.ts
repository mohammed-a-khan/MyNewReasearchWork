/**
 * `eztest merge`: combine shard runs into one run.
 *
 * The merged run directory holds:
 * - `shards/<shardRunId>/`: a byte-for-byte copy of every shard run, with its
 *   own evidence chain intact (it still verifies on its own);
 * - one new evidence chain that re-records every shard artifact (re-hashed
 *   from the copy, so it must match the shard's manifest) under new ids, then a
 *   `chain-link.json` per shard naming the shard's chain head, entry count and
 *   manifest hash. The shard manifest itself is also an entry, so altering a
 *   shard after the merge breaks both chains;
 * - `run.json` with every journey (evidence ids remapped to the merged chain),
 *   and a combined `heal-proposals.json`.
 *
 * `verifyMergedRun` checks the merged chain, each shard chain, and that every
 * link still names the shard head it was merged from.
 */
import { randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EvidenceVault, EzTestError, sha256, summarize, verifyEvidence, type JourneyResult, type RunResult, type ManifestEntry } from '../core/index.js';

export interface ShardLink {
  shardRunId: string;
  /** Head of the shard's own evidence chain at merge time. */
  shardEvidenceHead: string;
  shardEntries: number;
  /** sha256 of the shard's evidence-manifest.jsonl. */
  manifestSha256: string;
  /** Merged-chain ids of the first and last re-recorded entries. */
  mergedRange: [string, string] | [];
}

export interface MergeOptions {
  /** Merged run id (default merged-<timestamp>-<random>). */
  runId?: string;
  /** Merge even when a shard chain does not verify (the problems are reported). Default false. */
  allowUnverified?: boolean;
}

export interface MergeResult {
  runDir: string;
  run: RunResult;
  links: ShardLink[];
  warnings: string[];
}

/** A path that is a run directory, or a directory holding run directories (e.g. a CI artifact). */
export async function expandRunDirs(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    const abs = resolve(p);
    if (existsSync(join(abs, 'run.json'))) {
      out.push(abs);
      continue;
    }
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new EzTestError(`Not a run directory: ${p}`, 'RUN_NOT_FOUND');
    const found: string[] = [];
    const walk = async (d: string, depth: number) => {
      for (const name of (await readdir(d)).sort()) {
        const sub = join(d, name);
        if (!statSync(sub).isDirectory() || name === 'shards' || name === 'node_modules') continue;
        if (existsSync(join(sub, 'run.json'))) found.push(sub);
        else if (depth < 3) await walk(sub, depth + 1);
      }
    };
    await walk(abs, 0);
    if (!found.length) throw new EzTestError(`No run directories (with run.json) under ${p}`, 'RUN_NOT_FOUND');
    out.push(...found);
  }
  return [...new Set(out)];
}

function remapIds<T>(value: T, map: Map<string, string>): T {
  return JSON.parse(JSON.stringify(value), (_k, v: unknown) => (typeof v === 'string' && map.has(v) ? map.get(v) : v)) as T;
}

const newRunId = () => `merged-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')}-${randomBytes(3).toString('hex')}`;

export async function mergeRuns(runDirs: string[], outDir: string, opts: MergeOptions = {}): Promise<MergeResult> {
  if (!runDirs.length) throw new EzTestError('merge: no run directories given', 'INVALID_INPUT');
  const warnings: string[] = [];
  const shards: Array<{ dir: string; run: RunResult; head: string; entries: number }> = [];
  for (const dir of runDirs) {
    const run = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as RunResult;
    const v = await verifyEvidence(dir);
    if (!v.ok) {
      const msg = `shard ${run.runId} (${dir}) evidence chain does not verify: ${v.problems.slice(0, 3).join('; ')}`;
      if (!opts.allowUnverified) throw new EzTestError(msg, 'EVIDENCE_TAMPERED');
      warnings.push(msg);
    }
    shards.push({ dir, run, head: v.head, entries: v.entries });
  }
  const ids = new Set<string>();
  for (const s of shards) {
    if (ids.has(s.run.runId)) throw new EzTestError(`merge: run ${s.run.runId} given twice`, 'INVALID_INPUT');
    ids.add(s.run.runId);
  }
  shards.sort((a, b) => a.run.startedAt.localeCompare(b.run.startedAt) || a.run.runId.localeCompare(b.run.runId));

  const runDir = resolve(outDir);
  if (existsSync(join(runDir, 'evidence-manifest.jsonl'))) throw new EzTestError(`merge: ${runDir} already holds a run`, 'INVALID_INPUT');
  await mkdir(runDir, { recursive: true });
  const vault = new EvidenceVault(runDir);
  await vault.init();

  const links: ShardLink[] = [];
  const journeys: JourneyResult[] = [];
  const seenJourneys = new Map<string, string>();
  const proposals: { proposals: unknown[]; rejected: unknown[] } = { proposals: [], rejected: [] };
  for (const [n, s] of shards.entries()) {
    const sub = `shards/${s.run.runId}`;
    await cp(s.dir, join(runDir, sub), { recursive: true });
    const manifestText = existsSync(join(s.dir, 'evidence-manifest.jsonl')) ? await readFile(join(s.dir, 'evidence-manifest.jsonl'), 'utf8') : '';
    const entries = manifestText.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as ManifestEntry);
    const idMap = new Map<string, string>();
    for (const e of entries) {
      const ref = await vault.recordFile(e.kind, join(runDir, sub, e.path), {
        journeyId: e.journeyId, stepId: e.stepId, description: e.description,
      });
      if (ref.sha256 !== e.sha256) warnings.push(`shard ${s.run.runId}: ${e.path} does not match its manifest hash`);
      idMap.set(e.id, ref.id);
    }
    const manifestRef = await vault.recordFile('log', join(runDir, sub, 'evidence-manifest.jsonl'), { description: `evidence chain of shard ${s.run.runId}` });
    const link: ShardLink = {
      shardRunId: s.run.runId,
      shardEvidenceHead: s.head,
      shardEntries: s.entries,
      manifestSha256: sha256(manifestText),
      mergedRange: entries.length ? [idMap.get(entries[0].id)!, idMap.get(entries[entries.length - 1].id)!] : [],
    };
    await vault.store('report', `${sub}/chain-link.json`, JSON.stringify({ ...link, manifestEvidenceId: manifestRef.id }, null, 2), {
      description: `link to the evidence chain of shard ${s.run.runId} (head ${s.head.slice(0, 16)})`,
    });
    links.push(link);

    for (const j of remapIds(s.run.journeys, idMap)) {
      let jr = j;
      if (seenJourneys.has(j.journeyId)) {
        // Hook journeys (beforeAll/afterAll) run once per shard; keep each, distinguishable.
        jr = { ...j, journeyId: `${j.journeyId}#shard${n + 1}` };
        warnings.push(`journey ${j.journeyId} ran in shards ${seenJourneys.get(j.journeyId)} and ${s.run.runId}; kept as ${jr.journeyId}`);
      }
      seenJourneys.set(j.journeyId, s.run.runId);
      journeys.push(jr);
    }
    const hp = join(s.dir, 'heal-proposals.json');
    if (existsSync(hp)) {
      const f = remapIds(JSON.parse(await readFile(hp, 'utf8')) as { proposals?: unknown[]; rejected?: unknown[] }, idMap);
      proposals.proposals.push(...(f.proposals ?? []));
      proposals.rejected.push(...(f.rejected ?? []));
    }
  }

  const runId = opts.runId ?? newRunId();
  if (proposals.proposals.length || proposals.rejected.length) {
    await vault.store('report', 'heal-proposals.json', JSON.stringify({ runId, generatedAt: new Date().toISOString(), ...proposals }, null, 2), {
      description: 'heal proposals for review (all shards)',
    });
  }
  const startedAt = shards.map((s) => s.run.startedAt).sort()[0];
  const finishedAt = shards.map((s) => s.run.finishedAt).sort().slice(-1)[0];
  const first = shards[0].run.environment ?? {};
  const run: RunResult = {
    runId,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    journeys,
    summary: summarize(journeys),
    environment: {
      ...first,
      shards: shards.map((s) => s.run.runId).join(','),
      shardCount: String(shards.length),
      machineTimeMs: String(shards.reduce((a, s) => a + s.run.durationMs, 0)),
    },
    evidenceHead: vault.headHash,
  };
  await writeFile(join(runDir, 'run.json'), JSON.stringify(run, null, 2));
  return { runDir, run, links, warnings };
}

export interface MergedVerifyResult {
  ok: boolean;
  merged: { entries: number; head: string };
  shards: Array<{ shardRunId: string; ok: boolean; head: string; linked: boolean }>;
  problems: string[];
}

/** Verify a merged run: its own chain, every shard chain, and every shard link. */
export async function verifyMergedRun(runDir: string): Promise<MergedVerifyResult> {
  const own = await verifyEvidence(runDir);
  const problems = [...own.problems];
  const shards: MergedVerifyResult['shards'] = [];
  const base = join(runDir, 'shards');
  if (existsSync(base)) {
    for (const name of (await readdir(base)).sort()) {
      const dir = join(base, name);
      const linkPath = join(dir, 'chain-link.json');
      if (!existsSync(linkPath)) continue;
      const link = JSON.parse(await readFile(linkPath, 'utf8')) as ShardLink;
      const v = await verifyEvidence(dir);
      const manifestText = existsSync(join(dir, 'evidence-manifest.jsonl')) ? await readFile(join(dir, 'evidence-manifest.jsonl'), 'utf8') : '';
      const linked = v.head === link.shardEvidenceHead && v.entries === link.shardEntries && sha256(manifestText) === link.manifestSha256;
      if (!v.ok) problems.push(...v.problems.map((p) => `shard ${name}: ${p}`));
      if (!linked) problems.push(`shard ${name}: chain head ${v.head.slice(0, 16)} does not match the merged link ${link.shardEvidenceHead.slice(0, 16)}`);
      shards.push({ shardRunId: link.shardRunId, ok: v.ok, head: v.head, linked });
    }
  }
  return { ok: problems.length === 0, merged: { entries: own.entries, head: own.head }, shards, problems };
}
