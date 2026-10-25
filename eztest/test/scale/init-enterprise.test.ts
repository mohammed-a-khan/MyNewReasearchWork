/**
 * `eztest init --template enterprise` writes exactly the layout of the EZTest Project Guide, never
 * overwrites a file (it reports the ones it left alone), and `--app` adds an application to an
 * existing project: its folder and config layers, its `projects.<app>` overlay (the config's comments
 * kept), its npm scripts and its .env.example lines. The config layers load for every application and
 * environment, the pipeline is valid YAML that validates and lints before it runs anything, and
 * `basic` stays the default template. (Running the samples: test/e2e/init-enterprise-run.test.ts.)
 */
import { afterAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { initProject } from '../../src/cli/init.js';
import { findJourneyFiles } from '../../src/cli/journeys.js';
import { buildProgram } from '../../src/cli/program.js';
import { loadConfig } from '../../src/config/index.js';

const made: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), `eztest-${prefix}-`));
  made.push(d);
  return d;
}
afterAll(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const n of await readdir(d)) {
      const p = join(d, n);
      if ((await stat(p)).isDirectory()) await walk(p);
      else out.push(relative(dir, p).split('\\').join('/'));
    }
  };
  await walk(dir);
  return out.sort();
}

const APP_FILES = (app: string, upper: string) => [
  `apps/${app}/code/orders/order-from-api.journey.ts`,
  `apps/${app}/data/dev/orders.csv`,
  `apps/${app}/data/sit/orders.csv`,
  `apps/${app}/data/uat/orders.csv`,
  `apps/${app}/elements/orders.yaml`,
  `apps/${app}/features/orders/place-order.feature`,
  `apps/${app}/helpers/orders-api.ts`,
  `apps/${app}/journeys/orders/place-order.ez`,
  `apps/${app}/queries/${app.replace(/-/g, '_')}_db/${upper}_ORDER_BY_NUMBER.sql`,
  `apps/${app}/screens/orders.ts`,
  `apps/${app}/steps/orders.steps.ts`,
  `config/${app}/dev.yaml`,
  `config/${app}/sit.yaml`,
  `config/${app}/uat.yaml`,
];

const PROJECT_FILES = [
  '.env.example', '.gitignore', 'README.md', 'config/dev.yaml', 'config/sit.yaml', 'config/uat.yaml', 'eztest.config.yaml',
  'package.json', 'pipelines/azure-pipelines.yml', 'readiness-policy.yaml', 'shared/helpers/unique.ts', 'shared/steps/common.steps.ts', 'tsconfig.json',
];

