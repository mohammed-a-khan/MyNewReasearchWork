/**
 * API security scan pack end to end: EZTest's own scanner (no external
 * scanner) against a deliberately vulnerable API and a hardened one, checking
 * each OWASP API Top 10 probe, the safe-by-default guard, and the readiness
 * gate over a recorded scan.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { EvidenceVault, type RunResult } from '../../src/core/index.js';
import { evaluateReadiness, readEvidenceManifest } from '../../src/insights/index.js';
import {
  ApiSecurityScanner, apiScanMarkdown, apiSecurityReadinessInput, assertScanAllowed, evaluateApiSecurityGate, recordApiSecurityScan, scanApiSecurity, type ApiScanConfig, type ApiTarget,
} from '../../src/lenses/index.js';

interface Opts { secure: boolean }

async function body(req: IncomingMessage): Promise<string> {
  const c: Buffer[] = [];
  for await (const x of req) c.push(x as Buffer);
  return Buffer.concat(c).toString('utf8');
}

/** A tiny shop API. `secure:false` is riddled with the flaws the scanner looks for. */
function makeApi(o: Opts): Server {
  const orders: Record<string, { id: string; owner: string; total: number }> = { '1': { id: '1', owner: 'alice', total: 10 }, '2': { id: '2', owner: 'bob', total: 20 } };
  let hits = 0;
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const auth = req.headers.authorization;
    const who = auth === 'Bearer alice-token' ? 'alice' : auth === 'Bearer bob-token' ? 'bob' : undefined;
    const origin = req.headers.origin;
    const send = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
      const h: Record<string, string> = { 'content-type': 'application/json', ...headers };
      if (o.secure) {
        h['x-content-type-options'] = 'nosniff';
        if (origin === 'https://shop.example') h['access-control-allow-origin'] = origin;
      } else if (origin) {
        h['access-control-allow-origin'] = origin;
        h['access-control-allow-credentials'] = 'true';
      }
      res.writeHead(status, h);
      res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
    };
    const m = /^\/api\/orders\/(.+)$/.exec(url.pathname);
    if (m && req.method === 'GET') {
      hits++;
      if (o.secure && !who) return send(401, { error: 'unauthorized' });
      const search = url.searchParams.get('q');
      if (search && /['"<]/.test(search)) {
        // vulnerable: leak a DB error; secure: validate
        if (o.secure) return send(400, { error: 'invalid query' });
        return send(500, { error: `You have an error in your SQL syntax near "${search}"` });
      }
      if (o.secure && hits > 15) return send(429, { error: 'rate limited' }, { 'retry-after': '1' });
      const ord = orders[m[1]];
      if (!ord) return send(404, { error: 'not found' });
      if (o.secure && who && ord.owner !== who) return send(403, { error: 'forbidden' });
      return send(200, ord);
    }
    if (url.pathname === '/api/orders' && req.method === 'POST') {
      const data = JSON.parse((await body(req)) || '{}') as Record<string, unknown>;
      const id = String(Object.keys(orders).length + 1);
      // vulnerable: trust every field; secure: whitelist total only
      const rec = o.secure ? { id, owner: who ?? 'anon', total: Number(data.total) || 0 } : { id, owner: who ?? 'anon', ...data };
      orders[id] = rec as typeof orders[string];
      return send(201, rec);
    }
    send(404, { error: 'not found' });
  });
}

let vuln: Server;
let safe: Server;
let vulnUrl = '';
let safeUrl = '';

