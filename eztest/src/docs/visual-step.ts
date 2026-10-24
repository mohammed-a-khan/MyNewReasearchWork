/**
 * The "Expect document A to look like document B" step: resolves both
 * documents (a download in the ledger, or a file in the project), compares
 * them visually and stores the diff images and an HTML report as evidence.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { EzTestError } from '../core/index.js';
import type { StepContext } from '../runner/types.js';
import { compareDocumentsVisually, parseMasks, renderVisualHtml, visualResultSummary, type VisualMask } from './visual.js';

function safe(s: string): string {
  return s.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'doc';
}

/** A ledger key holding a download ({ path }) or a file path (relative to the project). */
export function resolveDocumentRef(ref: string, ctx: Pick<StepContext, 'ledger'>, cwd: string): string {
  const v = ctx.ledger.get(ref) as { path?: string } | string | undefined;
  if (v && typeof v === 'object' && typeof v.path === 'string') return v.path;
  if (typeof v === 'string' && existsSync(isAbsolute(v) ? v : resolve(cwd, v))) return isAbsolute(v) ? v : resolve(cwd, v);
  const p = isAbsolute(ref) ? ref : resolve(cwd, ref);
  if (existsSync(p)) return p;
  throw new EzTestError(`Document "${ref}" is neither a downloaded file in this journey nor a file in the project (${p})`, 'NO_DOCUMENT');
}

/** Run a visual document comparison step; returns what the compareDocument action expects. */
export async function visualDocumentCheck(args: Record<string, unknown>, ctx: StepContext, cwd: string): Promise<{ passed: boolean; details: unknown }> {
  const actualRef = String(args.document ?? '');
  const expectedRef = String(args.expected ?? args.against ?? '');
  const actual = resolveDocumentRef(actualRef, ctx, cwd);
  const expected = resolveDocumentRef(expectedRef, ctx, cwd);
  const masks: VisualMask[] = Array.isArray(args.masks) ? (args.masks as VisualMask[]) : typeof args.masks === 'string' ? parseMasks(args.masks) : [];
  const tolerance = args.tolerancePercent !== undefined ? Number(args.tolerancePercent) / 100 : undefined;
  const r = await compareDocumentsVisually(actual, expected, {
    masks, baseDir: cwd,
    ...(tolerance !== undefined ? { maxDiffRatio: tolerance } : {}),
    ...(args.maxDiffPixels !== undefined ? { maxDiffPixels: Number(args.maxDiffPixels) } : {}),
    ...(args.dpi !== undefined ? { dpi: Number(args.dpi) } : {}),
    ...(args.threshold !== undefined ? { threshold: Number(args.threshold) } : {}),
  });
  const base = `documents/${safe(ctx.journey.id)}-${safe(ctx.step.id)}`;
  const evidence: string[] = [];
  for (const p of r.pages) {
    // Diff images for every compared page, the rendered pages too when the page failed.
    const shots: Array<[string, Buffer | undefined]> = [['diff', p.diffPng], ...(p.passed ? [] : ([['actual', p.actualPng], ['expected', p.expectedPng]] as Array<[string, Buffer | undefined]>))];
    for (const [kind, png] of shots) {
      if (!png) continue;
      const ref = await ctx.evidence.store('screenshot', `${base}/page-${p.page}-${kind}.png`, new Uint8Array(png), { journeyId: ctx.journey.id, stepId: ctx.step.id, description: `visual document comparison, page ${p.page} ${kind}` });
      evidence.push(ref.id);
    }
  }
  const report = await ctx.evidence.store('report', `${base}/visual.html`, renderVisualHtml(r, { title: `Document ${actualRef} vs ${expectedRef}`, actualName: actualRef, expectedName: expectedRef }),
    { journeyId: ctx.journey.id, stepId: ctx.step.id, description: `visual document comparison: ${r.summary}` });
  evidence.push(report.id);
  if (!r.passed) {
    throw new EzTestError(`Document ${actualRef} does not look like ${expectedRef}: ${r.summary} (evidence ${evidence.join(', ')})`, 'DOCS_VISUAL_MISMATCH', { details: visualResultSummary(r) });
  }
  return { passed: r.passed, details: { ...visualResultSummary(r), actual: actualRef, expected: expectedRef, evidence } };
}
