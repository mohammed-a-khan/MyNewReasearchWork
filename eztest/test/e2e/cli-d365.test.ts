/** End-to-end: Dynamics 365 through the real CLI with a `d365:` config block (secret via secret://). */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startD365Mock, type D365MockServer } from '../../examples/d365-mock/server.js';
import { buildProgram } from '../../src/cli/index.js';
import type { RunResult } from '../../src/core/index.js';

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

const JOURNEY = `Journey: Create the Contoso account
Tags: @d365 @smoke
Risk: 5
Open the Account form
Set D365 field "Account Name" to "Contoso"
Set "Main Phone" to "555-0100" on the form
Set D365 field "Industry" to "Consulting"
Set lookup "Parent Account" to "Fabrikam"
Save the record
Expect the record to be saved
Expect D365 field "Account Name" to be "Contoso"
Verify in Dataverse that account "Contoso" has "telephone1" = "555-0100" and "Industry" = "Consulting"
Open the Accounts view
Expect the Accounts view to contain "Contoso"
`;

describe('eztest + Dynamics 365 (end to end)', () => {
  let mock: D365MockServer;
  let project: string;

  beforeAll(async () => {
    mock = await startD365Mock();
    project = await mkdtemp(join(tmpdir(), 'eztest-d365-cli-'));
    await mkdir(join(project, 'journeys'));
    await writeFile(join(project, 'journeys', 'create-account.ez'), JOURNEY);
    process.env.D365_TEST_SECRET = mock.clientSecret;
    await writeFile(
      join(project, 'eztest.config.yaml'),
      [
        `baseUrl: ${mock.url}`,
        'identity:',
        '  secretStores: [{ type: env, prefix: D365_TEST_ }]',
        'd365:',
        `  url: ${mock.url}`,
        `  tokenUrl: ${mock.tokenUrl}`,
        `  clientId: ${mock.clientId}`,
        '  clientSecret: secret://env/SECRET',
        '  entities: [account, opportunity]',
        '  timeoutMs: 8000',
      ].join('\n'),
    );
  });
  afterAll(async () => {
    delete process.env.D365_TEST_SECRET;
    await mock.close();
  });

  it('validates D365 phrasings only when the add-on is configured', async () => {
    const v = await cli(project, ['validate', 'journeys']);
    expect(v.err).toBe('');
    expect(v.exitCode).toBe(0);
  });

  it('runs a D365 journey: form, lookup, save, UI and Dataverse cross-check, view', async () => {
    const r = await cli(project, ['run', '--no-analyze']);
    const results = join(project, 'eztest-results');
    const run = JSON.parse(await readFile(join(results, (await readdir(results)).sort().pop()!, 'run.json'), 'utf8')) as RunResult;
    const lines = run.journeys[0].steps.map((s) => `${s.intent}: ${s.status}${s.error ? ` (${s.error.message})` : ''}`);
    expect(lines.filter((l) => !l.includes(': passed'))).toEqual([]);
    expect(r.exitCode).toBe(0);
    const evidence = await readFile(join(results, (await readdir(results)).sort().pop()!, 'run.json'), 'utf8');
    expect(evidence.includes(mock.clientSecret)).toBe(false);
  });

  it('snapshots metadata and reports release-wave impact on journeys', async () => {
    expect((await cli(project, ['d365', 'snapshot', '-o', 'before.json'])).exitCode).toBe(0);
    mock.setReleaseWave(true);
    expect((await cli(project, ['d365', 'snapshot', '-o', 'after.json'])).exitCode).toBe(0);
    mock.setReleaseWave(false);
    const r = await cli(project, ['d365', 'impact', '--before', 'before.json', '--after', 'after.json', 'journeys']);
    const report = JSON.parse(r.out) as { changes: unknown[]; impacted: Array<{ journeyId: string }> };
    expect(report.changes.length).toBeGreaterThan(0);
    expect(report.impacted.map((j) => j.journeyId)).toContain('create-the-contoso-account');
  });
});
