/**
 * Workday pack against the Workday mock (examples/workday-mock): a real
 * Chromium drives prompts, the date widget, related actions and the inbox;
 * WQL and SOAP cross-checks; 2026R1 -> 2026R2 tenant-preview impact; the task
 * and data-source role matrix. The mock emulates documented Workday
 * conventions; it is not Workday.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { SecretRegistry } from '../../src/identity/handle.js';
import { buildWql, createWorkdayIntegration, parseWorkdayEzScript, workdayLogin, type WorkdayIntegration } from '../../src/apps/workday/index.js';
import { startWorkdayMock, type WorkdayMockServer } from '../../examples/workday-mock/server.js';
import { PACK_SUITE_TIMEOUT_MS, allLines, runPack, stepLines } from './helpers.js';

let prod: WorkdayMockServer;
let preview: WorkdayMockServer;
let wd: WorkdayIntegration;
let wdPreview: WorkdayIntegration;

function integration(m: WorkdayMockServer): WorkdayIntegration {
  return createWorkdayIntegration({
    url: m.url, tenant: m.tenant,
    auth: { type: 'oauth2', grant: 'refresh_token', tokenUrl: m.tokenUrl, clientId: m.clientId, clientSecret: m.clientSecret, refreshToken: m.refreshToken },
    isu: { username: m.isu.username, password: m.isu.password },
    users: { hr: m.users.hr, manager: m.users.manager, employee: m.users.employee },
    tasks: ['Hire Employee'],
    whatsNewReport: { owner: 'ISU_EZTest', name: 'Whats_New_in_Workday' },
    timeoutMs: 8000,
  }, { secrets: new SecretRegistry() });
}

beforeAll(async () => {
  prod = await startWorkdayMock({ release: '2026R1' });
  preview = await startWorkdayMock({ release: '2026R2' });
  wd = integration(prod);
  wdPreview = integration(preview);
});
afterAll(async () => {
  await prod?.close();
  await preview?.close();
});

const HIRE = `
Journey: Hire a software engineer
Id: wd-hire
Tags: @workday
Log in to Workday as hr
Open the Workday task "Hire Employee"
Expect Workday field "Hire Date" to be mandatory
Set Workday field "Supervisory Organization" to "Engineering (Logan McNeil)"
Set Workday field "First Name" to "Ada"
Set Workday field "Last Name" to "Lovelace"
Set Workday field "Hire Date" to "2026-11-02"
Set Workday field "Reason" to "New Position"
Set Workday field "Employee Type" to "Contractor"
Set Workday field "Job Profile" to "Software Engineer"
Submit the Workday task
Expect the Workday confirmation to contain "You have submitted"
Expect the Workday confirmation to contain "Up Next: Logan McNeil"
Verify in Workday that worker "Ada Lovelace" has "Worker Status" = "Pending" and "Hire Date" = "2026-11-02" and "Job Profile" = "Software Engineer"
`;

describe('Workday pack against the Workday mock (real Chromium)', { timeout: PACK_SUITE_TIMEOUT_MS }, () => {
  it('parses Workday phrasings into wd.* steps', () => {
    const j = parseWorkdayEzScript(HIRE + `Open the Workday inbox item "Hire: Ada"\nApprove the Workday inbox item\nSend back the Workday inbox item\nExpect the Workday inbox not to contain "Hire: Ada"\nRun the Workday related action "Job Change > Change Job"\nVerify in Workday SOAP that employee "21004" has Business_Title = "x"\nExpect the Workday task "Hire Employee" to be unavailable`);
    expect(j.steps.map((s) => s.handler).slice(-7)).toEqual(['wd.openInboxItem', 'wd.inboxAction', 'wd.inboxAction', 'wd.expectInbox', 'wd.relatedAction', 'wd.verifySoap', 'wd.expectTask']);
    expect(j.steps.at(-5)?.args).toEqual({ action: 'Send Back' });
    expect(j.steps.at(-4)?.args).toEqual({ item: 'Hire: Ada', present: false });
  });

  it('hires through the business process: prompts, date widget, submit, inbox approval by the manager; WQL and SOAP agree', async () => {
    const approve = parseWorkdayEzScript(`
Journey: Approve the hire
Id: wd-approve
Log in to Workday as manager
Expect the Workday inbox to contain "Hire: Ada Lovelace"
Open the Workday inbox item "Hire: Ada Lovelace"
Approve the Workday inbox item
Expect the Workday confirmation to contain "You have approved"
Verify in Workday that worker "Ada Lovelace" has "Worker Status" = "Active"
Verify in Workday SOAP that employee "21004" has Business_Title = "Software Engineer" and Hire_Date = "2026-11-02" and Active = "1" and Formatted_Name = "Ada Lovelace"
`);
    const run = await runPack([parseWorkdayEzScript(HIRE)], wd.customSteps, prod.url);
    expect(stepLines(run)).toEqual(allLines(run));
    const b = run.journeys[0].ledger.workday as Record<string, any>;
    expect(b.confirmation.employeeId).toBe('21004');
    expect(prod.stats.wql.at(-1)).toBe("SELECT workdayID, fullName, workerStatus, hireDate, jobProfile FROM allWorkers WHERE fullName = 'Ada Lovelace' LIMIT 2");
    // The second journey runs as the manager (its own browser context); the approval confirmation carries no employee id.
    const run2 = await runPack([{ ...approve, variables: { ...approve.variables } }], wd.customSteps, prod.url);
    expect(stepLines(run2)).toEqual(allLines(run2));
    expect(prod.workers.find((w) => w.employeeId === '21004')?.status).toBe('Active');
    expect(prod.stats.soap).toBeGreaterThan(0);
  });

  it('changes a job through related actions and reports field errors from the error bar', async () => {
    const j = parseWorkdayEzScript(`
Journey: Promote Alex
Id: wd-change-job
Log in to Workday as manager
Open the Workday worker "Alex Jones"
Expect Workday field "Business Title" to be "Software Engineer"
Run the Workday related action "Job Change > Change Job"
Set Workday field "Business Title" to "Senior Software Engineer"
Submit the Workday task and expect the error "The field Effective Date is required"
Expect the Workday error to contain "Reason is required"
Set Workday field "Effective Date" to "12/01/2026"
Set Workday field "Reason" to "Promotion"
Set Workday field "Job Profile" to "Senior Software Engineer"
Submit the Workday task
Expect the Workday confirmation to contain "Process Successfully Completed"
Verify in Workday that worker "Alex Jones" has "Business Title" = "Senior Software Engineer" and "Job Profile" = "Senior Software Engineer"
`);
    const bad = parseWorkdayEzScript(`Journey: Bad\nId: bad\nLog in to Workday as hr\nOpen the Workday task "Hire Employee"\nSet Workday field "Job Profile" to "Engineer"`);
    const denied = parseWorkdayEzScript(`Journey: Denied\nId: denied\nLog in to Workday as employee\nOpen the Workday task "Hire Employee"`);
    const run = await runPack([j, bad, denied], wd.customSteps, prod.url);
    expect(stepLines(run)).toEqual(allLines(run));
    const err = (i: number) => run.journeys[i].steps.find((s) => s.status === 'failed')?.error?.message;
    expect(err(1)).toBe('Workday prompt "Job Profile" has no option "Engineer" (search results: "Software Engineer", "Senior Software Engineer")');
    expect(err(2)).toBe('Workday search finds no task "Hire Employee" for this user (tasks found: none)');
  });

  it('lists the journeys the 2026R2 preview breaks: tenant snapshots and the What\'s New report', async () => {
    const browser: Browser = await chromium.launch();
    try {
      const snap = async (m: WorkdayMockServer, i: WorkdayIntegration, release: string) => {
        const page = await (await browser.newContext()).newPage();
        expect(await workdayLogin(page, `${m.url}/${m.tenant}`, m.users.hr.username, m.users.hr.password, 8000)).toEqual({ ok: true });
        return i.snapshot({ release, page });
      };
      const before = await snap(prod, wd, '2026R1');
      const after = await snap(preview, wdPreview, '2026R2');
      expect(before.objects['task:Hire Employee'].fields.find((f) => f.name === 'employeeType')?.values).toEqual(['Regular', 'Fixed Term', 'Contractor']);
      const changes = await wdPreview.changes({ before, after, whatsNew: true, release: '2026R2' });
      expect(changes.map((c) => `${c.kind}:${c.object}.${c.field ?? ''}`)).toEqual(expect.arrayContaining([
        'field-relabeled:task:Hire Employee.reason', 'field-required:task:Hire Employee.timeType', 'values-removed:task:Hire Employee.employeeType', 'field-relabeled:allWorkers.jobProfile',
        'field-relabeled:task:Hire Employee.Reason', 'ui-changed:task:Request Compensation Change.',
      ]));
      const journeys = [
        parseWorkdayEzScript(HIRE),
        parseWorkdayEzScript(`Journey: Promote\nId: promote\nOpen the Workday worker "Alex Jones"\nRun the Workday related action "Job Change > Change Job"\nSet Workday field "Business Title" to "Lead"\nSubmit the Workday task`),
      ];
      const report = wdPreview.impact(changes, journeys);
      const hire = report.impacted.find((j) => j.journeyId === 'wd-hire')!;
      expect(hire.reasons.map((r) => `${r.severity}:${r.change}:${r.matchedBy}:${r.matched}`)).toEqual(expect.arrayContaining([
        'breaking:field-relabeled:field:Reason', 'breaking:values-removed:value:Contractor', 'breaking:field-required:creates-record:timeType', 'breaking:field-relabeled:field:Job Profile',
      ]));
      expect(report.impacted.find((j) => j.journeyId === 'promote')).toBeUndefined();
      expect(report.untested.some((c) => c.object === 'task:Request Compensation Change')).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it('checks task and data-source access per role (WQL as each user, global search in the UI)', async () => {
    const browser: Browser = await chromium.launch();
    try {
      const pages: Record<string, Page> = {};
      for (const r of ['hr', 'manager', 'employee'] as const) pages[r] = await (await browser.newContext()).newPage();
      const report = await wd.permissionMatrix([
        { task: 'Hire Employee', expect: { hr: 'available', manager: 'unavailable', employee: 'unavailable' } },
        { task: 'Change Job', expect: { hr: 'available', manager: 'available', employee: 'unavailable' } },
        { dataSource: 'allWorkers', expect: { hr: 'read', manager: 'read', employee: 'none' } },
      ], { pages });
      expect(report.violations).toEqual([]);
      const bad = await wd.permissionMatrix([{ dataSource: 'allWorkers', expect: { employee: 'read' } }]);
      expect(bad.violations.map((v) => `${v.user}:${v.subject}:${v.api}`)).toEqual(['employee:dataSource:allWorkers:none']);
    } finally {
      await browser.close();
    }
  });

  it('builds WQL from validated aliases and quoted literals only', () => {
    expect(buildWql('allWorkers', ['fullName'], { fullName: "O'Brien" }, 2)).toBe("SELECT fullName FROM allWorkers WHERE fullName = 'O''Brien' LIMIT 2");
    expect(() => buildWql('allWorkers', ['fullName FROM x --'])).toThrow(/Invalid WQL field/);
  });
});
