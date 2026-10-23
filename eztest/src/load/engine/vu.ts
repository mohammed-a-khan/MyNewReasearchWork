/**
 * The load generator's process-wide runtime (data pools, shapers, protocol
 * pools, browsers) and the virtual user that executes a user path.
 *
 * Coordinated omission: an iteration has an intended start (the open
 * model's scheduled arrival, or the pacing slot). The iteration, and the
 * transaction and request that start it, are measured from that intended
 * time, so a late start (generator saturated, no free VU, the system under
 * test stalling earlier requests) shows up as latency instead of vanishing.
 */
import http from 'node:http';
import https from 'node:https';
import { evaluateExpression, truthy } from '../../core/index.js';
import type { Action, HttpRequestSpec, PopulationSpec, Scenario, ThinkTime, UserPath } from '../model.js';
import { DataExhausted, DataPool, type Row } from '../data.js';
import type { MetricsCollector, SampleKind } from '../metrics.js';
import { render, renderDeep, seededRandom, TemplateError, type TemplateScope } from '../template.js';
import { checkAssertions, runExtractors } from '../extract.js';
import { createAgents, headerValue, HttpClient, HttpRequestError } from './http.js';
import { ConnectionShaper } from './shaping.js';
import { ProtocolPools, runGrpc, runMessage, runSql, runSse, runWs, type ProtocolOutcome } from '../protocols/index.js';
import { BrowserPool, type BrowserUser } from '../protocols/browser.js';
import type { LoadCurve } from '../profiles.js';

export interface PopulationRuntime {
  spec: PopulationSpec;
  path: UserPath;
  curve: LoadCurve;
  shaper?: ConnectionShaper;
  /** Open model: VUs this population may use in this process. */
  maxVus: number;
}

export class LoadRuntime {
  readonly pools: ProtocolPools;
  readonly browsers: BrowserPool;
  readonly dataPools = new Map<string, DataPool>();
  readonly random: () => number;
  private readonly shared?: { http: http.Agent; https: https.Agent };
  private readonly shapers = new Map<string, ConnectionShaper>();
  private vuSeq = 0;

  constructor(readonly scenario: Scenario, data: Record<string, Row[]>, readonly metrics: MetricsCollector, readonly o: { seed?: number; vuIdOffset?: number } = {}) {
    const seed = o.seed ?? scenario.options.seed;
    this.random = seed === undefined ? Math.random : seededRandom(seed);
    this.pools = new ProtocolPools({ connections: scenario.connections, buses: scenario.buses, baseDir: scenario.baseDir });
    this.browsers = new BrowserPool(scenario.options.browser);
    for (const [name, rows] of Object.entries(data)) {
      const spec = scenario.data[name];
      if (spec) this.dataPools.set(name, new DataPool(name, rows, spec, this.random));
    }
    if (scenario.options.sharedPool) this.shared = createAgents({ keepAlive: scenario.options.keepAlive, maxConnectionsPerHost: scenario.options.maxConnectionsPerHost * 16, tls: scenario.options.tls, baseDir: scenario.baseDir });
    this.vuSeq = o.vuIdOffset ?? 0;
  }

  shaperFor(p: PopulationSpec): ConnectionShaper | undefined {
    if (!p.network) return undefined;
    let s = this.shapers.get(p.name);
    if (!s) {
      s = new ConnectionShaper(p.network, this.random);
      this.shapers.set(p.name, s);
    }
    return s.active ? s : undefined;
  }

  nextVuId(): number {
    return ++this.vuSeq;
  }

  sharedAgents(): { http: http.Agent; https: https.Agent } | undefined {
    return this.shared;
  }

  async close(): Promise<void> {
    this.shared?.http.destroy();
    this.shared?.https.destroy();
    await this.pools.close();
    await this.browsers.close();
    for (const s of this.shapers.values()) await s.close();
  }
}

class StopIteration extends Error {
  constructor(readonly reason: 'error' | 'abort') {
    super(reason);
  }
}

export class StopVu extends Error {}

export type IterationResult = 'ok' | 'error' | 'aborted';

