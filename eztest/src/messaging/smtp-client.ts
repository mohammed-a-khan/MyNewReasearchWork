/**
 * An SMTP client for sending reports (RFC 5321): EHLO, STARTTLS when the
 * server offers it (or implicit TLS on port 465), AUTH PLAIN or LOGIN,
 * several recipients, and a MIME message (RFC 2045-2049) with a plain-text
 * and an HTML alternative plus base64 attachments. Replies are read whole
 * (multi-line replies included) and every command's reply code is checked.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { randomBytes } from 'node:crypto';
import { EzTestError } from '../core/index.js';

export interface SmtpAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface SmtpMessage {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: SmtpAttachment[];
}

export interface SmtpOptions {
  host: string;
  port: number;
  /** Implicit TLS from the start (port 465). Default: port === 465. */
  secure?: boolean;
  /** Upgrade with STARTTLS when the server offers it (default true); "required" fails when it does not. */
  starttls?: boolean | 'required';
  username?: string;
  password?: string;
  /** Name sent with EHLO (default "eztest.local"). */
  clientName?: string;
  /** Accept self-signed certificates (test servers). Default false. */
  insecureTls?: boolean;
  timeoutMs?: number;
}

const ADDRESS = /^[^\s<>@]+@[^\s<>@]+$/;
const addrOf = (a: string) => (/<([^>]+)>/.exec(a)?.[1] ?? a).trim();

