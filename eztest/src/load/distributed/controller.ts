/**
 * `eztest load controller` (and `eztest load run --agents N`): the
 * controller of a distributed load test. It listens for load generators,
 * authenticates them (shared-token HMAC and/or mutual TLS), splits each
 * population's load over them (by capacity, and by zone for geographic
 * populations), slices the data sets, starts everyone at one wall-clock
 * time, merges the per-second metrics exactly (histogram merges), runs the
 * monitors and SLAs on the merged timeline, relays live control, and stops
 * the agents safely (graceful, then abort). A lost agent is reported; the
 * test continues with the others.
 */
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer as netServer, type Server, type Socket } from 'node:net';
import { createServer as tlsServer, type TLSSocket } from 'node:tls';
import { EzTestError } from '../../core/index.js';
import { scenarioDocument, type Scenario } from '../model.js';
import { loadAllData, sliceRows, type Row } from '../data.js';
import { MetricsCollector, type EncodedInterval, type ErrorSample, type TimelinePoint } from '../metrics.js';
import { MonitorRunner } from '../monitors/index.js';
import { LiveSla, type SlaItem } from '../sla.js';
import { newRunId, steadyAfter, summarizeResults, type LiveSnapshot, type LoadResults, type LoadTestOptions } from '../run.js';
import type { EncodedHistogram } from '../histogram.js';
import { Channel, mac, macEqual, nonce, parseHostPort, PROTOCOL_VERSION, readTls, type Frame, type TlsFiles } from './protocol.js';

export interface ControllerOptions extends LoadTestOptions {
  /** "host:port" to listen on (default 0.0.0.0:7400). */
  listen?: string;
  token?: string;
  /** TLS server certificate/key; with `ca` and requireClientCert, agents must present a certificate signed by it (mTLS). */
  tls?: TlsFiles & { requireClientCert?: boolean };
  /** Agents to wait for before starting. */
  agents: number;
  /** How long to wait for them (default 120 s). */
  waitMs?: number;
  /** Delay between sending jobs and the common start (default 2 s). */
  startDelayMs?: number;
  log?: (s: string) => void;
  /**
   * Elastic scaling hook: a shell command run when the controller starts waiting, to bring up the
   * agents (e.g. "kubectl scale deployment/ez-load-agents --replicas={agents}"). Placeholders:
   * {agents}, {port}, {runId}. The token is passed as EZTEST_LOAD_TOKEN in its environment.
   */
  scaleUp?: string;
  /** Run after the test (e.g. "kubectl scale deployment/ez-load-agents --replicas=0"). Same placeholders. */
  scaleDown?: string;
}

interface AgentConn {
  id: string;
  host: string;
  zone?: string;
  capacity: number;
  index: number;
  ch: Channel;
  state: 'registered' | 'ready' | 'running' | 'done' | 'lost';
  lastT: number;
  requests: number;
  errors: number;
  peakVus: number;
  final?: Frame;
}

export class LoadController extends EventEmitter {
  readonly runId: string;
  readonly metrics: MetricsCollector;
  private server?: Server;
  private readonly agents: AgentConn[] = [];
  private readonly pending = new Map<number, Map<string, EncodedInterval>>();
  private readonly firstSeen = new Map<number, number>();
  private nextT = 0;
  private live: LiveSla;
  private liveItems: SlaItem[] = [];
  private monitors?: MonitorRunner;
  private state: LiveSnapshot['state'] = 'starting';
  private stopReason?: string;
  private startAt = 0;
  private flushTimer?: NodeJS.Timeout;
  port = 0;

  constructor(readonly scenario: Scenario, readonly o: ControllerOptions) {
    super();
    if (!o.token && !(o.tls?.requireClientCert && o.tls.ca)) throw new EzTestError('the controller needs a token or mutual TLS (tls.ca + requireClientCert) to authenticate agents', 'LOAD_AUTH');
    if (o.token && o.token.length < 16) throw new EzTestError('controller token: use at least 16 characters', 'LOAD_AUTH');
    if (!(o.agents >= 1)) throw new EzTestError('agents must be >= 1', 'LOAD_SCENARIO');
    this.runId = o.runId ?? newRunId();
    this.metrics = new MetricsCollector(scenario.options.errorSamples);
    this.metrics.steadyAfterSec = steadyAfter(scenario);
    this.live = new LiveSla(scenario.sla);
  }

  private log(s: string): void {
    this.o.log?.(s);
    this.emit('log', s);
  }

