import { describe, expect, it } from '../support/testkit.js';
import { parseIntent, parseEzScript, IntentParseError } from '../../src/intent/index.js';
import {
  SALESFORCE_INTENT_RULES, SalesforceFieldResolver, StaticDescribeSource, controlFor, createSalesforceIntentRules, fieldLocatorCandidates, normalizeAccess,
  parseDescribe, parseSalesforceEzScript, salesforceEquals, valuesEqual, toIsoDate, type DescribeSnapshot, type ResolvedSfField,
} from '../../src/salesforce/index.js';
import { registerIntentRules } from '../../src/intent/index.js';

const f = (name: string, label: string, type: string, extra: Record<string, unknown> = {}) => ({ name, label, type, nillable: true, createable: true, updateable: true, ...extra });

const opportunity = parseDescribe({
  name: 'Opportunity', label: 'Opportunity', labelPlural: 'Opportunities', keyPrefix: '006', createable: true, updateable: true, deletable: true, queryable: true,
  fields: [
    f('Id', 'Opportunity ID', 'id', { nillable: false, createable: false, updateable: false, defaultedOnCreate: true }),
    f('Name', 'Opportunity Name', 'string', { nillable: false, nameField: true }),
    f('AccountId', 'Account Name', 'reference', { referenceTo: ['Account'], relationshipName: 'Account' }),
    f('Account_Name__c', 'Account Name', 'string', { custom: true }),
    f('StageName', 'Stage', 'picklist', { nillable: false, picklistValues: [{ value: 'Prospecting', label: 'Prospecting', active: true }, { value: 'Closed Won', label: 'Won', active: true }] }),
    f('Amount', 'Amount', 'currency'),
    f('Probability', 'Probability (%)', 'percent'),
    f('CloseDate', 'Close Date', 'date', { nillable: false }),
    f('IsPrivate', 'Private', 'boolean', { nillable: false, defaultedOnCreate: true }),
    f('Description', 'Description', 'textarea'),
    f('LastActivityDate', 'Last Activity', 'date', { createable: false, updateable: false }),
    f('Geo__c', 'Geo', 'location', { custom: true }),
  ],
});
const account = parseDescribe({ name: 'Account', label: 'Account', labelPlural: 'Accounts', fields: [f('Id', 'Account ID', 'id'), f('Name', 'Account Name', 'string', { nameField: true })] });
const snapshot: DescribeSnapshot = { schema: 'eztest.salesforce.describe/v1', takenAt: '2026-10-01T00:00:00Z', objects: { Opportunity: opportunity, Account: account } };
const resolver = new SalesforceFieldResolver(new StaticDescribeSource(snapshot));

