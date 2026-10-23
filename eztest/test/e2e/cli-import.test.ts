/** End-to-end: `eztest import --verify` converts other tools' tests and proves them by replay. */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { cp, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { buildProgram } from '../../src/cli/index.js';

async function cli(cwd: string, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const before = process.exitCode;
  process.exitCode = 0;
  await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: process.env })
    .exitOverride()
    .parseAsync(['node', 'eztest', ...args]);
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = before;
  return { out: out.join('\n'), err: err.join('\n'), exitCode };
}

describe('eztest import (end to end)', () => {
  let app: DemoServer;
  let project: string;

  beforeAll(async () => {
    app = await startDemoApp();
    project = await mkdtemp(join(tmpdir(), 'eztest-import-'));
    await cp(resolve(__dirname, '../importers/fixtures'), join(project, 'legacy'), { recursive: true });
    await writeFile(join(project, 'eztest.config.yaml'), `baseUrl: ${app.url}\n`);
  });
  afterAll(async () => {
    await app.close();
  });

  it('imports a Cucumber feature and a Playwright spec, replays them, and they run with eztest run', async () => {
    const r = await cli(project, ['import', 'legacy/bob-order.feature', 'legacy/bob-order.spec.js', '-o', 'journeys', '--verify']);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatch(/imported \d+ journeys from 2 file\(s\)/);
    expect(r.out).toMatch(/verified by replay/);
    const files = (await readdir(join(project, 'journeys'))).filter((f) => f.endsWith('.ez'));
    expect(files.length).toBeGreaterThan(1);
    expect(await readFile(join(project, 'journeys', 'import-report.md'), 'utf8')).toMatch(/\| Steps \| \d+ \| \d+ \| \d+ \|/);

    const v = await cli(project, ['validate', 'journeys']);
    expect(v.err).toBe('');
    expect(v.exitCode).toBe(0);
  });
});
