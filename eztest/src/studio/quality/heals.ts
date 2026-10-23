/**
 * Heal Review inbox: every verified heal (`passed-healed` step) across runs,
 * deduplicated by journey, step and healed locator, with the evidence and the
 * post-conditions that verified it; accept (write the locator into the journey
 * file, with a diff first) or reject (the healer refuses that tier afterwards).
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { flattenStepResults, flattenSteps, type ConditionResult, type HealTier, type LocatorCandidate, type Step } from '../../core/index.js';
import { conditionToText } from '../../intent/conditions.js';
import { FingerprintStore, HealDecisions, locatorKey, planHealRewrite, type HealDecision, type HealRewritePlan, type FileChange, type ReviewTier } from '../../heal/index.js';
import { ELEMENTS_JOURNEY } from '../../heal/store.js';
import { ElementRepository, parseElementFile } from '../../elements/repository.js';
import { elementHealFile, planElementHeal } from '../../elements/heal.js';
import type { StudioApp } from '../app.js';
import { HttpError } from '../http.js';
import { completedRuns, evidenceView, journeyFiles, loadRun, qualityPaths, sha, type JourneyFileInfo } from './common.js';

export type HealStatus = 'pending' | 'accepted' | 'rejected' | 'applied';

export interface HealOccurrence {
  runId: string;
  startedAt: string;
  tier: ReviewTier;
  confidence: number;
}

export interface HealItem {
  key: string;
  journeyId: string;
  journeyName: string;
  stepId: string;
  intent: string;
  targetDescription?: string;
  original: LocatorCandidate[];
  healed: LocatorCandidate;
  tier: ReviewTier;
  tiers: ReviewTier[];
  confidence: number;
  minConfidence: number;
  reason: string;
  runs: HealOccurrence[];
  runCount: number;
  firstSeen: string;
  lastSeen: string;
  lastRunId: string;
  evidence: Array<NonNullable<ReturnType<typeof evidenceView>>>;
  conditions: Array<{ type: string; text: string; passed: boolean; actual?: string }>;
  impliedCheck?: string;
  status: HealStatus;
  decision?: HealDecision;
  file?: { path: string; format: string };
  /** heal: a verified heal of a failing locator; improvement: a more robust locator for a passing step. */
  kind?: 'heal' | 'improvement';
  /** Locator quality scores (improvements). */
  locatorScore?: { current: number; suggested: number };
  /** Shared repository element the heal belongs to: accepting it rewrites the element (every journey using it is fixed). */
  element?: string;
  /** The heal is of the target's i-th anchor or container (`below "Email"`); the journey text is edited by hand. */
  anchor?: number;
  /** Journeys and steps that healed this element (one review item for all of them). */
  usages?: Array<{ journeyId: string; journeyName: string; stepId: string; intent: string }>;
}

/** Element settings of the project config. */
async function elementsConfig(app: StudioApp): Promise<{ dir: string; screens: string[]; matchDescriptions: boolean }> {
  const cfg = (await app.config()).config as { elements?: { dir: string; screens: string[]; matchDescriptions: boolean } };
  return cfg.elements ?? { dir: 'elements', screens: [], matchDescriptions: true };
}

/** The project's element repository, as the runner loads it. */
export async function studioElements(app: StudioApp): Promise<ElementRepository> {
  return ElementRepository.load(app.cwd, await elementsConfig(app));
}

function conditionText(c: ConditionResult): string {
  try {
    return conditionToText(c.condition);
  } catch {
    return c.condition.type;
  }
}

/** Does the journey on disk already list the healed locator for the step (e.g. it was edited by hand)? */
function alreadyApplied(steps: Step[] | undefined, stepId: string, healed: LocatorCandidate): boolean {
  const s = flattenSteps(steps ?? []).find((x) => x.id === stepId);
  return !!s?.target?.locators.some((l) => locatorKey(l) === locatorKey(healed));
}

