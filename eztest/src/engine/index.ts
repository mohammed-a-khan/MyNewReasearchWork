/**
 * The engine wires EZTest's modules together from one loaded configuration:
 * identity (login + API tokens), databases, the test data fabric, document
 * checks and the healer all become runner handlers. The CLI and programmatic
 * users both go through `runWithConfig`, so behaviour is identical.
 */
import { resolveServerToken } from './server-token.js';
import { ElementRepository } from '../elements/repository.js';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Journey, Logger, RunResult, DataNeed } from '../core/index.js';
import { EzTestError, setBusinessCalendar, silentLogger } from '../core/index.js';
import { loadHolidays, type EzTestConfig, type LoadedConfig, type DocumentCheckConfig } from '../config/index.js';
import { AccountPool, LockoutGuard, createPooledLogin, identityVaultFromConfig, resolveClientCertificates, type IdentityVault } from '../identity/index.js';
import { DbRegistry, ApiClient, type DbConnectionSpec, type OracleDbClient } from '../surfaces/index.js';
import { QueryCatalogue, resolveQueryExamples, type QueryValue } from '../queries/index.js';
import {
  CleanupJournal,
  DataFabric,
  LeaseRegistry,
  SqlDataProvider,
  ApiDataProvider,
  SyntheticProvider,
  type DataProvider,
  type SqlEntityMapping,
  type ApiEntityMapping,
} from '../data/index.js';
import { autoApplyHeals, collectHealProposals, createHealer, FingerprintStore, HealDecisions } from '../heal/index.js';
import { extractPdf, reconcileThreeWay, renderHtml, type ThreeWayMapping } from '../docs/index.js';
import { visualDocumentCheck } from '../docs/visual-step.js';
import { createSoapStepHandler, SOAP_STEP } from '../surfaces/soap-step.js';
import type { CompareDocumentHandler, DataHandler, DbHandler, Lens, RunHooks, RunOptions, StepContext } from '../runner/index.js';
import { loadJourneyFile } from '../intent/index.js';
import { SmtpSink, TwilioSmsProvider, TwilioVoiceProvider, loadTranscriptFixtures } from '../messaging/index.js';
import { defaultFingerprintStorePath, runJourneys } from '../runner/index.js';
import { ResultsClient } from '../server/client.js';
import { storeFromConfig, type SharedStore } from '../store/index.js';
import { branchBaselineDir, seedBranchBaselinesSync } from '../git/branch.js';
import { createD365Integration, type D365Integration } from '../d365/index.js';
import { createSalesforceIntegration, type SalesforceIntegration } from '../salesforce/index.js';
import { enableAppPacks, hasAppPacks, type AppPacks } from '../apps/index.js';
import { createDesktopIntegration } from '../desktop/index.js';
import { mobileRunOptions } from '../mobile/index.js';
import { A11Y_STEP, createA11yStepHandler } from '../a11y/step.js';
import { createA11yLens, createPerfLens, createSecurityLens, createVisualLens, createVisualStepHandler, currentBranch, VISUAL_STEP, type A11yLensOptions, type Lens as EvalLens } from '../lenses/index.js';
import { integrationFromConfig } from '../integration/from-config.js';
import { recordApiCoverage } from '../contracts/run-coverage.js';
import { browserRunOptions } from './browsers.js';
import { KEYBOARD_STEP, createKeyboardStepHandler } from '../lenses/keyboard.js';
import { registries, pluginSteps, pluginLoginRecipe } from '../plugins/registry.js';

export interface EngineOptions {
  cwd?: string;
  logger?: Logger;
  /** Extra runner options that win over config-derived ones (e.g. lenses, custom steps). */
  runOptions?: Partial<RunOptions>;
  /** The results server client (the shared store uses it when store.backend is auto/server). Default: from `server:`. */
  serverClient?: ResultsClient;
  /** Where the pipeline outputs of values saved "for the pipeline" go (default: stdout, unmasked: CI logging commands). */
  pipelineOut?: (line: string) => void;
  /** Name of the `pipelines:` entry being run (recorded in the store export). */
  pipeline?: string;
  /** What process workers need beyond the configuration (eztest run flags), see src/engine/worker-setup.ts. */
  worker?: { updateBaselines?: boolean; timeTravel?: boolean };
}

export interface Engine {
  config: EzTestConfig;
  vault: IdentityVault;
  dbs: DbRegistry;
  /** The named-query catalogue (db.queries), loaded on first use. */
  queries(): Promise<QueryCatalogue>;
  /** Rows for `Examples: from query "NAME" on <alias> where ...` (the query DataSourceResolver). */
  queryExamples(name: string, alias: string | undefined, params: Record<string, QueryValue>): Promise<Array<Record<string, string>>>;
  /** Runner options derived from config. */
  runOptions: RunOptions;
  run(journeys: Journey[]): Promise<RunResult>;
  close(): Promise<void>;
  /** The shared store and data pools (docs/shared-data.md). */
  store: SharedStore;
}

/** URL of a module next to this one: the .js build when it exists, else the TypeScript source (development). */
function siblingModule(from: string, name: string): string {
  const js = new URL(`./${name}.js`, from);
  return existsSync(js) ? js.href : new URL(`./${name}.ts`, from).href;
}

function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function dbSpecs(config: EzTestConfig): Record<string, DbConnectionSpec> {
  return config.db.connections as unknown as Record<string, DbConnectionSpec>;
}

