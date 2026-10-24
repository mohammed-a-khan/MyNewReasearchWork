/**
 * Remote browsers over the browsers' own protocols (docs/browser-driver.md,
 * "Remote browsers"): a Chrome started separately with --remote-debugging-port
 * (directly, behind a gateway that wants an auth header, and a headless Chrome
 * in Docker when the image is there), and a Firefox started with
 * --remote-debugging-port (WebDriver BiDi). The run attaches instead of
 * launching and closes only what it created: the browsers keep running, the
 * user's own tabs stay open, and credentials never reach run.json or logs.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { findChromium } from '../../src/browser/index.js';
import { findFirefox } from '../../src/browser/firefox/launch.js';
import { resolveBrowserWsEndpoint } from '../../src/browser/launcher/launch.js';
import { remoteConnectFromConfig } from '../../src/engine/browsers.js';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys, type RunOptions } from '../../src/runner/index.js';
import { cli, latestRun } from '../sdk/helpers.js';

const JOURNEY = `Journey: Remote sign in
Open /chat/login
Type "remy" into the Your name field
Click the "Join the chat" button
  Expect the page contains "Signed in as remy"
`;
const FAST = { stepTimeoutMs: 8000, locateTimeoutMs: 3000, conditionTimeoutMs: 5000 } as const;

let app: DemoServer;
const cleanups: Array<() => void | Promise<void>> = [];
beforeAll(async () => {
  app = await startDemoApp();
});
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
  await app.close();
});

/** Start a browser process and wait for the line that announces its endpoint. */
function startBrowser(bin: string, args: string[], announce: RegExp): Promise<{ proc: ChildProcess; endpoint: string; alive: () => boolean }> {
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false;
  proc.once('exit', () => { exited = true; });
  // Kill and wait for the exit, so the profile is no longer written to when it is removed.
  cleanups.push(async () => {
    if (exited) return;
    const gone = new Promise<void>((r) => proc.once('exit', () => r()));
    proc.kill('SIGKILL');
    await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
  });
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`no endpoint from ${bin}: ${buf.slice(-500)}`)), 60_000);
    const on = (d: Buffer) => {
      buf += d.toString();
      const m = announce.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve({ proc, endpoint: m[1], alive: () => !exited && proc.exitCode === null });
      }
    };
    proc.stderr!.on('data', on);
    proc.stdout!.on('data', on);
    proc.once('exit', (code) => reject(new Error(`${bin} exited (${code}): ${buf.slice(-500)}`)));
  });
}

async function jsonList(httpBase: string): Promise<Array<{ type: string; url: string; id: string }>> {
  return (await (await fetch(`${httpBase}/json/list`)).json()) as Array<{ type: string; url: string; id: string }>;
}

async function run(opts: Partial<RunOptions>): Promise<Awaited<ReturnType<typeof runJourneys>>> {
  return runJourneys([parseEzScript(JOURNEY)], { ...FAST, baseUrl: app.url, outputDir: mkdtempSync(join(tmpdir(), 'eztest-remote-')), ...opts });
}

/**
 * A gateway in front of a DevTools endpoint that wants `authorization: Bearer <token>` on the
 * discovery request and the WebSocket upgrade (what a vendor grid exposing native CDP does).
 */
