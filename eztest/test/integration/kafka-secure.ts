/**
 * A security-enabled Kafka broker for the Kafka security suite (KRaft, one
 * node, apache/kafka image - the one the plain broker uses, so nothing new is
 * downloaded):
 *
 *   127.0.0.1:19093  SSL       - mutual TLS: a client certificate signed by the test CA is required
 *   127.0.0.1:19094  SASL_SSL  - PLAIN (alice / alice-secret), SCRAM-SHA-256 (bob / bob-secret) and
 *                                OAUTHBEARER (JWTs checked against a JWKS file; audience "eztest-kafka")
 *
 * Certificates (test CA, broker, client) and the JWT signing key are made
 * with openssl / node:crypto under <tmp>/eztest-it-kafka-sec and kept with
 * the container (eztest-it-kafka-sec) for fast re-runs. Set EZTEST_DOCKER=0
 * to never start it; the suite is then skipped.
 */
import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { dockerAvailable } from './brokers.js';

const run = promisify(execFile);
const NAME = 'eztest-it-kafka-sec';
const IMAGE = 'apache/kafka:3.9.1';

export interface SecureKafka {
  ssl: string;
  saslSsl: string;
  ca: string;
  clientCert: string;
  clientKey: string;
  /** PEM of the RSA key whose public half the broker trusts for OAUTHBEARER tokens. */
  jwtKey: string;
  jwtKid: string;
  dir: string;
}

async function sh(cmd: string, args: string[], cwd?: string): Promise<string> {
  const r = await run(cmd, args, { cwd, timeout: 60_000 });
  return r.stdout;
}

