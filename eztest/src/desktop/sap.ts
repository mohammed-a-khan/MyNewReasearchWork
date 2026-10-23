/**
 * SAP GUI for Windows through SAP GUI Scripting (SAP's own scripting API),
 * reached via EZTest's own Windows-side bridge: agents/sap/ez-sap-bridge.ps1,
 * a PowerShell/COM shim the user runs next to SAP GUI. It speaks the same
 * envelope as the desktop agents (POST /v1/rpc, X-EZ-Agent-Token).
 *
 * Fields are found by technical id ("wnd[0]/usr/ctxtVBAK-AUART"), technical
 * name ("VBAK-AUART"), their label on screen ("Order Type") or tooltip; the
 * status bar is a first-class post-condition.
 */
import type { Condition, ConditionResult, ElementFingerprint, LocatorCandidate, Step, Target } from '../core/index.js';
import { pickBest, scoreFingerprint } from '../heal/score.js';
import { analyzeDescription } from '../intent/target.js';
import type { ConditionEnv } from '../runner/conditions.js';
import type { InterceptorRuntime } from '../runner/surface.js';
import type { StepContext } from '../runner/types.js';
import { AgentClient, AgentError } from './agent.js';
import { evaluateTextConditions, unsupported, type ActResult, type DesktopSurface, type SurfaceCapture } from './surface.js';

export interface SapElement {
  /** Scripting id, e.g. wnd[0]/usr/ctxtVBAK-AUART */
  id: string;
  /** GuiTextField, GuiCTextField, GuiButton, GuiComboBox, GuiCheckBox, GuiRadioButton, GuiTab, GuiLabel, GuiTableControl, GuiGridView, GuiStatusbar ... */
  type: string;
  /** Technical name, e.g. VBAK-AUART or btn[11]. */
  name?: string;
  text?: string;
  tooltip?: string;
  /** Text of the label left of a field (GuiVComponent.LeftLabel). */
  leftLabel?: string;
  changeable?: boolean;
  selected?: boolean;
  /** Column titles of a table control / grid. */
  columns?: string[];
  rect?: { x: number; y: number; width: number; height: number };
}

export interface SapScreen {
  window: { id: string; title: string; transaction?: string; program?: string; screen?: number };
  elements: SapElement[];
}

export interface SapStatus {
  /** S success, E error, W warning, I information, A abort, '' none. */
  type: string;
  text: string;
  id?: string;
  number?: string;
}

/** VKey numbers of SAP GUI (sendVKey). */
export function sapVKey(combo: string): number | undefined {
  const k = combo.replace(/\s+/g, '').toUpperCase();
  const f = /^(SHIFT\+|CTRL\+|CTRL\+SHIFT\+)?F(\d{1,2})$/.exec(k);
  if (f) {
    const n = Number(f[2]);
    if (n < 1 || n > 12) return undefined;
    return n + ({ 'SHIFT+': 12, 'CTRL+': 24, 'CTRL+SHIFT+': 36 }[f[1] ?? ''] ?? 0);
  }
  return ({ ENTER: 0, RETURN: 0, 'CTRL+S': 11, ESCAPE: 12, ESC: 12, PAGEUP: 80, PAGEDOWN: 81, 'CTRL+PAGEUP': 82, 'CTRL+PAGEDOWN': 83 } as Record<string, number>)[k];
}

const FIELD_TYPES = ['GuiTextField', 'GuiCTextField', 'GuiPasswordField', 'GuiComboBox', 'GuiOkCodeField'];
const KIND_TYPES: Record<string, string[]> = {
  textbox: FIELD_TYPES, combobox: ['GuiComboBox'], button: ['GuiButton'], checkbox: ['GuiCheckBox'], radio: ['GuiRadioButton'],
  tab: ['GuiTab'], table: ['GuiTableControl', 'GuiGridView', 'GuiShell'], text: ['GuiLabel', 'GuiTextField'], message: ['GuiStatusbar', 'GuiLabel'],
};
const clean = (s: string | undefined) => (s ?? '').replace(/[\s:]+$/, '').replace(/\s+/g, ' ').trim().toLowerCase();

export class SapSurface implements DesktopSurface {
  readonly kind = 'sap' as const;
  private screenCache?: SapScreen;

  constructor(
    readonly system: string,
    readonly client: AgentClient,
  ) {}

