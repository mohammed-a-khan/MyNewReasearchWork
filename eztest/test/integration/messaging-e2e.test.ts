/**
 * Messaging steps against REAL brokers (Kafka, RabbitMQ/AMQP 0-9-1, MQTT,
 * IBM MQ through its REST messaging API), run through the EZTest engine:
 * publish from a payload file, listen before an action, wait with JSONPath /
 * header / correlation-id filters and a JSON Schema, capture variables,
 * expect no message, secrets masked in evidence. The Kafka suite also runs
 * the G14 acceptance flow: an order placed in the demo UI emits an event the
 * journey asserts, and a reply the journey publishes shows up in the UI.
 *
 * Brokers come from env vars or Docker (test/integration/brokers.ts); a suite
 * whose broker is unavailable is skipped with a note.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stringify as toYaml } from 'yaml';
import { loadConfig } from '../../src/config/index.js';
import { flattenStepResults, type JourneyResult } from '../../src/core/index.js';
import { createEngine } from '../../src/engine/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { KafkaBusDriver } from '../../src/integration/bus/kafka.js';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { amqpBroker, ibmMqBroker, kafkaBroker, mqttBroker, skipNote } from './brokers.js';

const [kafka, amqp, mqtt, ibmmq] = await Promise.all([kafkaBroker(), amqpBroker(), mqttBroker(), ibmMqBroker()]);
for (const [b, n, env] of [[kafka, 'Kafka', 'EZTEST_KAFKA_BROKERS'], [amqp, 'AMQP', 'EZTEST_AMQP_URL'], [mqtt, 'MQTT', 'EZTEST_MQTT_URL'], [ibmmq, 'IBM MQ', 'EZTEST_IBMMQ_URL']] as const) {
  if (!b) console.warn(`[eztest] ${skipNote(n, env)}`);
}

const SECRET = 'tok-9f8e7d6c5b4a-secret';
const ORDER_SCHEMA = {
  type: 'object',
  required: ['orderId', 'total', 'lines'],
  properties: { orderId: { type: 'integer' }, total: { type: 'number' }, lines: { type: 'array', minItems: 1, items: { type: 'object', required: ['sku', 'qty'] } } },
};

function steps(j: JourneyResult): string {
  return flattenStepResults(j.steps).map(({ result: s }) => `${s.stepId}: ${s.status}${s.error ? ` (${s.error.message})` : ''}`).join('\n');
}

async function project(brokers: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'eztest-msg-'));
  await mkdir(join(dir, 'payloads'), { recursive: true });
  await mkdir(join(dir, 'schemas'), { recursive: true });
  await writeFile(join(dir, 'payloads', 'order.json'), '{"orderId": ${orderId}, "total": 99.5, "token": "${partnerToken}", "lines": [{"sku": "SKU-200", "qty": 2}]}');
  await writeFile(join(dir, 'schemas', 'order.json'), JSON.stringify(ORDER_SCHEMA));
  await writeFile(join(dir, 'eztest.config.yaml'), toYaml({
    outputDir: 'results', healing: { enabled: false }, vars: { partnerToken: SECRET },
    messaging: { brokers, timeoutMs: 20_000 }, ...extra,
  }));
  return dir;
}

async function runJourney(dir: string, ez: string, extra: { baseUrl?: string } = {}): Promise<{ j: JourneyResult; runDir: string }> {
  const loaded = await loadConfig({ cwd: dir, environment: {} });
  const engine = await createEngine(loaded, { cwd: dir, runOptions: { stepTimeoutMs: 25_000, ...(extra.baseUrl ? { baseUrl: extra.baseUrl } : {}) } });
  try {
    const run = await engine.run([parseEzScript(ez)]);
    return { j: run.journeys[0], runDir: join(engine.runOptions.outputDir, run.runId) };
  } finally {
    await engine.close();
  }
}

/** Every evidence text file of a run, concatenated (to prove secrets are masked). */
async function allEvidence(runDir: string): Promise<string> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(json|jsonl|txt|html)$/.test(e.name)) out.push(await readFile(p, 'utf8'));
    }
  };
  await walk(runDir);
  return out.join('\n');
}