/** A DbRegistry for the config's connections; secret:// passwords resolve through the identity vault's stores. */
export function dbRegistryFromConfig(config: EzTestConfig, vault: IdentityVault): DbRegistry {
  return new DbRegistry(dbSpecs(config), { resolveSecret: (ref) => vault.registry.resolve(ref) });
}

/** Build data providers from `data.entities`. */
async function buildProviders(config: EzTestConfig, dbs: DbRegistry, vault: IdentityVault): Promise<DataProvider[]> {
  const providers: DataProvider[] = [];
  const sqlByConn = new Map<string, Record<string, SqlEntityMapping>>();
  const apiByConn = new Map<string, Record<string, ApiEntityMapping>>();
  const synthetic: Record<string, Record<string, unknown>> = {};
  for (const [entity, e] of Object.entries(config.data.entities)) {
    if (e.provider === 'sql') {
      if (!e.connection || !e.table) throw new EzTestError(`data.entities.${entity}: sql provider needs "connection" and "table"`, 'CONFIG');
      const m = sqlByConn.get(e.connection) ?? {};
      m[entity] = { table: e.table, key: e.key, columns: e.columns, ...(e.defaults ? { defaults: e.defaults } : {}) };
      sqlByConn.set(e.connection, m);
    } else if (e.provider === 'api') {
      if (!e.connection) throw new EzTestError(`data.entities.${entity}: api provider needs "connection"`, 'CONFIG');
      const m = apiByConn.get(e.connection) ?? {};
      m[entity] = { listPath: e.findPath, createPath: e.createPath, deletePath: e.deletePath, idField: e.key };
      apiByConn.set(e.connection, m);
    } else {
      synthetic[entity] = Object.fromEntries(Object.entries(e.columns ?? {}).map(([field, gen]) => [field, `gen:${gen}`]));
    }
  }
  for (const [conn, entities] of sqlByConn) {
    providers.push(new SqlDataProvider({ db: await dbs.get(conn), entities, seed: config.data.seed }));
  }
  for (const [conn, entities] of apiByConn) {
    const c = config.data.connections[conn];
    if (!c) throw new EzTestError(`data.connections.${conn} is not defined`, 'CONFIG');
    const role = c.auth;
    const api = new ApiClient({
      baseUrl: c.baseUrl,
      auth: role ? { type: 'oauth2', tokenProvider: { getToken: () => vault.apiToken(role) } } : undefined,
    });
    providers.push(new ApiDataProvider({ api, entities, name: `api:${conn}`, seed: config.data.seed }));
  }
  if (Object.keys(synthetic).length) providers.push(new SyntheticProvider({ entities: synthetic, seed: config.data.seed }));
  // Data providers contributed by plugins (they declare the entities they support).
  providers.push(...registries.dataProviders.list());
  return providers;
}

/**
 * Add-ons enabled by config (Dynamics 365, Salesforce, the src/apps packs). Their plain-English
 * phrasings must be registered BEFORE journeys are parsed, so call this right
 * after loading config. Secret references in the add-on config are resolved
 * through the Identity Vault. Returns the integrations and an unregister function.
 */
export async function enableAddons(
  loaded: LoadedConfig,
  opts: { cwd?: string; vault?: IdentityVault } = {},
): Promise<Addons> {
  const cfg = loaded.config;
  if (!cfg.d365 && !cfg.salesforce && !hasAppPacks(cfg)) return { off: () => {} };
  const vault = opts.vault ?? identityVaultFromConfig(cfg, { cwd: opts.cwd, masker: loaded.masker });
  const addons: Addons = { off: () => {} };
  const offs: Array<() => void> = [];
  if (cfg.d365) {
    const raw = { ...(cfg.d365 as Record<string, unknown>) };
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && v.startsWith('secret://')) {
        const value = await vault.registry.resolve(v);
        loaded.masker.add(value);
        raw[k] = value;
      }
    }
    addons.d365 = createD365Integration(raw as never, { entityNames: (raw.entities as string[] | undefined) ?? [] });
    offs.push(addons.d365.registerIntents());
  }
  if (cfg.salesforce) {
    // Passwords live inside `users`; the integration resolves secret:// and ENC() lazily via the registry.
    addons.salesforce = createSalesforceIntegration(cfg.salesforce as never, { secrets: vault.registry });
    offs.push(addons.salesforce.registerIntents());
  }
  // Packaged-app packs (docs/apps/): secrets resolve lazily through the vault's registry.
  const apps = enableAppPacks(cfg, { secrets: vault.registry, provideDataverseVerify: !cfg.d365 });
  if (apps) {
    addons.apps = apps;
    offs.push(apps.off);
  }
  addons.off = () => {
    for (const off of offs.reverse()) off();
  };
  return addons;
}

export interface Addons {
  d365?: D365Integration;
  salesforce?: SalesforceIntegration;
  /** SAP Fiori, ServiceNow, Workday, Oracle and Power Apps packs (src/apps). */
  apps?: AppPacks;
  off: () => void;
}

/** Adapt an evaluation lens (a11y/visual/security) to the runner's lens contract. */
export function toRunnerLens(lens: EvalLens, failSeverity: 'error' | 'warning' = 'error'): Lens {
  return {
    name: lens.name,
    async afterStep(page, step, ctx) {
      const r = await lens.afterStep(page, { id: step.id, intent: step.intent }, { journeyId: ctx.journey.id });
      return [{ lens: lens.name, severity: r.passed ? 'info' : failSeverity, message: r.summary, details: r.data }];
    },
  };
}

