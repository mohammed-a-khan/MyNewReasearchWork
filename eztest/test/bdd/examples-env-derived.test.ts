/**
 * Two things a consumer project found on 0.1.0-beta.5, exercised the way it uses them (`eztest run -e dev`):
 *  - the built-in `${env}` in an `Examples: from data "data/${env}/..."` path (it was left as written, so the data
 *    file was "not found" and the outline was skipped; `eztest validate` reported the same);
 *  - a derived column with a string argument (`with ref = unique('H', 10)`) used in quoted step text `"<ref>"`
 *    (its quotes were rewritten to double quotes, which ended the step's string early: "undefined step").
 */
import { afterEach, describe, expect, it } from '../support/testkit.js';
import { cli, latestRun } from './helpers.js';
import { clinicProject, type ClinicProject } from '../support/clinic.js';

let project: ClinicProject | undefined;
afterEach(async () => {
  await project?.remove();
  project = undefined;
});

const FEATURE = `Feature: Visits
  Scenario Outline: Book a visit for <petName>
    When I book a visit for "<petName>" with reference "<ref>"
    Then the reference "<ref>" starts with "H" and has 10 characters

    Examples: from data "data/\${env}/visits.json" where caseId = VIS_01 and enabled = Yes with ref = unique('H', 10)
`;

const STEPS = `
import { When, Then } from 'eztest/bdd';
When('I book a visit for {string} with reference {string}', async ({ vars }, pet: string, ref: string) => {
  vars.set('booked', { pet, ref });
});
Then('the reference {string} starts with {string} and has {int} characters', async ({ vars, expect }, ref: string, prefix: string, n: number) => {
  await expect(ref.startsWith(prefix), ref).toBe(true);
  await expect(ref.length, ref).toBe(n);
  await expect(ref).toBe((vars.get('booked') as { ref: string }).ref);
});
`;

async function setup(): Promise<ClinicProject> {
  return clinicProject('bdd:\n  steps: ["steps/**/*.steps.ts"]\n', {
    'config/dev.yaml': 'retries: 0\n',
    'features/visits.feature': FEATURE,
    'steps/visits.steps.ts': STEPS,
    'data/dev/visits.json': JSON.stringify([
      { caseId: 'VIS_01', enabled: 'Yes', petName: 'Rex' },
      { caseId: 'VIS_01', enabled: 'Yes', petName: 'Mia' },
      { caseId: 'VIS_02', enabled: 'Yes', petName: 'Other' },
      { caseId: 'VIS_01', enabled: 'No', petName: 'Off' },
    ]),
  });
}

describe('Examples from per-environment data with derived columns', () => {
  it('eztest run -e dev reads data/dev/... and binds "<ref>" built from unique(\'H\', 10)', async () => {
    project = await setup();
    const r = await cli(project.dir, ['run', '-e', 'dev', 'features']);
    expect(r.err.join('\n')).not.toMatch(/not found|undefined step/i);
    const { run } = await latestRun(project.dir);
    const scenarios = run.journeys.filter((j) => !j.tags.includes('hook'));
    expect(scenarios.map((j) => j.name).sort()).toEqual(['Book a visit for Mia', 'Book a visit for Rex']);
    expect(scenarios.map((j) => [j.name, j.status, j.steps.filter((s) => s.status !== 'passed').map((s) => s.error?.message)])).toEqual(
      scenarios.map((j) => [j.name, 'passed', []]),
    );
  });

  it('eztest validate -e dev finds the per-environment data file', async () => {
    project = await setup();
    const r = await cli(project.dir, ['validate', '-e', 'dev', 'features']);
    expect([...r.out, ...r.err].join('\n')).not.toMatch(/data file not found|\$\{env\}/);
    expect(r.exitCode).toBe(0);
  });
});
