import { describe, expect, it } from '../support/testkit.js';
import { mkdtemp, readFile, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceVault, summarize, verifyEvidence, type JourneyResult, type RunResult } from '../../src/core/index.js';
import { analyzeRun } from '../../src/engine/index.js';
import { expandRunDirs, mergeRuns, verifyMergedRun } from '../../src/scale/index.js';
import { buildProgram, type CliIO } from '../../src/cli/program.js';
import { fakeShardRun } from './fixtures-run.js';

function cli(cwd: string): CliIO & { lines: string[]; errs: string[] } {
  const lines: string[] = [];
  const errs: string[] = [];
  return { out: (s) => lines.push(s), err: (s) => errs.push(s), cwd, env: {}, lines, errs };
}

describe('eztest merge', () => {
  it('re-chains every shard artifact into one verifiable chain linked to each shard chain', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-merge-'));
    const s1 = await fakeShardRun(join(dir, 'a'), 'run-shard-1', [{ id: 'login', status: 'passed' }, { id: 'search', status: 'passed' }], '2026-10-22T10:00:00.000Z');
    const s2 = await fakeShardRun(join(dir, 'b'), 'run-shard-2', [{ id: 'checkout', status: 'failed' }], '2026-10-22T10:00:01.000Z');
    const out = join(dir, 'merged');
    const r = await mergeRuns([s2, s1], out, { runId: 'run-merged' });
    expect(r.run.journeys.map((j) => j.journeyId)).toEqual(['login', 'search', 'checkout']); // shards ordered by start
    expect(r.run.summary).toMatchObject({ total: 3, passed: 2, failed: 1 });
    expect(r.run.environment.shards).toBe('run-shard-1,run-shard-2');
    // Evidence ids are remapped into the merged chain and resolve there.
    const own = await verifyEvidence(out);
    expect(own.ok).toBe(true);
    expect(own.entries).toBe(3 * 2 + 2 * 2); // 6 artifacts + per shard: its manifest and its chain link
    const manifest = (await readFile(join(out, 'evidence-manifest.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { id: string; path: string });
    const checkout = r.run.journeys.find((j) => j.journeyId === 'checkout')!;
    const shotPath = manifest.find((m) => m.id === checkout.steps[0].evidence[0])!.path;
    expect(shotPath).toBe('shards/run-shard-2/checkout/step-1.png');
    expect(r.run.evidenceHead).toBe(own.head);

    const v = await verifyMergedRun(out);
    expect(v.ok).toBe(true);
    expect(v.shards.map((s) => [s.shardRunId, s.ok, s.linked])).toEqual([['run-shard-1', true, true], ['run-shard-2', true, true]]);
    const link = JSON.parse(await readFile(join(out, 'shards/run-shard-1/chain-link.json'), 'utf8')) as { shardEvidenceHead: string };
    expect(link.shardEvidenceHead).toBe((await verifyEvidence(s1)).head);

    // Combined reports, history, triage from the merged run.
    const a = await analyzeRun(out, { historyPath: join(dir, '.eztest/history.json'), formats: ['html', 'json', 'junit'] });
    expect(a.triage.verdicts.map((x) => x.journeyId)).toEqual(['checkout']);
    expect(existsSync(join(out, 'report.html'))).toBe(true);
    const hist = JSON.parse(await readFile(join(dir, '.eztest/history.json'), 'utf8')) as { runs: Array<{ runId: string; outcomes: unknown[] }> };
    expect(hist.runs.map((x) => [x.runId, x.outcomes.length])).toEqual([['run-merged', 3]]);
  });

  it('detects tampering with a shard after the merge (both chains and the link)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-merge-t-'));
    const s1 = await fakeShardRun(join(dir, 'a'), 'run-x-1', [{ id: 'a1', status: 'passed' }], '2026-10-22T10:00:00.000Z');
    const s2 = await fakeShardRun(join(dir, 'b'), 'run-x-2', [{ id: 'b1', status: 'passed' }], '2026-10-22T10:00:00.500Z');
    const out = join(dir, 'm');
    await mergeRuns([s1, s2], out);
    await writeFile(join(out, 'shards/run-x-2/b1/step-1.png'), 'forged');
    const v = await verifyMergedRun(out);
    expect(v.ok).toBe(false);
    expect(v.problems.join('\n')).toMatch(/content altered shards\/run-x-2\/b1\/step-1.png/);
    expect(v.problems.join('\n')).toMatch(/shard run-x-2: entry E-1: file content altered/);
    // Appending a forged entry to a shard manifest breaks the link even if the shard chain itself re-verifies.
    const dir2 = await mkdtemp(join(tmpdir(), 'ez-merge-t2-'));
    const t1 = await fakeShardRun(join(dir2, 'a'), 'run-y-1', [{ id: 'a1', status: 'passed' }], '2026-10-22T10:00:00.000Z');
    const out2 = join(dir2, 'm');
    await mergeRuns([t1], out2);
    const shard = await EvidenceVault.resume(join(out2, 'shards/run-y-1'));
    await shard.store('log', 'extra.txt', 'added later');
    const v2 = await verifyMergedRun(out2);
    expect(v2.ok).toBe(false);
    expect(v2.problems.join('\n')).toMatch(/does not match the merged link/);
  });

  it('refuses to merge a shard whose evidence does not verify (unless allowed), and finds run dirs inside CI artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-merge-u-'));
    const s1 = await fakeShardRun(join(dir, 'artifact-1', 'eztest-results'), 'run-u-1', [{ id: 'a', status: 'passed' }], '2026-10-22T10:00:00.000Z');
    await appendFile(join(s1, 'a/step-1.html'), 'x');
    await expect(mergeRuns([s1], join(dir, 'm1'))).rejects.toThrow(/does not verify/);
    const m = await mergeRuns([s1], join(dir, 'm2'), { allowUnverified: true });
    expect(m.warnings[0]).toMatch(/does not verify/);
    expect(await expandRunDirs([join(dir, 'artifact-1')])).toEqual([s1]);
  });

  it('CLI: merge prints the evidence status and evidence verify understands merged runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-merge-cli-'));
    await writeFile(join(dir, 'eztest.config.yaml'), 'baseUrl: http://localhost:1\n');
    await fakeShardRun(join(dir, 'shard-1'), 'run-c-1', [{ id: 'a', status: 'passed' }], '2026-10-22T10:00:00.000Z');
    await fakeShardRun(join(dir, 'shard-2'), 'run-c-2', [{ id: 'b', status: 'passed' }], '2026-10-22T10:00:00.100Z');
    const io = cli(dir);
    await buildProgram(io).parseAsync(['node', 'eztest', 'merge', 'shard-1', 'shard-2', '-o', 'merged', '--reporter', 'json'], { from: 'node' });
    expect(io.lines.join('\n')).toMatch(/merged 2 shard run\(s\).*2 journeys, 2 passed/);
    expect(io.lines.join('\n')).toMatch(/evidence: VALID merged chain .* 2\/2 shard chains linked/);
    expect(process.exitCode).toBe(0);
    const io2 = cli(dir);
    await buildProgram(io2).parseAsync(['node', 'eztest', 'evidence', 'verify', 'merged'], { from: 'node' });
    expect(io2.lines[0]).toMatch(/^VALID: merged run, .*run-c-1 linked, run-c-2 linked/);
    process.exitCode = 0;
  });
});
