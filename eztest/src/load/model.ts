/**
 * The EZTest Load scenario model: user paths (virtual-user scripts),
 * populations, load profiles, data sets, correlation rules, SLAs and
 * monitors, as one YAML/JSON document validated here.
 *
 *   name: Checkout
 *   baseUrl: http://shop.test
 *   userPaths:
 *     shopper:
 *       init: [ ... ]           # once per virtual user (e.g. sign in)
 *       actions: [ ... ]        # every iteration
 *       thinkTime: { min: 1s, max: 3s }
 *   populations:
 *     - { name: buyers, userPath: shopper, share: 80, network: { latencyMs: 60, downloadKbps: 4096 } }
 *   profile: { type: ramp, rampUp: 1m, plateau: 10m, rampDown: 30s, vus: 200 }
 *   sla: [ { match: "checkout*", p95: { warn: 500, fail: 900 }, errorRate: { fail: 0.01 } } ]
 *
 * The format is EZTest's own; nothing here reads or writes another tool's
 * script format (HAR, a browser standard, is the only import).
 */
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { EzTestError } from '../core/index.js';

// ------------------------------------------------------------------ durations

/** "250ms", "2s", "1.5m", "1h", "1m30s" or a number of milliseconds. */
export function parseDurationMs(v: unknown, what = 'duration'): number {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  if (typeof v !== 'string') throw new EzTestError(`${what}: expected a duration like "30s" (got ${JSON.stringify(v)})`, 'LOAD_SCENARIO');
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)/gy;
  let total = 0;
  let matched = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const n = Number(m[1]);
    total += m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60_000 : n * 3_600_000;
    matched = re.lastIndex;
  }
  if (!matched || matched !== s.length) throw new EzTestError(`${what}: invalid duration "${v}" (use e.g. 500ms, 30s, 5m, 1h30m)`, 'LOAD_SCENARIO');
  return total;
}

const Duration = z.union([z.number().min(0), z.string().min(1)]).transform((v, ctx) => {
  try {
    return parseDurationMs(v);
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: (e as Error).message });
    return z.NEVER;
  }
});

// ------------------------------------------------------------------ actions

export const Extractor = z.strictObject({
  /** Variable the value is stored in. */
  var: z.string().regex(/^[A-Za-z_][\w.]*$/, 'variable names are letters, digits, _ and .'),
  from: z.enum(['body', 'headers', 'header', 'cookie', 'url', 'status']).default('body'),
  /** JSON path ($.a.b[0].c) into a JSON body. */
  json: z.string().optional(),
  /** Regular expression; group 1 (or `group`) is the value. */
  regex: z.string().optional(),
  group: z.number().int().min(0).optional(),
  /** Text between two boundaries. */
  boundary: z.strictObject({ left: z.string(), right: z.string() }).optional(),
  /** Header or cookie name. */
  name: z.string().optional(),
  /** Which match: 0-based index, "random", "last" or "all" (an array). Default 0. */
  index: z.union([z.number().int().min(0), z.enum(['random', 'last', 'all'])]).optional(),
  default: z.string().optional(),
  /** Fail the request when nothing matched (default true unless a default is given). */
  required: z.boolean().optional(),
  /** Transform: url-decode or html-unescape the value. */
  decode: z.enum(['url', 'html', 'base64']).optional(),
});
export type Extractor = z.infer<typeof Extractor>;

export const Assertion = z.strictObject({
  status: z.union([z.number().int(), z.array(z.number().int())]).optional(),
  contains: z.string().optional(),
  notContains: z.string().optional(),
  regex: z.string().optional(),
  json: z.string().optional(),
  equals: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  exists: z.boolean().optional(),
  header: z.string().optional(),
  /** Response time budget for this request (ms or duration); a slower response is an error. */
  maxMs: Duration.optional(),
  minBytes: z.number().int().min(0).optional(),
  maxBytes: z.number().int().min(0).optional(),
  message: z.string().optional(),
});
export type Assertion = z.infer<typeof Assertion>;

export const ThinkTime = z.union([
  Duration,
  z.strictObject({ min: Duration, max: Duration }),
  z.strictObject({ mean: Duration, stdDev: Duration.optional(), distribution: z.enum(['normal', 'exponential']).default('normal') }),
]);
export type ThinkTimeInput = z.input<typeof ThinkTime>;
export type ThinkTime = z.infer<typeof ThinkTime>;

const Headers = z.record(z.string(), z.string());

