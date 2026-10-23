/**
 * Windows (UI Automation) and Java (Swing/AWT) desktop apps as a surface of
 * the driver ladder, through EZTest's own agents (agent.ts). EZ target
 * descriptions map to agent elements: `#SaveBtn` / `testid=SaveBtn` is an
 * AutomationId (Swing: component name); `the "Save" button` is Name +
 * ControlType; `the "Customer" field` is an Edit whose label (LabeledBy /
 * JLabel.labelFor) or name is "Customer"; `... in the "Invoice" window`
 * scopes to that top-level window. Matching is strict (exactly one element);
 * when it fails, the recorded fingerprint heals the step (verified by its
 * post-conditions), exactly like web steps.
 */
import type { Condition, ConditionResult, ElementFingerprint, LocatorCandidate, Step, Target } from '../core/index.js';
import { pickBest, scoreFingerprint } from '../heal/score.js';
import { analyzeDescription, type TargetKind } from '../intent/target.js';
import type { ConditionEnv } from '../runner/conditions.js';
import type { InterceptorRuntime } from '../runner/surface.js';
import type { StepContext } from '../runner/types.js';
import { AgentError, parseAgentKeys, type AgentClient, type AgentElement, type AgentWindow } from './agent.js';
import { evaluateTextConditions, unsupported, type ActResult, type DesktopSurface, type SurfaceCapture } from './surface.js';

/** UI Automation control types for each EZ element kind (generic: any). */
export const KIND_CONTROL_TYPES: Partial<Record<TargetKind, string[]>> = {
  button: ['Button', 'SplitButton'], link: ['Hyperlink', 'Button'], textbox: ['Edit', 'Document', 'ComboBox'], combobox: ['ComboBox', 'List'],
  checkbox: ['CheckBox'], radio: ['RadioButton'], switch: ['CheckBox', 'Button'], slider: ['Slider', 'Spinner'], tab: ['TabItem'],
  heading: ['Text', 'Header', 'HeaderItem'], img: ['Image'], table: ['DataGrid', 'Table', 'List'], row: ['DataItem', 'ListItem', 'TreeItem'],
  cell: ['DataItem', 'Edit', 'Text', 'Custom'], option: ['ListItem', 'MenuItem', 'TreeItem'], dialog: ['Window'], message: ['Text', 'StatusBar'],
  text: ['Text', 'Edit', 'Document'], menuitem: ['MenuItem'], menu: ['Menu', 'MenuBar', 'MenuItem'], region: ['Pane', 'Group'],
  navigation: ['Tree', 'ToolBar'], list: ['List', 'Tree'],
};

const WINDOW_SUFFIX = /^(.*?)\s+(?:in|on|of)\s+(?:the\s+)?"([^"]+)"\s+(?:window|dialog|form)$/i;
const clean = (s: string | undefined) => (s ?? '').replace(/&(?=\S)/g, '').replace(/[\s:]+$/, '').replace(/\s+/g, ' ').trim();

export interface Located {
  el: AgentElement;
  window: AgentWindow;
  used: LocatorCandidate;
  heal?: ActResult['heal'];
}

export class AgentSurface implements DesktopSurface {
  window?: AgentWindow;

  constructor(
    readonly kind: 'windows' | 'java',
    readonly name: string,
    readonly client: AgentClient,
    /** Called when the surface closes (e.g. stop a spawned JVM). */
    private readonly onClose?: () => Promise<void>,
  ) {}

  get label(): string {
    return `${this.kind === 'java' ? 'Java' : 'Windows'} app "${this.name}"${this.window ? ` (window "${this.window.title}")` : ''}`;
  }

  get driver(): string {
    return this.kind;
  }

  accepts(step: Step): boolean {
    return !['api', 'db', 'set', 'wait', 'useData', 'compareDocument', 'email', 'sms', 'ws', 'compareData', 'login', 'navigate', 'runJourney'].includes(step.action);
  }

