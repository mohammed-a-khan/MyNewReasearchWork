import { describe, expect, it } from '../support/testkit.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { initProject } from '../../src/cli/init.js';
import { loadConfig } from '../../src/config/index.js';
import { tempDir } from '../runner/fixtures.js';

describe('eztest init CI templates', () => {
  it('GitHub Actions: plan a duration-balanced matrix, run shards, merge, verify and publish', async () => {
    const dir = await tempDir('init-gh');
    await initProject(dir, { ci: 'github' });
    const wf = parse(await readFile(join(dir, '.github/workflows/eztest.yml'), 'utf8'));
    expect(Object.keys(wf.jobs)).toEqual(['plan', 'test', 'merge']);
    const steps = (job: string) => wf.jobs[job].steps.map((s: { run?: string }) => s.run ?? '').join('\n');
    expect(steps('plan')).toMatch(/eztest ci matrix --shards auto/);
    expect(wf.jobs.test.strategy.matrix).toBe('${{ fromJSON(needs.plan.outputs.matrix) }}');
    expect(steps('test')).toMatch(/eztest run --shard \$\{\{ matrix.shard \}\}/);
    expect(steps('merge')).toMatch(/eztest merge shards -o eztest-results\/merged/);
    expect(steps('merge')).toMatch(/eztest evidence verify/);
    expect(steps('merge')).toMatch(/eztest publish eztest-results\/merged/);
    // The generated config loads and is stamped with its schema version.
    expect((await loadConfig({ cwd: dir, environment: {} })).config.configVersion).toBe(1);
  });

  it('Azure Pipelines: the same flow with an output-variable matrix', async () => {
    const dir = await tempDir('init-az');
    await initProject(dir, { ci: 'azure' });
    const p = parse(await readFile(join(dir, 'azure-pipelines.yml'), 'utf8'));
    expect(p.jobs.map((j: { job: string }) => j.job)).toEqual(['plan', 'test', 'merge']);
    expect(p.jobs[1].strategy.matrix).toBe("$[ dependencies.plan.outputs['m.matrix'] ]");
    expect(JSON.stringify(p.jobs[2].steps)).toMatch(/eztest merge shards.*eztest publish/);
  });
});
