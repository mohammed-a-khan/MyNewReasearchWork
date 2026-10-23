/** Run-level reliability for native journeys (a fake platform driver; no browser, no device). */
import { describe, expect, it } from '../support/testkit.js';
import type { Journey, JourneyResult } from '../../src/core/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys, type PlatformDriver } from '../../src/runner/index.js';
import { tempDir } from '../runner/fixtures.js';

function fakeDriver(behaviour: (j: Journey, attempt: number) => Partial<JourneyResult>): PlatformDriver & { seen: Journey[] } {
  const seen: Journey[] = [];
  return {
    name: 'fake-mobile', platforms: ['android'], seen,
    async runAttempt(j, attempt) {
      seen.push(j);
      const b = behaviour(j, attempt);
      return {
        journeyId: j.id, name: j.name, status: 'passed', startedAt: new Date().toISOString(), durationMs: 1, tags: j.tags, requirements: j.requirements, risk: j.risk,
        attempt, browser: 'android', ledger: {}, evidence: [], steps: j.steps.map((s) => ({ stepId: s.id, intent: s.intent, status: 'passed', startedAt: '', durationMs: 0, conditions: [], evidence: [] })),
        ...b,
      } as JourneyResult;
    },
  };
}

const native = (id: string, extra = '') => parseEzScript(`Journey: ${id}\nId: ${id}\nPlatform: android\n${extra}Tap the "Go" button\n`);

describe('native journeys get dependencies, retries with flake causes, and the circuit breaker', () => {
  it('orders prerequisites, hands values over as variables, classifies a retried failure', async () => {
    const d = fakeDriver((j, attempt) => {
      if (j.id === 'login') return { ledger: { orderNumber: 'ORD-7', cart: { n: 2 } } };
      if (j.id === 'flaky' && attempt === 1) return { status: 'failed', steps: [{ stepId: 's', intent: 'x', status: 'failed', startedAt: '', durationMs: 0, conditions: [], evidence: [], error: { message: 'the "Go" button is covered by <android.widget.FrameLayout> (an overlay)' } }] };
      return {};
    });
    const r = await runJourneys([native('uses', 'Depends on: login with orderNumber, cart\n'), native('login', 'Returns: orderNumber\n'), native('flaky')], {
      outputDir: await tempDir('native'), platformDrivers: [d], retries: 1,
    });
    const by = Object.fromEntries(r.journeys.map((j) => [j.journeyId, j]));
    expect(d.seen.findIndex((j) => j.id === 'login')).toBeLessThan(d.seen.findIndex((j) => j.id === 'uses'));
    expect(d.seen.find((j) => j.id === 'uses')?.variables).toMatchObject({ orderNumber: 'ORD-7', cart: '{"n":2}' });
    expect(by.uses.reliability?.dependsOn).toEqual([{ journeyId: 'login', status: 'passed', handoff: ['orderNumber', 'cart'] }]);
    expect(by.flaky).toMatchObject({ status: 'passed', attempt: 2, reliability: { flake: { cause: 'overlay' } } });
  });

  it('environment failures on devices open the circuit breaker', async () => {
    const d = fakeDriver(() => ({ status: 'error', error: { message: 'session not created: connect ECONNREFUSED 127.0.0.1:4723' } }));
    const r = await runJourneys(['a', 'b', 'c', 'd'].map((id) => native(id)), {
      outputDir: await tempDir('native-cb'), platformDrivers: [d], circuitBreaker: { threshold: 2 },
    });
    expect(r.journeys.map((j) => j.status)).toEqual(['error', 'error', 'skipped', 'skipped']);
    expect(r.journeys[0].reliability?.environment?.reason).toMatch(/connection refused/);
    expect(r.journeys[2].error?.message).toMatch(/^not run: environment unavailable/);
    expect(d.seen).toHaveLength(2);
  });
});