describe('SalesforceFieldResolver', () => {
  it('resolves objects by API name, label and plural label, strictly', async () => {
    expect((await resolver.resolveObject('opportunities')).name).toBe('Opportunity');
    expect((await resolver.resolveObject('Account')).name).toBe('Account');
    await expect(resolver.resolveObject('Oportunity')).rejects.toThrow('Unknown or inaccessible sObject "Oportunity". Did you mean "Opportunity"?');
    await expect(resolver.resolveObject('  ')).rejects.toThrow(/Empty sObject name/);
  });

  it('maps labels <-> API names, prefers API names, refuses ambiguous labels and suggests on typos', async () => {
    expect(await resolver.apiNameOf('Opportunity', 'stage')).toBe('StageName');
    expect(await resolver.apiNameOf('Opportunity', 'Close Date *')).toBe('CloseDate'); // required marker ignored
    expect(await resolver.apiNameOf('Opportunity', 'accountid')).toBe('AccountId');
    expect(await resolver.labelOf('Opportunity', 'AccountId')).toBe('Account Name');
    await expect(resolver.resolveField('Opportunity', 'Account Name')).rejects.toThrow(
      'Field label "Account Name" is ambiguous on Opportunity: AccountId, Account_Name__c. Use the API name instead.',
    );
    await expect(resolver.resolveField('Opportunity', 'Clos Date')).rejects.toThrow('Field "Clos Date" not found on Opportunity. Did you mean "Close Date"?');
    await expect(resolver.resolveField('Opportunity', 'Zebra')).rejects.toThrow(/^Field "Zebra" not found on Opportunity$/);
  });

  it('derives required-ness from describe (nillable, defaulted, calculated)', () => {
    const by = Object.fromEntries(opportunity.fields.map((x) => [x.name, x.required]));
    expect(by).toMatchObject({ Id: false, Name: true, StageName: true, CloseDate: true, IsPrivate: false, Amount: false });
  });

  it('builds Lightning locator candidates per control type: API-name layout item, label item, accessible label', async () => {
    const stage = await resolver.resolveField('Opportunity', 'Stage');
    expect(stage.control).toBe('picklist');
    expect(stage.candidates).toEqual([
      { strategy: 'css', value: 'records-record-layout-item[data-target-selection-name="sfdc:RecordField.Opportunity.StageName"] lightning-combobox button[role="combobox"]' },
      { strategy: 'css', value: 'records-record-layout-item[field-label="Stage"] lightning-combobox button[role="combobox"]' },
      { strategy: 'label', value: 'Stage', exact: true },
    ]);
    expect((await resolver.resolveField('Opportunity', 'AccountId')).candidates[0].value).toMatch(/lightning-grouped-combobox input\[role="combobox"\]$/);
    expect((await resolver.resolveField('Opportunity', 'Description')).candidates[0].value).toMatch(/lightning-textarea textarea$/);
    expect((await resolver.resolveField('Opportunity', 'Amount')).candidates[0].value).toMatch(/lightning-input input:not\(\[type="checkbox"\]\)$/);
    const priv = await resolver.resolveField('Opportunity', 'Private');
    expect(priv.candidates.map((c) => c.value)).toEqual([
      'records-record-layout-item[data-target-selection-name="sfdc:RecordField.Opportunity.IsPrivate"] lightning-input input[type="checkbox"]',
      'records-record-layout-item[field-label="Private"] lightning-input input[type="checkbox"]',
    ]);
    expect(priv.outputs[0].value).toBe('records-record-layout-item[data-target-selection-name="sfdc:RecordField.Opportunity.IsPrivate"] .test-id__field-value');
    expect(fieldLocatorCandidates('Account', 'Na"me', 'text', 'A"B')[0].value).toContain('sfdc:RecordField.Account.Na\\"me');
    expect((await resolver.resolveField('Opportunity', 'Geo')).control).toBe('unsupported');
    expect([controlFor('phone'), controlFor('double'), controlFor('boolean'), controlFor('reference'), controlFor('multipicklist')]).toEqual(['text', 'number', 'checkbox', 'lookup', 'unsupported']);
  });

  it('compares displayed and expected values by field type', async () => {
    const field = async (n: string) => resolver.resolveField('Opportunity', n);
    const amount = await field('Amount');
    expect(valuesEqual(amount, '$1,250,000.00', '1250000')).toBe(true);
    expect(valuesEqual(amount, '$1,250,000.00', '1250001')).toBe(false);
    const close = await field('Close Date');
    expect(valuesEqual(close, '9/30/2030', '2030-09-30')).toBe(true);
    expect(valuesEqual(close, '30/9/2030', '2030-09-30', 'd/M/yyyy')).toBe(true);
    expect(valuesEqual(close, 'Sep 30, 2030', '2030-09-30')).toBe(true);
    const stage: ResolvedSfField = await field('Stage');
    expect(valuesEqual(stage, 'Won', 'Closed Won')).toBe(true); // API value vs label
    expect(valuesEqual(await field('Private'), 'true', 'Yes')).toBe(true);
    expect(valuesEqual(await field('Description'), 'a  b', 'a b')).toBe(true);
    expect(valuesEqual(await field('Description'), 'a', '')).toBe(false);
    expect(toIsoDate('not a date')).toBeUndefined();
    expect(salesforceEquals(stage.field, 'Closed Won', 'Won')).toBe(true);
    expect(salesforceEquals(amount.field, 50000, '$50,000')).toBe(true);
    expect(salesforceEquals((await field('AccountId')).field, '0015g000000AAAAAAA', 'Acme', 'Acme')).toBe(true);
    expect(salesforceEquals((await field('AccountId')).field, null, 'Acme')).toBe(false);
    expect(normalizeAccess('Read Only')).toBe('read-only');
    expect(() => normalizeAccess('maybe')).toThrow(/Unknown field access/);
  });
});

