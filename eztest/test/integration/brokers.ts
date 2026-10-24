/**
 * Real brokers for the messaging and file-transfer e2e suites. Each broker
 * comes from an environment variable when set, otherwise from a Docker
 * container this helper starts (only when Docker is running and the image is
 * already pulled: tests never download images). Without either, the suite is
 * skipped with a message saying how to enable it.
 *
 *   EZTEST_KAFKA_BROKERS=localhost:9092
 *   EZTEST_AMQP_URL=amqp://guest:guest@localhost:5672
 *   EZTEST_MQTT_URL=mqtt://localhost:1883
 *   EZTEST_IBMMQ_URL=https://app:passw0rd@localhost:9443?qmgr=QM1   (REST messaging API; self-signed certificate accepted)
 *   EZTEST_SFTP_URL=sftp://ez:ezpass@localhost:2222
 *   EZTEST_DOCKER=0  never start containers
 *
 * Containers are named eztest-it-* and left running for fast re-runs
 * (`docker rm -f $(docker ps -aq --filter name=eztest-it-)` removes them).
 */
import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function docker(args: string[], timeoutMs = 20_000): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await run('docker', args, { timeout: timeoutMs });
    return { ok: true, out: r.stdout.trim() };
  } catch (e) {
    return { ok: false, out: String((e as { stderr?: string }).stderr ?? (e as Error).message) };
  }
}

let dockerOk: Promise<boolean> | undefined;
export function dockerAvailable(): Promise<boolean> {
  if (process.env.EZTEST_DOCKER === '0') return Promise.resolve(false);
  return (dockerOk ??= docker(['info', '--format', '{{.ServerVersion}}'], 8000).then((r) => r.ok));
}

function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
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

async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** Start (or reuse) a container; resolves true once `ready` says so. */
export async function ensureContainer(name: string, image: string, args: string[], ready: () => Promise<boolean>, timeoutMs = 120_000, cmd: string[] = []): Promise<boolean> {
  if (!(await dockerAvailable())) return false;
  const state = await docker(['inspect', '-f', '{{.State.Running}}', name]);
  if (state.ok && state.out === 'true') return until(ready, timeoutMs);
  if (state.ok) {
    await docker(['start', name]);
    return until(ready, timeoutMs);
  }
  if (!(await docker(['image', 'inspect', image])).ok) return false;
  const r = await docker(['run', '-d', '--name', name, ...args, image, ...cmd], 60_000);
  // Another test file may have started it at the same moment.
  if (!r.ok && !/already in use/.test(r.out)) return false;
  return until(ready, timeoutMs);
}

/** True when an optional client library is installed (the suite is skipped otherwise). */
export async function clientAvailable(pkg: string): Promise<boolean> {
  const spec: string = pkg;
  try {
    await import(spec);
    return true;
  } catch {
    console.warn(`[eztest] ${pkg} is not installed; its e2e suite is skipped`);
    return false;
  }
}

export interface Brokers {
  kafka?: string[];
  amqp?: string;
  mqtt?: string;
  ibmmq?: { url: string; queueManager: string; username: string; password: string };
  sftp?: { host: string; port: number; username: string; password: string };
}

export async function kafkaBroker(): Promise<string[] | undefined> {
  if (!(await clientAvailable('kafkajs'))) return undefined;
  if (process.env.EZTEST_KAFKA_BROKERS) return process.env.EZTEST_KAFKA_BROKERS.split(',');
  const ok = await ensureContainer('eztest-it-kafka', 'apache/kafka:3.9.1', [
    '-p', '19092:19092', '-e', 'KAFKA_NODE_ID=1', '-e', 'KAFKA_PROCESS_ROLES=broker,controller',
    '-e', 'KAFKA_LISTENERS=PLAINTEXT://:19092,CONTROLLER://:9093', '-e', 'KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://127.0.0.1:19092',
    '-e', 'KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER', '-e', 'KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
    '-e', 'KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:9093', '-e', 'KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1',
    '-e', 'KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1', '-e', 'KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1',
    '-e', 'KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0', '-e', 'KAFKA_NUM_PARTITIONS=1',
  ], async () => {
    if (!(await portOpen('127.0.0.1', 19092))) return false;
    const { Kafka, logLevel } = (await import('kafkajs')).default as unknown as { Kafka: new (o: object) => { admin(): { connect(): Promise<void>; listTopics(): Promise<string[]>; disconnect(): Promise<void> } }; logLevel: { NOTHING: number } };
    const admin = new Kafka({ brokers: ['127.0.0.1:19092'], logLevel: logLevel.NOTHING, retry: { retries: 0 } }).admin();
    try {
      await admin.connect();
      await admin.listTopics();
      return true;
    } finally {
      await admin.disconnect().catch(() => undefined);
    }
  });
  return ok ? ['127.0.0.1:19092'] : undefined;
}

