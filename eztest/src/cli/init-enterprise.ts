/**
 * `eztest init --template enterprise [--app <name>]`: the project layout of the
 * EZTest Project Guide (docs/project-guide.md), with one minimal, working sample
 * of each style per application (an .ez journey, a feature with its step
 * definitions, a code journey), the element repository and a screen model they
 * share, an API helper, test data per environment, a named query, the config
 * layers, .env.example, the Azure DevOps pipeline, the readiness policy, a
 * README and npm scripts. `--app` on an existing project adds one application:
 * its folder, its config layers, its `projects.<app>` overlay and its scripts.
 *
 * Every application is a project overlay (`projects.<app>`, docs/configuration.md#projects):
 * its journeys folder, element repository, step definitions, query catalogue,
 * roles and session folder. Environments layer config/<env>.yaml (shared) and
 * config/<app>/<env>.yaml (the app's hosts, database and accounts) over it.
 */

/** Application names: folder names, project names and the prefix of journey ids and query names. */
export const APP_NAME = /^[a-z][a-z0-9-]{0,39}$/;

export interface AppNames {
  /** `web`, `back-office`: folder, project and id prefix. */
  app: string;
  /** `WEB`, `BACK_OFFICE`: environment variables and query names. */
  upper: string;
  /** `web_db`: the database connection alias. */
  db: string;
}

export function appNames(app: string): AppNames {
  if (!APP_NAME.test(app)) throw new Error(`--app "${app}": use lower-case letters, digits and hyphens, starting with a letter (e.g. web, back-office)`);
  const upper = app.replace(/-/g, '_').toUpperCase();
  return { app, upper, db: `${app.replace(/-/g, '_')}_db` };
}

const fill = (text: string, n: AppNames) => text.replace(/__APP__/g, n.app).replace(/__APPU__/g, n.upper).replace(/__DB__/g, n.db);

// ------------------------------------------------------------------ project files (once)

const CONFIG = `# EZTest project: the layout and rules of the EZTest Project Guide
# (node_modules/@eztech.com/eztest/docs/project-guide.md). configVersion 1 (docs/versioning.md).
#
# Every application under test is a project below (projects.<app>): select it with --project <app>,
# and the environment with -e <env>. The npm scripts in package.json do both.
# Layers, lowest first: this file < projects.<app> < config/<env>.yaml < config/<app>/<env>.yaml
#   < .env, .env.<env>, .env.<app>, .env.<app>.<env> < EZTEST_* variables < command-line flags.
configVersion: 1
journeysDir: apps                # all applications (lint, listings); each project narrows it to apps/<app>
outputDir: eztest-results
browser: chromium
headless: true
concurrency: 2
retries: 0
reporters: [console, html, json, junit]
screenshots: on-failure
trace: { browser: on-failure }
video: retain-on-failure

vars:
  DATA_ENV: dev                  # the data/<env>/ folder journeys read; config/<env>.yaml sets it

healing:
  enabled: true
  maxTier: T2-semantic
  requireVerification: true      # a heal counts only when the step's expectations still hold

# Accessibility findings after every step (recorded, not failing); the readiness gate a11yNoCritical reads them.
lenses: [a11y:warn]

identity:
  secretStores:
    - { type: env, prefix: EZTEST_SECRET_ }   # secret://env/NAME reads EZTEST_SECRET_NAME (.env locally, the pipeline in CI)

bdd:
  # Every application's step definitions and the shared ones; each project narrows this to its own.
  steps: ["apps/*/steps/**/*.steps.ts", "shared/steps/**/*.steps.ts"]
  fallback: true                 # steps without a definition may run as EZTest phrasings

# eztest lint (docs/project-guide.md#lint-rules): warnings fail the build too. Change a rule's severity
# or turn it off here, e.g. rules: { outside-layout: off, missing-id: error }.
lint:
  maxWarnings: 0
  rules: {}

readiness:
  policyPath: readiness-policy.yaml

report:
  baseline: previous             # compare each run with the previous one

# What each pipeline stage runs: eztest run --project <app> --pipeline <name> (docs/pipelines.md).
pipelines:
  pr:         { trigger: pr, environment: dev, record: false, tags: "@smoke", budget: 10m, browsers: [chromium] }
  nightly:    { trigger: schedule, schedule: "0 2 * * *", environment: sit, record: false, tags: "@regression and not @quarantined", shards: 2, browsers: [chromium] }
  deploy-sit: { trigger: deploy, environment: sit, tags: "@smoke or @regression", gate: readiness }
  deploy-uat: { trigger: deploy, environment: uat, tags: "@smoke", gate: readiness }

# Azure Test Plans (docs/azure-devops.md). In a pipeline the organisation and project come from the build;
# config/<env>.yaml sets the plan and suite of each environment.
# ado:
#   testPlanId: 0
#   testSuiteId: 0

projects:
`;

