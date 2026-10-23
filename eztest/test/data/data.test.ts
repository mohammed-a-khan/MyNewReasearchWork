import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '../support/testkit.js';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { SqliteDbClient, ApiClient } from '../../src/surfaces/index.js';
import {
  DataFabric,
  LeaseRegistry,
  SqlDataProvider,
  ApiDataProvider,
  SyntheticProvider,
  Synthetic,
  parseConstraint,
  parseWhere,
  matchesConstraint,
  satisfyingValue,
  toSqlWhere,
  quoteIdent,
  luhnValid,
  ibanValid,
  maskRecord,
  maskRows,
  CleanupRegistry,
} from '../../src/data/index.js';
import { startMock, json } from '../surfaces/mock-server.js';

let leaseDir: string;
beforeEach(() => {
  leaseDir = mkdtempSync(join(tmpdir(), 'eztest-leases-'));
});
afterEach(() => rmSync(leaseDir, { recursive: true, force: true }));

describe('constraints', () => {
  it('parses operators', () => {
    expect(parseConstraint('region', 'EU')).toEqual({ field: 'region', op: '=', value: 'EU' });
    expect(parseConstraint('region', '=EU')).toEqual({ field: 'region', op: '=', value: 'EU' });
    expect(parseConstraint('region', '!=US')).toEqual({ field: 'region', op: '!=', value: 'US' });
    expect(parseConstraint('limit', '>10000')).toEqual({ field: 'limit', op: '>', value: '10000' });
    expect(parseConstraint('limit', '>= 5')).toEqual({ field: 'limit', op: '>=', value: '5' });
    expect(parseConstraint('limit', '<5')).toEqual({ field: 'limit', op: '<', value: '5' });
    expect(parseConstraint('limit', '<=5.5')).toEqual({ field: 'limit', op: '<=', value: '5.5' });
    expect(parseConstraint('name', '~Contoso')).toEqual({ field: 'name', op: '~', value: 'Contoso' });
    expect(parseConstraint('d', '>2026-01-01')).toEqual({ field: 'd', op: '>', value: '2026-01-01' });
    expect(parseConstraint('x', '=>literal')).toEqual({ field: 'x', op: '=', value: '>literal' });
    expect(() => parseConstraint('x', '>')).toThrow(/no value/);
    expect(() => parseConstraint('x', '>abc')).toThrow(/number or an ISO date/);
    expect(parseWhere({})).toEqual([]);
  });
  it('matches in memory with typed comparison', () => {
    const gt = parseConstraint('l', '>10000');
    expect(matchesConstraint(25000, gt)).toBe(true);
    expect(matchesConstraint('25000.00', gt)).toBe(true);
    expect(matchesConstraint(10000, gt)).toBe(false);
    expect(matchesConstraint(null, gt)).toBe(false);
    expect(matchesConstraint('abc', gt)).toBe(false);
    expect(matchesConstraint('Contoso Ltd', parseConstraint('n', '~contoso'))).toBe(true);
    expect(matchesConstraint('Contoso Ltd', parseConstraint('n', '~C%Ltd'))).toBe(true);
    expect(matchesConstraint('Contoso Ltd', parseConstraint('n', '~Fab%'))).toBe(false);
    expect(matchesConstraint('US', parseConstraint('r', '!=EU'))).toBe(true);
    expect(matchesConstraint(5, parseConstraint('r', '=5.0'))).toBe(true);
    expect(matchesConstraint('2026-03-01', parseConstraint('d', '>2026-01-01'))).toBe(true);
  });
  it('produces satisfying values and parameterized SQL', () => {
    expect(satisfyingValue(parseConstraint('l', '>10000'))).toBe(10001);
    expect(satisfyingValue(parseConstraint('l', '<5.5'))).toBeCloseTo(5.49);
    expect(satisfyingValue(parseConstraint('l', '!=x'))).toBeUndefined();
    expect(satisfyingValue(parseConstraint('d', '>2026-01-01'))).toBe('2026-01-02');
    const w = toSqlWhere(parseWhere({ region: 'EU', creditLimit: '>10000', name: "~O'Brien" }), (f) => (f === 'creditLimit' ? 'credit_limit' : f), 'postgres');
    expect(w.sql).toBe('"region" = $1 AND "credit_limit" > $2 AND "name" ILIKE $3');
    expect(w.params).toEqual(['EU', 10000, "%O'Brien%"]);
    expect(toSqlWhere([], (f) => f, 'sqlite')).toEqual({ sql: '1=1', params: [] });
    expect(() => quoteIdent('x; DROP TABLE y', 'sqlite')).toThrow(/Invalid SQL identifier/);
    expect(quoteIdent('dbo.customers', 'mssql')).toBe('[dbo].[customers]');
  });
});

