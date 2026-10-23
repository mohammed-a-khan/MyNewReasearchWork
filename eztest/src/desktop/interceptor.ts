/**
 * The desktop and legacy step interceptor: owns the per-journey sessions of
 * every non-browser surface, runs the `desktop.* / windows.* / java.* /
 * sap.* / terminal.* / vision.*` steps, and routes the ordinary steps
 * (click, type, press, read, expect) to the active surface.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { EzTestError, NotSupportedError, type Step } from '../core/index.js';
import { TerminalSurface, type TerminalHostConfig } from '../legacy/terminal.js';
import { widgetName } from '../intent/rules-components.js';
import { setActiveSurface, type InterceptedStep, type InterceptorRuntime, type StepInterceptor } from '../runner/surface.js';
import type { StepContext } from '../runner/types.js';
import type { LegacyConfig } from './config.js';
import { PASS_THROUGH, runSurfaceStep, storeSurfaceEvidence, type ActResult, type DesktopSurface, type SurfaceKind } from './surface.js';

export interface DesktopDeps {
  /** Resolve a secret:// reference (Identity Vault registry). Plain values are returned as they are. */
  resolveSecret?: (ref: string) => Promise<string>;
  /** Register a resolved secret with the masker so it never reaches logs or evidence. */
  addSecret?: (value: string) => void;
  /** Project directory relative paths (CA files, images, apps) resolve against. */
  baseDir?: string;
}

/** Per-journey-attempt state: open surfaces and the active one. */
export interface DesktopSession {
  surfaces: Map<string, DesktopSurface>;
  active?: DesktopSurface;
  /** Owner key (the journey attempt's BrowserSession). */
  key: object;
  /** The journey's App: header app was launched. */
  launched?: boolean;
}

export type DesktopHandler = (step: Step, ctx: StepContext, rt: InterceptorRuntime, h: HandlerEnv) => Promise<InterceptedStep>;

export interface HandlerEnv {
  config: LegacyConfig;
  deps: DesktopDeps;
  session: DesktopSession;
  /** Args of the step with ${var} interpolated in string values. */
  args: Record<string, unknown>;
  secret(v: string | undefined): Promise<string | undefined>;
  path(p: string): string;
  /** Open (and activate) a surface under `key`, closing any previous one with that key. */
  open(key: string, s: DesktopSurface): void;
  activate(s: DesktopSurface | undefined): void;
  /** The active surface of a kind, or the named one; throws a clear error when none is open. */
  need<K extends SurfaceKind>(kinds: K[], what: string): DesktopSurface & { kind: K };
  close(key: string): Promise<void>;
}

const OWN_PREFIX = /^(?:desktop|windows|java|sap|terminal|vision|surface)\./;

export class DesktopInterceptor implements StepInterceptor {
  readonly name = 'desktop';
  private readonly sessions = new WeakMap<object, DesktopSession>();
  private readonly handlers = new Map<string, DesktopHandler>();

  constructor(
    readonly config: LegacyConfig,
    readonly deps: DesktopDeps = {},
  ) {
    this.register(TERMINAL_HANDLERS);
    this.register(SURFACE_HANDLERS);
  }

  register(handlers: Record<string, DesktopHandler>): void {
    for (const [k, h] of Object.entries(handlers)) this.handlers.set(k, h);
  }

  get handlerNames(): string[] {
    return [...this.handlers.keys()].sort();
  }

  /** The desktop session of a journey attempt (created on first use; closed with the attempt). */
  sessionFor(ctx: StepContext): DesktopSession {
    const key: object = ctx.session ?? ctx.context;
    let s = this.sessions.get(key);
    if (!s) {
      const created: DesktopSession = { surfaces: new Map(), key };
      s = created;
      this.sessions.set(key, s);
      ctx.session?.cleanups.push(async () => {
        setActiveSurface(key, undefined);
        for (const surf of created.surfaces.values()) await surf.close().catch(() => undefined);
        created.surfaces.clear();
        created.active = undefined;
      });
    }
    return s;
  }

  /** Run before the first step of a journey with an `App: electron ...` header: launch the app. */
  autoLaunch?: (step: Step, ctx: StepContext, rt: InterceptorRuntime, h: HandlerEnv) => Promise<InterceptedStep | undefined>;

