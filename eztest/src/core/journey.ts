/**
 * The Journey Model: EZTest's single source of truth for a test.
 *
 * A journey is a sequence of intent steps. Every step says *what* it does
 * (intent), *how* to find what it acts on (a target with several locator
 * candidates and an element fingerprint) and *what must be true afterwards*
 * (post-conditions). Post-conditions are what make healing verifiable: a
 * healed step only counts when its post-conditions still hold.
 */
import { z } from 'zod';

export const LocatorStrategy = z.enum([
  'role',
  'label',
  'text',
  'testId',
  'placeholder',
  'altText',
  'title',
  'css',
  'xpath',
  // ---------------------------------------------------- native apps (EZTest device agents; see docs/mobile.md)
  /** Accessibility id (iOS accessibilityIdentifier / name, Android content-desc). */
  'accessibilityId',
  /** Native element id (Android resource-id, iOS name). */
  'id',
  /** Native class name (android.widget.Button, XCUIElementTypeButton). */
  'className',
  /** iOS NSPredicate string (evaluated by XCTest). */
  'iosPredicate',
  // ---------------------------------------------------- containers (see docs/ez-language.md#relative-and-scoped-targets)
  /** A container labelled by `value`: landmark/group accessible name, fieldset legend or first heading. */
  'section',
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategy>;

export const LocatorCandidate = z.object({
  strategy: LocatorStrategy,
  value: z.string().min(1),
  /** Accessible name, used with strategy "role". */
  name: z.string().optional(),
  exact: z.boolean().optional(),
});
export type LocatorCandidate = z.infer<typeof LocatorCandidate>;

/** Snapshot of an element's identifying traits, recorded when the step last passed. */
export const ElementFingerprint = z.object({
  tag: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  id: z.string().optional(),
  testId: z.string().optional(),
  classes: z.array(z.string()).optional(),
  attributes: z.record(z.string(), z.string()).optional(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  /** CSS-like ancestry path, e.g. "form#login > div.row > button". */
  path: z.string().optional(),
  box: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .optional(),
});
export type ElementFingerprint = z.infer<typeof ElementFingerprint>;

/** How a scope narrows where a target is looked for (see TargetScope). */
export const ScopeRelation = z.enum(['within', 'row', 'above', 'below', 'leftOf', 'rightOf', 'near']);
export type ScopeRelation = z.infer<typeof ScopeRelation>;

export const Target = z.object({
  /** Human description, e.g. "the Sign in button". */
  description: z.string().min(1),
  locators: z.array(LocatorCandidate).default([]),
  fingerprint: ElementFingerprint.optional(),
  /** Frame selector chain for elements inside iframes. */
  frames: z.array(z.string()).optional(),
  /**
   * Relative and scoped targeting, outermost first: "in the row containing X",
   * "inside the Billing section", "below / above / right of / left of / near X".
   * Every anchor must resolve to exactly one element; the candidates are then
   * looked for inside the container (within, row) or filtered by layout.
   */
  get scope(): z.ZodOptional<z.ZodArray<typeof TargetScope>> {
    return z.array(TargetScope).optional();
  },
  /** Ordinal pick among the candidate's matches ("the 2nd Delete button"): 0-based, -1 = last. */
  nth: z.number().int().optional(),
  /** Shared element repository id (`Checkout.placeOrder`, elements/*.yaml); its locators come from the repository. */
  element: z.string().min(1).optional(),
});
export type Target = z.infer<typeof Target>;

/** One scope of a target: a container, a row, or a layout anchor. */
export const TargetScope = z.object({
  relation: ScopeRelation,
  /** The container (within) or the layout anchor (above/below/leftOf/rightOf/near). */
  get anchor(): z.ZodOptional<typeof Target> {
    return Target.optional();
  },
  /** row: text the row contains. */
  text: z.string().optional(),
  exact: z.boolean().optional(),
  /** Layout: only elements within this many CSS pixels of the anchor (near defaults to 50). */
  maxDistance: z.number().positive().optional(),
});
export type TargetScope = z.infer<typeof TargetScope>;

/** How a value is compared in attribute/cookie/storage/jsonPath conditions. */
export const CompareOp = z.enum(['equals', 'contains', 'matches', 'exists', 'absent', 'gt', 'gte', 'lt', 'lte', 'ne']);
export type CompareOp = z.infer<typeof CompareOp>;

/** Element states checked by the `state` condition and waited for by "Wait for X to be <state>". */
export const ElementState = z.enum([
  'enabled', 'disabled', 'editable', 'readonly', 'focused', 'checked', 'unchecked', 'inViewport', 'notInViewport',
  'attached', 'detached', 'visible', 'hidden', 'empty', 'stable',
]);
export type ElementState = z.infer<typeof ElementState>;

/**
 * Post-conditions are declarative and evaluated by the runner. They never
 * contain executable code (no eval), so journeys are safe to share.
 */
export const Condition = z.discriminatedUnion('type', [
  z.object({ type: z.literal('urlContains'), value: z.string() }),
  z.object({ type: z.literal('urlMatches'), pattern: z.string() }),
  z.object({ type: z.literal('titleContains'), value: z.string() }),
  z.object({ type: z.literal('visible'), target: Target }),
  z.object({ type: z.literal('hidden'), target: Target }),
  z.object({ type: z.literal('textContains'), target: Target, value: z.string() }),
  z.object({ type: z.literal('textEquals'), target: Target, value: z.string() }),
  z.object({ type: z.literal('valueEquals'), target: Target, value: z.string() }),
  z.object({ type: z.literal('count'), target: Target, equals: z.number().int().min(0) }),
  z.object({ type: z.literal('pageContainsText'), value: z.string() }),
  z.object({ type: z.literal('pageNotContainsText'), value: z.string() }),
  /** A value captured earlier must equal a literal or another captured value. */
  z.object({
    type: z.literal('ledgerEquals'),
    key: z.string(),
    expected: z.string().optional(),
    otherKey: z.string().optional(),
  }),
  z.object({ type: z.literal('apiStatus'), captureKey: z.string(), status: z.number().int() }),
  z.object({ type: z.literal('dbRowCount'), captureKey: z.string(), equals: z.number().int().min(0) }),
  z.object({ type: z.literal('downloadExists'), captureKey: z.string() }),
  // ---------------------------------------------------------- advanced (see docs/ez-language.md)
  /** An attribute of the element: exists, is absent, equals, contains or matches a value. */
  z.object({ type: z.literal('attribute'), target: Target, name: z.string().min(1), op: CompareOp.default('equals'), value: z.string().optional() }),
  /** A computed CSS property of the element equals a value. */
  z.object({ type: z.literal('css'), target: Target, property: z.string().min(1), value: z.string() }),
  /** A DOM state of the element. */
  z.object({ type: z.literal('state'), target: Target, state: ElementState }),
  z.object({ type: z.literal('hasClass'), target: Target, value: z.string().min(1), negate: z.boolean().optional() }),
  /** Count of matching elements compared with a number (or between value and max). */
  z.object({ type: z.literal('countCompare'), target: Target, op: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'between']), value: z.number().int().min(0), max: z.number().int().min(0).optional() }),
  /** Texts of all matching elements are in sorted order. */
  z.object({ type: z.literal('sorted'), target: Target, order: z.enum(['asc', 'desc']).default('asc'), numeric: z.boolean().optional(), column: z.string().optional() }),
  /** Element text (or value) matches a regular expression. */
  z.object({ type: z.literal('textMatches'), target: Target, pattern: z.string().min(1), flags: z.string().optional(), field: z.enum(['text', 'value']).optional() }),
  /** A safe expression (see expressions in docs) is truthy. Never evaluated as JavaScript. */
  z.object({ type: z.literal('expr'), expr: z.string().min(1) }),
  /** Number of open tabs/windows/popups. */
  z.object({ type: z.literal('tabCount'), op: z.enum(['eq', 'gt', 'gte', 'lt', 'lte']).default('eq'), value: z.number().int().min(0) }),
  /** A JavaScript dialog (alert/confirm/prompt/beforeunload) appeared, optionally containing text. */
  z.object({ type: z.literal('dialogSeen'), contains: z.string().optional(), kind: z.enum(['alert', 'confirm', 'prompt', 'beforeunload']).optional() }),
  /** Console messages of a level (error by default): at most `max` (0 = none) / at least `min`, optionally containing text. */
  z.object({ type: z.literal('console'), level: z.enum(['error', 'warning', 'info', 'log', 'debug', 'pageerror', 'any']).default('error'), contains: z.string().optional(), max: z.number().int().min(0).optional(), min: z.number().int().min(0).optional() }),
  /** A browser request was made matching a URL pattern (and optionally method, payload text, a header and status). */
  z.object({
    type: z.literal('request'), url: z.string().min(1), method: z.string().optional(), bodyContains: z.string().optional(),
    header: z.string().optional(), headerValue: z.string().optional(), status: z.number().int().optional(), negate: z.boolean().optional(),
  }),
  /** A WebSocket frame (from the page, or from a journey socket named `socket`) contained text. */
  z.object({ type: z.literal('wsMessage'), contains: z.string(), socket: z.string().optional() }),
  /** A captured API response (or any captured value) validates against a JSON Schema (inline or a file). */
  z.object({ type: z.literal('jsonSchema'), captureKey: z.string(), schema: z.record(z.string(), z.unknown()).optional(), schemaFile: z.string().optional() }),
  /** A JSONPath into a captured value compares to an expected value. */
  z.object({ type: z.literal('jsonPath'), captureKey: z.string(), path: z.string().min(1), op: CompareOp.default('equals'), value: z.string().optional() }),
  /** A captured API response took at most maxMs. */
  z.object({ type: z.literal('responseTime'), captureKey: z.string(), maxMs: z.number().int().positive() }),
  /** A captured download's name, type and size. */
  z.object({
    type: z.literal('download'), captureKey: z.string(), name: z.string().optional(), nameMatches: z.string().optional(),
    contentType: z.string().optional(), minBytes: z.number().int().min(0).optional(), maxBytes: z.number().int().min(0).optional(),
  }),
  /**
   * Locale-aware value of an element: its text parsed as a number, an amount (with currency) or a date
   * in `locale` (default the journey/run locale) equals `value` (a plain number / ISO date).
   */
  z.object({
    type: z.literal('localeValue'), target: Target, kind: z.enum(['number', 'currency', 'date']), value: z.string().min(1),
    locale: z.string().optional(), currency: z.string().optional(), tolerance: z.number().min(0).optional(),
  }),
  /** The page (or an element) is laid out right-to-left / left-to-right. */
  z.object({ type: z.literal('direction'), dir: z.enum(['rtl', 'ltr']), of: Target.optional() }),
  z.object({ type: z.literal('cookie'), name: z.string().min(1), op: CompareOp.default('exists'), value: z.string().optional() }),
  z.object({ type: z.literal('storage'), area: z.enum(['local', 'session']), key: z.string().min(1), op: CompareOp.default('exists'), value: z.string().optional() }),
  // ---------------------------------------------------------- assertion depth (see docs/ez-language.md#expectations)
  /** The element's accessible name, accessible description or ARIA role equals / contains / matches a value. */
  z.object({ type: z.literal('accessible'), target: Target, property: z.enum(['name', 'description', 'role']), op: z.enum(['equals', 'contains', 'matches', 'ne']).default('equals'), value: z.string() }),
  /**
   * The accessibility tree of an element (or the page) matches a YAML aria snapshot: inline (`snapshot`),
   * a file, or a named baseline in `.eztest/aria/<name>.aria.yml`. Partial: the snapshot's nodes must
   * appear in order; unnamed nodes match any name; `/regex/` names match by pattern.
   */
  z.object({ type: z.literal('ariaSnapshot'), target: Target.optional(), file: z.string().optional(), name: z.string().optional(), snapshot: z.string().optional() }),
  /** The element's text (or value) does not contain / does not equal a value. */
  z.object({ type: z.literal('textNot'), target: Target, value: z.string(), mode: z.enum(['contains', 'equals']).default('contains'), field: z.enum(['text', 'value']).default('text') }),
  /** The page title or the page text matches (or, negated, does not match) a regular expression. */
  z.object({ type: z.literal('pageMatches'), what: z.enum(['title', 'text']), pattern: z.string().min(1), flags: z.string().optional(), negate: z.boolean().optional() }),
  /** A captured API response conforms to an OpenAPI/Swagger spec (the file, or config api.spec), optionally a named operation. */
  z.object({ type: z.literal('apiContract'), captureKey: z.string(), spec: z.string().optional(), operation: z.string().optional() }),
]);
export type Condition = z.infer<typeof Condition>;

export const ActionType = z.enum([
  'navigate',
  'click',
  'dblclick',
  'fill',
  'clear',
  'select',
  'check',
  'uncheck',
  'press',
  'hover',
  'upload',
  'download',
  'wait',
  'assert',
  'capture',
  'api',
  'db',
  'login',
  'useData',
  'compareDocument',
  'custom',
  /**
   * A manual step (`Manual: <instruction>`): a human carries it out and records a verdict
   * (value: the instruction; args.expected: expected results; args.attachments: reference files).
   * See docs/manual-testing.md.
   */
  'manual',
  // -------------------------------------------- pages, frames, dialogs
  /** Tabs, windows and popups: args.op open | switch | close (see runner/pages.ts). */
  'tab',
  /** Frames: args.op enter | main | parent; with `steps` it is an "In the X frame" block. */
  'frame',
  /** Arm handling of the next dialog: args.op accept | dismiss | answer. */
  'dialog',
  // -------------------------------------------- input
  /** Keyboard: args.op down | up | type (slow typing) | insert. */
  'keyboard',
  /** Mouse: args.op move | down | up | wheel | clickAt. */
  'mouse',
  /** Drag `target` to `to` (or by args.offset); args.mode html5 forces the DnD event fallback. */
  'drag',
  /** Scroll: args.op page | element | intoView | untilVisible. */
  'scroll',
  /** Focus (args.op focus) or blur (args.op blur) an element. */
  'focus',
  /** Touch: args.op tap | swipe. */
  'touch',
  /** Dispatch a DOM event (value: event type, args.init: event init). */
  'dispatch',
  // -------------------------------------------- page data, scripts, network, browser state
  /** Declarative DOM query captured into the ledger (args.what attribute | property | css | box | count | texts | table | html | url | title | console | requests | dialogs). */
  'query',
  /** Run a page script (file or inline) in the browser page; gated by security.allowPageScripts. */
  'script',
  /** Network control: args.op mock | delay | abort | block | headers | unroute | offline | online | throttle | har | replayHar. */
  'network',
  /** Browser state: cookies, storage, permissions, geolocation, emulation, viewport, clipboard, auth, headers. */
  'browser',
  /** Email: fetch the latest message from the configured mail provider. */
  'email',
  /** SMS: fetch the latest message from the configured SMS provider. */
  'sms',
  /** Phone calls: args.op place | wait | expectSaid | expectDigits (configured voice provider). */
  'voice',
  /** WebSocket from the test: args.op connect | send | expect | close; GraphQL gql-subscribe | gql-event | gql-stop | gql-validate | gql-introspect. */
  'ws',
  /** Compare two captured datasets (DB rows, API body, UI table) by key. */
  'compareData',
  // -------------------------------------------- flow control and reuse
  /** Set a variable from a safe expression (value) or extract it (args.from + jsonPath/header/regex). */
  'set',
  /** `steps` when flow.condition/expr holds, otherwise `else`. */
  'if',
  /** `steps` flow.times times. */
  'repeat',
  /** `steps` for each item of flow.items (an expression) or each row of flow.data (csv, xlsx, json). */
  'forEach',
  /** `steps` while flow.condition/expr holds, at most flow.maxIterations times. */
  'while',
  /** `steps` until they all pass, at most flow.attempts times. */
  'retry',
  /** `steps`; on failure run `catch`. */
  'try',
  /** A named group of steps. */
  'group',
  /** Run another journey (value: id, name or file) with args as parameters. */
  'runJourney',
  // -------------------------------------------- integration (see docs/messaging.md, docs/api-contracts.md)
  /** Message buses, gRPC, SFTP/folder files, SSH, batch jobs, EDI and contract sessions: args.kind + args.op. */
  'integration',
  // -------------------------------------------- complex widgets (src/runner/components)
  /** A component-adapter operation: args.widget (grid, combobox, datepicker, ...) and args.op; target is the widget. */
  'component',
  /** Run a TypeScript code step (value: "file#export", args: parameters); see docs/sdk.md. */
  'code',
  // -------------------------------------------- native mobile (EZTest device agents; see docs/mobile.md)
  /** Device and app operations: args.op longPress | pinch | swipeUntil | rotate | home | back | background | deepLink | context | ... */
  'mobile',
  // -------------------------------------------- multi-actor journeys (see docs/multi-actor.md)
  /**
   * An actor (value: its name) acts: with `steps` it is an "As manager:" block (the steps run in that
   * actor's own browser context and session); without, it is "Switch to user "bob"" and the
   * following steps of the same list run as that actor.
   */
  'actor',
  /** "In parallel:": the child steps (usually As blocks of different actors) run at the same time. */
  'parallel',
  // -------------------------------------------- shared test data (see docs/shared-data.md)
  /** Shared store and data pools: args.op save | load | delete | poolAdd | poolTake | poolCount | poolSeed (src/store). */
  'store',
]);
export type ActionType = z.infer<typeof ActionType>;

export const ApiCall = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET'),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
  /** Identity Vault role whose token authorises the call. */
  asRole: z.string().optional(),
  /** Query string parameters (values support ${var}). */
  query: z.record(z.string(), z.string()).optional(),
  /** application/x-www-form-urlencoded body. */
  form: z.record(z.string(), z.string()).optional(),
  /** multipart/form-data body; a value "@path" attaches that file. */
  multipart: z.record(z.string(), z.string()).optional(),
  /** Send this file's content as the body. */
  bodyFile: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  /** Present the named TLS client certificate (config api.clientCertificates[].name). */
  clientCertificate: z.string().min(1).optional(),
  /** A GraphQL operation sent as a POST to `url`. */
  graphql: z.object({ query: z.string().min(1), variables: z.record(z.string(), z.unknown()).optional(), operationName: z.string().optional() }).optional(),
  /** A SOAP call: the body XML is wrapped in an envelope and POSTed to `url`. */
  soap: z.object({ action: z.string().optional(), version: z.enum(['1.1', '1.2']).optional(), body: z.string().min(1) }).optional(),
});
export type ApiCall = z.infer<typeof ApiCall>;

