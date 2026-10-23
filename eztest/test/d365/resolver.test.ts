import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { NotSupportedError } from '../../src/core/index.js';
import { parseEzScript, parseIntent, registerIntentRules } from '../../src/intent/index.js';
import {
  D365_INTENT_RULES, FieldResolver, StaticMetadataSource, assertDrivable, controlTypeFor, createD365IntentRules, dataverseEquals,
  fieldLocatorCandidates, normalizeLabel, parseD365EzScript, parseNumber, parseTwoOption, toIsoDate, type MetadataSnapshot,
} from '../../src/d365/index.js';

const SNAP: MetadataSnapshot = {
  schema: 'eztest.d365.metadata/v1',
  takenAt: '2026-01-01T00:00:00.000Z',
  entities: {
    account: {
      entity: { logicalName: 'account', displayName: 'Account', displayCollectionName: 'Accounts', entitySetName: 'accounts', primaryIdAttribute: 'accountid', primaryNameAttribute: 'name' },
      attributes: [
        { logicalName: 'name', displayName: 'Account Name', attributeType: 'String', requiredLevel: 'ApplicationRequired' },
        { logicalName: 'telephone1', displayName: 'Main Phone', attributeType: 'String', requiredLevel: 'None' },
        { logicalName: 'telephone2', displayName: 'Other Phone', attributeType: 'String', requiredLevel: 'None' },
        { logicalName: 'revenue', displayName: 'Annual Revenue', attributeType: 'Money', requiredLevel: 'None' },
        { logicalName: 'industrycode', displayName: 'Industry', attributeType: 'Picklist', requiredLevel: 'None', options: [{ value: 7, label: 'Consulting' }] },
        { logicalName: 'creditonhold', displayName: 'Credit Hold', attributeType: 'Boolean', requiredLevel: 'None', booleanLabels: { true: 'On hold', false: 'Clear' } },
        { logicalName: 'parentaccountid', displayName: 'Parent Account', attributeType: 'Lookup', requiredLevel: 'None', targets: ['account'] },
        { logicalName: 'lastusedincampaign', displayName: 'Last Campaign', attributeType: 'DateTime', requiredLevel: 'None' },
        { logicalName: 'new_dup1', displayName: 'Region', attributeType: 'String', requiredLevel: 'None' },
        { logicalName: 'new_dup2', displayName: 'region ', attributeType: 'String', requiredLevel: 'None' },
        { logicalName: 'entityimage', displayName: 'Default Image', attributeType: 'Virtual', requiredLevel: 'None' },
        { logicalName: 'accountid', attributeType: 'Uniqueidentifier', requiredLevel: 'SystemRequired' },
      ],
    },
    contact: {
      entity: { logicalName: 'contact', displayName: 'Contact', displayCollectionName: 'Contacts', entitySetName: 'contacts', primaryIdAttribute: 'contactid', primaryNameAttribute: 'fullname' },
      attributes: [{ logicalName: 'fullname', displayName: 'Full Name', attributeType: 'String', requiredLevel: 'None' }],
    },
  },
};

