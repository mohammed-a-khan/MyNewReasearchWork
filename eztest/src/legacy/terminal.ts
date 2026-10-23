/**
 * The green-screen terminal rung of the driver ladder: a TN3270 (IBM Z) or
 * TN5250 (IBM i) session behind
 * the normal plain-English steps. While it is the journey's active surface,
 * `Type "X" into the "USERID" field`, `Press Enter` / `Press PF3`, `Read the
 * "BALANCE" field as balance` and `Expect the screen to contain "..."` act on
 * the 3270 or 5250 screen. Fields are found by their label on screen, by row and
 * column, or (healing) by the fingerprint recorded when the step last passed.
 */
import type { Condition, ConditionResult, ElementFingerprint, LocatorCandidate, Step, Target } from '../core/index.js';
import type { ActResult, DesktopSurface, SurfaceCapture } from '../desktop/surface.js';
import { unsupported, evaluateTextConditions } from '../desktop/surface.js';
import { analyzeDescription } from '../intent/target.js';
import type { ConditionEnv } from '../runner/conditions.js';
import type { InterceptorRuntime } from '../runner/surface.js';
import type { StepContext } from '../runner/types.js';
import { renderScreenSvg } from './render.js';
import { Tn3270Client, type Tn3270Options } from './tn3270/client.js';
import { Tn5250Client } from './tn5250/client.js';
import type { TerminalClient } from './types.js';
import { fieldAtRowCol, fieldByFingerprint, fieldByLabel, fingerprintField, labelLeftOf, type FieldMatch, type TerminalFieldFingerprint } from './tn3270/fields.js';
import { TerminalError, type ScreenField } from './tn3270/screen.js';

export interface TerminalHostConfig extends Omit<Tn3270Options, 'tls'> {
  /** tn3270 (IBM Z, default) or tn5250 (IBM i). */
  protocol?: 'tn3270' | 'tn5250';
  /** TN5250: 27x132 display (IBM-3477-FC) instead of 24x80 (IBM-3179-2). */
  wide?: boolean;
  /** TN5250: virtual device name requested from the host (NEW-ENVIRON DEVNAME). */
  deviceName?: string;
  tls?: boolean;
  /** PEM file contents of extra trusted CAs for TLS. */
  ca?: string;
  /** How long to wait for the host after an AID key. Default 15000. */
  timeoutMs?: number;
  /** Quiet time after the keyboard unlocks before a screen is complete. Default 150. */
  settleMs?: number;
  /** Sign-on screen layout for "Log on to the mainframe as <user>". */
  logon?: { userField?: string; passwordField?: string; key?: string };
  /** Users for "Log on ... as <name>": password values are secret:// references (resolved by the engine). */
  users?: Record<string, { user: string; password: string }>;
}

const POS = /^(?:the\s+)?(?:input\s+)?field\s+at\s+row\s+(\d+)\s*(?:,\s*|\s+)col(?:umn)?\s+(\d+)$/i;
const AT_POS = /^(?:the\s+)?(?:text\s+)?at\s+row\s+(\d+)\s*(?:,\s*|\s+)col(?:umn)?\s+(\d+)$/i;

function fpToTerminal(fp: ElementFingerprint | undefined): TerminalFieldFingerprint | undefined {
  if (!fp?.box || fp.tag !== 'terminal-field') return undefined;
  return { ...(fp.label ? { label: fp.label } : {}), row: fp.box.y, col: fp.box.x, length: fp.box.width, numeric: fp.attributes?.numeric === 'true', hidden: fp.attributes?.hidden === 'true' };
}

function terminalFp(t: TerminalFieldFingerprint): ElementFingerprint {
  return {
    tag: 'terminal-field', ...(t.label ? { label: t.label } : {}), box: { x: t.col, y: t.row, width: t.length, height: 1 },
    attributes: { ...(t.numeric ? { numeric: 'true' } : {}), ...(t.hidden ? { hidden: 'true' } : {}) },
  };
}

const posLocator = (f: ScreenField): LocatorCandidate => ({ strategy: 'text', value: `field at row ${f.row} column ${f.col}` });

export class TerminalSurface implements DesktopSurface {
  readonly kind: 'tn3270' | 'tn5250';
  private lastHighlight?: { row: number; col: number; length: number; label?: string };

  constructor(
    readonly name: string,
    readonly client: TerminalClient,
    readonly config: TerminalHostConfig,
  ) {
    this.kind = client.protocol;
  }

  get label(): string {
    return this.kind === 'tn5250' ? `IBM i "${this.name}"` : `mainframe "${this.name}"`;
  }

