/**
 * The Node half of the recorder: turns the ordered stream of page events and
 * navigations into Journey steps. Every step is produced by writing its
 * plain-English line and parsing it with the intent grammar, so the journey is
 * by construction what its `.ez` text means.
 */
import {
  Journey,
  slugify,
  type ActionType,
  type Condition,
  type LocatorCandidate,
  type StepInput,
  type Target,
} from '../core/index.js';
import {
  conditionToText,
  describeTarget,
  journeyToEzScript,
  parseCondition,
  parseEzScript,
  parseIntent,
  quoteText,
} from '../intent/index.js';
import type { ElementInfo, PageEvent } from './page-script.js';
import { buildTarget, type RecordedTarget } from './target.js';

/** A page event plus the frame chain it came from (empty for the main frame). */
export type FramedPageEvent = PageEvent & { frames?: string[] };

export type ComposerEvent =
  | FramedPageEvent
  /** `byPage`: the page started it (link, form, script); false when typed/opened directly. Default true. */
  | { kind: 'navigate'; url: string; t: number; byPage?: boolean }
  | { kind: 'expect'; condition: Condition; t: number };

export interface RecordingResult {
  journey: Journey;
  /** The journey as an `.ez` script (empty only when the journey cannot be expressed in .ez; see warnings). */
  ez: string;
  warnings: string[];
  /** Variables the journey needs at run time (e.g. "password"); never recorded. */
  variables: string[];
  /** Origin the recorded relative URLs are resolved against. */
  baseUrl: string;
  /** Per step id: the locator candidates measured in the page (role+name, label, testId, id, css). */
  targets: Record<string, LocatorCandidate[]>;
}

export interface ComposerOptions {
  startUrl: string;
  /** Origin for relative URLs; also written to the journey when given. */
  baseUrl?: string;
  name?: string;
  id?: string;
  tags?: string[];
  /** Called with each committed step line (and updates), e.g. for live CLI output. */
  onStep?: (line: string) => void;
}

interface Draft {
  step: StepInput;
  elKey?: string;
  t: number;
  postconditions: Condition[];
  candidates?: LocatorCandidate[];
}

/** A navigation this soon after an action is attributed to it. */
const NAV_WINDOW_MS = 5000;
/** A second navigation this soon after the first is a redirect of the same action. */
const REDIRECT_WINDOW_MS = 1500;
const SECRET_PARAM = /pass|pwd|secret|token|otp|code|auth|key/i;

/** Deterministic JSON with sorted keys, for structural comparison. */
export function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return val;
  });
}

function stripTarget(t: Target | undefined): unknown {
  return t ? { description: t.description, locators: t.locators, frames: t.frames ?? null } : null;
}

function stripCondition(c: Condition): unknown {
  return 'target' in c ? { ...c, target: stripTarget(c.target) } : c;
}

/**
 * Structural differences between two journeys (ignoring fingerprints and
 * free-text intents); empty means equivalent.
 */
export function diffJourneys(a: Journey, b: Journey): string[] {
  const out: string[] = [];
  for (const k of ['id', 'name', 'baseUrl', 'description'] as const) {
    if ((a[k] ?? null) !== (b[k] ?? null)) out.push(`${k}: ${String(a[k])} != ${String(b[k])}`);
  }
  if (stable(a.tags) !== stable(b.tags)) out.push('tags differ');
  if (stable(a.variables) !== stable(b.variables)) out.push('variables differ');
  if (a.steps.length !== b.steps.length) out.push(`step count ${a.steps.length} != ${b.steps.length}`);
  const n = Math.min(a.steps.length, b.steps.length);
  for (let i = 0; i < n; i++) {
    const x = a.steps[i];
    const y = b.steps[i];
    const sx = stable({ id: x.id, action: x.action, value: x.value ?? null, args: x.args ?? null, target: stripTarget(x.target), post: x.postconditions.map(stripCondition) });
    const sy = stable({ id: y.id, action: y.action, value: y.value ?? null, args: y.args ?? null, target: stripTarget(y.target), post: y.postconditions.map(stripCondition) });
    if (sx !== sy) out.push(`step ${i + 1} (${x.id}) differs: ${sx} != ${sy}`);
  }
  return out;
}

/** Escape `${` so recorded literal text is not interpolated at run time. */
function literalValue(s: string): string {
  return s.replace(/\$\{/g, '$${');
}

function camel(s: string): string {
  const words = s.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const c = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
  return /^[A-Za-z_]/.test(c) ? c : '';
}

function truncateWords(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max / 2 ? cut.slice(0, sp) : cut).trim();
}