export const DbQuery = z.object({
  /** Connection name (db.connections). Empty for a catalogue query means the query's "-- connection:" header. */
  connection: z.string(),
  /** Inline SQL (empty when `query` or `procedure` is used). */
  sql: z.string().default(''),
  params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  /** What to keep: all rows (default), the first row, the first cell, or the row count. */
  capture: z.enum(['rows', 'row', 'cell', 'count']).optional(),
  /** Call this stored procedure (with `params`) instead of running `sql`. */
  procedure: z.string().regex(/^[A-Za-z_][\w.]*$/).optional(),
  /** Run this named query from the catalogue (db.queries) instead of `sql`. */
  query: z.string().regex(/^[A-Za-z_][\w.-]*$/).optional(),
  /** Values for the named query's :binds. Strings support ${var}; a lone "${var}" keeps the variable's type. Always bound, never spliced. */
  binds: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  /** OUT parameters of `procedure` (after the IN `params`); the step captures them as one record. */
  out: z.array(z.object({ name: z.string().regex(/^[A-Za-z_]\w*$/), type: z.enum(['string', 'number', 'date', 'clob', 'cursor', 'boolean']).default('string') })).optional(),
});
export type DbQuery = z.infer<typeof DbQuery>;

/** Source location of a step created by code (eztest/sdk). */
export const StepSource = z.object({ file: z.string().min(1), line: z.number().int().min(1), column: z.number().int().min(0).optional() });
export type StepSource = z.infer<typeof StepSource>;

