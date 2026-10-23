/**
 * JourneyDraft: accumulates the .ez lines of one imported test. Every line is
 * validated with the real grammar (parseIntent / parseCondition) before it is
 * emitted, so the generated script always parses; anything that does not pass
 * becomes a `# TODO (not converted): <original>` line plus a TodoItem.
 */
import { Step, slugify, type ActionType, type Condition, type LocatorCandidate } from '../core/index.js';
import { parseEzScript, parseIntent, tryParseCondition, conditionToText, examplesSourceToText, INTENT_RULES, type ExamplesSource } from '../intent/index.js';
import { emptyCoverage, type ConvertedJourney, type ImportCoverage, type ImportKind, type TodoItem } from './types.js';

/** Where a source step came from. */
export interface SourceRef {
  line: number;
  original: string;
}

/** What a generated step line must parse to; a mismatch turns it into a TODO. */
export interface StepCheck {
  action?: ActionType;
  value?: string;
  /** The original locator: it must be one of the parsed target's candidates. */
  candidate?: LocatorCandidate;
}

export interface ConditionCheck {
  type?: Condition['type'];
  candidate?: LocatorCandidate;
}

type Item =
  | { type: 'step'; text: string }
  | { type: 'expect'; text: string }
  | { type: 'todo'; original: string }
  | { type: 'comment'; text: string }
  | { type: 'manual'; text: string; expected: string[] };

export interface DraftOptions {
  kind: ImportKind;
  file: string;
  line: number;
  ids: Set<string>;
  tags?: string[];
  description?: string;
  requirements?: string[];
  risk?: number;
  baseUrl?: string;
  /** Preferred id (otherwise a slug of the name). */
  id?: string;
  /** External Examples source (rendered as `Examples: from ...`). */
  examplesFrom?: ExamplesSource;
  /** Extra header lines (e.g. `Params: a, b`, `Returns: x`), rendered after the tags. */
  headers?: string[];
  /**
   * Mark lines converted from free plain-English text with `[unverified]` (they are a reading of the
   * source text, not of its implementation) until `eztest import --verify` replays them.
   */
  markUnverified?: boolean;
  /**
   * Manual test management (docs/manual-testing.md): `manual` keeps every source step as a
   * `Manual:` step with its expected results; `hybrid` automates what the grammar reads and keeps
   * the rest as `Manual:` steps instead of TODOs. Default: automated (TODO lines).
   */
  manualMode?: 'automated' | 'manual' | 'hybrid';
}

