/**
 * Load what a run directory contains: run.json, the evidence manifest and the
 * parsed network logs, keyed by the evidence id that recorded them.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import type { EvidenceRef, RunResult } from '../core/index.js';
import { EzTestError } from '../core/index.js';
import { normalizeNetworkLog, type NetworkEntry } from '../perf/network.js';

export interface NetworkLog {
  evidenceId: string;
  journeyId?: string;
  stepId?: string;
  entries: NetworkEntry[];
}

export interface RunArtifacts {
  runDir: string;
  run: RunResult;
  evidence: EvidenceRef[];
  networkLogs: NetworkLog[];
  /** Problems found while loading (unreadable network files...). Never silently dropped. */
  warnings: string[];
}

export async function readEvidenceManifest(runDir: string): Promise<EvidenceRef[]> {
  const p = join(runDir, 'evidence-manifest.jsonl');
  if (!existsSync(p)) return [];
  const out: EvidenceRef[] = [];
  const lines = (await readFile(p, 'utf8')).split('\n').filter((l) => l.trim());
  for (const [i, line] of lines.entries()) {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new EzTestError(`evidence-manifest.jsonl line ${i + 1} is not valid JSON`, 'MANIFEST_INVALID');
    }
    const { seq: _s, prevHash: _p, entryHash: _h, ...ref } = e;
    out.push(ref as unknown as EvidenceRef);
  }
  return out;
}

function insideRunDir(runDir: string, p: string): string {
  const abs = resolve(runDir, p);
  const rel = relative(runDir, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new EzTestError(`Evidence path escapes run dir: ${p}`, 'PATH_ESCAPE');
  return abs;
}

export async function loadRunArtifacts(runDir: string): Promise<RunArtifacts> {
  const runPath = join(runDir, 'run.json');
  if (!existsSync(runPath)) throw new EzTestError(`run.json not found in ${runDir}`, 'RUN_NOT_FOUND');
  const run = JSON.parse(await readFile(runPath, 'utf8')) as RunResult;
  if (!run || !Array.isArray(run.journeys)) throw new EzTestError(`${runPath} is not a RunResult`, 'RUN_INVALID');
  const evidence = await readEvidenceManifest(runDir);
  const networkLogs: NetworkLog[] = [];
  const warnings: string[] = [];
  for (const ev of evidence) {
    if (ev.kind !== 'network') continue;
    try {
      const raw = JSON.parse(await readFile(insideRunDir(runDir, ev.path), 'utf8')) as unknown;
      networkLogs.push({ evidenceId: ev.id, journeyId: ev.journeyId, stepId: ev.stepId, entries: normalizeNetworkLog(raw) });
    } catch (e) {
      warnings.push(`network evidence ${ev.id} (${ev.path}) unreadable: ${(e as Error).message}`);
    }
  }
  return { runDir, run, evidence, networkLogs, warnings };
}