  static async connect(name: string, config: TerminalHostConfig): Promise<TerminalSurface> {
    const tls = config.tls ? { tls: config.ca ? { ca: config.ca } : true } : {};
    const client: TerminalClient = config.protocol === 'tn5250'
      ? await Tn5250Client.connect({
        host: config.host, ...(config.port ? { port: config.port } : {}), ...tls, ...(config.wide ? { wide: true } : {}),
        ...(config.terminalType ? { terminalType: config.terminalType } : {}), ...(config.deviceName ? { deviceName: config.deviceName } : {}),
        ...(config.connectTimeoutMs ? { connectTimeoutMs: config.connectTimeoutMs } : {}),
      })
      : await Tn3270Client.connect({ ...config, ...tls });
    const s = new TerminalSurface(name, client, config);
    await client.waitForScreen({ timeoutMs: config.timeoutMs ?? 15_000, settleMs: config.settleMs ?? 150 });
    return s;
  }

  private wait() {
    return { timeoutMs: this.config.timeoutMs ?? 15_000, settleMs: this.config.settleMs ?? 150 };
  }

  // ---------------------------------------------------------------- locating fields

  /** Resolve a target to a field: position, label, then the healing ladder (T0 cached heal, T1 fingerprint). */
  resolve(target: Target, ctx: StepContext, rt: InterceptorRuntime, step: Step): { match: FieldMatch; used: LocatorCandidate; heal?: ActResult['heal'] } {
    const screen = this.client.screen;
    const d = target.description.trim();
    const pos = POS.exec(d) ?? AT_POS.exec(d);
    if (pos) {
      const f = fieldAtRowCol(screen, Number(pos[1]), Number(pos[2]));
      return { match: { field: f, via: 'position' }, used: posLocator(f) };
    }
    const label = analyzeDescription(d).name ?? d.replace(/^the\s+/i, '');
    try {
      const m = fieldByLabel(screen, label);
      return { match: m, used: { strategy: 'label', value: label } };
    } catch (e) {
      const why = (e as Error).message;
      if (/more than one/.test(why)) throw e; // ambiguity is never healed
      const mem = rt.store.get(ctx.journey.id, step.id);
      const original: LocatorCandidate[] = [{ strategy: 'label', value: label }];
      if (mem?.healed?.locator.strategy === 'label') {
        try {
          const m = fieldByLabel(screen, mem.healed.locator.value);
          return { match: m, used: mem.healed.locator, heal: { tier: 'T0-cache', confidence: mem.healed.confidence, reason: `cached verified heal: ${why}`, original, healed: mem.healed.locator } };
        } catch {
          /* fall through to the fingerprint */
        }
      }
      const cached = mem?.healed?.locator.value.match(/^field at row (\d+) column (\d+)$/);
      if (cached) {
        try {
          const f = fieldAtRowCol(screen, Number(cached[1]), Number(cached[2]));
          if (!f.protected) return { match: { field: f, via: 'fingerprint' }, used: posLocator(f), heal: { tier: 'T0-cache', confidence: mem!.healed!.confidence, reason: `cached verified heal: ${why}`, original, healed: posLocator(f) } };
        } catch {
          /* fall through to the fingerprint */
        }
      }
      const fp = fpToTerminal(mem?.fingerprint);
      const h = fp ? fieldByFingerprint(screen, fp) : undefined;
      if (h) {
        const f = h.match.field;
        const now = labelLeftOf(screen, f);
        // Prefer the field's new label as the healed locator: the heal proposal then reads `into the "USER ID" field`.
        let healed = posLocator(f);
        if (now) {
          try {
            if (fieldByLabel(screen, now).field.attrAddress === f.attrAddress) healed = { strategy: 'label', value: now };
          } catch {
            /* the label is not unique: keep the position */
          }
        }
        return {
          match: h.match, used: healed,
          heal: { tier: 'T1-fingerprint', confidence: h.confidence, reason: `${why}; field with the recorded length/position found at row ${f.row} column ${f.col}${now ? ` (now labelled "${now}")` : ''}`, original, healed },
        };
      }
      throw e;
    }
  }

  private fieldResult(m: FieldMatch, used: LocatorCandidate, extra: Partial<ActResult> = {}): ActResult {
    const f = m.field;
    this.lastHighlight = { row: f.row, col: f.col, length: Math.min(f.length, this.client.screen.cols - f.col + 1), label: used.value };
    const via = m.via === 'label' && m.label ? `label "${m.label.text}" at row ${m.label.row} column ${m.label.col}` : `row ${f.row} column ${f.col}`;
    return {
      surface: { driver: this.kind, rung: 'field', via, box: { x: f.col, y: f.row, width: f.length, height: 1 } },
      usedLocator: used,
      fingerprint: terminalFp(fingerprintField(this.client.screen, f, m.label?.text)),
      ...extra,
    };
  }