/** The `projects.<app>` overlay (indented under `projects:`). */
export function projectBlock(n: AppNames): string {
  return fill(`  __APP__:
    baseUrl: \${__APPU___BASE_URL:-http://localhost:3000}
    journeysDir: apps/__APP__
    elements: { dir: apps/__APP__/elements }
    bdd: { steps: ["apps/__APP__/steps/**/*.steps.ts", "shared/steps/**/*.steps.ts"] }
    db:
      queries: { dir: apps/__APP__/queries }   # connections: config/__APP__/<env>.yaml
    identity:
      sessionDir: .eztest/sessions/__APP__      # roles sign in once per run; each app keeps its own sessions
      roles:
        clerk:
          loginUrl: /login
          username: clerk                       # per environment: config/__APP__/<env>.yaml
          password: secret://env/__APPU___CLERK_PASSWORD
          successUrl: /orders
          fields: { username: Username, password: Password, submit: Sign in }
    healthChecks:                               # before any journey: a down app is an environment problem, not 50 failures
      - { name: __APP__, url: /api/health, contains: UP }
`, n);
}

const ENV_LAYER = (env: string, extra: string) => `# ${env.toUpperCase()}, shared by every application: the test data folder, parallelism and retries.
# Each application's hosts, database and accounts: config/<app>/${env}.yaml.
environment: ${env}
vars:
  DATA_ENV: ${env}
${extra}`;

const README = `# Test automation

This project follows the EZTest Project Guide (\`node_modules/@eztech.com/eztest/docs/project-guide.md\`).

## Layout

\`\`\`
eztest.config.yaml            base config: shared settings, pipelines, lint, one projects.<app> per application
config/<env>.yaml             dev / sit / uat, shared by every application (data folder, workers, retries)
config/<app>/<env>.yaml       one application in one environment: host, database, accounts
.env.example                  the names of the secrets (copy to .env, which git ignores, and fill in)
readiness-policy.yaml         the release gate: GO / GO_WITH_RISKS / NO_GO
pipelines/azure-pipelines.yml validate + lint, PR smoke, nightly regression in shards, SIT after deployment
apps/<app>/
  journeys/<module>/*.ez        plain-English journeys
  features/<module>/*.feature   Gherkin, when the business owns the wording
  steps/*.steps.ts              step definitions for the features
  code/<module>/*.journey.ts    TypeScript journeys, for logic that is easier in code
  elements/<screen>.yaml        the element repository: one name per element, for all three styles
  screens/*.ts                  screen models: the same element ids, typed, for code
  helpers/*.ts                  API clients and other helpers
  data/<env>/*.csv|json|xlsx    test data per environment
  queries/<connection>/*.sql    named SQL (the query catalogue)
shared/steps, shared/helpers  steps and helpers every application uses
\`\`\`

## Running

\`\`\`bash
npm install                      # once; installs @eztech.com/eztest
npx eztest install-browsers      # once, if Chrome or Edge is not installed
cp .env.example .env             # then fill in the secrets for your environment

npm test                         # the first application on dev
npm run test:sit                 # ... on SIT (config/sit.yaml + config/<app>/sit.yaml)
npm run test:smoke               # @smoke only
npm run test:orders              # one module (its tag)
npm run test:headed              # watch the browser
npm run test:parallel            # 4 workers
npm run test:<app> -- -e uat     # another application; anything after -- goes to eztest run
npm run validate                 # every journey parses; every step, query and data file resolves
npx eztest elements unused --project <app> -e dev   # every @Screen.element reference is in the repository
npm run lint                     # the project guide's rules (also in the pipeline)
npm run studio                   # EZTest Studio on the same files
npm run report                   # trends across runs; each run's report is eztest-results/<run>/report.html
\`\`\`

The samples (\`orders\` module) expect an application with a sign-in page (Username, Password, "Sign in"),
an order form at \`/orders/new\` (Customer, Your reference, Quantity, "Place order"), an order page showing
\`data-testid="order-number"\` and \`data-testid="order-total"\`, \`POST /api/orders\`, \`GET /api/health\` and an
\`orders\` table. Replace them with your own journeys, keeping the layout and the rules.

## Adding an application

\`\`\`bash
npx eztest init --app billing    # apps/billing/, config/billing/<env>.yaml, projects.billing, npm scripts
\`\`\`

Then add it to the \`apps\` parameter of \`pipelines/azure-pipelines.yml\`.
`;

