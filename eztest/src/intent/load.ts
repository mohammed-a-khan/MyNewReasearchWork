/**
 * Loading journeys from disk: `.ez` scripts, YAML and JSON. YAML/JSON steps
 * may be written as plain-English strings, or as objects whose missing fields
 * are filled from their `intent`; `expect:` lists of phrases become
 * post-conditions and a string `target:` is described with describeTarget.
 */
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import YAML from 'yaml';
import { EzTestError, Journey, NotSupportedError, slugify, type Condition, type StepInput } from '../core/index.js';
import { parseCondition } from './conditions.js';
import { examplesSourceFromObject } from './examples-source.js';
import { parseEzScript } from './ezscript.js';
import { defaultStepId, parseIntent } from './parse.js';
import { describeTarget } from './target.js';
import { querySugarIntent } from './rules-queries.js';
import { storeSugarIntent } from '../store/rules.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const list = (v: unknown, what: string): unknown[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new EzTestError(`"${what}" must be a list of steps`, 'BAD_STEP');
  return v;
};
const q = (v: unknown) => {
  const s = String(v);
  return !s.includes('"') ? `"${s}"` : `'${s}'`;
};

/**
 * Block sugar for YAML/JSON:
 *   - if: the cookie banner is visible        - repeat: 3            - forEach: ${orders.body}   - while: the "More" button is visible
 *     then: [Click the "Accept" button]          steps: [Press Tab]     as: order                   max: 20
 *     else: [...]                                                      steps: [...]               steps: [...]
 *   - forEach: { data: users.csv, as: user }    - retry: 3             - try: [...]               - frame: payment
 *     steps: [...]                                steps: [...]           onFailure: [...]           steps: [...]
 *   - group: Checkout                           - runJourney: login    (with: { role: manager }, as: result)
 */
function sugar(s: Obj): Obj | undefined {
  const kids = (k: string) => list(s[k], k);
  if (s.if !== undefined || s.unless !== undefined) {
    const neg = s.if === undefined;
    return { intent: `${neg ? 'Unless' : 'If'} ${String(neg ? s.unless : s.if)} then`, steps: kids('then').length ? kids('then') : kids('steps'), else: s.else, rest: s };
  }
  if (s.repeat !== undefined) return { intent: `Repeat ${String(s.repeat)} times${s.as ? ` as ${String(s.as)}` : ''}`, steps: kids('steps').length ? kids('steps') : kids('do'), rest: s };
  const fe = s.forEach ?? s['for each'] ?? s.foreach;
  if (fe !== undefined) {
    const as = String(s.as ?? (isObj(fe) && fe.as) ?? (isObj(fe) && fe.data ? 'row' : 'item'));
    const head = isObj(fe) && fe.data !== undefined
      ? `For each ${as} in data ${q(fe.data)}${fe.sheet ? ` sheet ${q(fe.sheet)}` : ''}`
      : `For each ${as} in ${String(fe)}`;
    return { intent: head, steps: kids('steps').length ? kids('steps') : kids('do'), rest: s };
  }
  if (s.while !== undefined || s.until !== undefined) {
    const max = s.max ?? s.maxIterations;
    return { intent: `${s.while !== undefined ? 'While' : 'Repeat until'} ${String(s.while ?? s.until)}${max ? ` at most ${String(max)} times` : ''}`, steps: kids('steps').length ? kids('steps') : kids('do'), rest: s };
  }
  if (s.retry !== undefined) return { intent: `Retry up to ${String(s.retry)} times${s.every ? ` every ${String(s.every)}` : ''}`, steps: kids('steps'), rest: s };
  if (s.try !== undefined) return { intent: 'Try', steps: list(s.try, 'try'), catch: s.onFailure ?? s.catch ?? s.on_failure, rest: s };
  if (s.group !== undefined) return { intent: `Group ${q(s.group)}`, steps: kids('steps'), rest: s };
  const fr = s.frame ?? s.inFrame;
  if (fr !== undefined && s.action === undefined) {
    const path = (Array.isArray(fr) ? fr : [fr]).map(q).join(' > ');
    return { intent: `In frame ${path}`, steps: kids('steps'), rest: s };
  }
  const nq = querySugarIntent(s);
  if (nq) return { intent: nq, steps: undefined, rest: s };
  const st = storeSugarIntent(s);
  if (st) return { intent: st, steps: undefined, rest: s };
  const rc = s.runCode;
  if (rc !== undefined && s.action === undefined && typeof rc === 'string') {
    const w = isObj(s.with) ? Object.entries(s.with).map(([k, v]) => `${k}=${q(v)}`).join(', ') : '';
    return { intent: `Run code ${q(rc)}${w ? ` with ${w}` : ''}${s.as ? ` as ${String(s.as)}` : ''}`, steps: undefined, rest: s };
  }
  const rj = s.runJourney ?? s.run;
  if (rj !== undefined && s.action === undefined) {
    const w = isObj(s.with) ? Object.entries(s.with).map(([k, v]) => `${k}=${q(v)}`).join(', ') : '';
    return { intent: `Run journey ${q(rj)}${w ? ` with ${w}` : ''}${s.as ? ` and store the result as ${String(s.as)}` : ''}`, steps: undefined, rest: s };
  }
  // Multi-actor journeys (docs/multi-actor.md): `- as: manager` + steps, `- switchTo: bob`, `- parallel: [...]`.
  const actor = s.actor ?? (s.as !== undefined && s.steps !== undefined ? s.as : undefined);
  if (actor !== undefined && s.action === undefined) return { intent: `As ${String(actor)}:`, steps: kids('steps'), rest: s };
  const sw = s.switchTo ?? s['switch to user'] ?? s.switchToUser;
  if (sw !== undefined && s.action === undefined) return { intent: `Switch to user ${q(sw)}`, steps: undefined, rest: s };
  if (s.parallel !== undefined && s.action === undefined) return { intent: 'In parallel:', steps: list(s.parallel, 'parallel'), rest: s };
  return undefined;
}