export async function collectHeals(app: StudioApp, opts: { runs?: number; run?: string } = {}): Promise<{ items: HealItem[]; runsScanned: number; warnings: string[] }> {
  const runs = (await completedRuns(app)).slice(0, opts.runs ?? 60);
  const scan = opts.run ? runs.filter((r) => r.runId === opts.run) : runs;
  const decisions = await HealDecisions.open((await qualityPaths(app)).decisions);
  const files = await journeyFiles(app);
  const byId = new Map<string, JourneyFileInfo>(files.map((f) => [f.id, f]));
  const loaded = new Map<string, Awaited<ReturnType<typeof import('../../intent/index.js').loadJourneyFile>> | undefined>();
  const { loadJourneyFile } = await import('../../intent/index.js');
  const warnings: string[] = [];
  const items = new Map<string, HealItem>();
  // Oldest first so "first seen" and the latest occurrence fall out naturally.
  for (const r of [...scan].reverse()) {
    let lr;
    try {
      lr = await loadRun(app, r.runId);
    } catch (e) {
      warnings.push(`${r.runId}: ${(e as Error).message}`);
      continue;
    }
    const evById = new Map(lr.evidence.map((e) => [e.id, e]));
    for (const j of lr.run.journeys) {
      // Healed steps may be nested in blocks (if / loops / frame blocks / sub-journeys).
      for (const { result: s } of flattenStepResults(j.steps)) {
        // "improvement": a more robust locator verified against the live element of a passing step.
        const imp = s.improvement;
        if (imp && (s.status === 'passed' || s.status === 'passed-healed')) {
          const key = `${j.journeyId}/${s.stepId}/${locatorKey(imp.suggested)}`;
          const occ: HealOccurrence = { runId: r.runId, startedAt: r.startedAt ?? lr.run.startedAt, tier: 'improvement', confidence: imp.score / 100 };
          const cur = items.get(key);
          if (cur) {
            cur.runs.push(occ);
            cur.runCount = cur.runs.length;
            cur.lastSeen = occ.startedAt;
            cur.lastRunId = r.runId;
          } else {
            items.set(key, {
              key, kind: 'improvement', journeyId: j.journeyId, journeyName: j.name, stepId: s.stepId, intent: s.intent,
              original: s.usedLocator ? [s.usedLocator] : [], healed: imp.suggested, tier: 'improvement', tiers: ['improvement'],
              confidence: imp.score / 100, minConfidence: imp.score / 100, reason: imp.reason, runs: [occ], runCount: 1,
              firstSeen: occ.startedAt, lastSeen: occ.startedAt, lastRunId: r.runId, evidence: [], conditions: [], status: 'pending',
              locatorScore: { current: imp.currentScore, suggested: imp.score },
            });
          }
        }
        const h = s.heal;
        if (s.status !== 'passed-healed' || !h?.verified) continue;
        // A repository element is one review item, whichever journeys healed it.
        const key = h.element ? `@el/${h.element}/${locatorKey(h.healed)}` : `${j.journeyId}/${s.stepId}/${locatorKey(h.healed)}`;
        const usage = { journeyId: j.journeyId, journeyName: j.name, stepId: s.stepId, intent: s.intent };
        const occ: HealOccurrence = { runId: r.runId, startedAt: r.startedAt ?? lr.run.startedAt, tier: h.tier, confidence: h.confidence };
        const ev = [...new Set([...h.evidence, ...s.evidence])].map((id) => evidenceView(r.runId, evById.get(id))).filter((x): x is NonNullable<typeof x> => !!x);
        const cur = items.get(key);
        const implied = /;\s*([^;]*(?:value|checked|selected|filled)[^;]*)$/i.exec(h.reason)?.[1];
        const base = {
          intent: s.intent,
          original: h.original,
          tier: h.tier,
          confidence: h.confidence,
          reason: h.reason,
          lastSeen: occ.startedAt,
          lastRunId: r.runId,
          evidence: ev.length ? ev : (cur?.evidence ?? []),
          conditions: s.conditions.map((c) => ({ type: c.condition.type, text: conditionText(c), passed: c.passed, actual: c.actual })),
          ...(implied ? { impliedCheck: implied } : {}),
        };
        if (cur) {
          Object.assign(cur, base);
          cur.runs.push(occ);
          cur.runCount = cur.runs.length;
          if (!cur.tiers.includes(h.tier)) cur.tiers.push(h.tier);
          cur.minConfidence = Math.min(cur.minConfidence, h.confidence);
          if (cur.usages && !cur.usages.some((u) => u.journeyId === usage.journeyId && u.stepId === usage.stepId)) cur.usages.push(usage);
        } else {
          items.set(key, {
            key,
            journeyId: j.journeyId,
            journeyName: j.name,
            stepId: s.stepId,
            healed: h.healed,
            tiers: [h.tier],
            minConfidence: h.confidence,
            runs: [occ],
            runCount: 1,
            firstSeen: occ.startedAt,
            status: 'pending',
            ...(h.element ? { element: h.element, usages: [usage] } : {}),
            ...(h.anchor !== undefined ? { anchor: h.anchor } : {}),
            ...base,
          });
        }
      }
    }
  }
  const repo = [...items.values()].some((i) => i.element) ? await studioElements(app) : undefined;
  const elDir = (await elementsConfig(app)).dir;
  for (const it of items.values()) {
    it.runs.reverse();
    if (it.element) {
      // Repository element: its file is the element's file, and it is applied once it lists the healed locator first.
      const el = repo?.get(it.element);
      it.targetDescription = el?.description ?? `@${it.element}`;
      if (el) {
        it.file = { path: elementHealFile(el, elDir), format: 'element' };
        if (el.locators[0] && locatorKey(el.locators[0]) === locatorKey(it.healed)) it.status = 'applied';
      }
      const origin = it.tiers.find((t) => t !== 'T0-cache');
      if (it.tier === 'T0-cache' && origin) it.tier = origin;
      const d = decisions.decisionOn(it.journeyId, it.stepId, it.tier, it.healed);
      if (d) {
        it.decision = d;
        it.status = d.decision === 'rejected' ? 'rejected' : 'accepted';
      }
      continue;
    }
    // A T0 cache hit replays an earlier heal: review it under the tier that produced it.
    const origin = it.tiers.find((t) => t !== 'T0-cache');
    if (it.tier === 'T0-cache' && origin) it.tier = origin;
    const f = byId.get(it.journeyId);
    if (f) {
      it.file = { path: f.path, format: f.format };
      if (!loaded.has(f.path)) loaded.set(f.path, await loadJourneyFile(resolve(app.cwd, f.path)).catch(() => undefined));
      const j = loaded.get(f.path);
      it.targetDescription = flattenSteps(j?.steps ?? []).find((s) => s.id === it.stepId)?.target?.description;
      if (alreadyApplied(j?.steps, it.stepId, it.healed)) it.status = 'applied';
    }
    const d = decisions.decisionOn(it.journeyId, it.stepId, it.tier, it.healed) ?? [...decisions.forStep(it.journeyId, it.stepId)].reverse().find((x) => locatorKey(x.locator) === locatorKey(it.healed));
    if (d) {
      it.decision = d;
      if (d.decision === 'rejected') it.status = 'rejected';
      else if (it.status !== 'applied') it.status = 'accepted';
      else it.status = 'accepted';
    }
  }
  const list = [...items.values()].sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.lastSeen.localeCompare(a.lastSeen));
  return { items: list, runsScanned: scan.length, warnings };
}

