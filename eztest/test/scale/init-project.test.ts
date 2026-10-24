/**
 * What `eztest init` writes is consistent with itself: the readiness policy's
 * gates have their inputs in the config and the example, the .gitignore keeps
 * team decisions committable and ignores caches, and the next steps name the
 * package to install.
 */
import { describe, expect, it } from '../support/testkit.js';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { initProject } from '../../src/cli/init.js';
import { loadConfig } from '../../src/config/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { tempDir } from '../runner/fixtures.js';

describe('eztest init', () => {
  it('the readiness policy only asks for what the config and the example provide', async () => {
    const dir = await tempDir('init-consistent');
    await initProject(dir);
    const loaded = await loadConfig({ cwd: dir, environment: {} });
    const policy = parse(await readFile(join(dir, 'readiness-policy.yaml'), 'utf8')) as { gates: Record<string, { minRisk?: number } | boolean> };
    const example = parseEzScript(await readFile(join(dir, 'journeys', 'example.ez'), 'utf8'));
    // noFailedCriticalJourneys needs a journey at or above its minRisk ...
    const minRisk = (policy.gates.noFailedCriticalJourneys as { minRisk: number }).minRisk;
    expect(example.risk).toBeGreaterThanOrEqual(minRisk);
    // ... and a11yNoCritical needs accessibility results, which the a11y lens records.
    expect(policy.gates.a11yNoCritical).toBe(true);
    expect(loaded.config.lenses.some((l) => l.startsWith('a11y'))).toBe(true);
  });

  it('.gitignore ignores node_modules, results and caches, and keeps team decisions committable', async () => {
    const dir = await tempDir('init-gitignore');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    await initProject(dir);
    const files = {
      'node_modules/x/index.js': true,
      'eztest-results/run-1/report.json': true,
      '.env': true,
      '.eztest/history.json': true,
      '.eztest/fingerprints.json': true,
      '.eztest/code-cache/a.mjs': true,
      '.eztest/keys/signing.key.pem': true,
      '.eztest/store/data.json': true,
      '.eztest/quarantine.json': false,
      '.eztest/heal-decisions.json': false,
      '.eztest/triage-overrides.json': false,
      '.eztest/baselines/home--chromium--1280x720.png': false,
      '.eztest/approvals/2026/approval.json': false,
      'journeys/example.ez': false,
      'eztest.config.yaml': false,
    };
    for (const f of Object.keys(files)) {
      await mkdir(join(dir, f, '..'), { recursive: true });
      await writeFile(join(dir, f), 'x');
    }
    const ignored = (f: string) => {
      try {
        execFileSync('git', ['check-ignore', '-q', f], { cwd: dir });
        return true;
      } catch {
        return false;
      }
    };
    expect(Object.fromEntries(Object.keys(files).map((f) => [f, ignored(f)]))).toEqual(files);
    // Running init again adds nothing twice.
    const before = await readFile(join(dir, '.gitignore'), 'utf8');
    await initProject(dir);
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe(before);
  });

  it('names the package to install when the project does not depend on it yet', async () => {
    const fresh = await tempDir('init-next');
    expect((await initProject(fresh)).next[0]).toBe('npm install --save-dev @eztech/eztest   # the project\'s own EZTest, so npx eztest and CI use it');
    const has = await tempDir('init-next-dep');
    await writeFile(join(has, 'package.json'), JSON.stringify({ devDependencies: { '@eztech/eztest': '^0.1.0' } }));
    const r = await initProject(has);
    expect(r.next.some((n) => n.includes('npm install'))).toBe(false);
    expect(r.next.at(-1)).toContain('npx eztest run');
  });
});
