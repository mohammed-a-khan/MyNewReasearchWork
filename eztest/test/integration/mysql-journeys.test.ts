/**
 * `.ez` database steps on REAL MariaDB 10.11 and MySQL 8.4 through the CLI, the way a team uses them: a project with
 * `db.connections` (driver: mariadb / mysql, the password a secret reference), a named-query catalogue, `eztest
 * validate`, `queries check` (server-side prepare, nothing executed), `doctor`, and `eztest run` with inline SQL
 * (${var} bound as "?"), catalogue queries with :name binds, a stored procedure, a wait, one run per query row
 * (Examples: from query) and a typed DB-vs-data comparison. Fictional data only.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from '../../src/cli/index.js';
import type { RunResult } from '../../src/core/index.js';
import { MysqlDbClient } from '../../src/surfaces/index.js';
import { mysqlEnv, type MysqlServer } from './mysql-env.js';

const env = await mysqlEnv();
if (env.skip) console.warn(`[eztest] ${env.skip}`);

async function cli(cwd: string, args: string[]): Promise<{ out: string[]; err: string[]; exitCode: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const before = process.exitCode;
  process.exitCode = 0;
  await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: process.env }).exitOverride().parseAsync(['node', 'eztest', ...args]);
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = before;
  return { out, err, exitCode };
}

async function lastRun(project: string): Promise<RunResult> {
  const root = join(project, 'eztest-results');
  const dirs = (await readdir(root)).sort();
  return JSON.parse(await readFile(join(root, dirs[dirs.length - 1], 'run.json'), 'utf8')) as RunResult;
}

const JOURNEY = `Journey: Staff directory checks on the HR database
Tags: @db
Variables: dept=QA

# Inline SQL: \${var} values are bound as "?" (also inside a quoted literal), never spliced
Run query "SELECT id, name, salary FROM ezt_staff WHERE dept = '\${dept}' ORDER BY id" on hr as staff
Expect \${staff.0.name} equals "Zoë O'Brien"
Expect \${staff.1.salary} equals 2000.25
Get the value of query "SELECT COUNT(*) AS n FROM ezt_staff" on hr as total
Expect \${total} equals 3

# Catalogue queries with :name binds (and a backslash-escaped literal with a colon inside)
Expect query "STAFF_BY_DEPT" on hr with dept="QA" returns 2 rows
Get the first row of query "STAFF_BY_NAME" with name="Ana Lima" as ana
Expect \${ana.dept} equals "Ops"
Expect \${ana.note} equals "it's: fine"

# A stored procedure, then a wait for its effect
Call procedure "ezt_raise" on hr with params '[1, 10.5]' as r
Wait until query "SELECT id FROM ezt_staff WHERE id = 1 AND salary >= 1010.50" on hr returns 1 row within 5 seconds

# DB rows against expected data, typed (DECIMAL vs text, DATETIME vs ISO text)
Run query "SELECT id, salary, hired_at FROM ezt_staff WHERE id = 3" on hr as ops
Set variable expected to parseJson('[{"ID": "3", "SALARY": "3000.00", "HIRED_AT": "2025-07-01T08:30:00"}]')
Expect rows ops equal rows expected by key "id"
`;

const PER_ROW = `Journey: One run per QA staff member
Tags: @db
Get the value of query "SELECT dept FROM ezt_staff WHERE id = \${id}" on hr as d
Expect \${d} equals "QA"
Examples: from query "STAFF_BY_DEPT" on hr with dept="QA"
`;

for (const srv of env.servers) defineServer(srv);

function defineServer(srv: MysqlServer): void {
  describe(`.ez database steps on ${srv.label} (CLI)`, () => {
    let project: string;
    let db: MysqlDbClient;
    const saved = process.env.HR_DB_PASSWORD;

    beforeAll(async () => {
      project = await mkdtemp(join(tmpdir(), `eztest-${srv.flavor}-journeys-`));
      const u = new URL(srv.url);
      process.env.HR_DB_PASSWORD = decodeURIComponent(u.password);
      await mkdir(join(project, 'journeys'));
      await mkdir(join(project, 'queries'));
      await writeFile(join(project, 'eztest.config.yaml'), [
        'baseUrl: http://127.0.0.1:9',
        'journeysDir: journeys',
        'outputDir: eztest-results',
        'reporters: [json]',
        'identity:',
        '  secretStores:',
        '    - { type: env, prefix: HR_ }',
        'db:',
        '  connections:',
        '    hr:',
        `      driver: ${srv.flavor === 'mariadb' ? 'mariadb' : 'mysql'}`,
        `      host: ${u.hostname}`,
        `      port: ${u.port}`,
        '      database: eztest',
        '      user: eztest',
        '      password: secret://env/DB_PASSWORD',
        ...(srv.flavor === 'mysql' ? ['      ssl:', `        ca: ${env.ca}`] : []),
        '  queries:',
        '    dir: queries',
        '',
      ].join('\n'));
      await writeFile(join(project, 'queries', 'STAFF_BY_DEPT.sql'), '-- connection: hr\n-- description: Staff of a department\n-- params: dept\nSELECT id, name FROM ezt_staff WHERE dept = :dept ORDER BY id\n');
      await writeFile(join(project, 'queries', 'STAFF_BY_NAME.sql'), "-- connection: hr\n-- params: name\nSELECT dept, note, 'a\\':b' AS lit FROM ezt_staff WHERE name = :name\n");
      await writeFile(join(project, 'journeys', 'staff.ez'), JOURNEY);
      await writeFile(join(project, 'journeys', 'per-row.ez'), PER_ROW);
      db = await MysqlDbClient.connect({ connectionString: srv.url, ...(env.ca ? { ssl: { ca: env.ca } } : {}) });
      await db.execute('DROP TABLE IF EXISTS ezt_staff');
      await db.execute('CREATE TABLE ezt_staff (id INT PRIMARY KEY, name VARCHAR(80), dept VARCHAR(10), salary DECIMAL(10,2), hired_at DATETIME, note VARCHAR(40)) CHARACTER SET utf8mb4');
      await db.execute('INSERT INTO ezt_staff VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)', [
        1, "Zoë O'Brien", 'QA', 1000, '2024-01-15 09:00:00', null,
        2, 'Ravi Kumar', 'QA', 2000.25, '2024-03-01 10:00:00', null,
        3, 'Ana Lima', 'Ops', 3000, '2025-07-01 08:30:00', "it's: fine",
      ]);
      await db.execute('DROP PROCEDURE IF EXISTS ezt_raise');
      await db.execute('CREATE PROCEDURE ezt_raise(IN p_id INT, IN p_amount DECIMAL(10,2)) BEGIN UPDATE ezt_staff SET salary = salary + p_amount WHERE id = p_id; END');
    });

    afterAll(async () => {
      if (saved === undefined) delete process.env.HR_DB_PASSWORD;
      else process.env.HR_DB_PASSWORD = saved;
      await db?.execute('DROP PROCEDURE IF EXISTS ezt_raise').catch(() => undefined);
      await db?.execute('DROP TABLE IF EXISTS ezt_staff').catch(() => undefined);
      await db?.close();
    });

    it('validate, queries check (prepared on the server, nothing executed) and doctor', async () => {
      const v = await cli(project, ['validate', 'journeys']);
      expect(v.err).toEqual([]);
      expect(v.exitCode).toBe(0);
      const check = await cli(project, ['queries', 'check']);
      expect(check.err).toEqual([]);
      expect(check.out.at(-1)).toMatch(/2 checked: 2 ok, 0 error\(s\), 0 skipped/);
      await writeFile(join(project, 'queries', 'BROKEN.sql'), '-- connection: hr\nSELECT nmae FROM ezt_staff WHERE id = :id\n');
      const broken = await cli(project, ['queries', 'check', '--json']);
      expect(broken.exitCode).toBe(1);
      expect(JSON.parse(broken.out.join('\n')).find((r: { name: string }) => r.name === 'BROKEN')).toMatchObject({ status: 'error', message: expect.stringMatching(/ERROR 1054 \(42S22\): Unknown column 'nmae'/) });
      await writeFile(join(project, 'queries', 'BROKEN.sql'), '-- connection: hr\n-- fragment: true\nAND 1 = 1\n');
      const doc = await cli(project, ['doctor']);
      expect(doc.out.join('\n')).toMatch(srv.flavor === 'mariadb' ? /db hr\s+mysql ok \(\d+ ms\) MariaDB 10\.11/ : /db hr\s+mysql ok \(\d+ ms\) MySQL 8\.4\.\d+ \(TLS\)/);
    });

    it('runs the journeys: inline and catalogue SQL, a procedure, a wait, typed comparison, one run per row', async () => {
      const r = await cli(project, ['run', 'journeys']);
      const run = await lastRun(project);
      const failed = run.journeys.flatMap((j) => j.steps.filter((s) => s.status !== 'passed').map((s) => `${j.name}: ${s.intent}: ${s.error?.message ?? s.status}`));
      expect(failed).toEqual([]);
      expect(r.exitCode).toBe(0);
      expect(run.journeys.map((j) => j.name).sort()).toEqual(["One run per QA staff member [id=1, name=Zoë O'Brien]", 'One run per QA staff member [id=2, name=Ravi Kumar]', 'Staff directory checks on the HR database']);
      expect((await db.query('SELECT salary FROM ezt_staff WHERE id = 1'))[0].salary).toBe(1010.5);
      // The run's files never hold the password.
      const files = await readdir(join(project, 'eztest-results'), { recursive: true });
      for (const f of files.filter((x) => String(x).endsWith('.json'))) {
        expect(await readFile(join(project, 'eztest-results', String(f)), 'utf8')).not.toContain(process.env.HR_DB_PASSWORD!);
      }
    });

    it('a changed value makes the typed comparison fail with the cell named', async () => {
      await db.execute("UPDATE ezt_staff SET salary = 3000.01 WHERE id = 3");
      try {
        const r = await cli(project, ['run', 'journeys', '--grep', 'Staff directory']);
        expect(r.exitCode).toBe(1);
        const run = await lastRun(project);
        const step = run.journeys[0].steps.find((s) => s.intent.startsWith('Expect rows ops'));
        expect(step?.status).toBe('failed');
        expect(step?.error?.message).toMatch(/1 cell mismatches - \[3\] SALARY: expected "3000\.00", found 3000\.01 \(numbers differ by 0\.01/);
      } finally {
        await db.execute("UPDATE ezt_staff SET salary = 3000 WHERE id = 3");
      }
    });
  });
}
