/**
 * Input of the readiness gate `docsReconciled`: the document checks a run's journeys made
 * ("Compare document <download> to ... using <check>"), each citing its evidence.
 */
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { EvidenceRef } from '../core/index.js';
import type { DocsGateInput } from '../insights/readiness.js';

/** Evidence written by a "Compare document" step (runner/actions.ts): compare/<journey>/<step>.json. */
export function isDocumentCheckEvidence(e: EvidenceRef): boolean {
  return e.kind === 'data' && e.description === 'document comparison' && /^compare\//.test(e.path);
}

interface StoredCheck {
  passed?: boolean;
  details?: {
    status?: string;
    fields?: Array<{ name: string; verdict?: string; diagnosis?: string }>;
    footing?: { passed?: boolean; message?: string };
    diagnosis?: string[];
  };
}

/**
 * The gate input, or `{}` when the run made no document check (the gate then reports "no data",
 * never a pass). A failed check becomes a mismatch naming the fields that disagree.
 */
export async function docsReadinessInputs(runDir: string, evidence: EvidenceRef[]): Promise<{ docs?: DocsGateInput }> {
  const refs = evidence.filter(isDocumentCheckEvidence);
  if (!refs.length) return {};
  const mismatches: NonNullable<DocsGateInput['mismatches']> = [];
  const ids: string[] = [];
  for (const ref of refs) {
    const abs = resolve(runDir, ref.path);
    const rel = relative(resolve(runDir), abs);
    if (rel.startsWith('..') || rel === '') continue;
    let check: StoredCheck;
    try {
      check = JSON.parse(await readFile(abs, 'utf8')) as StoredCheck;
    } catch {
      continue;
    }
    ids.push(ref.id);
    if (check.passed) continue;
    const bad = (check.details?.fields ?? []).filter((f) => f.verdict && f.verdict !== 'ALL_AGREE').map((f) => `${f.name} (${f.diagnosis ?? f.verdict})`);
    if (check.details?.footing && check.details.footing.passed === false) bad.push(`footing (${check.details.footing.message ?? 'does not add up'})`);
    mismatches.push({
      description: `${ref.journeyId ?? 'a journey'}: ${bad.join(', ') || (check.details?.diagnosis ?? []).join('; ') || 'document check failed'}`,
      evidence: [ref.id],
      ...(ref.journeyId ? { journeyId: ref.journeyId } : {}),
    });
  }
  if (!ids.length) return {};
  return { docs: { reconciled: mismatches.length === 0, mismatches, evidence: ids } };
}
