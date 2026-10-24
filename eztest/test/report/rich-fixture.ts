/**
 * A realistic run for the report tests and the report screenshots: suites in
 * folders, failures sharing a root cause, flaky retries, heals, API and DB
 * steps, network and console logs, history with readiness, a baseline run,
 * Azure Pipelines context and every integration recorded.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { EvidenceVault, summarize, type EvidenceRef, type JourneyResult, type RunResult, type StepResult } from '../../src/core/index.js';
import { evaluateReadiness, failureSignature, scoreFlakiness, triageRun, type RunHistoryEntry } from '../../src/insights/index.js';
import { buildRunContext, recordIntegration, type IntegrationsRecord, type RunContext } from '../../src/report/index.js';

/** A small mock app page (header, nav, content cards; an error banner when failed). */
export function pagePng(w: number, h: number, accent: [number, number, number], failed = false, seed = 0): Buffer {
  const png = new PNG({ width: w, height: h });
  const set = (x: number, y: number, c: [number, number, number]) => {
    const i = (y * w + x) * 4;
    png.data[i] = c[0];
    png.data[i + 1] = c[1];
    png.data[i + 2] = c[2];
    png.data[i + 3] = 255;
  };
  const rect = (x0: number, y0: number, rw: number, rh: number, c: [number, number, number]) => {
    for (let y = y0; y < Math.min(h, y0 + rh); y++) for (let x = x0; x < Math.min(w, x0 + rw); x++) set(x, y, c);
  };
  rect(0, 0, w, h, [246, 247, 249]);
  rect(0, 0, w, 28, accent);
  rect(0, 28, 70, h - 28, [232, 234, 238]);
  for (let i = 0; i < 5; i++) rect(10, 44 + i * 18, 50, 8, [200, 204, 212]);
  const cards = 3 + (seed % 3);
  for (let i = 0; i < cards; i++) {
    rect(86 + (i % 3) * 74, 44 + Math.floor(i / 3) * 70, 66, 60, [255, 255, 255]);
    rect(92 + (i % 3) * 74, 52 + Math.floor(i / 3) * 70, 40, 6, [150, 156, 168]);
    rect(92 + (i % 3) * 74, 64 + Math.floor(i / 3) * 70, 54, 4, [210, 214, 222]);
  }
  rect(86, h - 34, 90, 20, accent);
  if (failed) {
    rect(86, 34, w - 96, 4, [208, 59, 59]);
    rect(86, h - 34, 90, 20, [208, 59, 59]);
  }
  return PNG.sync.write(png);
}

export interface RichFixture {
  root: string;
  runDir: string;
  baselineDir: string;
  run: RunResult;
  baseline: RunResult;
  evidence: EvidenceRef[];
  history: RunHistoryEntry[];
  context: RunContext;
  integrations: IntegrationsRecord;
  insights: Parameters<typeof import('../../src/report/index.js').writeReports>[2];
}

