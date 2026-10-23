/**
 * Consumer side of EZTest contracts: a journey opens a contract session
 * ("Start a contract between consumer X and provider Y"), names provider
 * states ("Given provider state ..."), and every API step and every message
 * it waits for (Kafka, AMQP, MQTT, IBM MQ) becomes an expectation in
 * contracts/<consumer>-<provider>.contract.json, with matchers
 * inferred from the recorded data. The file is written by "Finish the
 * contract": a journey that fails before it writes nothing, so a contract only
 * ever records behaviour a passing journey saw. Request credentials never
 * reach the file: only content negotiation headers are kept and all text goes
 * through the secret masker.
 */
import { join, resolve } from 'node:path';
import type { ApiExchange } from '../runner/types.js';
import { findOperation, matchOperation, responseFor, type ApiSpec } from './openapi.js';
import { contractFileName, expectationKey, inferMatchers, upsertExpectations, type Expectation, type MatcherStyle, type MessageChannel, type MessageExpectation, type ProviderState } from './model.js';

export interface ContractSessionOptions {
  consumer: string;
  provider: string;
  /** Directory of contract files (default <project>/contracts). */
  dir: string;
}

interface Session extends ContractSessionOptions {
  states: ProviderState[];
  /** Expectations recorded so far (written by stop()). */
  pending: Expectation[];
}

export interface ContractRecorderOptions {
  baseDir: string;
  defaultDir?: string;
  matchers?: MatcherStyle;
  /** Spec whose schemas refine matchers (style "schema"). */
  spec?: () => ApiSpec | undefined;
  mask?: (s: string) => string;
  /** Request headers kept in the contract (lower-case). Default: content-type, accept. */
  keepHeaders?: string[];
}

const KEEP = ['content-type', 'accept'];

/** Contract sessions per journey attempt (keyed by the attempt's ledger object). */
export class ContractRecorder {
  private readonly sessions = new WeakMap<object, Session>();
  readonly written = new Set<string>();

  constructor(readonly opts: ContractRecorderOptions) {}

  start(owner: object, o: Partial<ContractSessionOptions> & { consumer: string; provider: string }): Session {
    const s: Session = { consumer: o.consumer, provider: o.provider, dir: resolve(this.opts.baseDir, o.dir ?? this.opts.defaultDir ?? 'contracts'), states: [], pending: [] };
    this.sessions.set(owner, s);
    return s;
  }

  session(owner: object): Session | undefined {
    return this.sessions.get(owner);
  }

  state(owner: object, name: string, params?: Record<string, unknown>): void {
    const s = this.sessions.get(owner);
    if (!s) throw new Error('No contract session: start one first ("Start a contract between consumer "web" and provider "orders"")');
    s.states = [{ name, ...(params && Object.keys(params).length ? { params } : {}) }];
  }

  /** End the session and write its expectations to the contract file; returns the file (undefined without a session). */
  async stop(owner: object): Promise<{ file: string; expectations: number; replaced: string[] } | undefined> {
    const s = this.sessions.get(owner);
    this.sessions.delete(owner);
    if (!s || !s.pending.length) return undefined;
    const r = await upsertExpectations(s.dir, s.consumer, s.provider, s.pending);
    this.written.add(r.file);
    return { file: r.file, expectations: s.pending.length, replaced: r.replaced };
  }

  private maskDeep<T>(v: T): T {
    const m = this.opts.mask;
    if (!m) return v;
    return JSON.parse(m(JSON.stringify(v))) as T;
  }

  /** Record an API step's exchange as an expectation (no-op without a session). */
  async recordHttp(owner: object, x: ApiExchange, description: string): Promise<string | undefined> {
    const s = this.sessions.get(owner);
    if (!s) return undefined;
    const u = new URL(x.url, 'http://placeholder');
    const query: Record<string, string[]> = {};
    for (const [k, v] of u.searchParams) (query[k] ??= []).push(v);
    const keep = this.opts.keepHeaders ?? KEEP;
    const reqHeaders = Object.fromEntries(Object.entries(x.call.headers ?? {}).filter(([k]) => keep.includes(k.toLowerCase())));
    const resHeaders = Object.fromEntries(Object.entries(x.response.headers ?? {}).filter(([k]) => k.toLowerCase() === 'content-type'));
    let reqBody = x.call.body;
    if (typeof reqBody === 'string' && /json/i.test(reqHeaders['content-type'] ?? '')) {
      try {
        reqBody = JSON.parse(reqBody);
      } catch {
        // keep text
      }
    }
    if (reqBody instanceof Uint8Array || (typeof FormData !== 'undefined' && reqBody instanceof FormData)) reqBody = undefined;
    const style = this.opts.matchers ?? 'type';
    const spec = style === 'schema' ? this.opts.spec?.() : undefined;
    let schema: Record<string, unknown> | undefined;
    if (spec) {
      const op = matchOperation(spec, x.call.method, x.url)?.operation ?? findOperation(spec, `${x.call.method} ${u.pathname}`);
      const r = op ? responseFor(op, x.response.status) : undefined;
      schema = r ? Object.values(r.response.content)[0]?.schema : undefined;
    }
    const hasBody = x.response.body !== undefined && x.response.body !== '';
    const match = hasBody ? inferMatchers(x.response.body, style, spec ? { spec, schema } : undefined) : {};
    const e: Expectation = this.maskDeep({
      description,
      given: s.states,
      request: {
        method: x.call.method,
        path: u.pathname,
        ...(Object.keys(query).length ? { query } : {}),
        ...(Object.keys(reqHeaders).length ? { headers: reqHeaders } : {}),
        ...(reqBody !== undefined ? { body: reqBody } : {}),
      },
      response: {
        status: x.response.status,
        ...(Object.keys(resHeaders).length ? { headers: resHeaders } : {}),
        ...(hasBody ? { body: x.response.body } : {}),
        ...(Object.keys(match).length ? { match } : {}),
      },
    });
    this.add(s, e);
    return join(s.dir, contractFileName(s.consumer, s.provider));
  }

  /** Record a message a wait received as a message expectation (no-op without a session). */
  async recordMessage(owner: object, m: { description: string; channel: MessageChannel; contents: unknown; contentType?: string }): Promise<string | undefined> {
    const s = this.sessions.get(owner);
    if (!s) return undefined;
    const style = this.opts.matchers === 'exact' ? 'exact' : 'type';
    const match = m.contents !== null && typeof m.contents === 'object' ? inferMatchers(m.contents, style) : {};
    const e: MessageExpectation = this.maskDeep({
      kind: 'message', description: m.description, given: s.states, channel: m.channel,
      message: { contents: m.contents, ...(m.contentType ? { contentType: m.contentType } : {}), ...(Object.keys(match).length ? { match } : {}) },
    });
    this.add(s, e);
    return join(s.dir, contractFileName(s.consumer, s.provider));
  }

  private add(s: Session, e: Expectation): void {
    const k = expectationKey(e);
    s.pending = [...s.pending.filter((p) => expectationKey(p) !== k), e];
  }
}