  get label(): string {
    return `SAP "${this.system}"${this.screenCache ? ` (${this.screenCache.window.title})` : ''}`;
  }

  async screen(): Promise<SapScreen> {
    this.screenCache = await this.client.call<SapScreen>('dump');
    return this.screenCache;
  }

  async status(): Promise<SapStatus> {
    return this.client.call<SapStatus>('status');
  }

  accepts(step: Step): boolean {
    return !['api', 'db', 'set', 'wait', 'useData', 'compareDocument', 'email', 'sms', 'ws', 'compareData', 'login', 'navigate', 'tab', 'runJourney'].includes(step.action);
  }

  /** Candidates for a description: scripting id, technical name, label, text or tooltip. */
  match(elements: SapElement[], target: Target): { hits: SapElement[]; used: LocatorCandidate } {
    const d = target.description.trim();
    const raw = /^(?:the\s+)?"?(wnd\[\d+\]\/[^"\s]+)"?$/.exec(d);
    if (raw) return { hits: elements.filter((e) => e.id === raw[1]), used: { strategy: 'css', value: raw[1] } };
    const { kind, name } = analyzeDescription(d);
    const types = KIND_TYPES[kind];
    const pool = types ? elements.filter((e) => types.includes(e.type)) : elements;
    if (!name) return { hits: [], used: { strategy: 'role', value: kind } };
    const n = clean(name);
    const tech = pool.filter((e) => e.name === name || e.id.endsWith(`/${name}`) || e.id.replace(/^.*\/[a-z]+/, '') === name);
    if (tech.length) return { hits: tech, used: { strategy: 'testId', value: tech.length === 1 ? (tech[0].name ?? tech[0].id) : name } };
    const byLabel = pool.filter((e) => clean(e.leftLabel) === n || (!FIELD_TYPES.includes(e.type) || !e.changeable ? clean(e.text) === n : false) || clean(e.tooltip?.replace(/\s*\([^)]*\)\s*$/, '')) === n);
    return { hits: byLabel, used: { strategy: 'label', value: name } };
  }

  fingerprint(e: SapElement): ElementFingerprint {
    return {
      tag: e.type, ...(e.name ? { id: e.name } : {}), ...(e.leftLabel ? { label: e.leftLabel } : {}), ...(e.text && !FIELD_TYPES.includes(e.type) ? { name: e.text } : {}),
      ...(e.tooltip ? { attributes: { tooltip: e.tooltip } } : {}), path: e.id.replace(/\[\d+\]/g, '').split('/').slice(0, -1).join(' > '), ...(e.rect ? { box: e.rect } : {}),
    };
  }

  async locate(target: Target, ctx: StepContext, rt: InterceptorRuntime, step: Step): Promise<{ el: SapElement; used: LocatorCandidate; heal?: ActResult['heal'] }> {
    const scr = await this.screen();
    const { hits, used } = this.match(scr.elements, target);
    if (hits.length === 1) return { el: hits[0], used };
    if (hits.length > 1) throw new AgentError(`${target.description} matches ${hits.length} SAP elements (${hits.slice(0, 4).map((e) => e.id).join(', ')}); use the technical name or id`, 'ambiguous');
    const why = `${target.description} is not on SAP screen "${scr.window.title}"`;
    const mem = rt.store.get(ctx.journey.id, step.id);
    if (mem?.fingerprint) {
      const pick = pickBest(scr.elements.map((e) => ({ item: e, score: scoreFingerprint(mem.fingerprint!, this.fingerprint(e)).score })), 0.7, 0.1);
      if (pick.ok) {
        const e = pick.best.item;
        const healed: LocatorCandidate = { strategy: 'css', value: e.id };
        return { el: e, used: healed, heal: { tier: 'T1-fingerprint', confidence: Math.round(pick.best.score * 100) / 100, reason: `${why}; ${e.type} ${e.id}${e.leftLabel ? ` (labelled "${e.leftLabel}")` : ''} matches the recorded fingerprint`, original: [used], healed } };
      }
    }
    throw new AgentError(why, 'no-element');
  }

  private result(l: { el: SapElement; used: LocatorCandidate; heal?: ActResult['heal'] }, extra: Partial<ActResult> = {}): ActResult {
    return {
      surface: { driver: 'sap', rung: 'object', via: `${l.el.type} ${l.el.id}${l.el.leftLabel ? ` (label "${l.el.leftLabel}")` : ''}`, ...(l.el.rect ? { box: l.el.rect } : {}) },
      usedLocator: l.used, fingerprint: this.fingerprint(l.el), ...(l.heal ? { heal: l.heal } : {}), ...extra,
    };
  }

  /** Set a field (text, combo key/text, check box). */
  async set(l: { el: SapElement }, value: string): Promise<string> {
    await this.client.call('set', { id: l.el.id, value });
    return String((await this.client.call<{ value?: string }>('get', { id: l.el.id })).value ?? '');
  }

  async act(step: Step, ctx: StepContext, rt: InterceptorRuntime): Promise<ActResult | undefined> {
    const v = (s: string | undefined) => ctx.interpolate(s ?? '');
    switch (step.action) {
      case 'fill':
      case 'clear':
      case 'select': {
        const l = await this.locate(step.target!, ctx, rt, step);
        const want = step.action === 'clear' ? '' : v(step.value);
        const now = await this.set(l, want);
        return this.result(l, { implied: { ok: now === want || clean(now) === clean(want), message: `the field holds "${now}"` } });
      }
      case 'check':
      case 'uncheck': {
        const l = await this.locate(step.target!, ctx, rt, step);
        await this.client.call('select', { id: l.el.id, selected: step.action === 'check' });
        return this.result(l);
      }
      case 'click':
      case 'dblclick': {
        const l = await this.locate(step.target!, ctx, rt, step);
        await this.client.call(['GuiTab', 'GuiRadioButton', 'GuiCheckBox'].includes(l.el.type) ? 'select' : 'press', { id: l.el.id });
        return this.result(l, { newScreen: true });
      }
      case 'press': {
        const key = sapVKey(v(step.value));
        if (key === undefined) throw new AgentError(`"${step.value}" is not an SAP GUI key (Enter, F1-F12, Shift/Ctrl+F1-F12, Ctrl+S, Escape, PageUp/PageDown)`, 'invalid-argument');
        await this.client.call('vkey', { key });
        return { surface: { driver: 'sap', rung: 'object', via: `vkey ${key} (${step.value})` }, newScreen: true };
      }
      case 'capture': {
        if (!step.target || !step.captureAs) return unsupported(this, step);
        const l = await this.locate(step.target, ctx, rt, step);
        const value = String((await this.client.call<{ value?: string }>('get', { id: l.el.id })).value ?? '');
        return this.result(l, { captured: { [step.captureAs]: value } });
      }
      case 'assert':
        return { surface: { driver: 'sap', rung: 'object', via: 'screen' } };
      default:
        return unsupported(this, step);
    }
  }

  async evaluate(c: Condition, env: ConditionEnv): Promise<ConditionResult | undefined> {
    if (c.type === 'titleContains') {
      const t = (await this.screen()).window.title;
      const want = env.interpolate(c.value);
      return t.includes(want) ? { condition: c, passed: true, actual: t } : { condition: c, passed: false, message: `SAP window title "${t}" does not contain "${want}"`, actual: t };
    }
    return evaluateTextConditions(c, env, {
      label: this.label,
      screenText: async () => {
        const s = await this.screen();
        const st = await this.status().catch(() => ({ text: '' }) as SapStatus);
        return [s.window.title, ...s.elements.flatMap((e) => [e.leftLabel, e.text]).filter(Boolean), st.text].join('\n');
      },
      elementText: async (t) => {
        const s = await this.screen();
        const { hits } = this.match(s.elements, t);
        if (hits.length !== 1) return undefined;
        return String((await this.client.call<{ value?: string }>('get', { id: hits[0].id })).value ?? '');
      },
    });
  }

  async capture(): Promise<SurfaceCapture> {
    const png = await this.client.call<{ png?: string }>('screenshot').then((r) => (r.png ? Buffer.from(r.png, 'base64') : undefined)).catch(() => undefined);
    const scr = await this.screen().catch(() => undefined);
    const st = await this.status().catch(() => undefined);
    return {
      ...(png ? { image: { data: png, ext: 'png' as const } } : {}),
      ...(scr ? { snapshot: { data: JSON.stringify({ system: this.system, ...scr, statusBar: st }, null, 2), ext: 'json' as const, description: 'sap screen' } } : {}),
    };
  }

  async close(): Promise<void> {
    await this.client.call('close').catch(() => undefined);
  }
}
