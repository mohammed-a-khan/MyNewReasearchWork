/**
 * The deterministic plain-English grammar. Each rule is a regex over a
 * quote-protected line plus a builder producing a Journey step. Rules are tried
 * in order; the first that matches and builds wins. Nothing here guesses with
 * a model: the same line always yields the same step.
 */
import type { ApiCall, Condition, StepInput } from '../core/index.js';
import { parseCondition, tryParseCondition } from './conditions.js';
import { literal, restoreQuotes } from './quotes.js';
import { describeTarget } from './target.js';
import { ADVANCED_RULES, isKeyName } from './rules-advanced.js';
import { MIGRATION_RULES } from './rules-migration.js';
import { COMPONENT_RULES } from './rules-components.js';
import { QUERY_RULES } from './rules-queries.js';
import { DESKTOP_RULES } from './rules-desktop.js';
import { INTEGRATION_RULES } from '../integration/rules.js';
import { MOBILE_RULES } from './rules-mobile.js';
import { VISUAL_RULES } from './rules-visual.js';
import { A11Y_RULES } from './rules-a11y.js';
import { ACTOR_RULES } from './rules-actors.js';
import { CLOCK_RULES } from './rules-clock.js';
import { SPECIALIST_RULES } from './rules-specialist.js';
import { MANUAL_RULES } from './rules-manual.js';
import { KEYBOARD_RULES } from './rules-keyboard.js';
import { STORE_RULES } from '../store/rules.js';

/** What a rule builds: a step without id/intent (the parser adds those). */
export type StepBody = Omit<StepInput, 'id' | 'intent'>;

export interface IntentRule {
  /** Stable rule name, e.g. "fill-into". */
  name: string;
  /** Leading words that suggest this rule, used for "did you mean" suggestions. */
  keywords: string[];
  /** A canonical example line. */
  example: string;
  re: RegExp;
  build(m: RegExpExecArray, q: string[]): StepBody | undefined;
  /** Grouping for catalogues (e.g. the Studio palette). */
  category?: string;
  /**
   * Match against the raw line (quotes not protected), for rules whose tail
   * is verbatim code ("Run JavaScript: ..."). `q` is then empty.
   */
  raw?: boolean;
}

const T = (s: string, q: string[]) => describeTarget(restoreQuotes(s.trim(), q));
const V = (s: string, q: string[]) => literal(s, q);

/** Parse "2 seconds", "500ms", "1.5 s", "1 minute" into milliseconds. */
export function parseDuration(n: string, unit?: string): number {
  const v = Number(n);
  const u = (unit ?? 'ms').toLowerCase();
  if (/^(?:ms|millis|milliseconds?)$/.test(u)) return Math.round(v);
  if (/^(?:s|secs?|seconds?)$/.test(u)) return Math.round(v * 1000);
  if (/^(?:m|mins?|minutes?)$/.test(u)) return Math.round(v * 60_000);
  throw new Error(`Unknown duration unit "${unit}"`);
}

const DUR = String.raw`(\d+(?:\.\d+)?)\s*(ms|millis|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)`;
const METHOD = String.raw`(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)`;
const KEY = String.raw`([A-Za-z_][\w.-]*)`;

function assertStep(c: Condition): StepBody {
  return { action: 'assert', postconditions: [c] };
}

/** Parse "k=v, k2=v2" / "k = v and k2 = v2" into a record. */
export function parseKeyValues(s: string, q: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(/\s*(?:,|\band\b)\s*/i)) {
    if (!part.trim()) continue;
    const m = /^([\w.-]+)\s*(?:=|:|is)\s*(.+)$/i.exec(part.trim());
    if (!m) throw new Error(`Expected key=value, got "${restoreQuotes(part, q)}"`);
    out[m[1]] = V(m[2], q);
  }
  return out;
}

function apiBody(method: string, url: string, q: string[], body?: string, role?: string, key?: string): StepBody {
  const call: ApiCall = { method: method.toUpperCase() as ApiCall['method'], url: V(url, q) };
  if (body) {
    const raw = V(body, q);
    try {
      call.body = JSON.parse(raw);
    } catch {
      call.body = raw;
    }
  }
  if (role) call.asRole = role;
  return { action: 'api', api: call, captureAs: key ?? 'response' };
}

/** Split a quoted "GET /path" into method and url. */
function splitRequest(s: string): [string, string] | undefined {
  const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)$/i.exec(s.trim());
  return m ? [m[1], m[2]] : undefined;
}