/**
 * Lenses named in config: "a11y", "security", "visual", "perf"; suffix ":warn" records
 * findings without failing the step (e.g. "a11y:warn").
 */
/** The project's element repository (elements/*.yaml, configured screens) for RunOptions.elements; none when empty. */
async function loadElementRepository(cwd: string, o: { dir: string; screens: string[]; matchDescriptions: boolean }, logger?: { warn(m: string, d?: Record<string, unknown>): void }): Promise<{ elements?: ElementRepository }> {
  const repo = await ElementRepository.load(cwd, o);
  for (const p of repo.problems) logger?.warn(`element repository: ${p.file}: ${p.message}`);
  return repo.size ? { elements: repo } : {};
}

/** a11y lens options from config `accessibility` (tags, include/exclude, disabled rules, failOn). */
export function a11yLensOptions(config: Pick<EzTestConfig, 'accessibility'>): A11yLensOptions | undefined {
  const a = config.accessibility;
  if (!a) return undefined;
  const o: A11yLensOptions = {
    ...(a.tags?.length ? { tags: a.tags } : {}), ...(a.include?.length ? { include: a.include } : {}), ...(a.exclude?.length ? { exclude: a.exclude } : {}),
    ...(a.disableRules?.length ? { disableRules: a.disableRules } : {}), ...(a.failOn ? { failOn: a.failOn } : {}),
  };
  return Object.keys(o).length ? o : undefined;
}

export function lensesFromConfig(names: string[], cwd: string, opts: { updateBaselines?: boolean; branchBaselines?: boolean; defaultBranch?: string; a11y?: A11yLensOptions } = {}): Lens[] {
  return names.map((raw) => {
    const [name, mode] = raw.split(':');
    const sev = mode === 'warn' ? 'warning' : 'error';
    if (name === 'a11y') return toRunnerLens(createA11yLens(opts.a11y), sev);
    if (name === 'security') return toRunnerLens(createSecurityLens(), sev);
    if (name === 'perf') return toRunnerLens(createPerfLens(), sev);
    if (name === 'visual') {
      // vcs.branchScope.baselines: each branch compares against its own copy, seeded from the default branch's (docs/git.md).
      const shared = resolve(cwd, '.eztest/baselines');
      const baselineDir = opts.branchBaselines ? branchBaselineDir(shared, cwd, { defaultBranch: opts.defaultBranch }) : shared;
      if (baselineDir !== shared) seedBranchBaselinesSync(shared, baselineDir);
      return toRunnerLens(createVisualLens({ baselineDir, update: opts.updateBaselines }), sev);
    }
    const fromPlugin = registries.lenses.get(name);
    if (fromPlugin) return fromPlugin({ cwd, mode: sev, updateBaselines: opts.updateBaselines });
    throw new EzTestError(`Unknown lens "${raw}". Available: a11y, security, visual, perf${registries.lenses.names().map((n) => `, ${n}`).join('')} (optionally ":warn")`, 'CONFIG');
  });
}

/** Document checks: "Compare document <downloadKey> to <subject> using <checkName>". */
export function documentCheckHandler(config: EzTestConfig, dbs: DbRegistry, cwd: string): CompareDocumentHandler {
  const templates = new Map<string, unknown>();
  async function loadTemplate(path: string): Promise<unknown> {
    const abs = resolvePath(cwd, path);
    if (!templates.has(abs)) templates.set(abs, parseYaml(await readFile(abs, 'utf8')));
    return templates.get(abs);
  }
  return async (args, ctx) => {
    if (args.mode === 'visual') return visualDocumentCheck(args, ctx, cwd);
    const docKey = String(args.document ?? '');
    const checkName = String(args.using ?? args.against ?? '');
    const check: DocumentCheckConfig | undefined = config.documents[checkName];
    if (!check) {
      throw new EzTestError(
        `No document check "${checkName}" in config.documents (known: ${Object.keys(config.documents).join(', ') || 'none'})`,
        'CONFIG',
      );
    }
    const download = ctx.ledger.get(docKey) as { path?: string } | undefined;
    if (!download?.path) throw new EzTestError(`Ledger key "${docKey}" holds no downloaded file`, 'NO_DOCUMENT');
    const doc = await extractPdf(download.path, { template: (await loadTemplate(check.template)) as never, source: docKey });

    let dbRow: Record<string, unknown> | undefined;
    let lineRows: Array<Record<string, unknown>> = [];
    if (check.db) {
      const client = await dbs.get(check.db.connection);
      const params = check.db.params.map((p) => (typeof p === 'string' ? ctx.interpolate(p) : p));
      const rows = await client.query(check.db.query, params);
      dbRow = rows[0];
      if (check.db.linesQuery) lineRows = await client.query(check.db.linesQuery, params);
    }
    const ui: Record<string, string> = {};
    for (const f of check.fields) {
      const key = typeof f.ui === 'string' ? f.ui : f.ui?.key;
      if (!key) continue;
      const v = ctx.ledger.get(key);
      if (v !== undefined && v !== null) ui[key] = String(v);
    }
    const mapping: ThreeWayMapping = {
      fields: check.fields,
      lines: check.lines ? { ...check.lines, dbRows: lineRows } : undefined,
      footing: check.footing,
    };
    const report = reconcileThreeWay({ ui, pdf: doc, db: dbRow }, mapping);
    await ctx.evidence.store(
      'report',
      `documents/${ctx.journey.id}-${ctx.step.id}.html`,
      renderHtml(report, { title: `Document check: ${checkName}` }),
      { journeyId: ctx.journey.id, stepId: ctx.step.id, description: `three-way document check ${checkName}` },
    );
    return { passed: report.status === 'PASS', details: report };
  };
}