const T0 = Date.parse('2026-10-22T08:00:00Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();

interface Spec {
  id: string;
  name: string;
  suite: string;
  status: JourneyResult['status'];
  steps: string[];
  fail?: { at: number; message: string; name?: string; stack?: string };
  heal?: number;
  attempt?: number;
  tc?: number;
  tags?: string[];
  req?: string[];
  risk?: number;
  durations?: number[];
  api?: number;
  db?: number;
  browser?: string;
}

const SPECS: Spec[] = [
  { id: 'checkout-card', name: 'Checkout with a saved card', suite: 'checkout', status: 'failed', steps: ['Open /cart', 'Click the "Checkout" button', 'Choose the saved Visa card', 'Click "Place order"', 'Expect the total to be "42.00"'], fail: { at: 4, message: 'Expected the order total "42.00" but the page shows "40.00" (discount applied twice)', name: 'AssertionError', stack: 'AssertionError: Expected the order total\n    at expectText (src/runner/conditions.ts:120:11)\n    at runStep (src/runner/step.ts:88:9)' }, tc: 1201, tags: ['@critical', '@checkout'], req: ['3412'], risk: 5, durations: [820, 1400, 900, 2100, 600] },
  { id: 'checkout-voucher', name: 'Checkout with a voucher [voucher=SAVE10, country=DE]', suite: 'checkout', status: 'failed', steps: ['Open /cart', 'Apply voucher "SAVE10"', 'Click "Place order"', 'Expect the total to be "42.00"'], fail: { at: 3, message: 'Expected the order total "42.00" but the page shows "40.00" (discount applied twice)', name: 'AssertionError', stack: 'AssertionError: Expected the order total\n    at expectText (src/runner/conditions.ts:120:11)\n    at runStep (src/runner/step.ts:88:9)' }, tc: 1202, tags: ['@checkout'], req: ['3412'], risk: 4, durations: [700, 1100, 1900, 500] },
  { id: 'checkout-guest', name: 'Guest checkout', suite: 'checkout', status: 'passed', steps: ['Open /cart', 'Click "Checkout as guest"', 'Fill the address form', 'Click "Place order"', 'Expect the page to contain "Thank you"'], tc: 1203, tags: ['@checkout'], req: ['3413'], risk: 4 },
  { id: 'checkout-paypal', name: 'Checkout with PayPal', suite: 'checkout', status: 'passed-healed', heal: 2, steps: ['Open /cart', 'Click the "Checkout" button', 'Click the "PayPal" button', 'Expect the page to contain "Order"'], tc: 1204, tags: ['@checkout'], req: ['3413'], risk: 3 },
  { id: 'checkout-split', name: 'Split payment', suite: 'checkout', status: 'passed', attempt: 2, steps: ['Open /cart', 'Choose two payment methods', 'Click "Place order"', 'Expect the page to contain "Thank you"'], tags: ['@checkout'], risk: 3 },
  { id: 'account-login', name: 'Sign in with MFA', suite: 'account', status: 'passed', steps: ['Open /login', 'Type the user name', 'Type the password', 'Enter the TOTP code', 'Expect the page to contain "Dashboard"'], tc: 1101, tags: ['@critical', '@auth'], req: ['3401'], risk: 5 },
  { id: 'account-reset', name: 'Reset a forgotten password', suite: 'account', status: 'passed', steps: ['Open /login', 'Click "Forgot password"', 'Read the reset e-mail', 'Set a new password'], tags: ['@auth'], req: ['3402'], risk: 4 },
  { id: 'account-profile', name: 'Edit the profile', suite: 'account', status: 'failed', steps: ['Open /profile', 'Type "Ada" into the "First name" field', 'Click "Save"'], fail: { at: 1, message: "locator.fill: Timeout 5000ms exceeded.\nwaiting for getByLabel('First name')", name: 'TimeoutError' }, tags: ['@account'], req: ['3403'], risk: 2 },
  { id: 'account-delete', name: 'Delete the account', suite: 'account', status: 'skipped', steps: ['Open /profile', 'Click "Delete account"'], tags: ['@account', '@destructive'], risk: 3 },
  { id: 'account-sessions', name: 'Sign out of other sessions', suite: 'account', status: 'passed-healed', heal: 1, steps: ['Open /security', 'Click "Sign out everywhere"', 'Expect the page to contain "Signed out"'], tags: ['@auth'], risk: 3 },
  { id: 'search-basic', name: 'Search the catalogue', suite: 'search', status: 'passed', steps: ['Open /', 'Type "lamp" into the search box', 'Expect 12 results'], tc: 1301, tags: ['@search'], req: ['3420'], risk: 3 },
  { id: 'search-filters', name: 'Filter search results', suite: 'search', status: 'passed', steps: ['Open /search?q=lamp', 'Choose the "Brass" filter', 'Expect 3 results'], tags: ['@search'], risk: 2 },
  { id: 'search-sort', name: 'Sort search results by price', suite: 'search', status: 'passed', attempt: 2, steps: ['Open /search?q=lamp', 'Choose "Price, low to high"', 'Expect the first price to be the lowest'], tags: ['@search'], risk: 2 },
  { id: 'search-empty', name: 'Search with no results', suite: 'search', status: 'passed', steps: ['Open /', 'Type "zzzz" into the search box', 'Expect the page to contain "No results"'], tags: ['@search'], risk: 1 },
  { id: 'api-orders', name: 'Orders API: create and read', suite: 'api', status: 'failed', api: 0, steps: ['Call API "POST /api/orders"', 'Call API "GET /api/orders/{id}"', 'Expect status 200'], fail: { at: 0, message: 'API POST /api/orders returned 500', name: 'EzTestError' }, tc: 1401, tags: ['@api'], req: ['3430'], risk: 4 },
  { id: 'api-customers', name: 'Customers API: list', suite: 'api', status: 'passed', api: 0, steps: ['Call API "GET /api/customers?page=1"', 'Expect status 200'], tags: ['@api'], risk: 2 },
  { id: 'db-inventory', name: 'Inventory is reserved in the database', suite: 'data', status: 'passed', db: 1, steps: ['Place an order through the API', 'Query "reserved stock"', 'Expect 2 rows'], tags: ['@db'], req: ['3431'], risk: 3 },
  { id: 'data-import', name: 'Import customers from CSV', suite: 'data', status: 'error', steps: ['Upload customers.csv', 'Run the import job'], fail: { at: 1, message: 'SqliteError: UNIQUE constraint failed: customers.email (row 17)', name: 'SqliteError' }, tags: ['@data'], risk: 2 },
  { id: 'reports-sales', name: 'Sales report totals', suite: 'reports', status: 'passed', steps: ['Open /reports/sales', 'Choose "Last quarter"', 'Expect the total to match the ledger'], tags: ['@reports'], risk: 3, durations: [900, 5200, 3100] },
  { id: 'reports-export', name: 'Export the sales report to PDF', suite: 'reports', status: 'skipped', steps: ['Open /reports/sales', 'Click "Export PDF"'], tags: ['@reports'], risk: 2 },
];

export async function makeRichFixture(o: { root?: string } = {}): Promise<RichFixture> {
  const root = o.root ?? (await mkdtemp(join(tmpdir(), 'eztest-rich-')));
  const out = join(root, 'eztest-results');
  const runId = 'run-2026-10-22-0800';
  const runDir = join(out, runId);
  await mkdir(runDir, { recursive: true });
  const vault = new EvidenceVault(runDir);
  await vault.init();
  const journeys: JourneyResult[] = [];
  let clock = 0;
  const lanes = [0, 0, 0, 0];
  for (const [n, s] of SPECS.entries()) {
    const lane = lanes.indexOf(Math.min(...lanes));
    const start = lanes[lane];
    const steps: StepResult[] = [];
    let t = start;
    const failedAt = s.fail?.at ?? -1;
    for (const [i, intent] of s.steps.entries()) {
      const d = s.durations?.[i] ?? 300 + ((n * 37 + i * 53) % 900);
      const stepId = `s${i + 1}`;
      const failed = i === failedAt;
      const after = failedAt >= 0 && i > failedAt;
      const st: StepResult['status'] = s.status === 'skipped' || after ? 'skipped' : failed ? (s.status === 'error' ? 'blocked' : 'failed') : s.heal === i ? 'passed-healed' : 'passed';
      const ev: string[] = [];
      if (st !== 'skipped') {
        const accent: [number, number, number] = [[42, 120, 214], [27, 140, 110], [98, 80, 214], [235, 104, 52]][n % 4] as [number, number, number];
        ev.push((await vault.store('screenshot', `screenshots/${s.id}/${stepId}.png`, pagePng(320, 200, accent, failed, n + i), { journeyId: s.id, stepId, description: `after ${intent}` })).id);
      }
      const step: StepResult = { stepId, intent, status: st, startedAt: iso(t), durationMs: st === 'skipped' ? 0 : d, conditions: [], evidence: ev };
      if (failed && s.fail) {
        step.error = { message: s.fail.message, name: s.fail.name, ...(s.fail.stack ? { stack: s.fail.stack } : {}) };
        step.conditions = [{ condition: { type: 'pageContainsText', value: '42.00' } as never, passed: false, actual: 'Total: 40.00' }];
        if (/Timeout/.test(s.fail.message)) step.diagnosis = { expected: 'a text field labelled "First name"', found: 'no element matched; 2 similar elements', candidates: [{ locator: 'label=First name', matches: 0 }], similar: [{ locator: 'label=Given name', description: 'textbox "Given name"', score: 0.82 }], consoleErrors: ['TypeError: profile.form is undefined'], failedRequests: ['GET /api/profile 503'], url: 'https://shop.example.test/profile' };
      }
      if (s.heal === i) step.heal = { stepId, tier: 'T1-fingerprint', original: [{ strategy: 'css', value: `#btn-${i}` } as never], healed: { strategy: 'role', value: 'button', name: intent.replace(/^Click (the )?"?|"? button$/g, '') } as never, confidence: 0.93, verified: true, reason: 'fingerprint match on role, label and form position', evidence: ev };
      if (s.api === i) {
        const status = s.fail?.at === i ? 500 : 200;
        const body = status === 500 ? '{"error":"internal","traceId":"7f3a"}' : '{"items":[{"id":1,"name":"Ada"},{"id":2,"name":"Grace"}],"page":1}';
        ev.push((await vault.store('network', `api/${s.id}/${stepId}.json`, JSON.stringify({ entries: [{ method: intent.includes('POST') ? 'POST' : 'GET', url: `https://shop.example.test${intent.match(/"(?:GET|POST) ([^"]+)"/)?.[1] ?? '/api'}`, status, timing: 182, requestBody: intent.includes('POST') ? '{"sku":"LAMP-1","qty":2,"card":"****4242"}' : undefined, responseHeaders: { 'content-type': 'application/json' }, responseBody: body, journeyId: s.id, stepId }] }), { journeyId: s.id, stepId, description: 'API exchange' })).id);
      }
      if (s.db === i) step.captured = { reserved: [{ sku: 'LAMP-1', warehouse: 'BER-1', qty: 2, reserved_at: '2026-10-22T08:01:02Z' }, { sku: 'LAMP-1', warehouse: 'HAM-2', qty: 0, reserved_at: null }] };
      steps.push(step);
      t += step.durationMs + 40;
    }
    const dur = t - start;
    lanes[lane] = t + 120;
    clock = Math.max(clock, t);
    const tags = [...(s.tags ?? []), ...(s.tc ? [`@TestCaseId:${s.tc}`] : [])];
    const j: JourneyResult = {
      journeyId: s.id, name: s.name, status: s.status, startedAt: iso(start), durationMs: dur, steps, tags, requirements: s.req ?? [], risk: s.risk ?? 3,
      attempt: s.attempt ?? 1, ledger: {}, evidence: [],
      ...(s.fail && s.status !== 'passed' ? { error: { message: s.fail.message, name: s.fail.name } } : {}),
    };
    if (j.attempt > 1) {
      j.reliability = { flake: { cause: 'timing', confidence: 0.8, reason: 'the results grid re-rendered while the first attempt read it', failedAttempt: 1, failedStepId: 's2', evidence: [] } };
      j.attempts = [
        { attempt: 1, status: 'failed', startedAt: iso(start - 2000), durationMs: dur + 900, failedStepId: 's2', error: 'element was detached from the DOM while reading the price', steps: steps.map((x, i) => ({ stepId: x.stepId, intent: x.intent, status: i === 1 ? 'failed' : i > 1 ? 'skipped' : 'passed', durationMs: i === 1 ? 5000 : i > 1 ? 0 : x.durationMs })) },
        { attempt: 2, status: 'passed', startedAt: iso(start), durationMs: dur, steps: steps.map((x) => ({ stepId: x.stepId, intent: x.intent, status: x.status, durationMs: x.durationMs })) },
      ];
    }
    if (s.fail && s.status !== 'passed') {
      const ref = await vault.store('network', `journeys/${s.id}/network.json`, JSON.stringify([
        { method: 'GET', url: 'https://shop.example.test/cart', status: 200, timing: 41, stepId: 's1' },
        { method: 'POST', url: 'https://shop.example.test/api/price', status: 200, timing: 96, stepId: `s${(s.fail.at ?? 0) + 1}` },
        { method: 'GET', url: 'https://shop.example.test/api/profile', status: 503, timing: 1201, stepId: `s${(s.fail.at ?? 0) + 1}` },
      ]), { journeyId: s.id, description: 'network log' });
      const con = await vault.store('console', `journeys/${s.id}/console.json`, JSON.stringify([{ type: 'log', text: 'app ready' }, { type: 'warning', text: 'Deprecated API: discount.v1' }, { type: 'error', text: 'TypeError: Cannot read properties of undefined (reading "total")' }]), { journeyId: s.id, description: 'browser console' });
      j.evidence.push(ref.id, con.id);
    }
    journeys.push(j);
  }
  const run: RunResult = {
    runId, startedAt: iso(0), finishedAt: iso(clock + 500), durationMs: clock + 500, journeys, summary: summarize(journeys),
    environment: { node: 'v22.11.0', platform: 'linux', browser: 'chromium', browserVersion: '141.0.7390.37', baseUrl: 'https://shop.example.test', environment: 'staging', gitCommit: '9f2c4e1b7a3d5c6e8f9012ab34cd56ef78901234', gitBranch: 'feature/checkout-v2', gitRemote: 'https://dev.azure.com/contoso/Shop/_git/shop-web', gitAuthor: 'Ada Lovelace' },
    evidenceHead: vault.headHash,
  };
  await writeFile(join(runDir, 'run.json'), JSON.stringify(run, null, 2));
  const evidence: EvidenceRef[] = vault.entries.map(({ seq: _q, prevHash: _p, entryHash: _e, ...r }) => r);

  // a baseline run: profile and api passed then, a test that is new now, a removed test, slower search
  const baseline: RunResult = JSON.parse(JSON.stringify(run));
  baseline.runId = 'run-2026-10-21-0800';
  baseline.startedAt = new Date(T0 - 86_400_000).toISOString();
  baseline.finishedAt = new Date(T0 - 86_400_000 + run.durationMs).toISOString();
  baseline.journeys = baseline.journeys.filter((j) => j.journeyId !== 'db-inventory').map((j) => (j.journeyId === 'account-profile' || j.journeyId === 'api-orders' ? { ...j, status: 'passed' as const, error: undefined } : j.journeyId === 'reports-sales' ? { ...j, durationMs: 2500 } : j.journeyId === 'data-import' || j.journeyId === 'search-sort' ? { ...j, status: 'failed' as const } : j));
  baseline.journeys.push({ ...baseline.journeys[0], journeyId: 'checkout-legacy', name: 'Legacy checkout', status: 'passed', error: undefined, tags: ['@checkout'] });
  baseline.summary = summarize(baseline.journeys);
  const baselineDir = join(out, baseline.runId);
  await mkdir(baselineDir, { recursive: true });
  await writeFile(join(baselineDir, 'run.json'), JSON.stringify(baseline, null, 2));

  // history: 14 earlier runs
  const sig = (m: string, name?: string) => failureSignature({ message: m, name }).hash;
  const history: RunHistoryEntry[] = [];
  for (let r = 14; r >= 1; r--) {
    const at = new Date(T0 - r * 43_200_000).toISOString();
    const outcomes = SPECS.map((s, i) => {
      let status: JourneyResult['status'] = 'passed';
      if (s.status === 'skipped') status = 'skipped';
      if (s.id === 'data-import' && r < 5) status = 'failed';
      if ((s.id === 'checkout-split' || s.id === 'search-sort') && (r + i) % 3 === 0) status = 'failed';
      if (s.id === 'account-profile' && r === 9) status = 'failed';
      if (s.id === 'checkout-paypal' && r % 4 === 0) status = 'passed-healed';
      return { journeyId: s.id, status, durationMs: 1500 + ((i * 131 + r * 71) % 2600) + (r < 4 && s.suite === 'reports' ? 2400 : 0), attempt: 1, ...(status === 'failed' && s.id === 'data-import' ? { signature: sig('SqliteError: UNIQUE constraint failed: customers.email (row 17)', 'SqliteError') } : {}) };
    });
    const bad = outcomes.filter((x) => x.status === 'failed').length;
    history.push({ runId: `run-h${String(15 - r).padStart(2, '0')}`, startedAt: at, outcomes, durationMs: 14_000 + ((r * 977) % 6000), readiness: bad === 0 ? 'GO' : bad > 2 ? 'NO_GO' : 'GO_WITH_RISKS', readinessScore: 100 - bad * 9 });
  }
  const flaky = ['checkout-split', 'search-sort', 'checkout-paypal'].map((id) => scoreFlakiness(id, history.map((h) => h.outcomes.find((x) => x.journeyId === id)!.status)));
  const triage = triageRun({ run, evidence, flaky });
  const readiness = evaluateReadiness('gates:\n  noFailedCriticalJourneys: true\n  minPassRate: 0.9\n  maxHealedRatio: 0.2\n  requirementsCovered: true\n', { run, evidence, triage, flaky });
  history.push({ runId, startedAt: run.startedAt, durationMs: run.durationMs, outcomes: journeys.map((j) => ({ journeyId: j.journeyId, status: j.status, durationMs: j.durationMs, attempt: j.attempt, ...(j.error ? { signature: failureSignature({ ...(j.steps.find((s) => s.error)?.error ?? j.error) }).hash } : {}) })), readiness: readiness.decision, readinessScore: readiness.score });

  const env = {
    TF_BUILD: 'True', SYSTEM_TEAMFOUNDATIONCOLLECTIONURI: 'https://dev.azure.com/contoso/', SYSTEM_COLLECTIONURI: 'https://dev.azure.com/contoso/', SYSTEM_TEAMPROJECT: 'Shop',
    BUILD_BUILDID: '20931', BUILD_BUILDNUMBER: '20261022.4', BUILD_DEFINITIONNAME: 'shop-web-e2e', BUILD_REASON: 'PullRequest', BUILD_REQUESTEDFOR: 'Ada Lovelace',
    BUILD_SOURCEBRANCH: 'refs/heads/feature/checkout-v2', BUILD_SOURCEVERSION: '9f2c4e1b7a3d5c6e8f9012ab34cd56ef78901234', BUILD_REPOSITORY_PROVIDER: 'TfsGit', BUILD_REPOSITORY_URI: 'https://dev.azure.com/contoso/Shop/_git/shop-web',
    SYSTEM_PULLREQUEST_PULLREQUESTID: '318', SYSTEM_PULLREQUEST_TARGETBRANCH: 'refs/heads/main', EZTEST_SHARD: '1/2', EZTEST_HIDE_HOST: '1', TZ: 'Europe/Berlin',
  };
  const context = buildRunContext(run, env, { environmentName: 'staging', workers: 4 });
  await writeFile(join(runDir, 'context.json'), JSON.stringify(context, null, 2));
  const at = run.finishedAt;
  const collectionUrl = 'https://dev.azure.com/contoso';
  const integrations = await recordIntegration(runDir, {
    ado: {
      collectionUrl, project: 'Shop',
      publish: { status: 'partial', reason: '1 test case has no test point in suite 88 (#1204)', at, runId: 4711, runName: `EZTest ${runId}`, planId: 77, suiteId: 88, attachments: 9, warnings: ['test case 1204 has no test point in plan 77 / suite 88'], unmapped: journeys.filter((j) => !j.tags.some((g) => g.includes('TestCaseId'))).map((j) => j.journeyId), missingPoints: [{ journeyId: 'checkout-paypal', testCaseId: 1204 }],
        results: journeys.filter((j) => j.tags.some((g) => g.includes('TestCaseId')) && j.journeyId !== 'checkout-paypal').map((j, i) => ({ journeyId: j.journeyId, testCaseId: Number(j.tags.find((g) => g.includes('TestCaseId'))!.split(':')[1]), resultId: 100000 + i, outcome: j.status === 'failed' ? 'Failed' : j.status === 'skipped' ? 'NotExecuted' : 'Passed' })) },
      bugs: [{ journeyId: 'checkout-card', id: 5521, action: 'created' }, { journeyId: 'checkout-voucher', id: 5521, action: 'deduped' }, { journeyId: 'api-orders', id: 5522, action: 'created' }],
      build: { id: '20931', number: '20261022.4', url: `${collectionUrl}/Shop/_build/results?buildId=20931` },
      requirementsCommented: [{ requirement: '3412', action: 'commented' }],
    },
    pullRequest: { provider: 'azure-devops', number: 318, url: `${collectionUrl}/Shop/_git/shop-web/pullrequest/318`, comment: { action: 'updated', id: 9001 }, status: { kind: 'pr-status', state: 'failed', annotations: 5 }, at },
    jira: { baseUrl: 'https://contoso.atlassian.net', status: 'success', bugs: [{ journeyId: 'account-profile', key: 'SHOP-982', action: 'created' }] },
    notifications: [{ channel: 'teams', ok: true, message: 'posted to Teams', at, title: 'Shop E2E: 5 of 20 tests failed' }, { channel: 'slack', ok: true, message: 'posted to Slack', at }],
    resultsServer: { url: 'https://eztest.contoso.example/ui/p/shop/runs/run-2026-10-22-0800', verified: true, at },
  });
  const owners: Record<string, string[]> = {};
  const files: Record<string, string> = {};
  for (const s of SPECS) {
    files[s.id] = `journeys/${s.suite}/${s.id.replace(/^[a-z]+-/, '')}.ez`;
    owners[s.id] = s.suite === 'checkout' ? ['@contoso/payments'] : s.suite === 'account' ? ['@contoso/identity', 'ada@contoso.example'] : s.suite === 'api' || s.suite === 'data' ? ['@contoso/platform'] : ['@contoso/web'];
  }
  return {
    root, runDir, baselineDir, run, baseline, evidence, history, context, integrations,
    insights: {
      formats: ['html', 'json', 'junit'], triage, readiness, flaky, evidence, history, context, integrations, baseline, owners, files, flakyIds: ['checkout-split', 'search-sort'],
      brand: { name: 'Contoso Shop' }, title: 'Shop web - end-to-end regression', ado: { collectionUrl, project: 'Shop', testPlanId: 77, testSuiteId: 88 },
      requirementsCatalog: [{ id: '3412', title: 'Pay with a saved card' }, { id: '3413', title: 'Guest and wallet checkout' }, { id: '3440', title: 'Gift wrapping' }],
    },
  };
}
