# Configuration

EZTest reads one validated configuration, built from these layers (later layers win):

1. built-in defaults
2. `eztest.config.yaml` (or `.yml` / `.json`), or the file given with `--config`
3. the project overlay `projects.<name>`, selected with `--project <name>` or `EZTEST_PROJECT` (see [Projects](#projects))
4. `config/<env>.yaml|json`, selected with `--env <env>` or `EZTEST_ENV`; then, with a project, `projects.<name>.environments.<env>` and `config/<project>/<env>.yaml|json`
5. `.env` and `.env.<env>`; with a project, also `.env.<project>` and `.env.<project>.<env>`
6. `EZTEST_*` environment variables (`EZTEST_BASE_URL`, nested keys with `__`, e.g. `EZTEST_TIMEOUTS__STEP=20000`)
7. command-line flags

### Environment variables

One naming scheme:

- **Settings** are `EZTEST_<SECTION>__<KEY>`: `__` separates the levels of the configuration, and a single `_` inside a name becomes camelCase. `EZTEST_TIMEOUTS__STEP=20000` sets `timeouts.step`, `EZTEST_ADO__ORGANIZATION_URL` sets `ado.organizationUrl`, `EZTEST_BASE_URL` sets `baseUrl`. A variable that names no setting is ignored with a warning on stderr.
- **Credentials and switches that are not settings** are flat names: `EZTEST_ADO_PAT`, `EZTEST_SERVER_TOKEN`, `EZTEST_MASTER_KEY`, `EZTEST_ENV`, `EZTEST_PROJECT`, `EZTEST_CONFIG`, and the browser driver's `EZTEST_CHROMIUM_PATH`, `EZTEST_FIREFOX_PATH`, `EZTEST_BROWSERS_PATH`.
- **Secrets of the env secret store** are not settings either: `EZTEST_SECRET_<NAME>` (the prefix `eztest init` configures, read by `secret://env/<NAME>`) and any other `EZTEST_` prefix of an `identity.secretStores` entry of type `env` are left alone, with no warning.
- **Accepted aliases** (no warning; the canonical name wins when both are set): `EZTEST_ADO_ORG_URL` and `EZTEST_ADO__ORG_URL` for `EZTEST_ADO__ORGANIZATION_URL`, `EZTEST_ADO_PROJECT` for `EZTEST_ADO__PROJECT`.

Unknown keys produce warnings. Invalid values stop the run with the exact path at fault. `eztest doctor` shows which layers were used. For every project (or only the one given with `--project`), it also shows the effective values: base URL, browser and channel, timeouts, evidence policy, loaders, databases, roles and client certificates. `eztest doctor --no-browser` skips the browser launch check.

## Values

- `${VAR}` and `${VAR:-default}` read environment and `.env` variables when the config loads. An unset variable with no default is an error.
- `$${name}` is kept as a literal `${name}`, for values that only exist during a run, such as something a step captured.
- `ENC(v1:…)` holds an encrypted secret (AES-256-GCM, key derived with scrypt from `EZTEST_MASTER_KEY`). Create one with `eztest secret encrypt <value>`. EZTest has no built-in key. Decrypted values are masked in every log and report.
- `secret://<store>/<key>` references a secret held in a secret store (see `identity.secretStores`). Secrets are resolved only at the moment they are used. `secret://env/NAME` reads the real environment and the loaded `.env` files, so `.env.<project>.<env>` can hold a project's secrets. Database connection fields (`password`, `user`, `connectionString`) accept references too, and they are resolved the first time the connection is used.
- `vars:` holds plain configuration variables. `${NAME}` can use them in every config value, and journeys can use them as `${NAME}`. `.env` files and the real environment take precedence over them. Variables may reference each other. A variable's own name in its value is the environment's variable of that name: `THE_INTERNET_URL: ${THE_INTERNET_URL:-https://the-internet.herokuapp.com}` is the environment's `THE_INTERNET_URL`, else the default. Variables that refer to each other in a cycle nothing breaks (`APP: ${APP}/web`, or `A: ${B}` with `B: ${A}`) stop the run with the cycle named. An unresolved `${X}` of a name nothing defines stays as text inside a variable. `ENC(...)` variable values are decrypted and masked. A value that is a secret reference (`PASSWORD: secret://env/PASSWORD`) is resolved through the secret stores when a run starts and masked; `eztest import` replaces credentials it finds in the source tests with such variables and lists them in `import-report.md`.

## Reference

```yaml
environment: default
baseUrl: https://app.test
browser: chromium              # chromium | firefox (Chrome and Edge: channel; Safari/WebKit is not supported)
headless: true
concurrency: 1                 # journeys in parallel
workers: process               # parallel journeys in worker processes (default when concurrency > 1), or inline; docs/scale.md
retries: 0
logLevel: info
timeouts: { step: 15000 }
journeysDir: journeys
bddDir: features               # Gherkin .feature files (docs/bdd.md); default features/ when it exists
bdd:
  steps: ["**/*.steps.ts"]     # step definition globs (default: *.steps.* and step_definitions/ folders)
  fallback: true               # steps without a definition may run as EZTest phrasings
  language: en                 # for files without "# language:"
  worldParameters: {}          # passed to every World
outputDir: eztest-results
elements:                      # shared element repository (docs/elements.md)
  dir: elements                # elements/*.yaml
  screens: []                  # TypeScript screen dirs read statically, e.g. [screens]
  matchDescriptions: true      # bind journeys to elements by description / alias
reporters: [console, html, json, junit]

healing:
  enabled: true
  maxTier: T2-semantic         # T0-cache | T1-fingerprint | T2-semantic
  minConfidence: 0.7           # heals are also verified by post-conditions
  requireVerification: true    # a heal counts only when the step's post-conditions verify it; false: a heal of a
                               # step with nothing to verify it passes healed, marked unverified (never cached or applied)
  autoApply: false             # true: after a run, verified heals are written into the journey files
                               # (diff in <run>/heal-applied.diff, accepted decisions in .eztest/heal-decisions.json)

lenses: [a11y, security:warn, visual]   # after every step; ":warn" = record only

identity:
  sessionDir: .eztest/sessions
  sessionMaxAgeMinutes: 30
  secretStores:
    - { type: env, prefix: APP_ }                      # secret://env/X reads APP_X
    - { type: file, path: secrets.yaml }               # values may be ENC(...)
    - { type: azure-keyvault, vaultUrl: https://kv.vault.azure.net, ... }
    # secret://hashicorp-vault/apps/shop/db#password (KV v2; token or AppRole)
    - { type: hashicorp-vault, address: https://vault:8200, namespace: qa, auth: { method: approle, roleId: shop-ci, secretId: secret://env/VAULT_SECRET_ID } }
    # secret://aws-secrets-manager/prod/shop/db#password (SigV4; keys from AWS_* or secret://)
    - { type: aws-secrets-manager, region: eu-west-1 }
    # secret://gcp-secret-manager/shop-db-password[@version] (service-account key; CRC32C checked)
    - { type: gcp-secret-manager, project: shop-qa, credentialsFile: keys/qa-sa.json }
    # secret://cyberark-ccp/QA-Safe/shop-db (Central Credential Provider; mutual TLS)
    - { type: cyberark-ccp, url: https://ccp.corp, appId: EZTest_QA, clientCert: certs/ccp.pem, clientKey: certs/ccp-key.pem }
  roles:
    manager:
      loginUrl: /login
      username: bob                                    # or secret://...
      password: secret://env/BOB_PASSWORD
      totp: secret://env/BOB_TOTP                      # optional: TOTP MFA
      successUrl: /dashboard                           # also used to re-check cached sessions
      fields: { username: "Email", submit: "Log in" }  # optional field descriptions
      api: { tokenUrl: /oauth/token, clientId: app, clientSecret: secret://env/CLIENT_SECRET }
    broker:                                            # API-only role: no username or loginUrl;
      api: { tokenUrl: /oauth/token, clientId: broker, clientSecret: secret://env/BROKER_SECRET }  # used by "as broker" API steps only

db:
  connections:
    shop: { driver: sqlite, file: ./shop.db }
    erp:  { driver: postgres, connectionString: "${ERP_DB_URL}" }   # needs the `pg` package
    crm:  { driver: mssql, server: sql.test, database: crm, user: qa, password: secret://env/CRM_PW }  # needs `mssql`
    hr:   { driver: mariadb, host: hr-db.test, database: hr, user: qa, password: secret://env/HR_PW, ssl: { ca: certs/hr-ca.pem } }  # MySQL/MariaDB: built in
    # SQL Server from a connection string, Windows (NTLM) or Entra ID authentication: docs/databases.md
    hr:   { driver: mssql, connectionString: "Server=tcp:hr.corp,1433;Database=hr;User ID=CORP\\qa;Password=secret://env/HR_PW;Integrated Security=true" }
    ledger:                                   # needs `oracledb` (Thin mode: no Oracle Client install)
      type: oracle                            # `type:` is accepted as an alias of `driver:`
      host: ora.test
      port: 1521
      serviceName: LEDGERPDB                  # or sid: LEDGER, or connectString: "host:1521/SERVICE" / a TNS alias
      user: qa_reader
      password: secret://vault/LEDGER_PW      # secret:// or ENC(...)
      pool: { min: 0, max: 4 }
      fetchAsString: [DATE]                   # optional: DATE/TIMESTAMP/NUMBER/CLOB/JSON/RAW as text
  queries:                                    # the named-query catalogue (docs/databases.md)
    dir: queries                              # one NAME.sql per query (subfolders allowed)
    inline:
      LEDGER_PING: SELECT 1 AS ok FROM dual

data:
  seed: 42
  entities:
    Customer: { provider: sql, connection: shop, table: customers }
    Lead:     { provider: synthetic, columns: { name: fullName, email: email } }
    # defaults fill the columns a "Create" leaves out; gen:unique:PREFIX gives a value unique to the run
    Order:    { provider: sql, connection: shop, table: orders, defaults: { ref: "gen:unique:ORD-", status: OPEN } }

documents:
  invoice-vs-order:                   # used by "Compare document <x> to ... using invoice-vs-order"
    template: templates/invoice.yaml  # field + table extraction template
    db:
      connection: shop
      query: "SELECT ... WHERE 'ORD-' || o.id = ?"
      linesQuery: "SELECT ... line items ..."
      params: ['$${orderNumber}']
    fields:
      - { name: total, ui: orderTotal, pdf: total, db: total, type: currency, tolerance: { abs: 0.005 } }
    lines: { pdfTable: lines, key: SKU, fieldMap: { SKU: sku, Qty: qty } }
    footing: { pdfTable: lines, column: Line Total }

d365:                                   # Dynamics 365 / Power Apps add-on
  url: https://contoso.crm.dynamics.com
  tenantId: <tenant-guid>                # or tokenUrl: ...
  clientId: ${D365_CLIENT_ID}
  clientSecret: secret://env/D365_CLIENT_SECRET
  entities: [account, opportunity]       # for phrasings and release-wave snapshots
  dateFormat: M/d/yyyy

salesforce:                             # Salesforce Lightning add-on
  instanceUrl: https://contoso.my.salesforce.com
  lightningUrl: https://contoso.lightning.force.com   # optional
  clientId: ${SF_CLIENT_ID}
  clientSecret: secret://env/SF_CLIENT_SECRET
  apiVersion: '61.0'
  users:                                # roles for "Log in to Salesforce as <role>" and the permission matrix
    admin: { username: admin@contoso.com, password: secret://env/SF_ADMIN_PASSWORD }
    rep:   { username: rep@contoso.com,   password: secret://env/SF_REP_PASSWORD }
  apiUser: admin                        # REST user for SOQL cross-checks and snapshots
  objects: [Account, Opportunity]       # for phrasings and release snapshots

# Packaged-app packs; each block is optional (full reference in docs/apps/<pack>.md)
servicenow: { instanceUrl: https://acme.service-now.com, auth: { type: basic, username: eztest.integration, password: secret://env/SN_PASSWORD }, tables: [incident] }
sap: { url: https://s4qas.example.com, client: '100', auth: { type: basic, username: COMM_EZTEST, password: secret://env/SAP_PASSWORD }, services: [{ name: API_SALES_ORDER_SRV, version: 2, path: /sap/opu/odata/sap/API_SALES_ORDER_SRV }] }
workday: { url: https://wd2-impl-services1.workday.com, tenant: acme, auth: { type: oauth2, grant: refresh_token, tokenUrl: https://wd2-impl-services1.workday.com/ccx/oauth2/acme/token, clientId: wd-api-client, clientSecret: secret://env/WD_CS, refreshToken: secret://env/WD_RT } }
oracle: { url: https://acme.fa.us2.oraclecloud.com, auth: { type: basic, username: EZTEST.INTEGRATION, password: secret://env/ORA_PASSWORD }, resources: [{ name: purchaseOrders, path: /fscmRestApi/resources/11.13.18.05/purchaseOrders, key: OrderNumber }] }
powerapps: { apps: [{ name: Account Manager, url: https://apps.powerapps.com/play/e/<env>/a/<app> }] }

desktop:                                # desktop apps (see desktop-and-legacy.md)
  windows: { url: http://10.0.0.5:47123, token: secret://env/WIN_AGENT_TOKEN, apps: { invoice: { app: 'C:\Apps\Invoice.exe' } } }
  java: { apps: { ledger: { command: [java, -jar, apps/ledger.jar] } } }
  sap: { bridge: http://127.0.0.1:8765, token: secret://env/SAP_BRIDGE_TOKEN, systems: { ERP: { connection: ERP Development, client: '100', user: TESTER, password: secret://env/SAP_PASSWORD } } }
  electron: { executablePath: node_modules/.bin/electron }   # optional

mainframe:                              # TN3270 hosts
  hosts:
    cics: { host: mf.example.com, port: 992, tls: true, users: { clerk: { user: CLERK01, password: secret://env/MF_CLERK } } }

citrix:                                 # pixels-only screens: VNC sessions, image templates, OCR
  sessions: { desk1: { vnc: 'vdi-gw.example.com:5901', password: secret://env/VDI_VNC } }
  images: test-images
  match: { threshold: 0.9, scales: [1, 1.25, 1.5, 0.8, 2] }
  ocr: { lang: eng, minConfidence: 60 }

ado:                                     # docs/azure-devops.md
  organizationUrl: https://dev.azure.com/contoso   # or an Azure DevOps Server collection URL (+ apiVersion: '7.0')
  project: Shop
  pat: secret://env/ADO_PAT                # or auth: { type: workload-identity | service-principal | managed-identity | system-access-token, ... }
  testPlanId: 417                          # per environment in config/<env>.yaml
  testSuiteId: 418
  createBugs: false
  publishResults: false                  # true: eztest run publishes to Test Plans and links the report (docs/reports.md)
  configurations: { chromium: "Windows + Chrome" }
  paths: [{ tag: payments, areaPath: Shop\Payments }]

vcs:                                     # docs/git.md
  branchScope: { history: true, baselines: true, defaultBranch: main }
  pullRequests: { onHealAccept: false, onBaselineApprove: false, onQuarantine: false }
  owners: { "@alice": alice@contoso.com }

readiness:                               # opt-in (below): evaluate the policy after every run
  policyPath: readiness-policy.yaml

report:                                  # docs/reports.md
  name: Contoso Shop                     # the project name in the header; title: too
  trendRuns: 20
  baseline: previous                     # previous | none | <run directory>
  studioUrl: http://localhost:4400
  readiness: false                       # true: a secondary "Policy" tab with the policy's decision
  brand:                                 # white-label branding of every output (docs/reports.md#branding)
    company: Contoso QA
    logo: branding/logo.svg
    colors: { primary: "#0b5cad" }
  # brandFile: branding.yaml             # overrides report.brand (also --brand-file, EZTEST_BRAND_FILE)

security:
  allowPageScripts: false          # "Run script" / "Run JavaScript" steps (they run in the page, never in Node)

dialogs:                           # alert/confirm/prompt nobody armed for: recorded as evidence, warned about
  default: dismiss                 # or accept
  beforeunload: accept             # leave the page by default

hooks:                             # journey ids, names or files; beforeEach/afterEach run inside each journey's browser
  beforeAll: [journeys/hooks/seed.ez]
  beforeEach: [accept-cookies]
  afterEach: []
  afterAll: []

email:                             # mailbox for "Get the latest email ..."
  provider: sink                   # EZTest's built-in SMTP server (point the app's SMTP at it)
  port: 2525

sms:                               # inbox for "Get the latest SMS ..."
  provider: twilio
  accountSid: secret://env/TWILIO_SID
  authToken: secret://env/TWILIO_TOKEN

api:
  spec: specs/shop.yaml            # validate every API step against this OpenAPI/Swagger spec (docs/api-contracts.md)
  specMode: enforce                # enforce | warn

contracts:                         # EZTest contracts: files, matchers, provider verification, can-release (docs/api-contracts.md)
  dir: contracts                   # <consumer>-<provider>.contract.json
  matchers: type                   # type | schema | exact
  app: shop-web                    # this application on the results server (server:)
  canRelease: { environment: production }

messaging:                         # Kafka, RabbitMQ, AMQP 1.0, MQTT, IBM MQ brokers (docs/messaging.md)
  brokers:
    bus: { type: kafka, brokers: [localhost:9092] }
    sb: { type: amqp10, url: amqps://ns.servicebus.windows.net, addressing: servicebus, sas: { keyName: send, sharedAccessKey: secret://env/SB_KEY } }

soap:                              # SOAP services from WSDLs: validation, WS-Security, MTOM (docs/soap.md)
  services:
    policy: { wsdl: wsdl/policy.wsdl, endpoint: https://policy.test/ws, security: { username: svc, password: secret://env/POLICY_PW, passwordType: digest } }

grpc: { services: { orders: { address: localhost:50051, proto: protos/orders.proto } } }
files:                             # SFTP servers, SSH hosts with allow-listed commands, drop folders
  sftp: { partner: { host: sftp.example.com, username: shop, password: secret://env/SFTP_PW } }
batch: { jobs: { close-day: { ssh: batch-host, command: "./close-day.sh $${date}" } } }
```

`$${name}` keeps a literal `${name}` in a config value, for values only known at run time (provider-state params, batch-job parameters, job ids).

Journeys tagged `@library` are not run by `eztest run` on their own; other journeys call them with `Run journey "<id>" with k=v`.

## Scale, server, plugins and operations

```yaml
configVersion: 1                  # schema version; eztest upgrade-config migrates older files
server:                           # results server (docs/server.md)
  url: https://eztest.example.com
  # token: secret://env/SERVER_TOKEN   # optional; without it EZTEST_SERVER_TOKEN is read directly.
  #                                   # secret://env/NAME goes through the env store (EZTEST_SECRET_NAME with prefix EZTEST_SECRET_)
  project: payments               # default: the selected project, else "default"
  sharedState: true               # pull heal decisions, quarantine, triage overrides before runs
  publish: false                  # publish every run (or use --publish)
locks:                            # Locks: on journeys (docs/scale.md)
  backend: auto                   # auto | file | server | off
  dir: .eztest/locks
  ttlSeconds: 120
  timeoutMinutes: 30
selection:
  impactMapping: impact-mapping.yaml   # for --changed-since
store:                            # shared test data across journeys, runs and pipeline stages (docs/shared-data.md)
  backend: auto                   # auto (server when server.url is set) | file | server
  dir: .eztest/store
  defaultTtl: 7d
  pools: { approvable-policies: { from: data/policies.csv, column: policyNo } }
pipelines:                        # eztest run --pipeline <name|auto> (docs/pipelines.md)
  pr:         { trigger: pr, tags: "@smoke", impact: true, budget: 10m }
  nightly:    { trigger: schedule, tags: "@regression and not @quarantined", shards: 4 }
  deploy-sit: { environment: sit, tags: "@sit or @smoke", testPlan: 417, gate: readiness }
  deploy-uat: { environment: uat, tags: "@uat", requires: [deploy-sit] }
plugins: [./plugins/acme.mjs, "@acme/eztest-sso"]   # docs/plugins.md
publishers:                       # after eztest run / eztest publish
  - { use: slack, webhook: secret://env/SLACK_WEBHOOK, when: failed }
telemetry:
  otlp: { endpoint: http://collector:4318, serviceName: eztest }
webServer:                        # start the app under test (spawned without a shell)
  command: [npm, run, start]
  url: http://127.0.0.1:3000/
  reuseExisting: true
```

`reporters:` also accepts reporter names registered by plugins.

## Projects

One configuration can hold several projects (for example, several applications tested from one repository), and each project can have its own environments:

```yaml
baseUrl: https://default.example.test   # shared by every project
retries: 1
projects:
  orders:
    baseUrl: https://orders.example.test
    db: { connections: { orders: { driver: postgres, host: db.example.test, password: secret://env/ORDERS_DB_PASSWORD } } }
    identity: { roles: { clerk: { username: clerk1, password: secret://env/CLERK_PASSWORD, loginUrl: /login } } }
    environments:                         # optional inline environments
      sit: { baseUrl: https://orders-sit.example.test }
  payments:
    baseUrl: https://payments.example.test
    api: { clientCertificates: [{ name: partner, origin: https://pay-api.example.test, pfx: certs/partner.p12, passphrase: secret://env/PARTNER_PFX_PASS }] }
```

`eztest run --project orders --env sit` applies these layers, lowest first:

1. the base file
2. `projects.orders`
3. `config/sit.yaml`
4. `projects.orders.environments.sit`
5. `config/orders/sit.yaml`
6. `.env`, `.env.sit`, `.env.orders` and `.env.orders.sit`
7. `EZTEST_*` variables
8. command-line flags

The [EZTest Project Guide](project-guide.md#the-project-layout) builds a multi-application project this way: one project per application (`apps/<app>/` with its own `journeysDir`, `elements.dir`, `bdd.steps`, `db.queries.dir`, roles and `identity.sessionDir`), `config/<env>.yaml` for what every application shares in an environment and `config/<app>/<env>.yaml` for the application's host, database and accounts. `eztest init --template enterprise` writes it, and `eztest init --app <name>` adds an application.

Every command that reads configuration takes `--project`: run, validate, monitor, ado, import --verify, d365, salesforce, doctor and studio. EZTest never interpolates the overlays of other projects, so a project may reference variables that only its own runs set. In the Studio, the **Environments** page has a project switcher next to the environment switcher. It shows each effective value with the layer that set it.

## Browser, evidence and waits

```yaml
browser: { name: chromium, channel: msedge }   # or: browser: chromium + channel: msedge | chrome | chromium
browsers: [chromium, firefox, msedge]          # cross-browser run: journey x browser units, ids <id>@<browser> (CLI: --browsers)
# browser: { name: chromium, connect: { cdpEndpoint: http://chrome-host:9222, auth: { token: secret://env/GRID_TOKEN } } }
#   attach to a running Chrome/Edge (DevTools) or Firefox (bidiEndpoint: ws://host:9222) instead of launching one
video: retain-on-failure       # off (default) | on | retain-on-failure: the .webm is kept only when the attempt did not pass
screenshots: before-assertions # every-step | on-failure | off | before-assertions (on failure + before every assertion)
trace:
  browser: on-failure          # off | on | on-failure | retain-on-failure: the browser trace zip (EZTest's own format, opens in Studio's trace viewer) is kept only for attempts that did not pass
waits:
  loaders: [".spinner", ".loading", "xpath=//div[@aria-busy='true']"]
  loaderTimeoutMs: 30000       # the cap; reaching it logs a warning and the step continues
```

With `waits.loaders`, EZTest waits before every action and every post-condition check until none of these elements is visible. Steps that do not touch the page (API, DB and variables) skip the check.

Cross-browser runs (`browsers:`) and remote browsers (`browser.connect`, over the browser's own DevTools or WebDriver BiDi protocol only) are described in [browser-driver.md](browser-driver.md#cross-browser-runs).

- **Without loaders configured,** nothing happens and there is no page round trip.
- **With loaders configured,** a check where nothing is visible costs one page evaluation. In our measurements, that was about 3 ms with four selectors.

A journey can add loaders with a `Loaders: ".busy", "#mask"` header. `Wait for loaders to disappear` waits explicitly, and fails when it reaches the cap. When no loaders are configured, it uses the default selectors `.spinner`, `.loading`, `.loader`, `[aria-busy="true"]` and `[role="progressbar"]`. The CLI's `--screenshots` and `--trace` flags override the configuration.

## Reliability, environment health, locale and time

```yaml
reliability:
  actionability: true          # wait for visible / enabled / stable / not animating / not covered; name overlays in errors
  appIdle: false               # true or { timeoutMs, quietMs, ignoreUrls }: wait for pending fetch/XHR and Angular/jQuery quiescence
  verifyFill: true             # re-type a value a re-render wiped
  reresolve: true              # re-resolve a target detached mid-action, once
  slowMo: 0                    # ms before every action, debugging only
  circuitBreaker: { enabled: true, threshold: 3 }
  sessionExpiry: { text: ["Your session has expired"] }   # off unless set; role login pages are added
  reuseContext: false          # one browser context per worker, reset between journeys
  recycleBrowserAfter: 15      # fresh browser after N journeys (default 15 on Firefox, off on Chromium; 0 = never)
  suggestLocators: true        # verified, more robust locators proposed in the heal inbox
  orphanSweep: true            # delete test data left by crashed runs
healthChecks:                  # pre-flight; a failure stops the run as an environment problem
  - { name: app, url: /health, contains: ok }
  - { name: db, db: crm }
timezone: Europe/Berlin        # browser and today()/now()/format()
locale: de-DE                  # browser and locale-aware assertions
identity:
  sessionRefreshMarginMinutes: 5
  pools: { manager: { accounts: [{ username: mgr1, password: secret://env/MGR1 }, { username: mgr2, password: secret://env/MGR2 }] } }
  lockout: { maxFailures: 3, windowMinutes: 30, backoffMs: 2000 }
lint: { translatedUi: false, rules: { hard-wait: error }, maxWarnings: 0 }
```

Everything here is described in [reliability.md](reliability.md).

## API: client certificates and templates

```yaml
api:
  clientCertificates:
    - name: partner                       # used by: with client certificate "partner"
      origin: https://api.partner.test    # presented automatically to this origin
      pfx: certs/partner.p12              # or cert: + key: (PEM files)
      passphrase: secret://env/PARTNER_PFX_PASS   # or ENC(...)
      ca: certs/partner-ca.pem            # optional extra CA to trust for this server
      browser: true                       # also present it from the browser (default)
templates:
  syntax: mustache                        # dollar (default) | mustache
db:
  queries: { dir: queries }               # named query catalogue: <dir>/<NAME>.sql
dates:
  holidays: config/holidays.yaml          # or an inline list of YYYY-MM-DD dates
  weekend: [0, 6]                         # 0 = Sunday
```

EZTest's own HTTP client (API steps and data providers) uses the client certificates. So does the browser context, through the driver's `clientCertificates` context option. A certificate is chosen by the request's origin, and an API step can pick one by name: `Call API "GET /accounts" with client certificate "partner" and store as accounts`. EZTest never disables TLS verification of the server. To trust an internal CA, use `ca:` for API calls or `NODE_EXTRA_CA_CERTS` for the browser.

API body templates (inline bodies and `with body from file`) understand `${variable}` and `${expression}`, for example `${json(items)}` or `${addBusinessDays(today(), 3)}`.

- **`templates.syntax: mustache`** also enables `{{variable}}` and `{{expression}}`, so mustache-style payload files from other frameworks run unchanged. `{{jsonEncode(x)}}` is accepted as a synonym of `{{json(x)}}`.
- **`$${...}`** stays literal.
- **Unknown variables** are left as written.

Expression functions for business days and time zones:

- `addBusinessDays(date, n[, holidays])`, `isBusinessDay(date[, holidays])`, `nextBusinessDay(date[, holidays])` and `previousBusinessDay(date[, holidays])` use the holiday calendar. A calendar file may be a YAML/JSON list of dates, `{ holidays: [...] }` (entries may be `{ date, name }`), or one date per line.
- `now("America/New_York")`, `today("Asia/Tokyo")` and `format(date, "YYYY-MM-DD HH:mm", "Europe/London")` use the IANA zone database built into Node, with no extra dependency. A date-only value is a calendar date, so a time zone does not shift it.

## Identity: secret stores

`identity.secretStores` lists the stores `secret://<name>/<key>` resolves through; `name` defaults to the type. A store's own credentials may be `secret://` references to a store listed before it (an AppRole secret id from the environment, an AWS key from a file store). Resolved values are cached for 5 minutes and masked everywhere.

| Type | Key | Authentication | Settings |
|---|---|---|---|
| `env` | variable name (after `prefix`) | - | `prefix` |
| `file` | dotted path in a JSON/YAML file | values may be `ENC(...)` | `path` |
| `azure-keyvault` | secret name[/version] | Entra client credentials | `vaultUrl`, `tenantId`, `clientId`, `clientSecret`, `authorityUrl` |
| `hashicorp-vault` | `path/to/secret#field` (field default `value`) | `auth: { method: token, token }` or `{ method: approle, roleId, secretId, mount }`; an AppRole token is renewed by logging in again when it expires or is refused | `address`, `mount` (default `secret`, KV v2), `namespace`, `ca` |
| `aws-secrets-manager` | `secret-id` or `secret-id#jsonField` | SigV4 with `accessKeyId` / `secretAccessKey` / `sessionToken`, default `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` | `region`, `endpoint` (VPC endpoint), `versionStage` |
| `gcp-secret-manager` | `secret-name` or `secret-name@version` | a service-account key (`credentialsFile`, or `credentials` as a secret reference holding the JSON) signs the token request | `project` (default: the key's), `endpoint` |
| `cyberark-ccp` | `Safe/Object`, `Object` (with `safe`), or a query `Safe=S;UserName=u` | AppID, mutual TLS with `clientCert` / `clientKey` (and `ca`) | `url`, `appId`, `safe`, `folder` |

No vendor SDK is used: each store talks to its service's REST API, AWS requests are signed with EZTest's own SigV4, and GCP tokens with EZTest's own JWT signing. The test suite checks each store against a local fake that verifies the signature or authentication; none was run against the real cloud services.

## Identity: OAuth for API steps

A role's `api:` block gets the token for `... as <role>` API, GraphQL and WebSocket steps:

```yaml
identity:
  roles:
    service:                                   # client credentials with a signed client assertion
      api: { tokenUrl: https://idp/oauth2/token, clientId: orders-svc, clientAuth: private_key_jwt, clientKey: { privateKey: secret://vault/ORDERS_SVC_KEY, kid: k1 } }
    alice:                                     # authorization code + PKCE: EZTest's headless browser signs in as alice
      username: alice@corp.test
      password: secret://vault/ALICE_PW
      api: { grant: authorization_code, tokenUrl: https://idp/oauth2/token, authorizeUrl: https://idp/oauth2/authorize, redirectUri: https://app.test/callback, clientId: spa, clientAuth: none, scope: "openid orders.read" }
    kiosk:                                     # device code, approved in the browser as the role
      username: kiosk-op
      password: secret://vault/KIOSK_PW
      api: { grant: device_code, tokenUrl: https://idp/oauth2/token, deviceAuthorizationUrl: https://idp/oauth2/devicecode, clientId: kiosk, clientAuth: none }
    batch:                                     # JWT bearer (RFC 7523)
      api: { grant: jwt_bearer, tokenUrl: https://idp/oauth2/token, clientId: batch, clientSecret: secret://vault/BATCH, assertion: { privateKey: secret://vault/BATCH_KEY, subject: batch-user } }
    legacy:                                    # resource-owner password: the role's own username and password
      username: legacy-user
      password: secret://vault/LEGACY_PW
      api: { grant: password, tokenUrl: https://idp/oauth2/token, clientId: legacy, clientSecret: secret://vault/LEGACY_CLIENT }
```

- `grant`: `client_credentials` (default), `password`, `authorization_code`, `device_code`, `jwt_bearer`, `refresh_token` (with `refreshToken:`).
- `clientAuth`: `client_secret_post` (default with a secret), `client_secret_basic`, `private_key_jwt` (RS256, PS256 or ES256 by the key; `clientKey.alg` overrides), `none` (public clients).
- Authorization code: the browser opens the authorize URL with a PKCE S256 challenge, a state and a nonce, fills the identity provider's sign-in form as the role (username, password, TOTP; the same field rules as a form login), and the redirect to `redirectUri` is intercepted, so the redirect URI need not serve anything. The state is checked before the code is exchanged.
- Device code: polled as RFC 8628 says (`authorization_pending`, `slow_down` adds 5 s); the verification page is opened in the browser and signed in as the role.
- Tokens are cached per role until 60 s (`skewSeconds`) before they expire; concurrent steps share one request. A refresh token in a response is used (and rotated) when the token expires; if the refresh is refused, the grant runs again.
- A role used only for tokens with `password`, `authorization_code` or `device_code` needs no `loginUrl`.

## Roles and single sign-on

A role signs in once per run and environment; every later `Log in` (in any journey, worker or process) reuses
its session: the browser state (cookies of every host involved, local storage) is cached in
`identity.sessionDir` for `sessionMaxAgeMinutes`, and each reuse is checked first by opening `verifyUrl`.

Apps behind a corporate front door (Citrix NetScaler, F5, an SSO gateway such as oauth2-proxy, an identity
provider such as Keycloak, Okta or ADFS) work the same way. The login URL is the app itself; it redirects the
browser to the identity provider on another host, where the role's username, password and one-time code are
entered, and back to the app:

```yaml
identity:
  roles:
    employee:
      loginUrl: /                                  # the app: the gateway sends the browser to the identity provider
      username: ada
      password: secret://vault/ada
      totp: secret://vault/ada-totp                # optional: the one-time code page
      successUrl: https://expenses.corp.test/      # back at the app (absolute: the provider's URLs carry it encoded)
      verifyUrl: /api/me                           # opened to check a cached session
      interstitials: [Accept]                      # optional: buttons that answer the provider's in-between pages
```

- **One sign-in for the run.** Parallel workers wait for the one that signs in (a lock file next to the cached
  session) and reuse its session, so a run of any size signs in once per role: identity providers count logins,
  ask for MFA every time and may limit concurrent sessions.
- **Cached sessions are checked, not trusted.** Opening `verifyUrl` must stay on the app: being sent to the
  identity provider, landing on the login page or seeing a password field means the session ended (sign-out,
  a gateway time-out). One worker then follows the redirect: when the identity provider still knows the user
  (single sign-on), the renewed gateway session is cached for the others; otherwise the role signs in again.
- **The form.** The username, password and one-time code fields are found as on any login page (only elements
  that take typed text count: a `<form aria-label="Login">` is not the username field); the submit
  button pressed is the one of the form that holds the field just filled, never a "Restart login", "Forgot
  password?" or "Try another way" button next to it. A one-time code already typed in the current 30-second
  window (by any EZTest process on the machine) is never typed again: the step waits for the next window,
  because identity providers refuse reused codes.
- **In-between pages.** Terms of use and similar pages before the app are answered with the role's
  `interstitials` buttons (default `Accept`, `I accept`, `I agree`, `Agree`, `Continue`), only while the browser
  is still on the identity provider's host; `[]` turns this off.
- **Errors.** A wrong password stops at once with the provider's own message (`Role employee: login failed:
  Invalid username or password.`), and counts towards `identity.lockout`.
- **Mid-journey expiry.** With `reliability.sessionExpiry` (for example `text: ["Sign in to your account"]`), a
  step that lands on the identity provider's sign-in page signs the role in again and runs the step again,
  once, with the re-login recorded on the journey (`reliability.relogins`).

`test/acceptance/enterprise/gateway-sso.test.ts` runs all of this against oauth2-proxy and Keycloak on two hosts
(`test/acceptance/enterprise/env/sso.sh up`).

## Identity: Microsoft Entra ID and password rotation

```yaml
identity:
  roles:
    approver:
      username: approver@contoso.test
      password: secret://vault/approver-password
      totp: secret://vault/approver-totp       # optional
      loginUrl: /                              # the app URL that redirects to Entra
      login:
        type: entra                            # default: form
        tenantHint: contoso.test               # optional: domain_hint on the authorize URL
        staySignedIn: true                     # answer to "Stay signed in?" (default true)
        promptLogin: true                      # add prompt=login so a cached SSO/Kerberos session cannot skip the credentials (default)
    shared-tester:
      username: tester01
      loginUrl: /login
      passwordRotation:                        # MIGRATION AID: password derived from a rule
        type: monthly-formula
        prefix: secret://env/TESTER_PW_PREFIX
        suffix: secret://env/TESTER_PW_SUFFIX
        format: YYYYMM                         # YYYY YY MMMM MMM MM M
        rotatesOn: first-friday                # a day number, or first|second|third|fourth|last-<weekday>
        timezone: Europe/London                # optional
```

The Entra recipe handles these screens in whatever order they appear:

- the account picker (it picks the role's tile, or "Use another account");
- the identifier;
- the password;
- the one-time code, when the role has `totp`;
- "Stay signed in?".

It stops when `successUrl` matches, or when the browser leaves the sign-in host.

`passwordRotation` exists for shared test accounts whose password rotates on a schedule. No formula is built into EZTest: the parts come from secret stores and the rule from your configuration. Anyone who can read the rule can work out the password, so treat this as a temporary bridge and move those accounts to vault-managed passwords. You can add other providers with `registerPasswordRotationProvider(type, factory)`.

## Importers

```yaml
importers:
  plugins: [./importers/acme-steps.mjs, "@acme/eztest-importer-legacy"]   # docs/plugins.md, "Importer plugins"
  options:
    acme-steps: { strict: true }        # passed to that importer as ctx.options
```

Importer plugins add source formats to `eztest import --from <name>` and to Studio's import page. Importers for private or in-house frameworks belong in such plugins, kept in your own repository or private registry.

## Readiness policy

The readiness policy is an opt-in release gate: nothing evaluates it unless a pipeline step passes it (`eztest analyze <runDir> --policy readiness-policy.yaml`, which exits with 1 on NO_GO; `eztest run --policy`, `eztest merge --policy`) or `readiness.policyPath` is set. The report shows no decision unless `report.readiness: true` (a secondary Policy tab); the decision is always in `report.json` (`insights.readiness`) for `eztest gate` and the pipelines.

```yaml
version: 1
gates:
  noFailedCriticalJourneys: { minRisk: 4 }   # any failed journey with risk >= 4 is a blocker
  minPassRate: { min: 0.95 }
  maxHealedRatio: { max: 0.2 }               # too much healing = risk
  a11yNoCritical: true
  docsReconciled: true
  requirementsCovered: true
  uiCoverage: { min: 0.6, minPerPage: 0.4 }  # interactive elements interacted with or asserted (docs/coverage.md)
  noNewFailures: true                        # no journey newly failing or regressed
  manualVerified: true                       # every manual step has a tester's verdict (docs/manual-testing.md)
  a11yNoNewViolations: true                  # no accessibility issue new since the previous scanned run
exceptions:
  - gate: maxHealedRatio
    approver: Jane Doe                       # exceptions need a named approver
    reason: Redesign in progress, heals reviewed
    expires: 2026-12-31
```

The decision is `GO`, `GO_WITH_RISKS` or `NO_GO`. Each reason cites journey, evidence or requirement ids. A gate whose input is missing reports `no-data`; it is never counted as a pass.

## Coverage, accessibility and manual testing

```yaml
coverage:
  ui:
    routes: [/teams/:team/members]           # route templates matched before the automatic one
    ignore: ["link:Skip to content"]          # role or role:name, * wildcard
    ignoreRoutes: [/logout]
    normalizeNumbers: true                    # "ORD-12" and "ORD-13" links are one element group
    testIdAttribute: data-testid
accessibility:                                # a11y lens options and per-component scopes
  tags: [wcag2a, wcag2aa]
  exclude: ["#third-party-chat"]
  failOn: serious
  scopes:
    - { name: Payment widget, include: ["#payment"], rules: { contrast.text: warn } }
manual:
  plansFile: test-plans.json                  # suites, cycles, assignments (commit it)
  testers: [Quinn, Ravi]                      # offered for assignment
  casesDir: manual                            # where the Studio case editor writes new cases (inside journeysDir)
```

See [coverage.md](coverage.md) and [manual-testing.md](manual-testing.md).

## Behind a proxy

Every call EZTest makes to the network honours `HTTPS_PROXY` / `HTTP_PROXY` (or the lower-case names) and
`NO_PROXY`, with nothing to configure and no `NODE_USE_ENV_PROXY`: the browser, API steps (`Call API ...`), the SDK's
`context.request`, `route.fetch()`, health checks, OAuth token requests, secret stores, messaging providers, alert
webhooks, XSD downloads and `eztest install-browsers`. Proxy credentials go in the URL
(`http://user:password@proxy:3128`) and are sent as `Proxy-Authorization: Basic`. A browser on this machine is
reached directly; a remote one (a grid) through the proxy. List local hosts (`localhost,127.0.0.1,.ez.test`) in
`NO_PROXY` when the proxy cannot reach them.