const SUGAR_KEYS = new Set(['if', 'unless', 'then', 'repeat', 'do', 'forEach', 'for each', 'foreach', 'while', 'until', 'max', 'maxIterations', 'retry', 'every',
  'try', 'onFailure', 'on_failure', 'group', 'frame', 'inFrame', 'runJourney', 'run', 'runCode', 'with', 'as', 'query', 'on', 'returns', 'within', 'capture',
  'actor', 'switchTo', 'switch to user', 'switchToUser', 'parallel', 'store', 'sharedStore', 'pool']);

function normaliseStep(raw: unknown, index: number): StepInput {
  if (typeof raw === 'string') return parseIntent(raw);
  if (!isObj(raw)) throw new EzTestError(`Step ${index + 1} must be a string or an object`, 'BAD_STEP');
  const sg = sugar(raw);
  if (sg) {
    const base = parseIntent(String(sg.intent), { id: typeof raw.id === 'string' ? raw.id : undefined });
    const rest = Object.fromEntries(Object.entries(raw).filter(([k]) => !SUGAR_KEYS.has(k) && k !== 'steps' && k !== 'else' && k !== 'catch'));
    const step = normaliseStep({ ...base, ...rest, ...(sg.steps !== undefined ? { steps: sg.steps } : {}), ...(sg.else !== undefined ? { else: sg.else } : {}), ...(sg.catch !== undefined ? { catch: sg.catch } : {}) }, index);
    return step;
  }
  const s: Obj = { ...raw };
  // Child blocks: steps / else / catch lists are normalised like top-level steps.
  for (const k of ['steps', 'else', 'catch'] as const) {
    if (s[k] !== undefined) s[k] = list(s[k], k).map((c, i) => normaliseStep(c, i));
  }
  if (s.action === undefined) {
    if (typeof s.intent !== 'string') throw new EzTestError(`Step ${index + 1} needs an "intent" or an "action"`, 'BAD_STEP');
    const parsed = parseIntent(s.intent, { id: typeof s.id === 'string' ? s.id : undefined });
    for (const [k, v] of Object.entries(parsed)) if (s[k] === undefined) s[k] = v;
  }
  if (typeof s.to === 'string') s.to = describeTarget(s.to);
  if (typeof s.target === 'string') s.target = describeTarget(s.target);
  const conds: Condition[] = Array.isArray(s.postconditions) ? (s.postconditions as Condition[]) : [];
  if (s.expect !== undefined) {
    const list = Array.isArray(s.expect) ? s.expect : [s.expect];
    for (const e of list) conds.push(typeof e === 'string' ? parseCondition(e) : (e as Condition));
    delete s.expect;
  }
  s.postconditions = conds;
  if (s.id === undefined) s.id = defaultStepId(String(s.intent ?? `step-${index + 1}`));
  if (s.intent === undefined) s.intent = String(s.id);
  return s as unknown as StepInput;
}