  async useWindow(titleOrWindow: string | AgentWindow): Promise<AgentWindow> {
    if (typeof titleOrWindow !== 'string') {
      this.window = titleOrWindow;
      return titleOrWindow;
    }
    const all = await this.client.windows();
    const exact = all.filter((w) => w.title === titleOrWindow);
    const loose = exact.length ? exact : all.filter((w) => w.title.toLowerCase().includes(titleOrWindow.toLowerCase()));
    if (loose.length !== 1) throw new AgentError(`${loose.length ? `${loose.length} windows match` : 'no window matches'} "${titleOrWindow}" (open: ${all.map((w) => `"${w.title}"`).join(', ') || 'none'})`, 'no-window');
    this.window = loose[0];
    await this.client.activate(loose[0].id).catch(() => undefined);
    return loose[0];
  }

  /** The window steps act on; when it closed (a dialog was dismissed), the app's remaining window. */
  private async currentWindow(): Promise<AgentWindow> {
    const all = await this.client.windows();
    const cur = this.window && all.find((w) => w.id === this.window!.id);
    if (cur) return (this.window = cur);
    const sameApp = this.window?.pid !== undefined ? all.filter((w) => w.pid === this.window!.pid) : [];
    const next = sameApp[0] ?? all[0];
    if (!next) throw new AgentError(`${this.label} has no open window`, 'no-window');
    this.window = next;
    return next;
  }

  private async elementsOf(w: AgentWindow): Promise<AgentElement[]> {
    return (await this.client.elements(w.id)).elements;
  }

