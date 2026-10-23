import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyEvidence, type EvidenceRef } from '../../src/core/index.js';
import { registerIntentRules } from '../../src/intent/index.js';
import { D365_INTENT_RULES, parseD365EzScript } from '../../src/d365/index.js';
import { startD365Mock, type D365MockServer } from '../../examples/d365-mock/server.js';
import { clientFor, runD365, stepLines } from './fixtures.js';

let mock: D365MockServer;
let unregister: () => void;
beforeAll(async () => {
  mock = await startD365Mock();
  unregister = registerIntentRules(D365_INTENT_RULES);
});
afterAll(async () => {
  unregister?.();
  await mock?.close();
});

const CREATE_CONTOSO = `
Journey: Create the Contoso account
Id: create-contoso
Tags: @d365 @accounts
Open the Account form
Set D365 field "Account Name" to "Contoso"
Set "Main Phone" to "555-0100" on the form
Set D365 field "Industry" to "Consulting"
Set D365 field "Annual Revenue" to "1250000"
Set lookup "Parent Account" to "Fabrikam"
Set D365 field "Credit Hold" to "Yes"
Set D365 field "Last Date Included in Campaign" to "2026-03-15"
Set D365 field "Number of Employees" to "42"
Save the record
Expect the record to be saved
Expect D365 field "Account Name" to be "Contoso"
Expect D365 field "Annual Revenue" to be "$1,250,000.00"
Expect D365 field "Industry" to be "Consulting"
Expect D365 field "Parent Account" to be "Fabrikam"
Expect "Credit Hold" to be "Yes" on the form
Verify in Dataverse that account "Contoso" has "telephone1" = "555-0100" and "Industry" = "Consulting" and "revenue" = "1250000" and "Parent Account" = "Fabrikam" and "creditonhold" = "Yes" and "lastusedincampaign" = "2026-03-15" and "numberofemployees" = "42"
Open the Accounts view
Expect the Accounts view to contain "Contoso"
`;