  async execute(step: Step, ctx: StepContext, rt: InterceptorRuntime): Promise<InterceptedStep | undefined> {
    if (ctx.journey.electron && this.autoLaunch) {
      const session = this.sessionFor(ctx);
      if (!session.launched) {
        session.launched = true;
        const r = await this.autoLaunch(step, ctx, rt, this.env(step, ctx, session));
        if (r && r.status === 'failed') return r;
      }
    }
    step = this.fromComponentStep(step, ctx);
    if (step.action === 'custom' && step.handler && OWN_PREFIX.test(step.handler)) {
      const h = this.handlers.get(step.handler);
      if (!h) throw new EzTestError(`No desktop step "${step.handler}" (known: ${this.handlerNames.join(', ')})`, 'NO_HANDLER');
      const session = this.sessionFor(ctx);
      return h(step, ctx, rt, this.env(step, ctx, session));
    }
    const key: object = ctx.session ?? ctx.context;
    const active = this.sessions.get(key)?.active;
    if (!active || step.action === 'custom') return undefined;
    if (active.accepts ? !active.accepts(step) : PASS_THROUGH.has(step.action)) return undefined;
    return runSurfaceStep(active, step, ctx, rt, async () => {
      const r = await active.act(step, ctx, rt);
      if (!r) throw new NotSupportedError(`"${step.action}" steps on ${active.label}`);
      return r;
    });
  }

  /**
   * The same sentence works on web and desktop: "Expand "A > B" in the "Accounts" tree" parses as a
   * component step; while a desktop app is the active surface, it runs as the desktop tree action.
   */
  private fromComponentStep(step: Step, ctx: StepContext): Step {
    if (step.action !== 'component' || step.args?.widget !== 'tree' || !this.handlers.has('desktop.tree')) return step;
    const op = String(step.args.op ?? '');
    if (!['expand', 'collapse', 'select'].includes(op)) return step;
    const key: object = ctx.session ?? ctx.context;
    if (!this.sessions.get(key)?.active) return step;
    const tree = widgetName(step.target?.description ?? '', 'tree') ?? step.target?.description ?? '';
    const path = String(step.args.path ?? '').split(/\s*>\s*/).filter(Boolean);
    return { ...step, action: 'custom', handler: 'desktop.tree', target: undefined, args: { op, path, tree } };
  }

  private env(step: Step, ctx: StepContext, session: DesktopSession): HandlerEnv {
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(step.args ?? {})) args[k] = typeof v === 'string' ? ctx.interpolate(v) : v;
    const deps = this.deps;
    const env: HandlerEnv = {
      config: this.config, deps, session, args,
      secret: async (v) => {
        if (v === undefined) return undefined;
        const out = v.startsWith('secret://') ? await (deps.resolveSecret ?? missingResolver)(v) : v;
        if (v.startsWith('secret://')) deps.addSecret?.(out);
        return out;
      },
      path: (p) => (isAbsolute(p) ? p : resolve(deps.baseDir ?? process.cwd(), p)),
      open: (key, s) => {
        const prev = session.surfaces.get(key);
        if (prev && prev !== s) void prev.close().catch(() => undefined);
        session.surfaces.set(key, s);
        env.activate(s);
      },
      activate: (s) => {
        session.active = s;
        setActiveSurface(session.key, s);
      },
      need: (kinds, what) => {
        const a = session.active;
        if (a && (kinds as string[]).includes(a.kind)) return a as never;
        const any = [...session.surfaces.values()].find((x) => (kinds as string[]).includes(x.kind));
        if (any) return any as never;
        throw new EzTestError(`${what} needs an open ${kinds.join(' or ')} session; start one first (see docs/desktop-and-legacy.md)`, 'NO_SURFACE');
      },
      close: async (key) => {
        const s = session.surfaces.get(key);
        if (!s) return;
        session.surfaces.delete(key);
        if (session.active === s) env.activate(undefined);
        await s.close();
      },
    };
    return env;
  }
}

async function missingResolver(ref: string): Promise<string> {
  throw new EzTestError(`Cannot resolve ${ref}: no secret resolver configured (createEngine wires the Identity Vault)`, 'NO_SECRETS');
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new EzTestError(`missing ${what}`, 'MISSING_VALUE');
  return v;
};
const num = (v: unknown, what: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new EzTestError(`missing or invalid ${what}`, 'MISSING_VALUE');
  return n;
};

/** Run a handler body on a surface with the shared pipeline. */
export function onSurface(surface: DesktopSurface, step: Step, ctx: StepContext, rt: InterceptorRuntime, act: () => Promise<ActResult> | ActResult): Promise<InterceptedStep> {
  return runSurfaceStep(surface, step, ctx, rt, async () => act());
}

/** A failure before any surface exists (e.g. the connection itself failed). */
export function failedStep(message: string): InterceptedStep {
  return { status: 'failed', conditions: [], evidence: [], error: { message } };
}

// ------------------------------------------------------------------ terminal (TN3270)

