import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { SecretRegistry } from '../../src/identity/index.js';
import {
  SalesforceApiError, SalesforceAuthError, SalesforceClient, SalesforceMetadataError, createSalesforceIntegration, decodeValidFor, parseSalesforceConfig,
} from '../../src/salesforce/index.js';
import { encodeValidFor } from '../../examples/salesforce-mock/model.js';
import { startSalesforceMock, type SalesforceMockServer } from '../../examples/salesforce-mock/server.js';
import { clientFor, tokenProviderFor } from './fixtures.js';

let mock: SalesforceMockServer;
beforeAll(async () => {
  mock = await startSalesforceMock();
});
afterAll(async () => {
  await mock?.close();
});

async function failure<E = SalesforceApiError>(p: Promise<unknown>): Promise<E> {
  return p.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (e: unknown) => e as E,
  );
}

describe('Salesforce REST mock', () => {
  it('requires a bearer token and serves realistic describe JSON', async () => {
    const anon = await fetch(`${mock.url}/services/data/v61.0/sobjects/Account/describe`);
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual([{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }]);
    const bad = await fetch(mock.tokenUrl, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: mock.clientId, client_secret: mock.clientSecret, username: 'rep@ez.test', password: 'nope' }) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_grant', error_description: 'authentication failure' });
    const token = await tokenProviderFor(mock).getToken();
    const res = await fetch(`${mock.url}/services/data/v61.0/sobjects/Account/describe`, { headers: { authorization: `Bearer ${token}` } });
    const d = (await res.json()) as { fields: Array<Record<string, any>> };
    const name = d.fields.find((f) => f.name === 'Name')!;
    expect(name).toMatchObject({ label: 'Account Name', type: 'string', nillable: false, createable: true, updateable: true, nameField: true, soapType: 'xsd:string' });
    const sub = d.fields.find((f) => f.name === 'Sub_Industry__c')!;
    expect(sub).toMatchObject({ dependentPicklist: true, controllerName: 'Industry', restrictedPicklist: true, custom: true });
    expect(typeof sub.picklistValues[0].validFor).toBe('string');
  });
});

describe('SalesforceTokenProvider', () => {
  it('gets, caches and re-fetches tokens; failures name the user but never the secret or password', async () => {
    const tp = tokenProviderFor(mock, 'rep');
    const t1 = await tp.getToken();
    expect(await tp.getToken()).toBe(t1);
    expect(tp.requests).toBe(1);
    expect(tp.instanceUrl).toBe(mock.url);
    tp.invalidate();
    expect(await tp.getToken()).not.toBe(t1);
    expect(tp.requests).toBe(2);

    const wrong = tokenProviderFor(mock, undefined, 'wrong-client-secret');
    const e = await failure<SalesforceAuthError>(wrong.getToken());
    expect(e).toBeInstanceOf(SalesforceAuthError);
    expect(e.message).toBe('Salesforce token request failed (HTTP 400) invalid_client: invalid client credentials');
    expect(e.message).not.toContain('wrong-client-secret');
  });
});

