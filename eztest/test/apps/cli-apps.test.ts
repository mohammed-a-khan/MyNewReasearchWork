/**
 * End to end through the real CLI: `servicenow:` and `sap:` config blocks
 * (secrets via secret://env), `eztest validate` / `run` with pack phrasings,
 * `eztest apps snapshot|impact|permissions`. Against the mocks, not real
 * tenants.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from '../../src/cli/index.js';
import type { RunResult } from '../../src/core/index.js';
import { loadConfig } from '../../src/config/index.js';
import { enableAddons } from '../../src/engine/index.js';
import { startServiceNowMock, type ServiceNowMockServer } from '../../examples/servicenow-mock/server.js';
import { startSapMock, type SapMockServer } from '../../examples/sap-mock/server.js';

async function cli(cwd: string, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const before = process.exitCode;
  process.exitCode = 0;
  await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: process.env }).exitOverride().parseAsync(['node', 'eztest', ...args]);
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = before;
  return { out: out.join('\n'), err: err.join('\n'), exitCode };
}

const JOURNEY = `Journey: Report a laptop fault
Tags: @servicenow
Log in to ServiceNow as itil
Create a new ServiceNow incident
Set ServiceNow field "Caller" to "Fred Luddy"
Set ServiceNow field "Short description" to "Laptop will not boot"
Set ServiceNow field "Category" to "Hardware"
Submit the ServiceNow form
Expect the ServiceNow info message to contain "created"
Verify in ServiceNow that incident "\${servicenow.number}" has "Short description" = "Laptop will not boot" and category = "Hardware"
`;

const SAP_GUI = `Journey: Credit memo in SAP GUI
Connect to SAP "ERP"
Run transaction "VA01"
Set SAP field "VBAK-AUART" to "CR"
Press SAP button "Save"
`;

describe('eztest + packaged-app packs (end to end)', () => {
  let sn: ServiceNowMockServer;
  let qas: SapMockServer;
  let dev: SapMockServer;
  let project: string;

  beforeAll(async () => {
    sn = await startServiceNowMock();
    qas = await startSapMock({ system: 'QAS' });
    dev = await startSapMock({ system: 'DEV' });
    project = await mkdtemp(join(tmpdir(), 'eztest-apps-cli-'));
    await mkdir(join(project, 'journeys'));
    await writeFile(join(project, 'journeys', 'laptop.ez'), JOURNEY);
    await writeFile(join(project, 'journeys', 'credit-memo.ez'), SAP_GUI);
    Object.assign(process.env, {
      APPS_TEST_SN_INT: sn.users.integration.password, APPS_TEST_SN_ITIL: sn.users.itil.password, APPS_TEST_SN_EMP: sn.users.employee.password,
      APPS_TEST_SAP_QAS: qas.users.integration.password, APPS_TEST_SAP_DEV: dev.users.integration.password,
    });
    await writeFile(join(project, 'eztest.config.yaml'), [
      `baseUrl: ${sn.url}`,
      'identity:',
      '  secretStores: [{ type: env, prefix: APPS_TEST_ }]',
      'servicenow:',
      `  instanceUrl: ${sn.url}`,
      `  auth: { type: basic, username: ${sn.users.integration.username}, password: secret://env/SN_INT }`,
      '  users:',
      `    itil: { username: ${sn.users.itil.username}, password: secret://env/SN_ITIL }`,
      `    employee: { username: ${sn.users.employee.username}, password: secret://env/SN_EMP }`,
      '  tables: [incident, change_request]',
      '  timeoutMs: 8000',
      'sap:',
      `  url: ${qas.url}`,
      `  auth: { type: basic, username: ${qas.users.integration.username}, password: secret://env/SAP_QAS }`,
      '  services:',
      '    - { name: SD_SALESORDER_MANAGE_SRV, version: 2, path: /sap/opu/odata/sap/SD_SALESORDER_MANAGE_SRV }',
      '    - { name: API_SALES_ORDER_SRV, version: 2, path: /sap/opu/odata/sap/API_SALES_ORDER_SRV }',
      '  apps:',
      '    - { title: Manage Sales Orders, intent: SalesOrder-manage, service: SD_SALESORDER_MANAGE_SRV, entitySet: C_SalesOrder, tcodes: [VA02, VA03], ui5App: ZSD_SO_MANAGE }',
      `  source: { url: ${dev.url}, auth: { type: basic, username: ${dev.users.integration.username}, password: secret://env/SAP_DEV } }`,
    ].join('\n'));
  });
  afterAll(async () => {
    for (const k of Object.keys(process.env).filter((x) => x.startsWith('APPS_TEST_'))) delete process.env[k];
    await sn?.close();
    await qas?.close();
    await dev?.close();
  });

  it('validates pack phrasings only when the pack is configured', async () => {
    const v = await cli(project, ['validate', 'journeys']);
    expect(v.err).toBe('');
    expect(v.exitCode).toBe(0);
  });

  it('runs a ServiceNow journey from config; no secret reaches the results', async () => {
    const r = await cli(project, ['run', '--no-analyze', 'journeys/laptop.ez']);
    const results = join(project, 'eztest-results');
    const runDir = join(results, (await readdir(results)).sort().pop()!);
    const runJson = await readFile(join(runDir, 'run.json'), 'utf8');
    const run = JSON.parse(runJson) as RunResult;
    expect(run.journeys[0].steps.filter((s) => s.status !== 'passed').map((s) => `${s.intent}: ${s.error?.message}`)).toEqual([]);
    expect(r.exitCode).toBe(0);
    for (const s of [sn.users.itil.password, sn.users.integration.password]) expect(runJson.includes(s)).toBe(false);
  });

  it('snapshots, reports update-set and transport impact, and checks permissions', async () => {
    expect((await cli(project, ['apps', 'snapshot', 'servicenow', '-o', 'sn.json', '--release', 'before'])).out).toMatch(/wrote sn\.json: 2 objects/);
    const imp = await cli(project, ['apps', 'impact', 'servicenow', '--update-set', 'EZ incident form changes', '--skipped', '-o', 'sn-impact.json', 'journeys']);
    const rep = JSON.parse(imp.out) as { impacted: Array<{ journeyId: string; breaking: number; reasons: string[] }> };
    expect(rep.impacted.find((j) => j.journeyId === 'report-a-laptop-fault')?.reasons.some((r) => r.startsWith('breaking field-relabeled Short description'))).toBe(true);
    expect(imp.exitCode).toBe(1);
    expect(JSON.parse(await readFile(join(project, 'sn-impact.json'), 'utf8')).schema).toBe('eztest.apps.impact/v1');

    const sap = await cli(project, ['apps', 'impact', 'sap', '--transport', 'DEVK900123', 'journeys']);
    const srep = JSON.parse(sap.out) as { impacted: Array<{ journeyId: string; reasons: string[] }>; untested: string[] };
    expect(srep.impacted.find((j) => j.journeyId === 'credit-memo-in-sap-gui')?.reasons.some((r) => r.startsWith('breaking values-removed CR'))).toBe(true);
    expect(sap.exitCode).toBe(1);

    await writeFile(join(project, 'perms.yaml'), ['- { table: incident, field: Internal cost, expect: { itil: read, employee: none } }', '- { table: change_request, expect: { itil: read, employee: none } }'].join('\n'));
    const ok = await cli(project, ['apps', 'permissions', 'servicenow', '--checks', 'perms.yaml', '--ui']);
    expect(ok.out).toMatch(/4 checks for 2 users: 0 violation\(s\)/);
    expect(ok.exitCode).toBe(0);
    await writeFile(join(project, 'perms-bad.yaml'), '- { table: change_request, expect: { employee: read } }\n');
    const bad = await cli(project, ['apps', 'permissions', 'servicenow', '--checks', 'perms-bad.yaml']);
    expect(bad.out).toMatch(/VIOLATION employee: table:change_request expected read, API reports none/);
    expect(bad.exitCode).toBe(1);
  });

  it('wires the packs into enableAddons; Power Apps contributes the Dataverse verify step only without a d365 block', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-apps-pa-'));
    await writeFile(join(dir, 'eztest.config.yaml'), [
      'powerapps:',
      '  apps: [{ name: Account Manager, url: "https://apps.example/play/e/x/a/y" }]',
      '  dataverse: { url: "https://org.example.crm.dynamics.com", tenantId: contoso, clientId: c, clientSecret: s, entities: [account] }',
    ].join('\n'));
    const a = await enableAddons(await loadConfig({ cwd: dir }), { cwd: dir });
    try {
      expect(Object.keys(a.apps?.customSteps ?? {})).toEqual(expect.arrayContaining(['pa.openApp', 'pa.expectPowerFx', 'd365.verifyDataverse']));
    } finally {
      a.off();
    }
  });
});
