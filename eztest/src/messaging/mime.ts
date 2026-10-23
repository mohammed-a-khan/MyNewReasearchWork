/** Minimal RFC 5322 / MIME parsing: headers, multipart, quoted-printable, base64, encoded words. */

export interface ParsedMime {
  headers: Record<string, string>;
  text: string;
  html?: string;
}

function decodeQP(s: string, charset = 'utf-8'): string {
  const bytes: number[] = [];
  const src = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...Buffer.from(src[i], 'utf8'));
  }
  return Buffer.from(bytes).toString(charset.toLowerCase() === 'utf-8' || charset.toLowerCase() === 'utf8' ? 'utf8' : 'latin1');
}

/** Decode RFC 2047 encoded words (=?utf-8?B?...?= / =?utf-8?Q?...?=). */
export function decodeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_w, cs: string, enc: string, data: string) => {
    if (enc.toUpperCase() === 'B') return Buffer.from(data, 'base64').toString(/utf-?8/i.test(cs) ? 'utf8' : 'latin1');
    return decodeQP(data.replace(/_/g, ' '), cs);
  });
}

function splitHeaderBody(raw: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(raw);
  if (!m) return { head: raw, body: '' };
  return { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) };
}

export function parseHeaders(head: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = decodeWords(line.slice(i + 1).trim());
    out[k] = out[k] ? `${out[k]}, ${v}` : v;
  }
  return out;
}

function param(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(header);
  return m ? (m[1] ?? m[2]) : undefined;
}

function decodeBody(body: string, headers: Record<string, string>): string {
  const enc = (headers['content-transfer-encoding'] ?? '').toLowerCase();
  const cs = param(headers['content-type'], 'charset') ?? 'utf-8';
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString(/utf-?8/i.test(cs) ? 'utf8' : 'latin1');
  if (enc === 'quoted-printable') return decodeQP(body, cs);
  return body;
}

/** Text of an HTML document (tags removed, entities decoded, links kept as "text (url)"). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_w, href: string, t: string) => `${t} (${href})`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** Parse a raw RFC 5322 message. */
export function parseMime(raw: string): ParsedMime {
  const { head, body } = splitHeaderBody(raw);
  const headers = parseHeaders(head);
  const out: ParsedMime = { headers, text: '' };
  walk(headers, body, out, 0);
  if (!out.text && out.html) out.text = htmlToText(out.html);
  return out;
}

function walk(headers: Record<string, string>, body: string, out: ParsedMime, depth: number): void {
  const ct = (headers['content-type'] ?? 'text/plain').toLowerCase();
  if (ct.startsWith('multipart/') && depth < 10) {
    const boundary = param(headers['content-type'], 'boundary');
    if (!boundary) return;
    const parts = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?\\s*`));
    for (const part of parts) {
      if (!part.trim()) continue;
      const { head, body: pb } = splitHeaderBody(part);
      walk(parseHeaders(head), pb, out, depth + 1);
    }
    return;
  }
  if (/attachment/i.test(headers['content-disposition'] ?? '')) return;
  const text = decodeBody(body, headers);
  if (ct.startsWith('text/html')) out.html ??= text;
  else if (ct.startsWith('text/')) out.text ||= text.replace(/\r\n/g, '\n').trimEnd();
}