describe('SalesforceClient', () => {
  it('parses describe (required, FLS, picklists, dependent validFor, references) and caches it', async () => {
    const c = clientFor(mock);
    const before = mock.stats.describeRequests;
    const d = await c.describe('Account');
    expect(d).toMatchObject({ name: 'Account', label: 'Account', labelPlural: 'Accounts', keyPrefix: '001', createable: true, deletable: true });
    const by = Object.fromEntries(d.fields.map((f) => [f.name, f]));
    expect(by.Name).toMatchObject({ required: true, nameField: true, createable: true });
    expect(by.Id).toMatchObject({ type: 'id', required: false, createable: false });
    expect(by.Active__c.required).toBe(false); // boolean: defaulted on create
    expect(by.ParentId).toMatchObject({ type: 'reference', referenceTo: ['Account'], relationshipName: 'Parent' });
    expect(by.Industry.picklistValues!.map((p) => p.value)).toEqual(['Agriculture', 'Banking', 'Energy', 'Retail', 'Technology']);
    expect(by.Sub_Industry__c.picklistValues!.find((p) => p.value === 'Renewables')!.validFor).toEqual(['Energy']);
    expect(by.Sub_Industry__c.picklistValues!.find((p) => p.value === 'Retail Banking')!.validFor).toEqual(['Banking']);
    await c.describe('account');
    expect(mock.stats.describeRequests).toBe(before + 1); // cached (case-insensitive)
    c.clearCache();
    await c.describe('Account');
    expect(mock.stats.describeRequests).toBe(before + 2);
    await expect(c.describe('Nope__c')).rejects.toBeInstanceOf(SalesforceMetadataError);
    await expect(c.describe('Account/../../x')).rejects.toThrow(/Invalid sObject name/);
    expect((await c.describeGlobal()).map((o) => o.name)).toEqual(['Account', 'Contact', 'Opportunity', 'Case']);
  });

  it('describes AS the user: the rep sees AnnualRevenue read-only, no NumberOfEmployees and no Case', async () => {
    const rep = clientFor(mock, 'rep');
    const d = await rep.describe('Account');
    const rev = d.fields.find((f) => f.name === 'AnnualRevenue')!;
    expect(rev).toMatchObject({ createable: false, updateable: false });
    expect(d.fields.some((f) => f.name === 'NumberOfEmployees')).toBe(false);
    expect(d.deletable).toBe(false);
    expect((await rep.describeGlobal()).map((o) => o.name)).toEqual(['Account', 'Contact', 'Opportunity']);
    await expect(rep.describe('Case')).rejects.toThrow(/sObject "Case" does not exist or is not accessible/);
    expect((await rep.tabs()).map((t) => t.label)).toEqual(['Accounts', 'Contacts', 'Opportunities']);
  });

  it('creates, retrieves, updates and deletes records', async () => {
    const c = clientFor(mock);
    const globex = (await c.findByName('Account', 'Globex'))[0];
    const id = await c.create('Contact', { FirstName: 'Ann', LastName: "O'Neil", Email: 'ann@x.test', AccountId: globex.Id });
    expect(id).toMatch(/^003[A-Za-z0-9]{15}$/);
    expect(await c.retrieve('Contact', id, ['Name', 'AccountId'])).toMatchObject({ Name: "Ann O'Neil", AccountId: globex.Id, attributes: { type: 'Contact' } });
    await c.update('Contact', id, { Title: 'VP' });
    expect((await c.retrieve('Contact', id)).Title).toBe('VP');
    await c.delete('Contact', id);
    const gone = await failure(c.retrieve('Contact', id));
    expect(gone).toMatchObject({ status: 404, errorCode: 'NOT_FOUND' });
    await expect(c.retrieve('Contact', "003' OR 1=1")).rejects.toThrow(/Invalid Salesforce record id/);
    await expect(c.create('Contact', {})).rejects.toThrow(/no field values/);
  });

  it('turns Salesforce errors into typed errors (required, FLS, picklist, validation rule) without tokens', async () => {
    const admin = clientFor(mock);
    const e1 = await failure(admin.create('Opportunity', { Name: 'X' }));
    expect(e1).toMatchObject({ status: 400, errorCode: 'REQUIRED_FIELD_MISSING', fields: ['CloseDate', 'StageName'] });
    expect(e1.message).toBe('Salesforce POST sobjects/Opportunity failed (400): REQUIRED_FIELD_MISSING: Required fields are missing: [CloseDate, StageName]');
    const e2 = await failure(admin.create('Opportunity', { Name: 'X', StageName: 'Prospecting', CloseDate: '2020-01-01' }));
    expect(e2).toMatchObject({ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', fields: ['CloseDate'] });
    expect(e2.message).toContain('Close Date must be in the future for open opportunities');
    const e3 = await failure(admin.create('Account', { Name: 'X', Industry: 'Mining' }));
    expect(e3.message).toContain('INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: Industry: bad value for restricted picklist field: Mining');
    const e4 = await failure(admin.create('Account', { Name: 'X', Industry: 'Retail', Sub_Industry__c: 'Software' }));
    expect(e4.message).toContain('Sub-Industry: bad value for restricted picklist field: Software');
    const rep = clientFor(mock, 'rep');
    const e5 = await failure(rep.create('Account', { Name: 'Rep Co', AnnualRevenue: 5 }));
    expect(e5).toMatchObject({ errorCode: 'INVALID_FIELD_FOR_INSERT_UPDATE', fields: ['AnnualRevenue'] });
    const e6 = await failure(rep.create('Account', { Name: 'Rep Co', NumberOfEmployees: 5 }));
    expect(e6.message).toContain("No such column 'NumberOfEmployees' on sobject of type Account");
    const tokens = [await tokenProviderFor(mock).getToken(), await tokenProviderFor(mock, 'rep').getToken()];
    for (const e of [e1, e2, e3, e4, e5, e6]) {
      expect(e).toBeInstanceOf(SalesforceApiError);
      for (const t of tokens) {
        expect(e.message).not.toContain(t);
        expect(JSON.stringify(e.details)).not.toContain(t);
      }
    }
  });

  it('re-authenticates once after the session expires', async () => {
    const tp = tokenProviderFor(mock);
    const c = new SalesforceClient({ instanceUrl: mock.url, tokenProvider: tp, retry: false });
    await c.describeGlobal();
    mock.expireTokens();
    c.clearCache();
    expect((await c.describe('Account')).name).toBe('Account');
    expect(tp.requests).toBe(2);
  });

  it('decodes validFor bitsets exactly as Salesforce encodes them', () => {
    const ctl = Array.from({ length: 11 }, (_, i) => `v${i}`);
    for (const pick of [[], ['v0'], ['v7', 'v8'], ['v1', 'v10'], ctl]) expect(decodeValidFor(encodeValidFor(ctl, pick), ctl)).toEqual(pick);
  });
});

describe('createSalesforceIntegration', () => {
  it('validates the config block', () => {
    const base = { instanceUrl: mock.url, clientId: 'a', clientSecret: 'b', objects: ['Account'] };
    expect(() => parseSalesforceConfig({ ...base, objects: [] })).toThrow(/objects/);
    expect(() => parseSalesforceConfig({ ...base, apiUser: 'ghost' })).toThrow(/apiUser must name one of salesforce.users/);
    expect(() => parseSalesforceConfig({ ...base, apiVersion: '61' })).toThrow(/apiVersion/);
    expect(() => parseSalesforceConfig({ ...base, objects: ["Account' OR"] })).toThrow(/objects/);
    expect(parseSalesforceConfig(base)).toMatchObject({ apiVersion: '61.0', dateFormat: 'M/d/yyyy', users: {} });
  });

  it('wires a client, per-role clients, credentials (secret refs via the registry), intent rules and steps', async () => {
    const registry = new SecretRegistry([{ name: 'vault', get: async (k: string) => ({ 'sf/client': mock.clientSecret, 'sf/rep': mock.users.rep.password, 'sf/admin': mock.users.admin.password } as Record<string, string>)[k] }]);
    const integ = createSalesforceIntegration(
      {
        instanceUrl: mock.url, clientId: mock.clientId, clientSecret: 'secret://vault/sf/client', objects: ['Account', 'Opportunity'],
        users: { rep: { username: 'rep@ez.test', password: 'secret://vault/sf/rep' }, admin: { username: 'admin@ez.test', password: 'secret://vault/sf/admin' } },
      },
      { secrets: registry },
    );
    expect(Object.keys(integ.customSteps)).toContain('sf.verifySoql');
    expect(integ.intentRules.length).toBeGreaterThan(15);
    expect(await integ.client.findByName('Account', 'Globex')).toHaveLength(1);
    expect((await integ.clientFor('rep').describe('Account')).fields.some((f) => f.name === 'NumberOfEmployees')).toBe(false);
    const cred = await integ.credentials('rep');
    expect(cred.username).toBe('rep@ez.test');
    expect(String(cred.password)).toBe('[secret secret://vault/sf/rep]'); // a handle, never the value
    expect(() => integ.clientFor('ghost')).toThrow(/Unknown Salesforce role "ghost"/);
    // The masker knows the resolved secrets.
    expect(registry.masker.mask(`pw=${mock.users.rep.password}`)).not.toContain(mock.users.rep.password);
    const snap = await integ.snapshot({ release: 'Spring' });
    expect(Object.keys(snap.objects)).toEqual(['Account', 'Opportunity']);
    expect(snap.release).toBe('Spring');
    const off = integ.registerIntents();
    off();
  });

  it('can use a configured user as the API user (password flow)', async () => {
    const integ = createSalesforceIntegration({
      instanceUrl: mock.url, clientId: mock.clientId, clientSecret: mock.clientSecret, objects: ['Account'], apiUser: 'rep',
      users: { rep: { username: 'rep@ez.test', password: mock.users.rep.password } },
    });
    expect((await integ.client.describeGlobal()).map((o) => o.name)).not.toContain('Case');
  });
});
