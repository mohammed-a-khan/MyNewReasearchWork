/**
 * Database helpers that need no server: the SQL scanner, ${var} binding for
 * every dialect (Oracle included), case-insensitive rows, Oracle type helpers,
 * the named-query catalogue, its grammar and YAML forms, and journey validation.
 */
import { describe, expect, it } from '../support/testkit.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  caseInsensitiveRow,
  compareRows,
  getColumn,
  isPlsql,
  namedToPositional,
  oracleConnectString,
  oracleNumber,
  oracleStatement,
  scanSql,
} from '../../src/surfaces/index.js';
import { bindSql, procedureSql } from '../../src/runner/data-steps.js';
import { QueryCatalogue, parseQueryExamplesSource, parseQueryFile, validateQueryRefs } from '../../src/queries/index.js';
import { parseEzScript, journeyToEzScript, parseIntent, stepToText, normalizeJourneyInput } from '../../src/intent/index.js';
import { EzTestConfigSchema } from '../../src/config/schema.js';

describe('scanSql', () => {
  it('finds binds outside literals, identifiers, comments, casts and PL/SQL assignments', () => {
    const sql = `SELECT ':nope', "a:b", q'[ :also_not ]' -- :comment
      /* :block */ FROM t WHERE a = :a AND b = ? AND c::text = :c AND x := 1`;
    const t = scanSql(sql);
    expect(t.map((x) => (x.kind === 'named' ? `:${x.name}` : x.kind))).toEqual([':a', 'positional', ':c']);
  });
  it('reports ${var} and literals containing ${var}', () => {
    const t = scanSql(`SELECT * FROM t WHERE a = \${x} AND b LIKE '%\${y}%'`, { vars: true, literalVars: true, named: false, positional: false });
    expect(t.map((x) => x.kind === 'var' && x.name)).toEqual(['x', '%${y}%']);
  });
  it('rewrites named binds per occurrence for each dialect', () => {
    const sql = 'SELECT * FROM t WHERE a = :id OR b = :id AND c = :name';
    expect(namedToPositional(sql, { id: 1, name: 'x' }, 'oracle')).toEqual({ sql: 'SELECT * FROM t WHERE a = :1 OR b = :2 AND c = :3', params: [1, 1, 'x'], names: ['id', 'id', 'name'] });
    expect(namedToPositional(sql, { id: 1, name: 'x' }, 'mssql').sql).toBe('SELECT * FROM t WHERE a = @p1 OR b = @p2 AND c = @p3');
    expect(namedToPositional(sql, { id: 1, name: 'x' }, 'postgres').sql).toBe('SELECT * FROM t WHERE a = $1 OR b = $2 AND c = $3');
    expect(() => namedToPositional(sql, { id: 1 }, 'sqlite')).toThrow(/:name/);
  });
  it('keeps PL/SQL terminators and strips plain-SQL ones', () => {
    expect(oracleStatement('SELECT 1 FROM dual;')).toBe('SELECT 1 FROM dual');
    expect(oracleStatement('BEGIN NULL; END;')).toBe('BEGIN NULL; END;');
    expect(oracleStatement('CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;\n/')).toBe('CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;');
    expect(isPlsql('  -- x\n DECLARE n NUMBER; BEGIN NULL; END;')).toBe(true);
  });
});

describe('bindSql (${var} -> bound parameters)', () => {
  const vars = { id: 7, name: "O'Brien'; DROP TABLE t; --", region: 'EU', when: { y: 2026 } };
  it('binds Oracle variables as :1..:n in order of appearance, literals included', () => {
    const r = bindSql("SELECT * FROM t WHERE id = ${id} AND name LIKE '%${name}%' AND r = :r AND y = ${when.y}", ['EU'], vars, 'oracle');
    expect(r.sql).toBe('SELECT * FROM t WHERE id = :1 AND name LIKE :2 AND r = :3 AND y = :4');
    expect(r.params).toEqual([7, `%${vars.name}%`, 'EU', 2026]);
  });
  it('keeps the other dialects as before', () => {
    expect(bindSql('SELECT * FROM t WHERE a = ? AND b = ${id}', ['x'], vars, 'sqlite')).toEqual({ sql: 'SELECT * FROM t WHERE a = ? AND b = ?', params: ['x', 7] });
    expect(bindSql('SELECT * FROM t WHERE a = $1 AND b = ${id}', ['x'], vars, 'postgres')).toEqual({ sql: 'SELECT * FROM t WHERE a = $1 AND b = $2', params: ['x', 7] });
    expect(bindSql('SELECT * FROM t WHERE b = ${id}', [], vars, 'mssql')).toEqual({ sql: 'SELECT * FROM t WHERE b = @p1', params: [7] });
    // a ? inside a comment or literal is not a marker
    expect(bindSql("SELECT '?' -- ?\n FROM t WHERE b = ${region}", [], vars, 'sqlite')).toEqual({ sql: "SELECT '?' -- ?\n FROM t WHERE b = ?", params: ['EU'] });
  });
  it('fails on unknown variables instead of splicing', () => {
    expect(() => bindSql('SELECT ${nope} FROM dual', [], vars, 'oracle')).toThrow(/no such variable/);
  });
  it('builds Oracle procedure calls', () => {
    expect(procedureSql('billing.close_invoice', 2, 'oracle')).toBe('BEGIN billing.close_invoice(:1, :2); END;');
    expect(() => procedureSql('x; DROP', 0, 'oracle')).toThrow(/Invalid procedure/);
  });
});