describe('FieldResolver', () => {
  const r = new FieldResolver(new StaticMetadataSource(SNAP));

  it('resolves display labels and logical names both ways', async () => {
    expect(await r.logicalNameOf('account', 'Main Phone')).toBe('telephone1');
    expect(await r.logicalNameOf('account', '  main   phone ')).toBe('telephone1');
    expect(await r.logicalNameOf('account', 'Account Name*')).toBe('name');
    expect(await r.logicalNameOf('account', 'TELEPHONE1')).toBe('telephone1');
    expect(await r.logicalNameOf('account', '_parentaccountid_value')).toBe('parentaccountid');
    expect(await r.labelOf('account', 'revenue')).toBe('Annual Revenue');
    expect(await r.labelOf('account', 'accountid')).toBeUndefined();
  });

  it('resolves entities by logical, display and plural names', async () => {
    expect((await r.resolveEntity('Accounts')).logicalName).toBe('account');
    expect((await r.resolveEntity('contact')).logicalName).toBe('contact');
    expect((await r.resolveEntity('Contact')).logicalName).toBe('contact');
    await expect(r.resolveEntity('Acount')).rejects.toThrow('Unknown entity "Acount". Did you mean "Account", "Accounts"?');
    await expect(r.resolveEntity(' ')).rejects.toThrow(/Empty entity name/);
  });

  it('is strict: ambiguous labels and unknown fields are errors with suggestions', async () => {
    await expect(r.resolveAttribute('account', 'Region')).rejects.toThrow('Field label "Region" is ambiguous on account: new_dup1, new_dup2. Use the logical name instead.');
    await expect(r.resolveAttribute('account', 'Business Phone')).rejects.toThrow('Field "Business Phone" not found on account. Did you mean "Main Phone", "Other Phone"?');
    await expect(r.resolveAttribute('account', 'Zzz')).rejects.toThrow('Field "Zzz" not found on account');
    await expect(r.resolveAttribute('account', '')).rejects.toThrow(/Empty field name/);
    await expect(r.resolveAttribute('lead', 'Topic')).rejects.toThrow(/not in the metadata snapshot/);
  });

  it('maps attribute types to UCI controls and locator candidates', async () => {
    expect(['String', 'Picklist', 'Status', 'Money', 'Integer', 'Boolean', 'DateTime', 'Lookup', 'Customer', 'Owner', 'Virtual'].map(controlTypeFor))
      .toEqual(['text', 'optionset', 'optionset', 'money', 'number', 'twooptions', 'date', 'lookup', 'lookup', 'lookup', 'unsupported']);
    const name = await r.resolveField('account', 'Account Name');
    expect(name.candidates[0]).toEqual({ strategy: 'css', value: 'input[data-id="name.fieldControl-text-box-text"]' });
    expect(name.candidates.some((c) => c.value === 'input[data-id="name.fieldControl-phone-text-input"]')).toBe(true);
    expect(name.candidates.at(-1)).toEqual({ strategy: 'label', value: 'Account Name', exact: true });
    expect(name.container).toEqual({ strategy: 'css', value: 'div[data-id="name"]' });
    expect((await r.resolveField('account', 'Industry')).candidates[0].value).toBe('select[data-id="industrycode.fieldControl-option-set-select"]');
    expect((await r.resolveField('account', 'Annual Revenue')).candidates[0].value).toBe('input[data-id="revenue.fieldControl-currency-text-input"]');
    expect((await r.resolveField('account', 'Credit Hold')).candidates[0].value).toBe('input[data-id="creditonhold.fieldControl-checkbox-toggle"]');
    expect((await r.resolveField('account', 'Last Campaign')).candidates[0].value).toBe('input[data-id="lastusedincampaign.fieldControl-date-time-input"]');
    const lk = await r.resolveField('account', 'Parent Account');
    expect(lk.column).toBe('_parentaccountid_value');
    expect(lk.candidates[0].value).toBe('input[data-id="parentaccountid.fieldControl-LookupResultsDropdown_parentaccountid_textInputBox_with_filter_new"]');
    const img = await r.resolveField('account', 'Default Image');
    expect(() => assertDrivable(img)).toThrow(NotSupportedError);
    expect(fieldLocatorCandidates('x"y', 'text')[0].value).toBe('input[data-id="x\\"y.fieldControl-text-box-text"]');
  });

  it('rejects snapshots that are not snapshots or are empty', () => {
    expect(() => new StaticMetadataSource({} as MetadataSnapshot)).toThrow(/Not an EZTest D365 metadata snapshot/);
    expect(() => new StaticMetadataSource({ ...SNAP, entities: {} })).toThrow(/no entities/);
  });
});

describe('value helpers', () => {
  it('parses numbers, dates and two-options', () => {
    expect(parseNumber('$1,250,000.00')).toBe(1250000);
    expect(parseNumber('abc')).toBeUndefined();
    expect(parseNumber('')).toBeUndefined();
    expect(toIsoDate('2026-03-15')).toBe('2026-03-15');
    expect(toIsoDate('3/15/2026')).toBe('2026-03-15');
    expect(toIsoDate('15/3/2026', 'd/M/yyyy')).toBe('2026-03-15');
    expect(toIsoDate('2026-03-15T00:00:00Z')).toBe('2026-03-15');
    expect(toIsoDate('March 15')).toBeUndefined();
    expect(parseTwoOption('On hold', { true: 'On hold', false: 'Clear' })).toBe(true);
    expect(parseTwoOption('no')).toBe(false);
    expect(() => parseTwoOption('maybe', { true: 'Yes', false: 'No' })).toThrow('"maybe" is not a two-option value (expected "Yes" or "No")');
    expect(normalizeLabel(' Main Phone *')).toBe('main phone');
  });

  it('compares Dataverse values with raw, formatted and typed expectations', () => {
    expect(dataverseEquals('Picklist', 7, 'Consulting', 'Consulting')).toBe(true);
    expect(dataverseEquals('Picklist', 7, 'Consulting', '7')).toBe(true);
    expect(dataverseEquals('Picklist', 7, 'Consulting', 'Brokers')).toBe(false);
    expect(dataverseEquals('Money', 1250000, '$1,250,000.00', '1,250,000')).toBe(true);
    expect(dataverseEquals('Boolean', true, 'Yes', 'yes')).toBe(true);
    expect(dataverseEquals('Boolean', false, 'No', 'Yes')).toBe(false);
    expect(dataverseEquals('DateTime', '2026-03-15T00:00:00Z', '3/15/2026', '2026-03-15')).toBe(true);
    expect(dataverseEquals('String', null, undefined, '')).toBe(true);
    expect(dataverseEquals('String', null, undefined, 'x')).toBe(false);
    expect(dataverseEquals('String', 'abc', undefined, 'ABC')).toBe(false);
  });
});

