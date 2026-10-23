/**
 * `Requires:` and `Depends on:` journey headers.
 *
 *   Requires: db demo "SELECT id FROM customers WHERE region = 'EU'" has rows
 *   Requires: query "eligible_deals" on crm has at least 3 rows; api GET /api/health returns 200
 *   Requires: data Customer as customer where region=EU; variable PAYMENT_KEY; that ${limit} > 100
 *   Depends on: create-order with orderNumber, invoice; seed-catalogue
 *
 * Several checks per line are separated by ";" and Requires: may repeat.
 */
import type { Dependency, Precondition } from '../core/index.js';
import { literal, protectQuotes, quoteText, restoreQuotes } from './quotes.js';

function count(tail: string | undefined, where: string): number {
  if (!tail || !tail.trim()) return 1;
  const t = tail.trim();
  if (/^(?:has|returns)\s+(?:any\s+)?rows?$/i.test(t) || /^is\s+not\s+empty$/i.test(t)) return 1;
  const m = /^(?:has|returns)\s+(?:at\s+least\s+)?(\d+)\s+rows?$/i.exec(t);
  if (m) return Number(m[1]);
  throw new Error(`${where}: expected "has rows" or "has at least N rows", got "${t}"`);
}

function kv(s: string, quotes: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(',')) {
    if (!part.trim()) continue;
    const m = /^\s*([A-Za-z_][\w.-]*)\s*=\s*(.*)$/.exec(part);
    if (!m) throw new Error(`expected name=value, got "${restoreQuotes(part.trim(), quotes)}"`);
    out[m[1]] = literal(m[2], quotes);
  }
  return out;
}

/** Parse one `Requires:` value into preconditions. */
export function parseRequires(value: string, where = 'Requires'): Precondition[] {
  const { text, quotes } = protectQuotes(value);
  const out: Precondition[] = [];
  for (const raw of text.split(';')) {
    const part = raw.trim();
    if (!part) continue;
    const original = restoreQuotes(part, quotes);
    let m: RegExpExecArray | null;
    if ((m = /^db\s+([\w.-]+)\s+(⟦\d+⟧)(?:\s+(.*))?$/i.exec(part))) {
      out.push({ kind: 'db', connection: m[1], sql: literal(m[2], quotes), min: count(m[3], where), text: original });
    } else if ((m = /^(?:named\s+)?query\s+(⟦\d+⟧|[\w.-]+)(?:\s+on\s+([\w.-]+))?(?:\s+(.*))?$/i.exec(part))) {
      out.push({ kind: 'query', name: literal(m[1], quotes), connection: m[2] ?? '', min: count(m[3], where), text: original });
    } else if ((m = /^api\s+(?:(GET|HEAD|POST)\s+)?(⟦\d+⟧|\S+)(?:\s+as\s+([\w-]+))?\s+returns\s+(\d{3})$/i.exec(part))) {
      out.push({ kind: 'api', method: (m[1]?.toUpperCase() ?? 'GET') as 'GET', url: literal(m[2], quotes), status: Number(m[4]), ...(m[3] ? { asRole: m[3] } : {}), text: original });
    } else if ((m = /^data\s+(\w+)(?:\s+as\s+(\w+))?(?:\s+where\s+(.+))?$/i.exec(part))) {
      out.push({ kind: 'data', entity: m[1], ...(m[2] ? { as: m[2] } : {}), where: m[3] ? kv(m[3], quotes) : {}, text: original });
    } else if ((m = /^variables?\s+(.+)$/i.exec(part))) {
      for (const name of m[1].split(/[,\s]+/).filter(Boolean)) {
        if (!/^[A-Za-z_][\w.]*$/.test(name)) throw new Error(`${where}: "${name}" is not a variable name`);
        out.push({ kind: 'variable', name, text: `variable ${name}` });
      }
    } else if ((m = /^(?:that|expr(?:ession)?)\s+(.+)$/i.exec(part))) {
      out.push({ kind: 'expr', expr: restoreQuotes(m[1], quotes), text: original });
    } else {
      throw new Error(`${where}: unknown requirement "${original}" (use: db <conn> "<sql>" has rows; query "<name>" on <conn> has rows; api GET /path returns 200; data <Entity> where k=v; variable NAME; that <expression>)`);
    }
  }
  return out;
}

/** Render a precondition back as `Requires:` text. */
export function requiresToText(p: Precondition): string {
  const rows = (n: number) => (n === 1 ? 'has rows' : `has at least ${n} rows`);
  switch (p.kind) {
    case 'db': return `db ${p.connection} ${quoteText(p.sql)} ${rows(p.min)}`;
    case 'query': return `query ${quoteText(p.name)}${p.connection ? ` on ${p.connection}` : ''} ${rows(p.min)}`;
    case 'api': return `api ${p.method} ${p.url}${p.asRole ? ` as ${p.asRole}` : ''} returns ${p.status}`;
    case 'data': {
      const w = Object.entries(p.where).map(([k, v]) => `${k}=${quoteText(v)}`).join(', ');
      return `data ${p.entity}${p.as ? ` as ${p.as}` : ''}${w ? ` where ${w}` : ''}`;
    }
    case 'variable': return `variable ${p.name}`;
    case 'expr': return `that ${p.expr}`;
  }
}

/** Parse a `Depends on:` value. */
export function parseDependsOn(value: string, where = 'Depends on'): Dependency[] {
  const { text, quotes } = protectQuotes(value);
  return text.split(';').map((p) => p.trim()).filter(Boolean).map((part) => {
    const m = /^(⟦\d+⟧|[\w.-]+)(?:\s+(?:with|taking|take)\s+(.+))?$/i.exec(part);
    if (!m) throw new Error(`${where}: expected "<journey id> [with key, key]", got "${restoreQuotes(part, quotes)}"`);
    const take = m[2] ? m[2].split(/[,\s]+/).map((k) => k.trim()).filter(Boolean) : [];
    for (const k of take) if (!/^[A-Za-z_][\w.]*$/.test(k)) throw new Error(`${where}: "${k}" is not a ledger key`);
    return { journey: literal(m[1], quotes), take };
  });
}

export function dependsOnToText(d: Dependency): string {
  const id = /^[\w.-]+$/.test(d.journey) ? d.journey : quoteText(d.journey);
  return `${id}${d.take.length ? ` with ${d.take.join(', ')}` : ''}`;
}
