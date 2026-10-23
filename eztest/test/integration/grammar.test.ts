/** Integration and contract phrasings: every variant parses to the expected step, renders canonically and round-trips. */
import { describe, expect, it } from '../support/testkit.js';
import { Step, type Condition } from '../../src/core/index.js';
import { conditionToText, journeyToEzScript, parseCondition, parseEzScript, parseIntent, stepToText, matchedRule } from '../../src/intent/index.js';
import { INTEGRATION_RULES, isIntegrationExpectation } from '../../src/integration/index.js';

const p = (line: string) => Step.parse(parseIntent(line));

const CASES: Array<[string, Record<string, unknown>, string?]> = [
  // ------------------------------------------------------------ publish
  ['Publish message from file "order.json" to Kafka topic "orders" on bus', { kind: 'bus', op: 'publish', broker: 'bus', brokerKind: 'kafka', destType: 'topic', dest: 'orders', file: 'order.json' }],
  ['Publish \'{"id":1}\' to topic "orders"', { op: 'publish', destType: 'topic', dest: 'orders', payload: '{"id":1}' }],
  ['Send a message "hello" to RabbitMQ queue "greetings"', { op: 'publish', brokerKind: 'amqp', destType: 'queue', dest: 'greetings', payload: 'hello' }],
  ['Publish ${order} to AMQP exchange "orders" with routing key "order.created"', { op: 'publish', brokerKind: 'amqp', destType: 'exchange', payload: '${order}', routingKey: 'order.created' }],
  ['Put message \'{"a":1}\' on IBM MQ queue "DEV.QUEUE.1" on qm1 with correlation id "c-1"', { brokerKind: 'ibmmq', broker: 'qm1', correlationId: 'c-1' }],
  ['Produce event "x" to Kafka topic "t" with key "${id}" with headers "type" = "created", "v" = "2"', { key: '${id}', headers: { type: 'created', v: '2' } }],
  ['Publish message "on" to MQTT topic "lights/1" with QoS 2 retained and store it as sent', { brokerKind: 'mqtt', qos: 2, retain: true }, 'sent'],
  ['I publish "x" to JMS queue "Q" as receipt', { brokerKind: 'ibmmq', destType: 'queue' }, 'receipt'],
  ['Publish "x" to queue "q" with content type "text/csv"', { contentType: 'text/csv' }],
  // ------------------------------------------------------------ listen / wait / none
  ['Start listening on Kafka topic "invoices" as invoices', { op: 'listen', listener: 'invoices', brokerKind: 'kafka' }],
  ['Subscribe to MQTT topic "sensors/+/temp" on iot as temps', { op: 'listen', broker: 'iot', dest: 'sensors/+/temp' }],
  ['Listen to RabbitMQ exchange "events" with routing key "order.*" as ev', { op: 'listen', destType: 'exchange', routingKey: 'order.*' }],
  ['Wait for a message on Kafka topic "invoices" where "$.orderId" = ${orderId} within 30 s as invoice', { op: 'wait', filters: [{ field: '$.orderId', op: 'equals', value: '${orderId}' }], timeoutMs: 30000 }, 'invoice'],
  ['Wait for a message in invoices where key = "42" and header "type" = "created" and correlation id = "c1" within 2 minutes as m', { listener: 'invoices', filters: [{ field: 'key', op: 'equals', value: '42' }, { field: 'header:type', op: 'equals', value: 'created' }, { field: 'correlationId', op: 'equals', value: 'c1' }], timeoutMs: 120000 }, 'm'],
  ['Wait for 3 messages on queue "jobs" as batch', { count: 3, destType: 'queue' }, 'batch'],
  ['Receive a message from RabbitMQ queue "q" where payload contains "ok" matching schema "s.json" and store it as r', { filters: [{ field: 'payload', op: 'contains', value: 'ok' }], schema: 's.json' }, 'r'],
  ['Wait for the next event in ev where "$.total" > 10 and "$.status" != "VOID" within 500 ms as e', { filters: [{ field: '$.total', op: 'gt', value: '10' }, { field: '$.status', op: 'ne', value: 'VOID' }], timeoutMs: 500 }, 'e'],
  ['Wait for a message on topic "t" where "$.id" exists', { filters: [{ field: '$.id', op: 'exists' }] }, 'message'],
  ['Expect no message on RabbitMQ queue "errors" within 5 s', { op: 'none', timeoutMs: 5000 }],
  ['Verify no messages arrive in errs where "$.level" = "ERROR"', { op: 'none', listener: 'errs', timeoutMs: 5000 }],
  ['Stop listening to invoices', { op: 'stop', listener: 'invoices' }],
  ['Purge RabbitMQ queue "orders.dlq" on rabbit', { op: 'purge', broker: 'rabbit', dest: 'orders.dlq' }],
  // ------------------------------------------------------------ gRPC
  ['Call gRPC "shop.Orders/Get" on orders with \'{"id":42}\' as order', { kind: 'grpc', service: 'orders', method: 'shop.Orders/Get', request: '{"id":42}' }, 'order'],
  ['Call gRPC "shop.Orders/Get" on orders with ${req} with metadata "x-tenant" = "eu" with timeout 2 s expecting status NOT_FOUND and allow errors as r', { request: '${req}', metadata: { 'x-tenant': 'eu' }, timeoutMs: 2000, expectStatus: 'NOT_FOUND', allowErrors: true }, 'r'],
  ['Invoke gRPC method "pkg.Svc.Ping" on svc', { method: 'pkg.Svc.Ping' }, 'response'],
  // ------------------------------------------------------------ files / ssh / batch / edi
  ['Upload "batch.csv" to SFTP "partner" at "/in"', { kind: 'file', op: 'upload', server: 'partner', dir: '/in', local: 'batch.csv' }],
  ['Upload "a.csv" to SFTP partner into "/in" as "b.csv"', { server: 'partner', name: 'b.csv' }],
  ['Copy "fixtures/x.edi" to folder "drop/in"', { op: 'upload', folder: 'drop/in', local: 'fixtures/x.edi' }],
  ['Download "/out/ack.csv" from SFTP "partner" as ack', { op: 'download', remote: '/out/ack.csv' }, 'ack'],
  ['Wait for a file matching "ACK_*.csv" in "/out" on SFTP "partner" within 5 minutes as ack', { op: 'wait', pattern: 'ACK_*.csv', timeoutMs: 300000 }, 'ack'],
  ['Wait until a file named "*.done" appears in folder "out"', { op: 'wait', folder: 'out' }, 'file'],
  ['Delete "/in/x.csv" on SFTP "partner"', { op: 'delete', remote: '/in/x.csv' }],
  ['List files in "/out" on SFTP "partner" matching "*.csv" as files', { op: 'list', pattern: '*.csv' }, 'files'],
  ['List the files in folder "drop" as dropped', { op: 'list', folder: 'drop' }, 'dropped'],
  ['Run command "./close-day.sh" on SSH "batch-host" as closing', { kind: 'ssh', host: 'batch-host', command: './close-day.sh' }, 'closing'],
  ['Execute the shell command "ls /data" on host app1 expecting exit code 2 within 30 s', { host: 'app1', exitCode: 2, timeoutMs: 30000 }],
  ['Run batch job "close-day" with date=${today}, region="EU" and wait up to 10 minutes as job', { kind: 'batch', job: 'close-day', params: { date: '${today}', region: 'EU' }, timeoutMs: 600000 }, 'job'],
  ['Trigger batch job nightly', { job: 'nightly' }],
  ['Read the file ack as EDI into edi', { kind: 'edi', from: 'ack' }, 'edi'],
  ['Parse the download po as an EDI interchange into doc', { from: 'po' }, 'doc'],
  ['Load the EDI file "fixtures/850.edi" into po', { file: 'fixtures/850.edi' }, 'po'],
  // ------------------------------------------------------------ contracts
  ['Start a contract between consumer "shop-web" and provider "orders-api"', { kind: 'contract', op: 'start', consumer: 'shop-web', provider: 'orders-api' }],
  ['Record the contract between web and orders in "contracts"', { consumer: 'web', provider: 'orders', dir: 'contracts' }],
  ['Given provider state "order 42 exists" with id=42, status="OPEN"', { op: 'state', state: 'order 42 exists', params: { id: '42', status: 'OPEN' } }],
  ['Given the provider is in state "no orders"', { op: 'state', state: 'no orders' }],
  ['Finish the contract', { op: 'stop' }],
];

