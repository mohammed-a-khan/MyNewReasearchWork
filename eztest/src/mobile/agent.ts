/**
 * Client of the EZTest device agent protocol (JSON over HTTP, version 1),
 * served on the device by the EZTest Android agent (agents/android) and the
 * EZTest iOS agent (agents/ios). The protocol is EZTest's own; it is
 * documented in docs/mobile.md ("Agent protocol") and both agents implement
 * exactly these routes:
 *
 *   GET  /status                       -> { ready, agent, version, platform, device }
 *   POST /find {using, value}          -> { elements: [id] }
 *   POST /element/:id/click | /clear | /type {text}
 *   GET  /element/:id/text | /rect | /displayed | /enabled | /selected | /attribute/:name -> { value }
 *   GET  /source -> { value: xml }     GET /screenshot -> { value: base64 png }   GET /window -> rect
 *   POST /gesture {fingers: [[{x,y,t}]]}   POST /key {key}   POST /keys {text}
 *   GET|POST /orientation {value}      GET /alert -> { value: text|null }   POST /alert/accept | /alert/dismiss
 *   POST /keyboard/hide   POST /app/launch|activate|terminate {appId}   POST /app/background {seconds}
 *   POST /deeplink {url, appId}   POST /notifications/open   POST /lock {seconds}   POST /unlock   POST /shake
 *   POST /geolocation {latitude, longitude}
 *
 * Errors are non-2xx responses with `{ error: { code, message } }`; codes:
 * "no such element", "stale element", "invalid argument", "not supported",
 * "unknown command", "timeout", "internal", "unauthorized".
 *
 * Every request carries the session token in the `X-EZTest-Agent-Token`
 * header. The agents listen on the device loopback only and answer nothing
 * (HTTP 401, "unauthorized") without the token they were started with: a
 * random one EZTest generates for each agent it starts, or
 * `mobile.<platform>.agentToken` for an agent started by hand.
 */
import { randomBytes } from 'node:crypto';
import { DeviceError, type FindStrategy, type Gesture, type Rect } from './session.js';

/** The header that carries the agent session token. */
export const AGENT_TOKEN_HEADER = 'x-eztest-agent-token';

/** A fresh random session token for an agent EZTest starts. */
export function newAgentToken(): string {
  return randomBytes(24).toString('hex');
}

export const AGENT_PROTOCOL_VERSION = 1;

export interface AgentStatus {
  ready: boolean;
  agent: string;
  version: string;
  protocol?: number;
  platform: string;
  device?: Record<string, unknown>;
}

export interface AgentClientOptions {
  /** e.g. http://127.0.0.1:41234 (a local port forwarded to the agent). */
  url: string;
  timeoutMs?: number;
  /** The agent's session token (sent with every request). */
  token?: string;
  /** Called after every request (command log evidence). */
  onCommand?: (e: AgentCommandLog) => void;
}

export interface AgentCommandLog {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  error?: string;
}

export class AgentClient {
  readonly url: string;

  constructor(readonly options: AgentClientOptions) {
    this.url = options.url.replace(/\/+$/, '');
  }