// ------------------------------------------------------------------ accept / reject

export interface HealRef {
  journeyId: string;
  stepId: string;
  healed: LocatorCandidate;
  tier: ReviewTier;
  runId?: string;
  original?: LocatorCandidate[];
  /** Repository element id: the heal is written into the element repository. */
  element?: string;
  /** Heal of a scope anchor (index): not rewritten automatically. */
  anchor?: number;
}

const TIERS = new Set(['T0-cache', 'T1-fingerprint', 'T2-semantic', 'T3-ai', 'improvement']);
const STRATEGIES = new Set(['role', 'label', 'text', 'testId', 'placeholder', 'altText', 'title', 'css', 'xpath', 'section']);

export function parseHealRefs(v: unknown): HealRef[] {
  if (!Array.isArray(v) || v.length === 0) throw new HttpError(400, '"items" must be a non-empty list of heals');
  if (v.length > 200) throw new HttpError(400, 'At most 200 heals at a time');
  return v.map((x, i) => {
    const o = x as Record<string, unknown>;
    const h = o.healed as Record<string, unknown> | undefined;
    if (typeof o.journeyId !== 'string' || typeof o.stepId !== 'string') throw new HttpError(400, `items[${i}]: journeyId and stepId are required`);
    if (!h || typeof h.strategy !== 'string' || !STRATEGIES.has(h.strategy) || typeof h.value !== 'string' || !h.value) throw new HttpError(400, `items[${i}]: a valid healed locator is required`);
    if (typeof o.tier !== 'string' || !TIERS.has(o.tier)) throw new HttpError(400, `items[${i}]: unknown tier`);
    const healed: LocatorCandidate = { strategy: h.strategy as LocatorCandidate['strategy'], value: h.value };
    if (typeof h.name === 'string') healed.name = h.name;
    if (typeof h.exact === 'boolean') healed.exact = h.exact;
    if (o.element !== undefined && (typeof o.element !== 'string' || !/^[\w.-]+$/.test(o.element))) throw new HttpError(400, `items[${i}]: element must be an element id`);
    return { journeyId: o.journeyId, stepId: o.stepId, healed, tier: o.tier as ReviewTier, runId: typeof o.runId === 'string' ? o.runId : undefined, original: Array.isArray(o.original) ? (o.original as LocatorCandidate[]) : undefined, ...(typeof o.element === 'string' ? { element: o.element } : {}), ...(typeof o.anchor === 'number' ? { anchor: o.anchor } : {}) };
  });
}

