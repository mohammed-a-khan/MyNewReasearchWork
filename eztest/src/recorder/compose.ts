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

/**
 * A page event plus the frame chain it came from (empty for the main frame) and the tab it happened in
 * (1-based in opening order; default 1, the tab the recording started in).
 */
export type FramedPageEvent = PageEvent & { frames?: string[]; tab?: number };

export type ComposerEvent =
  | FramedPageEvent
  /** `byPage`: the page started it (link, form, script); false when typed/opened directly. Default true. */
  | { kind: 'navigate'; url: string; t: number; byPage?: boolean; tab?: number }
  | { kind: 'expect'; condition: Condition; t: number; tab?: number }
  /** A JavaScript dialog the user answered (OK / Cancel, the prompt's text). */
  | { kind: 'dialog'; type: string; message: string; accepted: boolean; userInput?: string; t: number; tab?: number }
  /** A tab, window or popup opened or closed. */
  | { kind: 'tab'; op: 'open' | 'close'; tab: number; t: number }
  /** A download started (attributed to the click just before it). */
  | { kind: 'download'; filename: string; t: number; tab?: number };

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
  /** The tab it happened in (see FramedPageEvent). */
  tab?: number;
  /** The frame chain it happened in: consecutive steps in one frame become an `In frame ... End` block. */
  frames?: string[];
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