/** The journey every broker runs: listen, publish from a file, filtered wait with schema, capture, expect none. */
function roundTrip(kind: string, destType: string, dest: string, broker: string): string {
  return `Journey: ${kind} round trip
Set variable orderId to 4000 + random(1, 999)
Set variable corr to "c-" + string(orderId)
Start listening on ${kind} ${destType} "${dest}" on ${broker} as events
Publish message from file "payloads/order.json" to ${kind} ${destType} "${dest}" on ${broker} with key "\${orderId}" with headers "source" = "eztest", "auth" = "\${partnerToken}" with correlation id "\${corr}" as sent
Wait for a message in events where "$.orderId" = \${orderId} and header "source" = "eztest" matching schema "schemas/order.json" within 20 s as received
  Expect response received "$.total" equals "99.5"
  Expect response received "$.lines[0].sku" equals "SKU-200"
Capture "$.lines[0].qty" from received as qty
Expect \${qty} equals "2"
Expect \${received_meta.correlationId} equals "\${corr}"
Expect no message in events where "$.orderId" = 1 within 1 s
Stop listening to events
`;
}

describe.skipIf(!kafka)('Kafka (real broker)', () => {
  const topic = `orders-${randomUUID().slice(0, 8)}`;
  const replies = `order-replies-${randomUUID().slice(0, 8)}`;
  let demo: DemoServer;
  let side: KafkaBusDriver;
  let stop = false;

  beforeAll(async () => {
    side = new KafkaBusDriver('side', { brokers: kafka! });
    demo = await startDemoApp({ onEvent: async (_t, e) => void (await side.publish({ type: 'topic', name: topic }, { payload: JSON.stringify(e), key: String(e.orderId) })) });
    // The "billing service": consumes replies and shows them on the order page.
    const sub = await side.subscribe({ type: 'topic', name: replies });
    void (async () => {
      while (!stop) {
        const m = await sub.next(() => true, 500).catch(() => undefined);
        if (!m) continue;
        const r = JSON.parse(m.payload) as { orderNumber: string; text: string };
        demo.notify(r.orderNumber, r.text);
      }
      await sub.close();
    })();
  });
  afterAll(async () => {
    stop = true;
    await new Promise((r) => setTimeout(r, 700));
    await side?.close();
    await demo?.close();
  });

  it('publishes, listens, filters by JSONPath/header/correlation id, validates the schema and captures variables', async () => {
    const dir = await project({ bus: { type: 'kafka', brokers: kafka } });
    const { j, runDir } = await runJourney(dir, roundTrip('Kafka', 'topic', `rt-${randomUUID().slice(0, 8)}`, 'bus'));
    expect(j.status, steps(j)).toBe('passed');
    const ev = await allEvidence(runDir);
    expect(ev).toContain('SKU-200');
    expect(ev).not.toContain(SECRET);
  });

  it('finds an event emitted just before the wait (time-based seek, no listener)', async () => {
    const dir = await project({ bus: { type: 'kafka', brokers: kafka } });
    const t = `seek-${randomUUID().slice(0, 8)}`;
    const { j } = await runJourney(dir, `Journey: Kafka lookback
Publish message '{"orderId": 77, "status": "PAID"}' to Kafka topic "${t}" with key "77"
Wait for a message on Kafka topic "${t}" where key = "77" and "$.status" = "PAID" within 15 s as paid
  Expect \${paid.orderId} equals "77"
`);
    expect(j.status, steps(j)).toBe('passed');
  });

  it('fails with the filter and what did arrive when no message matches', async () => {
    const dir = await project({ bus: { type: 'kafka', brokers: kafka } });
    const t = `miss-${randomUUID().slice(0, 8)}`;
    const { j } = await runJourney(dir, `Journey: Kafka miss
Publish message '{"orderId": 1}' to Kafka topic "${t}"
Wait for a message on Kafka topic "${t}" where "$.orderId" = 2 within 3 s as nope
`);
    expect(j.status).toBe('failed');
    const msg = flattenStepResults(j.steps).map(({ result: s }) => s.error?.message ?? '').join(' ');
    expect(msg).toMatch(/No message on Kafka topic ".+" on bus matched \$\.orderId equals 2 within 3 s; 1 other message\(s\) arrived/);
  });

  it('G14 acceptance: an order placed in the UI emits the Kafka event, and a published reply shows in the UI', async () => {
    const dir = await project({ bus: { type: 'kafka', brokers: kafka } });
    const { j } = await runJourney(dir, `Journey: Order event round trip
Start listening on Kafka topic "${topic}" as orderEvents
Open /login
Type "bob" into the Username field
Type "Builder#2" into the Password field
Click the "Sign in" button
Go to /orders/new
Select "Gadget (49.50)" from the Product dropdown
Fill the Quantity field with 2
Click the "Submit order" button
Capture the text of testid=order-number as orderNumber
Wait for a message in orderEvents where "$.orderNumber" = "\${orderNumber}" and "$.type" = "order.created" within 20 s as created
  Expect response created "$.total" equals "99"
  Expect response created "$.createdBy" equals "bob"
Publish message '{"orderNumber": "\${orderNumber}", "text": "Payment received for \${orderNumber}"}' to Kafka topic "${replies}" with key "\${orderNumber}"
Reload the page [retry=20 every=500ms]
  Expect page contains "Payment received for \${orderNumber}"
`, { baseUrl: demo.url });
    expect(j.status, steps(j)).toBe('passed');
  });
});