describe('D365 intent rules', () => {
  let off: () => void;
  beforeAll(() => {
    off = registerIntentRules(D365_INTENT_RULES);
  });
  afterAll(() => off());

  const step = (line: string) => {
    const s = parseIntent(line);
    return { handler: s.handler, args: s.args };
  };

  it('parses navigation, field, command and BPF phrasings into d365.* custom steps', () => {
    expect(step('Open the Account form')).toEqual({ handler: 'd365.openForm', args: { entity: 'Account', mode: 'new' } });
    expect(step('Open a new Opportunity')).toEqual({ handler: 'd365.openForm', args: { entity: 'Opportunity', mode: 'new' } });
    expect(step('Open the Accounts view')).toEqual({ handler: 'd365.openView', args: { entity: 'Accounts' } });
    expect(step('Open the D365 "Project Task" form')).toEqual({ handler: 'd365.openForm', args: { entity: 'Project Task', mode: 'new' } });
    expect(step('Open the Account record "Contoso"')).toEqual({ handler: 'd365.openRecord', args: { entity: 'Account', name: 'Contoso' } });
    expect(step('Set D365 field "Account Name" to "Contoso"')).toEqual({ handler: 'd365.setField', args: { field: 'Account Name', value: 'Contoso' } });
    expect(step('Set "Account Name" to "Contoso Ltd. to go" on the form')).toEqual({ handler: 'd365.setField', args: { field: 'Account Name', value: 'Contoso Ltd. to go' } });
    expect(step('Set lookup "Parent Account" to "Fabrikam"')).toEqual({ handler: 'd365.setField', args: { field: 'Parent Account', value: 'Fabrikam', kind: 'lookup' } });
    expect(step('Save the record')).toEqual({ handler: 'd365.save', args: { close: false } });
    expect(step('Then save and close the record')).toEqual({ handler: 'd365.save', args: { close: true } });
    expect(step('Move to the next stage')).toEqual({ handler: 'd365.nextStage', args: {} });
    expect(step('Expect the business process stage to be "Develop"')).toEqual({ handler: 'd365.expectStage', args: { stage: 'Develop' } });
    expect(step('Expect D365 field "Account Name" to be "Contoso"')).toEqual({ handler: 'd365.expectField', args: { field: 'Account Name', value: 'Contoso' } });
    expect(step('Expect the record to be saved')).toEqual({ handler: 'd365.expectSaved', args: {} });
    expect(step('Expect the Accounts view to contain "Contoso"')).toEqual({ handler: 'd365.expectView', args: { entity: 'Accounts', value: 'Contoso' } });
    expect(step('Expect the form notification to contain "Required"')).toEqual({ handler: 'd365.expectNotification', args: { text: 'Required' } });
    expect(step('Verify in Dataverse that account "Contoso" has "telephone1" = "555-0100"'))
      .toEqual({ handler: 'd365.verifyDataverse', args: { entity: 'account', name: 'Contoso', expect: { telephone1: '555-0100' } } });
    expect(step('Verify in Dataverse that account "Contoso" has "Main Phone" = "555-0100", revenue is "10" and "a and b" = "x, y"'))
      .toEqual({ handler: 'd365.verifyDataverse', args: { entity: 'account', name: 'Contoso', expect: { 'Main Phone': '555-0100', revenue: '10', 'a and b': 'x, y' } } });
  });

  it('does not hijack ordinary web phrasings', () => {
    expect(parseIntent('Open the Login form').action).toBe('navigate');
    expect(parseIntent('Set the Quantity field to 2').action).toBe('fill');
    expect(parseIntent('Save the draft as d').action).toBe('capture');
    expect(parseIntent('Verify the page contains "Welcome"').action).toBe('assert');
  });

  it('recognises custom entity names when configured', () => {
    const extra = createD365IntentRules({ entities: ['Project Task'] });
    const undo = registerIntentRules(extra);
    try {
      expect(step('Open a new Project Task')).toEqual({ handler: 'd365.openForm', args: { entity: 'Project Task', mode: 'new' } });
      expect(step('Open the Project Tasks view')).toEqual({ handler: 'd365.openView', args: { entity: 'Project Tasks' } });
    } finally {
      undo();
    }
    registerIntentRules(D365_INTENT_RULES);
  });

  it('parseD365EzScript keeps D365 Expect/Verify lines as steps but plain Expect lines as post-conditions', () => {
    const text = `Journey: Mixed\nOpen the Account form\n  Expect the URL contains "etn=account"\nSave the record\nExpect the record to be saved [id=saved]\nVerify in Dataverse that account "A" has name = "A"\nExpect the record to be saved`;
    const j = parseD365EzScript(text);
    // With the D365 rules registered, the core .ez parser gives the same result (add-on Expect lines are steps).
    expect(parseEzScript(text)).toEqual(j);
    expect(j.steps.map((s) => [s.id, s.handler, s.intent])).toEqual([
      ['open-the-account-form', 'd365.openForm', 'Open the Account form'],
      ['save-the-record', 'd365.save', 'Save the record'],
      ['saved', 'd365.expectSaved', 'Expect the record to be saved'],
      ['verify-in-dataverse-that-account-a-has-name-a', 'd365.verifyDataverse', 'Verify in Dataverse that account "A" has name = "A"'],
      ['expect-the-record-to-be-saved', 'd365.expectSaved', 'Expect the record to be saved'],
    ]);
    expect(j.steps[0].postconditions).toEqual([{ type: 'urlContains', value: 'etn=account' }]);
  });
});
