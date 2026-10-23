import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { access } from 'node:fs/promises';
import { chromium, type Browser } from '../../src/browser/index.js';
import { loginWithPassword, parseSalesforceEzScript, runPermissionMatrix, type PermissionCheck } from '../../src/salesforce/index.js';
import { startSalesforceMock, type SalesforceMockServer } from '../../examples/salesforce-mock/server.js';
import { clientFor, runSf, stepLines, tempDir } from './fixtures.js';

let mock: SalesforceMockServer;
beforeAll(async () => {
  mock = await startSalesforceMock();
});
afterAll(async () => {
  await mock?.close();
});

describe('rep user in the Lightning UI', () => {
  it('sees Annual Revenue read-only, Employees hidden, no Cases tab, Contacts only via the App Launcher', async () => {
    const j = parseSalesforceEzScript(`
Journey: Rep permissions
Id: rep-permissions
Log in to Salesforce as rep
Open the Account "Globex"
Expect field "Annual Revenue" to be read-only
Expect Salesforce field "Employees" to be hidden
Expect field "Account Phone" to be editable
Expect the Cases tab to be hidden
Expect the Contacts tab to be visible
Open the Contacts tab
Expect the Contacts list view to contain "Jane Doe"
Open the Account "Globex"
Set "Account Phone" to "555-0199" on the record
Expect field "Annual Revenue" to be read-only
Save the Salesforce record
Expect Salesforce field "Account Phone" to be "555-0199"
`);
    const run = await runSf(mock, [j]);
    expect(stepLines(run)).toEqual(run.journeys[0].steps.map((s) => `${s.stepId}:passed`));
    const sf = run.journeys[0].ledger.salesforce as Record<string, any>;
    // UI and describe-as-rep agree.
    expect(sf.access).toEqual({
      'Account.AnnualRevenue': { ui: 'read-only', api: 'read-only' },
      'Account.NumberOfEmployees': { ui: 'hidden', api: 'hidden' },
      'Account.Phone': { ui: 'editable', api: 'editable' },
    });
    const tabStep = run.journeys[0].steps.find((s) => s.stepId === 'open-the-contacts-tab')!;
    expect(tabStep.status).toBe('passed');
    // Contacts is not in the rep's navigation bar: the tab was reached through the App Launcher.
    expect(sf.listView).toMatchObject({ object: 'Contact', name: 'Recently Viewed', matched: [expect.stringMatching(/^003/)] });
  });

  it('fails with what the rep actually gets: hidden tab, read-only field, wrong access expectation', async () => {
    const cases = parseSalesforceEzScript(`Journey: Rep cases\nId: rep-cases\nLog in to Salesforce as rep\nOpen the Cases tab`);
    const revenue = parseSalesforceEzScript(`Journey: Rep revenue\nId: rep-revenue\nLog in to Salesforce as rep\nCreate a new Account\nSet Salesforce field "Annual Revenue" to "10"`);
    const wrong = parseSalesforceEzScript(`Journey: Wrong access\nId: wrong-access\nLog in to Salesforce as rep\nOpen the Account "Globex"\nExpect field "Annual Revenue" to be editable`);
    const tab = parseSalesforceEzScript(`Journey: Wrong tab\nId: wrong-tab\nLog in to Salesforce as admin\nExpect the Cases tab to be hidden`);
    const run = await runSf(mock, [cases, revenue, wrong, tab]);
    const err = (i: number) => run.journeys[i].steps.find((s) => s.status === 'failed')?.error?.message;
    expect(err(0)).toBe('The "Cases" tab is not available to this user (not in the navigation bar or the App Launcher)');
    expect(err(1)).toBe('Salesforce field "Annual Revenue" (AnnualRevenue) is read-only for this user (no editable control on the layout)');
    expect(err(2)).toBe('Salesforce field "Annual Revenue" (Account.AnnualRevenue) should be editable, but the page shows it as read-only and describe as rep@ez.test says read-only');
    expect(err(3)).toBe('The "Cases" tab should be hidden but it is visible (navigation bar)');
    // The rep cannot reach Cases by URL either.
    const direct = parseSalesforceEzScript(`Journey: Direct\nId: direct\nLog in to Salesforce as rep\nOpen the Salesforce Case tab`);
    const run2 = await runSf(mock, [direct]);
    expect(run2.journeys[0].steps[1].error?.message).toBe('The "Cases" tab is not available to this user (not in the navigation bar or the App Launcher)');
  });
});

const CHECKS: PermissionCheck[] = [
  { object: 'Account', field: 'Annual Revenue', expect: 'edit', users: ['admin'] },
  { object: 'Account', field: 'AnnualRevenue', expect: 'read', users: ['rep'] },
  { object: 'Account', field: 'Employees', expect: 'hidden', users: ['rep'] },
  { object: 'Account', field: 'Phone', expect: 'edit' },
  { object: 'Case', tab: 'Cases', expect: 'hidden', users: ['rep'] },
  { object: 'Case', tab: 'Cases', expect: 'visible', users: ['admin'] },
  { object: 'Case', expect: 'hidden', users: ['rep'] },
  // Deliberately wrong: the rep can NOT edit Annual Revenue.
  { object: 'Account', field: 'Annual Revenue', expect: 'edit', users: ['rep'] },
];

