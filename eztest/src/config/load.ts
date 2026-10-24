/**
 * Layered configuration loading, lowest to highest precedence:
 *   1. built-in defaults (the schema)
 *   2. eztest.config.yaml | .yml | .json
 *   3. the selected project's overlay (projects.<name>, --project / EZTEST_PROJECT)
 *   4. config/<env>.yaml | .yml | .json, then projects.<name>.environments.<env>,
 *      then config/<project>/<env>.yaml | .yml | .json
 *   5. .env, .env.<env> files (feed EZTEST_* keys and ${VAR} interpolation)
 *   6. real EZTEST_* environment variables
 *   7. programmatic / CLI overrides
 * Then: ${VAR} / ${VAR:-default} interpolation (variables: config `vars`, then
 * .env, then the real environment), ENC(...) decryption, validation.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ZodType } from 'zod';
import { EzTestError, interpolate } from '../core/index.js';
import { EzTestConfigSchema, type EzTestConfig } from './schema.js';
import { stripRemovedKeys } from './removed.js';
import { decryptValue, isEncryptedValue, MASTER_KEY_ENV } from './crypto.js';
import { loadDotenvFile } from './dotenv.js';
import { SecretMasker, defaultMasker } from './masker.js';

export interface LoadConfigOptions {
  /** Project directory (default process.cwd()). */
  cwd?: string;
  /** Environment name; selects config/<env>.* and .env.<env>. Default: EZTEST_ENV, else none. */
  env?: string;
  /** Project name; selects the `projects.<name>` overlay. Default: EZTEST_PROJECT, else none. */
  project?: string;
  /** Explicit base config file instead of eztest.config.*. */
  configFile?: string;
  /** Explicit .env files (relative to cwd). Default: ['.env', '.env.<env>']. */
  envFiles?: string[];
  /** Process environment (default process.env). Injectable for tests. */
  environment?: Record<string, string | undefined>;
  /** Highest-precedence overrides (CLI flags, programmatic). */
  overrides?: Record<string, unknown>;
  /** Masker to register decrypted values with (default: the shared masker). */
  masker?: SecretMasker;
}

export interface LoadedConfig {
  config: EzTestConfig;
  /** Unknown keys and other non-fatal findings of the configuration files. */
  warnings: string[];
  /**
   * EZTEST_* environment variables (and .env entries) that name no configuration key: ignored.
   * Kept apart from `warnings` because the environment is not the project's configuration
   * (a CI agent may set variables for other tools); commands print them on stderr only.
   */
  envWarnings?: string[];
  /** Files and layers that contributed, in precedence order. */
  sources: string[];
  env?: string;
  /** The selected project, if any. */
  project?: string;
  masker: SecretMasker;
  /** Variables visible to interpolation (.env merged under the real environment). Values are not logged. */
  variables: Record<string, string>;
}

export class ConfigError extends EzTestError {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(issues.length ? `${message}\n  - ${issues.join('\n  - ')}` : message, 'CONFIG_INVALID', { issues });
    this.name = 'ConfigError';
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);

/** Deep merge: objects merge key by key, everything else (incl. arrays) is replaced. */
export function deepMerge(base: Obj, over: Obj): Obj {
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k] as Obj, v) : v;
  }
  return out;
}

function readConfigFile(path: string): Obj {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`Cannot read config file ${path}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = path.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    throw new ConfigError(`Cannot parse config file ${path}: ${(e as Error).message}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isObj(parsed)) throw new ConfigError(`Config file ${path} must contain a mapping/object at the top level`);
  return parsed;
}

function firstExisting(dir: string, base: string): string | undefined {
  for (const ext of ['.yaml', '.yml', '.json']) {
    const p = join(dir, base + ext);
    if (existsSync(p)) return p;
  }
  return undefined;
}

// ------------------------------------------------------------ schema-guided env coercion

