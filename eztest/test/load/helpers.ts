import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { parseScenario, type Scenario, type ScenarioInput } from '../../src/load/index.js';

/**
 * A server with a known latency distribution: request n (global order) is
 * answered after delays[n % delays.length] ms. `stall` holds one request.
 */
export async function latencyServer(delays: number[], o: { stallAt?: number; stallMs?: number } = {}): Promise<{ url: string; count: () => number; close(): Promise<void> }> {
  let n = 0;
  const server: Server = createServer((req, res) => {
    const i = n++;
    let d = delays[i % delays.length];
    if (o.stallAt !== undefined && i === o.stallAt) d = o.stallMs ?? 1000;
    const body = '{"ok":true}';
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length) });
      res.end(body);
    }, d);
    req.resume();
  });
  server.keepAliveTimeout = 60_000;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    count: () => n,
    close: () => new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

const CHILD_SERVER = `
const http = require('node:http');
const delays = JSON.parse(process.argv[1]);
let n = 0;
const measured = [];
const server = http.createServer((req, res) => {
  if (req.url === '/__stats') { res.end(JSON.stringify(measured)); return; }
  const t0 = performance.now();
  const d = delays[n++ % delays.length];
  req.resume();
  setTimeout(() => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '11' });
    res.end('{"ok":true}');
    measured.push(performance.now() - t0);
  }, d);
});
server.keepAliveTimeout = 60000;
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
`;

/** The same, in its own process, recording the time it really took to answer each request (server side). */
export async function latencyServerProcess(delays: number[]): Promise<{ url: string; measured(): Promise<number[]>; close(): Promise<void> }> {
  const child: ChildProcess = spawn(process.execPath, ['-e', CHILD_SERVER, JSON.stringify(delays)], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    child.stdout!.on('data', (c: Buffer) => {
      buf += c.toString();
      if (buf.includes('\n')) resolve(Number(buf.trim()));
    });
    child.once('exit', (code) => reject(new Error(`latency server exited ${code}`)));
  });
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    measured: async () => (await (await fetch(`${url}/__stats`)).json()) as number[],
    close: async () => {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    },
  };
}

export function scenario(s: Partial<ScenarioInput> & { userPaths: ScenarioInput['userPaths'] }, baseDir = process.cwd()): Scenario {
  return parseScenario({ name: 'test', ...s }, baseDir);
}

/** Exact nearest-rank percentile. */
export function exactPercentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
