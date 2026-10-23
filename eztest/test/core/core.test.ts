import { describe, it, expect } from '../support/testkit.js';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseJourney,
  safeParseJourney,
  EvidenceVault,
  verifyEvidence,
  interpolate,
  journeyStatusFrom,
  summarize,
  type StepResult,
  type JourneyResult,
} from '../../src/core/index.js';

describe('Journey Model', () => {
  it('parses a journey and applies defaults', () => {
    const j = parseJourney({
      id: 'login',
      name: 'Login',
      steps: [
        { id: 's1', intent: 'Open the app', action: 'navigate', value: '/login' },
        {
          id: 's2',
          intent: 'Click Sign in',
          action: 'click',
          target: { description: 'Sign in button', locators: [{ strategy: 'role', value: 'button', name: 'Sign in' }] },
          postconditions: [{ type: 'urlContains', value: '/dashboard' }],
        },
      ],
    });
    expect(j.tags).toEqual([]);
    expect(j.steps[0].postconditions).toEqual([]);
    expect(j.steps[1].postconditions[0].type).toBe('urlContains');
  });

  it('rejects a journey with no steps and unknown actions', () => {
    expect(safeParseJourney({ id: 'x', name: 'x', steps: [] }).success).toBe(false);
    expect(
      safeParseJourney({ id: 'x', name: 'x', steps: [{ id: 'a', intent: 'a', action: 'teleport' }] }).success,
    ).toBe(false);
  });
});

describe('statuses', () => {
  const step = (status: StepResult['status']): StepResult => ({
    stepId: 's',
    intent: 'i',
    status,
    startedAt: '',
    durationMs: 0,
    conditions: [],
    evidence: [],
  });

  it('healed steps never collapse into a plain pass', () => {
    expect(journeyStatusFrom([step('passed'), step('passed-healed')])).toBe('passed-healed');
    expect(journeyStatusFrom([step('passed'), step('passed')])).toBe('passed');
    expect(journeyStatusFrom([step('passed-healed'), step('failed')])).toBe('failed');
    expect(journeyStatusFrom([])).toBe('error');
  });

  it('summarizes runs', () => {
    const jr = (status: JourneyResult['status']) => ({ status }) as JourneyResult;
    expect(summarize([jr('passed'), jr('passed-healed'), jr('failed'), jr('skipped'), jr('error')])).toEqual({
      total: 5,
      passed: 1,
      passedHealed: 1,
      failed: 1,
      skipped: 1,
      errors: 1,
    });
  });
});

describe('interpolate', () => {
  it('fills variables, defaults and nested keys', () => {
    expect(interpolate('${a}-${b:-x}-${c.d}', { a: 1, c: { d: 'z' } })).toBe('1-x-z');
    expect(interpolate('${missing}', {})).toBe('${missing}');
    expect(() => interpolate('${missing}', {}, { strict: true })).toThrow(/Unknown variable/);
  });
});

describe('EvidenceVault', () => {
  it('builds a verifiable hash chain and detects tampering', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-ev-'));
    const vault = new EvidenceVault(dir);
    await vault.init();
    const a = await vault.store('log', 'logs/a.txt', 'hello', { stepId: 's1' });
    await vault.store('data', 'data/b.json', '{"x":1}');
    expect(a.id).toBe('E-1');

    const ok = await verifyEvidence(dir);
    expect(ok.ok).toBe(true);
    expect(ok.entries).toBe(2);
    expect(ok.head).toBe(vault.headHash);

    await writeFile(join(dir, 'logs/a.txt'), 'tampered');
    const bad = await verifyEvidence(dir);
    expect(bad.ok).toBe(false);
    expect(bad.problems.join(' ')).toMatch(/content altered/);
  });

  it('detects edited manifest metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-ev-'));
    const vault = new EvidenceVault(dir);
    await vault.init();
    await vault.store('log', 'a.txt', 'one');
    const manifest = join(dir, 'evidence-manifest.jsonl');
    const txt = await readFile(manifest, 'utf8');
    await writeFile(manifest, txt.replace('"kind":"log"', '"kind":"data"'));
    const res = await verifyEvidence(dir);
    expect(res.ok).toBe(false);
  });

  it('refuses paths outside the run directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-ev-'));
    const vault = new EvidenceVault(dir);
    await vault.init();
    await expect(vault.store('log', '../escape.txt', 'x')).rejects.toThrow(/escapes/);
  });
});

describe('interpolate escapes', () => {
  it('keeps $${name} as a literal ${name}', () => {
    expect(interpolate('a $${later} b ${now}', { now: 1 }, { strict: true })).toBe('a ${later} b 1');
  });
});
