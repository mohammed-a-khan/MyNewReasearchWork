import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { DataverseClient, DataverseError, D365MetadataError, buildFilter, createD365Integration, odataLiteral, parseD365Config } from '../../src/d365/index.js';
import { startD365Mock, type D365MockServer } from '../../examples/d365-mock/server.js';
import { clientFor, tokenProviderFor } from './fixtures.js';

let mock: D365MockServer;
beforeAll(async () => {
  mock = await startD365Mock();
});
afterAll(async () => {
  await mock?.close();
});

describe('Dataverse Web API mock', () => {
  it('rejects requests without a valid bearer token and serves realistic metadata JSON', async () => {
    const anon = await fetch(`${mock.apiUrl}/accounts`);
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as { error: { code: string } }).error.code).toBe('0x80072560');
    const bad = await fetch(mock.tokenUrl, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: mock.clientId, client_secret: 'nope' }) });
    expect(bad.status).toBe(401);
    const tok = (await (await fetch(mock.tokenUrl, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: mock.clientId, client_secret: mock.clientSecret }) })).json()) as { access_token: string };
    const res = await fetch(`${mock.apiUrl}/EntityDefinitions(LogicalName='account')/Attributes?$select=LogicalName,DisplayName,AttributeType,RequiredLevel`, {
      headers: { authorization: `Bearer ${tok.access_token}` },
    });
    const body = (await res.json()) as { value: Array<Record<string, any>> };
    const name = body.value.find((a) => a.LogicalName === 'name')!;
    expect(name.DisplayName.UserLocalizedLabel.Label).toBe('Account Name');
    expect(name.RequiredLevel.Value).toBe('ApplicationRequired');
    expect(name.AttributeType).toBe('String');
    expect(name['@odata.type']).toBe('#Microsoft.Dynamics.CRM.StringAttributeMetadata');
    expect(body.value.find((a) => a.LogicalName === 'accountid')!.DisplayName.UserLocalizedLabel.Label).toBe('Account');
  });
});

/** Await a promise that must reject; returns the error. */
async function failure(p: Promise<unknown>): Promise<DataverseError> {
  return p.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (e: unknown) => e as DataverseError,
  );
}

