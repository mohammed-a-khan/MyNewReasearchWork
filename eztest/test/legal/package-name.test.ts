/**
 * The npm package is @mohammed-a-khan/eztest (the unscoped "eztest" on npm is
 * an unrelated package); its command stays `eztest`. Every place that installs
 * or imports EZTest by name uses the scoped name.
 */
import { describe, expect, it } from '../support/testkit.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EZTEST_VERSION, PACKAGE_NAME } from '../../src/ops/index.js';
import { eztestModulePath } from '../../src/runner/code-journeys.js';
import { CI_SYSTEMS, CI_TEMPLATES } from '../../src/cli/ci-templates.js';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const pkg = JSON.parse(read('package.json')) as Record<string, any>;

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(?:md|ts|mjs|js|json|ya?ml)$/.test(n)) out.push(p);
  }
  return out;
}

describe('package name', () => {
  it('is scoped, public, keeps the eztest bin, and the lock file agrees', () => {
    expect(pkg.name).toBe('@mohammed-a-khan/eztest');
    expect(PACKAGE_NAME).toBe(pkg.name);
    expect(pkg.publishConfig).toEqual({ access: 'public' });
    expect(pkg.bin).toEqual({ eztest: './dist/cli/bin.js' });
    expect(pkg.license).toBe('UNLICENSED');
    const lock = JSON.parse(read('package-lock.json')) as { name: string; packages: Record<string, { name?: string }> };
    expect(lock.name).toBe(pkg.name);
    expect(lock.packages[''].name).toBe(pkg.name);
    // The version is read from package.json by its name (it would be 0.0.0 otherwise).
    expect(EZTEST_VERSION).toBe(pkg.version);
  });

  it('self-imports resolve by the scoped name and by the legacy bare name', () => {
    expect(eztestModulePath('@mohammed-a-khan/eztest/sdk')).toMatch(/[\\/]sdk[\\/]index\.(?:js|ts)$/);
    expect(eztestModulePath('@mohammed-a-khan/eztest/bdd')).toMatch(/[\\/]bdd[\\/]index\.(?:js|ts)$/);
    expect(eztestModulePath('@mohammed-a-khan/eztest')).toMatch(/[\\/]index\.(?:js|ts)$/);
    expect(eztestModulePath('@mohammed-a-khan/eztest/package.json')).toBe(join(ROOT, 'package.json'));
    expect(eztestModulePath('eztest/sdk')).toBe(eztestModulePath('@mohammed-a-khan/eztest/sdk'));
    expect(eztestModulePath('@mohammed-a-khan/eztest/../x')).toBeUndefined();
    expect(eztestModulePath('@other/eztest/sdk')).toBeUndefined();
    expect(eztestModulePath('eztestx/sdk')).toBeUndefined();
  });

  it('no install instruction, CI file or docs example names the unscoped package', () => {
    const files = [join(ROOT, 'README.md'), ...walk(join(ROOT, 'docs')), ...walk(join(ROOT, 'examples')).filter((f) => !f.includes('node_modules')), ...walk(join(ROOT, 'integrations')), join(ROOT, 'Dockerfile')];
    const bad: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/npm (?:i|install|add)\b[^\n]*?(?<![\w@/-])eztest(?:@[\w.^~-]+)?(?![\w/-])|from ['"]eztest(?:\/[\w-]+)?['"]|`eztest@\$\{/g)) bad.push(`${f.slice(ROOT.length + 1)}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
    expect(read('README.md')).toContain('npm install @mohammed-a-khan/eztest');
    for (const s of CI_SYSTEMS) for (const [, text] of CI_TEMPLATES[s]) expect(text).toContain('npm install --save-dev @mohammed-a-khan/eztest');
  });

  it('every subpath export is in the TypeScript paths for the repository\'s own code', () => {
    const ts = JSON.parse(read('tsconfig.json')) as { compilerOptions: { paths: Record<string, string[]> } };
    expect(ts.compilerOptions.paths['@mohammed-a-khan/eztest/*']).toEqual(['./src/*/index.ts']);
    for (const sub of Object.keys(pkg.exports).filter((k) => k.startsWith('./') && k !== './package.json')) {
      const target = (pkg.exports[sub] as { import: string }).import.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts');
      const mapped = ts.compilerOptions.paths[`@mohammed-a-khan/eztest/${sub.slice(2)}`]?.[0] ?? `./src/${sub.slice(2)}/index.ts`;
      expect(mapped.replace(/^\.\//, ''), sub).toBe(target);
    }
  });
});