// "Expect softly ..." is a soft assertion (rules-advanced), not a plain one.
const ASSERT_PREFIX = String.raw`^(?:verify|expect|assert|ensure|confirm|make\s+sure|validate)\s+(?!softly\b)(?:that\s+)?(.+)$`;

export const INTENT_RULES: IntentRule[] = [
  // ------------------------------------------------------------ shared test data: store and data pools (before "Save/Store ..." and assertions)
  ...STORE_RULES,
  // ------------------------------------------------------------ accessibility checks ("Check accessibility", "Expect the page to be accessible")
  ...A11Y_RULES,
  // ------------------------------------------------------------ multi-actor journeys ("As manager:", "Switch to user", "In parallel:")
  ...ACTOR_RULES,
  // ------------------------------------------------------------ integration: messaging, gRPC, files/SSH, batch, EDI, contracts (before generic waits/asserts)
  ...INTEGRATION_RULES,
  // ------------------------------------------------------------ browser clock and time (before "Set ... to ..." variables)
  ...CLOCK_RULES,
  // ------------------------------------------------------------ components (grids, combo boxes, date pickers, trees, ...)
  ...COMPONENT_RULES,
  // ------------------------------------------------------------ migration aids (rows from downloads, loader waits)
  ...MIGRATION_RULES,
  // ------------------------------------------------------------ named-query catalogue (before assertions: "Expect query "NAME" ... returns 2 rows")
  ...QUERY_RULES,
  // ------------------------------------------------------------ desktop and legacy (mainframe, SAP GUI, Windows/Java apps, image/OCR); see rules-desktop.ts
  ...DESKTOP_RULES,
  // ------------------------------------------------------------ visual baselines (before assertions: "Expect the Header to look like the baseline")
  ...VISUAL_RULES,
  // ------------------------------------------------------------ phone calls, single stories, API security scans; see rules-specialist.ts
  ...SPECIALIST_RULES,
  // ------------------------------------------------------------ manual steps ("Manual: ..."), carried out by a tester (docs/manual-testing.md)
  ...MANUAL_RULES,
  // ------------------------------------------------------------ keyboard operability ("Expect the page to be keyboard operable")
  ...KEYBOARD_RULES,

  // ------------------------------------------------------------ assertions
  { name: 'assert', keywords: ['verify', 'expect', 'assert', 'ensure', 'confirm'], example: 'Verify the page contains "Welcome"',
    re: new RegExp(ASSERT_PREFIX, 'i'), build: (m, q) => assertStep(parseCondition(restoreQuotes(m[1], q))) },
  { name: 'check-that', keywords: ['check'], example: 'Check that the URL contains "/dashboard"',
    re: /^check\s+that\s+(.+)$/i, build: (m, q) => assertStep(parseCondition(restoreQuotes(m[1], q))) },
  { name: 'should-see', keywords: ['should', 'see'], example: 'I should see "Order created"',
    re: /^(?:should|must)\s+(?:not\s+)?see\s+.+$/i, build: (m, q) => assertStep(parseCondition(restoreQuotes(m[0], q))) },
  { name: 'see', keywords: ['see'], example: 'See "Welcome"',
    re: /^sees?\s+(.+)$/i, build: (m, q) => assertStep(parseCondition(restoreQuotes(m[0], q))) },
  { name: 'subject-should', keywords: ['should'], example: 'The Orders table should have 2 rows',
    re: /^(.+?)\s+(?:should|must)\s+.+$/i, build: (m, q) => {
      const c = tryParseCondition(restoreQuotes(m[0], q));
      return c ? assertStep(c) : undefined;
    } },

  // ------------------------------------------------------------ native mobile (gestures, device and app operations; docs/mobile.md)
  ...MOBILE_RULES,

  // ------------------------------------------------------------ advanced (tabs, frames, dialogs, input, network, flow, ...)
  ...ADVANCED_RULES,

  // ------------------------------------------------------------ navigation
  { name: 'reload', keywords: ['reload', 'refresh'], example: 'Reload the page',
    re: /^(?:reload|refresh)(?:\s+the\s+page)?$/i, build: () => ({ action: 'navigate', value: 'reload', args: { mode: 'reload' } }) },
  { name: 'go-back', keywords: ['go', 'back'], example: 'Go back',
    re: /^(?:go|navigate)\s+back(?:\s+a\s+page)?$/i, build: () => ({ action: 'navigate', value: 'back', args: { mode: 'back' } }) },
  { name: 'go-forward', keywords: ['go', 'forward'], example: 'Go forward',
    re: /^(?:go|navigate)\s+forward$/i, build: () => ({ action: 'navigate', value: 'forward', args: { mode: 'forward' } }) },
  { name: 'open-element', keywords: ['open'], example: 'Open the Orders tab',
    re: /^open\s+(?:the\s+)?(.+?\s+(?:link|tab|menu|menu item|dropdown))$/i, build: (m, q) => ({ action: 'click', target: T(m[1], q) }) },
  { name: 'open-url', keywords: ['open', 'visit', 'launch', 'browse'], example: 'Open /login',
    re: /^(?:open|visit|launch|browse\s+to|load)\s+(?:the\s+)?(?:page\s+|url\s+|site\s+)?(.+)$/i, build: (m, q) => ({ action: 'navigate', value: V(m[1], q) }) },
  { name: 'go-to', keywords: ['go', 'navigate', 'head'], example: 'Go to /orders/new',
    re: /^(?:go|navigate|head|browse)\s+to\s+(?:the\s+)?(?:page\s+|url\s+)?(.+)$/i, build: (m, q) => ({ action: 'navigate', value: V(m[1], q) }) },
  { name: 'start-at', keywords: ['start', 'begin'], example: 'Start at /login',
    re: /^(?:start|begin)\s+(?:at|on|from)\s+(.+)$/i, build: (m, q) => ({ action: 'navigate', value: V(m[1], q) }) },

  // ------------------------------------------------------------ data / identity
  { name: 'login-as', keywords: ['log', 'login', 'sign', 'authenticate'], example: 'Log in as manager',
    re: /^(?:log\s*in|login|sign\s*in|signin|authenticate)\s+as\s+(?:an?\s+|the\s+)?(.+)$/i, build: (m, q) => ({ action: 'login', value: V(m[1], q) }) },
  { name: 'login', keywords: ['log', 'login', 'sign'], example: 'Log in',
    re: /^(?:log\s*in|login|sign\s*in|signin)$/i, build: () => ({ action: 'login' }) },
  { name: 'use-data', keywords: ['use'], example: 'Use data Customer as customer where region=EU',
    re: /^use\s+(?:test\s+)?data\s+(\w+)\s+as\s+(\w+)(?:\s+(?:where|with)\s+(.+))?$/i,
    build: (m, q) => ({ action: 'useData', args: { entity: m[1], as: m[2], where: m[3] ? parseKeyValues(m[3], q) : {} } }) },
  { name: 'given-entity', keywords: ['given', 'with'], example: 'Given a Customer as buyer where region=EU',
    re: /^(?:(?:given|with|using)\s+)?an?\s+(\w+)\s+(?:as|called|named)\s+(\w+)(?:\s+(?:where|with)\s+(.+))?$/i,
    build: (m, q) => ({ action: 'useData', args: { entity: m[1], as: m[2], where: m[3] ? parseKeyValues(m[3], q) : {} } }) },

  // ------------------------------------------------------------ api
  { name: 'call-api-quoted', keywords: ['call', 'api'], example: 'Call API "GET /api/orders" as manager and store as orders',
    re: new RegExp(String.raw`^call\s+(?:the\s+)?api\s+(⟦\d+⟧)(?:\s+with\s+body\s+(\S+))?(?:\s+as\s+([\w-]+))?(?:\s+(?:and\s+)?(?:store|save|capture|keep)\s+(?:it\s+|the\s+response\s+)?as\s+${KEY})?$`, 'i'),
    build: (m, q) => {
      const r = splitRequest(V(m[1], q));
      if (!r) throw new Error('API call must look like "GET /path"');
      return apiBody(r[0], r[1], [], m[2] ? V(m[2], q) : undefined, m[3], m[4]);
    } },
  { name: 'call-api', keywords: ['call', 'api'], example: 'Call API GET /api/orders and store as orders',
    re: new RegExp(String.raw`^call\s+(?:the\s+)?(?:api\s+)?${METHOD}\s+(\S+)(?:\s+with\s+body\s+(\S+))?(?:\s+as\s+([\w-]+))?(?:\s+(?:and\s+)?(?:store|save|capture|keep)\s+(?:it\s+|the\s+response\s+)?as\s+${KEY})?$`, 'i'),
    build: (m, q) => apiBody(m[1], m[2], q, m[3], m[4], m[5]) },
  { name: 'send-request', keywords: ['send', 'make'], example: 'Send a GET request to /api/orders and store as orders',
    re: new RegExp(String.raw`^(?:send|make|issue)\s+an?\s+${METHOD}\s+(?:request\s+)?to\s+(\S+)(?:\s+with\s+body\s+(\S+))?(?:\s+as\s+([\w-]+))?(?:\s+(?:and\s+)?(?:store|save|capture|keep)\s+(?:it\s+|the\s+response\s+)?as\s+${KEY})?$`, 'i'),
    build: (m, q) => apiBody(m[1], m[2], q, m[3], m[4], m[5]) },
  { name: 'bare-request', keywords: ['get', 'post', 'put', 'patch', 'delete'], example: 'GET /api/orders as manager and store as orders',
    re: new RegExp(String.raw`^${METHOD}\s+(\S+)(?:\s+with\s+body\s+(\S+))?(?:\s+as\s+([\w-]+))?(?:\s+(?:and\s+)?(?:store|save|capture|keep)\s+(?:it\s+|the\s+response\s+)?as\s+${KEY})?$`),
    build: (m, q) => apiBody(m[1], m[2], q, m[3], m[4], m[5]) },

  // ------------------------------------------------------------ db
  { name: 'run-query', keywords: ['run', 'query', 'execute'], example: 'Run query "SELECT * FROM orders" on shop as rows',
    re: new RegExp(String.raw`^(?:run|execute)\s+(?:the\s+)?(?:sql\s+)?query\s+(⟦\d+⟧)\s+(?:on|against|in|using)\s+([\w.-]+)(?:\s+(?:with\s+params?\s+(\S+)))?(?:\s+(?:and\s+)?(?:store|save)?\s*(?:it\s+)?as\s+${KEY})?$`, 'i'),
    build: (m, q) => dbBody(m[2], V(m[1], q), m[3] ? V(m[3], q) : undefined, m[4]) },
  { name: 'query-on', keywords: ['query'], example: 'Query shop with "SELECT COUNT(*) AS n FROM orders" as count',
    re: new RegExp(String.raw`^query\s+([\w.-]+)\s+(?:with|for|using)\s+(⟦\d+⟧)(?:\s+(?:and\s+)?(?:store|save)?\s*(?:it\s+)?as\s+${KEY})?$`, 'i'),
    build: (m, q) => dbBody(m[1], V(m[2], q), undefined, m[3]) },

  // ------------------------------------------------------------ documents
  { name: 'compare-document', keywords: ['compare'], example: 'Compare document invoice to the order and store as invoiceCheck',
    re: new RegExp(String.raw`^compare\s+(?:the\s+)?(?:document|pdf|file|invoice|report)\s+(\S+)\s+(?:to|with|against)\s+(.+?)(?:\s+using\s+(\S+))?(?:\s+(?:and\s+)?(?:store|save)\s+(?:it\s+|the\s+result\s+)?as\s+${KEY})?$`, 'i'),
    build: (m, q) => ({ action: 'compareDocument', args: { document: V(m[1], q), against: V(m[2], q), ...(m[3] ? { using: V(m[3], q) } : {}) }, ...(m[4] ? { captureAs: m[4] } : {}) }) },

  // ------------------------------------------------------------ custom
  { name: 'custom-step', keywords: ['run', 'perform', 'execute'], example: 'Run step "seedCart" with items=3',
    re: /^(?:run|perform|execute|do)\s+(?:the\s+)?(?:custom\s+)?step\s+(\S+)(?:\s+with\s+(.+))?$/i,
    build: (m, q) => ({ action: 'custom', handler: V(m[1], q), ...(m[2] ? { args: parseKeyValues(m[2], q) } : {}) }) },

  // ------------------------------------------------------------ waits
  { name: 'wait-duration', keywords: ['wait'], example: 'Wait 2 seconds',
    re: new RegExp(String.raw`^wait\s+(?:for\s+)?${DUR}$`, 'i'), build: (m) => ({ action: 'wait', value: String(parseDuration(m[1], m[2])) }) },
  { name: 'pause', keywords: ['pause', 'sleep'], example: 'Pause for 500 ms',
    re: new RegExp(String.raw`^(?:pause|sleep)\s+(?:for\s+)?${DUR}$`, 'i'), build: (m) => ({ action: 'wait', value: String(parseDuration(m[1], m[2])) }) },
  { name: 'wait-url', keywords: ['wait'], example: 'Wait until the URL contains "/dashboard"',
    re: /^wait\s+(?:until|for)\s+(?:the\s+)?(?:url|address)\s+(?:to\s+)?(?:contains?|includes?)\s+(.+)$/i,
    build: (m, q) => ({ action: 'wait', postconditions: [{ type: 'urlContains', value: V(m[1], q) }] }) },
  { name: 'wait-text', keywords: ['wait'], example: 'Wait for the text "Saved"',
    re: /^wait\s+(?:until|for)\s+(?:the\s+)?text\s+(⟦\d+⟧)(?:\s+to\s+appear|\s+appears)?$/i,
    build: (m, q) => ({ action: 'wait', postconditions: [{ type: 'pageContainsText', value: V(m[1], q) }] }) },
  { name: 'wait-hidden', keywords: ['wait'], example: 'Wait for the spinner to disappear',
    re: /^wait\s+(?:until|for)\s+(.+?)\s+(?:to\s+(?:disappear|be\s+hidden|go\s+away|vanish)|disappears|is\s+hidden|is\s+gone)$/i,
    build: (m, q) => ({ action: 'wait', postconditions: [{ type: 'hidden', target: T(m[1], q) }] }) },
  { name: 'wait-visible', keywords: ['wait'], example: 'Wait for the Orders table to appear',
    re: /^wait\s+(?:until|for)\s+(.+?)(?:\s+to\s+(?:appear|be\s+visible|show|load)|\s+appears|\s+is\s+visible)?$/i,
    build: (m, q) => ({ action: 'wait', target: T(m[1], q) }) },

  // ------------------------------------------------------------ capture / download
  { name: 'capture-mode', keywords: ['capture', 'remember', 'store', 'save', 'grab', 'read', 'note'], example: 'Capture the text of testid=order-number as orderNumber',
    re: new RegExp(String.raw`^(?:capture|remember|store|save|grab|read|get|note|record)\s+(?:the\s+)?(text|value)\s+(?:of|from|in)\s+(.+?)\s+(?:as|into)\s+${KEY}$`, 'i'),
    build: (m, q) => ({ action: 'capture', target: T(m[2], q), captureAs: m[3], args: { mode: m[1].toLowerCase() } }) },
  { name: 'let-be', keywords: ['let'], example: 'Let total be the text of testid=order-total',
    re: new RegExp(String.raw`^let\s+${KEY}\s+(?:be|=)\s+(?:the\s+)?(text|value)\s+(?:of|from|in)\s+(.+)$`, 'i'),
    build: (m, q) => ({ action: 'capture', target: T(m[3], q), captureAs: m[1], args: { mode: m[2].toLowerCase() } }) },
  { name: 'download-as', keywords: ['download', 'save'], example: 'Download the Download invoice link as invoice',
    re: new RegExp(String.raw`^(?:download|save\s+the\s+download\s+(?:from|of))\s+(.+?)\s+as\s+${KEY}$`, 'i'),
    build: (m, q) => ({ action: 'download', target: T(m[1], q), captureAs: m[2] }) },
  { name: 'download', keywords: ['download'], example: 'Download the invoice link',
    re: /^download\s+(?:by\s+clicking\s+)?(.+)$/i, build: (m, q) => ({ action: 'download', target: T(m[1], q), captureAs: 'download' }) },
  { name: 'capture', keywords: ['capture', 'remember', 'store', 'save', 'note'], example: 'Remember the order number link as orderNumber',
    re: new RegExp(String.raw`^(?:capture|remember|store|save|grab|note|record)\s+(.+?)\s+(?:as|into)\s+${KEY}$`, 'i'),
    build: (m, q) => ({ action: 'capture', target: T(m[1], q), captureAs: m[2], args: { mode: 'text' } }) },

  // ------------------------------------------------------------ pointer
  { name: 'double-click', keywords: ['double-click', 'double', 'dblclick'], example: 'Double-click the Order row',
    re: /^(?:double[-\s]?click|double[-\s]?tap|dbl[-\s]?click)\s+(?:on\s+)?(.+)$/i, build: (m, q) => ({ action: 'dblclick', target: T(m[1], q) }) },
  { name: 'right-click', keywords: ['right-click', 'right'], example: 'Right-click the Order row',
    re: /^right[-\s]?click\s+(?:on\s+)?(.+)$/i, build: (m, q) => ({ action: 'click', target: T(m[1], q), args: { button: 'right' } }) },
  { name: 'click', keywords: ['click', 'tap'], example: 'Click the "Sign in" button',
    re: /^(?:click|tap|hit)\s+(?:on\s+)?(.+)$/i, build: (m, q) => ({ action: 'click', target: T(m[1], q) }) },
  { name: 'press-element', keywords: ['press', 'push'], example: 'Press the Save button',
    re: /^(?:press|push)\s+(?:on\s+)?(?:the\s+)?(.+?\s+(?:button|link|btn))$/i, build: (m, q) => ({ action: 'click', target: T(m[1], q) }) },
  { name: 'follow-link', keywords: ['follow'], example: 'Follow the Orders link',
    re: /^follow\s+(?:the\s+)?(.+)$/i, build: (m, q) => ({ action: 'click', target: T(/link$/i.test(m[1]) ? m[1] : `${m[1]} link`, q) }) },
  { name: 'submit', keywords: ['submit'], example: 'Submit with the "Place order" button',
    re: /^submit\s+(?:the\s+form\s+)?(?:with|using|via)\s+(.+)$/i, build: (m, q) => ({ action: 'click', target: T(m[1], q) }) },
  { name: 'hover', keywords: ['hover', 'mouse', 'point'], example: 'Hover over the Help icon',
    re: /^(?:hover|mouse\s*over|move\s+the\s+mouse\s+(?:to|over)|point\s+at)\s+(?:over\s+|on\s+)?(.+)$/i, build: (m, q) => ({ action: 'hover', target: T(m[1], q) }) },

  // ------------------------------------------------------------ keyboard
  { name: 'press-key-in', keywords: ['press', 'hit'], example: 'Press Enter in the Search field',
    re: /^(?:press|hit)\s+(?:the\s+)?(?:key\s+)?([A-Za-z0-9+]+|⟦\d+⟧)(?:\s+key)?\s+(?:in|on|into)\s+(.+)$/i,
    build: (m, q) => (isKey(V(m[1], q)) ? { action: 'press', value: V(m[1], q), target: T(m[2], q) } : undefined) },
  { name: 'press-key', keywords: ['press', 'hit'], example: 'Press Enter',
    re: /^(?:press|hit)\s+(?:the\s+)?(?:key\s+)?([A-Za-z0-9+]+|⟦\d+⟧)(?:\s+key)?$/i,
    build: (m, q) => (isKey(V(m[1], q)) ? { action: 'press', value: V(m[1], q) } : undefined) },

  // ------------------------------------------------------------ forms
  { name: 'upload', keywords: ['upload', 'attach'], example: 'Upload "fixtures/po.pdf" to the Attachment field',
    re: /^(?:upload|attach)\s+(?:the\s+)?(?:file\s+)?(.+?)\s+(?:to|into|in|using|via|with|on)\s+(.+)$/i,
    build: (m, q) => ({ action: 'upload', value: V(m[1], q), target: T(m[2], q) }) },
  { name: 'choose-file', keywords: ['choose', 'select'], example: 'Choose file "a.csv" for the Import field',
    re: /^(?:choose|select|pick)\s+file\s+(.+?)\s+(?:for|in|into|on)\s+(.+)$/i,
    build: (m, q) => ({ action: 'upload', value: V(m[1], q), target: T(m[2], q) }) },
  { name: 'type-into', keywords: ['type', 'enter', 'input', 'write', 'key'], example: 'Type "bob" into the Username field',
    re: /^(?:type|enter|input|write|key\s+in)\s+(.+?)\s+(?:into|in\s+to|in|on)\s+(.+)$/i,
    build: (m, q) => ({ action: 'fill', value: V(m[1], q), target: T(m[2], q) }) },
  { name: 'fill-with', keywords: ['fill'], example: 'Fill the Quantity field with 2',
    re: /^fill\s+(?:in\s+|out\s+)?(.+?)\s+with\s+(.+)$/i, build: (m, q) => ({ action: 'fill', target: T(m[1], q), value: V(m[2], q) }) },
  { name: 'fill-into', keywords: ['fill'], example: 'Fill "2" into the Quantity field',
    re: /^fill\s+(.+?)\s+(?:into|in)\s+(.+)$/i, build: (m, q) => ({ action: 'fill', value: V(m[1], q), target: T(m[2], q) }) },
  { name: 'set-select', keywords: ['set', 'change'], example: 'Set the Product dropdown to "Widget"',
    re: /^(?:set|change)\s+(.+?(?:dropdown|drop-down|select|combobox|combo box|list box|picker))\s+to\s+(.+)$/i,
    build: (m, q) => ({ action: 'select', target: T(m[1], q), value: V(m[2], q) }) },
  { name: 'set-to', keywords: ['set', 'change', 'update'], example: 'Set the Quantity field to 2',
    re: /^(?:set|change|update)\s+(.+?)\s+to\s+(.+)$/i, build: (m, q) => ({ action: 'fill', target: T(m[1], q), value: V(m[2], q) }) },
  { name: 'put-in', keywords: ['put'], example: 'Put "2" in the Quantity field',
    re: /^put\s+(.+?)\s+(?:in|into)\s+(.+)$/i, build: (m, q) => ({ action: 'fill', value: V(m[1], q), target: T(m[2], q) }) },
  { name: 'clear', keywords: ['clear', 'empty', 'erase'], example: 'Clear the Search field',
    re: /^(?:clear|empty|erase|blank)\s+(?:out\s+)?(.+)$/i, build: (m, q) => ({ action: 'clear', target: T(m[1], q) }) },
  { name: 'select-from', keywords: ['select', 'choose', 'pick'], example: 'Select "Gadget" from the Product dropdown',
    re: /^(?:select|choose|pick)\s+(.+?)\s+(?:from|in|on|for)\s+(.+)$/i,
    build: (m, q) => ({ action: 'select', value: V(m[1], q), target: T(m[2], q) }) },
  { name: 'uncheck', keywords: ['uncheck', 'untick', 'unmark', 'deselect'], example: 'Uncheck the Newsletter checkbox',
    re: /^(?:uncheck|untick|unmark|deselect|unselect)\s+(.+)$/i, build: (m, q) => ({ action: 'uncheck', target: T(m[1], q) }) },
  { name: 'check', keywords: ['check', 'tick', 'mark'], example: 'Check the Remember me checkbox',
    re: /^(?:check|tick|mark)\s+(.+)$/i, build: (m, q) => ({ action: 'check', target: T(m[1], q) }) },
  { name: 'turn-on', keywords: ['turn', 'enable', 'switch'], example: 'Turn on the Dark mode switch',
    re: /^(?:turn\s+on|enable|switch\s+on)\s+(.+)$/i, build: (m, q) => ({ action: 'check', target: T(m[1], q) }) },
  { name: 'turn-off', keywords: ['turn', 'disable', 'switch'], example: 'Turn off the Dark mode switch',
    re: /^(?:turn\s+off|disable|switch\s+off)\s+(.+)$/i, build: (m, q) => ({ action: 'uncheck', target: T(m[1], q) }) },
  { name: 'select-option', keywords: ['select', 'choose'], example: 'Select the Express radio button',
    re: /^(?:select|choose)\s+(?:the\s+)?(.+?\s+(?:radio|radio button|checkbox|option|switch))$/i,
    build: (m, q) => ({ action: 'check', target: T(m[1], q) }) },
];

const NAMED_KEYS = /^(?:enter|tab|escape|esc|space|backspace|delete|home|end|pageup|pagedown|insert|arrow(?:up|down|left|right)|f\d{1,2})$/i;
function isKey(k: string): boolean {
  return k.split('+').every((p) => NAMED_KEYS.test(p) || /^(?:control|ctrl|shift|alt|meta|cmd|controlormeta)$/i.test(p) || /^[A-Za-z0-9]$/.test(p) || isKeyName(p));
}

function dbBody(connection: string, sql: string, params: string | undefined, key: string | undefined): StepBody {
  let p: Array<string | number | boolean | null> | undefined;
  if (params) {
    const parsed: unknown = JSON.parse(params);
    if (!Array.isArray(parsed)) throw new Error('Query params must be a JSON array');
    p = parsed as Array<string | number | boolean | null>;
  }
  return { action: 'db', db: { connection, sql, ...(p ? { params: p } : {}) }, captureAs: key ?? 'rows' };
}

