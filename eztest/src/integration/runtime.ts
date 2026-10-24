/**
 * The integration runtime: executes `integration` steps (message buses, gRPC,
 * SFTP/folders, SSH, batch jobs, EDI, contract sessions) for the runner. Broker
 * connections and SSH sessions are opened on first use and shared by the run;
 * listeners and contract sessions belong to one journey attempt. Every message,
 * file and command output is masked before it reaches the ledger or evidence.
 */
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { EzTestError, NotSupportedError, renderTemplate, type CompareOp, type Step } from '../core/index.js';
import { cachedSpec, validateAgainstDefinition } from '../contracts/openapi.js';
import type { ContractRecorder } from '../contracts/consumer.js';
import { envProxyFetch, getPath, validateSchema } from '../surfaces/index.js';
import { compareOp } from '../runner/conditions-advanced.js';
import { maskDeep } from '../runner/dom.js';
import { safeName } from '../runner/evidence.js';
import { resolveUrl } from '../runner/api.js';
import type { StepContext } from '../runner/types.js';
import { AmqpBusDriver } from './bus/amqp.js';
import { Amqp10BusDriver } from './bus/amqp10.js';
import { IbmMqBusDriver } from './bus/ibmmq.js';
import { KafkaBusDriver } from './bus/kafka.js';
import { MemoryBusDriver } from './bus/memory.js';
import { MqttBusDriver } from './bus/mqtt.js';
import { BusError, type BusDestination, type BusDriver, type BusMessage, type BusSubscription } from './bus/types.js';
import type { BatchConfig, BrokerConfig, FilesConfig, GrpcConfig, MessagingConfig } from './config.js';
import { parseEdi } from './edi.js';
import { allowedFolder, commandAllowed, copyLocal, fileMatcher, listLocal, removeLocal, SshSession, type RemoteFile } from './files.js';
import { GrpcServiceClient } from './grpc.js';
import type { BusFilter } from './rules.js';
import type { IntegrationOutcome, IntegrationRuntime } from './types.js';

type Args = Record<string, unknown>;

export interface IntegrationRuntimeOptions {
  /** Project directory: relative files (payloads, protos, keys) resolve against it. */
  baseDir: string;
  messaging?: Partial<MessagingConfig>;
  grpc?: Partial<GrpcConfig>;
  files?: Partial<FilesConfig>;
  batch?: Partial<BatchConfig>;
  /** Contract consumer sessions (built by the engine; one per run). */
  contracts?: ContractRecorder;
  /** Ready-made bus drivers by broker name (tests, custom brokers). */
  drivers?: Record<string, BusDriver>;
  /** Auth headers for HTTP batch jobs run as a role. */
  apiAuth?: (role: string, ctx: StepContext) => Promise<Record<string, string>>;
  templateSyntax?: 'dollar' | 'mustache';
  /** How far back file waits look at modification times (default 10 minutes). */
  fileLookbackMs?: number;
  /** Cleanup problems (a consumer group the broker kept, ...). Default: a process warning. */
  onWarning?: (message: string) => void;
}

interface JourneyState {
  listeners: Map<string, { sub: BusSubscription; broker: string; kind: string; dest: BusDestination }>;
}

const KIND_TEXT: Record<string, string> = { kafka: 'Kafka', amqp: 'RabbitMQ', amqp10: 'AMQP 1.0', mqtt: 'MQTT', ibmmq: 'IBM MQ', memory: 'memory' };

export function createBusDriver(name: string, c: BrokerConfig, baseDir: string): BusDriver {
  switch (c.type) {
    case 'kafka': return new KafkaBusDriver(name, c);
    case 'amqp': return new AmqpBusDriver(name, c);
    case 'amqp10': return new Amqp10BusDriver(name, { ...c, ...(['ca', 'cert', 'key'] as const).reduce((o, k) => (c[k] ? { ...o, [k]: isAbsolute(c[k]!) ? c[k] : resolve(baseDir, c[k]!) } : o), {}) });
    case 'mqtt': return new MqttBusDriver(name, c);
    case 'ibmmq': return new IbmMqBusDriver(name, { ...c, ...(c.ca ? { ca: isAbsolute(c.ca) ? c.ca : resolve(baseDir, c.ca) } : {}) });
    case 'memory': return new MemoryBusDriver(name);
  }
}

