/**
 * Plain-English phrasings for the shared store and data pools. Each builds
 * one `store` step with canonical args; `storeStepToText` renders it back to
 * a line that parses to the same step.
 *
 *   Save ${orderId} to the shared store as "pending-order" for 2 days in namespace "sit"
 *   Save ${token} to the shared store as "api-token" as a secret for the pipeline
 *   Load "pending-order" from the shared store as orderId or use "ORD-0"
 *   Delete "pending-order" from the shared store
 *   Add ${policy} to pool "approvable-policies"
 *   Fill pool "approvable-policies" from "data/policies.csv" column "policyNo"
 *   Take one item from pool "approvable-policies" as policy
 *   Expect pool "approvable-policies" has at least 3 items
 */
import { literal, protectQuotes, quoteText } from '../intent/quotes.js';
import type { IntentRule, StepBody } from '../intent/rules.js';
import type { Step } from '../core/index.js';
import { parseTtl, ttlText } from './types.js';

const Q = String.raw`⟦\d+⟧`;
const NAME = String.raw`(${Q}|[A-Za-z0-9_][\w.:@/-]*)`;
const VAR = String.raw`[A-Za-z_]\w*`;
const UNIT = String.raw`(?:ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)`;
const STORE = String.raw`the\s+shared\s+(?:data\s+)?store`;
const POOL = String.raw`(?:the\s+)?(?:data\s+)?pool`;
const NS_CLAUSE = String.raw`in\s+(?:the\s+)?namespace\s+(?:${Q}|[A-Za-z0-9_][\w.-]*)`;

type Args = Record<string, unknown>;

function fatal(message: string): Error {
  return Object.assign(new Error(message), { fatal: true });
}

const nameOf = (s: string, q: string[]) => (s.startsWith('⟦') ? literal(s, q) : s);

