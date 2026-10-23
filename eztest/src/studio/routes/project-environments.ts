/**
 * Project › Environments: the config environments (config/<env>.* and
 * .env.<env>), the active environment for Studio runs (switchable for this
 * Studio session), and the effective configuration with the layer that set
 * each value (file or environment variable). Secret values are masked.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { envToConfig, isEncryptedValue, listProjects, loadDotenvFile, MASTER_KEY_ENV } from '../../config/index.js';
import type { StudioApp } from '../app.js';
import { HttpError, sendJson } from '../http.js';
import { relPosix } from '../security.js';
import { maskConfig } from './settings.js';
import type { StudioRoute } from './route.js';

type Env = Record<string, string | undefined>;

interface ActiveState {
  original: Env;
  /** undefined = follow EZTEST_ENV of the Studio process; '' = no environment. */
  active?: string;
  /** undefined = follow EZTEST_PROJECT of the Studio process; '' = no project. */
  project?: string;
}

const STATE = new WeakMap<StudioApp, ActiveState>();

/** The environment variables of the Studio process with EZTEST_ENV overridden (live view, not a copy). */
function overlay(original: Env, extra: Env): Env {
  return new Proxy(original, {
    get: (t, k) => (typeof k === 'string' && k in extra ? extra[k] : Reflect.get(t, k)),
    has: (t, k) => (typeof k === 'string' && k in extra ? extra[k] !== undefined : Reflect.has(t, k)),
    ownKeys: (t) => [...new Set([...Reflect.ownKeys(t).filter((k) => !(typeof k === 'string' && k in extra && extra[k] === undefined)), ...Object.keys(extra).filter((k) => extra[k] !== undefined)])],
    getOwnPropertyDescriptor: (t, k) => {
      if (typeof k === 'string' && k in extra) return extra[k] === undefined ? undefined : { value: extra[k], enumerable: true, configurable: true, writable: true };
      return Reflect.getOwnPropertyDescriptor(t, k);
    },
  });
}

export function activeEnvironment(app: StudioApp): { name?: string; overridden: boolean } {
  const st = STATE.get(app);
  if (st && st.active !== undefined) return { name: st.active || undefined, overridden: true };
  return { name: app.ctx.env.EZTEST_ENV || undefined, overridden: false };
}

export function activeProject(app: StudioApp): { name?: string; overridden: boolean } {
  const st = STATE.get(app);
  if (st && st.project !== undefined) return { name: st.project || undefined, overridden: true };
  return { name: app.ctx.env.EZTEST_PROJECT || undefined, overridden: false };
}

function stateOf(app: StudioApp): ActiveState {
  let st = STATE.get(app);
  if (!st) {
    st = { original: app.ctx.env };
    STATE.set(app, st);
  }
  return st;
}

function applyOverlay(app: StudioApp, st: ActiveState): void {
  const extra: Env = {};
  if (st.active !== undefined) extra.EZTEST_ENV = st.active || undefined;
  if (st.project !== undefined) extra.EZTEST_PROJECT = st.project || undefined;
  app.ctx.env = Object.keys(extra).length ? overlay(st.original, extra) : st.original;
}

/** Switch the environment used by Studio runs, the workbench and every page (this Studio session only). */
export function setActiveEnvironment(app: StudioApp, name: string | undefined | null): void {
  if (name && !/^[A-Za-z0-9_.-]+$/.test(name)) throw new HttpError(400, 'Invalid environment name');
  const st = stateOf(app);
  st.active = name === null || name === undefined ? undefined : name;
  applyOverlay(app, st);
}

/** Switch the project overlay (projects.<name>) used by Studio runs and every page (this Studio session only). */
export function setActiveProject(app: StudioApp, name: string | undefined | null): void {
  if (name && !/^[A-Za-z0-9_.-]+$/.test(name)) throw new HttpError(400, 'Invalid project name');
  const st = stateOf(app);
  st.project = name === null || name === undefined ? undefined : name;
  applyOverlay(app, st);
}

export function studioProjects(app: StudioApp): string[] {
  return listProjects({ cwd: app.cwd, environment: (STATE.get(app)?.original ?? app.ctx.env) });
}

