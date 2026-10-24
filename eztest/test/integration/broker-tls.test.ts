/**
 * MQTT and AMQP over TLS against REAL brokers with TLS enabled (the images
 * the plain suites use, so nothing new is downloaded):
 *
 *   eztest-it-mqtt-tls    Mosquitto, mqtts on 127.0.0.1:18883, client certificate required
 *   eztest-it-rabbit-tls  RabbitMQ, amqps on 127.0.0.1:15671 only, verify_peer + fail_if_no_peer_cert
 *
 * Both use the test PKI of the Kafka security suite (a private CA, a server
 * certificate for localhost / 127.0.0.1, a client certificate). Each broker
 * round-trips a message with the CA, client certificate and key from broker
 * config (files relative to the project), and refuses: no client
 * certificate, an untrusted server (no CA), and a servername the server
 * certificate does not name.
 */
import { describe, expect, it } from '../support/testkit.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { BrokerSchema } from '../../src/integration/config.js';
import { createBusDriver } from '../../src/integration/runtime.js';
import { MqttBusDriver } from '../../src/integration/bus/mqtt.js';
import { AmqpBusDriver } from '../../src/integration/bus/amqp.js';
import type { BusDriver } from '../../src/integration/bus/types.js';
import { clientAvailable, dockerAvailable } from './brokers.js';
import { docker, ensureTestPki } from './kafka-secure.js';

async function tlsUp(port: number, pki: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = tlsConnect({ host: '127.0.0.1', port, ca: readFileSync(join(pki, 'ca.pem')), cert: readFileSync(join(pki, 'client.pem')), key: readFileSync(join(pki, 'client-key.pem')), servername: 'localhost' }, () => {
      s.end();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.setTimeout(2000, () => {
      s.destroy();
      resolve(false);
    });
  });
}