export const HttpRequestSpec = z.strictObject({
  name: z.string().optional(),
  method: z.string().default('GET').transform((m) => m.toUpperCase()),
  url: z.string().min(1),
  headers: Headers.optional(),
  /** Raw body (templated). */
  body: z.string().optional(),
  /** JSON body (templated leaves). */
  json: z.unknown().optional(),
  /** Form fields (application/x-www-form-urlencoded). */
  form: z.record(z.string(), z.string()).optional(),
  extract: z.array(Extractor).optional(),
  assert: z.array(Assertion).optional(),
  timeoutMs: Duration.optional(),
  /** Follow redirects (default from options.followRedirects). */
  followRedirects: z.boolean().optional(),
  /** Do not keep the body beyond assertions/extraction (saves memory). */
  discardBody: z.boolean().optional(),
  /** Requests for page resources (css, js, images) fetched in parallel after this one. */
  resources: z.array(z.string()).optional(),
  /** Time to wait before this request (recorded think time). */
  thinkBefore: ThinkTime.optional(),
  /** Keep the response as a variable { status, headers, body } (body parsed when JSON), e.g. ${tok.body.access_token}. */
  captureAs: z.string().regex(/^[A-Za-z_]\w*$/).optional(),
});
export type HttpRequestSpec = z.infer<typeof HttpRequestSpec>;

export const BrowserActionSpec = z.strictObject({
  goto: z.string().optional(),
  click: z.string().optional(),
  fill: z.string().optional(),
  value: z.string().optional(),
  press: z.string().optional(),
  key: z.string().optional(),
  select: z.string().optional(),
  check: z.string().optional(),
  waitFor: z.string().optional(),
  /** Text that must be on the page afterwards. */
  expectText: z.string().optional(),
  /** URL part the page must reach. */
  expectUrl: z.string().optional(),
  /** Read text of a selector into a variable. */
  capture: z.strictObject({ selector: z.string(), var: z.string() }).optional(),
  name: z.string().optional(),
  timeoutMs: Duration.optional(),
});
export type BrowserActionSpec = z.infer<typeof BrowserActionSpec>;

export const WsActionSpec = z.strictObject({
  name: z.string().optional(),
  url: z.string().min(1),
  headers: Headers.optional(),
  send: z.array(z.string()).optional(),
  /** Text each awaited message must contain (in order). */
  expect: z.array(z.string()).optional(),
  timeoutMs: Duration.optional(),
});

export const SseActionSpec = z.strictObject({
  name: z.string().optional(),
  url: z.string().min(1),
  headers: Headers.optional(),
  /** Stop once an event's data contains this text. */
  until: z.string().optional(),
  maxEvents: z.number().int().min(1).optional(),
  timeoutMs: Duration.optional(),
  extract: z.strictObject({ var: z.string(), json: z.string().optional(), regex: z.string().optional() }).optional(),
});

export const GrpcActionSpec = z.strictObject({
  name: z.string().optional(),
  address: z.string().min(1),
  proto: z.union([z.string(), z.array(z.string())]),
  method: z.string().min(1),
  request: z.unknown().optional(),
  metadata: Headers.optional(),
  tls: z.boolean().optional(),
  expectStatus: z.string().default('OK'),
  timeoutMs: Duration.optional(),
});

export const SqlActionSpec = z.strictObject({
  name: z.string().optional(),
  /** Connection name from `connections`. */
  connection: z.string().min(1),
  sql: z.string().min(1),
  params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  /** Store the first row's columns as variables with this prefix. */
  captureAs: z.string().optional(),
  minRows: z.number().int().min(0).optional(),
});

export const MessageActionSpec = z.strictObject({
  name: z.string().optional(),
  /** Bus name from `buses`. */
  bus: z.string().min(1),
  publish: z.strictObject({ type: z.enum(['topic', 'queue', 'exchange']).default('queue'), destination: z.string(), payload: z.string(), key: z.string().optional(), routingKey: z.string().optional(), headers: Headers.optional() }).optional(),
  consume: z.strictObject({ type: z.enum(['topic', 'queue', 'exchange']).default('queue'), destination: z.string(), contains: z.string().optional(), timeoutMs: Duration.optional() }).optional(),
});

