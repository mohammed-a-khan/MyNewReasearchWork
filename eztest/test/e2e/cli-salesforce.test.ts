/** End-to-end: Salesforce Lightning through the real CLI with a `salesforce:` config block (passwords via secret://). */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSalesforceMock, type SalesforceMockServer } from '../../examples/salesforce-mock/server.js';
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

const JOURNEY = `Journey: Create a bank account in Salesforce
Tags: @salesforce @smoke
Risk: 5
Log in to Salesforce as admin
Open the Accounts tab
Create a new Account
Set Salesforce field "Account Name" to "Northwind Bank"
Set Salesforce field "Phone" to "555-0100"
Set Salesforce field "Industry" to "Banking"
Save the Salesforce record
Expect the toast to contain "was created"
Expect Salesforce field "Account Name" to be "Northwind Bank"
Verify in Salesforce that Account "Northwind Bank" has Industry = "Banking" and Phone = "555-0100"
Expect the Accounts list view to contain "Northwind Bank"
`;

describe('eztest + Salesforce (end to end)', () => {
  let mock: SalesforceMockServer;
  let project: string;

  beforeAll(async () => {
    mock = await startSalesforceMock();
    project = await mkdtemp(join(tmpdir(), 'eztest-sf-cli-'));
    await mkdir(join(project, 'journeys'));
    await writeFile(join(project, 'journeys', 'create-bank.ez'), JOURNEY);
    process.env.SF_TEST_CLIENT_SECRET = mock.clientSecret;
    process.env.SF_TEST_ADMIN_PASSWORD = mock.users.admin.password;
    process.env.SF_TEST_REP_PASSWORD = mock.users.rep.password;
    await writeFile(
      join(project, 'eztest.config.yaml'),
      [
        `baseUrl: ${mock.url}`,
        'identity:',
        '  secretStores: [{ type: env, prefix: SF_TEST_ }]',
        'salesforce:',
        `  instanceUrl: ${mock.url}`,
        `  tokenUrl: ${mock.tokenUrl}`,
        `  clientId: ${mock.clientId}`,
        '  clientSecret: secret://env/CLIENT_SECRET',
        '  users:',
        `    admin: { username: ${mock.users.admin.username}, password: secret://env/ADMIN_PASSWORD }`,
        `    rep: { username: ${mock.users.rep.username}, password: secret://env/REP_PASSWORD }`,
        '  apiUser: admin',
        '  objects: [Account, Opportunity]',
      ].join('\n'),
    );
  });
  afterAll(async () => {
    for (const k of ['SF_TEST_CLIENT_SECRET', 'SF_TEST_ADMIN_PASSWORD', 'SF_TEST_REP_PASSWORD']) delete process.env[k];
    await mock.close();
  });

  it('validates Salesforce phrasings when the add-on is configured', async () => {
    const v = await cli(project, ['validate', 'journeys']);
    expect(v.err).toBe('');
    expect(v.exitCode).toBe(0);
  });

  it('runs a Lightning journey: login, record form, save, toast, SOQL cross-check, list view; no secrets in results', async () => {
    const r = await cli(project, ['run', '--no-analyze']);
    const results = join(project, 'eztest-results');
    const runDir = join(results, (await readdir(results)).sort().pop()!);
    const runJson = await readFile(join(runDir, 'run.json'), 'utf8');
    const run = JSON.parse(runJson) as RunResult;
    const lines = run.journeys[0].steps.map((s) => `${s.intent}: ${s.status}${s.error ? ` (${s.error.message})` : ''}`);
    expect(lines.filter((l) => !l.includes(': passed'))).toEqual([]);
    expect(r.exitCode).toBe(0);
    for (const secret of [mock.clientSecret, mock.users.admin.password, mock.users.rep.password]) expect(runJson.includes(secret)).toBe(false);
  });

  it('snapshots describe metadata and reports which journeys a release breaks', async () => {
    expect((await cli(project, ['salesforce', 'snapshot', '-o', 'spring.json', '--release', 'Spring'])).exitCode).toBe(0);
    mock.setRelease('Summer');
    try {
      expect((await cli(project, ['salesforce', 'snapshot', '-o', 'summer.json', '--release', 'Summer'])).exitCode).toBe(0);
    } finally {
      mock.setRelease('Spring');
    }
    const r = await cli(project, ['salesforce', 'impact', '--before', 'spring.json', '--after', 'summer.json', 'journeys']);
    const report = JSON.parse(r.out) as { changes: unknown[]; impacted: Array<{ journeyId: string; breaking: number }> };
    expect(report.changes.length).toBeGreaterThan(0);
    const hit = report.impacted.find((j) => j.journeyId === 'create-a-bank-account-in-salesforce');
    expect(hit?.breaking).toBeGreaterThan(0);
    expect(r.exitCode).toBe(1);
  });

  it('checks the permission matrix per user and fails on a violated expectation', async () => {
    await writeFile(
      join(project, 'perms.yaml'),
      [
        '- { object: Account, field: AnnualRevenue, expect: read, users: [rep] }',
        '- { object: Account, field: AnnualRevenue, expect: edit, users: [admin] }',
        '- { object: Account, field: NumberOfEmployees, expect: hidden, users: [rep] }',
        '- { tab: Cases, object: Case, expect: hidden, users: [rep] }',
      ].join('\n'),
    );
    const ok = await cli(project, ['salesforce', 'permissions', '--checks', 'perms.yaml', '-o', 'perms-report.json']);
    expect(ok.out).toMatch(/0 violation\(s\)/);
    expect(ok.exitCode).toBe(0);
    expect(JSON.parse(await readFile(join(project, 'perms-report.json'), 'utf8')).passed).toBe(true);

    await writeFile(join(project, 'perms-bad.yaml'), '- { object: Account, field: AnnualRevenue, expect: edit, users: [rep] }\n');
    const bad = await cli(project, ['salesforce', 'permissions', '--checks', 'perms-bad.yaml']);
    expect(bad.out).toMatch(/VIOLATION rep: .*AnnualRevenue|VIOLATION rep: .*Annual Revenue/);
    expect(bad.exitCode).toBe(1);
  });
});