export interface AcceptPlan {
  plans: Array<HealRewritePlan & { ref: HealRef }>;
  /** Combined change per file (several heals in one file are applied in order). */
  files: Array<FileChange & { beforeHash: string }>;
  errors: Array<{ ref: HealRef; error: string }>;
}

/** Plan accepting a set of heals: per file, apply each heal to the text produced by the previous one. */
export async function planAccept(app: StudioApp, refs: HealRef[]): Promise<AcceptPlan> {
  const files = await journeyFiles(app);
  const state = new Map<string, { abs: string; display: string; original: string; current: string; sidecars: Map<string, { before: string; after: string; existed: boolean }> }>();
  const plans: AcceptPlan['plans'] = [];
  const errors: AcceptPlan['errors'] = [];
  const sidecarText = new Map<string, string>();
  const repo = refs.some((r) => r.element) ? await studioElements(app) : undefined;
  const elementsDir = (await elementsConfig(app)).dir;
  // Element files changed by earlier refs in this plan (several journeys healing one element, or one screen file).
  const elementText = new Map<string, { before: string; current: string; existed: boolean }>();
  for (const ref of refs) {
    if (ref.anchor !== undefined) {
      errors.push({ ref, error: 'This heal is of an anchor or container of a relative target (e.g. the text after "below"); edit that part of the step by hand. Until then the verified heal is replayed from the cache.' });
      continue;
    }
    if (ref.element) {
      const el = repo?.get(ref.element);
      if (!el) {
        errors.push({ ref, error: `No element "${ref.element}" in the element repository (${elementsDir}/)` });
        continue;
      }
      const display = elementHealFile(el, elementsDir);
      const abs = app.confine(display);
      let st = elementText.get(display);
      if (!st) {
        const existed = existsSync(abs);
        const text = existed ? await readFile(abs, 'utf8') : '';
        st = { before: text, current: text, existed };
        elementText.set(display, st);
      }
      try {
        // The element as planned so far, so two heals of one element chain (the second one is then already applied).
        const cur = el.source === 'screen' ? el : parseElementFile(st.current, el.file).elements.find((e) => e.id === el.id) ?? el;
        const plan = planElementHeal({ element: cur, healed: ref.healed, text: st.current, displayPath: display, existed: st.existed });
        for (const c of plan.changes) st.current = c.after;
        plans.push({ journeyId: ref.journeyId, stepId: ref.stepId, method: plan.method, summary: plan.summary, changes: plan.changes, notes: plan.notes, ref });
      } catch (e) {
        errors.push({ ref, error: (e as Error).message });
      }
      continue;
    }
    const f = files.find((x) => x.id === ref.journeyId);
    if (!f) {
      errors.push({ ref, error: `No journey file with id "${ref.journeyId}" in ${await app.journeysDir()}/` });
      continue;
    }
    const abs = await app.journeyPath(f.path);
    let st = state.get(abs);
    if (!st) {
      const text = await readFile(abs, 'utf8');
      st = { abs, display: f.path, original: text, current: text, sidecars: new Map() };
      state.set(abs, st);
    }
    try {
      const plan = await planHealRewrite({ file: abs, displayPath: f.path, text: st.current, journeyId: ref.journeyId, stepId: ref.stepId, healed: ref.healed });
      for (const c of plan.changes) {
        if (c.path === f.path) st.current = c.after;
        else {
          // Sidecar: chain through earlier planned sidecar text for this file.
          const sideAbs = resolve(app.cwd, c.path);
          const prev = sidecarText.get(sideAbs);
          if (prev !== undefined) {
            // Re-plan against the chained sidecar content by merging step entries.
            const merged = JSON.parse(prev) as { version: 1; steps: Record<string, unknown> };
            const mine = JSON.parse(c.after) as { steps: Record<string, unknown> };
            merged.steps[ref.stepId] = mine.steps[ref.stepId];
            sidecarText.set(sideAbs, JSON.stringify(merged, null, 2) + '\n');
          } else sidecarText.set(sideAbs, c.after);
          const s = st.sidecars.get(c.path) ?? { before: c.before, after: c.after, existed: c.existed };
          s.after = sidecarText.get(sideAbs)!;
          st.sidecars.set(c.path, s);
        }
      }
      plans.push({ ...plan, ref });
    } catch (e) {
      errors.push({ ref, error: (e as Error).message });
    }
  }
  const { unifiedDiff } = await import('../../heal/index.js');
  const out: AcceptPlan['files'] = [];
  for (const [display, st] of elementText) {
    if (st.current === st.before) continue;
    const diff = unifiedDiff(st.before, st.current);
    out.push({ path: display, existed: st.existed, before: st.before, after: st.current, diff, unified: render(display, diff, st.existed), beforeHash: sha(st.before) });
  }
  for (const st of state.values()) {
    if (st.current !== st.original) {
      const diff = unifiedDiff(st.original, st.current);
      out.push({ path: st.display, existed: true, before: st.original, after: st.current, diff, unified: render(st.display, diff, true), beforeHash: sha(st.original) });
    }
    for (const [p, s] of st.sidecars) {
      const diff = unifiedDiff(s.before, s.after);
      out.push({ path: p, existed: s.existed, before: s.before, after: s.after, diff, unified: render(p, diff, s.existed), beforeHash: sha(s.before) });
    }
  }
  return { plans, files: out, errors };
}