async function start(name: string, image: string, args: string[], port: number, pki: string, cmd: string[] = []): Promise<boolean> {
  const st = await docker(['inspect', '-f', '{{.State.Running}}', name]);
  if (st.ok && st.out !== 'true') await docker(['start', name]);
  if (!st.ok) {
    if (!(await docker(['image', 'inspect', image])).ok) return false;
    const r = await docker(['run', '-d', '--name', name, ...args, image, ...cmd]);
    if (!r.ok && !/already in use/.test(r.out)) return false;
  }
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    if (await tlsUp(port, pki)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

const pki = (await dockerAvailable()) ? await ensureTestPki() : undefined;
const mqttOk = !!pki && (await clientAvailable('mqtt')) && (await start('eztest-it-mqtt-tls', 'eclipse-mosquitto:2.0.20', ['-p', '18883:8883', '-v', `${pki}:/tls:ro`], 18883, pki, ['mosquitto', '-c', '/tls/mosquitto.conf']).catch(() => false));
const amqpOk = !!pki && (await clientAvailable('amqplib')) && (await start('eztest-it-rabbit-tls', 'rabbitmq:3.13-alpine', ['-p', '15671:5671', '-v', `${pki}:/tls:ro`, '-v', `${pki}/rabbitmq.conf:/etc/rabbitmq/conf.d/90-eztest-tls.conf:ro`], 15671, pki).catch(() => false));
if (!mqttOk) console.warn('[eztest] MQTT TLS suite skipped (needs Docker and the eclipse-mosquitto:2.0.20 image)');
if (!amqpOk) console.warn('[eztest] AMQP TLS suite skipped (needs Docker and the rabbitmq:3.13-alpine image)');

/** Publish one message and read it back. */
async function roundTrip(d: BusDriver, dest: { type: 'topic' | 'queue'; name: string }): Promise<string | undefined> {
  const sub = await d.subscribe(dest, { fromTimestamp: Date.now() - 1000 });
  const body = `tls-${randomUUID().slice(0, 6)}`;
  await d.publish(dest, { payload: body });
  const m = await sub.next((x) => x.payload === body, 10_000);
  await sub.close();
  return m?.payload;
}

const files = (p: string) => ({ ca: join(p, 'ca.pem'), cert: join(p, 'client.pem'), key: join(p, 'client-key.pem') });

describe.skipIf(!mqttOk)('MQTT over TLS (live Mosquitto, client certificate required)', () => {
  it('round-trips with CA, client certificate and key from broker config', async () => {
    const d = createBusDriver('iot', BrokerSchema.parse({ type: 'mqtt', url: 'mqtts://127.0.0.1:18883', tls: { ...files(pki!), servername: 'localhost' } }), '/');
    try {
      expect(await roundTrip(d, { type: 'topic', name: `eztest/tls/${randomUUID().slice(0, 6)}` })).toMatch(/^tls-/);
    } finally {
      await d.close();
    }
  }, 60_000);

  it('refuses without a client certificate, without the CA, and with a servername the certificate does not name', async () => {
    const ca = readFileSync(join(pki!, 'ca.pem'));
    const cert = readFileSync(join(pki!, 'client.pem'));
    const key = readFileSync(join(pki!, 'client-key.pem'));
    const cases: Array<[string, MqttBusDriver, RegExp]> = [
      ['no client certificate', new MqttBusDriver('a', { url: 'mqtts://127.0.0.1:18883', tls: { ca } }), /Cannot connect to MQTT broker "a"/],
      ['no CA', new MqttBusDriver('b', { url: 'mqtts://127.0.0.1:18883', tls: { cert, key } }), /self[- ]signed|unable to verify|certificate/i],
      ['wrong servername', new MqttBusDriver('c', { url: 'mqtts://127.0.0.1:18883', tls: { ca, cert, key, servername: 'mq.other.example' } }), /does not match certificate's altnames|Hostname\/IP/i],
    ];
    for (const [why, d, re] of cases) {
      try {
        await expect(d.publish({ type: 'topic', name: 'x' }, { payload: 'x' }), why).rejects.toThrow(re);
      } finally {
        await d.close();
      }
    }
  }, 60_000);
});

describe.skipIf(!amqpOk)('AMQP over TLS (live RabbitMQ, amqps only, verify_peer)', () => {
  it('round-trips with CA, client certificate and key from broker config', async () => {
    const d = createBusDriver('rabbit', BrokerSchema.parse({ type: 'amqp', url: 'amqps://guest:guest@127.0.0.1:15671', declare: true, tls: { ...files(pki!), servername: 'localhost' } }), '/');
    try {
      expect(await roundTrip(d, { type: 'queue', name: `eztest.tls.${randomUUID().slice(0, 6)}` })).toMatch(/^tls-/);
    } finally {
      await d.close();
    }
  }, 60_000);

  it('refuses without a client certificate, without the CA, and with a servername the certificate does not name', async () => {
    const ca = readFileSync(join(pki!, 'ca.pem'));
    const cert = readFileSync(join(pki!, 'client.pem'));
    const key = readFileSync(join(pki!, 'client-key.pem'));
    const url = 'amqps://guest:guest@127.0.0.1:15671';
    const cases: Array<[string, AmqpBusDriver, RegExp]> = [
      ['no client certificate', new AmqpBusDriver('a', { url, tls: { ca } }), /Cannot connect to AMQP broker "a"/],
      ['no CA', new AmqpBusDriver('b', { url, tls: { cert, key } }), /self[- ]signed|unable to verify|certificate/i],
      ['wrong servername', new AmqpBusDriver('c', { url, tls: { ca, cert, key, servername: 'mq.other.example' } }), /does not match certificate's altnames|Hostname\/IP/i],
    ];
    for (const [why, d, re] of cases) {
      try {
        await expect(d.publish({ type: 'queue', name: 'x' }, { payload: 'x' }), why).rejects.toThrow(re);
      } finally {
        await d.close();
      }
    }
  }, 60_000);
});
