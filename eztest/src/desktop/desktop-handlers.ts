/**
 * Steps for Windows and Java desktop apps (EZTest's own agents): launch or
 * attach, menus, windows, grids, trees and file dialogs. Ordinary steps
 * (Click, Type, Select, Check, Press, Read, Expect) reach the app through the
 * active AgentSurface.
 */
import { join } from 'node:path';
import { EzTestError } from '../core/index.js';
import { AgentClient, AgentError } from './agent.js';
import { AgentSurface } from './agent-surface.js';
import { failedStep, onSurface, type DesktopHandler, type HandlerEnv } from './interceptor.js';
import { ElectronSurface } from './electron.js';
import { ensureJavaAgentJar, launchJavaApp } from './java.js';

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new EzTestError(`missing ${what}`, 'MISSING_VALUE');
  return v;
};

function agentSurface(h: HandlerEnv): AgentSurface {
  return h.need(['windows', 'java'], 'This desktop step') as unknown as AgentSurface;
}

async function openWindows(h: HandlerEnv, appName: string): Promise<AgentSurface> {
  const cfg = h.config.desktop.windows;
  if (!cfg) throw new EzTestError('Windows apps need a desktop.windows block (the URL of the EZTest Windows agent); see docs/desktop-and-legacy.md', 'NO_CONFIG');
  const client = new AgentClient({ url: cfg.url, ...(cfg.token ? { token: await h.secret(cfg.token) } : {}), timeoutMs: cfg.timeoutMs });
  const hello = await client.hello();
  if (hello.agent !== 'windows') throw new AgentError(`${cfg.url} is the ${hello.agent} agent, not the Windows agent`, 'protocol');
  const app = cfg.apps[appName] ?? { app: appName };
  const s = new AgentSurface('windows', appName, client);
  if (app.window) await s.useWindow(app.window);
  else {
    const r = await client.launch({ app: str(app.app, `desktop.windows.apps.${appName}.app`), ...(app.args ? { args: app.args } : {}), ...(app.workingDir ? { workingDir: app.workingDir } : {}), timeoutMs: cfg.timeoutMs });
    await s.useWindow(r.window);
  }
  return s;
}

async function openJava(h: HandlerEnv, appName: string): Promise<AgentSurface> {
  const cfg = h.config.desktop.java;
  const app = cfg?.apps[appName];
  if (!cfg || !app) throw new EzTestError(`Java app "${appName}" is not configured under desktop.java.apps (command to start it, or the URL of a JVM started with the agent)`, 'NO_CONFIG');
  if (app.url) {
    const client = new AgentClient({ url: app.url, ...(cfg.token ? { token: await h.secret(cfg.token) } : {}), timeoutMs: cfg.timeoutMs });
    await client.hello();
    const s = new AgentSurface('java', appName, client);
    return s;
  }
  const agentJar = await ensureJavaAgentJar({ ...(cfg.agentJar ? { configured: h.path(cfg.agentJar) } : {}), cacheDir: join(h.deps.baseDir ?? process.cwd(), '.eztest', 'agents') });
  const handle = await launchJavaApp(app.command ?? [], {
    agentJar, ...(app.cwd ? { cwd: h.path(app.cwd) } : {}), env: app.env, timeoutMs: cfg.startTimeoutMs,
    ...(cfg.token ? { token: await h.secret(cfg.token) } : {}),
  });
  return new AgentSurface('java', appName, handle.client, handle.stop);
}

