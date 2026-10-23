import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyEvidence, type EvidenceRef } from '../../src/core/index.js';
import { parseSalesforceEzScript } from '../../src/salesforce/index.js';
import { startSalesforceMock, type SalesforceMockServer } from '../../examples/salesforce-mock/server.js';
import { clientFor, runSf, stepLines, tempDir, tokenProviderFor } from './fixtures.js';

let mock: SalesforceMockServer;
beforeAll(async () => {
  mock = await startSalesforceMock();
});
afterAll(async () => {
  await mock?.close();
});

const allPassed = (run: Awaited<ReturnType<typeof runSf>>, i = 0) => run.journeys[i].steps.map((s) => `${s.stepId}:passed`);
const accounts = () => [...mock.store.table('Account').values()];
const opps = () => [...mock.store.table('Opportunity').values()];

const CREATE_ACME = `
Journey: Create the Acme account
Id: create-acme
Tags: @salesforce @accounts
Log in to Salesforce as admin
Open the Accounts tab
Create a new Account
Set Salesforce field "Account Name" to "Acme"
Set Salesforce field "Type" to "Prospect"
Set "Industry" to "Energy" on the record
Set Salesforce field "Sub-Industry" to "Renewables"
Set Salesforce field "Annual Revenue" to "1250000"
Set Salesforce field "Active" to "true"
Set Salesforce field "SLA Expiration Date" to "2027-03-15"
Set Salesforce field "Description" to "Wind farms in the North Sea"
Save the Salesforce record
Expect the toast to contain "was created"
Expect Salesforce field "Account Name" to be "Acme"
Expect Salesforce field "Annual Revenue" to be "$1,250,000.00"
Expect "Industry" to be "Energy" on the record
Expect Salesforce field "Sub-Industry" to be "Renewables"
Expect Salesforce field "Active" to be "Yes"
Expect Salesforce field "SLA Expiration Date" to be "3/15/2027"
Verify in Salesforce that Account "Acme" has Industry = "Energy" and Sub_Industry__c = "Renewables" and "Annual Revenue" = "1250000" and Active__c = "true" and "SLA Expiration Date" = "2027-03-15"
Expect the Accounts list view to contain "Acme"
`;