/**
 * `vars:` values that are secret references (`secret://env/NAME`, e.g. a credential an importer replaced by
 * ${NAME}) are resolved through the secret stores when the engine starts, and masked like every secret.
 */
/** Variable names whose values are treated as secrets (masked in logs, reports and evidence). */
export const SECRET_VAR_NAME = /pass|pwd|secret|token|pin\b|otp|apikey|api_key|key$|credential/i;

export async function resolveVarSecrets(vars: Record<string, string>, resolveSecret: (ref: string) => Promise<string>, mask: (v: string) => void): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v !== 'string' || !v.startsWith('secret://')) {
      out[k] = v;
      // A plain value under a secret-sounding name (a --var password=..., EZTEST_VAR_password, a Studio Variables field)
      // is masked like a secret reference.
      if (typeof v === 'string' && v.length >= 3 && SECRET_VAR_NAME.test(k)) mask(v);
      continue;
    }
    try {
      out[k] = await resolveSecret(v);
    } catch (e) {
      throw new EzTestError(`vars.${k}: ${v} could not be resolved: ${(e as Error).message}`, 'SECRET_UNRESOLVED');
    }
    mask(out[k]);
  }
  return out;
}

/** The files written by healing.autoApply, in the run folder. */
export const HEAL_APPLIED_FILES = { json: 'heal-applied.json', diff: 'heal-applied.diff' } as const;

/**
 * healing.autoApply after a run: the verified heals (heal proposals) are written into the journey files that define
 * them and recorded as accepted decisions; `heal-applied.json` and `heal-applied.diff` in the run folder say what changed.
 */
async function applyHealsAfterRun(
  run: RunResult,
  journeys: Journey[],
  o: { cwd: string; config: EzTestConfig; outputDir: string; fingerprintStore?: string; decisions?: HealDecisions; logger: Logger },
): Promise<void> {
  const file = collectHealProposals(run, journeys);
  if (!file.proposals.length) return;
  const { findJourneyFiles, loadJourneysFromFile, defaultJourneyPaths, bddOptionsFrom } = await import('../cli/journeys.js');
  const where = new Map<string, string>();
  for (const f of await findJourneyFiles(defaultJourneyPaths(o.config, o.cwd), o.cwd, { code: true, features: true })) {
    try {
      for (const j of await loadJourneysFromFile(f, o.cwd, { bdd: bddOptionsFrom(o.config) })) if (!where.has(j.id)) where.set(j.id, resolve(o.cwd, f));
    } catch {
      // a file that does not parse defines no journey here
    }
  }
  const decisions = o.decisions ?? (await HealDecisions.open(healDecisionsPath(o.outputDir)));
  const store = await FingerprintStore.open(o.fingerprintStore ?? defaultFingerprintStorePath(o.outputDir));
  const r = await autoApplyHeals({ proposals: file.proposals, locate: (id) => where.get(id), cwd: o.cwd, minConfidence: o.config.healing.minConfidence, decisions, store, runId: run.runId });
  const runDir = join(o.outputDir, run.runId);
  const { writeFile: write } = await import('node:fs/promises');
  await write(join(runDir, HEAL_APPLIED_FILES.json), JSON.stringify({ runId: run.runId, applied: r.applied, skipped: r.skipped, files: r.files }, null, 2));
  if (r.diff) await write(join(runDir, HEAL_APPLIED_FILES.diff), r.diff);
  if (r.applied.length) {
    await decisions.save();
    await store.save();
  }
  o.logger.info('healing.autoApply', { runId: run.runId, applied: r.applied.length, skipped: r.skipped.length, files: r.files });
}

/** `.eztest/heal-decisions.json` next to the fingerprint store for an output directory. */
export function healDecisionsPath(outputDir: string): string {
  return join(dirname(resolve(outputDir)), '.eztest', 'heal-decisions.json');
}

/** Resolve "Run journey <ref>" and hook references that name a file (relative to the project or journeys dir). */
export function journeyFileResolver(cwd: string, journeysDir: string): (ref: string) => Promise<Journey | undefined> {
  return async (ref) => {
    const bases = [cwd, resolvePath(cwd, journeysDir)];
    const names = /\.(?:ez|ya?ml|json)$/i.test(ref) ? [ref] : [ref, `${ref}.ez`, `${ref}.yaml`, `${ref}.yml`, `${ref}.json`];
    for (const b of bases) {
      for (const n of names) {
        const p = resolvePath(b, n);
        if (existsSync(p) && statSync(p).isFile()) return loadJourneyFile(p);
      }
    }
    return undefined;
  };
}

