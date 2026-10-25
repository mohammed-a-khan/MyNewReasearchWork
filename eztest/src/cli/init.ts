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
import { addAppToPipeline, appFiles, appNames, appScripts, APP_NAME, envExampleLines, NPM_PLACEHOLDER_TEST, projectBlock, projectFiles, projectScripts, type AppNames } from './init-enterprise.js';

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

# Release readiness gate (opt-in, docs/configuration.md#readiness-policy): a pipeline step that fails on the
# policy's NO_GO is   npx eztest analyze <runDir> --policy readiness-policy.yaml   (or eztest run --policy ...).
# readiness:
#   policyPath: readiness-policy.yaml   # evaluate the policy after every run

# The HTML report (docs/reports.md). Default title and name: this folder's name.
report:
  # title: Shop web - regression
  # name: Contoso Shop               # the project name in the header
  baseline: previous                 # compare each run with the previous one
  # readiness: true                  # add a secondary "Policy" tab with the readiness policy's decision
  # brand:                           # white-label branding of every output (docs/reports.md#branding)
  #   company: Contoso QA
  #   subtitle: Nightly regression
  #   logo: branding/logo.svg        # .svg/.png/.jpg/.webp under 512 KiB, embedded in the report
  #   colors: { primary: "#0b5cad" }
  #   footer: Confidential - internal use only

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
  'readiness-policy.yaml': `# Release readiness gates (opt-in): GO / GO_WITH_RISKS / NO_GO with cited reasons, for a pipeline step:
#   npx eztest analyze <runDir> --policy readiness-policy.yaml   (exit code 1 on NO_GO)
# The report shows the decision only with report.readiness: true (a secondary Policy tab).
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
export const PACKAGE_NAME = '@eztech.com/eztest';

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
    // npm scripts: the application's own, and the project's over every application. Missing ones are added; a
    // project script is rewritten only while it is still the one init wrote for the applications before (or npm's
    // placeholder test script), never when someone changed it.
    const apps = configFile ? await enterpriseApps(dir, join(dir, configFile), names) : [names];
    const before = apps.filter((a) => a.app !== names.app);
    const previous = before.length ? projectScripts(before) : {};
    const pkg = await addScripts(dir, { ...projectScripts(apps), ...appScripts(names) }, (key, current) => current === previous[key] || (key === 'test' && NPM_PLACEHOLDER_TEST.test(current.trim())));
    if (pkg.created) created.push('package.json');
    else {
      const what = [
        ...(pkg.added.length ? [`scripts: ${pkg.added.join(', ')}`] : []),
        ...(pkg.replaced.length ? [`now over ${apps.map((a) => a.app).join(', ')}: ${pkg.replaced.join(', ')}`] : []),
        ...(pkg.typeModule ? ['"type": "module"'] : []),
      ];
      if (what.length) updated.push(`package.json (${what.join('; ')})`);
      else skipped.push('package.json (scripts)');
      if (pkg.kept.length && before.length) next.push(`package.json: ${pkg.kept.join(', ')} ${pkg.kept.length === 1 ? 'was' : 'were'} changed by hand and ${pkg.kept.length === 1 ? 'is' : 'are'} kept; add ${names.app} to ${pkg.kept.length === 1 ? 'it' : 'them'} if wanted`);
    }
    // The pipeline init wrote: the application joins the apps parameter, its secrets are mapped.
    let pipelineSecrets: string[] = [];
    const pipeline = join(dir, 'pipelines', 'azure-pipelines.yml');
    if (!firstApp && !created.includes('pipelines/azure-pipelines.yml') && existsSync(pipeline)) {
      const text = await readFile(pipeline, 'utf8');
      const next2 = addAppToPipeline(text, names, apps);
      if (next2) {
        await writeFile(pipeline, next2);
        pipelineSecrets = [...new Set([...next2.matchAll(new RegExp(String.raw`EZTEST_SECRET_${names.upper}_[A-Z0-9_]+(?=:)`, 'g'))].map((m) => m[0]))];
        updated.push(`pipelines/azure-pipelines.yml (apps: ${names.app}${pipelineSecrets.length ? `; secrets: ${pipelineSecrets.join(', ')}` : ''})`);
      }
    }
    if (!(await dependsOnEztest(dir))) next.push(`npm install --save-dev ${PACKAGE_NAME}   # the project's own EZTest, so npx eztest and CI use it`);
    // At least one space before the comment, also for a long application name.
    const step = (cmd: string, why: string) => next.push(`${cmd.padEnd(29)} # ${why}`);
    step('npx eztest install-browsers', 'once, if Chrome is not installed');
    step('cp .env.example .env', 'and fill in the secrets (git ignores .env)');
    step(`npm run validate:${names.app}`, 'every journey parses; every step, query and data file resolves');
    step('npm run lint', 'the project guide\'s rules');
    step(`npm run test:${names.app}`, `point config/${names.app}/dev.yaml (baseUrl, database) at your app first`);
    if (!firstApp) {
      if (pipelineSecrets.length) next.push(`define the secret variables ${pipelineSecrets.join(', ')} in the pipeline (pipelines/azure-pipelines.yml maps them)`);
      else next.push(`add ${names.app} to the apps parameter of pipelines/azure-pipelines.yml, with its secret variables`);
    }
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

