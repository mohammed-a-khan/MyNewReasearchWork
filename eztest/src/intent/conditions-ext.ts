/**
 * Advanced expectation phrasings and their canonical renderings: element
 * attributes, CSS, states, classes, count comparisons, sort order, regex;
 * tabs, dialogs, console, requests, WebSocket messages; JSON Schema,
 * JSONPath and response time of API responses; downloads, cookies, storage;
 * and safe expressions as a last resort.
 *
 * Rendering is the inverse of parsing: conditionToText(c) parses back to c.
 */
import { checkExpression, type CompareOp, type Condition, type ElementState, type Target } from '../core/index.js';
import { isQuoted, literal, quoteText, restoreQuotes } from './quotes.js';
import { tableRowsTarget } from './table-target.js';
import { describeTarget } from './target.js';

interface CondRule {
  name: string;
  re: RegExp;
  build(m: RegExpExecArray, q: string[]): Condition | undefined;
}

const Q = String.raw`⟦\d+⟧`;
const val = (s: string, q: string[]) => literal(s, q);
const tgt = (s: string, q: string[]): Target => describeTarget(restoreQuotes(s.trim(), q));
const isPageWord = (s: string) => /^(?:the\s+)?(?:current\s+|page\s+)?(?:url|address|title|page)$/i.test(s.trim());

const CMP: Record<string, 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne'> = {
  'more than': 'gt', 'over': 'gt', 'greater than': 'gt', 'at least': 'gte', 'no fewer than': 'gte', 'fewer than': 'lt', 'less than': 'lt', 'under': 'lt',
  'at most': 'lte', 'no more than': 'lte', 'exactly': 'eq', 'not exactly': 'ne',
};
const CMP_RE = String.raw`(more\s+than|over|greater\s+than|at\s+least|no\s+fewer\s+than|fewer\s+than|less\s+than|under|at\s+most|no\s+more\s+than|exactly|not\s+exactly)`;
const cmpOf = (s: string) => CMP[s.toLowerCase().replace(/\s+/g, ' ')];
const CMP_TEXT: Record<string, string> = { gt: 'more than', gte: 'at least', lt: 'fewer than', lte: 'at most', eq: 'exactly', ne: 'not exactly' };

const STATE_WORDS: Array<[RegExp, ElementState]> = [
  [/^enabled$/i, 'enabled'], [/^(?:disabled|not\s+enabled)$/i, 'disabled'], [/^editable$/i, 'editable'], [/^(?:read-?only|not\s+editable)$/i, 'readonly'],
  [/^(?:focused|in\s+focus|active)$/i, 'focused'], [/^(?:checked|ticked|selected)$/i, 'checked'], [/^(?:unchecked|not\s+checked|unticked|not\s+selected)$/i, 'unchecked'],
  [/^(?:in\s+the\s+viewport|in\s+view|on\s+screen|scrolled\s+into\s+view)$/i, 'inViewport'], [/^(?:not\s+in\s+the\s+viewport|out\s+of\s+view|off\s+screen)$/i, 'notInViewport'],
  [/^empty$/i, 'empty'], [/^stable$/i, 'stable'], [/^(?:detached|removed|gone\s+from\s+the\s+dom|not\s+in\s+the\s+dom)$/i, 'detached'], [/^(?:attached|in\s+the\s+dom)$/i, 'attached'],
];
const STATE_TEXT: Record<ElementState, string> = {
  enabled: 'enabled', disabled: 'disabled', editable: 'editable', readonly: 'read-only', focused: 'focused', checked: 'checked', unchecked: 'unchecked',
  inViewport: 'in the viewport', notInViewport: 'not in the viewport', attached: 'attached', detached: 'detached', visible: 'visible on screen', hidden: 'hidden from view',
  empty: 'empty', stable: 'stable',
};
const STATE_RE = String.raw`(enabled|disabled|not\s+enabled|editable|read-?only|not\s+editable|focused|in\s+focus|checked|ticked|selected|unchecked|not\s+checked|unticked|not\s+selected|in\s+the\s+viewport|in\s+view|on\s+screen|scrolled\s+into\s+view|not\s+in\s+the\s+viewport|out\s+of\s+view|off\s+screen|empty|stable|detached|removed|gone\s+from\s+the\s+dom|not\s+in\s+the\s+dom|attached|in\s+the\s+dom|visible\s+on\s+screen|hidden\s+from\s+view)`;
function stateOf(w: string): ElementState {
  if (/^visible\s+on\s+screen$/i.test(w)) return 'visible';
  if (/^hidden\s+from\s+view$/i.test(w)) return 'hidden';
  for (const [re, s] of STATE_WORDS) if (re.test(w.trim())) return s;
  throw new Error(`unknown state ${w}`);
}

