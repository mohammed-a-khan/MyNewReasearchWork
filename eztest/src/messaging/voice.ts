/**
 * Phone-call (voice) verification: place a call, wait for a call, and check
 * what was said (IVR prompts, spoken one-time codes) and which DTMF digits
 * were sent.
 *
 *   TwilioVoiceProvider  Twilio Programmable Voice over its REST API (Calls,
 *                        Recordings, Transcriptions). Credentials are secret://
 *                        references resolved by the engine and masked.
 *   MemoryVoiceProvider  an in-process call log (tests, custom gateways).
 *   TwilioMockServer     a local HTTP server speaking the subset of the
 *                        Twilio REST API the provider uses, with scripted calls,
 *                        so the real provider code is exercised offline.
 *
 * Transcripts come only from the provider's own transcription service or
 * from a deterministic local fixture (recording id or audio SHA-256 -> text).
 * No third-party speech or AI service is ever called.
 *
 * Placing a call dials a real phone number and costs money, so outbound calls
 * are refused unless the number is on the configured allow-list.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EzTestError, nowIso, sleep } from '../core/index.js';

export interface VoiceCall {
  id: string;
  from: string;
  to: string;
  direction: 'inbound' | 'outbound';
  /** queued | ringing | in-progress | completed | busy | failed | no-answer | canceled */
  status: string;
  startedAt: string;
  durationSec?: number;
  /** DTMF digits sent on the call (SendDigits for outbound calls; reported by the provider for inbound ones). */
  digits?: string;
  /** Transcript as the transcription service returned it. */
  transcript?: string;
  /** Where the transcript came from. */
  transcriptSource?: 'provider' | 'fixture';
  recordingId?: string;
}

export interface PlaceCallRequest {
  to: string;
  from?: string;
  /** Text the call says when answered (TwiML <Say>). */
  say?: string;
  /** DTMF digits to send once connected ("w" waits half a second, as Twilio SendDigits). */
  digits?: string;
  /** Record the far end and transcribe it (default true: needed for transcript checks). */
  record?: boolean;
  /** Maximum recording length in seconds. Default 60. */
  maxSeconds?: number;
}

export interface CallQuery {
  to?: string;
  from?: string;
  direction?: 'inbound' | 'outbound';
  /** Only calls started at or after this epoch ms. */
  since?: number;
  timeoutMs?: number;
  pollMs?: number;
}

export interface VoiceProvider {
  readonly name: string;
  /** Start an outbound call; resolves with the call as first created. */
  placeCall(req: PlaceCallRequest): Promise<VoiceCall>;
  /** The newest call matching the query, polling until one exists. */
  waitForCall(q: CallQuery): Promise<VoiceCall>;
  /** Poll a call until it has ended and its transcript (when recorded) is ready. */
  complete(call: VoiceCall, o?: { timeoutMs?: number; pollMs?: number }): Promise<VoiceCall>;
}

/** Deterministic transcripts: recording id or sha256 of the recording audio -> text. */
export interface TranscriptFixtures {
  byRecording?: Record<string, string>;
  bySha256?: Record<string, string>;
}

export async function loadTranscriptFixtures(path: string): Promise<TranscriptFixtures> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as TranscriptFixtures;
  if (!raw || typeof raw !== 'object') throw new EzTestError(`transcript fixtures ${path}: expected an object with byRecording / bySha256`, 'CONFIG');
  return { byRecording: raw.byRecording ?? {}, bySha256: raw.bySha256 ?? {} };
}

const normNumber = (s: string) => s.replace(/[^\d+]/g, '');
const sameNumber = (a: string, b: string) => {
  const x = normNumber(a);
  const y = normNumber(b);
  return !!x && !!y && (x === y || x.endsWith(y) || y.endsWith(x));
};

function matchesCall(c: VoiceCall, q: CallQuery): boolean {
  if (q.to && !sameNumber(c.to, q.to)) return false;
  if (q.from && !sameNumber(c.from, q.from)) return false;
  if (q.direction && c.direction !== q.direction) return false;
  if (q.since !== undefined && Date.parse(c.startedAt) < q.since - 2000) return false;
  return true;
}

