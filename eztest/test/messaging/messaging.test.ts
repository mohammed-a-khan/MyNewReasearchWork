/** Email and SMS providers: SMTP sink, MIME parsing, the Twilio HTTP adapter. */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import {
  MemorySmsProvider, SmtpSink, TwilioSmsProvider, decodeWords, htmlToText, parseMime, sendSmtpMail,
} from '../../src/messaging/index.js';

async function httpMock(handler: (url: URL, headers: Record<string, string | string[] | undefined>) => unknown): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const body = handler(url, req.headers);
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address();
  return { url: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`, server };
}

describe('MIME', () => {
  it('parses headers, encoded words, quoted-printable, base64 and multipart/alternative', () => {
    expect(decodeWords('=?utf-8?B?V2VsY29tZSDinJM=?= and =?UTF-8?Q?caf=C3=A9_bar?=')).toBe('Welcome ✓ and café bar');
    const raw = [
      'From: Shop <noreply@shop.test>', 'To: ada@test.local', 'Subject: =?utf-8?Q?Your_code?=', 'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="b1"', '', '--b1', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
      'Code: 482913 =', 'and a link https://shop.test/v?t=1', '--b1', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
      Buffer.from('<p>Code <b>482913</b> <a href="https://shop.test/v?t=1">verify</a></p>').toString('base64'), '--b1--', '',
    ].join('\r\n');
    const m = parseMime(raw);
    expect(m.headers.subject).toBe('Your code');
    expect(m.text).toBe('Code: 482913 and a link https://shop.test/v?t=1');
    expect(m.html).toContain('<b>482913</b>');
    expect(htmlToText(m.html!)).toBe('Code 482913 verify (https://shop.test/v?t=1)');
  });
});

describe('SMTP sink', () => {
  let sink: SmtpSink;
  beforeAll(async () => {
    sink = await new SmtpSink().start();
  });
  afterAll(async () => {
    await sink.stop();
  });

  it('receives mail over SMTP and returns the newest match, waiting for late mail', async () => {
    await sendSmtpMail({ port: sink.port, from: 'a@x.test', to: 'bob@test.local', subject: 'First', text: 'one' });
    await sendSmtpMail({ port: sink.port, from: 'a@x.test', to: 'ada@test.local', subject: 'Welcome Ada', text: 'Line\n.leading dot\nend', html: '<p>Hi</p>' });
    const m = await sink.latest({ to: 'ADA@test.local', subject: 'welcome', timeoutMs: 1000 });
    expect(m).toMatchObject({ from: 'a@x.test', to: ['ada@test.local'], subject: 'Welcome Ada', text: 'Line\n.leading dot\nend', html: '<p>Hi</p>' });
    const late = sink.latest({ to: 'late@test.local', timeoutMs: 3000, pollMs: 50 });
    setTimeout(() => void sendSmtpMail({ port: sink.port, from: 'a@x.test', to: 'late@test.local', subject: 'Late', text: 'x' }), 200);
    expect((await late).subject).toBe('Late');
    await expect(sink.latest({ to: 'nobody@test.local', timeoutMs: 200 })).rejects.toThrow(/No email to nobody@test.local arrived within 200 ms/);
    expect(sink.messages.length).toBe(3);
  });
});

describe('HTTP SMS adapter', () => {
  it('Twilio: authenticates with the account SID and token and filters by recipient', async () => {
    let auth = '';
    let to = '';
    const { url, server } = await httpMock((u, h) => {
      if (!u.pathname.startsWith('/2010-04-01/Accounts/AC123/Messages.json')) return undefined;
      auth = String(h.authorization);
      to = u.searchParams.get('To') ?? '';
      return { messages: [{ sid: 'SM1', from: '+15550000', to: '+15550100', body: 'Your code is 654321', date_sent: new Date().toUTCString() }] };
    });
    try {
      const m = await new TwilioSmsProvider({ accountSid: 'AC123', authToken: 'tok', baseUrl: url }).latest({ to: '+15550100', timeoutMs: 1000 });
      expect(m).toMatchObject({ id: 'SM1', body: 'Your code is 654321' });
      expect(auth).toBe(`Basic ${Buffer.from('AC123:tok').toString('base64')}`);
      expect(to).toBe('+15550100');
    } finally {
      server.close();
    }
    expect(() => new TwilioSmsProvider({ accountSid: '', authToken: '' })).toThrow(/secret:\/\//);
  });

  it('MemorySmsProvider filters by recipient, sender and text', async () => {
    const p = new MemorySmsProvider();
    p.push({ from: '+1', to: '+2', body: 'hello' });
    p.push({ from: '+1', to: '+3', body: 'code 1234' });
    expect((await p.latest({ to: '+3', contains: 'code', timeoutMs: 100 })).body).toBe('code 1234');
    await expect(p.latest({ to: '+9', timeoutMs: 100, pollMs: 20 })).rejects.toThrow(/No SMS arrived/);
  });
});