const isAbsolute = (u: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(u);

export class VirtualUser {
  readonly id: number;
  readonly client: HttpClient;
  readonly scope: TemplateScope;
  stopRequested = false;
  aborted = false;
  initialized = false;
  busy = false;
  private intended?: number;
  private browserUser?: BrowserUser;
  private vuRows = new Map<string, Row>();
  private readonly opts: Scenario['options'];

  constructor(readonly rt: LoadRuntime, readonly pop: PopulationRuntime) {
    this.id = rt.nextVuId();
    const s = rt.scenario;
    this.opts = s.options;
    this.client = new HttpClient({
      http: s.options.http, keepAlive: s.options.keepAlive, maxConnectionsPerHost: s.options.maxConnectionsPerHost, timeoutMs: s.options.timeoutMs,
      followRedirects: s.options.followRedirects, maxRedirects: s.options.maxRedirects, userAgent: s.options.userAgent, tls: s.options.tls, baseDir: s.baseDir,
      auth: pop.path.auth ?? s.options.auth, shaper: pop.shaper, agents: rt.sharedAgents(),
    });
    const vars = new Map<string, unknown>();
    vars.set('env', process.env);
    for (const [k, v] of Object.entries(s.options.variables)) vars.set(k, v);
    for (const [k, v] of Object.entries(pop.path.variables)) vars.set(k, v);
    this.scope = { vars, vu: this.id, iter: 0, random: rt.random };
  }

  private get metrics(): MetricsCollector {
    return this.rt.metrics;
  }

  private record(kind: SampleKind, name: string, from: number, start: number, end: number, ok: boolean, extra: { errorType?: string; status?: number; bytesIn?: number; bytesOut?: number } = {}): void {
    if (this.aborted) return;
    this.metrics.record({ kind, name, population: this.pop.spec.name, ok, latencyUs: (end - from) * 1000, serviceUs: (end - start) * 1000, ...extra });
  }

  /** Intended start for the first timed leaf of an iteration (consumed by it). */
  private takeIntended(t0: number): number {
    const i = this.intended;
    this.intended = undefined;
    return i !== undefined && i < t0 ? i : t0;
  }

  private bindData(scope: 'vu' | 'iteration'): void {
    for (const name of this.pop.path.data) {
      const pool = this.rt.dataPools.get(name);
      if (!pool) continue;
      const spec = this.rt.scenario.data[name];
      if (scope === 'vu' && spec.scope !== 'iteration') {
        const row = pool.take();
        this.vuRows.set(name, row);
        this.scope.vars.set(name, row);
      } else if (scope === 'iteration' && spec.scope === 'iteration') this.scope.vars.set(name, pool.take());
    }
  }

  async init(): Promise<boolean> {
    try {
      this.bindData('vu');
      if (this.pop.path.init.length) {
        const t0 = performance.now();
        await this.runActions(this.pop.path.init, true);
        this.record('transaction', `${this.pop.path.name} init`, t0, t0, performance.now(), true);
      }
      this.initialized = true;
      return true;
    } catch (e) {
      if (e instanceof DataExhausted && e.stopVu) throw new StopVu(e.message);
      if (e instanceof StopIteration) return false;
      this.noteError('init', 'init', (e as Error).message);
      return false;
    }
  }

  /** Run one iteration. `intendedStart` is performance.now() time the iteration should have started. */
  async iteration(intendedStart?: number): Promise<IterationResult> {
    this.busy = true;
    this.scope.iter++;
    const t0 = performance.now();
    const from = intendedStart !== undefined && intendedStart < t0 ? intendedStart : t0;
    this.intended = from;
    let ok = true;
    try {
      this.bindData('iteration');
      await this.runActions(this.pop.path.actions, true);
    } catch (e) {
      if (e instanceof DataExhausted) {
        if (e.stopVu) {
          this.busy = false;
          throw new StopVu(e.message);
        }
        this.noteError('data', this.pop.path.name, e.message);
      }
      if (e instanceof StopIteration && e.reason === 'abort') {
        this.busy = false;
        return 'aborted';
      }
      if (!(e instanceof StopIteration) && !(e instanceof DataExhausted)) this.noteError('script', this.pop.path.name, (e as Error).message);
      ok = false;
    }
    this.intended = undefined;
    this.record('iteration', this.pop.path.name, from, t0, performance.now(), ok, ok ? {} : { errorType: 'iteration' });
    this.busy = false;
    return ok ? 'ok' : 'error';
  }

  async end(): Promise<void> {
    if (!this.pop.path.end.length || this.aborted) return;
    try {
      await this.runActions(this.pop.path.end, true);
    } catch {
      // end actions (sign out) failing does not matter for the results beyond their own samples
    }
  }

  async newSession(): Promise<void> {
    this.client.cookies.clear();
    await this.browserUser?.clearSession();
    this.initialized = false;
  }

  async close(): Promise<void> {
    this.client.close();
    await this.browserUser?.close();
    this.browserUser = undefined;
  }

  private noteError(type: string, name: string, message: string, extra: { status?: number; url?: string; body?: Buffer } = {}): void {
    this.metrics.noteError({ at: new Date().toISOString(), name, population: this.pop.spec.name, type, message: message.slice(0, 500), status: extra.status, url: extra.url, bodyStart: extra.body ? extra.body.subarray(0, 300).toString('utf8') : undefined });
  }

  private async think(t: ThinkTime | undefined): Promise<void> {
    if (t === undefined || this.aborted) return;
    const f = this.opts.thinkTimeFactor;
    if (f === 0) return;
    let ms: number;
    if (typeof t === 'number') ms = t;
    else if ('min' in t) ms = t.min + this.rt.random() * Math.max(0, t.max - t.min);
    else if (t.distribution === 'exponential') ms = -Math.log(1 - this.rt.random()) * t.mean;
    else {
      const u = 1 - this.rt.random();
      const v = this.rt.random();
      ms = Math.max(0, t.mean + (t.stdDev ?? t.mean / 4) * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
    }
    ms *= f;
    if (ms <= 0) return;
    if (this.intended !== undefined) this.intended += ms; // waiting is user behaviour, not latency
    await new Promise((r) => setTimeout(r, ms));
  }

  private async runActions(list: Action[], topLevel = false): Promise<void> {
    for (let i = 0; i < list.length; i++) {
      if (this.aborted) throw new StopIteration('abort');
      const a = list[i];
      await this.runAction(a);
      if (topLevel && i < list.length - 1 && (a.kind === 'request' || a.kind === 'transaction' || a.kind === 'browser')) {
        await this.think(this.pop.path.thinkTime ?? this.opts.thinkTime);
      }
    }
  }

  private vars(): Record<string, unknown> {
    const v: Record<string, unknown> = Object.fromEntries(this.scope.vars);
    v.__vu = this.id;
    v.__iter = this.scope.iter;
    return v;
  }

  private async runAction(a: Action): Promise<void> {
    switch (a.kind) {
      case 'request':
        return this.request(a.spec);
      case 'transaction': {
        const t0 = performance.now();
        const from = this.intended !== undefined && this.intended < t0 ? this.intended : t0;
        try {
          await this.runActions(a.actions);
        } catch (e) {
          if (!(e instanceof StopIteration && e.reason === 'abort')) this.record('transaction', a.name, from, t0, performance.now(), false, { errorType: 'transaction' });
          throw e;
        }
        this.record('transaction', a.name, from, t0, performance.now(), true);
        return;
      }
      case 'think':
        return this.think(a.time);
      case 'set':
        for (const [k, v] of Object.entries(a.vars)) this.scope.vars.set(k, render(v, this.scope));
        return;
      case 'if':
        return this.runActions(truthy(evaluateExpression(a.cond, this.vars())) ? a.then : a.else);
      case 'loop': {
        const max = a.times ?? a.max;
        for (let n = 0; n < max; n++) {
          if (a.while !== undefined && !truthy(evaluateExpression(a.while, this.vars()))) break;
          this.scope.vars.set('__loop', n);
          await this.runActions(a.actions);
        }
        return;
      }
      case 'use': {
        const pool = this.rt.dataPools.get(a.dataset);
        if (!pool) throw new TemplateError(`unknown data set "${a.dataset}"`);
        this.scope.vars.set(a.dataset, pool.take());
        return;
      }
      case 'browser':
        return this.browser(a.spec);
      default:
        return this.protocol(a);
    }
  }

  private async protocol(a: Extract<Action, { kind: 'ws' | 'sse' | 'grpc' | 'sql' | 'message' }>): Promise<void> {
    const name = a.spec.name ?? `${a.kind.toUpperCase()} ${'url' in a.spec ? a.spec.url : 'method' in a.spec ? a.spec.method : 'connection' in a.spec ? a.spec.connection : a.spec.bus}`;
    const t0 = performance.now();
    const from = this.takeIntended(t0);
    let out: ProtocolOutcome;
    const timeout = this.opts.timeoutMs;
    try {
      if (a.kind === 'ws') out = await runWs(a.spec, this.scope, timeout);
      else if (a.kind === 'sse') {
        const cookie = this.client.cookies.header(new URL(render(a.spec.url, this.scope)));
        out = await runSse(a.spec, this.scope, timeout, cookie ? { cookie } : {});
      }
      else if (a.kind === 'grpc') out = await runGrpc(a.spec, this.scope, this.rt.pools, timeout);
      else if (a.kind === 'sql') out = await runSql(a.spec, this.scope, this.rt.pools);
      else out = await runMessage(a.spec, this.scope, this.rt.pools, timeout);
    } catch (e) {
      out = { ok: false, errorType: a.kind.toUpperCase(), message: (e as Error).message, bytesIn: 0, bytesOut: 0 };
    }
    const end = performance.now();
    for (const [k, v] of out.vars ?? []) this.scope.vars.set(k, v);
    this.record('request', name, from, t0, end, out.ok, { errorType: out.errorType, bytesIn: out.bytesIn, bytesOut: out.bytesOut });
    if (!out.ok) {
      this.noteError(out.errorType ?? 'error', name, out.message ?? 'failed');
      if (this.opts.onError === 'stopIteration') throw new StopIteration('error');
    }
  }

  private async browser(spec: Extract<Action, { kind: 'browser' }>['spec']): Promise<void> {
    if (!this.browserUser) this.browserUser = await this.rt.browsers.newUser(this.pop.spec.network, this.rt.scenario.baseUrl);
    const name = spec.name ?? (spec.goto !== undefined ? `open ${spec.goto}` : spec.click !== undefined ? `click ${spec.click}` : spec.fill !== undefined ? `fill ${spec.fill}` : 'browser step');
    const t0 = performance.now();
    const from = this.takeIntended(t0);
    const out = await this.browserUser.run(spec, this.scope, this.opts.timeoutMs);
    const end = performance.now();
    for (const [k, v] of out.vars ?? []) this.scope.vars.set(k, v);
    this.record('page', name, from, t0, end, out.ok, { errorType: out.errorType, bytesIn: out.navigation?.transferSize });
    if (out.navigation && out.ok) {
      this.metrics.record({ kind: 'request', name: `${name} (TTFB)`, population: this.pop.spec.name, ok: true, latencyUs: Math.max(1, out.navigation.ttfb * 1000) });
    }
    if (!out.ok) {
      this.noteError(out.errorType ?? 'browser', name, out.message ?? 'failed');
      if (this.opts.onError === 'stopIteration') throw new StopIteration('error');
    }
  }

  private buildUrl(raw: string): string {
    const u = render(raw, this.scope);
    if (isAbsolute(u)) return u;
    const base = this.rt.scenario.baseUrl;
    if (!base) throw new TemplateError(`relative URL "${u}" but the scenario has no baseUrl`);
    return new URL(u, base.endsWith('/') ? base : `${base}/`).href.replace(/([^:])\/\/+/g, '$1/');
  }

  private async request(spec: HttpRequestSpec): Promise<void> {
    if (spec.thinkBefore !== undefined) await this.think(spec.thinkBefore);
    const name = spec.name ?? `${spec.method} ${spec.url}`;
    let url: string;
    const headers: Record<string, string> = {};
    let body: string | undefined;
    try {
      url = this.buildUrl(spec.url);
      for (const [k, v] of Object.entries(spec.headers ?? {})) headers[k.toLowerCase()] = render(v, this.scope);
      if (spec.json !== undefined) {
        body = JSON.stringify(renderDeep(spec.json, this.scope));
        headers['content-type'] ??= 'application/json';
      } else if (spec.form) {
        body = new URLSearchParams(Object.entries(spec.form).map(([k, v]) => [k, render(v, this.scope)])).toString();
        headers['content-type'] ??= 'application/x-www-form-urlencoded';
      } else if (spec.body !== undefined) body = render(spec.body, this.scope);
    } catch (e) {
      const t = performance.now();
      this.record('request', name, this.takeIntended(t), t, t, false, { errorType: 'template' });
      this.noteError('template', name, (e as Error).message);
      throw new StopIteration('error');
    }
    const t0 = performance.now();
    const from = this.takeIntended(t0);
    let res;
    try {
      res = await this.client.request({ method: spec.method, url, headers, body, timeoutMs: spec.timeoutMs, followRedirects: spec.followRedirects });
    } catch (e) {
      const end = performance.now();
      const type = e instanceof HttpRequestError ? e.type : 'NETWORK';
      this.record('request', name, from, t0, end, false, { errorType: type });
      this.noteError(type, name, (e as Error).message, { url });
      if (this.opts.onError === 'stopIteration') throw new StopIteration(this.aborted ? 'abort' : 'error');
      return;
    }
    const end = performance.now();
    const view = { status: res.status, url: res.url, headers: res.headers, body: res.body, durationMs: end - from };
    let errorType: string | undefined;
    let message: string | undefined;
    const hasStatusAssert = (spec.assert ?? []).some((a) => a.status !== undefined);
    if (!hasStatusAssert && res.status >= 400) {
      errorType = `HTTP ${res.status}`;
      message = `${spec.method} ${res.url} returned ${res.status}`;
    }
    if (!errorType && spec.assert?.length) {
      const failed = checkAssertions(view, spec.assert, this.scope);
      if (failed) {
        errorType = 'assertion';
        message = failed;
      }
    }
    if (!errorType && spec.extract?.length) {
      const ex = runExtractors(view, spec.extract, this.rt.random, this.scope);
      for (const [k, v] of ex.vars) this.scope.vars.set(k, v);
      if (ex.missing.length) {
        errorType = 'extraction';
        message = `could not extract ${ex.missing.join(', ')} from the response`;
      }
    }
    if (spec.captureAs) {
      let parsed: unknown = res.body.toString('utf8');
      try {
        parsed = JSON.parse(parsed as string);
      } catch {
        // keep the text
      }
      this.scope.vars.set(spec.captureAs, { status: res.status, headers: res.headers, body: parsed });
    }
    this.scope.vars.set('__status', res.status);
    this.scope.vars.set('__location', headerValue(res.headers, 'location') ?? '');
    this.record('request', name, from, t0, end, !errorType, { errorType, status: res.status, bytesIn: res.bytesIn, bytesOut: res.bytesOut });
    if (spec.resources?.length && !errorType) await this.resources(spec.resources, url);
    if (errorType) {
      this.noteError(errorType, name, message!, { status: res.status, url: res.url, body: res.body });
      if (this.opts.onError === 'stopIteration') throw new StopIteration('error');
    }
  }

  private async resources(list: string[], pageUrl: string): Promise<void> {
    await Promise.all(
      list.map(async (r) => {
        const url = new URL(render(r, this.scope), pageUrl).href;
        const t0 = performance.now();
        try {
          const res = await this.client.request({ method: 'GET', url });
          this.record('request', `resource ${new URL(url).pathname}`, t0, t0, performance.now(), res.status < 400, { status: res.status, bytesIn: res.bytesIn, bytesOut: res.bytesOut, errorType: res.status >= 400 ? `HTTP ${res.status}` : undefined });
        } catch (e) {
          this.record('request', `resource ${new URL(url).pathname}`, t0, t0, performance.now(), false, { errorType: e instanceof HttpRequestError ? e.type : 'NETWORK' });
        }
      }),
    );
  }
}
