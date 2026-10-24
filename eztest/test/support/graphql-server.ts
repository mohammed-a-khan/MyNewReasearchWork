/**
 * A GraphQL test server (no GraphQL library): POST /graphql answers the
 * introspection query from a schema written below and a few canned
 * operations; /graphql upgrades to the graphql-transport-ws protocol and
 * streams scripted orderUpdated events. It checks a bearer token (header or
 * connection_init payload) when `token` is set, and records every protocol
 * message.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IntroTypeRef, IntrospectionSchema, IntroType } from '../../src/surfaces/graphql-schema.js';
import { startWsServer, type WsServerConn } from './ws-server.js';

const T = (s: string): IntroTypeRef => {
  if (s.endsWith('!')) return { kind: 'NON_NULL', ofType: T(s.slice(0, -1)) };
  if (s.startsWith('[')) return { kind: 'LIST', ofType: T(s.slice(1, -1)) };
  const scalars = ['ID', 'String', 'Int', 'Float', 'Boolean', 'DateTime'];
  return { kind: scalars.includes(s) ? 'SCALAR' : ['Status'].includes(s) ? 'ENUM' : ['OrderInput', 'LineInput'].includes(s) ? 'INPUT_OBJECT' : s === 'SearchResult' ? 'UNION' : s === 'Node' ? 'INTERFACE' : 'OBJECT', name: s };
};
const args = (a: Record<string, string>, defaults: Record<string, string> = {}) => Object.entries(a).map(([name, type]) => ({ name, type: T(type), defaultValue: defaults[name] ?? null }));
const obj = (name: string, fields: Record<string, string | [string, Record<string, string>, Record<string, string>?]>, interfaces: string[] = []): IntroType => ({
  kind: 'OBJECT', name, interfaces: interfaces.map((n) => ({ name: n })),
  fields: Object.entries(fields).map(([n, f]) => (typeof f === 'string' ? { name: n, args: [], type: T(f) } : { name: n, args: args(f[1], f[2]), type: T(f[0]) })),
});

export const TEST_SCHEMA: IntrospectionSchema = {
  queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, subscriptionType: { name: 'Subscription' },
  types: [
    ...['ID', 'String', 'Int', 'Float', 'Boolean', 'DateTime'].map((name) => ({ kind: 'SCALAR' as const, name })),
    obj('Query', { order: ['Order', { id: 'ID!' }], orders: ['[Order!]!', { status: 'Status', first: 'Int' }, { first: '10' }], search: ['[SearchResult!]!', { term: 'String!' }], node: ['Node', { id: 'ID!' }] }),
    obj('Mutation', { placeOrder: ['Order!', { input: 'OrderInput!' }] }),
    obj('Subscription', { orderUpdated: ['Order!', { id: 'ID!' }], ticks: 'Int!' }),
    obj('Order', { id: 'ID!', status: 'Status!', total: 'Float!', placedAt: 'DateTime', lines: '[Line!]!', customer: 'Customer' }, ['Node']),
    obj('Line', { sku: 'String!', qty: 'Int!' }),
    obj('Customer', { id: 'ID!', name: 'String!' }, ['Node']),
    { kind: 'INTERFACE', name: 'Node', fields: [{ name: 'id', args: [], type: T('ID!') }], possibleTypes: [{ name: 'Order' }, { name: 'Customer' }] },
    { kind: 'UNION', name: 'SearchResult', possibleTypes: [{ name: 'Order' }, { name: 'Customer' }] },
    { kind: 'ENUM', name: 'Status', enumValues: [{ name: 'NEW' }, { name: 'PAID' }, { name: 'SHIPPED' }] },
    { kind: 'INPUT_OBJECT', name: 'OrderInput', inputFields: args({ customerId: 'ID!', lines: '[LineInput!]!', note: 'String' }) },
    { kind: 'INPUT_OBJECT', name: 'LineInput', inputFields: args({ sku: 'String!', qty: 'Int!' }, { qty: '1' }) },
  ],
  directives: [{ name: 'deprecated', locations: ['FIELD_DEFINITION'], args: args({ reason: 'String' }) }],
};

export interface TestGraphQLServer {
  url: string;
  wsUrl: string;
  /** Protocol messages received over WebSocket, in order. */
  received: Array<Record<string, unknown>>;
  /** HTTP operations received. */
  posted: Array<{ query: string; auth?: string }>;
  /** Push an orderUpdated event to every subscription of that order. */
  emit(id: string, status: string): void;
  close(): Promise<void>;
}

