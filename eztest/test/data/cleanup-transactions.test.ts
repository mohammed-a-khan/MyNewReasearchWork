/**
 * Cleanup actions, database transactions and live test data, end to end through `eztest run` (real browser
 * runner, real SQLite clinic database):
 *  - `.ez`: Snapshot ... and restore it ..., On cleanup run query ..., In a transaction on clinic ... End;
 *  - code: db.transaction, db.executeAll, cleanup.add / query / snapshot, poll, log.pass;
 *  - Gherkin: ctx.cleanup in a definition, `{ retry }`, @depends-on handoff, `Load ... or run query ...`,
 *    Examples `resolve with query ... as pet when ...` (an empty result is a test-data problem);
 *  - a crashed run's journaled cleanup queries are run by the next run's orphan sweep.
 */
import { afterEach, describe, expect, it } from '../support/testkit.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { JourneyResult, StepResult } from '../../src/core/index.js';
import { byId, cli, flat, latestRun, tree } from '../sdk/helpers.js';
import { clinicProject, type ClinicProject } from '../support/clinic.js';

let project: ClinicProject | undefined;
afterEach(async () => {
  await project?.remove();
  project = undefined;
});

const EZ_CLEANUP = `Journey: Rename a pet and book a visit
Tags: @data

Set variable petId to 10
Snapshot query "PET_ROW" on clinic with pet_id=\${petId} and restore it with "RESTORE_PET" after the journey
Run query "RENAME_PET" on clinic with pet_id=\${petId}, name="Biscuit II" as renamed
Set variable visitId to "V-CLEAN-1"
Run query "INSERT_VISIT" on clinic with visit_id=\${visitId}, pet_id=\${petId}, reason="vaccination" as inserted
On cleanup run query "DELETE_VISIT" on clinic with visit_id=\${visitId}
Expect query "VISIT_BY_ID" on clinic with visit_id=\${visitId} returns 1 row
Expect query "VISIT_BY_ID" on clinic with visit_id="V-NOT-THERE" returns 1 row
`;

const EZ_TX = `Journey: Book two visits in one transaction
Tags: @data

In a transaction on clinic
  Run query "INSERT_VISIT" on clinic with visit_id="V-TX-1", pet_id=11, reason="x-ray" as first
  Run query "INSERT_VISIT" on clinic with visit_id="V-TX-2", pet_id=11, reason="blood test" as second
End
Get the value of query "VISIT_COUNT" on clinic with pet_id=11 as visits
Expect \${visits} equals 2
`;

const EZ_ROLLBACK = `Journey: A failing statement rolls the transaction back
Tags: @data

In a transaction on clinic
  Run query "INSERT_VISIT" on clinic with visit_id="V-TX-3", pet_id=12, reason="dental" as first
  Run query "INSERT_VISIT" on clinic with visit_id="V-TX-3", pet_id=12, reason="the same id again" as second
End
`;

const CODE = `import { journey, db, cleanup, poll, log } from 'eztest/sdk';

journey('Visits in code', { tags: ['@data'] }, async () => {
  await db.transaction(async (tx) => {
    await tx.execute('INSERT_VISIT', { visit_id: 'V-SDK-1', pet_id: 12, reason: 'check-up' });
    await tx.execute('INSERT_VISIT', { visit_id: 'V-SDK-2', pet_id: 12, reason: 'grooming' });
  }, { connection: 'clinic' });
  const all = await db.executeAll([{ query: 'INSERT_VISIT', params: { visit_id: 'V-SDK-3', pet_id: 12, reason: 'nails' } }, ['VISIT_COUNT', { pet_id: 12 }]], { connection: 'clinic' });
  log.info('visits after executeAll: ' + String(Object.values(all[1].rows[0])[0]));
  cleanup.add('remove the first two code visits', async () => {
    await db.execute('DELETE_VISIT', { visit_id: 'V-SDK-1' });
    await db.execute('DELETE_VISIT', { visit_id: 'V-SDK-2' });
  });
  await cleanup.query('DELETE_VISIT', { visit_id: 'V-SDK-3' }, { connection: 'clinic' });
  const before = await cleanup.snapshot('PET_ROW', { pet_id: 12 }, { restore: 'RESTORE_PET' });
  await db.execute('RENAME_PET', { pet_id: 12, name: 'Juni ' + String(before.name) });
  let n = 0;
  const v = await poll(async () => (++n >= 3 ? n : 0), { within: 5000, every: 20, message: 'the third try' });
  await log.pass('polled ' + v + ' times');
  // A failed transaction rolls back; the code catches it and goes on.
  await db.transaction(async (tx) => {
    await tx.execute('INSERT_VISIT', { visit_id: 'V-SDK-RB', pet_id: 12, reason: 'rolled back' });
    throw new Error('stop here');
  }, { connection: 'clinic' }).catch(() => undefined);
});
`;