describe('case-insensitive rows and comparison', () => {
  it('keeps the original keys but reads any casing', () => {
    const r = caseInsensitiveRow({ ORDER_ID: 1, Status: 'OPEN' });
    expect(Object.keys(r)).toEqual(['ORDER_ID', 'Status']);
    expect((r as Record<string, unknown>).order_id).toBe(1);
    expect('status' in r).toBe(true);
    expect('missing' in r).toBe(false);
    expect(JSON.stringify(r)).toBe('{"ORDER_ID":1,"Status":"OPEN"}');
    expect(r).toEqual({ ORDER_ID: 1, Status: 'OPEN' });
    expect(getColumn({ Amount: 2 }, 'AMOUNT')).toBe(2);
  });
  it('compares an Oracle-style row set with an API/SQL Server one by key, typed', () => {
    const oracle = [{ ORDER_ID: 1, TOTAL: 25000, PLACED: new Date('2026-03-01T10:00:00Z'), NOTE: null }, { ORDER_ID: 2, TOTAL: '19.99', PLACED: new Date('2026-03-02T00:00:00Z'), NOTE: 'x' }];
    const api = [{ order_id: '1', total: '25000.00', placed: '2026-03-01T10:00:00.000Z', note: null }, { order_id: 2, total: 19.99, placed: '2026-03-02T00:00:00Z', note: 'x' }];
    expect(compareRows(oracle, api, { key: 'order_id' }).summary).toBe('PASS: 2 rows x 3 columns equal');
    expect(compareRows(api, oracle, { key: 'ORDER_ID' }).passed).toBe(true);
    const bad = compareRows(api, [{ ORDER_ID: 1, TOTAL: 25001, PLACED: new Date('2026-03-01T10:00:00Z'), NOTE: null }], { key: 'order_id', failOnExtra: false });
    expect(bad.passed).toBe(false);
    expect(bad.mismatches[0]).toMatchObject({ column: 'total', reason: 'numbers differ by 1' });
  });
});

describe('Oracle helpers', () => {
  it('maps NUMBER text without losing precision', () => {
    expect(oracleNumber('.5')).toBe(0.5);
    expect(oracleNumber('-12.25')).toBe(-12.25);
    expect(oracleNumber('42')).toBe(42);
    expect(oracleNumber('12345678901234567890')).toBe('12345678901234567890');
    expect(oracleNumber('0.1234567890123456789')).toBe('0.1234567890123456789');
    expect(oracleNumber(null)).toBeNull();
  });
  it('builds connect strings from serviceName or SID', () => {
    expect(oracleConnectString({ host: 'db', serviceName: 'FREEPDB1' })).toBe('db:1521/FREEPDB1');
    expect(oracleConnectString({ host: 'db', port: 1522, sid: 'ORCL' })).toBe('(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db)(PORT=1522))(CONNECT_DATA=(SID=ORCL)))');
    expect(oracleConnectString({ connectString: 'tns_alias', host: 'ignored' })).toBe('tns_alias');
    expect(() => oracleConnectString({ host: 'db' })).toThrow(/serviceName or sid/);
  });
  it('validates oracle connections in config (type: alias, secrets, pool)', () => {
    const c = EzTestConfigSchema.parse({ db: { connections: { ledger: { type: 'oracle', host: 'h', serviceName: 'S', user: 'u', password: 'secret://env/P', pool: { max: 8 }, fetchAsString: ['DATE'] }, sql: { type: 'sqlserver', server: 's' } } } });
    expect(c.db.connections.ledger).toMatchObject({ driver: 'oracle', pool: { min: 0, max: 8 } });
    expect(c.db.connections.sql.driver).toBe('mssql');
    expect(c.db.queries).toEqual({ dir: 'queries', inline: {} });
    expect(() => EzTestConfigSchema.parse({ db: { connections: { x: { driver: 'oracle', host: 'h' } } } })).toThrow(/serviceName or sid/);
  });
});

