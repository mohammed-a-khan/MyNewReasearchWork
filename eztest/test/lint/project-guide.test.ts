/**
 * The lint rules that enforce the EZTest Project Guide (docs/project-guide.md#lint-rules): each one
 * finds what it should and nothing else (a positive and a negative case per rule), every finding names
 * its guide section, the rules can be turned off or re-graded in eztest.config.yaml (lint:) or with
 * --rule, and --format junit gives CI a test case per file.
 */
import { afterAll, describe, expect, it } from '../support/testkit.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { formatJunit, LINT_RULES, lintCode, lintJourney, lintPaths, type LintOptions, type LintReport } from '../../src/lint/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { buildProgram } from '../../src/cli/program.js';

/** A journey that follows the guide; tests change one thing at a time. */
const GOOD = (body = 'Open /orders\nClick the "Save" button\n  Expect the page contains "Saved"\n', head = '') => `Journey: Save an order\nId: web-orders-save\nTags: @regression @orders\n${head}\n${body}`;

const rulesOf = (text: string, file = 'apps/web/journeys/orders/a.ez', o: LintOptions = {}) => lintJourney(parseEzScript(text), file, text, o).map((f) => f.rule);

const made: string[] = [];
afterAll(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'eztest-lint-guide-'));
  made.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

const by = (r: LintReport, rule: string) => r.findings.filter((f) => f.rule === rule).map((f) => `${f.file}${f.line ? `:${f.line}` : ''}`);

