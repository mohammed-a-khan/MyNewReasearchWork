/**
 * EZTest Load: throughput and accuracy with 1..N generator processes on this machine, against a
 * target (BENCH_SERVER_WORKERS cluster processes) that counts and times every request itself.
 * 98% of the requests are answered at once, 2% after 40 ms, so the true p99 is 40 ms.
 *
 *   npx tsx scripts/bench/load-generators.ts [generators=1,2,3,4] [closed|open] [vus or rate=64] [seconds=8]
 *
 * Prints, per generator count: requests/s, the generator's request count and the server's own
 * count (they must be equal), p50/p99 as measured and the server's p99, and the generators'
 * worst and median event-loop delay (their health).
 */
import { spawn } from 'node:child_process';
import { LoadTest, parseScenario } from '../../src/load/index.js';

const gens = (process.argv[2] ?? '1,2,3,4').split(',').map(Number);
const model = (process.argv[3] ?? 'closed') as 'closed' | 'open';
const level = Number(process.argv[4] ?? 64);
const seconds = Number(process.argv[5] ?? 8);
const workers = Number(process.env.BENCH_SERVER_WORKERS ?? 2);

const SERVER = `
const cluster = require('node:cluster');
const http = require('node:http');
const n = Number(process.argv[1]);
const delays = [...Array(49).fill(0), 40];
if (cluster.isPrimary) {
  let stats = [], pending = 0, waiting = [], ready = 0, port = 0;
  for (let i = 0; i < n; i++) cluster.fork();
  cluster.on('message', (w, m) => {
    if (m.type === 'port') { port = m.port; if (++ready === n) ctl.listen(0, '127.0.0.1', () => process.stdout.write(port + ' ' + ctl.address().port + '\\n')); }
    if (m.type === 'stats') { stats.push(m); if (--pending === 0) { const all = { count: stats.reduce((a, s) => a + s.count, 0), lat: stats.flatMap((s) => s.lat) }; stats = []; for (const r of waiting.splice(0)) r.end(JSON.stringify(all)); } }
  });
  const ctl = http.createServer((req, res) => {
    if (req.url === '/stats') { waiting.push(res); pending = n; for (const id in cluster.workers) cluster.workers[id].send('stats'); }
    else { for (const id in cluster.workers) cluster.workers[id].send('reset'); res.end('ok'); }
  });
} else {
  let count = 0, lat = [];
  process.on('message', (m) => { if (m === 'stats') process.send({ type: 'stats', count, lat }); else { count = 0; lat = []; } });
  const s = http.createServer((req, res) => {
    const t0 = performance.now();
    const d = delays[count++ % delays.length];
    req.resume();
    const end = () => { res.writeHead(200, { 'content-type': 'application/json', 'content-length': '2' }); res.end('{}'); lat.push(performance.now() - t0); };
    d ? setTimeout(end, d) : end();
  });
  s.keepAliveTimeout = 60000;
  s.listen(Number(process.env.BENCH_PORT || 47124), '127.0.0.1', () => process.send({ type: 'port', port: s.address().port }));
}
`;

const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const r3 = (n: number) => Math.round(n * 1000) / 1000;

async function main(): Promise<void> {
  const child = spawn(process.execPath, ['-e', SERVER, String(workers)], { stdio: ['ignore', 'pipe', 'inherit'] });
  const [port, ctl] = await new Promise<number[]>((r) => child.stdout!.once('data', (b: Buffer) => r(b.toString().trim().split(' ').map(Number))));
  try {
    for (const g of gens) {
      await fetch(`http://127.0.0.1:${ctl}/reset`);
      const s = parseScenario({
        name: `generators ${g}`, baseUrl: `http://127.0.0.1:${port}`, model,
        userPaths: { p: { actions: [{ request: { name: 'r', url: '/x' } }] } },
        profile: model === 'open' ? { type: 'constant', rate: level, duration: `${seconds}s` } : { type: 'constant', vus: level, duration: `${seconds}s` },
        options: { thinkTimeFactor: 0, maxVus: 2000, maxConnectionsPerHost: 2000 },
      });
      const r = await new LoadTest(s, { monitors: false, generators: g }).run();
      const server = (await (await fetch(`http://127.0.0.1:${ctl}/stats`)).json()) as { count: number; lat: number[] };
      const n = r.names.find((x) => x.name === 'r');
      console.log(JSON.stringify({
        generators: g, model, level, rps: Math.round(r.totals.rps), requests: r.totals.requests, serverCount: server.count, errors: r.totals.errors, dropped: r.totals.dropped,
        p50: n?.latency.p50, p99: n?.latency.p99, serverP99: r3(pct(server.lat, 99)), lagWorstMs: r.totals.generatorLag.worstMs, lagMedianMs: r.totals.generatorLag.medianMs,
      }));
    }
  } finally {
    child.kill();
  }
}

void main();