/** Keep only defined keys, in a fixed order (the same args however the line was written). */
function ordered(o: Args): Args {
  const keys = ['op', 'key', 'pool', 'value', 'each', 'file', 'sheet', 'column', 'namespace', 'ttlMs', 'pipeline', 'secret', 'default', 'keep', 'min', 'max'];
  const out: Args = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/** Trailing clauses in any order: namespace, ttl, pipeline, secret, default, keep. */
function clauses(tail: string, q: string[], allowed: Array<'namespace' | 'ttl' | 'pipeline' | 'secret' | 'default' | 'keep'>): Args {
  const out: Args = {};
  let t = tail.trim();
  while (t) {
    t = t.replace(/^(?:,\s*|and\s+)+/i, '');
    let m: RegExpExecArray | null;
    if (allowed.includes('namespace') && (m = new RegExp(String.raw`^in\s+(?:the\s+)?namespace\s+(${Q}|[A-Za-z0-9_][\w.-]*)`, 'i').exec(t))) out.namespace = nameOf(m[1], q);
    else if (allowed.includes('pipeline') && (m = /^for\s+the\s+(?:whole\s+)?pipeline\b/i.exec(t))) out.pipeline = true;
    else if (allowed.includes('ttl') && (m = new RegExp(String.raw`^(?:for|expiring\s+(?:in|after))\s+(\d+(?:\.\d+)?)\s*(${UNIT})\b`, 'i').exec(t))) out.ttlMs = parseTtl(`${m[1]} ${m[2]}`);
    else if (allowed.includes('secret') && (m = /^as\s+(?:a\s+)?secret\b/i.exec(t))) out.secret = true;
    else if (allowed.includes('keep') && (m = /^keep\s+it(?:\s+(?:even\s+)?(?:if|when)\s+the\s+journey\s+fails)?\b/i.exec(t))) out.keep = true;
    else if (allowed.includes('default') && (m = new RegExp(String.raw`^or\s+(?:use|default\s+to)\s+(${Q}|\$\{[\w.]+\}|-?\d+(?:\.\d+)?|true|false)`, 'i').exec(t))) out.default = literal(m[1], q);
    else throw fatal(`cannot read "${t}" (expected ${allowed.map((a) => ({ namespace: 'in namespace "x"', ttl: 'for 2 days', pipeline: 'for the pipeline', secret: 'as a secret', default: 'or use "value"', keep: 'and keep it' })[a]).join(', ')})`);
    t = t.slice(m[0].length).trim();
  }
  return out;
}

const value = (s: string, q: string[]) => literal(s.trim(), q);

export const STORE_RULES: IntentRule[] = [
  {
    name: 'store-save',
    keywords: ['save', 'store', 'put'],
    category: 'Shared data',
    example: 'Save ${orderId} to the shared store as "pending-order" for 2 days',
    re: new RegExp(String.raw`^(?:save|store|put|keep)\s+(.+?)\s+(?:to|in|into)\s+${STORE}\s+as\s+${NAME}(.*)$`, 'i'),
    build(m, q): StepBody {
      const c = clauses(m[3], q, ['namespace', 'ttl', 'pipeline', 'secret']);
      return { action: 'store', args: ordered({ op: 'save', key: nameOf(m[2], q), value: value(m[1], q), ...c }) };
    },
  },
  {
    name: 'store-load',
    keywords: ['load', 'read', 'get', 'fetch'],
    category: 'Shared data',
    example: 'Load "pending-order" from the shared store as orderId',
    re: new RegExp(String.raw`^(?:load|read|get|fetch|take)\s+${NAME}\s+from\s+${STORE}(?:\s+as\s+(${VAR}))?(.*)$`, 'i'),
    build(m, q): StepBody {
      const key = nameOf(m[1], q);
      const c = clauses(m[3], q, ['namespace', 'default']);
      return { action: 'store', captureAs: m[2] ?? key.replace(/[^\w]/g, '_'), args: ordered({ op: 'load', key, ...c }) };
    },
  },
  {
    name: 'store-delete',
    keywords: ['delete', 'remove', 'clear'],
    category: 'Shared data',
    example: 'Delete "pending-order" from the shared store',
    re: new RegExp(String.raw`^(?:delete|remove|clear|forget)\s+${NAME}\s+from\s+${STORE}(.*)$`, 'i'),
    build(m, q): StepBody {
      return { action: 'store', args: ordered({ op: 'delete', key: nameOf(m[1], q), ...clauses(m[2], q, ['namespace']) }) };
    },
  },
  {
    name: 'pool-seed',
    keywords: ['fill', 'seed'],
    category: 'Shared data',
    example: 'Fill pool "approvable-policies" from "data/policies.csv"',
    re: new RegExp(String.raw`^(?:fill|seed|load|populate)\s+${POOL}\s+${NAME}\s+from\s+(?:the\s+)?(?:data\s+)?(?:file\s+)?(${Q})(?:\s+sheet\s+(${Q}))?(?:\s+(?:using\s+)?(?:the\s+)?column\s+(${Q}))?(.*)$`, 'i'),
    build(m, q): StepBody {
      return { action: 'store', args: ordered({ op: 'poolSeed', pool: nameOf(m[1], q), file: literal(m[2], q), ...(m[3] ? { sheet: literal(m[3], q) } : {}), ...(m[4] ? { column: literal(m[4], q) } : {}), ...clauses(m[5], q, ['namespace', 'secret']) }) };
    },
  },
  {
    name: 'pool-add',
    keywords: ['add', 'put'],
    category: 'Shared data',
    example: 'Add ${policy} to pool "approvable-policies"',
    re: new RegExp(String.raw`^(?:add|put|return)\s+(each\s+(?:item\s+)?of\s+)?(.+?)\s+(?:to|into|back\s+to)\s+${POOL}\s+${NAME}(.*)$`, 'i'),
    build(m, q): StepBody {
      return { action: 'store', args: ordered({ op: 'poolAdd', pool: nameOf(m[3], q), value: value(m[2], q), ...(m[1] ? { each: true } : {}), ...clauses(m[4], q, ['namespace', 'secret']) }) };
    },
  },
  {
    name: 'pool-take',
    keywords: ['take', 'claim', 'reserve'],
    category: 'Shared data',
    example: 'Take one item from pool "approvable-policies" as policy',
    re: new RegExp(String.raw`^(?:take|claim|reserve|get)\s+(?:one|an|1|a)\s+(?:free\s+)?item\s+from\s+${POOL}\s+${NAME}(?:\s+as\s+(${VAR}))?(.*)$`, 'i'),
    build(m, q): StepBody {
      return { action: 'store', captureAs: m[2] ?? 'item', args: ordered({ op: 'poolTake', pool: nameOf(m[1], q), ...clauses(m[3], q, ['namespace', 'keep']) }) };
    },
  },
  {
    name: 'pool-count',
    keywords: ['expect', 'verify'],
    category: 'Shared data',
    example: 'Expect pool "approvable-policies" has at least 3 items',
    re: new RegExp(String.raw`^(?:expect|verify|assert|ensure|check|confirm)\s+(?:that\s+)?${POOL}\s+${NAME}\s+(?:has|to\s+have|contains|holds|still\s+has)\s+(?:at\s+least\s+(\d+)|at\s+most\s+(\d+)|(\d+))\s+(?:free\s+|available\s+)?items?(.*)$`, 'i'),
    build(m, q): StepBody {
      const exact = m[4] !== undefined ? Number(m[4]) : undefined;
      return {
        action: 'store',
        args: ordered({ op: 'poolCount', pool: nameOf(m[1], q), min: m[2] !== undefined ? Number(m[2]) : exact, max: m[3] !== undefined ? Number(m[3]) : exact, ...clauses(m[5], q, ['namespace']) }),
      };
    },
  },
];

/** "Expect pool "x" has at least 3 items" is a step of its own, not a post-condition of the step before it. */
export function isStoreExpectation(line: string): boolean {
  const { text } = protectQuotes(line.trim().replace(/[.;]+$/, '').replace(/^(?:and|then|but|also)\s+/i, ''));
  return STORE_RULES.find((r) => r.name === 'pool-count')!.re.test(text);
}

/** YAML/JSON sugar: `- store: { save: orderId, as: pending-order, ttl: 2 days }` and `- pool: { take: x, as: policy }`. */
export function storeSugarIntent(s: Record<string, unknown>): string | undefined {
  const st = s.store ?? s.sharedStore;
  const qv = (v: unknown) => (typeof v === 'string' && /^\$\{[\w.]+\}$/.test(v) ? v : quoteText(String(v)));
  const tail = (o: Record<string, unknown>) =>
    `${o.ttl !== undefined ? ` for ${String(o.ttl)}` : ''}${o.namespace !== undefined ? ` in namespace ${quoteText(String(o.namespace))}` : ''}${o.pipeline ? ' for the pipeline' : ''}${o.secret ? ' as a secret' : ''}`;
  if (st && typeof st === 'object' && s.action === undefined) {
    const o = st as Record<string, unknown>;
    if (o.save !== undefined) {
      const v = o.value !== undefined ? o.value : `\${${String(o.save)}}`;
      return `Save ${qv(v)} to the shared store as ${quoteText(String(o.as ?? o.key ?? o.save))}${tail(o)}`;
    }
    if (o.load !== undefined) return `Load ${quoteText(String(o.load))} from the shared store${o.as ? ` as ${String(o.as)}` : ''}${o.namespace !== undefined ? ` in namespace ${quoteText(String(o.namespace))}` : ''}${o.default !== undefined ? ` or use ${qv(o.default)}` : ''}`;
    if (o.delete !== undefined) return `Delete ${quoteText(String(o.delete))} from the shared store${o.namespace !== undefined ? ` in namespace ${quoteText(String(o.namespace))}` : ''}`;
  }
  const pl = s.pool;
  if (pl && typeof pl === 'object' && s.action === undefined) {
    const o = pl as Record<string, unknown>;
    const ns = o.namespace !== undefined ? ` in namespace ${quoteText(String(o.namespace))}` : '';
    if (o.take !== undefined) return `Take one item from pool ${quoteText(String(o.take))}${o.as ? ` as ${String(o.as)}` : ''}${ns}${o.keep ? ' and keep it' : ''}`;
    if (o.add !== undefined) return `Add ${qv(o.add)} to pool ${quoteText(String(o.to ?? o.pool))}${ns}${o.secret ? ' as a secret' : ''}`;
    if (o.fill !== undefined || o.seed !== undefined) return `Fill pool ${quoteText(String(o.fill ?? o.seed))} from ${quoteText(String(o.from))}${o.column ? ` column ${quoteText(String(o.column))}` : ''}${ns}`;
    if (o.expect !== undefined) return `Expect pool ${quoteText(String(o.expect))} has at least ${Number(o.atLeast ?? o.min ?? 1)} items${ns}`;
  }
  return undefined;
}

/** A `store` step as a plain-English line. */
export function storeStepToText(s: Step): string {
  const a = (s.args ?? {}) as Record<string, unknown>;
  const q = (v: unknown) => quoteText(String(v));
  const val = (v: unknown) => (typeof v === 'string' && /^(?:\$\{[\w.]+\}|-?\d+(?:\.\d+)?)$/.test(v) ? v : q(v));
  const ns = a.namespace !== undefined ? ` in namespace ${q(a.namespace)}` : '';
  switch (a.op) {
    case 'save':
      return `Save ${val(a.value)} to the shared store as ${q(a.key)}${a.ttlMs !== undefined ? ` for ${ttlText(Number(a.ttlMs))}` : ''}${ns}${a.pipeline ? ' for the pipeline' : ''}${a.secret ? ' as a secret' : ''}`;
    case 'load':
      return `Load ${q(a.key)} from the shared store as ${s.captureAs ?? String(a.key)}${ns}${a.default !== undefined ? ` or use ${val(a.default)}` : ''}`;
    case 'delete':
      return `Delete ${q(a.key)} from the shared store${ns}`;
    case 'poolAdd':
      return `Add ${a.each ? 'each of ' : ''}${val(a.value)} to pool ${q(a.pool)}${ns}${a.secret ? ' as a secret' : ''}`;
    case 'poolSeed':
      return `Fill pool ${q(a.pool)} from ${q(a.file)}${a.sheet !== undefined ? ` sheet ${q(a.sheet)}` : ''}${a.column !== undefined ? ` column ${q(a.column)}` : ''}${ns}${a.secret ? ' as a secret' : ''}`;
    case 'poolTake':
      return `Take one item from pool ${q(a.pool)} as ${s.captureAs ?? 'item'}${ns}${a.keep ? ' and keep it' : ''}`;
    case 'poolCount': {
      const n = a.min !== undefined && a.min === a.max ? `${String(a.min)}` : a.min !== undefined ? `at least ${String(a.min)}` : `at most ${String(a.max)}`;
      return `Expect pool ${q(a.pool)} has ${n} items${ns}`;
    }
  }
  throw new Error(`store step "${s.intent}" has no plain-English form`);
}
