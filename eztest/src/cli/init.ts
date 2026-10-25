/** `eztest init`: scaffold a project. Never overwrites existing files. */
import { existsSync } from 'node:fs';
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CI_SYSTEMS, CI_TEMPLATES, type CiSystemName } from './ci-templates.js';

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
];

export { CI_SYSTEMS, type CiSystemName };

/** The npm package projects install (its command is `eztest`). */
export const PACKAGE_NAME = '@eztech.com/eztest';

export async function initProject(dir: string, opts: { ci?: CiSystemName } = {}): Promise<{ created: string[]; skipped: string[]; next: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];
  const files: Record<string, string> = { ...FILES };
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
  if (!(await dependsOnEztest(dir))) next.push(`npm install --save-dev ${PACKAGE_NAME}   # the project's own EZTest, so npx eztest and CI use it`);
  next.push('npx eztest install-browsers   # once, if Chrome is not installed');
  next.push('npx eztest run                # set baseUrl in eztest.config.yaml first');
  return { created, skipped, next };
}

async function dependsOnEztest(dir: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    return [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies].some((d) => !!d?.[PACKAGE_NAME]);
  } catch {
    return false;
  }
}
