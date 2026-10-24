/**
 * Plain-English phrasings for integration steps: message buses (Kafka,
 * RabbitMQ/AMQP, MQTT, IBM MQ), gRPC, SFTP and folder file drops, SSH
 * commands, batch jobs, EDI files and contract consumer sessions. Every phrasing
 * builds one `integration` step whose args are canonical (fixed key order), and
 * `integrationStepToText` renders it back to a line that parses to the same step.
 *
 *   Publish message from file "order.json" to Kafka topic "orders" on bus with key "${orderId}"
 *   Start listening on Kafka topic "invoices" as invoices
 *   Wait for a message on Kafka topic "invoices" where "$.orderId" = ${orderId} within 30 s as invoice
 *   Expect no message on RabbitMQ queue "errors" within 5 s
 *   Call gRPC "shop.Orders/Get" on orders with '{"id":42}' as order
 *   Upload "batch.csv" to SFTP "partner" at "/in"
 *   Wait for a file matching "ACK_*.csv" in "/out" on SFTP "partner" within 5 minutes as ack
 *   Run command "./close-day.sh" on SSH "batch-host" as closing
 *   Run batch job "close-day" and wait up to 10 minutes as job
 *   Read the file ack as EDI into edi
 *   Start a contract between consumer "shop-web" and provider "orders-api"
 *   Given provider state "order 42 exists" with id=42
 */
import { literal, protectQuotes, quoteText } from '../intent/quotes.js';
import type { IntentRule, StepBody } from '../intent/rules.js';
import type { Step } from '../core/index.js';

const Q = String.raw`⟦\d+⟧`;
const KEY = String.raw`([A-Za-z_][\w.-]*)`;
const VAR = String.raw`\$\{[\w.]+\}`;
const NAME = String.raw`(${Q}|[A-Za-z_][\w.-]*)`;
const DUR = String.raw`(\d+(?:\.\d+)?)\s*(milliseconds?|millis|ms|minutes?|mins?|m|seconds?|secs?|s|hours?|h)\b`;
const KIND = String.raw`(kafka|amqp\s*1(?:\.0)?|amqp10|artemis|service\s*bus|solace|rabbit\s*mq|amqp|mqtt|ibm\s*mq|mq|jms|memory)`;
/** [kind] (topic|queue|exchange) "name" [on broker] */
const DEST = String.raw`(?:the\s+)?(?:${KIND}\s+)?(topic|queue|exchange)\s+(${Q})(?:\s+(?:on|via|using|at)\s+(?!sftp\b|ssh\b)([\w.-]+))?`;

type Args = Record<string, unknown>;

/** A clause error: the line is clearly this phrasing, so no other rule should claim it. */
function fatal(message: string): Error {
  return Object.assign(new Error(message), { fatal: true });
}

export function ms(n: string, unit?: string): number {
  const v = Number(n);
  const u = (unit ?? 'ms').toLowerCase();
  if (/^(?:ms|millis|milliseconds?)$/.test(u)) return Math.round(v);
  if (/^(?:s|secs?|seconds?)$/.test(u)) return Math.round(v * 1000);
  if (/^(?:m|mins?|minutes?)$/.test(u)) return Math.round(v * 60_000);
  return Math.round(v * 3_600_000);
}

function msText(n: number): string {
  if (n % 60_000 === 0 && n >= 60_000) return `${n / 60_000} minute${n === 60_000 ? '' : 's'}`;
  if (n % 1000 === 0) return `${n / 1000} s`;
  return `${n} ms`;
}

const KIND_WORDS: Record<string, string> = { kafka: 'kafka', 'amqp1.0': 'amqp10', amqp1: 'amqp10', amqp10: 'amqp10', artemis: 'amqp10', servicebus: 'amqp10', solace: 'amqp10', rabbitmq: 'amqp', amqp: 'amqp', mqtt: 'mqtt', ibmmq: 'ibmmq', mq: 'ibmmq', jms: 'ibmmq', memory: 'memory' };
const KIND_TEXT: Record<string, string> = { kafka: 'Kafka', amqp: 'RabbitMQ', amqp10: 'AMQP 1.0', mqtt: 'MQTT', ibmmq: 'IBM MQ', memory: 'memory' };

function kindOf(w: string | undefined): string | undefined {
  return w ? KIND_WORDS[w.toLowerCase().replace(/\s+/g, '')] : undefined;
}

