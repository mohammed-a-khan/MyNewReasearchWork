/**
 * AMQP 1.0 against a real broker: RabbitMQ 4 (native AMQP 1.0), plain and
 * TLS. The broker comes from EZTEST_AMQP10_URL (and EZTEST_AMQP10_TLS_URL +
 * EZTEST_AMQP10_CA for TLS), or from a container this suite starts when
 * Docker is running and rabbitmq:4.1-alpine is already pulled (tests never
 * download images). Queues are declared for the test with AMQP 0-9-1
 * (amqplib), the way an application would own them.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { loadConfig } from '../../src/config/index.js';
import { flattenStepResults, type JourneyResult } from '../../src/core/index.js';
import { createEngine } from '../../src/engine/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { Amqp10BusDriver } from '../../src/integration/bus/amqp10.js';
import { Amqp10Connection } from '../../src/integration/bus/amqp10-client.js';
import type { BusMessage } from '../../src/integration/bus/types.js';
import { clientAvailable, ensureContainer } from './brokers.js';

const TLS_DIR = join(tmpdir(), 'eztest-rabbit4-tls');

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    s.setTimeout(1000);
    s.on('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.on('timeout', () => {
      s.destroy();
      resolve(false);
    });
    s.on('error', () => resolve(false));
  });
}

/** Certificates and config for the container's TLS listener (made once with openssl). */
function tlsFiles(): boolean {
  try {
    if (!existsSync(join(TLS_DIR, 'server.pem'))) {
      mkdirSync(TLS_DIR, { recursive: true });
      const o = (args: string[]) => execFileSync('openssl', args, { cwd: TLS_DIR, stdio: 'ignore' });
      o(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '30', '-subj', '/CN=eztest-amqp10-ca']);
      o(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost']);
      writeFileSync(join(TLS_DIR, 'ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
      o(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '30', '-extfile', 'ext.cnf']);
    }
    // The broker runs as another user in the container: it must be able to read the key.
    execFileSync('sh', ['-c', 'chmod 644 *.pem *.key'], { cwd: TLS_DIR, stdio: 'ignore' });
    writeFileSync(join(TLS_DIR, 'rabbitmq.conf'), [
      'listeners.ssl.default = 5671', 'ssl_options.cacertfile = /etc/rabbitmq/certs/ca.pem', 'ssl_options.certfile = /etc/rabbitmq/certs/server.pem',
      'ssl_options.keyfile = /etc/rabbitmq/certs/server.key', 'ssl_options.verify = verify_none', 'ssl_options.fail_if_no_peer_cert = false', 'loopback_users = none', '',
    ].join('\n'));
    return true;
  } catch {
    return false;
  }
}

async function rabbit4(): Promise<{ url: string; tlsUrl?: string; ca?: string } | undefined> {
  if (process.env.EZTEST_AMQP10_URL) return { url: process.env.EZTEST_AMQP10_URL, tlsUrl: process.env.EZTEST_AMQP10_TLS_URL, ca: process.env.EZTEST_AMQP10_CA };
  if (!tlsFiles()) return undefined;
  const ok = await ensureContainer('eztest-it-rabbit4', 'rabbitmq:4.1-alpine', [
    '-p', '15674:5672', '-p', '15676:5671', '-v', `${join(TLS_DIR, 'rabbitmq.conf')}:/etc/rabbitmq/conf.d/20-eztest.conf:ro`, '-v', `${TLS_DIR}:/etc/rabbitmq/certs:ro`,
  ], async () => {
    if (!(await portOpen(15674))) return false;
    const c = await Amqp10Connection.connect({ host: '127.0.0.1', port: 15674, sasl: { username: 'guest', password: 'guest' }, hostname: 'vhost:/', connectTimeoutMs: 3000 });
    await c.close();
    return true;
  }, 120_000);
  return ok ? { url: 'amqp://guest:guest@127.0.0.1:15674', tlsUrl: 'amqps://guest:guest@localhost:15676', ca: join(TLS_DIR, 'ca.pem') } : undefined;
}

const hasAmqplib = await clientAvailable('amqplib');
const broker = hasAmqplib ? await rabbit4() : undefined;
if (!broker) console.warn('[eztest] AMQP 1.0 live suite skipped: set EZTEST_AMQP10_URL, or run Docker with rabbitmq:4.1-alpine pulled');

/** Declare queues the way the application would (AMQP 0-9-1 on the same broker). */
async function declare(...queues: string[]): Promise<void> {
  const pkg: string = 'amqplib';
  const amqplib = ((await import(pkg)) as { default: unknown }).default as unknown as { connect(u: string): Promise<{ createChannel(): Promise<{ assertQueue(q: string, o: object): Promise<unknown>; purgeQueue(q: string): Promise<unknown> }>; close(): Promise<void> }> };
  const c = await amqplib.connect(broker!.url);
  const ch = await c.createChannel();
  for (const q of queues) {
    await ch.assertQueue(q, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
    await ch.purgeQueue(q);
  }
  await c.close();
}

const q = (name: string) => ({ type: 'queue' as const, name });

describe.skipIf(!broker)('AMQP 1.0 (RabbitMQ 4, real broker)', () => {
  let d: Amqp10BusDriver;
  const Q1 = `ez10.orders.${randomUUID().slice(0, 8)}`;
  const Q2 = `ez10.big.${randomUUID().slice(0, 8)}`;
  const Q3 = `ez10.flow.${randomUUID().slice(0, 8)}`;
  beforeAll(async () => {
    await declare(Q1, Q2, Q3);
    d = new Amqp10BusDriver('rabbit4', { url: broker!.url, addressing: 'rabbitmq' });
  });
  afterAll(async () => {
    await d?.close();
  });

  it('publishes with outcome, filters, settles matched messages and releases the rest back to the queue', async () => {
    const r = await d.publish(q(Q1), { payload: '{"orderId": 1, "total": 10}', key: 'orders.created', headers: { source: 'eztest', tenant: 'acme' }, correlationId: 'corr-1' });
    expect(r.messageId).toMatch(/^[0-9a-f-]{36}$/);
    await d.publish(q(Q1), { payload: '{"orderId": 2, "total": 20}', headers: { source: 'other' } });
    const sub = await d.subscribe(q(Q1));
    const m = await sub.next((x: BusMessage) => x.headers.source === 'eztest', 10_000);
    expect(m).toMatchObject({ destination: Q1, payload: '{"orderId": 1, "total": 10}', key: 'orders.created', correlationId: 'corr-1', messageId: r.messageId, headers: { source: 'eztest', tenant: 'acme' }, routingKey: Q1 });
    // Wait for the second one to arrive, then close without matching it: it goes back to the queue.
    expect((await sub.next((x) => x.headers.source === 'nobody', 1500))).toBeUndefined();
    expect(sub.messages.length).toBe(2);
    await sub.close();
    const again = await d.subscribe(q(Q1));
    const back = await again.next(() => true, 10_000);
    expect(back?.payload).toBe('{"orderId": 2, "total": 20}');
    await again.close();
    // Both are settled now (each matched a wait once): the queue is empty.
    expect(await d.purge(q(Q1))).toBe(0);
  });

  it('a 300 KB message crosses the 128 KB frame limit both ways (multi-frame transfers)', async () => {
    const payload = JSON.stringify({ blob: 'x'.repeat(300_000) });
    await d.publish(q(Q2), { payload });
    const sub = await d.subscribe(q(Q2));
    const m = await sub.next(() => true, 15_000);
    expect(m?.payload.length).toBe(payload.length);
    expect(m?.payload === payload).toBe(true);
    await sub.close();
  });

  it('link credit: 250 messages arrive through a 100-message credit window', async () => {
    for (let i = 0; i < 250; i++) await d.publish(q(Q3), { payload: String(i) });
    const sub = await d.subscribe(q(Q3), { consumeMatched: false });
    const deadline = Date.now() + 20_000;
    while (sub.messages.length < 250 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(sub.messages.map((m) => Number(m.payload))).toEqual(Array.from({ length: 250 }, (_, i) => i));
    await sub.close();
  });

  it('missing queues and wrong credentials are reported as such', async () => {
    await expect(d.publish(q(`ez10.missing.${randomUUID()}`), { payload: 'x' })).rejects.toMatchObject({ code: 'AMQP10_NOT_FOUND' });
    await expect(d.subscribe(q(`ez10.missing.${randomUUID()}`))).rejects.toThrow(/does not exist on AMQP 1\.0 broker "rabbit4".*amqp:not-found/);
    const bad = new Amqp10BusDriver('rabbit4', { url: broker!.url.replace('guest:guest', 'guest:wrong'), addressing: 'rabbitmq' });
    await expect(bad.publish(q(Q1), { payload: 'x' })).rejects.toMatchObject({ code: 'BUS_AUTH' });
    await bad.close();
  });

  it.skipIf(!broker?.tlsUrl)('TLS (amqps) with the broker CA', async () => {
    const t = new Amqp10BusDriver('rabbit4-tls', { url: broker!.tlsUrl!, addressing: 'rabbitmq', ca: broker!.ca });
    try {
      await t.publish(q(Q1), { payload: 'over tls' });
      const sub = await t.subscribe(q(Q1));
      expect((await sub.next(() => true, 10_000))?.payload).toBe('over tls');
      await sub.close();
    } finally {
      await t.close();
    }
    // Without the CA the certificate is refused.
    const untrusted = new Amqp10BusDriver('rabbit4-tls', { url: broker!.tlsUrl!, addressing: 'rabbitmq' });
    await expect(untrusted.publish(q(Q1), { payload: 'x' })).rejects.toThrow(/self-signed|unable to verify|certificate/i);
    await untrusted.close();
  });

  it('journeys: the same publish/wait/filter steps with transport amqp10, secrets masked in evidence', async () => {
    const queue = `ez10.journey.${randomUUID().slice(0, 8)}`;
    await declare(queue);
    const dir = await mkdtemp(join(tmpdir(), 'eztest-amqp10-'));
    await mkdir(join(dir, 'schemas'), { recursive: true });
    await writeFile(join(dir, 'schemas', 'order.json'), JSON.stringify({ type: 'object', required: ['orderId', 'total'], properties: { orderId: { type: 'integer' }, total: { type: 'number' } } }));
    const SECRET = 'tok-amqp10-5e3c1a';
    await writeFile(join(dir, 'eztest.config.yaml'), toYaml({
      outputDir: 'results', healing: { enabled: false }, vars: { partnerToken: SECRET },
      messaging: { timeoutMs: 15_000, brokers: { artemisLike: { type: 'amqp10', url: broker!.url.replace('guest:guest@', ''), username: 'guest', password: 'guest', addressing: 'rabbitmq' } } },
    }));
    const ez = `Journey: AMQP 1.0 round trip
Set variable orderId to 7000 + random(1, 999)
Start listening on AMQP 1.0 queue "${queue}" on artemisLike as events
Publish message '{"orderId": \${orderId}, "total": 12.5, "token": "\${partnerToken}"}' to AMQP 1.0 queue "${queue}" on artemisLike with headers "source" = "eztest" with correlation id "c-\${orderId}"
Wait for a message in events where "$.orderId" = \${orderId} and header "source" = "eztest" matching schema "schemas/order.json" within 15 s as received
  Expect response received "$.total" equals "12.5"
Expect \${received_meta.correlationId} equals "c-\${orderId}"
Expect no message in events where "$.orderId" = 1 within 1 s
Stop listening to events
Publish message '{"n": 1}' to RabbitMQ queue "${queue}"
Wait for a message on RabbitMQ queue "${queue}" where "$.n" = 1 within 15 s
`;
    const loaded = await loadConfig({ cwd: dir, environment: {} });
    const engine = await createEngine(loaded, { cwd: dir, runOptions: { stepTimeoutMs: 20_000 } });
    let j: JourneyResult;
    let runDir: string;
    try {
      const run = await engine.run([parseEzScript(ez)]);
      j = run.journeys[0];
      runDir = join(engine.runOptions.outputDir, run.runId);
    } finally {
      await engine.close();
    }
    const text = flattenStepResults(j.steps).map(({ result: s }) => `${s.stepId}: ${s.status}${s.error ? ` (${s.error.message})` : ''}`).join('\n');
    expect(j.status, text).toBe('passed');
    const evidence: string[] = [];
    const walk = async (p: string): Promise<void> => {
      for (const e of await readdir(p, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(join(p, e.name));
        else if (/\.(json|jsonl|txt|html)$/.test(e.name)) evidence.push(await readFile(join(p, e.name), 'utf8'));
      }
    };
    await walk(runDir);
    expect(evidence.join('\n')).not.toContain(SECRET);
    expect(evidence.join('\n')).toContain('"kind": "amqp10"');
  });
});