export class JourneyComposer {
  private readonly drafts: Draft[] = [];
  private readonly warningList: string[] = [];
  private readonly secrets = new Set<string>();
  private readonly base: URL;
  private current?: URL;
  private lastActionT = 0;
  private navConsumed = false;
  private navT = 0;
  private navDraft?: Draft;
  private navCondition?: Condition;

  constructor(private readonly opts: ComposerOptions) {
    this.base = new URL(opts.baseUrl ?? opts.startUrl);
  }

  get warnings(): readonly string[] {
    return this.warningList;
  }

  get stepCount(): number {
    return this.drafts.length;
  }

  warn(message: string): void {
    if (!this.warningList.includes(message)) this.warningList.push(message);
  }

  /** Record the initial `Open <url>` step. */
  start(t: number): void {
    const u = new URL(this.opts.startUrl, this.base);
    this.current = u;
    this.addNavigate(u, t);
    this.navConsumed = false;
  }

  apply(ev: ComposerEvent): void {
    switch (ev.kind) {
      case 'navigate': return this.onNavigate(ev.url, ev.t, ev.byPage ?? true);
      case 'expect': return this.attachCondition(ev.condition);
      case 'assert': return this.onAssert(ev);
      case 'click': return this.action(ev.button === 'right' ? 'rightclick' : 'click', ev);
      case 'dblclick': {
        // The browser reports click, click, dblclick: fold the clicks into the double-click.
        for (let i = 0; i < 2; i++) {
          const last = this.drafts[this.drafts.length - 1];
          if (last && last.step.action === 'click' && last.elKey === ev.el.key && ev.t - last.t < 1500 && last.postconditions.length === 0) {
            this.drafts.pop();
          }
        }
        return this.action('dblclick', ev);
      }
      case 'fill': {
        const value = ev.secret ? undefined : ev.value ?? '';
        const last = this.drafts[this.drafts.length - 1];
        const coalesce = last && (last.step.action === 'fill' || last.step.action === 'clear') && last.elKey === ev.el.key;
        if (coalesce) this.drafts.pop();
        if (!ev.secret && value === '') return this.action('clear', ev, undefined, coalesce ? last.t : undefined);
        return this.action('fill', ev, ev.secret ? this.secretRef(ev.el) : literalValue(value ?? ''), coalesce ? last.t : undefined);
      }
      case 'select': {
        if (ev.labels.length === 0) {
          this.warn(`A selection in ${buildTarget(ev.el).label} cleared every option; not recorded (no plain-English step for "deselect all").`);
          return;
        }
        if (ev.labels.length > 1) {
          this.warn(`Several options were selected in ${buildTarget(ev.el).label}; only "${ev.labels[0]}" was recorded (multi-select is not expressible as one step).`);
        }
        return this.action('select', ev, literalValue(ev.labels[0]));
      }
      case 'check': return this.action('check', ev);
      case 'uncheck': return this.action('uncheck', ev);
      case 'press': return this.action('press', ev, ev.key);
      case 'upload': {
        if (ev.files.length === 0) {
          this.warn(`The file selection of ${buildTarget(ev.el).label} was cleared; not recorded.`);
          return;
        }
        if (ev.files.length > 1) this.warn(`Several files were chosen for ${buildTarget(ev.el).label}; only "${ev.files[0]}" was recorded.`);
        this.warn(`Upload of "${ev.files[0]}": the browser only reveals file names; edit the step to the file's path relative to where tests run.`);
        return this.action('upload', ev, literalValue(ev.files[0]));
      }
    }
  }

  // ------------------------------------------------------------------ actions

  private secretRef(el: ElementInfo): string {
    let name = camel(el.label ?? '') || camel(el.nameAttr ?? '') || camel(el.id ?? '') || 'password';
    if (!/^[A-Za-z_][\w]*$/.test(name)) name = 'password';
    this.secrets.add(name);
    return `\${${name}}`;
  }

  private action(kind: ActionType | 'rightclick', ev: FramedPageEvent & { el?: ElementInfo }, value?: string, t0?: number): void {
    const rt = ev.el ? buildTarget(ev.el) : undefined;
    const draft = this.makeDraft(kind, rt, value, ev.frames);
    if (!draft) return;
    draft.elKey = ev.el?.key;
    draft.t = t0 ?? ev.t;
    this.drafts.push(draft);
    this.lastActionT = ev.t;
    this.navConsumed = false;
    this.opts.onStep?.(draft.step.intent);
  }