describe.skipIf(!amqp)('RabbitMQ / AMQP 0-9-1 (real broker)', () => {
  it('queue round trip with schema, capture and expect-none', async () => {
    const dir = await project({ rabbit: { type: 'amqp', url: amqp } });
    const { j, runDir } = await runJourney(dir, roundTrip('RabbitMQ', 'queue', `eztest.rt.${randomUUID().slice(0, 8)}`, 'rabbit'));
    expect(j.status, steps(j)).toBe('passed');
    expect(await allEvidence(runDir)).not.toContain(SECRET);
  });

  it('exchange with routing keys, waiting without a listener on a queue, and purge', async () => {
    const dir = await project({ rabbit: { type: 'amqp', url: amqp } });
    const q = `eztest.work.${randomUUID().slice(0, 8)}`;
    const { j } = await runJourney(dir, `Journey: AMQP exchange
Start listening on RabbitMQ exchange "amq.topic" as created
Publish message '{"id": 5, "event": "created"}' to RabbitMQ exchange "amq.topic" with routing key "order.created"
Publish message '{"id": 6, "event": "deleted"}' to RabbitMQ exchange "amq.topic" with routing key "order.deleted"
Wait for a message in created where "$.event" = "created" within 10 s as c
  Expect \${c_meta.routingKey} equals "order.created"
Publish message '{"job": 1}' to RabbitMQ queue "${q}"
Wait for a message on RabbitMQ queue "${q}" where "$.job" = 1 within 10 s as job
Publish message '{"job": 2}' to RabbitMQ queue "${q}"
Purge RabbitMQ queue "${q}"
Expect no message on RabbitMQ queue "${q}" within 1 s
`);
    expect(j.status, steps(j)).toBe('passed');
  });
});

describe.skipIf(!mqtt)('MQTT (real broker)', () => {
  it('topic round trip with wildcard listener, QoS and capture', async () => {
    const dir = await project({ iot: { type: 'mqtt', url: mqtt } });
    const base = `eztest/${randomUUID().slice(0, 8)}`;
    const { j } = await runJourney(dir, `Journey: MQTT sensors
Start listening on MQTT topic "${base}/+/temperature" as temps
Publish message '{"sensor": "s1", "celsius": 21.5}' to MQTT topic "${base}/s1/temperature" with QoS 1 with correlation id "r-1"
Wait for a message in temps where "$.sensor" = "s1" and "$.celsius" > 20 within 10 s as t
  Expect \${t_meta.destination} equals "${base}/s1/temperature"
  Expect \${t_meta.correlationId} equals "r-1"
`);
    expect(j.status, steps(j)).toBe('passed');
    const dir2 = await project({ iot: { type: 'mqtt', url: mqtt } });
    const r2 = await runJourney(dir2, roundTrip('MQTT', 'topic', `${base}/orders`, 'iot'));
    expect(r2.j.status, steps(r2.j)).toBe('passed');
  });
});

describe.skipIf(!ibmmq)('IBM MQ via the REST messaging API (real queue manager)', () => {
  it('put and get with correlation id selector and JSONPath filter (non-matching messages are put back)', async () => {
    const dir = await project({ qm1: { type: 'ibmmq', ...ibmmq, insecure: true } });
    const { j } = await runJourney(dir, `Journey: IBM MQ
Purge IBM MQ queue "DEV.QUEUE.2"
Put message '{"order": 1}' on IBM MQ queue "DEV.QUEUE.2" with correlation id "eztest-a"
Put message '{"order": 2}' on IBM MQ queue "DEV.QUEUE.2" with correlation id "eztest-b"
Wait for a message on IBM MQ queue "DEV.QUEUE.2" where correlation id = "eztest-b" within 10 s as b
  Expect \${b.order} equals "2"
Wait for a message on IBM MQ queue "DEV.QUEUE.2" where "$.order" = 1 within 10 s as a
  Expect \${a_meta.correlationId} equals "eztest-a"
Expect no message on IBM MQ queue "DEV.QUEUE.2" within 2 s
`);
    expect(j.status, steps(j)).toBe('passed');
  });
});
