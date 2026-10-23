/**
 * Mail and SMS providers:
 *   SmtpSink        a built-in SMTP server EZTest can start; the app under test sends mail to it (no IMAP needed)
 *   TwilioSmsProvider the Twilio Messages API (credentials from secrets)
 *   MemorySmsProvider an in-process inbox (tests, custom gateways)
 */
import { createServer, type Server, type Socket } from 'node:net';
import { EzTestError, nowIso, sleep } from '../core/index.js';
import { parseMime } from './mime.js';
import type { EmailMessage, MailProvider, MailQuery, SmsMessage, SmsProvider, SmsQuery } from './types.js';

function matchesMail(m: EmailMessage, q: MailQuery): boolean {
  if (q.to && !m.to.some((t) => t.toLowerCase().includes(q.to!.toLowerCase()))) return false;
  if (q.subject && !m.subject.toLowerCase().includes(q.subject.toLowerCase())) return false;
  if (q.since !== undefined && Date.parse(m.date) < q.since - 1000) return false;
  return true;
}

/** Poll `list()` until the newest matching item appears. */
async function pollLatest<T>(list: () => Promise<T[]>, match: (m: T) => boolean, q: { timeoutMs?: number; pollMs?: number }, what: string): Promise<T> {
  const deadline = Date.now() + (q.timeoutMs ?? 10_000);
  let lastError: string | undefined;
  for (;;) {
    try {
      const hits = (await list()).filter(match);
      if (hits.length) return hits[hits.length - 1];
      lastError = undefined;
    } catch (e) {
      lastError = (e as Error).message;
    }
    if (Date.now() >= deadline) throw new EzTestError(`No ${what} arrived within ${q.timeoutMs ?? 10_000} ms${lastError ? ` (${lastError})` : ''}`, 'NO_MESSAGE');
    await sleep(q.pollMs ?? 250);
  }
}

const addr = (s: string) => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim();

// ------------------------------------------------------------------ SMTP sink

/** A tiny SMTP server that keeps every message in memory. Never relays mail. */
export class SmtpSink implements MailProvider {
  readonly name = 'smtp-sink';
  readonly messages: EmailMessage[] = [];
  private server?: Server;
  private sockets = new Set<Socket>();
  port = 0;
  host = '127.0.0.1';
  private counter = 0;

  /** Start listening (port 0 = any free port). */
  async start(port = 0, host = '127.0.0.1'): Promise<this> {
    this.host = host;
    this.server = createServer((sock) => this.session(sock));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => resolve());
    });
    const a = this.server.address();
    this.port = typeof a === 'object' && a ? a.port : port;
    return this;
  }

  private session(sock: Socket): void {
    this.sockets.add(sock);
    sock.on('close', () => this.sockets.delete(sock));
    sock.setEncoding('utf8');
    const reply = (s: string) => sock.write(`${s}\r\n`);
    let buf = '';
    let inData = false;
    let from = '';
    let rcpt: string[] = [];
    reply('220 eztest-sink ESMTP ready');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      for (;;) {
        if (inData) {
          // buf starts with the CRLF that ended the DATA command, so "\r\n.\r\n" also finds an empty message.
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) {
            if (buf.length > 25 * 1024 * 1024) {
              reply('552 message too large');
              sock.destroy();
            }
            return;
          }
          const data = buf.slice(2, end);
          buf = buf.slice(end + 5);
          inData = false;
          this.store(from, rcpt, data.replace(/^\.\./gm, '.'));
          rcpt = [];
          reply('250 OK: queued');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') reply('250-eztest-sink\r\n250-8BITMIME\r\n250-SMTPUTF8\r\n250 SIZE 26214400');
        else if (cmd === 'HELO') reply('250 eztest-sink');
        else if (cmd === 'MAIL') {
          from = addr(line.replace(/^MAIL FROM:\s*/i, '').replace(/\s+\w+=\S+/g, ''));
          reply('250 OK');
        } else if (cmd === 'RCPT') {
          rcpt.push(addr(line.replace(/^RCPT TO:\s*/i, '')));
          reply('250 OK');
        } else if (cmd === 'DATA') {
          inData = true;
          buf = '\r\n' + buf;
          reply('354 End data with <CR><LF>.<CR><LF>');
        } else if (cmd === 'RSET') {
          rcpt = [];
          reply('250 OK');
        } else if (cmd === 'NOOP') reply('250 OK');
        else if (cmd === 'AUTH') reply('235 Authentication successful');
        else if (cmd === 'QUIT') {
          reply('221 Bye');
          sock.end();
          return;
        } else if (cmd === 'STAR') reply('454 TLS not available');
        else reply('502 Command not implemented');
      }
    });
    sock.on('error', () => undefined);
  }

  private store(from: string, rcpt: string[], raw: string): void {
    const p = parseMime(raw);
    const to = rcpt.length ? rcpt : (p.headers.to ?? '').split(',').map(addr).filter(Boolean);
    this.messages.push({
      id: `sink-${++this.counter}`, from: p.headers.from ? addr(p.headers.from) : from, to, subject: p.headers.subject ?? '',
      text: p.text, ...(p.html ? { html: p.html } : {}), date: nowIso(),
    });
  }

  latest(q: MailQuery): Promise<EmailMessage> {
    return pollLatest(async () => this.messages, (m) => matchesMail(m, q), q, `email${q.to ? ` to ${q.to}` : ''}${q.subject ? ` with subject "${q.subject}"` : ''}`);
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = undefined;
  }
}