describe('DataFabric against the demo app database', () => {
  let demo: DemoServer;
  let db: SqliteDbClient;
  const mapping = {
    Customer: { table: 'customers', key: 'id', defaults: { name: 'gen:company', region: 'EU', creditLimit: 1000 } },
  };
  beforeAll(async () => {
    demo = await startDemoApp();
    db = new SqliteDbClient({ database: demo.db });
  });
  afterAll(() => demo.close());

  const fabric = (owner: string) =>
    new DataFabric({ providers: [new SqlDataProvider({ db, entities: mapping, name: 'demo-db' })], leases: new LeaseRegistry({ dir: leaseDir, owner }) });

  it('finds and leases a matching record, then releases it', async () => {
    const f = fabric('w1');
    const r = await f.resolve({ as: 'customer', entity: 'Customer', where: { region: 'EU', creditLimit: '>10000' } });
    expect(r.source).toBe('found');
    expect(r.record.name).toBe('Contoso Ltd');
    expect(r.record.creditLimit).toBe(25000);
    expect(r.record.credit_limit).toBe(25000);
    expect(readdirSync(leaseDir).filter((x) => x.endsWith('.lease'))).toHaveLength(1);
    const rep = await f.release();
    expect(rep.leasesReleased).toBe(1);
    expect(readdirSync(leaseDir).filter((x) => x.endsWith('.lease'))).toHaveLength(0);
  });

  it('two parallel resolvers never get the same record; the third creates one and cleans it up', async () => {
    const need = { as: 'customer', entity: 'Customer', where: { region: 'EU', creditLimit: '>10000' } };
    const [a, b] = [fabric('worker-a'), fabric('worker-b')];
    const [ra, rb] = await Promise.all([a.resolve(need), b.resolve(need)]);
    expect(new Set([ra.record.id, rb.record.id]).size).toBe(2);
    expect([ra.record.name, rb.record.name].sort()).toEqual(['Contoso Ltd', 'Northwind Traders']);

    const c = fabric('worker-c');
    await expect(c.resolve({ ...need, strategy: 'find' })).rejects.toThrow(/No available Customer where region = EU, creditLimit > 10000/);
    const rc = await c.resolve(need); // find-or-create
    expect(rc.source).toBe('created');
    expect(rc.record.region).toBe('EU');
    expect(rc.record.creditLimit).toBe(10001);
    expect(typeof rc.record.name).toBe('string');
    const createdId = rc.record.id as number;
    expect(await db.query('SELECT id FROM customers WHERE id = ?', [createdId])).toHaveLength(1);

    const rep = await c.release();
    expect(rep.ok).toBe(true);
    expect(rep.cleaned).toEqual([`delete demo-db:Customer:${createdId}`]);
    expect(await db.query('SELECT id FROM customers WHERE id = ?', [createdId])).toHaveLength(0);
    await a.release();
    await b.release();
    const again = fabric('worker-d');
    expect((await again.resolve({ ...need, strategy: 'find' })).source).toBe('found');
    await again.release();
  });

  it('cleans up created data even when the journey fails, in reverse order', async () => {
    const f = fabric('w-fail');
    let ids: number[] = [];
    await expect(
      f.withData(
        [
          { as: 'c1', entity: 'Customer', where: { region: 'APAC' }, strategy: 'create' },
          { as: 'c2', entity: 'Customer', where: { region: 'APAC', name: '=Second Co' }, strategy: 'create' },
        ],
        async (data) => {
          ids = [data.c1.id as number, data.c2.id as number];
          expect(data.c2.name).toBe('Second Co');
          throw new Error('journey failed');
        },
      ),
    ).rejects.toThrow('journey failed');
    expect(ids).toHaveLength(2);
    expect(await db.query("SELECT id FROM customers WHERE region = 'APAC'")).toEqual([]);
  });

  it('rejects unknown entities and duplicate aliases', async () => {
    const f = fabric('w-x');
    await expect(f.resolve({ as: 'x', entity: 'Nope' })).rejects.toThrow(/No data provider handles entity "Nope"/);
    await expect(
      f.resolveAll([
        { as: 'c', entity: 'Customer', where: { region: 'US' }, strategy: 'find' },
        { as: 'c', entity: 'Customer', where: { region: 'EU' }, strategy: 'find' },
      ]),
    ).rejects.toThrow(/Duplicate data alias/);
    await f.release();
  });
});

