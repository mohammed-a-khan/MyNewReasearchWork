/**
 * A fresh project, the way a user gets one: the published tarball (`npm pack`)
 * installed as @mohammed-a-khan/eztest, `eztest init`, the example pointed at a
 * local site, `eztest run`, then `eztest gate`. A fully passing run of what
 * init writes must be GO, and the package's subpath exports must resolve by
 * the scoped name (a code journey imports @mohammed-a-khan/eztest/sdk).
 *
 * Needs dist/ (npm run build), like the other tests of the published package.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const HAS_DIST = existsSync(join(ROOT, 'dist', 'cli', 'bin.js'));

function sh(cmd: string, args: string[], cwd: string, env: Record<string, string | undefined> = {}): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    execFile(cmd, args, { cwd, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, timeout: 240_000 }, (err, stdout, stderr) => {
      res({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` });
    });
  });
}

let base: string;
let project: string;
let server: Server;
let url: string;

beforeAll(async () => {
  if (!HAS_DIST) return;
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shop home</title></head>
<body><header><nav aria-label="Main"><a href="/">Home</a></nav></header>
<main><h1>Welcome to the shop</h1><p>Everything is in stock.</p></main></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  base = await mkdtemp(join(tmpdir(), 'eztest-init-packed-'));
  project = join(base, 'project');
  await mkdir(project);
});

afterAll(async () => {
  server?.close();
  if (base) await rm(base, { recursive: true, force: true }).catch(() => undefined);
});

describe('a fresh project from the packed package', () => {
  it.skipIf(!HAS_DIST)('init, run against a local site, gate: GO', async () => {
    // npm pack: the files a user installs.
    const packed = await sh('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', base], ROOT);
    expect(packed.code, packed.out).toBe(0);
    const info = JSON.parse(packed.out.slice(packed.out.indexOf('['))) as Array<{ name: string; filename: string }>;
    expect(info[0].name).toBe('@mohammed-a-khan/eztest');
    const tarball = join(base, info[0].filename.replace(/^@/, '').replace(/\//g, '-'));
    expect(existsSync(tarball), `${tarball} in ${(await readdir(base)).join(', ')}`).toBe(true);

    // "npm install" without the network: unpack into node_modules/@mohammed-a-khan/eztest, link the
    // runtime dependencies from this repository's install, and add the bin the way npm does.
    const pkgDir = join(project, 'node_modules', '@mohammed-a-khan', 'eztest');
    await mkdir(pkgDir, { recursive: true });
    const untar = await sh('tar', ['-xzf', tarball, '-C', pkgDir, '--strip-components=1'], base);
    expect(untar.code, untar.out).toBe(0);
    const manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')) as { bin: Record<string, string>; dependencies: Record<string, string> };
    expect(Object.keys(manifest.bin)).toEqual(['eztest']);
    for (const dep of Object.keys(manifest.dependencies)) {
      const at = join(project, 'node_modules', dep);
      await mkdir(join(at, '..'), { recursive: true });
      await symlink(join(ROOT, 'node_modules', dep), at, 'dir');
    }
    await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'fresh-project', private: true, type: 'module', devDependencies: { '@mohammed-a-khan/eztest': '0.1.0' } }, null, 2));
    const bin = join(pkgDir, manifest.bin.eztest);
    const eztest = (args: string[]) => sh(process.execPath, [bin, ...args], project, { EZTEST_ADO_ORG_URL: undefined, EZTEST_ADO_PROJECT: undefined, CI: undefined });

    const init = await eztest(['init']);
    expect(init.code, init.out).toBe(0);
    expect(init.out).toContain('created  journeys/example.ez');
    expect(init.out).toContain('npx eztest run');
    expect(init.out).not.toContain('npm install --save-dev'); // the project already depends on it

    // Point the project at the local site and make the example match its page.
    const cfgPath = join(project, 'eztest.config.yaml');
    await writeFile(cfgPath, (await readFile(cfgPath, 'utf8')).replace('baseUrl: http://localhost:3000', `baseUrl: ${url}`));
    const exPath = join(project, 'journeys', 'example.ez');
    await writeFile(exPath, (await readFile(exPath, 'utf8')).replace('Expect the page to contain "Welcome"', 'Expect the page to contain "Welcome to the shop"'));
    // A code journey importing the SDK by the package name (a subpath export of the installed package).
    await writeFile(join(project, 'journeys', 'stock.journey.mjs'), `import { journey, expect } from '@mohammed-a-khan/eztest/sdk';
journey('Stock message shows', { tags: ['@smoke'] }, async ({ ui }) => {
  await ui.open('/');
  await expect.ui.page().toContainText('Everything is in stock');
});
`);

    const run = await eztest(['run']);
    expect(run.code, run.out).toBe(0);
    const results = join(project, 'eztest-results');
    const runDir = join(results, (await readdir(results)).filter((d) => d.startsWith('run-')).sort().at(-1)!);
    const report = JSON.parse(await readFile(join(runDir, 'report.json'), 'utf8')) as { run: { journeys: Array<{ journeyId: string; status: string }> }; insights: { readiness: { decision: string; score: number; gates: Array<{ gate: string; status: string }> } } };
    expect(report.run.journeys.map((j) => j.status)).toEqual(['passed', 'passed']);
    const rd = report.insights.readiness;
    expect(rd.gates.filter((g) => g.status !== 'pass'), JSON.stringify(rd.gates)).toEqual([]);
    expect(rd.decision).toBe('GO');

    const gate = await eztest(['gate', runDir, '--on-risks', 'fail', '--on-missing', 'fail']);
    expect(gate.code, gate.out).toBe(0);
    expect(gate.out).toContain('PASS');
  }, 300_000);
});
