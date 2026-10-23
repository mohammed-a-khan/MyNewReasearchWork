/** Runner options and the injectable handler contracts. */
import type { BrowserContext, Page } from '../browser/index.js';
import type { ApiCall, DataNeed, DbQuery, EventBus, Journey, Logger, Step } from '../core/index.js';
import type { Healer } from '../heal/types.js';
import type { DebugController } from './debug/controller.js';
import type { EvidenceWriter } from './evidence.js';
import type { TimeTravelOptions } from './trace/types.js';
import type { Ledger } from './ledger.js';
import type { DialogPolicy } from './dialogs.js';
import type { BrowserSession } from './session.js';
import type { MailProvider, SmsProvider } from '../messaging/types.js';
import type { VoiceProvider } from '../messaging/voice.js';

/** Everything a handler may need about the step being executed. */
export interface StepContext {
  runId: string;
  runDir: string;
  journey: Journey;
  step: Step;
  page: Page;
  context: BrowserContext;
  ledger: Ledger;
  attempt: number;
  baseUrl?: string;
  logger: Logger;
  evidence: EvidenceWriter;
  /** Current interpolation variables (journey < run < ledger). */
  vars(): Record<string, unknown>;
  /** Interpolate ${var} placeholders with `vars()`. */
  interpolate(s: string): string;
  /** Tabs, frames, dialogs and recorded browser events of this journey attempt (set by the runner). */
  session?: BrowserSession;
  /**
   * Set by platform drivers (native apps): the platform name and the driver's session object
   * (for the mobile driver, the DeviceSession), so custom steps can drive the device. `page` is
   * then a stand-in that throws when used.
   */
  platform?: { name: string; session: unknown };
  /** Multi-actor journeys: the actor whose context `page`, `context` and `session` belong to (docs/multi-actor.md). */
  actor?: string;
  /** Id of the top-level journey of this attempt (sub-journeys and hooks run inside it); set by the web runner. */
  rootJourneyId?: string;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** Signs a browser session in as `role` (e.g. via the Identity Vault). */
export type LoginHandler = (page: Page, role: string, ctx: StepContext) => Promise<void>;
/** Performs an API call. Default: global fetch with baseUrl resolution. */
export type ApiHandler = (call: ApiCall, ctx: StepContext) => Promise<ApiResponse>;
/** Provides auth headers for API calls made `asRole`. */
export type ApiAuthProvider = (role: string, ctx: StepContext) => Promise<Record<string, string>>;
/** Values bound to a statement (never spliced into SQL). */
export type DbQueryParams = DbQuery['params'];
export type DbDialectName = 'sqlite' | 'postgres' | 'mssql' | 'oracle';
export interface DbHandler {
  query(connection: string, sql: string, params: DbQueryParams): Promise<Array<Record<string, unknown>>>;
  /** SQL dialect of a connection, used to emit the right placeholders (default sqlite-style "?"). */
  dialect?(connection: string): Promise<DbDialectName> | DbDialectName;
  /**
   * Compile a named catalogue query (db.queries) for a connection ('' = the
   * query's header connection): dialect placeholders plus bound values.
   */
  namedQuery?(name: string, connection: string, call: { binds?: Record<string, string | number | boolean | null>; params?: Array<string | number | boolean | null> }): Promise<{ connection: string; sql: string; params: unknown[] }>;
  /** Call a stored procedure with OUT parameters; returns the OUT values by name. */
  callProcedure?(connection: string, name: string, params: Array<string | number | boolean | null>, out: Array<{ name: string; type: string }>): Promise<Record<string, unknown>>;
}
/** Finds or creates test data for a data need; the record lands in the ledger under `need.as`. */
export type DataHandler = (need: DataNeed, ctx: StepContext) => Promise<Record<string, unknown>>;
export type CompareDocumentHandler = (args: Record<string, unknown>, ctx: StepContext) => Promise<{ passed: boolean; details: unknown }>;
/** A registered custom step; a returned record is merged into the ledger. */
export type CustomStepHandler = (page: Page, step: Step, ctx: StepContext) => Promise<Record<string, unknown> | void>;

export interface LensFinding {
  /** Filled in by the runner when omitted. */
  lens?: string;
  /** "error" findings fail the step; others are recorded as evidence only. */
  severity: 'info' | 'warning' | 'error';
  message: string;
  details?: unknown;
}

export interface Lens {
  name: string;
  afterStep?(page: Page, step: Step, ctx: StepContext): Promise<LensFinding[]>;
}

/** before-assertions: on failure, plus a screenshot before every assertion / post-condition check. */
export type ScreenshotPolicy = 'every-step' | 'on-failure' | 'off' | 'before-assertions';

/** A resolved TLS client certificate (file contents loaded, passphrase resolved). */
export interface ClientCertificate {
  name?: string;
  /** e.g. https://api.example.com (port optional). */
  origin: string;
  pfx?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  passphrase?: string;
  ca?: Buffer;
  /** Present it from the browser too (default true). */
  browser?: boolean;
}

/**
 * One browser of a run: a name (chromium, chrome, msedge, firefox, ...; channels are Chromium builds)
 * or a full entry with an executable or a remote endpoint (see src/runner/browsers.ts).
 */
export type BrowserTarget = string | {
  /** chromium, chrome, chrome-beta, msedge, msedge-beta, ..., firefox (webkit is not supported). */
  name: string;
  /** Explicit executable for this browser. */
  executablePath?: string;
  /** Attach to a running browser instead of launching one. */
  connect?: RemoteBrowserConnect;
};

/**
 * Attach to a running browser over its own protocol (never another test tool's wire protocol):
 * a Chrome/Edge DevTools endpoint, or a Firefox WebDriver BiDi WebSocket. Values are resolved
 * (secret:// references already turned into text by the engine).
 */
export interface RemoteBrowserConnect {
  /** Chrome / Edge / Chromium DevTools: ws://host:port/devtools/browser/<id>, or http(s)://host:port (resolved via /json/version). */
  cdpEndpoint?: string;
  /** Firefox WebDriver BiDi: ws://host:port (the /session path is added when missing) or a full ws(s):// URL. */
  bidiEndpoint?: string;
  /** Extra headers on the HTTP discovery request and the WebSocket handshake (e.g. a vendor's auth token). */
  headers?: Record<string, string>;
  /** Connect timeout. Default 30 s. */
  timeoutMs?: number;
}

export interface RunOptions {
  baseUrl?: string;
  browser?: 'chromium' | 'firefox' | 'webkit';
  /**
   * Cross-browser run (docs/browser-driver.md): every journey runs once per browser, as journey x
   * browser units whose ids end in `@<browser>`. Overrides `browser`/`channel` when it has entries.
   */
  browsers?: BrowserTarget[];
  /** Attach to a running browser (single-browser runs; for a matrix give each entry its own `connect`). */
  connect?: RemoteBrowserConnect;
  headless?: boolean;
  /** Explicit browser executable (otherwise the browser EZTest finds: EZTEST_CHROMIUM_PATH, the install-browsers cache, an installed Chrome/Edge). */
  executablePath?: string;
  /** The run directory is `<outputDir>/<runId>`. */
  outputDir: string;
  /** Override the generated run id. */
  runId?: string;
  /** Journeys run in parallel, each in its own BrowserContext. Default 1. */
  concurrency?: number;
  /** Journey-level retries. Default 0. */
  retries?: number;
  /** Per-action timeout. Default 10000. */
  stepTimeoutMs?: number;
  /** How long to poll for a target to resolve before healing. Default min(stepTimeoutMs, 5000). */
  locateTimeoutMs?: number;
  /** How long post-conditions are polled. Default 5000. */
  conditionTimeoutMs?: number;
  /** Default "on-failure". */
  screenshots?: ScreenshotPolicy;
  /** Record a browser trace zip per journey attempt (true = always kept). */
  trace?: boolean;
  /** Trace retention when `trace` is not set: keep only attempts that did not pass. */
  traceMode?: 'off' | 'on' | 'on-failure' | 'retain-on-failure';
  /** Video per journey attempt: on, or retain-on-failure (deleted when the attempt passed). Default off. */
  video?: 'off' | 'on' | 'retain-on-failure';
  /** Browser channel (msedge, chrome, ...) for chromium. */
  channel?: string;
  /** Loader/spinner selectors waited out before every action and post-condition (plus each journey's Loaders: header). */
  loaders?: { selectors: string[]; timeoutMs?: number };
  /** TLS client certificates for API calls (matched by origin or by name) and the browser context. */
  clientCertificates?: ClientCertificate[];
  /** API body template syntax (config templates.syntax). Default 'dollar'. */
  templateSyntax?: 'dollar' | 'mustache';
  /** Directory of the named query catalogue (config db.queries.dir). Default <baseDir>/queries. */
  queriesDir?: string;
  /** EZTest time-travel trace (DOM snapshots, network, console, action metadata per step). Off unless enabled. */
  timeTravel?: TimeTravelOptions;
  /** Live step debugger; forces concurrency 1. */
  debug?: DebugController;
  variables?: Record<string, string>;
  events?: EventBus;
  logger?: Logger;
  healer?: Healer;
  /** Shared element repository (src/elements): targets naming an element (or its description) take its locators. */
  elements?: import('../elements/repository.js').ElementRepository;
  /** Fingerprint store path. Default `<parent of outputDir>/.eztest/fingerprints.json`. */
  fingerprintStore?: string;
  viewport?: { width: number; height: number };
  login?: LoginHandler;
  api?: ApiHandler;
  apiAuth?: ApiAuthProvider;
  db?: DbHandler;
  data?: DataHandler;
  compareDocument?: CompareDocumentHandler;
  customSteps?: Record<string, CustomStepHandler>;
  lenses?: Lens[];
  /** Masks secrets in captured text (dialogs, cookies, storage, network, evidence). The engine passes the config masker. */
  mask?: (text: string) => string;
  /** Default handling of dialogs nobody armed for. */
  dialogs?: DialogPolicy;
  /** Allow "Run script"/"Run JavaScript" steps to execute in the browser page (config security.allowPageScripts). Default false. */
  allowPageScripts?: boolean;
  /** Directory relative file paths (uploads, scripts, data files, mocks, schemas) resolve against. Default process.cwd(). */
  baseDir?: string;
  /** Journeys callable with "Run journey" (by id, name or file). */
  library?: Journey[];
  /**
   * Rows for external Examples sources (`Examples: from query "NAME" on conn`, or any `from data` source
   * it chooses to serve). Return undefined to fall back to the built-in data-file reader.
   */
  dataSourceResolver?: import('./examples-source.js').DataSourceResolver;
  /** Resolve a "Run journey" reference that is not in the library (e.g. a file path). */
  resolveJourney?: (ref: string) => Promise<Journey | undefined>;
  /** Hook journeys: before/after all journeys, and before/after each journey (inside its browser context). */
  hooks?: RunHooks;
  /** Mailbox for "Get the latest email ..." steps. */
  mail?: MailProvider;
  /** SMS inbox for "Get the latest SMS ..." steps. */
  sms?: SmsProvider;
  /** Phone calls for "Place a call ..." / "Wait for a call ..." steps. */
  voice?: VoiceProvider;
  /** Component/story harness: a journey with a `Story:` header opens its story here before the first step. */
  storyHarness?: { urlFor(storyId: string, args?: Record<string, unknown>): string };
  /** Safety cap for While loops without an explicit max. Default 100. */
  maxLoopIterations?: number;
  /** Cancels the run. Checked between journeys and between steps (also inside blocks and loops); what has not run is recorded as skipped. */
  signal?: AbortSignal;
  /** Non-browser surfaces (desktop, terminal, SAP GUI, screen images) that may execute steps first (see runner/surface.ts). */
  stepInterceptors?: import('./surface.js').StepInterceptor[];
  /** Observes every API step's exchange (spec validation, contract recording); may throw to fail the step. Returns evidence ids. */
  apiHook?: ApiExchangeHook;
  /** Messaging, gRPC, files/SSH, batch, EDI and contract sessions for `integration` steps (built from config by the engine). */
  integration?: import('../integration/types.js').IntegrationRuntime;
  /** The configured OpenAPI/Swagger spec (absolute path) used by "conforms to the API spec" expectations. */
  apiSpec?: string;
  // ------------------------------------------------------------ reliability (docs/reliability.md)
  /** Actionability, app idle, re-render safety and slowMo (debugging only). */
  reliability?: import('./reliability/guard.js').ReliabilityOptions;
  /** Pre-flight environment checks: when one fails nothing runs and the run is an environment problem. */
  healthChecks?: import('./reliability/health.js').HealthCheck[];
  /** Stop the run when the environment goes down mid-run (default on, 3 consecutive environment failures). */
  circuitBreaker?: { enabled?: boolean; threshold?: number };
  /** Detect "session expired" mid-journey and re-login once (recorded in evidence). */
  sessionExpiry?: import('./reliability/session-expiry.js').SessionExpiryOptions;
  /** Clear the cached session of a role and sign in again (used after a mid-journey session expiry). Default: `login`. */
  relogin?: LoginHandler;
  /** Called when a journey attempt starts and ends (e.g. release a pooled account, flush a cleanup journal). */
  lifecycle?: {
    journeyStart?(journey: Journey, attempt: number): Promise<void> | void;
    journeyEnd?(journey: Journey, result: import('../core/index.js').JourneyResult): Promise<void> | void;
  };
  /** Reuse one browser context per worker and reset its state between journeys (opt-in, for speed). */
  reuseContext?: boolean;
  /** Fingerprint capture: every passing step (default), or only steps that have none yet ("missing", used by --fast). */
  fingerprints?: 'always' | 'missing';
  /** Store console/network logs as evidence for passing journeys too (default true; --fast keeps them only on failure). */
  passingLogs?: boolean;
  /** Propose verified, more robust locators for weak targets (heal inbox "improvement"). Default true. */
  suggestLocators?: boolean;
  /** Failure diagnosis with "did you mean", highlighted screenshot, console and network errors. Default true. */
  diagnose?: boolean;
  /** IANA time zone pinned for the browser (journeys can still override) and for expression date functions. */
  timezone?: string;
  /** Default locale for the browser and locale-aware assertions. */
  locale?: string;
  /** Default platform for journeys without a `Platform:` header. Default 'web'. */
  platform?: import('./platform.js').PlatformName;
  /** Drivers for non-web platforms (e.g. the mobile driver from eztest/mobile); checked before registered drivers. */
  platformDrivers?: import('./platform.js').PlatformDriver[];
  /** Resource locks (`Locks:` / `locks:`): a journey starts only once it holds all of its lock keys (see src/scale/locks.ts). */
  locks?: RunLocks;
  /** inline (default): retry a failed journey at once; isolated: retry failures after the main pass, one at a time. */
  retryStrategy?: 'inline' | 'isolated';
  /**
   * Verdicts for `Manual:` steps (Studio's guided runner, `eztest run --manual prompt`). Without one,
   * manual steps are recorded as not executed (docs/manual-testing.md).
   */
  manual?: import('./manual.js').ManualVerdictProvider;
  /** Shared test data store and data pools (`Save ... to the shared store`, `Take one item from pool ...`); see docs/shared-data.md. */
  store?: import('../store/types.js').StoreStepRuntime;
}

/** Lock coordination hook used by the runner's scheduler. */
export interface RunLocks {
  /** Acquire all of the journey's lock keys, or none: a release function, or undefined when a key is busy. */
  tryAcquire(journey: Journey): Promise<(() => Promise<void>) | undefined>;
  /** Give up on a journey whose locks stay busy this long (it is recorded as an error). Default 30 min. */
  timeoutMs?: number;
  /** Retry interval while every pending journey is blocked. Default 250 ms. */
  pollMs?: number;
  /** Human description of who holds the journey's keys (for the timeout message). */
  describeHolders?(journey: Journey): Promise<string>;
}

/** One API step's request and response, as the runner sent and received them. */
export interface ApiExchange {
  call: ApiCall;
  /** Absolute URL that was called. */
  url: string;
  response: ApiResponse & { durationMs: number };
  step: Step;
}
export type ApiExchangeHook = (x: ApiExchange, ctx: StepContext) => Promise<string[] | void>;

export interface RunHooks {
  beforeAll?: Journey[];
  afterAll?: Journey[];
  beforeEach?: Journey[];
  afterEach?: Journey[];
}