async function catalogueDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'eztest-queries-'));
  for (const [name, text] of Object.entries(files)) {
    const p = join(dir, 'queries', name);
    await mkdir(join(p, '..'), { recursive: true });
    await writeFile(p, text);
  }
  return dir;
}

describe('named-query catalogue', () => {
  const files = {
    'OPEN_INVOICES.sql': `-- connection: ledger
-- description: Open invoices of a customer
-- params: customer_id:number, status = 'OPEN'
SELECT invoice_no, amount FROM invoices i
 WHERE i.customer_id = :customer_id AND i.status = :status {{> not_archived}}
 ORDER BY invoice_no`,
    'fragments/not_archived.sql': "-- description: skip archived rows\nAND i.archived = 'N' {{> tenant}}",
    'fragments/tenant.sql': 'AND i.tenant = :tenant',
    'BY_POSITION.sql': 'SELECT * FROM t WHERE a = ? AND b = ?',
  };

  it('loads files, expands fragments and compiles named binds per dialect', async () => {
    const cwd = await catalogueDir(files);
    const cat = await QueryCatalogue.load({ cwd, inline: { INLINE_ONE: 'SELECT 1 AS one FROM dual' } });
    expect(cat.names()).toEqual(['BY_POSITION', 'INLINE_ONE', 'OPEN_INVOICES']);
    expect(cat.names({ fragments: true })).toContain('not_archived');
    expect(cat.get('OPEN_INVOICES')).toMatchObject({ connection: 'ledger', description: 'Open invoices of a customer', source: 'queries/OPEN_INVOICES.sql' });
    // The fragment's bind is not declared in the header: a static problem.
    expect(cat.problemsOf('OPEN_INVOICES')).toEqual(['queries/OPEN_INVOICES.sql: "OPEN_INVOICES" uses :tenant but the header does not declare it']);
  });

  it('binds values (never splices), applies defaults and types', async () => {
    const cwd = await catalogueDir({ ...files, 'fragments/tenant.sql': "AND i.tenant = 'T1'" });
    const cat = await QueryCatalogue.load({ cwd });
    const evil = "1 OR 1=1; DROP TABLE invoices --";
    expect(() => cat.compile('OPEN_INVOICES', { binds: { customer_id: evil } }, 'oracle')).toThrow(/must be a number/);
    const c = cat.compile('OPEN_INVOICES', { binds: { customer_id: '42' } }, 'oracle');
    expect(c.sql).toContain('WHERE i.customer_id = :1 AND i.status = :2 AND i.archived = \'N\' AND i.tenant = \'T1\'');
    expect(c.params).toEqual([42, 'OPEN']);
    const m = cat.compile('OPEN_INVOICES', { binds: { CUSTOMER_ID: 7, status: "x' OR 'a'='a" } }, 'mssql');
    expect(m.sql).toContain('@p1 AND i.status = @p2');
    expect(m.params).toEqual([7, "x' OR 'a'='a"]);
    expect(cat.compile('BY_POSITION', { params: [1, 'b'] }, 'postgres')).toMatchObject({ sql: 'SELECT * FROM t WHERE a = $1 AND b = $2', params: [1, 'b'] });
    expect(cat.checkCall('OPEN_INVOICES', [])).toEqual(['query "OPEN_INVOICES" needs param "customer_id"']);
    expect(cat.checkCall('OPEN_INVOICES', ['customer_id', 'colour'])).toEqual(['query "OPEN_INVOICES" has no param "colour" (params: customer_id, status)']);
    expect(cat.checkCall('BY_POSITION', [], 1)).toEqual(['query "BY_POSITION" has 2 ? marker(s) but 1 positional value(s) were given']);
    expect(cat.checkCall('NOPE', [])[0]).toMatch(/Unknown query "NOPE"/);
  });

  it('rejects SQL splicing, include cycles, duplicates and unknown fragments', async () => {
    await expect(QueryCatalogue.load({ cwd: await catalogueDir({ 'A.sql': 'SELECT * FROM t WHERE a = ${x}' }) })).rejects.toThrow(/bind-parameter only/);
    await expect(QueryCatalogue.load({ cwd: await catalogueDir({ 'A.sql': 'SELECT * FROM t {{FILTER_CTE}}' }) })).rejects.toThrow(/only \{\{> fragment\}\} includes/);
    await expect(QueryCatalogue.load({ cwd: await catalogueDir({ 'A.sql': 'SELECT 1 {{> B}}', 'B.sql': '{{> A}}' }) })).rejects.toThrow(/Include cycle: A -> B -> A/);
    await expect(QueryCatalogue.load({ cwd: await catalogueDir({ 'A.sql': 'SELECT 1 {{> missing}}' }) })).rejects.toThrow(/unknown fragment "missing"/);
    await expect(QueryCatalogue.load({ cwd: await catalogueDir({ 'A.sql': 'SELECT 1' }), inline: { A: 'SELECT 2' } })).rejects.toThrow(/defined twice/);
    const unused = await QueryCatalogue.load({ cwd: await catalogueDir({ 'A.sql': '-- params: a\nSELECT 1', 'B.sql': 'SELECT :x, ? FROM dual' }) });
    expect(unused.problemsOf('A')).toEqual(['queries/A.sql: "A" declares param "a" but never uses :a']);
    expect(unused.checkCall('B', ['x'], 1)).toEqual(['queries/B.sql: "B" mixes :name and ? binds; use one style']);
    // a missing default dir is just an empty catalogue
    expect((await QueryCatalogue.load({ cwd: tmpdir(), dir: 'no-such-dir-xyz' })).names()).toEqual([]);
  });

  it('reads headers', () => {
    const q = parseQueryFile('-- name: X\n-- params: a, b:number = 2, c:date, d = null\n\nSELECT :a, :b, :c, :d FROM dual', 'X', 'x.sql');
    expect(q.declared).toEqual([{ name: 'a', type: 'any' }, { name: 'b', type: 'number', default: 2 }, { name: 'c', type: 'date' }, { name: 'd', type: 'any', default: null }]);
    expect(q.sql).toBe('SELECT :a, :b, :c, :d FROM dual');
    expect(() => parseQueryFile('-- name: Y\nSELECT 1', 'X', 'x.sql')).toThrow(/differs/);
  });
});

