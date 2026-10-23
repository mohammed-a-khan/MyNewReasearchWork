/**
 * Manual test cases as `.ez`: the Studio case editor's form model, rendering
 * it to a script (validated by the real parser), reading a script back into
 * the form, and turning a manual case into an automated (or hybrid) journey,
 * either through the EZ grammar or from lines recorded with the recorder.
 */
import { flattenSteps, slugify, type Journey, type Step } from '../core/index.js';
import { journeyToEzScript, parseEzScript, parseIntent, quoteText, tryParseCondition, conditionToText } from '../intent/index.js';
import { journeyKind } from '../runner/manual.js';
import { looksLikeLocation } from '../importers/builder.js';
import { isKeyName } from '../intent/rules-advanced.js';

export interface ManualCaseStep {
  /** A manual instruction ("Manual: ..."). */
  instruction?: string;
  /** Or an automated EZ line (hybrid cases). */
  automated?: string;
  expected?: string[];
  attachments?: string[];
  /** Automated checks ("Expect ..." lines, without the Expect). */
  checks?: string[];
}

export interface ManualCaseInput {
  name: string;
  id?: string;
  type?: 'manual' | 'hybrid';
  description?: string;
  assignee?: string;
  preconditions?: string;
  requirements?: string[];
  tags?: string[];
  risk?: number;
  baseUrl?: string;
  steps: ManualCaseStep[];
  /** Parameters: an Examples table (one execution per row; use <column> in the steps). */
  parameters?: { columns: string[]; rows: string[][] };
}