  private lineFor(kind: ActionType | 'rightclick', d: string, value?: string): string | undefined {
    const q = value === undefined ? undefined : (() => {
      try {
        return quoteText(value);
      } catch {
        return undefined;
      }
    })();
    switch (kind) {
      case 'click': return `Click ${d}`;
      case 'rightclick': return `Right-click ${d}`;
      case 'dblclick': return `Double-click ${d}`;
      case 'fill': return q && `Type ${q} into ${d}`;
      case 'clear': return `Clear ${d}`;
      case 'select': return q && `Select ${q} from ${d}`;
      case 'check': return `Check ${d}`;
      case 'uncheck': return `Uncheck ${d}`;
      case 'press': return d ? `Press ${value} in ${d}` : `Press ${value}`;
      case 'upload': return q && `Upload ${q} to ${d}`;
      default: return undefined;
    }
  }

  /** Write the line, parse it back, and keep it only if it means exactly this action on this target. */
  private makeDraft(kind: ActionType | 'rightclick', rt: RecordedTarget | undefined, value: string | undefined, frames?: string[]): Draft | undefined {
    const action: ActionType = kind === 'rightclick' ? 'click' : kind;
    const descriptions = rt ? rt.descriptions : [''];
    for (const d of descriptions) {
      const line = this.lineFor(kind, d, value);
      if (!line) continue;
      let step: StepInput;
      try {
        step = parseIntent(line);
      } catch {
        continue;
      }
      if (step.action !== action || (step.value ?? undefined) !== value) continue;
      if (kind === 'rightclick' && step.args?.button !== 'right') continue;
      if (rt) {
        const want = describeTarget(d);
        if (!step.target || stable(step.target) !== stable(want)) continue;
        step.target = { ...step.target, fingerprint: rt.fingerprint, ...(frames?.length ? { frames } : {}) };
        const selector = /^(?:css=|testid=|#)/.test(d);
        if (selector && (rt.kind !== 'generic' || d.startsWith('css='))) {
          const what = d.startsWith('css=') ? 'a CSS selector' : d.startsWith('#') ? 'an id selector' : 'a test id';
          this.warn(`"${line}": ${rt.note ?? 'no unique accessible name, label or test id'}; recorded with ${what} instead.`);
        }
      } else if (step.target) {
        continue;
      }
      return { step, t: 0, postconditions: [], ...(rt ? { candidates: rt.candidates } : {}) };
    }
    this.warn(`Could not express a ${kind}${rt ? ` on ${rt.label}` : ''} as a plain-English step; it was not recorded.`);
    return undefined;
  }

  // ------------------------------------------------------------------ navigation

  private relUrl(u: URL): string {
    const params = new URLSearchParams(u.search);
    for (const k of [...params.keys()]) if (SECRET_PARAM.test(k)) params.delete(k);
    const search = params.toString() ? `?${params.toString()}` : '';
    if (u.origin === this.base.origin) return `${u.pathname}${search}`;
    return `${u.origin}${u.pathname}${search}`;
  }

  private pathOf(u: URL): string {
    return u.origin === this.base.origin ? u.pathname : `${u.origin}${u.pathname}`;
  }

  private addNavigate(u: URL, t: number): void {
    const url = this.relUrl(u);
    const lines = /^\S+$/.test(url) ? [`Open ${url}`] : [];
    try {
      lines.push(`Open ${quoteText(url)}`);
    } catch {
      // no quoting possible
    }
    for (const line of lines) {
      try {
        const step = parseIntent(line);
        if (step.action !== 'navigate' || step.value !== url || step.args) continue;
        const draft: Draft = { step, t, postconditions: [] };
        this.drafts.push(draft);
        this.lastActionT = t;
        this.navConsumed = true;
        this.navDraft = draft;
        this.navCondition = undefined;
        this.navT = t;
        this.opts.onStep?.(line);
        return;
      } catch {
        // try the quoted form
      }
    }
    this.warn(`Navigation to ${url} could not be expressed as an Open step; not recorded.`);
  }

  private onNavigate(url: string, t: number, byPage: boolean): void {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'file:') return;
    const prev = this.current;
    this.current = u;
    if (prev && this.pathOf(prev) === this.pathOf(u)) return;
    const last = this.drafts[this.drafts.length - 1];
    const cond: Condition = { type: 'urlContains', value: this.pathOf(u) };
    // A navigation the user started directly (address bar, bookmark) only continues an Open step.
    const related = last !== undefined && (byPage || last.step.action === 'navigate');
    if (related && this.navConsumed && last === this.navDraft && t - this.navT < REDIRECT_WINDOW_MS) {
      // A redirect right after the action's navigation: expect the final URL.
      if (this.navCondition) {
        const i = last.postconditions.indexOf(this.navCondition);
        if (i >= 0) last.postconditions.splice(i, 1, cond);
        else last.postconditions.push(cond);
      } else {
        last.postconditions.unshift(cond);
      }
      this.navCondition = cond;
      this.navT = t;
      return;
    }
    if (related && !this.navConsumed && t - this.lastActionT < NAV_WINDOW_MS) {
      last.postconditions.push(cond);
      this.navConsumed = true;
      this.navDraft = last;
      this.navCondition = cond;
      this.navT = t;
      this.opts.onStep?.(`  Expect ${conditionToText(cond)}`);
      return;
    }
    if (byPage) {
      // The page moved on its own (timer, script): wait for it rather than opening the URL.
      const line = `Wait until the URL contains ${quoteText(cond.value)}`;
      const step = parseIntent(line);
      const draft: Draft = { step, t, postconditions: [] };
      this.drafts.push(draft);
      this.navConsumed = true;
      this.navDraft = draft;
      this.navCondition = undefined;
      this.navT = t;
      this.opts.onStep?.(line);
      return;
    }
    this.addNavigate(u, t);
  }