/** A `navigate` value that is really a location: URL, /path, ./relative, ${variable} or host name. */
export function looksLikeLocation(v: string): boolean {
  return /^(?:[a-z][\w+.-]*:|\/|\.\.?\/|\$\{|~\/|localhost\b|[\w-]+(?:\.[\w-]+)+(?:[/:?#]|$))/i.test(v.trim());
}

/** Words that start an EZ action line (rule keywords plus common synonyms). */
let knownVerbs: Set<string> | undefined;
function verbs(): Set<string> {
  if (knownVerbs) return knownVerbs;
  knownVerbs = new Set(INTENT_RULES.flatMap((r) => r.keywords.map((k) => k.toLowerCase().split(/\s+/)[0])));
  for (const w of ['go', 'open', 'visit', 'navigate', 'browse', 'click', 'tap', 'press', 'type', 'enter', 'fill', 'input', 'select', 'choose', 'pick',
    'check', 'uncheck', 'tick', 'untick', 'toggle', 'hover', 'upload', 'download', 'wait', 'capture', 'remember', 'store', 'save', 'set', 'let',
    'clear', 'empty', 'log', 'sign', 'login', 'logout', 'call', 'send', 'run', 'execute', 'get', 'post', 'put', 'patch', 'delete', 'query',
    'scroll', 'drag', 'drop', 'double-click', 'right-click', 'switch', 'close', 'accept', 'dismiss', 'submit', 'reload', 'refresh', 'focus',
    'assert', 'expect', 'verify', 'ensure', 'confirm', 'repeat', 'retry', 'try', 'group', 'if', 'unless', 'while', 'for', 'use', 'mock', 'stub',
    'block', 'count', 'compare', 'read', 'extract', 'copy', 'paste', 'search', 'follow', 'add', 'remove', 'answer', 'emulate', 'grant', 'hold', 'release']) knownVerbs.add(w);
  return knownVerbs;
}

/** First word of an action line after dropping a leading subject ("I", "the user", ...). */
export function leadingVerb(line: string): string {
  const t = line.trim().replace(/^(?:and|then|when|given|but|also)\s+/i, '').replace(/^(?:i|we|they|the\s+user|user)\s+/i, '');
  const w = (/^([A-Za-z][\w-]*)/.exec(t)?.[1] ?? '').toLowerCase();
  if (!w || verbs().has(w)) return w;
  // Third person: "clicks" -> "click", "goes" -> "go".
  for (const stem of [w.replace(/es$/, ''), w.replace(/s$/, '')]) if (stem !== w && verbs().has(stem)) return stem;
  return w;
}

const CONTEXT_SUFFIX = '(?:page|screen|tab|form|dialog|module|modal|panel|window|view|section|grid|popup)';

/**
 * Split a trailing page context off an action line: `Click Search on Make Payment` ->
 * { line: "Click Search", context: "Make Payment" }. Only capitalised (proper-noun) contexts
 * after on / in / within are split; "from" is grammar ("Select X from Y") and is kept.
 */
export function splitPageContext(line: string): { line: string; context: string } | undefined {
  const m = new RegExp(`^(.*\\S)\\s+(?:on|in|within)\\s+(?:the\\s+)?((?:[A-Z][\\w&'/-]*)(?:\\s+(?:[A-Z][\\w&'/-]*|of|and|&|-))*)(?:\\s+${CONTEXT_SUFFIX})?$`).exec(line.trim());
  if (!m || /["'`]$/.test(m[1])) return undefined;
  return { line: m[1], context: m[2] };
}

/** "Select/Open the X tab [on Y]" -> `Click the "X" tab`. */
export function tabClick(line: string): { line: string; context?: string } | undefined {
  const t = line.trim().replace(/^(?:and|then|when|given|but)\s+/i, '').replace(/^(?:i|we|the\s+user|user)\s+/i, '');
  const m = /^(?:select|selects|open|opens|choose|chooses|switch(?:es)?\s+to|go(?:es)?\s+to|navigate(?:s)?\s+to|click(?:s)?(?:\s+on)?|move(?:s)?\s+to)\s+(?:the\s+)?("[^"]+"|'[^']+'|[\w&/ -]+?)\s+tab(?:\s+(?:on|in|of|from|under|within)\s+(?:the\s+)?(.+))?$/i.exec(t);
  if (!m) return undefined;
  const name = m[1].replace(/^["']|["']$/g, '').trim();
  if (!name || name.includes('"')) return undefined;
  return { line: `Click the "${name}" tab`, ...(m[2] ? { context: m[2].trim() } : {}) };
}

const EXPECT = /^(?:(?:then|and|also)\s+)?(?:expect|verify)\s+(?:that\s+)?(.+)$/i;
const HEADER = /^(journey|name|id|tags|role|requirements?|risk|base\s*url|variables|vars|description|lenses|data)\s*:/i;

/** Collapse whitespace so a source fragment fits on one .ez comment line. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** True when two candidates locate the same thing (exactness ignored). */
export function sameCandidate(a: LocatorCandidate, b: LocatorCandidate): boolean {
  return a.strategy === b.strategy && a.value === b.value && (a.name ?? '') === (b.name ?? '');
}

function uniqueId(base: string, ids: Set<string>): string {
  let id = base || 'journey';
  for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
  ids.add(id);
  return id;
}

function conditionTarget(c: Condition): LocatorCandidate[] | undefined {
  return 'target' in c ? c.target?.locators : undefined;
}

/**
 * Drop a leading subject ("I click ..." -> "Click ...") when the shorter line
 * parses to exactly the same step; otherwise keep the line as written.
 */
export function tidy(line: string): string {
  const m = /^(?:i|we|they|the\s+user|user)\s+(?!should\b|must\b|see\b|can\b|do\b|don't\b|am\b|are\b)(.+)$/i.exec(line);
  if (!m) return line;
  const short = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  try {
    const a = Step.parse({ ...parseIntent(line), id: 'x', intent: 'x' });
    const b = Step.parse({ ...parseIntent(short), id: 'x', intent: 'x' });
    return JSON.stringify(a) === JSON.stringify(b) ? short : line;
  } catch {
    return line;
  }
}

export class JourneyDraft {
  readonly id: string;
  readonly coverage: ImportCoverage = emptyCoverage();
  readonly todo: TodoItem[] = [];
  readonly warnings: string[] = [];
  private items: Item[] = [];
  private stepCount = 0;
  /** Hybrid mode: a TODO raised while reading a free line becomes a manual step instead. */
  private todoAsManual = false;
  /** Manual steps emitted. */
  manualSteps = 0;

  constructor(
    readonly name: string,
    private readonly opts: DraftOptions,
  ) {
    this.id = uniqueId(opts.id ?? slugify(oneLine(name)), opts.ids);
  }

  get steps(): number {
    return this.stepCount;
  }

  comment(text: string): void {
    const t = oneLine(text);
    if (t) this.items.push({ type: 'comment', text: t });
  }

  /** A manual step (`Manual: <text>`), with expected results added by later `expect` calls. */
  manual(text: string, src: SourceRef): boolean {
    const t = oneLine(text).replace(/^manual(?:\s+step)?\s*:\s*/i, '');
    if (!t) return false;
    this.coverage.sourceSteps++;
    this.stepCount++;
    this.manualSteps++;
    this.items.push({ type: 'manual', text: t, expected: [] });
    void src;
    return true;
  }

  private lastItem(): Item | undefined {
    return [...this.items].reverse().find((i) => i.type !== 'comment');
  }

  /** Record a source element that was not converted. */
  addTodo(src: SourceRef, reason: string, countAs: 'step' | 'assertion' | 'none' = 'step', file?: string): boolean {
    if (this.todoAsManual && countAs === 'step') {
      this.todoAsManual = false;
      return this.manual(src.original.replace(/\s*\(test case #\d+ .*\)$/, ''), src);
    }
    if (this.todoAsManual && countAs === 'assertion') {
      this.todoAsManual = false;
      const phrase = oneLine(src.original.replace(/^expected:\s*/i, '').replace(/\s*\(test case #\d+ .*\)$/, ''));
      const last = this.lastItem();
      this.coverage.assertions++;
      if (last?.type === 'manual') {
        last.expected.push(phrase);
        return true;
      }
      this.stepCount++;
      this.manualSteps++;
      this.items.push({ type: 'manual', text: `Check: ${phrase}`, expected: [phrase] });
      return true;
    }
    if (countAs === 'step') this.coverage.sourceSteps++;
    else if (countAs === 'assertion') this.coverage.assertions++;
    const original = oneLine(src.original);
    this.items.push({ type: 'todo', original });
    this.todo.push({ file: file ?? this.opts.file, line: src.line, original, reason, journeyId: this.id });
    return false;
  }

  /**
   * Add an action step from a plain-English line. The line must parse, and
   * match `check` when given; otherwise a TODO is recorded. Lines that parse as
   * assertions are routed to `expect`.
   */
  step(line: string, src: SourceRef, check: StepCheck = {}, opts: { unverified?: boolean } = {}): boolean {
    const text = tidy(oneLine(line));
    const e = EXPECT.exec(text);
    if (e) return this.expect(e[1], src);
    if (!this.stepCount && HEADER.test(text)) return this.addTodo(src, 'line would be read as an .ez header');
    let parsed: Step;
    try {
      parsed = Step.parse(parseIntent(text));
    } catch (err) {
      return this.addTodo(src, `not understood by the EZ grammar: ${(err as Error).message.split('. Did you mean')[0]}`);
    }
    if (parsed.action === 'assert') {
      const c = parsed.postconditions[0];
      return c ? this.condition(c, text, src) : this.addTodo(src, 'assertion without a condition', 'assertion');
    }
    const mismatch = this.checkStep(parsed, check);
    if (mismatch) return this.addTodo(src, mismatch);
    // "Navigate to the Accounts module" is not a URL: without a location, navigate is a misreading.
    if (parsed.action === 'navigate' && !parsed.args?.mode && !looksLikeLocation(parsed.value ?? '')) {
      return this.addTodo(src, `"${parsed.value ?? ''}" is not a URL, /path or \${variable}; navigating to a page by name needs a library journey`);
    }
    this.coverage.sourceSteps++;
    this.coverage.convertedSteps++;
    this.stepCount++;
    this.items.push({ type: 'step', text: opts.unverified ? `${text} [unverified]` : text });
    return true;
  }

  /**
   * Add a line that stands for a whole source step (e.g. `Run journey "x" with ...`). `complete`
   * says whether the source step is fully covered; an incomplete one is emitted (it runs what was
   * translated) but counted as not converted, with `reason` in a comment.
   */
  call(line: string, src: SourceRef, opts: { complete: boolean; assertion?: boolean; reason?: string }): boolean {
    const text = oneLine(line);
    try {
      Step.parse(parseIntent(text));
    } catch (err) {
      return this.addTodo(src, `generated line does not parse: ${(err as Error).message.split('. Did you mean')[0]}`, opts.assertion ? 'assertion' : 'step');
    }
    if (opts.assertion) {
      this.coverage.assertions++;
      if (opts.complete) this.coverage.convertedAssertions++;
    } else {
      this.coverage.sourceSteps++;
      if (opts.complete) this.coverage.convertedSteps++;
    }
    if (!opts.complete && opts.reason) this.comment(`partial: ${opts.reason}`);
    this.stepCount++;
    this.items.push({ type: 'step', text });
    return true;
  }

  /** Add an already-validated line produced by structural translation (not counted: the caller counts the source step). */
  line(text: string, indent = ''): boolean {
    const t = oneLine(text);
    try {
      const s = Step.parse(parseIntent(t));
      if (s.action === 'assert' && /^(?:expect|verify)\b/i.test(t)) {
        const last = [...this.items].reverse().find((i) => i.type !== 'comment');
        if (last && (last.type === 'step' || last.type === 'expect')) {
          this.items.push({ type: 'expect', text: t.replace(/^(?:expect|verify)\s+(?:that\s+)?/i, '') });
          return true;
        }
      }
    } catch {
      return false;
    }
    this.stepCount++;
    this.items.push({ type: 'step', text: indent + t });
    return true;
  }

  /** Block structure (`If ... then`, `Otherwise`, `End`, `In frame ...`, `Try`, `On failure`): checked when the journey is parsed. */
  structural(text: string): void {
    this.items.push({ type: 'step', text });
  }

  /** Record a counted source step or assertion that was converted by a caller (via `line`). */
  count(kind: 'step' | 'assertion', converted: boolean): void {
    if (kind === 'step') {
      this.coverage.sourceSteps++;
      if (converted) this.coverage.convertedSteps++;
    } else {
      this.coverage.assertions++;
      if (converted) this.coverage.convertedAssertions++;
    }
  }

  /** A TODO line without coverage counting (the caller counts the source step). */
  todoLine(src: SourceRef, reason: string, file?: string): void {
    this.addTodo(src, reason, 'none', file);
  }

  private checkStep(s: Step, check: StepCheck): string | undefined {
    if (check.action && s.action !== check.action) return `generated line parsed as "${s.action}", expected "${check.action}"`;
    if (check.value !== undefined && s.value !== check.value) return `generated line lost the value ${JSON.stringify(check.value)}`;
    if (check.candidate && !(s.target?.locators ?? []).some((l) => sameCandidate(l, check.candidate!))) {
      return `original locator ${check.candidate.strategy}=${JSON.stringify(check.candidate.value)} cannot be expressed in .ez`;
    }
    return undefined;
  }

  /**
   * Add an expectation phrase (without the Expect prefix). It becomes a
   * post-condition of the previous step, or a standalone `Assert that` step
   * when there is no step before it (or an unconverted step intervened).
   */
  expect(phrase: string, src: SourceRef, check: ConditionCheck = {}): boolean {
    const text = oneLine(phrase).replace(/[.;]+$/, '');
    const mode = this.opts.manualMode;
    if (mode === 'manual' || (mode === 'hybrid' && this.lastItem()?.type === 'manual')) {
      // An expected result of a manual step is for the tester to check.
      const last = this.lastItem();
      this.coverage.assertions++;
      if (last?.type === 'manual') last.expected.push(oneLine(phrase));
      else {
        this.stepCount++;
        this.manualSteps++;
        this.items.push({ type: 'manual', text: `Check: ${oneLine(phrase)}`, expected: [oneLine(phrase)] });
      }
      return true;
    }
    if (mode === 'hybrid') {
      this.todoAsManual = true;
      try {
        return this.expectAutomated(text, src, check);
      } finally {
        this.todoAsManual = false;
      }
    }
    return this.expectAutomated(text, src, check);
  }

  private expectAutomated(text: string, src: SourceRef, check: ConditionCheck): boolean {
    const c = tryParseCondition(text);
    if (!c) return this.addTodo(src, 'expectation not understood by the EZ grammar', 'assertion');
    if (check.type && c.type !== check.type) return this.addTodo(src, `expectation parsed as "${c.type}", expected "${check.type}"`, 'assertion');
    if (check.candidate && !(conditionTarget(c) ?? []).some((l) => sameCandidate(l, check.candidate!))) {
      return this.addTodo(src, `original locator ${check.candidate.strategy}=${JSON.stringify(check.candidate.value)} cannot be expressed in .ez`, 'assertion');
    }
    return this.condition(c, text, src);
  }

  /** Emit a parsed condition, preferring the original phrasing when it round-trips. */
  private condition(c: Condition, phrase: string, src: SourceRef): boolean {
    const want = JSON.stringify(c);
    const stripped = phrase.replace(/^(?:verify|expect|assert|ensure|confirm|check)\s+(?:that\s+)?/i, '').replace(/^The\b/, 'the');
    let chosen: string | undefined;
    let canonical = stripped;
    try {
      canonical = conditionToText(c);
    } catch {
      // keep the original phrasing only
    }
    const order = /^(?:i|we|they|the\s+user|user)\b/i.test(stripped) ? [canonical, stripped] : [stripped, canonical];
    for (const cand of order) {
      const p = tryParseCondition(cand);
      if (p && JSON.stringify(p) === want) {
        chosen = cand;
        break;
      }
    }
    if (!chosen) return this.addTodo(src, 'expectation cannot be rendered back to .ez', 'assertion');
    const last = [...this.items].reverse().find((i) => i.type !== 'comment');
    if (last && (last.type === 'step' || last.type === 'expect')) {
      this.items.push({ type: 'expect', text: chosen });
    } else {
      const line = `Assert that ${chosen}`;
      try {
        const s = Step.parse(parseIntent(line));
        if (s.action !== 'assert' || JSON.stringify(s.postconditions[0]) !== want) throw new Error('mismatch');
      } catch {
        return this.addTodo(src, 'standalone assertion cannot be rendered to .ez', 'assertion');
      }
      this.items.push({ type: 'step', text: line });
      this.stepCount++;
    }
    this.coverage.assertions++;
    this.coverage.convertedAssertions++;
    return true;
  }

  /**
   * Classify a free plain-English line (Gherkin step, manual test step):
   * an expectation when it reads as one (preferred for "Then" lines), else an action.
   */
  english(text: string, src: SourceRef, preferCondition = false): boolean {
    if (this.opts.manualMode === 'manual') return this.manual(text, src);
    if (this.opts.manualMode === 'hybrid') {
      this.todoAsManual = true;
      try {
        return this.englishAutomated(text, src, preferCondition);
      } finally {
        this.todoAsManual = false;
      }
    }
    return this.englishAutomated(text, src, preferCondition);
  }

  private englishAutomated(text: string, src: SourceRef, preferCondition: boolean): boolean {
    let t = oneLine(text);
    const unverified = { unverified: !!this.opts.markUnverified };
    // "Select/Open the Shipping tab [on Order Setup]" is a tab click, not a dropdown selection.
    const tab = tabClick(t);
    if (tab) {
      if (tab.context) this.comment(`context: ${tab.context}`);
      return this.step(tab.line, src, { action: 'click' }, unverified);
    }
    if (preferCondition) {
      const body = t.replace(/^(?:verify|expect|assert|ensure|confirm|check)\s+(?:that\s+)?/i, '').replace(/[.;]+$/, '');
      if (tryParseCondition(body)) return this.expect(body, src);
      try {
        const s = Step.parse(parseIntent(t));
        if (s.action !== 'assert') return this.step(t, src, {}, unverified);
      } catch {
        // fall through to the TODO
      }
      return this.addTodo(src, 'expectation not understood by the EZ grammar', 'assertion');
    }
    // A domain verb ("resolve", "prepare", "configure the deal") has no EZ meaning: guessing an action from it is wrong.
    const verb = leadingVerb(t);
    if (this.opts.markUnverified && verb && !verbs().has(verb) && !/^(?:expect|verify|assert)\b/i.test(t)) {
      return this.addTodo(src, `"${verb}" is a domain step; it needs a step definition or library journey`);
    }
    // Strip a trailing page context ("Click Search on Make Payment") when the rest still parses as the same kind of step.
    const ctx = splitPageContext(t);
    if (ctx) {
      try {
        const full = Step.parse(parseIntent(t));
        const short = Step.parse(parseIntent(ctx.line));
        if (short.action === full.action && short.target && full.target) {
          this.comment(`context: ${ctx.context}`);
          t = ctx.line;
        }
      } catch {
        // keep the line as written
      }
    }
    return this.step(t, src, {}, unverified);
  }

  /** Render the .ez script. */
  render(): string {
    const o = this.opts;
    const out: string[] = [`# Imported from ${o.kind}: ${o.file}:${o.line}`, `Journey: ${oneLine(this.name)}`];
    if (this.id !== slugify(oneLine(this.name))) out.push(`Id: ${this.id}`);
    if (o.description && oneLine(o.description)) out.push(`Description: ${oneLine(o.description)}`);
    // `@TestCaseId:{1,2}` (Gherkin) becomes one tag per id: .ez tags are space/comma separated, and ADO reads every TestCaseId tag.
    const expanded = (o.tags ?? []).flatMap((t) => {
      const m = /^@?(TestCaseId)\s*[:=]\s*\{([^}]*)\}$/i.exec(t.trim());
      return m ? m[2].split(',').map((x) => x.trim()).filter(Boolean).map((x) => `${m[1]}:${x}`) : [t];
    });
    const tags = [...new Set(expanded.map((t) => t.replace(/^@/, '').replace(/[\s,]+/g, '-')).filter(Boolean))];
    if (tags.length) out.push(`Tags: ${tags.map((t) => `@${t}`).join(' ')}`);
    if (o.requirements?.length) out.push(`Requirements: ${o.requirements.join(', ')}`);
    if (o.risk && o.risk !== 3) out.push(`Risk: ${o.risk}`);
    if (o.baseUrl) out.push(`Base URL: ${o.baseUrl}`);
    if (this.manualSteps) out.push(`Type: ${this.items.some((i) => i.type === 'step') ? 'hybrid' : 'manual'}`);
    for (const h of o.headers ?? []) out.push(h);
    out.push('');
    for (const i of this.items) {
      if (i.type === 'step') out.push(i.text);
      else if (i.type === 'expect') out.push(`  Expect ${i.text}`);
      else if (i.type === 'todo') out.push(`# TODO (not converted): ${i.original}`);
      else if (i.type === 'manual') {
        out.push(`Manual: ${i.text}`);
        for (const e of i.expected) out.push(`  Expected: ${e}`);
      }
      else out.push(`# ${i.text}`);
    }
    if (o.examplesFrom) out.push('', examplesSourceToText(o.examplesFrom));
    return out.join('\n') + '\n';
  }

  /** Produce the converted journey (parsing the generated .ez with the real parser). */
  finish(): ConvertedJourney {
    const ez = this.render();
    const o = this.opts;
    const result: ConvertedJourney = {
      id: this.id, name: oneLine(this.name), kind: o.kind, file: o.file, line: o.line, ez,
      coverage: { ...this.coverage }, todo: [...this.todo], verified: false,
    };
    if (this.stepCount === 0) {
      this.warnings.push(`${o.file}:${o.line}: "${result.name}" has no convertible steps; no journey produced`);
      return result;
    }
    try {
      result.journey = parseEzScript(ez, { source: o.file });
    } catch (err) {
      this.warnings.push(`${o.file}:${o.line}: generated .ez for "${result.name}" did not parse: ${(err as Error).message}`);
    }
    return result;
  }
}