/** A code journey: a `journey()` registered by a TypeScript module (see docs/sdk.md). */
export const CodeRef = z.object({
  /** Absolute path of the module that registers the journey. */
  file: z.string().min(1),
  /** The registered journey name (unique within the module). */
  name: z.string().min(1),
  /** Line of the journey() call. */
  line: z.number().int().min(1).optional(),
});
export type CodeRef = z.infer<typeof CodeRef>;

/** Parameters of flow-control steps (if, repeat, forEach, while, retry). Declarative; nothing is evaluated as code. */
export const FlowSpec = z.object({
  /** if/while: a declarative condition. */
  condition: Condition.optional(),
  /** if/while: a safe expression, e.g. "${count} < 3" (see expressions in docs). */
  expr: z.string().optional(),
  /** if/while: invert the condition ("unless", "until"). */
  negate: z.boolean().optional(),
  /** repeat: how many times (a number or a "${var}"). */
  times: z.union([z.number().int().min(0), z.string()]).optional(),
  /** forEach: an expression yielding a list, e.g. "${orders.body}". */
  items: z.string().optional(),
  /** forEach: a data file (csv, xlsx, json) whose rows are iterated. */
  data: z.string().optional(),
  /** forEach over xlsx: sheet name. */
  sheet: z.string().optional(),
  /** forEach: variable name for the current item (default "item", or "row" for data files). */
  as: z.string().optional(),
  /** while: safety cap (default 100); exceeding it fails the step. */
  maxIterations: z.number().int().positive().optional(),
  /** retry: attempts (default 3). */
  attempts: z.number().int().positive().optional(),
  /** retry/while: pause between iterations. */
  delayMs: z.number().int().min(0).optional(),
});
export type FlowSpec = z.infer<typeof FlowSpec>;

