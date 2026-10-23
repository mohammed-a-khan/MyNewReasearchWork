/**
 * Advanced plain-English phrasings: tabs/windows/popups, frames, dialogs,
 * keyboard, mouse and gestures, DOM events, DOM queries, page scripts,
 * network control, browser state, API/GraphQL/SOAP/WebSocket, databases,
 * email/SMS, waits, variables and flow control.
 *
 * These rules are checked right after the assertion rules and before the
 * core rules, so specific phrasings ("Open a new tab with /x", "Type "x"
 * slowly into ...") win over the generic ones ("Open <url>", "Type <x> into <y>").
 * Like the core grammar they are deterministic regexes: no AI involved.
 */
import type { ApiCall, Condition, StepInput, Target } from '../core/index.js';
import { checkExpression } from '../core/index.js';
import { parseCondition, tryParseCondition } from './conditions.js';
import { literal, restoreQuotes } from './quotes.js';
import { describeTarget } from './target.js';
import type { IntentRule, StepBody } from './rules.js';

const Q = String.raw`⟦\d+⟧`;
const KEY = String.raw`([A-Za-z_][\w.-]*)`;
const DUR = String.raw`(\d+(?:\.\d+)?)\s*(ms|millis|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)`;
const STORE = String.raw`(?:\s+(?:and\s+)?(?:store|save|capture|keep|remember)\s+(?:it\s+|them\s+|the\s+(?:result|response|value|message|text|request|event)\s+)?as\s+${KEY})`;
const ORD: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const ORDS = Object.keys(ORD).join('|');

const T = (s: string, q: string[]): Target => describeTarget(restoreQuotes(s.trim(), q));
const V = (s: string, q: string[]) => literal(s, q);

function ms(n: string, unit?: string): number {
  const v = Number(n);
  const u = (unit ?? 'ms').toLowerCase();
  if (/^(?:ms|millis|milliseconds?)$/.test(u)) return Math.round(v);
  if (/^(?:s|secs?|seconds?)$/.test(u)) return Math.round(v * 1000);
  return Math.round(v * 60_000);
}

/** "a=1, b="x y"" (comma or "and" separated) into a record. */
function kv(s: string, q: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(/\s*(?:,|\band\b)\s*/i)) {
    if (!part.trim()) continue;
    const m = /^(⟦\d+⟧|[\w.-]+)\s*(?:=|:|is)\s*(.+)$/i.exec(part.trim());
    if (!m) throw new Error(`Expected name=value, got "${restoreQuotes(part, q)}"`);
    out[V(m[1], q)] = V(m[2], q);
  }
  return out;
}

/** A list of quoted values ("a", "b" and "c"). */
function quotedList(s: string, q: string[]): string[] {
  return s.split(/\s*(?:,|\band\b)\s*/i).filter(Boolean).map((x) => V(x, q));
}

/** Parse a nested single-line step ("... then click the "OK" button"); the import is late-bound to avoid a cycle. */
let parseInner: (line: string) => StepInput = () => {
  throw new Error('nested step parser not initialised');
};
export function setInnerParser(fn: typeof parseInner): void {
  parseInner = fn;
}
const inner = (s: string, q: string[]) => [parseInner(restoreQuotes(s.trim(), q))];
/** One inline child step of a single-line block (for rule sets outside this file, e.g. "As manager: click ..."). */
export const innerStep = (s: string, q: string[]) => inner(s, q);

/**
 * A rule error that ends parsing of the line: the phrasing was recognised
 * (e.g. "Set variable ...") but its content is invalid, so no other rule may
 * reinterpret the line (e.g. as filling a field named "variable x").
 */
export class FatalRuleError extends Error {
  readonly fatal = true;
}

/** If/While condition: a declarative condition, else a safe expression. */
export function flowCondition(text: string): { condition?: Condition; expr?: string } {
  const t = text.trim().replace(/[:,]$/, '').trim();
  const c = tryParseCondition(t);
  if (c) return c.type === 'expr' ? { expr: c.expr } : { condition: c };
  const err = checkExpression(t);
  if (err) throw new FatalRuleError(`Cannot understand the condition "${t}": not a known expectation, and not an expression (${err})`);
  return { expr: t };
}

/**
 * A block step. With an inline step ("Repeat 3 times: press Tab") it carries
 * that one child; without, `steps` is empty and the .ez parser fills it from
 * the following lines up to "End".
 */
const block = (action: StepBody['action'], flow: StepBody['flow'], rest: string | undefined, q: string[], extra: Partial<StepBody> = {}): StepBody =>
  ({ action, ...(flow ? { flow } : {}), ...extra, steps: rest ? inner(rest, q) : [] });

/** "status 200 and body "x" and header "a" = "b"" option clauses for mocks. */
function mockOptions(tail: string, q: string[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const raw of tail.split(/\s+(?:and|with)\s+|\s*,\s*(?=(?:status|body|json|file|header|headers|content)\b)/i)) {
    const p = raw.trim();
    if (!p) continue;
    let m: RegExpExecArray | null;
    if ((m = /^(?:a\s+)?(?:status(?:\s+code)?\s+)?(\d{3})$/i.exec(p)) || (m = /^status(?:\s+code)?\s+(\d{3})$/i.exec(p))) o.status = Number(m[1]);
    else if ((m = new RegExp(`^(?:the\\s+)?(?:body|json|text)\\s+(?:from\\s+(?:the\\s+)?file\\s+)(${Q})$`, 'i').exec(p)) || (m = new RegExp(`^(?:the\\s+)?file\\s+(${Q})$`, 'i').exec(p))) o.bodyFile = V(m[1], q);
    else if ((m = new RegExp(`^(?:the\\s+)?(?:body|json|text)\\s+(${Q})$`, 'i').exec(p))) o.body = V(m[1], q);
    else if ((m = new RegExp(`^(?:the\\s+)?header\\s+(${Q})\\s*(?:=|:|set\\s+to|to)\\s*(${Q})$`, 'i').exec(p))) o.headers = { ...(o.headers as object), [V(m[1], q)]: V(m[2], q) };
    else if ((m = /^headers\s+(.+)$/i.exec(p))) o.headers = { ...(o.headers as object), ...kv(m[1], q) };
    else if ((m = new RegExp(`^content[-\\s]type\\s+(${Q}|\\S+)$`, 'i').exec(p))) o.contentType = V(m[1], q);
    else if ((m = /^(?:only\s+)?(once|twice|(\d+)\s+times?)$/i.exec(p))) o.times = m[1].toLowerCase() === 'once' ? 1 : m[1].toLowerCase() === 'twice' ? 2 : Number(m[2]);
    else throw new Error(`Unknown mock option "${restoreQuotes(p, q)}" (use status N, body "...", body from file "...", header "k" = "v")`);
  }
  return o;
}

/** API call option clauses: "with form a=1, b=2", "with query ...", "with headers ...", "with header "k" = "v"", "with multipart ...", "with body from file "x"", "with body "..."", "with timeout 5s". */
function apiOptions(tail: string, q: string[]): Partial<ApiCall> & { asRole?: string; key?: string; allowErrors?: boolean } {
  const out: Partial<ApiCall> & { asRole?: string; key?: string; allowErrors?: boolean } = {};
  let rest = tail.trim();
  const store = new RegExp(`${STORE}$`, 'i').exec(rest);
  if (store) {
    out.key = store[1];
    rest = rest.slice(0, store.index).trim();
  }
  const role = /^as\s+([\w-]+)(?=\s|$)/i.exec(rest);
  if (role) {
    out.asRole = role[1];
    rest = rest.slice(role[0].length).trim();
  }
  for (const raw of rest.split(/(?:^|\s+)(?:and\s+)?with\s+/i)) {
    const p = raw.trim();
    if (!p) continue;
    let m: RegExpExecArray | null;
    if ((m = /^form(?:\s+data)?\s+(.+)$/i.exec(p))) out.form = kv(m[1], q);
    else if ((m = /^(?:query|params|query\s+params|query\s+string)\s+(.+)$/i.exec(p))) out.query = kv(m[1], q);
    else if ((m = new RegExp(`^header\\s+(${Q})\\s*(?:=|:)\\s*(${Q})$`, 'i').exec(p))) out.headers = { ...(out.headers ?? {}), [V(m[1], q)]: V(m[2], q) };
    else if ((m = /^headers\s+(.+)$/i.exec(p))) out.headers = { ...(out.headers ?? {}), ...kv(m[1], q) };
    else if ((m = /^multipart(?:\s+form)?\s+(.+)$/i.exec(p))) out.multipart = kv(m[1], q);
    else if ((m = new RegExp(`^(?:body|json)\\s+from\\s+(?:the\\s+)?file\\s+(${Q}|\\S+)$`, 'i').exec(p)) || (m = new RegExp(`^(?:the\\s+)?file\\s+(${Q}|\\S+)$`, 'i').exec(p))) out.bodyFile = V(m[1], q);
    else if ((m = new RegExp(`^(?:body|json)\\s+(${Q}|\\S+)$`, 'i').exec(p))) {
      const v = V(m[1], q);
      try {
        out.body = JSON.parse(v);
      } catch {
        out.body = v;
      }
    } else if ((m = new RegExp(`^(?:a\\s+)?timeout\\s+(?:of\\s+)?${DUR}$`, 'i').exec(p))) out.timeoutMs = ms(m[1], m[2]);
    else if (/^errors?\s+allowed$|^allowed\s+errors?$/i.test(p)) out.allowErrors = true;
    else if ((m = /^role\s+([\w-]+)$/i.exec(p))) out.asRole = m[1];
    else if ((m = new RegExp(`^(?:the\\s+)?client\\s+cert(?:ificate)?\\s+(${Q}|[\\w.-]+)$`, 'i').exec(p))) out.clientCertificate = V(m[1], q);
    else throw new Error(`Unknown API option "with ${restoreQuotes(p, q)}" (use form, query, headers, header "k" = "v", multipart, body, body from file, timeout, client certificate "name")`);
  }
  return out;
}

const NAMED = /^(?:enter|return|tab|escape|esc|space|spacebar|backspace|bksp|delete|del|insert|ins|home|end|pageup|pgup|pagedown|pgdn|up|down|left|right|arrow(?:up|down|left|right)|capslock|numlock|scrolllock|printscreen|pause|contextmenu|control|ctrl|shift|alt|option|opt|meta|cmd|command|win|windows|super|mod|controlormeta|cmdorctrl|ctrlorcmd|plus|minus|equals?|comma|period|dot|slash|backslash|semicolon|quote|backquote|bracketleft|bracketright|f(?:[1-9]|1\d|2[0-4])|digit\d|key[a-z]|numpad(?:\d|add|subtract|multiply|divide|decimal|enter))$/i;
/** True for a named key or alias ("Mod", "Ctrl", "PgDn", "F12", "KeyA", ...). */
export function isKeyName(k: string): boolean {
  return NAMED.test(k);
}
const KEYCOMBO = String.raw`((?:[A-Za-z0-9]+\+)*[A-Za-z0-9]+|${Q})`;
const isCombo = (k: string) => k.split('+').every((p) => isKeyName(p) || /^[A-Za-z0-9]$/.test(p));

const MODS = String.raw`((?:(?:shift|ctrl|control|alt|option|cmd|command|meta|mod)[-+\s]?)+)`;
const modList = (s: string) => s.split(/[-+\s]+/).filter(Boolean).map((m) => m.toLowerCase());

const frameTarget = (s: string, q: string[]): string[] =>
  s.split(/\s*(?:>|\binside\s+(?:the\s+)?|\bwithin\s+(?:the\s+)?|\bthen\b)\s*/i).filter(Boolean)
    .map((p) => V(p.replace(/^(?:the\s+)?/i, '').replace(/\s+(?:i?frame)$/i, '').trim(), q)).filter(Boolean);

function cat(category: string, rules: IntentRule[]): IntentRule[] {
  return rules.map((r) => ({ ...r, category }));
}

