/**
 * `contracts:` configuration (EZTest contracts) and the `api.spec` options.
 *
 *   api:
 *     spec: specs/shop.yaml          # every API step is validated against it
 *     specMode: enforce              # or warn
 *   contracts:
 *     dir: contracts                 # contract files (<consumer>-<provider>.contract.json)
 *     matchers: type                 # type | schema | exact
 *     app: shop-web                  # this application on the results server (publish, can-release)
 *     branch: main                   # default branch for publish / verify
 *     canRelease: { environment: production }
 *     provider:
 *       name: orders-api
 *       baseUrl: http://localhost:8080
 *       asRole: api                  # bearer token for replayed requests (Identity Vault)
 *       states:
 *         "order 42 exists": { query: SEED_ORDER, on: shop, with: { id: 42 } }
 *         "no orders":       { sql: "DELETE FROM orders", on: shop }
 *         "a customer":      { request: "POST /test/customers", body: { name: "Ann" } }
 *         "logged-in user":  { journey: seed-user }
 *       stateChangeUrl: http://localhost:8080/_test/state
 *       messageProducers:          # message expectations: trigger the provider, read its broker
 *         "order created": { broker: bus, trigger: "POST /api/orders", body: { sku: A1 } }
 *
 * Contracts are published to and fetched from the EZTest results server
 * (`server:`); see docs/api-contracts.md.
 */
import { z } from 'zod';

const StateStep = z.object({
  /** Named query from the catalogue (db.queries) ... */
  query: z.string().optional(),
  /** ... or inline SQL ... */
  sql: z.string().optional(),
  /** ... on this connection. */
  on: z.string().optional(),
  /** Binds for the query; values may use ${param} from the state's params. */
  with: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  /** An HTTP setup call on the provider ("POST /test/seed") with an optional JSON body. */
  request: z.string().optional(),
  body: z.unknown().optional(),
  /** A journey (id, name or file) run with the state's params as variables. */
  journey: z.string().optional(),
});

export const ProviderStateSchema = StateStep.extend({ teardown: StateStep.optional() });

export const ContractsSchema = z.object({
  dir: z.string().default('contracts'),
  matchers: z.enum(['type', 'schema', 'exact']).default('type'),
  /** This application's name on the results server (default: the provider name when verifying). */
  app: z.string().optional(),
  version: z.string().optional(),
  branch: z.string().optional(),
  canRelease: z.object({ environment: z.string().optional() }).optional(),
  provider: z
    .object({
      name: z.string().min(1),
      baseUrl: z.string().url().optional(),
      asRole: z.string().optional(),
      headers: z.record(z.string(), z.string()).default({}),
      stateChangeUrl: z.string().url().optional(),
      states: z.record(z.string(), ProviderStateSchema).default({}),
      /**
       * Message expectations: how to make the provider publish each one (by description, "*" for any).
       * EZTest triggers the provider (an HTTP call), then reads the message from the broker on the
       * expectation's channel (or dest/destType here).
       */
      messageProducers: z
        .record(
          z.string(),
          z.object({
            broker: z.string().optional(),
            destType: z.enum(['topic', 'queue', 'exchange']).optional(),
            dest: z.string().min(1).optional(),
            trigger: z.string().optional(),
            body: z.unknown().optional(),
            timeoutMs: z.number().int().positive().default(15_000),
          }),
        )
        .default({}),
    })
    .optional(),
});
export type ContractsConfig = z.infer<typeof ContractsSchema>;
export type ProviderStateConfig = z.infer<typeof ProviderStateSchema>;

export const ApiSpecOptionsSchema = {
  /** OpenAPI/Swagger spec file(s): every API step is validated against them. */
  spec: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  /** enforce (default): a contract break fails the step; warn: it is recorded only. */
  specMode: z.enum(['enforce', 'warn']).default('enforce'),
  /** Also fail calls that match no operation in the spec (default false). */
  specStrict: z.boolean().default(false),
};
