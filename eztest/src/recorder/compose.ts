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
/** The run-time variable a recorded one-time code step reads its TOTP secret (base32) from. */
export const TOTP_VARIABLE = 'totpSecret';
/** Internal marker of a recorded one-time code (never a real value). */
const TOTP_VALUE = '\u0000totp';

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
  /** The last option picked from a list, so the app filling its field with it is not recorded as typing. */
  private lastPick?: { t: number; text: string };
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
      case 'click':
        if (ev.picked) this.lastPick = { t: ev.t, text: ev.picked };
        return this.action(ev.button === 'right' ? 'rightclick' : 'click', ev);
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
        // The app writing the picked suggestion into its field ("Ayesha" -> "Ayesha  Rahman") is not typing.
        const sameText = (a: string, b: string) => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();
        if (value !== undefined && this.lastPick && ev.t - this.lastPick.t < 3000 && sameText(value, this.lastPick.text)) return;
        const last = this.drafts[this.drafts.length - 1];
        const coalesce = last && (last.step.action === 'fill' || last.step.action === 'clear') && last.elKey === ev.el.key;
        if (coalesce) this.drafts.pop();
        if (!ev.secret && value === '') return this.action('clear', ev, undefined, coalesce ? last.t : undefined);
        if (ev.otp || ev.el.otp) {
          // The code typed now is useless on replay: the step computes a fresh one from the TOTP secret.
          this.secrets.add(TOTP_VARIABLE);
          return this.action('fill', ev, TOTP_VALUE, coalesce ? last.t : undefined);
        }
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
      case 'choose': {
        this.lastPick = { t: ev.t, text: ev.option };
        // The click that opened the list and the pick become one step: Select "Admin" from the "User Role" dropdown.
        const last = this.drafts[this.drafts.length - 1];
        const box = buildTarget(ev.el);
        if (!box.ambiguous && box.kind === 'combobox') {
          // Its opening click, when the browser reported one, is part of this step.
          const opened = last && last.step.action === 'click' && last.elKey === ev.el.key && last.postconditions.length === 0;
          if (opened) this.drafts.pop();
          return this.action('select', ev, literalValue(ev.option), opened ? last.t : undefined);
        }
        return this.action('click', { ...ev, el: ev.optionEl });
      }
      case 'retract': {
        const i = this.drafts.map((d) => d.elKey).lastIndexOf(ev.key);
        const d = i >= 0 ? this.drafts[i] : undefined;
        if (d && d.step.action === 'click') {
          this.drafts.splice(i, 1);
          this.warn(`A click on ${d.step.target?.description ?? 'an element'} was left out: the element disappeared right after (a loading overlay or backdrop).`);
        }
        return;
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
      case 'fill': return value === TOTP_VALUE ? `Type the one-time code from \${${TOTP_VARIABLE}} into ${d}` : q && `Type ${q} into ${d}`;
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
      if (value === TOTP_VALUE) {
        if (step.action !== 'fill' || step.args?.totp !== `\${${TOTP_VARIABLE}}`) continue;
      } else if (step.action !== action || (step.value ?? undefined) !== value) continue;
      if (kind === 'rightclick' && step.args?.button !== 'right') continue;
      if (rt) {
        const want = describeTarget(d);
        if (!step.target || stable(step.target) !== stable(want)) continue;
        step.target = { ...step.target, fingerprint: rt.fingerprint, ...(frames?.length ? { frames } : {}) };
        const positional = /^the \d+(?:st|nd|rd|th) /.test(d);
        if (positional) this.warn(`"${line}": ${rt.note ?? 'the name repeats'}; recorded by position, which changes if items are added or reordered (a test id or a unique label is steadier).`);
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

  /** The URL an expectation can rely on on every run: the path up to the first one-time segment (see stablePath). */
  private stableUrlOf(u: URL): string {
    const p = stablePath(u.pathname);
    return u.origin === this.base.origin ? p : `${u.origin}${p}`;
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
    const stable = this.stableUrlOf(u);
    // Only a one-time token in the path (a reset code, a session id): nothing to expect about the URL.
    if (stable === '/' && u.pathname !== '/') {
      this.navConsumed = true;
      return;
    }
    const cond: Condition = { type: 'urlContains', value: stable };
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

/**
 * A path without its one-time parts: everything before the first segment that is different on every run (UUIDs,
 * hex or digit ids, random tokens such as a password-reset or session code). `/auth/changeWeakPassword/resetCode/YeC8lO2a...`
 * becomes `/auth/changeWeakPassword/resetCode/`, `/orders/58213907/edit` becomes `/orders/`.
 */
export function stablePath(pathname: string): string {
  const parts = pathname.split('/');
  for (let i = 1; i < parts.length; i++) {
    if (volatileSegment(decodeURIComponent(parts[i]))) return `${parts.slice(0, i).join('/')}/`;
  }
  return pathname;
}

function volatileSegment(seg: string): boolean {
  if (!seg) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true; // UUID
  if (/^\d+$/.test(seg)) return true; // a record id (`/empNumber/7` of the employee just created differs every run)
  if (/^[0-9a-f]{12,}$/i.test(seg) && /\d/.test(seg) && /[a-f]/i.test(seg)) return true; // hex id / hash
  // A random token: long, no separators a word would have, letters and digits mixed with case changes.
  if (seg.length >= 16 && /^[\w~.+=-]+$/.test(seg) && /\d/.test(seg) && /[a-z]/.test(seg) && /[A-Z]/.test(seg) && !/^[A-Z]?[a-z]+(?:[A-Z][a-z]+)+\d*$/.test(seg)) return true;
  return false;
}