  /** Start listening; resolves with the bound port. */
  async listen(): Promise<number> {
    const { host, port } = parseHostPort(this.o.listen ?? '0.0.0.0:7400', '0.0.0.0');
    const tls = readTls(this.o.tls);
    const onConn = (s: Socket | TLSSocket) => void this.accept(s);
    this.server = tls ? tlsServer({ ...tls, requestCert: !!this.o.tls?.requireClientCert, rejectUnauthorized: !!this.o.tls?.requireClientCert }, onConn) : netServer(onConn);
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => resolve());
    });
    this.port = (this.server.address() as { port: number }).port;
    this.log(`controller listening on ${host}:${this.port}${tls ? ' (TLS' + (this.o.tls?.requireClientCert ? ', client certificates required)' : ')') : ''}`);
    return this.port;
  }

  private async accept(sock: Socket | TLSSocket): Promise<void> {
    const ch = new Channel(sock);
    ch.on('error', () => undefined);
    const nc = nonce();
    ch.send({ type: 'hello', nonce: nc, version: PROTOCOL_VERSION, runId: this.runId });
    let reg: Frame;
    try {
      reg = await ch.next('register', 15_000);
    } catch {
      ch.close();
      return;
    }
    const id = String(reg.id ?? '');
    if (this.o.token && !macEqual(String(reg.mac ?? ''), mac(this.o.token, 'agent', nc, String(reg.nonce ?? ''), id))) {
      this.log(`rejected agent ${id || '?'} from ${sock.remoteAddress}: bad token`);
      ch.send({ type: 'error', message: 'authentication failed' });
      ch.close();
      return;
    }
    if (this.state !== 'starting' || this.agents.filter((a) => a.state !== 'lost').length >= this.o.agents) {
      ch.send({ type: 'bye', reason: 'the test has all its agents' });
      ch.close();
      return;
    }
    const a: AgentConn = { id: id || `agent-${this.agents.length + 1}`, host: String(reg.host ?? sock.remoteAddress ?? ''), zone: typeof reg.zone === 'string' ? reg.zone : undefined, capacity: Number(reg.capacity) > 0 ? Number(reg.capacity) : 1, index: this.agents.length, ch, state: 'registered', lastT: -1, requests: 0, errors: 0, peakVus: 0 };
    if (this.agents.some((x) => x.id === a.id && x.state !== 'lost')) a.id = `${a.id}-${a.index}`;
    this.agents.push(a);
    ch.send({ type: 'welcome', index: a.index, ...(this.o.token ? { mac: mac(this.o.token, 'controller', String(reg.nonce ?? ''), nc) } : {}) });
    ch.on('frame', (f: Frame) => this.onFrame(a, f));
    ch.on('close', () => {
      if (a.state !== 'done') {
        a.state = 'lost';
        this.log(`agent ${a.id} lost`);
        this.emit('agent-lost', a.id);
        this.flush(true);
        this.checkDone();
      }
    });
    this.log(`agent ${a.id} (${a.host}${a.zone ? `, zone ${a.zone}` : ''}) registered`);
    this.emit('agent', { id: a.id, host: a.host, zone: a.zone });
  }

  private doneWaiters: Array<() => void> = [];
  private checkDone(): void {
    if (this.agents.length && this.agents.every((a) => a.state === 'done' || a.state === 'lost')) for (const w of this.doneWaiters.splice(0)) w();
  }

  private onFrame(a: AgentConn, f: Frame): void {
    switch (f.type) {
      case 'ping':
        a.ch.send({ type: 'pong', at: Date.now() });
        return;
      case 'ready':
        a.state = 'ready';
        this.emit('agent-ready', a.id);
        return;
      case 'interval': {
        const e = f.data as EncodedInterval;
        a.state = 'running';
        a.lastT = Math.max(a.lastT, e.t);
        a.peakVus = Math.max(a.peakVus, e.vus);
        for (const k of e.keys) if (k.k === 'request') {
          a.requests += k.n;
          a.errors += k.e;
        }
        let m = this.pending.get(e.t);
        if (!m) {
          this.pending.set(e.t, (m = new Map()));
          this.firstSeen.set(e.t, Date.now());
        }
        m.set(a.id, e);
        this.flush(false);
        return;
      }
      case 'final':
        a.final = f;
        a.state = 'done';
        this.flush(true);
        this.checkDone();
        return;
      case 'log':
        this.log(`[${a.id}] ${String(f.message)}`);
        return;
    }
  }

  /** Merge complete seconds in order (or everything that is stale when `force`). */
  private flush(force: boolean): void {
    for (;;) {
      const t = this.nextT;
      const parts = this.pending.get(t);
      const live = this.agents.filter((a) => a.state === 'running' || a.state === 'ready');
      const complete = parts && live.every((a) => parts.has(a.id) || a.lastT > t);
      const stale = parts && Date.now() - (this.firstSeen.get(t) ?? Date.now()) > 3000;
      const later = [...this.pending.keys()].some((k) => k > t);
      if (!parts) {
        // a second nobody reported (all agents idle in it): skip it once later seconds exist
        if (later && (force || live.every((a) => a.lastT > t))) {
          this.nextT++;
          continue;
        }
        return;
      }
      if (!complete && !stale && !force) return;
      if (!complete && force && live.some((a) => a.lastT <= t) && !stale && this.state === 'running') return;
      this.pending.delete(t);
      this.firstSeen.delete(t);
      this.nextT++;
      const point = this.metrics.ingest([...parts.values()]);
      this.onPoint(point);
    }
  }

  private onPoint(p: TimelinePoint): void {
    this.liveItems = this.live.update(this.metrics.timeline);
    const stopOn = this.scenario.stopOnSlaFail;
    if (stopOn !== false && this.live.failingSince !== undefined && this.state === 'running') {
      const grace = stopOn === true ? 0 : stopOn / 1000;
      if (p.t - this.live.failingSince >= grace) {
        this.stopReason = `SLA failed live at ${this.live.failingSince}s (stopOnSlaFail)`;
        this.stop();
      }
    }
    this.emit('point', p, this.snapshot());
  }

  /** Split of each population over the agents: by capacity, zone populations only to agents of their zone. */
  private slices(): Map<string, Record<string, number>> {
    const out = new Map<string, Record<string, number>>();
    const act = this.agents.filter((a) => a.state !== 'lost');
    for (const a of act) out.set(a.id, {});
    for (const p of this.scenario.populations) {
      let pool = p.zone ? act.filter((a) => a.zone === p.zone) : act;
      if (!pool.length) {
        this.log(`population ${p.name}: no agent in zone ${p.zone}; using all agents`);
        pool = act;
      }
      const sum = pool.reduce((x, a) => x + a.capacity, 0);
      for (const a of pool) out.get(a.id)![p.name] = a.capacity / sum;
    }
    return out;
  }

  async run(): Promise<LoadResults> {
    if (!this.server) await this.listen();
    if (this.o.scaleUp) await this.hook('scale-up', this.o.scaleUp, false);
    const waitMs = this.o.waitMs ?? 120_000;
    const deadline = Date.now() + waitMs;
    while (this.agents.filter((a) => a.state !== 'lost').length < this.o.agents) {
      if (Date.now() > deadline) throw new EzTestError(`only ${this.agents.filter((a) => a.state !== 'lost').length} of ${this.o.agents} agent(s) registered within ${Math.round(waitMs / 1000)} s`, 'LOAD_AGENTS');
      await new Promise((r) => setTimeout(r, 100));
    }
    const data: Record<string, Row[]> = this.o.data ?? (await loadAllData(this.scenario));
    const doc = scenarioDocument(this.scenario);
    const act = this.agents.filter((a) => a.state !== 'lost');
    const slices = this.slices();
    this.startAt = Date.now() + (this.o.startDelayMs ?? 2000);
    act.forEach((a, i) => {
      const d: Record<string, Row[]> = {};
      for (const [name, rows] of Object.entries(data)) d[name] = sliceRows(rows, this.scenario.data[name], i, act.length);
      a.ch.send({ type: 'job', runId: this.runId, scenario: doc, data: d, slices: slices.get(a.id), startAt: this.startAt, vuIdOffset: i * 1_000_000, roundOffset: i / act.length, durationMs: this.o.durationMs, seed: this.o.seed === undefined ? undefined : this.o.seed + i });
    });
    this.log(`job sent to ${act.length} agent(s); start at ${new Date(this.startAt).toISOString()}`);
    this.metrics.startedAt = this.startAt;
    this.monitors = new MonitorRunner(this.o.monitors === false ? [] : this.scenario.monitors, this.scenario);
    await new Promise((r) => setTimeout(r, Math.max(0, this.startAt - Date.now())));
    await this.monitors.start(this.startAt);
    this.state = 'running';
    this.emit('started', { runId: this.runId });
    this.flushTimer = setInterval(() => this.flush(false), 500);
    await new Promise<void>((resolve) => {
      this.doneWaiters.push(resolve);
      this.checkDone();
    });
    clearInterval(this.flushTimer);
    this.flush(true);
    await this.monitors.stop();
    // final details: status codes, error types, service-time histograms, error samples
    const details: Array<{ k: 'request' | 'transaction' | 'page' | 'iteration'; name: string; status: Record<string, number>; errs: Record<string, number>; service: EncodedHistogram }> = [];
    for (const a of this.agents) {
      const f = a.final;
      if (!f) continue;
      details.push(...((f.details ?? []) as typeof details));
      for (const e of (f.errors ?? []) as ErrorSample[]) this.metrics.noteError({ ...e, name: `${e.name}`, message: `[${a.id}] ${e.message}` });
      this.metrics.maxVus = Math.max(this.metrics.maxVus, Number(f.maxVus ?? 0));
    }
    this.metrics.ingestFinal(details);
    this.state = 'done';
    const finishedAt = Date.now();
    const secs = Math.max(0.001, (finishedAt - this.startAt) / 1000);
    const lost = this.agents.filter((a) => a.state === 'lost');
    const results = summarizeResults({
      runId: this.runId, scenario: this.scenario, metrics: this.metrics, startedAt: this.startAt, finishedAt, monitors: this.monitors.series, live: this.live,
      baseline: this.o.baseline, rules: this.o.regressionRules,
      stopReason: [this.stopReason, lost.length ? `${lost.length} agent(s) lost: ${lost.map((a) => a.id).join(', ')}` : undefined].filter(Boolean).join('; ') || undefined,
      agents: this.agents.map((a) => ({ id: a.id, host: a.host, zone: a.zone, vus: a.peakVus, requests: a.requests, errors: a.errors, rps: Math.round((a.requests / secs) * 10) / 10 })),
    });
    if (this.o.scaleDown) await this.hook('scale-down', this.o.scaleDown, true);
    this.emit('done', results);
    return results;
  }

  /** Run a scaling hook; scale-up is not awaited to completion (it may start long-running agents). */
  private hook(name: string, cmd: string, wait: boolean): Promise<void> {
    const line = cmd.replace(/\{agents\}/g, String(this.o.agents)).replace(/\{port\}/g, String(this.port)).replace(/\{runId\}/g, this.runId);
    this.log(`${name} hook: ${line}`);
    const p = spawn(line, { shell: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...(this.o.token ? { EZTEST_LOAD_TOKEN: this.o.token } : {}), EZTEST_LOAD_CONTROLLER_PORT: String(this.port), EZTEST_LOAD_RUN_ID: this.runId } });
    p.stderr?.on('data', (d: Buffer) => this.log(`[${name}] ${d.toString().trim()}`));
    this.hooks.push(p);
    if (!wait) {
      p.on('exit', (code) => code && this.log(`${name} hook exited with ${code}`));
      return Promise.resolve();
    }
    return new Promise((r) => p.on('exit', () => r()));
  }

  private readonly hooks: Array<ReturnType<typeof spawn>> = [];

  snapshot(): LiveSnapshot {
    const tl = this.metrics.timeline;
    const last = tl[tl.length - 1];
    return {
      runId: this.runId, scenario: this.scenario.name, state: this.state, elapsedMs: this.startAt ? Math.max(0, Date.now() - this.startAt) : 0, durationMs: 0,
      vus: last?.vus ?? 0, point: last,
      totals: { requests: tl.reduce((a, p) => a + p.requests, 0), errors: tl.reduce((a, p) => a + p.errors, 0), iterations: tl.reduce((a, p) => a + p.iterations, 0), dropped: this.metrics.iterationsDropped },
      sla: this.liveItems, monitors: this.monitors?.latest() ?? [],
      populations: Object.entries(last?.populations ?? {}).map(([name, v]) => ({ name, vus: v.vus, target: v.vus, queued: 0 })),
      agents: this.agents.map((a) => ({ id: a.id, host: a.host, vus: a.peakVus, state: a.state })),
    };
  }

  private broadcast(f: Frame): void {
    for (const a of this.agents) if (a.state !== 'lost' && a.state !== 'done') a.ch.send(f);
  }

  stop(reason = 'stopped'): void {
    this.stopReason ??= reason;
    this.state = 'stopping';
    this.broadcast({ type: 'stop' });
  }

  abort(): void {
    this.stopReason ??= 'aborted';
    this.state = 'stopping';
    this.broadcast({ type: 'stop', abort: true });
  }

  /** Add VUs: split over the running agents. */
  addVus(n: number, population?: string): void {
    const act = this.agents.filter((a) => a.state === 'running' || a.state === 'ready');
    if (!act.length) throw new EzTestError('no running agents', 'LOAD_CONTROL');
    const each = n / act.length;
    for (const a of act) a.ch.send({ type: 'control', addVus: each, population });
  }

  setFactor(f: number): void {
    this.broadcast({ type: 'control', factor: f });
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    for (const a of this.agents) a.ch.close();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
