/** OpenAPI / Swagger loading and validation, lint, coverage numbers, generators and mock store. */
import { describe, expect, it } from '../support/testkit.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildSpec, computeApiCoverage, describeViolations, generateValue, lintSpec, loadApiSpec, matchOperation, mockStoreFromSpec,
  stringFromPattern, validateAgainstDefinition, validateExchange, validateSchemaIn, apiCoverageMarkdown,
} from '../../src/contracts/index.js';
import { Synthetic } from '../../src/data/synthetic.js';

const DEMO = resolve(__dirname, '../../examples/demo-app/openapi.yaml');

const SWAGGER = {
  swagger: '2.0',
  info: { title: 'Pets', version: '1' },
  host: 'pets.example.com',
  basePath: '/v1',
  schemes: ['https'],
  paths: {
    '/pets': {
      get: { operationId: 'listPets', parameters: [{ name: 'limit', in: 'query', type: 'integer', maximum: 100, required: true }], responses: { 200: { description: 'ok', schema: { type: 'array', items: { $ref: '#/definitions/Pet' } } } } },
      post: { operationId: 'addPet', consumes: ['application/json'], parameters: [{ name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/Pet' } }], responses: { 201: { description: 'created', schema: { $ref: '#/definitions/Pet' }, headers: { Location: { type: 'string' } } } } },
    },
    '/pets/{id}/photo': {
      post: { operationId: 'upload', consumes: ['multipart/form-data'], parameters: [{ name: 'id', in: 'path', type: 'integer', required: true }, { name: 'caption', in: 'formData', type: 'string', required: true }], responses: { 204: { description: 'stored' } } },
    },
  },
  definitions: { Pet: { type: 'object', required: ['name'], properties: { id: { type: 'integer', format: 'int64' }, name: { type: 'string', minLength: 1 }, tag: { type: 'string', 'x-nullable': true } } } },
};

const OAS31 = {
  openapi: '3.1.0',
  info: { title: 'Items', version: '2' },
  servers: [{ url: 'https://api.example.com/{stage}', variables: { stage: { default: 'prod' } } }],
  paths: {
    '/items/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^I-\\d+$' } }],
      get: {
        operationId: 'getItem',
        parameters: [{ name: 'X-Trace', in: 'header', required: true, schema: { type: 'string' } }],
        responses: {
          '2XX': { description: 'ok', headers: { 'X-Rate': { required: true, schema: { type: 'integer' } } }, content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } },
          default: { description: 'err', content: { 'application/problem+json': { schema: { type: 'object', required: ['title'] } } } },
        },
      },
    },
    '/items/special': { get: { operationId: 'special', responses: { 200: { description: 'ok' } } } },
  },
  components: { schemas: { Item: { type: 'object', required: ['id', 'price'], properties: { id: { type: 'string' }, price: { type: ['number', 'null'], exclusiveMinimum: 0 }, tags: { $ref: '#/components/schemas/Tags', description: 'sibling allowed in 3.1' } } }, Tags: { type: 'array', items: { type: 'string' } } } },
};