const OP_WORDS: Array<[RegExp, CompareOp]> = [
  [/^(?:is|equals|=|==|is\s+equal\s+to)$/i, 'equals'], [/^(?:contains|includes)$/i, 'contains'], [/^matches$/i, 'matches'],
  [/^(?:is\s+not|does\s+not\s+equal|!=)$/i, 'ne'], [/^(?:is\s+greater\s+than|is\s+more\s+than|>)$/i, 'gt'], [/^(?:is\s+at\s+least|>=)$/i, 'gte'],
  [/^(?:is\s+less\s+than|<)$/i, 'lt'], [/^(?:is\s+at\s+most|<=)$/i, 'lte'],
];
const OP_RE = String.raw`(is\s+equal\s+to|equals|is\s+not|does\s+not\s+equal|is\s+greater\s+than|is\s+more\s+than|is\s+at\s+least|is\s+less\s+than|is\s+at\s+most|is|contains|includes|matches|==|!=|>=|<=|=|>|<)`;
const opOf = (w: string): CompareOp => OP_WORDS.find(([re]) => re.test(w.trim()))![1];
const OP_TEXT: Partial<Record<CompareOp, string>> = { equals: 'is', contains: 'contains', matches: 'matches', ne: 'is not', gt: 'is greater than', gte: 'is at least', lt: 'is less than', lte: 'is at most' };

const LEVELS: Record<string, string> = { error: 'errors', warning: 'warnings', info: 'info messages', log: 'log messages', debug: 'debug messages', pageerror: 'page errors', any: 'messages' };
const LEVEL_RE = String.raw`(errors?|warnings?|info\s+messages?|log\s+messages?|debug\s+messages?|page\s+errors?|javascript\s+errors?|js\s+errors?|messages?|logs?)`;
function levelOf(w: string): 'error' | 'warning' | 'info' | 'log' | 'debug' | 'pageerror' | 'any' {
  const s = w.toLowerCase();
  if (/^(?:javascript|js)\s+error/.test(s)) return 'pageerror';
  if (s.startsWith('page')) return 'pageerror';
  if (s.startsWith('error')) return 'error';
  if (s.startsWith('warning')) return 'warning';
  if (s.startsWith('info')) return 'info';
  if (s.startsWith('log ')) return 'log';
  if (s.startsWith('debug')) return 'debug';
  return 'any';
}

function bytes(n: string, unit?: string): number {
  const u = (unit ?? 'bytes').toLowerCase();
  const v = Number(n);
  if (/^k/.test(u)) return Math.round(v * 1024);
  if (/^m/.test(u)) return Math.round(v * 1024 * 1024);
  return Math.round(v);
}

function durationMs(n: string, unit: string): number {
  const v = Number(n);
  return /^(?:s|secs?|seconds?)$/i.test(unit) ? Math.round(v * 1000) : Math.round(v);
}