interface ZodInternals {
  _zod: { def: { type: string; innerType?: ZodType; shape?: Record<string, ZodType>; valueType?: ZodType; element?: ZodType; options?: ZodType[]; in?: ZodType } };
}
function defOf(s: ZodType): ZodInternals['_zod']['def'] {
  return (s as unknown as ZodInternals)._zod.def;
}
function unwrap(s: ZodType): ZodType {
  let cur = s;
  for (let i = 0; i < 20; i++) {
    const d = defOf(cur);
    if (['optional', 'default', 'prefault', 'nullable', 'readonly', 'catch'].includes(d.type) && d.innerType) cur = d.innerType;
    else if (d.type === 'pipe' && d.in) cur = d.in;
    else break;
  }
  return cur;
}
/** Find the schema at a key path, resolving keys case-insensitively (env vars lose case). */
function schemaAt(root: ZodType, path: string[]): { schema?: ZodType; keys: string[] } {
  let cur: ZodType | undefined = unwrap(root);
  const keys: string[] = [];
  for (const raw of path) {
    if (!cur) {
      keys.push(raw);
      continue;
    }
    const d = defOf(cur);
    if (d.type === 'object' && d.shape) {
      const match = Object.keys(d.shape).find((k) => k.toLowerCase() === raw.toLowerCase());
      keys.push(match ?? raw);
      cur = match ? unwrap(d.shape[match]) : undefined;
    } else if (d.type === 'record' && d.valueType) {
      keys.push(raw);
      cur = unwrap(d.valueType);
    } else {
      keys.push(raw);
      cur = undefined;
    }
  }
  return { schema: cur, keys };
}

function snakeToCamel(s: string): string {
  return s.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function coerceEnv(value: string, schema: ZodType | undefined, name: string): unknown {
  const t = schema ? defOf(schema).type : 'string';
  const v = value.trim();
  switch (t) {
    case 'number':
    case 'int': {
      if (!/^-?\d+(\.\d+)?$/.test(v)) throw new ConfigError(`Environment variable ${name} must be a number`);
      return Number(v);
    }
    case 'boolean': {
      if (/^(true|1|yes|on)$/i.test(v)) return true;
      if (/^(false|0|no|off)$/i.test(v)) return false;
      throw new ConfigError(`Environment variable ${name} must be a boolean (true/false)`);
    }
    case 'array':
      if (v.startsWith('[')) return parseJsonEnv(v, name);
      return v === '' ? [] : v.split(',').map((x) => x.trim()).filter(Boolean);
    case 'object':
    case 'record':
      return parseJsonEnv(v, name);
    case 'union': {
      if (/^-?\d+$/.test(v)) return Number(v);
      if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
      return value;
    }
    default:
      return value;
  }
}
function parseJsonEnv(v: string, name: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    throw new ConfigError(`Environment variable ${name} must be valid JSON`);
  }
}

/** Values under keys like these are registered with the masker even when they were not encrypted. */
const SENSITIVE_KEY = /(password|passwd|secret|token|apikey|api_key|pat|credential|connectionstring)$/i;

const RESERVED_ENV = new Set(['EZTEST_MASTER_KEY', 'EZTEST_ENV', 'EZTEST_CONFIG', 'EZTEST_PROJECT', 'EZTEST_CODE_LOADER', 'EZTEST_ADO_PAT', 'EZTEST_ADO_PLAN']);
/**
 * Live-database test switches (docs/databases.md), results-server and shard variables, and the
 * browser driver's own variables (docs/browser-driver.md): not config keys.
 */
const RESERVED_ENV_PREFIX = /^EZTEST_(?:ORACLE|MSSQL|REPORT)_|^EZTEST_SERVER_(?!_)|^EZTEST_SHARD(?:_|$)|^EZTEST_(?:FIREFOX|CFT|CANCEL)_|^EZTEST_TEMP_SWEEP(?:_HOURS)?$|^EZTEST_(?:CHROMIUM_PATH|CHROMIUM_SANDBOX|BROWSERS_PATH|HEADLESS_SHELL|TEST_BROWSER_DIRS)$/;