export async function listEnvironments(app: StudioApp): Promise<Array<{ name: string; files: string[] }>> {
  const names = new Map<string, string[]>();
  const add = (n: string, f: string) => names.set(n, [...(names.get(n) ?? []), f]);
  const cfgDir = join(app.cwd, 'config');
  if (existsSync(cfgDir)) {
    for (const f of await readdir(cfgDir)) {
      if (['.yaml', '.yml', '.json'].includes(extname(f).toLowerCase())) add(basename(f, extname(f)), `config/${f}`);
    }
  }
  // The active project's own environments (config/<project>/<env>.yaml and projects.<name>.environments).
  const project = activeProject(app).name;
  if (project && /^[A-Za-z0-9_.-]+$/.test(project)) {
    const pdir = join(cfgDir, project);
    if (existsSync(pdir)) {
      for (const f of await readdir(pdir)) {
        if (['.yaml', '.yml', '.json'].includes(extname(f).toLowerCase())) add(basename(f, extname(f)), `config/${project}/${f}`);
      }
    }
    const baseFile = firstExisting(app.cwd, 'eztest.config');
    const overlayEnvs = baseFile ? (readFileLayer(baseFile).projects as Obj | undefined)?.[project] : undefined;
    if (isObj(overlayEnvs) && isObj(overlayEnvs.environments)) for (const e of Object.keys(overlayEnvs.environments)) add(e, `projects.${project}.environments.${e}`);
  }
  for (const f of await readdir(app.cwd)) {
    const m = /^\.env\.([A-Za-z0-9_.-]+)$/.exec(f);
    if (m && !/\.(?:example|sample|template)$/.test(f)) add(m[1], f);
  }
  return [...names.entries()].map(([name, files]) => ({ name, files })).sort((a, b) => a.name.localeCompare(b.name));
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function readFileLayer(path: string): Obj {
  try {
    const text = readFileSync(path, 'utf8');
    const v = path.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
    return isObj(v) ? v : {};
  } catch {
    return {};
  }
}

function firstExisting(dir: string, base: string): string | undefined {
  for (const ext of ['.yaml', '.yml', '.json']) if (existsSync(join(dir, base + ext))) return join(dir, base + ext);
  return undefined;
}

function leaves(v: unknown, prefix: string, out: Map<string, unknown>): void {
  if (isObj(v) && Object.keys(v).length) {
    for (const [k, x] of Object.entries(v)) leaves(x, prefix ? `${prefix}.${k}` : k, out);
  } else out.set(prefix, v);
}

interface Layer {
  source: string;
  kind: 'default' | 'file' | 'dotenv' | 'environment';
  values: Map<string, unknown>;
  /** path -> environment variable that set it (environment and dotenv layers). */
  vars?: Map<string, string>;
}

/** Each config layer as the loader sees it, lowest precedence first. */
function layersFor(app: StudioApp, envName: string | undefined): Layer[] {
  const layers: Layer[] = [];
  const env = app.ctx.env;
  const baseFile = env.EZTEST_CONFIG ? join(app.cwd, env.EZTEST_CONFIG) : firstExisting(app.cwd, 'eztest.config');
  const project = activeProject(app).name;
  let overlayObj: Obj | undefined;
  if (baseFile && existsSync(baseFile)) {
    const m = new Map<string, unknown>();
    const base = readFileLayer(baseFile);
    const { projects: _projects, ...rest } = base;
    leaves(rest, '', m);
    layers.push({ source: relPosix(app.cwd, baseFile), kind: 'file', values: m });
    const o = project && isObj(base.projects) ? (base.projects as Obj)[project] : undefined;
    if (isObj(o)) {
      overlayObj = o;
      const { environments: _e, ...own } = o;
      const pm = new Map<string, unknown>();
      leaves(own, '', pm);
      layers.push({ source: `projects.${project}`, kind: 'file', values: pm });
    }
  }
  if (envName) {
    const f = firstExisting(join(app.cwd, 'config'), envName);
    if (f) {
      const m = new Map<string, unknown>();
      leaves(readFileLayer(f), '', m);
      layers.push({ source: relPosix(app.cwd, f), kind: 'file', values: m });
    }
    const inline = overlayObj && isObj(overlayObj.environments) ? (overlayObj.environments as Obj)[envName] : undefined;
    if (isObj(inline)) {
      const m = new Map<string, unknown>();
      leaves(inline, '', m);
      layers.push({ source: `projects.${project}.environments.${envName}`, kind: 'file', values: m });
    }
    const pf = project ? firstExisting(join(app.cwd, 'config', project), envName) : undefined;
    if (pf) {
      const m = new Map<string, unknown>();
      leaves(readFileLayer(pf), '', m);
      layers.push({ source: relPosix(app.cwd, pf), kind: 'file', values: m });
    }
  }
  for (const f of ['.env', ...(envName ? [`.env.${envName}`] : []), ...(project ? [`.env.${project}`, ...(envName ? [`.env.${project}.${envName}`] : [])] : [])]) {
    const vars = loadDotenvFile(join(app.cwd, f));
    if (!vars) continue;
    const m = new Map<string, unknown>();
    const by = new Map<string, string>();
    for (const [k, v] of Object.entries(vars)) {
      const one = new Map<string, unknown>();
      try {
        leaves(envToConfig({ [k]: v }), '', one);
      } catch {
        continue;
      }
      for (const [p, x] of one) {
        if (!p) continue;
        m.set(p, x);
        by.set(p, k);
      }
    }
    layers.push({ source: f, kind: 'dotenv', values: m, vars: by });
  }
  const m = new Map<string, unknown>();
  const by = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith('EZTEST_') || v === undefined) continue;
    const one = new Map<string, unknown>();
    try {
      leaves(envToConfig({ [k]: v }), '', one);
    } catch {
      continue;
    }
    for (const [p, x] of one) {
      if (!p) continue;
      m.set(p, x);
      by.set(p, k);
    }
  }
  if (m.size) layers.push({ source: 'environment', kind: 'environment', values: m, vars: by });
  return layers;
}