describe('query steps: grammar, rendering, YAML and validation', () => {
  it('parses the catalogue phrasings with category Database', () => {
    const run = parseIntent('Run query "OPEN_INVOICES" on ledger with customer_id=${customerId}, status="PAID" and store the rows as invoices');
    expect(run).toMatchObject({ action: 'db', db: { connection: 'ledger', sql: '', query: 'OPEN_INVOICES', binds: { customer_id: '${customerId}', status: 'PAID' } }, captureAs: 'invoices' });
    expect(parseIntent('Run query "OPEN_INVOICES" with customer_id=7 as x').db).toMatchObject({ connection: '', binds: { customer_id: 7 } });
    expect(parseIntent('Get the value of query "INVOICE_TOTAL" on ledger with invoice_no="007" as total')).toMatchObject({ db: { query: 'INVOICE_TOTAL', capture: 'cell', binds: { invoice_no: '007' } }, captureAs: 'total' });
    const exp = parseIntent('Expect query "OPEN_INVOICES" on ledger with customer_id=7 returns 2 rows');
    expect(exp).toMatchObject({ action: 'db', captureAs: 'query_OPEN_INVOICES', postconditions: [{ type: 'dbRowCount', captureKey: 'query_OPEN_INVOICES', equals: 2 }] });
    expect(parseIntent('Expect query "X" returns at least 1 row').postconditions).toEqual([{ type: 'expr', expr: 'len(query_X) >= 1' }]);
    expect(parseIntent('Expect query "X" returns no rows').postconditions).toEqual([{ type: 'dbRowCount', captureKey: 'query_X', equals: 0 }]);
    const wait = parseIntent('Wait until query "INVOICE_POSTED" on ledger with invoice_no=${no} returns 1 row within 10 seconds every 2 seconds');
    expect(wait).toMatchObject({ db: { query: 'INVOICE_POSTED' }, poll: { attempts: 5, intervalMs: 2000 } });
    const proc = parseIntent('Call procedure "billing.close_invoice" on ledger with params \'[42]\' and out status, total:number as closed');
    expect(proc).toMatchObject({ db: { procedure: 'billing.close_invoice', params: [42], out: [{ name: 'status', type: 'string' }, { name: 'total', type: 'number' }] }, captureAs: 'closed' });
    // quoted SQL still goes to the inline-SQL rules
    expect(parseIntent('Run query "SELECT 1" on shop as one').db).toMatchObject({ sql: 'SELECT 1' });
    expect(parseIntent('Run query "COMMIT" on shop as x').db?.query).toBeUndefined();
  });

  it('round-trips through .ez text', () => {
    const j = parseEzScript(['Journey: Q', 'Run query "OPEN_INVOICES" on ledger with customer_id=${id}, status="OPEN", n=2 and store the rows as inv', 'Get the row count of query "OPEN_INVOICES" with customer_id=7 as n', 'Call procedure "p" on ledger and out total:number as o'].join('\n'));
    const text = journeyToEzScript(j);
    expect(text).toContain('Run query "OPEN_INVOICES" on ledger with customer_id=${id}, status="OPEN", n=2 and store the rows as inv');
    expect(text).toContain('Get the row count of query "OPEN_INVOICES" with customer_id=7 as n');
    expect(text).toContain('Call procedure "p" on ledger and out total:number as o');
    const again = parseEzScript(text);
    expect(again.steps.map((s) => s.db)).toEqual(j.steps.map((s) => s.db));
    expect(stepToText(j.steps[0])).toMatch(/^Run query "OPEN_INVOICES"/);
  });

  it('accepts YAML/JSON sugar and the canonical db form', () => {
    const j = normalizeJourneyInput({
      name: 'yaml',
      steps: [
        { query: 'OPEN_INVOICES', on: 'ledger', with: { customer_id: 7, status: 'OPEN' }, as: 'inv' },
        { query: 'OPEN_INVOICES', with: { customer_id: 7 }, returns: 2 },
        { query: 'INVOICE_TOTAL', with: { invoice_no: '007' }, capture: 'value', as: 'total' },
        { query: 'INVOICE_POSTED', with: { invoice_no: '${no}' }, returns: 'at least 1', within: '5 seconds' },
        { action: 'db', db: { connection: 'ledger', query: 'OPEN_INVOICES', binds: { customer_id: 7 } }, captureAs: 'raw' },
      ],
    });
    expect(j.steps[0]).toMatchObject({ db: { connection: 'ledger', query: 'OPEN_INVOICES', binds: { customer_id: 7, status: 'OPEN' } }, captureAs: 'inv' });
    expect(j.steps[1].postconditions[0]).toMatchObject({ type: 'dbRowCount', equals: 2 });
    expect(j.steps[2]).toMatchObject({ db: { capture: 'cell', binds: { invoice_no: '007' } }, captureAs: 'total' });
    expect(j.steps[3]).toMatchObject({ poll: { attempts: 5 }, postconditions: [{ type: 'expr', expr: 'len(query_INVOICE_POSTED) >= 1' }] });
    expect(j.steps[4].db).toMatchObject({ sql: '', query: 'OPEN_INVOICES' });
  });

  it('validates references: query exists, params supplied, connection known', async () => {
    const cwd = await catalogueDir({ 'OPEN_INVOICES.sql': '-- connection: ledger\n-- params: customer_id\nSELECT * FROM inv WHERE c = :customer_id', 'NO_CONN.sql': 'SELECT 1 FROM dual' });
    const cat = await QueryCatalogue.load({ cwd });
    const j = parseEzScript(['Journey: refs', 'Run query "OPEN_INVOICES" as a', 'Run query "OPEN_INVOICES" with customer_id=1, extra=2 as b', 'Run query "MISSING" on ledger as c', 'Run query "NO_CONN" as d', 'Run query "OPEN_INVOICES" on other with customer_id=1 as e', 'If ${x} equals 1 then', '  Run query "OPEN_INVOICES" with customer_id=1 as f', 'End'].join('\n'));
    expect(validateQueryRefs(j, cat, ['ledger'])).toEqual([
      'step "Run query "OPEN_INVOICES" as a": query "OPEN_INVOICES" needs param "customer_id"',
      'step "Run query "OPEN_INVOICES" with customer_id=1, extra=2 as b": query "OPEN_INVOICES" has no param "extra" (params: customer_id)',
      'step "Run query "MISSING" on ledger as c": Unknown query "MISSING"',
      'step "Run query "NO_CONN" as d": query "NO_CONN" has no connection (add "on <alias>" or a "-- connection:" header)',
      'step "Run query "OPEN_INVOICES" on other with customer_id=1 as e": unknown connection "other" (db.connections: ledger)',
    ]);
  });

  it('parses Examples-from-query sources', () => {
    expect(parseQueryExamplesSource('from query "ACTIVE_CUSTOMERS" on ledger where region = "EU" and min_limit = 1000')).toEqual({ name: 'ACTIVE_CUSTOMERS', alias: 'ledger', params: { region: 'EU', min_limit: 1000 } });
    expect(parseQueryExamplesSource('from query ACTIVE_CUSTOMERS')).toEqual({ name: 'ACTIVE_CUSTOMERS', params: {} });
    expect(parseQueryExamplesSource('from data "x.json"')).toBeUndefined();
  });
});