/** Advanced rules, checked before the core condition grammar. */
export const ADVANCED_CONDITION_RULES: CondRule[] = [
  // ---------------------------------------------------------------- locale-aware values and layout direction
  { name: 'locale-value', re: new RegExp(String.raw`^(.+?)\s+shows\s+the\s+(number|amount|date)\s+(${Q}|-?[\d.]+|\d{4}-\d{2}-\d{2})(?:\s+in\s+([A-Z]{3}))?(?:\s+(?:for|in)\s+locale\s+([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*))?$`, 'i'),
    build: (m, q) => ({
      type: 'localeValue', target: tgt(m[1], q), kind: m[2].toLowerCase() === 'amount' ? 'currency' : (m[2].toLowerCase() as 'number' | 'date'), value: val(m[3], q),
      ...(m[4] ? { currency: m[4].toUpperCase() } : {}), ...(m[5] ? { locale: m[5] } : {}),
    }) },
  { name: 'layout-direction', re: /^(?:the\s+)?(page|layout|.+?)\s+is\s+(?:laid\s+out\s+)?(right-to-left|rtl|left-to-right|ltr)$/i,
    build: (m, q) => {
      const dir = /^(?:right-to-left|rtl)$/i.test(m[2]) ? 'rtl' : 'ltr';
      return /^(?:page|layout)$/i.test(m[1]) ? { type: 'direction', dir } : { type: 'direction', dir, of: tgt(m[1], q) };
    } },
  // ---------------------------------------------------------------- tabs
  { name: 'tab-count', re: new RegExp(String.raw`^(?:there\s+(?:is|are)\s+(?:${CMP_RE}\s+)?(\d+)\s+(?:open\s+)?(?:tabs?|windows?|pages?)(?:\s+open)?|(\d+)\s+(?:tabs?|windows?)\s+(?:is|are)\s+open|the\s+number\s+of\s+(?:open\s+)?(?:tabs|windows)\s+is\s+(?:${CMP_RE}\s+)?(\d+))$`, 'i'),
    build: (m) => {
      const op = cmpOf(m[1] ?? m[4] ?? 'exactly');
      if (op === 'ne') return undefined;
      return { type: 'tabCount', op, value: Number(m[2] ?? m[3] ?? m[5]) };
    } },
  // ---------------------------------------------------------------- dialogs
  { name: 'dialog-seen', re: new RegExp(String.raw`^(?:an?\s+|the\s+)?(alert|confirm(?:ation)?|prompt|beforeunload|leave\s+page)?\s*(?:dialog|alert|popup|box)?\s*(?:(?:saying|with\s+(?:the\s+)?(?:text|message)|containing|that\s+says|says)\s+(${Q}))?(?:\s+(?:appears|appeared|was\s+shown|is\s+shown|opened|was\s+opened))?$`, 'i'),
    build: (m, q) => {
      const whole = m[0].trim();
      if (!/\b(?:dialog|alert|confirm|confirmation|prompt|beforeunload)\b/i.test(whole)) return undefined;
      if (!m[2] && !/(?:appears|appeared|was\s+shown|is\s+shown|opened)$/i.test(whole)) return undefined;
      const k = m[1]?.toLowerCase();
      const kind = !k ? undefined : k.startsWith('confirm') ? 'confirm' : /leave|beforeunload/.test(k) ? 'beforeunload' : (k as 'alert' | 'prompt');
      return { type: 'dialogSeen', ...(m[2] ? { contains: val(m[2], q) } : {}), ...(kind ? { kind } : {}) };
    } },
  // ---------------------------------------------------------------- console
  { name: 'console-none', re: new RegExp(String.raw`^(?:there\s+(?:are|is)\s+)?no\s+(?:browser\s+)?(?:console\s+)?${LEVEL_RE}(?:\s+in\s+the\s+console)?(?:\s+containing\s+(${Q}))?$|^the\s+console\s+has\s+no\s+${LEVEL_RE}(?:\s+containing\s+(${Q}))?$`, 'i'),
    build: (m, q) => {
      const lvl = levelOf(m[1] ?? m[3]);
      if (!/console|javascript|js|page/i.test(m[0]) && lvl === 'any') return undefined;
      return { type: 'console', level: lvl, max: 0, ...(m[2] || m[4] ? { contains: val(m[2] ?? m[4], q) } : {}) };
    } },
  { name: 'console-count', re: new RegExp(String.raw`^there\s+(?:are|is)\s+(at\s+most|at\s+least)\s+(\d+)\s+console\s+${LEVEL_RE}(?:\s+containing\s+(${Q}))?$`, 'i'),
    build: (m, q) => ({ type: 'console', level: levelOf(m[3]), ...(/most/i.test(m[1]) ? { max: Number(m[2]) } : { min: Number(m[2]) }), ...(m[4] ? { contains: val(m[4], q) } : {}) }) },
  { name: 'console-has', re: new RegExp(String.raw`^the\s+console\s+(?:has|shows|logs|contains|logged)\s+(?:an?\s+)?(?:${LEVEL_RE}\s+)?(?:containing\s+)?(${Q})$|^the\s+console\s+has\s+${LEVEL_RE}$`, 'i'),
    build: (m, q) => ({ type: 'console', level: m[1] || m[3] ? levelOf(m[1] ?? m[3]) : 'any', ...(m[2] ? { contains: val(m[2], q) } : {}) }) },
  // ---------------------------------------------------------------- network requests
  { name: 'request-made', re: new RegExp(String.raw`^(an?|no)\s+(?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+)?(?:request|call)\s+(?:was\s+|is\s+|has\s+been\s+)?(?:made|sent|fired)\s+to\s+(${Q}|\S+)((?:\s+with\s+(?:body\s+containing\s+${Q}|header\s+${Q}(?:\s*=\s*${Q})?|status\s+\d{3}))*)$`, 'i'),
    build: (m, q) => {
      const tail = m[4] ?? '';
      const body = new RegExp(`with\\s+body\\s+containing\\s+(${Q})`, 'i').exec(tail);
      const header = new RegExp(`with\\s+header\\s+(${Q})(?:\\s*=\\s*(${Q}))?`, 'i').exec(tail);
      const status = /with\s+status\s+(\d{3})/i.exec(tail);
      return {
        type: 'request', url: val(m[3], q), ...(m[2] ? { method: m[2].toUpperCase() } : {}), ...(body ? { bodyContains: val(body[1], q) } : {}),
        ...(header ? { header: val(header[1], q), ...(header[2] ? { headerValue: val(header[2], q) } : {}) } : {}),
        ...(status ? { status: Number(status[1]) } : {}), ...(m[1].toLowerCase() === 'no' ? { negate: true } : {}),
      };
    } },
  { name: 'request-payload', re: new RegExp(String.raw`^the\s+(?:(GET|POST|PUT|PATCH|DELETE)\s+)?request\s+to\s+(${Q}|\S+)\s+(?:contains|had\s+(?:a\s+)?body\s+containing|sent)\s+(${Q})$|^the\s+(?:(GET|POST|PUT|PATCH|DELETE)\s+)?request\s+to\s+(${Q}|\S+)\s+had\s+header\s+(${Q})(?:\s*=\s*(${Q}))?$`, 'i'),
    build: (m, q) => (m[3]
      ? { type: 'request', url: val(m[2], q), bodyContains: val(m[3], q), ...(m[1] ? { method: m[1].toUpperCase() } : {}) }
      : { type: 'request', url: val(m[5], q), header: val(m[6], q), ...(m[7] ? { headerValue: val(m[7], q) } : {}), ...(m[4] ? { method: m[4].toUpperCase() } : {}) }) },
  // ---------------------------------------------------------------- websocket
  { name: 'ws-message', re: new RegExp(String.raw`^an?\s+web\s*socket\s+message\s+containing\s+(${Q})(?:\s+(?:was\s+received|arrived|is\s+received))?(?:\s+on\s+(?:web\s*socket\s+)?(\w+))?$|^(?:the\s+)?web\s*socket(?:\s+(\w+))?\s+received\s+(${Q})$`, 'i'),
    build: (m, q) => ({ type: 'wsMessage', contains: val(m[1] ?? m[4], q), ...(m[2] || m[3] ? { socket: m[2] ?? m[3] } : {}) }) },
  // ---------------------------------------------------------------- API responses
  { name: 'json-schema', re: new RegExp(String.raw`^(?:the\s+)?(?:response\s+)?([\w.]+)(?:\s+response)?\s+(?:matches|conforms\s+to|is\s+valid\s+against|validates\s+against)\s+(?:the\s+)?(?:json\s+)?schema\s+(${Q})$`, 'i'),
    build: (m, q) => ({ type: 'jsonSchema', captureKey: m[1], schemaFile: val(m[2], q) }) },
  { name: 'json-path', re: new RegExp(String.raw`^(?:the\s+)?(?:response\s+)?([\w.]+)(?:\s+response)?\s+(?:(has|does\s+not\s+have)\s+(${Q})|(${Q})\s+${OP_RE}\s+(${Q}|\S+))$`, 'i'),
    build: (m, q) => {
      const path = val(m[3] ?? m[4], q);
      if (!/^\$(?:[.[]|$)/.test(path)) return undefined; // a JSONPath ($.x, $[0]), not ${var}
      if (m[2]) return { type: 'jsonPath', captureKey: m[1], path, op: /not/i.test(m[2]) ? 'absent' : 'exists' };
      return { type: 'jsonPath', captureKey: m[1], path, op: opOf(m[5]), value: val(m[6], q) };
    } },
  { name: 'response-time', re: /^(?:the\s+)?(?:response\s+)?([\w.]+)(?:\s+response)?\s+(?:responded|took|returned|answered|completed)\s+(?:within|in\s+under|in\s+less\s+than|under|less\s+than|in\s+at\s+most|at\s+most)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)$|^the\s+response\s+time\s+of\s+([\w.]+)\s+is\s+(?:under|below|less\s+than|at\s+most)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)$/i,
    build: (m) => ({ type: 'responseTime', captureKey: m[1] ?? m[4], maxMs: durationMs(m[2] ?? m[5], m[3] ?? m[6]) }) },
  // ---------------------------------------------------------------- downloads
  { name: 'download-props', re: new RegExp(String.raw`^(?:the\s+)?(?:download|downloaded\s+file)\s+([\w.]+)\s+(?:is\s+named\s+(${Q})|name\s+(?:is\s+)?(${Q})|name\s+matches\s+(${Q})|(?:is\s+an?|has\s+type|is\s+of\s+type)\s+(${Q}|[\w./+-]+)(?:\s+file)?|is\s+(larger|bigger|smaller)\s+than\s+(\d+(?:\.\d+)?)\s*(bytes?|kb|kib|mb|mib)?|is\s+at\s+(least|most)\s+(\d+(?:\.\d+)?)\s*(bytes?|kb|kib|mb|mib)?)$`, 'i'),
    build: (m, q) => {
      const key = m[1];
      if (m[2] || m[3]) return { type: 'download', captureKey: key, name: val(m[2] ?? m[3], q) };
      if (m[4]) return { type: 'download', captureKey: key, nameMatches: val(m[4], q) };
      if (m[5]) return { type: 'download', captureKey: key, contentType: val(m[5], q) };
      if (m[6]) {
        const n = bytes(m[7], m[8]);
        return /smaller/i.test(m[6]) ? { type: 'download', captureKey: key, maxBytes: n - 1 } : { type: 'download', captureKey: key, minBytes: n + 1 };
      }
      const n = bytes(m[10], m[11]);
      return /least/i.test(m[9]) ? { type: 'download', captureKey: key, minBytes: n } : { type: 'download', captureKey: key, maxBytes: n };
    } },
  // ---------------------------------------------------------------- cookies and storage
  { name: 'cookie', re: new RegExp(String.raw`^(?:the\s+)?cookie\s+(${Q}|[\w-]+)\s+(exists|is\s+set|does\s+not\s+exist|is\s+not\s+set|is\s+absent|${OP_RE}\s+(${Q}|\S+))$|^there\s+is\s+no\s+cookie\s+(${Q}|[\w-]+)$`, 'i'),
    build: (m, q) => {
      if (m[5]) return { type: 'cookie', name: val(m[5], q), op: 'absent' };
      const w = m[2].toLowerCase();
      if (/^(?:exists|is\s+set)$/.test(w)) return { type: 'cookie', name: val(m[1], q), op: 'exists' };
      if (/not|absent/.test(w) && !m[3]) return { type: 'cookie', name: val(m[1], q), op: 'absent' };
      return { type: 'cookie', name: val(m[1], q), op: opOf(m[3]), value: val(m[4], q) };
    } },
  { name: 'storage', re: new RegExp(String.raw`^(?:the\s+)?(local|session)\s+storage\s+(?:item\s+|key\s+)?(${Q}|[\w.-]+)\s+(exists|is\s+set|does\s+not\s+exist|is\s+not\s+set|is\s+absent|${OP_RE}\s+(${Q}|\S+))$|^(?:the\s+)?(local|session)\s+storage\s+(has|does\s+not\s+have)\s+(?:an?\s+)?(?:item\s+|key\s+)?(${Q}|[\w.-]+)$`, 'i'),
    build: (m, q) => {
      if (m[6]) return { type: 'storage', area: m[6].toLowerCase() as 'local', key: val(m[8], q), op: /not/i.test(m[7]) ? 'absent' : 'exists' };
      const area = m[1].toLowerCase() as 'local' | 'session';
      const w = m[3].toLowerCase();
      if (/^(?:exists|is\s+set)$/.test(w)) return { type: 'storage', area, key: val(m[2], q), op: 'exists' };
      if (/not|absent/.test(w) && !m[4]) return { type: 'storage', area, key: val(m[2], q), op: 'absent' };
      return { type: 'storage', area, key: val(m[2], q), op: opOf(m[4]), value: val(m[5], q) };
    } },
  // ---------------------------------------------------------------- element attributes, CSS, classes
  { name: 'attribute-of', re: new RegExp(String.raw`^the\s+(${Q})\s+attribute\s+of\s+(.+?)\s+${OP_RE}\s+(${Q}|\S+)$`, 'i'),
    build: (m, q) => ({ type: 'attribute', target: tgt(m[2], q), name: val(m[1], q), op: opOf(m[3]), value: val(m[4], q) }) },
  { name: 'has-attribute', re: new RegExp(String.raw`^(.+?)\s+(has|does\s+not\s+have)\s+(?:the\s+|an?\s+)?attribute\s+(${Q})(?:\s*(?:=|equal\s+to|with\s+value|set\s+to)\s*(${Q}|\S+))?$`, 'i'),
    build: (m, q) => (/not/i.test(m[2])
      ? { type: 'attribute', target: tgt(m[1], q), name: val(m[3], q), op: 'absent' }
      : m[4] ? { type: 'attribute', target: tgt(m[1], q), name: val(m[3], q), op: 'equals', value: val(m[4], q) }
        : { type: 'attribute', target: tgt(m[1], q), name: val(m[3], q), op: 'exists' }) },
  { name: 'css-of', re: new RegExp(String.raw`^the\s+(?:css|computed\s+style|style)\s+(${Q})\s+of\s+(.+?)\s+(?:is|equals)\s+(${Q}|\S+)$|^the\s+(${Q})\s+(?:css|style)\s+of\s+(.+?)\s+(?:is|equals)\s+(${Q}|\S+)$|^(.+?)\s+has\s+(?:the\s+)?(?:css|style)\s+(${Q})\s*(?:=|of|set\s+to|equal\s+to)\s*(${Q}|\S+)$`, 'i'),
    build: (m, q) => ({ type: 'css', target: tgt(m[2] ?? m[5] ?? m[7], q), property: val(m[1] ?? m[4] ?? m[8], q), value: val(m[3] ?? m[6] ?? m[9], q) }) },
  { name: 'has-class', re: new RegExp(String.raw`^(.+?)\s+(has|does\s+not\s+have)\s+(?:the\s+)?(?:css\s+)?class\s+(${Q}|[\w-]+)$`, 'i'),
    build: (m, q) => ({ type: 'hasClass', target: tgt(m[1], q), value: val(m[3], q), ...(/not/i.test(m[2]) ? { negate: true } : {}) }) },
  // ---------------------------------------------------------------- sort order
  { name: 'sorted', re: new RegExp(String.raw`^(?:the\s+(${Q})\s+column\s+(?:of|in)\s+(.+?)|(.+?))\s+(?:is|are)\s+sorted(?:\s+(?:in\s+)?(ascending|descending|asc|desc|a-z|z-a|alphabetically|numerically|reverse)(?:\s+order)?)?(?:\s+(numerically|alphabetically))?$`, 'i'),
    build: (m, q) => {
      const w = `${m[4] ?? ''} ${m[5] ?? ''}`.toLowerCase();
      const order = /desc|z-a|reverse/.test(w) ? 'desc' : 'asc';
      const numeric = /numerically/.test(w) ? true : /alphabetically/.test(w) ? false : undefined;
      return m[1]
        ? { type: 'sorted', target: tgt(m[2], q), column: val(m[1], q), order, ...(numeric !== undefined ? { numeric } : {}) }
        : { type: 'sorted', target: tgt(m[3], q), order, ...(numeric !== undefined ? { numeric } : {}) };
    } },
  // ---------------------------------------------------------------- counts
  { name: 'count-between', re: /^there\s+(?:are|is)\s+between\s+(\d+)\s+and\s+(\d+)\s+(rows?\s+in\s+)?(.+)$/i,
    build: (m, q) => ({ type: 'countCompare', target: m[3] ? tableRowsTarget(restoreQuotes(m[4], q)) : tgt(m[4], q), op: 'between', value: Number(m[1]), max: Number(m[2]) }) },
  { name: 'count-rows-compare', re: new RegExp(String.raw`^there\s+(?:are|is)\s+${CMP_RE}\s+(\d+)\s+rows?\s+in\s+(.+)$|^(.+?\s+(?:table|grid))\s+(?:has|have|contains|shows)\s+${CMP_RE}\s+(\d+)\s+rows?$`, 'i'),
    build: (m, q) => ({ type: 'countCompare', target: tableRowsTarget(restoreQuotes(m[3] ?? m[4], q)), op: cmpOf(m[1] ?? m[5]), value: Number(m[2] ?? m[6]) }) },
  { name: 'count-compare', re: new RegExp(String.raw`^there\s+(?:are|is)\s+${CMP_RE}\s+(\d+)\s+(.+)$|^(.+?)\s+(?:has|have|contains|shows)\s+${CMP_RE}\s+(\d+)\s+(?:items|elements|entries|matches|occurrences)$|^the\s+(?:number|count)\s+of\s+(.+?)\s+is\s+(greater\s+than|more\s+than|less\s+than|fewer\s+than|at\s+least|at\s+most)\s+(\d+)$`, 'i'),
    build: (m, q) => {
      if (m[3] && /^(?:open\s+)?(?:tabs?|windows?|pages?)(?:\s+open)?$/i.test(m[3])) return undefined;
      if (m[3] && /^console\s/i.test(m[3])) return undefined;
      return { type: 'countCompare', target: tgt(m[3] ?? m[4] ?? m[7], q), op: cmpOf(m[1] ?? m[5] ?? m[8]), value: Number(m[2] ?? m[6] ?? m[9]) };
    } },
  // ---------------------------------------------------------------- states and regex
  { name: 'state', re: new RegExp(String.raw`^(.+?)\s+(?:is|are)\s+(?:currently\s+)?${STATE_RE}$`, 'i'),
    build: (m, q) => (isPageWord(m[1]) ? undefined : { type: 'state', target: tgt(m[1], q), state: stateOf(m[2]) }) },
  { name: 'text-matches', re: new RegExp(String.raw`^the\s+(text|value)\s+of\s+(.+?)\s+matches\s+(${Q}|/\S+/[gimsuy]*)$|^(.+?)\s+(?:text\s+)?matches\s+(${Q}|/\S+/[gimsuy]*)$`, 'i'),
    build: (m, q) => {
      const target = m[2] ?? m[4];
      if (isPageWord(target)) return undefined;
      const raw = m[3] ?? m[5];
      const pattern = isQuoted(raw) ? val(raw, q) : raw;
      return { type: 'textMatches', target: tgt(target, q), pattern, ...(m[1]?.toLowerCase() === 'value' ? { field: 'value' as const } : {}) };
    } },
  // ---------------------------------------------------------------- DB rows and explicit expressions
  { name: 'query-rows-compare', re: new RegExp(String.raw`^(?:the\s+)?(?:query|result|results)\s+([\w.]+)\s+(?:returns|returned|has|contains)\s+${CMP_RE}\s+(\d+)\s+rows?$`, 'i'),
    build: (m) => {
      const op = cmpOf(m[2]);
      const sym = { gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '==', ne: '!=' }[op];
      return { type: 'expr', expr: `len(${m[1]}) ${sym} ${m[3]}` };
    } },
  { name: 'expression-true', re: new RegExp(String.raw`^the\s+expression\s+(${Q})\s+is\s+(true|false)$`, 'i'),
    build: (m, q) => {
      const e = val(m[1], q);
      const err = checkExpression(e);
      if (err) throw new Error(err);
      return { type: 'expr', expr: m[2].toLowerCase() === 'false' ? `not (${e})` : e };
    } },
];