/** Keep only defined keys, in the given order (args must serialise identically however the line was written). */
function ordered(o: Args, keys: string[]): Args {
  const out: Args = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

const V = (s: string, q: string[]) => literal(s.trim(), q);
const nameOf = (s: string, q: string[]) => (s.startsWith('⟦') ? literal(s, q) : s);

/** A filter value: quoted text, ${var}, number, true/false/null or a bare word, kept as text. */
function filterValue(s: string, q: string[]): string {
  return literal(s.trim(), q);
}

export interface BusFilter {
  /** "$.path" | "key" | "correlationId" | "header:<name>" | "payload" */
  field: string;
  op: 'equals' | 'ne' | 'contains' | 'matches' | 'exists' | 'absent' | 'gt' | 'gte' | 'lt' | 'lte';
  value?: string;
}

const OPS: Array<[RegExp, BusFilter['op']]> = [
  [/^(?:!=|<>|is\s+not|does\s+not\s+equal|not\s+equals?)$/i, 'ne'],
  [/^(?:=|==|equals?|is)$/i, 'equals'],
  [/^(?:contains|includes|has)$/i, 'contains'],
  [/^(?:matches|=~)$/i, 'matches'],
  [/^(?:>=)$/, 'gte'], [/^(?:<=)$/, 'lte'], [/^(?:>)$/, 'gt'], [/^(?:<)$/, 'lt'],
];
const OP_RE = String.raw`(!=|<>|==|=~|>=|<=|=|>|<|is\s+not|does\s+not\s+equal|equals?|is|contains|includes|matches)`;

function parseFilters(text: string, q: string[]): BusFilter[] {
  const out: BusFilter[] = [];
  for (const part of text.split(/\s+and\s+/i)) {
    const p = part.trim();
    if (!p) continue;
    let m: RegExpExecArray | null;
    if ((m = new RegExp(`^(${Q})\\s+(exists|is\\s+present|is\\s+absent|does\\s+not\\s+exist)$`, 'i').exec(p))) {
      out.push({ field: V(m[1], q), op: /absent|not/i.test(m[2]) ? 'absent' : 'exists' });
      continue;
    }
    m = new RegExp(`^(?:(${Q})|(key)|(correlation\\s*id)|header\\s+(${Q}|[\\w.-]+)|(payload|body|message))\\s*${OP_RE}\\s*(${Q}|${VAR}|\\S+)$`, 'i').exec(p);
    if (!m) throw fatal(`Cannot read the message filter "${p}" (try "$.orderId" = \${orderId}, key = "42", header "type" = "created", correlation id = "abc", payload contains "x")`);
    const field = m[1] ? V(m[1], q) : m[2] ? 'key' : m[3] ? 'correlationId' : m[4] ? `header:${nameOf(m[4], q)}` : 'payload';
    if (m[1] && !/^\$/.test(field)) throw fatal(`A message field must be a JSONPath starting with $ (got "${field}")`);
    const op = OPS.find(([re]) => re.test(m![6].trim()))?.[1] ?? 'equals';
    out.push({ field, op, value: filterValue(m[7], q) });
  }
  return out;
}

function filterText(f: BusFilter): string {
  const field = f.field === 'key' ? 'key' : f.field === 'correlationId' ? 'correlation id' : f.field === 'payload' ? 'payload' : f.field.startsWith('header:') ? `header ${quoteText(f.field.slice(7))}` : quoteText(f.field);
  if (f.op === 'exists') return `${field} exists`;
  if (f.op === 'absent') return `${field} is absent`;
  const op = { equals: '=', ne: '!=', contains: 'contains', matches: 'matches', gt: '>', gte: '>=', lt: '<', lte: '<=' }[f.op];
  const v = f.value ?? '';
  return `${field} ${op} ${/^\$\{[\w.]+\}$/.test(v) || /^-?\d+(?:\.\d+)?$/.test(v) || /^(?:true|false|null)$/.test(v) ? v : quoteText(v)}`;
}

function dest(m: RegExpExecArray, i: number, q: string[]): Args {
  return ordered({ broker: m[i + 3], brokerKind: kindOf(m[i]), destType: m[i + 1].toLowerCase(), dest: V(m[i + 2], q) }, ['broker', 'brokerKind', 'destType', 'dest']);
}

function destText(a: Args): string {
  const kind = a.brokerKind ? `${KIND_TEXT[String(a.brokerKind)]} ` : '';
  return `${kind}${String(a.destType)} ${quoteText(String(a.dest))}${a.broker ? ` on ${String(a.broker)}` : ''}`;
}

/** Wait/expect-none clauses: where ..., within ..., matching schema "...", at least N. */
function waitClauses(text: string, q: string[]): Args {
  const out: Args = {};
  let rest = ` ${text.trim()}`;
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(rest);
    if (m) rest = rest.slice(0, m.index) + rest.slice(m.index + m[0].length);
    return m;
  };
  let m: RegExpExecArray | null;
  if ((m = take(new RegExp(String.raw`\s+(?:within|in\s+under|for\s+up\s+to|for)\s+${DUR}`, 'i')))) out.timeoutMs = ms(m[1], m[2]);
  if ((m = take(new RegExp(String.raw`\s+(?:matching|valid\s+against|conforming\s+to)\s+(?:the\s+)?(?:json\s+)?schema\s+(${Q})`, 'i')))) out.schema = V(m[1], q);
  if ((m = take(/\s+(?:where|whose|with|matching)\s+(.+)$/i))) out.filters = parseFilters(m[1], q);
  // Not fatal: "Wait for a message in the inbox" may be a UI wait handled by another rule.
  if (rest.trim()) throw new Error(`Unexpected words in the message step: "${rest.trim()}"`);
  return out;
}