describe('loading specs', () => {
  it('normalises the demo OpenAPI 3.0 spec', () => {
    const s = loadApiSpec(DEMO);
    expect(s.version).toBe('3.0.3');
    expect(s.operations.map((o) => o.id)).toEqual(['getToken', 'quote', 'listOrders', 'getOrder', 'listCustomers']);
    expect(s.operations.find((o) => o.id === 'getOrder')?.responses['404']?.content['application/json'].schema).toBeDefined();
    expect(s.warnings).toEqual([]);
  });

  it('reads Swagger 2.0: basePath, body and formData parameters, response headers', () => {
    const s = buildSpec(SWAGGER);
    expect(s.basePaths).toEqual(['/v1']);
    expect(s.servers).toEqual(['https://pets.example.com/v1']);
    const add = s.operations.find((o) => o.id === 'addPet')!;
    expect(Object.keys(add.requestBody!.content)).toEqual(['application/json']);
    expect(add.responses['201'].headers.location).toBeDefined();
    expect(s.operations.find((o) => o.id === 'upload')!.requestBody!.content['multipart/form-data'].schema).toMatchObject({ required: ['caption'] });
    expect(matchOperation(s, 'GET', 'https://pets.example.com/v1/pets?limit=3')?.operation.id).toBe('listPets');
    const bad = validateExchange(s, { method: 'POST', url: '/v1/pets', requestBody: { name: '' }, status: 201, responseBody: { name: 'Rex', id: 1.5 } });
    expect(bad.violations.map((v) => `${v.side} ${v.message}`)).toEqual(['request /name: must NOT have fewer than 1 characters', 'response /id: must be integer', 'response /id: must match format "int64"']);
    expect(validateExchange(s, { method: 'GET', url: '/v1/pets', status: 200, responseBody: [] }).violations[0].message).toBe('required query parameter "limit" is missing');
    expect(validateExchange(s, { method: 'GET', url: '/v1/pets?limit=500', status: 200, responseBody: [] }).violations[0].message).toMatch(/query parameter "limit" = "500" must be <= 100/);
  });

  it('reads OpenAPI 3.1: type arrays, numeric exclusive bounds, $ref siblings, path-level parameters, 2XX/default, required headers, literal paths first', () => {
    const s = buildSpec(OAS31);
    expect(s.basePaths).toEqual(['/prod']);
    expect(matchOperation(s, 'GET', '/prod/items/special')?.operation.id).toBe('special');
    expect(matchOperation(s, 'GET', '/prod/items/I-1')?.operation.id).toBe('getItem');
    const ok = validateExchange(s, { method: 'GET', url: '/prod/items/I-7', requestHeaders: { 'x-trace': 't' }, status: 203, responseHeaders: { 'content-type': 'application/json', 'x-rate': '5' }, responseBody: { id: 'I-7', price: null, tags: ['a'] } });
    expect(ok.violations).toEqual([]);
    const bad = validateExchange(s, { method: 'GET', url: '/prod/items/X', status: 200, responseHeaders: { 'content-type': 'application/json', 'x-rate': 'many' }, responseBody: { id: 'X', price: 0, tags: [1] } });
    expect(bad.violations.map((v) => v.message)).toEqual([
      'path parameter "id" = "X" must match pattern "^I-\\d+$"',
      'response header "x-rate" = "many" must be integer',
      '/price: must be > 0',
      '/tags/0: must be string',
    ]);
    const problem = validateExchange(s, { method: 'GET', url: '/prod/items/I-1', status: 500, responseHeaders: { 'content-type': 'application/problem+json' }, responseBody: {} });
    expect(problem.violations.map((v) => v.message)).toEqual(['/title: required property is missing']);
    expect(describeViolations(problem)).toMatch(/^GET \/prod\/items\/I-1 -> 500 breaks the API contract \(getItem\): response \/title: required property is missing$/);
  });

  it('resolves relative-file $refs and OpenAPI 3.0 nullable / boolean exclusiveMinimum', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-oas-'));
    await writeFile(join(dir, 'common.yaml'), 'Money:\n  type: number\n  minimum: 0\n  exclusiveMinimum: true\n  nullable: true\n');
    await writeFile(join(dir, 'api.yaml'), `openapi: 3.0.3
info: { title: T, version: "1" }
paths:
  /pay:
    post:
      operationId: pay
      requestBody: { required: true, content: { application/json: { schema: { type: object, properties: { amount: { $ref: 'common.yaml#/Money' } } } } } }
      responses: { "204": { description: ok } }
`);
    const s = loadApiSpec(join(dir, 'api.yaml'));
    expect(validateExchange(s, { method: 'POST', url: '/pay', requestBody: { amount: null }, status: 204 }).valid).toBe(true);
    expect(validateExchange(s, { method: 'POST', url: '/pay', requestBody: { amount: 0 }, status: 204 }).violations[0].message).toBe('/amount: must be > 0');
    expect(validateExchange(s, { method: 'POST', url: '/pay', status: 204 }).violations[0].message).toBe('the request body is required');
    expect(validateExchange(s, { method: 'GET', url: '/pay', status: 200 }).violations[0].message).toBe('method GET is not documented for /pay');
    expect(validateExchange(s, { method: 'GET', url: '/nowhere' }).violations[0].message).toBe('no operation in the spec matches GET /nowhere');
  });

  it('validates values against named schemas (message payloads) and refuses non-specs', () => {
    const s = loadApiSpec(DEMO);
    expect(validateAgainstDefinition(s, 'OrderLine', { sku: 'A', name: 'n', qty: 0, unit_price: 1, line_total: 1 }).map((v) => v.message)).toEqual(['/qty: must be >= 1']);
    expect(() => validateAgainstDefinition(s, 'Nope', {})).toThrow(/no schema "Nope"/);
    expect(() => buildSpec({ info: {} })).toThrow(/not an OpenAPI 3\.0\/3\.1 or Swagger 2\.0 document/);
  });
});