const one = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Render a case to `.ez` and parse it back (throws with a line number when something is not valid). */
export function renderManualCase(c: ManualCaseInput): { ez: string; journey: Journey } {
  if (!one(c.name)) throw new Error('A case needs a name');
  if (!c.steps.length) throw new Error('A case needs at least one step');
  const out: string[] = [`Journey: ${one(c.name)}`];
  if (c.id && c.id !== slugify(one(c.name))) out.push(`Id: ${c.id}`);
  const automated = c.steps.some((s) => one(s.automated));
  out.push(`Type: ${automated ? 'hybrid' : c.type ?? 'manual'}`);
  if (one(c.description)) out.push(`Description: ${one(c.description)}`);
  if (c.tags?.length) out.push(`Tags: ${c.tags.map((t) => `@${t.replace(/^@/, '').replace(/[\s,]+/g, '-')}`).join(' ')}`);
  if (c.requirements?.length) out.push(`Requirements: ${c.requirements.map(one).filter(Boolean).join(', ')}`);
  if (c.risk && c.risk !== 3) out.push(`Risk: ${c.risk}`);
  if (one(c.assignee)) out.push(`Assignee: ${one(c.assignee)}`);
  if (one(c.preconditions)) out.push(`Preconditions: ${one(c.preconditions)}`);
  if (one(c.baseUrl)) out.push(`Base URL: ${one(c.baseUrl)}`);
  out.push('');
  for (const s of c.steps) {
    if (one(s.automated)) out.push(one(s.automated));
    else if (one(s.instruction)) out.push(`Manual: ${one(s.instruction)}`);
    else continue;
    for (const e of (s.expected ?? []).map(one).filter(Boolean)) out.push(`  Expected: ${e}`);
    for (const a of (s.attachments ?? []).map(one).filter(Boolean)) out.push(`  Attachment: ${a}`);
    for (const k of (s.checks ?? []).map(one).filter(Boolean)) out.push(`  Expect ${k.replace(/^(?:expect|verify)\s+/i, '')}`);
  }
  const p = c.parameters;
  if (p && p.columns.length && p.rows.length) {
    const cell = (v: string) => (/^[^|"']*$/.test(v) && v.trim() === v && v !== '' ? v : quoteText(v));
    out.push('', 'Examples:', `  | ${p.columns.map(one).join(' | ')} |`);
    for (const r of p.rows) out.push(`  | ${p.columns.map((_, i) => cell(one(r[i]))).join(' | ')} |`);
  }
  const ez = out.join('\n') + '\n';
  return { ez, journey: parseEzScript(ez) };
}

/** Read a journey back into the case editor's form. */
export function caseFromJourney(j: Journey): ManualCaseInput {
  const steps: ManualCaseStep[] = j.steps.map((s) => {
    const a = (s.args ?? {}) as { expected?: string[]; attachments?: string[] };
    const checks = s.postconditions.map((c) => {
      try {
        return conditionToText(c);
      } catch {
        return '';
      }
    }).filter(Boolean);
    return s.action === 'manual'
      ? { instruction: s.value ?? '', expected: a.expected ?? [], attachments: a.attachments ?? [], checks }
      : { automated: s.intent, checks };
  });
  const cols = j.examples?.length ? Object.keys(j.examples[0]) : [];
  const kind = journeyKind(j);
  return {
    name: j.name, id: j.id, type: kind === 'automated' ? 'hybrid' : kind, ...(j.description ? { description: j.description } : {}),
    ...(j.assignee ? { assignee: j.assignee } : {}), ...(j.preconditions ? { preconditions: j.preconditions } : {}),
    requirements: j.requirements, tags: j.tags, risk: j.risk, ...(j.baseUrl ? { baseUrl: j.baseUrl } : {}), steps,
    ...(cols.length ? { parameters: { columns: cols, rows: j.examples!.map((r) => cols.map((c) => r[c] ?? '')) } } : {}),
  };
}

/** The header lines of a journey's `.ez` (everything before the first step), without `Type:`. */
function headerLines(j: Journey, type?: 'hybrid'): string[] {
  const text = journeyToEzScript({ ...j, type: undefined, examples: undefined, examplesFrom: undefined });
  const head = text.split('\n');
  const blank = head.indexOf('');
  const lines = head.slice(0, blank < 0 ? head.length : blank);
  if (type) lines.push(`Type: ${type}`);
  return lines;
}

function examplesLines(j: Journey): string[] {
  if (!j.examples?.length) return [];
  const cols = Object.keys(j.examples[0]);
  const cell = (v: string) => (/^[^|"']*$/.test(v) && v.trim() === v && v !== '' ? v : quoteText(v));
  return ['', 'Examples:', `  | ${cols.join(' | ')} |`, ...j.examples.map((r) => `  | ${cols.map((c) => cell(r[c] ?? '')).join(' | ')} |`)];
}

function expectLine(text: string): string | undefined {
  const body = text.replace(/^(?:verify|expect|check|ensure|confirm)\s+(?:that\s+)?/i, '').replace(/[.;]+$/, '').trim();
  return tryParseCondition(body) ? `  Expect ${body}` : undefined;
}

/** The `.ez` lines of one (automated) step as the renderer writes them. */
function stepLines(j: Journey, s: Step): string[] {
  const head = headerLines(j).length;
  return journeyToEzScript({ ...j, steps: [s], examples: undefined, examplesFrom: undefined, type: undefined }).split('\n').slice(head + 1).filter((l) => l.trim());
}

function manualLines(s: Step): string[] {
  const a = (s.args ?? {}) as { expected?: string[]; attachments?: string[] };
  return [
    `Manual: ${s.value ?? ''}`,
    ...(a.expected ?? []).map((e) => `  Expected: ${e}`),
    ...(a.attachments ?? []).map((f) => `  Attachment: ${f}`),
    ...s.postconditions.map((c) => `  Expect ${conditionToText(c)}`),
  ];
}

/**
 * The instruction as an EZ line when the grammar reads it as a real step: not
 * an assertion, a navigation to an actual location, a key press of real keys,
 * a target action with a short target. Anything else stays manual, because a
 * wrong reading would run the wrong thing.
 */
export function grammarLine(text: string): string | undefined {
  const t = text.trim();
  if (!t) return undefined;
  let p;
  try {
    p = parseIntent(t);
  } catch {
    return undefined;
  }
  if (p.action === 'manual' || p.action === 'assert') return undefined;
  if (p.action === 'navigate' && !p.args?.mode && !looksLikeLocation(p.value ?? '')) return undefined;
  if (p.action === 'press' && !(p.value ?? '').split('+').every((k) => isKeyName(k) || /^[A-Za-z0-9]$/.test(k))) return undefined;
  if (p.target && p.target.description.split(/\s+/).length > 8) return undefined;
  return t;
}

export interface AutomationResult {
  ez: string;
  journey: Journey;
  /** Manual steps turned into automated lines. */
  automated: string[];
  /** Manual steps kept as `Manual:` (the result is hybrid while any remain). */
  kept: string[];
  /** Expected results that are not checkable as written (kept as comments). */
  uncheckedExpectations: string[];
}

/**
 * Convert through the EZ grammar: a manual instruction that reads as an EZ
 * step becomes that step, and an expected result that reads as a condition
 * becomes an `Expect` line. Everything else stays manual, so the result runs
 * as a hybrid journey and nothing is dropped.
 */
export function automateWithGrammar(j: Journey): AutomationResult {
  const body: string[] = [];
  const automated: string[] = [];
  const kept: string[] = [];
  const unchecked: string[] = [];
  for (const s of j.steps) {
    if (s.action !== 'manual') {
      body.push(...stepLines(j, s));
      continue;
    }
    const line = grammarLine(s.value ?? '');
    const a = (s.args ?? {}) as { expected?: string[] };
    if (!line) {
      kept.push(s.value ?? s.intent);
      body.push(...manualLines(s));
      continue;
    }
    automated.push(s.value ?? '');
    body.push(`# Manual: ${s.value}`, line!);
    for (const e of a.expected ?? []) {
      const x = expectLine(e);
      if (x) body.push(x);
      else {
        unchecked.push(e);
        body.push(`  # Expected (check manually or write as an Expect line): ${e}`);
      }
    }
    for (const c of s.postconditions) body.push(`  Expect ${conditionToText(c)}`);
  }
  const ez = [...headerLines(j, kept.length ? 'hybrid' : undefined), '', ...body, ...examplesLines(j)].join('\n') + '\n';
  return { ez, journey: parseEzScript(ez), automated, kept, uncheckedExpectations: unchecked };
}

export interface RecordedStep {
  /** The manual step's id. */
  stepId: string;
  /** Recorded `.ez` lines for it (from the recorder), in order. */
  lines: string[];
}

/**
 * Convert with the recorder: each manual step is replaced by the lines
 * recorded while the tester performed it (the instruction stays as a
 * comment); its expected results become `Expect` lines where the grammar
 * reads them. Steps with nothing recorded stay manual (hybrid).
 */
export function automateWithRecording(j: Journey, recorded: RecordedStep[]): AutomationResult {
  const byStep = new Map(recorded.map((r) => [r.stepId, r.lines.map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim())]));
  for (const r of recorded) if (!flattenSteps(j.steps).some((s) => s.id === r.stepId)) throw new Error(`No step "${r.stepId}" in ${j.id}`);
  const body: string[] = [];
  const automated: string[] = [];
  const kept: string[] = [];
  const unchecked: string[] = [];
  let opened = false;
  for (const s of j.steps) {
    const lines = byStep.get(s.id) ?? [];
    if (s.action !== 'manual' || !lines.length) {
      if (s.action === 'manual') {
        kept.push(s.value ?? s.intent);
        body.push(...manualLines(s));
      } else body.push(...stepLines(j, s));
      continue;
    }
    automated.push(s.value ?? '');
    body.push(`# Manual: ${s.value}`);
    for (const l of lines) {
      // The recorder starts with "Open <url>"; later recordings of the same session repeat it only when the page changed.
      if (/^open\s/i.test(l.trim()) && opened && body[body.length - 1]?.trim() === l.trim()) continue;
      if (/^open\s/i.test(l.trim())) opened = true;
      // Validate each line with the grammar (recorder output always parses, but a hand-edited line may not).
      const t = l.trim();
      if (/^(?:expect|verify)\b/i.test(t)) {
        body.push(`  ${t}`);
        continue;
      }
      parseIntent(t);
      body.push(t);
    }
    for (const e of ((s.args ?? {}) as { expected?: string[] }).expected ?? []) {
      const x = expectLine(e);
      if (x) body.push(x);
      else {
        unchecked.push(e);
        body.push(`  # Expected (check manually or write as an Expect line): ${e}`);
      }
    }
    for (const c of s.postconditions) body.push(`  Expect ${conditionToText(c)}`);
  }
  const ez = [...headerLines(j, kept.length ? 'hybrid' : undefined), '', ...body, ...examplesLines(j)].join('\n') + '\n';
  return { ez, journey: parseEzScript(ez), automated, kept, uncheckedExpectations: unchecked };
}
