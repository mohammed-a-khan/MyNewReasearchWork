/**
 * Every call EZTest makes to the network goes through the environment's proxy (HTTP_PROXY / HTTPS_PROXY / NO_PROXY),
 * not only health checks: API steps (`Call API ...`), the SDK's `context.request` and the browser installer's
 * downloads. A consumer project on a proxy-only machine had every API step fail with "fetch failed" while the
 * health checks passed; it needed NODE_USE_ENV_PROXY=1 as a workaround.
 *
 * A real HTTP proxy on 127.0.0.1 answers for a host that does not resolve, as a corporate proxy reaches the outside.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from '../../src/browser/index.js';
import { httpGet } from '../../src/browser/launcher/install.js';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys } from '../../src/runner/index.js';

let proxy: Server;
let proxyUrl = '';
const asked: Array<{ line: string; auth?: string }> = [];
const NAMES = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'] as const;
const saved: Record<string, string | undefined> = {};
const made: string[] = [];

beforeAll(async () => {
  proxy = createServer((req, res) => {
    asked.push({ line: `${req.method} ${req.url}`, auth: req.headers['proxy-authorization'] as string | undefined });
    const u = new URL(req.url ?? '/');
    if (u.hostname === 'api.eztest.invalid' && u.pathname === '/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, via: 'proxy' }));
    }
    if (u.hostname === 'downloads.eztest.invalid') {
      if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('corp:s3cret').toString('base64')}`) {
        res.writeHead(407, { 'proxy-authenticate': 'Basic realm="corp"' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end('browser bytes');
    }
    res.writeHead(502);
    return res.end();
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  for (const n of NAMES) saved[n] = process.env[n];
});

afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

afterAll(async () => {
  proxy.closeAllConnections();
  await new Promise((r) => proxy.close(r));
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

function behindProxy(url = proxyUrl): void {
  for (const n of NAMES) delete process.env[n];
  process.env.HTTP_PROXY = url;
}

describe('outbound calls use the environment proxy', () => {
  it('API steps reach a host only the proxy can reach', async () => {
    behindProxy();
    asked.length = 0;
    const out = await mkdtemp(join(tmpdir(), 'ez-outbound-proxy-'));
    made.push(out);
    const j = parseEzScript('Journey: api through the proxy\nId: api-proxy\nSend a GET request to http://api.eztest.invalid/ping and store as ping\n', { source: 'api.ez' });
    const run = await runJourneys([j], { outputDir: out, headless: true, screenshots: 'off' });
    const jr = run.journeys[0];
    expect(jr.steps.filter((s) => s.status === 'failed').map((s) => s.error?.message)).toEqual([]);
    expect(jr.status).toBe('passed');
    expect(asked.map((a) => a.line)).toContain('GET http://api.eztest.invalid/ping');
  });

  it("the SDK's context.request goes through the proxy too", async () => {
    behindProxy();
    asked.length = 0;
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext();
      const res = await ctx.request.get('http://api.eztest.invalid/ping');
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({ ok: true, via: 'proxy' });
    } finally {
      await browser.close();
    }
    expect(asked.map((a) => a.line)).toContain('GET http://api.eztest.invalid/ping');
  });

  it('browser downloads send the proxy credentials from the proxy URL', async () => {
    const withCreds = new URL(proxyUrl);
    withCreds.username = 'corp';
    withCreds.password = 's3cret';
    behindProxy(withCreds.toString());
    const r = await httpGet('http://downloads.eztest.invalid/chrome.zip');
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('browser bytes');
    behindProxy();
    expect((await httpGet('http://downloads.eztest.invalid/chrome.zip')).status).toBe(407);
  });

  it('NO_PROXY keeps a host direct', async () => {
    behindProxy();
    process.env.NO_PROXY = 'api.eztest.invalid';
    asked.length = 0;
    const out = await mkdtemp(join(tmpdir(), 'ez-outbound-proxy-'));
    made.push(out);
    const j = parseEzScript('Journey: api direct\nId: api-direct\nSend a GET request to http://api.eztest.invalid/ping and store as ping\n', { source: 'api.ez' });
    const run = await runJourneys([j], { outputDir: out, headless: true, screenshots: 'off' });
    expect(run.journeys[0].status).not.toBe('passed'); // the host does not resolve without the proxy
    expect(asked).toEqual([]);
  });
});