export const ADVANCED_RULES: IntentRule[] = [
  // ================================================================== flow control (openers end with "then"/":" or carry one step)
  ...cat('Flow control', [
    { name: 'if', keywords: ['if', 'unless', 'when'], example: 'If the "Accept cookies" button is visible then click the "Accept cookies" button',
      re: /^(if|unless)\s+(.+?)(?:(?:\s*,?\s*then\b|\s*(?<!:):(?!:))\s*(.*))?$/i,
      build: (m, q) => block('if', { ...flowCondition(restoreQuotes(m[2], q)), ...(m[1].toLowerCase() === 'unless' ? { negate: true } : {}) }, m[3] || undefined, q) },
    { name: 'repeat', keywords: ['repeat', 'do'], example: 'Repeat 3 times: press Tab',
      re: /^(?:repeat|do\s+(?:the\s+following|this))\s+(\d+|\$\{[\w.]+\})\s+times?(?:\s+as\s+(\w+))?\s*(?::\s*(.*))?$/i,
      build: (m, q) => block('repeat', { times: /^\d+$/.test(m[1]) ? Number(m[1]) : m[1], ...(m[2] ? { as: m[2] } : {}) }, m[3] || undefined, q) },
    { name: 'for-each-data', keywords: ['for', 'each'], example: 'For each row in data "fixtures/users.csv": type "${row.name}" into the Name field',
      re: new RegExp(String.raw`^for\s+each\s+(\w+)\s+in\s+(?:the\s+)?(?:data(?:\s+file)?|file|rows?\s+of|sheet\s+(${Q})\s+of)\s+(${Q})(?:\s+sheet\s+(${Q}))?(?:\s+as\s+(\w+))?\s*(?::\s*(.*))?$`, 'i'),
      build: (m, q) => block('forEach', { data: V(m[3], q), as: m[5] ?? m[1], ...(m[2] || m[4] ? { sheet: V(m[2] ?? m[4], q) } : {}) }, m[6] || undefined, q) },
    { name: 'for-each', keywords: ['for', 'each'], example: 'For each item in ${items}: type "${item}" into the Search field',
      re: /^for\s+each\s+(\w+)\s+in\s+(.+?)(?:\s+as\s+(\w+))?\s*(?::\s*(.*))?$/i,
      build: (m, q) => {
        const items = restoreQuotes(m[2], q).trim();
        const err = checkExpression(items);
        if (err) throw new FatalRuleError(`For each: "${items}" is not a list expression (${err})`);
        return block('forEach', { items, as: m[3] ?? m[1] }, m[4] || undefined, q);
      } },
    { name: 'while', keywords: ['while', 'repeat'], example: 'While the "Load more" button is visible: click the "Load more" button',
      re: /^(?:while|repeat\s+while|as\s+long\s+as|(repeat\s+until|until))\s+(.+?)(?:\s+(?:at\s+most|max(?:imum)?|up\s+to)\s+(\d+)\s+times)?\s*(?::\s*(.*)|\s+do)?$/i,
      build: (m, q) => block('while', { ...flowCondition(restoreQuotes(m[2], q)), ...(m[1] ? { negate: true } : {}), ...(m[3] ? { maxIterations: Number(m[3]) } : {}) }, m[4] || undefined, q) },
    { name: 'retry-block', keywords: ['retry', 'try'], example: 'Retry up to 3 times: click the "Refresh" button',
      re: new RegExp(String.raw`^(?:retry|try)(?:\s+the\s+following)?\s+up\s+to\s+(\d+)\s+times(?:\s+(?:every|waiting|with)\s+${DUR}(?:\s+between)?)?\s*(?::\s*(.*))?$`, 'i'),
      build: (m, q) => block('retry', { attempts: Number(m[1]), ...(m[2] ? { delayMs: ms(m[2], m[3]) } : {}) }, m[4] || undefined, q) },
    { name: 'try', keywords: ['try'], example: 'Try: click the "Dismiss" button',
      re: /^try(?:\s+the\s+following|\s+to)?\s*(?::\s*(.*)|\s+(?!up\s+to)(.+))?$/i,
      build: (m, q) => block('try', undefined, m[1] || m[2] || undefined, q) },
    { name: 'group', keywords: ['group', 'section', 'step'], example: 'Group "Checkout": click the "Pay" button',
      re: new RegExp(String.raw`^(?:group|section|step\s+group)\s+(${Q})\s*(?::\s*(.*))?$`, 'i'),
      build: (m, q) => ({ action: 'group', value: V(m[1], q), steps: m[2] ? inner(m[2], q) : [] }) },
    { name: 'run-journey', keywords: ['run', 'call', 'include', 'perform', 'execute'], example: 'Run journey "login-and-open-orders" with role=manager',
      re: new RegExp(String.raw`^(?:run|call|include|perform|execute|reuse)\s+(?:the\s+)?(?:journey|flow|sub-?journey|scenario)\s+(${Q}|[\w./-]+)(?:\s+journey)?(?:\s+with\s+(.+?))?${STORE}?$`, 'i'),
      build: (m, q) => ({ action: 'runJourney', value: V(m[1], q), ...(m[2] ? { args: kv(m[2], q) } : {}), ...(m[3] ? { captureAs: m[3] } : {}) }) },
    { name: 'run-code', keywords: ['run', 'call', 'code'], example: 'Run code "steps/billing.ts#settleOverdue" with region="EU" as result',
      re: new RegExp(String.raw`^(?:run|call|execute)\s+(?:the\s+)?code(?:\s+step)?\s+(${Q}|[\w./#:-]+)(?:\s+with\s+(.+?))?(?:${STORE}|\s+as\s+${KEY})?$`, 'i'),
      build: (m, q) => ({ action: 'code', value: V(m[1], q), ...(m[2] ? { args: kv(m[2], q) } : {}), ...(m[3] || m[4] ? { captureAs: m[3] ?? m[4] } : {}) }) },
    { name: 'run-the-journey', keywords: ['run'], example: 'Run the "login" journey with role=manager and store the result as login',
      re: new RegExp(String.raw`^(?:run|call|include|perform)\s+the\s+(${Q})\s+(?:journey|flow)(?:\s+with\s+(.+?))?${STORE}?$`, 'i'),
      build: (m, q) => ({ action: 'runJourney', value: V(m[1], q), ...(m[2] ? { args: kv(m[2], q) } : {}), ...(m[3] ? { captureAs: m[3] } : {}) }) },
  ]),

  // ================================================================== variables
  ...cat('Variables', [
    { name: 'set-variable', keywords: ['set', 'let', 'calculate', 'compute'], example: 'Set variable total to ${price} * ${qty}',
      re: /^(?:set\s+(?:the\s+)?(?:variable|var)\s+|set\s+\$\{|let\s+|calculate\s+|compute\s+)(\w+)\}?\s+(?:to|=|be|as)\s+(.+)$/i,
      build: (m, q) => {
        const expr = restoreQuotes(m[2], q).trim();
        // "Let total be the text of ..." is a capture (core rule).
        if (/^(?:the\s+)?(?:text|value)\s+(?:of|from|in)\s/i.test(expr)) return undefined;
        const err = checkExpression(expr);
        if (err) throw new FatalRuleError(`"${expr}" is not a valid expression (${err})`);
        return { action: 'set', value: expr, captureAs: m[1] };
      } },
    { name: 'increment', keywords: ['increment', 'increase', 'decrement', 'decrease'], example: 'Increment count by 2',
      re: /^(increment|increase|decrement|decrease)\s+(\w+)(?:\s+by\s+(\d+(?:\.\d+)?))?$/i,
      build: (m) => ({ action: 'set', value: `${m[2]} ${/^(?:inc)/i.test(m[1]) ? '+' : '-'} ${m[3] ?? 1}`, captureAs: m[2] }) },
    { name: 'extract', keywords: ['extract', 'capture', 'get'], example: 'Extract the code from ${sms} as otp',
      re: new RegExp(String.raw`^(?:extract|capture|get|grab|read|find)\s+(?:the\s+)?(?:(\d+)-digit\s+)?(link|url|code|otp|verification\s+(?:link|code)|(${Q}))\s+(?:from|in|of)\s+(?:the\s+)?(?:email\s+|e-mail\s+|sms\s+|text\s+message\s+|message\s+)?(\$\{[\w.]+\}|\w[\w.]*)(?:\s+matching\s+(${Q}))?\s+as\s+${KEY}$`, 'i'),
      build: (m, q) => {
        const what = m[2].toLowerCase();
        const src = m[4].startsWith('${') ? m[4].slice(2, -1) : m[4];
        // A quoted "$..." is a JSONPath (see capture-json-path), not a regex.
        if (m[3]) return /^\$(?:[.[]|$)/.test(V(m[3], q)) ? undefined : { action: 'set', captureAs: m[6], args: { extract: { from: src, kind: 'regex', pattern: V(m[3], q) } } };
        const kind = /link|url/.test(what) ? 'link' : 'code';
        const pattern = m[5] ? V(m[5], q) : m[1] ? `\\b(\\d{${m[1]}})\\b` : undefined;
        return { action: 'set', captureAs: m[6], args: { extract: { from: src, kind, ...(pattern ? { pattern } : {}) } } };
      } },
    { name: 'capture-json-path', keywords: ['capture', 'get', 'extract'], example: 'Capture "$.items[0].id" from orders as firstId',
      re: new RegExp(String.raw`^(?:capture|get|extract|read|take)\s+(?:the\s+)?(?:json\s*path\s+)?(${Q})\s+(?:from|of|in)\s+(?:the\s+)?(?:response\s+)?([\w.]+)(?:\s+response)?\s+as\s+${KEY}$`, 'i'),
      build: (m, q) => {
        const p = V(m[1], q);
        if (!/^\$(?:[.[]|$)/.test(p)) return undefined;
        return { action: 'set', captureAs: m[3], args: { extract: { from: m[2], kind: 'jsonPath', path: p } } };
      } },
    { name: 'capture-response-header', keywords: ['capture', 'get'], example: 'Capture the header "x-request-id" of orders as requestId',
      re: new RegExp(String.raw`^(?:capture|get|read)\s+(?:the\s+)?(?:response\s+)?header\s+(${Q})\s+(?:of|from)\s+(?:the\s+)?(?:response\s+)?([\w.]+)\s+as\s+${KEY}$`, 'i'),
      build: (m, q) => ({ action: 'set', captureAs: m[3], args: { extract: { from: m[2], kind: 'header', name: V(m[1], q) } } }) },
    { name: 'capture-response-status', keywords: ['capture', 'get'], example: 'Capture the status of orders as code',
      re: new RegExp(String.raw`^(?:capture|get|read)\s+(?:the\s+)?(?:http\s+)?status(?:\s+code)?\s+(?:of|from)\s+(?:the\s+)?(?:response\s+)?([\w.]+)\s+as\s+${KEY}$`, 'i'),
      build: (m) => ({ action: 'set', captureAs: m[2], args: { extract: { from: m[1], kind: 'status' } } }) },
  ]),

  // ================================================================== soft assertions
  ...cat('Assertions', [
    { name: 'soft-assert', keywords: ['soft', 'softly'], example: 'Soft expect the page contains "Welcome"',
      re: /^(?:soft(?:ly)?\s+(?:expect|verify|assert|check|ensure)|(?:expect|verify|assert|check|ensure)\s+softly)\s+(?:that\s+)?(.+)$/i,
      build: (m, q) => ({ action: 'assert', soft: true, postconditions: [parseCondition(restoreQuotes(m[1], q))] }) },
  ]),

  // ================================================================== tabs, windows and popups
  ...cat('Tabs and windows', [
    { name: 'click-switch-new', keywords: ['click'], example: 'Click the "Open report" link and switch to the new tab',
      re: /^(?:click|tap|press|follow)\s+(?:on\s+)?(.+?)\s+and\s+(switch|go|move|change|jump|wait)\s+(?:over\s+)?(?:to|for)\s+(?:the\s+)?(?:new(?:ly)?(?:[-\s]opened)?|opened|resulting)?\s*(?:tab|window|popup|page)(?:\s+window)?$/i,
      build: (m, q) => ({ action: 'click', target: T(m[1], q), args: { newPage: m[2].toLowerCase() === 'wait' ? 'wait' : 'switch' } }) },
    { name: 'open-new-tab', keywords: ['open'], example: 'Open a new tab with /orders as orders',
      re: new RegExp(String.raw`^open\s+(?:a\s+|another\s+)?new\s+(?:tab|window|page)(?:\s+(?:with|at|to|for|on|showing|and\s+go\s+to)\s+(.+?))?(?:\s+(?:as|named|called)\s+(${Q}|[\w-]+))?$`, 'i'),
      build: (m, q) => ({ action: 'tab', ...(m[1] ? { value: V(m[1], q) } : {}), args: { op: 'open', ...(m[2] ? { name: V(m[2], q) } : {}) } }) },
    { name: 'open-in-new-tab', keywords: ['open'], example: 'Open /report in a new tab',
      re: new RegExp(String.raw`^open\s+(.+?)\s+in\s+(?:a\s+)?new\s+(?:tab|window)(?:\s+(?:as|named|called)\s+(${Q}|[\w-]+))?$`, 'i'),
      build: (m, q) => ({ action: 'tab', value: V(m[1], q), args: { op: 'open', ...(m[2] ? { name: V(m[2], q) } : {}) } }) },
    { name: 'switch-new-tab', keywords: ['switch', 'go', 'move'], example: 'Switch to the new tab',
      re: /^(?:switch|go|move|change|jump|focus)\s+(?:over\s+)?(?:to\s+|on\s+)?(?:the\s+)?(?:new(?:ly)?(?:[-\s]opened)?|latest|opened|last\s+opened|other)\s+(?:tab|window|popup|page)$|^(?:switch|go|move)\s+to\s+(?:the\s+)?popup(?:\s+window)?$/i,
      build: () => ({ action: 'tab', args: { op: 'switch', by: 'new' } }) },
    { name: 'switch-main-tab', keywords: ['switch', 'go', 'return'], example: 'Switch back to the main tab',
      re: /^(?:switch|go|move|return|change|jump)\s+(?:back\s+)?to\s+(?:the\s+)?(?:main|first|original|initial|parent|opener)\s+(?:tab|window|page)$/i,
      build: () => ({ action: 'tab', args: { op: 'switch', by: 'main' } }) },
    { name: 'switch-previous-tab', keywords: ['switch', 'go'], example: 'Switch back to the previous tab',
      // Plain "Go back" stays browser history navigation.
      re: /^switch\s+back$|^(?:switch|go|move|return|change|jump)\s+back\s+to\s+(?:the\s+)?(?:previous|last|prior)\s+(?:tab|window)$|^(?:switch|go|move|return)\s+to\s+(?:the\s+)?(?:previous|prior)\s+(?:tab|window)$/i,
      build: () => ({ action: 'tab', args: { op: 'switch', by: 'previous' } }) },
    { name: 'switch-tab-index', keywords: ['switch', 'go'], example: 'Switch to tab 2',
      re: new RegExp(String.raw`^(?:switch|go|move|change|jump)\s+(?:back\s+)?to\s+(?:(?:tab|window|page)\s+(?:number\s+)?#?(\d+)|the\s+(${ORDS}|\d+(?:st|nd|rd|th))\s+(?:tab|window|page))$`, 'i'),
      build: (m) => ({ action: 'tab', args: { op: 'switch', by: 'index', value: m[1] ?? String(ORD[m[2].toLowerCase()] ?? parseInt(m[2], 10)) } }) },
    { name: 'switch-tab-title', keywords: ['switch', 'go'], example: 'Switch to the tab titled "Report"',
      re: new RegExp(String.raw`^(?:switch|go|move|change|jump)\s+(?:back\s+)?to\s+(?:the\s+)?(?:tab|window|page|popup)\s+(?:titled|with\s+(?:the\s+)?title|whose\s+title\s+(?:is|contains))\s+(${Q})$`, 'i'),
      build: (m, q) => ({ action: 'tab', args: { op: 'switch', by: 'title', value: V(m[1], q) } }) },
    { name: 'switch-tab-url', keywords: ['switch', 'go'], example: 'Switch to the tab with URL "/report"',
      re: new RegExp(String.raw`^(?:switch|go|move|change|jump)\s+(?:back\s+)?to\s+(?:the\s+)?(?:tab|window|page|popup)\s+(?:with\s+(?:the\s+)?url(?:\s+(?:containing|matching|like))?|whose\s+url\s+(?:is|contains|matches)|at)\s+(${Q}|\S+)$`, 'i'),
      build: (m, q) => ({ action: 'tab', args: { op: 'switch', by: 'url', value: V(m[1], q) } }) },
    { name: 'switch-tab-named', keywords: ['switch', 'go'], example: 'Switch to the "Report" tab',
      re: new RegExp(String.raw`^(?:switch|go|move|change|jump)\s+(?:back\s+)?to\s+(?:the\s+)?(${Q})\s+(?:tab|window|page|popup)$`, 'i'),
      build: (m, q) => ({ action: 'tab', args: { op: 'switch', by: 'title', value: V(m[1], q) } }) },
    { name: 'close-tab', keywords: ['close'], example: 'Close the tab',
      re: new RegExp(String.raw`^close\s+(?:the\s+)?(?:(current|this|new|popup|active)\s+)?(?:tab|window|popup|page)(?:\s+(?:number\s+)?#?(\d+)|\s+(?:titled|with\s+title)\s+(${Q}))?$|^close\s+(?:the\s+)?(${Q})\s+(?:tab|window|popup)$|^close\s+(?:the\s+)?popup$`, 'i'),
      build: (m, q) => ({
        action: 'tab',
        args: m[2] ? { op: 'close', by: 'index', value: m[2] } : m[3] || m[4] ? { op: 'close', by: 'title', value: V(m[3] ?? m[4], q) } : { op: 'close' },
      }) },
  ]),

  // ================================================================== frames
  ...cat('Frames', [
    { name: 'in-frame', keywords: ['in', 'inside', 'within'], example: 'In the "payment" frame: type "4242" into the Card number field',
      re: new RegExp(String.raw`^(?:in|inside|within)\s+(?:the\s+)?(?:i?frame\s+((?:${Q}|\S+)(?:\s*>\s*(?:${Q}|\S+))*)|((?:${Q}|[#.\w[\]="-]+)(?:\s+i?frame)?(?:\s+(?:inside|within)\s+(?:the\s+)?(?:${Q}|[#.\w[\]="-]+)(?:\s+i?frame)?)*)\s+i?frame)\s*(?::\s*(.*))?$`, 'i'),
      build: (m, q) => {
        const raw = m[1] ?? m[2];
        let path = frameTarget(raw, q);
        // "the inner frame inside the outer frame" lists the innermost first.
        if (!m[1] && /\binside\b|\bwithin\b/i.test(raw)) path = path.reverse();
        return { action: 'frame', args: { op: 'enter', path }, steps: m[3] ? inner(m[3], q) : [] };
      } },
    { name: 'switch-frame', keywords: ['switch', 'enter', 'go'], example: 'Switch to frame "payment"',
      re: new RegExp(String.raw`^(?:switch|go|move|change)\s+(?:in)?to\s+(?:the\s+)?(?:i?frame\s+((?:${Q}|\S+)(?:\s*>\s*(?:${Q}|\S+))*)|(${Q})\s+i?frame)$|^enter\s+(?:the\s+)?(?:i?frame\s+(${Q}|\S+)|(${Q})\s+i?frame)$`, 'i'),
      build: (m, q) => ({ action: 'frame', args: { op: 'enter', path: frameTarget(m[1] ?? m[2] ?? m[3] ?? m[4], q) } }) },
    { name: 'switch-main-frame', keywords: ['switch', 'leave', 'exit'], example: 'Switch to the main frame',
      re: /^(?:switch|go|return|move)\s+(?:back\s+)?to\s+(?:the\s+)?(?:main|top|default|root)\s+(?:frame|document|content|page)$|^(?:leave|exit)\s+(?:the|all|every)\s+i?frames?$|^switch\s+back\s+to\s+the\s+page$/i,
      build: () => ({ action: 'frame', args: { op: 'main' } }) },
    { name: 'switch-parent-frame', keywords: ['switch'], example: 'Switch to the parent frame',
      re: /^(?:switch|go|return|move)\s+(?:back\s+)?(?:up\s+)?to\s+(?:the\s+)?(?:parent|outer)\s+i?frame$/i,
      build: () => ({ action: 'frame', args: { op: 'parent' } }) },
  ]),

  // ================================================================== dialogs
  ...cat('Dialogs', [
    { name: 'accept-dialog', keywords: ['accept', 'confirm', 'ok'], example: 'Accept the next dialog',
      re: new RegExp(String.raw`^(?:accept|confirm|ok|approve|click\s+ok\s+(?:on|in))\s+(?:the\s+)?(?:next\s+|upcoming\s+|following\s+)?(?:(alert|confirm(?:ation)?|prompt|beforeunload|leave\s+page)\s+)?(?:dialog|alert|popup|box|message|confirmation)?${STORE}?$`, 'i'),
      build: (m) => ({ action: 'dialog', args: { op: 'accept', ...(m[1] ? { kind: dialogKind(m[1]) } : {}) }, ...(m[2] ? { captureAs: m[2] } : {}) }) },
    { name: 'dismiss-dialog', keywords: ['dismiss', 'cancel', 'decline', 'reject'], example: 'Dismiss the next dialog',
      re: new RegExp(String.raw`^(?:dismiss|cancel|decline|reject|close)\s+(?:the\s+)?(?:next\s+|upcoming\s+|following\s+)(?:(alert|confirm(?:ation)?|prompt|beforeunload|leave\s+page)\s+)?(?:dialog|alert|popup|box|message|confirmation)?${STORE}?$|^(?:dismiss|cancel|decline|reject)\s+(?:the\s+)?(?:(alert|confirm(?:ation)?|prompt|beforeunload)\s+)?dialog${STORE}?$`, 'i'),
      build: (m) => ({ action: 'dialog', args: { op: 'dismiss', ...(m[1] || m[3] ? { kind: dialogKind(m[1] ?? m[3]) } : {}) }, ...(m[2] || m[4] ? { captureAs: m[2] ?? m[4] } : {}) }) },
    { name: 'answer-prompt', keywords: ['answer', 'type', 'enter', 'respond'], example: 'Answer the next prompt with "Bob"',
      re: new RegExp(String.raw`^(?:answer|respond\s+to|reply\s+to|fill)\s+(?:the\s+)?(?:next\s+)?prompt(?:\s+dialog)?\s+with\s+(${Q}|\S+)${STORE}?$|^(?:type|enter|input)\s+(${Q})\s+(?:in|into)\s+the\s+(?:next\s+)?prompt(?:\s+dialog)?${STORE}?$`, 'i'),
      build: (m, q) => ({ action: 'dialog', value: V(m[1] ?? m[3], q), args: { op: 'answer', kind: 'prompt' }, ...(m[2] || m[4] ? { captureAs: m[2] ?? m[4] } : {}) }) },
    { name: 'capture-dialog', keywords: ['capture', 'remember', 'store'], example: 'Capture the dialog text as message',
      re: new RegExp(String.raw`^(?:capture|remember|store|save|get|read)\s+(?:the\s+)?(?:last\s+)?(?:dialog|alert|confirm|prompt)(?:\s+(?:text|message))?\s+as\s+${KEY}$`, 'i'),
      build: (m) => ({ action: 'query', captureAs: m[1], args: { what: 'dialog' } }) },
  ]),

  // ================================================================== keyboard
  ...cat('Keyboard', [
    { name: 'press-on-page', keywords: ['press'], example: 'Press Control+K on the page',
      re: new RegExp(String.raw`^(?:press|hit)\s+(?:the\s+)?(?:keys?\s+|shortcut\s+)?${KEYCOMBO}(?:\s+keys?)?(?:\s+(\d+)\s+times)?\s+(?:on|in)\s+the\s+(?:page|document|window|browser)$`, 'i'),
      build: (m, q) => (isCombo(V(m[1], q)) ? { action: 'press', value: V(m[1], q), ...(m[2] ? { args: { times: Number(m[2]) } } : {}) } : undefined) },
    { name: 'press-times', keywords: ['press', 'hit'], example: 'Press Tab 3 times',
      re: new RegExp(String.raw`^(?:press|hit)\s+(?:the\s+)?(?:key\s+)?${KEYCOMBO}(?:\s+key)?\s+(\d+)\s+times(?:\s+(?:in|on|into)\s+(.+))?$`, 'i'),
      build: (m, q) => (isCombo(V(m[1], q)) ? { action: 'press', value: V(m[1], q), args: { times: Number(m[2]) }, ...(m[3] ? { target: T(m[3], q) } : {}) } : undefined) },
    { name: 'press-shortcut', keywords: ['use', 'press', 'trigger'], example: 'Use the keyboard shortcut Mod+K',
      re: new RegExp(String.raw`^(?:use|press|trigger|hit)\s+(?:the\s+)?(?:keyboard\s+)?shortcut\s+${KEYCOMBO}(?:\s+(?:in|on)\s+(.+))?$`, 'i'),
      build: (m, q) => (isCombo(V(m[1], q)) ? { action: 'press', value: V(m[1], q), ...(m[2] ? { target: T(m[2], q) } : {}) } : undefined) },
    { name: 'hold-key', keywords: ['hold', 'press', 'keep'], example: 'Hold down Shift',
      re: new RegExp(String.raw`^(?:hold(?:\s+down)?|press\s+and\s+hold|keep\s+(?:holding|pressing)|press\s+down)\s+(?:the\s+)?${KEYCOMBO}(?:\s+key)?$|^keep\s+${KEYCOMBO}\s+(?:pressed|held)(?:\s+down)?$`, 'i'),
      build: (m, q) => {
        const k = V(m[1] ?? m[2], q);
        return isCombo(k) && !/mouse|button/i.test(k) ? { action: 'keyboard', value: k, args: { op: 'down' } } : undefined;
      } },
    { name: 'release-key', keywords: ['release', 'let'], example: 'Release Shift',
      re: new RegExp(String.raw`^(?:release|let\s+go\s+of|lift)\s+(?:the\s+)?${KEYCOMBO}(?:\s+key)?$`, 'i'),
      build: (m, q) => (isCombo(V(m[1], q)) ? { action: 'keyboard', value: V(m[1], q), args: { op: 'up' } } : undefined) },
    { name: 'type-slowly', keywords: ['type', 'enter'], example: 'Type "laptop" slowly into the Search field',
      re: new RegExp(String.raw`^(?:type|enter|key\s+in)\s+(${Q})\s+(?:(slowly|character\s+by\s+character|key\s+by\s+key|letter\s+by\s+letter)|with\s+(?:a\s+)?${DUR}\s+delay(?:\s+between\s+keys)?)(?:\s+(?:into|in|on)\s+(.+?))?$|^(?:type|enter|key\s+in)\s+(${Q})\s+(?:into|in|on)\s+(.+?)\s+(slowly|character\s+by\s+character|key\s+by\s+key|letter\s+by\s+letter)$`, 'i'),
      build: (m, q) => {
        if (m[6]) return { action: 'keyboard', value: V(m[6], q), target: T(m[7], q), args: { op: 'type', delayMs: 100 } };
        const delay = m[3] ? ms(m[3], m[4]) : 100;
        return { action: 'keyboard', value: V(m[1], q), args: { op: 'type', delayMs: delay }, ...(m[5] ? { target: T(m[5], q) } : {}) };
      } },
    { name: 'type-keys', keywords: ['type'], example: 'Type "hello" on the keyboard',
      re: new RegExp(String.raw`^(?:type|key\s+in)\s+(${Q})(?:\s+(?:on|with|using)\s+the\s+keyboard)?$`, 'i'),
      build: (m, q) => ({ action: 'keyboard', value: V(m[1], q), args: { op: 'type', delayMs: 0 } }) },
    { name: 'insert-text', keywords: ['insert', 'paste'], example: 'Insert text "Hello" into the Notes field',
      re: new RegExp(String.raw`^(?:insert|paste)\s+(?:the\s+)?(?:text\s+)?(${Q})(?:\s+(?:into|in)\s+(.+))?$`, 'i'),
      build: (m, q) => ({ action: 'keyboard', value: V(m[1], q), args: { op: 'insert' }, ...(m[2] ? { target: T(m[2], q) } : {}) }) },
  ]),

  // ================================================================== mouse and gestures
  ...cat('Mouse and gestures', [
    { name: 'context-click', keywords: ['open', 'context'], example: 'Open the context menu on the "Report.pdf" item',
      re: /^(?:open\s+the\s+context\s+menu\s+(?:on|of|for)|context[-\s]?click(?:\s+on)?)\s+(.+)$/i,
      build: (m, q) => ({ action: 'click', target: T(m[1], q), args: { button: 'right' } }) },
    { name: 'middle-click', keywords: ['middle-click', 'middle'], example: 'Middle-click the "Docs" link',
      re: /^middle[-\s]?click\s+(?:on\s+)?(.+)$|^click\s+(?:on\s+)?(.+?)\s+with\s+the\s+middle(?:\s+mouse)?\s+button$/i,
      build: (m, q) => ({ action: 'click', target: T(m[1] ?? m[2], q), args: { button: 'middle' } }) },
    { name: 'triple-click', keywords: ['triple-click', 'triple'], example: 'Triple-click the Address field',
      re: /^triple[-\s]?click\s+(?:on\s+)?(.+)$/i,
      build: (m, q) => ({ action: 'click', target: T(m[1], q), args: { clickCount: 3 } }) },
    { name: 'modifier-click', keywords: ['shift-click', 'ctrl-click', 'click'], example: 'Shift-click the "Row 3" cell',
      re: new RegExp(String.raw`^${MODS}[-+\s]?click\s+(?:on\s+)?(.+)$|^click\s+(?:on\s+)?(.+?)\s+(?:while\s+holding(?:\s+down)?|with|holding)\s+${MODS}(?:\s+(?:held|pressed|key|keys))?$`, 'i'),
      build: (m, q) => ({ action: 'click', target: T(m[2] ?? m[3], q), args: { modifiers: modList(m[1] ?? m[4]) } }) },
    { name: 'click-at-offset', keywords: ['click'], example: 'Click the Canvas at 10, 20',
      re: /^click\s+(?:on\s+)?(.+?)\s+at\s+(?:offset\s+|position\s+|\(\s*)?(-?\d+)\s*,\s*(-?\d+)\s*\)?$/i,
      build: (m, q) => ({ action: 'click', target: T(m[1], q), args: { position: { x: Number(m[2]), y: Number(m[3]) } } }) },
    { name: 'click-at-coordinates', keywords: ['click'], example: 'Click at 100, 200',
      re: /^click\s+at\s+(?:the\s+)?(?:coordinates?\s+|position\s+|\(\s*)?(-?\d+)\s*,\s*(-?\d+)\s*\)?$/i,
      build: (m) => ({ action: 'mouse', args: { op: 'clickAt', x: Number(m[1]), y: Number(m[2]) } }) },
    { name: 'drag-by', keywords: ['drag'], example: 'Drag the Slider handle by 100, 0',
      re: /^drag\s+(.+?)\s+(?:by\s+(-?\d+)\s*,\s*(-?\d+)|(\d+)\s*(?:px|pixels)?\s+(left|right|up|down)|(left|right|up|down)\s+by\s+(\d+)\s*(?:px|pixels)?)$/i,
      build: (m, q) => {
        let x = 0;
        let y = 0;
        if (m[2] !== undefined) {
          x = Number(m[2]);
          y = Number(m[3]);
        } else {
          const n = Number(m[4] ?? m[7]);
          const d = (m[5] ?? m[6]).toLowerCase();
          if (d === 'left') x = -n;
          else if (d === 'right') x = n;
          else if (d === 'up') y = -n;
          else y = n;
        }
        return { action: 'drag', target: T(m[1], q), args: { offset: { x, y } } };
      } },
    { name: 'drag-to', keywords: ['drag', 'move'], example: 'Drag the "Task A" card to the "Done" column',
      re: /^(?:drag(?:\s+and\s+drop)?|move)\s+(.+?)\s+(?:to|onto|into|over|on\s+to|on)\s+(.+?)(?:\s+(?:using|with)\s+(?:(html5|native)(?:\s+(?:drag\s+and\s+drop|events|dnd))?|the\s+(mouse)))?$/i,
      build: (m, q) => {
        if (/^(?:the\s+)?(?:mouse|pointer|cursor|focus)$|^(?:the\s+)?files?\s+⟦/i.test(m[1].trim())) return undefined;
        return { action: 'drag', target: T(m[1], q), to: T(m[2], q), ...(m[3] ? { args: { mode: 'html5' } } : m[4] ? { args: { mode: 'mouse' } } : {}) };
      } },
    { name: 'mouse-move', keywords: ['move', 'mouse'], example: 'Move the mouse to 100, 200',
      re: /^move\s+the\s+(?:mouse|pointer|cursor)\s+(?:to|by)\s+(?:\(\s*)?(-?\d+)\s*,\s*(-?\d+)\s*\)?$/i,
      build: (m) => ({ action: 'mouse', args: { op: 'move', x: Number(m[1]), y: Number(m[2]) } }) },
    { name: 'mouse-down', keywords: ['press', 'mouse'], example: 'Press the mouse button on the Canvas',
      re: /^(?:press(?:\s+down)?|hold(?:\s+down)?)\s+the\s+(?:(left|right|middle)\s+)?mouse(?:\s+button)?(?:\s+(?:on|over|at)\s+(.+))?$|^mouse\s+down(?:\s+(?:on|over|at)\s+(.+))?$/i,
      build: (m, q) => ({ action: 'mouse', args: { op: 'down', ...(m[1] ? { button: m[1].toLowerCase() } : {}) }, ...(m[2] || m[3] ? { target: T(m[2] ?? m[3], q) } : {}) }) },
    { name: 'mouse-up', keywords: ['release', 'mouse'], example: 'Release the mouse button over the Trash icon',
      re: /^release\s+the\s+(?:(left|right|middle)\s+)?mouse(?:\s+button)?(?:\s+(?:on|over|at)\s+(.+))?$|^mouse\s+up(?:\s+(?:on|over|at)\s+(.+))?$/i,
      build: (m, q) => ({ action: 'mouse', args: { op: 'up', ...(m[1] ? { button: m[1].toLowerCase() } : {}) }, ...(m[2] || m[3] ? { target: T(m[2] ?? m[3], q) } : {}) }) },
    { name: 'mouse-wheel', keywords: ['scroll', 'turn', 'wheel'], example: 'Scroll the mouse wheel down by 300',
      re: /^(?:scroll|turn|roll)\s+the\s+(?:mouse\s+)?wheel\s+(up|down|left|right)(?:\s+by\s+(\d+))?$/i,
      build: (m) => {
        const n = Number(m[2] ?? 100);
        const d = m[1].toLowerCase();
        return { action: 'mouse', args: { op: 'wheel', dx: d === 'left' ? -n : d === 'right' ? n : 0, dy: d === 'up' ? -n : d === 'down' ? n : 0 } };
      } },
    { name: 'scroll-until', keywords: ['scroll', 'keep'], example: 'Scroll down until the "Item 150" text is visible',
      re: /^(?:keep\s+)?scroll(?:ing)?\s+(?:(down|up|left|right)\s+)?(?:(?:in|inside|within)\s+(.+?)\s+)?until\s+(.+?)\s+(?:is\s+visible|appears|is\s+shown|shows\s+up|comes\s+into\s+view|is\s+in\s+view)(?:\s+(?:at\s+most|max(?:imum)?|up\s+to)\s+(\d+)\s+times)?$/i,
      build: (m, q) => ({
        action: 'scroll', target: T(m[3], q),
        args: { op: 'untilVisible', direction: (m[1] ?? 'down').toLowerCase(), ...(m[4] ? { max: Number(m[4]) } : {}), ...(m[2] ? { container: T(m[2], q) } : {}) },
      }) },
    { name: 'scroll-page', keywords: ['scroll'], example: 'Scroll down by 500',
      re: /^scroll\s+(?:the\s+(?:page|window)\s+)?(?:(down|up|left|right)(?:\s+(?:by\s+)?(\d+)\s*(?:px|pixels)?)?|to\s+the\s+(top|bottom|end|start)(?:\s+of\s+the\s+(?:page|window))?)$/i,
      build: (m) => ({ action: 'scroll', args: { op: 'page', direction: m[1] ? m[1].toLowerCase() : m[3].toLowerCase() === 'end' ? 'bottom' : m[3].toLowerCase() === 'start' ? 'top' : m[3].toLowerCase(), ...(m[2] ? { amount: Number(m[2]) } : {}) } }) },
    { name: 'scroll-element', keywords: ['scroll'], example: 'Scroll the Results list down by 300',
      re: /^scroll\s+(?:inside\s+|within\s+|in\s+)?(?!down\b|up\b|to\b)(.+?)\s+(?:(down|up|left|right)(?:\s+(?:by\s+)?(\d+)\s*(?:px|pixels)?)?|to\s+the\s+(top|bottom))$/i,
      build: (m, q) => ({ action: 'scroll', target: T(m[1], q), args: { op: 'element', direction: (m[2] ?? m[4]).toLowerCase(), ...(m[3] ? { amount: Number(m[3]) } : {}) } }) },
    { name: 'scroll-into-view', keywords: ['scroll', 'bring'], example: 'Scroll to the Footer section',
      re: /^(?:scroll\s+(?:down\s+|up\s+)?to|scroll\s+(.+?)\s+into\s+view|bring)\s*(.*?)(?:\s+into\s+view)?$/i,
      build: (m, q) => {
        const t = (m[1] ?? m[2] ?? '').trim();
        if (!t || /^(?:the\s+)?(?:top|bottom|end|start)(?:\s+of\s+the\s+(?:page|window))?$/i.test(t)) return undefined;
        return { action: 'scroll', target: T(t, q), args: { op: 'intoView' } };
      } },
    { name: 'focus', keywords: ['focus', 'give'], example: 'Focus the Search field',
      re: /^(?:focus(?:\s+on)?|put\s+the\s+focus\s+on|give\s+focus\s+to|move\s+focus\s+to)\s+(.+)$/i,
      build: (m, q) => ({ action: 'focus', target: T(m[1], q), args: { op: 'focus' } }) },
    { name: 'blur', keywords: ['blur', 'unfocus', 'remove'], example: 'Blur the Email field',
      re: /^(?:blur|unfocus|remove\s+(?:the\s+)?focus\s+from|take\s+(?:the\s+)?focus\s+(?:away\s+)?from)\s+(.+)$/i,
      build: (m, q) => ({ action: 'focus', target: T(m[1], q), args: { op: 'blur' } }) },
    { name: 'touch-tap', keywords: ['touch'], example: 'Touch the "Menu" button',
      re: /^(?:touch|finger[-\s]tap|tap\s+with\s+a\s+finger\s+on)\s+(?:on\s+)?(.+)$/i,
      build: (m, q) => ({ action: 'touch', target: T(m[1], q), args: { op: 'tap' } }) },
    { name: 'swipe', keywords: ['swipe'], example: 'Swipe left on the Carousel',
      re: /^swipe\s+(?:(.+?)\s+)?(left|right|up|down)(?:\s+(?:on|across|over)\s+(.+?))?(?:\s+by\s+(\d+)\s*(?:px|pixels)?)?$/i,
      build: (m, q) => {
        const t = m[3] ?? m[1];
        return { action: 'touch', ...(t ? { target: T(t, q) } : {}), args: { op: 'swipe', direction: m[2].toLowerCase(), ...(m[4] ? { distance: Number(m[4]) } : {}) } };
      } },
  ]),

  // ================================================================== DOM events
  ...cat('Events', [
    { name: 'dispatch-event', keywords: ['trigger', 'fire', 'dispatch', 'raise', 'emit'], example: 'Trigger the "change" event on the Quantity field',
      re: new RegExp(String.raw`^(?:trigger|fire|dispatch|raise|emit|send)\s+(?:an?\s+|the\s+)?(${Q}|[\w:-]+)\s+event(?:\s+(?:on|at|to)\s+((?:the\s+)?(?:window|document)|.+?))?(?:\s+with\s+(?:(detail)\s+(${Q}|\S+)|(?:init\s+)?(${Q})))?$`, 'i'),
      build: (m, q) => {
        const type = V(m[1], q);
        const where = m[2]?.trim();
        const global = !where || /^(?:the\s+)?(?:window|document)$/i.test(where);
        let init: Record<string, unknown> | undefined;
        if (m[3]) {
          const raw = V(m[4], q);
          let detail: unknown = raw;
          try {
            detail = JSON.parse(raw);
          } catch {
            /* keep text */
          }
          init = { detail };
        } else if (m[5]) {
          const parsed: unknown = JSON.parse(V(m[5], q));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('event init must be a JSON object');
          init = parsed as Record<string, unknown>;
        }
        return {
          action: 'dispatch', value: type,
          ...(global ? {} : { target: T(where!, q) }),
          ...(init || (global && where) ? { args: { ...(init ? { init } : {}), ...(global && where ? { on: where.replace(/^the\s+/i, '').toLowerCase() } : {}) } } : {}),
        };
      } },
    { name: 'listen-event', keywords: ['listen', 'start', 'watch'], example: 'Listen for the "cart-updated" event on the window',
      re: new RegExp(String.raw`^(?:(?:start\s+)?listen(?:ing)?|watch)\s+for\s+(?:the\s+|an?\s+)?(${Q}|[\w:-]+)\s+events?(?:\s+on\s+((?:the\s+)?(?:window|document)|.+))?$`, 'i'),
      build: (m, q) => {
        const where = m[2]?.trim();
        const global = !where || /^(?:the\s+)?(?:window|document)$/i.test(where);
        return { action: 'wait', ...(global ? {} : { target: T(where!, q) }), args: { for: 'listen', event: V(m[1], q), ...(global && where ? { on: where.replace(/^the\s+/i, '').toLowerCase() } : {}) } };
      } },
    { name: 'wait-event', keywords: ['wait'], example: 'Wait for the "cart-updated" event and capture it as cart',
      re: new RegExp(String.raw`^wait\s+(?:for|until)\s+(?:the\s+|an?\s+)?(${Q}|[\w:-]+)\s+event(?:\s+(?:on|from)\s+((?:the\s+)?(?:window|document)|.+?))?(?:\s+(?:fires|is\s+fired|happens))?${STORE}?$`, 'i'),
      build: (m, q) => {
        const where = m[2]?.trim();
        const global = !where || /^(?:the\s+)?(?:window|document)$/i.test(where);
        return { action: 'wait', ...(global ? {} : { target: T(where!, q) }), args: { for: 'event', event: V(m[1], q), ...(global && where ? { on: where.replace(/^the\s+/i, '').toLowerCase() } : {}) }, ...(m[3] ? { captureAs: m[3] } : {}) };
      } },
    { name: 'wait-response', keywords: ['wait'], example: 'Wait for the response to /api/orders and capture it as order',
      re: new RegExp(String.raw`^wait\s+(?:for|until)\s+(?:the\s+|an?\s+)?(?:(GET|POST|PUT|PATCH|DELETE)\s+)?(request|response|call)\s+(?:to|from|for|of)\s+(${Q}|\S+)(?:\s+(?:with|returning)\s+status\s+(\d{3}))?(?:\s+(?:is\s+)?(?:made|sent|received|finished|completes?|arrives?))?${STORE}?$`, 'i'),
      build: (m, q) => ({
        action: 'wait', args: { for: m[2].toLowerCase() === 'request' ? 'request' : 'response', url: V(m[3], q), ...(m[1] ? { method: m[1].toUpperCase() } : {}), ...(m[4] ? { status: Number(m[4]) } : {}) },
        ...(m[5] ? { captureAs: m[5] } : {}),
      }) },
    { name: 'capture-console', keywords: ['capture', 'collect'], example: 'Capture the console errors as errors',
      re: new RegExp(String.raw`^(?:capture|collect|record|get)\s+(?:the\s+|all\s+)?(?:browser\s+)?console\s+(messages|logs|errors|warnings)\s+as\s+${KEY}$`, 'i'),
      build: (m) => ({ action: 'query', captureAs: m[2], args: { what: 'console', level: ({ errors: 'error', warnings: 'warning' } as Record<string, string>)[m[1].toLowerCase()] ?? 'any' } }) },
    { name: 'capture-requests', keywords: ['capture', 'collect'], example: 'Capture the requests to /api as calls',
      re: new RegExp(String.raw`^(?:capture|collect|record|get)\s+(?:the\s+|all\s+)?(?:network\s+)?requests(?:\s+(?:to|for|matching)\s+(${Q}|\S+))?\s+as\s+${KEY}$`, 'i'),
      build: (m, q) => ({ action: 'query', captureAs: m[2], args: { what: 'requests', ...(m[1] ? { name: V(m[1], q) } : {}) } }) },
  ]),

  // ================================================================== DOM queries
  ...cat('DOM queries', [
    { name: 'capture-attribute', keywords: ['capture', 'get', 'read'], example: 'Capture the "href" attribute of the "Docs" link as docsUrl',
      re: new RegExp(String.raw`^(?:capture|get|read|remember|store|save|grab)\s+(?:the\s+)?(?:(${Q})\s+(attribute|property|css|style|computed\s+style)|(attribute|property|css(?:\s+property)?|style|computed\s+style)\s+(${Q}))\s+(?:of|from|on)\s+(.+?)\s+as\s+${KEY}$`, 'i'),
      build: (m, q) => {
        const kind = (m[2] ?? m[3]).toLowerCase();
        const what = kind.startsWith('attr') ? 'attribute' : kind.startsWith('prop') ? 'property' : 'css';
        return { action: 'query', target: T(m[5], q), captureAs: m[6], args: { what, name: V(m[1] ?? m[4], q) } };
      } },
    { name: 'capture-box', keywords: ['capture', 'get'], example: 'Capture the bounding box of the Logo image as logoBox',
      re: new RegExp(String.raw`^(?:capture|get|read|measure)\s+(?:the\s+)?(?:bounding\s+box|position|size|dimensions|box|rect(?:angle)?)\s+(?:of|from)\s+(.+?)\s+as\s+${KEY}$`, 'i'),
      build: (m, q) => ({ action: 'query', target: T(m[1], q), captureAs: m[2], args: { what: 'box' } }) },
    { name: 'capture-html', keywords: ['capture', 'get'], example: 'Capture the HTML of the Summary panel as summaryHtml',
      re: new RegExp(String.raw`^(?:capture|get|read)\s+(?:the\s+)?(outer\s+|inner\s+)?html\s+(?:of|from)\s+(.+?)\s+as\s+${KEY}$`, 'i'),
      build: (m, q) => ({ action: 'query', target: T(m[2], q), captureAs: m[3], args: { what: 'html', ...(m[1] && /outer/i.test(m[1]) ? { outer: true } : {}) } }) },
    { name: 'capture-count', keywords: ['count', 'capture'], example: 'Count the "Order" rows as orderCount',
      re: new RegExp(String.raw`^(?:count\s+(?:the\s+)?(.+?)\s+(?:and\s+store\s+)?as|(?:capture|get|store|remember)\s+the\s+(?:number|count)\s+of\s+(.+?)\s+as)\s+${KEY}$`, 'i'),
      build: (m, q) => (/^rows\s+(?:of|from|returned)\b/i.test((m[1] ?? m[2]).trim()) ? undefined
        : { action: 'query', target: T(m[1] ?? m[2], q), captureAs: m[3], args: { what: 'count' } }) },
    { name: 'capture-texts', keywords: ['capture', 'collect', 'get'], example: 'Capture the texts of the "Name" cells as names',
      re: new RegExp(String.raw`^(?:capture|collect|get|read|store)\s+(?:all\s+)?(?:the\s+)?(?:texts|list|labels|values\s+of\s+the\s+texts|text\s+of\s+(?:all|every|each))\s+(?:of\s+)?(?:the\s+)?(.+?)\s+as\s+${KEY}$`, 'i'),
      build: (m, q) => ({ action: 'query', target: T(m[1], q), captureAs: m[2], args: { what: 'texts' } }) },
    { name: 'capture-table', keywords: ['capture', 'read'], example: 'Capture the rows of the Orders table as orders',
      re: new RegExp(String.raw`^(?:capture|read|get|store)\s+(?:the\s+)?(?:rows\s+of\s+|data\s+(?:of|in)\s+)?(?:the\s+)?(.+?\s+(?:table|grid))(?:\s+rows)?\s+as\s+${KEY}$`, 'i'),
      build: (m, q) => (/^(?:the\s+)?(?:text|value)\s+(?:of|from|in)\s/i.test(m[1]) ? undefined
        : { action: 'query', target: T(m[1], q), captureAs: m[2], args: { what: 'table' } }) },
    { name: 'capture-page-info', keywords: ['capture', 'get'], example: 'Capture the current URL as pageUrl',
      re: new RegExp(String.raw`^(?:capture|get|read|remember|store)\s+(?:the\s+)?(?:current\s+|page\s+)?(url|address|title|page\s+title)\s+as\s+${KEY}$`, 'i'),
      build: (m) => ({ action: 'query', captureAs: m[2], args: { what: /title/i.test(m[1]) ? 'title' : 'url' } }) },
    { name: 'capture-state', keywords: ['capture'], example: 'Capture whether the Newsletter checkbox is checked as subscribed',
      re: new RegExp(String.raw`^(?:capture|check|get|record)\s+whether\s+(.+?)\s+is\s+(enabled|disabled|checked|visible|hidden|editable|focused)\s+as\s+${KEY}$`, 'i'),
      build: (m, q) => ({ action: 'query', target: T(m[1], q), captureAs: m[3], args: { what: 'state', name: m[2].toLowerCase() } }) },
    { name: 'capture-matching', keywords: ['capture'], example: 'Capture the text of the Toast matching "ORD-\\d+" as orderNumber',
      re: new RegExp(String.raw`^(?:capture|get|read|extract)\s+(?:the\s+)?(text|value)\s+(?:of|from|in)\s+(.+?)\s+matching\s+(${Q})\s+as\s+${KEY}$`, 'i'),
      build: (m, q) => ({ action: 'query', target: T(m[2], q), captureAs: m[4], args: { what: m[1].toLowerCase(), pattern: V(m[3], q) } }) },
  ]),

  // ================================================================== page scripts (opt-in)
  ...cat('Page scripts', [
    { name: 'run-javascript', keywords: ['run', 'execute', 'evaluate'], example: 'Run JavaScript: return document.title',
      raw: true,
      re: /^(?:run|execute|evaluate)\s+(?:javascript|js|script)(?:\s+on\s+(.+?))?(?:\s+(?:and\s+)?(?:store|save|capture|keep)\s+(?:it\s+|the\s+result\s+)?as\s+([A-Za-z_][\w.-]*))?\s*:\s*([\s\S]+)$/i,
      build: (m) => ({ action: 'script', value: m[3].trim(), ...(m[1] ? { target: describeTarget(m[1].trim()) } : {}), ...(m[2] ? { captureAs: m[2] } : {}) }) },
    { name: 'run-script-file', keywords: ['run', 'execute'], example: 'Run script "scripts/seed-cart.js" with items=3 and store the result as cart',
      re: new RegExp(String.raw`^(?:run|execute)\s+(?:the\s+)?(?:page\s+)?script\s+(?:file\s+)?(${Q})(?:\s+on\s+(.+?))?(?:\s+with\s+(.+?))?${STORE}?$`, 'i'),
      build: (m, q) => ({ action: 'script', args: { file: V(m[1], q), ...(m[3] ? { params: kv(m[3], q) } : {}) }, ...(m[2] ? { target: T(m[2], q) } : {}), ...(m[4] ? { captureAs: m[4] } : {}) }) },
  ]),

  // ================================================================== network
  ...cat('Network', [
    { name: 'mock-route', keywords: ['mock', 'stub', 'fake'], example: 'Mock GET /api/orders with status 200 and body "[]"',
      re: new RegExp(String.raw`^(?:mock|stub|fake)\s+(?:the\s+)?(?:(GET|POST|PUT|PATCH|DELETE)\s+)?(?:requests?\s+to\s+|responses?\s+(?:to|from|of|for)\s+|calls?\s+to\s+|route\s+|api\s+)?(${Q}|\S+)\s+(?:to\s+return|returning|with|as|so\s+it\s+returns)\s+(.+)$`, 'i'),
      build: (m, q) => ({ action: 'network', args: { op: 'mock', url: V(m[2], q), ...(m[1] ? { method: m[1].toUpperCase() } : {}), ...mockOptions(m[3], q) } }) },
    { name: 'delay-route', keywords: ['delay', 'slow'], example: 'Delay /api/orders by 2 seconds',
      re: new RegExp(String.raw`^(?:delay|slow\s+down)\s+(?:the\s+)?(?:(GET|POST|PUT|PATCH|DELETE)\s+)?(?:requests?\s+to\s+|responses?\s+(?:to|from)\s+|calls?\s+to\s+)?(${Q}|\S+)\s+by\s+${DUR}$`, 'i'),
      build: (m, q) => ({ action: 'network', args: { op: 'delay', url: V(m[2], q), ms: ms(m[3], m[4]), ...(m[1] ? { method: m[1].toUpperCase() } : {}) } }) },
    { name: 'block-preset', keywords: ['block'], example: 'Block images',
      re: /^(?:block|disable|abort)\s+(?:all\s+)?(images?|fonts?|media|videos?|stylesheets|css|styles|scripts|analytics|trackers)(?:\s+requests)?$/i,
      build: (m) => ({ action: 'network', args: { op: 'block', preset: m[1].toLowerCase() } }) },
    { name: 'block-route', keywords: ['block', 'abort', 'fail'], example: 'Block requests to /analytics',
      re: new RegExp(String.raw`^(?:block|abort|fail|drop|cancel)\s+(?:all\s+)?(?:the\s+)?(?:(GET|POST|PUT|PATCH|DELETE)\s+)?(?:requests?|calls?)\s+(?:to|for|matching)\s+(${Q}|\S+)$|^block\s+(${Q}|/\S*|https?://\S+)$|^make\s+(${Q}|\S+)\s+fail$`, 'i'),
      build: (m, q) => ({ action: 'network', args: { op: 'block', url: V(m[2] ?? m[3] ?? m[4], q), ...(m[1] ? { method: m[1].toUpperCase() } : {}) } }) },
    { name: 'request-header', keywords: ['set', 'add'], example: 'Set request header "x-test" to "1" for /api/*',
      re: new RegExp(String.raw`^(?:set|add|send)\s+(?:the\s+)?request\s+header\s+(${Q})\s+(?:to|=|as)\s+(${Q})(?:\s+(?:for|on)\s+(?:requests\s+to\s+)?(${Q}|\S+))?$|^add\s+header\s+(${Q})\s*=\s*(${Q})\s+to\s+requests(?:\s+(?:to|for)\s+(${Q}|\S+))?$`, 'i'),
      build: (m, q) => ({ action: 'network', args: { op: 'headers', headers: { [V(m[1] ?? m[4], q)]: V(m[2] ?? m[5], q) }, ...(m[3] || m[6] ? { url: V(m[3] ?? m[6], q) } : {}) } }) },
    { name: 'unroute', keywords: ['stop', 'remove', 'clear', 'unblock'], example: 'Stop mocking /api/orders',
      re: new RegExp(String.raw`^(?:stop\s+(?:mocking|stubbing|blocking|delaying)|unblock|unmock|restore)\s+(?:requests\s+to\s+)?(${Q}|\S+)$|^(?:remove|clear|reset)\s+(?:all\s+)?(?:the\s+)?(?:network\s+)?(?:mocks|stubs|routes|blocks)$`, 'i'),
      build: (m, q) => ({ action: 'network', args: { op: 'unroute', ...(m[1] ? { url: V(m[1], q) } : {}) } }) },
    { name: 'offline', keywords: ['go', 'simulate'], example: 'Go offline',
      re: /^(?:go|switch|set\s+the\s+(?:browser|network)|simulate\s+being|simulate\s+an?)\s+(offline|online)(?:\s+(?:mode|network))?$|^(?:go\s+back\s+online|restore\s+the\s+network(?:\s+connection)?)$/i,
      build: (m) => ({ action: 'network', args: { op: (m[1] ?? 'online').toLowerCase() === 'offline' ? 'offline' : 'online' } }) },
    { name: 'throttle', keywords: ['throttle', 'emulate', 'use'], example: 'Throttle the network to slow 3G',
      re: /^(?:throttle\s+the\s+(?:network|connection)\s+to\s+|emulate\s+(?:an?\s+)?|use\s+an?\s+|simulate\s+(?:an?\s+)?)(slow\s*3g|fast\s*3g|4g|dsl)(?:\s+(?:network|connection))?$|^(?:stop\s+throttling|remove\s+(?:the\s+)?network\s+throttling|disable\s+throttling)$/i,
      build: (m) => ({ action: 'network', args: { op: 'throttle', profile: m[1] ? m[1].toLowerCase().replace(/\s+/g, '') : 'none' } }) },
    { name: 'save-har', keywords: ['save', 'record', 'export'], example: 'Save the network traffic as HAR "orders-flow"',
      re: new RegExp(String.raw`^(?:save|record|export|write)\s+(?:the\s+)?(?:network\s+(?:traffic|log)\s+)?(?:as\s+)?(?:a\s+)?har(?:\s+(?:file\s+)?(?:as\s+)?(${Q}|[\w.-]+))?(?:\s+for\s+(${Q}|\S+))?$|^(?:save|export)\s+the\s+network\s+(?:traffic|log)\s+as\s+har\s+(${Q}|[\w.-]+)$`, 'i'),
      build: (m, q) => ({ action: 'network', args: { op: 'har', ...(m[1] || m[3] ? { name: V(m[1] ?? m[3], q) } : {}), ...(m[2] ? { url: V(m[2], q) } : {}) } }) },
    { name: 'replay-har', keywords: ['replay', 'serve'], example: 'Replay HAR "fixtures/orders.har"',
      re: new RegExp(String.raw`^(?:replay|serve\s+requests\s+from|answer\s+requests\s+from)\s+(?:the\s+)?har\s+(?:file\s+)?(${Q}|\S+)(?:\s+for\s+(${Q}|\S+))?$`, 'i'),
      build: (m, q) => ({ action: 'network', args: { op: 'replayHar', file: V(m[1], q), ...(m[2] ? { url: V(m[2], q) } : {}) } }) },
  ]),

  // ================================================================== browser state
  ...cat('Browser state', [
    { name: 'set-cookie', keywords: ['set', 'add'], example: 'Set cookie "theme" to "dark"',
      re: new RegExp(String.raw`^(?:set|add|create)\s+(?:a\s+|the\s+)?cookie\s+(${Q}|[\w-]+)\s+(?:to|=|with\s+value)\s+(${Q}|\S+)(?:\s+(?:for|on)\s+(?:domain\s+)?(${Q}|\S+))?$`, 'i'),
      build: (m, q) => {
        const where = m[3] ? V(m[3], q) : undefined;
        return { action: 'browser', args: { op: 'setCookie', name: V(m[1], q), value: V(m[2], q), ...(where ? (/^https?:/i.test(where) ? { url: where } : { domain: where }) : {}) } };
      } },
    { name: 'delete-cookie', keywords: ['delete', 'remove', 'clear'], example: 'Delete cookie "theme"',
      re: new RegExp(String.raw`^(?:delete|remove|clear|drop)\s+(?:the\s+)?(?:cookie\s+(${Q}|[\w-]+)|(${Q})\s+cookie)$|^(?:delete|remove|clear)\s+(?:all\s+)?(?:the\s+)?cookies$`, 'i'),
      build: (m, q) => (m[1] || m[2] ? { action: 'browser', args: { op: 'deleteCookie', name: V(m[1] ?? m[2], q) } } : { action: 'browser', args: { op: 'clearCookies' } }) },
    { name: 'capture-cookie', keywords: ['capture', 'get'], example: 'Capture cookie "session" as sessionId',
      re: new RegExp(String.raw`^(?:capture|get|read|remember|store)\s+(?:the\s+)?(?:cookie\s+(${Q}|[\w-]+)|(${Q})\s+cookie|(all\s+)?cookies)\s+as\s+${KEY}$`, 'i'),
      build: (m, q) => (m[1] || m[2]
        ? { action: 'browser', captureAs: m[4], args: { op: 'getCookie', name: V(m[1] ?? m[2], q) } }
        : { action: 'browser', captureAs: m[4], args: { op: 'cookies' } }) },
    { name: 'set-storage', keywords: ['set', 'put', 'store'], example: 'Set local storage "cart" to "[1,2]"',
      re: new RegExp(String.raw`^(?:set|put|store|save)\s+(?:the\s+)?(local|session)\s+storage\s+(?:item\s+|key\s+)?(${Q}|[\w.-]+)\s+(?:to|=|as)\s+(${Q}|\S+)$|^(?:set|put|store)\s+(${Q})\s+(?:to\s+(${Q})\s+)?in\s+(local|session)\s+storage(?:\s+to\s+(${Q}))?$`, 'i'),
      build: (m, q) => (m[1]
        ? { action: 'browser', args: { op: 'setStorage', area: m[1].toLowerCase(), key: V(m[2], q), value: V(m[3], q) } }
        : { action: 'browser', args: { op: 'setStorage', area: m[6].toLowerCase(), key: V(m[4], q), value: V(m[5] ?? m[7] ?? '', q) } }) },
    { name: 'remove-storage', keywords: ['remove', 'delete', 'clear'], example: 'Clear local storage',
      re: new RegExp(String.raw`^(?:remove|delete)\s+(${Q}|[\w.-]+)\s+from\s+(local|session)\s+storage$|^(?:clear|empty|reset)\s+(?:the\s+)?(local|session)\s+storage$`, 'i'),
      build: (m, q) => (m[1]
        ? { action: 'browser', args: { op: 'removeStorage', area: m[2].toLowerCase(), key: V(m[1], q) } }
        : { action: 'browser', args: { op: 'clearStorage', area: m[3].toLowerCase() } }) },
    { name: 'capture-storage', keywords: ['capture', 'get'], example: 'Capture local storage "cart" as cart',
      re: new RegExp(String.raw`^(?:capture|get|read|remember)\s+(?:the\s+)?(local|session)\s+storage(?:\s+(?:item\s+|key\s+)?(${Q}|[\w.-]+))?\s+as\s+${KEY}$`, 'i'),
      build: (m, q) => ({ action: 'browser', captureAs: m[3], args: { op: 'getStorage', area: m[1].toLowerCase(), ...(m[2] ? { key: V(m[2], q) } : {}) } }) },
    { name: 'clear-state', keywords: ['clear', 'reset'], example: 'Clear the browser state',
      re: /^(?:clear|reset|wipe)\s+(?:all\s+)?(?:the\s+)?(?:browser\s+(?:state|data|storage)|site\s+data|cookies\s+and\s+storage)$/i,
      build: () => ({ action: 'browser', args: { op: 'clearState' } }) },
    { name: 'grant-permission', keywords: ['grant', 'allow'], example: 'Grant permission "geolocation"',
      re: new RegExp(String.raw`^(?:grant|allow)\s+(?:the\s+)?(?:permissions?\s+)?((?:${Q}|[\w-]+)(?:\s*(?:,|and)\s*(?:${Q}|[\w-]+))*)(?:\s+permissions?)?(?:\s+(?:for|on)\s+(${Q}|\S+))?$`, 'i'),
      build: (m, q) => {
        const perms = m[1].split(/\s*(?:,|\band\b)\s*/i).map((p) => V(p, q)).filter(Boolean);
        const known = /^(?:geolocation|notifications|camera|microphone|clipboard-read|clipboard-write|midi|background-sync|ambient-light-sensor|accelerometer|gyroscope|magnetometer|accessibility-events|payment-handler|storage-access|local-fonts)$/;
        if (!perms.every((p) => known.test(p))) return undefined;
        return { action: 'browser', args: { op: 'grant', permissions: perms, ...(m[2] ? { origin: V(m[2], q) } : {}) } };
      } },
    { name: 'clear-permissions', keywords: ['revoke', 'clear'], example: 'Revoke all permissions',
      re: /^(?:revoke|clear|reset|remove)\s+(?:all\s+)?(?:the\s+)?permissions$/i,
      build: () => ({ action: 'browser', args: { op: 'clearPermissions' } }) },
    { name: 'geolocation', keywords: ['set', 'pretend'], example: 'Set the geolocation to 52.52, 13.405',
      re: /^(?:set\s+(?:the\s+)?(?:geo)?location\s+to|pretend\s+to\s+be\s+at|emulate\s+(?:the\s+)?(?:geo)?location)\s+(?:latitude\s+)?(-?\d+(?:\.\d+)?)\s*(?:,|and)\s*(?:longitude\s+)?(-?\d+(?:\.\d+)?)$/i,
      build: (m) => ({ action: 'browser', args: { op: 'geolocation', latitude: Number(m[1]), longitude: Number(m[2]) } }) },
    { name: 'timezone', keywords: ['set', 'use'], example: 'Set the timezone to "Asia/Tokyo"',
      re: new RegExp(String.raw`^(?:set\s+(?:the\s+)?time\s*zone\s+to|use\s+(?:the\s+)?time\s*zone|emulate\s+(?:the\s+)?time\s*zone)\s+(${Q}|[\w/+-]+)$`, 'i'),
      build: (m, q) => ({ action: 'browser', args: { op: 'timezone', value: V(m[1], q) } }) },
    { name: 'locale', keywords: ['set', 'use'], example: 'Set the locale to de-DE',
      re: new RegExp(String.raw`^(?:set\s+(?:the\s+)?(?:locale|language)\s+to|use\s+(?:the\s+)?locale|emulate\s+(?:the\s+)?locale)\s+(${Q}|[\w-]+)$`, 'i'),
      build: (m, q) => ({ action: 'browser', args: { op: 'locale', value: V(m[1], q) } }) },
    { name: 'color-scheme', keywords: ['use', 'emulate', 'set'], example: 'Use dark mode',
      re: /^(?:use|emulate|enable|prefer)\s+(dark|light)\s+(?:mode|theme|color\s+scheme)$|^set\s+(?:the\s+)?(?:preferred\s+)?colou?r\s+scheme\s+to\s+(dark|light|no-preference)$/i,
      build: (m) => ({ action: 'browser', args: { op: 'colorScheme', value: (m[1] ?? m[2]).toLowerCase() } }) },
    { name: 'reduced-motion', keywords: ['prefer', 'emulate'], example: 'Prefer reduced motion',
      re: /^(?:prefer|emulate|enable|use)\s+reduced\s+motion$|^(?:allow|restore)\s+(?:full\s+)?motion$/i,
      build: (m) => ({ action: 'browser', args: { op: 'reducedMotion', value: /reduced/i.test(m[0]) ? 'reduce' : 'no-preference' } }) },
    { name: 'emulate-media', keywords: ['emulate'], example: 'Emulate print media',
      re: /^emulate\s+(print|screen)\s+media(?:\s+type)?$/i,
      build: (m) => ({ action: 'browser', args: { op: 'media', value: m[1].toLowerCase() } }) },
    { name: 'emulate-device', keywords: ['emulate', 'use'], example: 'Emulate device "iPhone 13"',
      re: new RegExp(String.raw`^(?:emulate|use|switch\s+to)\s+(?:the\s+)?device\s+(${Q})$|^emulate\s+an?\s+(${Q}|iphone[\w\s]*|ipad[\w\s]*|pixel[\w\s]*|galaxy[\w\s]*)$`, 'i'),
      build: (m, q) => ({ action: 'browser', args: { op: 'device', value: V(m[1] ?? m[2], q).trim() } }) },
    { name: 'viewport', keywords: ['resize', 'set'], example: 'Resize the viewport to 375x812',
      re: /^(?:resize|set)\s+(?:the\s+)?(?:viewport|window|browser|screen)(?:\s+size)?\s+to\s+(\d+)\s*[x×*,]\s*(\d+)$/i,
      build: (m) => ({ action: 'browser', args: { op: 'viewport', width: Number(m[1]), height: Number(m[2]) } }) },
    { name: 'clipboard-write', keywords: ['copy', 'write', 'set'], example: 'Copy "SAVE10" to the clipboard',
      re: new RegExp(String.raw`^(?:copy|write|put)\s+(${Q})\s+(?:to|into|on)\s+the\s+clipboard$|^set\s+the\s+clipboard\s+to\s+(${Q})$`, 'i'),
      build: (m, q) => ({ action: 'browser', args: { op: 'clipboardWrite', value: V(m[1] ?? m[2], q) } }) },
    { name: 'clipboard-read', keywords: ['capture', 'read'], example: 'Capture the clipboard as copied',
      re: new RegExp(String.raw`^(?:capture|read|get|remember)\s+(?:the\s+)?clipboard(?:\s+(?:text|contents?))?\s+as\s+${KEY}$`, 'i'),
      build: (m) => ({ action: 'browser', captureAs: m[1], args: { op: 'clipboardRead' } }) },
    { name: 'basic-auth', keywords: ['use'], example: 'Use basic auth with username "admin" and password "${adminPassword}"',
      re: new RegExp(String.raw`^(?:use|set)\s+(?:http\s+)?(?:basic\s+auth(?:entication)?|http\s+credentials)\s+(?:with\s+)?(?:username\s+)?(${Q})\s+(?:and\s+(?:password\s+)?|\/\s*)(${Q})$`, 'i'),
      build: (m, q) => ({ action: 'browser', args: { op: 'basicAuth', username: V(m[1], q), password: V(m[2], q) } }) },
    { name: 'extra-header', keywords: ['send', 'set', 'add'], example: 'Send header "x-tenant" = "acme" with every request',
      re: new RegExp(String.raw`^(?:send|set|add)\s+(?:the\s+)?(?:extra\s+)?(?:http\s+)?header\s+(${Q})\s*(?:=|to|:)\s*(${Q})\s+(?:with|on|for)\s+(?:every|all)\s+requests?$|^set\s+(?:the\s+)?extra\s+http\s+header\s+(${Q})\s+to\s+(${Q})$`, 'i'),
      build: (m, q) => ({ action: 'browser', args: { op: 'headers', headers: { [V(m[1] ?? m[3], q)]: V(m[2] ?? m[4], q) } } }) },
    { name: 'user-agent', keywords: ['set', 'use'], example: 'Set the user agent to "EZTestBot/1.0"',
      re: new RegExp(String.raw`^(?:set\s+(?:the\s+)?user[-\s]agent\s+to|use\s+(?:the\s+)?user[-\s]agent)\s+(${Q})$`, 'i'),
      build: (m, q) => ({ action: 'browser', args: { op: 'userAgent', value: V(m[1], q) } }) },
  ]),

  // ================================================================== files
  ...cat('Files', [
    { name: 'upload-many', keywords: ['upload', 'attach'], example: 'Upload "fixtures/a.pdf" and "fixtures/b.pdf" to the Attachments field',
      re: new RegExp(String.raw`^(?:upload|attach)\s+(?:the\s+)?(?:files?\s+)?((?:${Q}\s*(?:,|and)\s*)+${Q})\s+(?:to|into|in|using|via|with|on)\s+(.+)$`, 'i'),
      build: (m, q) => ({ action: 'upload', target: T(m[2], q), args: { files: quotedList(m[1], q) } }) },
    { name: 'drop-files', keywords: ['drop', 'drag'], example: 'Drop file "fixtures/a.pdf" onto the Drop zone',
      re: new RegExp(String.raw`^(?:drop|drag(?:\s+and\s+drop)?)\s+(?:the\s+)?files?\s+((?:${Q}\s*(?:,|and)\s*)*${Q})\s+(?:onto|on|into|to|over)\s+(.+)$`, 'i'),
      build: (m, q) => ({ action: 'upload', target: T(m[2], q), args: { files: quotedList(m[1], q), mode: 'drop' } }) },
  ]),

  // ================================================================== API, GraphQL, SOAP, WebSocket
  ...cat('API', [
    { name: 'call-api-options', keywords: ['call', 'send'], example: 'Call API "POST /api/notes" with form title=Hello, body=World and store as note',
      re: new RegExp(String.raw`^(?:call\s+(?:the\s+)?api|send\s+(?:an?\s+)?(?:api\s+)?request)\s+(${Q})\s+((?:as\s+[\w-]+\s+)?(?:and\s+)?with\s+(?:form|query|params|headers?|multipart|body\s+from|json\s+from|file|timeout|errors|role|(?:the\s+)?client\s+cert(?:ificate)?)\b.*)$`, 'i'),
      build: (m, q) => {
        const r = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)$/i.exec(V(m[1], q).trim());
        if (!r) throw new Error('API call must look like "GET /path"');
        const o = apiOptions(m[2], q);
        const { key, asRole, allowErrors, ...rest } = o;
        return { action: 'api', api: { method: r[1].toUpperCase() as ApiCall['method'], url: r[2], ...rest, ...(asRole ? { asRole } : {}) }, captureAs: key ?? 'response', ...(allowErrors ? { args: { allowErrors: true } } : {}) };
      } },
    { name: 'graphql', keywords: ['send', 'run', 'call'], example: 'Send GraphQL query "{ orders { id status } }" to /graphql and store as gq',
      re: new RegExp(String.raw`^(?:send|run|call|execute|post)\s+(?:a\s+|the\s+)?graphql\s+(query|mutation|operation)\s+(${Q})\s+(?:to|on|at|against)\s+(${Q}|\S+)(?:\s+with\s+variables\s+(${Q}))?(?:\s+as\s+([\w-]+)(?=\s|$))?${STORE}?$`, 'i'),
      build: (m, q) => {
        let variables: Record<string, unknown> | undefined;
        if (m[4]) {
          const v: unknown = JSON.parse(V(m[4], q));
          if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('GraphQL variables must be a JSON object');
          variables = v as Record<string, unknown>;
        }
        return { action: 'api', api: { method: 'POST', url: V(m[3], q), graphql: { query: V(m[2], q), ...(variables ? { variables } : {}) }, ...(m[5] ? { asRole: m[5] } : {}) }, captureAs: m[6] ?? 'response' };
      } },
    { name: 'soap', keywords: ['call', 'send'], example: 'Call SOAP action "GetOrder" on /soap with body "<GetOrder><Id>1</Id></GetOrder>" and store as order',
      re: new RegExp(String.raw`^(?:call|send|invoke)\s+(?:the\s+)?soap\s+(?:action|operation|request)\s+(${Q})\s+(?:on|to|at)\s+(${Q}|\S+)\s+with\s+(?:the\s+)?body\s+(${Q})(?:\s+using\s+soap\s+(1\.[12]))?(?:\s+as\s+([\w-]+)(?=\s|$))?${STORE}?$`, 'i'),
      build: (m, q) => ({ action: 'api', api: { method: 'POST', url: V(m[2], q), soap: { action: V(m[1], q), body: V(m[3], q), ...(m[4] ? { version: m[4] as '1.1' | '1.2' } : {}) }, ...(m[5] ? { asRole: m[5] } : {}) }, captureAs: m[6] ?? 'response' }) },
    { name: 'ws-connect', keywords: ['connect', 'open'], example: 'Connect to websocket "/ws" as feed',
      re: new RegExp(String.raw`^(?:connect\s+to|open)\s+(?:a\s+|the\s+)?web\s*socket\s+(?:at\s+|to\s+)?(${Q}|\S+)(?:\s+as\s+(\w+))?$`, 'i'),
      build: (m, q) => ({ action: 'ws', args: { op: 'connect', url: V(m[1], q), socket: m[2] ?? 'ws' } }) },
    { name: 'ws-send', keywords: ['send'], example: 'Send "ping" on websocket feed',
      re: new RegExp(String.raw`^send\s+(?:the\s+)?(?:web\s*socket\s+message\s+)?(${Q})\s+(?:on|over|to|through|via)\s+(?:the\s+)?web\s*socket(?:\s+(\w+))?$|^send\s+web\s*socket\s+message\s+(${Q})(?:\s+on\s+(\w+))?$`, 'i'),
      build: (m, q) => ({ action: 'ws', value: V(m[1] ?? m[3], q), args: { op: 'send', socket: m[2] ?? m[4] ?? 'ws' } }) },
    { name: 'ws-expect', keywords: ['wait'], example: 'Wait for a websocket message containing "pong" on feed and store it as reply',
      re: new RegExp(String.raw`^wait\s+for\s+(?:a|the|an?\s+incoming)\s+(?:web\s*socket\s+)?message\s+(?:on\s+(?:web\s*socket\s+)?(\w+)\s+)?(?:containing|with|saying)\s+(${Q})(?:\s+on\s+(?:web\s*socket\s+)?(\w+))?${STORE}?$`, 'i'),
      build: (m, q) => ({ action: 'ws', args: { op: 'expect', contains: V(m[2], q), socket: m[1] ?? m[3] ?? 'ws' }, ...(m[4] ? { captureAs: m[4] } : {}) }) },
    { name: 'ws-close', keywords: ['close', 'disconnect'], example: 'Close websocket feed',
      re: /^(?:close|disconnect)\s+(?:the\s+)?web\s*socket(?:\s+(\w+))?$/i,
      build: (m) => ({ action: 'ws', args: { op: 'close', socket: m[1] ?? 'ws' } }) },
  ]),

  // ================================================================== databases
  ...cat('Database', [
    { name: 'query-capture', keywords: ['get', 'count', 'run'], example: 'Get the value of query "SELECT total FROM orders WHERE id = ${orderId}" on demo as total',
      re: new RegExp(String.raw`^(?:get|fetch|read|capture)\s+the\s+(value|first\s+row|row|rows|row\s+count|number\s+of\s+rows)\s+(?:of|from)\s+(?:the\s+)?(?:sql\s+)?query\s+(${Q})\s+(?:on|against|in|using)\s+([\w.-]+)(?:\s+with\s+params?\s+(\S+))?\s+as\s+${KEY}$|^count\s+(?:the\s+)?rows\s+(?:of|from|returned\s+by)\s+(?:the\s+)?(?:sql\s+)?query\s+(${Q})\s+(?:on|against|in|using)\s+([\w.-]+)\s+as\s+${KEY}$`, 'i'),
      build: (m, q) => {
        const what = (m[1] ?? 'row count').toLowerCase();
        const capture = what === 'value' ? 'cell' : /count|number/.test(what) ? 'count' : what === 'rows' ? 'rows' : 'row';
        const params = m[4] ? JSON.parse(V(m[4], q)) as unknown : undefined;
        if (params !== undefined && !Array.isArray(params)) throw new Error('Query params must be a JSON array');
        return { action: 'db', db: { connection: m[3] ?? m[7], sql: V(m[2] ?? m[6], q), capture, ...(params ? { params: params as Array<string | number | boolean | null> } : {}) }, captureAs: m[5] ?? m[8] };
      } },
    { name: 'wait-query', keywords: ['wait', 'poll'], example: 'Wait until query "SELECT * FROM orders WHERE status = \'Shipped\'" on demo returns 1 row',
      re: new RegExp(String.raw`^(?:wait|poll)\s+until\s+(?:the\s+)?(?:sql\s+)?query\s+(${Q})\s+(?:on|against|in)\s+([\w.-]+)\s+returns\s+(?:(at\s+least\s+)?(\d+)\s+rows?|rows|a\s+row|any\s+rows)(?:\s+(?:within|for\s+up\s+to)\s+${DUR})?(?:\s+(?:checking\s+)?every\s+${DUR})?(?:\s+as\s+${KEY})?$`, 'i'),
      build: (m, q) => {
        const n = m[4] !== undefined ? Number(m[4]) : 1;
        const key = m[9] ?? 'rows';
        const atLeast = !!m[3] || m[4] === undefined;
        const within = m[5] ? ms(m[5], m[6]) : 30_000;
        const every = m[7] ? ms(m[7], m[8]) : 1000;
        const cond: Condition = atLeast ? { type: 'expr', expr: `len(${key}) >= ${n}` } : { type: 'dbRowCount', captureKey: key, equals: n };
        return { action: 'db', db: { connection: m[2], sql: V(m[1], q) }, captureAs: key, postconditions: [cond], poll: { attempts: Math.max(1, Math.ceil(within / every)), intervalMs: every } };
      } },
    { name: 'call-procedure', keywords: ['call', 'execute', 'run'], example: 'Call procedure "close_order" on shop with params \'[42]\' as result',
      re: new RegExp(String.raw`^(?:call|execute|run|exec)\s+(?:the\s+)?(?:stored\s+)?procedure\s+(${Q}|[\w.]+)\s+(?:on|against|in|using)\s+([\w.-]+)(?:\s+with\s+params?\s+(\S+))?(?:\s+(?:and\s+)?(?:store\s+)?as\s+${KEY})?$`, 'i'),
      build: (m, q) => {
        const params = m[3] ? JSON.parse(V(m[3], q)) as unknown : [];
        if (!Array.isArray(params)) throw new Error('Procedure params must be a JSON array');
        return { action: 'db', db: { connection: m[2], sql: '', procedure: V(m[1], q), params: params as Array<string | number | boolean | null> }, captureAs: m[4] ?? 'rows' };
      } },
    { name: 'compare-data', keywords: ['compare'], example: 'Compare ${dbRows} with ${uiRows} by id',
      re: new RegExp(String.raw`^compare\s+(?:the\s+)?(?:data\s+|rows\s+)?(\$\{[\w.]+\}|[\w.]+)\s+(?:with|to|against)\s+(?:the\s+)?(\$\{[\w.]+\}|[\w.]+)\s+(?:by|using|on)\s+(?:key\s+|column\s+)?((?:${Q}|[\w.-]+)(?:\s*(?:,|and)\s*(?:${Q}|[\w.-]+))*)(?:\s+(?:ignoring\s+case))?(?:\s+(?:and\s+)?(?:store|save)\s+(?:the\s+result\s+)?as\s+${KEY})?$`, 'i'),
      build: (m, q) => {
        const strip = (s: string) => (s.startsWith('${') ? s.slice(2, -1) : s);
        const keys = m[3].split(/\s*(?:,|\band\b)\s*/i).map((k) => V(k, q));
        return { action: 'compareData', args: { expected: strip(m[1]), actual: strip(m[2]), key: keys.length === 1 ? keys[0] : keys, ...(/ignoring\s+case/i.test(m[0]) ? { ignoreCase: true } : {}) }, ...(m[4] ? { captureAs: m[4] } : {}) };
      } },
  ]),

  // ================================================================== email and SMS
  ...cat('Email and SMS', [
    { name: 'get-email', keywords: ['get', 'wait', 'fetch', 'open'], example: 'Get the latest email to "bob@shop.test" with subject "Welcome" as mail',
      re: new RegExp(String.raw`^(?:get|fetch|open|read|wait\s+for|check\s+for)\s+(?:the\s+)?(?:latest|last|newest|next|new|an?)\s+(?:e-?mail|message)(?:\s+(?:sent\s+)?to\s+(${Q}|\S+@\S+))?(?:\s+(?:with\s+(?:the\s+)?subject|about)\s+(${Q}))?(?:\s+(?:within|for\s+up\s+to)\s+${DUR})?(?:\s+(?:and\s+(?:store|save)\s+it\s+)?as\s+${KEY})?$`, 'i'),
      build: (m, q) => ({ action: 'email', args: { ...(m[1] ? { to: V(m[1], q) } : {}), ...(m[2] ? { subject: V(m[2], q) } : {}), ...(m[3] ? { timeoutMs: ms(m[3], m[4]) } : {}) }, captureAs: m[5] ?? 'email' }) },
    { name: 'get-sms', keywords: ['get', 'wait', 'fetch'], example: 'Get the latest SMS to "+15550100" as sms',
      re: new RegExp(String.raw`^(?:get|fetch|read|wait\s+for|check\s+for)\s+(?:the\s+)?(?:latest|last|newest|next|new|an?)\s+(?:sms|text\s+message|text)(?:\s+(?:sent\s+)?to\s+(${Q}|\+?[\d\s-]+?))?(?:\s+from\s+(${Q}|\+?[\d\s-]+?))?(?:\s+containing\s+(${Q}))?(?:\s+(?:within|for\s+up\s+to)\s+${DUR})?(?:\s+(?:and\s+(?:store|save)\s+it\s+)?as\s+${KEY})?$`, 'i'),
      build: (m, q) => ({ action: 'sms', args: { ...(m[1] ? { to: V(m[1], q).trim() } : {}), ...(m[2] ? { from: V(m[2], q).trim() } : {}), ...(m[3] ? { contains: V(m[3], q) } : {}), ...(m[4] ? { timeoutMs: ms(m[4], m[5]) } : {}) }, captureAs: m[6] ?? 'sms' }) },
  ]),

  // ================================================================== waits
  ...cat('Wait', [
    { name: 'wait-load', keywords: ['wait'], example: 'Wait for the network to be idle',
      re: /^wait\s+(?:for|until)\s+(?:the\s+)?(?:(page|document)\s+to\s+(?:finish\s+)?load(?:ing)?|page\s+(?:is\s+)?loaded|(network)\s+(?:to\s+be\s+|is\s+)?idle|network\s+idle|(dom\s*content\s*loaded|dom\s+content\s+to\s+load|dom\s+to\s+be\s+ready|dom\s+ready))$/i,
      build: (m) => ({ action: 'wait', args: { for: 'load', state: m[2] || /network/i.test(m[0]) ? 'networkidle' : m[3] ? 'domcontentloaded' : 'load' } }) },
    { name: 'wait-url-match', keywords: ['wait'], example: 'Wait for the URL to match "/orders/\\d+"',
      re: new RegExp(String.raw`^wait\s+(?:for|until)\s+(?:the\s+)?(?:url|address)\s+(?:to\s+)?(?:match|matches|to\s+be|is|equals?)\s+(${Q}|\S+)$`, 'i'),
      build: (m, q) => {
        const v = V(m[1], q);
        return { action: 'wait', args: { for: 'url', url: /^\/.*\/[gimsuy]*$/.test(v) || v.includes('*') ? v : `/${v.replace(/[.+?^${}()|[\]\\]/g, '\\$&')}/` } };
      } },
    { name: 'wait-state', keywords: ['wait'], example: 'Wait for the Save button to be enabled',
      re: /^wait\s+(?:for|until)\s+(.+?)\s+(?:to\s+(?:be(?:come)?\s+)?|is\s+|becomes\s+)(enabled|disabled|editable|read-?only|checked|unchecked|focused|stable|detached|attached|removed|gone\s+from\s+the\s+dom|in\s+the\s+viewport|in\s+view)$/i,
      build: (m, q) => {
        const raw = m[2].toLowerCase();
        const state = /removed|gone/.test(raw) ? 'detached' : /read-?only/.test(raw) ? 'readonly' : /view/.test(raw) ? 'inViewport' : raw;
        return { action: 'wait', target: T(m[1], q), args: { for: 'state', state } };
      } },
    { name: 'wait-text-change', keywords: ['wait'], example: 'Wait for the text of the Status label to change',
      re: new RegExp(String.raw`^wait\s+(?:for|until)\s+(?:the\s+text\s+of\s+(.+?)\s+to\s+change|(.+?)(?:\s+text)?\s+(?:to\s+change|changes)(?:\s+text)?)(?:\s+from\s+(${Q}))?${STORE}?$`, 'i'),
      build: (m, q) => ({ action: 'wait', target: T(m[1] ?? m[2], q), args: { for: 'textChange', ...(m[3] ? { from: V(m[3], q) } : {}) }, ...(m[4] ? { captureAs: m[4] } : {}) }) },
    { name: 'wait-until-condition', keywords: ['wait', 'poll'], example: 'Wait until the Status field has value "Shipped" within 30 seconds checking every 1 second',
      re: new RegExp(String.raw`^(?:wait|poll|keep\s+checking)\s+until\s+(.+?)(?:\s+(?:within|for\s+up\s+to|for\s+at\s+most|timeout)\s+${DUR})?(?:\s+(?:checking\s+|polling\s+)?every\s+${DUR})?$`, 'i'),
      build: (m, q) => {
        const text = restoreQuotes(m[1], q);
        const within = m[2] ? ms(m[2], m[3]) : undefined;
        const every = m[4] ? ms(m[4], m[5]) : undefined;
        let fc: { condition?: Condition; expr?: string };
        try {
          fc = flowCondition(text);
        } catch (e) {
          if (within || every) throw e;
          return undefined; // e.g. "Wait until the Orders table shows up": a core wait rule
        }
        // Plain "Wait until <condition>" (or a bare word) stays a core rule.
        if (!within && !every && (!fc.expr || !/[<>=!]|\(|\b(?:and|or|not|contains|matches)\b/.test(fc.expr))) return undefined;
        return { action: 'wait', args: { for: 'condition', ...(fc.condition ? { condition: fc.condition } : { expr: fc.expr }), ...(within ? { timeoutMs: within } : {}), ...(every ? { intervalMs: every } : {}) } };
      } },
  ]),
];

function dialogKind(s: string): string {
  const k = s.toLowerCase();
  if (k.startsWith('confirm')) return 'confirm';
  if (/leave|beforeunload/.test(k)) return 'beforeunload';
  return k;
}
