/**
 * The structured step model behind the Studio's visual step view.
 *
 * `journeyModel` turns journey text into step cards (action, target, value,
 * post-conditions). `applySteps` takes the edited card list (kept, edited,
 * inserted, reordered, duplicated or deleted steps) and produces new file
 * text. For `.ez` files the edit is done on the file's own lines, so headers,
 * comments and untouched steps stay byte-for-byte; YAML and JSON journeys are
 * rebuilt through the journey model and serialized again.
 */
import YAML from 'yaml';
import { Journey, Step, type Condition } from '../core/index.js';
import { conditionToText, matchesPluginRule, parseCondition, parseIntent, IntentParseError } from '../intent/index.js';
import { HttpError } from './http.js';
import { parseJourneyText, validateText, type JourneyFormat, type ValidationResult } from './authoring.js';

const HEADER = /^(journey|name|id|tags|role|requirements?|risk|base\s*url|variables|vars|description|lenses|data)\s*:\s*(.*)$/i;
const EXPECT = /^(?:(?:then|and|also)\s+)?(?:expect|verify)\s+(?:that\s+)?(.+)$/i;

export interface StepCard {
  index: number;
  id: string;
  /** The step's plain-English line (with `[...]` annotations for .ez). */
  text: string;
  /** Expectation phrases (without the leading "Expect"). */
  expects: string[];
  action: string;
  target?: string;
  value?: string;
  captureAs?: string;
  optional: boolean;
  /** 1-based first and last line of the step in an .ez file. */
  line?: number;
  endLine?: number;
}

export interface JourneyModel {
  ok: boolean;
  format: JourneyFormat;
  header?: { id: string; name: string; tags: string[]; risk: number; requirements: string[]; role?: string; description?: string };
  steps: StepCard[];
  validation: ValidationResult;
}

/** One entry of the edited step list: `from` keeps an existing step; `text` (re)defines one. */
export interface StepEdit {
  from?: number;
  text?: string;
  expects?: string[];
}

interface Segment {
  /** 0-based step line; the segment runs to the next step line (exclusive), so trailing comments move with the step. */
  stepLine: number;
  end: number;
}

/** Split .ez lines into the header block (before the first step) and one segment per step. */
function segments(lines: string[]): { headerEnd: number; segs: Segment[] } {
  const segs: Segment[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (isCommentOrBlank(t)) continue;
    if (!segs.length && HEADER.test(t)) continue;
    if (segs.length && EXPECT.test(t) && !matchesPluginRule(t)) continue;
    if (segs.length) segs[segs.length - 1].end = i;
    segs.push({ stepLine: i, end: lines.length });
  }
  return { headerEnd: segs[0]?.stepLine ?? lines.length, segs };
}

function isCommentOrBlank(l: string): boolean {
  const t = l.trim();
  return !t || t.startsWith('#') || t.startsWith('//');
}

function condText(c: Condition): string {
  try {
    return conditionToText(c);
  } catch {
    return c.type;
  }
}

/** Number of post-conditions a step line produces by itself (e.g. "Wait until the URL contains ..."). */
function impliedConditions(text: string): number {
  try {
    return Step.parse(parseIntent(text)).postconditions.length;
  } catch {
    return 0;
  }
}

function card(step: Step, index: number, text: string, expects: string[], range?: { line: number; endLine: number }): StepCard {
  return {
    index, id: step.id, text, expects, action: step.action, target: step.target?.description, value: step.value,
    captureAs: step.captureAs, optional: step.optional, ...(range ?? {}),
  };
}

export function journeyModel(text: string, format: JourneyFormat): JourneyModel {
  const validation = validateText(text, format);
  if (!validation.ok) return { ok: false, format, steps: [], validation };
  const j = parseJourneyText(text, format);
  const header = { id: j.id, name: j.name, tags: j.tags, risk: j.risk, requirements: j.requirements, role: j.role, description: j.description };
  if (format === 'ez') {
    const lines = text.split(/\r?\n/);
    const { segs } = segments(lines);
    const steps = j.steps.map((s, i) => {
      const seg = segs[i];
      const stepLine = seg ? lines[seg.stepLine].trim() : s.intent;
      const expects = seg
        ? lines.slice(seg.stepLine + 1, seg.end).map((l) => EXPECT.exec(l.trim())?.[1]).filter((x): x is string => !!x)
        : s.postconditions.map(condText);
      let last = seg ? seg.stepLine : 0;
      if (seg) for (let k = seg.stepLine; k < seg.end; k++) if (!isCommentOrBlank(lines[k])) last = k;
      return card(s, i, stepLine, expects, seg ? { line: seg.stepLine + 1, endLine: last + 1 } : undefined);
    });
    return { ok: true, format, header, steps, validation };
  }
  const steps = j.steps.map((s, i) => card(s, i, s.intent, s.postconditions.slice(impliedConditions(s.intent)).map(condText)));
  return { ok: true, format, header, steps, validation };
}