/** RFC 2047 encoded-word for a header value that is not plain ASCII. */
export function encodeHeader(v: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

const b64lines = (b: Buffer) => b.toString('base64').replace(/.{76}/g, '$&\r\n');

/** Build the MIME message (CRLF line ends, dot-stuffing not applied). */
export function buildMime(m: SmtpMessage, o: { date?: Date; messageId?: string } = {}): string {
  const id = randomBytes(8).toString('hex');
  const alt = `ez-alt-${id}`;
  const mixed = `ez-mix-${id}`;
  const domain = addrOf(m.from).split('@')[1] ?? 'eztest.local';
  const head = [
    `From: ${m.from}`,
    `To: ${m.to.join(', ')}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(m.subject.replace(/[\r\n]+/g, ' '))}`,
    `Date: ${(o.date ?? new Date()).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${o.messageId ?? `${id}.${Date.now()}@${domain}`}>`,
    'MIME-Version: 1.0',
    'X-Mailer: EZTest',
  ];
  const textPart = ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64lines(Buffer.from(m.text, 'utf8'))];
  const body: string[] = [];
  const alternative = m.html
    ? [`Content-Type: multipart/alternative; boundary="${alt}"`, '', `--${alt}`, ...textPart, `--${alt}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64lines(Buffer.from(m.html, 'utf8')), `--${alt}--`]
    : textPart;
  if (m.attachments?.length) {
    body.push(`Content-Type: multipart/mixed; boundary="${mixed}"`, '', `--${mixed}`, ...alternative);
    for (const a of m.attachments) {
      const name = encodeHeader(a.filename.replace(/["\r\n]/g, ''));
      body.push(`--${mixed}`, `Content-Type: ${a.contentType}; name="${name}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${name}"`, '', b64lines(a.content));
    }
    body.push(`--${mixed}--`);
  } else body.push(...alternative);
  return [...head, ...body].join('\r\n');
}

/** Send a message. Resolves with the server's final reply to the message. */
export async function sendSmtp(o: SmtpOptions, m: SmtpMessage): Promise<{ reply: string; recipients: number }> {
  const rcpts = [...m.to, ...(m.cc ?? []), ...(m.bcc ?? [])].map(addrOf);
  if (!rcpts.length) throw new EzTestError('email: no recipients', 'INVALID_INPUT');
  for (const r of [...rcpts, addrOf(m.from)]) if (!ADDRESS.test(r)) throw new EzTestError(`email: "${r}" is not an e-mail address`, 'INVALID_INPUT');
  const timeout = o.timeoutMs ?? 20_000;
  const secure = o.secure ?? o.port === 465;
  let sock: Socket | TLSSocket = secure
    ? tlsConnect({ host: o.host, port: o.port, servername: o.host, rejectUnauthorized: !o.insecureTls })
    : netConnect(o.port, o.host);
  let buf = '';
  let lines: string[] = [];
  let waiter: { resolve: (r: string) => void; reject: (e: Error) => void } | undefined;
  const replies: string[] = [];
  const onData = (c: Buffer) => {
    buf += c.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 2);
      lines.push(l);
      // The last line of a reply has a space (or nothing) after the code.
      if (/^\d{3}(?: |$)/.test(l)) {
        const r = lines.join('\n');
        lines = [];
        if (waiter) {
          const w = waiter;
          waiter = undefined;
          w.resolve(r);
        } else replies.push(r);
      }
    }
  };
  let failure: Error | undefined;
  const onError = (e: Error) => {
    failure = e;
    if (waiter) waiter.reject(e);
  };
  const attach = (s: Socket | TLSSocket) => {
    s.on('data', onData);
    s.on('error', onError);
    s.setTimeout(timeout, () => onError(new Error(`SMTP ${o.host}:${o.port} timed out after ${timeout} ms`)));
  };
  attach(sock);
  const next = () => new Promise<string>((resolve, reject) => {
    if (failure) return reject(failure);
    const r = replies.shift();
    if (r !== undefined) return resolve(r);
    waiter = { resolve, reject };
  });
  const cmd = async (line: string, expect: string, shown = line.split(' ')[0]): Promise<string> => {
    sock.write(`${line}\r\n`);
    const r = await next();
    if (!r.startsWith(expect)) throw new EzTestError(`SMTP ${shown} was refused: ${r.split('\n').pop()}`, 'EMAIL_SEND');
    return r;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      sock.once(secure ? 'secureConnect' : 'connect', () => resolve());
      sock.once('error', reject);
    });
    const greet = await next();
    if (!greet.startsWith('220')) throw new EzTestError(`SMTP greeting: ${greet}`, 'EMAIL_SEND');
    const name = o.clientName ?? 'eztest.local';
    let ehlo = await cmd(`EHLO ${name}`, '250');
    const offers = (w: string) => ehlo.split('\n').some((l) => l.slice(4).toUpperCase().startsWith(w));
    if (!secure && o.starttls !== false && offers('STARTTLS')) {
      await cmd('STARTTLS', '220');
      sock.removeAllListeners('data');
      const plain = sock as Socket;
      sock = tlsConnect({ socket: plain, servername: o.host, rejectUnauthorized: !o.insecureTls });
      await new Promise<void>((resolve, reject) => {
        sock.once('secureConnect', () => resolve());
        sock.once('error', reject);
      });
      attach(sock);
      ehlo = await cmd(`EHLO ${name}`, '250');
    } else if (!secure && o.starttls === 'required') throw new EzTestError(`SMTP ${o.host} does not offer STARTTLS (starttls: required)`, 'EMAIL_SEND');
    if (o.username) {
      const mech = ehlo.split('\n').find((l) => /AUTH/i.test(l)) ?? '';
      if (/PLAIN/i.test(mech) || !/LOGIN/i.test(mech)) await cmd(`AUTH PLAIN ${Buffer.from(`\u0000${o.username}\u0000${o.password ?? ''}`).toString('base64')}`, '235', 'AUTH');
      else {
        await cmd('AUTH LOGIN', '334', 'AUTH');
        await cmd(Buffer.from(o.username).toString('base64'), '334', 'AUTH (user)');
        await cmd(Buffer.from(o.password ?? '').toString('base64'), '235', 'AUTH (password)');
      }
    }
    await cmd(`MAIL FROM:<${addrOf(m.from)}>`, '250', 'MAIL FROM');
    for (const r of rcpts) await cmd(`RCPT TO:<${r}>`, '25', `RCPT TO ${r}`);
    await cmd('DATA', '354');
    const data = buildMime(m).replace(/^\./gm, '..');
    const reply = await cmd(`${data}\r\n.`, '250', 'message');
    sock.write('QUIT\r\n');
    return { reply: reply.split('\n').pop() ?? reply, recipients: rcpts.length };
  } finally {
    sock.end();
    setTimeout(() => sock.destroy(), 1000).unref();
  }
}