describe('project guide lint rules: journeys', () => {
  it('a journey that follows the guide has no findings', () => {
    expect(rulesOf(GOOD())).toEqual([]);
  });

  it('raw-selector: a target found only by CSS or XPath; not names, labels, test ids or elements', () => {
    expect(rulesOf(GOOD('Open /orders\nClick css=.btn-primary.save\n  Expect the page contains "Saved"\n'))).toEqual(['raw-selector']);
    expect(rulesOf(GOOD('Open /orders\nClick xpath=//button[@id="save"]\n  Expect the page contains "Saved"\n'))).toEqual(['raw-selector']);
    expect(rulesOf(GOOD('Open /orders\nClick testid=save\n  Expect the page contains "Saved"\n'))).toEqual([]);
    expect(rulesOf(GOOD('Open /orders\nClick the @Orders.save button\n  Expect the page contains "Saved"\n'))).toEqual([]);
    expect(rulesOf(GOOD('Open /orders\nType "2" into the Quantity field\nClick the "Save" button\n  Expect the page contains "Saved"\n'))).toEqual([]);
    // An absolute XPath is reported as such, not twice.
    expect(rulesOf(GOOD('Open /orders\nClick xpath=/html/body/div[2]/button\n  Expect the page contains "Saved"\n'))).toEqual(['absolute-xpath']);
  });

  it('no-assertion: a journey that checks nothing; library and setup journeys are exempt', () => {
    expect(rulesOf(GOOD('Open /orders\nType "2" into the Quantity field\n'))).toEqual(['no-assertion']);
    expect(rulesOf(GOOD('Open /orders\nExpect the page contains "Orders"\n'))).toEqual([]);
    expect(rulesOf('Journey: Open orders\nId: lib-open-orders\nTags: @library\nOpen /orders\n')).toEqual([]);
  });

  it('missing-tags and missing-id', () => {
    expect(rulesOf('Journey: X\nId: x\n\nOpen /\nExpect the page contains "Hi"\n')).toEqual(['missing-tags']);
    expect(rulesOf('Journey: X\nTags: @smoke\n\nOpen /\nExpect the page contains "Hi"\n')).toEqual(['missing-id']);
    expect(rulesOf('Journey: X\nId: x\nTags: @smoke\n\nOpen /\nExpect the page contains "Hi"\n')).toEqual([]);
    // YAML journeys: an `id:` key.
    const yaml = 'id: x\nname: X\ntags: [smoke]\nsteps:\n  - Open /\n  - Expect the page contains "Hi"\n';
    const j = parseEzScript('Journey: X\nId: x\nTags: @smoke\nOpen /\nExpect the page contains "Hi"\n');
    expect(lintJourney(j, 'x.yaml', yaml).map((f) => f.rule)).toEqual([]);
    expect(lintJourney(j, 'x.yaml', yaml.replace('id: x\n', '')).map((f) => f.rule)).toEqual(['missing-id']);
  });

  it('hardcoded-host: fixed hosts in steps and Base URL; paths and ${VARS} are fine', () => {
    expect(rulesOf(GOOD('Open https://web.sit.corp.test/orders\nExpect the page contains "Orders"\n'))).toEqual(['hardcoded-host']);
    expect(rulesOf(GOOD('Open /orders\nExpect the page contains "Orders"\n', 'Base URL: https://web.sit.corp.test'))).toEqual(['hardcoded-host']);
    expect(rulesOf(GOOD('Call API "GET https://api.corp.test/orders" and store as orders\n  Expect the response status is 200\n'))).toEqual(['hardcoded-host']);
    expect(rulesOf(GOOD('Open ${PARTNER_URL}/orders\nExpect the page contains "Orders"\n'))).toEqual([]);
    expect(rulesOf(GOOD('Open /orders\nExpect the page contains "Orders"\n', 'Base URL: ${PARTNER_URL}'))).toEqual([]);
  });

  it('missing-postcondition: submitting (Sign in, Enter in a field) and navigating (links) actions need a check after them', () => {
    expect(rulesOf(GOOD('Open /login\nClick the "Sign in" button\nExpect the page contains "Welcome"\n'))).toEqual([]); // the next line checks it
    expect(rulesOf(GOOD('Open /login\nClick the "Sign in" button\nOpen /orders\nExpect the page contains "Orders"\n'))).toEqual(['missing-postcondition']);
    expect(rulesOf(GOOD('Open /\nClick the "Orders" link\nType "x" into the Search field\nExpect the page contains "x"\n'))).toEqual(['missing-postcondition']);
    expect(rulesOf(GOOD('Open /\nClick the "Orders" link\n  Expect the URL contains "/orders"\n'))).toEqual([]);
    expect(rulesOf(GOOD('Open /\nPress Enter in the Search field\nOpen /x\nExpect the page contains "x"\n'))).toEqual(['missing-postcondition']);
    expect(rulesOf(GOOD('Open /\nPress Enter in the Search field\n  Expect the page contains "results"\n'))).toEqual([]);
  });

  it('code: hard-coded hosts, and code journeys without id or tags', () => {
    expect(lintCode("await ui.open('https://web.sit.corp.test/orders');\n", 'a.steps.ts').map((f) => f.rule)).toEqual(['hardcoded-host']);
    expect(lintCode("await api.get('/api/orders');\nawait ui.open('/orders');\n", 'a.steps.ts')).toEqual([]);
  });

  it('every rule names its section of the project guide', () => {
    for (const [id, r] of Object.entries(LINT_RULES)) expect(r.doc, id).toMatch(/^docs\/project-guide\.md#[a-z0-9-]+$/);
    const f = lintJourney(parseEzScript('Journey: X\nOpen /\nWait 2 seconds\n'), 'x.ez', 'Journey: X\nOpen /\nWait 2 seconds\n');
    expect(f.find((x) => x.rule === 'hard-wait')?.doc).toBe('docs/project-guide.md#no-fixed-waits');
  });
});

describe('project guide lint rules: across files', () => {
  it('duplicate-id across .ez, features and code journeys; missing @id: and tags on scenarios; ids in code', async () => {
    const dir = await project({
      'apps/web/journeys/orders/a.ez': GOOD(),
      'apps/web/journeys/orders/b.ez': GOOD(),
      'apps/web/features/orders/o.feature': '@orders\nFeature: O\n  @id:web-orders-save @smoke\n  Scenario: S\n    Given I am on "/orders"\n  Scenario: Untagged and without id\n    Given I am on "/orders"\n',
      'apps/web/code/orders/c.journey.ts': "import { journey } from '@eztech/eztest/sdk';\njourney('No id', { tags: ['@orders'] }, async ({ ui }) => { await ui.open('/'); });\njourney('No tags', { id: 'web-orders-no-tags' }, async () => {});\njourney('Fine', { id: 'web-orders-fine', tags: ['@orders'] }, async () => {});\n",
    });
    const r = await lintPaths(['apps'], { cwd: dir });
    // The scenario's @id: comes first (files are read in path order); both journeys repeat it, at their Id: line.
    expect(by(r, 'duplicate-id').sort()).toEqual(['apps/web/journeys/orders/a.ez:2', 'apps/web/journeys/orders/b.ez:2']);
    expect(r.findings.find((f) => f.rule === 'duplicate-id')?.message).toBe('journey id "web-orders-save" is also used by apps/web/features/orders/o.feature:4');
    expect(r.findings.find((f) => f.rule === 'duplicate-id')?.severity).toBe('error');
    expect(by(r, 'missing-id')).toEqual(['apps/web/code/orders/c.journey.ts:2', 'apps/web/features/orders/o.feature:6']);
    // The second scenario inherits @orders from the feature: tagged. The code journey without tags is reported.
    expect(by(r, 'missing-tags')).toEqual(['apps/web/code/orders/c.journey.ts:3']);
  });

  it('repeated-selector: one raw selector in several steps is reported once, naming every place', async () => {
    const twice = await project({
      'apps/web/journeys/orders/a.ez': GOOD('Open /orders\nClick testid=save\n  Expect the page contains "Saved"\n'),
      'apps/web/journeys/orders/b.ez': GOOD('Open /orders\nClick testid=save\n  Expect the page contains "Saved"\n').replace('web-orders-save', 'web-orders-save-2'),
    });
    const r = await lintPaths(['apps'], { cwd: twice });
    expect(by(r, 'repeated-selector')).toEqual(['apps/web/journeys/orders/a.ez:6']);
    expect(r.findings.find((f) => f.rule === 'repeated-selector')?.message).toMatch(/testid=save is written 2 times \(apps\/web\/journeys\/orders\/a\.ez:6, apps\/web\/journeys\/orders\/b\.ez:6\)/);
    const once = await project({ 'apps/web/journeys/orders/a.ez': GOOD('Open /orders\nClick testid=save\n  Expect the page contains "Saved"\n') });
    expect(by(await lintPaths(['apps'], { cwd: once }), 'repeated-selector')).toEqual([]);
  });

  it('undeclared-dependency: a value only another journey captures, unless Depends on:, a run-wide Setup value or a config variable', async () => {
    const create = GOOD('Open /orders/new\nClick the "Place order" button\n  Expect the page contains "created"\nCapture the text of testid=order-number as orderNumber\n').replace('web-orders-save', 'web-orders-create');
    const use = (head = '') => GOOD('Open /orders/${orderNumber}\nExpect the page contains "${orderNumber}"\n', head).replace('web-orders-save', 'web-orders-approve');
    const dir = await project({ 'apps/web/journeys/orders/create.ez': create, 'apps/web/journeys/orders/approve.ez': use() });
    const r = await lintPaths(['apps'], { cwd: dir });
    expect(by(r, 'undeclared-dependency')).toEqual(['apps/web/journeys/orders/approve.ez:5']);
    expect(r.findings.find((f) => f.rule === 'undeclared-dependency')?.suggestion).toMatch(/Depends on: web-orders-create with orderNumber/);
    const declared = await project({ 'apps/web/journeys/orders/create.ez': create, 'apps/web/journeys/orders/approve.ez': use('Depends on: web-orders-create with orderNumber') });
    expect(by(await lintPaths(['apps'], { cwd: declared }), 'undeclared-dependency')).toEqual([]);
    // A config variable of that name, or a value nobody else captures (a --var), is not a dependency.
    expect(by(await lintPaths(['apps'], { cwd: dir, variables: ['orderNumber'] }), 'undeclared-dependency')).toEqual([]);
    const alone = await project({ 'apps/web/journeys/orders/approve.ez': use() });
    expect(by(await lintPaths(['apps'], { cwd: alone }), 'undeclared-dependency')).toEqual([]);
    // A Setup journey's Returns are run-wide values.
    const setup = await project({
      'apps/web/journeys/orders/setup.ez': 'Setup: Create the shared order\nId: web-orders-setup\nReturns: orderNumber\nOpen /orders/new\nCapture the text of testid=order-number as orderNumber\n  Expect the page contains "ORD"\n',
      'apps/web/journeys/orders/approve.ez': use(),
    });
    expect(by(await lintPaths(['apps'], { cwd: setup }), 'undeclared-dependency')).toEqual([]);
  });

  it('undefined-step and ambiguous-step: Gherkin steps against the step definitions, read as text', async () => {
    const dir = await project({
      'apps/web/features/orders/o.feature': '@orders\nFeature: O\n  @id:web-o-1 @smoke\n  Scenario: S\n    Given I am logged in as "clerk"\n    When I place an order\n    Then the invoice is sent twice\n    And the total is right\n',
      'apps/web/steps/orders.steps.ts': "import { When, Then } from '@eztech/eztest/bdd';\nWhen('I place an order', async () => {});\nThen('the total is right', async () => {});\nThen(/^the total is (right|wrong)$/, async () => {});\n",
    });
    const r = await lintPaths(['apps'], { cwd: dir, bdd: { steps: ['apps/web/steps/**/*.steps.ts'] } });
    expect(by(r, 'undefined-step')).toEqual(['apps/web/features/orders/o.feature:7']);   // line 5 is an EZTest phrasing, line 6 has a definition
    expect(by(r, 'ambiguous-step')).toEqual(['apps/web/features/orders/o.feature:8']);
    expect(r.findings.find((f) => f.rule === 'undefined-step')?.suggestion).toContain("Then('the invoice is sent twice'");
    // Per project: each application's features bind to that application's definitions only.
    const two = await project({
      'apps/a/features/x/o.feature': '@x\nFeature: O\n  @id:a-o @smoke\n  Scenario: S\n    When I place an order\n',
      'apps/a/steps/a.steps.ts': "import { When } from '@eztech/eztest/bdd';\nWhen('I place an order', async () => {});\n",
      'apps/b/steps/b.steps.ts': "import { When } from '@eztech/eztest/bdd';\nWhen('I place an order', async () => {});\n",
    });
    expect(by(await lintPaths(['apps'], { cwd: two, bdd: { steps: ['apps/*/steps/**/*.steps.ts'] } }), 'ambiguous-step')).toEqual(['apps/a/features/x/o.feature:5']);
    expect(by(await lintPaths(['apps'], { cwd: two, bdd: { steps: ['apps/*/steps/**/*.steps.ts'] }, bddScopes: [{ dir: 'apps/a', steps: ['apps/a/steps/**/*.steps.ts'] }] }), 'ambiguous-step')).toEqual([]);
  });

  it('plaintext-secret in data, config layers and .env.example; references, roles\' field names and empty values are fine', async () => {
    const dir = await project({
      'apps/web/data/dev/users.csv': 'user,password,role\nann,Summer#2026,clerk\nbob,${BOB_PASSWORD},clerk\n',
      'apps/web/data/dev/partners.json': JSON.stringify({ partners: [{ name: 'acme', apiKey: 'k-12345678' }, { name: 'zed', apiKey: 'secret://env/ZED_KEY' }] }, null, 2),
      'config/web/sit.yaml': 'identity:\n  roles:\n    clerk:\n      username: sit-clerk\n      password: Winter#2026\n      fields: { username: Staff ID, password: Passphrase }\n    lead:\n      password: secret://env/LEAD_PASSWORD\n      api: { tokenUrl: /oauth/token, clientAuth: client_secret_post, clientSecret: ENC(v1:abc) }\n',
      'eztest.config.yaml': 'baseUrl: http://localhost:3000\nlint:\n  rules: { plaintext-secret: error }\n',
      '.env.example': '# names only\nEZTEST_SECRET_WEB_CLERK_PASSWORD=\nEZTEST_SECRET_WEB_API_TOKEN=abc123xyz\nWEB_BASE_URL=http://localhost:3000\n',
    });
    const r = await lintPaths(['apps', 'config', 'eztest.config.yaml', '.env.example'], { cwd: dir });
    expect(by(r, 'plaintext-secret')).toEqual(['.env.example:3', 'apps/web/data/dev/partners.json:5', 'apps/web/data/dev/users.csv:2', 'config/web/sit.yaml:5']);
    expect(r.findings.map((f) => f.message).join(' ')).not.toMatch(/Summer#2026|Winter#2026|k-12345678|abc123xyz/);
  });

  it('outside-layout: test files where the layout does not put them, only in projects with apps/', async () => {
    const files = {
      'apps/web/journeys/orders/fine.ez': GOOD(),
      'apps/web/journeys/no-module.ez': GOOD().replace('web-orders-save', 'web-no-module'),
      'apps/web/journeys/orders/wrong.feature': '@orders\nFeature: F\n  @id:web-f @smoke\n  Scenario: S\n    Given I am on "/orders"\n',
      'apps/web/tests/stray.ez': GOOD().replace('web-orders-save', 'web-stray'),
      'apps/web/data/orders.csv': 'case,customer\na,b\n',
      'apps/web/data/dev/orders.csv': 'case,customer\na,b\n',
      'apps/web/elements/orders.yaml': 'screen: Orders\nelements:\n  save: testid=save\n',
      'journeys/old.ez': GOOD().replace('web-orders-save', 'old'),
      'shared/steps/common.steps.ts': "import { Given } from '@eztech/eztest/bdd';\nGiven('the app is up', async () => {});\n",
      'tools/build.ts': 'export const x = 1;\n',
    };
    const dir = await project(files);
    const r = await lintPaths(['apps', 'journeys', 'shared', 'tools'], { cwd: dir });
    expect(by(r, 'outside-layout').sort()).toEqual([
      'apps/web/data/orders.csv', 'apps/web/journeys/no-module.ez', 'apps/web/journeys/orders/wrong.feature', 'apps/web/tests/stray.ez', 'journeys/old.ez',
    ]);
    // Without an apps/ folder the project does not use the layout: nothing is out of place.
    const flat = await project({ 'journeys/old.ez': GOOD().replace('web-orders-save', 'old') });
    expect(by(await lintPaths(['journeys'], { cwd: flat }), 'outside-layout')).toEqual([]);
    expect(by(await lintPaths(['journeys'], { cwd: flat, layout: true }), 'outside-layout')).toEqual(['journeys/old.ez']);
  });
});

describe('project guide lint rules: configuration and output', () => {
  async function cli(dir: string, args: string[]): Promise<{ out: string; err: string; code: number }> {
    const out: string[] = [];
    const err: string[] = [];
    process.exitCode = 0;
    await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd: dir, env: {} }).parseAsync(['node', 'eztest', 'lint', ...args]);
    const code = Number(process.exitCode ?? 0);
    process.exitCode = 0;
    return { out: out.join('\n'), err: err.join('\n'), code };
  }

  it('lint: in eztest.config.yaml turns rules off or changes their severity; --rule wins; unknown rules are named', async () => {
    const dir = await project({
      'apps/web/journeys/orders/a.ez': 'Journey: A\nOpen https://web.sit.corp.test/\nWait 2 seconds\nType "x" into the Search field\nExpect the page contains "A"\n',
      'eztest.config.yaml': 'baseUrl: http://localhost:3000\njourneysDir: apps\nlint:\n  rules: { missing-tags: error, hardcoded-host: off, no-such-rule: warning }\n',
    });
    const r = await cli(dir, ['--format', 'json']);
    const report = JSON.parse(r.out) as LintReport;
    expect(report.findings.map((f) => `${f.rule}:${f.severity}`).sort()).toEqual(['hard-wait:warning', 'missing-id:warning', 'missing-tags:error']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/lint\.rules\.no-such-rule: unknown lint rule/);
    const r2 = await cli(dir, ['--format', 'json', '--rule', 'missing-tags=off', '--rule', 'hardcoded-host=error']);
    expect((JSON.parse(r2.out) as LintReport).findings.map((f) => `${f.rule}:${f.severity}`).sort()).toEqual(['hard-wait:warning', 'hardcoded-host:error', 'missing-id:warning']);
  });

  it('without paths it lints the journeys folder, the feature folders, shared/, config/, the config file and .env.example', async () => {
    const dir = await project({
      'eztest.config.yaml': 'baseUrl: http://localhost:3000\njourneysDir: apps\n',
      'apps/web/journeys/orders/a.ez': GOOD(),
      'shared/helpers/h.ts': "export const host = () => fetch('https://api.corp.test/x');\n",
      'config/sit.yaml': 'vars:\n  API_TOKEN: tok-1234567\n',
      '.env.example': 'EZTEST_SECRET_X_PASSWORD=\n',
    });
    const report = JSON.parse((await cli(dir, ['--format', 'json'])).out) as LintReport;
    expect(report.fileList?.sort()).toEqual(['.env.example', 'apps/web/journeys/orders/a.ez', 'config/sit.yaml', 'eztest.config.yaml', 'shared/helpers/h.ts']);
    expect(report.findings.map((f) => `${f.rule} ${f.file}`).sort()).toEqual(['hardcoded-host shared/helpers/h.ts', 'plaintext-secret config/sit.yaml']);
  });

  it('--format junit: one test case per file, failed for errors and warnings, with the fix and the guide section', async () => {
    const dir = await project({ 'eztest.config.yaml': 'journeysDir: apps\n', 'apps/web/journeys/orders/a.ez': GOOD('Open /\nWait 2 seconds\nType "x" into the Search field\nExpect the page contains "A"\n'), 'apps/web/journeys/orders/b.ez': GOOD().replace('web-orders-save', 'web-orders-b') });
    const r = await cli(dir, ['--format', 'junit']);
    expect(r.out).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(r.out).toMatch(/<testsuite name="eztest lint" tests="3" failures="1"/);
    expect(r.out).toMatch(/<testcase classname="eztest\.lint" name="apps\/web\/journeys\/orders\/a\.ez">\s*<failure type="lint" message="0 error\(s\), 1 warning\(s\): hard-wait">[^<]*see: docs\/project-guide\.md#no-fixed-waits/);
    expect(r.out).toMatch(/<testcase classname="eztest\.lint" name="apps\/web\/journeys\/orders\/b\.ez">\s*<\/testcase>/);
    const empty = formatJunit({ files: 0, fileList: [], findings: [], counts: { error: 0, warning: 0, info: 0 } });
    expect(empty).toMatch(/tests="0" failures="0"/);
  });
});