describe('lint', () => {
  it('passes the demo spec and reports each rule on a sloppy one', () => {
    expect(lintSpec(loadApiSpec(DEMO)).counts.error).toBe(0);
    const r = lintSpec(buildSpec({ openapi: '3.0.0', info: { title: '', version: '' }, paths: { '/a/{id}/': { get: { security: [{ oauth: [] }], requestBody: { content: {} }, responses: { 500: { description: 'x', content: { 'application/json': {} } } } } } } }));
    expect(r.passed).toBe(false);
    expect([...new Set(r.findings.map((f) => f.rule))].sort()).toEqual([
      'error-response', 'get-no-body', 'info-title-version', 'no-trailing-slash', 'operation-id', 'operation-summary', 'operation-tags', 'path-params-declared', 'request-body-example', 'response-schema', 'security-defined', 'servers-defined', 'success-response',
    ]);
    expect(lintSpec(buildSpec({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths: {} }), { rules: { 'servers-defined': 'off' } }).findings).toEqual([]);
  });
});

describe('API coverage numbers', () => {
  it('counts operations, status codes and parameters exercised, and calls outside the spec', () => {
    const s = loadApiSpec(DEMO);
    const r = computeApiCoverage(s, [
      { method: 'GET', url: 'http://h/api/orders/1', status: 200, journeyId: 'j1', evidenceId: 'E-1' },
      { method: 'GET', url: 'http://h/api/orders/2', status: 404, journeyId: 'j2' },
      { method: 'GET', url: 'http://h/api/customers?region=EU', status: 200, journeyId: 'j1', violations: 1 },
      { method: 'POST', url: 'http://h/api/public/quote', status: 418, hasBody: true },
      { method: 'GET', url: 'http://h/health', status: 200 },
    ]);
    expect(r.totals).toMatchObject({ operations: 5, coveredOperations: 3, statusCodes: 11, coveredStatusCodes: 3, parameters: 4, coveredParameters: 3, calls: 5, unmatchedCalls: 1, violations: 1 });
    expect(r.totals.operationRatio).toBe(0.6);
    const getOrder = r.operations.find((o) => o.id === 'getOrder')!;
    expect(getOrder).toMatchObject({ calls: 2, journeys: ['j1', 'j2'], evidence: ['E-1'], statuses: { covered: ['200', '404'], missing: ['401'], seen: [200, 404] }, parameters: { exercised: ['path:id'], missing: [] } });
    expect(r.operations.find((o) => o.id === 'quote')!.statuses.undocumented).toEqual([418]);
    expect(r.operations.find((o) => o.id === 'listCustomers')!.parameters.exercised).toEqual(['query:region']);
    expect(r.unmatched).toEqual([{ method: 'GET', url: 'http://h/health', status: 200 }]);
    const md = apiCoverageMarkdown(r);
    expect(md).toContain('| Operations | 3 | 5 | 60% |');
    expect(md).toContain('**untested** `POST /api/token` (getToken)');
  });
});

describe('generators and spec mocks', () => {
  it('generates strings from patterns deterministically', () => {
    for (const p of ['^SKU-\\d+$', '^[A-Z]{3}-\\d{2,4}$', '^(?:EUR|USD)$', '^\\d+\\.\\d{2}$', '^[a-z0-9_]+@example\\.(com|org)$']) {
      const a = stringFromPattern(p, new Synthetic(1));
      expect(a, p).toBeDefined();
      expect(new RegExp(p).test(a!), `${p} -> ${a}`).toBe(true);
      expect(stringFromPattern(p, new Synthetic(1))).toBe(a);
    }
  });

  it('generates schema-valid, seed-stable values for every response schema of the demo spec', () => {
    const s = loadApiSpec(DEMO);
    for (const op of s.operations) {
      for (const [code, r] of Object.entries(op.responses)) {
        for (const m of Object.values(r.content)) {
          if (!m.schema) continue;
          const v = generateValue(s, m.schema, { seed: `x|${op.id}|${code}` });
          expect(validateSchemaIn(s, m.schema, v), `${op.id} ${code} ${JSON.stringify(v)}`).toEqual([]);
          expect(generateValue(s, m.schema, { seed: `x|${op.id}|${code}` })).toEqual(v);
        }
      }
    }
  });

  it('builds an eztest mock store from the spec (GET operations)', () => {
    const store = mockStoreFromSpec(loadApiSpec(DEMO), 3);
    expect(store.recordings.map((r) => `${r.request.method} ${r.request.path} ${r.response.status}`)).toEqual(['GET /api/orders 200', 'GET /api/orders/1 200', 'GET /api/customers 200']);
  });
});