/** Turn a loosely written journey object (YAML/JSON) into a validated Journey. */
export function normalizeJourneyInput(raw: unknown, fallbackId?: string): Journey {
  if (!isObj(raw)) throw new EzTestError('A journey file must contain one journey object', 'BAD_JOURNEY');
  const j: Obj = { ...raw };
  if (typeof j.name !== 'string' && typeof j.journey === 'string') {
    j.name = j.journey;
    delete j.journey;
  }
  if (!Array.isArray(j.steps)) throw new EzTestError('Journey needs a "steps" list', 'BAD_JOURNEY');
  const seen = new Map<string, number>();
  // Step ids are unique across the whole tree (nested block steps included), in document order.
  const register = (step: StepInput) => {
    const n = (seen.get(step.id) ?? 0) + 1;
    seen.set(step.id, n);
    if (n > 1) step.id = `${step.id}-${n}`;
    for (const c of [...(step.steps ?? []), ...(step.else ?? []), ...(step.catch ?? [])]) register(c);
  };
  j.steps = (j.steps as unknown[]).map((st, i) => {
    const step = normaliseStep(st, i);
    register(step);
    return step;
  });
  // `examples: { from: rows.json, where: ... }` (or `{ query: NAME, on: conn }`) is an external Examples source.
  if (isObj(j.examples)) {
    try {
      j.examplesFrom = examplesSourceFromObject(j.examples);
    } catch (e) {
      throw new EzTestError(`Invalid journey: ${(e as Error).message}`, 'BAD_JOURNEY');
    }
    delete j.examples;
  }
  if (Array.isArray(j.tags)) j.tags = (j.tags as unknown[]).map((t) => String(t).replace(/^@/, ''));
  // `actors: { manager: approver }` is shorthand for `{ manager: { role: approver } }`; a list names plain web users.
  if (Array.isArray(j.actors)) j.actors = Object.fromEntries((j.actors as unknown[]).map((a) => [String(a), {}]));
  if (isObj(j.actors)) j.actors = Object.fromEntries(Object.entries(j.actors).map(([k, v]) => [k, typeof v === 'string' ? { role: v } : v ?? {}]));
  if (typeof j.browsers === 'string') j.browsers = j.browsers.split(/[,\s]+/).filter(Boolean);
  if (j.id === undefined) j.id = typeof j.name === 'string' ? slugify(j.name) : fallbackId;
  const r = Journey.safeParse(j);
  if (!r.success) {
    throw new EzTestError(`Invalid journey: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'BAD_JOURNEY');
  }
  return r.data;
}

/** Load a journey from `.ez`, `.yaml`/`.yml` or `.json`. */
export async function loadJourneyFile(path: string): Promise<Journey> {
  const ext = extname(path).toLowerCase();
  const text = await readFile(path, 'utf8');
  const fallbackId = slugify(basename(path, ext));
  switch (ext) {
    case '.ez':
      return parseEzScript(text, { source: basename(path) });
    case '.yaml':
    case '.yml':
      return normalizeJourneyInput(YAML.parse(text), fallbackId);
    case '.json':
      return normalizeJourneyInput(JSON.parse(text), fallbackId);
    default:
      throw new NotSupportedError(`journey file type "${ext}" (use .ez, .yaml, .yml or .json)`);
  }
}