async function makeMaterial(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const o = (args: string[]) => sh('openssl', args, dir);
  await o(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca-key.pem', '-out', 'ca.pem', '-days', '3650', '-subj', '/CN=EZTest Test CA']);
  for (const [name, cn, san] of [['broker', 'localhost', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], ['client', 'eztest-client', 'subjectAltName=DNS:eztest-client']] as const) {
    await o(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}-key.pem`, '-out', `${name}.csr`, '-subj', `/CN=${cn}`]);
    await writeFile(join(dir, `${name}.ext`), `${san}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth,clientAuth\n`);
    await o(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca-key.pem', '-CAcreateserial', '-out', `${name}.pem`, '-days', '3650', '-extfile', `${name}.ext`]);
    // PKCS#8, as Kafka's PEM keystore wants it
    await o(['pkcs8', '-topk8', '-nocrypt', '-in', `${name}-key.pem`, '-out', `${name}-key8.pem`]);
  }
  await writeFile(join(dir, 'broker-keystore.pem'), (await readFile(join(dir, 'broker-key8.pem'), 'utf8')) + (await readFile(join(dir, 'broker.pem'), 'utf8')));
  const kid = 'eztest-kafka-key';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(join(dir, 'jwt-key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  await writeFile(join(dir, 'jwks.json'), JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }] }));
  await writeFile(join(dir, 'kid'), kid);
  await writeFile(join(dir, 'server.properties'), [
    'process.roles=broker,controller', 'node.id=1', 'controller.quorum.voters=1@localhost:19095',
    'listeners=SSL://:19093,SASL_SSL://:19094,CONTROLLER://:19095',
    'advertised.listeners=SSL://127.0.0.1:19093,SASL_SSL://127.0.0.1:19094',
    'controller.listener.names=CONTROLLER',
    'listener.security.protocol.map=CONTROLLER:PLAINTEXT,SSL:SSL,SASL_SSL:SASL_SSL',
    'inter.broker.listener.name=SSL',
    'log.dirs=/tmp/kraft-logs',
    'offsets.topic.replication.factor=1', 'transaction.state.log.replication.factor=1', 'transaction.state.log.min.isr=1',
    'group.initial.rebalance.delay.ms=0', 'num.partitions=1', 'auto.create.topics.enable=false',
    'ssl.keystore.type=PEM', 'ssl.keystore.location=/cfg/broker-keystore.pem',
    'ssl.truststore.type=PEM', 'ssl.truststore.location=/cfg/ca.pem',
    'ssl.client.auth=required', 'ssl.endpoint.identification.algorithm=',
    'listener.name.sasl_ssl.ssl.client.auth=none',
    'sasl.enabled.mechanisms=PLAIN,SCRAM-SHA-256,OAUTHBEARER',
    'listener.name.sasl_ssl.sasl.enabled.mechanisms=PLAIN,SCRAM-SHA-256,OAUTHBEARER',
    'listener.name.sasl_ssl.plain.sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required username="admin" password="admin-secret" user_admin="admin-secret" user_alice="alice-secret";',
    'listener.name.sasl_ssl.scram-sha-256.sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required;',
    'listener.name.sasl_ssl.oauthbearer.sasl.jaas.config=org.apache.kafka.common.security.oauthbearer.OAuthBearerLoginModule required;',
    'listener.name.sasl_ssl.oauthbearer.sasl.server.callback.handler.class=org.apache.kafka.common.security.oauthbearer.OAuthBearerValidatorCallbackHandler',
    'sasl.oauthbearer.jwks.endpoint.url=file:///cfg/jwks.json',
    'sasl.oauthbearer.expected.audience=eztest-kafka',
    '',
  ].join('\n'));
  // The container users (Kafka's appuser, mosquitto, rabbitmq) must read the broker material (test-only keys).
  for (const f of ['ca.pem', 'broker-keystore.pem', 'broker.pem', 'broker-key.pem', 'jwks.json', 'server.properties']) await chmod(join(dir, f), 0o644);
  await writeFile(join(dir, 'mosquitto.conf'), [
    'listener 8883', 'cafile /tls/ca.pem', 'certfile /tls/broker.pem', 'keyfile /tls/broker-key.pem',
    'require_certificate true', 'use_identity_as_username true', 'allow_anonymous false', '',
  ].join('\n'), { mode: 0o644 });
  await writeFile(join(dir, 'rabbitmq.conf'), [
    'listeners.tcp = none', 'listeners.ssl.default = 5671', 'loopback_users = none',
    'ssl_options.cacertfile = /tls/ca.pem', 'ssl_options.certfile = /tls/broker.pem', 'ssl_options.keyfile = /tls/broker-key.pem',
    'ssl_options.verify = verify_peer', 'ssl_options.fail_if_no_peer_cert = true', '',
  ].join('\n'), { mode: 0o644 });
  await chmod(dir, 0o755);
}

export async function docker(args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    return { ok: true, out: (await sh('docker', args)).trim() };
  } catch (e) {
    return { ok: false, out: String((e as { stderr?: string }).stderr ?? (e as Error).message) };
  }
}

/** The test PKI directory (CA, a broker certificate for localhost / 127.0.0.1, a client certificate), made once. */
export async function ensureTestPki(): Promise<string> {
  const dir = join(tmpdir(), 'eztest-it-kafka-sec');
  if (!existsSync(join(dir, 'rabbitmq.conf'))) {
    // Containers built on older material would not trust the new certificates.
    for (const n of [NAME, 'eztest-it-mqtt-tls', 'eztest-it-rabbit-tls']) await docker(['rm', '-f', n]);
    await makeMaterial(dir);
  }
  return dir;
}

export async function secureKafkaBroker(probe: (k: SecureKafka) => Promise<boolean>): Promise<SecureKafka | undefined> {
  if (!(await dockerAvailable())) return undefined;
  const dir = await ensureTestPki();
  const k: SecureKafka = {
    ssl: '127.0.0.1:19093', saslSsl: '127.0.0.1:19094', dir,
    ca: await readFile(join(dir, 'ca.pem'), 'utf8'), clientCert: await readFile(join(dir, 'client.pem'), 'utf8'), clientKey: await readFile(join(dir, 'client-key.pem'), 'utf8'),
    jwtKey: await readFile(join(dir, 'jwt-key.pem'), 'utf8'), jwtKid: (await readFile(join(dir, 'kid'), 'utf8')).trim(),
  };
  const fresh = await docker(['inspect', '-f', '{{.State.Running}}', NAME]);
  if (fresh.ok && fresh.out !== 'true') await docker(['start', NAME]);
  if (!fresh.ok) {
    if (!(await docker(['image', 'inspect', IMAGE])).ok) return undefined;
    const clusterId = randomUUID().replace(/-/g, '').slice(0, 22);
    const script = [
      `/opt/kafka/bin/kafka-storage.sh format -t ${clusterId} -c /cfg/server.properties --ignore-formatted --add-scram 'SCRAM-SHA-256=[name=bob,password=bob-secret]'`,
      'exec /opt/kafka/bin/kafka-server-start.sh /cfg/server.properties',
    ].join(' && ');
    const r = await docker(['run', '-d', '--name', NAME, '-p', '19093:19093', '-p', '19094:19094', '-v', `${dir}:/cfg:ro`,
      '-e', 'KAFKA_HEAP_OPTS=-Xmx384m -Xms128m', '-e', 'KAFKA_OPTS=-Dorg.apache.kafka.sasl.oauthbearer.allowed.urls=file:///cfg/jwks.json',
      '--entrypoint', 'bash', IMAGE, '-c', script]);
    if (!r.ok && !/already in use/.test(r.out)) {
      console.warn(`[eztest] could not start ${NAME}: ${r.out}`);
      return undefined;
    }
  }
  const end = Date.now() + 120_000;
  while (Date.now() < end) {
    if (await probe(k).catch(() => false)) return k;
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.warn(`[eztest] ${NAME} did not become ready (docker logs ${NAME})`);
  return undefined;
}
