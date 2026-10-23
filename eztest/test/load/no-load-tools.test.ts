/**
 * EZTest Load is EZTest's own: no other load-testing tool is a dependency,
 * is imported, is named, or has its script format read or written. HAR (the
 * browsers' recording format) is the only import. Scans the manifests, the
 * lockfile, src/, docs/, examples/, scripts/, deploy/ and the README.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '../support/testkit.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TOOLS = /\bk6\b|jmeter|gatling|locust|neoload|loadrunner|artillery|\bautocannon\b|\bwrk2?\b|\bvegeta\b|\btsung\b|['"]loadtest['"]/i;
const FORMATS = /\.jmx\b|\.k6\.js\b|from ['"]k6|\bjmeter\b|\.scala\b.*simulation/i;
const PACKAGES = ['k6', 'artillery', 'loadtest', 'autocannon', 'gatling', 'locust', '@grafana/k6', 'jmeter', 'neoload', 'loadrunner'];

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|mts|mjs|js|json|md|ya?ml|html|css)$|Dockerfile$/.test(e)) out.push(p);
  }
  return out;
}

describe('no other load-testing tool', () => {
  it('is a dependency in package.json or the lockfile', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies });
    expect(deps.filter((d) => PACKAGES.includes(d))).toEqual([]);
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, unknown> };
    expect(Object.keys(lock.packages).filter((p) => PACKAGES.some((x) => p === `node_modules/${x}` || p.startsWith(`node_modules/${x}/`)))).toEqual([]);
  });

  it('is named, imported or has its format read or written in the source, docs, examples, scripts or deploy files', () => {
    const scanned = ['src', 'docs', 'examples', 'scripts', 'deploy'].flatMap((d) => files(join(ROOT, d))).concat([join(ROOT, 'README.md')]);
    expect(scanned.length).toBeGreaterThan(200);
    const hits: string[] = [];
    for (const f of scanned) {
      const text = readFileSync(f, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (TOOLS.test(line) || FORMATS.test(line)) hits.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