const PIPELINE = `# EZTest on Azure Pipelines (written by eztest init --template enterprise; docs/project-guide.md#ci).
#
#   every run     -> Checks: eztest validate and element references per application, eztest lint (JUnit in the Tests tab)
#   pull request  -> Smoke: @smoke on dev per application (pipelines.pr), the readiness gate, PR status
#   schedule      -> Regression: @regression on SIT in 2 duration-balanced shards per application, merged
#                    into one verified run, the readiness gate, results published to Azure Test Plans
#   main          -> TestSIT after the SIT deployment: deployment jobs in the "sit" environment
#
# Secrets: pipeline secret variables (or a variable group linked to Key Vault) named like .env.example,
# mapped into the steps that run journeys. EZTEST_PUBLISH_TEST_PLANS=true publishes to Azure Test Plans
# with the build's own token (grant the build service "Create test runs").
parameters:
  - name: apps
    type: object
    default: [__APP__]

trigger: [main]
pr: [main]
schedules:
  - cron: '0 2 * * *'
    displayName: Nightly regression (02:00 UTC)
    branches: { include: [main] }
    always: true

pool: { vmImage: ubuntu-latest }
variables:
  npm_config_cache: $(Pipeline.Workspace)/.npm
  EZTEST_APP_VERSION: $(Build.BuildNumber)

stages:
  - stage: Checks
    jobs:
      - job: validate_and_lint
        steps:
          - task: NodeTool@0
            inputs: { versionSpec: '22.x' }
          - script: npm ci
          - \${{ each app in parameters.apps }}:
              - script: npx eztest validate --project \${{ app }} -e dev
                displayName: Validate \${{ app }}
              - script: npx eztest elements unused --project \${{ app }} -e dev
                displayName: Element references \${{ app }}
          - script: npx eztest lint --format junit -o eztest-lint.xml
            displayName: Lint (EZTest Project Guide)
          - task: PublishTestResults@2
            condition: always()
            inputs: { testResultsFormat: JUnit, testResultsFiles: eztest-lint.xml, testRunTitle: 'EZTest lint' }

  - stage: Smoke
    dependsOn: Checks
    condition: and(succeeded(), eq(variables['Build.Reason'], 'PullRequest'))
    jobs:
      - \${{ each app in parameters.apps }}:
          - job: smoke_\${{ replace(app, '-', '_') }}
            displayName: Smoke \${{ app }}
            steps:
              - checkout: self
                fetchDepth: 0
              - task: NodeTool@0
                inputs: { versionSpec: '22.x' }
              - script: npm ci
              - script: npx eztest install-browsers chromium
              - script: npx eztest run --project \${{ app }} --pipeline pr --headless --reporter html,json,junit
                env:
                  EZTEST_MASTER_KEY: $(EZTEST_MASTER_KEY)
                  EZTEST_SECRET___APPU___CLERK_PASSWORD: $(EZTEST_SECRET___APPU___CLERK_PASSWORD)
              - script: echo "##vso[task.setvariable variable=EZTEST_RUN_DIR]$(ls -td eztest-results/run-* | head -1)"
                condition: always()
              - task: PublishTestResults@2
                condition: always()
                inputs: { testResultsFormat: JUnit, testResultsFiles: '$(EZTEST_RUN_DIR)/junit.xml', testRunTitle: 'EZTest smoke \${{ app }}' }
              - task: PublishPipelineArtifact@1
                condition: always()
                inputs: { targetPath: '$(EZTEST_RUN_DIR)', artifact: 'smoke-\${{ app }}' }
              - script: npx eztest pr report "$(EZTEST_RUN_DIR)"
                condition: always()
                env: { SYSTEM_ACCESSTOKEN: $(System.AccessToken) }

  - stage: Regression
    dependsOn: Checks
    condition: and(succeeded(), eq(variables['Build.Reason'], 'Schedule'))
    jobs:
      - \${{ each app in parameters.apps }}:
          # pipelines.nightly has shards: 2; each parallel job runs its own shard (SYSTEM_JOBPOSITIONINPHASE).
          - job: regression_\${{ replace(app, '-', '_') }}
            displayName: Regression \${{ app }}
            strategy: { parallel: 2 }
            steps:
              - task: NodeTool@0
                inputs: { versionSpec: '22.x' }
              - script: npm ci
              - script: npx eztest install-browsers chromium
              - script: npx eztest run --project \${{ app }} --pipeline nightly --headless --reporter json,junit
                env:
                  EZTEST_MASTER_KEY: $(EZTEST_MASTER_KEY)
                  EZTEST_SECRET___APPU___CLERK_PASSWORD: $(EZTEST_SECRET___APPU___CLERK_PASSWORD)
                  EZTEST_SECRET___APPU___DB_PASSWORD: $(EZTEST_SECRET___APPU___DB_PASSWORD)
              - task: PublishPipelineArtifact@1
                condition: always()
                inputs: { targetPath: eztest-results, artifact: 'shard-\${{ app }}-$(System.JobPositionInPhase)' }
          - job: merge_\${{ replace(app, '-', '_') }}
            displayName: Merge and gate \${{ app }}
            dependsOn: regression_\${{ replace(app, '-', '_') }}
            condition: succeededOrFailed()
            steps:
              - task: NodeTool@0
                inputs: { versionSpec: '22.x' }
              - script: npm ci
              - task: DownloadPipelineArtifact@2
                inputs: { patterns: 'shard-\${{ app }}-*/**', path: shards }
              - script: npx eztest merge shards -o eztest-results/merged --reporter html,json,junit
              - script: npx eztest evidence verify eztest-results/merged
              - task: PublishTestResults@2
                condition: always()
                inputs: { testResultsFormat: JUnit, testResultsFiles: eztest-results/merged/junit.xml, testRunTitle: 'EZTest regression \${{ app }}' }
              - task: PublishPipelineArtifact@1
                condition: always()
                inputs: { targetPath: eztest-results/merged, artifact: 'regression-\${{ app }}' }
              - script: npx eztest ado publish eztest-results/merged --project \${{ app }} -e sit
                condition: and(succeededOrFailed(), eq(variables['EZTEST_PUBLISH_TEST_PLANS'], 'true'))
                env: { SYSTEM_ACCESSTOKEN: $(System.AccessToken) }
              - script: npx eztest gate eztest-results/merged --on-no-go fail --on-risks warn
                condition: succeededOrFailed()

  - stage: TestSIT
    dependsOn: Checks
    condition: and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/main'), notIn(variables['Build.Reason'], 'PullRequest', 'Schedule'))
    jobs:
      - \${{ each app in parameters.apps }}:
          - deployment: sit_\${{ replace(app, '-', '_') }}
            displayName: SIT \${{ app }}
            environment: sit
            strategy:
              runOnce:
                deploy:
                  steps:
                    - checkout: self
                    - task: NodeTool@0
                      inputs: { versionSpec: '22.x' }
                    - script: npm ci
                    - script: npx eztest install-browsers chromium
                    # deploy-sit: -e sit, the readiness gate (NO_GO fails the stage), a deployment record.
                    - script: npx eztest run --project \${{ app }} --pipeline deploy-sit --headless --reporter html,json,junit
                      env:
                        EZTEST_MASTER_KEY: $(EZTEST_MASTER_KEY)
                        EZTEST_SECRET___APPU___CLERK_PASSWORD: $(EZTEST_SECRET___APPU___CLERK_PASSWORD)
                        EZTEST_SECRET___APPU___DB_PASSWORD: $(EZTEST_SECRET___APPU___DB_PASSWORD)
                        SYSTEM_ACCESSTOKEN: $(System.AccessToken)
                    - task: PublishTestResults@2
                      condition: always()
                      inputs: { testResultsFormat: JUnit, testResultsFiles: 'eztest-results/run-*/junit.xml', testRunTitle: 'EZTest SIT \${{ app }}' }
                    - task: PublishPipelineArtifact@1
                      condition: always()
                      inputs: { targetPath: eztest-results, artifact: 'sit-\${{ app }}' }
`;

