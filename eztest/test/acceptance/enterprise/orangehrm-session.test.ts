/**
 * Acceptance on a REAL OrangeHRM 5.7 (no database needed): a cached role session checked on a busy page.
 *
 * The role's verifyUrl is the dashboard, a page that keeps requesting after it opens (widgets, avatars, polls).
 * Checking a cached session routes the requests that leave the app's origin while verifyUrl opens and unroutes
 * afterwards; requests still paused then were answered after the browser had turned interception off, and the
 * worker died with "Fetch.continueRequest: Fetch domain is not enabled" (4 of 4 runs). Every run after the first
 * reuses the cached session, on parallel workers.
 *
 *   EZTEST_ORANGEHRM_URL=http://127.0.0.1:18080 EZTEST_ORANGEHRM_PASSWORD=... npm test -- test/acceptance/enterprise/orangehrm-session
 *
 * Skipped, with a message, without them.
 */
import { afterAll, beforeAll, describe, expect, it } from '../../support/testkit.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cli, failures, lastRun, urlUp } from './helpers.js';

const APP = process.env.EZTEST_ORANGEHRM_URL?.replace(/\/$/, '');
const PASSWORD = process.env.EZTEST_ORANGEHRM_PASSWORD;

async function available(): Promise<string | undefined> {
  if (!APP || !PASSWORD) return 'set EZTEST_ORANGEHRM_URL and EZTEST_ORANGEHRM_PASSWORD';
  if (!(await urlUp(`${APP}/web/index.php/auth/login`))) return `OrangeHRM does not answer at ${APP}`;
  return undefined;
}
const skip = await available();
if (skip) console.warn(`[acceptance] OrangeHRM cached session skipped: ${skip}`);

describe.skipIf(!!skip)('OrangeHRM: a cached session checked on the busy dashboard (real app)', () => {
  let project: string;
  const env: NodeJS.ProcessEnv = {};

  beforeAll(async () => {
    project = await mkdtemp(join(tmpdir(), 'eztest-accept-ohrm-session-'));
    await mkdir(join(project, 'journeys'));
    await writeFile(join(project, 'eztest.config.yaml'), [
      `baseUrl: ${APP}`,
      'journeysDir: journeys',
      'outputDir: eztest-results',
      'reporters: [json]',
      'healing: { enabled: false }',
      'identity:',
      '  secretStores: [{ type: env, prefix: EZTEST_SECRET_ }]',
      '  roles:',
      '    admin:',
      '      loginUrl: /web/index.php/auth/login',
      '      username: Admin',
      '      password: secret://env/OHRM_ADMIN_PASSWORD',
      '      verifyUrl: /web/index.php/dashboard/index',
      '',
    ].join('\n'));
    for (const [i, page] of ['pim/viewEmployeeList', 'admin/viewSystemUsers', 'leave/viewLeaveList', 'dashboard/index'].entries()) {
      await writeFile(join(project, 'journeys', `j${i}.ez`), [
        `Journey: Cached session ${i}`,
        'Role: admin',
        '',
        'Log in',
        `Open /web/index.php/${page}`,
        'Expect the URL does not contain "/auth/login"',
        '',
      ].join('\n'));
    }
    Object.assign(env, process.env, { EZTEST_SECRET_OHRM_ADMIN_PASSWORD: PASSWORD });
  });

  afterAll(async () => {
    if (project) await rm(project, { recursive: true, force: true });
  });

  it('the first run signs in; three more runs on 2 workers check the cached session on the dashboard and go on', async () => {
    for (let round = 0; round < 4; round++) {
      const r = await cli(project, ['run', 'journeys', '-w', '2'], env);
      const { run } = await lastRun(project);
      expect({ round, failures: failures(run.journeys), errors: run.journeys.filter((j) => j.status !== 'passed').map((j) => j.error?.message ?? j.status) }).toEqual({ round, failures: [], errors: [] });
      expect(run.journeys).toHaveLength(4);
      expect(r.exitCode).toBe(0);
    }
  }, 600_000);
});
