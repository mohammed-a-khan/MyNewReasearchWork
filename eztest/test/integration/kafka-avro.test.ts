/**
 * Schema registry and schema-encoded Kafka messages.
 *
 * - EZTest's registry client against a local Confluent-compatible registry
 *   (test/support/schema-registry-server.ts): subjects, versions, lookup,
 *   compatibility, config, basic authentication, errors.
 * - The serializer: Avro (EZTest's codec), JSON Schema and Protobuf
 *   (protobufjs) in the Confluent wire format.
 * - Live on the Kafka broker (eztest-it-kafka): journeys publish
 *   "as Avro using subject ..." / "as Protobuf ...", and waits filter and
 *   assert on the decoded fields; the bytes on the topic are checked raw.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stringify as toYaml } from 'yaml';
import { loadConfig } from '../../src/config/index.js';
import { flattenStepResults, type JourneyResult } from '../../src/core/index.js';
import { createEngine } from '../../src/engine/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { KafkaBusDriver } from '../../src/integration/bus/kafka.js';
import { SchemaRegistryClient, SchemaRegistryError, SchemaRegistrySerde } from '../../src/integration/schema-registry.js';
import { unframeConfluent } from '../../src/integration/avro.js';
import { integrationStepToText } from '../../src/integration/rules.js';
import { startSchemaRegistry, type TestSchemaRegistry } from '../support/schema-registry-server.js';
import { kafkaBroker } from './brokers.js';

const ORDER_V1 = { type: 'record', name: 'OrderPlaced', namespace: 'shop.events', fields: [
  { name: 'orderId', type: 'long' },
  { name: 'status', type: { type: 'enum', name: 'Status', symbols: ['NEW', 'PAID', 'SHIPPED'] } },
  { name: 'total', type: { type: 'bytes', logicalType: 'decimal', precision: 10, scale: 2 } },
  { name: 'placedAt', type: { type: 'long', logicalType: 'timestamp-millis' } },
  { name: 'lines', type: { type: 'array', items: { type: 'record', name: 'Line', fields: [{ name: 'sku', type: 'string' }, { name: 'qty', type: 'int' }] } } },
  { name: 'note', type: ['null', 'string'], default: null },
] };
const ORDER_PROTO = `syntax = "proto3";
package shop.events;
message Shipment { string order_id = 1; int32 parcels = 2; repeated string tracking = 3; }
message Cancelled { string order_id = 1; string reason = 2; }
`;

const steps = (j: JourneyResult) => flattenStepResults(j.steps).map(({ result: s }) => `${s.stepId}: ${s.status}${s.error ? ` (${s.error.message})` : ''}`).join('\n');

describe('schema registry client', () => {
  let reg: TestSchemaRegistry;
  let c: SchemaRegistryClient;
  beforeAll(async () => {
    reg = await startSchemaRegistry({ username: 'sr-user', password: 'sr-pass' });
    c = new SchemaRegistryClient({ url: reg.url, username: 'sr-user', password: 'sr-pass' });
  });
  afterAll(() => reg.close());

  it('registers, lists, reads versions and ids, and looks schemas up', async () => {
    const id = await c.register('orders-value', ORDER_V1);
    expect(await c.register('orders-value', JSON.stringify(ORDER_V1, null, 2))).toBe(id); // same canonical form: same id, no new version
    expect(await c.subjects()).toEqual(['orders-value']);
    expect(await c.versions('orders-value')).toEqual([1]);
    const latest = await c.version('orders-value');
    expect(latest).toMatchObject({ subject: 'orders-value', id, version: 1, schemaType: 'AVRO' });
    expect((await c.schemaById(id)).schema).toBe(latest.schema);
    expect(await c.lookup('orders-value', ORDER_V1)).toMatchObject({ id, version: 1 });
    expect(await c.lookup('orders-value', { ...ORDER_V1, name: 'Other' })).toBeUndefined();
    expect(reg.requests.every((r) => r.auth === `Basic ${Buffer.from('sr-user:sr-pass').toString('base64')}`)).toBe(true);
  });

  it('checks compatibility (with the reasons) and enforces it on registration', async () => {
    const v2 = { ...ORDER_V1, fields: [...ORDER_V1.fields, { name: 'channel', type: 'string', default: 'web' }] };
    const breaking = { ...ORDER_V1, fields: [...ORDER_V1.fields, { name: 'customerId', type: 'string' }] };
    expect(await c.compatibility('orders-value')).toBe('BACKWARD');
    expect(await c.checkCompatibility('orders-value', v2)).toEqual({ compatible: true, messages: [] });
    const no = await c.checkCompatibility('orders-value', breaking);
    expect(no.compatible).toBe(false);
    expect(no.messages.join()).toMatch(/customerId: the reader's field has no default/);
    await expect(c.register('orders-value', breaking)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/incompatible/) });
    expect(await c.register('orders-value', v2)).toBeGreaterThan(0);
    expect(await c.versions('orders-value')).toEqual([1, 2]);
    await c.setCompatibility('NONE', 'orders-value');
    expect(await c.compatibility('orders-value')).toBe('NONE');
    expect(await c.register('orders-value', breaking)).toBeGreaterThan(0);
  });

  it('reports registry errors with their codes', async () => {
    const err = await c.version('no-such-subject').catch((e) => e);
    expect(err).toBeInstanceOf(SchemaRegistryError);
    expect(err).toMatchObject({ status: 404, errorCode: 40401 });
    const anon = new SchemaRegistryClient({ url: reg.url });
    await expect(anon.subjects()).rejects.toThrow(/HTTP 401 40101 Unauthorized \(check the registry credentials\)/);
  });
});

describe('schema-registry serializer (Avro, JSON Schema, Protobuf)', () => {
  let reg: TestSchemaRegistry;
  let serde: SchemaRegistrySerde;
  beforeAll(async () => {
    reg = await startSchemaRegistry();
    const c = new SchemaRegistryClient({ url: reg.url });
    await c.register('orders-value', ORDER_V1);
    await c.register('shipments-value', ORDER_PROTO, 'PROTOBUF');
    await c.register('audit-value', JSON.stringify({ type: 'object', properties: { who: { type: 'string' } } }), 'JSON');
    serde = new SchemaRegistrySerde(c);
  });
  afterAll(() => reg.close());

  it('Avro: framed with the schema id, decoded to JSON-friendly values', async () => {
    const order = { orderId: 42, status: 'PAID', total: '99.50', placedAt: '2026-03-01T10:00:00.000Z', lines: [{ sku: 'SKU-200', qty: 2 }] };
    const e = await serde.encode('orders-value', order);
    expect(e.format).toBe('avro');
    expect(unframeConfluent(e.bytes)?.schemaId).toBe(e.schemaId);
    expect(await serde.decode(e.bytes)).toEqual({ format: 'avro', schemaId: e.schemaId, type: 'shop.events.OrderPlaced', value: { ...order, note: null } });
    await expect(serde.encode('orders-value', { ...order, status: 'LOST' })).rejects.toThrow(/"LOST" is not a symbol of enum shop\.events\.Status/);
    expect(await serde.decode(Buffer.from('{"plain":"json"}'))).toBeUndefined();
  });

  it('Protobuf: message indexes for the first and a later message type', async () => {
    const a = await serde.encode('shipments-value', { order_id: '42', parcels: 2, tracking: ['T1', 'T2'] });
    expect(a.format).toBe('protobuf');
    expect(a.bytes[5]).toBe(0); // [0] is written as a single 0
    expect(await serde.decode(a.bytes)).toEqual({ format: 'protobuf', schemaId: a.schemaId, type: 'shop.events.Shipment', value: { order_id: '42', parcels: 2, tracking: ['T1', 'T2'] } });
    const b = await serde.encode('shipments-value', { order_id: '43', reason: 'customer request' }, { message: 'shop.events.Cancelled' });
    expect(Array.from(b.bytes.subarray(5, 7))).toEqual([2, 2]); // count 1, index 1 (zig-zag)
    expect(await serde.decode(b.bytes)).toMatchObject({ type: 'shop.events.Cancelled', value: { order_id: '43', reason: 'customer request' } });
    await expect(serde.encode('shipments-value', { parcels: 'many' })).rejects.toThrow(/does not fit Protobuf shop\.events\.Shipment: parcels: integer expected/);
  });

  it('JSON Schema payloads', async () => {
    const e = await serde.encode('audit-value', { who: 'bob' });
    expect(Buffer.from(e.bytes.subarray(5)).toString()).toBe('{"who":"bob"}');
    expect(await serde.decode(e.bytes)).toEqual({ format: 'json', schemaId: e.schemaId, value: { who: 'bob' } });
  });

  it('the publish step grammar round-trips', () => {
    const j = parseEzScript('Journey: g\nPublish message from file "order.json" to Kafka topic "orders" on bus with key "${id}" as Avro using subject "orders-value" as sent\nPublish message "${s}" to Kafka topic "ship" as Protobuf using subject "shipments-value" message "shop.events.Cancelled" version 1\n');
    const [p1, p2] = j.steps;
    expect(p1.args).toMatchObject({ encoding: 'avro', subject: 'orders-value', key: '${id}' });
    expect(p1.captureAs).toBe('sent');
    expect(integrationStepToText(p1)).toBe('Publish message from file "order.json" to Kafka topic "orders" on bus with key ${id} as Avro using subject "orders-value" as sent');
    expect(p2.args).toMatchObject({ encoding: 'protobuf', subject: 'shipments-value', messageType: 'shop.events.Cancelled', schemaVersion: 1 });
    expect(integrationStepToText(p2)).toBe('Publish message ${s} to Kafka topic "ship" as Protobuf using subject "shipments-value" message "shop.events.Cancelled" version 1');
    expect(() => parseEzScript('Journey: g\nPublish message "x" to Kafka topic "orders" as Avro\n')).toThrow(/Say which registry subject to encode with/);
  });
});

const kafka = await kafkaBroker();
if (!kafka) console.warn('[eztest] Kafka Avro e2e skipped (no broker: EZTEST_KAFKA_BROKERS or Docker)');

describe.skipIf(!kafka)('Avro and Protobuf messages on a real Kafka broker', () => {
  let reg: TestSchemaRegistry;
  let dir: string;
  beforeAll(async () => {
    reg = await startSchemaRegistry();
    const c = new SchemaRegistryClient({ url: reg.url });
    await c.register('orders-value', ORDER_V1);
    await c.register('shipments-value', ORDER_PROTO, 'PROTOBUF');
    dir = await mkdtemp(join(tmpdir(), 'eztest-avro-'));
    await mkdir(join(dir, 'payloads'), { recursive: true });
    await writeFile(join(dir, 'payloads', 'order.json'), '{"orderId": ${orderId}, "status": "PAID", "total": "99.50", "placedAt": "2026-03-01T10:00:00.000Z", "lines": [{"sku": "SKU-200", "qty": 2}]}');
    await writeFile(join(dir, 'eztest.config.yaml'), toYaml({ outputDir: 'results', healing: { enabled: false }, messaging: { timeoutMs: 20_000, brokers: { bus: { type: 'kafka', brokers: kafka, createTopics: true, schemaRegistry: { url: reg.url } } } } }));
  });
  afterAll(() => reg?.close());

  async function runJourney(ez: string): Promise<JourneyResult> {
    const loaded = await loadConfig({ cwd: dir, environment: {} });
    const engine = await createEngine(loaded, { cwd: dir, runOptions: { stepTimeoutMs: 25_000 } });
    try {
      return (await engine.run([parseEzScript(ez)])).journeys[0];
    } finally {
      await engine.close();
    }
  }

  it('publishes as Avro using a subject; the wait decodes, filters and asserts on the fields', async () => {
    const topic = `orders-avro-${randomUUID().slice(0, 8)}`;
    const raw = new KafkaBusDriver('raw', { brokers: kafka!, createTopics: true });
    const rawSub = await raw.subscribe({ type: 'topic', name: topic }, { fromTimestamp: Date.now() - 1000 }).catch(() => undefined);
    try {
      const j = await runJourney(`Journey: Avro round trip
Set variable orderId to 7000 + random(1, 999)
Start listening on Kafka topic "${topic}" on bus as events
Publish message from file "payloads/order.json" to Kafka topic "${topic}" on bus with key "\${orderId}" as Avro using subject "orders-value" as sent
Expect \${sent.format} equals "avro"
Wait for a message in events where "$.orderId" = \${orderId} and "$.status" = "PAID" and "$.lines[0].sku" = "SKU-200" within 20 s as received
  Expect response received "$.total" equals "99.50"
  Expect response received "$.placedAt" equals "2026-03-01T10:00:00.000Z"
Expect \${received_meta.format} equals "avro"
Expect \${received_meta.schemaId} equals "\${sent.schemaId}"
Expect no message in events where "$.status" = "SHIPPED" within 1 s
`);
      expect(j.status, steps(j)).toBe('passed');
      // On the wire: magic byte 0, the schema id, then Avro binary (not JSON).
      const m = rawSub ? await rawSub.next(() => true, 10_000) : undefined;
      expect(m?.binary).toBe(true);
      const bytes = Buffer.from(m!.payload, 'base64');
      expect(bytes[0]).toBe(0);
      expect(bytes.readUInt32BE(1)).toBe(1);
      expect(bytes.toString('utf8')).not.toContain('orderId');
    } finally {
      await rawSub?.close();
      await raw.close();
    }
  }, 90_000);

  it('Protobuf with a named message type; a payload that does not fit the schema fails the step', async () => {
    const topic = `ship-pb-${randomUUID().slice(0, 8)}`;
    const j = await runJourney(`Journey: Protobuf round trip
Start listening on Kafka topic "${topic}" on bus as events
Publish message '{"order_id": "42", "reason": "customer request"}' to Kafka topic "${topic}" on bus as Protobuf using subject "shipments-value" message "shop.events.Cancelled"
Wait for a message in events where "$.reason" = "customer request" within 20 s as cancelled
Expect \${cancelled.order_id} equals "42"
Publish message '{"orderId": 1, "status": "LOST"}' to Kafka topic "${topic}" on bus as Avro using subject "orders-value"
`);
    const r = flattenStepResults(j.steps).map(({ result }) => result);
    // ("Expect ..." after a step is that step's post-condition, not a step of its own)
    expect(r.slice(0, 3).map((s) => s.status), steps(j)).toEqual(['passed', 'passed', 'passed']);
    expect(r[3].status).toBe('failed');
    expect(r[3].error?.message).toMatch(/"LOST" is not a symbol of enum shop\.events\.Status/);
  }, 90_000);
});
