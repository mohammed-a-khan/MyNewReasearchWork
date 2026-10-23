/**
 * Accepting a reviewed heal: write the healed locator into the journey file so
 * the next run passes without healing. Planning is pure (text in, text out);
 * nothing is written until the caller shows the diff and confirms.
 *
 * What happens per format (preference order):
 *
 *  `.ez`
 *   1. ez-phrase: the step's target phrase is rewritten to one the grammar
 *      turns back into the healed locator, e.g. `the "Submit order" button`
 *      -> `the "Place order" button`, or a selector form the grammar knows
 *      (`testid=place-order`, `#place-order`). The rewritten line is re-parsed
 *      and must keep the same action, value and capture key and resolve to the
 *      healed locator. The old step id is pinned with `[id=...]` so history,
 *      the fingerprint store and heal decisions keep matching.
 *   2. ez-sidecar: when no phrase expresses the locator (e.g. an arbitrary CSS
 *      path), the healed locator is added to `<file>.locators.json` next to the
 *      journey; the loader puts it first in the step's candidates. The `.ez`
 *      text is left untouched.
 *
 *  `.yaml` / `.yml` / `.json`
 *   1. a string step is rewritten like an `.ez` line (yaml-phrase / json-phrase);
 *   2. otherwise the step's `target` becomes (or stays) an object whose
 *      `locators` list starts with the healed locator (yaml-target /
 *      json-target); a string target keeps its text as the `description`.
 *      YAML comments and layout outside the step are preserved.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import YAML, { isMap, isScalar, isSeq, type Document, type YAMLMap } from 'yaml';
import type { Journey, LocatorCandidate, Step, StepInput } from '../core/index.js';
import { flattenSteps, Step as StepSchema } from '../core/index.js';
import { parseIntent, defaultStepId } from '../intent/parse.js';
import { parseEzScript } from '../intent/ezscript.js';
import { normalizeJourneyInput } from '../intent/load.js';
import { describeTarget } from '../intent/target.js';
import { locatorKey } from './decisions.js';

export type HealRewriteMethod = 'ez-phrase' | 'ez-sidecar' | 'yaml-phrase' | 'yaml-target' | 'json-phrase' | 'json-target'
  /** The step used a shared repository element: the element's entry in elements/*.yaml is rewritten (src/elements/heal.ts). */
  | 'element-yaml' | 'element-json' | 'element-override';

export interface DiffLine {
  kind: ' ' | '+' | '-';
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface FileChange {
  /** Path as given by the caller. */
  path: string;
  existed: boolean;
  before: string;
  after: string;
  /** Unified diff (3 lines of context). */
  diff: DiffLine[];
  unified: string;
}

export interface HealRewritePlan {
  journeyId: string;
  stepId: string;
  method: HealRewriteMethod;
  /** Plain-English summary for the confirmation dialog. */
  summary: string;
  changes: FileChange[];
  notes: string[];
  /** The rewritten step line, for phrase rewrites. */
  newLine?: string;
}

export interface LocatorSidecar {
  version: 1;
  steps: Record<string, { locators: LocatorCandidate[]; description?: string; acceptedAt?: string; note?: string }>;
}

/** Sidecar path for a journey file: `checkout.ez` -> `checkout.ez.locators.json`. */
export function sidecarPath(journeyFile: string): string {
  return `${journeyFile}.locators.json`;
}

/** Sidecars are not journeys (the journey loader skips them). */
export const SIDECAR_RE = /\.locators\.json$/i;

const same = (a: LocatorCandidate, b: LocatorCandidate) => locatorKey(a) === locatorKey(b);

// ------------------------------------------------------------------ diff

type Op = { op: 'eq'; i: number; j: number } | { op: 'del'; i: number } | { op: 'ins'; j: number };

/** Line diff via LCS over the changed middle (journey files are small). */
function diffSequences(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  const W = m + 1;
  const dp = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * W + j] = A[i] === B[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
  const ops: Op[] = [];
  for (let k = 0; k < pre; k++) ops.push({ op: 'eq', i: k, j: k });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      ops.push({ op: 'eq', i: i + pre, j: j + pre });
      i++;
      j++;
    } else if (i < n && (j === m || dp[(i + 1) * W + j] >= dp[i * W + j + 1])) {
      ops.push({ op: 'del', i: i + pre });
      i++;
    } else {
      ops.push({ op: 'ins', j: j + pre });
      j++;
    }
  }
  for (let k = 0; k < suf; k++) ops.push({ op: 'eq', i: a.length - suf + k, j: b.length - suf + k });
  return ops;
}

