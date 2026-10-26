/**
 * A run as consumer projects produce it, not a tidy sample: scenario titles of
 * 60-120 characters, Gherkin steps with long text and ${...} expressions, 6 to
 * 20 steps, several evidence files per step (screenshot, accessibility
 * findings, aria snapshot, DB rows), a dozen tags per test, failures with long
 * engine messages (post-conditions, "query returned no rows") and a triage
 * that knows nothing about some of them. One browser by default; `browsers`
 * makes every test run in each browser (journey ids `<id>@<browser>`).
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceVault, summarize, type JourneyResult, type RunResult, type StepResult, type EvidenceRef } from '../../src/core/index.js';
import { pagePng } from './rich-fixture.js';

export interface MessyFixture {
  /** The temporary folder holding the run; remove it when done. */
  root: string;
  runDir: string;
  run: RunResult;
  evidence: EvidenceRef[];
  ids: { urlFail: string; noRows: string; passed: string };
}

const T0 = Date.parse('2026-10-26T09:00:00Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();

const FEATURES = [
  'Employee personal details management in the PIM module for HR administrators across regions',
  'Payroll run approval workflow for multi-entity organisations with regional cost centres',
  'Leave requests',
];
const LONG_STEPS = [
  'Given I am logged in as "hr-admin" with the "PIM Administrator" role for the "EU-West" business unit',
  'When I open the "Add Employee" form from the PIM menu and wait for the employee list grid to finish loading',
  'And I type "${unique(\'EMP-\')}" into the "Employee Id" field',
  'And I type "${format(addBusinessDays(today(), 2), "MM/DD/YYYY")}" into the "Joined Date" field',
  'And I select "Full-Time Permanent" from the "Employment Status" dropdown',
  'And I click the "Save" button',
  'Then I get the value of query "SELECT emp_number FROM hs_hr_employee WHERE employee_id = \'${employeeId}\' AND termination_id IS NULL" on hrm as empNumber',
  'And the URL contains "/pim/viewPersonalDetails/empNumber/"',
  'And the page contains "Personal Details"',
  'And the "Employee Full Name" field has the value "${firstName} ${lastName}"',
  'When I open the "Job" tab',
  'And I select "QA Engineer" from the "Job Title" dropdown',
  'And I click the "Save" button',
  'Then the page contains "Successfully Updated"',
];
const TAGS = ['@hr', '@pim', '@regression', '@critical', '@smoke', '@sprint-42', '@eu-west', '@long-running', '@nightly', '@owner-hr-platform', '@data-driven', '@TestCaseId:4711'];

export async function makeMessyFixture(o: { count?: number; browsers?: string[]; preflightFailed?: boolean } = {}): Promise<MessyFixture> {
  const root = await mkdtemp(join(tmpdir(), 'eztest-messy-'));
  const runDir = join(root, 'eztest-results', 'run-messy');
  await mkdir(runDir, { recursive: true });
  const vault = new EvidenceVault(runDir);
  await vault.init();
  const browsers = o.browsers ?? ['chromium'];
  const count = o.count ?? 13;
  const journeys: JourneyResult[] = [];
  const shot = pagePng(160, 100, [42, 120, 214]);
  let clock = 0;
  for (let n = 0; n < count; n++) {
    const feature = FEATURES[n % FEATURES.length];
    const name = n === 0
      ? 'HR administrator creates a new employee record and lands on the personal details page that shows the employee number'
      : n === 1
        ? 'Employee onboarding reference number is generated with the regional prefix and stored on the employee record in the database'
        : `Scenario ${n}: HR administrator updates the job details of an employee in the ${['EU-West', 'US-East', 'APAC'][n % 3]} business unit and the audit trail records the change`;
    const kind = n === 0 ? 'url' : n === 1 ? 'norows' : n % 5 === 4 ? 'fail' : 'pass';
    const stepCount = 6 + (n % 15);
    for (const browser of browsers) {
      const id = `scenario-${n}${browsers.length > 1 ? `@${browser}` : ''}`;
      const steps: StepResult[] = [];
      let t = clock;
      const failAt = kind === 'url' ? 5 : kind === 'norows' ? 6 : kind === 'fail' ? stepCount - 1 : -1;
      for (let i = 0; i < stepCount; i++) {
        const intent = LONG_STEPS[i % LONG_STEPS.length];
        const stepId = `s${i + 1}`;
        const status: StepResult['status'] = failAt >= 0 && i > failAt ? 'skipped' : i === failAt ? 'failed' : 'passed';
        const ev: string[] = [];
        if (status !== 'skipped') {
          ev.push((await vault.store('screenshot', `journeys/${id}/attempt-1/${stepId}-${intent.slice(0, 30).replace(/\W+/g, '-')}.png`, shot, { journeyId: id, stepId, description: `screenshot after ${intent.slice(0, 40)}` })).id);
          ev.push((await vault.store('data', `journeys/${id}/attempt-1/lens-a11y-${stepId}.json`, JSON.stringify({ violations: [] }), { journeyId: id, stepId, description: 'lens a11y findings' })).id);
          if (i % 2 === 0) ev.push((await vault.store('aria', `journeys/${id}/attempt-1/${stepId}.aria.yml`, '- main:\n  - heading "PIM"', { journeyId: id, stepId, description: 'aria snapshot' })).id);
          if (i === 6) ev.push((await vault.store('data', `journeys/${id}/attempt-1/query-rows-${stepId}.json`, JSON.stringify([]), { journeyId: id, stepId, description: 'DB query rows' })).id);
        }
        const step: StepResult = { stepId, intent, status, startedAt: iso(t), durationMs: status === 'skipped' ? 0 : 120 + ((n * 31 + i * 17) % 400), conditions: [], evidence: ev };
        if (status === 'failed') {
          if (kind === 'url') {
            step.error = { message: 'post-condition failed: urlContains: URL does not contain "/pim/viewPersonalDetails/empNumber/"; pageContainsText: page does not contain "Personal Details"; did you mean role=link "New order" (0.61) or role=button "Cancel order" (0.58)?' };
            step.conditions = [{ condition: { type: 'urlContains', value: '/pim/viewPersonalDetails/empNumber/' } as never, passed: false, actual: 'https://hrm.example.test/pim/addEmployee', message: 'URL does not contain "/pim/viewPersonalDetails/empNumber/"' }];
          } else if (kind === 'norows') step.error = { message: 'query returned no rows', name: 'EzTestError' };
          else step.error = { message: `post-condition failed: textEquals: testid=job-title text is "Software Engineer", expected "QA Engineer"`, name: 'EzTestError' };
        }
        steps.push(step);
        t += step.durationMs + 20;
      }
      const failed = steps.find((s) => s.error);
      journeys.push({
        journeyId: id, name, status: failed ? 'failed' : 'passed', startedAt: iso(clock), durationMs: t - clock, steps, tags: TAGS, requirements: [], risk: 3, attempt: 1, ledger: {}, evidence: [], browser,
        suitePath: [{ kind: 'feature', name: feature }],
        ...(failed ? { error: failed.error } : {}),
      } as JourneyResult);
      clock = t + 50;
    }
  }
  const run: RunResult = {
    runId: 'run-messy', startedAt: iso(0), finishedAt: iso(clock), durationMs: clock, journeys, summary: summarize(journeys),
    environment: { node: 'v22.11.0', platform: 'linux', browser: browsers[0], browserVersion: '141.0.7390.37', baseUrl: 'https://hrm.example.test' },
    evidenceHead: vault.headHash,
    ...(browsers.length > 1 ? { browsers: Object.fromEntries(browsers.map((b) => [b, { ...summarize(journeys.filter((j) => j.browser === b)) }])) } : {}),
    ...(o.preflightFailed ? { health: { preflight: { ok: false, checks: [{ name: 'app', ok: false, message: 'GET https://hrm.example.test/health returned 503', ms: 40 } as never] } } } : {}),
  };
  await writeFile(join(runDir, 'run.json'), JSON.stringify(run, null, 2));
  const evidence: EvidenceRef[] = vault.entries.map(({ seq: _q, prevHash: _p, entryHash: _e, ...r }) => r);
  const sfx = browsers.length > 1 ? `@${browsers[0]}` : '';
  return { root, runDir, run, evidence, ids: { urlFail: `scenario-0${sfx}`, noRows: `scenario-1${sfx}`, passed: `scenario-2${sfx}` } };
}
