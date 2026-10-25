/**
 * Health checks go through the environment's proxy (HTTP_PROXY / HTTPS_PROXY / NO_PROXY), like the browser and the
 * API steps. They used Node's global fetch: on a machine whose only way out is a proxy, the check failed with
 * "DNS lookup failed (ENOTFOUND)" and every journey of the run was skipped as "environment unavailable".
 *
 * A real HTTP proxy on 127.0.0.1 (absolute-form requests and CONNECT) in front of hosts that do not resolve.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys } from '../../src/runner/index.js';
import { runHealthChecks } from '../../src/runner/reliability/health.js';

let proxy: Server;
let direct: Server;
let proxyUrl = '';
let directUrl = '';
const asked: string[] = [];
const NAMES = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  // The proxy answers for the (unresolvable) shop host itself, as a corporate proxy reaches the outside.
  proxy = createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    const u = new URL(req.url ?? '/');
    if (u.hostname === 'shop.eztest.invalid' && u.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('shop is up');
    }
    res.writeHead(502);
    return res.end();
  });
  proxy.on('connect', (req, socket) => {
    asked.push(`CONNECT ${req.url}`);
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  direct = createServer((_req, res) => {
    res.writeHead(200);
    res.end('direct');
  });
  await new Promise<void>((r) => direct.listen(0, '127.0.0.1', r));
  directUrl = `http://127.0.0.1:${(direct.address() as AddressInfo).port}`;
  for (const n of NAMES) saved[n] = process.env[n];
});

afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

afterAll(async () => {
  for (const s of [proxy, direct]) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

function behindProxy(): void {
  for (const n of NAMES) delete process.env[n];
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  process.env.NO_PROXY = '127.0.0.1,localhost';
}

describe('health checks behind a proxy', () => {
  it('a URL check goes through HTTP_PROXY; NO_PROXY hosts go direct; the proxy\'s answer is the answer', async () => {
    behindProxy();
    asked.length = 0;
    const [up, bypass, https] = await runHealthChecks(
      [{ url: '/health', contains: 'shop is up' }, { name: 'direct', url: `${directUrl}/` }, { name: 'tls', url: 'https://secure.eztest.invalid/', timeoutMs: 3000 }],
      { baseUrl: 'http://shop.eztest.invalid' },
    );
    expect(up).toMatchObject({ ok: true, message: 'HTTP 200' });
    expect(bypass).toMatchObject({ ok: true });
    // https goes through a CONNECT tunnel; this proxy refuses it, and the message says so (not a DNS failure).
    expect(https.ok).toBe(false);
    expect(https.message).toMatch(/proxy .* refused to open a tunnel to secure\.eztest\.invalid:443/);
    expect(asked).toEqual(['GET http://shop.eztest.invalid/health', 'CONNECT secure.eztest.invalid:443']);
  });

  it('a run with a health check on a host only the proxy reaches runs its journeys', async () => {
    behindProxy();
    const out = await mkdtemp(join(tmpdir(), 'ez-health-proxy-'));
    const run = await runJourneys([parseEzScript('Journey: Runs\n\nSet variable x to "1"\nExpect the expression "x == \'1\'" is true\n')], {
      outputDir: out, baseUrl: 'http://shop.eztest.invalid', healthChecks: [{ url: '/health' }], stepTimeoutMs: 5000,
    });
    expect(run.journeys.map((j) => `${j.journeyId}:${j.status}`)).toEqual(['runs:passed']);
  }, 60_000);

  it('without a proxy the host does not resolve, and the check says so', async () => {
    for (const n of NAMES) delete process.env[n];
    const [c] = await runHealthChecks([{ url: 'http://shop.eztest.invalid/health', timeoutMs: 5000 }], {});
    expect(c.ok).toBe(false);
    expect(c.message).toMatch(/DNS lookup failed|ENOTFOUND|EAI_AGAIN/);
  });
});