const READINESS = `# Release readiness gates: GO / GO_WITH_RISKS / NO_GO with cited reasons (docs/configuration.md#readiness-policy).
# noFailedCriticalJourneys needs journeys with Risk 4 or 5 (the samples have them); a11yNoCritical needs
# accessibility results (the a11y lens in eztest.config.yaml records them).
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
`;

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true
  },
  "include": ["apps/**/*.ts", "shared/**/*.ts"]
}
`;

const SHARED_STEPS = `/**
 * Step definitions every application's features use: one definition for the whole project
 * (docs/project-guide.md#helpers-or-steps). App-specific steps live in apps/<app>/steps/.
 */
import { Given } from '@eztech.com/eztest/bdd';

// Every application of this project answers GET /api/health (relative to its baseUrl).
Given('the application is up', async ({ api, expect }) => {
  const res = await api.get('/api/health', { allowErrors: true });
  await expect(res.status, 'health check status').toBe(200);
});
`;

const SHARED_UNIQUE = `/**
 * Test data generators shared by every application: values unique across workers, shards and
 * machines, so parallel journeys never collide (docs/project-guide.md#test-data-per-environment).
 */
import { uniqueValue } from '@eztech.com/eztest/core';

/** A reference such as PO-mq3k9d-7f2a-1, unique to this run, worker and machine. */
export function uniqueReference(prefix: string): string {
  return uniqueValue(prefix);
}
`;

/** Files written once per project (not per application). */
export function projectFiles(n: AppNames): Record<string, string> {
  return {
    'eztest.config.yaml': CONFIG + projectBlock(n),
    'config/dev.yaml': ENV_LAYER('dev', 'concurrency: 2\nretries: 0\n'),
    'config/sit.yaml': ENV_LAYER('sit', 'concurrency: 4\nretries: 1               # a shared environment: one retry; the flake classifier records why\n# ado: { testPlanId: 0, testSuiteId: 0 }\n'),
    'config/uat.yaml': ENV_LAYER('uat', 'concurrency: 4\nretries: 1\n# ado: { testPlanId: 0, testSuiteId: 0 }\n'),
    '.env.example': `# The names of the secrets this suite reads; the values never go into git (docs/project-guide.md#secrets).
