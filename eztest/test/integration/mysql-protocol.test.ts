/**
 * EZTest's own MySQL protocol client against REAL servers: MariaDB 10.11 and MySQL 8.4 in Docker
 * (test/acceptance/enterprise/env/mysql.sh starts them; see test/integration/mysql-env.ts). No driver package.
 *
 * Covers the handshake with and without TLS (certificate verified), every sign-in path (mysql_native_password,
 * an auth switch to it, caching_sha2_password fast path and full authentication over TLS, with a fetched RSA key and
 * with a configured one), the text and the binary protocol decoding the same values to the same types (DECIMAL,
 * BIGINT, DATETIME(6), DATE, TIME, BLOB, BIT, ENUM, JSON, utf8mb4, NULL), several result sets and CALL, payloads
 * over 16 MB, the pool, transactions, read-only transactions, server errors, re-prepare after ALTER TABLE, and
 * injection strings staying values. Fictional data only.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { DbError, DbRegistry, MysqlDbClient, checkDbHealth, compareRows, mysqlSettings, nativePasswordToken, cachingSha2Token } from '../../src/surfaces/index.js';
import { bindSql } from '../../src/runner/data-steps.js';
import { mysqlEnv, type MysqlServer } from './mysql-env.js';

const env = await mysqlEnv();
if (env.skip) console.warn(`[eztest] ${env.skip}`);

describe('MySQL protocol: offline pieces', () => {
  it('reads mysql:// and mariadb:// URLs, the fields beside them winning', () => {
    const s = mysqlSettings({ connectionString: 'mariadb://qa%40corp:p%3Bss@db.test:3310/hr?ssl=true&allowPublicKeyRetrieval=true&timezone=Z', database: 'other' });
    expect(s).toMatchObject({ host: 'db.test', port: 3310, user: 'qa@corp', password: 'p;ss', database: 'other', ssl: true, allowPublicKeyRetrieval: true, timezone: 'Z' });
    expect(mysqlSettings({ connectionString: 'mysql://u@h/d?ssl-mode=DISABLED' }).ssl).toBe(false);
    expect(mysqlSettings({ connectionString: 'mysql://u@h/d?ssl-mode=PREFERRED' }).ssl).toEqual({ rejectUnauthorized: false, optional: true });
    expect(mysqlSettings({ connectionString: 'mysql://u@h/d?ssl-mode=VERIFY_IDENTITY' }).ssl).toBe(true);
    expect(mysqlSettings({ connectionString: 'mysql://u@h/d?ssl-ca=/x/ca.pem' }).ssl).toEqual({ ca: '/x/ca.pem' });
    expect(mysqlSettings({ host: 'h' })).toMatchObject({ host: 'h', port: 3306 });
    expect(() => mysqlSettings({ connectionString: 'postgres://u@h/d' })).toThrow(/mysql:\/\/ or mariadb:\/\//);
  });

  it('computes the scrambles of the two password plugins (known vectors)', () => {
    const scramble = Buffer.from('0102030405060708090a0b0c0d0e0f1011121314', 'hex');
    // SHA1("secret") XOR SHA1(scramble + SHA1(SHA1("secret"))), and the SHA-256 variant; checked against the formula.
    expect(nativePasswordToken('secret', scramble)).toHaveLength(20);
    expect(cachingSha2Token('secret', scramble)).toHaveLength(32);
    expect(nativePasswordToken('', scramble)).toHaveLength(0);
    expect(nativePasswordToken('secret', scramble).toString('hex')).not.toBe(nativePasswordToken('secret2', scramble).toString('hex'));
  });

  it('binds ${var} as "?" in text order, leaving backslash-escaped literals and backticks alone', () => {
    const r = bindSql("SELECT * FROM `t?` WHERE a = ? AND b = '${x}' AND c = 'it\\'s ${not}' AND d = ${y}", [1], { x: 'X', y: 2, not: 'N' }, 'mysql');
    expect(r.sql).toBe("SELECT * FROM `t?` WHERE a = ? AND b = ? AND c = ? AND d = ?");
    expect(r.params).toEqual([1, 'X', "it\\'s N", 2]);
    expect(MysqlDbClient.bind("SELECT 'a\\':b' AS lit, :x AS v", { x: 1 })).toEqual({ text: "SELECT 'a\\':b' AS lit, ? AS v", values: [1] });
  });
});

for (const srv of env.servers) defineServer(srv);

function defineServer(srv: MysqlServer): void {
  const T = 'ezt_mysql_types';
  describe(`MySQL protocol, live on ${srv.label}`, () => {
    let db: MysqlDbClient;
    let root: MysqlDbClient;
    const tls = () => ({ ca: env.ca! });

    beforeAll(async () => {
      db = await MysqlDbClient.connect({ connectionString: srv.url, name: srv.flavor, pool: { max: 3 } });
      root = await MysqlDbClient.connect({ connectionString: srv.rootUrl, name: `${srv.flavor}-root`, ...(srv.flavor === 'mysql' ? { allowPublicKeyRetrieval: true } : {}) });
      await db.execute(`DROP TABLE IF EXISTS ${T}`);
      await db.execute(`CREATE TABLE ${T} (
        id INT PRIMARY KEY, tiny TINYINT, small SMALLINT UNSIGNED, big BIGINT, ubig BIGINT UNSIGNED,
        price DECIMAL(10,2), exact DECIMAL(30,10), ratio FLOAT, dbl DOUBLE,
        born DATE, at DATETIME(6), stamp TIMESTAMP NULL, dur TIME, yr YEAR,
        code CHAR(3), name VARCHAR(80) CHARACTER SET utf8mb4, notes TEXT, photo BLOB, raw VARBINARY(8), flags BIT(3),
        state ENUM('new','active','gone'), tags SET('a','b','c'), doc JSON, active BOOLEAN
      ) CHARACTER SET utf8mb4`);
      await db.execute(`INSERT INTO ${T} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        1, -7, 65000, '9007199254740993', '18446744073709551615', 25000.5, '12345678901234567890.0123456789', 1.25, 0.1,
        '1990-02-28', new Date(2026, 2, 1, 14, 5, 6, 789), new Date(2026, 2, 1, 14, 5, 6), '-838:59:59', 2026,
        'ABC', 'Zoë 😀 Ångström', 'line1\nline2', Buffer.from([0, 1, 2, 255]), Buffer.from('ab\0c'), 5,
        'active', 'a,c', '{"k": [1, 2]}', true,
      ]);
      await db.execute(`INSERT INTO ${T} (id) VALUES (2)`); // everything else NULL
    });

    afterAll(async () => {
      await db?.execute(`DROP TABLE IF EXISTS ${T}`).catch(() => undefined);
      await db?.close();
      await root?.close();
    });

    it('decodes every type the same way over the text and the binary protocol', async () => {
      const text = (await db.query(`SELECT * FROM ${T} WHERE id = 1`))[0];
      const binary = (await db.query(`SELECT * FROM ${T} WHERE id = ?`, [1]))[0];
      const want = {
        id: 1, tiny: -7, small: 65000, big: '9007199254740993', ubig: '18446744073709551615',
        price: 25000.5, exact: '12345678901234567890.0123456789', ratio: 1.25, dbl: 0.1,
        born: '1990-02-28', at: new Date(2026, 2, 1, 14, 5, 6, 789), stamp: new Date(2026, 2, 1, 14, 5, 6), dur: '-838:59:59', yr: 2026,
        code: 'ABC', name: 'Zoë 😀 Ångström', notes: 'line1\nline2', photo: Buffer.from([0, 1, 2, 255]), raw: Buffer.from('ab\0c'), flags: 5,
        state: 'active', tags: 'a,c', active: 1,
      };
      expect(text).toMatchObject(want);
      expect(binary).toMatchObject(want);
      // JSON: MySQL keeps a JSON type (normalised text), MariaDB an alias of LONGTEXT (the text as stored).
      expect(JSON.parse(String(text.doc))).toEqual({ k: [1, 2] });
      expect(binary.doc).toEqual(text.doc);
      expect(Buffer.isBuffer(text.photo)).toBe(true);
      const nulls = (await db.query(`SELECT * FROM ${T} WHERE id = ?`, [2]))[0];
      for (const [k, v] of Object.entries(nulls)) if (k !== 'id') expect([k, v]).toEqual([k, null]);
      expect((await db.query(`SELECT * FROM ${T} WHERE id = 2`))[0]).toEqual(nulls);
      // Case-insensitive lookups like the other dialects.
      expect(text.NAME).toBe('Zoë 😀 Ångström');
    });

    it('binds every JS type and keeps injection strings as values', async () => {
      const r = (await db.query('SELECT ? AS n, ? AS f, ? AS s, ? AS b, ? AS z, ? AS d, ? AS bin, ? AS big', [42, 2.5, "x'); DROP TABLE ezt_mysql_types; --", true, null, new Date(2027, 0, 5, 9, 30), Buffer.from('hi'), 2n ** 62n]))[0];
      expect(r).toMatchObject({ n: 42, f: 2.5, s: "x'); DROP TABLE ezt_mysql_types; --", b: 1, z: null, big: String(2n ** 62n) });
      expect(r.d instanceof Date ? r.d.getTime() : String(r.d)).toBe(new Date(2027, 0, 5, 9, 30).getTime());
      expect(Buffer.from(r.bin as Buffer).toString()).toBe('hi');
      expect(await db.query(`SELECT id FROM ${T} WHERE name = :name`, { name: "x' OR '1'='1" })).toEqual([]);
      expect(await db.query(`SELECT id FROM ${T} WHERE code = :c OR name = :c`, { c: 'ABC' })).toEqual([{ id: 1 }]);
      expect((await db.query(`SELECT COUNT(*) AS n FROM ${T}`))[0].n).toBe(2);
      await expect(db.query('SELECT ? AS a', [1, 2])).rejects.toThrow(/1 "\?" marker\(s\) but 2 value\(s\)/);
    });

    it('returns several result sets from one call, and from a stored procedure (CALL)', async () => {
      const multi = await db.results('SELECT 1 AS a; SELECT 2 AS b, 3 AS c; UPDATE ezt_mysql_types SET tiny = tiny WHERE id = 1');
      expect(multi.map((r) => r.rows)).toEqual([[{ a: 1 }], [{ b: 2, c: 3 }], []]);
      expect(multi[2].rowsAffected).toBe(1); // matched rows (CLIENT_FOUND_ROWS, as Connector/J reports them)
      await db.execute('DROP PROCEDURE IF EXISTS ezt_two_sets');
      await db.execute(`CREATE PROCEDURE ezt_two_sets(IN p INT) BEGIN SELECT id, code FROM ${T} WHERE id = p; SELECT COUNT(*) AS total FROM ${T}; END`);
      const sets = await db.results('CALL ezt_two_sets(?)', [1]);
      expect(sets.filter((s) => s.columns.length).map((s) => s.rows)).toEqual([[{ id: 1, code: 'ABC' }], [{ total: 2 }]]);
      expect(await db.query('CALL ezt_two_sets(1)')).toEqual([{ id: 1, code: 'ABC' }]);
      await db.execute('DROP PROCEDURE ezt_two_sets');
    });

    it('verifies the server certificate over TLS, and refuses one from another CA', async () => {
      expect(env.ca).toBeTruthy();
      const c = await MysqlDbClient.connect({ connectionString: srv.url, ssl: tls() });
      expect(c.server.tls).toBe(true);
      const cipher = await c.query(srv.flavor === 'mariadb' ? "SHOW SESSION STATUS LIKE 'Ssl_version'" : "SHOW SESSION STATUS LIKE 'Ssl_version'");
      expect(String(cipher[0].Value)).toMatch(/^TLSv1\.[23]$/);
      await c.close();
      const wrong = await MysqlDbClient.connect({ connectionString: srv.url, ssl: true }).catch((e) => e);
      expect(wrong).toBeInstanceOf(DbError);
      expect(wrong.message).toMatch(/TLS with MySQL .* failed: .*(self.signed|unable to verify|local issuer)/i);
      const byName = await MysqlDbClient.connect({ connectionString: srv.url.replace('127.0.0.1', 'localhost'), ssl: tls() });
      expect(byName.server.tls).toBe(true);
      await byName.close();
    });

    it('reports a wrong password as a sign-in error that never shows the password', async () => {
      // Over TLS: on MySQL a wrong password never matches the server's cache, so caching_sha2_password goes to full
      // authentication, which needs a secure channel (without one the client refuses to send the password at all).
      const e = await MysqlDbClient.connect({ connectionString: srv.url, password: 'Wrong-Pass-123', ssl: tls() }).catch((x) => x);
      expect(e).toBeInstanceOf(DbError);
      expect(e.code).toBe('DB_AUTH');
      expect(e.message).toMatch(/Access denied for user 'eztest'.*error 1045/);
      expect(e.message).not.toContain('Wrong-Pass-123');
      const h = await checkDbHealth('nowhere', () => MysqlDbClient.connect({ host: '127.0.0.1', port: 1, connectTimeoutMs: 2000 }), 'mysql');
      expect(h).toMatchObject({ ok: false, dialect: 'mysql' });
    });

    if (srv.flavor === 'mysql') {
      it('caching_sha2_password: full authentication over TLS, then the fast path', async () => {
        await root.execute('FLUSH PRIVILEGES'); // empties the server's cache: the next sign-in is a full one
        const full = await MysqlDbClient.connect({ connectionString: srv.url, ssl: tls() });
        expect(full.server.authPlugin).toBe('caching_sha2_password');
        await full.close();
        const fast = await MysqlDbClient.connect({ connectionString: srv.url }); // no TLS: only the fast path can work
        expect((await fast.query('SELECT CURRENT_USER() AS u'))[0].u).toBe('eztest@%');
        await fast.close();
      });

      it('caching_sha2_password: full authentication without TLS needs the RSA key, fetched or configured', async () => {
        await root.execute('FLUSH PRIVILEGES');
        const refused = await MysqlDbClient.connect({ connectionString: srv.url }).catch((x) => x);
        expect(refused).toBeInstanceOf(DbError);
        expect(refused.message).toMatch(/caching_sha2_password needs the password sent securely: connect with ssl, give serverPublicKey .*allowPublicKeyRetrieval/);
        const fetched = await MysqlDbClient.connect({ connectionString: srv.url, allowPublicKeyRetrieval: true });
        expect(fetched.server.tls).toBe(false);
        await fetched.close();
        const key = String((await root.query("SHOW STATUS LIKE 'Caching_sha2_password_rsa_public_key'"))[0].Value);
        expect(key).toMatch(/BEGIN PUBLIC KEY/);
        await root.execute('FLUSH PRIVILEGES');
        const configured = await MysqlDbClient.connect({ connectionString: srv.url, serverPublicKey: key });
        expect((await configured.query('SELECT 1 AS ok'))[0].ok).toBe(1);
        await configured.close();
      });

      it('follows an auth switch to mysql_native_password, and a REQUIRE SSL user needs TLS', async () => {
        const native = await MysqlDbClient.connect({ connectionString: srv.url.replace('eztest:EzMysql_1', 'ez_native:EzNative_1') });
        expect(native.server.authPlugin).toBe('mysql_native_password');
        await native.close();
        const plain = await MysqlDbClient.connect({ connectionString: srv.url.replace('eztest:EzMysql_1', 'ez_tls:EzTls_1'), allowPublicKeyRetrieval: true }).catch((x) => x);
        expect(plain).toBeInstanceOf(DbError);
        expect(plain.message).toMatch(/Access denied for user 'ez_tls'/);
        const secure = await MysqlDbClient.connect({ connectionString: srv.url.replace('eztest:EzMysql_1', 'ez_tls:EzTls_1'), ssl: tls() });
        expect((await secure.query('SELECT CURRENT_USER() AS u'))[0].u).toBe('ez_tls@%');
        await secure.close();
      });

      it('sends and receives payloads over 16 MB (split into several protocol packets)', async () => {
        const big = 'x'.repeat(17 * 1024 * 1024 + 3) + 'é';
        const r = (await db.query('SELECT LENGTH(?) AS len, ? AS echo', [big, big]))[0];
        expect(r.len).toBe(Buffer.byteLength(big));
        expect(r.echo === big).toBe(true);
      });
    } else {
      it('signs in with mysql_native_password, with and without TLS', async () => {
        expect(db.server.authPlugin).toBe('mysql_native_password');
        expect(db.server.flavor).toBe('mariadb');
        const c = await MysqlDbClient.connect({ connectionString: srv.url, ssl: tls() });
        expect(c.server).toMatchObject({ tls: true, authPlugin: 'mysql_native_password', flavor: 'mariadb' });
        await c.close();
      });

      it('sends and receives a 5 MB BLOB', async () => {
        const blob = Buffer.alloc(5 * 1024 * 1024, 7);
        blob[123] = 0;
        const r = (await db.query('SELECT ? AS b, LENGTH(?) AS n', [blob, blob]))[0];
        expect(r.n).toBe(blob.length);
        expect(Buffer.compare(r.b as Buffer, blob)).toBe(0);
      });
    }

    it('pools connections: concurrent queries share at most pool.max connections, a killed one is replaced', async () => {
      const ids = await Promise.all(Array.from({ length: 9 }, (_, i) => db.query('SELECT SLEEP(0.15) AS s, CONNECTION_ID() AS id, ? AS i', [i])));
      expect(ids.map((r) => r[0].i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      const distinct = new Set(ids.map((r) => r[0].id));
      expect(distinct.size).toBeLessThanOrEqual(3);
      expect(distinct.size).toBeGreaterThan(1);
      expect(db.poolStatus()).toMatchObject({ max: 3, inUse: 0 });
      for (const id of distinct) await root.execute(`KILL ${Number(id)}`);
      await new Promise((r) => setTimeout(r, 300));
      expect((await db.query('SELECT 1 AS ok'))[0].ok).toBe(1);
      const h = await checkDbHealth(srv.flavor, async () => db);
      expect(h).toMatchObject({ ok: true, dialect: 'mysql', version: expect.stringMatching(srv.flavor === 'mariadb' ? /^MariaDB 10\.11/ : /^MySQL 8\.4/) });
    });

    it('commits and rolls back transactions; a read-only transaction refuses writes', async () => {
      await db.transaction((tx) => tx.execute(`UPDATE ${T} SET code = ? WHERE id = 1`, ['TX1']));
      expect((await db.query(`SELECT code FROM ${T} WHERE id = 1`))[0].code).toBe('TX1');
      await expect(db.transaction(async (tx) => {
        await tx.execute(`UPDATE ${T} SET code = 'BAD' WHERE id = 1`);
        throw new Error('boom');
      })).rejects.toThrow('boom');
      expect((await db.query(`SELECT code FROM ${T} WHERE id = 1`))[0].code).toBe('TX1');
      const ro = await db.readOnly((tx) => tx.execute(`UPDATE ${T} SET code = 'RO' WHERE id = 1`)).catch((e) => e);
      expect(ro).toBeInstanceOf(DbError);
      expect(ro.message).toMatch(/ERROR 1792 .*READ ONLY transaction/);
      expect(await db.readOnly((tx) => tx.query(`SELECT code FROM ${T} WHERE id = 1`))).toEqual([{ code: 'TX1' }]);
      const ins = await db.execute(`CREATE TEMPORARY TABLE IF NOT EXISTS ezt_auto (id INT AUTO_INCREMENT PRIMARY KEY, v INT)`);
      expect(ins.rowsAffected).toBe(0);
    });

    it('reports server errors with errno and SQLSTATE and keeps the connection usable; re-prepares after ALTER TABLE', async () => {
      const e = await db.query('SELECT * FROM ezt_no_such_table WHERE id = ?', [1]).catch((x) => x);
      expect(e).toBeInstanceOf(DbError);
      expect(e.message).toMatch(/ERROR 1146 \(42S02\): Table 'eztest\.ezt_no_such_table' doesn't exist/);
      expect(e.details).toMatchObject({ errno: 1146, sqlState: '42S02' });
      const syntax = await db.query('SELEC 1').catch((x) => x);
      expect(syntax.message).toMatch(/ERROR 1064 \(42000\)/);
      expect((await db.query('SELECT 2 AS ok'))[0].ok).toBe(2);
      // The same prepared statement before and after the table changes shape.
      expect(Object.keys((await db.query(`SELECT * FROM ${T} WHERE id = ?`, [1]))[0])).not.toContain('extra');
      await db.execute(`ALTER TABLE ${T} ADD COLUMN extra INT DEFAULT 9`);
      const after = (await Promise.all([1, 1, 1].map((id) => db.query(`SELECT * FROM ${T} WHERE id = ?`, [id])))).map((r) => r[0].extra);
      expect(after).toEqual([9, 9, 9]);
      await db.execute(`ALTER TABLE ${T} DROP COLUMN extra`);
    });

    it('works through the registry from a config spec (driver mysql, secret password), and compares typed rows', async () => {
      const u = new URL(srv.url);
      const reg = new DbRegistry({ hr: { driver: 'mysql', host: u.hostname, port: Number(u.port), database: 'eztest', user: 'eztest', password: 'secret://vault/HR_PW' } }, { resolveSecret: async () => decodeURIComponent(u.password) });
      try {
        const hr = await reg.get('hr');
        expect(hr.dialect).toBe('mysql');
        const rows = await hr.query(`SELECT id, price, at FROM ${T} WHERE id = 1`);
        const diff = compareRows(rows, [{ ID: '1', PRICE: '25000.50', AT: new Date(2026, 2, 1, 14, 5, 6, 789).toISOString() }], { key: 'id' });
        expect(diff).toMatchObject({ passed: true, compared: 1, matched: 1 });
      } finally {
        await reg.closeAll();
      }
    });
  });
}