const STEPS = `import { Given, When, Then } from 'eztest/bdd';

let tries = 0;
When('I book visit {string} for pet {int} and clean it up afterwards', async ({ db, cleanup }, id: string, pet: number) => {
  await db.execute('INSERT_VISIT', { visit_id: id, pet_id: pet, reason: 'bdd' });
  await cleanup.query('DELETE_VISIT', { visit_id: id }, { connection: 'clinic' });
  cleanup.add('note the cleanup of ' + id, async () => { /* nothing to undo */ });
});
Then('the check passes on the third try', { retry: { attempts: 3, every: 10 } }, async ({ expect }) => {
  tries++;
  await expect(tries, 'tries').toBe(3);
});
Then('the visit {string} is in the database', async ({ db, expect }, id: string) => {
  const rows = await db.query('VISIT_BY_ID', { visit_id: id });
  await expect(rows.length, 'visits ' + id).toBe(1);
});
Then('the pet {string} is a {word}', async ({ vars }, name: string, species: string) => {
  vars.set('petSeen', { name, species });
});
Given('visit {string} is booked', async ({ db, vars }, id: string) => {
  await db.execute('INSERT_VISIT', { visit_id: id, pet_id: 10, reason: 'follow-up' });
  vars.set('visitId', id);
});
`;

const BOOK = `Feature: Visit book
  Scenario: Book a follow-up
    Given visit "V-DEP-1" is booked
`;

const FOLLOW = `@depends-on:visit-book--book-a-follow-up with visitId
Feature: Follow-up
  Scenario: The follow-up is there
    Then the visit "\${visitId}" is in the database
`;

const MORE = `Feature: Clinic data
  Scenario: Cleanup and retry from definitions
    When I book visit "V-BDD-1" for pet 10 and clean it up afterwards
    Then the check passes on the third try

  Scenario: Any open visit when the shared store has none
    Given I load "open-visit" from the shared store as visitId or run query "ANY_OPEN_VISIT" on clinic as visit
    Then the visit "\${visitId}" is in the database

  Scenario Outline: Treat a pet in state <requiredState>
    Then the pet "<pet.name>" is a <pet.species>

    Examples: from data "data/treatments.csv" resolve with query "FIND_PET_FOR_STATE" on clinic with state=<requiredState> as pet when dataMode = live
    Examples: from data "data/discharged.csv" resolve with query "FIND_PET_FOR_STATE" on clinic with state=<requiredState> as pet or keep row values
`;

const steps = (j: JourneyResult) => j.steps.map((s) => s.intent);
const cleanups = (j: JourneyResult) => j.steps.filter((s) => s.cleanup);