# Locally: copy to .env (git ignores it) and fill in. Pipelines: secret variables with the same names.
# secret://env/NAME in the config reads EZTEST_SECRET_NAME.
# EZTEST_MASTER_KEY=          (only when the config holds ENC(...) values: eztest secret encrypt <value>)
${envExampleLines(n)}`,
    'readiness-policy.yaml': READINESS,
    'pipelines/azure-pipelines.yml': fill(PIPELINE, n),
    'README.md': README,
    'tsconfig.json': TSCONFIG,
    'shared/steps/common.steps.ts': SHARED_STEPS,
    'shared/helpers/unique.ts': SHARED_UNIQUE,
  };
}

/** The application's lines of .env.example. */
export function envExampleLines(n: AppNames): string {
  return fill(`# __APP__
EZTEST_SECRET___APPU___CLERK_PASSWORD=
EZTEST_SECRET___APPU___DB_PASSWORD=
# __APPU___BASE_URL=http://localhost:3000   (overrides the host of the selected environment)
`, n);
}

// ------------------------------------------------------------------ application files

const APP_ENV = (env: string, host: string, db: string) => `# __APP__ in ${env.toUpperCase()}: its host, database and accounts. The pipeline can set the host (__APPU___BASE_URL).
baseUrl: \${__APPU___BASE_URL:-${host}}
identity:
  roles:
    clerk: { username: ${env === 'dev' ? 'clerk' : `${env}-clerk`} }