export type ActionInput =
  | { request: z.input<typeof HttpRequestSpec> | string }
  | { transaction: { name: string; actions: ActionInput[] } }
  | { think: ThinkTimeInput }
  | { pause: number | string }
  | { set: Record<string, string> }
  | { if: { cond: string; then: ActionInput[]; else?: ActionInput[] } }
  | { loop: { times?: number; while?: string; max?: number; actions: ActionInput[] } }
  | { browser: z.input<typeof BrowserActionSpec> }
  | { ws: z.input<typeof WsActionSpec> }
  | { sse: z.input<typeof SseActionSpec> }
  | { grpc: z.input<typeof GrpcActionSpec> }
  | { sql: z.input<typeof SqlActionSpec> }
  | { message: z.input<typeof MessageActionSpec> }
  | { use: string };

export type Action =
  | { kind: 'request'; spec: HttpRequestSpec }
  | { kind: 'transaction'; name: string; actions: Action[] }
  | { kind: 'think'; time: ThinkTime }
  | { kind: 'set'; vars: Record<string, string> }
  | { kind: 'if'; cond: string; then: Action[]; else: Action[] }
  | { kind: 'loop'; times?: number; while?: string; max: number; actions: Action[] }
  | { kind: 'browser'; spec: BrowserActionSpec }
  | { kind: 'ws'; spec: z.infer<typeof WsActionSpec> }
  | { kind: 'sse'; spec: z.infer<typeof SseActionSpec> }
  | { kind: 'grpc'; spec: z.infer<typeof GrpcActionSpec> }
  | { kind: 'sql'; spec: z.infer<typeof SqlActionSpec> }
  | { kind: 'message'; spec: z.infer<typeof MessageActionSpec> }
  | { kind: 'use'; dataset: string };

/** "GET /path" or "POST https://x/y" shorthand. */
function requestShorthand(s: string): z.input<typeof HttpRequestSpec> {
  const m = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(s);
  if (m) return { method: m[1], url: m[2] };
  return { method: 'GET', url: s.trim() };
}

const KINDS = ['request', 'transaction', 'think', 'pause', 'set', 'if', 'loop', 'browser', 'ws', 'sse', 'grpc', 'sql', 'message', 'use'] as const;

function issuePath(path: Array<string | number>): string {
  return path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('').replace(/^\./, '');
}

function parseSpec<T extends z.ZodTypeAny>(schema: T, v: unknown, where: string): z.infer<T> {
  const r = schema.safeParse(v);
  if (!r.success) throw new EzTestError(`${where}: ${r.error.issues.map((i) => `${issuePath(i.path as Array<string | number>) || '(value)'}: ${i.message}`).join('; ')}`, 'LOAD_SCENARIO');
  return r.data;
}

/** Validate and normalize a list of actions (recursive). */
export function parseActions(list: unknown, where: string): Action[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new EzTestError(`${where}: expected a list of actions`, 'LOAD_SCENARIO');
  return list.map((raw, i) => parseAction(raw, `${where}[${i}]`));
}

