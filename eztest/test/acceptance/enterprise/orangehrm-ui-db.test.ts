/**
 * Acceptance: UI and database together on a REAL OrangeHRM 5.7 and its MariaDB, the way an HR team tests it.
 *
 *   - add an employee through the UI (oxd form fields whose labels are not tied to their inputs, a hidden file
 *     input behind the profile picture, a toast shown just before the app navigates) and find the row in
 *     hs_hr_employee and the photo in hs_hr_emp_picture; then personal details with oxd select dropdowns, the oxd
 *     date input and custom radio buttons, checked in the database;
 *   - seed employees with SQL and find them in the PIM search (the oxd autocomplete included), the UI table
 *     compared with the SQL result set row by row;
 *   - one employee per CSV row (Examples: from data, with a filter), each checked in the database;
 *   - a TypeScript code journey that reads a value from the database, uses it in the UI and compares the UI table
 *     with a SQL result set;
 *   - and the comparison failing, cell named, when the database disagrees.
 *
 * All through `eztest run` on the fixture project test/acceptance/enterprise/fixtures/orangehrm. Every employee a
 * run creates carries a random tag in its Employee Id and is deleted afterwards (the instance may be shared).
 *
 *   EZTEST_ORANGEHRM_URL=http://127.0.0.1:18080 EZTEST_ORANGEHRM_PASSWORD=... \
 *   EZTEST_ORANGEHRM_DB_URL=mysql://root:...@<db host>:3306/orangehrm_app npm test -- test/acceptance/enterprise/orangehrm-ui-db
 *
 * test/acceptance/enterprise/env/orangehrm.sh prints these for a running pair, or starts an isolated one.
 * Skipped, with a message, without them.
 */
import { afterAll, beforeAll, describe, expect, it } from '../../support/testkit.js';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MysqlDbClient, mysqlSettings } from '../../../src/surfaces/index.js';
import { cli, failures, flat, lastRun, portOpen, runTag, urlUp } from './helpers.js';

const APP = process.env.EZTEST_ORANGEHRM_URL?.replace(/\/$/, '');
const PASSWORD = process.env.EZTEST_ORANGEHRM_PASSWORD;
const DB_URL = process.env.EZTEST_ORANGEHRM_DB_URL;
const FIXTURE = resolve(__dirname, 'fixtures/orangehrm');

async function available(): Promise<string | undefined> {
  if (!APP || !PASSWORD || !DB_URL) return 'set EZTEST_ORANGEHRM_URL, EZTEST_ORANGEHRM_PASSWORD and EZTEST_ORANGEHRM_DB_URL (test/acceptance/enterprise/env/orangehrm.sh prints them)';
  if (!(await urlUp(`${APP}/web/index.php/auth/login`))) return `OrangeHRM does not answer at ${APP}`;
  const db = mysqlSettings({ connectionString: DB_URL });
  if (!(await portOpen(db.host, db.port))) return `the OrangeHRM database does not answer at ${db.host}:${db.port}`;
  return undefined;
}
const skip = await available();
if (skip) console.warn(`[acceptance] OrangeHRM UI + DB skipped: ${skip}`);

