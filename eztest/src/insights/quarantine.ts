/**
 * Quarantine (`.eztest/quarantine.json`): a known-flaky or known-broken journey
 * can be quarantined with a reason, an owner and an expiry date. Quarantined
 * journeys still run and are still reported, but their failures do not fail
 * `eztest run` (exit code) and do not block release readiness. They are shown
 * separately. An expired quarantine no longer applies (its failures count
 * again) and is reported as a warning so the owner renews or removes it.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { JourneyResult, RunResult } from '../core/index.js';
import { EzTestError } from '../core/index.js';

export interface QuarantineEntry {
  journeyId: string;
  reason: string;
  owner: string;
  /** ISO date (YYYY-MM-DD) or timestamp; the quarantine stops applying after it. */
  expires: string;
  createdAt: string;
  createdBy?: string;
  /** Optional link to a tracking work item. */
  ticket?: string;
}

export interface QuarantineFile {
  version: 1;
  entries: QuarantineEntry[];
}

export interface QuarantineStatus {
  /** Entries in force now. */
  active: QuarantineEntry[];
  /** Entries past their expiry (no longer applied). */
  expired: QuarantineEntry[];
  /** Active entries that expire within `soonDays`. */
  expiringSoon: QuarantineEntry[];
  warnings: string[];
}

const DAY = 86_400_000;

/** Expiry instant: a bare date means the end of that day (UTC). */
export function expiryTime(expires: string): number {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(expires) ? Date.parse(`${expires}T23:59:59.999Z`) : Date.parse(expires);
  return t;
}

export function validateQuarantineEntry(e: Partial<QuarantineEntry>): string[] {
  const problems: string[] = [];
  if (!e.journeyId || typeof e.journeyId !== 'string') problems.push('journeyId is required');
  if (!e.reason || !String(e.reason).trim()) problems.push('a reason is required');
  if (!e.owner || !String(e.owner).trim()) problems.push('an owner is required');
  if (!e.expires || !Number.isFinite(expiryTime(String(e.expires)))) problems.push('expires must be a date (YYYY-MM-DD)');
  return problems;
}

export async function loadQuarantine(path: string): Promise<QuarantineFile> {
  if (!existsSync(path)) return { version: 1, entries: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    throw new EzTestError(`Quarantine file ${path} is not valid JSON: ${(e as Error).message}`, 'QUARANTINE_INVALID');
  }
  const d = raw as Partial<QuarantineFile>;
  if (!d || d.version !== 1 || !Array.isArray(d.entries)) throw new EzTestError(`Quarantine file ${path} has an unknown format`, 'QUARANTINE_INVALID');
  for (const e of d.entries) {
    const p = validateQuarantineEntry(e);
    if (p.length) throw new EzTestError(`Quarantine file ${path}: entry ${e?.journeyId ?? '?'}: ${p.join('; ')}`, 'QUARANTINE_INVALID');
  }
  return d as QuarantineFile;
}

export async function saveQuarantine(path: string, file: QuarantineFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2) + '\n');
  await rename(tmp, path);
}

/** Which entries apply at `now`, which expired, which expire within `soonDays`. */
export function quarantineStatus(file: QuarantineFile, now = new Date(), soonDays = 7): QuarantineStatus {
  const active: QuarantineEntry[] = [];
  const expired: QuarantineEntry[] = [];
  const expiringSoon: QuarantineEntry[] = [];
  const warnings: string[] = [];
  for (const e of file.entries) {
    const t = expiryTime(e.expires);
    if (t < now.getTime()) {
      expired.push(e);
      warnings.push(`quarantine of ${e.journeyId} (owner ${e.owner}) expired on ${e.expires}; its failures count again - renew or remove it`);
    } else {
      active.push(e);
      if (t - now.getTime() <= soonDays * DAY) {
        expiringSoon.push(e);
        warnings.push(`quarantine of ${e.journeyId} (owner ${e.owner}) expires on ${e.expires}`);
      }
    }
  }
  return { active, expired, expiringSoon, warnings };
}

export interface QuarantineSplit {
  /** Journeys whose failures count. */
  counted: JourneyResult[];
  /** Quarantined journeys (any status). */
  quarantined: JourneyResult[];
  /** Quarantined journeys that failed or errored (their failures are ignored). */
  ignoredFailures: JourneyResult[];
}

export function splitQuarantined(run: Pick<RunResult, 'journeys'>, activeIds: Iterable<string>): QuarantineSplit {
  const ids = new Set(activeIds);
  const counted: JourneyResult[] = [];
  const quarantined: JourneyResult[] = [];
  for (const j of run.journeys) (ids.has(j.journeyId) ? quarantined : counted).push(j);
  return { counted, quarantined, ignoredFailures: quarantined.filter((j) => j.status === 'failed' || j.status === 'error') };
}

/**
 * Run exit code with quarantine applied: 0 only when no non-quarantined journey
 * failed or errored and something ran.
 */
export function exitCodeWithQuarantine(run: Pick<RunResult, 'journeys' | 'summary'>, activeIds: Iterable<string> = []): number {
  if (run.summary.total === 0) return 1;
  const { counted } = splitQuarantined(run, activeIds);
  return counted.some((j) => j.status === 'failed' || j.status === 'error') ? 1 : 0;
}
