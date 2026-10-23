/**
 * `eztest load agent`: a load generator. It dials the controller (so agents
 * can be added elastically behind NAT or by an autoscaler), authenticates,
 * receives a job (the scenario, its share of each population and its slice
 * of each data set), starts at the controller's start time, streams one
 * metrics interval per second, obeys live control (add VUs, scale, stop)
 * and sends its final details. Then it waits for the next job, or exits
 * with `once`.
 */
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { hostname } from 'node:os';
import { EzTestError } from '../../core/index.js';
import { parseScenario } from '../model.js';
import { MetricsCollector, type EncodedInterval } from '../metrics.js';
import { Executor } from '../engine/executor.js';
import { LoadRuntime } from '../engine/vu.js';
import { buildPopulations, steadyAfter } from '../run.js';
import type { Row } from '../data.js';
import { Channel, mac, macEqual, nonce, parseHostPort, PROTOCOL_VERSION, readTls, type Frame, type TlsFiles } from './protocol.js';

export interface AgentOptions {
  controller: string;
  token?: string;
  id?: string;
  zone?: string;
  /** Relative capacity weight (default 1). */
  capacity?: number;
  tls?: TlsFiles & { servername?: string; insecure?: boolean };
  /** Run one job and exit. */
  once?: boolean;
  /** Retry connecting for this long (ms) before giving up. Default 60 s. */
  connectTimeoutMs?: number;
  log?: (s: string) => void;
  baseDir?: string;
}

export interface AgentHandle {
  id: string;
  /** Resolves when the agent stops (once: after its job). */
  done: Promise<void>;
  stop(): void;
}

function connectOnce(o: AgentOptions): Promise<Channel> {
  const { host, port } = parseHostPort(o.controller);
  const tls = readTls(o.tls);
  return new Promise((resolve, reject) => {
    const sock = tls || o.tls?.insecure
      ? tlsConnect({ host, port, ...tls, servername: o.tls?.servername ?? (/^\d+\.\d+\.\d+\.\d+$/.test(host) ? undefined : host), rejectUnauthorized: !o.tls?.insecure })
      : netConnect({ host, port });
    const onErr = (e: Error) => reject(e);
    sock.once('error', onErr);
    sock.once(tls || o.tls?.insecure ? 'secureConnect' : 'connect', () => {
      sock.off('error', onErr);
      resolve(new Channel(sock));
    });
  });
}

async function handshake(ch: Channel, o: AgentOptions, id: string): Promise<number> {
  const hello = await ch.next('hello', 15_000);
  if (hello.version !== PROTOCOL_VERSION) throw new EzTestError(`controller speaks protocol ${String(hello.version)}, this agent ${PROTOCOL_VERSION}`, 'LOAD_AGENT');
  const na = nonce();
  ch.send({ type: 'register', id, host: hostname(), zone: o.zone, capacity: o.capacity ?? 1, nonce: na, pid: process.pid, ...(o.token ? { mac: mac(o.token, 'agent', String(hello.nonce), na, id) } : {}) });
  const w = await Promise.race([
    ch.next('welcome', 15_000),
    ch.next('error', 16_000).then((f) => {
      throw new EzTestError(`controller refused the agent: ${String(f.message ?? 'error')}`, 'LOAD_AUTH');
    }),
  ]);
  if (o.token && !macEqual(String(w.mac ?? ''), mac(o.token, 'controller', na, String(hello.nonce)))) throw new EzTestError('controller failed authentication (wrong token?)', 'LOAD_AUTH');
  return Number(w.index ?? 0);
}