describe('D365 adapter against the UCI mock (real Chromium)', () => {
  it('creates an account with option set, money, lookup, two-options and date; verifies via UI and the Dataverse Web API', async () => {
    const j = parseD365EzScript(CREATE_CONTOSO);
    // D365 Expect/Verify lines became standalone custom steps with their original wording.
    expect(j.steps.map((s) => s.handler)).toEqual([
      'd365.openForm', 'd365.setField', 'd365.setField', 'd365.setField', 'd365.setField', 'd365.setField', 'd365.setField', 'd365.setField', 'd365.setField',
      'd365.save', 'd365.expectSaved', 'd365.expectField', 'd365.expectField', 'd365.expectField', 'd365.expectField', 'd365.expectField',
      'd365.verifyDataverse', 'd365.openView', 'd365.expectView',
    ]);
    expect(j.steps[10].intent).toBe('Expect the record to be saved');
    expect(j.steps[10].id).toBe('expect-the-record-to-be-saved');

    const run = await runD365(mock, [j]);
    const jr = run.journeys[0];
    expect(stepLines(run)).toEqual(jr.steps.map((s) => `${s.stepId}:passed`));
    expect(jr.status).toBe('passed');

    // Persisted in the in-memory store with the right types.
    const rec = [...mock.store.table('account').values()].find((r) => r.name === 'Contoso')!;
    expect(rec).toMatchObject({ telephone1: '555-0100', industrycode: 7, revenue: 1_250_000, creditonhold: true, lastusedincampaign: '2026-03-15T00:00:00Z', numberofemployees: 42 });
    const fabrikam = [...mock.store.table('account').values()].find((r) => r.name === 'Fabrikam')!;
    expect(rec._parentaccountid_value).toBe(fabrikam.accountid); // exact match, not "Fabrikam Holdings"

    // Ledger: record id, field read-backs, lookup id, Dataverse values, view.
    const d = jr.ledger.d365 as Record<string, any>;
    expect(d.recordId).toBe(rec.accountid);
    expect(d.records.account).toBe(rec.accountid);
    expect(d.fields).toMatchObject({ name: 'Contoso', revenue: '$1,250,000.00', industrycode: 'Consulting', parentaccountid: 'Fabrikam', creditonhold: 'Yes', lastusedincampaign: '3/15/2026' });
    expect(d.lookups.parentaccountid).toEqual({ id: fabrikam.accountid, name: 'Fabrikam' });
    expect(d.dataverse.account).toMatchObject({ id: rec.accountid, telephone1: '555-0100', revenue: 1_250_000 });
    expect(d.view).toMatchObject({ entity: 'account', name: 'Active Accounts', matched: [rec.accountid] });
  });

  it('stores D365 evidence (screenshots + JSON) in the verified evidence manifest without tokens', async () => {
    const j = parseD365EzScript(`Journey: Evidence check\nOpen the Account form\nSet D365 field "Account Name" to "Evidence Co"\nSave the record\nVerify in Dataverse that account "Evidence Co" has "name" = "Evidence Co"`);
    const out = await import('./fixtures.js').then((f) => f.tempDir('ev'));
    const { runJourneys } = await import('../../src/runner/index.js');
    const { createD365Steps } = await import('../../src/d365/index.js');
    const run = await runJourneys([j], { baseUrl: mock.url, outputDir: out, customSteps: createD365Steps({ metadata: clientFor(mock) }) });
    expect(run.journeys[0].status).toBe('passed');
    const runDir = join(out, run.runId);
    const entries = (await readFile(join(runDir, 'evidence-manifest.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as EvidenceRef);
    const d365 = entries.filter((e) => e.path.includes('d365/'));
    expect(d365.some((e) => e.kind === 'screenshot' && e.path.includes('saved'))).toBe(true);
    const dv = d365.find((e) => e.path.includes('dataverse'))!;
    const body = JSON.parse(await readFile(join(runDir, dv.path), 'utf8')) as { checks: Array<{ passed: boolean }> };
    expect(body.checks).toEqual([expect.objectContaining({ column: 'name', passed: true })]);
    const all = await Promise.all(entries.filter((e) => /\.(json|jsonl|txt|html)$/.test(e.path)).map((e) => readFile(join(runDir, e.path), 'utf8')));
    expect(all.join('\n')).not.toMatch(/Bearer\s+\S{10,}/);
    expect(all.join('\n')).not.toContain(mock.clientSecret);
    expect((await verifyEvidence(runDir)).ok).toBe(true);
  });

  it('moves an opportunity through the business process flow and cross-checks the stage in Dataverse', async () => {
    const j = parseD365EzScript(`
Journey: Qualify an opportunity
Open a new Opportunity
Set D365 field "Topic" to "Contoso Q3 deal"
Set lookup "Account" to "Adventure Works"
Set D365 field "Est. Revenue" to "50000"
Set D365 field "Est. Close Date" to "9/30/2026"
Save the record
Expect the business process stage to be "Qualify"
Move to the next stage
Expect the business process stage to be "Develop"
Verify in Dataverse that opportunity "Contoso Q3 deal" has "stepname" = "Develop" and "Est. Close Date" = "2026-09-30"
`);
    const run = await runD365(mock, [j]);
    expect(stepLines(run)).toEqual(run.journeys[0].steps.map((s) => `${s.stepId}:passed`));
    const opp = [...mock.store.table('opportunity').values()].find((r) => r.name === 'Contoso Q3 deal')!;
    expect(opp.stepname).toBe('Develop');
    expect((run.journeys[0].ledger.d365 as { stage: string }).stage).toBe('Develop');
  });

  it('fails the save step with the form notification when a required field is missing', async () => {
    const j = parseD365EzScript(`
Journey: Account without a name
Open a new Account
Set "Main Phone" to "555-0199" on the form
Save the record
Expect the record to be saved
`);
    const before = mock.store.table('account').size;
    const run = await runD365(mock, [j]);
    const jr = run.journeys[0];
    expect(jr.status).toBe('failed');
    const save = jr.steps.find((s) => s.stepId === 'save-the-record')!;
    expect(save.status).toBe('failed');
    expect(save.error?.message).toBe('Save failed: Account Name: Required fields must be filled in.');
    expect(mock.store.table('account').size).toBe(before);
  });

  it('blocks a stage move when a required step is incomplete and surfaces the notification', async () => {
    const j = parseD365EzScript(`
Journey: Opportunity without account
Open a new Opportunity
Set D365 field "Topic" to "Orphan deal"
Save the record
Move to the next stage
`);
    const run = await runD365(mock, [j]);
    const step = run.journeys[0].steps.at(-1)!;
    expect(step.status).toBe('failed');
    expect(step.error?.message).toBe('Could not move to the next stage: Required steps are incomplete in stage Qualify: Account.');
  });

  it('fails assertions with what was actually seen (field, view, Dataverse)', async () => {
    const field = parseD365EzScript(`Journey: Wrong field\nOpen the Account record "Fabrikam"\nExpect D365 field "Main Phone" to be "000"`, { id: 'wrong-field' });
    const view = parseD365EzScript(`Journey: Missing row\nExpect the Accounts view to contain "Northwind"`, { id: 'missing-row' });
    const dv = parseD365EzScript(`Journey: Wrong dv\nVerify in Dataverse that account "Fabrikam" has "telephone1" = "000"`, { id: 'wrong-dv' });
    const lookup = parseD365EzScript(`Journey: Bad lookup\nOpen the Account form\nSet lookup "Parent Account" to "Fabri"`, { id: 'bad-lookup' });
    const run = await runD365(mock, [field, view, dv, lookup]);
    const err = (i: number) => run.journeys[i].steps.find((s) => s.status === 'failed')?.error?.message;
    expect(run.journeys[0].steps[0].status).toBe('passed'); // opened via the view
    expect(err(0)).toBe('D365 field "Main Phone" (telephone1) is "555-0111", expected "000"');
    expect(err(1)).toMatch(/^View "Active Accounts" has no row with "Northwind" \(\d+ rows: "Adventure Works"/);
    expect(err(2)).toBe('Dataverse account "Fabrikam": telephone1 is "555-0111", expected "000"');
    expect(err(3)).toBe('D365 lookup "Parent Account": no record named exactly "Fabri" (results: "Fabrikam", "Fabrikam Holdings")');
  });

  it('saves and closes back to the view', async () => {
    const j = parseD365EzScript(`
Journey: Save and close
Open the Account form
Set D365 field "Account Name" to "Closing Co"
Save and close the record
Expect the Accounts view to contain "Closing Co"
`);
    const run = await runD365(mock, [j]);
    expect(stepLines(run)).toEqual(run.journeys[0].steps.map((s) => `${s.stepId}:passed`));
  });
});