export function parseAction(raw: unknown, where: string): Action {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new EzTestError(`${where}: an action is an object with one of ${KINDS.join(', ')}`, 'LOAD_SCENARIO');
  const keys = Object.keys(raw);
  const kind = keys.find((k) => (KINDS as readonly string[]).includes(k));
  if (!kind || keys.length !== 1) throw new EzTestError(`${where}: an action has exactly one key of ${KINDS.join(', ')} (got ${keys.join(', ') || 'none'})`, 'LOAD_SCENARIO');
  const v = (raw as Record<string, unknown>)[kind];
  switch (kind) {
    case 'request':
      return { kind: 'request', spec: parseSpec(HttpRequestSpec, typeof v === 'string' ? requestShorthand(v) : v, `${where}.request`) };
    case 'transaction': {
      const t = v as { name?: unknown; actions?: unknown };
      if (!t || typeof t.name !== 'string' || !t.name) throw new EzTestError(`${where}.transaction: needs a name`, 'LOAD_SCENARIO');
      return { kind: 'transaction', name: t.name, actions: parseActions(t.actions, `${where}.transaction.actions`) };
    }
    case 'think':
    case 'pause':
      return { kind: 'think', time: parseSpec(ThinkTime, v, `${where}.${kind}`) };
    case 'set': {
      if (!v || typeof v !== 'object') throw new EzTestError(`${where}.set: expected { var: value }`, 'LOAD_SCENARIO');
      return { kind: 'set', vars: Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x)])) };
    }
    case 'if': {
      const c = v as { cond?: unknown; then?: unknown; else?: unknown };
      if (!c || typeof c.cond !== 'string') throw new EzTestError(`${where}.if: needs cond (an expression)`, 'LOAD_SCENARIO');
      return { kind: 'if', cond: c.cond, then: parseActions(c.then, `${where}.if.then`), else: parseActions(c.else, `${where}.if.else`) };
    }
    case 'loop': {
      const l = v as { times?: unknown; while?: unknown; max?: unknown; actions?: unknown };
      if (!l || (l.times === undefined && typeof l.while !== 'string')) throw new EzTestError(`${where}.loop: needs times or while`, 'LOAD_SCENARIO');
      const times = l.times === undefined ? undefined : Number(l.times);
      if (times !== undefined && !(Number.isInteger(times) && times >= 0)) throw new EzTestError(`${where}.loop.times: a whole number`, 'LOAD_SCENARIO');
      return { kind: 'loop', times, while: typeof l.while === 'string' ? l.while : undefined, max: l.max === undefined ? 1000 : Number(l.max), actions: parseActions(l.actions, `${where}.loop.actions`) };
    }
    case 'browser':
      return { kind: 'browser', spec: parseSpec(BrowserActionSpec, v, `${where}.browser`) };
    case 'ws':
      return { kind: 'ws', spec: parseSpec(WsActionSpec, v, `${where}.ws`) };
    case 'sse':
      return { kind: 'sse', spec: parseSpec(SseActionSpec, v, `${where}.sse`) };
    case 'grpc':
      return { kind: 'grpc', spec: parseSpec(GrpcActionSpec, v, `${where}.grpc`) };
    case 'sql':
      return { kind: 'sql', spec: parseSpec(SqlActionSpec, v, `${where}.sql`) };
    case 'message':
      return { kind: 'message', spec: parseSpec(MessageActionSpec, v, `${where}.message`) };
    case 'use':
      if (typeof v !== 'string') throw new EzTestError(`${where}.use: a data set name`, 'LOAD_SCENARIO');
      return { kind: 'use', dataset: v };
  }
  throw new EzTestError(`${where}: unknown action`, 'LOAD_SCENARIO');
}

// ------------------------------------------------------------------ profiles

export const ProfileSpec = z.discriminatedUnion('type', [
  /** Constant VUs (closed) or rate (open) for a duration. */
  z.strictObject({ type: z.literal('constant'), vus: z.number().int().min(0).optional(), rate: z.number().min(0).optional(), duration: Duration }),
  /** Ramp up to a target, hold, ramp down. */
  z.strictObject({ type: z.literal('ramp'), vus: z.number().int().min(0).optional(), rate: z.number().min(0).optional(), from: z.number().min(0).default(0), rampUp: Duration, plateau: Duration.default(0), rampDown: Duration.default(0) }),
  /** Steps of `step` VUs (or rate) every `every`, up to `to`, then hold. */
  z.strictObject({ type: z.literal('step'), from: z.number().min(0).default(0), step: z.number().min(0), every: Duration, to: z.number().min(0), hold: Duration.default(0), rampWithin: Duration.default(0) }),
  /** A base load with periodic spikes. */
  z.strictObject({ type: z.literal('peak'), base: z.number().min(0), peak: z.number().min(0), duration: Duration, peakEvery: Duration, peakFor: Duration, rampWithin: Duration.default(0) }),
  /** A long steady run (soak/endurance), with a short ramp. */
  z.strictObject({ type: z.literal('soak'), vus: z.number().int().min(0).optional(), rate: z.number().min(0).optional(), duration: Duration, rampUp: Duration.default(60_000), rampDown: Duration.default(0) }),
  /** Arbitrary curve: points (at, value), linear in between. */
  z.strictObject({ type: z.literal('custom'), points: z.array(z.strictObject({ at: Duration, value: z.number().min(0) })).min(2) }),
]);
export type ProfileSpec = z.infer<typeof ProfileSpec>;
export type ProfileInput = z.input<typeof ProfileSpec>;

// ------------------------------------------------------------------ populations, network

export const NetworkSpec = z.strictObject({
  /** Added round-trip latency (ms), split between directions. */
  latencyMs: z.number().min(0).default(0),
  jitterMs: z.number().min(0).default(0),
  /** Per-connection bandwidth caps in kilobits per second (0 = unlimited). */
  downloadKbps: z.number().min(0).default(0),
  uploadKbps: z.number().min(0).default(0),
  /** Packet loss in percent, emulated as TCP retransmission delays. */
  lossPercent: z.number().min(0).max(100).default(0),
});
export type NetworkSpec = z.infer<typeof NetworkSpec>;