/** Hook journeys named in config (`hooks.beforeAll` ...), by id, name or file. */
export async function hooksFromConfig(config: EzTestConfig, pool: Journey[], resolve?: (ref: string) => Promise<Journey | undefined>): Promise<RunHooks | undefined> {
  const h = config.hooks;
  if (!h.beforeAll.length && !h.afterAll.length && !h.beforeEach.length && !h.afterEach.length) return undefined;
  const find = async (ref: string): Promise<Journey> => {
    const hit = pool.find((j) => j.id === ref || j.name === ref) ?? (await resolve?.(ref));
    if (!hit) throw new EzTestError(`hooks: no journey "${ref}" (give an id, a name or a file path)`, 'CONFIG');
    return hit;
  };
  const all = async (refs: string[]) => Promise.all(refs.map(find));
  return { beforeAll: await all(h.beforeAll), afterAll: await all(h.afterAll), beforeEach: await all(h.beforeEach), afterEach: await all(h.afterEach) };
}

/**
 * Separate `Setup:` / `Teardown:` journeys (tagged setup / teardown) from the tests: they become beforeAll /
 * afterAll hooks, after the config's own hooks (setup) and before them (teardown).
 */
export function splitSetupJourneys(journeys: Journey[], configHooks?: RunHooks, extra?: RunHooks): { journeys: Journey[]; hooks?: RunHooks } {
  const setup = journeys.filter((j) => j.tags.includes('setup'));
  const teardown = journeys.filter((j) => j.tags.includes('teardown') && !j.tags.includes('setup'));
  const tests = journeys.filter((j) => !setup.includes(j) && !teardown.includes(j));
  const base: RunHooks = { ...(configHooks ?? {}), ...(extra ?? {}) };
  if (!setup.length && !teardown.length) return { journeys: tests, ...(configHooks || extra ? { hooks: base } : {}) };
  const ids = (l: Journey[] | undefined) => new Set((l ?? []).map((j) => j.id));
  const before = ids(base.beforeAll);
  const after = ids(base.afterAll);
  return {
    journeys: tests,
    hooks: { ...base, beforeAll: [...(base.beforeAll ?? []), ...setup.filter((j) => !before.has(j.id))], afterAll: [...teardown.filter((j) => !after.has(j.id)), ...(base.afterAll ?? [])] },
  };
}

/** A results-server client from `server:` (token from server.token or EZTEST_SERVER_TOKEN), for the shared store. */
async function engineServerClient(config: EzTestConfig, vault: IdentityVault, masker: { add(v: string): unknown }, variables: Record<string, string | undefined> = {}): Promise<ResultsClient> {
  const s = config.server!;
  const token = await resolveServerToken(s, (ref) => vault.registry.resolve(ref), { ...process.env, ...variables });
  if (token) masker.add(token);
  return new ResultsClient({ url: s.url, token, project: s.project ?? config.project ?? 'default', timeoutMs: s.timeoutMs });
}

/** Mail and SMS providers from config. Secret references are resolved through the vault and masked. */
export async function messagingFromConfig(config: EzTestConfig, vault: IdentityVault, masker: { add(v: string): unknown }): Promise<Pick<RunOptions, 'mail' | 'sms' | 'voice'>> {
  const out: Pick<RunOptions, 'mail' | 'sms' | 'voice'> = {};
  const secret = async (v: string) => {
    if (!v.startsWith('secret://')) return v;
    const s = await vault.registry.resolve(v);
    masker.add(s);
    return s;
  };
  if (config.email?.provider === 'sink') out.mail = await new SmtpSink().start(config.email.port, config.email.host);
  if (config.sms?.provider === 'twilio') {
    out.sms = new TwilioSmsProvider({ accountSid: await secret(config.sms.accountSid), authToken: await secret(config.sms.authToken), baseUrl: config.sms.baseUrl });
  }
  if (config.voice?.provider === 'twilio') {
    const v = config.voice;
    out.voice = new TwilioVoiceProvider({
      accountSid: await secret(v.accountSid), authToken: await secret(v.authToken), ...(v.baseUrl ? { baseUrl: v.baseUrl } : {}), ...(v.from ? { from: v.from } : {}),
      allowedNumbers: v.allowedNumbers, ...(v.transcripts ? { fixtures: await loadTranscriptFixtures(v.transcripts) } : {}),
    });
  }
  return out;
}

