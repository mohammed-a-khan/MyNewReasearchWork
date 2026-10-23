import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { parseEzScript } from '../../src/intent/index.js';
import {
  SalesforceFieldResolver, StaticDescribeSource, diffDescribe, impactedJourneys, parseSalesforceEzScript, snapshotDescribe, type DescribeSnapshot,
} from '../../src/salesforce/index.js';
import { startSalesforceMock, type SalesforceMockServer } from '../../examples/salesforce-mock/server.js';
import { clientFor, runSf, stepLines } from './fixtures.js';

let mock: SalesforceMockServer;
beforeAll(async () => {
  mock = await startSalesforceMock();
});
afterAll(async () => {
  await mock?.close();
});

const journeys = () => [
  parseSalesforceEzScript(`
Journey: Banking account
Id: account-banking
Risk: 4
Log in to Salesforce as admin
Create a new Account
Set Salesforce field "Account Name" to "Bank Co"
Set "Industry" to "Banking" on the record
Set "Account Phone" to "555-0100" on the record
Save the Salesforce record
Verify in Salesforce that Account "Bank Co" has Industry = "Banking"
`),
  parseSalesforceEzScript(`
Journey: Opportunity pipeline
Id: opp-pipeline
Log in to Salesforce as admin
Create a new Opportunity
Set Salesforce field "Opportunity Name" to "Pipeline"
Set Salesforce field "Stage" to "Needs Analysis"
Set Salesforce field "Amount" to "100"
Save the Salesforce record
Expect the path stage to be "Needs Analysis"
`),
  parseSalesforceEzScript(`
Journey: Globex in the list
Id: list-only
Log in to Salesforce as admin
Expect the Accounts list view to contain "Globex"
`),
  parseEzScript(`
Journey: Legacy phone entry
Id: legacy-phone
Open /lightning/o/Account/new
Type "555-0177" into the Account Phone field
`),
];

