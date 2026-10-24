/** run.json and the JUnit XML carry no absolute local paths: the fingerprint store is recorded relative to the project. */
import { describe, expect, it } from '../support/testkit.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runJourneys, projectRelative } from '../../src/runner/index.js';
import { writeReports } from '../../src/report/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { FAST, tempDir } from '../runner/fixtures.js';

describe('paths in results', () => {
  it('projectRelative: relative to the folder that holds the output directory, forward slashes', () => {
    expect(projectRelative('/work/shop/.eztest/fingerprints.json', '/work/shop/eztest-results')).toBe('.eztest/fingerprints.json');
    expect(projectRelative('/work/other/fp.json', '/work/shop/eztest-results')).toBe('../other/fp.json');
  });

  it('a run records the fingerprint store as .eztest/fingerprints.json, and junit.xml has no absolute path of this machine', async () => {
    const site = createServer((_q, r) => r.end('<!doctype html><html lang="en"><title>Home</title><main><h1>Welcome</h1></main></html>'));
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    const root = await tempDir('junit-paths');
    const outputDir = join(root, 'eztest-results');
    try {
      const run = await runJourneys([parseEzScript('Journey: Home\nId: home\nOpen "/"\n  Expect the page to contain "Welcome"\n')], {
        ...FAST, baseUrl: `http://127.0.0.1:${(site.address() as AddressInfo).port}`, outputDir,
      });
      expect(run.environment?.fingerprintStore).toBe('.eztest/fingerprints.json');
      const runDir = join(outputDir, run.runId);
      expect(JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')).environment.fingerprintStore).toBe('.eztest/fingerprints.json');
      await writeReports(runDir, run, { formats: ['junit'] });
      const xml = await readFile(join(runDir, 'junit.xml'), 'utf8');
      expect(xml).not.toContain(root);
      expect(xml).toContain('.eztest/fingerprints.json');
    } finally {
      site.close();
    }
  }, 60_000);
});