  // ---------------------------------------------------------------- actions

  /** Type at 1-based row/column (the field's content from there is replaced). */
  typeAt(row: number, col: number, text: string): ActResult {
    const f = this.client.typeAt(row, col, text);
    return this.fieldResult({ field: f, via: 'position' }, posLocator(f));
  }

  /** Type at the cursor (TSO line mode, command lines), keeping what is already in the field. */
  typeAtCursor(text: string): ActResult {
    const { row, col } = this.client.screen.rowCol(this.client.screen.cursor);
    const f = this.client.typeAt(row, col, text, { replace: false });
    return this.fieldResult({ field: f, via: 'position' }, { strategy: 'text', value: `cursor at row ${row} column ${col}` });
  }

  async press(key: string): Promise<ActResult> {
    const k = key.trim();
    const aid = this.client.keyName(k);
    const screen = this.client.screen;
    if (aid) {
      await this.client.pressAndWait(aid, this.wait());
      this.lastHighlight = undefined;
      return { surface: { driver: this.kind, rung: 'field', via: `AID ${aid}` }, newScreen: true };
    }
    const u = k.toUpperCase().replace(/[\s_-]+/g, '');
    if (u === 'TAB' || u === 'BACKTAB' || u === 'SHIFT+TAB' || u === 'HOME') {
      const inputs = screen.fields().filter((f) => !f.protected && f.length > 0);
      if (!inputs.length) throw new TerminalError('the screen has no input fields to tab to');
      let f: ScreenField;
      if (u === 'HOME') f = inputs[0];
      else if (u === 'TAB') f = inputs.find((x) => x.address > screen.cursor) ?? inputs[0];
      else f = [...inputs].reverse().find((x) => x.address < screen.cursor && !(screen.cursor >= x.address && screen.cursor < x.address + x.length)) ?? inputs[inputs.length - 1];
      screen.cursor = f.address;
      return { surface: { driver: this.kind, rung: 'field', via: `${k} to row ${f.row} column ${f.col}` } };
    }
    if (u === 'ERASEEOF' || u === 'ERASEEOFIELD') {
      screen.eraseToEndOfField(screen.cursor);
      return { surface: { driver: this.kind, rung: 'field', via: 'Erase EOF' } };
    }
    const local = this.client.localKey?.(k);
    if (local) {
      this.lastHighlight = undefined;
      return { surface: { driver: this.kind, rung: 'field', via: local } };
    }
    throw new TerminalError(`"${key}" is not a terminal key (${this.client.keyHelp}, Tab, Backtab, Home, Erase EOF)`);
  }

  /** The text at 1-based row/column (`length` characters, default to the end of the field or row). */
  readAt(row: number, col: number, length?: number): string {
    const screen = this.client.screen;
    const addr = screen.addressOf(row, col);
    if (length === undefined) {
      const f = screen.fieldAt(addr);
      length = f ? f.address + f.length - addr : screen.cols - col + 1;
    }
    return screen.readRange(addr, length).replace(/\s+$/, '');
  }

  async act(step: Step, ctx: StepContext, rt: InterceptorRuntime): Promise<ActResult | undefined> {
    const v = (s: string | undefined) => ctx.interpolate(s ?? '');
    switch (step.action) {
      case 'fill':
      case 'clear': {
        const r = this.resolve(step.target!, ctx, rt, step);
        const text = step.action === 'clear' ? '' : v(step.value);
        this.client.fill(r.match.field, text);
        const now = this.client.screen.fieldAt(r.match.field.address)?.value.replace(/\s+$/, '') ?? '';
        const implied = { ok: now === text.replace(/\s+$/, ''), message: now === text.replace(/\s+$/, '') ? 'the field holds the typed value' : 'the field does not hold the typed value' };
        return this.fieldResult(r.match, r.used, { implied, ...(r.heal ? { heal: r.heal } : {}) });
      }
      case 'press':
        return this.press(v(step.value));
      case 'click':
      case 'dblclick': {
        // Put the cursor on the field or text (selection lists act on the cursor position with Enter).
        const d = step.target!.description;
        try {
          const r = this.resolve(step.target!, ctx, rt, step);
          this.client.screen.cursor = r.match.field.address;
          return this.fieldResult(r.match, r.used, r.heal ? { heal: r.heal } : {});
        } catch {
          const name = analyzeDescription(d).name ?? d;
          const at = this.findText(name);
          if (!at) throw new TerminalError(`"${name}" is not on the screen`);
          this.client.moveCursor(at.row, at.col);
          this.lastHighlight = { row: at.row, col: at.col, length: name.length };
          return { surface: { driver: this.kind, rung: 'coordinates', via: `text "${name}" at row ${at.row} column ${at.col}`, box: { x: at.col, y: at.row, width: name.length, height: 1 } }, usedLocator: { strategy: 'text', value: name } };
        }
      }
      case 'capture': {
        if (!step.target || !step.captureAs) return undefined;
        const r = this.resolveAny(step.target, ctx, rt, step);
        return { ...r.result, captured: { [step.captureAs]: r.value } };
      }
      case 'assert':
        return { surface: { driver: this.kind, rung: 'field', via: 'screen' } };
      case 'hover':
      case 'select':
      case 'check':
      case 'uncheck':
      case 'upload':
      case 'download':
      case 'drag':
      case 'scroll':
      case 'keyboard':
      case 'mouse':
      case 'touch':
      case 'dispatch':
      case 'focus':
      case 'query':
      case 'script':
      case 'network':
      case 'browser':
      case 'dialog':
      case 'frame':
        return unsupported(this, step);
      default:
        return undefined;
    }
  }