/** Launch an Electron app (step or the journey's App: electron header) and make it the active surface. */
export async function launchElectron(step: Parameters<DesktopHandler>[0], ctx: Parameters<DesktopHandler>[1], rt: Parameters<DesktopHandler>[2], h: HandlerEnv, app: string, args: string[], executable?: string): Promise<Awaited<ReturnType<DesktopHandler>>> {
  const cfg = h.config.desktop.electron;
  let s: ElectronSurface;
  try {
    s = await ElectronSurface.launch(app, {
      app: /^[a-z][a-z0-9+.-]*:\/\//i.test(app) ? app : h.path(app), args: [...cfg.args, ...args], baseDir: h.deps.baseDir ?? process.cwd(), env: cfg.env, timeoutMs: cfg.timeoutMs,
      ...(executable ?? cfg.executablePath ? { executable: h.path((executable ?? cfg.executablePath)!) } : {}),
    });
  } catch (e) {
    return failedStep(`could not launch Electron app "${app}": ${(e as Error).message}`);
  }
  h.open(`electron:${app}`, s);
  return onSurface(s, step, ctx, rt, () => ({ surface: { driver: 'electron', rung: 'object', via: `launched ${app}` }, newScreen: true }));
}

export const DESKTOP_HANDLERS: Record<string, DesktopHandler> = {
  'desktop.launch': async (step, ctx, rt, h) => {
    if (h.args.driver === 'electron') return launchElectron(step, ctx, rt, h, str(h.args.app, 'app'), typeof h.args.args === 'string' ? h.args.args.split(/\s+/).filter(Boolean) : []);
    const driver = h.args.driver === 'java' ? 'java' : 'windows';
    const name = str(h.args.app, 'app');
    let s: AgentSurface;
    try {
      s = driver === 'java' ? await openJava(h, name) : await openWindows(h, name);
    } catch (e) {
      return failedStep(`could not start ${driver === 'java' ? 'Java' : 'Windows'} app "${name}": ${(e as Error).message}`);
    }
    h.open(`${driver}:${name}`, s);
    return onSurface(s, step, ctx, rt, async () => {
      const w = await s.useWindow(s.window ?? (await s.client.windows())[0] ?? 'missing');
      return { surface: { driver, rung: 'object', via: `window "${w.title}"` }, newScreen: true };
    });
  },
  'desktop.attach': async (step, ctx, rt, h) => {
    const title = str(h.args.window, 'window title');
    let s = h.session.active?.kind === 'windows' || h.session.active?.kind === 'java' ? (h.session.active as unknown as AgentSurface) : undefined;
    if (!s) {
      try {
        const cfg = h.config.desktop.windows;
        if (!cfg) throw new EzTestError('attaching to a window needs a desktop.windows block (the URL of the EZTest Windows agent)', 'NO_CONFIG');
        const client = new AgentClient({ url: cfg.url, ...(cfg.token ? { token: await h.secret(cfg.token) } : {}), timeoutMs: cfg.timeoutMs });
        await client.hello();
        s = new AgentSurface('windows', title, client);
        h.open(`windows:${title}`, s);
      } catch (e) {
        return failedStep(`could not attach to "${title}": ${(e as Error).message}`);
      }
    }
    const surface = s;
    return onSurface(surface, step, ctx, rt, async () => {
      const w = await surface.useWindow(title);
      h.activate(surface);
      return { surface: { driver: surface.kind, rung: 'object', via: `window "${w.title}"` }, newScreen: true };
    });
  },
  'desktop.menu': async (step, ctx, rt, h) => {
    const s = agentSurface(h);
    const path = (h.args.path as string[] | undefined)?.map((p) => ctx.interpolate(p)) ?? [];
    if (!path.length) return failedStep('empty menu path');
    return onSurface(s, step, ctx, rt, () => s.menu(path, ctx, rt, step));
  },
  'desktop.expectWindow': async (step, ctx, rt, h) => {
    const s = agentSurface(h);
    const title = str(h.args.window, 'window title');
    return onSurface(s, step, ctx, rt, async () => {
      const deadline = Date.now() + rt.conditionTimeoutMs;
      for (;;) {
        const titles = (await s.client.windows()).map((w) => w.title);
        const open = titles.some((t) => t === title || t.includes(title));
        if (open !== Boolean(h.args.negate)) return { surface: { driver: s.kind, rung: 'object', via: `windows: ${titles.map((t) => `"${t}"`).join(', ')}` } };
        if (Date.now() >= deadline) throw new AgentError(`window "${title}" is ${open ? '' : 'not '}open (open windows: ${titles.map((t) => `"${t}"`).join(', ') || 'none'})`, 'assertion');
        await new Promise((r) => setTimeout(r, 200));
      }
    });
  },
  'desktop.close': async (step, ctx, rt, h) => {
    const s = agentSurface(h);
    const r = await onSurface(s, step, ctx, rt, async () => {
      for (const w of await s.client.windows()) await s.client.closeWindow(w.id).catch(() => undefined);
      return { surface: { driver: s.kind, rung: 'object', via: 'closed the app windows' } };
    });
    const key = [...h.session.surfaces.entries()].find(([, v]) => v === s)?.[0];
    if (key) await h.close(key);
    return r;
  },
  'desktop.cell': async (step, ctx, rt, h) => {
    const s = agentSurface(h);
    const grid = str(h.args.grid, 'grid name');
    const row = Number(h.args.row);
    const column = /^\d+$/.test(String(h.args.column)) ? Number(h.args.column) : String(h.args.column);
    return onSurface(s, step, ctx, rt, async () => {
      const l = await s.locate({ description: `the "${grid}" table`, locators: [] }, ctx, rt, step).catch(async () => s.locate({ description: `the "${grid}"`, locators: [] }, ctx, rt, step));
      const base = { surface: { driver: s.kind, rung: 'object' as const, via: `${l.el.controlType} "${grid}" row ${row} column ${column}` }, usedLocator: l.used, ...(l.heal ? { heal: l.heal } : {}) };
      if (h.args.value !== undefined) {
        const now = await s.client.cell(l.el.id, row, column, String(h.args.value));
        return { ...base, implied: { ok: now === String(h.args.value), message: `the cell holds "${now}"` } };
      }
      const value = await s.client.cell(l.el.id, row, column);
      if (h.args.expect !== undefined) {
        const want = String(h.args.expect);
        const ok = h.args.op === 'contains' ? value.includes(want) : value.trim() === want.trim();
        if (!ok) throw new AgentError(`row ${row} column ${column} of "${grid}" is "${value}", expected ${h.args.op === 'contains' ? 'it to contain ' : ''}"${want}"`, 'assertion');
      }
      return { ...base, ...(typeof h.args.as === 'string' ? { captured: { [h.args.as]: value } } : {}) };
    });
  },
  'desktop.tree': async (step, ctx, rt, h) => {
    const s = agentSurface(h);
    const tree = str(h.args.tree, 'tree name');
    const path = (h.args.path as string[]).map((p) => ctx.interpolate(p));
    const op = String(h.args.op ?? 'select');
    return onSurface(s, step, ctx, rt, async () => {
      const l = await s.locate({ description: `the "${tree}" tree`, locators: [] }, ctx, rt, step).catch(async () => s.locate({ description: `the "${tree}"`, locators: [] }, ctx, rt, step));
      await s.client.call('treePath', { id: l.el.id, path, op });
      return { surface: { driver: s.kind, rung: 'object', via: `tree "${tree}" ${op} ${path.join(' > ')}` }, usedLocator: l.used, newScreen: true };
    });
  },
  'desktop.fileDialog': async (step, ctx, rt, h) => {
    const s = agentSurface(h);
    const path = str(h.args.path, 'file path');
    return onSurface(s, step, ctx, rt, async () => {
      // The common file dialog: a "File name:" edit and an Open/Save button, in its own top-level window.
      const field = await s.locate({ description: 'the "File name" field', locators: [] }, ctx, rt, step);
      await s.client.setValue(field.el.id, path);
      await s.client.keys(['ENTER'], field.el.id);
      return { surface: { driver: s.kind, rung: 'object', via: `file dialog "${field.window.title}"` }, newScreen: true };
    });
  },
};
