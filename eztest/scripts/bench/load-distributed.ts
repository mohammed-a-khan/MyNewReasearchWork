/**
 * EZTest Load distributed benchmark: a controller and N agent processes
 * (`eztest load agent`) against a minimal keep-alive server (node:cluster).
 *
 *   npx tsx scripts/bench/load-distributed.ts [agents=2] [vus=400] [seconds=8]
 *
 * Prints requests/second per agent and merged.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LoadController, parseScenario } from '../../src/load/index.js';

const agents = Number(process.argv[2] ?? 2);
const vus = Number(process.argv[3] ?? 400);
const seconds = Number(process.argv[4] ?? 8);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TOKEN = 'bench-token-0123456789abcdef';

const SERVER = `
const cluster = require('node:cluster');
const http = require('node:http');
if (cluster.isPrimary) {
  let ready = 0;
  for (let i = 0; i < 2; i++) cluster.fork();
  cluster.on('message', (w, port) => { if (++ready === 2) process.stdout.write(String(port) + '\\n'); });
} else {
  const s = http.createServer((req, res) => { res.writeHead(200, { 'content-length': '2' }); res.end('ok'); });
  s.keepAliveTimeout = 60000;
  s.listen(47124, '127.0.0.1', () => process.send(s.address().port));
}
`;

async function main(): Promise<void> {
  // node:cluster re-runs the -e script in each worker with the same arguments
  const srv = spawn(process.execPath, ['-e', SERVER, 'server'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((r) => srv.stdout!.once('data', (b: Buffer) => r(Number(b.toString().trim()))));
  const s = parseScenario({
    name: 'distributed bench', baseUrl: `http://127.0.0.1:${port}`,
    userPaths: { p: { actions: [{ request: { name: 'GET /', url: '/' } }] } },
    profile: { type: 'ramp', vus, rampUp: '2s', plateau: `${seconds - 2}s` },
    options: { maxConnectionsPerHost: 1, gracefulStop: '2s' },
  });
  const c = new LoadController(s, { agents, listen: '127.0.0.1:0', token: TOKEN, monitors: false });
  await c.listen();
  const tsx = pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href;
  const procs = Array.from({ length: agents }, (_, i) => spawn(process.execPath, ['--import', tsx, join(ROOT, 'src/cli/bin.ts'), 'load', 'agent', '--controller', `127.0.0.1:${c.port}`, '--id', `agent-${i + 1}`, '--once'], { env: { ...process.env, EZTEST_LOAD_TOKEN: TOKEN }, stdio: 'ignore' }));
  try {
    const r = await c.run();
    for (const a of r.agents) console.log(JSON.stringify({ agent: a.id, peakVus: a.vus, requests: a.requests, rps: a.rps }));
    console.log(JSON.stringify({ merged: true, agents: r.agents.length, vus: r.totals.maxVus, requests: r.totals.requests, rps: Math.round(r.totals.rps), p50: r.totals.latency.p50, p99: r.totals.latency.p99, errors: r.totals.errors }));
  } finally {
    await c.close();
    for (const p of procs) p.kill();
    srv.kill();
  }
}

void main();
