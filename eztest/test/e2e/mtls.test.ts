/**
 * mTLS: a local HTTPS server that requires a client certificate signed by a test CA
 * (generated here with openssl). EZTest's API client and the browser context both
 * present the configured certificate; without it the server refuses the handshake.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { TLSSocket } from 'node:tls';
import * as tls from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, SecretMasker } from '../../src/config/index.js';
import { createEngine } from '../../src/engine/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { ApiClient } from '../../src/surfaces/index.js';
import { describeSteps } from './advanced-helpers.js';

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const PASS = `p12-${Math.random().toString(36).slice(2)}`;

describe.skipIf(!hasOpenssl())('mTLS client certificates', () => {
  let dir: string;
  let server: Server;
  let origin: string;
  let caPem: string;
  const defaultCAs = tls.getCACertificates('default');

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'eztest-mtls-'));
    const o = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
    o('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=EZTest Test CA');
    writeFileSync(join(dir, 'server.ext'), 'subjectAltName=IP:127.0.0.1,DNS:localhost\n');
    o('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost');
    o('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '2', '-extfile', 'server.ext');
    o('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'client.key', '-out', 'client.csr', '-subj', '/CN=ez-client');
    o('x509', '-req', '-in', 'client.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'client.pem', '-days', '2');
    o('pkcs12', '-export', '-inkey', 'client.key', '-in', 'client.pem', '-out', 'client.p12', '-passout', `pass:${PASS}`);
    caPem = readFileSync(join(dir, 'ca.pem'), 'utf8');
    server = createServer({ key: readFileSync(join(dir, 'server.key')), cert: readFileSync(join(dir, 'server.pem')), ca: caPem, requestCert: true, rejectUnauthorized: true }, (req, res) => {
      const cn = (req.socket as TLSSocket).getPeerCertificate()?.subject?.CN ?? '';
      if (req.url?.startsWith('/api/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ cn }));
      } else {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><title>mTLS</title><p id="who">Hello ${cn}</p>`);
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    // The browser side verifies the server through Node's default trust store: add the test CA for this process.
    tls.setDefaultCACertificates([...defaultCAs, caPem]);
  });
  afterAll(async () => {
    tls.setDefaultCACertificates(defaultCAs);
    await new Promise<void>((r) => server?.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  async function engineFor(certs: string): Promise<Awaited<ReturnType<typeof createEngine>>> {
    writeFileSync(join(dir, 'eztest.config.yaml'), `outputDir: results\nheadless: true\nscreenshots: on-failure\nhealing: { enabled: false }\n${certs}`);
    const loaded = await loadConfig({ cwd: dir, environment: { CERT_PASS: PASS }, masker: new SecretMasker() });
    // inline: the test CA is added to this process's trust store (tls.setDefaultCACertificates), which a worker process would not have.
    return createEngine(loaded, { cwd: dir, runOptions: { stepTimeoutMs: 6000, conditionTimeoutMs: 2000, screenshots: 'on-failure', workers: 'inline' } });
  }

  it('presents the certificate from API steps (by origin and by name) and from the browser', async () => {
    const engine = await engineFor(`api:\n  clientCertificates:\n    - { name: c1, origin: "${origin}", pfx: client.p12, passphrase: "secret://env/CERT_PASS", ca: ca.pem }\n`);
    try {
      const j = parseEzScript([
        'Journey: mTLS',
        `Call API "GET ${origin}/api/whoami" and store as me`,
        'Expect ${me.body.cn} == "ez-client"',
        `Call API "GET ${origin}/api/whoami" with client certificate "c1" and store as named`,
        'Expect ${named.status} == 200',
        `Open ${origin}/whoami`,
        'Expect the page contains "Hello ez-client"',
        '',
      ].join('\n'));
      expect(j.steps.find((s) => s.captureAs === 'named')?.api?.clientCertificate).toBe('c1');
      const run = await engine.run([j]);
      expect(run.journeys[0].status, describeSteps(run.journeys[0])).toBe('passed');
      const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
      for (const f of walk(join(dir, 'results', run.runId))) expect(readFileSync(f).includes(PASS), f).toBe(false);
    } finally {
      await engine.close();
    }
  }, 60_000);

  it('fails clearly without a certificate, with an unknown name, and with a wrong passphrase', async () => {
    const none = await engineFor('');
    try {
      const run = await none.run([parseEzScript(`Journey: no cert\nCall API "GET ${origin}/api/whoami" and store as me\n`)]);
      expect(run.journeys[0].status).toBe('failed');
      const unknown = await none.run([parseEzScript(`Journey: unknown cert\nCall API "GET ${origin}/api/whoami" with client certificate "nope" and store as me\n`)]);
      expect(unknown.journeys[0].steps[0].error?.message).toMatch(/No client certificate named "nope"/);
    } finally {
      await none.close();
    }
    const client = new ApiClient({ clientCertificates: [{ origin, pfx: readFileSync(join(dir, 'client.p12')), passphrase: 'wrong', ca: Buffer.from(caPem) }], retry: false });
    await expect(client.get(`${origin}/api/whoami`)).rejects.toThrow(/wrong passphrase|mac verify failure/);
    const ok = new ApiClient({ clientCertificates: [{ origin, pfx: readFileSync(join(dir, 'client.p12')), passphrase: PASS, ca: Buffer.from(caPem) }], retry: false });
    const res = await ok.get<{ cn: string }>(`${origin}/api/whoami`);
    expect(res.body.cn).toBe('ez-client');
    const pem = new ApiClient({ clientCertificates: [{ origin, cert: readFileSync(join(dir, 'client.pem')), key: readFileSync(join(dir, 'client.key')), ca: Buffer.from(caPem) }], retry: false });
    expect((await pem.get<{ cn: string }>(`${origin}/api/whoami`)).body.cn).toBe('ez-client');
  }, 60_000);
});
