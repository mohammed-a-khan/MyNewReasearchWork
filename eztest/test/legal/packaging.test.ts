/**
 * What the npm package ships: no source maps (they point at src/, which is not shipped), no agent test
 * fixtures, sample apps or build scripts, and README links to the repository for what stays there.
 */
import { describe, expect, it } from '../support/testkit.js';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { files: string[] };

describe('the published package', () => {
  it('the build emits no source or declaration maps', () => {
    const build = JSON.parse(readFileSync(join(ROOT, 'tsconfig.build.json'), 'utf8')) as { compilerOptions: Record<string, unknown> };
    expect(build.compilerOptions).toMatchObject({ sourceMap: false, declarationMap: false });
    expect(pkg.files).toEqual(expect.arrayContaining(['!dist/**/*.map', '!agents/java/sample', '!agents/java/build.sh', '!agents/android/app/src/test']));
  });

  it.skipIf(!existsSync(join(ROOT, 'dist')))('npm pack has no .map files, agent fixtures, sample app or build script', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const files = (JSON.parse(out) as Array<{ files: Array<{ path: string }> }>)[0].files.map((f) => f.path);
    expect(files.length).toBeGreaterThan(500);
    expect(files.filter((f) => f.endsWith('.map'))).toEqual([]);
    expect(files.filter((f) => f.startsWith('agents/java/sample') || f === 'agents/java/build.sh' || f.startsWith('agents/android/app/src/test') || f.endsWith('.gitignore'))).toEqual([]);
    // The agents themselves still ship (EZTest builds them on first use).
    expect(files).toEqual(expect.arrayContaining(['agents/java/src/dev/eztest/agent/EzAgent.java', 'agents/windows/UiaAgent.cs', 'agents/android/app/src/main/java/io/eztest/agent/AgentInstrumentation.java']));
    expect(files).toContain('THIRD_PARTY_NOTICES.md');
    expect(files.some((f) => f.startsWith('examples/') || f.startsWith('test/') || f.startsWith('src/'))).toBe(false);
  }, 120_000);

  it('README links to examples/ and test/ point at the repository on GitHub', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const links = [...readme.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
    expect(links.filter((l) => /^(?:\.\/)?(?:examples|test|tools|src|editors|agents|scripts)\//.test(l))).toEqual([]);
    expect(links).toEqual(expect.arrayContaining([
      'https://github.com/mohammed-a-khan/MyNewReasearchWork/tree/main/eztest/examples/bdd-project',
      'https://github.com/mohammed-a-khan/MyNewReasearchWork/tree/main/eztest/test/legal/no-testing-tools.test.ts',
    ]));
  });
});