describe('cleanup actions, transactions and live data (real runner, SQLite)', () => {
  it('runs registered cleanups in reverse after the journey, also after a failure; transactions commit or roll back', async () => {
    project = await clinicProject('', {
      'journeys/cleanup.ez': EZ_CLEANUP,
      'journeys/tx.ez': EZ_TX,
      'journeys/rollback.ez': EZ_ROLLBACK,
      'journeys/visits.journey.ts': CODE,
    });
    await cli(project.dir, ['run', 'journeys']);
    const { run } = await latestRun(project.dir);
    const summary = run.journeys.map((j) => `${j.journeyId} ${j.status} ${j.error?.message ?? ''}\n${tree(j.steps, 1)}`).join('\n');

    // .ez: the journey failed at its last step; both cleanups still ran, newest first, as cleanup steps.
    const clean = byId(run, 'rename-a-pet-and-book-a-visit');
    expect(clean.status, summary).toBe('failed');
    expect(cleanups(clean).map((s) => [s.intent, s.status]), summary).toEqual([
      ['Cleanup: run query DELETE_VISIT on clinic with visit_id=V-CLEAN-1', 'passed'],
      ['Cleanup: restore PET_ROW with RESTORE_PET (pet_id=10)', 'passed'],
    ]);
    const db = project.open();
    try {
      expect(db.prepare("SELECT name, state, weight_kg FROM pets WHERE pet_id = 10").get()).toEqual({ name: 'Biscuit', state: 'healthy', weight_kg: 12.5 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM visits WHERE visit_id = 'V-CLEAN-1'").get()).toEqual({ n: 0 });
      // The transaction committed both visits; the failing one left nothing behind.
      expect(db.prepare("SELECT visit_id FROM visits WHERE pet_id = 11 ORDER BY visit_id").all()).toEqual([{ visit_id: 'V-TX-1' }, { visit_id: 'V-TX-2' }]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM visits WHERE visit_id = 'V-TX-3'").get()).toEqual({ n: 0 });
      // Code: committed visits removed by the cleanups, the pet restored, the rolled-back visit never there.
      expect(db.prepare("SELECT visit_id FROM visits WHERE visit_id LIKE 'V-SDK-%'").all()).toEqual([]);
      expect(db.prepare('SELECT name FROM pets WHERE pet_id = 12').get()).toEqual({ name: 'Juniper' });
    } finally {
      db.close();
    }
    // Every cleanup ran, so the journal is gone.
    const journalDir = join(project.dir, '.eztest', 'cleanup');
    expect(existsSync(journalDir) ? readdirSync(journalDir).filter((f) => f.endsWith('.jsonl')) : []).toEqual([]);

    const tx = byId(run, 'book-two-visits-in-one-transaction');
    expect(tx.status, summary).toBe('passed');
    expect(tx.steps[0].captured).toMatchObject({ transaction: 'committed', statements: 2 });
    expect(tx.steps[0].children!.map((c) => c.status)).toEqual(['passed', 'passed']);
    expect(tx.steps[0].evidence.length).toBe(1);
    const rb = byId(run, 'a-failing-statement-rolls-the-transaction-back');
    expect(rb.status).toBe('failed');
    expect(rb.steps[0].captured).toMatchObject({ transaction: 'rolled back', statements: 1 });

    const code = byId(run, 'visits-in-code');
    expect(code.status, summary).toBe('passed');
    const all = flat(code.steps);
    expect(all.map((s) => s.intent)).toEqual(expect.arrayContaining([
      'Transaction on clinic', 'Commit the transaction on clinic (2 statement(s))', 'Roll back the transaction on clinic', 'Poll until the third try', 'polled 3 times',
    ]));
    expect(all.find((s) => s.intent === 'Poll until the third try')!.warnings).toEqual(['attempt 1 failed: not yet: the third try', 'attempt 2 failed: not yet: the third try']);
    expect(cleanups(code).map((s) => [s.intent, s.status])).toEqual([
      ['Cleanup: restore PET_ROW with RESTORE_PET (pet_id=12)', 'passed'],
      ['Cleanup: run query DELETE_VISIT on clinic with visit_id=V-SDK-3', 'passed'],
      ['Cleanup: remove the first two code visits', 'passed'],
    ]);
    expect(cleanups(code)[2].children!.length).toBe(2);
    expect(steps(code)).not.toContain('Code error');
  });

  it('Gherkin: cleanup and retry in definitions, @depends-on handoff, store fallback to a query, live rows per Examples row', async () => {
    project = await clinicProject('', {
      'steps/clinic.steps.ts': STEPS,
      'features/visit-book.feature': BOOK,
      'features/follow-up.feature': FOLLOW,
      'features/clinic-data.feature': MORE,
      'data/treatments.csv': 'requiredState,dataMode\nin-treatment,live\nhealthy,offline\ndischarged,live\n',
      'data/discharged.csv': 'requiredState,dataMode\ndischarged,live\n',
    });
    await cli(project.dir, ['run', 'features']);
    const { run } = await latestRun(project.dir);
    const summary = run.journeys.map((j) => `${j.journeyId} ${j.status} ${j.error?.name ?? ''} ${j.error?.message ?? ''}\n${tree(j.steps, 1)}`).join('\n');

    const defs = byId(run, 'clinic-data--cleanup-and-retry-from-definitions');
    expect(defs.status, summary).toBe('passed');
    expect(cleanups(defs).map((s) => s.intent)).toEqual(['Cleanup: note the cleanup of V-BDD-1', 'Cleanup: run query DELETE_VISIT on clinic with visit_id=V-BDD-1']);
    const retried = defs.steps.find((s) => s.intent === 'Then the check passes on the third try')!;
    expect(retried.captured).toMatchObject({ attempts: 3 });
    expect(retried.warnings?.length).toBe(2);

    // @depends-on: the prerequisite ran first and handed visitId over.
    const follow = byId(run, 'follow-up--the-follow-up-is-there');
    expect(follow.status, summary).toBe('passed');
    expect(follow.reliability?.dependsOn?.[0]).toMatchObject({ journeyId: 'visit-book--book-a-follow-up', handoff: ['visitId'] });

    // The shared store has no "open-visit": the query's first row is used.
    const open = byId(run, 'clinic-data--any-open-visit-when-the-shared-store-has-none');
    expect(open.status, summary).toBe('passed');
    expect(open.ledger.visitId).toBe('V-OPEN-1');
    expect(open.ledger.visit).toMatchObject({ visit_id: 'V-OPEN-1', pet_id: 12 });

    // Live rows: the matching row got the query's first row as pet.*, the offline row kept its values,
    // the row with no pet in that state is a test-data problem (not a product failure).
    const live = byId(run, 'clinic-data--treat-a-pet-in-state-requiredstate-in-treatment');
    expect(live.status, summary).toBe('passed');
    expect(live.ledger.petSeen).toEqual({ name: 'Pepper', species: 'cat' });
    expect(byId(run, 'clinic-data--treat-a-pet-in-state-requiredstate-healthy').ledger.petSeen).toEqual({ name: '<pet.name>', species: '<pet.species>' });
    const none = byId(run, 'clinic-data--treat-a-pet-in-state-requiredstate-discharged');
    expect(none.status).toBe('error');
    expect(none.error?.name).toBe('DataPrecondition');
    expect(none.error?.message).toContain('no test data: query FIND_PET_FOR_STATE on clinic with state=discharged returned no row for pet');
    // "or keep row values": the same row runs with its own values.
    expect(byId(run, 'clinic-data--treat-a-pet-in-state-requiredstate-2-discharged').status, summary).toBe('passed');
  });

  it("runs a crashed run's journaled cleanup queries in the next run's orphan sweep", async () => {
    project = await clinicProject('', { 'journeys/noop.ez': 'Journey: Nothing much\n\nSet variable x to 1\n' });
    const db = project.open();
    db.exec("INSERT INTO visits (visit_id, pet_id, reason) VALUES ('V-CRASH-1', 10, 'left behind')");
    db.close();
    // A journal written by a process that is gone (same host, dead pid): its query was never marked done.
    const dir = join(project.dir, '.eztest', 'cleanup');
    await mkdir(dir, { recursive: true });
    const entry = {
      op: 'add', id: 'j-1', provider: 'eztest-cleanup', entity: 'query', recordId: 'crashed: run query DELETE_VISIT',
      record: { connection: 'clinic', query: 'DELETE_VISIT', binds: { visit_id: 'V-CRASH-1' }, description: 'run query DELETE_VISIT', journeyId: 'crashed' },
      createdAt: Date.now() - 60_000, owner: 'crashed', host: hostname(), pid: 2 ** 22 + 12345,
    };
    await writeFile(join(dir, 'crashed.jsonl'), `${JSON.stringify(entry)}\n`);
    await cli(project.dir, ['run', 'journeys']);
    const after = project.open();
    try {
      expect(after.prepare("SELECT COUNT(*) AS n FROM visits WHERE visit_id = 'V-CRASH-1'").get()).toEqual({ n: 0 });
    } finally {
      after.close();
    }
    expect(readdirSync(dir).filter((f) => f.endsWith('.jsonl'))).toEqual([]);
    expect(readFileSync(join(project.dir, 'eztest.config.yaml'), 'utf8')).toContain('clinic');
  });
});

export type { StepResult };