describe('DataverseClient', () => {
  it('loads entity + attribute metadata with options, booleans and lookup targets, and caches it', async () => {
    const c = clientFor(mock);
    const e = await c.getEntity('account');
    expect(e).toEqual({ logicalName: 'account', displayName: 'Account', displayCollectionName: 'Accounts', entitySetName: 'accounts', primaryIdAttribute: 'accountid', primaryNameAttribute: 'name' });
    const before = mock.stats.metadataRequests;
    const attrs = await c.getAttributes('account');
    const after = mock.stats.metadataRequests;
    expect(after - before).toBe(6);
    const by = Object.fromEntries(attrs.map((a) => [a.logicalName, a]));
    expect(by.telephone1).toMatchObject({ displayName: 'Main Phone', attributeType: 'String', requiredLevel: 'None' });
    expect(by.industrycode.options).toContainEqual({ value: 7, label: 'Consulting' });
    expect(by.creditonhold.booleanLabels).toEqual({ true: 'Yes', false: 'No' });
    expect(by.parentaccountid).toMatchObject({ attributeType: 'Lookup', targets: ['account'] });
    expect(by.name.isPrimaryName).toBe(true);
    await c.getAttributes('account');
    await c.getEntity('account');
    expect(mock.stats.metadataRequests).toBe(after); // cached
    c.clearCache();
    await c.getAttributes('account');
    expect(mock.stats.metadataRequests).toBe(after + 6);
    await expect(c.getEntity('nosuchentity')).rejects.toBeInstanceOf(D365MetadataError);
    await expect(c.getEntity("account') or 1 eq 1")).rejects.toThrow(/Invalid entity logical name/);
  });

  it('creates, retrieves (with formatted values), queries, updates and deletes records', async () => {
    const c = clientFor(mock);
    const fab = (await c.findByName('account', 'Fabrikam'))[0];
    const id = await c.create('account', { name: "O'Brien Ltd", telephone1: '555-0123', revenue: 10.5, industrycode: 7, 'parentaccountid@odata.bind': `/accounts(${String(fab.accountid)})` });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const r = await c.retrieve('account', id, { formatted: true });
    expect(r).toMatchObject({ name: "O'Brien Ltd", revenue: 10.5, industrycode: 7, _parentaccountid_value: fab.accountid });
    expect(r['industrycode@OData.Community.Display.V1.FormattedValue']).toBe('Consulting');
    expect(r['_parentaccountid_value@OData.Community.Display.V1.FormattedValue']).toBe('Fabrikam');
    expect(r['revenue@OData.Community.Display.V1.FormattedValue']).toBe('$10.50');
    const plain = await c.retrieve('account', id, { select: ['name'] });
    expect(Object.keys(plain).filter((k) => !k.startsWith('@'))).toEqual(['accountid', 'name']);

    // Quote escaping in $filter, $select and $top.
    const rows = await c.query('account', { filter: { name: "O'Brien Ltd" }, select: ['name', 'telephone1'] });
    expect(rows).toHaveLength(1);
    expect(rows[0].telephone1).toBe('555-0123');
    expect(await c.query('account', { top: 2 })).toHaveLength(2);
    expect((await c.query('account', { filter: `_parentaccountid_value eq ${String(fab.accountid)}` })).map((x) => x.name)).toContain("O'Brien Ltd");

    await c.update('account', id, { telephone1: '555-0999' });
    expect((await c.retrieve('account', id)).telephone1).toBe('555-0999');
    await c.delete('account', id);
    const gone = await failure(c.retrieve('account', id));
    expect(gone).toBeInstanceOf(DataverseError);
    expect(gone).toMatchObject({ status: 404, dataverseCode: '0x80040217' });
  });

  it('turns Dataverse errors into typed errors and never puts the token in messages', async () => {
    const c = clientFor(mock);
    const e1 = await failure(c.create('account', { nosuchcolumn: 1 }));
    expect(e1).toBeInstanceOf(DataverseError);
    expect(e1.status).toBe(400);
    expect(e1.message).toMatch(/^Dataverse POST accounts failed \(400\): The property 'nosuchcolumn' does not exist/);
    const e2 = await failure(c.create('account', { name: 'X', industrycode: 999 }));
    expect(e2.message).toContain('999 is not a valid value for industrycode');
    const e3 = await failure(c.query('account', { select: ['bogus'] }));
    expect(e3.message).toContain("Could not find a property named 'bogus'");
    await expect(c.create('account', {})).rejects.toThrow(/no column values/);
    await expect(c.retrieve('account', 'not-a-guid')).rejects.toThrow(/Invalid record id/);

    const tp = tokenProviderFor(mock);
    const token = await tp.getToken();
    for (const e of [e1, e2, e3]) {
      expect(e.message).not.toContain(token);
      expect(JSON.stringify(e.details)).not.toContain(token);
    }
    const wrong = new DataverseClient({ url: mock.url, tokenProvider: tokenProviderFor(mock, 'wrong-secret'), retry: false });
    const e4 = await failure(wrong.query('account'));
    expect(e4.message).not.toContain('wrong-secret');
  });

  it('builds OData literals and filters safely', () => {
    expect(odataLiteral("O'Brien")).toBe("'O''Brien'");
    expect(odataLiteral(5)).toBe('5');
    expect(odataLiteral(true)).toBe('true');
    expect(odataLiteral(null)).toBe('null');
    expect(odataLiteral('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
    expect(buildFilter({ name: 'A', statecode: 0 })).toBe("name eq 'A' and statecode eq 0");
    expect(() => buildFilter({})).toThrow(/Empty filter/);
    expect(() => buildFilter({ 'name or 1 eq 1': 'x' })).toThrow(/Invalid filter column/);
  });

  it('wires a d365 config block into a client, intent rules and custom steps', async () => {
    expect(() => parseD365Config({ url: 'https://x.crm.dynamics.com', clientId: 'a', clientSecret: 'b', entities: ['account'] })).toThrow(/tokenUrl or tenantId/);
    expect(() => parseD365Config({ url: 'https://x.crm.dynamics.com', tokenUrl: 'https://t/token', clientId: 'a', clientSecret: 'b', entities: [] })).toThrow(/entities/);
    const integ = createD365Integration({ url: mock.url, tokenUrl: mock.tokenUrl, clientId: mock.clientId, clientSecret: mock.clientSecret, entities: ['account', 'opportunity'] });
    expect(Object.keys(integ.customSteps)).toContain('d365.verifyDataverse');
    expect(integ.intentRules.length).toBeGreaterThan(10);
    expect((await integ.client.findByName('account', 'Fabrikam'))).toHaveLength(1);
    const off = integ.registerIntents();
    off();
  });
});