function hostConfig(h: HandlerEnv, name: string, protocol?: 'tn3270' | 'tn5250'): { name: string; cfg: TerminalHostConfig } {
  const known = h.config.mainframe.hosts[name];
  if (known) {
    return {
      name,
      cfg: {
        host: known.host, ...(known.port ? { port: known.port } : {}), tls: known.tls, model: known.model, protocol: protocol ?? known.protocol,
        ...(known.wide ? { wide: true } : {}), ...(known.deviceName ? { deviceName: known.deviceName } : {}),
        ...(known.terminalType ? { terminalType: known.terminalType } : {}), timeoutMs: known.timeoutMs, settleMs: known.settleMs,
        ...(known.caFile ? { ca: readFileSync(h.path(known.caFile), 'utf8') } : {}), logon: known.logon, users: known.users,
      },
    };
  }
  // "host:port" (or a bare host) without a config entry.
  const m = /^([\w.-]+)(?::(\d+))?$/.exec(name);
  if (!m) throw new EzTestError(`Unknown host "${name}": add it under mainframe.hosts in the config, or use "host:port"`, 'UNKNOWN_HOST');
  return { name, cfg: { host: m[1], ...(m[2] ? { port: Number(m[2]) } : {}), ...(protocol ? { protocol } : {}) } };
}

const TERMINALS: SurfaceKind[] = ['tn3270', 'tn5250'];

/** Sign-on screen defaults: the IBM i sign-on display labels its fields "User" and "Password". */
function logonDefaults(s: TerminalSurface): { userField: string; passwordField: string; key: string } {
  const d = s.kind === 'tn5250' ? { userField: 'User', passwordField: 'Password', key: 'Enter' } : { userField: 'USERID', passwordField: 'PASSWORD', key: 'Enter' };
  const c = s.config.logon ?? {};
  return { userField: c.userField ?? d.userField, passwordField: c.passwordField ?? d.passwordField, key: c.key ?? d.key };
}

export const TERMINAL_HANDLERS: Record<string, DesktopHandler> = {
  'terminal.connect': async (step, ctx, rt, h) => {
    const name = str(h.args.host, 'host name');
    const protocol = h.args.protocol === 'tn5250' || h.args.protocol === 'tn3270' ? h.args.protocol : undefined;
    let surface: TerminalSurface;
    try {
      const { cfg } = hostConfig(h, name, protocol);
      surface = await TerminalSurface.connect(name, cfg);
    } catch (e) {
      return failedStep(`could not connect to ${protocol === 'tn5250' ? 'IBM i' : 'mainframe'} "${name}": ${(e as Error).message}`);
    }
    h.open(`${surface.kind}:${name}`, surface);
    return onSurface(surface, step, ctx, rt, () => ({ surface: { driver: surface.kind, rung: 'field', via: `connected to ${name}` }, newScreen: true }));
  },
  'terminal.logon': async (step, ctx, rt, h) => {
    const s = h.need(TERMINALS, 'Log on to the mainframe') as unknown as TerminalSurface;
    const who = str(h.args.user, 'user name');
    const u = s.config.users?.[who];
    if (!u) return failedStep(`${s.label} has no user "${who}" under mainframe.hosts.${s.name}.users`);
    const password = (await h.secret(u.password)) ?? '';
    const logon = logonDefaults(s);
    return onSurface(s, step, ctx, rt, async () => {
      const uf = s.client.field(logon.userField).field;
      s.client.fill(uf, u.user);
      const pf = s.client.field(logon.passwordField).field;
      s.client.fill(pf, password);
      const r = await s.press(logon.key);
      return { ...r, surface: { driver: s.kind, rung: 'field', via: `logon as ${who} (${logon.userField} / ${logon.passwordField})` } };
    });
  },
  'terminal.typeAt': async (step, ctx, rt, h) => {
    const s = h.need(TERMINALS, 'Typing at a screen position') as unknown as TerminalSurface;
    if (h.args.cursor) return onSurface(s, step, ctx, rt, () => s.typeAtCursor(String(h.args.text ?? '')));
    return onSurface(s, step, ctx, rt, () => s.typeAt(num(h.args.row, 'row'), num(h.args.col, 'column'), String(h.args.text ?? '')));
  },
  'terminal.readAt': async (step, ctx, rt, h) => {
    const s = h.need(TERMINALS, 'Reading a screen position') as unknown as TerminalSurface;
    const as = str(h.args.as, 'variable name');
    return onSurface(s, step, ctx, rt, () => {
      const row = num(h.args.row, 'row');
      const col = num(h.args.col, 'column');
      const len = h.args.length !== undefined ? num(h.args.length, 'length') : undefined;
      const value = s.readAt(row, col, len).trim();
      return { surface: { driver: s.kind, rung: 'field', via: `row ${row} column ${col}`, box: { x: col, y: row, width: len ?? value.length, height: 1 } }, captured: { [as]: value } };
    });
  },
  'terminal.expectAt': async (step, ctx, rt, h) => {
    const s = h.need(TERMINALS, 'Checking a screen position') as unknown as TerminalSurface;
    const row = num(h.args.row, 'row');
    const col = num(h.args.col, 'column');
    const want = String(h.args.value ?? '');
    const op = h.args.op === 'contains' ? 'contains' : 'equals';
    return onSurface(s, step, ctx, rt, async () => {
      const deadline = Date.now() + rt.conditionTimeoutMs;
      let got = '';
      for (;;) {
        const len = h.args.length !== undefined ? num(h.args.length, 'length') : undefined;
        got = s.readAt(row, col, len).trim();
        if (op === 'equals' ? got === want.trim() : got.includes(want)) break;
        if (Date.now() >= deadline) throw new EzTestError(`row ${row} column ${col} shows "${got}", expected ${op === 'equals' ? '' : 'it to contain '}"${want}"`, 'ASSERTION');
        await new Promise((r) => setTimeout(r, 100));
      }
      return { surface: { driver: s.kind, rung: 'field', via: `row ${row} column ${col}`, box: { x: col, y: row, width: Math.max(1, got.length), height: 1 } } };
    });
  },
  'terminal.waitText': async (step, ctx, rt, h) => {
    const s = h.need(TERMINALS, 'Waiting for screen text') as unknown as TerminalSurface;
    const text = str(h.args.text, 'text');
    const timeoutMs = h.args.timeoutMs !== undefined ? num(h.args.timeoutMs, 'timeout') : (s.config.timeoutMs ?? 15_000);
    return onSurface(s, step, ctx, rt, async () => {
      if (h.args.gone) await s.client.waitUntil(() => !s.client.text().includes(text), timeoutMs, `"${text}" to leave the screen`);
      else await s.client.waitForText(text, { timeoutMs });
      return { surface: { driver: s.kind, rung: 'field', via: `screen text "${text}"` }, newScreen: true };
    });
  },
  'terminal.disconnect': async (step, ctx, rt, h) => {
    const s = h.need(TERMINALS, 'Disconnecting') as unknown as TerminalSurface;
    const r = await onSurface(s, step, ctx, rt, () => ({ surface: { driver: s.kind, rung: 'field', via: 'disconnect' }, newScreen: true }));
    await h.close(`${s.kind}:${s.name}`);
    return r;
  },
};