  /** Candidates for a target in a list of elements. */
  match(elements: AgentElement[], target: Target): { matches: AgentElement[]; used: LocatorCandidate } {
    let d = target.description.trim();
    const sfx = WINDOW_SUFFIX.exec(d);
    if (sfx) d = sfx[1];
    // Explicit ids: #id, testid=, automationid=
    const id = /^(?:#|(?:testid|test-id|automation\s*id|automationid|accessibility\s*id)\s*[=:]\s*)["']?([^"'\s]+)["']?$/i.exec(d);
    if (id) return { matches: elements.filter((e) => e.automationId === id[1]), used: { strategy: 'testId', value: id[1] } };
    const byId = /^(?:the\s+)?element\s+with\s+(?:the\s+)?(?:automation\s*)?id\s+"?([^"]+)"?$/i.exec(d);
    if (byId) return { matches: elements.filter((e) => e.automationId === byId[1]), used: { strategy: 'testId', value: byId[1] } };
    const { kind, name } = analyzeDescription(d);
    const types = KIND_CONTROL_TYPES[kind];
    const typed = types ? elements.filter((e) => types.includes(e.controlType)) : elements;
    if (!name) return { matches: typed, used: { strategy: 'role', value: types?.[0] ?? '*' } };
    const labelled = kind === 'textbox' || kind === 'combobox' || kind === 'slider' || kind === 'generic';
    const exact = (e: AgentElement) => e.name === name || e.automationId === name || (labelled && e.labeledBy === name);
    const loose = (e: AgentElement) => {
      const n = clean(name).toLowerCase();
      return clean(e.name).toLowerCase() === n || clean(e.labeledBy).toLowerCase() === n || (e.automationId ?? '').toLowerCase() === n.replace(/\s+/g, '');
    };
    let m = typed.filter(exact);
    if (!m.length) m = typed.filter(loose);
    // A text box named by the label just before it (labels without labelFor/LabeledBy).
    if (!m.length && labelled) m = this.byPrecedingLabel(elements, name, types ?? ['Edit', 'ComboBox', 'Document']);
    if (m.length > 1) {
      const visible = m.filter((e) => e.visible !== false);
      if (visible.length) m = visible;
    }
    return { matches: m, used: { strategy: 'role', value: types?.[0] ?? 'element', name } };
  }

  private byPrecedingLabel(elements: AgentElement[], name: string, types: string[]): AgentElement[] {
    const n = clean(name).toLowerCase();
    const out: AgentElement[] = [];
    elements.forEach((e, i) => {
      if (e.controlType !== 'Text' || clean(e.name).toLowerCase() !== n) return;
      const next = elements.slice(i + 1).find((x) => types.includes(x.controlType) && x.parent === e.parent);
      if (next) out.push(next);
    });
    return out;
  }

  fingerprint(e: AgentElement, w: AgentWindow): ElementFingerprint {
    return {
      tag: e.controlType,
      ...(e.name ? { name: e.name } : {}),
      ...(e.automationId ? { id: e.automationId } : {}),
      ...(e.labeledBy ? { label: e.labeledBy } : {}),
      ...(e.className ? { classes: [e.className] } : {}),
      attributes: { ...(e.framework ? { framework: e.framework } : {}), window: w.title },
      ...(e.rect ? { box: e.rect } : {}),
    };
  }

  /** Locate exactly one element, then T0 (cached heal) and T1 (fingerprint) healing. */
  async locate(target: Target, ctx: StepContext, rt: InterceptorRuntime, step: Step): Promise<Located> {
    const sfx = WINDOW_SUFFIX.exec(target.description.trim());
    let w = sfx ? await this.useWindow(sfx[2]) : await this.currentWindow();
    let elements = await this.elementsOf(w);
    let { matches, used } = this.match(elements, target);
    if (!matches.length && !sfx) {
      // Modal dialogs are separate top-level windows: look there too.
      for (const other of (await this.client.windows()).filter((x) => x.id !== w.id)) {
        const els = await this.elementsOf(other);
        const r = this.match(els, target);
        if (r.matches.length === 1) {
          this.window = other;
          w = other;
          elements = els;
          ({ matches, used } = r);
          break;
        }
      }
    }
    if (matches.length === 1) return { el: matches[0], window: w, used };
    if (matches.length > 1) throw new AgentError(`${target.description} matches ${matches.length} elements in window "${w.title}" (${matches.slice(0, 4).map((e) => `${e.controlType} "${e.name ?? e.automationId ?? ''}"`).join(', ')}); be more specific`, 'ambiguous');
    const why = `${target.description} was not found in window "${w.title}"`;
    const mem = rt.store.get(ctx.journey.id, step.id);
    const original: LocatorCandidate[] = [used];
    if (mem?.healed) {
      const c = mem.healed.locator;
      const hit = elements.filter((e) => (c.strategy === 'testId' ? e.automationId === c.value : e.controlType === c.value && e.name === c.name));
      if (hit.length === 1) return { el: hit[0], window: w, used: c, heal: { tier: 'T0-cache', confidence: mem.healed.confidence, reason: `cached verified heal: ${why}`, original, healed: c } };
    }
    if (mem?.fingerprint) {
      const ranked = elements.filter((e) => e.visible !== false).map((e) => ({ item: e, score: scoreFingerprint(mem.fingerprint!, this.fingerprint(e, w)).score }));
      const pick = pickBest(ranked, 0.7, 0.1);
      if (pick.ok) {
        const e = pick.best.item;
        const healed: LocatorCandidate = e.automationId ? { strategy: 'testId', value: e.automationId } : { strategy: 'role', value: e.controlType, name: e.name ?? '' };
        return { el: e, window: w, used: healed, heal: { tier: 'T1-fingerprint', confidence: Math.round(pick.best.score * 100) / 100, reason: `${why}; ${e.controlType} "${e.name ?? e.automationId}" matches the recorded fingerprint`, original, healed } };
      }
    }
    throw new AgentError(why, 'no-element');
  }

  private result(l: Located, extra: Partial<ActResult> = {}): ActResult {
    const via = l.used.strategy === 'testId' ? `AutomationId "${l.used.value}"` : `${l.el.controlType} "${l.el.name ?? ''}"`;
    return {
      surface: { driver: this.kind, rung: 'object', via: `${via} in window "${l.window.title}"`, ...(l.el.rect ? { box: l.el.rect } : {}) },
      usedLocator: l.used,
      fingerprint: this.fingerprint(l.el, l.window),
      ...(l.heal ? { heal: l.heal } : {}),
      ...extra,
    };
  }

  async act(step: Step, ctx: StepContext, rt: InterceptorRuntime): Promise<ActResult | undefined> {
    const v = (s: string | undefined) => ctx.interpolate(s ?? '');
    const c = this.client;
    const args = step.args ?? {};
    switch (step.action) {
      case 'click':
      case 'dblclick': {
        const l = await this.locate(step.target!, ctx, rt, step);
        const r = l.el.rect;
        if (step.action === 'dblclick' || args.button === 'right' || args.button === 'middle') {
          if (!r) throw new AgentError(`${step.target!.description} has no screen position to click`, 'no-rect');
          await c.mouse({ x: r.x + r.width / 2, y: r.y + r.height / 2, double: step.action === 'dblclick', ...(args.button ? { button: args.button as 'right' } : {}) });
        } else await c.invoke(l.el.id);
        return this.result(l, { newScreen: true });
      }
      case 'fill':
      case 'clear': {
        const l = await this.locate(step.target!, ctx, rt, step);
        const text = step.action === 'clear' ? '' : v(step.value);
        await c.setValue(l.el.id, text);
        const now = await c.getValue(l.el.id).catch(() => undefined);
        return this.result(l, { implied: { ok: now === text, message: now === text ? 'the field holds the typed value' : `the field holds "${now ?? '?'}"` } });
      }
      case 'select': {
        const l = await this.locate(step.target!, ctx, rt, step);
        const want = v(step.value);
        await c.expand(l.el.id).catch(() => undefined);
        const items = (await this.elementsOf(l.window)).filter((e) => (e.controlType === 'ListItem' || e.controlType === 'MenuItem') && clean(e.name) === clean(want));
        if (items.length === 1) await c.select(items[0].id);
        else await c.setValue(l.el.id, want);
        await c.collapse(l.el.id).catch(() => undefined);
        const now = await c.getValue(l.el.id).catch(() => undefined);
        return this.result(l, { implied: { ok: now === want, message: now === want ? 'the selection holds the value' : `the selection is "${now ?? '?'}"` } });
      }
      case 'check':
      case 'uncheck': {
        const l = await this.locate(step.target!, ctx, rt, step);
        await c.toggle(l.el.id, step.action === 'check' ? 'on' : 'off');
        return this.result(l);
      }
      case 'press': {
        const keys = parseAgentKeys(v(step.value));
        if (!keys) throw new AgentError(`"${step.value}" is not a key or key combination`, 'invalid-argument');
        if (step.target) {
          const l = await this.locate(step.target, ctx, rt, step);
          await c.keys(keys, l.el.id);
          return this.result(l, { newScreen: true });
        }
        await c.keys(keys);
        return { surface: { driver: this.kind, rung: 'object', via: `keys ${keys.join('+')}` }, newScreen: true };
      }
      case 'hover':
      case 'focus': {
        const l = await this.locate(step.target!, ctx, rt, step);
        await c.focus(l.el.id);
        return this.result(l);
      }
      case 'capture': {
        if (!step.target || !step.captureAs) return unsupported(this, step);
        const l = await this.locate(step.target, ctx, rt, step);
        const value = (args.mode === 'value' || ['Edit', 'ComboBox', 'Document'].includes(l.el.controlType)) ? await c.getValue(l.el.id) : (l.el.name ?? (await c.getValue(l.el.id)));
        return this.result(l, { captured: { [step.captureAs]: value } });
      }
      case 'tab': {
        // "Switch to the "Save As" window" / "Close the tab" work on desktop windows.
        const op = String(args.op ?? '');
        if (op === 'switch' && (args.by === 'title' || args.by === 'name') && typeof args.value === 'string') {
          const w = await this.useWindow(v(args.value));
          return { surface: { driver: this.kind, rung: 'object', via: `window "${w.title}"` }, newScreen: true };
        }
        if (op === 'close') {
          const w = await this.currentWindow();
          await c.closeWindow(w.id);
          this.window = undefined;
          return { surface: { driver: this.kind, rung: 'object', via: `closed window "${w.title}"` } };
        }
        return unsupported(this, step);
      }
      case 'assert':
        return { surface: { driver: this.kind, rung: 'object', via: `window "${(await this.currentWindow()).title}"` } };
      default:
        return unsupported(this, step);
    }
  }

  /** Menu path: expand each item, invoke the last ("File > Save As"). */
  async menu(path: string[], ctx: StepContext, rt: InterceptorRuntime, step: Step): Promise<ActResult> {
    let last: Located | undefined;
    for (let i = 0; i < path.length; i++) {
      last = await this.locate({ description: `the "${path[i]}" menu item`, locators: [] }, ctx, rt, step);
      if (i < path.length - 1) await this.client.expand(last.el.id).catch(() => this.client.invoke(last!.el.id));
      else await this.client.invoke(last.el.id);
    }
    return { ...this.result(last!), surface: { driver: this.kind, rung: 'object', via: `menu ${path.join(' > ')}` }, newScreen: true };
  }

  async evaluate(c: Condition, env: ConditionEnv): Promise<ConditionResult | undefined> {
    if (c.type === 'titleContains') {
      const w = await this.currentWindow();
      const want = env.interpolate(c.value);
      return w.title.includes(want) ? { condition: c, passed: true, actual: w.title } : { condition: c, passed: false, message: `window title "${w.title}" does not contain "${want}"`, actual: w.title };
    }
    if (c.type === 'state' && ['enabled', 'disabled', 'checked', 'unchecked', 'visible', 'hidden'].includes(c.state)) {
      const w = await this.currentWindow();
      const { matches } = this.match(await this.elementsOf(w), c.target);
      if (matches.length !== 1) return { condition: c, passed: false, message: `${c.target.description}: ${matches.length} matches in window "${w.title}"` };
      const e = matches[0];
      const st = { enabled: e.enabled !== false, disabled: e.enabled === false, checked: e.toggle === 'on' || e.selected === true, unchecked: e.toggle === 'off' || e.selected === false, visible: e.visible !== false, hidden: e.visible === false }[c.state as 'enabled'];
      return st ? { condition: c, passed: true, actual: c.state } : { condition: c, passed: false, message: `${c.target.description} is not ${c.state}` };
    }
    return evaluateTextConditions(c, env, {
      label: this.label,
      screenText: async () => {
        const w = await this.currentWindow();
        return [w.title, ...(await this.elementsOf(w)).filter((e) => e.visible !== false).flatMap((e) => [e.name, e.value]).filter(Boolean)].join('\n');
      },
      elementText: async (t, field) => {
        const w = await this.currentWindow();
        const { matches } = this.match(await this.elementsOf(w), t);
        if (matches.length !== 1) return undefined;
        const e = matches[0];
        if (field === 'value' || ['Edit', 'ComboBox', 'Document'].includes(e.controlType)) return this.client.getValue(e.id);
        return e.name ?? e.value ?? '';
      },
    });
  }

  /** UI tree of the current window as XML (evidence and offline healing analysis). */
  async treeXml(): Promise<string> {
    const w = await this.currentWindow();
    const els = await this.elementsOf(w);
    const kids = new Map<string | undefined, AgentElement[]>();
    for (const e of els) kids.set(e.parent, [...(kids.get(e.parent) ?? []), e]);
    const ids = new Set(els.map((e) => e.id));
    const attr = (k: string, v: unknown) => (v === undefined || v === null || v === '' ? '' : ` ${k}="${String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`);
    const out: string[] = [`<?xml version="1.0" encoding="utf-8"?>`, `<Desktop agent="${this.kind}" window="${w.title.replace(/"/g, '&quot;')}">`];
    const walk = (e: AgentElement, depth: number) => {
      const tag = /^[A-Za-z][\w-]*$/.test(e.controlType) ? e.controlType : 'Element';
      const r = e.rect;
      const a = attr('Name', e.name) + attr('AutomationId', e.automationId) + attr('ClassName', e.className) + attr('FrameworkId', e.framework) + attr('LabeledBy', e.labeledBy)
        + attr('Value', e.value) + attr('Toggle', e.toggle) + attr('IsEnabled', e.enabled) + attr('IsOffscreen', e.visible === undefined ? undefined : !e.visible)
        + (r ? attr('x', r.x) + attr('y', r.y) + attr('width', r.width) + attr('height', r.height) : '');
      const children = kids.get(e.id) ?? [];
      const pad = '  '.repeat(depth);
      if (!children.length) out.push(`${pad}<${tag}${a}/>`);
      else {
        out.push(`${pad}<${tag}${a}>`);
        for (const ch of children) walk(ch, depth + 1);
        out.push(`${pad}</${tag}>`);
      }
    };
    for (const root of els.filter((e) => !e.parent || !ids.has(e.parent))) walk(root, 1);
    out.push('</Desktop>');
    return out.join('\n');
  }

  async capture(): Promise<SurfaceCapture> {
    const w = await this.currentWindow().catch(() => undefined);
    const png = await this.client.screenshot(w?.id).catch(() => undefined);
    const xml = await this.treeXml().catch(() => undefined);
    return {
      ...(png ? { image: { data: png, ext: 'png' as const } } : {}),
      ...(xml ? { snapshot: { data: xml, ext: 'xml' as const, description: 'ui tree' } } : {}),
    };
  }

  async close(): Promise<void> {
    await this.onClose?.();
  }
}
