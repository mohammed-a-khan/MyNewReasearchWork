/** GraphQL over HTTP POST. GraphQL `errors` are always surfaced, never swallowed. */
import { EzTestError } from '../core/index.js';
import type { ApiClient, ApiResponse, RequestOptions } from './api.js';
import { INTROSPECTION_QUERY, validateGraphQL, type GqlError, type IntrospectionSchema } from './graphql-schema.js';

export interface GraphQLErrorItem {
  message: string;
  path?: Array<string | number>;
  locations?: Array<{ line: number; column: number }>;
  extensions?: Record<string, unknown>;
}

export interface GraphQLResult<T> {
  data?: T | null;
  errors: GraphQLErrorItem[];
  response: ApiResponse;
}

export class GraphQLRequestError extends EzTestError {
  constructor(
    message: string,
    readonly errors: GraphQLErrorItem[],
    readonly status: number,
  ) {
    super(message, 'GRAPHQL_ERROR', { status, errors });
    this.name = 'GraphQLRequestError';
  }
}

export class GraphQLClient {
  constructor(
    private readonly api: ApiClient,
    private readonly path = '/graphql',
  ) {}

  /** Execute and return data + errors (does not throw on GraphQL errors; does throw on a non-GraphQL response). */
  async request<T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>,
    opts: { operationName?: string } & Pick<RequestOptions, 'headers' | 'timeoutMs'> = {},
  ): Promise<GraphQLResult<T>> {
    if (!query.trim()) throw new EzTestError('GraphQL query is empty', 'GRAPHQL_EMPTY');
    const res = await this.api.post(this.path, {
      json: { query, variables: variables ?? {}, ...(opts.operationName ? { operationName: opts.operationName } : {}) },
      headers: { accept: 'application/graphql-response+json, application/json', ...opts.headers },
      timeoutMs: opts.timeoutMs,
    });
    const body = res.body as { data?: T | null; errors?: GraphQLErrorItem[] } | string;
    if (!body || typeof body !== 'object' || (!('data' in body) && !('errors' in body))) {
      throw new GraphQLRequestError(`GraphQL endpoint returned HTTP ${res.status} without a GraphQL body`, [], res.status);
    }
    return { data: body.data, errors: Array.isArray(body.errors) ? body.errors : [], response: res };
  }

  /** The server's schema by introspection (cached by the client; `refresh` asks again). */
  async introspect(o: { refresh?: boolean } & Pick<RequestOptions, 'headers' | 'timeoutMs'> = {}): Promise<IntrospectionSchema> {
    if (!this.schema || o.refresh) {
      const r = await this.query<{ __schema: IntrospectionSchema }>(INTROSPECTION_QUERY, undefined, { operationName: 'EZTestIntrospection', headers: o.headers, timeoutMs: o.timeoutMs }).catch((e: Error) => {
        throw new EzTestError(`GraphQL introspection of ${this.path} failed (is introspection disabled on the server?): ${e.message}`, 'GRAPHQL_INTROSPECTION');
      });
      this.schema = r.__schema;
    }
    return this.schema;
  }

  /** Validate a document against the introspected schema; empty = valid. */
  async validate(query: string, o: Pick<RequestOptions, 'headers' | 'timeoutMs'> = {}): Promise<GqlError[]> {
    return validateGraphQL(query, await this.introspect(o));
  }

  private schema?: IntrospectionSchema;

  /** Execute and return data; throws GraphQLRequestError when there are errors or no data. */
  async query<T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>,
    opts: { operationName?: string } & Pick<RequestOptions, 'headers' | 'timeoutMs'> = {},
  ): Promise<T> {
    const r = await this.request<T>(query, variables, opts);
    if (r.errors.length || r.data === undefined || r.data === null) {
      const msgs = r.errors.map((e) => (e.path ? `${e.message} (at ${e.path.join('.')})` : e.message));
      throw new GraphQLRequestError(`GraphQL errors: ${msgs.join('; ') || 'no data returned'}`, r.errors, r.response.status);
    }
    return r.data;
  }
}
