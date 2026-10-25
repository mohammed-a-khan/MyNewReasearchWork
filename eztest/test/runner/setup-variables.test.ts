/**
 * A journey's `Variables:` header sees the values a `Setup:` journey returns (docs/shared-data.md: "every journey
 * of the run can use it as ${tenantId}"), inline and in worker processes. It was resolved against run variables
 * only, so `Variables: last=Okafor${runTag}` typed and stored `Okafor${runTag}` literally.
 */
import { afterAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as toYaml } from 'yaml';
import type { RunResult } from '../../src/core/index.js';
import { loadConfig } from '../../src/config/index.js';
import { createEngine } from '../../src/engine/index.js';
import { parseEzScript } from '../../src/intent/index.js';

/** Temporary folders this file made, removed at the end. */
const made: string[] = [];
async function tempDirOf(prefix: string): Promise<string> {
  const d = await mkdtemp(prefix);
  made.push(d);
  return d;
}
afterAll(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const SCRIPTS = [
  'Setup: Run tag\nId: run-tag\nReturns: runTag\n\nSet variable runTag to "Ez" + upper(randomString(6))\n',
  ...[1, 2].map((i) => [
    `Journey: New hire ${i}`,
    `Id: hire-${i}`,
    'Variables: last=Okafor${runTag}, empId=${runTag}${n}, n=' + i,
    '',
    'Set variable typed to "${last}"',
    'Expect the expression "typed == \'Okafor\' + runTag" is true',
    'Expect the expression "empId == runTag + \'' + i + '\'" is true',
    '',
  ].join('\n')),
];

async function run(workers: 'inline' | 'process'): Promise<RunResult> {
  const dir = await tempDirOf(join(tmpdir(), `ez-setup-vars-${workers}-`));
  await writeFile(join(dir, 'eztest.config.yaml'), toYaml({ outputDir: 'results', healing: { enabled: false }, concurrency: 2, workers }));
  const engine = await createEngine(await loadConfig({ cwd: dir, environment: {} }), { cwd: dir, runOptions: { stepTimeoutMs: 10_000, screenshots: 'off' } });
  try {
    return await engine.run(SCRIPTS.map((s) => parseEzScript(s)));
  } finally {
    await engine.close();
  }
}

describe('Variables: headers and Setup: values', () => {
  for (const workers of ['inline', 'process'] as const) {
    it(`a header variable built from a Setup value is resolved (${workers})`, async () => {
      const r = await run(workers);
      const status = r.journeys.map((j) => `${j.journeyId}:${j.status}${j.error ? ` ${j.error.message}` : ''}`).sort();
      expect(status).toEqual(['hire-1:passed', 'hire-2:passed', 'run-tag:passed']);
      const tag = r.journeys.find((j) => j.journeyId === 'run-tag')!.ledger.runTag as string;
      expect(tag).toMatch(/^Ez[A-Z0-9]{6}$/);
      for (const i of [1, 2]) expect(r.journeys.find((j) => j.journeyId === `hire-${i}`)!.ledger.typed).toBe(`Okafor${tag}`);
    }, 120_000);
  }
});