function authGateway(targetPort: number, token: string): Promise<{ port: number; server: Server; seen: string[] }> {
  const seen: string[] = [];
  const ok = (h: string | undefined) => h === `Bearer ${token}`;
  const server = createServer((req, res) => {
    seen.push(`http ${req.url} ${ok(req.headers.authorization) ? 'auth' : 'no-auth'}`);
    if (!ok(req.headers.authorization)) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    const up = request({ host: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers: { host: `127.0.0.1:${targetPort}` } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.writeHead(502).end());
    up.end();
  });
  server.on('upgrade', (req, socket, head) => {
    seen.push(`ws ${req.url} ${ok(req.headers.authorization) ? 'auth' : 'no-auth'}`);
    if (!ok(req.headers.authorization)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    const up = netConnect(targetPort, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        if (/^host$/i.test(k)) lines.push(`Host: 127.0.0.1:${targetPort}`);
        else if (!/^authorization$/i.test(k)) lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
      }
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    resolve({ port: (server.address() as { port: number }).port, server, seen });
  }));
}

// With EZTEST_BROWSER=firefox the suite's "chromium" is Firefox: the CDP attach tests need a real Chromium.
const onFirefox = process.env.EZTEST_BROWSER === 'firefox';

describe.skipIf(onFirefox)('remote Chrome over its DevTools endpoint (CDP)', () => {
  let chrome: { proc: ChildProcess; endpoint: string; alive: () => boolean };
  let httpBase: string;
  beforeAll(async () => {
    const profile = mkdtempSync(join(tmpdir(), 'eztest-remote-chrome-'));
    cleanups.push(() => rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
    chrome = await startBrowser(findChromium().executablePath, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank',
    ], /DevTools listening on (ws:\/\/\S+)/);
    httpBase = `http://${new URL(chrome.endpoint).host}`;
  });

  it('attaches by http://host:port and by ws:// URL, runs, and leaves the browser and its own tab alone', async () => {
    const before = (await jsonList(httpBase)).filter((t) => t.type === 'page');
    expect(before.length).toBeGreaterThan(0);
    for (const cdpEndpoint of [httpBase, chrome.endpoint]) {
      const r = await run({ connect: { cdpEndpoint } });
      expect(r.journeys[0].status, JSON.stringify(r.journeys[0].error ?? r.journeys[0].steps.map((s) => s.error))).toBe('passed');
      expect(r.environment.browserEndpoint).toBe(`chromium: cdp ${new URL(cdpEndpoint).protocol}//${new URL(httpBase).host}`);
      expect(r.environment.browserVersion).toMatch(/^\d+\./);
    }
    // Still running; the pages it had are still there and nothing the run opened is left behind.
    expect(chrome.alive()).toBe(true);
    const after = (await jsonList(httpBase)).filter((t) => t.type === 'page');
    expect(after.map((t) => t.id).sort()).toEqual(before.map((t) => t.id).sort());
  });

  it('sends headers and auth (secret:// resolved, masked) through a gateway; a missing token fails clearly', async () => {
    const gw = await authGateway(Number(new URL(httpBase).port), 's3cret-token');
    const ep = `http://127.0.0.1:${gw.port}`;
    // /json/version through the gateway reports Chrome's own address: the host is taken from the endpoint.
    const ws = await resolveBrowserWsEndpoint(ep, { authorization: 'Bearer s3cret-token' });
    expect(new URL(ws).host).toBe(`127.0.0.1:${gw.port}`);
    const bad = await run({ connect: { cdpEndpoint: ep } }).catch((e: Error) => e);
    expect(bad).toBeInstanceOf(Error);
    expect((bad as Error).message).toMatch(/401/);
    const masked: string[] = [];
    const connect = await remoteConnectFromConfig({ cdpEndpoint: ep, headers: {}, auth: { token: 'secret://env/EZ_GRID_TOKEN' } }, async (ref) => {
      expect(ref).toBe('secret://env/EZ_GRID_TOKEN');
      return 's3cret-token';
    }, (s) => masked.push(s));
    expect(connect.headers).toEqual({ Authorization: 'Bearer s3cret-token' });
    expect(masked).toContain('s3cret-token');
    const r = await run({ connect });
    expect(r.journeys[0].status).toBe('passed');
    expect(gw.seen.some((s) => s.startsWith('http /json/version auth'))).toBe(true);
    expect(gw.seen.some((s) => s.startsWith('ws /devtools/browser/') && s.endsWith(' auth'))).toBe(true);
    expect(chrome.alive()).toBe(true);
  });

  it('config browser.connect with a secret:// token: eztest run attaches, and the token is in no run file', async () => {
    const gw = await authGateway(Number(new URL(httpBase).port), 'cfg-token-42');
    const project = mkdtempSync(join(tmpdir(), 'eztest-remote-cfg-'));
    writeFileSync(join(project, 'eztest.config.yaml'), `baseUrl: ${app.url}
journeysDir: journeys
outputDir: eztest-results
reporters: [json]
browser:
  name: chromium
  connect:
    cdpEndpoint: http://127.0.0.1:${gw.port}
    auth:
      token: secret://env/EZ_GRID_TOKEN
`);
    mkdirSync(join(project, 'journeys'));
    writeFileSync(join(project, 'journeys', 'remote.ez'), JOURNEY);
    process.env.EZ_GRID_TOKEN = 'cfg-token-42';
    try {
      const r = await cli(project, ['run', '--no-analyze']);
      const { dir, run: res } = await latestRun(project);
      expect(res.journeys[0].status, r.err.join('\n')).toBe('passed');
      expect(res.environment.browserEndpoint).toBe(`chromium: cdp http://127.0.0.1:${gw.port}`);
      expect(readFileSync(join(dir, 'run.json'), 'utf8')).not.toContain('cfg-token-42');
      expect([...r.out, ...r.err].join('\n')).not.toContain('cfg-token-42');
    } finally {
      delete process.env.EZ_GRID_TOKEN;
    }
    expect(chrome.alive()).toBe(true);
  });
});

describe('remote Firefox over WebDriver BiDi', () => {
  let ff: { proc: ChildProcess; endpoint: string; alive: () => boolean } | undefined;
  let firefoxPath: string | undefined;
  try {
    firefoxPath = findFirefox().executablePath;
  } catch {
    firefoxPath = undefined;
  }
  beforeAll(async () => {
    if (!firefoxPath) return;
    const profile = mkdtempSync(join(tmpdir(), 'eztest-remote-ff-'));
    cleanups.push(() => rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
    ff = await startBrowser(firefoxPath, ['--headless', '--no-remote', '--remote-debugging-port=0', '--profile', profile, 'about:blank'], /WebDriver BiDi listening on (ws:\/\/\S+)/);
  });

  it.skipIf(!firefoxPath)('attaches to a running Firefox (bidiEndpoint), runs twice (one session at a time), Firefox keeps running', async () => {
    for (let i = 0; i < 2; i++) {
      const r = await run({ browser: 'firefox', connect: { bidiEndpoint: ff!.endpoint } });
      const j = r.journeys[0];
      expect(j.status, JSON.stringify(j.error ?? j.steps.map((s) => s.error))).toBe('passed');
      expect(j.browser).toBe('firefox');
      expect(r.environment.browserEndpoint).toBe(`firefox: bidi ws://${new URL(ff!.endpoint).host}`);
      expect(r.environment.browserVersion).toMatch(/^\d+/);
    }
    expect(ff!.alive()).toBe(true);
  });

  it.skipIf(!firefoxPath || onFirefox)('a matrix of a remote Firefox and a launched Chromium', async () => {
    const r = await run({ browsers: ['chromium', { name: 'firefox', connect: { bidiEndpoint: ff!.endpoint } }] });
    expect(r.journeys.map((j) => `${j.journeyId}:${j.status}`).sort()).toEqual(['remote-sign-in@chromium:passed', 'remote-sign-in@firefox:passed']);
    expect(r.environment.browserEndpoint).toBe(`chromium: launched, firefox: bidi ws://${new URL(ff!.endpoint).host}`);
    expect(ff!.alive()).toBe(true);
  });
});

const IMAGE = 'chromedp/headless-shell:latest';
const docker = spawnSync('docker', ['image', 'inspect', IMAGE], { encoding: 'utf8' }).status === 0;

describe.skipIf(!docker || onFirefox)(`headless Chrome in Docker (${IMAGE}, port-mapped)`, () => {
  it('attaches through the mapped port (the browser reports its in-container address) and drives a page served from the host', async () => {
    // The page server listens on every interface so the container can reach it through host.docker.internal.
    const page = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Docker</title><label for="q">Query</label><input id="q"><button onclick="document.getElementById(\'o\').textContent=\'Hello \'+document.getElementById(\'q\').value">Go</button><p id="o"></p>'));
    await new Promise<void>((r) => page.listen(0, '0.0.0.0', () => r()));
    cleanups.push(() => new Promise<void>((r) => page.close(() => r())));
    const pagePort = (page.address() as { port: number }).port;
    const name = `eztest-remote-${process.pid}`;
    const started = spawnSync('docker', ['run', '-d', '--rm', '--name', name, '--add-host', 'host.docker.internal:host-gateway', '-p', '127.0.0.1::9222', IMAGE], { encoding: 'utf8' });
    expect(started.status, started.stderr).toBe(0);
    cleanups.push(() => { spawnSync('docker', ['rm', '-f', name]); });
    const port = /:(\d+)\s*$/.exec(spawnSync('docker', ['port', name, '9222/tcp'], { encoding: 'utf8' }).stdout.trim().split('\n')[0])![1];
    const ep = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 60; i++) {
      if (await fetch(`${ep}/json/version`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const r = await runJourneys([parseEzScript('Journey: Docker page\nOpen /\nType "docker" into the Query field\nClick the "Go" button\n  Expect the page contains "Hello docker"')], {
      ...FAST, baseUrl: `http://host.docker.internal:${pagePort}`, outputDir: mkdtempSync(join(tmpdir(), 'eztest-remote-docker-')), connect: { cdpEndpoint: ep },
    });
    const j = r.journeys[0];
    expect(j.status, JSON.stringify(j.error ?? j.steps.map((s) => s.error))).toBe('passed');
    expect(r.environment.browserVersion).toMatch(/^\d+\./);
    // The container is still serving DevTools after the run.
    expect(await fetch(`${ep}/json/version`).then((x) => x.ok)).toBe(true);
  });
});

it('describes a remote endpoint for run.json without its credentials (user info and query hidden)', async () => {
  const { describeBrowser } = await import('../../src/runner/browsers.js');
  expect(describeBrowser({ id: 'chromium', engine: 'chromium', connect: { cdpEndpoint: 'wss://user:pw@grid.example.com/cdp?token=abc' } })).toBe('cdp wss://grid.example.com');
  expect(describeBrowser({ id: 'chromium', engine: 'chromium' })).toBe('launched');
});