export const PopulationSpec = z.strictObject({
  name: z.string().min(1),
  userPath: z.string().min(1),
  /** Percentage of the load (VUs or arrival rate). Shares are normalized to 100. */
  share: z.number().min(0).max(100).default(100),
  /** A geographic label (shown in results); agents tagged with the same zone get this population. */
  zone: z.string().optional(),
  network: NetworkSpec.optional(),
  /** Population-specific profile (overrides the scenario profile). */
  profile: ProfileSpec.optional(),
  /** Browser-level users (through EZTest's driver) instead of protocol-level ones; set automatically when the path has browser actions. */
  browser: z.boolean().optional(),
});
export type PopulationSpec = z.infer<typeof PopulationSpec>;

// ------------------------------------------------------------------ data

export const DatasetSpec = z.strictObject({
  /** CSV (header row) or JSON array file, relative to the scenario. */
  file: z.string().optional(),
  /** Inline rows. */
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))).optional(),
  /** SQL query on a named connection (rows read once before the test). */
  query: z.string().optional(),
  connection: z.string().optional(),
  /** Row order: sequential, random, or unique (each row used by one VU/iteration only, across all agents). */
  order: z.enum(['sequential', 'random', 'unique']).default('sequential'),
  /** When a new row is taken: every iteration, once per VU, or once per test (shared). */
  scope: z.enum(['iteration', 'vu', 'test']).default('iteration'),
  /** What unique/sequential rows do when exhausted: recycle from the start, stop the VU, or fail the iteration. */
  onExhausted: z.enum(['recycle', 'stopVu', 'error']).default('recycle'),
  delimiter: z.string().length(1).optional(),
});
export type DatasetSpec = z.infer<typeof DatasetSpec>;

// ------------------------------------------------------------------ SLA

const Threshold = z.strictObject({ warn: z.number().optional(), fail: z.number().optional() });
export const SlaSpec = z.strictObject({
  name: z.string().optional(),
  /** Glob over transaction/request names ("*" any). */
  match: z.string().default('*'),
  kind: z.enum(['transaction', 'request', 'any']).default('any'),
  avg: Threshold.optional(),
  p50: Threshold.optional(),
  p90: Threshold.optional(),
  p95: Threshold.optional(),
  p99: Threshold.optional(),
  max: Threshold.optional(),
  /** Error rate 0..1 (above = bad). */
  errorRate: Threshold.optional(),
  /** Minimum throughput (per second; below = bad). */
  throughput: Threshold.optional(),
  /** Window for live evaluation. Default 10s. */
  window: Duration.default(10_000),
  /** Ignore the first part of the run in the final evaluation (ramp-up). */
  ignoreFirst: Duration.default(0),
});
export type SlaSpec = z.infer<typeof SlaSpec>;

// ------------------------------------------------------------------ monitors

export const MonitorSpec = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('host'), name: z.string().default('localhost'), /** Remote host agent (eztest load monitor-agent) URL; omit for this machine. */ url: z.string().optional(), token: z.string().optional(), processes: z.array(z.string()).optional(), intervalMs: z.number().int().min(200).default(1000) }),
  z.strictObject({ type: z.literal('http'), name: z.string().optional(), url: z.string().min(1), expectStatus: z.number().int().default(200), timeoutMs: z.number().int().default(5000), intervalMs: z.number().int().min(200).default(2000) }),
  z.strictObject({ type: z.literal('db'), name: z.string().optional(), connection: z.string().min(1), intervalMs: z.number().int().min(500).default(5000), topSql: z.number().int().min(0).default(5) }),
  z.strictObject({ type: z.literal('jvm'), name: z.string().optional(), /** Process id or a pattern matched against java command lines. */ pid: z.union([z.number().int(), z.string()]), intervalMs: z.number().int().min(500).default(2000), jstat: z.string().optional(), jcmd: z.string().optional() }),
]);
export type MonitorSpec = z.infer<typeof MonitorSpec>;

// ------------------------------------------------------------------ correlation rules (editor)

export const CorrelationRuleSpec = z.strictObject({
  name: z.string().min(1),
  /** Where the value is found. */
  from: z.enum(['body', 'header', 'cookie']).default('body'),
  regex: z.string().optional(),
  json: z.string().optional(),
  boundary: z.strictObject({ left: z.string(), right: z.string() }).optional(),
  header: z.string().optional(),
  /** Only responses whose URL matches this glob. */
  urlMatch: z.string().optional(),
  /** Variable name (default: from the rule name). */
  var: z.string().optional(),
  enabled: z.boolean().default(true),
  framework: z.string().optional(),
});
export type CorrelationRuleSpec = z.infer<typeof CorrelationRuleSpec>;

