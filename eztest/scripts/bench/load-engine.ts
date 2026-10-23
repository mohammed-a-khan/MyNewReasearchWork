/**
 * EZTest Load throughput benchmark: one load generator process against a
 * minimal keep-alive server running in another process.
 *
 *   npx tsx scripts/bench/load-engine.ts [vus=100,500,1000] [seconds=8] [delayMs=0]
 *
 * Prints VUs, requests/second, p50/p99 and the generator's CPU use per run.
 */
import { spawn } from 'node:child_process';
import { LoadTest, parseScenario } from '../../src/load/index.js';

const vusList = (process.argv[2] ?? '100,500,1000').split(',').map(Number);
const seconds = Number(process.argv[3] ?? 8);
const delay = Number(process.argv[4] ?? 0);

const workers = Number(process.env.BENCH_SERVER_WORKERS ?? 2);
// The target: a minimal keep-alive server in BENCH_SERVER_WORKERS processes (node:cluster) so it is not the bottleneck.
const SERVER = `
const cluster = require('node:cluster');
const http = require('node:http');
const d = Number(process.argv[1]);
const n = Number(process.argv[2]);
if (cluster.isPrimary) {
  let port = 0;
  for (let i = 0; i < n; i++) cluster.fork();
  let ready = 0;
  cluster.on('message', (w, m) => { port = m; if (++ready === n) process.stdout.write(String(port) + '\\n'); });
} else {
  const s = http.createServer((req, res) => { const end = () => { res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '2' }); res.end('ok'); }; d ? setTimeout(end, d) : end(); });
  s.keepAliveTimeout = 60000;
  s.listen(Number(process.env.BENCH_PORT || 47123), '127.0.0.1', () => process.send(s.address().port));
}
`;

async function main(): Promise<void> {
  const child = spawn(process.execPath, ['-e', SERVER, String(delay), String(workers)], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((r) => child.stdout!.once('data', (b: Buffer) => r(Number(b.toString().trim()))));
  try {
    for (const vus of vusList) {
      const s = parseScenario({
        name: `bench ${vus}`, baseUrl: `http://127.0.0.1:${port}`,
        userPaths: { p: { actions: [{ request: { name: 'GET /', url: '/' } }] } },
        // a short ramp: thousands of simultaneous connects would only measure the target's accept backlog
        profile: { type: 'ramp', vus, rampUp: `${Math.max(1, Math.round(seconds / 4))}s`, plateau: `${seconds - Math.max(1, Math.round(seconds / 4))}s` },
        options: { maxConnectionsPerHost: 1, gracefulStop: '2s' },
      });
      const cpu0 = process.cpuUsage();
      const t0 = Date.now();
      const r = await new LoadTest(s, { monitors: false }).run();
      const cpu = process.cpuUsage(cpu0);
      const wall = (Date.now() - t0) / 1000;
      console.log(JSON.stringify({ vus, seconds, delayMs: delay, requests: r.totals.requests, rps: Math.round(r.totals.rps), errors: r.totals.errors, p50: r.totals.latency.p50, p99: r.totals.latency.p99, generatorCpuPercent: Math.round(((cpu.user + cpu.system) / 1e6 / wall) * 100) }));
    }
  } finally {
    child.kill();
  }
}

void main();
