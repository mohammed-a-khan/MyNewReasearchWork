/**
 * Several users in one Gherkin scenario (`@actors:desk=receptionist,doc=vet`, `I act as` / `I continue as`,
 * `ctx.actors` in a definition), signing in as another role in a context that is signed in already (its cookies
 * and storage are cleared first), and the console noise allowlist (`console.ignore`) in checks, diagnostics,
 * reports and config layers. Real browser against the clinic app.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from '../support/testkit.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { StepResult } from '../../src/core/index.js';
import { loadConfig } from '../../src/config/index.js';
import { byId, cli, latestRun, tree } from './helpers.js';
import { clinicProject, startClinicApp, type ClinicApp, type ClinicProject } from '../support/clinic.js';

let app: ClinicApp;
let project: ClinicProject | undefined;
beforeAll(async () => {
  app = await startClinicApp();
});
afterAll(async () => {
  await app?.close();
});
afterEach(async () => {
  await project?.remove();
  project = undefined;
});
const gs = (j: { steps: StepResult[] }) => j.steps.filter((s) => s.gherkin?.kind === 'step');

const CONFIG = [
  'identity:',
  '  sessionMaxAgeMinutes: 0.0001',
  '  roles:',
  '    receptionist: { username: desk, password: "Desk#2026", loginUrl: /login, successUrl: /home }',
  '    vet: { username: vet, password: "Vet#2026", loginUrl: /login, successUrl: /home }',
  'console:',
  '  ignore: ["ResizeObserver loop", "^chat-widget:"]',
].join('\n');

const FEATURE = `Feature: Front desk and vet

  @actors:desk=receptionist,doc=vet
  Scenario: The desk and the vet work side by side
    Given I act as "desk"
    And I am on "/home"
    Then the page contains "Signed in as desk"
    When I continue as "doc"
    And I am on "/home"
    Then the page contains "Signed in as vet"
    And both actors are signed in
    When I continue as "desk"
    Then the page contains "Signed in as desk"

  Scenario: Signing in as another role signs out first
    Given I am logged in as "receptionist"
    And I am on "/home"
    Then the page contains "Signed in as desk"
    When I am logged in as "vet"
    And I am on "/home"
    Then the page contains "Signed in as vet"
    And the page contains "Users seen here: vet"

  Scenario: Known console noise is ignored
    Given I am on "/noisy"
    Then there are no console errors

  Scenario: A real console error still counts
    Given I am on "/noisy?real=1"
    Then there are no console errors
`;

const STEPS = `import { Then } from 'eztest/bdd';
Then('both actors are signed in', async ({ actors }) => {
  await actors.desk.expect.ui.page().toContainText('Signed in as desk');
  await actors.doc.expect.ui.page().toContainText('Signed in as vet');
});
`;

describe('BDD: several users, role switches and console noise (real browser)', () => {
  it('runs actors from tags, clears a signed-in context before another role, and ignores configured console noise', async () => {
    project = await clinicProject(CONFIG, { 'features/desk.feature': FEATURE, 'steps/desk.steps.ts': STEPS }, { appUrl: app.url });
    await cli(project.dir, ['run']);
    const { dir, run } = await latestRun(project.dir);
    const summary = run.journeys.map((j) => `${j.journeyId} ${j.status} ${j.error?.message ?? ''}\n${tree(j.steps, 1)}`).join('\n');

    const side = byId(run, 'desk--the-desk-and-the-vet-work-side-by-side');
    expect(side.status, summary).toBe('passed');
    // Each actor signed in with its role in its own context when it first acted; steps are labelled with the actor.
    const steps = gs(side);
    expect(steps[0].gherkin).toMatchObject({ match: 'ez', location: 'actor' });
    expect(steps[0].children?.[0]).toMatchObject({ intent: 'Log in as receptionist', status: 'passed' });
    expect(steps[3].children?.[0]).toMatchObject({ intent: 'Log in as vet', status: 'passed' });
    expect(steps.map((s) => s.actor)).toEqual(['desk', 'desk', 'desk', 'doc', 'doc', 'doc', 'doc', 'desk', 'desk']);
    expect(steps[6].gherkin?.match).toBe('definition');

    // The second login cleared the receptionist's cookie and storage: the vet's home page had nothing stored.
    const sw = byId(run, 'desk--signing-in-as-another-role-signs-out-first');
    expect(sw.status, summary).toBe('passed');
    expect(gs(sw)[3].captured).toMatchObject({ signedOut: 'receptionist', signedIn: 'vet' });

    // console.ignore: the noise does not fail "no console errors"; a real error does, and only it is reported.
    expect(byId(run, 'desk--known-console-noise-is-ignored').status, summary).toBe('passed');
    const real = byId(run, 'desk--a-real-console-error-still-counts');
    expect(real.status).toBe('failed');
    const failed = gs(real).at(-1)!;
    expect(failed.error?.message).toContain('Appointment list failed to load');
    expect(failed.error?.message).not.toContain('ResizeObserver');
    // The report counts the ignored messages ("3 messages, 2 ignored").
    const html = await readFile(join(dir, 'report.html'), 'utf8');
    expect(html).toContain('"ig":1');
    expect(html).toContain(' ignored');
  });

  it('console.ignore patterns of the base config, the project and the environment add up', async () => {
    project = await clinicProject([
      'console:',
      '  ignore: ["base-noise"]',
      'projects:',
      '  frontdesk:',
      '    console: { ignore: ["project-noise"] }',
      '    environments:',
      '      sit: { console: { ignore: ["inline-env-noise"] } }',
    ].join('\n'));
    await mkdir(join(project.dir, 'config'), { recursive: true });
    await writeFile(join(project.dir, 'config', 'sit.yaml'), 'console:\n  ignore: ["env-noise"]\n');
    const loaded = await loadConfig({ cwd: project.dir, env: 'sit', project: 'frontdesk', environment: {} });
    expect(loaded.config.console.ignore).toEqual(['base-noise', 'project-noise', 'env-noise', 'inline-env-noise']);
  });
});