// ------------------------------------------------------------------ connections (SQL, buses, auth)

export const AuthSpec = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('basic'), username: z.string(), password: z.string() }),
  z.strictObject({ type: z.literal('digest'), username: z.string(), password: z.string() }),
  z.strictObject({ type: z.literal('ntlm'), username: z.string(), password: z.string(), domain: z.string().default(''), workstation: z.string().default('EZTEST') }),
  /** SPNEGO/Kerberos: a token from a command (e.g. a helper that calls the OS GSS-API) or a fixed base64 token per request. */
  z.strictObject({ type: z.literal('negotiate'), tokenCommand: z.string().optional(), token: z.string().optional() }),
  z.strictObject({ type: z.literal('oauth2'), tokenUrl: z.string(), grant: z.enum(['client_credentials', 'password']).default('client_credentials'), clientId: z.string(), clientSecret: z.string().optional(), username: z.string().optional(), password: z.string().optional(), scope: z.string().optional() }),
  z.strictObject({ type: z.literal('bearer'), token: z.string() }),
]);
export type AuthSpec = z.infer<typeof AuthSpec>;

export const TlsSpec = z.strictObject({
  /** Client certificate (PEM) and key, or a PFX/P12 bundle, relative to the scenario. */
  cert: z.string().optional(),
  key: z.string().optional(),
  pfx: z.string().optional(),
  passphrase: z.string().optional(),
  ca: z.string().optional(),
  /** Accept self-signed server certificates (test environments). */
  insecure: z.boolean().default(false),
});

export const OptionsSpec = z.strictObject({
  /** HTTP version: 1.1, 2 (prior knowledge for http://, ALPN for https://) or auto (ALPN). */
  http: z.enum(['1.1', '2', 'auto']).default('1.1'),
  timeoutMs: Duration.default(30_000),
  followRedirects: z.boolean().default(true),
  maxRedirects: z.number().int().min(0).default(10),
  keepAlive: z.boolean().default(true),
  /** Connections per origin per VU (HTTP/1.1). */
  maxConnectionsPerHost: z.number().int().min(1).default(6),
  /** One connection pool shared by all VUs of a process instead of one per VU. */
  sharedPool: z.boolean().default(false),
  userAgent: z.string().default('EZTest-Load/1.0'),
  /** Discard bodies after extraction/assertion (default true). */
  discardBodies: z.boolean().default(true),
  /** Keep the first N error responses' bodies for diagnosis. */
  errorSamples: z.number().int().min(0).default(20),
  /** Graceful stop: how long running iterations may finish when stopping. */
  gracefulStop: Duration.default(10_000),
  /** Default think time between actions when the path sets none. */
  thinkTime: ThinkTime.optional(),
  /** Iteration pacing: start iterations at most this often per VU (closed model). */
  pacing: Duration.optional(),
  /** Open model: VUs available to run arriving iterations (per process). */
  maxVus: z.number().int().min(1).default(1000),
  /** Open model: arrivals that may wait for a free VU before being dropped (their wait counts in latency). */
  maxQueue: z.number().int().min(0).default(10_000),
  /** After a failed request: end the iteration (default, a broken chain of correlated values cannot go on) or continue. */
  onError: z.enum(['stopIteration', 'continue']).default('stopIteration'),
  /** Open model: clear cookies and run `init` again for every arriving iteration (a new visitor each time). */
  newSessionPerIteration: z.boolean().default(false),
  /** Multiply every think time (0 disables them, e.g. for a smoke run). */
  thinkTimeFactor: z.number().min(0).default(1),
  /** Seed for think times and random data (reproducible runs). */
  seed: z.number().int().optional(),
  tls: TlsSpec.optional(),
  auth: AuthSpec.optional(),
  /** Variables available to every user path. */
  variables: z.record(z.string(), z.string()).default({}),
  /** Browser users: headless (default) and the executable. */
  browser: z.strictObject({ headless: z.boolean().default(true), executablePath: z.string().optional(), name: z.enum(['chromium', 'firefox']).default('chromium') }).optional(),
});
export type LoadOptionsSpec = z.infer<typeof OptionsSpec>;

