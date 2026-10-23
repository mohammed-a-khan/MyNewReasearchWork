/**
 * Manual triage reclassification (`.eztest/triage-overrides.json`). A reviewer
 * moves a failure to another category with a reason; the override applies to
 * that run's verdict, and, because it is keyed by failure signature too, it is
 * offered as the starting classification when the same failure signature comes
 * back in a later run ("previously classified as ... by ..."). Trends and
 * readiness read verdicts with overrides applied.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EzTestError } from '../core/index.js';
import type { TriageCategory, TriageReport, TriageVerdict } from './triage.js';

export const TRIAGE_CATEGORIES: TriageCategory[] = ['product-bug', 'test-issue', 'environment', 'data', 'flaky', 'unknown'];

export interface TriageOverride {
  runId: string;
  journeyId: string;
  /** Failure signature hash, so the same failure in later runs inherits the classification. */
  signature?: string;
  from: TriageCategory;
  to: TriageCategory;
  reason: string;
  by: string;
  at: string;
}

export interface TriageOverridesFile {
  version: 1;
  overrides: TriageOverride[];
}

export async function loadTriageOverrides(path: string): Promise<TriageOverridesFile> {
  if (!existsSync(path)) return { version: 1, overrides: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    throw new EzTestError(`Triage overrides ${path} is not valid JSON: ${(e as Error).message}`, 'OVERRIDES_INVALID');
  }
  const d = raw as Partial<TriageOverridesFile>;
  if (!d || d.version !== 1 || !Array.isArray(d.overrides)) throw new EzTestError(`Triage overrides ${path} has an unknown format`, 'OVERRIDES_INVALID');
  return d as TriageOverridesFile;
}

export async function saveTriageOverrides(path: string, file: TriageOverridesFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2) + '\n');
  await rename(tmp, path);
}

/** Add an override, replacing an earlier one for the same run and journey. */
export function addTriageOverride(file: TriageOverridesFile, o: TriageOverride): TriageOverridesFile {
  if (!TRIAGE_CATEGORIES.includes(o.to)) throw new EzTestError(`Unknown triage category ${o.to}`, 'INVALID_INPUT');
  if (!o.reason.trim()) throw new EzTestError('A reclassification needs a reason', 'INVALID_INPUT');
  return { version: 1, overrides: [...file.overrides.filter((x) => !(x.runId === o.runId && x.journeyId === o.journeyId)), o] };
}

export interface AppliedVerdict extends TriageVerdict {
  /** Category the rules decided, before any override. */
  ruleCategory: TriageCategory;
  override?: TriageOverride & { inherited: boolean };
}

/**
 * Apply overrides to a run's verdicts: an override for this run and journey wins; otherwise
 * the latest override of an earlier run with the same failure signature is inherited.
 */
export function applyTriageOverrides(
  report: Pick<TriageReport, 'runId' | 'verdicts'>,
  file: TriageOverridesFile,
  runStartedAt?: (runId: string) => string | undefined,
): AppliedVerdict[] {
  const mine = runStartedAt?.(report.runId);
  return report.verdicts.map((v) => {
    const own = [...file.overrides].reverse().find((o) => o.runId === report.runId && o.journeyId === v.journeyId);
    if (own) return { ...v, ruleCategory: v.category, category: own.to, override: { ...own, inherited: false } };
    if (v.signature) {
      const prior = file.overrides
        .filter((o) => o.signature === v.signature && o.runId !== report.runId)
        .filter((o) => {
          const t = runStartedAt?.(o.runId);
          return !mine || !t || t <= mine;
        })
        .sort((a, b) => a.at.localeCompare(b.at))
        .pop();
      if (prior) return { ...v, ruleCategory: v.category, category: prior.to, override: { ...prior, inherited: true } };
    }
    return { ...v, ruleCategory: v.category };
  });
}