db:
  connections:
${db}`;

const EZ = `# The plain-English style (docs/project-guide.md#choosing-a-style). Elements: apps/__APP__/elements/orders.yaml;
# data: apps/__APP__/data/<env>/orders.csv (one journey per row); the database check: apps/__APP__/queries/.
Journey: Place an order
Id: __APP__-orders-place-order
Tags: @smoke @regression @orders
Requirements: ORD-1
Risk: 4
Role: clerk
Examples: from data "apps/__APP__/data/\${DATA_ENV}/orders.csv"

Log in
Open /orders/new
Set variable reference to unique("PO-")
Type "<customer>" into the @Orders.customer field
Type "\${reference}" into the @Orders.reference field
Fill the @Orders.quantity field with <quantity>
Click the @Orders.placeOrder button
  Expect the page contains "created"
Capture the text of @Orders.orderNumber as orderNumber
  Expect the @Orders.orderTotal text has text "<total>"
Expect query "__APPU___ORDER_BY_NUMBER" on __DB__ with order_number=\${orderNumber} returns 1 row
`;

const FEATURE = `# The BDD style, when the business owns the wording (docs/project-guide.md#choosing-a-style).
# Steps: apps/__APP__/steps/orders.steps.ts and shared/steps/common.steps.ts; "I am logged in as" is an
# EZTest phrasing (the Identity Vault login) and needs no definition.
@orders
Feature: Orders
  A clerk places orders for customers, and every order is stored.

  Background:
    Given the application is up
    And I am logged in as "clerk"

  @id:__APP__-orders-place-order-bdd @smoke @regression @req:ORD-1 @risk:4
  Scenario: Place an order
    When I place an order for 2 items for "Contoso Ltd"
    Then the order total is "25.00"
    And the order is stored in the database
`;

const STEPS = `/**
 * Step definitions for the orders features of __APP__ (docs/bdd.md). Elements come from the screen
 * model (screens/orders.ts), which shares its ids with elements/orders.yaml.
 */
import { Then, When } from '@eztech.com/eztest/bdd';
import { Orders } from '../screens/orders.ts';
import { uniqueReference } from '../../../shared/helpers/unique.ts';

/** What the steps of one scenario share (a new World for every scenario attempt). */
interface OrdersWorld {
  orderNumber?: string;
}

When('I place an order for {int} items for {string}', async ({ ui, world }, quantity: number, customer: string) => {
  await ui.open('/orders/new');
  await ui.fill(Orders.customer, customer);
  await ui.fill(Orders.reference, uniqueReference('PO-'));
  await ui.fill(Orders.quantity, String(quantity));
  await ui.click(Orders.placeOrder, { expect: { text: 'created' } });
  (world as OrdersWorld).orderNumber = await ui.text(Orders.orderNumber);
});

Then('the order total is {string}', async ({ expect }, total: string) => {
  await expect.ui.text(Orders.orderTotal).toBe(total);
});