export const UserPathSpecRaw = z.strictObject({
  description: z.string().optional(),
  init: z.array(z.unknown()).default([]),
  actions: z.array(z.unknown()).min(1),
  end: z.array(z.unknown()).default([]),
  thinkTime: ThinkTime.optional(),
  pacing: Duration.optional(),
  /** Data sets bound at iteration (or VU) start: `${users.username}`. */
  data: z.array(z.string()).default([]),
  /** Variables of this path. */
  variables: z.record(z.string(), z.string()).default({}),
  auth: AuthSpec.optional(),
  /** Where the path came from (journey, har, recording, yaml). */
  source: z.string().optional(),
});

export interface UserPath {
  name: string;
  description?: string;
  init: Action[];
  actions: Action[];
  end: Action[];
  thinkTime?: ThinkTime;
  pacing?: number;
  data: string[];
  variables: Record<string, string>;
  auth?: AuthSpec;
  source?: string;
  /** Has browser actions: runs as a browser-level user. */
  browser: boolean;
}

const ScenarioRaw = z.strictObject({
  version: z.literal(1).default(1),
  name: z.string().min(1),
  description: z.string().optional(),
  baseUrl: z.string().optional(),
  model: z.enum(['closed', 'open']).default('closed'),
  profile: ProfileSpec.optional(),
  userPaths: z.record(z.string(), UserPathSpecRaw),
  populations: z.array(PopulationSpec).optional(),
  data: z.record(z.string(), DatasetSpec).default({}),
  sla: z.array(SlaSpec).default([]),
  monitors: z.array(MonitorSpec).default([]),
  correlation: z.strictObject({ rules: z.array(CorrelationRuleSpec).default([]), frameworks: z.array(z.string()).optional() }).optional(),
  connections: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  buses: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  options: OptionsSpec.default(OptionsSpec.parse({})),
  /** Stop the test early when an SLA fails live (with this grace). */
  stopOnSlaFail: z.union([z.boolean(), Duration]).default(false),
  tags: z.array(z.string()).default([]),
  /** Readiness: journey/requirement ids this load test covers (for citations). */
  requirements: z.array(z.string()).default([]),
});

export interface Scenario {
  version: 1;
  name: string;
  description?: string;
  baseUrl?: string;
  model: 'closed' | 'open';
  profile?: ProfileSpec;
  userPaths: Record<string, UserPath>;
  populations: PopulationSpec[];
  data: Record<string, DatasetSpec>;
  sla: SlaSpec[];
  monitors: MonitorSpec[];
  correlation?: { rules: CorrelationRuleSpec[]; frameworks?: string[] };
  connections: Record<string, Record<string, unknown>>;
  buses: Record<string, Record<string, unknown>>;
  options: LoadOptionsSpec;
  stopOnSlaFail: boolean | number;
  tags: string[];
  requirements: string[];
  /** Directory the scenario's relative paths resolve against. */
  baseDir: string;
}

export type ScenarioInput = z.input<typeof ScenarioRaw>;

function hasBrowser(actions: Action[]): boolean {
  return actions.some((a) => a.kind === 'browser' || (a.kind === 'transaction' && hasBrowser(a.actions)) || (a.kind === 'if' && (hasBrowser(a.then) || hasBrowser(a.else))) || (a.kind === 'loop' && hasBrowser(a.actions)));
}