// ------------------------------------------------------------------ switching surfaces

export const SURFACE_HANDLERS: Record<string, DesktopHandler> = {
  /** "Switch to the browser" / "Switch to mainframe "cics"" / "Switch to the desktop app". */
  'surface.use': async (_step, _ctx, _rt, h) => {
    const to = str(h.args.to, 'surface').toLowerCase();
    if (to === 'browser' || to === 'web') {
      h.activate(undefined);
      return { status: 'passed', conditions: [], evidence: [] };
    }
    const name = typeof h.args.name === 'string' ? h.args.name : undefined;
    const kinds: Record<string, SurfaceKind[]> = { mainframe: TERMINALS, terminal: TERMINALS, 'ibm i': ['tn5250'], as400: ['tn5250'], windows: ['windows'], desktop: ['windows', 'java'], java: ['java'], sap: ['sap'], screen: ['vision'], citrix: ['vision'] };
    const want = kinds[to];
    if (!want) return failedStep(`cannot switch to "${to}" (browser, mainframe, desktop, windows, java, sap, screen)`);
    const match = [...h.session.surfaces.entries()].find(([k, s]) => want.includes(s.kind) && (!name || k.endsWith(`:${name}`)));
    if (!match) return failedStep(`no open ${to} session${name ? ` "${name}"` : ''} to switch to`);
    h.activate(match[1]);
    return { status: 'passed', conditions: [], evidence: [], surface: { driver: match[1].kind, rung: 'object', via: `switched to ${match[1].label}` } };
  },
  /** "Take a screenshot of the screen" for the active surface. */
  'surface.snapshot': async (step, ctx, _rt, h) => {
    const s = h.session.active;
    if (!s) return failedStep('no desktop, terminal, SAP or screen session is active');
    const ids = await storeSurfaceEvidence(s, step, ctx, 'on request');
    return { status: 'passed', conditions: [], evidence: ids, surface: { driver: s.kind, rung: 'object', via: 'snapshot' } };
  },
};