export function unifiedDiff(before: string, after: string, context = 3): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const ops = diffSequences(a, b);
  const all: DiffLine[] = ops.map((o) =>
    o.op === 'eq' ? { kind: ' ', text: a[o.i], oldNo: o.i + 1, newNo: o.j + 1 } : o.op === 'del' ? { kind: '-', text: a[o.i], oldNo: o.i + 1 } : { kind: '+', text: b[o.j], newNo: o.j + 1 },
  );
  const keep = new Set<number>();
  all.forEach((l, i) => {
    if (l.kind === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(all.length - 1, i + context); k++) keep.add(k);
  });
  return all.filter((_, i) => keep.has(i));
}

function renderUnified(path: string, d: DiffLine[], existed: boolean): string {
  const head = [`--- ${existed ? `a/${path}` : '/dev/null'}`, `+++ b/${path}`];
  return [...head, ...d.map((l) => `${l.kind}${l.text}`)].join('\n') + '\n';
}

function change(path: string, before: string, after: string, existed = true): FileChange {
  const diff = unifiedDiff(before, after);
  return { path, existed, before, after, diff, unified: renderUnified(path, diff, existed) };
}

// ------------------------------------------------------------------ phrases

const ROLE_WORD: Record<string, string> = {
  button: 'button', link: 'link', tab: 'tab', heading: 'heading', checkbox: 'checkbox', radio: 'radio button', switch: 'switch',
  slider: 'slider', menuitem: 'menu item', option: 'option', cell: 'cell', combobox: 'dropdown', textbox: 'field', img: 'image',
  dialog: 'dialog', region: 'region', navigation: 'navigation', list: 'list', searchbox: 'field', spinbutton: 'field',
};

const q = (s: string) => (s.includes('"') ? (s.includes("'") ? undefined : `'${s}'`) : `"${s}"`);

/** Target phrases the grammar may turn into the healed locator, most natural first. */
export function phrasesFor(healed: LocatorCandidate, action: string): string[] {
  const out: string[] = [];
  const name = healed.strategy === 'role' ? healed.name : healed.value;
  const n = name ? q(name) : undefined;
  if (n) {
    if (healed.strategy === 'role' && ROLE_WORD[healed.value]) out.push(`the ${n} ${ROLE_WORD[healed.value]}`);
    if (healed.strategy === 'label' || healed.strategy === 'placeholder') {
      if (action === 'select') out.push(`the ${n} dropdown`);
      if (action === 'check' || action === 'uncheck') out.push(`the ${n} checkbox`, `the ${n} radio button`, `the ${n} switch`);
      out.push(`the ${n} field`, `the ${n} dropdown`, `the ${n} checkbox`);
    }
    if (healed.strategy === 'altText') out.push(`the ${n} image`);
    if (healed.strategy === 'text') out.push(`the ${n} text`, n, `the ${n} button`, `the ${n} link`);
    if (healed.strategy === 'title') out.push(n);
  }
  if (healed.strategy === 'testId' && /^[\w.:-]+$/.test(healed.value)) out.push(`testid=${healed.value}`);
  if (healed.strategy === 'css' && /^#[A-Za-z][\w-]*$/.test(healed.value)) out.push(healed.value);
  return [...new Set(out)];
}

interface StepShape {
  action: string;
  value?: string;
  captureAs?: string;
  locators: LocatorCandidate[];
}

function shapeOf(s: StepInput | Step): StepShape {
  const p = StepSchema.parse({ ...s, id: 'x', intent: 'x', postconditions: [] });
  return { action: p.action, value: p.value, captureAs: p.captureAs, locators: p.target?.locators ?? [] };
}

const ANN_RE = /\s*\[((?:\s*(?:id\s*=\s*[\w.-]+|optional|timeout\s*=\s*\d+(?:\.\d+)?\s*(?:ms|s|m)?|risk\s*=\s*[1-5])\s*)+)\]\s*$/i;

/** Pin `id` on a step line (adds or extends the trailing `[...]` annotation). */
function pinId(line: string, id: string): string {
  const m = ANN_RE.exec(line);
  if (m) {
    if (/\bid\s*=/.test(m[1])) return line;
    return `${line.slice(0, m.index)} [id=${id} ${m[1].trim()}]`;
  }
  return `${line.replace(/\s+$/, '')} [id=${id}]`;
}

/**
 * Rewrite one step line so its target resolves to `healed`. Returns undefined when no
 * phrase does it while keeping the step's meaning.
 */
export function rewriteStepLine(line: string, step: Step, healed: LocatorCandidate): { line: string; phrase: string; first: boolean } | undefined {
  const desc = step.target?.description;
  if (!desc) return undefined;
  const at = line.indexOf(desc);
  if (at < 0 || line.indexOf(desc, at + 1) >= 0) return undefined;
  const want = shapeOf(step);
  for (const phrase of phrasesFor(healed, step.action)) {
    let candidate = line.slice(0, at) + phrase + line.slice(at + desc.length);
    let parsed: StepInput;
    try {
      parsed = parseIntent(candidate);
    } catch {
      continue;
    }
    const got = shapeOf(parsed);
    if (got.action !== want.action || got.value !== want.value || got.captureAs !== want.captureAs) continue;
    const idx = got.locators.findIndex((l) => same(l, healed));
    if (idx < 0) continue;
    if ((parsed.id ?? defaultStepId(parsed.intent)) !== step.id) candidate = pinId(candidate, step.id);
    // Re-check after pinning.
    const final = parseIntent(candidate);
    if (final.id !== step.id) continue;
    return { line: candidate, phrase, first: idx === 0 };
  }
  return undefined;
}

// ------------------------------------------------------------------ .ez

/**
 * Find the 0-based line of a step in an .ez script, including steps nested in
 * blocks (If / loops / try / frame blocks). Each line that parses as a step is
 * matched by its id; duplicate ids ("click-x-2") pick the n-th occurrence.
 */
export function ezStepLine(text: string, step: Step): number | undefined {
  const lines = text.split(/\r?\n/);
  const m = /^(.*)-(\d+)$/.exec(step.id);
  const exact: number[] = [];
  const byBase: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    if (step.target?.description && !line.includes(step.target.description)) continue;
    let id: string | undefined;
    try {
      id = parseIntent(line).id;
    } catch {
      continue;
    }
    if (id === step.id) exact.push(i);
    else if (m && id === m[1]) byBase.push(i);
  }
  if (exact.length === 1) return exact[0];
  if (m && !exact.length) {
    // The parser numbers repeats 2, 3, ...: the first occurrence keeps the base id.
    const all = byBase;
    return all[Number(m[2]) - 1];
  }
  return exact[0];
}

