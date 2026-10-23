import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import {
  SalesforceMetadataError, SoqlBuildError, StaticDescribeSource, escapeSoqlLike, escapeSoqlString, snapshotDescribe, soql, soqlLiteral, soqlString,
  type DescribeSnapshot,
} from '../../src/salesforce/index.js';
import { parseSoql, SoqlError } from '../../examples/salesforce-mock/soql.js';
import { startSalesforceMock, type SalesforceMockServer } from '../../examples/salesforce-mock/server.js';
import { clientFor } from './fixtures.js';

let mock: SalesforceMockServer;
let snap: DescribeSnapshot;
beforeAll(async () => {
  mock = await startSalesforceMock();
  snap = await snapshotDescribe(clientFor(mock), ['Account', 'Opportunity', 'Contact']);
});
afterAll(async () => {
  await mock?.close();
});

describe('SOQL escaping', () => {
  it('escapes every SOQL string escape and rejects control characters', () => {
    expect(escapeSoqlString("O'Brien")).toBe("O\\'Brien");
    expect(escapeSoqlString('back\\slash')).toBe('back\\\\slash');
    expect(escapeSoqlString('say "hi"\n\t\r')).toBe('say \\"hi\\"\\n\\t\\r');
    expect(soqlString("x' OR Name != '")).toBe("'x\\' OR Name != \\''");
    expect(() => escapeSoqlString('nul\u0000byte')).toThrow(SoqlBuildError);
    expect(escapeSoqlLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });

  it('types literals by field: dates/numbers/booleans unquoted and validated, ids checked', () => {
    expect(soqlLiteral('2026-03-15', { name: 'CloseDate', type: 'date' })).toBe('2026-03-15');
    expect(() => soqlLiteral("2026-03-15' OR Id != '", { name: 'CloseDate', type: 'date' })).toThrow(/is not a date/);
    expect(() => soqlLiteral('2026-02-30', { name: 'CloseDate', type: 'date' })).toThrow(/is not a date/);
    expect(soqlLiteral(new Date('2026-03-15T00:00:00Z'), { name: 'CloseDate', type: 'date' })).toBe('2026-03-15');
    expect(soqlLiteral('1250000', { name: 'AnnualRevenue', type: 'currency' })).toBe('1250000');
    expect(() => soqlLiteral('1 OR Name != null', { name: 'AnnualRevenue', type: 'currency' })).toThrow(/is not a number/);
    expect(() => soqlLiteral(1.5, { name: 'NumberOfEmployees', type: 'int' })).toThrow(/not an integer/);
    expect(soqlLiteral('TRUE', { name: 'Active__c', type: 'boolean' })).toBe('true');
    expect(() => soqlLiteral('yes', { name: 'Active__c', type: 'boolean' })).toThrow(/not a boolean/);
    expect(soqlLiteral('0015g000000ABCDAAA', { name: 'AccountId', type: 'reference' })).toBe("'0015g000000ABCDAAA'");
    expect(() => soqlLiteral("001' OR Name != '", { name: 'AccountId', type: 'reference' })).toThrow(/not a Salesforce id/);
    expect(soqlLiteral(42, { name: 'Name', type: 'string' })).toBe("'42'");
    expect(soqlLiteral(null)).toBe('null');
    expect(() => soqlLiteral(Number.NaN)).toThrow(/non-finite/);
  });
});

describe('soql() builder', () => {
  it('builds SELECT / WHERE (AND, operators, IN, LIKE helpers) / ORDER BY / LIMIT', () => {
    const q = soql('Account')
      .select('Id', 'Name')
      .select(['Owner.Name', 'name']) // duplicates (case-insensitive) are dropped
      .where({ Name: "O'Brien", AnnualRevenue: { gte: 1000, lt: 5000 }, Industry: { in: ['Energy', 'Retail'] }, Phone: { startsWith: '555_%' } })
      .orderBy('Name', 'DESC', 'LAST')
      .limit(5);
    expect(q.toSoql()).toBe(
      "SELECT Id, Name, Owner.Name FROM Account WHERE Name = 'O\\'Brien' AND AnnualRevenue >= 1000 AND AnnualRevenue < 5000 AND Industry IN ('Energy', 'Retail') AND Phone LIKE '555\\_\\%%' ORDER BY Name DESC NULLS LAST LIMIT 5",
    );
    expect(soql('Contact').select('Id').where({ Email: { contains: 'a%b' }, Title: { like: 'C%O' } }).toSoql()).toBe("SELECT Id FROM Contact WHERE Email LIKE '%a\\%b%' AND Title LIKE 'C%O'");
  });

  it('rejects injection through object names, field names, operators and limits', () => {
    expect(() => soql('Account WHERE Name != null')).toThrow(/Invalid sObject name/);
    expect(() => soql("Account'")).toThrow(SalesforceMetadataError);
    expect(() => soql('Account').select('Name FROM User')).toThrow(/Invalid SELECT field/);
    expect(() => soql('Account').select('Id').where({ 'Name = null OR Name': 'x' })).toThrow(/Invalid WHERE field/);
    expect(() => soql('Account').select('Id').where({ Name: { or: 'x' } as never })).toThrow(/Unknown SOQL operator "or"/);
    expect(() => soql('Account').select('Id').where({})).toThrow(/at least one condition/);
    expect(() => soql('Account').select('Id').where({ Name: { in: [] } })).toThrow(/non-empty array/);
    expect(() => soql('Account').select('Id').where({ Name: { gt: null } })).toThrow(/null can only be compared/);
    expect(() => soql('Account').select('Id').orderBy('Name; DELETE')).toThrow(/Invalid ORDER BY field/);
    expect(() => soql('Account').select('Id').limit(0)).toThrow(/Invalid LIMIT/);
    expect(() => soql('Account').toSoql()).toThrow(/at least one SELECT field/);
  });

  it('compile() validates names against describe metadata (with relationships) and types literals by field', async () => {
    const src = new StaticDescribeSource(snap);
    expect(await soql('account').select('id', 'NAME', 'parent.name').where({ industry: 'Energy' }).limit(1).compile(src)).toBe(
      "SELECT Id, Name, Parent.Name FROM Account WHERE Industry = 'Energy' LIMIT 1",
    );
    await expect(soql('Account').select('Id').where({ CloseDate: '2030-01-01' }).compile(src)).rejects.toThrow('No field "CloseDate" on Account');
    expect(await soql('opportunity').select('name', 'account.name').where({ closedate: '2030-09-30', amount: { gt: '1000' }, 'Account.Industry': 'Energy' }).compile(src)).toBe(
      "SELECT Name, Account.Name FROM Opportunity WHERE CloseDate = 2030-09-30 AND Amount > 1000 AND Account.Industry = 'Energy'",
    );
    await expect(soql('Opportunity').select('Name').where({ CloseDate: 'tomorrow' }).compile(src)).rejects.toThrow(/"tomorrow" is not a date \(YYYY-MM-DD\) for CloseDate \(date\)/);
    await expect(soql('Opportunity').select('Owner.Name').compile(src)).rejects.toThrow(/No relationship "Owner" on Opportunity/);
    await expect(soql('Opportunity').select('Name').where({ Amount: { contains: '5' } }).compile(src)).rejects.toThrow(/LIKE is not supported on Amount/);
    await expect(soql('Invoice__c').select('Name').compile(src)).rejects.toThrow(/not in the describe snapshot/);
  });
});

describe('SOQL against the mock REST API (end to end)', () => {
  it("finds O'Brien exactly and treats injection payloads as plain text", async () => {
    const c = clientFor(mock);
    const id = await c.create('Account', { Name: "O'Brien & Sons", Industry: 'Retail' });
    const rows = await c.query(soql('Account').select('Id', 'Name').where({ Name: "O'Brien & Sons" }));
    expect(rows.map((r) => r.Id)).toEqual([id]);
    expect(mock.stats.queries.at(-1)).toBe("SELECT Id, Name FROM Account WHERE Name = 'O\\'Brien & Sons'");
    // Classic injection payloads match nothing (they are a single escaped literal).
    for (const payload of ["x' OR Name != '", "' OR Id != null OR Name = '", "\\' OR Name != \\'", 'Globex\' --']) {
      expect(await c.query(soql('Account').select('Id').where({ Name: payload }))).toEqual([]);
    }
    // Unescaped text that would have widened the query is rejected by the server parser.
    expect(() => parseSoql("SELECT Id FROM Account WHERE Name = 'x' OR Name != 'y'")).toThrow(SoqlError);
    // Names are checked against THIS user's describe before anything is sent.
    const sent = mock.stats.queries.length;
    await expect(c.query(soql('Account').select('Id').where({ Bogus__c: 'x' }))).rejects.toThrow(/No field "Bogus__c" on Account/);
    expect(mock.stats.queries.length).toBe(sent);
    // Raw strings are refused outright.
    await expect(c.query("SELECT Id FROM Account" as never)).rejects.toThrow(/raw SOQL strings are not accepted/);
  });

  it('honours relationships, dates, LIKE wildcards and field-level security in the mock', async () => {
    const admin = clientFor(mock);
    const rows = await admin.query(soql('Opportunity').select('Name', 'Account.Name', 'CloseDate').where({ 'Account.Name': 'Globex', CloseDate: { gt: '2029-12-31' } }));
    expect(rows).toEqual([expect.objectContaining({ Name: 'Globex Renewal', CloseDate: '2030-06-30', Account: expect.objectContaining({ Name: 'Globex' }) })]);
    expect((await admin.query(soql('Account').select('Name').where({ Name: { startsWith: 'Acme' } }).orderBy('Name'))).map((r) => r.Name)).toEqual(['Acme Holdings']);
    // The rep cannot see NumberOfEmployees: the builder refuses before the call, and the server would refuse too.
    const rep = clientFor(mock, 'rep');
    await expect(rep.query(soql('Account').select('NumberOfEmployees'))).rejects.toThrow(/No field "NumberOfEmployees" on Account/);
    await expect(rep.query(soql('Case').select('Subject'))).rejects.toThrow(/sObject "Case" does not exist or is not accessible/);
  });
});