function waitClauseText(a: Args): string {
  const parts: string[] = [];
  const filters = (a.filters as BusFilter[] | undefined) ?? [];
  if (filters.length) parts.push(`where ${filters.map(filterText).join(' and ')}`);
  if (a.schema) parts.push(`matching schema ${quoteText(String(a.schema))}`);
  if (a.timeoutMs !== undefined) parts.push(`within ${msText(Number(a.timeoutMs))}`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/** Publish clauses: with key/routing key/header(s)/correlation id/qos/content type, retained. */
function publishClauses(text: string, q: string[]): Args {
  const out: Args = {};
  const headers: Record<string, string> = {};
  for (const raw of text.split(/\s+(?=with\s|retained\b|and\s+retain)/i)) {
    const c = raw.trim();
    if (!c) continue;
    let m: RegExpExecArray | null;
    if ((m = new RegExp(String.raw`^with\s+(?:the\s+)?routing\s+key\s+(${Q}|${VAR}|\S+)$`, 'i').exec(c))) out.routingKey = V(m[1], q);
    else if ((m = new RegExp(String.raw`^with\s+(?:the\s+)?(?:message\s+)?key\s+(${Q}|${VAR}|\S+)$`, 'i').exec(c))) out.key = V(m[1], q);
    else if ((m = new RegExp(String.raw`^with\s+(?:the\s+)?correlation\s*id\s+(${Q}|${VAR}|\S+)$`, 'i').exec(c))) out.correlationId = V(m[1], q);
    else if ((m = new RegExp(String.raw`^with\s+(?:the\s+)?content\s*type\s+(${Q}|\S+)$`, 'i').exec(c))) out.contentType = V(m[1], q);
    else if ((m = /^with\s+qos\s+([012])$/i.exec(c))) out.qos = Number(m[1]);
    else if (/^(?:retained|and\s+retain(?:ed)?)$/i.test(c)) out.retain = true;
    else if ((m = new RegExp(String.raw`^with\s+headers?\s+(.+)$`, 'i').exec(c))) {
      for (const h of m[1].split(/\s*,\s*|\s+and\s+/i)) {
        const hm = new RegExp(String.raw`^(${Q}|[\w.-]+)\s*(?:=|:)\s*(${Q}|${VAR}|\S+)$`).exec(h.trim());
        if (!hm) throw fatal(`Expected header "name" = "value", got "${h}"`);
        headers[nameOf(hm[1], q)] = V(hm[2], q);
      }
    } else throw fatal(`Unknown publish option "${c}"`);
  }
  if (Object.keys(headers).length) out.headers = headers;
  return out;
}

function publishClauseText(a: Args): string {
  const parts: string[] = [];
  const val = (v: unknown) => (/^\$\{[\w.]+\}$/.test(String(v)) ? String(v) : quoteText(String(v)));
  if (a.routingKey !== undefined) parts.push(`with routing key ${val(a.routingKey)}`);
  if (a.key !== undefined) parts.push(`with key ${val(a.key)}`);
  if (a.headers) parts.push(`with headers ${Object.entries(a.headers as Record<string, string>).map(([k, v]) => `${quoteText(k)} = ${val(v)}`).join(', ')}`);
  if (a.correlationId !== undefined) parts.push(`with correlation id ${val(a.correlationId)}`);
  if (a.contentType !== undefined) parts.push(`with content type ${quoteText(String(a.contentType))}`);
  if (a.qos !== undefined) parts.push(`with QoS ${String(a.qos)}`);
  if (a.retain) parts.push('retained');
  return parts.length ? ` ${parts.join(' ')}` : '';
}

const PUBLISH_KEYS = ['kind', 'op', 'broker', 'brokerKind', 'destType', 'dest', 'file', 'payload', 'routingKey', 'key', 'headers', 'correlationId', 'contentType', 'qos', 'retain'];
const WAIT_KEYS = ['kind', 'op', 'broker', 'brokerKind', 'destType', 'dest', 'listener', 'count', 'filters', 'schema', 'timeoutMs'];

function step(args: Args, keys: string[], captureAs?: string): StepBody {
  return { action: 'integration', args: ordered(args, keys), ...(captureAs ? { captureAs } : {}) } as StepBody;
}

function cat(category: string, rules: IntentRule[]): IntentRule[] {
  return rules.map((r) => ({ ...r, category }));
}

// ------------------------------------------------------------------ messaging
const BUS_RULES: IntentRule[] = cat('Messaging', [
  { name: 'bus-publish', keywords: ['publish', 'send', 'produce', 'put', 'emit'], example: 'Publish message from file "order.json" to Kafka topic "orders" on bus with key "${orderId}"',
    re: new RegExp(String.raw`^(?:publish|send|produce|put|post|emit)\s+(?:an?\s+|the\s+)?(?:message|event)?\s*(?:from\s+(?:the\s+)?file\s+(${Q})|(${Q}|${VAR}))\s+(?:to|on|onto|into)\s+${DEST}((?:\s+(?:with\s|retained|and\s+retain).*?)?)(?:\s+(?:and\s+)?(?:store|save|keep)\s+(?:it\s+)?as\s+${KEY}|\s+as\s+${KEY})?$`, 'i'),
    build: (m, q) => {
      const a: Args = { kind: 'bus', op: 'publish', ...dest(m, 3, q), ...(m[1] ? { file: V(m[1], q) } : { payload: V(m[2], q) }), ...publishClauses(m[7] ?? '', q) };
      return step(a, PUBLISH_KEYS, m[8] ?? m[9]);
    } },
  { name: 'bus-listen', keywords: ['start', 'listen', 'subscribe'], example: 'Start listening on Kafka topic "invoices" as invoices',
    re: new RegExp(String.raw`^(?:start\s+)?(?:listening|listen|subscribing|subscribe)\s+(?:on|to|for\s+messages\s+on)\s+${DEST}(?:\s+with\s+(?:the\s+)?(?:routing|binding)\s+key\s+(${Q}))?\s+as\s+${KEY}$`, 'i'),
    build: (m, q) => step({ kind: 'bus', op: 'listen', ...dest(m, 1, q), ...(m[5] ? { routingKey: V(m[5], q) } : {}), listener: m[6] }, ['kind', 'op', 'broker', 'brokerKind', 'destType', 'dest', 'routingKey', 'listener']) },
  { name: 'bus-wait', keywords: ['wait', 'receive', 'consume'], example: 'Wait for a message on Kafka topic "invoices" where "$.orderId" = ${orderId} within 30 s as invoice',
    re: new RegExp(String.raw`^(?:wait\s+for|receive|consume|read)\s+(?:an?\s+|the\s+next\s+|the\s+)?(?:(\d+)\s+)?(?:message|event)s?\s+(?:on|from|in)\s+(?:${DEST}|([A-Za-z_][\w-]*))(.*?)(?:\s+(?:and\s+)?(?:store|save|keep)\s+(?:it\s+|them\s+)?as\s+${KEY}|\s+as\s+${KEY})?$`, 'i'),
    build: (m, q) => {
      if (m[6] && /^(?:kafka|rabbit|amqp|mqtt|ibm|mq|jms|topic|queue|exchange|the|a|an|this|that)$/i.test(m[6])) return undefined;
      const a: Args = { kind: 'bus', op: 'wait', ...(m[6] ? { listener: m[6] } : dest(m, 2, q)), ...(m[1] && Number(m[1]) !== 1 ? { count: Number(m[1]) } : {}), ...waitClauses(m[7] ?? '', q) };
      return step(a, WAIT_KEYS, m[8] ?? m[9] ?? 'message');
    } },
  { name: 'bus-expect-none', keywords: ['expect', 'verify', 'ensure'], example: 'Expect no message on RabbitMQ queue "errors" within 5 s',
    re: new RegExp(String.raw`^(?:expect|verify|assert|ensure|confirm|check\s+that)\s+(?:that\s+)?no\s+(?:message|event)s?\s+(?:(?:arrives?|is\s+(?:published|received)|was\s+(?:published|received)|are\s+(?:published|received))\s+)?(?:on|in|from)\s+(?:${DEST}|([A-Za-z_][\w-]*))(.*)$`, 'i'),
    build: (m, q) => {
      if (m[5] && /^(?:the|a|an|this|that)$/i.test(m[5])) return undefined;
      const a: Args = { kind: 'bus', op: 'none', ...(m[5] ? { listener: m[5] } : dest(m, 1, q)), ...waitClauses(m[6] ?? '', q) };
      if (a.timeoutMs === undefined) a.timeoutMs = 5000;
      return step(a, WAIT_KEYS);
    } },
  { name: 'bus-stop', keywords: ['stop'], example: 'Stop listening to invoices',
    re: new RegExp(String.raw`^stop\s+(?:listening|subscribing)\s+(?:to|on)\s+${KEY}$`, 'i'),
    build: (m) => step({ kind: 'bus', op: 'stop', listener: m[1] }, ['kind', 'op', 'listener']) },
  { name: 'bus-purge', keywords: ['purge', 'clear', 'drain'], example: 'Purge RabbitMQ queue "orders.dlq"',
    re: new RegExp(String.raw`^(?:purge|drain|empty|clear)\s+(?:the\s+)?(?:${KIND}\s+)?(queue)\s+(${Q})(?:\s+on\s+([\w.-]+))?$`, 'i'),
    build: (m, q) => step({ kind: 'bus', op: 'purge', ...dest(m, 1, q) }, ['kind', 'op', 'broker', 'brokerKind', 'destType', 'dest']) },
]);

// ------------------------------------------------------------------ gRPC
const GRPC_RULES: IntentRule[] = cat('gRPC', [
  { name: 'grpc-call', keywords: ['call', 'invoke'], example: 'Call gRPC "shop.Orders/Get" on orders with \'{"id":42}\' as order',
    re: new RegExp(String.raw`^(?:call|invoke)\s+(?:the\s+)?grpc\s+(?:method\s+)?(${Q})\s+(?:on|at|of)\s+([\w.-]+)(?:\s+with\s+(?!metadata\b|timeout\b)(${Q}|${VAR}))?((?:\s+(?:with|expecting|and\s+allow)\b.*?)?)(?:\s+(?:and\s+)?(?:store|save|keep)\s+(?:it\s+|the\s+response\s+)?as\s+${KEY}|\s+as\s+${KEY})?$`, 'i'),
    build: (m, q) => {
      const a: Args = { kind: 'grpc', op: 'call', service: m[2], method: V(m[1], q), ...(m[3] ? { request: V(m[3], q) } : {}) };
      const metadata: Record<string, string> = {};
      for (const raw of (m[4] ?? '').split(/\s+(?=with\s|expecting\s|and\s+allow)/i)) {
        const c = raw.trim();
        if (!c) continue;
        let x: RegExpExecArray | null;
        if ((x = new RegExp(String.raw`^with\s+metadata\s+(.+)$`, 'i').exec(c))) {
          for (const h of x[1].split(/\s*,\s*/)) {
            const hm = new RegExp(String.raw`^(${Q}|[\w.-]+)\s*(?:=|:)\s*(${Q}|${VAR}|\S+)$`).exec(h.trim());
            if (!hm) throw fatal(`Expected metadata "name" = "value", got "${h}"`);
            metadata[nameOf(hm[1], q).toLowerCase()] = V(hm[2], q);
          }
        } else if ((x = new RegExp(String.raw`^with\s+timeout\s+${DUR}$`, 'i').exec(c))) a.timeoutMs = ms(x[1], x[2]);
        else if ((x = /^expecting\s+(?:the\s+)?(?:grpc\s+)?status\s+([A-Za-z_]+|\d+)$/i.exec(c))) a.expectStatus = /^\d+$/.test(x[1]) ? Number(x[1]) : x[1].toUpperCase();
        else if (/^and\s+allow\s+errors$/i.test(c)) a.allowErrors = true;
        else throw fatal(`Unknown gRPC option "${c}"`);
      }
      if (Object.keys(metadata).length) a.metadata = metadata;
      return step(a, ['kind', 'op', 'service', 'method', 'request', 'metadata', 'timeoutMs', 'expectStatus', 'allowErrors'], m[5] ?? m[6] ?? 'response');
    } },
]);

// ------------------------------------------------------------------ files, SSH, batch, EDI
const LOC = String.raw`(?:sftp\s+(${Q}|[A-Za-z_][\w.-]*)\s+(?:at|in|into|to|under)\s+(${Q})|(?:the\s+)?(?:local\s+)?folder\s+(${Q}))`;

function location(m: RegExpExecArray, i: number, q: string[]): Args {
  return m[i] ? { server: nameOf(m[i], q), dir: V(m[i + 1], q) } : { folder: V(m[i + 2], q) };
}

const FILE_RULES: IntentRule[] = cat('Files and SSH', [
  { name: 'file-upload', keywords: ['upload', 'copy', 'put', 'send'], example: 'Upload "batch.csv" to SFTP "partner" at "/in"',
    re: new RegExp(String.raw`^(?:upload|copy|put|send|drop)\s+(?:the\s+)?(?:file\s+)?(${Q})\s+(?:to|into|onto)\s+${LOC}(?:\s+as\s+(${Q}))?$`, 'i'),
    build: (m, q) => step({ kind: 'file', op: 'upload', ...location(m, 2, q), local: V(m[1], q), ...(m[5] ? { name: V(m[5], q) } : {}) }, ['kind', 'op', 'server', 'dir', 'folder', 'local', 'name']) },
  { name: 'file-download', keywords: ['download', 'fetch', 'get'], example: 'Download "/out/ack.csv" from SFTP "partner" as ack',
    re: new RegExp(String.raw`^(?:download|fetch|get)\s+(?:the\s+)?(?:file\s+)?(${Q})\s+from\s+sftp\s+(${Q}|[A-Za-z_][\w.-]*)\s+as\s+${KEY}$`, 'i'),
    build: (m, q) => step({ kind: 'file', op: 'download', server: nameOf(m[2], q), remote: V(m[1], q) }, ['kind', 'op', 'server', 'remote'], m[3]) },
  { name: 'file-wait', keywords: ['wait'], example: 'Wait for a file matching "ACK_*.csv" in "/out" on SFTP "partner" within 5 minutes as ack',
    re: new RegExp(String.raw`^wait\s+(?:for|until)\s+(?:an?\s+|the\s+)?file\s+(?:matching|named|like|called)\s+(${Q})\s+(?:to\s+appear\s+|appears\s+)?in\s+(?:(${Q})\s+on\s+sftp\s+(${Q}|[A-Za-z_][\w.-]*)|(?:the\s+)?(?:local\s+)?folder\s+(${Q}))(?:\s+(?:within|for\s+up\s+to)\s+${DUR})?(?:\s+as\s+${KEY})?$`, 'i'),
    build: (m, q) => step({ kind: 'file', op: 'wait', ...(m[3] ? { server: nameOf(m[3], q), dir: V(m[2], q) } : { folder: V(m[4], q) }), pattern: V(m[1], q), ...(m[5] ? { timeoutMs: ms(m[5], m[6]) } : {}) },
      ['kind', 'op', 'server', 'dir', 'folder', 'pattern', 'timeoutMs'], m[7] ?? 'file') },
  { name: 'file-delete', keywords: ['delete', 'remove'], example: 'Delete "/in/batch.csv" on SFTP "partner"',
    re: new RegExp(String.raw`^(?:delete|remove)\s+(?:the\s+)?(?:file\s+)?(${Q})\s+(?:on|from)\s+sftp\s+(${Q}|[A-Za-z_][\w.-]*)$`, 'i'),
    build: (m, q) => step({ kind: 'file', op: 'delete', server: nameOf(m[2], q), remote: V(m[1], q) }, ['kind', 'op', 'server', 'remote']) },
  { name: 'file-list', keywords: ['list'], example: 'List files in "/out" on SFTP "partner" as files',
    re: new RegExp(String.raw`^list\s+(?:the\s+)?files\s+in\s+(?:(${Q})\s+on\s+sftp\s+(${Q}|[A-Za-z_][\w.-]*)|(?:the\s+)?(?:local\s+)?folder\s+(${Q}))(?:\s+matching\s+(${Q}))?\s+as\s+${KEY}$`, 'i'),
    build: (m, q) => step({ kind: 'file', op: 'list', ...(m[2] ? { server: nameOf(m[2], q), dir: V(m[1], q) } : { folder: V(m[3], q) }), ...(m[4] ? { pattern: V(m[4], q) } : {}) }, ['kind', 'op', 'server', 'dir', 'folder', 'pattern'], m[5]) },
  { name: 'ssh-command', keywords: ['run', 'execute'], example: 'Run command "./close-day.sh 2026-01-31" on SSH "batch-host" as closing',
    re: new RegExp(String.raw`^(?:run|execute)\s+(?:the\s+)?(?:shell\s+)?command\s+(${Q})\s+on\s+(?:ssh\s+)?(?:host\s+)?(${Q}|[A-Za-z_][\w.-]*)(?:\s+expecting\s+exit\s+code\s+(\d+))?(?:\s+within\s+${DUR})?(?:\s+as\s+${KEY})?$`, 'i'),
    build: (m, q) => step({ kind: 'ssh', op: 'exec', host: nameOf(m[2], q), command: V(m[1], q), ...(m[3] !== undefined ? { exitCode: Number(m[3]) } : {}), ...(m[4] ? { timeoutMs: ms(m[4], m[5]) } : {}) },
      ['kind', 'op', 'host', 'command', 'exitCode', 'timeoutMs'], m[6]) },
  { name: 'batch-job', keywords: ['run', 'start', 'trigger'], example: 'Run batch job "close-day" with date=${today} and wait up to 10 minutes as job',
    re: new RegExp(String.raw`^(?:run|start|trigger|launch)\s+(?:the\s+)?batch\s+job\s+(${Q}|[A-Za-z_][\w.-]*)(?:\s+with\s+(.+?))?(?:\s+and\s+wait(?:\s+(?:up\s+to|for\s+up\s+to|at\s+most|for))?\s+${DUR})?(?:\s+as\s+${KEY})?$`, 'i'),
    build: (m, q) => {
      const params: Record<string, string> = {};
      if (m[2]) {
        for (const part of m[2].split(/\s*,\s*|\s+and\s+(?!wait\b)/i)) {
          const pm = new RegExp(String.raw`^([\w.-]+)\s*(?:=|:)\s*(${Q}|${VAR}|\S+)$`).exec(part.trim());
          if (!pm) throw fatal(`Expected name=value for a batch job parameter, got "${part}"`);
          params[pm[1]] = V(pm[2], q);
        }
      }
      return step({ kind: 'batch', op: 'run', job: nameOf(m[1], q), ...(Object.keys(params).length ? { params } : {}), ...(m[3] ? { timeoutMs: ms(m[3], m[4]) } : {}) }, ['kind', 'op', 'job', 'params', 'timeoutMs'], m[5]);
    } },
  { name: 'edi-read', keywords: ['read', 'parse', 'load'], example: 'Read the file ack as EDI into edi',
    re: new RegExp(String.raw`^(?:read|parse|load)\s+(?:the\s+)?(?:(?:download(?:ed\s+file)?|file|capture)\s+${KEY}|edi\s+file\s+(${Q}))\s+(?:as\s+(?:an?\s+)?edi(?:\s+(?:document|interchange|file))?\s+)?(?:into|as)\s+${KEY}$`, 'i'),
    build: (m, q) => {
      if (m[1] && !/\bedi\b/i.test(m[0])) return undefined;
      return step({ kind: 'edi', op: 'parse', ...(m[1] ? { from: m[1] } : { file: V(m[2], q) }) }, ['kind', 'op', 'from', 'file'], m[3]);
    } },
]);

// ------------------------------------------------------------------ contract consumer sessions
const CONTRACT_RULES: IntentRule[] = cat('API contracts', [
  { name: 'contract-start', keywords: ['start', 'begin', 'record', 'contract'], example: 'Start a contract between consumer "shop-web" and provider "orders-api"',
    re: new RegExp(String.raw`^(?:start|begin|record|open)\s+(?:a\s+|the\s+)?contract\s+between\s+(?:the\s+)?(?:consumer\s+)?${NAME}\s+and\s+(?:the\s+)?(?:provider\s+)?${NAME}(?:\s+in\s+(${Q}))?$`, 'i'),
    build: (m, q) => step({ kind: 'contract', op: 'start', consumer: nameOf(m[1], q), provider: nameOf(m[2], q), ...(m[3] ? { dir: V(m[3], q) } : {}) }, ['kind', 'op', 'consumer', 'provider', 'dir']) },
  { name: 'contract-state', keywords: ['given', 'provider'], example: 'Given provider state "order 42 exists" with id=42',
    re: new RegExp(String.raw`^(?:given\s+)?(?:that\s+)?(?:the\s+)?provider\s+(?:is\s+in\s+)?state\s+(${Q})(?:\s+with\s+(.+))?$`, 'i'),
    build: (m, q) => {
      const params: Record<string, string> = {};
      if (m[2]) {
        for (const part of m[2].split(/\s*,\s*|\s+and\s+/i)) {
          const pm = new RegExp(String.raw`^([\w.-]+)\s*(?:=|:)\s*(${Q}|${VAR}|\S+)$`).exec(part.trim());
          if (!pm) throw fatal(`Expected name=value for a provider state parameter, got "${part}"`);
          params[pm[1]] = V(pm[2], q);
        }
      }
      return step({ kind: 'contract', op: 'state', state: V(m[1], q), ...(Object.keys(params).length ? { params } : {}) }, ['kind', 'op', 'state', 'params']);
    } },
  { name: 'contract-stop', keywords: ['stop', 'end', 'finish', 'contract'], example: 'Finish the contract',
    re: /^(?:stop|end|finish|close)\s+(?:the\s+|recording\s+the\s+)?contract$/i,
    build: () => step({ kind: 'contract', op: 'stop' }, ['kind', 'op']) },
]);

export const INTEGRATION_RULES: IntentRule[] = [...BUS_RULES, ...GRPC_RULES, ...FILE_RULES, ...CONTRACT_RULES];

// ------------------------------------------------------------------ rendering

function val(v: unknown): string {
  return /^\$\{[\w.]+\}$/.test(String(v)) ? String(v) : quoteText(String(v));
}

const nm = (s: unknown) => (/^[A-Za-z_][\w.-]*$/.test(String(s)) ? String(s) : quoteText(String(s)));

/** Canonical .ez line for an `integration` step. */
export function integrationStepToText(s: Pick<Step, 'args' | 'captureAs'>): string {
  const a = (s.args ?? {}) as Args;
  const as = s.captureAs ? ` as ${s.captureAs}` : '';
  const kind = String(a.kind);
  const op = String(a.op);
  if (kind === 'bus') {
    const where = a.listener && op !== 'listen' && op !== 'stop' ? String(a.listener) : destText(a);
    switch (op) {
      case 'publish': {
        const what = a.file !== undefined ? `message from file ${quoteText(String(a.file))}` : `message ${val(a.payload)}`;
        return `Publish ${what} to ${destText(a)}${publishClauseText(a)}${as}`;
      }
      case 'listen': return `Start listening on ${destText(a)}${a.routingKey !== undefined ? ` with routing key ${quoteText(String(a.routingKey))}` : ''} as ${String(a.listener)}`;
      case 'wait': {
        const n = a.count ? `${String(a.count)} messages` : 'a message';
        return `Wait for ${n} ${a.listener ? 'in' : 'on'} ${where}${waitClauseText(a)} as ${s.captureAs ?? 'message'}`;
      }
      case 'none': return `Expect no message ${a.listener ? 'in' : 'on'} ${where}${waitClauseText(a)}`;
      case 'stop': return `Stop listening to ${String(a.listener)}`;
      case 'purge': return `Purge ${destText(a)}`;
    }
  }
  if (kind === 'grpc') {
    const parts = [`Call gRPC ${quoteText(String(a.method))} on ${String(a.service)}`];
    if (a.request !== undefined) parts.push(`with ${val(a.request)}`);
    if (a.metadata) parts.push(`with metadata ${Object.entries(a.metadata as Record<string, string>).map(([k, v]) => `${quoteText(k)} = ${val(v)}`).join(', ')}`);
    if (a.timeoutMs !== undefined) parts.push(`with timeout ${msText(Number(a.timeoutMs))}`);
    if (a.expectStatus !== undefined) parts.push(`expecting status ${String(a.expectStatus)}`);
    if (a.allowErrors) parts.push('and allow errors');
    return `${parts.join(' ')} as ${s.captureAs ?? 'response'}`;
  }
  if (kind === 'file') {
    const loc = a.server !== undefined ? `SFTP ${nm(a.server)}` : '';
    switch (op) {
      case 'upload': return `Upload ${quoteText(String(a.local))} to ${a.server !== undefined ? `${loc} at ${quoteText(String(a.dir))}` : `folder ${quoteText(String(a.folder))}`}${a.name !== undefined ? ` as ${quoteText(String(a.name))}` : ''}`;
      case 'download': return `Download ${quoteText(String(a.remote))} from ${loc}${as}`;
      case 'wait': return `Wait for a file matching ${quoteText(String(a.pattern))} in ${a.server !== undefined ? `${quoteText(String(a.dir))} on ${loc}` : `folder ${quoteText(String(a.folder))}`}${a.timeoutMs !== undefined ? ` within ${msText(Number(a.timeoutMs))}` : ''} as ${s.captureAs ?? 'file'}`;
      case 'delete': return `Delete ${quoteText(String(a.remote))} on ${loc}`;
      case 'list': return `List files in ${a.server !== undefined ? `${quoteText(String(a.dir))} on ${loc}` : `folder ${quoteText(String(a.folder))}`}${a.pattern !== undefined ? ` matching ${quoteText(String(a.pattern))}` : ''}${as}`;
    }
  }
  if (kind === 'ssh') {
    return `Run command ${quoteText(String(a.command))} on SSH ${nm(a.host)}${a.exitCode !== undefined ? ` expecting exit code ${String(a.exitCode)}` : ''}${a.timeoutMs !== undefined ? ` within ${msText(Number(a.timeoutMs))}` : ''}${as}`;
  }
  if (kind === 'batch') {
    const params = a.params ? ` with ${Object.entries(a.params as Record<string, string>).map(([k, v]) => `${k}=${val(v)}`).join(', ')}` : '';
    return `Run batch job ${nm(a.job)}${params}${a.timeoutMs !== undefined ? ` and wait up to ${msText(Number(a.timeoutMs))}` : ''}${as}`;
  }
  if (kind === 'edi') {
    return a.from !== undefined ? `Read the file ${String(a.from)} as EDI into ${s.captureAs}` : `Read the EDI file ${quoteText(String(a.file))} into ${s.captureAs}`;
  }
  if (kind === 'contract') {
    switch (op) {
      case 'start': return `Start a contract between consumer ${quoteText(String(a.consumer))} and provider ${quoteText(String(a.provider))}${a.dir !== undefined ? ` in ${quoteText(String(a.dir))}` : ''}`;
      case 'state': return `Given provider state ${quoteText(String(a.state))}${a.params ? ` with ${Object.entries(a.params as Record<string, string>).map(([k, v]) => `${k}=${val(v)}`).join(', ')}` : ''}`;
      case 'stop': return 'Finish the contract';
    }
  }
  throw fatal(`cannot render integration step ${kind}/${op}`);
}

/** "Expect no message ..." is a step of its own in .ez files (it listens), never a post-condition of the line above. */
export function isIntegrationExpectation(line: string): boolean {
  const { text } = protectQuotes(line.trim().replace(/[.;]+$/, '').replace(/^(?:and|then|but|also)\s+/i, ''));
  return BUS_RULES.find((r) => r.name === 'bus-expect-none')!.re.test(text);
}