async function readSidecar(path: string): Promise<{ text: string; data: LocatorSidecar; existed: boolean }> {
  if (!existsSync(path)) return { text: '', data: { version: 1, steps: {} }, existed: false };
  const text = await readFile(path, 'utf8');
  const data = JSON.parse(text) as LocatorSidecar;
  if (data.version !== 1 || typeof data.steps !== 'object') throw new Error(`${basename(path)} has an unknown format`);
  return { text, data, existed: true };
}

function sidecarChange(displayPath: string, side: { text: string; data: LocatorSidecar; existed: boolean }, step: Step, healed: LocatorCandidate, now: string): FileChange {
  const cur = side.data.steps[step.id]?.locators ?? [];
  const next: LocatorSidecar = {
    version: 1,
    steps: {
      ...side.data.steps,
      [step.id]: { description: step.target?.description, locators: [healed, ...cur.filter((l) => !same(l, healed))], acceptedAt: now, note: 'accepted heal (EZTest Studio)' },
    },
  };
  return change(displayPath, side.text, JSON.stringify(next, null, 2) + '\n', side.existed);
}

export interface PlanInput {
  /** Absolute path of the journey file (used to read the sidecar). */
  file: string;
  /** Path shown in diffs (e.g. relative to the project). */
  displayPath: string;
  text: string;
  journeyId: string;
  stepId: string;
  healed: LocatorCandidate;
  now?: string;
}

/** Plan the file changes that accept a heal. Throws when the step is not in the file. */
export async function planHealRewrite(i: PlanInput): Promise<HealRewritePlan> {
  const now = i.now ?? new Date().toISOString();
  const lower = i.file.toLowerCase();
  if (lower.endsWith('.ez')) return planEz(i, now);
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return planStructured(i, 'yaml', now);
  if (lower.endsWith('.json')) return planStructured(i, 'json', now);
  throw new Error(`Cannot rewrite ${basename(i.file)}: not a journey file`);
}

