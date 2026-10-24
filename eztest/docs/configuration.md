# Configuration

EZTest reads one validated configuration, built from these layers (later layers win):

1. built-in defaults
2. `eztest.config.yaml` (or `.yml` / `.json`), or the file given with `--config`
3. the project overlay `projects.<name>`, selected with `--project <name>` or `EZTEST_PROJECT` (see [Projects](#projects))
4. `config/<env>.yaml|json`, selected with `--env <env>` or `EZTEST_ENV`; then, with a project, `projects.<name>.environments.<env>` and `config/<project>/<env>.yaml|json`
5. `.env` and `.env.<env>`; with a project, also `.env.<project>` and `.env.<project>.<env>`
6. `EZTEST_*` environment variables (`EZTEST_BASE_URL`, nested keys with `__`, e.g. `EZTEST_TIMEOUTS__STEP=20000`)
7. command-line flags

Unknown keys produce warnings. Invalid values stop the run with the exact path at fault. `eztest doctor` shows which layers were used. For every project (or only the one given with `--project`), it also shows the effective values: base URL, browser and channel, timeouts, evidence policy, loaders, databases, roles and client certificates. `eztest doctor --no-browser` skips the browser launch check.

## Values

- `${VAR}` and `${VAR:-default}` read environment and `.env` variables when the config loads. An unset variable with no default is an error.
- `$${name}` is kept as a literal `${name}`, for values that only exist during a run, such as something a step captured.
- `ENC(v1:…)` holds an encrypted secret (AES-256-GCM, key derived with scrypt from `EZTEST_MASTER_KEY`). Create one with `eztest secret encrypt <value>`. EZTest has no built-in key. Decrypted values are masked in every log and report.
- `secret://<store>/<key>` references a secret held in a secret store (see `identity.secretStores`). Secrets are resolved only at the moment they are used. `secret://env/NAME` reads the real environment and the loaded `.env` files, so `.env.<project>.<env>` can hold a project's secrets. Database connection fields (`password`, `user`, `connectionString`) accept references too, and they are resolved the first time the connection is used.
- `vars:` holds plain configuration variables. `${NAME}` can use them in every config value, and journeys can use them as `${NAME}`. `.env` files and the real environment take precedence over them. Variables may reference each other. An unresolved `${X}` inside a variable stays as text. `ENC(...)` variable values are decrypted and masked.

## Reference

```yaml
environment: default
baseUrl: https://app.test
browser: chromium              # chromium | firefox | webkit
headless: true
concurrency: 1                 # journeys in parallel
retries: 0
logLevel: info
timeouts: { step: 15000 }
journeysDir: journeys
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
  requireVerification: true

lenses: [a11y, security:warn, visual]   # after every step; ":warn" = record only

identity:
  sessionDir: .eztest/sessions
  sessionMaxAgeMinutes: 30
  secretStores:
    - { type: env, prefix: APP_ }                      # secret://env/X reads APP_X
    - { type: file, path: secrets.yaml }               # values may be ENC(...)
    - { type: azure-keyvault, vaultUrl: https://kv.vault.azure.net, ... }
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
  configurations: { chromium: "Windows + Chrome" }
  paths: [{ tag: payments, areaPath: Shop\Payments }]

vcs:                                     # docs/git.md
  branchScope: { history: true, baselines: true, defaultBranch: main }
  pullRequests: { onHealAccept: false, onBaselineApprove: false, onQuarantine: false }
  owners: { "@alice": alice@contoso.com }

readiness:
  policyPath: readiness-policy.yaml

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

messaging:                         # Kafka, RabbitMQ, MQTT, IBM MQ brokers (docs/messaging.md)
  brokers:
    bus: { type: kafka, brokers: [localhost:9092] }

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
  token: secret://env/EZTEST_SERVER_TOKEN
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
