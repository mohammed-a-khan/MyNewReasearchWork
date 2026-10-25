/**
 * Step-definition arguments are resolved before the definition runs: `${var}`, `${a.b.0}`, `${x:-default}`,
 * `$${` escapes, inline expressions (evaluated once per attempt), `secret://` values (resolved when the step
 * runs, masked), and the "fetch then reference" pattern (an Examples row holding `${dbOwnerName}` that a
 * Background step fetched from the database). Also `${env}`, run.excludeTags, the holiday calendar from a
 * query, derived Examples columns, filter operators and `eztest validate`'s warning. Real browser, real SQLite.
 */
import { afterEach, describe, expect, it } from '../support/testkit.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StepResult } from '../../src/core/index.js';
import { byId, cli, latestRun, tree } from './helpers.js';
import { clinicProject, type ClinicProject } from '../support/clinic.js';

let project: ClinicProject | undefined;
afterEach(async () => {
  await project?.remove();
  project = undefined;
  delete process.env.CLINIC_VET_PW;
});
const gs = (j: { steps: StepResult[] }) => j.steps.filter((s) => s.gherkin?.kind === 'step');

const STEPS = `
import { When, Then, type DataTable } from 'eztest/bdd';

When('the owner {string} books {string} with reference {string}', async ({ vars }, owner: string, reason: string, ref: string) => {
  vars.set('booked', { owner, reason, ref });
});
Then('the booking reference is {string}', async ({ vars, expect }, ref: string) => {
  await expect(ref, 'one reference in every step of the attempt').toBe((vars.get('booked') as { ref: string }).ref);
});
Then('the visit sheet is:', async ({ vars }, table: DataTable) => {
  const [row] = table.hashes();
  vars.set('sheet', { owner: row.owner, due: row.due, vetPasswordResolved: row.vet === process.env.CLINIC_VET_PW, vetLength: row.vet.length });
});
Then('the note reads:', async ({ vars }, note: string) => {
  vars.set('note', note);
});
Then('the derived reference starts with {string} and is due {}', async ({ vars, expect }, prefix: string, due: string) => {
  const ref = vars.get<string>('ref');
  await expect(ref.startsWith(prefix), \`\${ref} starts with \${prefix}\`).toBe(true);
  vars.set('derived', { ref, due, petName: vars.get('name') });
});
`;

const FEATURE = `@clinic
Feature: Booking visits at the pet clinic

  Background:
    Given I get the value of query "OWNER_NAME" on clinic with owner_id=1 as dbOwnerName

  Scenario Outline: Book a visit for <ownerName>
    When the owner "<ownerName>" books "<reason>" with reference "\${unique('VIS-')}"
    Then the booking reference is "\${unique('VIS-')}"
    And the visit sheet is:
      | owner       | due                                                       | vet           |
      | <ownerName> | \${format(addBusinessDays("2026-12-24", 1), "YYYY-MM-DD")} | <vetPassword> |
    And the note reads:
      """
      Owner \${dbOwnerName} in \${env}; city \${city:-unknown}; literal $\${notAVariable}
      """

    Examples:
      | ownerName      | reason   | vetPassword                |
      | \${dbOwnerName} | check-up | secret://env/CLINIC_VET_PW |

  Scenario: An unknown variable stops the step before the definition runs
    When the owner "\${nobodySetThis}" books "x-ray" with reference "R-1"

  @skip
  Scenario: Left out by run.excludeTags
    When the owner "Nobody" books "nothing" with reference "R-0"

  Scenario Outline: Rows from the database with derived columns
    Then the derived reference starts with "VIS-" and is due <due>

    Examples: from query "FIND_PET_FOR_STATE" on clinic with state="healthy" where name in (Biscuit, "Juniper") and species ^= rab with ref = unique("VIS-"), due = format(addBusinessDays("2026-12-24", 2), "YYYY-MM-DD")
`;