  async call<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const t0 = Date.now();
    const timeout = timeoutMs ?? this.options.timeoutMs ?? 30_000;
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, {
        method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.options.token ? { [AGENT_TOKEN_HEADER]: this.options.token } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      const err = e as Error;
      const why = err.name === 'TimeoutError' ? `timed out after ${timeout} ms` : ((err.cause as Error)?.message ?? err.message);
      this.options.onCommand?.({ method, path, status: 0, durationMs: Date.now() - t0, error: why });
      throw new DeviceError(`device agent ${method} ${path} failed: ${why}`, 'connection failed');
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new DeviceError(`device agent ${method} ${path} returned non-JSON (HTTP ${res.status})`, 'internal', res.status);
    }
    const err = json.error as { code?: string; message?: string } | undefined;
    if (res.status === 401) {
      this.options.onCommand?.({ method, path, status: 401, durationMs: Date.now() - t0, error: 'unauthorized' });
      throw new DeviceError(`the device agent refused ${method} ${path}: ${this.options.token ? 'its session token does not match (the agent was started by another session?)' : 'no session token was sent'}${err?.message ? ` (${err.message})` : ''}. For an agent started by hand, set mobile.<platform>.agentToken to the token it was started with.`, 'unauthorized', 401);
    }
    if (!res.ok || err) {
      const code = err?.code ?? (res.status === 404 ? 'unknown command' : 'internal');
      this.options.onCommand?.({ method, path, status: res.status, durationMs: Date.now() - t0, error: code });
      throw new DeviceError(`${code}: ${err?.message ?? `HTTP ${res.status}`} (${method} ${path})`, code, res.status);
    }
    this.options.onCommand?.({ method, path, status: res.status, durationMs: Date.now() - t0 });
    return ('value' in json ? json.value : json) as T;
  }

  private el(id: string, rest: string): string {
    return `/element/${encodeURIComponent(id)}${rest}`;
  }

  status(timeoutMs?: number): Promise<AgentStatus> { return this.call('GET', '/status', undefined, timeoutMs); }
  async find(using: FindStrategy, value: string): Promise<string[]> {
    const r = await this.call<{ elements?: string[] }>('POST', '/find', { using, value });
    return r.elements ?? [];
  }
  click(id: string): Promise<void> { return this.call('POST', this.el(id, '/click'), {}); }
  clear(id: string): Promise<void> { return this.call('POST', this.el(id, '/clear'), {}); }
  type(id: string, text: string): Promise<void> { return this.call('POST', this.el(id, '/type'), { text }); }
  async text(id: string): Promise<string> { return String((await this.call<unknown>('GET', this.el(id, '/text'))) ?? ''); }
  async attribute(id: string, name: string): Promise<string | null> {
    const v = await this.call<unknown>('GET', this.el(id, `/attribute/${encodeURIComponent(name)}`));
    return v === null || v === undefined ? null : String(v);
  }
  rect(id: string): Promise<Rect> { return this.call('GET', this.el(id, '/rect')); }
  async displayed(id: string): Promise<boolean> { return Boolean(await this.call('GET', this.el(id, '/displayed'))); }
  async enabled(id: string): Promise<boolean> { return Boolean(await this.call('GET', this.el(id, '/enabled'))); }
  async selected(id: string): Promise<boolean> { return Boolean(await this.call('GET', this.el(id, '/selected'))); }
  async source(): Promise<string> { return String(await this.call<unknown>('GET', '/source')); }
  async screenshot(): Promise<Buffer> { return Buffer.from(String(await this.call<unknown>('GET', '/screenshot')), 'base64'); }
  window(): Promise<Rect> { return this.call('GET', '/window'); }
  gesture(g: Gesture): Promise<void> { return this.call('POST', '/gesture', g, 60_000); }
  key(key: string): Promise<void> { return this.call('POST', '/key', { key }); }
  keys(text: string): Promise<void> { return this.call('POST', '/keys', { text }); }
  async orientation(): Promise<'portrait' | 'landscape'> { return (await this.call<string>('GET', '/orientation')) === 'landscape' ? 'landscape' : 'portrait'; }
  setOrientation(value: 'portrait' | 'landscape'): Promise<void> { return this.call('POST', '/orientation', { value }); }
  async alertText(): Promise<string | undefined> {
    const v = await this.call<unknown>('GET', '/alert');
    return v === null || v === undefined ? undefined : String(v);
  }
  acceptAlert(): Promise<void> { return this.call('POST', '/alert/accept', {}); }
  dismissAlert(): Promise<void> { return this.call('POST', '/alert/dismiss', {}); }
  hideKeyboard(): Promise<void> { return this.call('POST', '/keyboard/hide', {}); }
  app(op: 'launch' | 'activate' | 'terminate', appId: string): Promise<void> { return this.call('POST', `/app/${op}`, { appId }, 60_000); }
  background(seconds: number): Promise<void> { return this.call('POST', '/app/background', { seconds }, Math.max(30_000, seconds * 1000 + 30_000)); }
  deepLink(url: string, appId?: string): Promise<void> { return this.call('POST', '/deeplink', { url, ...(appId ? { appId } : {}) }); }
  openNotifications(): Promise<void> { return this.call('POST', '/notifications/open', {}); }
  lock(seconds?: number): Promise<void> { return this.call('POST', '/lock', seconds !== undefined ? { seconds } : {}, 60_000); }
  unlock(): Promise<void> { return this.call('POST', '/unlock', {}); }
  shake(): Promise<void> { return this.call('POST', '/shake', {}); }
  geolocation(latitude: number, longitude: number): Promise<void> { return this.call('POST', '/geolocation', { latitude, longitude }); }
}

/** Poll an agent until it answers /status (it may still be starting). */
export async function waitForAgent(client: AgentClient, timeoutMs: number): Promise<AgentStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const s = await client.status(2000);
      if (s.ready) return s;
      last = new Error('agent not ready');
    } catch (e) {
      // A refused token does not get better by waiting.
      if ((e as DeviceError).code === 'unauthorized') throw e;
      last = e;
    }
    if (Date.now() >= deadline) throw new DeviceError(`the EZTest device agent did not answer within ${timeoutMs} ms (${(last as Error).message})`, 'agent not ready');
    await new Promise((r) => setTimeout(r, 300));
  }
}