describe('eztest init --template enterprise', () => {
  it('writes the project guide layout with a sample of each style, and npm scripts', async () => {
    const dir = await tempDir('init-ent-layout');
    const r = await initProject(dir, { template: 'enterprise' });
    expect(await tree(dir)).toEqual([...PROJECT_FILES, ...APP_FILES('web', 'WEB')].sort());
    expect(r.skipped).toEqual([]);
    expect(r.updated).toEqual([]);
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(Object.keys(pkg.scripts)).toEqual(expect.arrayContaining([
      'test', 'test:dev', 'test:sit', 'test:uat', 'test:smoke', 'test:regression', 'test:orders', 'test:headless', 'test:headed', 'test:parallel',
      'test:web', 'lint', 'validate', 'studio', 'report',
    ]));
    expect(pkg.scripts['test:sit']).toBe('eztest run --project web -e sit');
    expect(pkg.scripts['test:orders']).toBe('eztest run --project web -e dev -t @orders');
    expect(pkg.scripts['test:headless']).toBe('eztest run --project web -e dev --headless');
    // .env.example names the secrets, without values; .env stays ignored and .env.example does not.
    const envExample = await readFile(join(dir, '.env.example'), 'utf8');
    expect(envExample).toMatch(/^EZTEST_SECRET_WEB_CLERK_PASSWORD=$/m);
    expect(envExample.split('\n').filter((l) => /^[A-Z_]+=./.test(l))).toEqual([]);
    const gi = (await readFile(join(dir, '.gitignore'), 'utf8')).split('\n');
    expect(gi).toEqual(expect.arrayContaining(['.env', '.env.*', '!.env.example']));
    // The README explains how to run per environment and module.
    const readme = await readFile(join(dir, 'README.md'), 'utf8');
    for (const s of ['npm run test:sit', 'npm run test:orders', 'npm run test:<app> -- -e uat', 'eztest init --app']) expect(readme).toContain(s);
  });

  it('the config layers load for every environment: hosts, data folder, database and roles per layer', async () => {
    const dir = await tempDir('init-ent-config');
    await initProject(dir, { template: 'enterprise' });
    const dev = (await loadConfig({ cwd: dir, project: 'web', env: 'dev', environment: {} })).config;
    expect(dev.journeysDir).toBe('apps/web');
    expect(dev.elements.dir).toBe('apps/web/elements');
    expect(dev.db.queries.dir).toBe('apps/web/queries');
    expect(dev.bdd.steps).toEqual(['apps/web/steps/**/*.steps.ts', 'shared/steps/**/*.steps.ts']);
    expect(dev.vars.DATA_ENV).toBe('dev');
    expect(dev.baseUrl).toBe('http://localhost:3000');
    expect(dev.db.connections.web_db).toMatchObject({ driver: 'sqlite' });
    expect(dev.identity.roles.clerk).toMatchObject({ username: 'clerk', password: 'secret://env/WEB_CLERK_PASSWORD' });
    expect(dev.identity.sessionDir).toBe('.eztest/sessions/web');
    const sit = (await loadConfig({ cwd: dir, project: 'web', env: 'sit', environment: { WEB_BASE_URL: 'https://web.sit.corp.test' } })).config;
    expect(sit.baseUrl).toBe('https://web.sit.corp.test');
    expect(sit.vars.DATA_ENV).toBe('sit');
    expect(sit.retries).toBe(1);
    expect(sit.db.connections.web_db).toMatchObject({ driver: 'postgres', password: 'secret://env/WEB_DB_PASSWORD' });
    expect(sit.identity.roles.clerk.username).toBe('sit-clerk');
    expect((await loadConfig({ cwd: dir, project: 'web', env: 'uat', environment: {} })).config.baseUrl).toBe('https://web.uat.example.test');
    // Without a project: every application's folder (lint, listings), every application's step definitions.
    const base = (await loadConfig({ cwd: dir, environment: {} })).config;
    expect(base.journeysDir).toBe('apps');
    expect(base.lint.maxWarnings).toBe(0);
    // The app folder holds journeys of three styles next to element files and JSON/YAML data: only journeys are found.
    await writeFile(join(dir, 'apps/web/data/dev/partners.json'), '[{"name":"acme"}]\n');
    const found = (await findJourneyFiles(['apps/web'], dir, { code: true })).map((f) => relative(dir, f).split('\\').join('/'));
    expect(found).toEqual(['apps/web/code/orders/order-from-api.journey.ts', 'apps/web/features/orders/place-order.feature', 'apps/web/journeys/orders/place-order.ez']);
    // A file named on the command line is always read as a journey (and reported if it is not one).
    expect(await findJourneyFiles(['apps/web/elements/orders.yaml'], dir)).toHaveLength(1);
  });

  it('eztest run has --headless next to --headed (the test:headless script)', () => {
    const run = buildProgram({ out: () => {}, err: () => {}, cwd: '.', env: {} }).commands.find((c) => c.name() === 'run')!;
    expect(run.options.map((o) => o.long)).toEqual(expect.arrayContaining(['--headed', '--headless']));
  });

  it('the pipeline is valid YAML: validate, element references and lint first, then smoke, regression shards and SIT per app', async () => {
    const dir = await tempDir('init-ent-pipeline');
    await initProject(dir, { template: 'enterprise' });
    const text = await readFile(join(dir, 'pipelines', 'azure-pipelines.yml'), 'utf8');
    const p = parse(text) as { parameters: Array<{ name: string; default: string[] }>; stages: Array<{ stage: string; dependsOn?: string }> };
    expect(p.parameters[0]).toMatchObject({ name: 'apps', default: ['web'] });
    expect(p.stages.map((s) => s.stage)).toEqual(['Checks', 'Smoke', 'Regression', 'TestSIT']);
    for (const s of p.stages.slice(1)) expect(s.dependsOn).toBe('Checks');
    for (const cmd of ['eztest validate --project ${{ app }} -e dev', 'eztest elements unused --project ${{ app }} -e dev --strict', 'eztest lint --format junit -o eztest-lint.xml',
      '--pipeline pr', '--pipeline nightly', 'eztest merge shards', 'eztest gate eztest-results/merged', 'eztest ado publish', '--pipeline deploy-sit', 'strategy: { parallel: 2 }']) {
      expect(text).toContain(cmd);
    }
    // The secrets the pipeline maps are the ones .env.example names.
    const env = (await readFile(join(dir, '.env.example'), 'utf8')).match(/^[A-Z_]+(?==)/gm)!;
    for (const name of new Set(text.match(/EZTEST_SECRET_[A-Z_]+(?=:)/g))) expect(env).toContain(name);
    // The pipelines: entries the YAML runs exist in the config.
    const cfg = (await loadConfig({ cwd: dir, project: 'web', environment: {} })).config;
    expect(Object.keys(cfg.pipelines)).toEqual(expect.arrayContaining(['pr', 'nightly', 'deploy-sit', 'deploy-uat']));
    expect(cfg.pipelines.nightly.shards).toBe(2);
  });

  it('never overwrites: existing files are reported and kept, a second init changes nothing', async () => {
    const dir = await tempDir('init-ent-keep');
    await writeFile(join(dir, 'README.md'), '# Our tests\n');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'ours', scripts: { test: 'our-own-runner', lint: 'our-linter' } }, null, 2));
    const r = await initProject(dir, { template: 'enterprise' });
    expect(r.skipped).toContain('README.md');
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('# Our tests\n');
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { name: string; scripts: Record<string, string> };
    expect(pkg.name).toBe('ours');
    expect(pkg.scripts.test).toBe('our-own-runner');      // existing scripts are never changed
    expect(pkg.scripts.lint).toBe('our-linter');
    expect(pkg.scripts['test:sit']).toBe('eztest run --project web -e sit');
    expect(r.updated.find((u) => u.startsWith('package.json'))).toMatch(/^package\.json \(scripts: test:dev, test:sit/);
    const before = new Map<string, string>();
    for (const f of await tree(dir)) before.set(f, await readFile(join(dir, f), 'utf8'));
    const again = await initProject(dir, { template: 'enterprise' });
    expect(again.created).toEqual([]);
    expect(again.updated).toEqual([]);
    expect(again.skipped).toEqual(expect.arrayContaining([...APP_FILES('web', 'WEB'), 'README.md', 'pipelines/azure-pipelines.yml', 'eztest.config.yaml (projects.web exists)', 'package.json (scripts)']));
    for (const [f, text] of before) expect(await readFile(join(dir, f), 'utf8'), f).toBe(text);
  });

  it('--app adds an application: its folder, config layers, project overlay, scripts and secret names', async () => {
    const dir = await tempDir('init-ent-app');
    await initProject(dir, { template: 'enterprise' });
    const cfgBefore = await readFile(join(dir, 'eztest.config.yaml'), 'utf8');
    const r = await initProject(dir, { app: 'back-office' });
    expect(r.created.sort()).toEqual(APP_FILES('back-office', 'BACK_OFFICE').sort());
    expect(r.updated).toEqual([
      'eztest.config.yaml (projects.back-office)',
      '.env.example (EZTEST_SECRET_BACK_OFFICE_CLERK_PASSWORD, EZTEST_SECRET_BACK_OFFICE_DB_PASSWORD)',
      'package.json (scripts: test:back-office, validate:back-office, studio:back-office; now over web, back-office: test, test:dev, test:sit, test:uat, test:smoke, test:regression, test:orders, test:headed, test:headless, test:parallel, validate, doctor)',
      'pipelines/azure-pipelines.yml (apps: back-office; secrets: EZTEST_SECRET_BACK_OFFICE_CLERK_PASSWORD, EZTEST_SECRET_BACK_OFFICE_DB_PASSWORD)',
    ]);
    expect(r.next.at(-1)).toBe('define the secret variables EZTEST_SECRET_BACK_OFFICE_CLERK_PASSWORD, EZTEST_SECRET_BACK_OFFICE_DB_PASSWORD in the pipeline (pipelines/azure-pipelines.yml maps them)');
    // Every "next" line has a space before its comment, also for a long application name.
    for (const l of r.next.filter((x) => x.includes("#"))) expect(l).toMatch(/\s#/);
    expect(r.next).toContain(`npm run validate:back-office${' '.repeat(29 - 'npm run validate:back-office'.length)} # every journey parses; every step, query and data file resolves`);
    // The config keeps everything it had, comments included, and gains the overlay.
    const cfg = await readFile(join(dir, 'eztest.config.yaml'), 'utf8');
    for (const line of cfgBefore.split('\n').filter((l) => l.trim().startsWith('#'))) expect(cfg).toContain(line.trim());
    const bo = (await loadConfig({ cwd: dir, project: 'back-office', env: 'sit', environment: {} })).config;
    expect(bo.journeysDir).toBe('apps/back-office');
    expect(bo.identity.roles.clerk.password).toBe('secret://env/BACK_OFFICE_CLERK_PASSWORD');
    expect(bo.db.connections.back_office_db).toMatchObject({ driver: 'postgres' });
    expect(bo.identity.sessionDir).toBe('.eztest/sessions/back-office');
    expect((await loadConfig({ cwd: dir, project: 'web', env: 'dev', environment: {} })).config.journeysDir).toBe('apps/web');
    // Ids and query names carry the application, so two applications never collide.
    expect(await readFile(join(dir, 'apps/back-office/journeys/orders/place-order.ez'), 'utf8')).toMatch(/^Id: back-office-orders-place-order$/m);
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    // The project scripts cover every application; each application keeps its own.
    expect(pkg.scripts.test).toBe('eztest run --project web -e dev && eztest run --project back-office -e dev');
    expect(pkg.scripts['test:smoke']).toBe('eztest run --project web -e dev -t @smoke && eztest run --project back-office -e dev -t @smoke');
    expect(pkg.scripts.validate).toBe('eztest validate --project web -e dev && eztest validate --project back-office -e dev');
    expect(pkg.scripts.lint).toBe('eztest lint');
    expect(pkg.scripts.studio).toBe('eztest studio --project web -e dev');
    expect(pkg.scripts['test:back-office']).toBe('eztest run --project back-office -e dev');
    // The pipeline runs it, with its secrets mapped where the others' are.
    const pipeline = await readFile(join(dir, 'pipelines', 'azure-pipelines.yml'), 'utf8');
    const yml = parse(pipeline) as { parameters: Array<{ name: string; default: string[] }> };
    expect(yml.parameters.find((x) => x.name === 'apps')?.default).toEqual(['web', 'back-office']);
    expect(pipeline.match(/EZTEST_SECRET_BACK_OFFICE_CLERK_PASSWORD: \$\(EZTEST_SECRET_BACK_OFFICE_CLERK_PASSWORD\)/g)).toHaveLength(3);
    expect(pipeline.match(/EZTEST_SECRET_BACK_OFFICE_DB_PASSWORD: \$\(EZTEST_SECRET_BACK_OFFICE_DB_PASSWORD\)/g)).toHaveLength(2);
    expect(pipeline.match(/EZTEST_SECRET_WEB_DB_PASSWORD: /g)).toHaveLength(2);
    // A third application: the scripts written for two grow to three.
    await initProject(dir, { app: 'claims' });
    const pkg3 = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg3.scripts.validate).toBe('eztest validate --project web -e dev && eztest validate --project back-office -e dev && eztest validate --project claims -e dev');
    expect((parse(await readFile(join(dir, 'pipelines', 'azure-pipelines.yml'), 'utf8')) as { parameters: Array<{ name: string; default: string[] }> }).parameters[0].default).toEqual(['web', 'back-office', 'claims']);
    // Adding it again changes nothing.
    const again = await initProject(dir, { app: 'claims' });
    expect(again.created).toEqual([]);
    expect(again.updated).toEqual([]);
  });

  it('after npm init: the placeholder test script is replaced, "type": "module" is added, scripts changed by hand are kept', async () => {
    const dir = await tempDir('init-ent-npm-init');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'qa', version: '1.0.0', main: 'index.js', scripts: { test: 'echo "Error: no test specified" && exit 1' }, license: 'ISC' }, null, 2));
    const r = await initProject(dir, { template: 'enterprise' });
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { type: string; scripts: Record<string, string> };
    expect(pkg.scripts.test).toBe('eztest run --project web -e dev');
    expect(pkg.type).toBe('module');
    expect(Object.keys(pkg).slice(0, 3)).toEqual(['name', 'version', 'type']);
    expect(r.updated.find((u) => u.startsWith('package.json'))).toMatch(/now over web: test; "type": "module"\)$/);
    // A project script someone changed is kept when an application is added, and the output says so.
    pkg.scripts.validate = 'eztest validate --project web -e dev --strict';
    await writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    const added = await initProject(dir, { app: 'practice-sites' });
    const after = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { type: string; scripts: Record<string, string> };
    expect(after.scripts.validate).toBe('eztest validate --project web -e dev --strict');
    expect(after.scripts.test).toBe('eztest run --project web -e dev && eztest run --project practice-sites -e dev');
    expect(added.next).toContain('package.json: validate was changed by hand and is kept; add practice-sites to it if wanted');
    expect(added.next).toContain('npm run validate:practice-sites # every journey parses; every step, query and data file resolves');
    // An explicit "type" is left alone.
    const cjs = await tempDir('init-ent-cjs');
    await writeFile(join(cjs, 'package.json'), JSON.stringify({ name: 'qa', type: 'commonjs' }, null, 2));
    await initProject(cjs, { template: 'enterprise' });
    expect((JSON.parse(await readFile(join(cjs, 'package.json'), 'utf8')) as { type: string }).type).toBe('commonjs');
  });

  it('rejects application names that are not folder and id safe, and unknown templates', async () => {
    const dir = await tempDir('init-ent-bad');
    await expect(initProject(dir, { app: 'Web App' })).rejects.toThrow(/lower-case letters, digits and hyphens/);
    await expect(initProject(dir, { template: 'huge' as never })).rejects.toThrow(/Unknown template "huge"/);
  });

  it('basic stays the default; the CLI takes --template and --app and reports created, updated and kept files', async () => {
    const basic = await tempDir('init-basic-default');
    expect((await initProject(basic)).created).toEqual(expect.arrayContaining(['eztest.config.yaml', 'journeys/example.ez', 'readiness-policy.yaml']));
    const dir = await tempDir('init-ent-cli');
    const out: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => out.push(s), cwd: dir, env: {} };
    await buildProgram(io).parseAsync(['node', 'eztest', 'init', '--template', 'enterprise', '--app', 'portal']);
    expect(out).toContain('created  apps/portal/journeys/orders/place-order.ez');
    out.length = 0;
    await buildProgram(io).parseAsync(['node', 'eztest', 'init', '--app', 'portal']);
    expect(out).toContain('exists   apps/portal/journeys/orders/place-order.ez (left unchanged)');
    out.length = 0;
    await buildProgram(io).parseAsync(['node', 'eztest', 'init', '--app', 'claims']);
    expect(out).toContain('updated  eztest.config.yaml (projects.claims)');
    expect(out).toContain('created  apps/claims/features/orders/place-order.feature');
  });
});
