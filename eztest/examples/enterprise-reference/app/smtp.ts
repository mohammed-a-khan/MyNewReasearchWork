/** A minimal SMTP client on node:net: EHLO, MAIL FROM, RCPT TO, DATA (multipart/alternative text + HTML). */
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';

export interface Mail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendMail(relay: string, mail: Mail): Promise<void> {
  const [host, port] = relay.split(':');
  const sock = connect({ host, port: Number(port || 25) });
  sock.setEncoding('utf8');
  let buf = '';
  const waiters: Array<(line: string) => void> = [];
  sock.on('data', (d: string) => {
    buf += d;
    for (;;) {
      const i = buf.indexOf('\r\n');
      if (i < 0) break;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      // multi-line replies ("250-...") end with a line that has a space after the code
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) waiters.shift()?.(line);
    }
  });
  const reply = () =>
    new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('smtp timeout')), 10_000);
      waiters.push((l) => {
        clearTimeout(t);
        resolve(l);
      });
    });
  const expect = async (code: string) => {
    const l = await reply();
    if (!l.startsWith(code)) throw new Error(`smtp: expected ${code}, got "${l}"`);
  };
  const cmd = async (line: string, code: string) => {
    sock.write(`${line}\r\n`);
    await expect(code);
  };
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  try {
    await expect('220');
    await cmd('EHLO larkspur.local', '250');
    await cmd(`MAIL FROM:<${mail.from}>`, '250');
    await cmd(`RCPT TO:<${mail.to}>`, '250');
    await cmd('DATA', '354');
    const boundary = `lk-${randomBytes(8).toString('hex')}`;
    const headers = [
      `From: Larkspur Mutual <${mail.from}>`,
      `To: <${mail.to}>`,
      `Subject: ${mail.subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${randomBytes(12).toString('hex')}@larkspur.local>`,
      'MIME-Version: 1.0',
    ];
    const body = mail.html
      ? [
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
          '',
          `--${boundary}`,
          'Content-Type: text/plain; charset=utf-8',
          '',
          mail.text,
          `--${boundary}`,
          'Content-Type: text/html; charset=utf-8',
          '',
          mail.html,
          `--${boundary}--`,
        ]
      : ['Content-Type: text/plain; charset=utf-8', '', mail.text];
    const data = [...headers, ...body]
      .join('\r\n')
      .split('\r\n')
      .map((l) => (l.startsWith('.') ? `.${l}` : l))
      .join('\r\n');
    await cmd(`${data}\r\n.`, '250');
    sock.write('QUIT\r\n');
  } finally {
    sock.end();
  }
}