describe('LeaseRegistry', () => {
  it('is exclusive, expires, renews and only releases its own lease', async () => {
    let now = 1_000;
    const a = new LeaseRegistry({ dir: leaseDir, owner: 'a', ttlMs: 1000, now: () => now });
    const b = new LeaseRegistry({ dir: leaseDir, owner: 'b', ttlMs: 1000, now: () => now });
    const la = await a.tryAcquire('res-1');
    expect(la?.owner).toBe('a');
    expect(await b.tryAcquire('res-1')).toBeUndefined();
    expect((await b.holder('res-1'))?.owner).toBe('a');
    now += 500;
    const renewed = await a.renew(la!);
    expect(renewed.expiresAt).toBe(2500);
    now += 1600; // expired
    const lb = await b.tryAcquire('res-1');
    expect(lb?.owner).toBe('b');
    expect(await a.release(la!)).toBe(false); // lost; must not delete b's lease
    expect((await a.holder('res-1'))?.owner).toBe('b');
    await expect(a.renew(la!)).rejects.toThrow(/lost/);
    expect(await b.release(lb!)).toBe(true);
    expect(await a.holder('res-1')).toBeUndefined();
  });

  it('only one of many concurrent acquirers wins', async () => {
    const regs = Array.from({ length: 12 }, (_, i) => new LeaseRegistry({ dir: leaseDir, owner: `w${i}` }));
    const results = await Promise.all(regs.map((r) => r.tryAcquire('hot-record')));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('treats a half-written lease file as held until it is older than the TTL', async () => {
    const reg = new LeaseRegistry({ dir: leaseDir, ttlMs: 60_000 });
    const file = join(leaseDir, createHash('sha256').update('r').digest('hex').slice(0, 40) + '.lease');
    writeFileSync(file, '');
    expect(await reg.tryAcquire('r')).toBeUndefined();
  });
});

describe('CleanupRegistry', () => {
  it('runs in reverse order and continues after failures', async () => {
    const order: string[] = [];
    const c = new CleanupRegistry();
    c.add('first', async () => void order.push('first'));
    c.add('second', async () => {
      throw new Error('cannot delete secret-xyz');
    });
    c.add('third', async () => void order.push('third'));
    const r = await c.runAll((s) => s.replace('secret-xyz', '****'));
    expect(order).toEqual(['third', 'first']);
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual([{ description: 'second', error: 'cannot delete ****' }]);
    expect(c.size).toBe(0);
  });
});

describe('ApiDataProvider', () => {
  it('finds via GET, creates via POST and deletes via DELETE', async () => {
    const store = new Map<number, Record<string, unknown>>([[1, { id: 1, name: 'Existing', tier: 'gold' }]]);
    let next = 100;
    const mock = await startMock((req, body, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'GET' && u.pathname === '/api/accounts') return json(res, 200, { items: [...store.values()] });
      if (req.method === 'POST' && u.pathname === '/api/accounts') {
        const rec = { id: next++, ...JSON.parse(body) };
        store.set(rec.id, rec);
        return json(res, 201, rec);
      }
      const m = /^\/api\/accounts\/(\d+)$/.exec(u.pathname);
      if (req.method === 'DELETE' && m) {
        store.delete(Number(m[1]));
        res.writeHead(204);
        return res.end();
      }
      return json(res, 404, {});
    });
    try {
      const api = new ApiClient({ baseUrl: mock.url });
      const f = new DataFabric({
        providers: [new ApiDataProvider({ api, entities: { Account: { listPath: '/api/accounts', createPath: '/api/accounts', deletePath: '/api/accounts/{id}', defaults: { name: 'gen:company' } } } })],
        leases: new LeaseRegistry({ dir: leaseDir }),
      });
      const found = await f.resolve({ as: 'a', entity: 'Account', where: { tier: 'gold' } });
      expect(found.source).toBe('found');
      expect(found.record.name).toBe('Existing');
      const created = await f.resolve({ as: 'b', entity: 'Account', where: { tier: 'silver' } });
      expect(created.source).toBe('created');
      expect(created.record).toMatchObject({ id: 100, tier: 'silver' });
      expect(store.has(100)).toBe(true);
      const rep = await f.release();
      expect(rep.ok).toBe(true);
      expect(store.has(100)).toBe(false);
      expect(store.has(1)).toBe(true);
    } finally {
      await mock.close();
    }
  });
});

describe('Synthetic data', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const gen = (seed: string | number) => {
      const s = new Synthetic(seed);
      return [s.fullName(), s.email(), s.phone(), s.company(), s.address(), s.date().toISOString(), s.int(1, 1e6), s.cardNumber(), s.iban(), s.uuid(), s.businessDay()];
    };
    expect(gen('seed-1')).toEqual(gen('seed-1'));
    expect(gen(7)).toEqual(gen(7));
    expect(gen('seed-1')).not.toEqual(gen('seed-2'));
  });

  it('produces valid-shaped values', () => {
    const s = new Synthetic('shapes');
    for (let i = 0; i < 50; i++) {
      expect(luhnValid(s.cardNumber('visa'))).toBe(true);
      const mc = s.cardNumber('mastercard');
      expect(mc).toMatch(/^5[1-5]\d{14}$/);
      expect(luhnValid(mc)).toBe(true);
      expect(s.cardNumber('amex')).toMatch(/^3[47]\d{13}$/);
      expect(ibanValid(s.iban('DE'))).toBe(true);
      expect(ibanValid(s.iban('GB'))).toBe(true);
      expect(ibanValid(s.iban('NL'))).toBe(true);
      expect(s.uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(s.email()).toMatch(/^[a-z0-9.]+@example\.(com|org|net)$/);
      expect(s.phone()).toMatch(/^\+1-\d{3}-555-01\d{2}$/);
      const bd = new Date(s.businessDay({ from: '2026-01-01', to: '2026-01-31' }) + 'T00:00:00Z');
      expect([1, 2, 3, 4, 5]).toContain(bd.getUTCDay());
      expect(bd.getUTCMonth()).toBe(0);
      const d = s.date({ from: '2026-02-01', to: '2026-02-10' });
      expect(d.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-02-01'));
      expect(d.getTime()).toBeLessThanOrEqual(Date.parse('2026-02-10'));
    }
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(ibanValid('DE89370400440532013000')).toBe(true);
    expect(ibanValid('DE89370400440532013001')).toBe(false);
    expect(() => s.date({ from: '2026-02-10', to: '2026-02-01' })).toThrow();
    expect(() => s.byName('nope')).toThrow(/Unknown synthetic generator/);
  });

  it('generates edge cases', () => {
    const s = new Synthetic(1);
    expect(s.boundaryNumbers(1, 100)).toEqual([0, 1, 2, 99, 100, 101]);
    expect(s.boundaryNumbers(-5, 5)).toEqual([-6, -5, -4, 0, 4, 5, 6]);
    expect(s.longString(300)).toHaveLength(300);
    expect(s.edgeCases('long').map((x) => x.length)).toEqual([255, 256, 4000]);
    expect(s.edgeCases('sql')).toContain("O'Brien");
    expect(s.edgeCases('html').some((x) => x.includes('<script>'))).toBe(true);
    expect(s.edgeCases('rtl').some((x) => /[֐-ۿ]/.test(x))).toBe(true);
    expect(s.edgeCases('emoji').every((x) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(x))).toBe(true);
    const all = s.allEdgeCases();
    expect(new Set(all.map((a) => a.kind)).size).toBe(8);
    expect(s.extremeNumbers()).toContain(Number.MAX_SAFE_INTEGER + 2);
  });

  it('SyntheticProvider generates records satisfying constraints, deterministically', async () => {
    const make = () => new SyntheticProvider({ seed: 'run-1', entities: { Customer: { name: 'gen:company', email: 'gen:email', creditLimit: (s: Synthetic) => s.int(0, 5000), region: 'US' } } });
    const f1 = new DataFabric({ providers: [make()], leases: new LeaseRegistry({ dir: leaseDir }) });
    const f2 = new DataFabric({ providers: [make()], leases: new LeaseRegistry({ dir: leaseDir }) });
    const need = { as: 'c', entity: 'Customer', where: { region: 'EU', creditLimit: '>10000' }, strategy: 'generate' as const };
    const a = await f1.resolve(need);
    const b = await f2.resolve(need);
    expect(a.source).toBe('generated');
    expect(a.record).toEqual(b.record);
    expect(a.record.region).toBe('EU');
    expect(a.record.creditLimit).toBe(10001);
    expect(a.lease).toBeUndefined();
  });
});