describe('Salesforce adapter against the Lightning mock (real Chromium, open shadow DOM)', () => {
  it('creates an account with picklist, dependent picklist, currency, checkbox, date and textarea; verifies via UI and SOQL', async () => {
    const j = parseSalesforceEzScript(CREATE_ACME);
    expect(j.steps.map((s) => s.handler)).toEqual([
      'sf.login', 'sf.openTab', 'sf.newRecord', 'sf.setField', 'sf.setField', 'sf.setField', 'sf.setField', 'sf.setField', 'sf.setField', 'sf.setField', 'sf.setField',
      'sf.save', 'sf.expectToast', 'sf.expectField', 'sf.expectField', 'sf.expectField', 'sf.expectField', 'sf.expectField', 'sf.expectField',
      'sf.verifySoql', 'sf.expectListView',
    ]);
    // Expect/Verify lines are standalone steps keeping their wording, not post-conditions.
    expect(j.steps[12].intent).toBe('Expect the toast to contain "was created"');

    const run = await runSf(mock, [j]);
    expect(stepLines(run)).toEqual(allPassed(run));
    const jr = run.journeys[0];
    expect(jr.status).toBe('passed');

    const rec = accounts().find((r) => r.Name === 'Acme')!;
    expect(rec).toMatchObject({ Type: 'Prospect', Industry: 'Energy', Sub_Industry__c: 'Renewables', AnnualRevenue: 1_250_000, Active__c: true, SLAExpirationDate__c: '2027-03-15', Description: 'Wind farms in the North Sea' });

    const sf = jr.ledger.salesforce as Record<string, any>;
    expect(sf.user).toEqual({ role: 'admin', username: 'admin@ez.test' });
    expect(sf.recordId).toBe(rec.Id);
    expect(sf.records.Account).toBe(rec.Id);
    expect(sf.toast).toEqual({ type: 'success', message: 'Account "Acme" was created.' });
    expect(sf.fields).toMatchObject({ Name: 'Acme', Industry: 'Energy', Sub_Industry__c: 'Renewables', AnnualRevenue: '$1,250,000.00', Active__c: 'true', SLAExpirationDate__c: '3/15/2027' });
    expect(sf.soql.Account).toMatchObject({ Id: rec.Id, Industry: 'Energy', AnnualRevenue: 1_250_000, Active__c: true, SLAExpirationDate__c: '2027-03-15' });
    expect(sf.listView).toMatchObject({ object: 'Account', name: 'Recently Viewed', matched: [rec.Id] });
    // The SOQL cross-check went through the safe builder (validated against describe, string literal escaped).
    expect(mock.stats.queries.at(-1)).toBe(
      "SELECT Id, Name, Industry, Sub_Industry__c, AnnualRevenue, Active__c, SLAExpirationDate__c FROM Account WHERE Name = 'Acme' LIMIT 2",
    );
  });

  it('creates an opportunity with a strict lookup to that account, moves the path and cross-checks the stage in SOQL', async () => {
    const j = parseSalesforceEzScript(`
Journey: Acme wind deal
Id: acme-deal
Log in to Salesforce as admin
Create a new Opportunity
Set Salesforce field "Opportunity Name" to "Acme Wind Deal"
Set lookup "Account Name" to "Acme"
Set Salesforce field "Amount" to "50000"
Set Salesforce field "Close Date" to "9/30/2030"
Set Salesforce field "Stage" to "Prospecting"
Save the Salesforce record
Expect the toast to contain "was created"
Expect Salesforce field "Stage" to be "Prospecting"
Expect Salesforce field "Account Name" to be "Acme"
Expect the path stage to be "Prospecting"
Mark the stage as complete
Expect the toast to contain "Stage changed"
Expect the path stage to be "Qualification"
Expect Salesforce field "Stage" to be "Qualification"
Verify in Salesforce that Opportunity "Acme Wind Deal" has StageName = "Qualification" and "Account Name" = "Acme" and Amount = "50000" and "Close Date" = "9/30/2030"
Set "Stage" to "Proposal" on the record
Save the Salesforce record
Expect Salesforce field "Stage" to be "Proposal"
`);
    const run = await runSf(mock, [j]);
    expect(stepLines(run)).toEqual(allPassed(run));
    const acme = accounts().find((r) => r.Name === 'Acme')!;
    const holdings = accounts().find((r) => r.Name === 'Acme Holdings')!;
    const opp = opps().find((r) => r.Name === 'Acme Wind Deal')!;
    expect(opp).toMatchObject({ AccountId: acme.Id, Amount: 50_000, CloseDate: '2030-09-30', StageName: 'Proposal' });
    expect(opp.AccountId).not.toBe(holdings.Id); // exact match, not "Acme Holdings"
    const sf = run.journeys[0].ledger.salesforce as Record<string, any>;
    expect(sf.lookups.AccountId).toEqual({ id: acme.Id, name: 'Acme' });
    expect(sf.stage).toBe('Qualification');
    expect(sf.soql.Opportunity).toMatchObject({ StageName: 'Qualification', AccountId: acme.Id });
    // Relationship field selected through the builder (Account.Name), validated against describe.
    expect(mock.stats.queries.at(-1)).toContain('Account.Name');
  });

  it('surfaces the validation rule as the save step error and keeps the record unsaved', async () => {
    const before = mock.store.table('Opportunity').size;
    const j = parseSalesforceEzScript(`
Journey: Past close date
Id: past-close
Log in to Salesforce as admin
Create a new Opportunity
Set Salesforce field "Opportunity Name" to "Stale Deal"
Set Salesforce field "Close Date" to "2020-01-15"
Set Salesforce field "Stage" to "Prospecting"
Save the Salesforce record
`);
    const run = await runSf(mock, [j]);
    const save = run.journeys[0].steps.find((s) => s.stepId === 'save-the-salesforce-record')!;
    expect(save.status).toBe('failed');
    expect(save.error?.message).toBe('Save failed: Close Date: Close Date must be in the future for open opportunities');
    expect(mock.store.table('Opportunity').size).toBe(before);
    expect(run.journeys[0].ledger.salesforce).toMatchObject({ errors: ['Close Date: Close Date must be in the future for open opportunities'] });

    // The same failure can be the expected outcome of a negative test.
    const neg = parseSalesforceEzScript(`
Journey: Negative close date
Id: negative-close
Log in to Salesforce as admin
Create a new Opportunity
Set Salesforce field "Opportunity Name" to "Stale Deal"
Set Salesforce field "Close Date" to "2020-01-15"
Set Salesforce field "Stage" to "Prospecting"
Save the Salesforce record and expect the error "Close Date must be in the future"
Cancel the Salesforce record
`);
    const run2 = await runSf(mock, [neg]);
    expect(stepLines(run2)).toEqual(allPassed(run2));
  });

  it('reports required fields with their labels and blocks a path move with the validation rule toast', async () => {
    const req = parseSalesforceEzScript(`
Journey: Missing name
Id: missing-name
Log in to Salesforce as admin
Create a new Account
Set Salesforce field "Account Phone" to "555-0199"
Save the Salesforce record
`);
    // An open opportunity whose close date has passed (inserted behind the API's back).
    const opp = mock.objects().find((o) => o.name === 'Opportunity')!;
    const globex = accounts().find((r) => r.Name === 'Globex')!;
    mock.store.insert(opp, { Name: 'Overdue Deal', AccountId: globex.Id, StageName: 'Prospecting', CloseDate: '2021-05-01' });
    const path = parseSalesforceEzScript(`
Journey: Blocked path
Id: blocked-path
Log in to Salesforce as admin
Open the Opportunity "Overdue Deal"
Mark the stage as complete
`);
    const run = await runSf(mock, [req, path]);
    const err = (i: number) => run.journeys[i].steps.find((s) => s.status === 'failed')?.error?.message;
    expect(err(0)).toBe('Save failed: Account Name: Complete this field.');
    expect(err(1)).toBe('Could not mark "Prospecting" as complete: Close Date must be in the future for open opportunities');
    expect(opps().find((r) => r.Name === 'Overdue Deal')!.StageName).toBe('Prospecting');
  });

  it('checks related lists and list views, and fails with what was actually seen', async () => {
    const ok = parseSalesforceEzScript(`
Journey: Globex contacts
Id: globex-contacts
Log in to Salesforce as admin
Open the Account "Globex"
Expect the related list "Contacts" to contain "Jane Doe"
Expect the related list "Opportunities" to contain "Globex Renewal"
Expect Salesforce field "Industry" to be "Technology"
`);
    const bad = parseSalesforceEzScript(`
Journey: Wrong expectations
Id: wrong
Log in to Salesforce as admin
Open the Account "Globex"
Expect the related list "Contacts" to contain "Bob Builder"
`);
    const badList = parseSalesforceEzScript(`Journey: Missing row\nId: missing-row\nLog in to Salesforce as admin\nExpect the Accounts list view to contain "Northwind"`);
    const badField = parseSalesforceEzScript(`Journey: Wrong field\nId: wrong-field\nLog in to Salesforce as admin\nOpen the Account "Globex"\nExpect Salesforce field "Account Phone" to be "000"`);
    const badSoql = parseSalesforceEzScript(`Journey: Wrong soql\nId: wrong-soql\nVerify in Salesforce that Account "Globex" has Industry = "Retail"`);
    const badLookup = parseSalesforceEzScript(`Journey: Bad lookup\nId: bad-lookup\nLog in to Salesforce as admin\nCreate a new Opportunity\nSet lookup "Account Name" to "Acm"`);
    const typo = parseSalesforceEzScript(`Journey: Typo\nId: typo\nLog in to Salesforce as admin\nCreate a new Account\nSet Salesforce field "Anual Revenue" to "1"`);
    const dependent = parseSalesforceEzScript(`Journey: Dependent\nId: dependent\nLog in to Salesforce as admin\nCreate a new Account\nSet Salesforce field "Sub-Industry" to "Software"`);
    const wrongDep = parseSalesforceEzScript(`Journey: Wrong dependent\nId: wrong-dep\nLog in to Salesforce as admin\nCreate a new Account\nSet Salesforce field "Industry" to "Retail"\nSet Salesforce field "Sub-Industry" to "Software"`);
    const run = await runSf(mock, [ok, bad, badList, badField, badSoql, badLookup, typo, dependent, wrongDep]);
    expect(stepLines(run, 0)).toEqual(allPassed(run, 0));
    const err = (i: number) => run.journeys[i].steps.find((s) => s.status === 'failed')?.error?.message;
    expect(err(1)).toBe('Related list "Contacts" has no row with "Bob Builder" (2 rows: "Jane Doe", "John Smith")');
    expect(err(2)).toMatch(/^List view "Recently Viewed" has no row with "Northwind" \(\d+ rows: "Acme", "Acme Holdings", "Globex"/);
    expect(err(3)).toBe('Salesforce field "Account Phone" (Phone) is "555-0101", expected "000"');
    expect(err(4)).toBe('Salesforce Account "Globex": Industry is "Technology", expected "Retail"');
    expect(err(5)).toBe('Salesforce lookup "Account Name": no record named exactly "Acm" (results: "Acme", "Acme Holdings")');
    expect(err(6)).toBe('Field "Anual Revenue" not found on Account. Did you mean "Annual Revenue"?');
    expect(err(7)).toBe('Salesforce picklist "Sub-Industry" is disabled (it depends on "Industry"; set that first)');
    expect(err(8)).toBe('Salesforce picklist "Sub-Industry" has no option "Software" (options: Grocery)');
  });

  it('stores Salesforce evidence (screenshots + JSON) in a verified manifest without tokens, passwords or secrets', async () => {
    const j = parseSalesforceEzScript(`
Journey: Evidence check
Id: evidence
Log in to Salesforce as rep
Create a new Account
Set Salesforce field "Account Name" to "Evidence Co"
Save the Salesforce record
Verify in Salesforce that Account "Evidence Co" has Name = "Evidence Co"
`);
    const out = await tempDir('ev');
    const run = await runSf(mock, [j], {}, out);
    expect(stepLines(run)).toEqual(allPassed(run));
    const runDir = join(out, run.runId);
    const entries = (await readFile(join(runDir, 'evidence-manifest.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as EvidenceRef);
    const sf = entries.filter((e) => e.path.includes('salesforce/'));
    expect(sf.some((e) => e.kind === 'screenshot' && e.path.includes('saved'))).toBe(true);
    const login = sf.find((e) => e.path.includes('login'))!;
    expect(JSON.parse(await readFile(join(runDir, login.path), 'utf8'))).toEqual({ role: 'rep', username: 'rep@ez.test', landedOn: '/lightning/page/home' });
    const soqlEv = sf.find((e) => e.path.includes('soql'))!;
    const body = JSON.parse(await readFile(join(runDir, soqlEv.path), 'utf8')) as { soql: string; checks: Array<{ passed: boolean }> };
    expect(body.soql).toBe("SELECT Id, Name FROM Account WHERE Name = 'Evidence Co' LIMIT 2");
    expect(body.checks).toEqual([expect.objectContaining({ apiName: 'Name', passed: true })]);

    const integrationToken = await tokenProviderFor(mock).getToken();
    const texts = await Promise.all(entries.filter((e) => /\.(json|jsonl|txt|html)$/.test(e.path)).map((e) => readFile(join(runDir, e.path), 'utf8')));
    const all = [...texts, await readFile(join(runDir, 'evidence-manifest.jsonl'), 'utf8'), JSON.stringify(run)].join('\n');
    for (const secret of [mock.users.rep.password, mock.users.admin.password, mock.clientSecret, integrationToken]) expect(all).not.toContain(secret);
    expect(all).not.toMatch(/00D5g000004EZTE!/); // no access token of any user
    expect(all).not.toMatch(/Bearer\s+\S{10,}/);
    expect((await verifyEvidence(runDir)).ok).toBe(true);
    // Sanity: the integration client is distinct from the UI session and still works.
    expect(await clientFor(mock).findByName('Account', 'Evidence Co')).toHaveLength(1);
  });

  it('fails the login step with the login page error for a wrong password', async () => {
    const j = parseSalesforceEzScript(`Journey: Bad login\nId: bad-login\nLog in to Salesforce as rep`);
    const run = await runSf(mock, [j], { credentials: async () => ({ username: 'rep@ez.test', password: 'wrong-password' }) });
    expect(run.journeys[0].steps[0].error?.message).toBe(
      "Salesforce login as rep (rep@ez.test) failed: Please check your username and password. If you still can't log in, contact your Salesforce administrator.",
    );
    expect(JSON.stringify(run)).not.toContain('wrong-password');
  });
});