/** Send a plain-text (and optional HTML) email over SMTP. Used by the demo app and handy for tests. */
export async function sendSmtpMail(o: { host?: string; port: number; from: string; to: string; subject: string; text: string; html?: string }): Promise<void> {
  const { connect } = await import('node:net');
  const sock = connect(o.port, o.host ?? '127.0.0.1');
  sock.setEncoding('utf8');
  const lines: string[] = [];
  let buf = '';
  let waiter: ((l: string) => void) | undefined;
  sock.on('data', (c: string) => {
    buf += c;
    let i: number;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (/^\d{3}-/.test(l)) continue;
      if (waiter) {
        const w = waiter;
        waiter = undefined;
        w(l);
      } else lines.push(l);
    }
  });
  const next = () => new Promise<string>((resolve, reject) => {
    const l = lines.shift();
    if (l !== undefined) return resolve(l);
    const t = setTimeout(() => reject(new Error('SMTP timeout')), 5000);
    waiter = (x) => {
      clearTimeout(t);
      resolve(x);
    };
  });
  const cmd = async (s: string, expect: string) => {
    sock.write(`${s}\r\n`);
    const r = await next();
    if (!r.startsWith(expect)) throw new Error(`SMTP ${s.split(' ')[0]} failed: ${r}`);
  };
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', () => resolve());
    sock.once('error', reject);
  });
  const greet = await next();
  if (!greet.startsWith('220')) throw new Error(`SMTP greeting: ${greet}`);
  await cmd('EHLO localhost', '250');
  await cmd(`MAIL FROM:<${o.from}>`, '250');
  await cmd(`RCPT TO:<${o.to}>`, '250');
  await cmd('DATA', '354');
  const boundary = `ez-${Date.now().toString(36)}`;
  const head = [`From: ${o.from}`, `To: ${o.to}`, `Subject: ${o.subject}`, 'MIME-Version: 1.0'];
  const body = o.html
    ? [`Content-Type: multipart/alternative; boundary="${boundary}"`, '', `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', o.text,
      `--${boundary}`, 'Content-Type: text/html; charset=utf-8', '', o.html, `--${boundary}--`]
    : ['Content-Type: text/plain; charset=utf-8', '', o.text];
  const msg = [...head, ...body].join('\r\n').replace(/^\./gm, '..');
  await cmd(`${msg}\r\n.`, '250');
  sock.write('QUIT\r\n');
  sock.end();
}

// ------------------------------------------------------------------ HTTP helper

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new EzTestError(`GET ${url} returned ${res.status}`, 'MAIL_API');
  return res.json();
}

// ------------------------------------------------------------------ SMS

function matchesSms(m: SmsMessage, q: SmsQuery): boolean {
  if (q.to && !m.to.replace(/\s/g, '').includes(q.to.replace(/\s/g, ''))) return false;
  if (q.from && !m.from.replace(/\s/g, '').includes(q.from.replace(/\s/g, ''))) return false;
  if (q.contains && !m.body.includes(q.contains)) return false;
  if (q.since !== undefined && Date.parse(m.date) < q.since - 2000) return false;
  return true;
}

/** Twilio Messages API adapter (inbound messages to your test number). */
export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio';
  constructor(private readonly o: { accountSid: string; authToken: string; baseUrl?: string }) {
    if (!o.accountSid || !o.authToken) throw new EzTestError('Twilio SMS provider needs accountSid and authToken (use secret:// references)', 'CONFIG');
  }

  latest(q: SmsQuery): Promise<SmsMessage> {
    const base = (this.o.baseUrl ?? 'https://api.twilio.com').replace(/\/+$/, '');
    const auth = 'Basic ' + Buffer.from(`${this.o.accountSid}:${this.o.authToken}`).toString('base64');
    return pollLatest(async () => {
      const qs = new URLSearchParams({ PageSize: '20' });
      if (q.to) qs.set('To', q.to);
      if (q.from) qs.set('From', q.from);
      const body = (await getJson(`${base}/2010-04-01/Accounts/${encodeURIComponent(this.o.accountSid)}/Messages.json?${qs}`, { authorization: auth })) as {
        messages?: Array<{ sid: string; from: string; to: string; body: string; date_created?: string; date_sent?: string }>;
      };
      return (body.messages ?? [])
        .map((m) => ({ id: m.sid, from: m.from, to: m.to, body: m.body, date: new Date(m.date_sent ?? m.date_created ?? Date.now()).toISOString() }))
        .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    }, (m) => matchesSms(m, q), q, 'SMS (Twilio)');
  }
}

/** In-process SMS inbox: push messages from a test double or a custom gateway webhook. */
export class MemorySmsProvider implements SmsProvider {
  readonly name = 'memory';
  readonly messages: SmsMessage[] = [];
  private n = 0;

  push(m: Omit<SmsMessage, 'id' | 'date'> & Partial<Pick<SmsMessage, 'id' | 'date'>>): SmsMessage {
    const msg: SmsMessage = { id: m.id ?? `sms-${++this.n}`, date: m.date ?? nowIso(), from: m.from, to: m.to, body: m.body };
    this.messages.push(msg);
    return msg;
  }

  latest(q: SmsQuery): Promise<SmsMessage> {
    return pollLatest(async () => this.messages, (m) => matchesSms(m, q), q, 'SMS');
  }
}