describe.skipIf(!!skip)('OrangeHRM UI and its MariaDB together (real app)', () => {
  let project: string;
  let db: MysqlDbClient;
  const tag = runTag();
  const env: NodeJS.ProcessEnv = {};

  beforeAll(async () => {
    project = await mkdtemp(join(tmpdir(), 'eztest-accept-ohrm-db-'));
    await cp(FIXTURE, project, { recursive: true });
    const s = mysqlSettings({ connectionString: DB_URL });
    Object.assign(env, process.env, {
      OHRM_URL: APP, OHRM_ADMIN_PASSWORD: PASSWORD, OHRM_DB_PASSWORD: s.password ?? '', OHRM_DB_HOST: s.host, OHRM_DB_PORT: String(s.port),
      OHRM_DB_NAME: s.database ?? 'orangehrm_app', OHRM_DB_USER: s.user ?? 'root', RUN_TAG: tag,
    });
    db = await MysqlDbClient.connect({ connectionString: DB_URL, name: 'ohrm-check' });
  });

  afterAll(async () => {
    if (db) {
      // Everything this run created: the tag starts every Employee Id it used (pictures go with the employee).
      await db.execute('DELETE FROM hs_hr_employee WHERE employee_id LIKE ?', [`${tag}%`]).catch(() => undefined);
      await db.close();
    }
  });

  const run = (grep: string) => cli(project, ['run', 'journeys', '--grep', grep], env);

  it('adds an employee through the UI and finds the row, the photo and the personal details in the database', async () => {
    const r = await run('Add an employee through the UI');
    const { run: result } = await lastRun(project);
    expect(failures(result.journeys)).toEqual([]);
    expect(r.exitCode).toBe(0);
    // Checked again here, outside EZTest.
    const [row] = await db.query('SELECT e.emp_number, e.emp_firstname, e.emp_lastname, e.emp_birthday, e.emp_gender, e.emp_marital_status, p.epic_type FROM hs_hr_employee e JOIN hs_hr_emp_picture p ON p.emp_number = e.emp_number WHERE e.employee_id = ?', [`${tag}1`]);
    expect(row).toMatchObject({ emp_firstname: 'Mira', emp_lastname: `Okafor${tag}`, emp_birthday: '1990-04-15', emp_gender: 2, emp_marital_status: 'Married', epic_type: 'image/png' });
    // The toast was seen although the app navigated right after showing it; the upload went to the form's
    // file input (the header's "profile picture" has none).
    const steps = flat(result.journeys[0].steps);
    expect(steps.find((s) => s.intent.startsWith('Expect a toast containing "Successfully Saved"'))?.status).toBe('passed');
    expect(steps.find((s) => s.intent.startsWith('Upload'))?.status).toBe('passed');
    // The toast of the Personal Details page (a new document) is recorded too; the date picker is the element
    // repository's @Pim.dateOfBirth.
    expect(steps.find((s) => s.intent.startsWith('Expect a toast containing "Successfully Updated"'))?.status).toBe('passed');
    expect(steps.find((s) => s.intent.startsWith('Pick 1990-04-15 in the @Pim.dateOfBirth date picker'))?.status).toBe('passed');
  }, 300_000);

  it('finds employees seeded with SQL in the PIM search; the UI table equals the SQL result set row by row', async () => {
    const r = await run('seeded with SQL');
    const { run: result, dir } = await lastRun(project);
    expect(failures(result.journeys)).toEqual([]);
    expect(r.exitCode).toBe(0);
    const ui = result.journeys[0].ledger.uiRows as Array<Record<string, string>>;
    expect(ui.map((x) => [x.Id, x['First (& Middle) Name'], x['Last Name']])).toEqual([[`${tag}S1`, 'Anika', `Seeded${tag}`], [`${tag}S2`, 'Bruno K', `Seeded${tag}`], [`${tag}S3`, 'Chen', `Seeded${tag}`]]);
    const compare = JSON.parse(await readFile(join(dir, 'compare', 'employees-seeded-with-sql-show-up-in-the-pim-search-table', 'expect-rows-uirows-equal-rows-dbrows-by-key-id.json'), 'utf8'));
    expect(compare).toMatchObject({ passed: true, compared: 3, matched: 3 });
  }, 300_000);

  it('creates one employee per CSV row (filtered) and checks each in the database', async () => {
    const r = await run('New hire from the CSV');
    const { run: result } = await lastRun(project);
    expect(failures(result.journeys)).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(result.journeys).toHaveLength(3); // H4 has runFlag No
    const rows = await db.query('SELECT employee_id, emp_firstname, emp_lastname, emp_birthday FROM hs_hr_employee WHERE employee_id LIKE ? ORDER BY employee_id', [`${tag}H%`]);
    expect(rows.map((x) => [x.employee_id, x.emp_firstname, x.emp_lastname, x.emp_birthday])).toEqual([
      [`${tag}H1`, 'Amara', `Nwosu${tag}`, '1992-07-01'],
      [`${tag}H2`, 'Diego', `Fernández${tag}`, '1985-11-23'],
      [`${tag}H3`, 'Siobhán', `O'Neill${tag}`, '2000-02-29'],
    ]);
  }, 600_000);

  it('runs a TypeScript code journey: a DB value drives the UI, the UI table equals the SQL rows', async () => {
    const r = await run('code journey');
    const { run: result } = await lastRun(project);
    expect(failures(result.journeys)).toEqual([]);
    expect(r.exitCode).toBe(0);
    const steps = flat(result.journeys[0].steps);
    // The id came from the database (the second seeded employee) and was typed into the UI.
    expect(steps.map((s) => s.intent)).toContain(`Type "${tag}C2" into the "Employee Id" field`);
    expect(steps.find((s) => s.intent === 'Expect rows to equal 4 expected rows by Id')?.status).toBe('passed');
  }, 300_000);

  it('fails the comparison, naming the cell, when the database disagrees with the UI', async () => {
    await writeFile(join(project, 'journeys', 'disagree.ez'), [
      'Journey: The UI table and a disagreeing SQL result set',
      'Role: admin',
      `Variables: lastName=Odd${tag}`,
      `Run query "INSERT INTO hs_hr_employee (employee_id, emp_firstname, emp_middle_name, emp_lastname) VALUES ('${tag}D1', 'Omar', '', '\${lastName}')" on hr as seeded`,
      'Log in',
      'Open /web/index.php/pim/viewEmployeeList',
      'Type "${lastName}" into the "Employee Name" field',
      'Click the "Search" button',
      'Expect the page contains "(1) Record Found"',
      'Capture the rows of the table as uiRows',
      // The "database" side says UPPER(first name): the UI shows "Omar".
      "Run query \"SELECT employee_id AS Id, UPPER(emp_firstname) AS `First (& Middle) Name` FROM hs_hr_employee WHERE emp_lastname = '${lastName}'\" on hr as dbRows",
      'Expect rows uiRows equal rows dbRows by key "Id"',
      '',
    ].join('\n'));
    const r = await run('disagreeing SQL');
    expect(r.exitCode).toBe(1);
    const { run: result } = await lastRun(project);
    const step = flat(result.journeys[0].steps).find((s) => s.intent.startsWith('Expect rows uiRows'));
    expect(step?.status).toBe('failed');
    expect(step?.error?.message).toMatch(new RegExp(`1 cell mismatches - \\[${tag}D1\\] First \\(& Middle\\) Name: expected "OMAR", found "Omar"`));
  }, 300_000);
});