async function planEz(i: PlanInput, now: string): Promise<HealRewritePlan> {
  const journey = parseEzScript(i.text, { source: basename(i.file) });
  if (journey.id !== i.journeyId) throw new Error(`${i.displayPath} holds journey "${journey.id}", not "${i.journeyId}"`);
  const step = flattenSteps(journey.steps).find((s) => s.id === i.stepId);
  if (!step) throw new Error(`Step "${i.stepId}" is not in ${i.displayPath}`);
  const lineNo = ezStepLine(i.text, step);
  const eol = i.text.includes('\r\n') ? '\r\n' : '\n';
  const lines = i.text.split(/\r?\n/);
  const notes: string[] = [];
  if (lineNo !== undefined) {
    const raw = lines[lineNo];
    const indent = /^\s*/.exec(raw)![0];
    const r = rewriteStepLine(raw.trim(), step, i.healed);
    if (r) {
      lines[lineNo] = indent + r.line;
      const after = lines.join(eol);
      // The whole file must still parse to the same journey id and step ids.
      const back = parseEzScript(after, { source: basename(i.file) });
      const idsOf = (j: Journey) => flattenSteps(j.steps).map((s) => s.id).join('|');
      const nb = flattenSteps(back.steps).find((s) => s.id === step.id);
      if (back.id === journey.id && idsOf(back) === idsOf(journey) && nb?.target?.locators.some((l) => same(l, i.healed))) {
        if (!r.first) notes.push('the healed locator is not the first candidate of the new phrase; an earlier candidate may match first');
        if (/^(?:testid=|#)/.test(r.phrase)) notes.push('the new phrase is a selector; the human description of the element is replaced by it');
        return {
          journeyId: i.journeyId,
          stepId: i.stepId,
          method: 'ez-phrase',
          summary: `Rewrite line ${lineNo + 1}: ${step.target?.description} -> ${r.phrase}`,
          changes: [change(i.displayPath, i.text, after)],
          notes,
          newLine: r.line,
        };
      }
      notes.push('a phrase rewrite changed other step ids; using the sidecar instead');
    } else notes.push('no target phrase expresses the healed locator; it is added to the sidecar instead');
  } else notes.push('the step line could not be located; the healed locator goes to the sidecar');
  const sp = sidecarPath(i.file);
  const side = await readSidecar(sp);
  return {
    journeyId: i.journeyId,
    stepId: i.stepId,
    method: 'ez-sidecar',
    summary: `Add the healed locator to ${basename(sp)} for step ${i.stepId} (the .ez text is unchanged)`,
    changes: [sidecarChange(sidecarPath(i.displayPath), side, step, i.healed, now)],
    notes,
  };
}

async function planStructured(i: PlanInput, fmt: 'yaml' | 'json', _now: string): Promise<HealRewritePlan> {
  const doc: Document | undefined = fmt === 'yaml' ? YAML.parseDocument(i.text) : undefined;
  const raw: unknown = fmt === 'yaml' ? doc!.toJS() : JSON.parse(i.text);
  const journey = normalizeJourneyInput(raw, basename(i.file).replace(/\.[^.]+$/, ''));
  if (journey.id !== i.journeyId) throw new Error(`${i.displayPath} holds journey "${journey.id}", not "${i.journeyId}"`);
  const idx = journey.steps.findIndex((s) => s.id === i.stepId);
  if (idx < 0) {
    if (flattenSteps(journey.steps).some((s) => s.id === i.stepId)) throw new Error(`Step "${i.stepId}" is nested in a block of ${i.displayPath}; YAML/JSON nested steps are not rewritten automatically - edit its target by hand`);
    throw new Error(`Step "${i.stepId}" is not in ${i.displayPath}`);
  }
  const step = journey.steps[idx];
  const rawStep = (raw as { steps: unknown[] }).steps[idx];
  const notes: string[] = [];
  const healedObj = (): Record<string, unknown> => ({ ...i.healed });
  let method: HealRewriteMethod;
  let summary: string;
  let after: string;

  const phrase = typeof rawStep === 'string' ? rewriteStepLine(rawStep, step, i.healed) : undefined;
  if (phrase) {
    method = fmt === 'yaml' ? 'yaml-phrase' : 'json-phrase';
    summary = `Rewrite step ${idx + 1}: ${step.target?.description} -> ${phrase.phrase}`;
    if (!phrase.first) notes.push('the healed locator is not the first candidate of the new phrase');
    if (fmt === 'yaml') {
      (doc!.get('steps') as { set(k: number, v: unknown): void }).set(idx, phrase.line);
      after = doc!.toString();
    } else {
      (raw as { steps: unknown[] }).steps[idx] = phrase.line;
      after = JSON.stringify(raw, null, detectIndent(i.text)) + '\n';
    }
  } else {
    method = fmt === 'yaml' ? 'yaml-target' : 'json-target';
    summary = `Put the healed locator first in step ${idx + 1}'s target locators`;
    // Build the new step object: keep everything, make target an object with the healed locator first.
    const cur = step.target!;
    const locators = [i.healed, ...cur.locators.filter((l) => !same(l, i.healed))];
    if (typeof rawStep === 'string') {
      notes.push('the plain-English step became an object so it can carry its locators; its id is pinned');
      const obj = { id: step.id, intent: rawStep, target: { description: cur.description, locators } };
      if (fmt === 'yaml') (doc!.get('steps') as { set(k: number, v: unknown): void }).set(idx, doc!.createNode(obj));
      else (raw as { steps: unknown[] }).steps[idx] = obj;
    } else {
      const so = rawStep as Record<string, unknown>;
      const t = so.target;
      if (fmt === 'yaml') {
        const node = (doc!.get('steps') as { get(k: number, keep: true): unknown }).get(idx, true) as YAMLMap;
        if (!isMap(node)) throw new Error('unexpected YAML step node');
        if (t && typeof t === 'object' && !Array.isArray(t)) {
          const tn = node.get('target', true) as unknown as YAMLMap;
          const ls = tn.get('locators', true);
          if (isSeq(ls)) {
            // Drop an existing equal locator, then insert the healed one first.
            ls.items = ls.items.filter((it) => !(isMap(it) && same(it.toJSON() as LocatorCandidate, i.healed)));
            ls.items.unshift(doc!.createNode(healedObj()) as never);
          } else tn.set('locators', doc!.createNode(locators));
        } else {
          const description = isScalar(node.get('target', true)) ? String(t) : cur.description;
          if (typeof t !== 'string') notes.push('the step had no explicit target; one was added from its intent');
          node.set('target', doc!.createNode({ description, locators: typeof t === 'string' ? [i.healed, ...describeTarget(t).locators.filter((l) => !same(l, i.healed))] : locators }));
        }
        if (so.id === undefined) node.set('id', step.id);
      } else {
        if (t && typeof t === 'object' && !Array.isArray(t)) {
          const to = t as { locators?: LocatorCandidate[] };
          to.locators = [healedObj() as LocatorCandidate, ...(to.locators ?? []).filter((l) => !same(l, i.healed))];
        } else {
          so.target = { description: typeof t === 'string' ? t : cur.description, locators: typeof t === 'string' ? [i.healed, ...describeTarget(t).locators.filter((l) => !same(l, i.healed))] : locators };
        }
        if (so.id === undefined) so.id = step.id;
      }
    }
    after = fmt === 'yaml' ? doc!.toString() : JSON.stringify(raw, null, detectIndent(i.text)) + '\n';
  }
  // Verify: same journey, same step ids, and the step now lists the healed locator first or in its phrase.
  const back = normalizeJourneyInput(fmt === 'yaml' ? YAML.parse(after) : JSON.parse(after), basename(i.file).replace(/\.[^.]+$/, ''));
  if (back.id !== journey.id || flattenSteps(back.steps).map((s) => s.id).join('|') !== flattenSteps(journey.steps).map((s) => s.id).join('|')) {
    throw new Error('The rewrite would change the journey id or step ids; edit the file by hand');
  }
  const ns = back.steps[idx];
  if (!ns.target?.locators.some((l) => same(l, i.healed))) throw new Error('The rewrite did not take effect; edit the file by hand');
  return { journeyId: i.journeyId, stepId: i.stepId, method, summary, changes: [change(i.displayPath, i.text, after)], notes, newLine: phrase?.line };
}

function detectIndent(text: string): number {
  const m = /\n( +)"/.exec(text);
  return m ? m[1].length : 2;
}

/** Merge a locator sidecar into a loaded journey: sidecar locators go first in each step's target. */
export function applyLocatorSidecar(journey: Journey, side: LocatorSidecar): Journey {
  if (!side?.steps) return journey;
  const map = (steps: Step[] | undefined): Step[] | undefined =>
    steps?.map((s) => {
      const hint = side.steps[s.id];
      const nested = { ...s, ...(s.steps ? { steps: map(s.steps) } : {}), ...(s.else ? { else: map(s.else) } : {}), ...(s.catch ? { catch: map(s.catch) } : {}) };
      if (!hint?.locators?.length || !s.target) return nested;
      return { ...nested, target: { ...s.target, locators: [...hint.locators, ...s.target.locators.filter((l) => !hint.locators.some((h) => same(h, l)))] } };
    });
  return { ...journey, steps: map(journey.steps)! };
}

/** Load the sidecar of a journey file, if any. A broken sidecar is an error (it would hide a reviewed fix). */
export async function loadLocatorSidecar(journeyFile: string): Promise<LocatorSidecar | undefined> {
  const p = sidecarPath(journeyFile);
  if (!existsSync(p)) return undefined;
  const data = JSON.parse(await readFile(p, 'utf8')) as LocatorSidecar;
  if (data.version !== 1 || typeof data.steps !== 'object') throw new Error(`${basename(p)} has an unknown format`);
  return data;
}
