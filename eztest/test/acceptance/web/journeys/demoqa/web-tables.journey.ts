/**
 * demoqa.com web tables from code: add people from a JSON file, read the whole table back, compute with it and
 * compare with the file; then read a value in a new window and check it on the main page.
 */
import { expect, files, inRow, journey, step, ui } from '@eztech/eztest/sdk';

interface Person { first: string; last: string; email: string; age: string; salary: string; department: string }

journey('Web tables filled from JSON and checked row by row', { tags: ['@demoqa', '@code', '@data'], baseUrl: 'https://demoqa.com' }, async () => {
  const { people } = (await files.readJson('journeys/data/people.json')) as { people: Person[] };
  await ui.open('/webtables', { expect: { text: 'Web Tables' } });
  const before = (await ui.table('the table')).filter((r) => Object.values(r).some((v) => v.trim()));

  for (const p of people) {
    await step(`Add ${p.first} ${p.last}`, async () => {
      await ui.click('the "Add" button');
      await ui.perform('Expect the "Registration Form" dialog to be open');
      await ui.fill('the First Name field', p.first);
      await ui.fill('the Last Name field', p.last);
      await ui.fill('the name@example.com field', p.email);
      await ui.fill('the Age field', p.age);
      await ui.fill('the Salary field', p.salary);
      await ui.fill('the Department field', p.department);
      await ui.click('the "Submit" button', { expect: { text: p.email } });
    });
  }

  const rows = (await ui.table('the table')).filter((r) => Object.values(r).some((v) => v.trim()));
  await expect(rows.length, 'rows after adding').toBe(before.length + people.length);
  for (const p of people) {
    const row = rows.find((r) => r.Email === p.email);
    await expect(row, `row of ${p.email}`).toBeDefined();
    await expect(row!['First Name']).toBe(p.first);
    await expect(row!.Department).toBe(p.department);
  }
  const added = rows.filter((r) => people.some((p) => p.email === r.Email));
  const total = added.reduce((s, r) => s + Number(r.Salary), 0);
  await expect(total, 'salaries of the people added').toBe(people.reduce((s, p) => s + Number(p.salary), 0));

  await step('Delete a person by their row', async () => {
    await ui.click(inRow('alan@example.com', { title: 'Delete' }), { expect: { notText: 'alan@example.com' } });
    const after = (await ui.table('the table')).filter((r) => Object.values(r).some((v) => v.trim()));
    // demoqa redraws the table from its initial rows after a delete: the person is gone, the first ones are back.
    await expect(after.some((r) => r.Email === 'alan@example.com')).toBe(false);
    await expect(after.some((r) => r.Email === 'cierra@example.com')).toBe(true);
  });

  await step('Search narrows the table to one row', async () => {
    await ui.fill('the Type to search field', 'Vega');
    const found = (await ui.table('the table')).filter((r) => Object.values(r).some((v) => v.trim()));
    await expect(found.map((r) => r.Email)).toEqual(['cierra@example.com']);
  });
});

journey('A value read in a new tab is checked on the main page', { tags: ['@demoqa', '@code'], baseUrl: 'https://demoqa.com' }, async () => {
  await ui.open('/browser-windows');
  await ui.click('the "New Tab" button');
  await ui.switchToTab('new');
  const heading = await ui.text('the "This is a sample page" heading');
  await ui.switchToTab('main');
  await ui.open('/sample');
  await expect.ui.page().toContainText(heading);
  await step('Frames: the same sample page in a big and a small frame', async () => {
    await ui.open('/frames');
    const big = await ui.inFrame('frame1', () => ui.text('the "This is a sample page" heading'));
    const small = await ui.inFrame('frame2', () => ui.text('the "This is a sample page" heading'));
    await expect(small).toBe(big);
  });
});