Then('the order is stored in the database', async ({ db, expect, world }) => {
  const stored = await db.count('__APPU___ORDER_BY_NUMBER', { order_number: String((world as OrdersWorld).orderNumber) });
  await expect(stored, 'orders stored with this number').toBe(1);
});
`;

const CODE = `/**
 * The TypeScript style, for logic that is easier in code (docs/project-guide.md#choosing-a-style).
 * The order is set up through the API (fast, no screens), then checked where the user sees it and
 * where it is stored. The data row comes from apps/__APP__/data/<env>/orders.csv.
 */
import { expect, journey, step } from '@eztech.com/eztest/sdk';
import { Orders } from '../../screens/orders.ts';
import { createOrder } from '../../helpers/orders-api.ts';

journey('Order created through the API shows its total', {
  id: '__APP__-orders-order-from-api',
  tags: ['@regression', '@orders'],
  requirements: ['ORD-2'],
  risk: 3,
  role: 'clerk',
}, async ({ ui, db, data, vars }) => {
  const [row] = await data.rows('apps/__APP__/data/' + vars.config('DATA_ENV', 'dev') + '/orders.csv');
  const order = await step('Create the order through the API', () => createOrder({ customer: row.customer, quantity: Number(row.quantity) }));
  await ui.login();
  await ui.open('/orders/' + order.number);
  await expect.ui.text(Orders.orderNumber).toBe(order.number);
  await expect.ui.text(Orders.orderTotal).toBe(row.total);
  await expect(await db.count('__APPU___ORDER_BY_NUMBER', { order_number: order.number }), 'orders stored with this number').toBe(1);
});
`;

const HELPER = `/**
 * The orders API of __APP__. Setting test data up through the API is faster and steadier than
 * through the screens (docs/project-guide.md#api-setup); the journey then checks the screens.
 */
import { api } from '@eztech.com/eztest/sdk';
import { uniqueReference } from '../../../shared/helpers/unique.ts';

export interface CreatedOrder {
  number: string;
  total: string;
}

/** Create an order; the step fails unless the API answers 201. */
export async function createOrder(order: { customer: string; quantity: number }): Promise<CreatedOrder> {
  const res = await api.post<CreatedOrder>('/api/orders', { ...order, reference: uniqueReference('API-') }, { expectStatus: 201 });
  return res.body;
}
`;

const SCREEN = `/**
 * The orders screens of __APP__ as a screen model, for code journeys and step definitions. The ids
 * (Orders.customer, ...) are those of elements/orders.yaml: the repository's locators come first,
 * so a heal accepted there reaches code too (docs/elements.md).
 */
import { screen } from '@eztech.com/eztest/sdk';

export const Orders = screen('Orders', {
  customer: { label: 'Customer' },
  reference: { label: 'Your reference' },
  quantity: { label: 'Quantity' },
  placeOrder: { role: 'button', name: 'Place order', testId: 'place-order' },
  orderNumber: 'testid=order-number',
  orderTotal: 'testid=order-total',
});
`;

const ELEMENTS = `# The orders screens of __APP__: one name per element, used by .ez journeys (@Orders.customer), step
# definitions and code journeys (screens/orders.ts has the same ids). docs/elements.md
screen: Orders
elements:
  customer:
    description: the "Customer" field
    locators: [{ strategy: label, value: Customer }]
  reference:
    description: the "Your reference" field
    locators: [{ strategy: label, value: Your reference }]
  quantity:
    description: the "Quantity" field
    locators: [{ strategy: label, value: Quantity }]
  placeOrder:
    description: the "Place order" button
    locators:
      - role=button[name="Place order"]
      - testid=place-order
  orderNumber:
    description: the order number
    locators: [testid=order-number]
  orderTotal:
    description: the order total
    locators: [testid=order-total]
`;

const QUERY = `-- connection: __DB__
-- description: One order by its number: the read-only check after an order is placed
-- params: order_number
SELECT order_number, customer, quantity, total
  FROM orders
 WHERE order_number = :order_number
