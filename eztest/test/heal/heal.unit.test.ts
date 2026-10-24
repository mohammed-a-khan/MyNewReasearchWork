import { describe, expect, it } from '../support/testkit.js';
import { join } from 'node:path';
import { type ElementFingerprint, type RunResult } from '../../src/core/index.js';
import {
  FingerprintStore, HEAL_TIERS, collectHealProposals, createHealer, jaccard, jaroWinkler, pickBest, poolSelector,
  promoteVerifiedHeals, resolveHealPolicy, robustCandidates, scoreFingerprint, textSimilarity, tokenOverlap,
} from '../../src/heal/index.js';
import { tempDir } from '../runner/fixtures.js';

const signIn: ElementFingerprint = {
  tag: 'button', role: 'button', name: 'Sign in', text: 'Sign in', id: 'login-btn', classes: ['btn', 'primary'],
  attributes: { type: 'submit' }, path: 'main > form#login-form > p', box: { x: 40, y: 200, width: 60, height: 22 },
};
const logIn: ElementFingerprint = { ...signIn, name: 'Log in', text: 'Log in', id: 'signin-button', box: { x: 40, y: 200, width: 54, height: 22 } };
const navLink: ElementFingerprint = {
  tag: 'a', role: 'link', name: 'Sign out', text: 'Sign out', attributes: { href: '/logout' }, path: 'header > nav', box: { x: 200, y: 10, width: 50, height: 18 },
};

describe('similarity primitives', () => {
  it('jaro-winkler matches the classic reference values', () => {
    expect(jaroWinkler('MARTHA', 'MARHTA')).toBeCloseTo(0.961, 3);
    expect(jaroWinkler('DWAYNE', 'DUANE')).toBeCloseTo(0.84, 2);
    expect(jaroWinkler('', 'x')).toBe(0);
    expect(jaroWinkler('same', 'same')).toBe(1);
  });
  it('token overlap, text similarity and jaccard', () => {
    expect(tokenOverlap('Submit order', 'Place order')).toBeCloseTo(0.5);
    expect(tokenOverlap('submitOrder', 'submit-order')).toBe(1);
    expect(textSimilarity('Sign in', 'sign  IN')).toBe(1);
    expect(textSimilarity(undefined, 'x')).toBe(0);
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3);
    expect(jaccard([], [])).toBe(0);
  });
});

describe('fingerprint scorer', () => {
  it('an identical element scores 1', () => {
    expect(scoreFingerprint(signIn, signIn).score).toBeCloseTo(1);
  });
  it('a renamed button in the same place clears the 0.72 threshold; an unrelated link does not', () => {
    const renamed = scoreFingerprint(signIn, logIn);
    const other = scoreFingerprint(signIn, navLink);
    expect(renamed.score).toBeGreaterThanOrEqual(0.72);
    expect(other.score).toBeLessThan(0.4);
    expect(renamed.breakdown.classes).toBe(1);
    expect(renamed.breakdown.attributes).toBe(1);
    expect(renamed.breakdown.id).toBeLessThan(1);
  });
  it('only features present in the stored fingerprint count', () => {
    const sparse: ElementFingerprint = { testId: 'order-number' };
    expect(scoreFingerprint(sparse, { testId: 'order-number', tag: 'span' }).score).toBe(1);
    expect(Object.keys(scoreFingerprint(sparse, { tag: 'span' }).breakdown)).toEqual(['testId']);
  });
});

describe('pickBest: threshold and margin rule', () => {
  it('accepts a clear winner', () => {
    const r = pickBest([{ item: 'a', score: 0.9 }, { item: 'b', score: 0.5 }], 0.72, 0.08);
    expect(r.ok && r.best.item).toBe('a');
  });
  it('refuses an ambiguous near-tie even above threshold', () => {
    const r = pickBest([{ item: 'a', score: 0.86 }, { item: 'b', score: 0.81 }], 0.72, 0.08);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/ambiguous/);
  });
  it('refuses a winner below threshold, and empty input', () => {
    expect(pickBest([{ item: 'a', score: 0.7 }], 0.72, 0.08).ok).toBe(false);
    expect(pickBest([], 0.72, 0.08).ok).toBe(false);
  });
  it('a single candidate above threshold is accepted', () => {
    expect(pickBest([{ item: 'a', score: 0.8 }], 0.72, 0.08).ok).toBe(true);
  });
});

