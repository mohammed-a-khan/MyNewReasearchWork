/**
 * Response templates: plain token replacement, no expression evaluation.
 *   {{request.path}} {{request.method}} {{request.query.<name>}}
 *   {{request.header.<name>}} {{uuid}} {{now}}
 * Unknown tokens are left untouched so they stay visible.
 */
import { randomUUID } from 'node:crypto';

export interface TemplateRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
}

const TOKEN = /\{\{\s*([A-Za-z][\w.-]*)\s*\}\}/g;

export function hasTemplateTokens(text: string): boolean {
  TOKEN.lastIndex = 0;
  return TOKEN.test(text);
}

function resolveToken(name: string, req: TemplateRequest): string | undefined {
  if (name === 'uuid') return randomUUID();
  if (name === 'now') return new Date().toISOString();
  if (name === 'request.path') return req.path;
  if (name === 'request.method') return req.method;
  if (name.startsWith('request.query.')) return req.query.get(name.slice('request.query.'.length)) ?? '';
  if (name.startsWith('request.header.')) {
    const v = req.headers[name.slice('request.header.'.length).toLowerCase()];
    return Array.isArray(v) ? v.join(', ') : (v ?? '');
  }
  return undefined;
}

/** Replace tokens. With `json`, substituted values are JSON-string-escaped so a JSON body stays valid. */
export function renderTemplate(text: string, req: TemplateRequest, opts: { json?: boolean } = {}): string {
  return text.replace(TOKEN, (whole, name: string) => {
    const v = resolveToken(name, req);
    if (v === undefined) return whole;
    return opts.json ? JSON.stringify(v).slice(1, -1) : v;
  });
}