export async function amqpBroker(): Promise<string | undefined> {
  if (!(await clientAvailable('amqplib'))) return undefined;
  if (process.env.EZTEST_AMQP_URL) return process.env.EZTEST_AMQP_URL;
  const url = 'amqp://guest:guest@127.0.0.1:15673';
  const ok = await ensureContainer('eztest-it-rabbit', 'rabbitmq:3.13-alpine', ['-p', '15673:5672'], async () => {
    const pkg: string = 'amqplib';
    const amqp = ((await import(pkg)) as { default: unknown }).default as unknown as { connect(u: string): Promise<{ close(): Promise<void> }> };
    const c = await amqp.connect(url);
    await c.close();
    return true;
  });
  return ok ? url : undefined;
}

export async function mqttBroker(): Promise<string | undefined> {
  if (!(await clientAvailable('mqtt'))) return undefined;
  if (process.env.EZTEST_MQTT_URL) return process.env.EZTEST_MQTT_URL;
  // The image's no-auth config is passed as the command.
  const ok = await ensureContainer('eztest-it-mqtt', 'eclipse-mosquitto:2.0.20', ['-p', '11883:1883'], () => portOpen('127.0.0.1', 11883), 30_000, ['mosquitto', '-c', '/mosquitto-no-auth.conf']);
  return ok ? 'mqtt://127.0.0.1:11883' : undefined;
}

export async function ibmMqBroker(): Promise<Brokers['ibmmq']> {
  const env = process.env.EZTEST_IBMMQ_URL;
  if (env) {
    const u = new URL(env);
    return { url: `${u.protocol}//${u.host}`, queueManager: u.searchParams.get('qmgr') ?? 'QM1', username: decodeURIComponent(u.username || 'app'), password: decodeURIComponent(u.password) };
  }
  const cfg = { url: 'https://127.0.0.1:19443', queueManager: 'QM1', username: 'app', password: 'passw0rd' };
  const ok = await ensureContainer('eztest-it-ibmmq', 'ibmcom/mq:9.2.4.0-r1', ['-p', '19443:9443', '-e', 'LICENSE=accept', '-e', 'MQ_QMGR_NAME=QM1', '-e', 'MQ_APP_PASSWORD=passw0rd', '-e', 'MQ_ADMIN_PASSWORD=passw0rd'], async () => {
    const { IbmMqBusDriver } = await import('../../src/integration/bus/ibmmq.js');
    const d = new IbmMqBusDriver('probe', { ...cfg, insecure: true, waitMs: 0 });
    await d.get({ type: 'queue', name: 'DEV.QUEUE.3' }, { waitMs: 0 });
    return true;
  }, 180_000);
  return ok ? cfg : undefined;
}

export async function sftpServer(): Promise<Brokers['sftp']> {
  if (!(await clientAvailable('ssh2'))) return undefined;
  const env = process.env.EZTEST_SFTP_URL;
  if (env) {
    const u = new URL(env);
    return { host: u.hostname, port: Number(u.port || 22), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
  }
  const ok = await ensureContainer('eztest-it-sftp', 'atmoz/sftp:alpine', ['-p', '12222:22'], () => portOpen('127.0.0.1', 12222), 60_000, ['ez:ezpass:1001::in,out']);
  return ok ? { host: '127.0.0.1', port: 12222, username: 'ez', password: 'ezpass' } : undefined;
}

/** An OpenSSH server that runs commands (linuxserver/openssh-server), for SSH command and batch-job steps. */
export async function sshServer(): Promise<Brokers['sftp']> {
  if (!(await clientAvailable('ssh2'))) return undefined;
  const env = process.env.EZTEST_SSH_URL;
  if (env) {
    const u = new URL(env);
    return { host: u.hostname, port: Number(u.port || 22), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
  }
  const cfg = { host: '127.0.0.1', port: 12223, username: 'ez', password: 'ezpass' };
  const ok = await ensureContainer('eztest-it-ssh', 'linuxserver/openssh-server:latest', [
    '-p', '12223:2222', '-e', 'PUID=1000', '-e', 'PGID=1000', '-e', 'USER_NAME=ez', '-e', 'USER_PASSWORD=ezpass', '-e', 'PASSWORD_ACCESS=true',
  ], async () => {
    if (!(await portOpen('127.0.0.1', 12223))) return false;
    const { SshSession } = await import('../../src/integration/files.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    // The probe trusts the container's key in a throwaway known_hosts file (the suites keep their own).
    const s = new SshSession('probe', { ...cfg, knownHosts: join(mkdtempSync(join(tmpdir(), 'eztest-probe-')), 'known_hosts'), trustOnFirstUse: true }, process.cwd());
    try {
      return (await s.exec('echo ready', 5000)).stdout.trim() === 'ready';
    } finally {
      s.close();
    }
  }, 90_000);
  return ok ? cfg : undefined;
}

export function skipNote(what: string, env: string): string {
  return `${what} e2e skipped: set ${env}, or run Docker with the image pulled (test/integration/brokers.ts)`;
}
