/**
 * Cross-dialect checks on REAL servers: the same fictional rows in Oracle and
 * SQL Server (and the EZ Shop API) compare equal with typed, case-insensitive
 * row comparison; the same catalogue query runs on both dialects.
 *
 * Needs EZTEST_ORACLE_URL and EZTEST_MSSQL_URL (+ EZTEST_MSSQL_DRIVER when the
 * mssql package is not installed in this project). Skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MssqlDbClient, OracleDbClient, compareRows, type DbClient } from '../../src/surfaces/index.js';
import { QueryCatalogue, checkQueries } from '../../src/queries/index.js';
import { MSSQL_SKIP, ORACLE_SKIP, announceSkip, loadMssql, mssqlEnv, oracleEnv } from './db-env.js';

const ora = oracleEnv();
const ms = mssqlEnv();
const mssqlDriver = ms ? await loadMssql(ms.driverPath) : undefined;
const on = !!(ora && ms && mssqlDriver);
announceSkip(on, `${ora ? '' : ORACLE_SKIP + '; '}${ms && mssqlDriver ? '' : MSSQL_SKIP}`);

const ROWS: Array<[number, string, number, string, string | null]> = [
  [1, 'Contoso Ltd', 25000, '2024-01-15', 'Key account'],
  [2, 'Fabrikam Inc', 5000.5, '2024-06-01', null],
  [3, 'Northwind Traders', 12000, '2025-02-20', 'Ünïcödé ✓'],
];

describe.skipIf(!on)(`Oracle <-> SQL Server (live)${on ? '' : ` - ${ORACLE_SKIP} / ${MSSQL_SKIP}`}`, () => {
  let oracle: OracleDbClient;
  let sqlserver: MssqlDbClient;

  beforeAll(async () => {
    oracle = await OracleDbClient.connect({ ...ora! });
    sqlserver = await MssqlDbClient.connect({ server: ms!.server, port: ms!.port, database: ms!.database, user: ms!.user, password: ms!.password, encrypt: true, trustServerCertificate: true, driverModule: mssqlDriver });
    await oracle.plsql("BEGIN EXECUTE IMMEDIATE 'DROP TABLE ezt_x_accounts PURGE'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF; END;");
    await oracle.execute('CREATE TABLE ezt_x_accounts (account_id NUMBER(10) PRIMARY KEY, account_name VARCHAR2(80), credit_limit NUMBER(12,2), opened_on DATE, notes CLOB)');
    await sqlserver.execute("IF OBJECT_ID('dbo.ezt_x_accounts') IS NOT NULL DROP TABLE dbo.ezt_x_accounts");
    await sqlserver.execute('CREATE TABLE dbo.ezt_x_accounts (Account_Id INT PRIMARY KEY, Account_Name NVARCHAR(80), Credit_Limit DECIMAL(12,2), Opened_On DATE, Notes NVARCHAR(MAX))');
    for (const [id, name, limit, opened, notes] of ROWS) {
      await oracle.execute("INSERT INTO ezt_x_accounts VALUES (:1, :2, :3, TO_DATE(:4, 'YYYY-MM-DD'), :5)", [id, name, limit, opened, notes]);
      await sqlserver.execute('INSERT INTO dbo.ezt_x_accounts VALUES (@p1, @p2, @p3, @p4, @p5)', [id, name, limit, opened, notes]);
    }
  });

  afterAll(async () => {
    await oracle?.execute('DROP TABLE ezt_x_accounts PURGE').catch(() => undefined);
    await sqlserver?.execute('DROP TABLE dbo.ezt_x_accounts').catch(() => undefined);
    await oracle?.close();
    await sqlserver?.close();
  });

  it('compares Oracle rows (UPPER CASE) with SQL Server rows (Mixed_Case) by key, typed', async () => {
    const o = await oracle.query("SELECT account_id, account_name, credit_limit, TO_CHAR(opened_on, 'YYYY-MM-DD') AS opened_on, notes FROM ezt_x_accounts ORDER BY account_id");
    const s = await sqlserver.query('SELECT Account_Id, Account_Name, Credit_Limit, CONVERT(char(10), Opened_On, 23) AS Opened_On, Notes FROM dbo.ezt_x_accounts ORDER BY Account_Id');
    expect(Object.keys(o[0])).toEqual(['ACCOUNT_ID', 'ACCOUNT_NAME', 'CREDIT_LIMIT', 'OPENED_ON', 'NOTES']);
    expect(Object.keys(s[0])).toEqual(['Account_Id', 'Account_Name', 'Credit_Limit', 'Opened_On', 'Notes']);
    expect(s[1].credit_limit).toBe(5000.5);
    expect(o[2].notes).toBe('Ünïcödé ✓');
    expect(compareRows(o, s, { key: 'account_id' }).summary).toBe('PASS: 3 rows x 4 columns equal');
    expect(compareRows(s, o, { key: 'ACCOUNT_ID' }).passed).toBe(true);
    // Dates as native values: Oracle DATE and SQL Server DATE both come back as Date objects for the same day.
    const od = await oracle.query('SELECT account_id, opened_on FROM ezt_x_accounts');
    const sd = await sqlserver.query('SELECT Account_Id, Opened_On FROM dbo.ezt_x_accounts');
    expect(od[0].opened_on).toBeInstanceOf(Date);
    expect(sd[0].opened_on).toBeInstanceOf(Date);
    // A real difference is reported cell by cell.
    await sqlserver.execute('UPDATE dbo.ezt_x_accounts SET Credit_Limit = 5001 WHERE Account_Id = 2');
    const s2 = await sqlserver.query('SELECT Account_Id, Credit_Limit FROM dbo.ezt_x_accounts');
    const r = compareRows(await oracle.query('SELECT account_id, credit_limit FROM ezt_x_accounts'), s2, { key: 'account_id' });
    expect(r.passed).toBe(false);
    expect(r.mismatches).toEqual([{ key: '2', column: 'CREDIT_LIMIT', expected: 5000.5, actual: 5001, reason: 'numbers differ by 0.5' }]);
    await sqlserver.execute('UPDATE dbo.ezt_x_accounts SET Credit_Limit = 5000.5 WHERE Account_Id = 2');
  });

  it('runs one catalogue query on both dialects with the same named binds, and checks it on both', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'eztest-x-q-'));
    await mkdir(join(cwd, 'queries'), { recursive: true });
    await writeFile(join(cwd, 'queries', 'ACCOUNTS_OVER.sql'), '-- params: min_limit:number, name_like = \'%\'\nSELECT account_id, account_name FROM ezt_x_accounts WHERE credit_limit >= :min_limit AND account_name LIKE :name_like ORDER BY account_id');
    await writeFile(join(cwd, 'queries', 'ACCOUNTS_BROKEN.sql'), 'SELECT account_nmae FROM ezt_x_accounts WHERE account_id = :id');
    const cat = await QueryCatalogue.load({ cwd });
    const run = async (c: DbClient, binds: Record<string, string | number>) => {
      const q = cat.compile('ACCOUNTS_OVER', { binds }, c.dialect);
      return c.query(q.sql, q.params as never);
    };
    const o = await run(oracle, { min_limit: 10000 });
    const s = await run(sqlserver, { min_limit: '10000' });
    expect(o.map((x) => x.account_name)).toEqual(['Contoso Ltd', 'Northwind Traders']);
    expect(compareRows(o, s, { key: 'account_id' }).passed).toBe(true);
    expect(await run(sqlserver, { min_limit: 0, name_like: "x' OR '1'='1" })).toEqual([]);
    const clients: Record<string, DbClient> = { oracle, sqlserver };
    for (const conn of ['oracle', 'sqlserver']) {
      const results = await checkQueries(cat, { connection: conn, open: async (n) => clients[n] });
      expect(results.find((r) => r.name === 'ACCOUNTS_OVER')).toMatchObject({ status: 'ok' });
      expect(results.find((r) => r.name === 'ACCOUNTS_BROKEN')).toMatchObject({ status: 'error', message: expect.stringMatching(/ORA-00904|Invalid column name 'account_nmae'/) });
    }
  });
});