describe('Salesforce intent rules', () => {
  const parse = (line: string) => {
    const off = registerIntentRules(SALESFORCE_INTENT_RULES);
    try {
      const s = parseIntent(line);
      return { handler: s.handler, args: s.args };
    } finally {
      off();
    }
  };

  it('turns every documented phrasing into an sf.* step with the right arguments', () => {
    expect(parse('Log in to Salesforce as rep')).toEqual({ handler: 'sf.login', args: { role: 'rep' } });
    expect(parse('Then I sign in to Salesforce as "sales manager"')).toEqual({ handler: 'sf.login', args: { role: 'sales manager' } });
    expect(parse('Open the Accounts tab')).toEqual({ handler: 'sf.openTab', args: { tab: 'Accounts' } });
    expect(parse('Open the Salesforce Invoice__c tab')).toEqual({ handler: 'sf.openTab', args: { tab: 'Invoice__c' } });
    expect(parse('Open the Account "Acme"')).toEqual({ handler: 'sf.openRecord', args: { object: 'Account', name: 'Acme' } });
    expect(parse('Create a new Opportunity')).toEqual({ handler: 'sf.newRecord', args: { object: 'Opportunity' } });
    expect(parse('Set Salesforce field "Account Name" to "Acme"')).toEqual({ handler: 'sf.setField', args: { field: 'Account Name', value: 'Acme' } });
    expect(parse('Set "Stage" to "Prospecting" on the record')).toEqual({ handler: 'sf.setField', args: { field: 'Stage', value: 'Prospecting' } });
    expect(parse('Set lookup "Account Name" to "Acme"')).toEqual({ handler: 'sf.setField', args: { field: 'Account Name', value: 'Acme', kind: 'lookup' } });
    expect(parse('Save the Salesforce record')).toEqual({ handler: 'sf.save', args: {} });
    expect(parse('Save the Salesforce record and expect the error "Close Date"')).toEqual({ handler: 'sf.save', args: { expectError: 'Close Date' } });
    expect(parse('Cancel the Salesforce record')).toEqual({ handler: 'sf.cancel', args: {} });
    expect(parse('Expect the toast to contain "was created"')).toEqual({ handler: 'sf.expectToast', args: { text: 'was created' } });
    expect(parse('Expect Salesforce field "Stage" to be "Prospecting"')).toEqual({ handler: 'sf.expectField', args: { field: 'Stage', value: 'Prospecting' } });
    expect(parse('Mark the stage as complete')).toEqual({ handler: 'sf.markStageComplete', args: {} });
    expect(parse('Expect the path stage to be "Qualification"')).toEqual({ handler: 'sf.expectPathStage', args: { stage: 'Qualification' } });
    expect(parse('Expect the related list "Contacts" to contain "Jane Doe"')).toEqual({ handler: 'sf.expectRelatedList', args: { list: 'Contacts', value: 'Jane Doe' } });
    expect(parse('Expect the Accounts list view to contain "Acme"')).toEqual({ handler: 'sf.expectListView', args: { object: 'Accounts', value: 'Acme' } });
    expect(parse('Verify in Salesforce that Account "Acme" has Industry = "Energy" and "Annual Revenue" is 5000')).toEqual({
      handler: 'sf.verifySoql', args: { object: 'Account', name: 'Acme', expect: { Industry: 'Energy', 'Annual Revenue': '5000' } },
    });
    expect(parse('Expect field "Annual Revenue" to be read-only')).toEqual({ handler: 'sf.expectFieldAccess', args: { field: 'Annual Revenue', access: 'read-only' } });
    expect(parse('Expect Salesforce field "Employees" to be hidden')).toEqual({ handler: 'sf.expectFieldAccess', args: { field: 'Employees', access: 'hidden' } });
    expect(parse('Expect the Cases tab to be hidden')).toEqual({ handler: 'sf.expectTab', args: { tab: 'Cases', visible: false } });
    expect(parse('Verify the Contacts tab is visible')).toEqual({ handler: 'sf.expectTab', args: { tab: 'Contacts', visible: true } });
  });

  it('does not hijack ordinary web lines', () => {
    const off = registerIntentRules(SALESFORCE_INTENT_RULES);
    try {
      expect(parseIntent('Open the Widgets tab').action).toBe('click'); // not a known object
      expect(parseIntent('Expect field "Email" to be hidden').handler).toBeUndefined(); // generic web assertion
      expect(parseIntent('Set the Quantity field to 2').action).toBe('fill');
      expect(() => parseIntent('Verify in Salesforce that Account "Acme" has nonsense')).toThrow(IntentParseError);
    } finally {
      off();
    }
    // Unregistered: the core grammar does not produce Salesforce steps.
    expect(parseIntent('Mark the stage as complete').handler).toBeUndefined();
    expect(() => parseIntent('Verify in Salesforce that Account "Acme" has Industry = "Energy"')).toThrow(IntentParseError);
  });

  it('recognises extra (custom) object labels and keeps Expect lines as standalone steps in .ez scripts', () => {
    const rules = createSalesforceIntentRules({ objects: ['Invoice'] });
    const j = parseSalesforceEzScript(`Journey: Invoices\nOpen the Invoices tab\nExpect the Invoices list view to contain "INV-1"`, {}, rules);
    expect(j.steps.map((s) => [s.handler, s.args])).toEqual([['sf.openTab', { tab: 'Invoices' }], ['sf.expectListView', { object: 'Invoices', value: 'INV-1' }]]);
    // Without registration the same lines are plain web steps.
    expect(parseEzScript('Journey: x\nOpen the Invoices tab').steps[0].action).toBe('click');
  });
});
