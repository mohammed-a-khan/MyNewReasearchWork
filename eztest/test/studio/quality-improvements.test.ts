/**
 * Heal review inbox: "improvement" items (a verified, more robust locator the
 * runner found for a passing step with a weak target) are listed next to heals,
 * previewed as a diff, and only written when a reviewer accepts them.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EvidenceVault, summarize, type JourneyResult, type RunResult } from '../../src/core/index.js';
import { HealDecisions } from '../../src/heal/index.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { client, copyShopProject } from './helpers.js';

const ORDER = 'create-an-order-and-verify-the-invoice-three-ways';
const SUBMIT = 'click-the-submit-order-button';
const suggested = { strategy: 'testId' as const, value: 'submit-order' };

let studio: StudioHandle;
let project: string;
let c: ReturnType<typeof client>;

async function fabricate(runId: string, startedAt: string): Promise<void> {
  const dir = join(project, 'eztest-results', runId);
  const vault = new EvidenceVault(dir);
  await vault.init();
  const results: JourneyResult[] = [{
    journeyId: ORDER, name: 'Create an order', status: 'passed', startedAt, durationMs: 1000, tags: [], requirements: [], risk: 3, attempt: 1, ledger: {}, evidence: [],
    steps: [{
      stepId: SUBMIT, intent: 'Click the "Submit order" button', status: 'passed', startedAt, durationMs: 200, conditions: [], evidence: [],
      usedLocator: { strategy: 'xpath', value: "//form/div[3]/button[1]" },
      improvement: { suggested, score: 95, currentScore: 20, reason: 'testId="submit-order" (score 95) selects the same single element as the current target (score 20)' },
    }],
  }];
  const run: RunResult = { runId, startedAt, finishedAt: startedAt, durationMs: 1000, journeys: results, summary: summarize(results), environment: {} };
  await writeFile(join(dir, 'run.json'), JSON.stringify(run, null, 2));
}

beforeAll(async () => {
  project = await copyShopProject();
  await fabricate('run-20261101-000000-aaaaaa', '2026-11-01T00:00:00.000Z');
  await fabricate('run-20261102-000000-bbbbbb', '2026-11-02T00:00:00.000Z');
  studio = await startStudio({ cwd: project, env: { SHOP_URL: 'http://127.0.0.1:9' }, watch: false });
  c = client(studio.port, studio.token);
});

afterAll(async () => {
  await studio?.close();
});

const item = { journeyId: ORDER, stepId: SUBMIT, healed: suggested, tier: 'improvement', runId: 'run-20261102-000000-bbbbbb' };

describe('improvement proposals in the heal inbox', () => {
  it('lists improvements (deduplicated across runs) with their locator scores, pending review', async () => {
    const r = (await c.get('/api/quality/heals')).json();
    const imp = r.items.find((i: { kind?: string }) => i.kind === 'improvement');
    expect(imp).toMatchObject({ journeyId: ORDER, stepId: SUBMIT, tier: 'improvement', status: 'pending', runCount: 2, healed: suggested, locatorScore: { current: 20, suggested: 95 } });
    const journey = await readFile(join(project, 'journeys/create-order.ez'), 'utf8');
    expect(journey).not.toContain('submit-order'); // nothing applied without review
  });

  it('previews and writes the better locator only when accepted', async () => {
    const p = (await c.post('/api/quality/heals/preview', { items: [item] })).json();
    expect(p.errors).toEqual([]);
    expect(p.files[0].diff.some((l: { kind: string; text: string }) => l.kind === '+' && l.text.includes('submit-order'))).toBe(true);
    const ok = await c.post('/api/quality/heals/accept', { items: [item], reviewer: 'Ann', expected: { [p.files[0].path]: p.files[0].beforeHash }, confirm: true });
    expect(ok.status, ok.body).toBe(200);
    expect(await readFile(join(project, p.files[0].path), 'utf8')).toContain('submit-order');
    const decisions = await HealDecisions.open(join(project, '.eztest', 'heal-decisions.json'));
    expect(decisions.list()).toEqual([expect.objectContaining({ tier: 'improvement', decision: 'accepted', reviewer: 'Ann' })]);
  });

  it('can be rejected (and is then not offered as pending again)', async () => {
    const other = { ...item, healed: { strategy: 'label', value: 'Submit' } };
    const rej = await c.post('/api/quality/heals/reject', { items: [other], reviewer: 'Bo', reason: 'labels are translated', confirm: true });
    expect(rej.status, rej.body).toBe(200);
    const decisions = await HealDecisions.open(join(project, '.eztest', 'heal-decisions.json'));
    expect(decisions.list().some((d) => d.tier === 'improvement' && d.decision === 'rejected')).toBe(true);
  });
});