describe('runPermissionMatrix', () => {
  it('checks every user x check via describe-as-user and the tabs resource; flags the wrong expectation with evidence', async () => {
    const report = await runPermissionMatrix({ users: { admin: clientFor(mock, 'admin'), rep: clientFor(mock, 'rep') }, checks: CHECKS });
    expect(report.results.map((r) => `${r.user} ${r.subject} ${r.expected}/${r.api} ${r.passed ? 'ok' : 'VIOLATION'}`)).toEqual([
      'admin Account.AnnualRevenue edit/edit ok',
      'rep Account.AnnualRevenue read/read ok',
      'rep Account.NumberOfEmployees hidden/hidden ok',
      'admin Account.Phone edit/edit ok',
      'rep Account.Phone edit/edit ok',
      'rep tab:Cases hidden/hidden ok',
      'admin tab:Cases visible/visible ok',
      'rep object:Case hidden/hidden ok',
      'rep Account.AnnualRevenue edit/read VIOLATION',
    ]);
    expect(report.passed).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].evidence).toEqual({
      source: 'describe',
      field: { name: 'AnnualRevenue', label: 'Annual Revenue', type: 'currency', createable: false, updateable: false },
    });
    expect(report.results[5].evidence.tabs).toEqual(['Accounts', 'Contacts', 'Opportunities']);
    expect(JSON.stringify(report)).not.toContain(mock.users.rep.password);
  });

  it('cross-checks the Lightning UI of each user and screenshots violations', async () => {
    const browser: Browser = await chromium.launch();
    try {
      const pages = { admin: await browser.newPage(), rep: await (await browser.newContext()).newPage() };
      for (const r of ['admin', 'rep'] as const) {
        const res = await loginWithPassword(pages[r], mock.url, mock.users[r].username, mock.users[r].password, 8000);
        expect(res.ok).toBe(true);
      }
      const dir = await tempDir('perm');
      const report = await runPermissionMatrix({ users: { admin: clientFor(mock, 'admin'), rep: clientFor(mock, 'rep') }, checks: CHECKS, ui: { pages, appUrl: mock.url, screenshotDir: dir, timeoutMs: 8000 } });
      expect(report.results.map((r) => `${r.user} ${r.subject} api=${r.api} ui=${r.ui}`)).toEqual([
        'admin Account.AnnualRevenue api=edit ui=edit',
        'rep Account.AnnualRevenue api=read ui=read',
        'rep Account.NumberOfEmployees api=hidden ui=hidden',
        'admin Account.Phone api=edit ui=edit',
        'rep Account.Phone api=edit ui=edit',
        'rep tab:Cases api=hidden ui=hidden',
        'admin tab:Cases api=visible ui=visible',
        'rep object:Case api=hidden ui=hidden',
        'rep Account.AnnualRevenue api=read ui=read',
      ]);
      expect(report.violations.map((v) => v.subject)).toEqual(['Account.AnnualRevenue']);
      const shot = report.violations[0].evidence.screenshot as string;
      await access(shot);
    } finally {
      await browser.close();
    }
  });

  it('refuses empty or malformed input instead of passing', async () => {
    const users = { admin: clientFor(mock, 'admin'), rep: clientFor(mock, 'rep') };
    await expect(runPermissionMatrix({ users: {}, checks: CHECKS })).rejects.toThrow(/no users given/);
    await expect(runPermissionMatrix({ users, checks: [] })).rejects.toThrow(/no checks given/);
    await expect(runPermissionMatrix({ users, checks: [{ object: 'Account', field: 'Phone', expect: 'visible' }] })).rejects.toThrow(/expects "visible" \(use edit \| read \| hidden\)/);
    await expect(runPermissionMatrix({ users, checks: [{ object: 'Case', tab: 'Cases', expect: 'read' }] })).rejects.toThrow(/use visible \| hidden for tabs/);
    await expect(runPermissionMatrix({ users, checks: [{ object: 'Account', field: 'Phone', expect: 'edit', users: ['ceo'] }] })).rejects.toThrow(/unknown user "ceo"/);
    await expect(runPermissionMatrix({ users, checks: [{ object: "Account'", expect: 'edit' }] })).rejects.toThrow(/Invalid check 1 object/);
    // A typo is an error with a suggestion, never a silent "hidden".
    await expect(runPermissionMatrix({ users, checks: [{ object: 'Account', field: 'Anual Revenue', expect: 'hidden' }] })).rejects.toThrow(
      'runPermissionMatrix: field "Anual Revenue" not found on Account for any user. Did you mean "Annual Revenue"?',
    );
  });
});