function asJson(text: string): unknown {
  if (!/^\s*[[{"]|^\s*-?\d|^\s*(?:true|false|null)\s*$/.test(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function msText(n: number): string {
  return n % 1000 === 0 ? `${n / 1000} s` : `${n} ms`;
}

export class Integration implements IntegrationRuntime {
  private readonly drivers = new Map<string, BusDriver>();
  private readonly journeys = new WeakMap<object, JourneyState>();
  private readonly openSubs = new Set<BusSubscription>();
  private readonly ssh = new Map<string, SshSession>();
  private readonly grpcClients = new Map<string, GrpcServiceClient>();

  constructor(readonly opts: IntegrationRuntimeOptions) {
    for (const [n, d] of Object.entries(opts.drivers ?? {})) this.drivers.set(n, d);
  }

  private state(ctx: StepContext): JourneyState {
    let s = this.journeys.get(ctx.ledger);
    if (!s) {
      s = { listeners: new Map() };
      this.journeys.set(ctx.ledger, s);
    }
    return s;
  }

  private mask(ctx: StepContext): (s: string) => string {
    return ctx.session?.mask ?? ((s: string) => s);
  }

  async perform(step: Step, ctx: StepContext, timeoutMs: number): Promise<IntegrationOutcome> {
    const a = (step.args ?? {}) as Args;
    switch (String(a.kind)) {
      case 'bus': return this.bus(step, a, ctx);
      case 'grpc': return this.grpcCall(step, a, ctx);
      case 'file': return this.file(step, a, ctx);
      case 'ssh': return this.sshExec(step, a, ctx, timeoutMs);
      case 'batch': return this.batchRun(step, a, ctx);
      case 'edi': return this.edi(step, a, ctx);
      case 'contract': return this.contract(a, ctx);
      default: throw new NotSupportedError(`integration kind "${String(a.kind)}"`);
    }
  }

  // ---------------------------------------------------------------- message buses

  /** The broker a step means: by name, else the only (or first) broker of the named kind, else the only broker. */
  driverFor(name: string | undefined, kind: string | undefined): BusDriver {
    const configured = this.opts.messaging?.brokers ?? {};
    const all = [...new Set([...this.drivers.keys(), ...Object.keys(configured)])];
    let pick = name;
    if (!pick) {
      // "RabbitMQ/AMQP queue" also finds an AMQP 1.0 broker when no AMQP 0-9-1 one is configured.
      const typeOf = (n: string) => this.drivers.get(n)?.kind ?? configured[n]?.type;
      let ofKind = kind ? all.filter((n) => typeOf(n) === kind) : all;
      if (kind === 'amqp' && !ofKind.length) ofKind = all.filter((n) => typeOf(n) === 'amqp10');
      if (ofKind.length === 0) throw new EzTestError(`No ${kind ? `${KIND_TEXT[kind]} ` : ''}broker configured (messaging.brokers)`, 'BUS_CONFIG');
      if (ofKind.length > 1 && !kind) throw new EzTestError(`Several brokers are configured (${ofKind.join(', ')}); say which one: "... on <broker>"`, 'BUS_CONFIG');
      pick = ofKind[0];
    }
    let d = this.drivers.get(pick);
    if (!d) {
      const c = configured[pick];
      if (!c) throw new EzTestError(`No broker "${pick}" in messaging.brokers (known: ${all.join(', ') || 'none'})`, 'BUS_CONFIG');
      d = createBusDriver(pick, c, this.opts.baseDir);
      this.drivers.set(pick, d);
    }
    if (kind && d.kind !== kind && d.kind !== 'memory' && !(kind === 'amqp' && d.kind === 'amqp10')) throw new EzTestError(`Broker "${pick}" is ${KIND_TEXT[d.kind]}, but the step says ${KIND_TEXT[kind]}`, 'BUS_CONFIG');
    return d;
  }

  private destOf(a: Args, ctx: StepContext): BusDestination {
    return { type: String(a.destType) as BusDestination['type'], name: ctx.interpolate(String(a.dest)), ...(a.routingKey !== undefined ? { routingKey: ctx.interpolate(String(a.routingKey)) } : {}) };
  }

  private describe(d: BusDriver, dest: BusDestination): string {
    return `${KIND_TEXT[d.kind]} ${dest.type} "${dest.name}" on ${d.name}`;
  }

  private async payload(a: Args, ctx: StepContext): Promise<string> {
    const vars = ctx.vars();
    if (a.file !== undefined) {
      const p = resolve(this.opts.baseDir, ctx.interpolate(String(a.file)));
      return renderTemplate(await readFile(p, 'utf8'), vars, { syntax: this.opts.templateSyntax });
    }
    const raw = String(a.payload ?? '');
    const whole = /^\$\{([A-Za-z_][\w.]*)\}$/.exec(raw);
    if (whole) {
      const v = getPath(vars, whole[1]);
      if (v !== undefined && typeof v === 'object') return JSON.stringify(v);
    }
    return renderTemplate(raw, vars, { syntax: this.opts.templateSyntax });
  }

  private predicate(filters: BusFilter[], ctx: StepContext): (m: BusMessage) => boolean {
    const want = filters.map((f) => ({ ...f, value: f.value === undefined ? undefined : ctx.interpolate(f.value) }));
    return (m) => {
      let json: unknown;
      let parsed = false;
      return want.every((f) => {
        let actual: unknown;
        if (f.field.startsWith('$')) {
          if (!parsed) {
            json = asJson(m.payload);
            parsed = true;
          }
          if (json === undefined) return false;
          try {
            actual = getPath(json, f.field);
          } catch {
            return false;
          }
        } else if (f.field === 'key') actual = m.key;
        else if (f.field === 'correlationId') actual = m.correlationId;
        else if (f.field === 'payload') actual = m.payload;
        else if (f.field.startsWith('header:')) {
          const h = f.field.slice(7).toLowerCase();
          actual = Object.entries(m.headers).find(([k]) => k.toLowerCase() === h)?.[1];
        }
        return compareOp(actual, f.op as CompareOp, f.value);
      });
    };
  }

  private filterText(filters: BusFilter[]): string {
    return filters.map((f) => `${f.field.startsWith('header:') ? `header ${f.field.slice(7)}` : f.field} ${f.op}${f.value !== undefined ? ` ${f.value}` : ''}`).join(' and ');
  }

  private async checkSchema(schemaRef: string, value: unknown, ctx: StepContext): Promise<string[]> {
    const ref = ctx.interpolate(schemaRef);
    const [file, pointer] = ref.split('#');
    const abs = resolve(this.opts.baseDir, file);
    if (pointer && /^\/components\/schemas\/|^\/definitions\//.test(pointer)) {
      const name = pointer.split('/').pop()!;
      return validateAgainstDefinition(cachedSpec(abs), decodeURIComponent(name), value).map((v) => v.message);
    }
    const schema = JSON.parse(await readFile(abs, 'utf8')) as Record<string, unknown>;
    const r = validateSchema(value, schema);
    return r.errors;
  }

  private async bus(step: Step, a: Args, ctx: StepContext): Promise<IntegrationOutcome> {
    const op = String(a.op);
    const st = this.state(ctx);
    const mask = this.mask(ctx);
    const lookback = this.opts.messaging?.lookbackMs ?? 60_000;
    if (op === 'stop') {
      const l = st.listeners.get(String(a.listener));
      if (!l) throw new EzTestError(`No listener "${String(a.listener)}" in this journey`, 'BUS_LISTENER');
      await l.sub.close();
      this.openSubs.delete(l.sub);
      st.listeners.delete(String(a.listener));
      return {};
    }
    // Listener-based waits use the listener's broker and destination.
    const listener = a.listener !== undefined && op !== 'listen' ? st.listeners.get(String(a.listener)) : undefined;
    if (a.listener !== undefined && op !== 'listen' && !listener) throw new EzTestError(`No listener "${String(a.listener)}" (start it first: Start listening on Kafka topic "..." as ${String(a.listener)})`, 'BUS_LISTENER');
    const driver = listener ? this.driverFor(listener.broker, undefined) : this.driverFor(a.broker as string | undefined, a.brokerKind as string | undefined);
    const dest = listener ? listener.dest : this.destOf(a, ctx);
    const where = this.describe(driver, dest);

    if (op === 'publish') {
      const payload = await this.payload(a, ctx);
      const headers = a.headers ? Object.fromEntries(Object.entries(a.headers as Record<string, string>).map(([k, v]) => [k, ctx.interpolate(v)])) : undefined;
      const msg = {
        payload, ...(a.key !== undefined ? { key: ctx.interpolate(String(a.key)) } : {}), ...(headers ? { headers } : {}),
        ...(a.correlationId !== undefined ? { correlationId: ctx.interpolate(String(a.correlationId)) } : {}),
        ...(a.contentType !== undefined ? { contentType: String(a.contentType) } : asJson(payload) !== undefined ? { contentType: 'application/json' } : {}),
        ...(a.qos !== undefined ? { qos: Number(a.qos) as 0 | 1 | 2 } : {}), ...(a.retain ? { retain: true } : {}),
      };
      const receipt = await driver.publish(dest, msg);
      const record = { direction: 'published', broker: driver.name, kind: driver.kind, destination: dest.name, ...(dest.routingKey ? { routingKey: dest.routingKey } : {}), key: msg.key, headers: msg.headers, correlationId: msg.correlationId, payload: asJson(payload) ?? payload, receipt };
      const ref = await ctx.evidence.store('data', `messages/${safeName(ctx.journey.id)}/${safeName(step.id)}.json`, JSON.stringify(record, null, 2), { journeyId: ctx.journey.id, stepId: step.id, description: `published to ${where}` });
      if (step.captureAs) {
        const v = maskDeep({ destination: dest.name, ...receipt, ...(msg.key !== undefined ? { key: msg.key } : {}), ...(msg.correlationId ? { correlationId: msg.correlationId } : {}) }, mask);
        ctx.ledger.set(step.captureAs, v);
        return { captured: { [step.captureAs]: v }, evidence: [ref.id] };
      }
      return { evidence: [ref.id] };
    }

    if (op === 'listen') {
      const name = String(a.listener);
      await st.listeners.get(name)?.sub.close();
      const sub = await driver.subscribe(dest, { fromTimestamp: Date.now(), consumeMatched: true });
      this.openSubs.add(sub);
      st.listeners.set(name, { sub, broker: driver.name, kind: driver.kind, dest });
      return {};
    }

    if (op === 'purge') {
      if (!driver.purge) throw new NotSupportedError(`purging ${KIND_TEXT[driver.kind]} ${dest.type}s`);
      const n = await driver.purge(dest);
      return step.captureAs ? { captured: { [step.captureAs]: n ?? null } } : {};
    }

    if (op === 'wait' || op === 'none') {
      const filters = (a.filters as BusFilter[] | undefined) ?? [];
      const pred = this.predicate(filters, ctx);
      const timeout = Number(a.timeoutMs ?? (op === 'none' ? 5000 : this.opts.messaging?.timeoutMs ?? 30_000));
      const corr = filters.find((f) => f.field === 'correlationId' && f.op === 'equals')?.value;
      const temp = !listener;
      const sub = listener?.sub ?? (await driver.subscribe(dest, { fromTimestamp: Date.now() - lookback, consumeMatched: op === 'wait', ...(driver.kind === 'ibmmq' && corr ? { correlationId: ctx.interpolate(corr) } : {}) } as never));
      if (temp) this.openSubs.add(sub);
      try {
        const deadline = Date.now() + timeout;
        if (op === 'none') {
          const hit = await sub.next(pred, timeout);
          if (hit) {
            const sample = mask(hit.payload).slice(0, 300);
            throw new EzTestError(`A message arrived on ${where}${filters.length ? ` matching ${this.filterText(filters)}` : ''} within ${msText(timeout)}, but none was expected: ${sample}`, 'BUS_UNEXPECTED_MESSAGE');
          }
          return {};
        }
        const count = Number(a.count ?? 1);
        const got: BusMessage[] = [];
        while (got.length < count) {
          const m = await sub.next(pred, Math.max(0, deadline - Date.now()));
          if (!m) break;
          got.push(m);
        }
        if (got.length < count) {
          const others = sub.messages.filter((m) => !got.includes(m));
          const seen = others.length ? `; ${others.length} other message(s) arrived, e.g. ${others.slice(-3).map((m) => mask(m.payload).slice(0, 160)).join(' | ')}` : '; no messages arrived at all';
          if (sub.error && !sub.closed) throw sub.error;
          throw new EzTestError(`No${count > 1 ? ` ${count}` : ''} message${count > 1 ? 's' : ''} on ${where}${filters.length ? ` matched ${this.filterText(filters.map((f) => ({ ...f, value: f.value === undefined ? undefined : ctx.interpolate(f.value) })))}` : ''} within ${msText(timeout)}${got.length ? ` (found ${got.length})` : ''}${seen}`, 'BUS_TIMEOUT');
        }
        const payloads = got.map((m) => (m.binary ? m.payload : asJson(m.payload) ?? m.payload));
        if (a.schema !== undefined) {
          for (const [i, p] of payloads.entries()) {
            const errs = await this.checkSchema(String(a.schema), p, ctx);
            if (errs.length) throw new EzTestError(`Message${count > 1 ? ` ${i + 1}` : ''} on ${where} does not match schema ${String(a.schema)}: ${errs.slice(0, 5).join('; ')}`, 'BUS_SCHEMA');
          }
        }
        const metas = got.map((m) => ({
          broker: driver.name, kind: driver.kind, destination: m.destination, ...(m.key !== undefined ? { key: m.key } : {}), headers: m.headers,
          ...(m.correlationId ? { correlationId: m.correlationId } : {}), ...(m.messageId ? { messageId: m.messageId } : {}), timestamp: new Date(m.timestamp).toISOString(),
          ...(m.partition !== undefined ? { partition: m.partition } : {}), ...(m.offset !== undefined ? { offset: m.offset } : {}), ...(m.routingKey ? { routingKey: m.routingKey } : {}),
        }));
        const key = step.captureAs ?? 'message';
        const value = maskDeep(count > 1 ? payloads : payloads[0], mask);
        const meta = maskDeep(count > 1 ? metas : metas[0], mask);
        ctx.ledger.set(key, value);
        ctx.ledger.set(`${key}_meta`, meta);
        const ref = await ctx.evidence.store('data', `messages/${safeName(ctx.journey.id)}/${safeName(step.id)}.json`, JSON.stringify({ direction: 'received', where, filters, messages: got.map((m, i) => ({ ...metas[i], payload: payloads[i] })) }, null, 2),
          { journeyId: ctx.journey.id, stepId: step.id, description: `received from ${where}` });
        if (this.opts.contracts) {
          // Inside a contract session every received message becomes a message expectation.
          for (const [i, p] of payloads.entries()) {
            await this.opts.contracts.recordMessage(ctx.ledger, {
              description: count > 1 ? `${step.intent} (${i + 1})` : step.intent,
              channel: { transport: driver.kind === 'amqp10' ? 'amqp' : driver.kind, destType: dest.type, dest: dest.name, broker: driver.name },
              contents: p, ...(asJson(got[i].payload) !== undefined ? { contentType: 'application/json' } : {}),
            });
          }
        }
        return { captured: { [key]: value, [`${key}_meta`]: meta }, evidence: [ref.id] };
      } finally {
        if (temp) {
          await sub.close();
          this.openSubs.delete(sub);
        }
      }
    }
    throw new NotSupportedError(`message op "${op}"`);
  }

  // ---------------------------------------------------------------- gRPC

  private grpcClient(name: string): GrpcServiceClient {
    let c = this.grpcClients.get(name);
    if (!c) {
      const cfg = this.opts.grpc?.services?.[name];
      if (!cfg) throw new EzTestError(`No gRPC service "${name}" in grpc.services (known: ${Object.keys(this.opts.grpc?.services ?? {}).join(', ') || 'none'})`, 'GRPC_CONFIG');
      c = new GrpcServiceClient(name, cfg, this.opts.baseDir);
      this.grpcClients.set(name, c);
    }
    return c;
  }

  private async grpcCall(step: Step, a: Args, ctx: StepContext): Promise<IntegrationOutcome> {
    const client = this.grpcClient(String(a.service));
    let request: unknown = {};
    if (a.request !== undefined) {
      const raw = String(a.request);
      const whole = /^\$\{([A-Za-z_][\w.]*)\}$/.exec(raw);
      const v = whole ? getPath(ctx.vars(), whole[1]) : undefined;
      if (v !== undefined && typeof v === 'object') request = v;
      else {
        const text = renderTemplate(raw, ctx.vars(), { syntax: this.opts.templateSyntax });
        try {
          request = JSON.parse(text);
        } catch {
          throw new EzTestError(`gRPC request must be JSON (got ${text.slice(0, 80)})`, 'GRPC_REQUEST');
        }
      }
    }
    const metadata = a.metadata ? Object.fromEntries(Object.entries(a.metadata as Record<string, string>).map(([k, v]) => [k, ctx.interpolate(v)])) : undefined;
    const method = ctx.interpolate(String(a.method));
    const r = await client.call(method, request, { ...(metadata ? { metadata } : {}), ...(a.timeoutMs !== undefined ? { timeoutMs: Number(a.timeoutMs) } : {}) });
    const mask = this.mask(ctx);
    const key = step.captureAs ?? 'response';
    const value = maskDeep(r.response ?? null, mask);
    const meta = maskDeep({ status: r.status, code: r.code, details: r.details, metadata: r.metadata, streaming: r.streaming }, mask);
    ctx.ledger.set(key, value);
    ctx.ledger.set(`${key}_meta`, meta);
    const ref = await ctx.evidence.store('data', `grpc/${safeName(ctx.journey.id)}/${safeName(step.id)}.json`, JSON.stringify({ method, service: a.service, request, ...(meta as object), response: r.response }, null, 2),
      { journeyId: ctx.journey.id, stepId: step.id, description: `gRPC ${method}` });
    if (a.expectStatus !== undefined) {
      const want = typeof a.expectStatus === 'number' ? await client.statusName(a.expectStatus) : String(a.expectStatus);
      if (r.status !== want) throw new EzTestError(`gRPC ${method} returned ${r.status}${r.details ? ` (${r.details})` : ''}, expected ${want}`, 'GRPC_STATUS', { evidence: ref.id });
    } else if (r.code !== 0 && !a.allowErrors) {
      throw new EzTestError(`gRPC ${method} returned ${r.status}${r.details ? `: ${r.details}` : ''}`, 'GRPC_STATUS', { evidence: ref.id });
    }
    return { captured: { [key]: value, [`${key}_meta`]: meta }, evidence: [ref.id] };
  }

  // ---------------------------------------------------------------- files, SSH, batch

  private sshSession(name: string, kind: 'sftp' | 'ssh'): SshSession {
    const id = `${kind}:${name}`;
    let s = this.ssh.get(id);
    if (!s) {
      const cfg = kind === 'sftp' ? this.opts.files?.sftp?.[name] ?? this.opts.files?.ssh?.[name] : this.opts.files?.ssh?.[name];
      if (!cfg) throw new EzTestError(`No ${kind === 'sftp' ? 'SFTP server' : 'SSH host'} "${name}" in files.${kind} (known: ${Object.keys((kind === 'sftp' ? this.opts.files?.sftp : this.opts.files?.ssh) ?? {}).join(', ') || 'none'})`, 'FILES_CONFIG');
      s = new SshSession(name, cfg, this.opts.baseDir);
      this.ssh.set(id, s);
    }
    return s;
  }

  private async keepFile(step: Step, ctx: StepContext, name: string, fetch: (abs: string) => Promise<void>, extra: Record<string, unknown>): Promise<IntegrationOutcome> {
    const filename = safeName(name);
    const relPath = ctx.evidence.reserve(`downloads/${safeName(ctx.journey.id)}/${safeName(step.id)}-${filename}`);
    const abs = join(ctx.runDir, relPath);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(ctx.runDir, 'downloads', safeName(ctx.journey.id)), { recursive: true });
    await fetch(abs);
    const ref = await ctx.evidence.recordFile('download', abs, { journeyId: ctx.journey.id, stepId: step.id, description: `file ${name}` });
    const rec = { path: abs, relPath: ref.path, filename, evidenceId: ref.id, sha256: ref.sha256, size: (await stat(abs)).size, ...extra };
    const key = step.captureAs ?? 'file';
    ctx.ledger.set(key, rec);
    return { captured: { [key]: rec }, evidence: [ref.id] };
  }

  private async file(step: Step, a: Args, ctx: StepContext): Promise<IntegrationOutcome> {
    const op = String(a.op);
    const I = (v: unknown) => ctx.interpolate(String(v));
    const files = this.opts.files ?? {};
    const local = a.folder !== undefined ? allowedFolder(I(a.folder), this.opts.baseDir, files.allowFolders ?? []) : undefined;
    const sftp = a.server !== undefined ? this.sshSession(I(a.server), 'sftp') : undefined;
    const remoteDir = a.dir !== undefined ? I(a.dir) : undefined;
    switch (op) {
      case 'upload': {
        const src = resolve(this.opts.baseDir, I(a.local));
        const name = a.name !== undefined ? I(a.name) : src.split(/[\\/]/).pop()!;
        if (sftp) await sftp.upload(src, `${remoteDir!.replace(/\/$/, '')}/${name}`);
        else await copyLocal(src, local!, name);
        return {};
      }
      case 'download': {
        const remote = I(a.remote);
        return this.keepFile(step, ctx, remote.split('/').pop() ?? 'file', (abs) => sftp!.download(remote, abs), { remotePath: remote, server: sftp!.name });
      }
      case 'delete': {
        await sftp!.remove(I(a.remote));
        return {};
      }
      case 'list': {
        const all = sftp ? await sftp.list(remoteDir!) : await listLocal(local!);
        const re = a.pattern !== undefined ? fileMatcher(I(a.pattern)) : undefined;
        const out = all.filter((f) => !f.isDirectory && (!re || re.test(f.name)));
        if (step.captureAs) ctx.ledger.set(step.captureAs, out);
        return step.captureAs ? { captured: { [step.captureAs]: out } } : {};
      }
      case 'wait': {
        const re = fileMatcher(I(a.pattern));
        const timeout = Number(a.timeoutMs ?? 60_000);
        const since = Date.now() - (this.opts.fileLookbackMs ?? 600_000);
        const deadline = Date.now() + timeout;
        let found: RemoteFile | undefined;
        let last: RemoteFile[] = [];
        for (;;) {
          last = sftp ? await sftp.list(remoteDir!) : await listLocal(local!);
          // Newest matching file modified within the lookback window (SFTP times have 1 s resolution).
          found = last.filter((f) => !f.isDirectory && re.test(f.name) && Date.parse(f.modifiedAt) >= since - 1000).sort((x, y) => y.modifiedAt.localeCompare(x.modifiedAt))[0];
          if (found || Date.now() >= deadline) break;
          await new Promise((r) => setTimeout(r, Math.min(files.pollMs ?? 1000, Math.max(0, deadline - Date.now()))));
        }
        const where = sftp ? `${remoteDir} on SFTP ${sftp.name}` : `folder ${String(a.folder)}`;
        if (!found) throw new EzTestError(`No file matching "${I(a.pattern)}" appeared in ${where} within ${msText(timeout)} (files there: ${last.map((f) => f.name).slice(0, 10).join(', ') || 'none'})`, 'FILE_TIMEOUT');
        const f = found;
        return this.keepFile(step, ctx, f.name, (abs) => (sftp ? sftp.download(f.path, abs) : copyLocal(f.path, abs.slice(0, abs.lastIndexOf('/')), abs.slice(abs.lastIndexOf('/') + 1)).then(() => undefined)),
          { remotePath: f.path, ...(sftp ? { server: sftp.name } : { folder: local }), modifiedAt: f.modifiedAt });
      }
      case 'remove-local': {
        await removeLocal(resolve(local!, I(a.name)));
        return {};
      }
    }
    throw new NotSupportedError(`file op "${op}"`);
  }

  private async sshExec(step: Step, a: Args, ctx: StepContext, timeoutMs: number): Promise<IntegrationOutcome> {
    const hostName = ctx.interpolate(String(a.host));
    const host = this.opts.files?.ssh?.[hostName];
    if (!host) throw new EzTestError(`No SSH host "${hostName}" in files.ssh`, 'FILES_CONFIG');
    const command = ctx.interpolate(String(a.command));
    if (!commandAllowed(command, host.allowCommands ?? [])) {
      throw new EzTestError(`Command "${command}" is not in files.ssh.${hostName}.allowCommands; EZTest only runs allow-listed commands`, 'SSH_NOT_ALLOWED');
    }
    const r = await this.sshSession(hostName, 'ssh').exec(command, Number(a.timeoutMs ?? Math.max(timeoutMs, 300_000)));
    return this.commandOutcome(step, ctx, `ssh ${hostName}: ${command}`, r, a.exitCode === undefined ? 0 : Number(a.exitCode));
  }

  private async commandOutcome(step: Step, ctx: StepContext, what: string, r: { exitCode: number | null; stdout: string; stderr: string; durationMs: number }, expect: number): Promise<IntegrationOutcome> {
    const mask = this.mask(ctx);
    const v = { exitCode: r.exitCode, stdout: mask(r.stdout), stderr: mask(r.stderr), durationMs: r.durationMs };
    const ref = await ctx.evidence.store('data', `commands/${safeName(ctx.journey.id)}/${safeName(step.id)}.json`, JSON.stringify({ command: what, ...v }, null, 2), { journeyId: ctx.journey.id, stepId: step.id, description: what });
    if (step.captureAs) ctx.ledger.set(step.captureAs, v);
    if (r.exitCode !== expect) throw new EzTestError(`${what} exited with ${r.exitCode}, expected ${expect}${v.stderr ? `: ${v.stderr.trim().slice(0, 300)}` : ''}`, 'COMMAND_FAILED');
    return { ...(step.captureAs ? { captured: { [step.captureAs]: v } } : {}), evidence: [ref.id] };
  }

  /**
   * Watch for a batch job's completion file (batch.jobs.<name>.doneFile): the files matching the
   * pattern before the job starts are noted, and the job is done when a new one appears (or a noted
   * one changes). Remote clocks are never compared with ours.
   */
  private async doneFileWatch(job: string, d: { sftp: string; dir: string; pattern: string }, vars: Record<string, unknown>): Promise<{ server: string; wait(ms: number, totalMs?: number): Promise<RemoteFile> }> {
    const server = renderTemplate(d.sftp, vars);
    const dir = renderTemplate(d.dir, vars);
    const pattern = renderTemplate(d.pattern, vars);
    const s = this.sshSession(server, 'sftp');
    const re = fileMatcher(pattern);
    const matching = async () => (await s.list(dir)).filter((f) => !f.isDirectory && re.test(f.name));
    const before = new Map((await matching()).map((f) => [f.name, `${f.modifiedAt}:${f.size}`]));
    return {
      server,
      wait: async (ms: number, totalMs = ms) => {
        const deadline = Date.now() + ms;
        let seen: RemoteFile[] = [];
        for (;;) {
          seen = await matching();
          const fresh = seen.find((f) => before.get(f.name) !== `${f.modifiedAt}:${f.size}`);
          if (fresh) return fresh;
          if (Date.now() >= deadline) break;
          await new Promise((r) => setTimeout(r, Math.min(this.opts.files?.pollMs ?? 1000, Math.max(0, deadline - Date.now()))));
        }
        throw new EzTestError(
          `Batch job "${job}" finished, but its completion file (matching "${pattern}" in ${dir} on SFTP ${server}) did not appear within ${msText(totalMs)} of the job starting${seen.length ? ` (only files that were there before the job: ${seen.map((f) => f.name).slice(0, 5).join(', ')})` : ''}`,
          'BATCH_NOT_DONE',
        );
      },
    };
  }

  private async batchRun(step: Step, a: Args, ctx: StepContext): Promise<IntegrationOutcome> {
    const name = ctx.interpolate(String(a.job));
    const job = this.opts.batch?.jobs?.[name];
    if (!job) throw new EzTestError(`No batch job "${name}" in batch.jobs (known: ${Object.keys(this.opts.batch?.jobs ?? {}).join(', ') || 'none'})`, 'BATCH_CONFIG');
    const params = Object.fromEntries(Object.entries((a.params ?? {}) as Record<string, string>).map(([k, v]) => [k, ctx.interpolate(v)]));
    const vars = { ...ctx.vars(), ...params };
    const timeout = Number(a.timeoutMs ?? 600_000);
    if ('ssh' in job) {
      const host = this.opts.files?.ssh?.[job.ssh];
      if (!host) throw new EzTestError(`batch.jobs.${name}: no SSH host "${job.ssh}" in files.ssh`, 'BATCH_CONFIG');
      const command = renderTemplate(job.command, vars);
      if (!commandAllowed(command, host.allowCommands ?? [])) throw new EzTestError(`Batch job "${name}" runs "${command}", which is not in files.ssh.${job.ssh}.allowCommands`, 'SSH_NOT_ALLOWED');
      const started = Date.now();
      // The completion file: what is there before the job starts does not count.
      const done = job.doneFile ? await this.doneFileWatch(name, job.doneFile, vars) : undefined;
      const r = await this.sshSession(job.ssh, 'ssh').exec(command, timeout);
      const out = await this.commandOutcome(step, ctx, `batch job ${name}`, r, job.successExitCode ?? 0);
      if (!done) return out;
      const file = await done.wait(Math.max(0, timeout - (Date.now() - started)), timeout);
      const rec = { name: file.name, path: file.path, modifiedAt: file.modifiedAt, server: done.server };
      const ref = await ctx.evidence.store('data', `batch/${safeName(ctx.journey.id)}/${safeName(step.id)}-done.json`, JSON.stringify({ job: name, doneFile: rec }, null, 2), { journeyId: ctx.journey.id, stepId: step.id, description: `batch job ${name}: completion file` });
      const captured = out.captured && step.captureAs ? { [step.captureAs]: { ...(out.captured[step.captureAs] as Record<string, unknown>), doneFile: rec } } : undefined;
      if (captured && step.captureAs) ctx.ledger.set(step.captureAs, captured[step.captureAs]);
      return { ...(captured ? { captured } : {}), evidence: [...(out.evidence ?? []), ref.id] };
    }
    // HTTP job: start, then poll the status URL until a success or failure status.
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(job.asRole && this.opts.apiAuth ? await this.opts.apiAuth(job.asRole, ctx) : {}) };
    const [method, url] = /^(GET|POST|PUT|PATCH)\s+(\S+)$/i.test(job.start.trim()) ? job.start.trim().split(/\s+/) : ['POST', job.start];
    const started = Date.now();
    const res = await envProxyFetch(resolveUrl(renderTemplate(url, vars), ctx.baseUrl), { method: method.toUpperCase(), headers, ...(job.body !== undefined ? { body: renderTemplate(JSON.stringify(job.body), vars) } : {}) });
    const startBody = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok) throw new EzTestError(`Batch job "${name}" did not start: HTTP ${res.status}`, 'BATCH_FAILED');
    const jobId = getPath(startBody, job.idPath ?? '$.id');
    const statusUrl = resolveUrl(renderTemplate(job.statusUrl, { ...vars, jobId }), ctx.baseUrl);
    let status = '';
    let last: unknown;
    while (Date.now() - started < timeout) {
      const r = await envProxyFetch(statusUrl, { headers });
      last = await r.json().catch(() => ({}));
      status = String(getPath(last, job.statusPath ?? '$.status') ?? '').toUpperCase();
      if ((job.success ?? []).map((s) => s.toUpperCase()).includes(status) || (job.failure ?? []).map((s) => s.toUpperCase()).includes(status)) break;
      await new Promise((r2) => setTimeout(r2, job.pollMs ?? 2000));
    }
    const mask = this.mask(ctx);
    const v = maskDeep({ job: name, id: jobId ?? null, status, durationMs: Date.now() - started, result: last }, mask) as Record<string, unknown>;
    const ref = await ctx.evidence.store('data', `batch/${safeName(ctx.journey.id)}/${safeName(step.id)}.json`, JSON.stringify(v, null, 2), { journeyId: ctx.journey.id, stepId: step.id, description: `batch job ${name}` });
    if (step.captureAs) ctx.ledger.set(step.captureAs, v);
    if (!(job.success ?? []).map((s) => s.toUpperCase()).includes(status)) {
      throw new EzTestError(`Batch job "${name}" ${status ? `ended with status ${status}` : `did not finish within ${msText(timeout)}`}`, 'BATCH_FAILED');
    }
    return { ...(step.captureAs ? { captured: { [step.captureAs]: v } } : {}), evidence: [ref.id] };
  }

  // ---------------------------------------------------------------- EDI

  private async edi(step: Step, a: Args, ctx: StepContext): Promise<IntegrationOutcome> {
    let text: string;
    if (a.file !== undefined) text = await readFile(resolve(this.opts.baseDir, ctx.interpolate(String(a.file))), 'utf8');
    else {
      const src = ctx.ledger.get(String(a.from));
      if (typeof src === 'string') text = src;
      else if (src && typeof src === 'object' && typeof (src as { path?: unknown }).path === 'string') text = await readFile((src as { path: string }).path, 'utf8');
      else throw new EzTestError(`${String(a.from)} is not a file or text (download it first)`, 'NOT_A_FILE');
    }
    const doc = parseEdi(text);
    const v = maskDeep(doc, this.mask(ctx));
    const key = step.captureAs ?? 'edi';
    ctx.ledger.set(key, v);
    return { captured: { [key]: v } };
  }

  // ---------------------------------------------------------------- contract sessions

  private async contract(a: Args, ctx: StepContext): Promise<IntegrationOutcome> {
    const recorder = this.opts.contracts;
    if (!recorder) throw new EzTestError('Contract sessions need the EZTest engine (contracts config); none is available', 'NO_HANDLER');
    const op = String(a.op);
    if (op === 'start') {
      recorder.start(ctx.ledger, { consumer: ctx.interpolate(String(a.consumer)), provider: ctx.interpolate(String(a.provider)), ...(a.dir !== undefined ? { dir: ctx.interpolate(String(a.dir)) } : {}) });
      return {};
    }
    if (op === 'state') {
      const params = a.params ? Object.fromEntries(Object.entries(a.params as Record<string, string>).map(([k, v]) => {
        const s = ctx.interpolate(v);
        return [k, /^-?\d+(?:\.\d+)?$/.test(s) ? Number(s) : s];
      })) : undefined;
      recorder.state(ctx.ledger, ctx.interpolate(String(a.state)), params);
      return {};
    }
    if (op === 'stop') {
      const r = await recorder.stop(ctx.ledger);
      if (!r) return {};
      ctx.logger.info(`contract ${r.file}: ${r.expectations} expectation(s) written${r.replaced.length ? ` (${r.replaced.length} changed)` : ''}`);
      return {};
    }
    throw new NotSupportedError(`contract op "${op}"`);
  }

  async close(): Promise<void> {
    for (const s of this.openSubs) await s.close().catch(() => undefined);
    this.openSubs.clear();
    const warn = this.opts.onWarning ?? ((m: string) => process.emitWarning(m, 'EZTestMessaging'));
    for (const d of this.drivers.values()) {
      await d.close().catch((e: Error) => warn(`closing ${d.kind} broker "${d.name}" failed: ${e.message}`));
      for (const w of (d as { closeWarnings?: string[] }).closeWarnings?.splice(0) ?? []) warn(w);
    }
    for (const s of this.ssh.values()) s.close();
    for (const c of this.grpcClients.values()) c.close();
    this.drivers.clear();
    this.ssh.clear();
    this.grpcClients.clear();
  }
}

export function createIntegrationRuntime(opts: IntegrationRuntimeOptions): Integration {
  return new Integration(opts);
}

export { BusError };