function stripTarget(t: { description: string; locators?: unknown; frames?: string[] } | undefined): unknown {
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
  private readonly captureNames = new Set<string>();
  private readonly base: URL;
  private lastActionT = 0;
  private navConsumed = false;
  private navT = 0;
  private navDraft?: Draft;
  private navCondition?: Condition;
  // Tabs, as the runner will see them on replay: opening order, the current one and the switch history.
  private readonly openTabs: number[] = [1];
  private readonly visited = new Set<number>([1]);
  private readonly tabHistory: number[] = [];
  private readonly tabUrl = new Map<number, URL>();
  private readonly tabOpenedT = new Map<number, number>();
  private runnerTab = 1;
  private readonly closedByPage = new Set<number>();

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

  /** The URL of the tab the journey is on. */
  private get current(): URL | undefined {
    return this.tabUrl.get(this.runnerTab);
  }

  /** Record the initial `Open <url>` step. */
  start(t: number): void {
    const u = new URL(this.opts.startUrl, this.base);
    this.tabUrl.set(1, u);
    this.addNavigate(u, t);
    this.navConsumed = false;
  }

  apply(ev: ComposerEvent): void {
    switch (ev.kind) {
      case 'navigate': return this.onNavigate(ev.url, ev.t, ev.byPage ?? true, ev.tab ?? 1);
      case 'expect':
        // Typed while looking at another tab (a popup that just opened): it is about that tab.
        if (ev.tab !== undefined) this.ensureTab(ev.tab, ev.t);
        return this.attachCondition(ev.condition);
      case 'closing':
        this.closedByPage.add(ev.tab ?? 1);
        return;
      case 'tab': return ev.op === 'open' ? this.onTabOpened(ev.tab, ev.t) : this.onTabClosed(ev.tab, ev.t);
      case 'dialog': return this.onDialog(ev);
      case 'download': return this.onDownload(ev);
      default: break;
    }
    this.ensureTab(ev.tab ?? 1, ev.t);
    switch (ev.kind) {
      case 'assert': return this.onAssert(ev);
      case 'click': return this.action(ev.button === 'right' ? 'rightclick' : 'click', ev);
      case 'hover': {
        const last = this.drafts[this.drafts.length - 1];
        if (last && last.step.action === 'hover' && last.elKey === ev.el.key) return;
        return this.action('hover', ev);
      }
      case 'drag': return this.onDrag(ev);
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
        if (!/[\\/]/.test(ev.files[0])) this.warn(`Upload of "${ev.files[0]}": the browser only reveals file names; edit the step to the file's path relative to where tests run.`);
        return this.action('upload', ev, literalValue(ev.files[0]));
      }
    }
  }

  // ------------------------------------------------------------------ tabs and popups

  private onTabOpened(tab: number, t: number): void {
    if (!this.openTabs.includes(tab)) this.openTabs.push(tab);
    this.tabOpenedT.set(tab, t);
  }

  private onTabClosed(tab: number, t: number): void {
    const i = this.openTabs.indexOf(tab);
    if (i < 0) return;
    this.openTabs.splice(i, 1);
    for (let h = this.tabHistory.length - 1; h >= 0; h--) if (this.tabHistory[h] === tab) this.tabHistory.splice(h, 1);
    if (tab !== this.runnerTab) return;
    // A tab the page closed itself (window.close() behind a "Close" button) needs no step; the person closing it does.
    if (!this.closedByPage.has(tab) && this.openTabs.length) this.addLine('Close the tab', t, (s) => s.action === 'tab' && s.args?.op === 'close');
    this.runnerTab = this.tabHistory.pop() ?? this.openTabs[0] ?? 1;
  }

  /** Before an action in another tab than the journey is on: switch to it, the way the runner will. */
  private ensureTab(tab: number, t: number): void {
    if (tab === this.runnerTab || !this.openTabs.includes(tab)) return;
    const unvisited = this.openTabs.filter((n) => !this.visited.has(n));
    const isNew = !this.visited.has(tab) && unvisited[0] === tab;
    const last = this.drafts[this.drafts.length - 1];
    let draft: Draft | undefined;
    // "Click X and switch to the new tab" when the click opened it (and nothing else is checked after the click).
    if (isNew && last && last.tab === this.runnerTab && last.step.action === 'click' && !last.step.args && !last.frames?.length &&
      last.postconditions.length === 0 && (this.tabOpenedT.get(tab) ?? t) >= last.t - 50) {
      try {
        const step = parseIntent(`${last.step.intent} and switch to the new tab`);
        if (step.action === 'click' && step.args?.newPage === 'switch' && step.target && stable(stripTarget(step.target)) === stable(stripTarget({ ...last.step.target!, frames: undefined }))) {
          step.target = last.step.target;
          last.step = step;
          draft = last;
          this.opts.onStep?.(step.intent);
        }
      } catch {
        // a separate switch step below
      }
    }
    if (!draft) {
      const line = isNew ? 'Switch to the new tab' : tab === this.openTabs[0] ? 'Switch back to the main tab' : `Switch to tab ${this.openTabs.indexOf(tab) + 1}`;
      draft = this.addLine(line, t, (s) => s.action === 'tab' && s.args?.op === 'switch');
    }
    if (this.runnerTab !== tab) this.tabHistory.push(this.runnerTab);
    this.runnerTab = tab;
    this.visited.add(tab);
    if (!draft) return;
    draft.tab = tab;
    // Where the switch lands: the tab's address, so the replay checks it is the right one.
    const u = this.tabUrl.get(tab);
    if (isNew && u && (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:')) {
      const s = this.stableUrlOf(u);
      if (!(s === '/' && u.pathname !== '/')) {
        const cond: Condition = { type: 'urlContains', value: s };
        draft.postconditions.push(cond);
        this.opts.onStep?.(`  Expect ${conditionToText(cond)}`);
        this.navCondition = cond;
      }
    }
    this.navConsumed = true;
    this.navDraft = draft;
    this.navT = t;
    this.lastActionT = t;
  }

  /** A step from a fixed line (tab switches, dialogs), kept only if it parses to what `ok` expects. */
  private addLine(line: string, t: number, ok: (s: StepInput) => boolean, at?: number, frames?: string[]): Draft | undefined {
    let step: StepInput;
    try {
      step = parseIntent(line);
    } catch {
      this.warn(`"${line}" could not be recorded.`);
      return undefined;
    }
    if (!ok(step)) {
      this.warn(`"${line}" could not be recorded.`);
      return undefined;
    }
    const draft: Draft = { step, t, postconditions: [], tab: this.runnerTab, ...(frames?.length ? { frames } : {}) };
    if (at === undefined) this.drafts.push(draft);
    else this.drafts.splice(at, 0, draft);
    this.opts.onStep?.(frames?.length ? `${frameOpener(frames)}: ${line}` : line);
    return draft;
  }

  // ------------------------------------------------------------------ dialogs and downloads

  private onDialog(ev: Extract<ComposerEvent, { kind: 'dialog' }>): void {
    if (ev.type === 'beforeunload') return;
    const tab = ev.tab ?? 1;
    // The step that opened it: the last one in its tab.
    let i = this.drafts.length - 1;
    while (i > 0 && (this.drafts[i].tab ?? 1) !== tab) i--;
    const trigger = this.drafts[i];
    if (!trigger) return;
    const kind = ev.type === 'confirm' || ev.type === 'prompt' ? ev.type : 'alert';
    let line: string;
    if (kind === 'alert') line = 'Accept the next alert';
    else if (!ev.accepted) line = `Dismiss the next ${kind} dialog`;
    else if (kind === 'prompt') {
      let q: string;
      try {
        q = quoteText(literalValue(ev.userInput ?? ''));
      } catch {
        this.warn(`The answer to the prompt "${ev.message}" cannot be written in .ez; it was recorded as accepted without text.`);
        q = '';
      }
      line = q ? `Answer the next prompt with ${q}` : 'Accept the next prompt dialog';
    } else line = 'Accept the next confirm dialog';
    const at = this.drafts.indexOf(trigger);
    const armed = this.addLine(line, trigger.t, (s) => s.action === 'dialog', at, trigger.frames);
    if (armed) armed.tab = tab;
    const message = truncateWords(ev.message.replace(/\s+/g, ' ').trim(), 80);
    const cond: Condition = { type: 'dialogSeen', kind, ...(message ? { contains: literalValue(message) } : {}) } as Condition;
    try {
      const back = parseCondition(conditionToText(cond));
      if (stable(back) !== stable(cond)) throw new Error('no round trip');
      if (!trigger.postconditions.some((c) => stable(c) === stable(cond))) trigger.postconditions.push(cond);
      this.opts.onStep?.(`  Expect ${conditionToText(cond)}`);
    } catch {
      const plain: Condition = { type: 'dialogSeen', kind } as Condition;
      trigger.postconditions.push(plain);
    }
  }

  private onDownload(ev: Extract<ComposerEvent, { kind: 'download' }>): void {
    const tab = ev.tab ?? 1;
    const last = this.drafts[this.drafts.length - 1];
    if (!last || (last.tab ?? 1) !== tab || last.step.action !== 'click' || last.step.args || ev.t - last.t > NAV_WINDOW_MS || !last.step.target) {
      this.warn(`A download of "${ev.filename}" started without a click to attribute it to; not recorded.`);
      return;
    }
    const base = camel(ev.filename.replace(/\.[^.]*$/, '')) || 'download';
    let name = /^download/i.test(base) ? base : `${base}File`;
    for (let n = 2; this.captureNames.has(name); n++) name = `${base}File${n}`;
    const line = `Download ${last.step.target.description} as ${name}`;
    try {
      const step = parseIntent(line);
      if (step.action !== 'download' || step.captureAs !== name || !step.target || stable(stripTarget(step.target)) !== stable(stripTarget({ ...last.step.target, frames: undefined }))) throw new Error('no round trip');
      step.target = last.step.target;
      last.step = step;
      this.captureNames.add(name);
      const cond: Condition = { type: 'downloadExists', captureKey: name } as Condition;
      last.postconditions.push(cond);
      this.opts.onStep?.(line);
    } catch {
      this.warn(`A download of "${ev.filename}" could not be written as a Download step; it stays a click.`);
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
    draft.tab = this.runnerTab;
    if (ev.frames?.length) draft.frames = ev.frames;
    this.drafts.push(draft);
    this.lastActionT = ev.t;
    this.navConsumed = false;
    this.opts.onStep?.(ev.frames?.length ? `${frameOpener(ev.frames)}: ${draft.step.intent}` : draft.step.intent);
  }

  private onDrag(ev: Extract<FramedPageEvent, { kind: 'drag' }>): void {
    const from = buildTarget(ev.el);
    const to = buildTarget(ev.to);
    for (const a of from.descriptions) {
      for (const b of to.descriptions) {
        if (a === b) continue;
        const line = `Drag ${a} to ${b}`;
        let step: StepInput;
        try {
          step = parseIntent(line);
        } catch {
          continue;
        }
        if (step.action !== 'drag' || !step.target || !step.to) continue;
        if (stable(step.target) !== stable(describeTarget(a)) || stable(step.to) !== stable(describeTarget(b))) continue;
        step.target = { ...step.target, fingerprint: from.fingerprint, ...(ev.frames?.length ? { frames: ev.frames } : {}) };
        step.to = { ...step.to, fingerprint: to.fingerprint, ...(ev.frames?.length ? { frames: ev.frames } : {}) };
        const draft: Draft = { step, t: ev.t, postconditions: [], tab: this.runnerTab, candidates: from.candidates, elKey: ev.el.key, ...(ev.frames?.length ? { frames: ev.frames } : {}) };
        this.drafts.push(draft);
        this.lastActionT = ev.t;
        this.navConsumed = false;
        this.opts.onStep?.(ev.frames?.length ? `${frameOpener(ev.frames)}: ${line}` : line);
        return;
      }
    }
    this.warn(`Could not express a drag from ${from.label} to ${to.label} as a plain-English step; it was not recorded.`);
  }

  private lineFor(kind: ActionType | 'rightclick', d: string, value?: string): string[] {
    const q = value === undefined ? undefined : (() => {
      try {
        return quoteText(value);
      } catch {
        return undefined;
      }
    })();
    switch (kind) {
      case 'click': return [`Click ${d}`];
      case 'rightclick': return [`Right-click ${d}`];
      case 'dblclick': return [`Double-click ${d}`];
      case 'hover': return [`Hover over ${d}`];
      case 'fill': return q ? [`Type ${q} into ${d}`] : [];
      case 'clear': return [`Clear ${d}`];
      case 'select': return q ? [`Select ${q} from ${d}`] : [];
      case 'check': return [`Check ${d}`];
      case 'uncheck': return [`Uncheck ${d}`];
      case 'press': {
        const keys = [value ?? '', ...(q ? [q] : [])];
        return keys.map((k) => (d ? `Press ${k} in ${d}` : `Press ${k}`));
      }
      case 'upload': return q ? [`Upload ${q} to ${d}`] : [];
      default: return [];
    }
  }

  /** Write the line, parse it back, and keep it only if it means exactly this action on this target. */
  private makeDraft(kind: ActionType | 'rightclick', rt: RecordedTarget | undefined, value: string | undefined, frames?: string[]): Draft | undefined {
    const action: ActionType = kind === 'rightclick' ? 'click' : kind;
    const descriptions = rt ? rt.descriptions : [''];
    for (const d of descriptions) {
      for (const line of this.lineFor(kind, d, value)) {
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
        return { step, t: 0, postconditions: [], tab: this.runnerTab, ...(rt ? { candidates: rt.candidates } : {}) };
      }
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
        const draft: Draft = { step, t, postconditions: [], tab: this.runnerTab };
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

  private onNavigate(url: string, t: number, byPage: boolean, tab: number): void {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'file:') return;
    const prev = this.tabUrl.get(tab);
    this.tabUrl.set(tab, u);
    // Another tab moving on its own: its address is checked when the journey switches to it.
    if (tab !== this.runnerTab) return;
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
      const draft: Draft = { step, t, postconditions: [], tab: this.runnerTab };
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
    // The person did something on this page: a navigation after it is not a redirect of the step before.
    this.navDraft = undefined;
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
      this.attachCondition(cond, ev.frames);
      return;
    }
    this.warn(`Could not express an expectation on ${rt.label} in plain English; not recorded.`);
  }

  /**
   * Attach a condition to the previous step (or record a standalone assertion if there is none, or when the
   * condition is about an element in another frame than that step).
   */
  attachCondition(cond: Condition, frames?: string[]): void {
    const last = this.drafts[this.drafts.length - 1];
    const sameFrame = !frames?.length || stable(frames) === stable(last?.frames ?? []);
    if (last && sameFrame) {
      if (!last.postconditions.some((c) => stable(c) === stable(cond))) last.postconditions.push(cond);
      this.opts.onStep?.(`  Expect ${conditionToText(cond)}`);
      return;
    }
    const line = `Assert that ${conditionToText(cond)}`;
    const step = parseIntent(line);
    if (frames?.length) step.postconditions = (step.postconditions ?? []).map((c) => withFrames(c, frames));
    this.drafts.push({ step, t: Date.now(), postconditions: [], tab: this.runnerTab, ...(frames?.length ? { frames } : {}) });
    this.opts.onStep?.(frames?.length ? `${frameOpener(frames)}: ${line}` : line);
  }

  // ------------------------------------------------------------------ result

  result(): RecordingResult {
    const ids = new Map<string, number>();
    const targets: Record<string, LocatorCandidate[]> = {};
    const uniqueId = (s: StepInput) => {
      const n = (ids.get(s.id) ?? 0) + 1;
      ids.set(s.id, n);
      if (n > 1) s.id = `${s.id}-${n}`;
    };
    const steps: StepInput[] = [];
    // Steps in a frame go into an `In frame ... End` block. A check of the address, title or tabs (a link in a
    // frame that loads the whole page) ends the block and is checked after it; text checks stay in the frame.
    let block: { frames: string[]; step: StepInput } | undefined;
    for (const d of this.drafts) {
      const s: StepInput = { ...d.step, postconditions: [...(d.step.postconditions ?? []), ...d.postconditions] };
      const frames = d.frames ?? [];
      if (!frames.length) {
        block = undefined;
        uniqueId(s);
        if (d.candidates) targets[s.id] = d.candidates;
        steps.push(s);
        continue;
      }
      if (!block || stable(block.frames) !== stable(frames)) {
        const opener = parseIntent(frameOpener(frames));
        opener.steps = [];
        uniqueId(opener);
        block = { frames, step: opener };
        steps.push(opener);
      }
      if (s.target) s.target = withoutFrames(s.target, frames);
      if (s.to) s.to = withoutFrames(s.to, frames);
      const own = (s.postconditions ?? []).filter((c) => !TOP_LEVEL.has(c.type)).map((c) => stripFrames(c, frames));
      const page = (s.postconditions ?? []).filter((c) => TOP_LEVEL.has(c.type));
      s.postconditions = own;
      uniqueId(s);
      if (d.candidates) targets[s.id] = d.candidates;
      block.step.steps!.push(s);
      if (page.length) {
        block.step.postconditions = [...(block.step.postconditions ?? []), ...page];
        block = undefined;
      }
    }
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

/** Conditions about the top-level page, not the frame a step ran in. */
const TOP_LEVEL: ReadonlySet<string> = new Set(['urlContains', 'urlMatches', 'titleContains', 'titleMatches', 'tabCount']);

/** `In frame "outer" > "inner"` for a frame chain. */
function frameOpener(frames: string[]): string {
  return `In frame ${frames.map((f) => quoteText(f)).join(' > ')}`;
}

function withoutFrames<T extends { frames?: string[] }>(t: T, frames: string[]): T {
  if (!t.frames || stable(t.frames) !== stable(frames)) return t;
  const { frames: _f, ...rest } = t;
  return rest as T;
}

function stripFrames<C extends object>(c: C, frames: string[]): C {
  const t = (c as { target?: { frames?: string[] } }).target;
  return t ? ({ ...c, target: withoutFrames(t, frames) } as C) : c;
}

function withFrames<C extends object>(c: C, frames: string[]): C {
  const t = (c as { target?: object }).target;
  return t ? ({ ...c, target: { ...t, frames } } as C) : c;
}

/**
 * A path without its one-time parts: everything before the first segment that is different on every run (UUIDs,
 * long hex or digit ids, random tokens such as a password-reset or session code). `/auth/changeWeakPassword/resetCode/YeC8lO2a...`
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
  if (/^\d{6,}$/.test(seg)) return true; // long numeric id
  if (/^[0-9a-f]{12,}$/i.test(seg) && /\d/.test(seg) && /[a-f]/i.test(seg)) return true; // hex id / hash
  // A random token: long, no separators a word would have, letters and digits mixed with case changes.
  if (seg.length >= 16 && /^[\w~.+=-]+$/.test(seg) && /\d/.test(seg) && /[a-z]/.test(seg) && /[A-Z]/.test(seg) && !/^[A-Z]?[a-z]+(?:[A-Z][a-z]+)+\d*$/.test(seg)) return true;
  return false;
}