export async function createEngine(loaded: LoadedConfig, opts: EngineOptions & { addons?: Omit<Addons, 'off'> } = {}): Promise<Engine> {
  const cwd = opts.cwd ?? process.cwd();
  const logger = opts.logger ?? silentLogger;
  const config = loaded.config;
  // secret://env/NAME resolves from the real environment and the loaded .env files (.env.<project>.<env> ...).
  const vault = identityVaultFromConfig(config, { cwd, masker: loaded.masker, logger, env: { ...process.env, ...loaded.variables } });
  const dbs = dbRegistryFromConfig(config, vault);
  let catalogue: Promise<QueryCatalogue> | undefined;
  const queries = () => (catalogue ??= QueryCatalogue.fromConfig(config.db.queries, cwd));

  const db: DbHandler = {
    query: async (connection, sql, params) => (await dbs.get(connection)).query(sql, params ?? []),
    // Placeholders for ${var} parameters follow the connection's dialect (?, $n, @pn, :n).
    dialect: async (connection) => (await dbs.get(connection)).dialect,
    namedQuery: async (name, connection, call) => {
      const cat = await queries();
      const conn = connection || cat.get(name).connection;
      if (!conn) throw new EzTestError(`Query "${name}" has no connection: add "on <alias>" to the step or "-- connection: <alias>" to the query file`, 'QUERY_CONNECTION');
      const client = await dbs.get(conn);
      const c = cat.compile(name, call, client.dialect);
      return { connection: conn, sql: c.sql, params: c.params };
    },
    callProcedure: async (connection, name, params, out) => {
      const client = await dbs.get(connection);
      if (client.dialect !== 'oracle') throw new EzTestError(`OUT parameters are supported on Oracle connections; "${connection}" is ${client.dialect}`, 'NOT_SUPPORTED');
      return (client as OracleDbClient).callProcedure(name, params, out as Parameters<OracleDbClient['callProcedure']>[2]);
    },
  };

  let fabric: DataFabric | undefined;
  const leases = new LeaseRegistry({ dir: resolvePath(cwd, config.data.leaseDir), ttlMs: config.data.leaseTtlSeconds * 1000 });
  // Created records are journaled so a crashed run's data is removed by the next run's orphan sweep.
  const cleanupDir = resolvePath(cwd, '.eztest/cleanup');
  const ensureFabric = async (): Promise<DataFabric> => {
    fabric ??= new DataFabric({ providers: await buildProviders(config, dbs, vault), leases, logger, journal: new CleanupJournal(cleanupDir) });
    return fabric;
  };
  const data: DataHandler = async (need: DataNeed, _ctx: StepContext) => (await (await ensureFabric()).resolve(need)).record;

  const hasRoles = Object.keys(config.identity.roles).length > 0;
  // Authentication at scale: account pools (one leased account per journey), sessions refreshed before
  // they expire, lockout protection, and re-login after a mid-journey session expiry.
  const pooled = hasRoles
    ? createPooledLogin({
      vault,
      pool: Object.keys(config.identity.pools).length ? new AccountPool({ pools: config.identity.pools, leases, environment: config.environment }) : undefined,
      guard: new LockoutGuard(resolvePath(cwd, '.eztest/lockout.json'), {
        maxFailures: config.identity.lockout.maxFailures, windowMs: config.identity.lockout.windowMinutes * 60_000, backoffMs: config.identity.lockout.backoffMs, logger,
      }),
      maxAgeMs: config.identity.sessionMaxAgeMinutes * 60_000,
      refreshMarginMs: config.identity.sessionRefreshMarginMinutes * 60_000,
      logger,
    })
    : undefined;
  const rel = config.reliability;
  const loginPaths = Object.values(config.identity.roles).map((r) => {
    if (!r.loginUrl) return undefined; // API-only role
    try {
      return new URL(r.loginUrl, config.baseUrl ?? 'http://localhost').pathname;
    } catch {
      return undefined;
    }
  }).filter((x): x is string => !!x && x !== '/');
  // Login recipes from plugins take the roles they claim; every other role uses the Identity Vault.
  const hasRecipes = registries.loginRecipes.list().length > 0;
  const login: RunOptions['login'] = hasRecipes
    ? async (page, role, ctx) => (pluginLoginRecipe(role)?.login ?? pooled?.login ?? vault.login)(page, role, ctx)
    : pooled?.login ?? (hasRoles ? vault.login : undefined);
  const outputDir = resolvePath(cwd, config.outputDir);
  // Business-day functions (addBusinessDays, ...) use the configured holiday calendar.
  setBusinessCalendar({ holidays: await loadHolidays(config.dates.holidays, cwd), weekend: config.dates.weekend });
  const clientCertificates = config.api.clientCertificates.length
    ? await resolveClientCertificates(config.api.clientCertificates, { cwd, registry: vault.registry })
    : undefined;
  // Reviewer decisions from the Studio's heal inbox: rejected heals are never re-applied.
  const decisions = config.healing.enabled ? await HealDecisions.open(healDecisionsPath(outputDir)) : undefined;
  // Messaging, gRPC, files/SSH, batch, EDI and contract steps; api.spec validation of every API step.
  const integration = await integrationFromConfig(config, {
    cwd, resolveSecret: (ref) => vault.registry.resolve(ref), masker: loaded.masker,
    ...(hasRoles ? { apiAuth: async (role: string) => ({ authorization: `Bearer ${await vault.apiToken(role)}` }) } : {}),
    ...(config.templates.syntax !== 'dollar' ? { templateSyntax: config.templates.syntax } : {}),
  });
  // Cross-browser matrix and remote endpoints (browser.connect); secret:// values resolved and masked.
  const browserOpts = await browserRunOptions(config, (ref) => vault.registry.resolve(ref), (v) => loaded.masker.add(v));
  // Shared test data: the store and data pools (local files, or the results server when configured).
  const serverClient = opts.serverClient ?? (config.server?.url ? await engineServerClient(config, vault, loaded.masker, loaded.variables) : undefined);
  const store = await storeFromConfig(config, {
    cwd, client: serverClient, resolveSecret: (ref) => vault.registry.resolve(ref), addSecret: (v) => loaded.masker.add(v), env: { ...loaded.variables, ...process.env }, logger,
  });
  const runOptions: RunOptions = {
    baseUrl: config.baseUrl,
    browser: config.browser,
    ...(config.channel ? { channel: config.channel } : {}),
    ...browserOpts,
    headless: config.headless,
    ...(config.video !== 'off' ? { video: config.video } : {}),
    ...(config.trace.browser !== 'off' ? { traceMode: config.trace.browser } : {}),
    ...(config.screenshots ? { screenshots: config.screenshots } : {}),
    ...(config.waits.loaders.length ? { loaders: { selectors: config.waits.loaders, timeoutMs: config.waits.loaderTimeoutMs } } : {}),
    ...(clientCertificates ? { clientCertificates } : {}),
    ...(config.templates.syntax !== 'dollar' ? { templateSyntax: config.templates.syntax } : {}),
    queriesDir: resolvePath(cwd, config.db.queries?.dir ?? 'queries'),
    ...(await loadElementRepository(cwd, config.elements, logger)),
    ...(Object.keys(config.vars).length ? { variables: await resolveVarSecrets(config.vars, (ref) => vault.registry.resolve(ref), (v) => loaded.masker.add(v)) } : {}),
    outputDir,
    concurrency: config.concurrency,
    retries: config.retries,
    stepTimeoutMs: config.timeouts.step,
    logger,
    healer: config.healing.enabled
      ? createHealer({ enabled: true, maxTier: config.healing.maxTier, minConfidence: config.healing.minConfidence, requireVerification: config.healing.requireVerification }, { decisions })
      : undefined,
    login,
    relogin: pooled?.relogin,
    // Pooled accounts are released and shared-store pool claims settled (consumed on pass, released on failure) per attempt.
    lifecycle: {
      journeyEnd: async (j, r) => {
        try {
          await pooled?.journeyEnd(j, r);
        } finally {
          await store.journeyEnd(j, r);
        }
      },
    },
    store,
    // Reliability (docs/reliability.md).
    reliability: { actionability: rel.actionability, appIdle: rel.appIdle, verifyFill: rel.verifyFill, reresolve: rel.reresolve, ...(rel.slowMo ? { slowMo: rel.slowMo } : {}) },
    circuitBreaker: rel.circuitBreaker,
    ...(rel.sessionExpiry ? { sessionExpiry: { ...rel.sessionExpiry, urls: [...rel.sessionExpiry.urls, ...loginPaths] } } : {}),
    ...(rel.reuseContext ? { reuseContext: true } : {}),
    ...(rel.recycleBrowserAfter !== undefined ? { recycleBrowserAfter: rel.recycleBrowserAfter } : {}),
    suggestLocators: rel.suggestLocators,
    ...(config.healthChecks.length ? { healthChecks: config.healthChecks } : {}),
    ...(config.timezone ? { timezone: config.timezone } : {}),
    ...(config.locale ? { locale: config.locale } : {}),
    apiAuth: hasRoles ? async (role) => ({ authorization: `Bearer ${await vault.apiToken(role)}` }) : undefined,
    db,
    data,
    compareDocument: documentCheckHandler(config, dbs, cwd),
    lenses: lensesFromConfig(config.lenses, cwd, { branchBaselines: config.vcs.branchScope.baselines, defaultBranch: config.vcs.branchScope.defaultBranch, a11y: a11yLensOptions(config) }),
    lensFactory: (spec: string) => lensesFromConfig([spec], cwd, { branchBaselines: config.vcs.branchScope.baselines, defaultBranch: config.vcs.branchScope.defaultBranch, a11y: a11yLensOptions(config) })[0],
    // Advanced engine: masking of captured text, page-script opt-in, dialog policy, file base, journey refs.
    mask: (s: string) => loaded.masker.mask(s),
    allowPageScripts: config.security.allowPageScripts,
    dialogs: config.dialogs,
    baseDir: cwd,
    resolveJourney: journeyFileResolver(cwd, config.journeysDir),
    // `Examples: from query "NAME" on <alias>`: rows from the named-query catalogue (data files are read by the runner).
    dataSourceResolver: async (src) =>
      src.query !== undefined
        ? resolveQueryExamples(src.query, src.connection, src.params ?? {}, { catalogue: await queries(), open: (n) => dbs.get(n), vars: opts.runOptions?.variables })
        : undefined,
    ...(await messagingFromConfig(config, vault, loaded.masker)),
    // Native mobile (Platform: android | ios journeys) through EZTest's device agents.
    ...(config.mobile
      ? mobileRunOptions(config.mobile, { mask: (s) => loaded.masker.mask(s), baseDir: cwd })
      : {}),
    ...(config.trace.timeTravel.enabled ? { timeTravel: { ...config.trace.timeTravel, masker: loaded.masker } } : {}),
    integration: integration.runtime,
    ...(integration.apiHook ? { apiHook: integration.apiHook } : {}),
    ...(integration.specs[0] ? { apiSpec: integration.specs[0] } : {}),
    ...(registries.steps.names().length ? { customSteps: pluginSteps() } : {}),
    // Process workers (docs/scale.md): each worker builds these handlers from the same resolved configuration.
    // The email sink is one SMTP listener whose mailbox the steps read: runs with it stay in one process.
    ...(config.workers ? { workers: config.workers } : {}),
    ...(config.email?.provider === 'sink' ? {} : {
      workerSetup: {
        module: siblingModule(import.meta.url, 'worker-setup'), export: 'setupEngineWorker',
        args: { cwd, config, variables: loaded.variables, ...(loaded.env ? { env: loaded.env } : {}), ...(loaded.project ? { project: loaded.project } : {}), ...(opts.pipeline ? { pipeline: opts.pipeline } : {}), ...(opts.runOptions?.baseUrlOverride ? { baseUrlOverride: opts.runOptions.baseUrlOverride } : {}), ...(opts.worker ?? {}) },
      },
    }),
    addSecret: (v: string) => void loaded.masker.add(v),
    knownSecrets: () => loaded.masker.secrets(),
    ...opts.runOptions,
  };
  // "Expect <element|the page> to look like the baseline": visual assertions with modes, keyed and branched baselines.
  runOptions.customSteps = {
    // "Call SOAP operation ... on <service>": WSDL services with validation, WS-Security and MTOM (docs/soap.md).
    [SOAP_STEP]: createSoapStepHandler(config.soap, { baseDir: cwd, resolveSecret: (ref) => vault.registry.resolve(ref), addSecret: (v) => loaded.masker.add(v) }),
    [VISUAL_STEP]: createVisualStepHandler({ baselineDir: resolvePath(cwd, '.eztest/baselines'), branch: currentBranch(cwd), update: () => process.env.EZTEST_UPDATE_BASELINES === '1' }),
    // "Check accessibility": EZTest's accessibility engine, static and dynamic checks.
    [A11Y_STEP]: createA11yStepHandler(),
    // "Expect the page to be keyboard operable": Tab through, traps, unreachable elements, focus visibility.
    [KEYBOARD_STEP]: createKeyboardStepHandler(),
    ...(runOptions.customSteps ?? {}),
  };
  for (const addon of [opts.addons?.d365, opts.addons?.salesforce, opts.addons?.apps]) {
    if (addon) runOptions.customSteps = { ...addon.customSteps, ...(runOptions.customSteps ?? {}) };
  }
  // Desktop and legacy driver ladder (Electron, Windows/Java agents, SAP GUI, TN3270, image/OCR); docs/desktop-and-legacy.md.
  const desktop = createDesktopIntegration(
    { desktop: config.desktop, mainframe: config.mainframe, citrix: config.citrix },
    { resolveSecret: (ref) => vault.registry.resolve(ref), addSecret: (v) => loaded.masker.add(v), baseDir: cwd },
  );
  runOptions.stepInterceptors = [desktop.interceptor, ...(runOptions.stepInterceptors ?? [])];
  const stopMail = runOptions.mail instanceof SmtpSink ? runOptions.mail : undefined;

  return {
    config,
    vault,
    dbs,
    queries,
    queryExamples: async (name, alias, params) =>
      resolveQueryExamples(name, alias, params, { catalogue: await queries(), open: (n) => dbs.get(n), vars: runOptions.variables }),
    runOptions,
    async run(journeys) {
      // Orphan sweep: delete test data that crashed runs created and never removed.
      if (rel.orphanSweep && Object.keys(config.data.entities).length && existsSync(cleanupDir)) {
        await (await ensureFabric()).sweepOrphans(cleanupDir).catch((e: Error) => logger.warn('orphan sweep failed', { message: e.message }));
      }
      const configHooks = await hooksFromConfig(config, [...(runOptions.library ?? []), ...journeys], runOptions.resolveJourney);
      // `Setup:` / `Teardown:` journeys run once, before / after all others; a setup's Returns: become run-wide values.
      const { journeys: tests, hooks } = splitSetupJourneys(journeys, configHooks, runOptions.hooks);
      if (!tests.length) throw new EzTestError('Only Setup:/Teardown: journeys were selected; there is nothing to run between them', 'NO_JOURNEYS');
      let run: RunResult;
      try {
        run = await runJourneys(tests, hooks ? { ...runOptions, hooks } : runOptions);
      } finally {
        await store.releaseOutstanding().catch((e: Error) => logger.warn('pool claims not released', { message: e.message }));
      }
      // Values saved "for the pipeline": store-export.json and the CI's output variables.
      if (config.store.pipelineOutputs) {
        await store.finish({ runDir: join(runOptions.outputDir, run.runId), outputDir: runOptions.outputDir, runId: run.runId, pipeline: opts.pipeline, out: opts.pipelineOut ?? ((l) => process.stdout.write(l + '\n')) })
          .catch((e: Error) => logger.warn(`pipeline outputs not written: ${e.message}`));
      }
      // API coverage against api.spec, recorded next to the run (report, Studio and the apiCoverage gate read it).
      if (integration.specs.length && run.journeys.length) {
        await recordApiCoverage(join(runOptions.outputDir, run.runId), integration.specEntries).catch((e: Error) => logger.warn(`API coverage not recorded: ${e.message}`));
      }
      // healing.autoApply: verified heals are written back into the journey files (with a diff in the run folder).
      if (config.healing.enabled && config.healing.autoApply) {
        await applyHealsAfterRun(run, tests, { cwd, config, outputDir: runOptions.outputDir, fingerprintStore: runOptions.fingerprintStore, decisions, logger })
          .catch((e: Error) => logger.warn(`healing.autoApply failed: ${e.message}`));
      }
      return run;
    },
    store,
    async close() {
      if (fabric) await fabric.release();
      await stopMail?.stop();
      await integration.runtime.close();
      await dbs.closeAll();
    },
  };
}

/** Load config-derived handlers, run, and always release data and connections. */
export async function runWithConfig(loaded: LoadedConfig, journeys: Journey[], opts: EngineOptions = {}): Promise<RunResult> {
  const engine = await createEngine(loaded, opts);
  try {
    return await engine.run(journeys);
  } finally {
    await engine.close();
  }
}
export * from './analyze.js';
export { browserRunOptions, remoteConnectFromConfig } from './browsers.js';

export { resolveServerToken } from './server-token.js';
