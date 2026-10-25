/** `eztest analyze` reports a configuration that does not load instead of silently analyzing without it. */
import { describe, expect, it } from '../support/testkit.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { buildProgram } from '../../src/cli/index.js';
import { makeRichFixture } from './rich-fixture.js';

async function cli(cwd: string, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  process.exitCode = 0;
  await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: { PATH: process.env.PATH } }).exitOverride().parseAsync(['node', 'eztest', ...args]);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { out: out.join('\n'), err: err.join('\n'), code };
}

describe('eztest analyze and the configuration', () => {
  it('a broken eztest.config.yaml is reported and exits 1; --no-config analyzes without it; a valid one is used', async () => {
    const rich = await makeRichFixture();
    const run = relative(rich.root, rich.runDir);
    await writeFile(join(rich.root, 'eztest.config.yaml'), 'baseUrl: 42\nconcurrency: lots\n');
    const bad = await cli(rich.root, ['analyze', run, '--no-history']);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/^analyze: eztest\.config\.yaml could not be loaded: Invalid EZTest configuration/);
    expect(bad.err).toMatch(/concurrency/);
    expect(bad.err).toContain('pass --no-config to analyze without it');
    expect(bad.out).toBe('');

    const without = await cli(rich.root, ['analyze', run, '--no-history', '--no-config']);
    expect(without.code).toBe(0);
    expect(JSON.parse(without.out)).toHaveProperty('triage');

    await writeFile(join(rich.root, 'eztest.config.yaml'), 'baseUrl: http://shop.test\nreport:\n  name: Contoso Shop\n');
    const ok = await cli(rich.root, ['analyze', run, '--no-history']);
    expect(ok.code).toBe(0);
    expect(ok.err).toBe('');
  });

  it('--brand-file brands the reports and warns about a colour that fails WCAG AA; --policy is the gate', async () => {
    const rich = await makeRichFixture();
    const run = relative(rich.root, rich.runDir);
    await writeFile(join(rich.root, 'branding.yaml'), 'brand:\n  company: Northwind QA\n  colors: { primary: "#ffd400" }\n');
    const r = await cli(rich.root, ['analyze', run, '--no-history', '--brand-file', 'branding.yaml']);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/warning: report\.brand\.colors\.primary #ffd400 has a contrast of 1\.\d+:1 .*accessible shade #[0-9a-f]{6}/);
    const html = await readFile(join(rich.root, run, 'report.html'), 'utf8');
    expect(html).toContain('<div class="brand-eyebrow">Northwind QA</div>');
    expect(html).not.toMatch(/NO GO|tab-policy/);
    // The readiness gate is an explicit --policy: NO_GO fails the step (the fixture fails critical journeys).
    await writeFile(join(rich.root, 'policy.yaml'), 'version: 1\ngates:\n  noFailedCriticalJourneys: { minRisk: 4 }\n');
    const gate = await cli(rich.root, ['analyze', run, '--no-history', '--policy', 'policy.yaml']);
    expect(JSON.parse(gate.out).readiness).toBe('NO_GO');
    expect(gate.code).toBe(1);
  });
});
