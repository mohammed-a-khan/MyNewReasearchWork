/**
 * The Azure Pipelines YAML templates shipped in integrations/azure-devops:
 * they parse (template expressions included), the multi-stage example has
 * nightly and weekly schedules and runs the environment tests as deployment
 * jobs, and the stage template offers the "run after deployment" job and
 * passes the pipelines: entry to the task and the CLI.
 */
import { describe, expect, it } from '../support/testkit.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseDocument, parse } from 'yaml';

const T = (f: string) => fileURLToPath(new URL(`../../integrations/azure-devops/templates/${f}`, import.meta.url));
async function yaml(f: string): Promise<any> {
  const text = await readFile(T(f), 'utf8');
  const doc = parseDocument(text, { uniqueKeys: true, strict: true });
  if (doc.errors.length) throw new Error(`${f}: ${doc.errors.map((e) => e.message).join('; ')}`);
  return parse(text);
}

describe('Azure DevOps YAML templates', () => {
  it('multi-stage example: schedules, PR, scheduled regression and deployment-job test stages', async () => {
    const p = await yaml('azure-pipelines.multistage.yml');
    expect(p.schedules.map((s: { cron: string }) => s.cron)).toEqual(['0 2 * * 1-5', '0 4 * * 6']);
    expect(p.schedules.every((s: { always: boolean }) => s.always)).toBe(true);
    const text = JSON.stringify(p.stages);
    expect(text).toMatch(/"pipeline":"pr"/);
    expect(text).toMatch(/"pipeline":"nightly","shards":4/);
    expect(text).toMatch(/"pipeline":"deploy-sit","deploymentEnvironment":"sit"/);
    expect(text).toMatch(/"pipeline":"deploy-uat","deploymentEnvironment":"uat"/);
    expect(await readFile(T('azure-pipelines.multistage.yml'), 'utf8')).toMatch(/Invoke REST API.*\n.*deployments\?environment=sit&version=\$\(Build\.BuildNumber\)/);
  });

  it('stage template: a job for shards, a deployment job in the environment after deployment', async () => {
    const s = await yaml('eztest-stage.yml');
    expect(s.parameters.map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining(['pipeline', 'deploymentEnvironment']));
    const jobs = s.stages[0].jobs;
    const asJob = jobs.find((j: Record<string, unknown>) => Object.keys(j)[0].includes("eq(parameters.deploymentEnvironment, '')"));
    const asDeployment = jobs.find((j: Record<string, unknown>) => Object.keys(j)[0].includes("ne(parameters.deploymentEnvironment, '')"));
    expect(Object.values(asJob)[0]).toEqual([expect.objectContaining({ job: 'journeys' })]);
    const d = (Object.values(asDeployment)[0] as Array<Record<string, any>>)[0];
    expect(d).toMatchObject({ deployment: 'journeys', environment: '${{ parameters.deploymentEnvironment }}' });
    expect(d.strategy.runOnce.deploy.steps[0]).toEqual({ checkout: 'self', fetchDepth: 0 });
    expect(d.strategy.runOnce.deploy.steps[1].parameters.pipeline).toBe('${{ parameters.pipeline }}');
  });

  it('steps template: EZTEST_PIPELINE for the task and the CLI, a named run step for output variables', async () => {
    const text = await readFile(T('eztest-steps.yml'), 'utf8');
    await yaml('eztest-steps.yml');
    expect(text.match(/EZTEST_PIPELINE: \$\{\{ parameters\.pipeline \}\}/g)).toHaveLength(2);
    expect(text).toMatch(/name: eztest {3}# values saved "for the pipeline" are output variables: eztest\.<name>/);
  });
});
