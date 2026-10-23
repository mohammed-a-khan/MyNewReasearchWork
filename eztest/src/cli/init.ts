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

# Run accessibility/security/visual checks after every step ("a11y:warn" records without failing)
lenses: []

identity:
  secretStores:
    - type: env
      prefix: EZTEST_SECRET_
  roles: {}
  # sales-rep:
  #   loginUrl: /login
  #   username: alice
  #   password: secret://env/ALICE_PASSWORD
  #   totp: secret://env/ALICE_TOTP

# db:
#   connections:
#     shop: { driver: sqlite, file: ./shop.db }

readiness:
  policyPath: readiness-policy.yaml

# Team results server (eztest server): publish runs, share heal decisions, quarantine and history.
# server:
#   url: https://eztest.example.com
#   token: secret://env/EZTEST_SERVER_TOKEN
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
  'journeys/example.ez': `Journey: Example - home page loads
Tags: @smoke
Risk: 2

Open "/"
Expect the page to contain "Welcome"
`,
  'readiness-policy.yaml': `# Release readiness gates: GO / GO_WITH_RISKS / NO_GO with cited reasons.
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

const GITIGNORE = ['eztest-results/', '.eztest/', '.env', '.env.*'];

export { CI_SYSTEMS, type CiSystemName };

export async function initProject(dir: string, opts: { ci?: CiSystemName } = {}): Promise<{ created: string[]; skipped: string[] }> {
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
  return { created, skipped };
}
