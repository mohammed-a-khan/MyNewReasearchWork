import { describe, expect, it } from '../support/testkit.js';
import { join } from 'node:path';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { formatSarif, formatText, lintCode, lintExitCode, lintJourney, lintPaths, scoreLocator, scoreTarget, isAbsoluteXPath, isPositionalXPath, looksDynamic } from '../../src/lint/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { buildProgram } from '../../src/cli/program.js';

const FIX = join(import.meta.dirname, 'fixtures');

describe('locator quality score', () => {
  it('ranks test ids > role+name > label > text > classes > positional > absolute', () => {
    const s = (c: Parameters<typeof scoreLocator>[0]) => scoreLocator(c).score;
    const testId = s({ strategy: 'testId', value: 'save-order' });
    const role = s({ strategy: 'role', value: 'button', name: 'Save' });
    const label = s({ strategy: 'label', value: 'Email' });
    const text = s({ strategy: 'text', value: 'Save' });
    const cls = s({ strategy: 'css', value: '.btn.btn-primary' });
    const pos = s({ strategy: 'xpath', value: "//table[@id='orders']/tbody/tr[3]/td[2]/a" });
    const abs = s({ strategy: 'xpath', value: '/html/body/div[2]/form/button[1]' });
    expect([testId, role, label, text, cls, pos, abs]).toEqual([...[testId, role, label, text, cls, pos, abs]].sort((a, b) => b - a));
    expect(abs).toBeLessThan(10);
    expect(scoreLocator({ strategy: 'role', value: 'button' }).score).toBeLessThan(50); // no name: ambiguous
  });

  it('penalises generated ids and classes', () => {
    expect(looksDynamic('btn-8f3a2c91')).toBe(true);
    expect(looksDynamic('ember1234')).toBe(true);
    expect(looksDynamic('ctl00_Main_Save')).toBe(true);
    expect(looksDynamic('save-order')).toBe(false);
    expect(scoreLocator({ strategy: 'css', value: '#btn-8f3a2c91' }).score).toBeLessThan(scoreLocator({ strategy: 'css', value: '#save' }).score - 30);
    expect(scoreLocator({ strategy: 'css', value: '.css-1x2y3z' }).score).toBeLessThan(20);
  });

  it('a target scores by its best candidate, plus a little for fallbacks', () => {
    const t = scoreTarget([{ strategy: 'xpath', value: '//div[2]/button' }, { strategy: 'testId', value: 'pay' }]);
    expect(t.score).toBeGreaterThanOrEqual(95);
    expect(t.grade).toBe('robust');
    expect(scoreTarget([]).score).toBe(0);
  });

  it('classifies XPath shapes', () => {
    expect(isAbsoluteXPath('/html/body/div')).toBe(true);
    expect(isAbsoluteXPath('(//a)[2]')).toBe(false);
    expect(isPositionalXPath('(//a)[2]')).toBe(true);
    expect(isPositionalXPath("//a[@id='x']")).toBe(false);
    expect(isPositionalXPath('//li[last()]')).toBe(true);
  });
});