describe('release impact (Spring -> Summer -> Winter)', () => {
  let spring: DescribeSnapshot;
  let summer: DescribeSnapshot;
  let winter: DescribeSnapshot;

  it('snapshots describe per release and diffs it', async () => {
    spring = await snapshotDescribe(clientFor(mock), ['Account', 'Opportunity'], { source: mock.url, release: 'Spring' });
    mock.setRelease('Summer');
    summer = await snapshotDescribe(clientFor(mock), ['account', 'Opportunity'], { release: 'Summer' });
    mock.setRelease('Winter');
    winter = await snapshotDescribe(clientFor(mock), ['Account', 'Opportunity'], { release: 'Winter' });
    mock.setRelease('Spring');
    spring = JSON.parse(JSON.stringify(spring)) as DescribeSnapshot; // snapshots are files in CI
    expect(Object.keys(spring.objects)).toEqual(['Account', 'Opportunity']);

    const d = diffDescribe(spring, summer);
    const brief = (k: 'relabeled' | 'added' | 'removed' | 'picklistChanged' | 'requiredChanged' | 'typeChanged') => d[k].map((c) => `${c.object}.${c.field}`);
    expect(d.before.release).toBe('Spring');
    expect(d.after.release).toBe('Summer');
    expect(brief('relabeled')).toEqual(['Account.Phone']);
    expect(d.relabeled[0].detail).toBe('Account.Phone label "Account Phone" became "Main Phone"');
    expect(brief('added')).toEqual(['Account.Region__c']);
    expect(d.added[0].detail).toBe('"Region" (Account.Region__c, picklist, required) was added');
    expect(brief('picklistChanged')).toEqual(['Account.Industry', 'Account.Sub_Industry__c']);
    expect(d.picklistChanged[0]).toMatchObject({ removedValues: ['Banking'], addedValues: ['Financial Services'] });
    expect(brief('removed')).toEqual([]);
    expect(brief('typeChanged')).toEqual([]);
    expect(brief('requiredChanged')).toEqual([]);

    const w = diffDescribe(summer, winter);
    expect(w.changes.map((c) => `${c.object}.${c.field}:${c.change}`)).toEqual(['Opportunity.Amount:relabeled', 'Opportunity.StageName:picklist-changed']);
    expect(w.picklistChanged[0]).toMatchObject({ removedValues: ['Needs Analysis'], addedValues: ['Discovery'] });
    expect(() => diffDescribe({} as DescribeSnapshot, summer)).toThrow(/not a Salesforce describe snapshot/);
  });

  it('lists impacted journeys: relabels, newly required fields on create, removed picklist values', () => {
    const impacted = impactedJourneys(diffDescribe(spring, summer), journeys());
    expect(impacted.map((j) => j.journeyId)).toEqual(['account-banking', 'legacy-phone']);
    const bank = impacted[0];
    expect(bank.reasons.map((r) => [r.stepId, r.field, r.change, r.matchedBy, r.severity])).toEqual([
      ['set-industry-to-banking-on-the-record', 'Industry', 'picklist-value-removed', 'picklist-value', 'breaking'],
      ['set-account-phone-to-555-0100-on-the-record', 'Phone', 'relabeled', 'label', 'breaking'],
      ['verify-in-salesforce-that-account-bank-co-has-industry-banki', 'Industry', 'picklist-value-removed', 'picklist-value', 'breaking'],
      ['create-a-new-account', 'Region__c', 'added', 'creates-record', 'breaking'],
    ]);
    expect(bank.reasons[0].detail).toBe('Account.Industry ("Industry") no longer has the value "Banking"');
    expect(bank.reasons[3].detail).toBe('"Region" is now required on Account; this journey creates a Account without setting it');
    expect(bank.breaking).toBe(4);
    expect(impacted[1].reasons).toEqual([expect.objectContaining({ field: 'Phone', change: 'relabeled', matchedBy: 'label', matched: 'Account Phone', severity: 'breaking' })]);

    const later = impactedJourneys(diffDescribe(summer, winter), journeys());
    expect(later.map((j) => j.journeyId)).toEqual(['opp-pipeline']);
    expect(later[0].reasons.map((r) => [r.stepId, r.field, r.change, r.severity])).toEqual([
      ['set-salesforce-field-stage-to-needs-analysis', 'StageName', 'picklist-value-removed', 'breaking'],
      ['set-salesforce-field-amount-to-100', 'Amount', 'relabeled', 'breaking'],
      ['expect-the-path-stage-to-be-needs-analysis', 'StageName', 'picklist-value-removed', 'breaking'],
    ]);
    expect(() => impactedJourneys(diffDescribe(spring, summer), [])).toThrow(/no journeys/);
  });

  it('a journey that sets the newly required field is only flagged for review on it', () => {
    const j = parseSalesforceEzScript(`Journey: Sets region\nId: sets-region\nCreate a new Account\nSet Salesforce field "Account Name" to "N"\nSet Salesforce field "Region" to "EMEA"\nSave the Salesforce record`);
    expect(impactedJourneys(diffDescribe(spring, summer), [j])).toEqual([]);
  });

  it('after the Summer release the old label fails with a suggestion and the missing required field is surfaced', async () => {
    mock.setRelease('Summer');
    try {
      const old = parseSalesforceEzScript(`Journey: Old label\nId: old-label\nLog in to Salesforce as admin\nCreate a new Account\nSet "Account Phone" to "555-0100" on the record`);
      const noRegion = parseSalesforceEzScript(`Journey: No region\nId: no-region\nLog in to Salesforce as admin\nCreate a new Account\nSet Salesforce field "Account Name" to "Summer Co"\nSave the Salesforce record`);
      const fixed = parseSalesforceEzScript(`
Journey: Summer-ready
Id: summer-ready
Log in to Salesforce as admin
Create a new Account
Set Salesforce field "Account Name" to "Summer Co"
Set Salesforce field "Region" to "EMEA"
Set "Main Phone" to "555-0222" on the record
Set Salesforce field "Industry" to "Financial Services"
Set Salesforce field "Sub-Industry" to "Retail Banking"
Save the Salesforce record
Verify in Salesforce that Account "Summer Co" has Region__c = "EMEA" and "Main Phone" = "555-0222"
`);
      const run = await runSf(mock, [old, noRegion, fixed]);
      expect(run.journeys[0].steps[2].error?.message).toMatch(/^Field "Account Phone" not found on Account\. Did you mean .*"Main Phone"/);
      expect(run.journeys[1].steps.find((s) => s.status === 'failed')?.error?.message).toBe('Save failed: Region: Complete this field.');
      expect(stepLines(run, 2)).toEqual(run.journeys[2].steps.map((s) => `${s.stepId}:passed`));
    } finally {
      mock.setRelease('Spring');
    }
  });

  it('resolves fields offline from a snapshot', async () => {
    const r = new SalesforceFieldResolver(new StaticDescribeSource(summer));
    expect((await r.resolveField('Account', 'Main Phone')).name).toBe('Phone');
    await expect(r.resolveField('Account', 'Account Phone')).rejects.toThrow(/not found on Account/);
    expect(() => new StaticDescribeSource({ schema: 'eztest.salesforce.describe/v1', takenAt: '', objects: {} })).toThrow(/no objects/);
  });
});
