/**
 * `eztest init`: scaffold a project. Never overwrites existing files.
 *
 * Templates: `basic` (default: a config, one example journey and a readiness policy) and `enterprise`
 * (the layout of the EZTest Project Guide, see init-enterprise.ts). `--app <name>` adds an application to
 * an enterprise project: new files only, plus its `projects.<app>` overlay, its npm scripts and its
 * `.env.example` lines, which are added to the existing files (reported as updated).
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isMap, parseDocument, type YAMLMap } from 'yaml';
import { CI_SYSTEMS, CI_TEMPLATES, type CiSystemName } from './ci-templates.js';
import { appFiles, appNames, appScripts, envExampleLines, projectBlock, projectFiles, type AppNames } from './init-enterprise.js';

export const INIT_TEMPLATES = ['basic', 'enterprise'] as const;
export type InitTemplate = (typeof INIT_TEMPLATES)[number];

const FILES: Record<string, string> = {
  'eztest.config.yaml': `# EZTest configuration (configVersion 1; see docs/versioning.md). Values can use \${ENV_VAR} and ENC(...) encrypted secrets
# (encrypt with: npx eztest secret encrypt <value>, key from EZTEST_MASTER_KEY).
configVersion: 1
baseUrl: http://localhost:3000
browser: chromium
headless: true
concurrency: 2
retries: 0
journeysDir: journeys
outputDir: eztest-results
reporters: [console, html, json, junit]

healing:
  enabled: true
  maxTier: T2-semantic   # T0-cache, T1-fingerprint, T2-semantic

# Checks after every step: a11y, security, visual ("a11y:warn" records findings without failing the step).
# The readiness policy's a11yNoCritical gate reads these findings; without a11y results it has no data.
lenses: [a11y:warn]

identity:
  secretStores:
    - type: env
      prefix: EZTEST_SECRET_
  roles: {}
  # secret://env/NAME reads the environment variable EZTEST_SECRET_NAME (the prefix above).
  # sales-rep:
  #   loginUrl: /login
  #   username: alice
  #   password: secret://env/ALICE_PASSWORD   # EZTEST_SECRET_ALICE_PASSWORD
  #   totp: secret://env/ALICE_TOTP           # EZTEST_SECRET_ALICE_TOTP

# db:
#   connections:
#     shop: { driver: sqlite, file: ./shop.db }

readiness:
  policyPath: readiness-policy.yaml

# The HTML report (docs/reports.md). Default title and name: this folder's name.
report:
  # title: Shop web - regression
  # name: Contoso Shop               # shown above the title
  # logo: branding/logo.svg          # .svg/.png/.jpg/.gif/.webp under 512 KiB, embedded in the report
  # brandColor: "#0b5cad"            # header mark and accents
  baseline: previous                 # compare each run with the previous one

# Video per journey attempt for the report's player: off, on or retain-on-failure.
video: retain-on-failure

# Team results server (eztest server): publish runs, share heal decisions, quarantine and history.
# The token is read from the EZTEST_SERVER_TOKEN environment variable; or set server.token to a secret
# reference (secret://env/SERVER_TOKEN reads EZTEST_SECRET_SERVER_TOKEN).
# server:
#   url: https://eztest.example.com
#   project: my-team

# Shared test data across journeys, runs and pipeline stages (docs/shared-data.md).
store:
  backend: auto          # the results server when server.url is set, else .eztest/store
  # defaultTtl: 7d
  # pools:
  #   approvable-policies: { from: data/policies.csv, column: policyNo }

# What each CI trigger and deployment stage runs: eztest run --pipeline <name> (docs/pipelines.md).
pipelines:
  pr:         { trigger: pr, tags: "@smoke", impact: true, budget: 10m, browsers: [chromium] }
  nightly:    { trigger: schedule, schedule: "0 2 * * *", tags: "not @quarantined", shards: 4, browsers: [chromium] }
  deploy-sit: { trigger: deploy, environment: sit, tags: "@sit or @smoke", gate: readiness }
  deploy-uat: { trigger: deploy, environment: uat, tags: "@uat or @smoke", requires: [deploy-sit], gate: readiness }
`,
  'journeys/example.ez': `# Risk 4 and 5 journeys are critical: the readiness policy's noFailedCriticalJourneys gate needs them to pass.
Journey: Example - home page loads
Tags: @smoke
Risk: 4

Open "/"
Expect the page to contain "Welcome"
`,
  'readiness-policy.yaml': `# Release readiness gates: GO / GO_WITH_RISKS / NO_GO with cited reasons.
# Each gate needs its input in the run: noFailedCriticalJourneys needs a journey with Risk 4 or 5 (the example has one),
# a11yNoCritical needs accessibility results (the a11y lens in eztest.config.yaml records them).
version: 1
gates:
  noFailedCriticalJourneys: { minRisk: 4 }
  minPassRate: { min: 0.95 }
  maxHealedRatio: { max: 0.2 }
  a11yNoCritical: true
# exceptions:
#   - gate: maxHealedRatio
#     approver: Jane Doe
#     reason: UI redesign in progress, heals reviewed
#     expires: 2026-12-31
`,
};

/**
 * `.eztest/` holds caches and local state (history, fingerprints, code cache, leases, locks, keys, the local
 * store) and team decisions that belong in git: the quarantine list, heal decisions, triage overrides and
 * visual / aria baselines with their approvals. Everything under it is ignored except those.
 */
