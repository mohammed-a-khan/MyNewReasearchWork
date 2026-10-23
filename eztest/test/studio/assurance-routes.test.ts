/**
 * Server routes of the Assurance, Workbench and Project pages: SQL
 * classification and read-only enforcement, "Save as step" phrasing that the
 * parser accepts, requests as a role without leaking secrets, PDF compare
 * with positions, visual masks and approvals vault, environments with value
 * sources, identity (no secret values, ENC() needs the master key), test
 * data, mocks, evidence packs, pdf.js assets and path confinement.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { decryptValue } from '../../src/config/index.js';
import { verifyEvidence } from '../../src/core/index.js';
import { startDemoApp, DEMO_TOTP_SECRET, type DemoServer } from '../../examples/demo-app/server.js';
import { startStudio, validateText, type StudioHandle } from '../../src/studio/index.js';
import { buildStepLines, classifySql, jsonPathToLedger, substitute } from '../../src/studio/routes/workbench.js';
import { client, copyShopProject, raw, SHOP_ENV_KEYS } from './helpers.js';

async function pdf(lines: Array<[string, string]>, total: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const p = doc.addPage([595, 842]);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  let y = 790;
  for (const [k, v] of lines) {
    p.drawText(k, { x: 50, y, size: 11, font: f });
    p.drawText(v, { x: 160, y, size: 11, font: f });
    y -= 18;
  }
  p.drawText('Total:', { x: 360, y: 600, size: 11, font: f });
  p.drawText(total, { x: 460, y: 600, size: 11, font: f });
  return doc.save();
}

describe('workbench helpers', () => {
  it('classifies SQL: reads, writes hidden in CTEs or comments, multiple statements', () => {
    expect(classifySql('SELECT * FROM t').kind).toBe('read');
    expect(classifySql('  with x as (select 1) select * from x;').kind).toBe('read');
    expect(classifySql("SELECT 'delete from t' AS s").kind).toBe('read');
    expect(classifySql('-- delete\nSELECT 1').kind).toBe('read');
    expect(classifySql('PRAGMA table_info(t)').kind).toBe('write'); // pragma with arguments: conservative
    expect(classifySql('PRAGMA user_version').kind).toBe('read');
    expect(classifySql('DELETE FROM t').kind).toBe('write');
    expect(classifySql('WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x').kind).toBe('write');
    expect(classifySql('SELECT * INTO copy FROM t').kind).toBe('write');
    expect(classifySql('SELECT 1; DROP TABLE t').multiple).toBe(true);
  });

  it('turns requests and queries into step lines the parser accepts', () => {
    const check = (lines: string[]) => expect(validateText(['Journey: x', '', ...lines].join('\n'), 'ez')).toMatchObject({ ok: true });
    const rest = buildStepLines({ kind: 'rest', method: 'POST', url: '/api/notes', role: 'manager', bodyType: 'json', body: '{"title": "Hello world"}', headers: [{ name: 'x-trace', value: 'abc', enabled: true }], query: [{ name: 'page', value: '2', enabled: true }], captureAs: 'note', assertions: [{ type: 'status', value: 201 }, { type: 'jsonpath', path: '$.items[0].id', value: '7' }] });
    expect(rest[0]).toMatch(/^Call API "POST \/api\/notes" as manager .*with header "x-trace" = "abc".* and store as note$/);
    expect(rest.slice(1)).toEqual(['Expect the note response status is 201', 'Expect response note "$.items[0].id" equals "7"']);
    check(rest);
    check(buildStepLines({ kind: 'rest', method: 'POST', url: '/api/form', bodyType: 'form', body: 'a=1&b=two', captureAs: 'r' }));
    const gql = buildStepLines({ kind: 'graphql', url: '/graphql', graphql: { query: '{\n  orders { id }\n}', variables: '{"t":"x"}' }, captureAs: 'gq' });
    expect(gql[0]).toMatch(/^Send GraphQL query "\{ orders \{ id \} \}" to/);
    check(gql);
    check(buildStepLines({ kind: 'soap', url: '/soap', soap: { action: 'GetOrder', body: '<GetOrder>\n  <Id>1</Id>\n</GetOrder>', version: '1.2' }, captureAs: 'order' }));
    const sql = buildStepLines({ kind: 'sql', connection: 'shop', sql: 'SELECT *\nFROM customers WHERE region = ?', params: ['EU'], captureAs: 'rows', assertions: [{ type: 'rows', value: 2 }] });
    expect(sql).toEqual([`Run query "SELECT * FROM customers WHERE region = ?" on shop with params '["EU"]' as rows`, 'Expect the query rows returns 2 rows']);
    check(sql);
    expect(() => buildStepLines({ kind: 'rest', method: 'GET', url: 'https://x.test/a', captureAs: 'r' })).toThrow(/relative to the baseUrl/);
    expect(() => buildStepLines({ kind: 'rest', method: 'GET', url: '/a', captureAs: '1bad' })).toThrow(/Store as/);
    expect(jsonPathToLedger("$.a[0]['b-c']")).toBe('a.0.b-c');
    expect(() => jsonPathToLedger('$.a[*]')).toThrow();
    expect(substitute('/api/{{ id }}/${x}/{{missing}}', { id: '7', x: 'y' })).toBe('/api/7/y/{{missing}}');
  });
});

describe('Assurance, Workbench and Project routes', () => {
  let studio: StudioHandle;
  let app: DemoServer;
  let project: string;
  let c: ReturnType<typeof client>;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    project = await copyShopProject();
    app = await startDemoApp({ dbFile: join(project, 'shop.db') });
    const env: Record<string, string> = { SHOP_URL: app.url, SHOP_DB: join(project, 'shop.db'), SHOP_ALICE_PASSWORD: 'Wonderland#1', SHOP_ALICE_TOTP: DEMO_TOTP_SECRET, SHOP_BOB_PASSWORD: 'Builder#2', SHOP_API_CLIENT_SECRET: 'ez-client-secret' };
    for (const k of [...SHOP_ENV_KEYS, 'EZTEST_MASTER_KEY', 'EZTEST_ENV']) {
      saved[k] = process.env[k];
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    await mkdir(join(project, 'config'), { recursive: true });
    await writeFile(join(project, 'config', 'qa.yaml'), 'retries: 2\n');
    await mkdir(join(project, 'docs-a'), { recursive: true });
    await mkdir(join(project, 'docs-b'), { recursive: true });
    await writeFile(join(project, 'docs-a', 'inv1.pdf'), await pdf([['Invoice No:', 'INV-1'], ['Customer:', 'Contoso Ltd']], '100.00'));
    await writeFile(join(project, 'docs-b', 'inv1.pdf'), await pdf([['Invoice No:', 'INV-1'], ['Customer:', 'Contoso Ltd']], '110.00'));
    studio = await startStudio({ cwd: project, watch: false, env: { ...process.env, EZTEST_MASTER_KEY: undefined } });
    c = client(studio.port, studio.token);
  });

  afterAll(async () => {
    await studio?.close();
    await app?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('serves pdf.js and its worker publicly as self-hosted modules', async () => {
    const lib = await raw(studio.port, '/assets/pdfjs/pdf.mjs');
    expect(lib.status).toBe(200);
    expect(lib.headers['content-type']).toMatch(/javascript/);
    expect(lib.body).toContain('GlobalWorkerOptions');
    expect((await raw(studio.port, '/assets/pdfjs/pdf.worker.mjs')).status).toBe(200);
    expect((await raw(studio.port, '/assets/pdfjs/standard_fonts/FoxitSerif.pfb')).status).toBe(200);
    expect((await raw(studio.port, '/assets/pdfjs/../../package.json')).status).toBe(404);
  });

  it('sends a request as a role on the server and never returns the token', async () => {
    const r = await c.post('/api/workbench/send', { kind: 'rest', method: 'GET', url: '/api/customers', role: 'manager', headers: [] });
    const j = r.json();
    expect(j.status).toBe(200);
    expect(j.json[0].name).toBe('Contoso Ltd');
    expect(j.request.headers.authorization).toMatch(/^Bearer •••• \(token of role manager/);
    expect(r.body).not.toContain('ez-client-secret');
    expect((await c.post('/api/workbench/send', { kind: 'rest', method: 'GET', url: 'file:///etc/passwd' })).status).toBe(400);
    expect((await c.post('/api/workbench/send', { kind: 'rest', method: 'GET', url: '/api/customers', role: 'sales-rep' })).json().error).toMatch(/no API credentials/);
    const unauth = (await c.post('/api/workbench/send', { kind: 'rest', method: 'GET', url: '/api/customers' })).json();
    expect(unauth.status).toBe(401);
  });

  it('runs SQL read-only by default and requires the session toggle plus confirmation for writes', async () => {
    const read = (await c.post('/api/workbench/sql', { connection: 'shop', sql: 'SELECT name FROM customers WHERE region = ? ORDER BY id', params: ['EU'] })).json();
    expect(read.rows.map((x: { name: string }) => x.name)).toEqual(['Contoso Ltd', 'Northwind Traders']);
    expect(read.enforced).toBe('read-only SQLite connection');
    const blocked = await c.post('/api/workbench/sql', { connection: 'shop', sql: "UPDATE customers SET region = 'XX'" });
    expect(blocked.status).toBe(403);
    expect(blocked.json().blocked).toBe(true);
    expect((await c.post('/api/workbench/sql/mode', { allowWrites: true })).status).toBe(409);
    expect((await c.post('/api/workbench/sql/mode', { allowWrites: true, confirm: true })).json().writesEnabled).toBe(true);
    expect((await c.post('/api/workbench/sql', { connection: 'shop', sql: "UPDATE customers SET region = 'EU' WHERE id = 2" })).status).toBe(409);
    const w = (await c.post('/api/workbench/sql', { connection: 'shop', sql: "UPDATE customers SET region = 'EU' WHERE id = 2", confirm: true })).json();
    expect(w.rowsAffected).toBe(1);
    await c.post('/api/workbench/sql/mode', { allowWrites: false });
    expect((await c.post('/api/workbench/sql', { connection: 'shop', sql: 'SELECT 1; SELECT 2' })).status).toBe(400);
  });

  it('inserts step lines into a journey only when the result validates', async () => {
    const lines = ['Call API "GET /api/customers" as manager and store as customers2', 'Expect the customers2 response status is 200'];
    const ok = await c.post('/api/workbench/insert', { path: 'journeys/api-and-db.ez', lines });
    expect(ok.status).toBe(200);
    expect(await readFile(join(project, 'journeys/api-and-db.ez'), 'utf8')).toContain(lines[0]);
    expect((await c.post('/api/workbench/insert', { path: 'journeys/api-and-db.ez', lines: ['Frobnicate the widget'] })).status).toBe(422);
    expect((await c.post('/api/workbench/insert', { path: '../outside.ez', lines })).status).toBe(403);
    expect((await c.post('/api/workbench/insert', { path: 'eztest.config.yaml', lines })).status).toBe(403);
  });

  it('compares two PDFs with change positions, PII and bulk clusters', async () => {
    const r = (await c.post('/api/assurance/documents/compare', { a: { path: 'docs-a/inv1.pdf' }, b: { path: 'docs-b/inv1.pdf' } })).json();
    expect(r.diff.identical).toBe(false);
    expect(r.diff.changes.some((x: { description: string }) => /Total.*100\.00.*110\.00/.test(x.description))).toBe(true);
    const hl = r.highlights.filter((x: { doc: string; kind: string }) => x.doc === 'b' && x.kind === 'field');
    expect(hl.length).toBeGreaterThan(0);
    expect(hl[0].bbox.x).toBeGreaterThan(400); // the total is printed at x = 460
    expect(r.a.url).toBe('/api/assurance/documents/file?path=docs-a%2Finv1.pdf');
    expect((await raw(studio.port, r.a.url, { headers: { 'x-eztest-token': studio.token } })).headers['content-type']).toBe('application/pdf');
    const bulk = (await c.post('/api/assurance/documents/bulk', { dirA: 'docs-a', dirB: 'docs-b' })).json();
    expect(bulk.pairs).toBe(1);
    expect(bulk.clusters[0].count).toBe(1);
    // Upload + compare against the project PDF.
    const up = (await c.post('/api/assurance/documents/upload', { name: 'x.pdf', data: Buffer.from(await pdf([['Invoice No:', 'INV-1']], '1.00')).toString('base64') })).json();
    expect((await c.post('/api/assurance/documents/compare', { a: { upload: up.id } })).status).toBe(200);
    expect((await c.post('/api/assurance/documents/upload', { name: 'x.pdf', data: Buffer.from('hello').toString('base64') })).status).toBe(400);
    expect((await c.post('/api/assurance/documents/compare', { a: { path: '../etc/passwd.pdf' } })).status).toBe(403);
    // Template save is validated.
    expect((await c.put('/api/assurance/documents/template', { path: 'templates/bad.yaml', text: 'fields: [{ name: x }]' })).status).toBe(400);
  });

  it('saves visual ignore regions and records baseline approvals in a verifiable vault', async () => {
    const out = join(project, '.eztest', 'visual-output');
    await mkdir(out, { recursive: true });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    await writeFile(join(out, 'j-s1.actual.png'), png);
    expect((await c.put('/api/assurance/visual/masks', { name: 'j-s1', boxes: [{ x: 1, y: 2, width: 30, height: 4, label: 'clock' }] })).status).toBe(200);
    expect((await c.get('/api/assurance/visual/masks')).json().masks['j-s1'][0].label).toBe('clock');
    expect((await c.put('/api/assurance/visual/masks', { name: '../x', boxes: [] })).status).toBe(400);
    const a = (await c.post('/api/assurance/visual/approve', { items: [{ name: 'j-s1' }, { name: 'missing' }] })).json();
    expect(a.approved.map((x: { name: string }) => x.name)).toEqual(['j-s1']);
    expect(a.skipped[0].name).toBe('missing');
    expect(existsSync(join(project, '.eztest', 'baselines', 'j-s1.png'))).toBe(true);
    expect((await verifyEvidence(join(project, a.vault))).ok).toBe(true);
    const list = (await c.get('/api/assurance/visual/approvals')).json();
    expect(list.approvals[0].verified).toBe(true);
    expect((await raw(studio.port, '/api/assurance/visual/image?kind=baseline&name=j-s1', { headers: { 'x-eztest-token': studio.token } })).status).toBe(200);
    expect((await raw(studio.port, '/api/assurance/visual/image?kind=baseline&name=..%2Fx', { headers: { 'x-eztest-token': studio.token } })).status).toBe(400);
  });

  it('switches environments for the session and reports value sources with secrets masked', async () => {
    const v = (await c.get('/api/project/environments')).json();
    expect(v.environments.map((e: { name: string }) => e.name)).toEqual(['qa']);
    expect(v.values.find((x: { path: string }) => x.path === 'baseUrl')).toMatchObject({ source: 'eztest.config.yaml', via: 'interpolated from $SHOP_URL' });
    expect(JSON.stringify(v)).not.toContain('Builder#2');
    expect(v.sections.map((s: { key: string }) => s.key)).toEqual(expect.arrayContaining(['identity', 'db', 'documents', 'security', 'dialogs', 'hooks']));
    expect(v.sections.find((s: { key: string }) => s.key === 'identity').sources).toEqual(['eztest.config.yaml']);
    expect((await c.post('/api/project/environments/active', { name: 'nope' })).status).toBe(400);
    expect((await c.post('/api/project/environments/active', { name: 'qa' })).json()).toMatchObject({ ok: true, active: 'qa' });
    const after = (await c.get('/api/project/environments')).json();
    expect(after.values.find((x: { path: string }) => x.path === 'retries')).toMatchObject({ value: 2, source: 'config/qa.yaml' });
    expect((await c.get('/api/settings')).json().config.retries).toBe(2);
    await c.post('/api/project/environments/active', { name: null });
    expect((await c.get('/api/settings')).json().config.retries).toBe(0);
  });

  it('describes roles by reference only and encrypts only with a master key', async () => {
    const r = await c.get('/api/project/identity');
    for (const s of ['Builder#2', 'Wonderland#1', DEMO_TOTP_SECRET, 'ez-client-secret']) expect(r.body).not.toContain(s);
    const roles = r.json().roles;
    expect(roles.find((x: { name: string }) => x.name === 'sales-rep').password).toMatchObject({ kind: 'secret-ref', ref: 'secret://env/ALICE_PASSWORD' });
    const totp = (await c.post('/api/project/identity/roles/sales-rep/totp', {})).json();
    expect(totp.code).toMatch(/^\d{6}$/);
    expect((await c.post('/api/project/identity/roles/manager/totp', {})).status).toBe(404);
    const enc = await c.post('/api/project/identity/encrypt', { value: 's3cret-value' });
    expect(enc.status).toBe(412);
    expect(enc.json().error).toMatch(/EZTEST_MASTER_KEY is not set/);
    const keyed = await startStudio({ cwd: project, watch: false, env: { ...process.env, EZTEST_MASTER_KEY: 'a-long-master-key-123' } });
    try {
      const t = (await client(keyed.port, keyed.token).post('/api/project/identity/encrypt', { value: 's3cret-value' })).json().text;
      expect(t).toMatch(/^ENC\(v1:/);
      expect(decryptValue(t, 'a-long-master-key-123')).toBe('s3cret-value');
    } finally {
      await keyed.close();
    }
  });

  it('previews deterministic synthetic data with masks and lists leases', async () => {
    const a = (await c.post('/api/project/data/preview', { count: 3, seed: 7 })).json();
    const b = (await c.post('/api/project/data/preview', { count: 3, seed: 7 })).json();
    expect(a.rows).toEqual(b.rows);
    expect(a.masked[0].card).toMatch(/^\*+\d{4}$/);
    expect(a.masked[0].email).toMatch(/@example\.com$/);
    const leaseDir = join(project, '.eztest', 'leases');
    await mkdir(leaseDir, { recursive: true });
    await writeFile(join(leaseDir, 'a.lease'), JSON.stringify({ resource: 'Customer:1', owner: 'x', token: 't', acquiredAt: 1, expiresAt: 2 }));
    await writeFile(join(leaseDir, 'b.lease'), JSON.stringify({ resource: 'Customer:2', owner: 'x', token: 't', acquiredAt: Date.now(), expiresAt: Date.now() + 60_000 }));
    expect((await c.get('/api/project/data')).json().leases.filter((l: { stale: boolean }) => l.stale).length).toBe(1);
    const rel = (await c.post('/api/project/data/leases/release-stale', {})).json();
    expect(rel.released).toEqual(['Customer:1']);
    expect(rel.leases.length).toBe(1);
  });

  it('manages mock stores: capture, edit, faults, replay, drift', async () => {
    expect((await c.post('/api/project/mocks/store', { path: 'mocks/api.json', target: app.url })).status).toBe(200);
    const cap = (await c.post('/api/project/mocks/capture', { path: 'mocks/api.json', role: 'manager', paths: ['/api/customers'] })).json();
    expect(cap.captured).toEqual([{ path: '/api/customers', status: 200 }]);
    expect(JSON.stringify(cap)).not.toContain('Bearer');
    const id = cap.store.recordings[0].id;
    expect((await c.post('/api/project/mocks/drift', { path: 'mocks/api.json', role: 'manager' })).json()).toMatchObject({ ok: true, checked: 1 });
    await c.put('/api/project/mocks/recording', { path: 'mocks/api.json', id, response: { body: '{"items":[]}' } });
    const drift = (await c.post('/api/project/mocks/drift', { path: 'mocks/api.json', role: 'manager' })).json();
    expect(drift.drifted).toBe(1);
    expect((await c.put('/api/project/mocks/faults', { path: 'mocks/api.json', rules: [{ path: '/api/**' }] })).status).toBe(400);
    await c.put('/api/project/mocks/faults', { path: 'mocks/api.json', rules: [{ enabled: true, method: 'GET', path: '/api/**', status: 503 }] });
    const started = (await c.post('/api/project/mocks/server', { path: 'mocks/api.json' })).json();
    expect((await fetch(`${started.server.url}/api/customers`)).status).toBe(503);
    await c.del('/api/project/mocks/server', { path: 'mocks/api.json' });
    expect((await c.get('/api/project/mocks/wiremock?path=mocks%2Fapi.json')).status).toBe(404);
    expect((await c.get('/api/project/mocks')).json().stores.map((s: { path: string }) => s.path)).toContain('mocks/api.json');
  });

  it('lists monitors and refuses to start without @monitor journeys', async () => {
    const m = (await c.get('/api/project/monitors')).json();
    expect(m.journeys).toEqual([]);
    expect(m.loop.running).toBe(false);
    expect((await c.post('/api/project/monitors/start', { intervalSec: 60 })).status).toBe(400);
    expect((await c.post('/api/project/monitors/start', { intervalSec: 1 })).status).toBe(400);
  });

  it('generates the signing key once and needs it for packs', async () => {
    expect((await c.post('/api/project/compliance/pack', { runId: 'run-x', signer: { name: 'A', role: 'B' } })).status).toBe(412);
    const k = (await c.post('/api/project/compliance/key', {})).json();
    expect(k.key.fingerprint).toBeTruthy();
    expect((await c.post('/api/project/compliance/key', {})).status).toBe(409);
    expect((await c.post('/api/project/compliance/pack', { runId: 'run-x', signer: { name: 'A', role: 'B' } })).status).toBe(404);
    expect((await c.post('/api/project/compliance/verify', { data: Buffer.from('nope').toString('base64') })).status).toBe(400);
    const pub = await raw(studio.port, '/api/project/compliance/download?what=public-key', { headers: { 'x-eztest-token': studio.token } });
    expect(pub.body).toMatch(/BEGIN PUBLIC KEY/);
    expect((await raw(studio.port, '/api/project/compliance/download?what=private-key', { headers: { 'x-eztest-token': studio.token } })).status).not.toBe(200);
  });

  it('requires the session token on every new route', async () => {
    for (const p of ['/api/assurance/runs', '/api/workbench/context', '/api/project/identity', '/api/project/environments', '/api/project/compliance']) {
      expect((await raw(studio.port, p)).status).toBe(401);
    }
    expect((await raw(studio.port, '/api/workbench/sql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  });
});