/** Validate a scenario object (from YAML/JSON or built in code). */
export function parseScenario(input: unknown, baseDir = process.cwd()): Scenario {
  const r = ScenarioRaw.safeParse(input);
  if (!r.success) {
    throw new EzTestError(`Invalid load scenario: ${r.error.issues.slice(0, 8).map((i) => `${issuePath(i.path as Array<string | number>)}: ${i.message}`).join('; ')}`, 'LOAD_SCENARIO');
  }
  const s = r.data;
  const userPaths: Record<string, UserPath> = {};
  for (const [name, p] of Object.entries(s.userPaths)) {
    const init = parseActions(p.init, `userPaths.${name}.init`);
    const actions = parseActions(p.actions, `userPaths.${name}.actions`);
    const end = parseActions(p.end, `userPaths.${name}.end`);
    for (const d of p.data) if (!s.data[d]) throw new EzTestError(`userPaths.${name}.data: unknown data set "${d}" (defined: ${Object.keys(s.data).join(', ') || 'none'})`, 'LOAD_SCENARIO');
    userPaths[name] = { name, description: p.description, init, actions, end, thinkTime: p.thinkTime, pacing: p.pacing, data: p.data, variables: p.variables, auth: p.auth, source: p.source, browser: hasBrowser([...init, ...actions, ...end]) };
  }
  const names = Object.keys(userPaths);
  if (!names.length) throw new EzTestError('Invalid load scenario: userPaths is empty', 'LOAD_SCENARIO');
  const populations = s.populations?.length ? s.populations : [{ name: names[0], userPath: names[0], share: 100 } as PopulationSpec];
  const seen = new Set<string>();
  for (const p of populations) {
    if (!userPaths[p.userPath]) throw new EzTestError(`populations.${p.name}: unknown user path "${p.userPath}" (defined: ${names.join(', ')})`, 'LOAD_SCENARIO');
    if (seen.has(p.name)) throw new EzTestError(`populations: duplicate name "${p.name}"`, 'LOAD_SCENARIO');
    seen.add(p.name);
    if (!p.profile && !s.profile) throw new EzTestError(`populations.${p.name}: no load profile (set profile on the scenario or the population)`, 'LOAD_SCENARIO');
  }
  if (populations.reduce((a, p) => a + p.share, 0) <= 0) throw new EzTestError('populations: shares add up to 0', 'LOAD_SCENARIO');
  for (const [name, d] of Object.entries(s.data)) {
    const sources = [d.file, d.rows, d.query].filter((x) => x !== undefined).length;
    if (sources !== 1) throw new EzTestError(`data.${name}: give exactly one of file, rows or query`, 'LOAD_SCENARIO');
    if (d.query && !d.connection) throw new EzTestError(`data.${name}: a query needs a connection`, 'LOAD_SCENARIO');
  }
  for (const sla of s.sla) {
    for (const k of ['avg', 'p50', 'p90', 'p95', 'p99', 'max', 'errorRate', 'throughput'] as const) {
      const t = sla[k];
      if (t && t.warn !== undefined && t.fail !== undefined && (k === 'throughput' ? t.warn < t.fail : t.warn > t.fail)) {
        throw new EzTestError(`sla ${sla.name ?? sla.match}: ${k} warn threshold is beyond the fail threshold`, 'LOAD_SCENARIO');
      }
    }
  }
  return { ...s, userPaths, populations, baseDir } as Scenario;
}

/** Load a scenario file (.yaml, .yml or .json). */
export async function loadScenarioFile(path: string): Promise<Scenario> {
  const text = await readFile(path, 'utf8');
  let raw: unknown;
  try {
    raw = extname(path).toLowerCase() === '.json' ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    throw new EzTestError(`${path}: ${(e as Error).message}`, 'LOAD_SCENARIO');
  }
  return parseScenario(raw, dirname(resolve(path)));
}

/** Raw (unparsed) document form of a scenario, for saving edits. */
export function scenarioDocument(s: Scenario): Record<string, unknown> {
  const { baseDir: _b, userPaths, ...rest } = s;
  return { ...rest, userPaths: Object.fromEntries(Object.entries(userPaths).map(([k, p]) => [k, userPathDocument(p)])) };
}

export function actionDocument(a: Action): Record<string, unknown> {
  switch (a.kind) {
    case 'request':
      return { request: a.spec };
    case 'transaction':
      return { transaction: { name: a.name, actions: a.actions.map(actionDocument) } };
    case 'think':
      return { think: a.time };
    case 'set':
      return { set: a.vars };
    case 'if':
      return { if: { cond: a.cond, then: a.then.map(actionDocument), ...(a.else.length ? { else: a.else.map(actionDocument) } : {}) } };
    case 'loop':
      return { loop: { ...(a.times !== undefined ? { times: a.times } : {}), ...(a.while ? { while: a.while } : {}), max: a.max, actions: a.actions.map(actionDocument) } };
    case 'use':
      return { use: a.dataset };
    default:
      return { [a.kind]: (a as { spec: unknown }).spec };
  }
}

export function userPathDocument(p: UserPath): Record<string, unknown> {
  return {
    ...(p.description ? { description: p.description } : {}),
    ...(p.source ? { source: p.source } : {}),
    ...(p.init.length ? { init: p.init.map(actionDocument) } : {}),
    actions: p.actions.map(actionDocument),
    ...(p.end.length ? { end: p.end.map(actionDocument) } : {}),
    ...(p.thinkTime !== undefined ? { thinkTime: p.thinkTime } : {}),
    ...(p.pacing !== undefined ? { pacing: p.pacing } : {}),
    ...(p.data.length ? { data: p.data } : {}),
    ...(Object.keys(p.variables).length ? { variables: p.variables } : {}),
    ...(p.auth ? { auth: p.auth } : {}),
  };
}