async function runJob(ch: Channel, job: Frame, o: AgentOptions, log: (s: string) => void): Promise<void> {
  const scenario = parseScenario(job.scenario, o.baseDir ?? process.cwd());
  const data = (job.data ?? {}) as Record<string, Row[]>;
  const slices = (job.slices ?? {}) as Record<string, number>;
  const metrics = new MetricsCollector(scenario.options.errorSamples);
  metrics.steadyAfterSec = steadyAfter(scenario);
  const rt = new LoadRuntime(scenario, data, metrics, { vuIdOffset: Number(job.vuIdOffset ?? 0), seed: job.seed === undefined ? undefined : Number(job.seed) });
  const pops = buildPopulations(scenario, rt, slices);
  if (!pops.length) {
    ch.send({ type: 'final', details: [], errors: [], errorsByType: {}, empty: true });
    await rt.close();
    return;
  }
  const ex = new Executor({ runtime: rt, populations: pops, model: scenario.model, mode: 'agent', startAt: Number(job.startAt), roundOffset: job.roundOffset === undefined ? undefined : Number(job.roundOffset), durationMs: job.durationMs === undefined ? undefined : Number(job.durationMs) });
  ex.on('interval', (e: EncodedInterval) => ch.send({ type: 'interval', data: e }));
  const onControl = (f: Frame) => {
    try {
      if (f.type === 'stop') f.abort ? ex.abort() : ex.stop();
      else if (f.type === 'control') {
        if (typeof f.addVus === 'number') ex.addVus(f.addVus, typeof f.population === 'string' ? f.population : undefined);
        if (typeof f.factor === 'number') ex.setFactor(f.factor);
      }
    } catch (e) {
      ch.send({ type: 'log', level: 'warn', message: (e as Error).message });
    }
  };
  ch.on('frame', onControl);
  const lost = () => ex.stop();
  ch.once('close', lost);
  ch.send({ type: 'ready', populations: pops.map((p) => ({ name: p.spec.name, peak: p.curve.peak })) });
  log(`job ${String(job.runId)}: ${pops.map((p) => `${p.spec.name} peak ${Math.round(p.curve.peak * 100) / 100}`).join(', ')}; starting at ${new Date(Number(job.startAt)).toISOString()}`);
  try {
    await ex.run();
  } finally {
    ch.off('frame', onControl);
    ch.off('close', lost);
    await rt.close();
  }
  ch.send({ type: 'final', details: metrics.finalDetails(), errors: metrics.errorSamples, errorsByType: Object.fromEntries(metrics.errorsByType), maxVus: metrics.maxVus });
  log(`job ${String(job.runId)} done`);
}

export function startAgent(o: AgentOptions): AgentHandle {
  const id = o.id ?? `${hostname()}-${process.pid}`;
  const log = o.log ?? (() => undefined);
  let stopped = false;
  let current: Channel | undefined;
  let jobs = 0;
  let lastError = '';
  const done = (async () => {
    const deadline = Date.now() + (o.connectTimeoutMs ?? 60_000);
    while (!stopped) {
      let ch: Channel;
      try {
        ch = await connectOnce(o);
      } catch (e) {
        if (Date.now() > deadline) throw new EzTestError(`agent ${id}: cannot reach controller ${o.controller}: ${(e as Error).message}`, 'LOAD_AGENT');
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      current = ch;
      ch.on('error', () => undefined);
      const ping = setInterval(() => ch.send({ type: 'ping', at: Date.now() }), 5000);
      try {
        const index = await handshake(ch, o, id);
        log(`agent ${id} registered with ${o.controller} as #${index}`);
        const job = await new Promise<Frame | undefined>((resolve) => {
          const onF = (f: Frame) => {
            if (f.type === 'job') {
              ch.off('frame', onF);
              resolve(f);
            } else if (f.type === 'bye') resolve(undefined);
          };
          ch.on('frame', onF);
          ch.once('close', () => resolve(undefined));
        });
        if (job) {
          await runJob(ch, job, o, log);
          jobs++;
        }
      } catch (e) {
        lastError = (e as Error).message;
        log(`agent ${id}: ${lastError}`);
        if ((e as EzTestError).code === 'LOAD_AUTH') {
          clearInterval(ping);
          ch.close();
          throw e;
        }
      } finally {
        clearInterval(ping);
      }
      ch.close();
      if (o.once) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (o.once && !jobs && !stopped) throw new EzTestError(`agent ${id} ran no job${lastError ? `: ${lastError}` : ''}`, 'LOAD_AGENT');
  })();
  // The caller awaits `done` when it wants the outcome; a rejection must not surface as unhandled before that.
  done.catch(() => undefined);
  return {
    id,
    done,
    stop: () => {
      stopped = true;
      current?.close();
    },
  };
}