export const Step = z.object({
  id: z.string().min(1),
  /** The plain-English intent, e.g. 'Click the "Sign in" button'. */
  intent: z.string().min(1),
  action: ActionType,
  target: Target.optional(),
  /** Value to type/select/press, URL to open, wait duration, etc. Supports ${var} interpolation. */
  value: z.string().optional(),
  /** Key under which this step stores what it read (capture/api/db/download). */
  captureAs: z.string().optional(),
  api: ApiCall.optional(),
  db: DbQuery.optional(),
  /** Name of a registered custom step handler for action "custom". */
  handler: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  postconditions: z.array(Condition).default([]),
  optional: z.boolean().default(false),
  timeoutMs: z.number().int().positive().optional(),
  /** Risk weight 1 (low) .. 5 (critical), used by readiness and impact ranking. */
  risk: z.number().int().min(1).max(5).optional(),
  /** Soft assertion: a failure is recorded, the journey continues, and the journey still fails at the end. */
  soft: z.boolean().optional(),
  /** Re-run the action until its post-conditions hold ("retry until"), e.g. polling an API or a query. */
  poll: z.object({ attempts: z.number().int().min(1).max(10_000).optional(), intervalMs: z.number().int().min(0).optional() }).optional(),
  /** Second element of a two-element action (drag destination). */
  to: Target.optional(),
  /** Flow-control parameters for if/repeat/forEach/while/retry. */
  flow: FlowSpec.optional(),
  /** Where a step created by code (the TypeScript SDK) was called from: debugger line breakpoints and reports use it. */
  source: StepSource.optional(),
  /** Child steps of a block (if-then branch, loop body, try body, frame block, group). */
  get steps(): z.ZodOptional<z.ZodArray<typeof Step>> {
    return z.array(Step).optional();
  },
  /** "Otherwise" branch of an if. */
  get else(): z.ZodOptional<z.ZodArray<typeof Step>> {
    return z.array(Step).optional();
  },
  /** "On failure" branch of a try. */
  get catch(): z.ZodOptional<z.ZodArray<typeof Step>> {
    return z.array(Step).optional();
  },
});
export type Step = z.infer<typeof Step>;
export type StepInput = z.input<typeof Step>;