/** Last resort: a safe expression with an operator or function call ("${total} > 100", "len(rows) >= 2"). */
export const FALLBACK_CONDITION_RULES: CondRule[] = [
  { name: 'expression', re: /^(.+)$/,
    build: (m, q) => {
      const e = restoreQuotes(m[1], q).trim();
      if (!/[<>=!]=?|\(|\b(?:and|or|not|contains|matches|in|startsWith|endsWith)\b/.test(e)) return undefined;
      return checkExpression(e) ? undefined : { type: 'expr', expr: e };
    } },
];

/** Render an advanced condition as an expectation phrase that parses back to it. */
export function advancedConditionToText(c: Condition): string {
  const d = (t: Target) => t.description;
  switch (c.type) {
    case 'attribute':
      if (c.op === 'exists') return `${d(c.target)} has attribute ${quoteText(c.name)}`;
      if (c.op === 'absent') return `${d(c.target)} does not have attribute ${quoteText(c.name)}`;
      return `the ${quoteText(c.name)} attribute of ${d(c.target)} ${OP_TEXT[c.op]} ${quoteText(c.value ?? '')}`;
    case 'css': return `the CSS ${quoteText(c.property)} of ${d(c.target)} is ${quoteText(c.value)}`;
    case 'state': return `${d(c.target)} is ${STATE_TEXT[c.state]}`;
    case 'hasClass': return `${d(c.target)} ${c.negate ? 'does not have' : 'has'} class ${quoteText(c.value)}`;
    case 'countCompare': {
      const rows = /^rows in /.exec(d(c.target));
      if (c.op === 'between') return `there are between ${c.value} and ${c.max ?? c.value} ${d(c.target)}`;
      if (rows) return `there are ${CMP_TEXT[c.op]} ${c.value} ${d(c.target)}`;
      return `there are ${CMP_TEXT[c.op]} ${c.value} ${d(c.target)}`;
    }
    case 'sorted': {
      const tail = `${c.order === 'desc' ? 'descending' : 'ascending'}${c.numeric === true ? ' numerically' : c.numeric === false ? ' alphabetically' : ''}`;
      return c.column !== undefined ? `the ${quoteText(c.column)} column of ${d(c.target)} is sorted ${tail}` : `${d(c.target)} are sorted ${tail}`;
    }
    case 'textMatches': return `the ${c.field === 'value' ? 'value' : 'text'} of ${d(c.target)} matches ${quoteText(c.pattern)}`;
    case 'localeValue': return `${d(c.target)} shows the ${c.kind === 'currency' ? 'amount' : c.kind} ${quoteText(c.value)}${c.currency ? ` in ${c.currency}` : ''}${c.locale ? ` for locale ${c.locale}` : ''}`;
    case 'direction': return `${c.of ? d(c.of) : 'the page'} is ${c.dir === 'rtl' ? 'right-to-left' : 'left-to-right'}`;
    case 'expr': return `the expression ${quoteText(c.expr)} is true`;
    case 'tabCount': return `there are ${CMP_TEXT[c.op === 'eq' ? 'eq' : c.op]} ${c.value} tabs open`;
    case 'dialogSeen': {
      const noun = c.kind === 'alert' ? 'an alert' : c.kind === 'confirm' ? 'a confirm dialog' : c.kind === 'prompt' ? 'a prompt dialog' : c.kind === 'beforeunload' ? 'a beforeunload dialog' : 'a dialog';
      return c.contains !== undefined ? `${noun} saying ${quoteText(c.contains)}` : `${noun} appeared`;
    }
    case 'console': {
      const words = LEVELS[c.level];
      const contains = c.contains !== undefined ? ` containing ${quoteText(c.contains)}` : '';
      if (c.max === 0 && c.min === undefined) return `there are no console ${words}${contains}`;
      if (c.max !== undefined && c.min === undefined) return `there are at most ${c.max} console ${words}${contains}`;
      if (c.min !== undefined && c.max === undefined) return `there are at least ${c.min} console ${words}${contains}`;
      if (c.contains !== undefined) return c.level === 'any' ? `the console contains ${quoteText(c.contains)}` : `the console has ${words}${contains}`;
      return `the console has ${words}`;
    }
    case 'request': {
      let s = `${c.negate ? 'no' : 'a'} ${c.method ? `${c.method} ` : ''}request was made to ${quoteText(c.url)}`;
      if (!c.negate) {
        if (c.bodyContains !== undefined) s += ` with body containing ${quoteText(c.bodyContains)}`;
        if (c.header !== undefined) s += ` with header ${quoteText(c.header)}${c.headerValue !== undefined ? ` = ${quoteText(c.headerValue)}` : ''}`;
        if (c.status !== undefined) s += ` with status ${c.status}`;
      }
      return s;
    }
    case 'wsMessage': return c.socket ? `websocket ${c.socket} received ${quoteText(c.contains)}` : `a websocket message containing ${quoteText(c.contains)} was received`;
    case 'jsonSchema':
      if (!c.schemaFile) throw new Error('an inline JSON Schema cannot be written in .ez; keep this journey in YAML/JSON or use a schema file');
      return `response ${c.captureKey} matches schema ${quoteText(c.schemaFile)}`;
    case 'jsonPath':
      if (c.op === 'exists') return `response ${c.captureKey} has ${quoteText(c.path)}`;
      if (c.op === 'absent') return `response ${c.captureKey} does not have ${quoteText(c.path)}`;
      return `response ${c.captureKey} ${quoteText(c.path)} ${c.op === 'equals' ? 'equals' : OP_TEXT[c.op]} ${quoteText(c.value ?? '')}`;
    case 'responseTime': return `response ${c.captureKey} responded within ${c.maxMs} ms`;
    case 'download': {
      const k = `the download ${c.captureKey}`;
      const fields = [c.name, c.nameMatches, c.contentType, c.minBytes, c.maxBytes].filter((x) => x !== undefined).length;
      if (fields !== 1) throw new Error('a download check with several properties cannot be written as one .ez line');
      if (c.name !== undefined) return `${k} is named ${quoteText(c.name)}`;
      if (c.nameMatches !== undefined) return `${k} name matches ${quoteText(c.nameMatches)}`;
      if (c.contentType !== undefined) return `${k} has type ${quoteText(c.contentType)}`;
      if (c.minBytes !== undefined) return `${k} is at least ${c.minBytes} bytes`;
      return `${k} is at most ${c.maxBytes} bytes`;
    }
    case 'cookie':
      if (c.op === 'exists') return `cookie ${quoteText(c.name)} exists`;
      if (c.op === 'absent') return `cookie ${quoteText(c.name)} does not exist`;
      return `cookie ${quoteText(c.name)} ${OP_TEXT[c.op]} ${quoteText(c.value ?? '')}`;
    case 'storage':
      if (c.op === 'exists') return `${c.area} storage ${quoteText(c.key)} exists`;
      if (c.op === 'absent') return `${c.area} storage ${quoteText(c.key)} does not exist`;
      return `${c.area} storage ${quoteText(c.key)} ${OP_TEXT[c.op]} ${quoteText(c.value ?? '')}`;
    default:
      throw new Error(`cannot render condition ${(c as { type: string }).type}`);
  }
}