  /** A field (input or protected output) for reading: input by label, else the text right of a label. */
  private resolveAny(target: Target, ctx: StepContext, rt: InterceptorRuntime, step: Step): { value: string; result: ActResult } {
    try {
      const r = this.resolve(target, ctx, rt, step);
      return { value: r.match.field.value.replace(/\s+$/, '').replace(/^\s+/, ''), result: this.fieldResult(r.match, r.used, r.heal ? { heal: r.heal } : {}) };
    } catch (e) {
      const label = analyzeDescription(target.description).name ?? target.description;
      const out = this.outputRightOf(label);
      if (out === undefined) throw e;
      return { value: out.value, result: { surface: { driver: this.kind, rung: 'field', via: `output right of label "${label}" at row ${out.row}`, box: { x: out.col, y: out.row, width: out.value.length, height: 1 } }, usedLocator: { strategy: 'label', value: label } } };
    }
  }

  /** The first text after a label on the same row (protected output such as "BALANCE   1,250.00"). */
  outputRightOf(label: string): { value: string; row: number; col: number } | undefined {
    const rows = this.client.screen.textRows();
    const want = label.trim().toUpperCase();
    const hits: Array<{ value: string; row: number; col: number }> = [];
    rows.forEach((text, i) => {
      const up = text.toUpperCase();
      const at = up.indexOf(want);
      if (at < 0) return;
      if (/[A-Z0-9]/.test(up[at - 1] ?? '') || /[A-Z0-9]/.test(up[at + want.length] ?? '')) return;
      const rest = text.slice(at + want.length);
      const m = /^[\s.:=>_-]*(\S(?:.*?\S)?)(?:\s{2,}|$)/.exec(rest);
      if (m) hits.push({ value: m[1], row: i + 1, col: at + want.length + rest.indexOf(m[1]) + 1 });
    });
    return hits.length === 1 ? hits[0] : undefined;
  }

  findText(text: string): { row: number; col: number } | undefined {
    const rows = this.client.screen.textRows();
    for (let r = 0; r < rows.length; r++) {
      const c = rows[r].indexOf(text);
      if (c >= 0) return { row: r + 1, col: c + 1 };
    }
    const up = text.toUpperCase();
    for (let r = 0; r < rows.length; r++) {
      const c = rows[r].toUpperCase().indexOf(up);
      if (c >= 0) return { row: r + 1, col: c + 1 };
    }
    return undefined;
  }

  async evaluate(c: Condition, env: ConditionEnv): Promise<ConditionResult | undefined> {
    return evaluateTextConditions(c, env, {
      label: `the ${this.label} screen`,
      screenText: async () => this.client.screen.textRows().join('\n'),
      elementText: async (t) => {
        const d = t.description.trim();
        const pos = POS.exec(d) ?? AT_POS.exec(d);
        if (pos) return this.readAt(Number(pos[1]), Number(pos[2]));
        const label = analyzeDescription(d).name ?? d;
        try {
          return fieldByLabel(this.client.screen, label).field.value.trim();
        } catch {
          const out = this.outputRightOf(label);
          if (out) return out.value;
          return this.findText(label) ? label : undefined;
        }
      },
    });
  }

  async capture(): Promise<SurfaceCapture> {
    const snap = this.client.snapshot();
    return {
      image: { data: renderScreenSvg(snap, this.lastHighlight), ext: 'svg' },
      snapshot: { data: JSON.stringify({ host: this.name, ...snap }, null, 2), ext: 'json', description: 'terminal screen' },
    };
  }

  async close(): Promise<void> {
    this.client.close();
  }
}
