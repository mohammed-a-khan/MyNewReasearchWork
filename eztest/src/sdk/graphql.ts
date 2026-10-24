/**
 * `graphql`: GraphQL from code-first journeys, through the same steps as .ez
 * files (role tokens from the Identity Vault, client certificates, masked
 * evidence):
 *
 * ```ts
 * const orders = await graphql.query('/graphql', '{ orders { id status } }', {}, { asRole: 'manager' });
 * await graphql.validate('/graphql', 'query ($id: ID!) { order(id: $id) { id total } }');
 * const updates = await graphql.subscribe('/graphql', 'subscription { orderUpdated(id: 7) { status } }', { asRole: 'manager' });
 * const shipped = await updates.next({ '$.data.orderUpdated.status': 'SHIPPED' }, { timeoutMs: 10_000 });
 * await updates.stop();
 * ```
 */
import { literal, literalDeep, run, show, tempKey, type ActionOptions } from './internal.js';
import { currentHost } from './runtime.js';

export interface GraphQLOptions extends Omit<ActionOptions, 'expect'> {
  /** Authorise with this Identity Vault role's API token. */
  asRole?: string;
  headers?: Record<string, string>;
  /** Present this named TLS client certificate (config api.clientCertificates). */
  clientCertificate?: string;
}

export interface GraphQLSubscriptionHandle {
  readonly name: string;
  /** The next event whose fields match (JSONPath -> expected text), or the step fails after the timeout. */
  next(where?: Record<string, string | number | boolean>, o?: { timeoutMs?: number }): Promise<{ data: unknown; extensions?: Record<string, unknown> }>;
  stop(): Promise<void>;
}

let seq = 0;

async function captureOf<T>(key: string, r: Awaited<ReturnType<typeof run>>): Promise<T> {
  const v = r.captured?.[key] as T;
  currentHost().deleteVar(key);
  return v;
}

export const graphql = {
  /** Run a query or mutation over HTTP; returns `data` (GraphQL errors fail the step). */
  async query<T = Record<string, unknown>>(url: string, query: string, variables: Record<string, unknown> = {}, o: GraphQLOptions & { operationName?: string } = {}): Promise<T> {
    const key = tempKey('gql');
    const r = await run({
      intent: o.intent ?? `Send GraphQL query ${show(query, 50)} to ${url}`,
      action: 'api',
      api: {
        method: 'POST', url: literal(url),
        graphql: { query: literal(query), variables: literalDeep(variables), ...(o.operationName ? { operationName: o.operationName } : {}) },
        ...(o.headers ? { headers: literalDeep(o.headers) } : {}), ...(o.asRole ? { asRole: o.asRole } : {}), ...(o.clientCertificate ? { clientCertificate: o.clientCertificate } : {}),
      },
      captureAs: key,
    }, { ...o, intent: undefined });
    const res = await captureOf<{ body?: { data?: T } }>(key, r);
    return res?.body?.data as T;
  },

  /** Check a document against the server's schema (introspected); the step fails listing every problem. */
  async validate(url: string, query: string, o: GraphQLOptions = {}): Promise<void> {
    await run({ intent: o.intent ?? `Validate GraphQL ${show(query, 50)} against ${url}`, action: 'ws', args: { op: 'gql-validate', url: literal(url), query: literal(query), ...(o.asRole ? { asRole: o.asRole } : {}) } }, { ...o, intent: undefined });
  },

  /** A summary of the server's schema: root types, type names, fields per type. */
  async introspect(url: string, o: GraphQLOptions = {}): Promise<{ queryType: string | null; mutationType: string | null; subscriptionType: string | null; types: string[]; fields: Record<string, string[]> }> {
    const key = tempKey('gqlschema');
    const r = await run({ intent: o.intent ?? `Introspect the GraphQL schema at ${url}`, action: 'ws', args: { op: 'gql-introspect', url: literal(url), ...(o.asRole ? { asRole: o.asRole } : {}) }, captureAs: key }, { ...o, intent: undefined });
    return captureOf(key, r);
  },

  /** Start a subscription over graphql-transport-ws; events are buffered from now on. */
  async subscribe(url: string, query: string, o: GraphQLOptions & { variables?: Record<string, unknown>; name?: string } = {}): Promise<GraphQLSubscriptionHandle> {
    const name = o.name ?? `gqlsub${++seq}`;
    await run({
      intent: o.intent ?? `Subscribe to GraphQL ${show(query, 50)} at ${url} as ${name}`,
      action: 'ws',
      args: {
        op: 'gql-subscribe', url: literal(url), query: literal(query), socket: name,
        ...(o.asRole ? { asRole: o.asRole } : {}), ...(o.variables ? { variables: literalDeep(o.variables) } : {}),
        ...(o.headers ? { headers: literalDeep(o.headers) } : {}), ...(o.clientCertificate ? { clientCertificate: o.clientCertificate } : {}),
      },
    }, { ...o, intent: undefined });
    return {
      name,
      async next(where = {}, n = {}) {
        const key = tempKey('gqlevent');
        const filters = Object.entries(where).map(([path, value]) => ({ path, op: '=', value: literal(String(value)) }));
        const r = await run({ intent: `Wait for a GraphQL event on ${name}${filters.length ? ` where ${filters.map((f) => `${f.path} = ${f.value}`).join(' and ')}` : ''}`, action: 'ws', args: { op: 'gql-event', socket: name, ...(filters.length ? { filters } : {}), ...(n.timeoutMs ? { timeoutMs: n.timeoutMs } : {}) }, captureAs: key });
        return captureOf(key, r);
      },
      async stop() {
        await run({ intent: `Stop GraphQL subscription ${name}`, action: 'ws', args: { op: 'gql-stop', socket: name } });
      },
    };
  },
};

export type GraphQLSurface = typeof graphql;
