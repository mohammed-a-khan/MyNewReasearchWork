/**
 * Power Apps canvas pack against the Power Apps mock (examples/powerapps-mock,
 * with an embedded Dataverse mock): a real Chromium drives the player frame by
 * control names, galleries and Power Fx assertions; Dataverse cross-checks
 * reuse the D365 add-on; app-version and Dataverse change impact; the sharing
 * and control matrix. The mock emulates documented conventions; it is not
 * Power Apps.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { SecretRegistry } from '../../src/identity/handle.js';
import { createPowerAppsIntegration, evaluatePowerFx, parsePowerAppsEzScript, parsePowerFx, PowerFxError, powerFxNames, type PowerAppsIntegration } from '../../src/apps/powerapps/index.js';
import { startPowerAppsMock, type PowerAppsMockServer } from '../../examples/powerapps-mock/server.js';
import { appSourceYaml } from '../../examples/powerapps-mock/app.js';
import { PACK_SUITE_TIMEOUT_MS, allLines, runPack, stepLines } from './helpers.js';

let mock: PowerAppsMockServer;
let pa: PowerAppsIntegration;

beforeAll(async () => {
  mock = await startPowerAppsMock();
  pa = createPowerAppsIntegration({
    apps: [{ name: 'Account Manager', url: mock.playUrl, appId: mock.appId }],
    users: { maker: mock.users.maker, user: mock.users.user, guest: mock.users.guest },
    dataverse: { url: mock.dataverse.url, tokenUrl: mock.dataverse.tokenUrl, clientId: mock.dataverse.clientId, clientSecret: mock.dataverse.clientSecret, entities: ['account'] },
    api: { url: mock.url, tokenUrl: mock.tokenUrl, clientId: mock.clientId, clientSecret: mock.clientSecret },
    timeoutMs: 8000,
  }, { secrets: new SecretRegistry() });
});
afterAll(async () => {
  await mock?.close();
});

const EDIT = `
Journey: Update Fabrikam in the canvas app
Id: pa-edit
Tags: @powerapps
Log in to Power Apps as maker
Open the Power Apps app "Account Manager"
Expect Power Apps gallery "galAccounts" to have 3 items
Expect Power Apps control "btnDelete" to be disabled
Set Power Apps control "txtSearch" to "Fab"
Expect Power Apps gallery "galAccounts" to have 2 items
Expect Power Fx \`CountRows(galAccounts.AllItems) = 2 && First(galAccounts.AllItems).'Account Name' = "Fabrikam"\`
In Power Apps gallery "galAccounts", select the item where "lblAccountName" is "Fabrikam"
Expect the Power Apps screen to be "EditScreen"
Expect Power Apps control "txtName".Text to be "Fabrikam"
Set Power Apps control "txtPhone" to "555-0199"
Set Power Apps control "ddIndustry" to "Consulting"
Set Power Apps control "tglCreditHold" to "true"
Select Power Apps control "btnSave"
Expect the Power Apps notification to contain "Account saved"
Expect Power Apps property "lblStatus.Text" to be "Saved"
Expect Power Fx 'lblStatus.Text = "Saved" And Len(txtName.Text) > 3 And tglCreditHold.Value'
Verify in Dataverse that account "Fabrikam" has "Main Phone" = "555-0199" and "Industry" = "Consulting" and "Credit Hold" = "Yes"
`;

describe('Power Apps canvas pack against the Power Apps mock (real Chromium)', { timeout: PACK_SUITE_TIMEOUT_MS }, () => {
  it('parses canvas phrasings (control names, galleries, Power Fx) and reuses the Dataverse phrasing', () => {
    const j = parsePowerAppsEzScript(EDIT + 'Select item 2 in Power Apps gallery "galAccounts"\nExpect Power Apps control "btnDelete" to be hidden');
    expect(j.steps.map((s) => s.handler)).toEqual([
      'pa.login', 'pa.openApp', 'pa.expectGallery', 'pa.expectState', 'pa.setControl', 'pa.expectGallery', 'pa.expectPowerFx', 'pa.selectItem', 'pa.expectScreen', 'pa.expectProperty',
      'pa.setControl', 'pa.setControl', 'pa.setControl', 'pa.select', 'pa.expectNotification', 'pa.expectProperty', 'pa.expectPowerFx', 'd365.verifyDataverse', 'pa.selectItem', 'pa.expectState',
    ]);
    expect(j.steps[9].args).toEqual({ control: 'txtName', property: 'Text', value: 'Fabrikam' });
    expect(j.steps[15].args).toEqual({ control: 'lblStatus', property: 'Text', value: 'Saved' });
    expect(j.steps[7].args).toEqual({ gallery: 'galAccounts', where: { control: 'lblAccountName', value: 'Fabrikam' } });
  });

  it('edits a record through the player frame and the app object model; Dataverse agrees', async () => {
    const run = await runPack([parsePowerAppsEzScript(EDIT)], pa.customSteps, mock.url);
    expect(stepLines(run)).toEqual(allLines(run));
    expect((run.journeys[0].ledger.powerapps as Record<string, unknown>).bridge).toBe('object-model');
    const fab = [...mock.dataverse.store.table('account').values()].find((a) => a.name === 'Fabrikam')!;
    expect(fab).toMatchObject({ telephone1: '555-0199', industrycode: 7, creditonhold: true });
  });

  it('creates a record, shows Notify errors, and reports unknown controls and items with what the app has', async () => {
    const create = parsePowerAppsEzScript(`
Journey: New account
Id: pa-new
Log in to Power Apps as maker
Open the Power Apps app "Account Manager"
Select Power Apps control "btnNew"
Select Power Apps control "btnSave"
Expect the Power Apps notification to contain "Account name is required"
Set Power Apps control "txtName" to "Northwind Traders"
Set Power Apps control "txtPhone" to "555-0123"
Select Power Apps control "btnSave"
Expect the Power Apps notification to contain "saved"
Verify in Dataverse that account "Northwind Traders" has "Main Phone" = "555-0123"
Select Power Apps control "btnBack"
Expect Power Apps gallery "galAccounts" to contain "Northwind Traders"
`);
    const typo = parsePowerAppsEzScript(`Journey: Typo\nId: typo\nLog in to Power Apps as maker\nOpen the Power Apps app "Account Manager"\nSet Power Apps control "txtSerch" to "x"`);
    const item = parsePowerAppsEzScript(`Journey: Item\nId: item\nLog in to Power Apps as maker\nOpen the Power Apps app "Account Manager"\nSelect Power Apps control "btnNew"\nSet Power Apps control "ddIndustry" to "Aerospace"`);
    const fx = parsePowerAppsEzScript(`Journey: Fx\nId: fx\nLog in to Power Apps as maker\nOpen the Power Apps app "Account Manager"\nExpect Power Fx \`CountRows(galAccounts.AllItems) = 99\``);
    const guest = parsePowerAppsEzScript(`Journey: Guest\nId: guest\nLog in to Power Apps as guest\nOpen the Power Apps app "Account Manager"`);
    const run = await runPack([create, typo, item, fx, guest], pa.customSteps, mock.url);
    expect(stepLines(run)).toEqual(allLines(run));
    const err = (i: number) => run.journeys[i].steps.find((s) => s.status === 'failed')?.error?.message;
    expect(err(1)).toBe('No Power Apps control "txtSerch" on the screen BrowseScreen (controls: lblTitle, txtSearch, galAccounts, btnNew, btnDelete)');
    expect(err(2)).toMatch(/^Power Apps dropdown "ddIndustry" has no item "Aerospace" \(items: Accounting, /);
    expect(err(3)).toBe('Power Fx CountRows(galAccounts.AllItems) = 99 is false, expected true');
    expect(err(4)).toBe("Power Apps: Sorry, you don't have access to this app Ask the app owner to share it with you.");
  });

  it('lists the journeys an app version and a Dataverse release wave break', async () => {
    const dvBefore = await pa.dataverseSnapshot();
    mock.dataverse.setReleaseWave(true);
    let dvAfter;
    try {
      pa.dataverse!.clearCache();
      dvAfter = await pa.dataverseSnapshot();
    } finally {
      mock.dataverse.setReleaseWave(false);
      pa.dataverse!.clearCache();
    }
    const changes = pa.changes({ beforeSource: appSourceYaml(1), afterSource: appSourceYaml(2), dataverseBefore: dvBefore, dataverseAfter: dvAfter });
    const kinds = changes.map((c) => `${c.kind}:${c.field}`);
    expect(kinds).toEqual(expect.arrayContaining(['field-relabeled:txtName', 'field-removed:ddIndustry', 'field-removed:tglCreditHold', 'field-added:cmbIndustry', 'ui-changed:btnSave', 'logic-changed:lblPhone']));
    expect(changes.find((c) => c.field === 'ddIndustry')?.detail).toContain('cmbIndustry (ComboBox) looks like its replacement');
    expect(changes.some((c) => c.kind === 'logic-changed' && c.field === 'btnSave' && c.severity === 'breaking' && /Account Number/.test(c.detail))).toBe(true);
    const report = pa.impact(changes, [parsePowerAppsEzScript(EDIT), parsePowerAppsEzScript('Journey: Browse only\nId: browse\nLog in to Power Apps as user\nOpen the Power Apps app "Account Manager"\nExpect Power Apps gallery "galAccounts" to have 3 items')]);
    const edit = report.impacted.find((j) => j.journeyId === 'pa-edit')!;
    expect(edit.reasons.map((r) => `${r.severity}:${r.change}:${r.matched}`)).toEqual(expect.arrayContaining([
      'breaking:field-relabeled:txtName', 'breaking:field-removed:ddIndustry', 'breaking:field-removed:tglCreditHold', 'breaking:logic-changed:btnSave', 'review:logic-changed:txtPhone', 'breaking:field-relabeled:Main Phone',
    ]));
    expect(report.impacted.find((j) => j.journeyId === 'browse')?.breaking ?? 0).toBe(0);
    const snap = pa.snapshot({ source: appSourceYaml(1), release: 'v1' });
    expect(snap.objects['app:Account Manager'].fields.find((f) => f.name === 'btnSave')).toMatchObject({ type: 'Button', label: 'Save' });
  });

  it('checks app sharing (permissions API and the player) and control visibility per user', async () => {
    const browser: Browser = await chromium.launch();
    try {
      const pages: Record<string, Page> = {};
      for (const r of ['maker', 'user', 'guest']) pages[r] = await (await browser.newContext()).newPage();
      const report = await pa.permissionMatrix([
        { app: 'Account Manager', expect: { maker: 'owner', user: 'can-view', guest: 'none' } },
        { control: 'btnDelete', expect: { maker: 'disabled', user: 'hidden' } },
      ], { pages });
      expect(report.violations).toEqual([]);
      expect(report.results.find((r) => r.user === 'guest')).toMatchObject({ api: 'none', ui: 'none' });
      const bad = await pa.permissionMatrix([{ app: 'Account Manager', expect: { user: 'can-edit' } }]);
      expect(bad.violations.map((v) => `${v.user}:${v.api}`)).toEqual(['user:can-view']);
    } finally {
      await browser.close();
    }
  });

  it('evaluates a Power Fx subset deterministically, with no JavaScript evaluation', () => {
    const scope = { galAccounts: { AllItems: [{ 'Account Name': 'A' }, { 'Account Name': 'B' }], Selected: { 'Account Name': 'B' } }, lbl: { Text: 'Saved', Visible: true }, btn: { DisplayMode: 'Disabled' } };
    expect(evaluatePowerFx('CountRows(galAccounts.AllItems) = 2', scope)).toBe(true);
    expect(evaluatePowerFx("galAccounts.Selected.'Account Name' & \"!\"", scope)).toBe('B!');
    expect(evaluatePowerFx('btn.DisplayMode = DisplayMode.Disabled', scope)).toBe(true);
    expect(evaluatePowerFx('If(lbl.Visible, Len(lbl.Text), 0) * 2', scope)).toBe(10);
    expect(evaluatePowerFx('Not(IsBlank(lbl.Text)) || false', scope)).toBe(true);
    expect(powerFxNames('CountRows(galAccounts.AllItems) > 0 && lbl.Text = "x"')).toEqual(['galAccounts', 'lbl']);
    expect(() => evaluatePowerFx('constructor.constructor("return 1")()', scope)).toThrow(PowerFxError);
    expect(() => evaluatePowerFx('Patch(Accounts, lbl)', { Accounts: {}, lbl: {} })).toThrow(/not supported/);
    expect(() => parsePowerFx('1 +')).toThrow(PowerFxError);
  });
});
