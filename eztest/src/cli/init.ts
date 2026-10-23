/** `eztest init`: scaffold a project. Never overwrites existing files. */
import { existsSync } from 'node:fs';
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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

const CI: Record<'github' | 'azure', [string, string]> = {
  github: [
    '.github/workflows/eztest.yml',
    `# EZTest: duration-balanced shards in parallel, merged into one verified run, published.
# Optional: set the repository variable EZTEST_SERVER_URL and the secret EZTEST_SERVER_TOKEN
# (a tester token) to publish runs and share heal decisions and history with the team.
name: EZTest
on: [push, pull_request]
env:
  EZTEST_MASTER_KEY: \${{ secrets.EZTEST_MASTER_KEY }}
  EZTEST_SERVER_TOKEN: \${{ secrets.EZTEST_SERVER_TOKEN }}
jobs:
  plan:
    runs-on: ubuntu-latest
    outputs:
      matrix: \${{ steps.m.outputs.matrix }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - uses: actions/cache/restore@v4
        with:
          path: .eztest
          key: eztest-history-\${{ github.run_id }}
          restore-keys: eztest-history-
      # Shard count and balance come from historical durations (results server or .eztest/history.json).
      - id: m
        run: echo "matrix=$(npx eztest ci matrix --shards auto --target 10m)" >> "$GITHUB_OUTPUT"
  test:
    needs: plan
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix: \${{ fromJSON(needs.plan.outputs.matrix) }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npx eztest install-browsers chromium
      - uses: actions/cache/restore@v4
        with:
          path: .eztest
          key: eztest-history-\${{ github.run_id }}
          restore-keys: eztest-history-
      - run: npx eztest run --shard \${{ matrix.shard }} --reporter json,junit
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: 'shard-\${{ matrix.index }}'
          path: eztest-results
  merge:
    needs: test
    if: always()
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - uses: actions/cache/restore@v4
        with:
          path: .eztest
          key: eztest-history-\${{ github.run_id }}
          restore-keys: eztest-history-
      - uses: actions/download-artifact@v4
        with: { pattern: 'shard-*', path: shards }
      # One run: evidence re-chained and linked to every shard chain, history, triage, readiness, reports.
      - run: npx eztest merge shards -o eztest-results/merged --reporter html,json,junit
      - run: npx eztest evidence verify eztest-results/merged
      - if: vars.EZTEST_SERVER_URL != ''
        run: npx eztest publish eztest-results/merged --server "\${{ vars.EZTEST_SERVER_URL }}"
      - uses: actions/cache/save@v4
        if: always()
        with:
          path: .eztest
          key: eztest-history-\${{ github.run_id }}
      - if: always()
        uses: actions/upload-artifact@v4
        with: { name: eztest-results, path: eztest-results/merged }
`,
  ],
  azure: [
    'azure-pipelines.yml',
    `# EZTest: duration-balanced shards in parallel, merged into one verified run, published.
# Optional: set the pipeline variables EZTEST_SERVER_URL and EZTEST_SERVER_TOKEN (secret) to
# publish runs and share heal decisions and history with the team.
# Azure DevOps Test Plans, the readiness gate, PR status and the EZTest task (multi-stage):
# node_modules/eztest/integrations/azure-devops/templates and docs/azure-devops.md
trigger: [main]
pool: { vmImage: ubuntu-latest }
variables:
  npm_config_cache: $(Pipeline.Workspace)/.npm
jobs:
  - job: plan
    steps:
      - task: NodeTool@0
        inputs: { versionSpec: '22.x' }
      - script: npm ci
      - script: echo "##vso[task.setvariable variable=matrix;isOutput=true]$(npx eztest ci matrix --provider azure --shards auto --target 10m)"
        name: m
        env: { EZTEST_SERVER_TOKEN: $(EZTEST_SERVER_TOKEN) }
  - job: test
    dependsOn: plan
    strategy:
      matrix: $[ dependencies.plan.outputs['m.matrix'] ]
    steps:
      - task: NodeTool@0
        inputs: { versionSpec: '22.x' }
      - script: npm ci
      - script: npx eztest install-browsers chromium
      - script: npx eztest run --shard $(SHARD) --reporter json,junit
        env:
          EZTEST_MASTER_KEY: $(EZTEST_MASTER_KEY)
          EZTEST_SERVER_TOKEN: $(EZTEST_SERVER_TOKEN)
      - task: PublishPipelineArtifact@1
        condition: always()
        inputs: { targetPath: eztest-results, artifact: 'shard-$(SHARD_INDEX)' }
  - job: merge
    dependsOn: test
    condition: succeededOrFailed()
    steps:
      - task: NodeTool@0
        inputs: { versionSpec: '22.x' }
      - script: npm ci
      - task: DownloadPipelineArtifact@2
        inputs: { patterns: 'shard-*/**', path: shards }
      - script: npx eztest merge shards -o eztest-results/merged --reporter html,json,junit
      - script: npx eztest evidence verify eztest-results/merged
      - script: npx eztest publish eztest-results/merged --server "$(EZTEST_SERVER_URL)"
        condition: and(succeededOrFailed(), ne(variables['EZTEST_SERVER_URL'], ''))
        env: { EZTEST_SERVER_TOKEN: $(EZTEST_SERVER_TOKEN) }
      # Azure Test Plans (set EZTEST_ADO_PLAN) and the readiness gate: NO_GO fails, GO_WITH_RISKS warns.
      - script: npx eztest ado publish eztest-results/merged --plan $(EZTEST_ADO_PLAN)
        condition: and(succeededOrFailed(), ne(variables['EZTEST_ADO_PLAN'], ''))
        env: { SYSTEM_ACCESSTOKEN: $(System.AccessToken) }
      - script: npx eztest ado gate eztest-results/merged --on-no-go fail --on-risks warn
        condition: succeededOrFailed()
      - task: PublishTestResults@2
        condition: always()
        inputs: { testResultsFormat: JUnit, testResultsFiles: 'eztest-results/merged/junit.xml' }
      - task: PublishPipelineArtifact@1
        condition: always()
        inputs: { targetPath: eztest-results/merged, artifact: eztest-results }
`,
  ],
};

const GITIGNORE = ['eztest-results/', '.eztest/', '.env', '.env.*'];

export async function initProject(dir: string, opts: { ci?: 'github' | 'azure' } = {}): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];
  const files: Record<string, string> = { ...FILES };
  if (opts.ci) files[CI[opts.ci][0]] = CI[opts.ci][1];
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