export const DataNeed = z.object({
  /** Alias the journey uses, e.g. "customer". */
  as: z.string(),
  /** Entity type, e.g. "Customer". */
  entity: z.string(),
  /** Simple constraints, e.g. { region: "EU", creditLimit: ">10000" }. */
  where: z.record(z.string(), z.string()).default({}),
  /** Prefer reusing an existing record over creating one. */
  strategy: z.enum(['find', 'create', 'generate', 'find-or-create']).default('find-or-create'),
});
export type DataNeed = z.infer<typeof DataNeed>;

/**
 * A data-state precondition (`Requires:`): checked before the journey runs. When one does not
 * hold the journey is reported as a data problem, not a product failure.
 */
export const Precondition = z.discriminatedUnion('kind', [
  /** A SQL query on a connection returns at least `min` rows. ${var} are bound, never spliced. */
  z.object({ kind: z.literal('db'), connection: z.string().min(1), sql: z.string().min(1), min: z.number().int().min(0).default(1), text: z.string().optional() }),
  /** A named catalogue query returns at least `min` rows. */
  z.object({ kind: z.literal('query'), name: z.string().min(1), connection: z.string().default(''), min: z.number().int().min(0).default(1), text: z.string().optional() }),
  /** An API call returns `status`. */
  z.object({ kind: z.literal('api'), method: z.enum(['GET', 'HEAD', 'POST']).default('GET'), url: z.string().min(1), status: z.number().int().default(200), asRole: z.string().optional(), text: z.string().optional() }),
  /** The data fabric can find (not create) an entity matching `where`; it is leased and lands in the ledger under `as`. */
  z.object({ kind: z.literal('data'), entity: z.string().min(1), as: z.string().optional(), where: z.record(z.string(), z.string()).default({}), text: z.string().optional() }),
  /** A variable (e.g. a configured secret) is set and not empty. */
  z.object({ kind: z.literal('variable'), name: z.string().min(1), text: z.string().optional() }),
  /** A safe expression is truthy. */
  z.object({ kind: z.literal('expr'), expr: z.string().min(1), text: z.string().optional() }),
]);
export type Precondition = z.infer<typeof Precondition>;