describe('integration phrasings', () => {
  it.each(CASES)('%s', (line, args, captureAs) => {
    const s = p(line);
    expect(s.action).toBe('integration');
    expect(s.args).toMatchObject(Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)));
    if (captureAs !== undefined) expect(s.captureAs).toBe(captureAs);
    // The canonical line parses back to the same step.
    const canon = stepToText(s);
    const again = p(canon);
    expect({ args: again.args, captureAs: again.captureAs }, canon).toEqual({ args: s.args, captureAs: s.captureAs });
  });

  it('every rule example is matched by its own rule and has a category', () => {
    for (const r of INTEGRATION_RULES) {
      expect(matchedRule(r.example)?.name, r.example).toBe(r.name);
      expect(r.category).toBeTruthy();
    }
  });

  it('rejects malformed clauses with a helpful message', () => {
    expect(() => parseIntent('Wait for a message on topic "t" where banana as x')).toThrow(/Cannot read the message filter "banana"/);
    expect(() => parseIntent('Wait for a message on topic "t" where "orderId" = 1 as x')).toThrow(/JSONPath starting with \$/);
    expect(() => parseIntent('Publish "x" to topic "t" with flavour "y"')).toThrow(/Unknown publish option "with flavour/);
    expect(() => parseIntent('Call gRPC "a.B/C" on svc with \'{}\' with frobnicate yes')).toThrow(/Unknown gRPC option/);
  });

  it('does not steal existing phrasings', () => {
    expect(p('Put "2" in the Quantity field').action).toBe('fill');
    expect(p('Upload "fixtures/po.pdf" to the Attachment field').action).toBe('upload');
    expect(p('Download the invoice link as invoice').action).toBe('download');
    expect(p('Wait for the Orders table to appear').action).toBe('wait');
    expect(p('Read the download invoice as rows into r').action).toBe('set');
    expect(p('Clear the Search field').action).toBe('clear');
    expect(p('Send a GET request to /api/orders and store as orders').action).toBe('api');
    expect(p('Run step "seedCart" with items=3').action).toBe('custom');
    expect(p('Expect the page to contain "Saved"').action).toBe('assert');
    expect(p('Wait for a message in the inbox').action).toBe('wait');
  });

  it('"Expect no message" lines are steps of their own in .ez, other Expect lines stay post-conditions', () => {
    expect(isIntegrationExpectation('Expect no message on topic "t" within 1 s')).toBe(true);
    expect(isIntegrationExpectation('Expect response x status is 200')).toBe(false);
    const j = parseEzScript(`Journey: Bus
Publish "x" to topic "t"
Expect no message on topic "errors" within 1 s
Call API "GET /api/orders" and store as orders
  Expect response orders conforms to OpenAPI "specs/shop.yaml"
  Expect response orders conforms to the API spec operation "listOrders"
`);
    expect(j.steps.map((s) => s.action)).toEqual(['integration', 'integration', 'api']);
    expect(j.steps[2].postconditions).toEqual([
      { type: 'apiContract', captureKey: 'orders', spec: 'specs/shop.yaml' },
      { type: 'apiContract', captureKey: 'orders', operation: 'listOrders' },
    ]);
    expect(parseEzScript(journeyToEzScript(j))).toEqual(j);
  });
});

describe('apiContract expectation', () => {
  const cases: Array<[string, Condition]> = [
    ['response orders conforms to OpenAPI "specs/shop.yaml"', { type: 'apiContract', captureKey: 'orders', spec: 'specs/shop.yaml' }],
    ['response orders to conform to the OpenAPI spec "a.yaml"', { type: 'apiContract', captureKey: 'orders', spec: 'a.yaml' }],
    ['order is valid against the Swagger "legacy.json" operation getOrder', { type: 'apiContract', captureKey: 'order', spec: 'legacy.json', operation: 'getOrder' }],
    ['response order complies with the API contract', { type: 'apiContract', captureKey: 'order' }],
    ['order follows the API spec for operation "getOrder"', { type: 'apiContract', captureKey: 'order', operation: 'getOrder' }],
  ];
  it.each(cases)('%s', (text, want) => {
    const c = parseCondition(text);
    expect(c).toEqual(want);
    expect(parseCondition(conditionToText(c))).toEqual(c);
  });
  it('keeps the JSON Schema expectation separate', () => {
    expect(parseCondition('response orders matches schema "s.json"')).toMatchObject({ type: 'jsonSchema' });
  });
});
