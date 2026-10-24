/**
 * `healing.autoApply: true`: after a run, write the verified heals that a
 * reviewer would accept back into the journey files, the way the Studio's heal
 * inbox does (planHealRewrite: a phrase rewrite, a structured target, or a
 * locator sidecar), and record each as an accepted decision. Only heals whose
 * post-conditions verified them qualify; unverified heals
 * (healing.requireVerification: false), suspected regressions, heals below
 * minConfidence, anchor heals, repository-element heals and heals inside code
 * are left for review. Every change is kept as a unified diff.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import type { LocatorCandidate } from '../core/index.js';
import { planHealRewrite, type DiffLine, type HealRewriteMethod } from './apply.js';
import type { HealDecisions } from './decisions.js';
import type { HealProposal } from './proposals.js';
import type { FingerprintStore } from './store.js';

export interface AutoApplyOptions {
  /** Verified heal proposals of the run (heal-proposals.json `proposals`). */
  proposals: HealProposal[];
  /** Absolute path of the file that defines a journey, or undefined. */
  locate: (journeyId: string) => string | undefined;
  /** Project directory: diffs show paths relative to it, and files outside it are never written. */
  cwd: string;
  /** Heals below this confidence are left for review (config healing.minConfidence). */
  minConfidence: number;
  decisions?: HealDecisions;
  store?: FingerprintStore;
  runId: string;
  now?: string;
}

export interface AutoAppliedHeal {
  journeyId: string;
  stepId: string;
  file: string;
  method: HealRewriteMethod;
  tier: HealProposal['tier'];
  confidence: number;
  healed: LocatorCandidate;
}

export interface AutoApplyResult {
  applied: AutoAppliedHeal[];
  skipped: Array<{ journeyId: string; stepId: string; reason: string }>;
  /** Unified diff of every file written, in order. */
  diff: string;
  files: string[];
}

export const AUTO_APPLY_REVIEWER = 'eztest (healing.autoApply)';

function render(path: string, d: DiffLine[], existed: boolean): string {
  return [`--- ${existed ? `a/${path}` : '/dev/null'}`, `+++ b/${path}`, ...d.map((l) => `${l.kind}${l.text}`)].join('\n') + '\n';
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

export async function autoApplyHeals(o: AutoApplyOptions): Promise<AutoApplyResult> {
  const out: AutoApplyResult = { applied: [], skipped: [], diff: '', files: [] };
  const now = o.now ?? new Date().toISOString();
  const cwd = resolve(o.cwd);
  const skip = (p: HealProposal, reason: string) => out.skipped.push({ journeyId: p.journeyId, stepId: p.stepId, reason });
  const done = new Set<string>();
  for (const p of o.proposals) {
    if (!p.verified || p.unverified) {
      skip(p, 'not verified by post-conditions');
      continue;
    }
    if (p.confidence < o.minConfidence) {
      skip(p, `confidence ${p.confidence.toFixed(2)} is below healing.minConfidence ${o.minConfidence}`);
      continue;
    }
    if (p.anchor !== undefined) {
      skip(p, 'a heal of an anchor or container of a relative target is edited by hand');
      continue;
    }
    if (p.element) {
      skip(p, `a shared repository element (${p.element}) is accepted in the Studio heal inbox, where every journey using it is shown`);
      continue;
    }
    const key = `${p.journeyId}/${p.stepId}`;
    if (done.has(key)) continue;
    if (o.decisions?.rejection(p.journeyId, p.stepId, p.tier, p.healed)) {
      skip(p, 'a reviewer rejected this heal');
      continue;
    }
    const file = o.locate(p.journeyId);
    if (!file) {
      skip(p, 'no journey file defines this journey');
      continue;
    }
    const abs = resolve(file);
    const rel = relative(cwd, abs);
    if (rel.startsWith('..')) {
      skip(p, `${abs} is outside the project`);
      continue;
    }
    try {
      const text = await readFile(abs, 'utf8');
      const plan = await planHealRewrite({ file: abs, displayPath: rel.split('\\').join('/'), text, journeyId: p.journeyId, stepId: p.stepId, healed: p.healed, now });
      for (const c of plan.changes) {
        const target = resolve(cwd, c.path);
        if (relative(cwd, target).startsWith('..')) throw new Error(`${c.path} is outside the project`);
        await atomicWrite(target, c.after);
        out.diff += render(c.path, c.diff, c.existed);
        if (!out.files.includes(c.path)) out.files.push(c.path);
      }
      o.decisions?.record({
        journeyId: p.journeyId, stepId: p.stepId, decision: 'accepted', tier: p.tier, locator: p.healed, original: p.original,
        reviewer: AUTO_APPLY_REVIEWER, reason: `verified heal applied automatically (healing.autoApply; confidence ${p.confidence.toFixed(2)})`,
        decidedAt: now, runId: o.runId, file: plan.changes[0]?.path, rewrite: plan.method,
      });
      // The healed locator is now the step's own: the last good one, and no longer a cached heal.
      o.store?.setLastGood(p.journeyId, p.stepId, p.healed);
      o.store?.clearHeal(p.journeyId, p.stepId);
      done.add(key);
      out.applied.push({ journeyId: p.journeyId, stepId: p.stepId, file: plan.changes[0]?.path ?? rel, method: plan.method, tier: p.tier, confidence: p.confidence, healed: p.healed });
    } catch (e) {
      skip(p, (e as Error).message);
    }
  }
  return out;
}

