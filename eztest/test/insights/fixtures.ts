/**
 * Realistic run fixtures: a run directory produced through the real
 * EvidenceVault (hash-chained manifest), real PNG screenshots and network logs.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import {
  EvidenceVault,
  summarize,
  type EvidenceRef,
  type JourneyResult,
  type RunResult,
  type StepResult,
} from '../../src/core/index.js';

export function solidPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = rgb[0];
    png.data[i * 4 + 1] = rgb[1];
    png.data[i * 4 + 2] = rgb[2];
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

export interface Fixture {
  runDir: string;
  run: RunResult;
  evidence: EvidenceRef[];
  ids: Record<string, string>;
}

const t0 = Date.parse('2026-10-20T10:00:00Z');
const iso = (offsetMs: number) => new Date(t0 + offsetMs).toISOString();

function step(p: Partial<StepResult> & Pick<StepResult, 'stepId' | 'intent' | 'status'>): StepResult {
  return { startedAt: iso(0), durationMs: 120, conditions: [], evidence: [], ...p };
}

export async function makeRunFixture(): Promise<Fixture> {
  const runDir = await mkdtemp(join(tmpdir(), 'eztest-run-'));
  const vault = new EvidenceVault(runDir);
  await vault.init();
  const ids: Record<string, string> = {};
  const shot = async (key: string, journeyId: string, stepId: string, color: [number, number, number]) => {
    const r = await vault.store('screenshot', `screenshots/${journeyId}-${stepId}.png`, solidPng(40, 30, color), { journeyId, stepId, description: `after ${stepId}` });
    ids[key] = r.id;
    return r.id;
  };
  const login1 = await shot('login.s1', 'login', 's1', [200, 200, 255]);
  const login2 = await shot('login.s2', 'login', 's2', [180, 255, 180]);
  const order3 = await shot('order.s3', 'create-order', 's3', [255, 255, 180]);
  const healEv = (await vault.store('dom', 'dom/create-order-s3.html', '<button id="place-order">Place order</button>', { journeyId: 'create-order', stepId: 's3' })).id;
  ids['order.heal'] = healEv;
  const checkout2 = await shot('checkout.s2', 'checkout', 's2', [255, 180, 180]);
  const checkoutNet = (
    await vault.store(
      'network',
      'network/checkout.json',
      JSON.stringify([
        { method: 'GET', url: 'http://127.0.0.1:4600/orders/new', status: 200, timing: 35 },
        { method: 'POST', url: 'http://127.0.0.1:4600/api/orders?access_token=SECRET123', status: 500, timing: 80, responseBody: '{"error":"boom"}' },
      ]),
      { journeyId: 'checkout', description: 'network log' },
    )
  ).id;
  ids['checkout.net'] = checkoutNet;
  const search1 = await shot('search.s1', 'search', 's1', [220, 220, 220]);
  const reports1 = await shot('reports.s1', 'reports', 's1', [10, 10, 10]);
  const import1 = await shot('import.s1', 'data-import', 's1', [100, 100, 100]);
  const xss = await shot('xss.s1', 'xss<script>', 's1', [1, 2, 3]);

  const journeys: JourneyResult[] = [
    {
      journeyId: 'login',
      name: 'Sign in as manager',
      status: 'passed',
      startedAt: iso(0),
      durationMs: 900,
      tags: ['@critical', '@auth', '@TestCaseId:101'],
      requirements: ['REQ-1'],
      risk: 5,
      attempt: 1,
      ledger: {},
      evidence: [login1, login2],
      steps: [
        step({ stepId: 's1', intent: 'Open /login', status: 'passed', evidence: [login1] }),
        step({
          stepId: 's2',
          intent: 'Click "Sign in"',
          status: 'passed',
          evidence: [login2],
          usedLocator: { strategy: 'role', value: 'button', name: 'Sign in' },
          conditions: [{ condition: { type: 'urlContains', value: '/dashboard' }, passed: true, actual: 'http://x/dashboard' }],
        }),
      ],
    },
    {
      journeyId: 'create-order',
      name: 'Create an order',
      status: 'passed-healed',
      startedAt: iso(1000),
      durationMs: 1500,
      tags: ['@orders', '@TestCaseId:{102,103}'],
      requirements: ['REQ-2'],
      risk: 4,
      attempt: 1,
      ledger: { orderId: 7 },
      evidence: [order3, healEv],
      steps: [
        step({ stepId: 's1', intent: 'Open new order', status: 'passed' }),
        step({ stepId: 's2', intent: 'Fill quantity', status: 'passed' }),
        step({
          stepId: 's3',
          intent: 'Click "Submit order"',
          status: 'passed-healed',
          evidence: [order3],
          usedLocator: { strategy: 'css', value: '#place-order' },
          conditions: [{ condition: { type: 'pageContainsText', value: 'created' }, passed: true }],
          heal: {
            stepId: 's3',
            tier: 'T1-fingerprint',
            original: [{ strategy: 'css', value: '#submit-order' }],
            healed: { strategy: 'css', value: '#place-order' },
            confidence: 0.92,
            verified: true,
            reason: 'fingerprint match on role+form position',
            evidence: [healEv],
          },
        }),
      ],
    },
    {
      journeyId: 'checkout',
      name: 'Checkout totals',
      status: 'failed',
      startedAt: iso(3000),
      durationMs: 2100,
      tags: ['@orders', '@critical', '@TestCaseId:104'],
      requirements: ['REQ-3'],
      risk: 5,
      attempt: 1,
      ledger: {},
      evidence: [checkout2, checkoutNet],
      steps: [
        step({ stepId: 's1', intent: 'Open order', status: 'passed' }),
        step({
          stepId: 's2',
          intent: 'Click "Submit order"',
          status: 'failed',
          evidence: [checkout2],
          usedLocator: { strategy: 'role', value: 'button', name: 'Submit order' },
          conditions: [{ condition: { type: 'pageContainsText', value: 'Order ORD-' }, passed: false, actual: 'New order form' }],
          error: { message: 'Post-condition failed: page does not contain "Order ORD-" after 5000ms', name: 'PostConditionError' },
        }),
        step({ stepId: 's3', intent: 'Download invoice', status: 'skipped' }),
      ],
    },
    {
      journeyId: 'search',
      name: 'Search orders',
      status: 'failed',
      startedAt: iso(6000),
      durationMs: 5200,
      tags: ['@search'],
      requirements: [],
      risk: 2,
      attempt: 2,
      ledger: {},
      evidence: [search1],
      steps: [
        step({
          stepId: 's1',
          intent: 'Type in search box',
          status: 'failed',
          evidence: [search1],
          error: { message: "locator.fill: Timeout 5000ms exceeded.\nwaiting for getByRole('searchbox')", name: 'TimeoutError', stack: 'TimeoutError: x\n    at fillStep (/app/src/runner/actions.ts:10:5)\n    at runStep (/app/src/runner/run.ts:99:3)' },
          heal: {
            stepId: 's1',
            tier: 'T2-semantic',
            original: [{ strategy: 'role', value: 'searchbox' }],
            healed: { strategy: 'css', value: 'input.q' },
            confidence: 0.55,
            verified: false,
            reason: 'semantic candidate',
            evidence: [search1, 'E-999'],
          },
        }),
      ],
    },
    {
      journeyId: 'reports',
      name: 'Reports page',
      status: 'failed',
      startedAt: iso(12000),
      durationMs: 30000,
      tags: ['@reports'],
      requirements: ['REQ-4'],
      risk: 3,
      attempt: 1,
      ledger: {},
      evidence: [reports1],
      steps: [
        step({ stepId: 's1', intent: 'Open reports', status: 'failed', evidence: [reports1], error: { message: 'page.goto: net::ERR_NAME_NOT_RESOLVED at https://reports.internal.example/r/123', name: 'Error' } }),
      ],
    },
    {
      journeyId: 'data-import',
      name: 'Import customers',
      status: 'failed',
      startedAt: iso(45000),
      durationMs: 400,
      tags: ['@data'],
      requirements: [],
      risk: 2,
      attempt: 1,
      ledger: {},
      evidence: [import1],
      steps: [
        step({ stepId: 's1', intent: 'Insert customer', status: 'failed', evidence: [import1], error: { message: 'SqliteError: UNIQUE constraint failed: customers.email (row 17)' } }),
      ],
    },
    {
      journeyId: 'xss<script>',
      name: '<img src=x onerror=alert(1)> journey',
      status: 'passed',
      startedAt: iso(46000),
      durationMs: 100,
      tags: ['@misc'],
      requirements: [],
      risk: 1,
      attempt: 1,
      ledger: {},
      evidence: [xss],
      steps: [step({ stepId: 's1', intent: '"><script>alert(1)</script>', status: 'passed', evidence: [xss] })],
    },
    {
      journeyId: 'later',
      name: 'Deferred journey',
      status: 'skipped',
      startedAt: iso(47000),
      durationMs: 0,
      tags: [],
      requirements: [],
      risk: 1,
      attempt: 1,
      ledger: {},
      evidence: [],
      steps: [step({ stepId: 's1', intent: 'Nothing', status: 'skipped' })],
    },
  ];
  const run: RunResult = {
    runId: 'run-2026-10-20-001',
    startedAt: iso(0),
    finishedAt: iso(48000),
    durationMs: 48000,
    journeys,
    summary: summarize(journeys),
    environment: { baseUrl: 'http://127.0.0.1:4600', browser: 'chromium' },
    evidenceHead: vault.headHash,
  };
  await writeFile(join(runDir, 'run.json'), JSON.stringify(run, null, 2));
  const evidence: EvidenceRef[] = vault.entries.map(({ seq: _q, prevHash: _p, entryHash: _e, ...r }) => r);
  return { runDir, run, evidence, ids };
}
