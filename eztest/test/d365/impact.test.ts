import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { parseEzScript, registerIntentRules } from '../../src/intent/index.js';
import {
  D365_INTENT_RULES, FieldResolver, StaticMetadataSource, diffMetadata, impactedJourneys, parseD365EzScript, snapshotMetadata, type MetadataSnapshot,
} from '../../src/d365/index.js';
import { startD365Mock, type D365MockServer } from '../../examples/d365-mock/server.js';
import { clientFor, runD365, stepLines } from './fixtures.js';

let mock: D365MockServer;
let off: () => void;
beforeAll(async () => {
  mock = await startD365Mock();
  off = registerIntentRules(D365_INTENT_RULES);
});
afterAll(async () => {
  off?.();
  await mock?.close();
});

const journeys = () => [
  parseD365EzScript(`
Journey: Create account with phone
Id: account-phone
Risk: 4
Open the Account form
Set D365 field "Account Name" to "Wave Co"
Set "Main Phone" to "555-0100" on the form
Save the record
Verify in Dataverse that account "Wave Co" has "telephone1" = "555-0100"
`),
  parseD365EzScript(`
Journey: Opportunity pipeline
Id: opp-pipeline
Open a new Opportunity
Set D365 field "Topic" to "Pipeline"
Set lookup "Account" to "Fabrikam"
Save the record
Move to the next stage
`),
  parseEzScript(`
Journey: Legacy fax entry
Id: legacy-fax
Open /main.aspx?pagetype=entityrecord&etn=account
Type "555-0177" into the Fax field
`),
  parseD365EzScript(`
Journey: Account view only
Id: view-only
Expect the Accounts view to contain "Fabrikam"
`),
];

describe('release-wave impact', () => {
  let before: MetadataSnapshot;
  let after: MetadataSnapshot;

  it('snapshots metadata before and after the release wave and diffs it', async () => {
    before = await snapshotMetadata(clientFor(mock), ['account', 'opportunity'], { source: mock.url });
    mock.setReleaseWave(true);
    after = await snapshotMetadata(clientFor(mock), ['Account', 'opportunity']);
    // Round-trips through JSON (snapshots are files in CI).
    before = JSON.parse(JSON.stringify(before)) as MetadataSnapshot;
    expect(Object.keys(before.entities)).toEqual(['account', 'opportunity']);
    expect(before.entities.account.attributes.find((a) => a.logicalName === 'fax')?.displayName).toBe('Fax');

    const diff = diffMetadata(before, after);
    const brief = (k: keyof typeof diff) => (diff[k] as Array<{ entity: string; logicalName: string }>).map((c) => `${c.entity}.${c.logicalName}`);
    expect(brief('relabeled')).toEqual(['account.telephone1']);
    expect(diff.relabeled[0].detail).toBe('account.telephone1 label "Main Phone" became "Business Phone"');
    expect(brief('removed')).toEqual(['account.fax']);
    expect(brief('added')).toEqual(['account.accountratingcode']);
    expect(brief('requiredChanged')).toEqual(['account.accountnumber']);
    expect(brief('typeChanged')).toEqual([]);
    expect(diff.entities).toEqual({ added: [], removed: [] });
    expect(diff.changes.every((c) => c.entity === 'account')).toBe(true);
  });

  it('lists the journeys that reference changed fields, with reasons', () => {
    const diff = diffMetadata(before, after);
    const impacted = impactedJourneys(diff, journeys());
    expect(impacted.map((j) => j.journeyId)).toEqual(['account-phone', 'legacy-fax']);
    const phone = impacted[0];
    expect(phone.reasons.map((r) => [r.stepId, r.logicalName, r.change, r.matchedBy, r.severity])).toEqual([
      ['set-main-phone-to-555-0100-on-the-form', 'telephone1', 'relabeled', 'label', 'breaking'],
      ['verify-in-dataverse-that-account-wave-co-has-telephone1-555', 'telephone1', 'relabeled', 'logical-name', 'review'],
      ['open-the-account-form', 'accountnumber', 'required-changed', 'creates-record', 'breaking'],
    ]);
    expect(phone.reasons[0].matched).toBe('Main Phone');
    expect(phone.breaking).toBe(2);
    const fax = impacted[1];
    expect(fax.reasons).toEqual([expect.objectContaining({ logicalName: 'fax', change: 'removed', matchedBy: 'label', severity: 'breaking', detail: '"Fax" (fax) was removed from account' })]);
    expect(() => impactedJourneys(diff, [])).toThrow(/no journeys/);
  });

  it('a journey that already sets the newly required field is not flagged for it', () => {
    const diff = diffMetadata(before, after);
    const j = parseD365EzScript(`Journey: Sets number\nId: sets-number\nOpen the Account form\nSet D365 field "Account Number" to "A-1"\nSet D365 field "Account Name" to "N"\nSave the record`);
    expect(impactedJourneys(diff, [j])).toEqual([
      expect.objectContaining({ journeyId: 'sets-number', reasons: [expect.objectContaining({ logicalName: 'accountnumber', change: 'required-changed', matchedBy: 'label', severity: 'review' })] }),
    ]);
  });

  it('after the wave the old label fails with a suggestion, and the new label works with the new control data-id', async () => {
    const old = parseD365EzScript(`Journey: Old label\nId: old-label\nOpen the Account form\nSet "Main Phone" to "555-0100" on the form`);
    const neu = parseD365EzScript(`
Journey: New label
Id: new-label
Open the Account form
Set D365 field "Account Name" to "Wave Co 2"
Set D365 field "Account Number" to "W-2"
Set "Business Phone" to "555-0222" on the form
Save the record
Verify in Dataverse that account "Wave Co 2" has "Business Phone" = "555-0222"
`);
    const run = await runD365(mock, [old, neu]);
    expect(run.journeys[0].steps[1].error?.message).toBe('Field "Main Phone" not found on account. Did you mean "Business Phone"?');
    expect(stepLines(run, 1)).toEqual(run.journeys[1].steps.map((s) => `${s.stepId}:passed`));
  });

  it('works offline from a snapshot (StaticMetadataSource) for field resolution', async () => {
    const r = new FieldResolver(new StaticMetadataSource(after));
    const f = await r.resolveField('account', 'Business Phone');
    expect(f.logicalName).toBe('telephone1');
    expect(() => diffMetadata({} as MetadataSnapshot, after)).toThrow(/not a metadata snapshot/);
  });
});