describe('heal policy and helpers', () => {
  it('there is no AI tier: the ladder is T0-T2, and "T3-ai" is an unknown tier', () => {
    expect(HEAL_TIERS).toEqual(['T0-cache', 'T1-fingerprint', 'T2-semantic']);
    expect(() => createHealer({ maxTier: 'T3-ai' as never })).toThrow(/Unknown heal tier T3-ai \(tiers: T0-cache, T1-fingerprint, T2-semantic\)/);
    expect(Object.keys(resolveHealPolicy())).not.toContain('allowAI');
    expect(() => resolveHealPolicy({ margin: 2 })).toThrow(/between 0 and 1/);
    expect(resolveHealPolicy()).toMatchObject({ enabled: true, maxTier: 'T2-semantic', threshold: 0.72, margin: 0.08 });
  });
  it('robust locators prefer role+name, then label, testId, id', () => {
    const c = robustCandidates({ role: 'textbox', name: 'Email or username', label: 'Email or username', testId: 'username', id: 'username', tag: 'input' });
    expect(c.map((x) => x.strategy)).toEqual(['role', 'label', 'testId', 'css']);
    expect(c[3].value).toBe('#username');
    expect(robustCandidates({ id: '1bad id' })[0].value).toBe('[id="1bad id"]');
  });
  it('candidate pools follow role families, then the action', () => {
    expect(poolSelector({ role: 'button', action: 'click' })).toContain('a[href]');
    expect(poolSelector({ role: 'textbox', action: 'fill' })).toContain('textarea');
    expect(poolSelector({ action: 'select' })).toContain('select');
    expect(poolSelector({ action: 'hover' })).toBeUndefined();
  });
});

describe('fingerprint store and proposals', () => {
  it('persists fingerprints, last-good locators and promoted heals', async () => {
    const path = join(await tempDir('store'), 'nested', 'fp.json');
    const s = await FingerprintStore.open(path);
    s.recordSuccess('j', 's1', signIn, { strategy: 'role', value: 'button', name: 'Sign in' });
    await s.save();
    const run: Pick<RunResult, 'runId' | 'journeys'> = {
      runId: 'r1',
      journeys: [{
        journeyId: 'j', name: 'J', status: 'passed-healed', startedAt: '', durationMs: 0, tags: [], requirements: [], risk: 3, attempt: 1, ledger: {}, evidence: [],
        steps: [
          { stepId: 's1', intent: 'Click', status: 'passed-healed', startedAt: '', durationMs: 0, conditions: [], evidence: ['E-1'],
            heal: { stepId: 's1', tier: 'T1-fingerprint', original: [{ strategy: 'role', value: 'button', name: 'Sign in' }], healed: { strategy: 'role', value: 'button', name: 'Log in' }, confidence: 0.8, verified: true, reason: 'x', evidence: ['E-1'] } },
          { stepId: 's2', intent: 'Click 2', status: 'failed', startedAt: '', durationMs: 0, conditions: [], evidence: [],
            heal: { stepId: 's2', tier: 'T2-semantic', original: [], healed: { strategy: 'text', value: 'Go' }, confidence: 0.7, verified: false, reason: 'y', evidence: [] } },
        ],
      }],
    };
    const file = collectHealProposals(run);
    expect(file.proposals.map((p) => p.stepId)).toEqual(['s1']);
    expect(file.rejected.map((p) => p.stepId)).toEqual(['s2']);
    expect(promoteVerifiedHeals(s, file)).toBe(1);
    await s.save();
    const again = await FingerprintStore.open(path);
    expect(again.get('j', 's1')?.fingerprint?.id).toBe('login-btn');
    expect(again.get('j', 's1')?.healed?.locator).toEqual({ strategy: 'role', value: 'button', name: 'Log in' });
    expect(again.get('j', 's2')).toBeUndefined();
  });
});
