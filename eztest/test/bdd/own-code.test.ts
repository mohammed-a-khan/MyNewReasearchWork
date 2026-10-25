/**
 * Native BDD is EZTest's own code: no Gherkin, BDD or testing package is a
 * dependency or an import, and the Studio's highlighting knows every keyword
 * of the parser's language table.
 */
import { describe, expect, it } from '../support/testkit.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DIALECTS } from '../../src/bdd/index.js';

const ROOT = resolve(__dirname, '../..');
const BDD_PACKAGE = /(?:^|["'/])(?:@cucumber\/[\w.-]+|cucumber(?:-[\w.-]+)?|gherkin(?:-[\w.-]+)?|@?jest-cucumber|playwright-bdd|cypress-cucumber[\w.-]*)["']/i;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe('native BDD is EZTest\'s own code', () => {
  it('package.json and the lockfile name no Gherkin or BDD package', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    const deps = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => Object.keys(pkg[k] ?? {}));
    expect(deps.filter((d) => /cucumber|gherkin/i.test(d))).toEqual([]);
    const lock = readFileSync(join(ROOT, 'package-lock.json'), 'utf8');
    expect(lock.match(/"node_modules\/[^"]*(?:cucumber|gherkin)[^"]*"/gi) ?? []).toEqual([]);
  });

  it('src/bdd and the BDD runner import only EZTest modules and Node built-ins', () => {
    const files = [...walk(join(ROOT, 'src', 'bdd')), join(ROOT, 'src', 'runner', 'bdd-run.ts'), join(ROOT, 'src', 'studio', 'bdd.ts'), join(ROOT, 'src', 'report', 'bdd.ts')];
    const bad: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)(['"])([^'"]+)\1/g)) {
        const spec = m[2];
        if (!spec.startsWith('.') && !spec.startsWith('node:') && !/^(?:@eztech\.com\/)?eztest(?:\/|$)/.test(spec)) bad.push(`${f}: ${spec}`);
      }
      if (BDD_PACKAGE.test(text)) bad.push(`${f}: names a BDD package`);
    }
    expect(bad).toEqual([]);
  });

  it('the Studio editor highlights every keyword of every language', () => {
    const client = readFileSync(join(ROOT, 'src', 'studio', 'client', 'pages', 'journeys', 'gherkin.ts'), 'utf8');
    const quoted = (k: string) => client.includes(`'${k}'`) || client.includes(`"${k}"`);
    const missing: string[] = [];
    for (const [code, d] of Object.entries(DIALECTS)) {
      for (const k of [...d.feature, ...d.rule, ...d.background, ...d.scenario, ...d.scenarioOutline, ...d.examples, ...d.given, ...d.when, ...d.then, ...d.and, ...d.but]) {
        if (!quoted(k)) missing.push(`${code}: ${k}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