beforeAll(async () => {
  vuln = makeApi({ secure: false });
  safe = makeApi({ secure: true });
  await new Promise<void>((r) => vuln.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => safe.listen(0, '127.0.0.1', r));
  vulnUrl = `http://127.0.0.1:${(vuln.address() as AddressInfo).port}`;
  safeUrl = `http://127.0.0.1:${(safe.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => vuln.close(() => r()));
  await new Promise<void>((r) => safe.close(() => r()));
});

const TARGETS: ApiTarget[] = [
  { method: 'GET', path: '/api/orders/{id}', authRequired: true, sample: { id: '1', q: 'shoes' }, injectParams: ['q'], objectIds: { id: ['1', '2'] } },
  { method: 'POST', path: '/api/orders', authRequired: true, body: { total: 5 } },
];

const base = (url: string, extra: Partial<ApiScanConfig> = {}): ApiScanConfig => ({
  baseUrl: url, allowedHosts: ['127.0.0.1'], confirm: true, allowMutating: true,
  token: () => 'alice-token', otherToken: () => 'bob-token', rateLimitBurst: 20, timeoutMs: 8000, ...extra,
});

describe('API security scanner', () => {
  it('flags the vulnerable API across the OWASP API Top 10 probes', async () => {
    const r = await scanApiSecurity(base(vulnUrl), TARGETS);
    const ids = new Set(r.findings.map((f) => f.id));
    const cats = new Set(r.findings.map((f) => f.owasp));
    expect(ids).toContain('auth-bypass'); // API2: GET /orders/{id} returns 200 with no token
    expect(ids).toContain('bola'); // API1: alice reads bob's order
    expect(ids).toContain('mass-assignment'); // API3: POST accepts owner/role
    expect([...ids].some((i) => i.startsWith('injection'))).toBe(true); // API8: SQL error leaked
    expect(ids).toContain('no-rate-limit'); // API4
    expect(ids).toContain('cors-reflects-origin'); // API8: ACAO reflects an arbitrary Origin, with credentials
    expect(ids).toContain('verbose-error'); // API8
    expect(cats).toContain('API1');
    expect(cats).toContain('API3');
    const bola = r.findings.find((f) => f.id === 'bola')!;
    expect(bola.owasp).toBe('API1');
    expect(bola.evidence.request).toContain('as user');
    // the markdown names findings and OWASP ids
    expect(apiScanMarkdown(r)).toMatch(/API1:2023 Broken Object Level Authorization/);
  });

  it('finds nothing meaningful on the hardened API', async () => {
    const r = await scanApiSecurity(base(safeUrl), TARGETS);
    const high = r.findings.filter((f) => f.severity === 'high' || f.severity === 'medium');
    expect(high, JSON.stringify(high, null, 2)).toEqual([]);
  });

  it('runs only the requested probes and reports why others were skipped', async () => {
    const r = await scanApiSecurity(base(vulnUrl, { probes: ['bola'], otherToken: undefined }), TARGETS);
    expect(r.probes).toEqual(['bola']);
    expect(r.findings).toEqual([]);
    expect(r.skipped).toEqual([{ probe: 'bola', reason: 'needs two identities (token and otherToken) to compare object access' }]);
  });

  it('does not run mutating probes unless allowed', async () => {
    const r = await scanApiSecurity(base(vulnUrl, { allowMutating: false, probes: ['massAssignment'] }), TARGETS);
    expect(r.skipped[0]).toMatchObject({ probe: 'massAssignment', reason: /not enabled/ });
    expect(r.findings).toEqual([]);
  });

  it('masks secrets in evidence', async () => {
    const r = await scanApiSecurity(base(vulnUrl, { mask: (s) => s.split('alice-token').join('***') }), TARGETS);
    expect(JSON.stringify(r)).not.toContain('alice-token');
  });
});

describe('safe by default', () => {
  it('refuses without opt-in', () => {
    expect(() => assertScanAllowed({ baseUrl: vulnUrl, allowedHosts: ['127.0.0.1'], confirm: false })).toThrow(/opt-in/);
  });
  it('refuses a host that is not allow-listed (never production)', () => {
    expect(() => new ApiSecurityScanner(base('https://api.production.example', { allowedHosts: ['127.0.0.1'] }))).toThrow(/not in security.api.allowedHosts/);
  });
  it('allows a wildcard host', () => {
    expect(() => assertScanAllowed({ baseUrl: 'https://staging.shop.example', allowedHosts: ['*.shop.example'], confirm: true })).not.toThrow();
  });
});

describe('readiness gate', () => {
  it('fails when a recorded scan has blocking findings, and cites the evidence', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'eztest-apisec-'));
    await new EvidenceVault(runDir).init();
    const report = await scanApiSecurity(base(vulnUrl), TARGETS);
    const id = await recordApiSecurityScan(runDir, report);
    const manifest = await readEvidenceManifest(runDir);
    const input = await apiSecurityReadinessInput(runDir, manifest);
    expect(input?.evidence).toEqual([id]);
    const gate = evaluateApiSecurityGate(input, 'medium');
    expect(gate.status).toBe('fail');
    expect(gate.summary).toMatch(/Broken Object Level Authorization/);

    const run: RunResult = { runId: 'r1', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1, environment: {}, summary: { total: 1, passed: 1, passedHealed: 0, failed: 0, skipped: 0, errors: 0 }, journeys: [{ journeyId: 'j', name: 'j', status: 'passed', startedAt: new Date().toISOString(), durationMs: 1, steps: [], tags: [], requirements: [], risk: 1, attempt: 1, browser: 'chromium', ledger: {}, evidence: [] }] };
    const readiness = evaluateReadiness({ version: 1, gates: { apiSecurity: true } } as never, { run, evidence: manifest, apiSecurity: input });
    expect(readiness.decision).toBe('NO_GO');
    expect(readiness.gates.find((g) => g.gate === 'apiSecurity')?.status).toBe('fail');
  });

  it('passes and reports no-data correctly', async () => {
    const clean = await scanApiSecurity(base(safeUrl), TARGETS);
    expect(evaluateApiSecurityGate({ report: clean, evidence: ['e1'] }, 'medium').status).toBe('pass');
    expect(evaluateApiSecurityGate(undefined).status).toBe('no-data');
  });
});