`;

const DATA: Record<string, string> = {
  dev: 'case,customer,quantity,total\nsmall-order,Contoso Ltd,2,25.00\nbulk-order,Northwind Traders,40,500.00\n',
  sit: 'case,customer,quantity,total\nsmall-order,SIT Customer 1,2,25.00\nbulk-order,SIT Customer 2,40,500.00\n',
  uat: 'case,customer,quantity,total\nsmall-order,UAT Customer 1,2,25.00\n',
};

/** The files of one application. */
export function appFiles(n: AppNames): Record<string, string> {
  const sqlite = fill('    __DB__: { driver: sqlite, file: "${__APPU___DB_FILE:-__APP__.db}" }   # a local copy; sit/uat use the real server\n', n);
  const server = (env: string) => fill(`    __DB__:
      driver: postgres                      # needs the pg package (npm install --save-dev pg); mssql, oracle, mariadb: docs/databases.md
      host: \${__APPU___DB_HOST:-__APP__-db.${env}.example.test}
      database: __APP__
      user: eztest_reader                   # a read-only account (docs/project-guide.md#database-checks)
      password: secret://env/__APPU___DB_PASSWORD
`, n);
  return {
    [`config/${n.app}/dev.yaml`]: fill(APP_ENV('dev', 'http://localhost:3000', sqlite), n),
    [`config/${n.app}/sit.yaml`]: fill(APP_ENV('sit', `https://${n.app}.sit.example.test`, server('sit')), n),
    [`config/${n.app}/uat.yaml`]: fill(APP_ENV('uat', `https://${n.app}.uat.example.test`, server('uat')), n),
    [`apps/${n.app}/journeys/orders/place-order.ez`]: fill(EZ, n),
    [`apps/${n.app}/features/orders/place-order.feature`]: fill(FEATURE, n),
    [`apps/${n.app}/steps/orders.steps.ts`]: fill(STEPS, n),
    [`apps/${n.app}/code/orders/order-from-api.journey.ts`]: fill(CODE, n),
    [`apps/${n.app}/elements/orders.yaml`]: fill(ELEMENTS, n),
    [`apps/${n.app}/screens/orders.ts`]: fill(SCREEN, n),
    [`apps/${n.app}/helpers/orders-api.ts`]: fill(HELPER, n),
    [`apps/${n.app}/data/dev/orders.csv`]: DATA.dev,
    [`apps/${n.app}/data/sit/orders.csv`]: DATA.sit,
    [`apps/${n.app}/data/uat/orders.csv`]: DATA.uat,
    [`apps/${n.app}/queries/${n.db}/${n.upper}_ORDER_BY_NUMBER.sql`]: fill(QUERY, n),
  };
}

/** npm scripts. The first application gets the short names (test, test:sit, ...); every one gets test:<app>. */
export function appScripts(n: AppNames, first: boolean): Record<string, string> {
  const p = `--project ${n.app}`;
  const own: Record<string, string> = {
    [`test:${n.app}`]: `eztest run ${p} -e dev`,
    [`validate:${n.app}`]: `eztest validate ${p} -e dev`,
    [`studio:${n.app}`]: `eztest studio ${p} -e dev`,
  };
  if (!first) return own;
  return {
    test: `eztest run ${p} -e dev`,
    'test:dev': `eztest run ${p} -e dev`,
    'test:sit': `eztest run ${p} -e sit`,
    'test:uat': `eztest run ${p} -e uat`,
    'test:smoke': `eztest run ${p} -e dev -t @smoke`,
    'test:regression': `eztest run ${p} -e dev -t @regression`,
    'test:orders': `eztest run ${p} -e dev -t @orders`,
    'test:headed': `eztest run ${p} -e dev --headed`,
    'test:headless': `eztest run ${p} -e dev --headless`,
    'test:parallel': `eztest run ${p} -e dev -w 4`,
    ...own,
    lint: 'eztest lint',
    validate: `eztest validate ${p} -e dev`,
    studio: `eztest studio ${p} -e dev`,
    report: 'eztest report trends -o eztest-results/trends.html',
    doctor: `eztest doctor ${p} -e dev`,
  };
}