/** Turn EZTEST_* variables into a config object (EZTEST_AI__MODEL -> ai.model). `origin` records key path -> variable name. */
export function envToConfig(vars: Record<string, string | undefined>, origin?: Map<string, string>): Obj {
  let out: Obj = {};
  for (const [name, value] of Object.entries(vars)) {
    if (!name.startsWith('EZTEST_') || value === undefined || RESERVED_ENV.has(name) || RESERVED_ENV_PREFIX.test(name)) continue;
    const parts = name.slice('EZTEST_'.length).split('__').filter(Boolean).map(snakeToCamel);
    if (parts.length === 0) continue;
    const { schema, keys } = schemaAt(EzTestConfigSchema, parts);
    let node: unknown = coerceEnv(value, schema, name);
    for (let i = keys.length - 1; i >= 0; i--) node = { [keys[i]]: node };
    origin?.set(keys.join('.'), name);
    out = deepMerge(out, node as Obj);
  }
  return out;
}

// ------------------------------------------------------------ interpolation + decryption

function transformStrings(value: unknown, path: string, fn: (s: string, path: string) => string): unknown {
  if (typeof value === 'string') return fn(value, path);
  if (Array.isArray(value)) return value.map((v, i) => transformStrings(v, `${path}[${i}]`, fn));
  if (isObj(value)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) out[k] = transformStrings(v, path ? `${path}.${k}` : k, fn);
    return out;
  }
  return value;
}

/** Report keys present in the input but dropped by the schema. */
function unknownKeys(input: unknown, output: unknown, path: string, out: string[]): void {
  if (!isObj(input) || !isObj(output)) {
    if (Array.isArray(input) && Array.isArray(output)) {
      input.forEach((v, i) => unknownKeys(v, output[i], `${path}[${i}]`, out));
    }
    return;
  }
  for (const k of Object.keys(input)) {
    const p = path ? `${path}.${k}` : k;
    if (!(k in output)) out.push(p);
    else unknownKeys(input[k], output[k], p, out);
  }
}

export function formatIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string[] {
  return issues.map((i) => `${i.path.length ? i.path.map(String).join('.') : '(root)'}: ${i.message}`);
}

/** Validate an already-merged raw config object. */
export function validateConfig(input: unknown): { config: EzTestConfig; warnings: string[] } {
  // Keys of removed integrations with other testing tools: warned about with a migration hint, never a hard error.
  const { raw, warnings: removed } = stripRemovedKeys(input);
  const r = EzTestConfigSchema.safeParse(raw);
  if (!r.success) throw new ConfigError('Invalid EZTest configuration', formatIssues(r.error.issues));
  const unknown: string[] = [];
  unknownKeys(raw, r.data, '', unknown);
  return { config: r.data, warnings: [...removed, ...unknown.map((p) => `Unknown configuration key "${p}" (ignored)`)] };
}

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * Shape fixes applied before validation, so several spellings are accepted:
 * `browser: { name, channel }` becomes `browser` + `channel`, and a DB connection
 * written with `type:` (a common spelling in other tools) gets `driver:`.
 */
export function normalizeRawConfig(raw: Obj): Obj {
  const out: Obj = { ...raw };
  if (isObj(out.browser)) {
    const b = out.browser;
    if (b.channel !== undefined && out.channel === undefined) out.channel = b.channel;
    // `browser: { connect: { cdpEndpoint | bidiEndpoint, headers, auth } }`: attach to a running browser.
    if (b.connect !== undefined && out.browserConnect === undefined) out.browserConnect = b.connect;
    out.browser = b.name ?? b.type ?? 'chromium';
  }
  if (isObj(out.db) && isObj(out.db.connections)) {
    const conns: Obj = {};
    for (const [k, c] of Object.entries(out.db.connections)) {
      conns[k] = isObj(c) && c.driver === undefined && typeof c.type === 'string' ? (({ type, ...rest }) => ({ driver: type, ...rest }))(c) : c;
    }
    out.db = { ...out.db, connections: conns };
  }
  return out;
}