function render(path: string, d: FileChange['diff'], existed: boolean): string {
  return [`--- ${existed ? `a/${path}` : '/dev/null'}`, `+++ b/${path}`, ...d.map((l) => `${l.kind}${l.text}`)].join('\n') + '\n';
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

/**
 * Write an accepted plan. Every file must still hash to what the reviewer saw
 * (`expected`: path -> beforeHash); otherwise nothing is written (409).
 */
export async function writeAccept(app: StudioApp, refs: HealRef[], expected: Record<string, string>, reviewer: string, reason: string | undefined): Promise<{ written: string[]; accepted: HealRef[]; errors: AcceptPlan['errors']; plans: AcceptPlan['plans'] }> {
  const plan = await planAccept(app, refs);
  if (plan.errors.length && plan.plans.length === 0) throw new HttpError(422, plan.errors.map((e) => e.error).join('; '));
  for (const f of plan.files) {
    if (expected[f.path] !== f.beforeHash) throw new HttpError(409, `${f.path} changed since the preview; review the diff again`);
  }
  const confined = (p: string) => app.confine(p);
  for (const f of plan.files) await atomicWrite(confined(f.path), f.after);
  const paths = await qualityPaths(app);
  const decisions = await HealDecisions.open(paths.decisions);
  const store = await FingerprintStore.open(paths.fingerprints);
  const now = new Date().toISOString();
  const accepted: HealRef[] = [];
  for (const p of plan.plans) {
    const r = p.ref;
    decisions.record({ journeyId: r.journeyId, stepId: r.stepId, decision: 'accepted', tier: r.tier, locator: r.healed, original: r.original, reviewer, reason, decidedAt: now, runId: r.runId, file: p.changes[0]?.path, rewrite: p.method });
    // The healed locator is now the step's own locator: it is the last good one, and no longer a cached heal.
    // A repository element keeps its memory under @elements/<id> (one for every journey that uses it).
    const [mj, ms] = r.element ? [ELEMENTS_JOURNEY, r.element] : [r.journeyId, r.stepId];
    store.setLastGood(mj, ms, r.healed);
    store.clearHeal(mj, ms);
    accepted.push(r);
  }
  await decisions.save();
  await store.save();
  return { written: plan.files.map((f) => f.path), accepted, errors: plan.errors, plans: plan.plans };
}

export async function rejectHeals(app: StudioApp, refs: HealRef[], reviewer: string, reason: string): Promise<{ rejected: number; cacheCleared: number }> {
  const paths = await qualityPaths(app);
  const decisions = await HealDecisions.open(paths.decisions);
  const store = existsSync(paths.fingerprints) ? await FingerprintStore.open(paths.fingerprints) : undefined;
  const now = new Date().toISOString();
  let cleared = 0;
  for (const r of refs) {
    decisions.record({ journeyId: r.journeyId, stepId: r.stepId, decision: 'rejected', tier: r.tier, locator: r.healed, original: r.original, reviewer, reason, decidedAt: now, runId: r.runId });
    const mem = store?.get(r.journeyId, r.stepId);
    if (store && mem?.healed && (locatorKey(mem.healed.locator) === locatorKey(r.healed) || mem.healed.tier === r.tier)) {
      store.clearHeal(r.journeyId, r.stepId);
      cleared++;
    }
    if (store && mem?.lastGood && locatorKey(mem.lastGood) === locatorKey(r.healed)) store.setLastGood(r.journeyId, r.stepId, undefined);
  }
  await decisions.save();
  await store?.save();
  return { rejected: refs.length, cacheCleared: cleared };
}

export async function undoDecision(app: StudioApp, ref: HealRef): Promise<boolean> {
  const paths = await qualityPaths(app);
  const decisions = await HealDecisions.open(paths.decisions);
  const ok = decisions.remove(ref.journeyId, ref.stepId, ref.tier, ref.healed);
  if (ok) await decisions.save();
  return ok;
}

/** Atomic write helper shared with other quality modules. */
export { atomicWrite };