  // ------------------------------------------------------------------ expectations

  private onAssert(ev: Extract<FramedPageEvent, { kind: 'assert' }>): void {
    const rt = buildTarget(ev.el);
    if (ev.el.secret) {
      this.warn(`An expectation on the password field ${rt.label} was ignored: secret values are never recorded.`);
      return;
    }
    for (const d of rt.descriptions) {
      let target: Target;
      try {
        target = describeTarget(d);
      } catch {
        continue;
      }
      let cond: Condition;
      if (ev.value !== undefined) cond = { type: 'valueEquals', target, value: literalValue(ev.value) };
      else if (ev.text) cond = { type: 'textContains', target, value: literalValue(truncateWords(ev.text, 80)) };
      else cond = { type: 'visible', target };
      try {
        if (stable(stripCondition(parseCondition(conditionToText(cond)))) !== stable(stripCondition(cond))) continue;
      } catch {
        continue;
      }
      if (ev.frames?.length && 'target' in cond) cond = { ...cond, target: { ...cond.target, frames: ev.frames } } as Condition;
      this.attachCondition(cond);
      return;
    }
    this.warn(`Could not express an expectation on ${rt.label} in plain English; not recorded.`);
  }

  /** Attach a condition to the previous step (or record a standalone assertion if there is none). */
  attachCondition(cond: Condition): void {
    const last = this.drafts[this.drafts.length - 1];
    if (last) {
      if (!last.postconditions.some((c) => stable(c) === stable(cond))) last.postconditions.push(cond);
      this.opts.onStep?.(`  Expect ${conditionToText(cond)}`);
      return;
    }
    const line = `Assert that ${conditionToText(cond)}`;
    const step = parseIntent(line);
    this.drafts.push({ step, t: Date.now(), postconditions: [] });
    this.opts.onStep?.(line);
  }

  // ------------------------------------------------------------------ result

  result(): RecordingResult {
    const ids = new Map<string, number>();
    const targets: Record<string, LocatorCandidate[]> = {};
    const steps = this.drafts.map((d) => {
      const s: StepInput = { ...d.step, postconditions: [...(d.step.postconditions ?? []), ...d.postconditions] };
      const n = (ids.get(s.id) ?? 0) + 1;
      ids.set(s.id, n);
      if (n > 1) s.id = `${s.id}-${n}`;
      if (d.candidates) targets[s.id] = d.candidates;
      return s;
    });
    const variables = [...this.secrets].sort();
    const name = this.opts.name ?? `Recorded journey on ${this.relUrl(new URL(this.opts.startUrl, this.base))}`;
    const journey = Journey.parse({
      id: this.opts.id ?? slugify(name),
      name,
      ...(variables.length ? { description: `Recorded with eztest record. Supply at run time: ${variables.join(', ')}` } : {}),
      tags: this.opts.tags ?? ['recorded'],
      ...(this.opts.baseUrl ? { baseUrl: this.opts.baseUrl } : {}),
      steps,
    });
    const warnings = [...this.warningList];
    let ez = '';
    try {
      ez = journeyToEzScript(journey);
      if (variables.length) {
        const lines = ez.split('\n');
        const blank = lines.indexOf('');
        const note = [
          `# Variables to supply at run time (never recorded): ${variables.join(', ')}`,
          `#   e.g. ${variables.map((v) => `--var ${v}=...`).join(' ')}  or a secret reference in eztest config`,
        ];
        lines.splice(blank < 0 ? 1 : blank, 0, ...note);
        ez = lines.join('\n');
      }
      const diffs = diffJourneys(journey, parseEzScript(ez));
      if (diffs.length) warnings.push(`The .ez text does not parse back to the recorded journey: ${diffs.join('; ')}`);
    } catch (e) {
      ez = '';
      warnings.push(`The journey cannot be written as .ez (${(e as Error).message}); save it as YAML/JSON instead.`);
    }
    return { journey, ez, warnings, variables, baseUrl: this.base.origin, targets };
  }
}