/** Project names declared in the base config file (no validation, no interpolation). */
export function listProjects(opts: { cwd?: string; configFile?: string; environment?: Record<string, string | undefined> } = {}): string[] {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const envVars = opts.environment ?? process.env;
  const file = opts.configFile ? resolve(cwd, opts.configFile) : envVars.EZTEST_CONFIG ? resolve(cwd, envVars.EZTEST_CONFIG) : firstExisting(cwd, 'eztest.config');
  if (!file || !existsSync(file)) return [];
  try {
    const raw = readConfigFile(file);
    return isObj(raw.projects) ? Object.keys(raw.projects).sort() : [];
  } catch {
    return [];
  }
}

/** Resolve `vars` among themselves and against the environment (non-strict; strict checking happens later). */
function resolveVars(vars: Record<string, string>, env: Record<string, string>): Record<string, string> {
  let cur = { ...vars };
  for (let i = 0; i < 10; i++) {
    let changed = false;
    const scope = { ...cur, ...env };
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(cur)) {
      const r = env[k] !== undefined ? env[k] : interpolate(v, scope);
      if (r !== v) changed = true;
      next[k] = r;
    }
    cur = next;
    if (!changed) break;
  }
  return cur;
}

export async function loadConfig(opts: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const processEnv = opts.environment ?? process.env;
  const env = opts.env ?? processEnv.EZTEST_ENV ?? undefined;
  const masker = opts.masker ?? defaultMasker;
  const sources: string[] = ['defaults'];
  let raw: Obj = {};

  // 2. base file
  const baseFile = opts.configFile
    ? resolve(cwd, opts.configFile)
    : processEnv.EZTEST_CONFIG
      ? resolve(cwd, processEnv.EZTEST_CONFIG)
      : firstExisting(cwd, 'eztest.config');
  if (baseFile) {
    if (!existsSync(baseFile)) throw new ConfigError(`Config file not found: ${baseFile}`);
    raw = deepMerge(raw, readConfigFile(baseFile));
    sources.push(baseFile);
  }

  // 3. project overlay
  const project = opts.project ?? (processEnv.EZTEST_PROJECT || undefined);
  let overlay: Obj | undefined;
  if (project) {
    if (!NAME_RE.test(project)) throw new ConfigError(`Invalid project name "${project}"`);
    const projects = isObj(raw.projects) ? raw.projects : {};
    const o = projects[project];
    if (!isObj(o)) {
      const known = Object.keys(projects);
      throw new ConfigError(`Unknown project "${project}" (${known.length ? `known: ${known.join(', ')}` : 'the config has no projects: section'})`);
    }
    overlay = o;
    const { environments: _envs, projects: _p, project: _n, ...rest } = o;
    raw = deepMerge(raw, rest);
    sources.push(`projects.${project}`);
  }

  // 4. environment files: shared, then the project's own
  if (env) {
    if (!NAME_RE.test(env)) throw new ConfigError(`Invalid environment name "${env}"`);
    const envFile = firstExisting(join(cwd, 'config'), env);
    if (envFile) {
      raw = deepMerge(raw, readConfigFile(envFile));
      sources.push(envFile);
    }
    if (project && overlay) {
      const inline = isObj(overlay.environments) ? overlay.environments[env] : undefined;
      if (isObj(inline)) {
        raw = deepMerge(raw, inline);
        sources.push(`projects.${project}.environments.${env}`);
      }
      const projFile = firstExisting(join(cwd, 'config', project), env);
      if (projFile) {
        raw = deepMerge(raw, readConfigFile(projFile));
        sources.push(projFile);
      }
    }
  }

  // 5. .env files
  const dotenvVars: Record<string, string> = {};
  const envFiles = opts.envFiles ?? ['.env', ...(env ? [`.env.${env}`] : []), ...(project ? [`.env.${project}`, ...(env ? [`.env.${project}.${env}`] : [])] : [])];
  for (const f of envFiles) {
    const p = resolve(cwd, f);
    const vars = loadDotenvFile(p);
    if (vars) {
      Object.assign(dotenvVars, vars);
      sources.push(p);
    } else if (opts.envFiles) {
      throw new ConfigError(`.env file not found: ${p}`);
    }
  }
  const envOrigin = new Map<string, string>();
  raw = deepMerge(raw, envToConfig(dotenvVars, envOrigin));

  // 6. real EZTEST_* variables
  const fromEnv = envToConfig(processEnv, envOrigin);
  if (Object.keys(fromEnv).length) {
    raw = deepMerge(raw, fromEnv);
    sources.push('environment');
  }

  // 7. overrides
  if (opts.overrides && Object.keys(opts.overrides).length) {
    raw = deepMerge(raw, opts.overrides);
    sources.push('overrides');
  }
  if (env && raw.environment === undefined) raw.environment = env;
  if (project) raw.project = project;
  raw = normalizeRawConfig(raw);

  // interpolation and decryption
  const envVariables: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...dotenvVars, ...processEnv })) if (v !== undefined) envVariables[k] = v;
  const configVars: Record<string, string> = {};
  if (isObj(raw.vars)) for (const [k, v] of Object.entries(raw.vars)) if (v !== undefined && v !== null && typeof v !== 'object') configVars[k] = String(v);
  const resolvedVars = resolveVars(configVars, envVariables);
  const variables: Record<string, string> = { ...resolvedVars, ...envVariables };
  const masterKey = variables[MASTER_KEY_ENV];
  if (masterKey) masker.add(masterKey);

  const issues: string[] = [];
  // Other projects' overlays are kept as written (they may reference variables only their runs set);
  // `vars` are resolved leniently (an unresolved ${X} stays as text).
  const { projects: rawProjects, vars: _rawVars, ...toProcess } = raw;
  const processed = transformStrings(toProcess, '', (s, path) => {
    let out = s;
    try {
      out = interpolate(s, variables, { strict: true });
    } catch (e) {
      issues.push(`${path}: ${(e as Error).message} is not set and has no default`);
      return s;
    }
    if (isEncryptedValue(out)) {
      try {
        out = decryptValue(out, masterKey);
        masker.add(out);
      } catch (e) {
        issues.push(`${path}: ${(e as Error).message}`);
      }
    }
    if (SENSITIVE_KEY.test(path.split('.').pop() ?? '') && !out.startsWith('secret://')) masker.add(out);
    return out;
  });
  if (issues.length) throw new ConfigError('Configuration could not be resolved', issues);
  const finalVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(resolvedVars)) {
    let out = v;
    if (isEncryptedValue(out)) {
      try {
        out = decryptValue(out, masterKey);
        masker.add(out);
      } catch (e) {
        throw new ConfigError('Configuration could not be resolved', [`vars.${k}: ${(e as Error).message}`]);
      }
    }
    if (SENSITIVE_KEY.test(k)) masker.add(out);
    finalVars[k] = out;
    if (variables[k] === v) variables[k] = out;
  }
  (processed as Obj).vars = finalVars;
  if (rawProjects !== undefined) (processed as Obj).projects = rawProjects;

  const { config, warnings: all } = validateConfig(processed);
  // Unknown keys that only an environment variable introduced are the environment's, not the config's.
  const warnings: string[] = [];
  const envWarnings: string[] = [];
  for (const w of all) {
    const m = /^Unknown configuration key "([^"]+)" \(ignored\)$/.exec(w);
    const name = m ? envOrigin.get(m[1]) ?? [...envOrigin].find(([p]) => p.startsWith(`${m[1]}.`))?.[1] : undefined;
    if (name) envWarnings.push(`environment variable ${name} is not an EZTest setting (ignored; nested settings use "__", e.g. EZTEST_ADO__ORG_URL for ado.orgUrl)`);
    else warnings.push(w);
  }
  return { config, warnings, envWarnings, sources, env, project, masker, variables };
}
