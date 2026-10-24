/**
 * Stand-alone EZTest Load agent entry: bundled by scripts/build-load-agent.mjs
 * into one file for the slim agent image (deploy/load-agent/Dockerfile).
 * Configuration by flags or environment:
 *
 *   EZTEST_LOAD_CONTROLLER=host:7400  EZTEST_LOAD_TOKEN=...  EZTEST_LOAD_ZONE=eu-west
 *   EZTEST_LOAD_AGENT_ID=...  EZTEST_LOAD_CAPACITY=1  EZTEST_LOAD_ONCE=1  EZTEST_LOAD_GENERATORS=4 (default: one per CPU)
 *   EZTEST_LOAD_TLS_CA / _CERT / _KEY (mutual TLS)
 */
import { hostname } from 'node:os';
import { startAgent } from './distributed/agent.js';
import { defaultGenerators } from './engine/generators.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}

const env = process.env;
const controller = arg('controller') ?? env.EZTEST_LOAD_CONTROLLER;
if (!controller) {
  process.stderr.write('eztest-load-agent: --controller host:port (or EZTEST_LOAD_CONTROLLER) is required\n');
  process.exit(2);
}
const ca = arg('tls-ca') ?? env.EZTEST_LOAD_TLS_CA;
const cert = arg('tls-cert') ?? env.EZTEST_LOAD_TLS_CERT;
const key = arg('tls-key') ?? env.EZTEST_LOAD_TLS_KEY;
const once = (arg('once') ?? env.EZTEST_LOAD_ONCE) === 'true' || env.EZTEST_LOAD_ONCE === '1';
const agent = startAgent({
  controller,
  token: arg('token') ?? env.EZTEST_LOAD_TOKEN,
  id: arg('id') ?? env.EZTEST_LOAD_AGENT_ID ?? `${hostname()}-${process.pid}`,
  zone: arg('zone') ?? env.EZTEST_LOAD_ZONE,
  capacity: Number(arg('capacity') ?? env.EZTEST_LOAD_CAPACITY ?? 1) || 1,
  once,
  tls: ca || cert ? { ca, cert, key } : undefined,
  connectTimeoutMs: once ? 120_000 : 24 * 3_600_000,
  generators: Number(arg('generators') ?? env.EZTEST_LOAD_GENERATORS ?? 0) || defaultGenerators(),
  log: (l) => process.stderr.write(`${new Date().toISOString()} ${l}\n`),
});
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => agent.stop());
agent.done.then(
  () => process.exit(0),
  (e: Error) => {
    process.stderr.write(`eztest-load-agent: ${e.message}\n`);
    process.exit(2);
  },
);
