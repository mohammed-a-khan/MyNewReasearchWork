/**
 * ServiceNow pack against the ServiceNow mock (examples/servicenow-mock): a
 * real Chromium drives UI16 forms and the Service Portal, the Table API
 * cross-checks, update-set and skipped-upgrade impact, and the ACL matrix.
 * The mock emulates documented ServiceNow conventions; it is not ServiceNow.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { chromium, type Browser } from '../../src/browser/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { SecretRegistry } from '../../src/identity/handle.js';
import { createServiceNowIntegration, parseServiceNowEzScript, serviceNowLogin, snTerm, type ServiceNowIntegration } from '../../src/apps/servicenow/index.js';
import { startServiceNowMock, type ServiceNowMockServer } from '../../examples/servicenow-mock/server.js';
import { PACK_SUITE_TIMEOUT_MS, allLines, runPack, stepLines } from './helpers.js';

let mock: ServiceNowMockServer;
let sn: ServiceNowIntegration;

function integration(m: ServiceNowMockServer): ServiceNowIntegration {
  const secrets = new SecretRegistry();
  return createServiceNowIntegration({
    instanceUrl: m.url,
    auth: { type: 'oauth2', tokenUrl: m.tokenUrl, clientId: m.clientId, clientSecret: m.clientSecret, grant: 'client_credentials' },
    users: {
      admin: { username: m.users.admin.username, password: m.users.admin.password },
      itil: { username: m.users.itil.username, password: m.users.itil.password },
      employee: { username: m.users.employee.username, password: m.users.employee.password },
    },
    tables: ['incident', 'change_request', 'sc_req_item'],
    timeoutMs: 8000,
  }, { secrets });
}

beforeAll(async () => {
  mock = await startServiceNowMock();
  sn = integration(mock);
});
afterAll(async () => {
  await mock?.close();
});

const CREATE = `
Journey: Report a broken printer
Id: sn-create-incident
Tags: @servicenow
Log in to ServiceNow as itil
Create a new ServiceNow incident
Set ServiceNow field "Caller" to "Abel Tuter"
Set ServiceNow field "Short description" to "Printer jams on floor 3"
Set ServiceNow field "Category" to "Hardware"
Set ServiceNow field "Priority" to "2 - High"
Set ServiceNow field "Assignment group" to "Service Desk"
Expect ServiceNow field "Number" to be read-only
Expect ServiceNow field "Caller" to be mandatory
Submit the ServiceNow form
Expect the ServiceNow info message to contain "created"
Expect ServiceNow field "State" to be "New"
Verify in ServiceNow that incident "\${servicenow.number}" has "Short description" = "Printer jams on floor 3" and caller_id = "Abel Tuter" and priority = "2" and category = "Hardware" and "Assignment group" = "Service Desk"
`;

describe('ServiceNow pack against the ServiceNow mock (real Chromium)', { timeout: PACK_SUITE_TIMEOUT_MS }, () => {
  it('parses every phrasing into sn.* steps without hijacking web lines', () => {
    const j = parseServiceNowEzScript(CREATE);
    expect(j.steps.map((s) => s.handler)).toEqual([
      'sn.login', 'sn.newRecord', 'sn.setField', 'sn.setField', 'sn.setField', 'sn.setField', 'sn.setField', 'sn.expectFieldState', 'sn.expectFieldState',
      'sn.uiAction', 'sn.expectMessage', 'sn.expectField', 'sn.verifyRecord',
    ]);
    expect(j.steps[12].args).toMatchObject({ table: 'incident', key: '${servicenow.number}', expect: { 'Short description': 'Printer jams on floor 3', priority: '2' } });
    const more = parseServiceNowEzScript(`Journey: x
Open the ServiceNow incident list
Open the ServiceNow change request "CHG0010001"
Click the ServiceNow UI action "Resolve" and expect the error "mandatory"
Update the ServiceNow record
Expect the ServiceNow related list "Task SLAs" to contain "Priority 3"
Expect the ServiceNow UI action "Resolve" to be hidden
Expect the ServiceNow incident list to contain "VPN"
Open the ServiceNow catalog item "Standard Laptop"
Set ServiceNow variable "Model" to "Dell XPS 13"
Order the ServiceNow catalog item
Expect the ServiceNow error message to contain "Invalid"`);
    expect(more.steps.map((s) => s.handler)).toEqual(['sn.openList', 'sn.openRecord', 'sn.uiAction', 'sn.uiAction', 'sn.expectRelatedList', 'sn.expectUiAction', 'sn.expectList', 'sn.openCatalogItem', 'sn.setField', 'sn.orderCatalogItem', 'sn.expectMessage']);
    expect(more.steps[1].args).toEqual({ table: 'change request', key: 'CHG0010001' });
    // Without the pack's rules these lines are ordinary web steps (or unknown), never sn.*.
    const web = parseEzScript('Journey: w\nOpen the incident list\nSet "Short description" to "x" on the form');
    expect(web.steps.every((s) => !String(s.handler ?? '').startsWith('sn.'))).toBe(true);
  });

  it('creates an incident through the UI16 form (reference autocomplete, choices) and cross-checks it through the Table API', async () => {
    const run = await runPack([parseServiceNowEzScript(CREATE)], sn.customSteps, mock.url);
    expect(stepLines(run)).toEqual(allLines(run));
    const b = run.journeys[0].ledger.servicenow as Record<string, any>;
    expect(b.number).toMatch(/^INC\d{7}$/);
    const rec = mock.store.find('incident', (r) => r.number === b.number)[0];
    expect(rec).toMatchObject({ short_description: 'Printer jams on floor 3', category: 'hardware', priority: '2' });
    expect(b.tableApi.incident).toMatchObject({ caller_id: rec.caller_id, priority: '2' });
    expect(mock.stats.queries.some((q) => q === `incident?number=${b.number}`)).toBe(true);
  });

  it('resolves through a UI action, enforcing the resolution fields, and reads related lists', async () => {
    const j = parseServiceNowEzScript(`
Journey: Resolve the email incident
Id: sn-resolve
Log in to ServiceNow as itil
Open the ServiceNow incident "INC0010001"
Expect ServiceNow field "Short description" to be "Email not working"
Expect the ServiceNow related list "Task SLAs" to contain "Priority 3 resolution"
Click the ServiceNow UI action "Resolve" and expect the error "Resolution code, Resolution notes"
Set ServiceNow field "Resolution code" to "Solved (Work Around)"
Set ServiceNow field "Resolution notes" to "Re-created the mail profile"
Click the ServiceNow UI action "Resolve"
Expect the ServiceNow info message to contain "resolved"
Expect ServiceNow field "State" to be "Resolved"
Expect the ServiceNow UI action "Resolve" to be hidden
Verify in ServiceNow that incident "INC0010001" has state = "Resolved" and close_code = "Solved (Work Around)"
`);
    const run = await runPack([j], sn.customSteps, mock.url);
    expect(stepLines(run)).toEqual(allLines(run));
    expect(mock.store.find('incident', (r) => r.number === 'INC0010001')[0].state).toBe('6');
  });

  it('fails with what ServiceNow said: server business rule, strict reference match, unknown field, Table API mismatch', async () => {
    const p1 = parseServiceNowEzScript(`Journey: P1 without group\nId: p1\nLog in to ServiceNow as itil\nCreate a new ServiceNow incident\nSet ServiceNow field "Caller" to "Abel Tuter"\nSet ServiceNow field "Short description" to "Datacenter down"\nSet ServiceNow field "Priority" to "1 - Critical"\nSubmit the ServiceNow form`);
    const ref = parseServiceNowEzScript(`Journey: Bad ref\nId: ref\nLog in to ServiceNow as itil\nCreate a new ServiceNow incident\nSet ServiceNow field "Caller" to "Abel"`);
    const typo = parseServiceNowEzScript(`Journey: Typo\nId: typo\nLog in to ServiceNow as itil\nCreate a new ServiceNow incident\nSet ServiceNow field "Short descripton" to "x"`);
    const api = parseServiceNowEzScript(`Journey: Api\nId: api\nVerify in ServiceNow that incident "INC0010002" has priority = "3"`);
    const run = await runPack([p1, ref, typo, api], sn.customSteps, mock.url);
    const err = (i: number) => run.journeys[i].steps.find((s) => s.status === 'failed')?.error?.message;
    expect(err(0)).toBe('ServiceNow "Submit" failed: Assignment group is required for Priority 1 incidents; Invalid insert');
    expect(err(1)).toBe('ServiceNow reference "Caller": no record named exactly "Abel" (results: "Abel Tuter")');
    expect(err(2)).toBe('Field "Short descripton" not found on incident. Did you mean "Short description"?');
    expect(err(3)).toBe('ServiceNow incident "INC0010002": Priority is "1 - Critical" (1), expected "3"');
  });

  it('orders a catalog item on the Service Portal with metadata-aware variables, and checks the RITM variables', async () => {
    const j = parseServiceNowEzScript(`
Journey: Order a laptop
Id: sn-order-laptop
Log in to ServiceNow as employee
Open the ServiceNow catalog item "Standard Laptop"
Order the ServiceNow catalog item and expect the error "Model, Business justification"
Set ServiceNow variable "Model" to "Dell XPS 13"
Set ServiceNow variable "Business justification" to "New hire"
Set ServiceNow variable "Additional software" to "VS Code"
Set ServiceNow variable "Express delivery" to "yes"
Order the ServiceNow catalog item
Verify in ServiceNow that request "\${servicenow.request.number}" has "Requested for" = "Abel Tuter"
Verify in ServiceNow that requested item "\${servicenow.request.items.0}" has variables.model = "dell_xps_13" and variables.justification = "New hire" and variables.express = "true"
`);
    const run = await runPack([j], sn.customSteps, mock.url);
    expect(stepLines(run)).toEqual(allLines(run));
    const b = run.journeys[0].ledger.servicenow as Record<string, any>;
    expect(b.request.number).toMatch(/^REQ\d{7}$/);
    expect(b.request.items[0]).toMatch(/^RITM\d{7}$/);
  });

  it('lists the journeys an update set and an upgrade break, and diffs dictionary snapshots around a commit', async () => {
    const journeys = [
      parseServiceNowEzScript(CREATE),
      parseServiceNowEzScript(`Journey: Resolve\nId: resolve\nRisk: 5\nLog in to ServiceNow as itil\nOpen the ServiceNow incident "INC0010001"\nSet ServiceNow field "Resolution code" to "Solved (Work Around)"\nClick the ServiceNow UI action "Resolve"`),
      parseServiceNowEzScript(`Journey: Laptop\nId: laptop\nOpen the ServiceNow catalog item "Standard Laptop"\nSet ServiceNow variable "Model" to "Dell XPS 13"\nSet ServiceNow variable "Additional software" to "VS Code"\nOrder the ServiceNow catalog item`),
      parseServiceNowEzScript(`Journey: Database ticket\nId: db\nLog in to ServiceNow as itil\nCreate a new ServiceNow incident\nSet ServiceNow field "Category" to "Database"\nSet ServiceNow field "Caller" to "Abel Tuter"\nSubmit the ServiceNow form`),
      parseServiceNowEzScript(`Journey: Minimal\nId: minimal\nLog in to ServiceNow as itil\nCreate a new ServiceNow incident\nSet ServiceNow field "Caller" to "Abel Tuter"\nSubmit the ServiceNow form`),
      parseServiceNowEzScript(`Journey: Change list\nId: changes\nLog in to ServiceNow as itil\nOpen the ServiceNow change request list`),
    ];
    const changes = await sn.changes({ updateSets: ['EZ incident form changes'], skipped: true });
    const kinds = changes.map((c) => `${c.kind}:${c.object}${c.field ? '.' + c.field : ''}`);
    expect(kinds).toEqual(expect.arrayContaining([
      'field-added:incident.u_vip', 'field-relabeled:task.short_description', 'field-required:incident.category', 'values-removed:incident.category',
      'ui-changed:incident.ui_action:resolve_incident', 'field-removed:catalog:Standard Laptop.additional_software', 'logic-changed:incident',
      'skipped-upgrade:incident.ui_action:resolve_incident', 'skipped-upgrade:incident.priority', 'skipped-upgrade:IncidentUtils',
    ]));
    const report = sn.impact(changes, journeys);
    const by = Object.fromEntries(report.impacted.map((j) => [j.journeyId, j]));
    const why = (id: string) => by[id]?.reasons.map((r) => `${r.severity}:${r.change}:${r.matchedBy}:${r.matched}`) ?? [];
    expect(why('sn-create-incident')).toEqual(expect.arrayContaining(['breaking:field-relabeled:field:Short description', 'review:logic-changed:object:incident']));
    expect(why('resolve')).toEqual(expect.arrayContaining(['breaking:ui-changed:field:Resolve', 'review:skipped-upgrade:field:Resolve']));
    expect(why('laptop')).toEqual(expect.arrayContaining(['breaking:field-removed:field:Additional software']));
    expect(why('db')).toEqual(expect.arrayContaining(['breaking:values-removed:value:Database']));
    expect(why('minimal')).toEqual(expect.arrayContaining(['breaking:field-required:creates-record:category']));
    // "Category" is set in these journeys, so the newly mandatory field does not break them.
    expect(why('sn-create-incident').some((r) => r.includes('field-required'))).toBe(false);
    expect(why('db').some((r) => r.includes('field-required'))).toBe(false);
    expect(by.changes).toBeUndefined();
    expect(report.untested.some((c) => c.field === 'u_vip')).toBe(true);
    expect(report.impacted[0].breaking).toBeGreaterThan(0);

    // Snapshot -> commit the update set -> snapshot: the same changes appear as a dictionary diff.
    const local = await startServiceNowMock();
    try {
      const s2 = integration(local);
      const before = await s2.snapshot({ release: 'before' });
      local.commitUpdateSet('EZ incident form changes');
      s2.client.clearCache();
      const after = await s2.snapshot({ release: 'after' });
      const diff = await s2.changes({ before, after });
      expect(diff.map((c) => `${c.kind}:${c.object}.${c.field}`)).toEqual(expect.arrayContaining([
        'field-relabeled:incident.short_description', 'field-required:incident.category', 'values-removed:incident.category', 'field-added:incident.u_vip',
      ]));
      const r2 = s2.impact(diff, journeys);
      expect(r2.impacted.find((j) => j.journeyId === 'db')?.reasons.some((r) => r.matched === 'Database')).toBe(true);
    } finally {
      await local.close();
    }
  });

  it('checks the ACL matrix per role through the Table API (as each user) and the UI', async () => {
    const browser: Browser = await chromium.launch();
    try {
      const pages: Record<string, import('../../src/browser/index.js').Page> = {};
      for (const role of ['admin', 'itil', 'employee'] as const) {
        const p = await (await browser.newContext()).newPage();
        expect(await serviceNowLogin(p, mock.url, mock.users[role].username, mock.users[role].password, 8000)).toEqual({ ok: true });
        pages[role] = p;
      }
      const checks: import('../../src/apps/servicenow/index.js').ServiceNowPermissionCheck[] = [
        { table: 'incident', expect: { admin: 'write', itil: 'write', employee: 'read' } },
        { table: 'incident', field: 'Internal cost', expect: { admin: 'write', itil: 'read', employee: 'none' } },
        { table: 'change_request', expect: { itil: 'read', employee: 'none' } },
        { table: 'incident', uiAction: 'Delete', expect: { admin: 'visible', itil: 'hidden' } },
      ];
      const ok = await sn.permissionMatrix(checks, { pages });
      expect(ok.violations).toEqual([]);
      expect(ok.results.find((r) => r.user === 'employee' && r.subject === 'incident.Internal cost')).toMatchObject({ api: 'none', ui: 'none', passed: true });
      expect(ok.results.find((r) => r.user === 'itil' && r.subject === 'incident.Internal cost')).toMatchObject({ api: 'read', ui: 'read' });
      const bad = await sn.permissionMatrix([{ table: 'change_request', expect: { employee: 'read' } }, { table: 'incident', field: 'u_internal_cost', expect: { itil: 'write' } }], { pages });
      expect(bad.violations.map((v) => `${v.user}:${v.subject}:${v.api}:${v.ui}`)).toEqual(['employee:table:change_request:none:none', 'itil:incident.u_internal_cost:read:read']);
    } finally {
      await browser.close();
    }
  });

  it('builds encoded queries that a value cannot extend', () => {
    expect(snTerm('number', 'INC0010001')).toBe('number=INC0010001');
    expect(() => snTerm('number', 'X^ORactive=true')).toThrow(/cannot contain "\^"/);
    expect(() => snTerm('number); drop', 'x')).toThrow(/Invalid ServiceNow field/);
  });

  it('keeps passwords, client secrets and tokens out of results and evidence', async () => {
    const j = parseServiceNowEzScript(`Journey: Secrets\nId: secrets\nLog in to ServiceNow as itil\nOpen the ServiceNow incident "INC0010002"\nVerify in ServiceNow that incident "INC0010002" has priority = "1"`);
    const run = await runPack([j], sn.customSteps, mock.url);
    expect(stepLines(run)).toEqual(allLines(run));
    const text = JSON.stringify(run);
    for (const s of [mock.users.itil.password, mock.clientSecret, mock.users.integration.password]) expect(text).not.toContain(s);
  });
});