describe('eztest lint on journeys (fixtures)', () => {
  it('finds every anti-pattern with a fix suggestion and the line', async () => {
    const r = await lintPaths([join(FIX, 'journeys')], { cwd: FIX });
    const by = (rule: string) => r.findings.filter((f) => f.rule === rule);
    expect(by('hard-wait').map((f) => f.line)).toEqual([7, 14]);
    expect(by('absolute-xpath').map((f) => f.line)).toEqual([8]);
    expect(by('positional-xpath').map((f) => f.line)).toEqual([9]);
    expect(by('unsafe-xpath-quotes').map((f) => f.line)).toEqual([16]);
    // Plain-text secrets: two variables and a typed password (values redacted in the message).
    const secrets = by('plaintext-secret');
    expect(secrets).toHaveLength(3);
    expect(secrets.map((f) => f.message).join(' ')).not.toMatch(/Hunter2!|Spring2026!|sk_live_51Hq0aB3cD4eF5gH6/);
    // "Save" changes state with nothing checked after it; "Submit order" has an Expect; the POST has none.
    expect(by('missing-postcondition').map((f) => f.line)).toEqual([11, 17]);
    // Locale: de-DE marks the UI as translated: text-only targets are reported.
    expect(by('text-only-locator').length).toBeGreaterThanOrEqual(2);
    for (const f of r.findings) expect(f.suggestion.length).toBeGreaterThan(20);
    expect(lintExitCode(r)).toBe(1); // secrets are errors
  });

  it('a clean journey has no findings', async () => {
    const r = await lintPaths([join(FIX, 'clean')], { cwd: FIX });
    expect(r.findings).toEqual([]);
    expect(lintExitCode(r)).toBe(0);
    expect(lintExitCode(r, 0)).toBe(0);
  });

  it('rule severities can be changed or turned off; max-warnings fails CI', () => {
    const j = parseEzScript('Journey: W\nOpen /\nWait 2 seconds\nClick the "Next" button\n');
    expect(lintJourney(j, 'w.ez', '', {}).map((f) => `${f.rule}:${f.severity}`)).toEqual(['hard-wait:warning']);
    expect(lintJourney(j, 'w.ez', '', { rules: { 'hard-wait': 'error' } })[0].severity).toBe('error');
    expect(lintJourney(j, 'w.ez', '', { rules: { 'hard-wait': 'off' } })).toEqual([]);
    const report = { files: 1, findings: lintJourney(j, 'w.ez', ''), counts: { error: 0, warning: 1, info: 0 } };
    expect(lintExitCode(report)).toBe(0);
    expect(lintExitCode(report, 0)).toBe(1);
  });

  it('reports weak locators with their score', () => {
    const j = parseEzScript('Journey: Weak\nOpen /\nClick css=div.panel > div.row > span.c3 > a.link\n  Expect the page contains "Done"\n');
    const f = lintJourney(j, 'weak.ez', '').find((x) => x.rule === 'weak-locator');
    expect(f?.score).toBeLessThan(40);
    expect(f?.suggestion).toMatch(/testid=/);
  });
});

describe('eztest lint on imported code (fixtures)', () => {
  it('flags hard waits, fragile XPath, backslash quote escaping and secrets in a page object', async () => {
    const text = await readFile(join(FIX, 'code', 'LegacyPage.ts'), 'utf8');
    const f = lintCode(text, 'LegacyPage.ts');
    const rules = f.map((x) => `${x.rule}@${x.line}`);
    expect(rules).toEqual(expect.arrayContaining(['plaintext-secret@3', 'unsafe-xpath-quotes@7', 'unsafe-xpath-quotes@8', 'hard-wait@9', 'hard-wait@10', 'absolute-xpath@12', 'positional-xpath@13']));
    expect(rules).not.toContain('plaintext-secret@4'); // read from the environment
    expect(rules.some((r) => r.endsWith('@14'))).toBe(false); // a URL path is not an XPath
  });

  it('writes SARIF for code scanning and text for humans', async () => {
    const r = await lintPaths([FIX], { cwd: FIX });
    const sarif = JSON.parse(formatSarif(r));
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results.length).toBe(r.findings.length);
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toMatch(/\.(?:ez|ts)$/);
    const text = formatText(r);
    expect(text).toMatch(/fix: /);
    expect(text).toMatch(/error\(s\), \d+ warning\(s\)/);
  });
});

describe('eztest lint (CLI)', () => {
  it('runs in CI: exit code 1 on errors, JSON output, rule overrides', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-lint-'));
    await writeFile(join(dir, 'a.ez'), 'Journey: A\nOpen /\nWait 1 second\nClick the "Go" button\n  Expect the page contains "Gone"\n');
    const out: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => out.push(s), cwd: dir, env: {} };
    process.exitCode = 0;
    await buildProgram(io).parseAsync(['node', 'eztest', 'lint', 'a.ez', '--format', 'json']);
    const report = JSON.parse(out.join('\n'));
    expect(report.findings.map((f: { rule: string }) => f.rule)).toEqual(['hard-wait']);
    expect(process.exitCode).toBe(0);
    out.length = 0;
    await buildProgram(io).parseAsync(['node', 'eztest', 'lint', 'a.ez', '--max-warnings', '0']);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    await buildProgram(io).parseAsync(['node', 'eztest', 'lint', 'a.ez', '--rule', 'hard-wait=off']);
    expect(out.join('\n')).toMatch(/0 error\(s\), 0 warning\(s\)/);
    expect(process.exitCode).toBe(0);
  });
});
