/**
 * A code journey on the real OrangeHRM: a value read from the database drives the UI, and the PIM search table is
 * compared with a SQL result set row by row. Fictional employees only, tagged with the run's tag.
 */
import { journey, step, expect } from 'eztest/sdk';

type Row = Record<string, unknown>;

journey('PIM search table matches the database (code journey)', { id: 'pim-directory-code', tags: ['@orangehrm', '@sdk', '@db'], role: 'admin' }, async ({ ui, db, vars, log }) => {
  const tag = vars.text('tag');
  const lastName = `Code${tag}`;
  const hr = db.on('hr');

  await step('Seed four employees with SQL', async () => {
    for (const [i, [first, middle]] of [['Ines', ''], ['Jonas', 'P'], ['Kemal', ''], ['Lena', 'Marie']].entries()) {
      await hr.sql`INSERT INTO hs_hr_employee (employee_id, emp_firstname, emp_middle_name, emp_lastname) VALUES (${`${tag}C${i + 1}`}, ${first}, ${middle}, ${lastName})`;
    }
  });

  // A value from the database used in the UI: the id of the second employee, searched exactly.
  const [second] = await hr.sql<Row>`SELECT employee_id, emp_firstname FROM hs_hr_employee WHERE emp_lastname = ${lastName} ORDER BY employee_id LIMIT 1 OFFSET 1`;
  const empId = String(second.employee_id);
  log.info(`searching for employee id ${empId}`);

  await ui.login();
  await ui.open('/web/index.php/pim/viewEmployeeList');
  await ui.fill('the "Employee Id" field', empId);
  await ui.click('the "Search" button', { expect: { text: '(1) Record Found' } });
  const one = await ui.table('the table');
  await expect(one.length, 'rows for one id').toBe(1);
  await expect(one[0]['First (& Middle) Name'], 'first and middle name').toBe(`${second.emp_firstname} P`);

  // The whole result set: UI rows against SQL rows, by key, cell by cell (the UI sorts by first name: Ines..Lena).
  await ui.open('/web/index.php/pim/viewEmployeeList');
  await ui.fill('the "Employee Name" field', lastName);
  await ui.click('the "Search" button', { expect: { text: '(4) Records Found' } });
  const uiRows = await ui.table('the table');
  const dbRows = await hr.sql<Row>`SELECT employee_id AS Id, TRIM(CONCAT(emp_firstname, ' ', emp_middle_name)) AS \`First (& Middle) Name\`, emp_lastname AS \`Last Name\` FROM hs_hr_employee WHERE emp_lastname = ${lastName} ORDER BY employee_id`;
  await expect.rows(uiRows).toEqual(dbRows, { key: 'Id' });
  await expect(uiRows.map((r) => r.Id), 'UI order (by id)').toEqual(dbRows.map((r) => String(r.Id)));
});
