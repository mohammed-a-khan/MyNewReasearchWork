/**
 * The testkit runner end to end: it runs the fixture files in test/testkit/fixtures
 * (their own config) in worker processes and reports them.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from '../support/testkit.js';
import { formatTitle } from '../../tools/testkit/index.js';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const CLI = fileURLToPath(new URL('../../tools/testkit/cli.mjs', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'eztest-testkit-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [CLI, '--no-color', ...args], {
    cwd: FIXTURES,
    encoding: 'utf8',
    env: { ...process.env, TESTKIT_WATCHDOG_MS: '1500', TESTKIT_GRACE_MS: '300', CI: '', ...env },
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('testkit runner', () => {
  it('passes a passing file, runs hooks in order and exits 0', () => {
    const log = join(tmp, 'hooks.log');
    const r = run(['pass.fixture.ts', '--reporter', 'verbose'], { TESTKIT_LOG: log });
    expect(r.out).toContain('Tests  8 passed (8)');
    expect(r.out).toContain("✓ 'kendo' has n=1");
    expect(r.out).toContain('✓ 1 + 2 = 3');
    expect(r.code).toBe(0);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines.slice(0, 8)).toEqual(['beforeAll file', 'beforeEach file', 'beforeEach outer', 'test first', 'afterEach outer', 'afterEach file 2', 'afterEach file 1', 'beforeEach outer cleanup']);
    expect(lines.slice(-2)).toEqual(['afterAll file', 'beforeAll file cleanup']);
    expect(lines).toContain('afterAll inner');
  });

  it('swaps modules from the config', () => {
    const r = run(['pass.fixture.ts', '-t', 'module swap'], { TESTKIT_SWAP: '1' });
    expect(r.out).toContain('Tests  1 passed | 7 skipped (8)');
    expect(r.code).toBe(0);
  });

  it('reports failures with diffs, source frames, timeouts, skips, todo, retries, soft and unhandled errors', () => {
    const r = run(['fail.fixture.ts']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL  fail.fixture.ts > failures > diff');
    expect(r.out).toContain('-   "total": 11,\n+   "total": 10,');
    expect(r.out).toMatch(/❯ fail\.fixture\.ts:7:\d+\n\s+5\| describe\('failures'/);
    expect(r.out).toContain('Test timed out in 100ms.');
    expect(r.out).toContain('FAIL  fail.fixture.ts [ broken beforeAll > beforeAll ]');
    expect(r.out).toContain('Error: setup exploded');
    expect(r.out).toContain('afterAll still ran');
    expect(r.out).toContain('(error 2 of 2)');
    expect(r.out).toContain('UNHANDLED REJECTION  fail.fixture.ts');
    expect(r.out).toContain('Error: nobody caught me');
    expect(r.out).toContain('Tests  3 failed | 2 passed | 6 skipped | 1 todo (12)');
    expect(r.out).toContain('Errors  1 error');
  });

  it('runs only the .only tests of a file, and refuses .only on CI', () => {
    const r = run(['only.fixture.ts']);
    expect(r.out).toContain('Tests  1 passed | 2 skipped (3)');
    expect(r.code).toBe(0);
    const ci = run(['only.fixture.ts'], { CI: 'true' });
    expect(ci.out).toContain('.only is not allowed when CI is set');
    expect(ci.code).toBe(1);
    expect(run(['only.fixture.ts', '--allow-only'], { CI: 'true' }).code).toBe(0);
  });

  it('kills a worker whose test blocks the event loop', () => {
    const r = run(['hang.fixture.ts']);
    expect(r.out).toContain('The worker stopped responding during "blocks the event loop"');
    expect(r.out).toContain('Tests  1 failed (1)');
    expect(r.code).toBe(1);
  }, 30_000);

  it('reports open handles and a file that fails to import', () => {
    const r = run(['handles.fixture.ts', 'broken.fixture.ts', '--handles']);
    expect(r.out).toContain('handles.fixture.ts: TCPServerWrap');
    expect(r.out).toContain('FAIL  broken.fixture.ts [ collecting the file ]');
    expect(r.out).toContain('Test Files  1 failed | 1 passed (2)');
    expect(r.code).toBe(1);
  });

  it('writes JUnit XML for Azure DevOps', () => {
    const file = join(tmp, 'junit.xml');
    run(['fail.fixture.ts', 'pass.fixture.ts', '--reporter', 'junit', '--output-file', file]);
    const xml = readFileSync(file, 'utf8');
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<testsuites name="eztest-testkit" tests="\d+" failures="3" errors="2"/);
    expect(xml).toContain('<testcase classname="fail.fixture.ts" name="failures &gt; diff"');
    expect(xml).toContain('<failure message="expected { &quot;name&quot;: &quot;order&quot;');
    expect(xml).toContain('<skipped/>');
    expect(xml).toContain('<error message="setup exploded" type="Error">');
    expect(xml).not.toMatch(/\x1b\[/);
  });

  it('dot reporter, bail, file filters and bad usage', () => {
    const dot = run(['pass.fixture.ts', '--reporter', 'dot']);
    expect(dot.out).toMatch(/·{8}/);
    const bail = run(['fail.fixture.ts', '--bail', '1', '--workers', '1']);
    expect(bail.out).toContain('Bailed out after');
    expect(bail.code).toBe(1);
    expect(run(['--list', 'only']).out.trim()).toBe('only.fixture.ts');
    expect(run(['no-such-file']).code).toBe(1);
    expect(run(['--reporter', 'nope']).code).toBe(2);
  });
});

describe('test titles of .each', () => {
  it('formats printf placeholders and $properties', () => {
    expect(formatTitle('%s: %d items, %j, %#, %%', ['a', 3, { x: 1 }], 4)).toBe('a: 3 items, {"x":1}, 4, %');
    expect(formatTitle('$lib (en-US) $a.b', [{ lib: 'kendo', a: { b: 2 } }], 0)).toBe("'kendo' (en-US) 2");
    expect(formatTitle('t=%i', [59.9], 0)).toBe('t=59');
  });
});