describe('maskRecord', () => {
  it('masks deterministically with hash, redact, partial, email and null rules', () => {
    const rec = { id: 7, name: 'Contoso Ltd', email: 'Jane.Doe@contoso.com', iban: 'DE89370400440532013000', notes: 'secret', phone: '+1 555 0100', untouched: 1 };
    const rules = { name: 'hash', email: 'email', iban: { type: 'partial', keepStart: 2, keepEnd: 4 }, notes: 'redact', phone: 'null' } as const;
    const a = maskRecord(rec, rules, { salt: 's1' });
    const b = maskRecord(rec, rules, { salt: 's1' });
    const c = maskRecord(rec, rules, { salt: 's2' });
    expect(a).toEqual(b);
    expect(a.name).not.toBe(c.name);
    expect(a.name).toMatch(/^[0-9a-f]{16}$/);
    expect(a.email).toMatch(/^user-[0-9a-f]{10}@example\.com$/);
    expect(maskRecord({ email: 'jane.doe@CONTOSO.com' }, { email: 'email' }, { salt: 's1' }).email).toBe(maskRecord({ email: 'Jane.Doe@contoso.com' }, { email: 'email' }, { salt: 's1' }).email);
    expect(a.iban).toBe('DE****************3000');
    expect(a.notes).toBe('[REDACTED]');
    expect(a.phone).toBeNull();
    expect(a.untouched).toBe(1);
    expect(rec.name).toBe('Contoso Ltd'); // not mutated
    expect(maskRows([rec, rec], { name: 'hash' })).toHaveLength(2);
    expect(() => maskRecord(rec, { name: 'scramble' as 'hash' })).toThrow(/Not supported/);
  });
});