/** `Depends on:` a prerequisite journey (id or name), taking ledger values from it. */
export const Dependency = z.object({
  journey: z.string().min(1),
  /** Ledger keys of the prerequisite handed to this journey (default: the prerequisite's Returns:). */
  take: z.array(z.string().min(1)).default([]),
});
export type Dependency = z.infer<typeof Dependency>;

/** Browser context options applied when a journey's context is created. */
export const Emulation = z.object({
  /** A device name from the EZTest device list, e.g. "iPhone 13" or "Pixel 7". */
  device: z.string().optional(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  locale: z.string().optional(),
  timezoneId: z.string().optional(),
  colorScheme: z.enum(['light', 'dark', 'no-preference']).optional(),
  reducedMotion: z.enum(['reduce', 'no-preference']).optional(),
  geolocation: z.object({ latitude: z.number(), longitude: z.number(), accuracy: z.number().optional() }).optional(),
  permissions: z.array(z.string()).optional(),
  userAgent: z.string().optional(),
  extraHTTPHeaders: z.record(z.string(), z.string()).optional(),
  /** HTTP basic auth; values support ${var} (e.g. secrets from variables). */
  httpCredentials: z.object({ username: z.string(), password: z.string() }).optional(),
  offline: z.boolean().optional(),
  hasTouch: z.boolean().optional(),
  isMobile: z.boolean().optional(),
});
export type Emulation = z.infer<typeof Emulation>;

/** Where a journey runs: a browser (default) or a native app through a platform driver (EZTest's Android/iOS agents). */
export const Platform = z.enum(['web', 'android', 'ios']);
export type Platform = z.infer<typeof Platform>;

/**
 * One actor of a multi-actor journey (`Actors:` header / `actors:`): a user with their own browser
 * context, session and identity, or a native-app user through a platform driver (docs/multi-actor.md).
 */
export const Actor = z.object({
  /** Identity Vault role the actor signs in as when it first acts (needs a login handler). */
  role: z.string().min(1).optional(),
  /** web (default): an isolated browser context; android / ios: the actor's blocks run on that platform's driver. */
  platform: Platform.optional(),
  /** Native app of an android / ios actor (package / bundle id or a file to install). */
  app: z.string().min(1).optional(),
  /** Launch settings of an android / ios actor (serial, udid, ...). */
  capabilities: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** Context emulation of a web actor, over the journey's own (device, locale, viewport, ...). */
  emulation: Emulation.optional(),
});
export type Actor = z.infer<typeof Actor>;

/** A Gherkin scenario run natively (`.feature` files, see docs/bdd.md): where it comes from and how its steps bind. */
export const BddMeta = z.object({
  /** Absolute path of the feature file. */
  uri: z.string().min(1),
  language: z.string().default('en'),
  feature: z.object({ keyword: z.string(), name: z.string(), line: z.number().int(), tags: z.array(z.string()).default([]), description: z.string().optional() }),
  rule: z.object({ keyword: z.string(), name: z.string(), line: z.number().int(), tags: z.array(z.string()).default([]) }).optional(),
  scenario: z.object({ keyword: z.string(), name: z.string(), line: z.number().int(), tags: z.array(z.string()).default([]), outline: z.boolean().default(false) }),
  /** Outlines: the Examples block, and the row this journey runs (inline tables). */
  examples: z.object({
    keyword: z.string(), name: z.string(), line: z.number().int(), tags: z.array(z.string()).default([]), index: z.number().int(),
    row: z.object({ line: z.number().int(), index: z.number().int() }).optional(),
  }).optional(),
  /** Step definition files (absolute), loaded when the scenario runs. */
  glue: z.array(z.string()).default([]),
  /** Steps without a definition may run as EZTest plain-English steps. */
  fallback: z.boolean().default(true),
  worldParameters: z.record(z.string(), z.unknown()).optional(),
});
export type BddMeta = z.infer<typeof BddMeta>;

export const Journey = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  /** Identity Vault role the journey runs as. */
  role: z.string().optional(),
  baseUrl: z.string().optional(),
  data: z.array(DataNeed).default([]),
  variables: z.record(z.string(), z.string()).default({}),
  steps: z.array(Step).min(1),
  /** Requirement / work-item ids for traceability. */
  requirements: z.array(z.string()).default([]),
  risk: z.number().int().min(1).max(5).default(3),
  /**
   * `Type:` header: automated (default), manual (only `Manual:` steps, run by a tester in Studio) or
   * hybrid (automated steps that pause at `Manual:` steps for a verdict). Inferred when absent.
   */
  type: z.enum(['automated', 'manual', 'hybrid']).optional(),
  /** `Assignee:` header: the tester a manual or hybrid case is assigned to. */
  assignee: z.string().min(1).optional(),
  /** `Preconditions:` header: what must be true before a tester starts the case. */
  preconditions: z.string().min(1).optional(),
  /**
   * Resource locks: keys of shared entities this journey touches (e.g. "account-123").
   * Journeys sharing a key never run at the same time, across workers and shards.
   * `<column>` and `${var}` are filled from the journey's variables (Examples rows).
   */
  locks: z.array(z.string().min(1)).optional(),
  /** Lenses applied to every step (accessibility, visual, perf budgets...). */
  lenses: z.array(z.string()).default([]),
  /** Browser context emulation for this journey (device, locale, timezone, ...). */
  emulation: Emulation.optional(),
  /** Target platform (`Platform:` header). Default: web (or the run's default platform). */
  platform: Platform.optional(),
  /**
   * Actors of a multi-actor journey, by name (`Actors:` header). Actors used in `As <name>:` blocks
   * without a declaration are plain web users. See docs/multi-actor.md.
   */
  actors: z.record(z.string().regex(/^[A-Za-z_][\w.-]*$/), Actor).optional(),
  /**
   * Browsers this journey runs on in a cross-browser run (`Browsers:` header), e.g. ["chromium"] for a
   * Chrome-only feature. Default: every browser of the run.
   */
  browsers: z.array(z.string().min(1)).optional(),
  /** Set by the run plan on one journey x browser unit of a cross-browser run (the id then ends in `@<browser>`). */
  browser: z.string().min(1).optional(),
  /**
   * Browser clock at the start (`Clock:` header): `2026-12-31T23:59 Europe/London` (flowing),
   * `paused 2027-01-01 08:00` or `fixed 2027-01-01` (Date frozen). See docs/ez-language.md#clock-and-time.
   */
  clock: z.string().min(1).optional(),
  /** Single component story this journey runs against (`Story:` header); opened on the harness before the first step. */
  story: z.object({ id: z.string().min(1) }).optional(),
  /** Native app under test (`App:` header): a file path (.apk/.app/.ipa) to install, or an installed package / bundle id. */
  app: z.string().min(1).optional(),
  /** Extra launch settings for this journey (`Capabilities:` header), e.g. serial, udid, activity, locale; see docs/mobile.md. */
  capabilities: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** Parameters a caller passes with "Run journey ... with k=v" (required unless given a default in variables). */
  params: z.array(z.string()).optional(),
  /** Ledger keys handed back to a caller of "Run journey". */
  returns: z.array(z.string()).optional(),
  /** Examples table: the journey runs once per row, with the row's values as variables and <column> placeholders replaced. */
  examples: z.array(z.record(z.string(), z.string())).optional(),
  /** Loader/spinner selectors waited out before every action and post-condition (added to config waits.loaders). */
  loaders: z.array(z.string().min(1)).optional(),
  /** Data-state preconditions checked before the journey runs (`Requires:`). */
  requires: z.array(Precondition).optional(),
  /** Prerequisite journeys that must pass first, with explicit ledger handoff (`Depends on:`). */
  dependsOn: z.array(Dependency).optional(),
  /**
   * Desktop app journey (`App: electron path/to/main.js`): the runner launches the Electron app and
   * drives its windows with the normal web phrasings (see docs/desktop-and-legacy.md).
   */
  electron: z.object({
    /** Main script or app directory (relative to the project), or a packaged executable when `executable` is set. */
    app: z.string().min(1),
    args: z.array(z.string()).optional(),
    /** Electron binary (default: the `electron` package, or config desktop.electron.executablePath). */
    executable: z.string().optional(),
  }).optional(),
  /**
   * External Examples source: rows come from a data file (json, csv, xlsx) or a named query at run time,
   * optionally filtered (`where`). Rows are expanded into journeys like an inline Examples table.
   */
  /** Set for code journeys (TypeScript, eztest/sdk): the runner calls the registered function instead of walking `steps`. */
  code: CodeRef.optional(),
  /** Set for Gherkin scenarios (`.feature` files): the runner binds each step to a step definition or an EZTest phrasing. */
  bdd: BddMeta.optional(),
  /** A Gherkin BeforeAll / AfterAll hook run as a journey of its own (src/runner/bdd-all.ts). */
  bddAll: z.object({
    kind: z.enum(['beforeAll', 'afterAll']),
    /** The hook's id (`beforeAll:<file>:<line>`). */
    hook: z.string().min(1),
    glue: z.array(z.string()).default([]),
    worldParameters: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  examplesFrom: z.object({
    from: z.string().optional(),
    query: z.string().optional(),
    connection: z.string().optional(),
    params: z.record(z.string(), z.string()).optional(),
    path: z.string().optional(),
    sheet: z.string().optional(),
    where: z.string().optional(),
  }).optional(),
});
export type Journey = z.infer<typeof Journey>;
export type JourneyInput = z.input<typeof Journey>;

export function parseJourney(input: unknown): Journey {
  return Journey.parse(input);
}

export function safeParseJourney(input: unknown) {
  return Journey.safeParse(input);
}