const ENDED = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);

// ------------------------------------------------------------------ transcript normalisation

const WORD_DIGITS: Record<string, string> = { zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4', for: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };

/**
 * Normalise a spoken transcript so codes can be extracted: number words
 * become digits ("four eight two" -> "4 8 2") and runs of single digits
 * separated by spaces, commas, dots or dashes are joined ("4, 8, 2" -> "482").
 * "for", "o" and "oh" are only read as digits inside a run of digits.
 */
export function normalizeSpokenText(text: string): string {
  const tokens = text.split(/(\s+|[,.;:!?-]+)/);
  const WEAK = new Set(['for', 'o', 'oh']);
  const isDigitWord = (t: string) => /^\d$/.test(t) || (t.toLowerCase() in WORD_DIGITS && !WEAK.has(t.toLowerCase()));
  const out: string[] = [];
  let run = '';
  let pending = '';
  const flush = () => {
    if (run) {
      out.push(run);
      run = '';
    }
    if (pending) {
      out.push(pending);
      pending = '';
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    const lower = t.toLowerCase();
    if (/^(\s+|[,.;:!?-]+)$/.test(t)) {
      if (run) pending += t;
      else out.push(t);
      continue;
    }
    // "for", "o" and "oh" count only inside a run of digits: after one digit and before another.
    const nextWord = tokens.slice(i + 1).find((x) => x && !/^(\s+|[,.;:!?-]+)$/.test(x));
    const weak = WEAK.has(lower) && !!run && !!nextWord && (/^\d+$/.test(nextWord) || isDigitWord(nextWord));
    if (isDigitWord(t) || weak) {
      run += /^\d$/.test(t) ? t : WORD_DIGITS[lower];
      pending = '';
      continue;
    }
    if (/^\d+$/.test(t) && run) {
      run += t;
      pending = '';
      continue;
    }
    flush();
    out.push(t);
  }
  flush();
  return out.join('').replace(/\s+/g, ' ').trim();
}

/** Sentences of a transcript (IVR prompts), trimmed. */
export function transcriptPrompts(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

/** The call as a journey value: `text` is the normalised transcript, so "Extract the code from ${call}" works. */
export function callValue(c: VoiceCall): Record<string, unknown> {
  const transcript = c.transcript ?? '';
  return {
    id: c.id, from: c.from, to: c.to, direction: c.direction, status: c.status, startedAt: c.startedAt,
    ...(c.durationSec !== undefined ? { durationSec: c.durationSec } : {}), digits: c.digits ?? '',
    transcript, text: normalizeSpokenText(transcript), prompts: transcriptPrompts(transcript),
    ...(c.transcriptSource ? { transcriptSource: c.transcriptSource } : {}), ...(c.recordingId ? { recordingId: c.recordingId } : {}),
  };
}

// ------------------------------------------------------------------ allow-list

/** Outbound numbers allowed: exact E.164 numbers or prefixes ending in "*". */
export function assertDialAllowed(to: string, allowed: string[]): void {
  const n = normNumber(to);
  if (!n) throw new EzTestError(`"${to}" is not a phone number`, 'INVALID_INPUT');
  const ok = allowed.some((a) => (a.endsWith('*') ? n.startsWith(normNumber(a.slice(0, -1))) : normNumber(a) === n));
  if (!ok) throw new EzTestError(`Calling ${to} is not allowed: add it to voice.allowedNumbers (outbound calls dial real phones)`, 'NOT_ALLOWED');
}

const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** TwiML for an outbound test call: optional <Say>, then <Record> with Twilio's own transcription. */
export function outboundTwiml(req: PlaceCallRequest): string {
  const say = req.say ? `<Say>${escXml(req.say)}</Say>` : '';
  const rec = req.record === false ? '<Pause length="1"/>' : `<Record transcribe="true" playBeep="false" timeout="5" maxLength="${Math.max(1, Math.min(3600, req.maxSeconds ?? 60))}"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${say}${rec}</Response>`;
}

// ------------------------------------------------------------------ Twilio

interface TwilioCall { sid: string; from: string; to: string; direction?: string; status: string; start_time?: string | null; date_created?: string; duration?: string | null }
interface TwilioRecording { sid: string; call_sid?: string; status?: string; duration?: string }
interface TwilioTranscription { sid: string; status: string; transcription_text?: string | null }

export interface TwilioVoiceOptions {
  accountSid: string;
  authToken: string;
  /** Default caller id for placed calls. */
  from?: string;
  baseUrl?: string;
  /** Outbound numbers allowed (exact or prefix*). Placing any other call is refused. */
  allowedNumbers?: string[];
  /** Transcripts from local fixtures instead of Twilio transcription (deterministic tests). */
  fixtures?: TranscriptFixtures;
  /** Fetch the recording audio to match fixtures by SHA-256. Default true when bySha256 fixtures exist. */
  fetchAudio?: boolean;
  /** Poll interval while waiting for calls, recordings and transcripts. Default 2000 ms. */
  pollMs?: number;
}

export class TwilioVoiceProvider implements VoiceProvider {
  readonly name = 'twilio';
  private readonly base: string;
  private readonly auth: string;

  constructor(private readonly o: TwilioVoiceOptions) {
    if (!o.accountSid || !o.authToken) throw new EzTestError('Twilio voice provider needs accountSid and authToken (use secret:// references)', 'CONFIG');
    this.base = `${(o.baseUrl ?? 'https://api.twilio.com').replace(/\/+$/, '')}/2010-04-01/Accounts/${encodeURIComponent(o.accountSid)}`;
    this.auth = 'Basic ' + Buffer.from(`${o.accountSid}:${o.authToken}`).toString('base64');
  }

  private async api<T>(path: string, init: { method?: string; form?: Record<string, string> } = {}): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: this.auth, accept: 'application/json', ...(init.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      ...(init.form ? { body: new URLSearchParams(init.form).toString() } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const msg = (() => {
        try {
          return (JSON.parse(body) as { message?: string }).message ?? body;
        } catch {
          return body;
        }
      })();
      throw new EzTestError(`Twilio ${init.method ?? 'GET'} ${path.split('?')[0]} returned ${res.status}${msg ? `: ${msg.slice(0, 200)}` : ''}`, 'VOICE_API');
    }
    return (await res.json()) as T;
  }

  private toCall(c: TwilioCall, digits?: string): VoiceCall {
    return {
      id: c.sid, from: c.from, to: c.to, direction: /^outbound/.test(c.direction ?? '') ? 'outbound' : 'inbound', status: c.status,
      startedAt: new Date(c.start_time ?? c.date_created ?? Date.now()).toISOString(),
      ...(c.duration ? { durationSec: Number(c.duration) } : {}), ...(digits ? { digits } : {}),
    };
  }

  async placeCall(req: PlaceCallRequest): Promise<VoiceCall> {
    assertDialAllowed(req.to, this.o.allowedNumbers ?? []);
    const from = req.from ?? this.o.from;
    if (!from) throw new EzTestError('Placing a call needs a caller id: "from" in the step or voice.from in the config', 'CONFIG');
    const form: Record<string, string> = { To: req.to, From: from, Twiml: outboundTwiml(req) };
    if (req.digits) {
      if (!/^[0-9*#wW]+$/.test(req.digits)) throw new EzTestError(`"${req.digits}" is not a DTMF sequence (0-9 * # and w for a pause)`, 'INVALID_INPUT');
      form.SendDigits = req.digits;
    }
    const c = await this.api<TwilioCall>('/Calls.json', { method: 'POST', form });
    return this.toCall(c, req.digits);
  }

  async waitForCall(q: CallQuery): Promise<VoiceCall> {
    const deadline = Date.now() + (q.timeoutMs ?? 60_000);
    let last: string | undefined;
    for (;;) {
      try {
        const qs = new URLSearchParams({ PageSize: '20' });
        if (q.to) qs.set('To', q.to);
        if (q.from) qs.set('From', q.from);
        const list = await this.api<{ calls?: TwilioCall[] }>(`/Calls.json?${qs}`);
        const hits = (list.calls ?? []).map((c) => this.toCall(c)).filter((c) => matchesCall(c, q)).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
        if (hits.length) return hits[hits.length - 1];
        last = undefined;
      } catch (e) {
        last = (e as Error).message;
      }
      if (Date.now() >= deadline) throw new EzTestError(`No call${q.to ? ` to ${q.to}` : ''}${q.from ? ` from ${q.from}` : ''} within ${q.timeoutMs ?? 60_000} ms${last ? ` (${last})` : ''}`, 'NO_MESSAGE');
      await sleep(q.pollMs ?? this.o.pollMs ?? 1000);
    }
  }

  async complete(call: VoiceCall, o: { timeoutMs?: number; pollMs?: number } = {}): Promise<VoiceCall> {
    const deadline = Date.now() + (o.timeoutMs ?? 180_000);
    const poll = o.pollMs ?? this.o.pollMs ?? 2000;
    let cur = call;
    // 1. the call ends
    for (;;) {
      const c = await this.api<TwilioCall>(`/Calls/${encodeURIComponent(call.id)}.json`);
      cur = { ...this.toCall(c, call.digits), direction: call.direction };
      if (ENDED.has(cur.status)) break;
      if (Date.now() >= deadline) throw new EzTestError(`call ${call.id} still ${cur.status} after ${o.timeoutMs ?? 180_000} ms`, 'TIMEOUT');
      await sleep(poll);
    }
    if (cur.status !== 'completed') return cur;
    // 2. its recording, then the transcript (Twilio's own transcription, or a local fixture)
    for (;;) {
      const recs = (await this.api<{ recordings?: TwilioRecording[] }>(`/Calls/${encodeURIComponent(call.id)}/Recordings.json`)).recordings ?? [];
      const rec = recs.find((r) => (r.status ?? 'completed') === 'completed');
      if (rec) {
        cur.recordingId = rec.sid;
        const fixture = await this.fixtureFor(rec.sid);
        if (fixture !== undefined) return { ...cur, transcript: fixture, transcriptSource: 'fixture' };
        const tr = ((await this.api<{ transcriptions?: TwilioTranscription[] }>(`/Recordings/${encodeURIComponent(rec.sid)}/Transcriptions.json`)).transcriptions ?? [])[0];
        if (tr?.status === 'completed') return { ...cur, transcript: tr.transcription_text ?? '', transcriptSource: 'provider' };
        if (tr?.status === 'failed') throw new EzTestError(`Twilio could not transcribe the recording of call ${call.id}`, 'VOICE_TRANSCRIPTION');
      }
      if (Date.now() >= deadline) throw new EzTestError(`no ${rec ? 'transcript' : 'recording'} for call ${call.id} within ${o.timeoutMs ?? 180_000} ms (is recording with transcription on for this number?)`, 'TIMEOUT');
      await sleep(poll);
    }
  }

  private async fixtureFor(recordingSid: string): Promise<string | undefined> {
    const f = this.o.fixtures;
    if (!f) return undefined;
    if (f.byRecording?.[recordingSid] !== undefined) return f.byRecording[recordingSid];
    if (!f.bySha256 || !Object.keys(f.bySha256).length || this.o.fetchAudio === false) return undefined;
    const res = await fetch(`${this.base}/Recordings/${encodeURIComponent(recordingSid)}.wav`, { headers: { authorization: this.auth }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return undefined;
    const sha = createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
    return f.bySha256[sha];
  }
}

// ------------------------------------------------------------------ in-process

/** In-process call log: push calls from a test double or a custom gateway. */
export class MemoryVoiceProvider implements VoiceProvider {
  readonly name = 'memory';
  readonly calls: VoiceCall[] = [];
  private n = 0;

  constructor(private readonly o: { allowedNumbers?: string[]; from?: string; answer?: (req: PlaceCallRequest) => Partial<VoiceCall> } = {}) {}

  /** Record a call (for example one the app under test made to the test number). */
  push(c: Omit<VoiceCall, 'id' | 'startedAt' | 'status' | 'direction'> & Partial<VoiceCall>): VoiceCall {
    const call: VoiceCall = { id: c.id ?? `call-${++this.n}`, startedAt: c.startedAt ?? nowIso(), status: c.status ?? 'completed', direction: c.direction ?? 'inbound', ...c } as VoiceCall;
    this.calls.push(call);
    return call;
  }

  async placeCall(req: PlaceCallRequest): Promise<VoiceCall> {
    assertDialAllowed(req.to, this.o.allowedNumbers ?? []);
    return this.push({ from: req.from ?? this.o.from ?? '+10000000000', to: req.to, direction: 'outbound', ...(req.digits ? { digits: req.digits } : {}), ...(this.o.answer?.(req) ?? {}) });
  }

  async waitForCall(q: CallQuery): Promise<VoiceCall> {
    const deadline = Date.now() + (q.timeoutMs ?? 10_000);
    for (;;) {
      const hits = this.calls.filter((c) => matchesCall(c, q));
      if (hits.length) return hits[hits.length - 1];
      if (Date.now() >= deadline) throw new EzTestError(`No call${q.to ? ` to ${q.to}` : ''} within ${q.timeoutMs ?? 10_000} ms`, 'NO_MESSAGE');
      await sleep(q.pollMs ?? 100);
    }
  }

  async complete(call: VoiceCall): Promise<VoiceCall> {
    return this.calls.find((c) => c.id === call.id) ?? call;
  }
}

// ------------------------------------------------------------------ local Twilio REST mock

export interface MockCallScript {
  /** Transcript the "far end" produces (an IVR's prompts, a spoken code). */
  transcript: string;
  /** Seconds the call lasts. Default 4. */
  durationSec?: number;
  /** Polls before the call completes (simulates ringing / in-progress). Default 2. */
  pollsUntilDone?: number;
  /** Polls before the transcription completes after the call. Default 1. */
  pollsUntilTranscribed?: number;
  /** The provider fails to transcribe. */
  transcriptionFails?: boolean;
  /** Recording audio served at /Recordings/<sid>.wav (for SHA-256 fixtures). */
  audio?: Buffer;
}

interface MockCall {
  sid: string;
  from: string;
  to: string;
  direction: string;
  created: string;
  polls: number;
  trPolls: number;
  script: MockCallScript;
  recordingSid: string;
  sendDigits?: string;
  twiml?: string;
}

/**
 * A local stand-in for the Twilio REST API (the endpoints TwilioVoiceProvider
 * uses), with HTTP Basic auth checked. Outbound calls are answered by
 * `answer(to)`; inbound calls (the app calling your test number) are added
 * with `receive()`.
 */
export class TwilioMockServer {
  private server?: Server;
  readonly calls: MockCall[] = [];
  readonly requests: Array<{ method: string; path: string; form?: Record<string, string> }> = [];
  private n = 0;
  url = '';

  constructor(private readonly o: { accountSid: string; authToken: string; answer?: (to: string, form: Record<string, string>) => MockCallScript }) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
  }

  private newCall(from: string, to: string, direction: string, script: MockCallScript, extra: Partial<MockCall> = {}): MockCall {
    const id = String(++this.n).padStart(30, '0');
    const c: MockCall = { sid: `CA${id}`, recordingSid: `RE${id}`, from, to, direction, created: new Date().toUTCString(), polls: 0, trPolls: 0, script, ...extra };
    this.calls.push(c);
    return c;
  }

  /** An inbound call to `to` (e.g. the app under test calling the test number). */
  receive(from: string, to: string, script: MockCallScript & { digits?: string }): string {
    return this.newCall(from, to, 'inbound', script, script.digits ? { sendDigits: script.digits } : {}).sid;
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private status(c: MockCall): string {
    const done = c.script.pollsUntilDone ?? 2;
    return c.polls >= done ? 'completed' : c.polls === 0 ? 'queued' : 'in-progress';
  }

  private view(c: MockCall) {
    const st = this.status(c);
    return { sid: c.sid, from: c.from, to: c.to, direction: c.direction === 'inbound' ? 'inbound' : 'outbound-api', status: st, date_created: c.created, start_time: c.created, duration: st === 'completed' ? String(c.script.durationSec ?? 4) : null };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const form = req.headers['content-type']?.includes('form') ? Object.fromEntries(new URLSearchParams(body)) : undefined;
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname, ...(form ? { form } : {}) });
    const want = Buffer.from('Basic ' + Buffer.from(`${this.o.accountSid}:${this.o.authToken}`).toString('base64'));
    const got = Buffer.from(req.headers.authorization ?? '');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return this.json(res, 401, { code: 20003, message: 'Authenticate', status: 401 });
    const prefix = `/2010-04-01/Accounts/${this.o.accountSid}`;
    if (!url.pathname.startsWith(prefix)) return this.json(res, 404, { message: 'The requested resource was not found', status: 404 });
    const p = url.pathname.slice(prefix.length);
    let m: RegExpExecArray | null;
    if (p === '/Calls.json' && req.method === 'POST') {
      if (!form?.To || !form.From) return this.json(res, 400, { code: 21201, message: 'No called number is specified', status: 400 });
      const script = this.o.answer?.(form.To, form) ?? { transcript: '' };
      const c = this.newCall(form.From, form.To, 'outbound-api', script, { ...(form.SendDigits ? { sendDigits: form.SendDigits } : {}), ...(form.Twiml ? { twiml: form.Twiml } : {}) });
      return this.json(res, 201, this.view(c));
    }
    if (p === '/Calls.json') {
      const to = url.searchParams.get('To');
      const from = url.searchParams.get('From');
      const list = this.calls.filter((c) => (!to || c.to === to) && (!from || c.from === from)).reverse();
      return this.json(res, 200, { calls: list.map((c) => this.view(c)) });
    }
    if ((m = /^\/Calls\/(CA\w+)\.json$/.exec(p))) {
      const c = this.calls.find((x) => x.sid === m![1]);
      if (!c) return this.json(res, 404, { message: 'not found', status: 404 });
      const v = this.view(c);
      c.polls++;
      return this.json(res, 200, v);
    }
    if ((m = /^\/Calls\/(CA\w+)\/Recordings\.json$/.exec(p))) {
      const c = this.calls.find((x) => x.sid === m![1]);
      if (!c) return this.json(res, 404, { message: 'not found', status: 404 });
      return this.json(res, 200, { recordings: this.status(c) === 'completed' ? [{ sid: c.recordingSid, call_sid: c.sid, status: 'completed', duration: String(c.script.durationSec ?? 4) }] : [] });
    }
    if ((m = /^\/Recordings\/(RE\w+)\/Transcriptions\.json$/.exec(p))) {
      const c = this.calls.find((x) => x.recordingSid === m![1]);
      if (!c) return this.json(res, 404, { message: 'not found', status: 404 });
      const ready = c.trPolls++ >= (c.script.pollsUntilTranscribed ?? 1);
      const status = !ready ? 'in-progress' : c.script.transcriptionFails ? 'failed' : 'completed';
      return this.json(res, 200, { transcriptions: [{ sid: `TR${c.recordingSid.slice(2)}`, status, transcription_text: status === 'completed' ? c.script.transcript : null }] });
    }
    if ((m = /^\/Recordings\/(RE\w+)\.wav$/.exec(p))) {
      const c = this.calls.find((x) => x.recordingSid === m![1]);
      if (!c?.script.audio) return this.json(res, 404, { message: 'not found', status: 404 });
      res.writeHead(200, { 'content-type': 'audio/x-wav' });
      res.end(c.script.audio);
      return;
    }
    return this.json(res, 404, { message: 'The requested resource was not found', status: 404 });
  }

  /** DTMF digits the mock "heard" on a call (SendDigits of placed calls, scripted digits of received ones). */
  digitsOf(sid: string): string | undefined {
    return this.calls.find((c) => c.sid === sid)?.sendDigits;
  }
}
