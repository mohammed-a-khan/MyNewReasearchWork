/**
 * GraphQL: the document parser, validation against an introspected schema,
 * subscriptions over graphql-transport-ws (on EZTest's WebSocket client),
 * and the steps and SDK, against a local GraphQL server
 * (test/support/graphql-server.ts) that checks bearer tokens from the
 * identity vault.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { ApiClient, GraphQLClient, GraphQLSyntaxError, GraphQLWsClient, formatGraphQLErrors, parseGraphQL, validateGraphQL } from '../../src/surfaces/index.js';
import { loadConfig } from '../../src/config/index.js';
import { createEngine } from '../../src/engine/index.js';
import { flattenStepResults, type JourneyResult, type RunResult } from '../../src/core/index.js';
import { parseEzScript, stepToText } from '../../src/intent/index.js';
import { buildProgram } from '../../src/cli/index.js';
import { startMockOidc, type MockOidc } from '../server/mock-oidc.js';
import { TEST_SCHEMA, startGraphQLServer, type TestGraphQLServer } from '../support/graphql-server.js';

const v = (doc: string) => formatGraphQLErrors(validateGraphQL(doc, TEST_SCHEMA));

describe('GraphQL documents: parser', () => {
  it('parses operations, variables with defaults, fragments, inline fragments, directives, aliases and block strings', () => {
    const d = parseGraphQL(`
      # a comment
      query Orders($status: Status = PAID, $first: Int = 5, $withLines: Boolean!) {
        recent: orders(status: $status, first: $first) { ...OrderBits lines @include(if: $withLines) { sku qty } }
        search(term: """
          multi
          line
        """) { __typename ... on Customer { name } }
      }
      fragment OrderBits on Order { id status total }
    `);
    expect(d.definitions.map((x) => x.kind)).toEqual(['operation', 'fragment']);
    const op = d.definitions[0] as Extract<(typeof d.definitions)[0], { kind: 'operation' }>;
    expect(op.variables.map((x) => x.name)).toEqual(['status', 'first', 'withLines']);
    const f = op.selections[0] as { alias?: string; name: string };
    expect([f.alias, f.name]).toEqual(['recent', 'orders']);
    const search = op.selections[1] as { args: Array<{ value: { value: string } }> };
    expect(search.args[0].value.value).toBe('multi\nline');
  });

  it('reports syntax errors with line and column', () => {
    expect(() => parseGraphQL('{ orders { id ')).toThrow(GraphQLSyntaxError);
    expect(() => parseGraphQL('{ orders { id ')).toThrow(/1:15: unterminated selection set/);
    expect(() => parseGraphQL('query {\n  order(id: ) { id }\n}')).toThrow(/2:13: expected a value, found "\)"/);
    expect(() => parseGraphQL('type Order { id: ID }')).toThrow(/type system definitions are not executable/);
    expect(() => parseGraphQL('{ a(x: "unterminated) }')).toThrow(/unterminated string/);
  });
});

describe('GraphQL documents: validation against the schema', () => {
  it('accepts valid documents', () => {
    expect(v('{ orders { id status lines { sku qty } customer { name } } }')).toEqual([]);
    expect(v('query ($id: ID!) { order(id: $id) { ...F } } fragment F on Order { id total placedAt }')).toEqual([]);
    expect(v('{ search(term: "x") { __typename ... on Order { id } ... on Customer { name } } node(id: 1) { id ... on Order { status } } }')).toEqual([]);
    expect(v('mutation { placeOrder(input: { customerId: "c1", lines: [{ sku: "A" }] }) { id } }')).toEqual([]);
    expect(v('subscription ($id: ID!) { orderUpdated(id: $id) { status } }')).toEqual([]);
    expect(v('{ __schema { queryType { name } } }')).toEqual([]);
  });

  it('fields: unknown (with a suggestion), on unions, leaf with selection, object without selection', () => {
    expect(v('{ orders { id statsu } }')).toEqual(['1:15 Cannot query field "statsu" on type Order (did you mean "status"?).']);
    expect(v('{ search(term: "x") { id } }')).toEqual(['1:23 Cannot query field "id" on union SearchResult: select it inside "... on <Type>" (members: Order, Customer).']);
    expect(v('{ orders { id { x } } }')).toEqual(['1:12 Field "id" is of type ID! and cannot have a selection.']);
    expect(v('{ orders }')).toEqual(['1:3 Field "orders" of type [Order!]! needs a selection of subfields, e.g. "orders { ... }".']);
  });

  it('arguments: unknown, required, repeated, and literal values of the wrong kind', () => {
    expect(v('{ order { id } }')).toEqual(['1:3 Field "Query.order" needs argument "id" of type ID!.']);
    expect(v('{ order(id: 1, colour: RED) { id } }')).toEqual(['1:16 Unknown argument "colour" on field "Query.order".']);
    expect(v('{ orders(status: LOST) { id } }')).toEqual(['1:18 Argument "status" of field "Query.orders": "LOST" is not a value of enum Status (NEW, PAID, SHIPPED).']);
    expect(v('{ orders(first: "ten") { id } }')).toEqual(['1:17 Argument "first" of field "Query.orders" expects a value of type Int, not string "ten".']);
    expect(v('{ orders(first: 3000000000) { id } }')).toEqual(['1:17 Argument "first" of field "Query.orders": 3000000000 is outside the 32-bit Int range.']);
    expect(v('{ order(id: 1, id: 2) { id } }')).toEqual(['1:16 Argument "id" of field "Query.order" is given twice.']);
    expect(v('mutation { placeOrder(input: { lines: [{ qty: 2 }], extra: 1 }) { id } }')).toEqual([
      '1:40 Argument "input" of field "Mutation.placeOrder".lines: input field LineInput.sku of type String! is required.',
      '1:53 Argument "input" of field "Mutation.placeOrder": input type OrderInput has no field "extra".',
      '1:30 Argument "input" of field "Mutation.placeOrder": input field OrderInput.customerId of type ID! is required.',
    ]);
  });

  it('variables: undefined, unused, output types, nullable where required', () => {
    expect(v('query { order(id: $id) { id } }')).toEqual(['1:19 Variable "$id" is not defined by the operation.']);
    expect(v('query Q($x: Int) { orders { id } }')).toEqual(['1:9 Variable "$x" is never used in operation "Q".']);
    expect(v('query ($o: Order) { order(id: 1) { id } }')).toEqual(['1:8 Variable "$o" cannot be of the output type "Order".', '1:8 Variable "$o" is never used in the operation.']);
    expect(v('query ($id: ID) { order(id: $id) { id } }')).toEqual(['1:29 Variable "$id" of type ID is used where ID! is required.']);
    expect(v('query ($id: ID = "7") { order(id: $id) { id } }')).toEqual([]);
    expect(v('query ($s: String) { orders(status: $s) { id } }')).toEqual(['1:37 Variable "$s" of type String is used where Status is expected.']);
  });

  it('fragments, directives, operations', () => {
    expect(v('{ orders { ...Missing } }')).toEqual(['1:12 Unknown fragment "Missing".']);
    expect(v('{ orders { id } } fragment Unused on Order { id }')).toEqual(['1:19 Fragment "Unused" is never used.']);
    expect(v('{ orders { ...C } } fragment C on Customer { name }')).toEqual(['1:12 Fragment "C" (on "Customer") can never apply inside "Order".']);
    expect(v('{ orders { ...A } } fragment A on Order { ...B } fragment B on Order { ...A }')).toEqual(['1:72 Fragment "A" spreads itself (A -> B -> A).']);
    expect(v('{ orders { id @include } }')).toEqual(['1:15 Directive "@include" needs argument "if" of type Boolean!.']);
    expect(v('{ orders { id @cached } }')).toEqual(['1:15 Unknown directive "@cached".']);
    expect(v('subscription { orderUpdated(id: 1) { id } ticks }')).toEqual(['1:1 Subscription must select exactly one root field.']);
    expect(v('query A { orders { id } } query A { orders { id } }')).toEqual(['1:1 There can be only one operation named "A".']);
    expect(v('{ orders { id } } query B { orders { id } }')).toEqual(['1:1 An anonymous operation must be the only operation in the document.']);
    expect(v('{ orders { id ')).toEqual(['1:15 Syntax error: unterminated selection set']);
  });
});

describe('GraphQL over HTTP and WebSocket (local server)', () => {
  let gql: TestGraphQLServer;
  beforeAll(async () => {
    gql = await startGraphQLServer({ token: 'tok-1' });
  });
  afterAll(() => gql.close());

  it('introspects the schema and validates documents against it', async () => {
    const c = new GraphQLClient(new ApiClient({ headers: { authorization: 'Bearer tok-1' } }), gql.url);
    const schema = await c.introspect();
    expect(schema.subscriptionType?.name).toBe('Subscription');
    expect(await c.validate('{ orders { id } }')).toEqual([]);
    expect(formatGraphQLErrors(await c.validate('{ orders { idd } }'))).toEqual(['1:12 Cannot query field "idd" on type Order (did you mean "id"?).']);
    expect(gql.posted.filter((p) => /__schema/.test(p.query))).toHaveLength(1); // cached
    const closed = await startGraphQLServer({ introspection: false });
    try {
      await expect(new GraphQLClient(new ApiClient({}), closed.url).introspect()).rejects.toThrow(/introspection of .* failed \(is introspection disabled on the server\?\): GraphQL errors: GraphQL introspection is not allowed/);
    } finally {
      await closed.close();
    }
  });

  it('subscribes over graphql-transport-ws: init with the token, ack, events, ping/pong, complete', async () => {
    const c = await GraphQLWsClient.connect(gql.wsUrl, { connectionParams: { authorization: 'Bearer tok-1' } });
    const sub = c.subscribe('subscription ($id: ID!) { orderUpdated(id: $id) { id status } }', { id: '7' });
    await new Promise((r) => setTimeout(r, 50));
    gql.emit('7', 'PAID');
    gql.emit('7', 'SHIPPED');
    const shipped = await sub.next((e) => (e.data as { orderUpdated: { status: string } }).orderUpdated.status === 'SHIPPED', 2000);
    expect(shipped?.data).toEqual({ orderUpdated: { id: '7', status: 'SHIPPED' } });
    expect((await sub.next(() => true, 100))?.data).toEqual({ orderUpdated: { id: '7', status: 'PAID' } }); // earlier event still buffered
    const ticks = c.subscribe('subscription { ticks }');
    await new Promise((r) => setTimeout(r, 100));
    expect(ticks.events.map((e) => (e.data as { ticks: number }).ticks)).toEqual([1, 2, 3]);
    expect(ticks.completed).toBe(true);
    const bad = c.subscribe('subscription { nosuchfield }');
    expect(await bad.next(() => true, 1000)).toBeUndefined();
    expect(bad.error?.[0].message).toMatch(/Cannot query field "nosuchfield"/);
    sub.unsubscribe();
    await new Promise((r) => setTimeout(r, 50));
    // The server pinged after the ack; the client answered (whenever it got to it).
    expect(gql.received.map((m) => m.type).filter((t) => t !== 'pong')).toEqual(['connection_init', 'subscribe', 'subscribe', 'subscribe', 'complete']);
    expect(gql.received.filter((m) => m.type === 'pong')).toHaveLength(1);
    expect(gql.received[0]).toEqual({ type: 'connection_init', payload: { authorization: 'Bearer tok-1' } });
    await c.close();
  });

  it('a refused connection_init is reported with the protocol close code', async () => {
    await expect(GraphQLWsClient.connect(gql.wsUrl, { connectionParams: { authorization: 'Bearer wrong' } })).rejects.toMatchObject({ code: 'GRAPHQL_WS_FORBIDDEN', message: expect.stringMatching(/no connection_ack - the server closed the connection \(code 4403: Forbidden\)/) });
  });
});

describe('GraphQL steps and SDK (identity vault role)', () => {
  let gql: TestGraphQLServer;
  let idp: MockOidc;
  let dir: string;
  beforeAll(async () => {
    idp = await startMockOidc({ sub: 'x' });
    idp.registerClient('orders-ui', { secret: 'orders-secret' });
    // The server accepts exactly the token the vault gets for the role: fetch it once to learn it.
    gql = await startGraphQLServer();
    dir = await mkdtemp(join(tmpdir(), 'eztest-gql-'));
    await writeFile(join(dir, 'eztest.config.yaml'), toYaml({
      outputDir: 'eztest-results', journeysDir: 'journeys', healing: { enabled: false }, reporters: ['json'],
      identity: { roles: { manager: { api: { tokenUrl: `${idp.issuer}/token`, clientId: 'orders-ui', clientSecret: 'orders-secret' } } } },
    }));
  });
  afterAll(async () => {
    await gql?.close();
    await idp?.close();
  });

  it('parses and renders the steps', () => {
    const j = parseEzScript(`Journey: g
Subscribe to GraphQL "subscription ($id: ID!) { orderUpdated(id: $id) { status } }" at /graphql as updates using role manager with variables '{"id":"7"}'
Wait for a GraphQL event on updates where "$.data.orderUpdated.status" = "SHIPPED" within 10 s and store it as shipped
Stop GraphQL subscription updates
Validate GraphQL query "{ orders { id } }" against the schema of /graphql as manager
Introspect the GraphQL schema at /graphql and store it as schema
`);
    expect(j.steps.map((s) => s.args?.op)).toEqual(['gql-subscribe', 'gql-event', 'gql-stop', 'gql-validate', 'gql-introspect']);
    expect(j.steps[1].args).toMatchObject({ filters: [{ path: '$.data.orderUpdated.status', op: '=', value: 'SHIPPED' }], timeoutMs: 10_000 });
    for (const s of j.steps) expect(parseEzScript(`Journey: r\n${stepToText(s)}\n`).steps[0]).toMatchObject({ action: s.action, args: s.args, ...(s.captureAs ? { captureAs: s.captureAs } : {}) });
  });

  async function runEz(ez: string): Promise<JourneyResult> {
    const loaded = await loadConfig({ cwd: dir, environment: {} });
    const engine = await createEngine(loaded, { cwd: dir });
    try {
      return (await engine.run([parseEzScript(ez)])).journeys[0];
    } finally {
      await engine.close();
    }
  }

  it('a journey subscribes with the role token, waits for a matching event, validates and introspects', async () => {
    const timer = setInterval(() => gql.emit('7', 'SHIPPED'), 200);
    try {
      const j = await runEz(`Journey: Order updates
Subscribe to GraphQL "subscription ($id: ID!) { orderUpdated(id: $id) { id status } }" at "${gql.wsUrl}" as updates using role manager with variables '{"id":"7"}'
Wait for a GraphQL event on updates where "$.data.orderUpdated.status" = "SHIPPED" within 10 s and store it as shipped
Expect \${shipped.data.orderUpdated.id} equals "7"
Stop GraphQL subscription updates
Validate GraphQL query "query ($id: ID!) { order(id: $id) { id status total } }" against the schema of "${gql.url}" as manager
Introspect the GraphQL schema at "${gql.url}" as manager and store it as schema
Expect \${schema.subscriptionType} equals "Subscription"
`);
      expect(j.status, flattenStepResults(j.steps).map(({ result: s }) => `${s.intent}: ${s.status} ${s.error?.message ?? ''}`).join('\n')).toBe('passed');
      const init = gql.received.find((m) => m.type === 'connection_init') as { payload: { authorization: string } };
      expect(init.payload.authorization).toMatch(/^Bearer eyJ/); // the vault's client-credentials token
      expect(gql.posted.every((p) => p.auth === init.payload.authorization)).toBe(true);
    } finally {
      clearInterval(timer);
    }
  }, 60_000);

  it('an invalid document fails the step with every problem and its location', async () => {
    const j = await runEz(`Journey: Bad query
Validate GraphQL query "{ orders(status: LOST) { id customer } }" against the schema of "${gql.url}"
`);
    const s = flattenStepResults(j.steps)[0].result;
    expect(s.status).toBe('failed');
    expect(s.error?.message).toContain('1:18 Argument "status" of field "Query.orders": "LOST" is not a value of enum Status');
    expect(s.error?.message).toContain('1:29 Field "customer" of type Customer needs a selection of subfields');
  }, 60_000);

  it('the SDK: graphql.query, validate, introspect, subscribe / next / stop in a code journey', async () => {
    await mkdir(join(dir, 'journeys'), { recursive: true });
    await writeFile(join(dir, 'journeys', 'gql.journey.ts'), `import { journey, graphql, expect } from 'eztest/sdk';
journey('GraphQL from code', { id: 'gql-sdk' }, async () => {
  const data = await graphql.query<{ orders: Array<{ id: string; status: string }> }>('${gql.url}', '{ orders { id status } }', {}, { asRole: 'manager' });
  await expect(data.orders[0].status).toBe('PAID');
  await graphql.validate('${gql.url}', '{ orders { id } }', { asRole: 'manager' });
  const schema = await graphql.introspect('${gql.url}');
  await expect(schema.types).toContain('Order');
  const updates = await graphql.subscribe('${gql.wsUrl}', 'subscription { orderUpdated(id: "9") { id status } }', { asRole: 'manager' });
  const ev = await updates.next({ '$.data.orderUpdated.status': 'SHIPPED' }, { timeoutMs: 10000 });
  await expect((ev.data as { orderUpdated: { id: string } }).orderUpdated.id).toBe('9');
  await updates.stop();
});
`);
    const timer = setInterval(() => gql.emit('9', 'SHIPPED'), 200);
    try {
      const out: string[] = [];
      const err: string[] = [];
      process.exitCode = 0;
      await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd: dir, env: process.env }).exitOverride().parseAsync(['node', 'eztest', 'run', 'journeys']);
      const root = join(dir, 'eztest-results');
      const runDir = (await readdir(root)).filter((d) => d.startsWith('run-')).sort().at(-1)!;
      const run = JSON.parse(await readFile(join(root, runDir, 'run.json'), 'utf8')) as RunResult;
      const j = run.journeys.find((x) => x.journeyId === 'gql-sdk')!;
      expect(j.status, flattenStepResults(j.steps).map(({ result: s }) => `${s.intent}: ${s.status} ${s.error?.message ?? ''}`).join('\n') + err.join('\n')).toBe('passed');
    } finally {
      clearInterval(timer);
      process.exitCode = 0;
    }
  }, 90_000);
});