export const GITIGNORE = [
  'node_modules/',
  'eztest-results/',
  '.eztest/*',
  '!.eztest/quarantine.json',
  '!.eztest/heal-decisions.json',
  '!.eztest/triage-overrides.json',
  '!.eztest/baselines/',
  '!.eztest/aria/',
  '!.eztest/approvals/',
  '.env',
  '.env.*',
  '!.env.example',
];

export { CI_SYSTEMS, type CiSystemName };

/** The npm package projects install (its command is `eztest`). */
export const PACKAGE_NAME = '@eztech/eztest';

export interface InitOptions {
  ci?: CiSystemName;
  /** basic (default) or enterprise (the project guide's layout). `app` alone implies enterprise. */
  template?: InitTemplate;
  /** enterprise: the application to scaffold (default "web"), or to add to an existing project. */
  app?: string;
}

export interface InitResult {
  created: string[];
  /** Files that existed and were left unchanged. */
  skipped: string[];
  /** Existing files that got entries added (the app's project overlay, npm scripts, .env.example lines). */
  updated: string[];
  next: string[];
}

export async function initProject(dir: string, opts: InitOptions = {}): Promise<InitResult> {
  const created: string[] = [];
  const skipped: string[] = [];
  const updated: string[] = [];
  const template: InitTemplate = opts.template ?? (opts.app ? 'enterprise' : 'basic');
  if (!INIT_TEMPLATES.includes(template)) throw new Error(`Unknown template "${template}" (${INIT_TEMPLATES.join(', ')})`);
  let files: Record<string, string> = { ...FILES };
  let enterprise: { names: AppNames; configFile?: string; firstApp: boolean } | undefined;
  if (template === 'enterprise') {
    const names = appNames(opts.app ?? 'web');
    const configFile = ['eztest.config.yaml', 'eztest.config.yml', 'eztest.config.json'].find((f) => existsSync(join(dir, f)));
    const firstApp = !configFile || (await projectNames(join(dir, configFile))).length === 0;
    const project = projectFiles(names);
    if (configFile) delete project['eztest.config.yaml'];
    // .env.example: an existing one gets the app's lines below.
    if (existsSync(join(dir, '.env.example'))) delete project['.env.example'];
    files = { ...project, ...appFiles(names) };
    enterprise = { names, ...(configFile ? { configFile } : {}), firstApp };
  }
  if (opts.ci) {
    const t = CI_TEMPLATES[opts.ci];
    if (!t) throw new Error(`Unknown CI system "${opts.ci}" (${CI_SYSTEMS.join(', ')})`);
    for (const [path, content] of t) files[path] = content;
  }
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    if (existsSync(abs)) {
      skipped.push(rel);
      continue;
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
    created.push(rel);
  }
  const gi = join(dir, '.gitignore');
  const current = existsSync(gi) ? await readFile(gi, 'utf8') : '';
  const missing = GITIGNORE.filter((l) => !current.split(/\r?\n/).includes(l));
  if (missing.length) {
    await appendFile(gi, (current && !current.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
    created.push('.gitignore (entries)');
  }
  const next: string[] = [];
  if (enterprise) {
    const { names, configFile, firstApp } = enterprise;
    // The application's project overlay in an existing config.
    if (configFile) {
      const r = await addProject(join(dir, configFile), names);
      (r ? updated : skipped).push(r ? `${configFile} (projects.${names.app})` : `${configFile} (projects.${names.app} exists)`);
    }
    // .env.example: the application's secret names.
    const envExample = join(dir, '.env.example');
    if (!created.includes('.env.example')) {
      const text = await readFile(envExample, 'utf8');
      const lines = envExampleLines(names);
      const missing = lines.split('\n').filter((l) => /^[A-Z_]+=/.test(l) && !text.split(/\r?\n/).some((t) => t.startsWith(l)));
      if (missing.length) {
        await appendFile(envExample, (text.endsWith('\n') ? '' : '\n') + lines);
        updated.push(`.env.example (${missing.map((l) => l.replace(/=.*$/, '')).join(', ')})`);
      }
    }
    // npm scripts: added when missing, never changed.
    const pkg = await addScripts(dir, appScripts(names, firstApp));
    if (pkg.created) created.push('package.json');
    else if (pkg.added.length) updated.push(`package.json (scripts: ${pkg.added.join(', ')})`);
    else skipped.push('package.json (scripts)');
    if (!(await dependsOnEztest(dir))) next.push(`npm install --save-dev ${PACKAGE_NAME}   # the project's own EZTest, so npx eztest and CI use it`);
    const step = (cmd: string, why: string) => next.push(`${cmd.padEnd(30)}# ${why}`);
    step('npx eztest install-browsers', 'once, if Chrome is not installed');
    step('cp .env.example .env', 'and fill in the secrets (git ignores .env)');
    step(`npm run validate:${names.app}`, 'every journey parses; every step, query and data file resolves');
    step('npm run lint', 'the project guide\'s rules');
    step(`npm run test:${names.app}`, `point config/${names.app}/dev.yaml (baseUrl, database) at your app first`);
    if (!firstApp) next.push(`add ${names.app} to the apps parameter of pipelines/azure-pipelines.yml, with its secret variables`);
    return { created, skipped, updated, next };
  }
  if (!(await dependsOnEztest(dir))) next.push(`npm install --save-dev ${PACKAGE_NAME}   # the project's own EZTest, so npx eztest and CI use it`);
  next.push('npx eztest install-browsers   # once, if Chrome is not installed');
  next.push('npx eztest run                # set baseUrl in eztest.config.yaml first');
  return { created, skipped, updated, next };
}

/** Projects declared in a config file. */
async function projectNames(file: string): Promise<string[]> {
  const text = await readFile(file, 'utf8');
  if (file.endsWith('.json')) {
    const p = (JSON.parse(text) as { projects?: Record<string, unknown> }).projects;
    return p && typeof p === 'object' ? Object.keys(p) : [];
  }
  const p = parseDocument(text).get('projects');
  return isMap(p) ? p.items.map((i) => String((i.key as { value?: unknown })?.value ?? i.key)) : [];
}

/** Add `projects.<app>` to an existing config (YAML comments and layout elsewhere are kept). False when it is there. */
async function addProject(file: string, n: AppNames): Promise<boolean> {
  if ((await projectNames(file)).includes(n.app)) return false;
  const text = await readFile(file, 'utf8');
  const block = parseDocument(`projects:\n${projectBlock(n)}`);
  if (file.endsWith('.json')) {
    const cfg = JSON.parse(text) as Record<string, unknown>;
    const add = (block.toJS() as { projects: Record<string, unknown> }).projects;
    cfg.projects = { ...((cfg.projects as Record<string, unknown> | undefined) ?? {}), ...add };
    await writeFile(file, JSON.stringify(cfg, null, 2) + '\n');
    return true;
  }
  const doc = parseDocument(text);
  const fresh = block.get('projects') as YAMLMap;
  const projects = doc.get('projects');
  if (isMap(projects)) projects.items.push(...fresh.items);
  else doc.set('projects', fresh);
  await writeFile(file, doc.toString({ lineWidth: 0 }));
  return true;
}

/** Add missing npm scripts to package.json (creating it when there is none). */
async function addScripts(dir: string, scripts: Record<string, string>): Promise<{ created: boolean; added: string[] }> {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) {
    const name = basename(dir).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+/, '') || 'tests';
    await writeFile(file, JSON.stringify({ name, private: true, type: 'module', scripts }, null, 2) + '\n');
    return { created: true, added: Object.keys(scripts) };
  }
  const text = await readFile(file, 'utf8');
  const pkg = JSON.parse(text) as { scripts?: Record<string, string> };
  const have = pkg.scripts ?? {};
  const added = Object.keys(scripts).filter((k) => have[k] === undefined);
  if (!added.length) return { created: false, added };
  pkg.scripts = { ...have, ...Object.fromEntries(added.map((k) => [k, scripts[k]])) };
  const indent = /^(\s+)"/m.exec(text)?.[1] ?? '  ';
  await writeFile(file, JSON.stringify(pkg, null, indent) + '\n');
  return { created: false, added };
}

async function dependsOnEztest(dir: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    return [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies].some((d) => !!d?.[PACKAGE_NAME]);
  } catch {
    return false;
  }
}