export async function startGraphQLServer(o: { token?: string; introspection?: boolean } = {}): Promise<TestGraphQLServer> {
  const received: Array<Record<string, unknown>> = [];
  const posted: TestGraphQLServer['posted'] = [];
  const subscribers = new Map<string, Array<{ conn: WsServerConn; id: string }>>();
  const authOk = (h: unknown) => !o.token || h === `Bearer ${o.token}`;
  const http: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d));
    req.on('end', () => {
      const json = (status: number, b: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(b));
      };
      if (!authOk(req.headers.authorization)) return json(401, { errors: [{ message: 'unauthorized' }] });
      const q = JSON.parse(body || '{}') as { query?: string };
      posted.push({ query: String(q.query ?? ''), ...(req.headers.authorization ? { auth: String(req.headers.authorization) } : {}) });
      if (/__schema/.test(String(q.query))) {
        if (o.introspection === false) return json(200, { errors: [{ message: 'GraphQL introspection is not allowed' }] });
        return json(200, { data: { __schema: TEST_SCHEMA } });
      }
      if (/orders/.test(String(q.query))) return json(200, { data: { orders: [{ id: '7', status: 'PAID' }] } });
      json(200, { errors: [{ message: 'unsupported operation in the test server' }] });
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/graphql`;
  const ws = await startWsServer({
    protocols: ['graphql-transport-ws'],
    authorize: (req) => (o.token && req.headers.authorization && !authOk(req.headers.authorization) ? 401 : undefined),
    onConnection: (conn) => {
      let acked = false;
      conn.onmessage = (data) => {
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(data.toString()) as Record<string, unknown>;
        } catch {
          return conn.close(4400, 'Invalid message received');
        }
        received.push(m);
        if (m.type === 'connection_init') {
          const auth = (m.payload as { authorization?: string } | undefined)?.authorization ?? conn.req.headers.authorization;
          if (!authOk(auth)) return conn.close(4403, 'Forbidden');
          acked = true;
          conn.send(JSON.stringify({ type: 'connection_ack' }));
          conn.send(JSON.stringify({ type: 'ping' }));
          return;
        }
        if (m.type === 'pong' || m.type === 'ping') {
          if (m.type === 'ping') conn.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        if (!acked) return conn.close(4401, 'Unauthorized');
        if (m.type === 'subscribe') {
          const id = String(m.id);
          const p = m.payload as { query: string; variables?: Record<string, unknown> };
          if (/ticks/.test(p.query)) {
            for (let i = 1; i <= 3; i++) conn.send(JSON.stringify({ type: 'next', id, payload: { data: { ticks: i } } }));
            conn.send(JSON.stringify({ type: 'complete', id }));
            return;
          }
          if (/nosuchfield/.test(p.query)) {
            conn.send(JSON.stringify({ type: 'error', id, payload: [{ message: 'Cannot query field "nosuchfield" on type "Subscription".' }] }));
            return;
          }
          const orderId = String(p.variables?.id ?? /orderUpdated\s*\(\s*id:\s*"?([\w-]+)"?/.exec(p.query)?.[1] ?? '');
          const list = subscribers.get(orderId) ?? [];
          list.push({ conn, id });
          subscribers.set(orderId, list);
          return;
        }
        if (m.type === 'complete') {
          for (const [k, list] of subscribers) subscribers.set(k, list.filter((x) => !(x.conn === conn && x.id === m.id)));
        }
      };
    },
  });
  return {
    url, wsUrl: `${ws.url}/graphql`, received, posted,
    emit(id, status) {
      for (const s of subscribers.get(id) ?? []) s.conn.send(JSON.stringify({ type: 'next', id: s.id, payload: { data: { orderUpdated: { id, status } } } }));
    },
    close: async () => {
      await ws.close();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}