/** The value as written in the winning config layer (before interpolation and ENC() decryption). */
export function rawConfigValue(app: StudioApp, path: string): { value: unknown; source: string } | undefined {
  const layers = layersFor(app, activeEnvironment(app).name);
  for (let i = layers.length - 1; i >= 0; i--) if (layers[i].values.has(path)) return { value: layers[i].values.get(path), source: layers[i].source };
  return undefined;
}

const SECRETISH =/pass(?:word)?|secret|token|api[-_]?key|private|credential|^pat$|connectionstring/i;

function describeOrigin(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const enc: boolean = isEncryptedValue(raw as unknown);
  if (enc) return 'decrypted from ENC(…)';
  const vars = [...raw.matchAll(/(?<!\$)\$\{([A-Za-z_][\w]*)(?::-[^}]*)?\}/g)].map((x) => x[1]);
  if (vars.length) return `interpolated from ${vars.map((v) => `$${v}`).join(', ')}`;
  if (raw.startsWith('secret://')) return 'secret reference (resolved at run time)';
  return undefined;
}

export async function environmentsView(app: StudioApp): Promise<Record<string, unknown>> {
  const active = activeEnvironment(app);
  const envs = await listEnvironments(app);
  const layers = layersFor(app, active.name);
  let loaded;
  let error: string | undefined;
  try {
    loaded = await app.config();
  } catch (e) {
    error = (e as Error).message;
  }
  const values: Array<{ path: string; value: unknown; source: string; kind: string; via?: string; variable?: string; secret: boolean; overridden: string[] }> = [];
  if (loaded) {
    const effective = new Map<string, unknown>();
    leaves(maskConfig(loaded.config, loaded.masker), '', effective);
    for (const [path, value] of effective) {
      if (!path || path === 'projects' || path.startsWith('projects.')) continue;
      // Highest layer that sets this path (or an ancestor/descendant of it, for arrays and maps).
      const setters = layers.filter((l) => l.values.has(path));
      const top = setters[setters.length - 1];
      const leaf = path.split('.').pop() ?? '';
      values.push({
        path,
        value,
        source: top ? top.source : 'default',
        kind: top ? top.kind : 'default',
        variable: top?.vars?.get(path),
        via: top ? describeOrigin(top.values.get(path)) : undefined,
        secret: SECRETISH.test(leaf),
        overridden: setters.slice(0, -1).map((l) => l.source),
      });
    }
  }
  // Feature sections of the configuration and whether a layer sets them (new sections appear automatically).
  const SECTIONS = ['identity', 'db', 'data', 'documents', 'lenses', 'healing', 'trace', 'security', 'dialogs', 'hooks', 'email', 'sms', 'readiness', 'ado', 'd365', 'salesforce'];
  const effectiveTop = loaded ? (loaded.config as unknown as Record<string, unknown>) : {};
  const sections = SECTIONS.filter((k) => k in effectiveTop || layers.some((l) => [...l.values.keys()].some((p) => p === k || p.startsWith(`${k}.`)))).map((k) => {
    const setBy = layers.filter((l) => [...l.values.keys()].some((p) => p === k || p.startsWith(`${k}.`))).map((l) => l.source);
    return { key: k, configured: setBy.length > 0, sources: setBy, present: effectiveTop[k] !== undefined };
  });
  const sources = loaded ? loaded.sources.map((s) => (s.startsWith(app.cwd) ? relPosix(app.cwd, s) : s)) : [];
  const proj = activeProject(app);
  return {
    active: active.name ?? null,
    overridden: active.overridden,
    project: proj.name ?? null,
    projectOverridden: proj.overridden,
    processProject: (STATE.get(app)?.original ?? app.ctx.env).EZTEST_PROJECT ?? null,
    projects: studioProjects(app),
    processEnv: (STATE.get(app)?.original ?? app.ctx.env).EZTEST_ENV ?? null,
    environments: envs,
    sources,
    sections,
    layers: [{ source: 'defaults', kind: 'default', count: 0 }, ...layers.map((l) => ({ source: l.source, kind: l.kind, count: l.values.size }))],
    values,
    warnings: loaded ? loaded.warnings.map((w) => loaded.masker.mask(w)) : [],
    error: error && loaded === undefined ? error : undefined,
    masterKey: !!app.ctx.env[MASTER_KEY_ENV],
  };
}

