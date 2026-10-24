/**
 * Input of the readiness gate `a11yNoCritical`: the accessibility findings a
 * run recorded (the a11y lens after each step, and "Check accessibility"
 * steps), each citing the evidence file it came from.
 */
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { EvidenceRef } from '../core/index.js';
import type { A11yGateItem, A11yScanRef } from '../insights/readiness.js';
import type { A11yScanResult } from './types.js';

/** Evidence of accessibility scans: lens findings files named ".../lens-a11y-<step>.json". */
export function isA11yEvidence(e: EvidenceRef): boolean {
  return e.kind === 'data' && /(?:^|\/)lens-a11y-[^/]*\.json$/.test(e.path);
}

interface StoredFinding {
  lens?: string;
  details?: Partial<A11yScanResult>;
}

/**
 * One gate item per violated rule per scanned step, plus the scans read (`a11yScans`, so a run whose
 * scans are all clean still has evidence for a passing gate to cite). `{}` when the run holds
 * no accessibility evidence, so the gate reports "no data" rather than a pass.
 */
export async function a11yReadinessInputs(runDir: string, evidence: EvidenceRef[]): Promise<{ a11y?: A11yGateItem[]; a11yScans?: A11yScanRef[] }> {
  const refs = evidence.filter(isA11yEvidence);
  if (!refs.length) return {};
  const items: A11yGateItem[] = [];
  const scans: A11yScanRef[] = [];
  for (const ref of refs) {
    const abs = resolve(runDir, ref.path);
    const rel = relative(resolve(runDir), abs);
    if (rel.startsWith('..') || rel === '') continue;
    let stored: StoredFinding[];
    try {
      stored = JSON.parse(await readFile(abs, 'utf8')) as StoredFinding[];
    } catch {
      continue;
    }
    scans.push({ evidence: ref.id, ...(ref.journeyId ? { journeyId: ref.journeyId } : {}) });
    for (const f of Array.isArray(stored) ? stored : []) {
      for (const v of f.details?.violations ?? []) {
        items.push({ ruleId: v.ruleId, impact: v.impact, journeyId: ref.journeyId, evidence: [ref.id] });
      }
    }
  }
  return { a11y: items, a11yScans: scans };
}
