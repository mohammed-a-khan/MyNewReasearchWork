/**
 * EZTest has no AI tier: old configurations that still name one load, with a
 * clear warning per key, and the results server no longer accepts "T3-ai".
 */
import { afterAll, describe, expect, it } from '../support/testkit.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/index.js';
import { HealDecisions } from '../../src/heal/index.js';
import { tempDir } from '../runner/fixtures.js';
import { startTestServer, type TestServer } from '../server/helpers.js';

let server: TestServer | undefined;
afterAll(async () => server?.close());

describe('old configs with AI settings', () => {
  it('healing.maxTier: T3-ai, healing.allowAI and ai: load with a warning each; the heal tier becomes T2-semantic', async () => {
    const dir = await tempDir('legacy-ai');
    await writeFile(join(dir, 'eztest.config.yaml'), 'healing:\n  maxTier: T3-ai\n  allowAI: true\nai:\n  model: some-model\n');
    const loaded = await loadConfig({ cwd: dir, environment: {} });
    expect(loaded.config.healing.maxTier).toBe('T2-semantic');
    expect(loaded.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/"healing\.allowAI" is no longer supported and was ignored: EZTest has no AI healing/),
      expect.stringMatching(/"healing\.maxTier: T3-ai" is no longer supported and was ignored: the AI tier was removed; T2-semantic/),
      expect.stringMatching(/"ai" is no longer supported and was ignored: EZTest uses no AI provider/),
    ]));
    expect(loaded.warnings.some((w) => /Unknown configuration key/.test(w))).toBe(false);
  });

  it('EZTEST_AI__MODEL in the environment is ignored with the same warning, not an error', async () => {
    const dir = await tempDir('legacy-ai-env');
    await writeFile(join(dir, 'eztest.config.yaml'), 'baseUrl: http://localhost:3000\n');
    const loaded = await loadConfig({ cwd: dir, environment: { EZTEST_AI__MODEL: 'x' } });
    expect([...loaded.warnings, ...(loaded.envWarnings ?? [])].join("\n")).toMatch(/"ai" is no longer supported and was ignored: EZTest uses no AI provider/);
    expect((loaded.config as Record<string, unknown>).ai).toBeUndefined();
  });

  it('the results server rejects a heal decision with the removed T3-ai tier', async () => {
    server = await startTestServer();
    const approver = await server.token('rita', [{ project: 'payments', role: 'approver' }]);
    const decision = { journeyId: 'j', stepId: 's', decision: 'accepted', locator: { strategy: 'role', value: 'button', name: 'Go' }, reviewer: 'Rita', decidedAt: '2026-10-22T00:00:00Z' };
    const bad = await server.req('POST', '/api/projects/payments/state/heal-decisions', { token: approver, body: { upsert: [{ ...decision, tier: 'T3-ai' }] } });
    expect(bad.status).toBe(400);
    expect(bad.text).toMatch(/Unknown heal tier \(one of T0-cache, T1-fingerprint, T2-semantic\)/);
    const ok = await server.req('POST', '/api/projects/payments/state/heal-decisions', { token: approver, body: { upsert: [{ ...decision, tier: 'T2-semantic' }] } });
    expect(ok.status).toBe(200);
  });

  it('an old heal-decisions.json with T3-ai decisions still loads; those decisions are dropped', async () => {
    const dir = await tempDir('legacy-ai-decisions');
    const d = (tier: string) => ({ journeyId: 'j', stepId: 's', decision: 'rejected', tier, locator: { strategy: 'css', value: `#${tier}` }, reviewer: 'r', decidedAt: '2026-01-01T00:00:00Z' });
    await writeFile(join(dir, 'heal-decisions.json'), JSON.stringify({ version: 1, decisions: [d('T3-ai'), d('T1-fingerprint')] }));
    const decisions = await HealDecisions.open(join(dir, 'heal-decisions.json'));
    expect(decisions.list().map((x) => x.tier)).toEqual(['T1-fingerprint']);
  });
});