export const environmentRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/project/environments',
    summary: 'Config environments, the active one, layers and the effective config with value sources (masked)',
    async handler({ res, app }) {
      sendJson(res, 200, await environmentsView(app));
    },
  },
  {
    method: 'POST',
    path: '/api/project/environments/active',
    summary: 'Switch the active environment for Studio runs (null: follow EZTEST_ENV)',
    async handler({ res, app, body }) {
      const name = body.name === null || body.name === undefined ? null : String(body.name);
      if (name) {
        const known = (await listEnvironments(app)).map((e) => e.name);
        if (!known.includes(name)) throw new HttpError(400, `Unknown environment "${name}" (known: ${known.join(', ') || 'none'})`);
      }
      if (app.runs.current) throw new HttpError(409, 'A run is in progress; switch the environment after it finishes');
      setActiveEnvironment(app, name);
      // Validate right away so the UI can show a broken environment immediately.
      let ok = true;
      let error: string | undefined;
      try {
        await app.config();
      } catch (e) {
        ok = false;
        error = (e as Error).message;
      }
      app.hub.publish('project', { type: 'environment', name: activeEnvironment(app).name ?? null });
      sendJson(res, 200, { ok, error, active: activeEnvironment(app).name ?? null });
    },
  },
  {
    method: 'POST',
    path: '/api/project/environments/project',
    summary: 'Switch the active project overlay (projects.<name>) for Studio runs (null: follow EZTEST_PROJECT)',
    async handler({ res, app, body }) {
      const name = body.name === null || body.name === undefined ? null : String(body.name);
      if (name) {
        const known = studioProjects(app);
        if (!known.includes(name)) throw new HttpError(400, `Unknown project "${name}" (known: ${known.join(', ') || 'none'})`);
      }
      if (app.runs.current) throw new HttpError(409, 'A run is in progress; switch the project after it finishes');
      setActiveProject(app, name);
      let ok = true;
      let error: string | undefined;
      try {
        await app.config();
      } catch (e) {
        ok = false;
        error = (e as Error).message;
      }
      app.hub.publish('project', { type: 'project', name: activeProject(app).name ?? null });
      sendJson(res, 200, { ok, error, project: activeProject(app).name ?? null });
    },
  },
];