/** Parse an edited step (line plus expectations) or fail with the reason and suggestions, pointing at the card. */
function buildStep(edit: StepEdit, index: number): Step {
  const text = String(edit.text ?? '').trim();
  if (!text) throw new HttpError(422, `Step ${index + 1} is empty`, { index });
  let step: Step;
  try {
    step = Step.parse(parseIntent(text));
  } catch (e) {
    const suggestions = e instanceof IntentParseError ? e.suggestions : [];
    throw new HttpError(422, `Step ${index + 1}: ${(e as Error).message}`, { index, suggestions });
  }
  for (const x of edit.expects ?? []) {
    const phrase = String(x).trim().replace(/^(?:expect|verify)\s+/i, '');
    if (!phrase) continue;
    try {
      step.postconditions.push(parseCondition(phrase.replace(/[.;]+$/, '')));
    } catch (e) {
      throw new HttpError(422, `Step ${index + 1}, expectation "${phrase}": ${(e as Error).message}`, { index });
    }
  }
  return step;
}

function expectLines(expects: string[] | undefined): string[] {
  return (expects ?? []).map((x) => String(x).trim().replace(/^(?:expect|verify)\s+/i, '')).filter(Boolean).map((x) => `  Expect ${x}`);
}

/** Apply an edited step list and return the new file text with its validation. */
export function applySteps(text: string, format: JourneyFormat, edits: StepEdit[]): { content: string; validation: ValidationResult } {
  if (!Array.isArray(edits)) throw new HttpError(400, '"steps" must be a list');
  if (!edits.length) throw new HttpError(422, 'A journey needs at least one step');
  const current = validateText(text, format);
  if (!current.ok) throw new HttpError(422, 'Fix the problems in the code view before editing steps visually', { errors: current.errors });
  const j = parseJourneyText(text, format);
  const n = j.steps.length;
  for (const e of edits) {
    if (e.from !== undefined && (!Number.isInteger(e.from) || e.from < 0 || e.from >= n)) throw new HttpError(400, `Unknown step index ${String(e.from)}`);
  }
  // Every edited or new step must parse; errors point at the card.
  const built = edits.map((e, i) => (e.text !== undefined ? buildStep(e, i) : undefined));

  let content: string;
  if (format === 'ez') {
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const { headerEnd, segs } = segments(lines);
    const out = lines.slice(0, headerEnd);
    edits.forEach((e) => {
      const seg = e.from !== undefined ? segs[e.from] : undefined;
      const block = seg ? lines.slice(seg.stepLine, seg.end) : [];
      if (seg && e.text === undefined) {
        // A kept step moved to the end must not glue onto the previous one.
        out.push(...block);
        return;
      }
      // Replace the step line and its expectations; keep its comments.
      const indent = seg ? (/^\s*/.exec(lines[seg.stepLine])?.[0] ?? '') : '';
      out.push(indent + String(e.text).trim(), ...expectLines(e.expects), ...block.slice(1).filter((l) => !EXPECT.test(l.trim())));
    });
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    content = out.join(nl) + nl;
  } else {
    const ids = new Set<string>();
    const steps = edits.map((e, i) => {
      const s = (built[i] ?? j.steps[e.from!]) as Step;
      let id = s.id;
      for (let k = 2; ids.has(id); k++) id = `${s.id}-${k}`;
      ids.add(id);
      return { ...s, id };
    });
    const next = Journey.parse({ ...j, steps });
    content = format === 'json' ? JSON.stringify(next, null, 2) + '\n' : YAML.stringify(next);
  }
  return { content, validation: validateText(content, format) };
}