/**
 * Add missing npm scripts to package.json (creating it when there is none). An existing script is replaced only
 * when `replaceable` says so (`replaced`); other differing ones are `kept`. A package.json without "type" gets
 * "type": "module" (code journeys and step files are ES modules; without it Node warns for every file it loads).
 */
async function addScripts(dir: string, scripts: Record<string, string>, replaceable: (key: string, current: string) => boolean = () => false): Promise<{ created: boolean; added: string[]; replaced: string[]; kept: string[]; typeModule: boolean }> {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) {
    const name = basename(dir).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+/, '') || 'tests';
    await writeFile(file, JSON.stringify({ name, private: true, type: 'module', scripts }, null, 2) + '\n');
    return { created: true, added: Object.keys(scripts), replaced: [], kept: [], typeModule: true };
  }
  const text = await readFile(file, 'utf8');
  const pkg = JSON.parse(text) as { type?: string; scripts?: Record<string, string> };
  const have = pkg.scripts ?? {};
  const added = Object.keys(scripts).filter((k) => have[k] === undefined);
  const differs = Object.keys(scripts).filter((k) => have[k] !== undefined && have[k] !== scripts[k]);
  const replaced = differs.filter((k) => replaceable(k, have[k]));
  const kept = differs.filter((k) => !replaced.includes(k) && isProjectScript(k));
  const typeModule = pkg.type === undefined;
  if (!added.length && !replaced.length && !typeModule) return { created: false, added, replaced, kept, typeModule };
  const out: Record<string, unknown> = {};
  // "type" goes next to the name, as npm writes it.
  for (const [k, v] of Object.entries(pkg as Record<string, unknown>)) {
    out[k] = v;
    if (typeModule && (k === 'version' || (k === 'name' && !('version' in pkg)))) out.type = 'module';
  }
  if (typeModule && out.type === undefined) out.type = 'module';
  out.scripts = { ...have, ...Object.fromEntries([...added, ...replaced].map((k) => [k, scripts[k]])) };
  const indent = /^(\s+)"/m.exec(text)?.[1] ?? '  ';
  await writeFile(file, JSON.stringify(out, null, indent) + '\n');
  return { created: false, added, replaced, kept, typeModule };
}

/** Scripts over every application, which `init --app` keeps current (see projectScripts). */
function isProjectScript(key: string): boolean {
  return ['test', 'test:dev', 'test:sit', 'test:uat', 'test:smoke', 'test:regression', 'test:orders', 'test:headed', 'test:headless', 'test:parallel', 'validate', 'doctor'].includes(key);
}

/** The applications of an enterprise project: its projects that have an apps/<name>/ folder, plus the one being added. */
async function enterpriseApps(dir: string, configFile: string, adding: AppNames): Promise<AppNames[]> {
  const names = (await projectNames(configFile)).filter((p) => APP_NAME.test(p) && (p === adding.app || existsSync(join(dir, 'apps', p))));
  if (!names.includes(adding.app)) names.push(adding.app);
  return names.map(appNames);
}

async function dependsOnEztest(dir: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    return [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies].some((d) => !!d?.[PACKAGE_NAME]);
  } catch {
    return false;
  }
}