describe('BDD: step-definition arguments are resolved (real browser, SQLite)', () => {
  it('resolves arguments, cells and doc strings; fetch-then-reference rows; inline expressions once per attempt; secrets masked', async () => {
    process.env.CLINIC_VET_PW = 'Vet#Secret-77';
    project = await clinicProject([
      'run:',
      '  excludeTags: ["@skip"]',
      'dates:',
      '  holidays: { query: CLINIC_HOLIDAYS, column: day }',
    ].join('\n'), { 'features/visits.feature': FEATURE, 'steps/visits.steps.ts': STEPS });
    const r = await cli(project.dir, ['run', '-e', 'sit']);
    const { dir, run } = await latestRun(project.dir);
    const summary = run.journeys.map((j) => `${j.journeyId} ${j.status} ${j.error?.message ?? ''}\n${tree(j.steps, 1)}`).join('\n');
    // run.excludeTags left the @skip scenario out.
    expect(run.journeys.map((j) => j.journeyId).sort(), summary).toEqual([
      'visits--an-unknown-variable-stops-the-step-before-the-definition-runs',
      'visits--book-a-visit-for-ownername-1',
      'visits--rows-from-the-database-with-derived-columns-12',
    ]);
    expect(r.exitCode).toBe(1);

    const book = byId(run, 'visits--book-a-visit-for-ownername-1');
    expect(book.status, summary).toBe('passed');
    // The Examples value "${dbOwnerName}" resolved to what the Background step fetched from the database.
    const booked = book.ledger.booked as { owner: string; reason: string; ref: string };
    expect(booked.owner).toBe('Mira Okafor');
    expect(booked.reason).toBe('check-up');
    expect(booked.ref).toMatch(/^VIS-[0-9a-z]+-/);
    // The inline expression was evaluated once for the attempt: the same reference in both steps, recorded.
    expect((book.ledger.$expressions as Record<string, unknown>)["unique('VIS-')"]).toBe(booked.ref);
    expect(gs(book)[1].captured?.["unique('VIS-')"]).toBe(booked.ref);
    // Cells: the row's placeholder, an expression using the holiday calendar loaded from the database
    // (2026-12-25 and 2026-12-28 are clinic holidays: one business day after Dec 24 is Dec 29), a secret.
    const sheet = book.ledger.sheet as { owner: string; due: string; vetPasswordResolved: boolean; vetLength: number };
    expect(sheet).toEqual({ owner: 'Mira Okafor', due: '2026-12-29', vetPasswordResolved: true, vetLength: 'Vet#Secret-77'.length });
    expect(book.ledger.note).toBe('Owner Mira Okafor in sit; city unknown; literal ${notAVariable}');
    // The secret's value is masked everywhere in the results.
    expect(await readFile(join(dir, 'run.json'), 'utf8')).not.toContain('Vet#Secret-77');

    // A ${name} nothing sets fails the step with MISSING_VARIABLE; the definition never ran.
    const missing = byId(run, 'visits--an-unknown-variable-stops-the-step-before-the-definition-runs');
    const step = gs(missing).at(-1)!;
    expect(step.status).toBe('failed');
    expect(step.error?.name).toBe('MISSING_VARIABLE');
    expect(step.error?.message).toContain('${nobodySetThis}');
    expect(step.children).toBeUndefined();
    expect(missing.ledger.booked).toBeUndefined();

    // Rows from a query, filtered with "in" and "^=", with derived columns evaluated per attempt.
    const derived = byId(run, 'visits--rows-from-the-database-with-derived-columns-12');
    expect(derived.status, summary).toBe('passed');
    const d = derived.ledger.derived as { ref: string; due: string; petName: string };
    expect(d.ref).toMatch(/^VIS-/);
    expect(d.due).toBe('2026-12-30'); // Dec 24 + 2 business days: the 25th and the 28th are holidays, the 26th and 27th a weekend
    expect(d.petName).toBe('Juniper');
  });

  it('bdd.resolveArguments: false hands the text over as written', async () => {
    project = await clinicProject('bdd:\n  resolveArguments: false', {
      'features/raw.feature': 'Feature: Raw\n  Scenario: As written\n    When the owner "${dbOwnerName}" books "x" with reference "R-1"\n',
      'steps/visits.steps.ts': STEPS,
    });
    await cli(project.dir, ['run']);
    const { run } = await latestRun(project.dir);
    const j = run.journeys[0];
    expect(j.status, tree(j.steps)).toBe('passed');
    expect((j.ledger.booked as { owner: string }).owner).toBe('${dbOwnerName}');
  });

  it('eztest validate warns when an Examples row refers to a variable no earlier step sets', async () => {
    project = await clinicProject('', {
      'features/warn.feature': [
        'Feature: Owners',
        '  Background:',
        '    Given I get the value of query "OWNER_NAME" on clinic with owner_id=1 as dbOwnerName',
        '  Scenario Outline: Book for <ownerName>',
        '    When the owner "<ownerName>" books "check-up" with reference "R-<n>"',
        '    Examples:',
        '      | ownerName       | n |',
        '      | ${dbOwnerName}  | 1 |',
        '      | ${dbPetName}    | 2 |',
        '',
      ].join('\n'),
      'steps/visits.steps.ts': STEPS,
    });
    const r = await cli(project.dir, ['validate', 'features']);
    const out = r.out.join('\n');
    expect(out).toMatch(/warn\s+\S*features\/warn\.feature:9: Examples row uses \$\{dbPetName\}, but no earlier step sets "dbPetName"/);
    expect(out).not.toMatch(/dbOwnerName\}, but no earlier step/);
  });
});
