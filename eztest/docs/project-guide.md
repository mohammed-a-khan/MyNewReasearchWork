# The EZTest Project Guide

This guide is the EZTest way of building a test automation project: where every file goes, what things are called, which style to write a test in, and the rules a suite follows so that it stays fast, deterministic and reviewable as it grows to thousands of journeys and several teams. It is written for test architects, leads and senior engineers who set up a project and review the work that goes into it.

The guide is not only advice. `eztest init --template enterprise` writes the layout with a working sample of every style, `eztest lint` enforces the rules (each finding links back to the section here that explains it), and the generated pipeline runs `eztest validate` and `eztest lint` before it runs a single journey.

```bash
npx eztest init --template enterprise            # the layout, samples, config layers, pipeline and npm scripts
npx eztest init --app billing                    # add another application to the project
npx eztest lint                                  # the rules below; --format junit|json|sarif|text for CI
```

- [The project layout](#the-project-layout)
- [Naming conventions](#naming-conventions)
- [Choosing a style](#choosing-a-style)
- [Rules](#rules)
- [Lint rules](#lint-rules)
- [Pull request review checklist](#pull-request-review-checklist)
- [Smells](#smells)
- [CI](#ci)
- [Migrating from an in-house Playwright or Cucumber framework](#migrating-from-an-in-house-playwright-or-cucumber-framework)

## The project layout

```
eztest.config.yaml              base config: shared settings, lint, pipelines, and one projects.<app> per application
config/<env>.yaml               dev / sit / uat, shared by every application: data folder, workers, retries, test plan
config/<app>/<env>.yaml         one application in one environment: host, database, accounts
.env.example                    the names of the secrets, never their values; the real .env is git-ignored
readiness-policy.yaml           the release gate: GO / GO_WITH_RISKS / NO_GO
pipelines/azure-pipelines.yml   validate + lint, PR smoke, nightly regression in shards, tests after deployment
package.json                    npm scripts: test, test:<env>, test:smoke, test:<module>, test:<app>, lint, validate, studio, report
tsconfig.json                   type checking for the TypeScript parts (tsc --noEmit)
apps/<app>/                     one folder per application under test
  journeys/<module>/*.ez          plain-English journeys
  features/<module>/*.feature     Gherkin, when the business owns the wording
  steps/*.steps.ts                step definitions for this application's features
  code/<module>/*.journey.ts      TypeScript journeys, for logic that is easier in code
  elements/<screen>.yaml          the element repository: one name per element, shared by all three styles
  screens/*.ts                    screen models: the same element ids, typed, for code journeys and steps
  helpers/*.ts                    API clients, database helpers, calculations
  data/<env>/*.csv|json|xlsx      test data per environment (data/common/ for data every environment shares)
  queries/<connection>/*.sql      named SQL, one query per file (the query catalogue)
shared/
  steps/*.steps.ts                step definitions every application's features use
  helpers/*.ts                    helpers and test data generators every application uses
  data/                           data every application uses
```

`eztest init --template enterprise` writes exactly this, for an application called `web` (`--app <name>` picks another name), with an `orders` module as the sample.

### Why it looks like this

- **One application, one project.** Each folder under `apps/` is a project overlay in `eztest.config.yaml` ([configuration.md](configuration.md#projects)): `projects.web` sets `journeysDir: apps/web`, `elements.dir: apps/web/elements`, `db.queries.dir: apps/web/queries`, `bdd.steps` (this application's step definitions plus `shared/steps/`), its roles and its own session folder (`identity.sessionDir: .eztest/sessions/web`, because a cached session is keyed by environment and role, and two applications may both have a `clerk`). `eztest run --project web` therefore sees only that application, and a step definition or element of one application can never bind to another's journey.
- **Two environment layers.** `-e sit` applies `config/sit.yaml` (what every application shares in SIT: the data folder, workers, retries, the Azure Test Plans plan) and then `config/web/sit.yaml` (this application's host, database and accounts), over the base file and the project. `.env`, `.env.sit`, `.env.web` and `.env.web.sit` come next, then `EZTEST_*` variables, then the command line. `eztest doctor --project web -e sit` shows the layers it used and the effective values; the Studio's Environments page shows the layer that set each value.
- **One folder for all of an application's test assets.** Journeys, features and code journeys live next to the element repository, data and queries they use. EZTest reads `.ez`, `.feature`, `*.journey.ts` and YAML/JSON journeys as journeys; YAML and JSON files without a `steps` key (element files, JSON data) are not journeys, so they can share the folder.
- **Modules are folders and tags.** `journeys/orders/`, `features/orders/` and `code/orders/` hold one business capability, and its journeys carry the `@orders` tag, so `npm run test:orders` (`-t @orders`) runs it in every style.
- **Queries are `.sql` files.** The catalogue is one `NAME.sql` per query with a `-- connection:` / `-- params:` header ([databases.md](databases.md#the-named-query-catalogue)); a folder per connection keeps a project with several databases readable.

### One application, or a flat layout

For a single application the same layout applies: `apps/web/` is the only application, and adding a second one later is `eztest init --app <name>`, which changes nothing that exists. A flat project (`journeys/`, `features/`, `elements/`, `queries/` at the root, EZTest's defaults, as `eztest init` writes it) works too and needs no `--project`; `eztest lint` checks the layout only in projects that have an `apps/` folder.

### What `--app` does

`eztest init --app billing` in an existing project writes `apps/billing/` and `config/billing/<env>.yaml`, adds `projects.billing` to `eztest.config.yaml` (comments and the rest of the file are kept), adds `test:billing`, `validate:billing` and `studio:billing` to `package.json`, and adds the application's secret names to `.env.example`. It never overwrites a file: every file that exists is reported as left unchanged, and the three shared files only get entries. Add the application to the `apps` parameter of `pipelines/azure-pipelines.yml`, with its secret variables.

## Naming conventions

| What | Convention | Example |
|---|---|---|
| Application folder, project | lower-case words with hyphens | `web`, `back-office` |
| Module folder and tag | the business capability, lower-case, the same in every style | `journeys/orders/`, `@orders` |
| Journey file | what the journey does, kebab-case | `place-order.ez`, `place-order.feature`, `order-from-api.journey.ts` |
| Journey id | `<app>-<module>-<behaviour>`, stable for life | `Id: web-orders-place-order`, `@id:web-orders-place-order-bdd`, `{ id: 'web-orders-order-from-api' }` |
| Suite tags | `@smoke` (every pull request), `@regression` (nightly and after deployment) | `Tags: @smoke @regression @orders` |
| Other tags | `@library` (sub-journeys only called by others), `@wip`, `@TestCaseId:<n>` (Azure Test Plans), `@req:<id>` / `@risk:<n>` / `@role:<role>` on scenarios | `@TestCaseId:4711` |
| Element | screen in PascalCase, element in camelCase; one file per screen | `elements/orders.yaml` with `screen: Orders` and `placeOrder:`, used as `@Orders.placeOrder` |
| Screen model | the screen's name, the element repository's ids | `export const Orders = screen('Orders', { placeOrder: ... })` |
| Journey variables | camelCase | `${orderNumber}`, `${reference}` |
| Config and environment variables | UPPER_SNAKE, prefixed with the application for its own | `DATA_ENV`, `WEB_BASE_URL`, `WEB_DB_FILE` |
| Secrets | `EZTEST_SECRET_<APP>_<ROLE>_<WHAT>`, read as `secret://env/<APP>_<ROLE>_<WHAT>` | `EZTEST_SECRET_WEB_CLERK_PASSWORD` |
| Roles | the business role, lower-case | `clerk`, `senior-adjuster` |
| Queries | UPPER_SNAKE, prefixed with the application | `queries/web_db/WEB_ORDER_BY_NUMBER.sql` |
| Database connections | `<app>_db`, or the system's name | `web_db`, `ledger` |
| Step text | the user's words, present tense, no screen mechanics; typed parameters | `When I place an order for {int} items for {string}`, not `When I click the "Place order" button` |
| Data files | the entity, plural; the first column a readable case name | `data/dev/orders.csv` with `case,customer,quantity,total` |

Ids, query names and secret names carry the application, so two applications never collide; `eztest lint` reports duplicate ids across all applications and styles.

### How journeys refer to elements, data and queries

```text
Type "<customer>" into the @Orders.customer field                                   # element repository
Examples: from data "apps/web/data/${DATA_ENV}/orders.csv"                          # data of the selected environment
Expect query "WEB_ORDER_BY_NUMBER" on web_db with order_number=${orderNumber} returns 1 row   # query catalogue
```

```ts
await ui.fill(Orders.customer, customer);                                    // screen model, same id as the repository
const rows = await data.rows('apps/web/data/' + vars.config('DATA_ENV', 'dev') + '/orders.csv');
const stored = await db.count('WEB_ORDER_BY_NUMBER', { order_number: orderNumber });
```

Data paths are relative to the project root. `DATA_ENV` is a config variable: the base config sets `dev`, `config/<env>.yaml` sets the environment, and `eztest run` and `eztest validate` both read it, so `-e sit` reads `data/sit/`.

## Choosing a style

All three styles run through the same runner: strict locating, verified healing, evidence, traces, reports, retries, quarantine, sharding and the readiness gate are identical. Choose by who reads the test and how much logic it needs.

| | `.ez` journey | Gherkin feature + step definitions | TypeScript code journey |
|---|---|---|---|
| Written and read by | testers, analysts, developers | the business owns the wording; engineers write the steps | engineers |
| Best for | UI, API and database flows; most of a suite | acceptance criteria agreed in Gherkin, living documentation | loops over query rows, branching on data, calculations, file round trips, migrated code |
| Glue code | none | one definition per phrase (EZTest phrasings need none) | it is code |
| Data-driven | `Examples:` (inline, file, query) | `Examples:` (inline, file, query) | `data.rows(...)`, loops |
| Reuse | `Run journey`, `Run code`, elements | steps, shared steps, elements through screens | functions, screens, `run('<journey id>')` |
| Review cost | lowest: one line per step | medium: feature plus definitions | highest |
| Default | **yes** | when the business asks for Gherkin | when `.ez` would need many `Run code` lines |

Start with `.ez`. Move a journey to TypeScript when it needs real logic, not to avoid learning the phrasings; call a TypeScript helper from `.ez` with `Run code "<file>#<export>"` when only one step needs code. Keep Gherkin for scenarios whose wording is agreed with the business; do not write features nobody outside the team reads.

### The same scenario in each style

These are the samples `eztest init --template enterprise` writes. Each places an order, checks the total on screen and finds the order in the database.

`apps/web/journeys/orders/place-order.ez`:

```text
Journey: Place an order
Id: web-orders-place-order
Tags: @smoke @regression @orders
Requirements: ORD-1
Risk: 4
Role: clerk
Examples: from data "apps/web/data/${DATA_ENV}/orders.csv"

Log in
Open /orders/new
Set variable reference to unique("PO-")
Type "<customer>" into the @Orders.customer field
Type "${reference}" into the @Orders.reference field
Fill the @Orders.quantity field with <quantity>
Click the @Orders.placeOrder button
  Expect the page contains "created"
Capture the text of @Orders.orderNumber as orderNumber
  Expect the @Orders.orderTotal text has text "<total>"
Expect query "WEB_ORDER_BY_NUMBER" on web_db with order_number=${orderNumber} returns 1 row
```

`apps/web/features/orders/place-order.feature` with `apps/web/steps/orders.steps.ts`:

```gherkin
@orders
Feature: Orders
  A clerk places orders for customers, and every order is stored.

  Background:
    Given the application is up
    And I am logged in as "clerk"

  @id:web-orders-place-order-bdd @smoke @regression @req:ORD-1 @risk:4
  Scenario: Place an order
    When I place an order for 2 items for "Contoso Ltd"
    Then the order total is "25.00"
    And the order is stored in the database
```

```ts
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
  const stored = await db.count('WEB_ORDER_BY_NUMBER', { order_number: String((world as OrdersWorld).orderNumber) });
  await expect(stored, 'orders stored with this number').toBe(1);
});
```

`Given the application is up` is a shared step (`shared/steps/common.steps.ts`); `I am logged in as "clerk"` is an EZTest phrasing and needs no definition.

`apps/web/code/orders/order-from-api.journey.ts`, which sets the order up through the API instead of the screens:

```ts
journey('Order created through the API shows its total', {
  id: 'web-orders-order-from-api', tags: ['@regression', '@orders'], requirements: ['ORD-2'], risk: 3, role: 'clerk',
}, async ({ ui, db, data, vars }) => {
  const [row] = await data.rows('apps/web/data/' + vars.config('DATA_ENV', 'dev') + '/orders.csv');
  const order = await step('Create the order through the API', () => createOrder({ customer: row.customer, quantity: Number(row.quantity) }));
  await ui.login();
  await ui.open('/orders/' + order.number);
  await expect.ui.text(Orders.orderNumber).toBe(order.number);
  await expect.ui.text(Orders.orderTotal).toBe(row.total);
  await expect(await db.count('WEB_ORDER_BY_NUMBER', { order_number: order.number }), 'orders stored with this number').toBe(1);
});
```

`Orders` is the screen model in `apps/web/screens/orders.ts`; its ids are those of `apps/web/elements/orders.yaml`, so the repository's locators come first and one accepted heal reaches all three styles.

## Rules

Each rule says what to do and why. Where `eztest lint` checks it, the rule id is given; the [lint rules](#lint-rules) table lists them all.

### No fixed waits

Never `Wait 2 seconds`, `waitForTimeout`, `sleep`. Every action already waits for its element to be visible, enabled, stable and not covered; wait for the signal you actually need: an `Expect` line under the action (polled until it holds), `Wait for the text "Saved"`, `Wait until the URL contains "/done"`, `Wait for the Orders table to appear`, `Wait until query ... returns 1 row within 30 seconds`, or loaders in `waits.loaders` / `Loaders:`. **Why:** a fixed wait always costs its full time, and is still too short on a slow day; it is the most common cause of both slow and flaky suites. Lint: `hard-wait`.

### One behaviour per journey

A journey tests one behaviour a user cares about, with the steps it needs and no more: "place an order", not "place, amend, cancel and invoice an order". Long flows across several behaviours belong in a few end-to-end journeys tagged as such. **Why:** a failure then names the behaviour that broke, a journey can be retried, quarantined or selected on its own, and its run time stays predictable for sharding and budgets. No lint rule can judge this; it is the first question of a review.

### Independent journeys

Every journey creates or leases its own data and cleans it up, and can run alone, in any order, on any worker. Set data up through the API or the database, take it from a data pool (`Take one item from pool "approvable-policies" as policy`), declare it (`Data: Customer as buyer where region=EU`, which finds or creates a record, leases it and removes what it created), or generate it (`unique("PO-")`). When one journey truly needs another's result, say so: `Depends on: web-orders-create with orderNumber` runs the prerequisite first, hands the value over, and skips the dependent with the reason when the prerequisite fails. For values the whole run shares, use a `Setup:` journey, whose `Returns:` are run-wide ([shared-data.md](shared-data.md)). **Why:** hidden order dependencies pass on one machine and fail on four workers, in shards or after a retry. Lint: `undeclared-dependency` (a journey that uses a value only another journey captures, without `Depends on:`).

### Test data per environment

Data lives in `apps/<app>/data/<env>/`, read through `${DATA_ENV}`: the same journey reads `data/dev/orders.csv` on dev and `data/sit/orders.csv` on SIT. Data every environment shares goes in `data/common/`. Values that must be unique (references, e-mail addresses, names of records the journey creates) are generated per run: `unique("PO-")`, `uniqueEmail()`, `gen:unique:PREFIX` in data entities, `uniqueValue()` from `@eztech.com/eztest/core` in code (`shared/helpers/unique.ts` in the template); they combine time, host, process, shard and a counter, so they never collide across workers or machines. `eztest validate` checks that every data file exists, parses, has the filtered columns and holds no `REPLACE_WITH_*` placeholders. **Why:** shared, hand-maintained values are the first thing to break when two runs overlap. Lint: `outside-layout` reports data files outside a per-environment folder.

### Secrets

Secrets never appear in a journey, a data file, a config file or `.env.example`:

- config values are `secret://env/NAME` (a secret store: the environment and `.env`, Azure Key Vault, HashiCorp Vault, AWS or GCP Secret Manager, CyberArk), `ENC(...)` (`eztest secret encrypt <value>`, decrypted with `EZTEST_MASTER_KEY`) or `${VAR}`;
- passwords belong to roles in the Identity Vault (`identity.roles.<role>.password: secret://env/WEB_CLERK_PASSWORD`), and journeys `Log in as clerk`;
- a recorded password becomes `${password}`, supplied with `--var`, `EZTEST_VAR_password` or `vars: { password: secret://env/... }`; a `${name}` nobody supplied fails the step before anything is typed;
- `.env.example` names the secrets with empty values; the real `.env` is git-ignored (`eztest init` adds `.env`, `.env.*` and `!.env.example` to `.gitignore`); pipelines provide them as secret variables with the same names.

Every resolved secret is masked in logs, reports and evidence. **Why:** test passwords in git end up in production more often than anyone admits, and a leaked test account still opens real systems. Lint: `plaintext-secret` (error) in journeys, code, CSV/TSV/XLSX/JSON data, YAML config layers and `.env.example`; the field names of a role's login form (`fields: { password: Passphrase }`) are not secrets.

### Locators

Name elements the way a user sees them: `the "Place order" button`, `the Quantity field`, `the "Edit" button in the row containing "Acme"`, or by a test id (`testid=place-order`) where the application has them. CSS and XPath are a last resort: never absolute (`/html/body/...`) or positional (`[3]`) XPath, never `\'` inside XPath (write `${var}`, EZTest quotes it safely). On a translated UI, give text-only targets a test id. **Why:** names, labels and test ids survive layout changes, are what healing verifies against, and read as the requirement; structural selectors break on the next redesign. Lint: `raw-selector` (a target found only by CSS or XPath), `absolute-xpath`, `positional-xpath`, `unsafe-xpath-quotes`, `text-only-locator`, `weak-locator` (info, with the locator's quality score).

### The element repository

An element used in more than one step gets one entry in `apps/<app>/elements/<screen>.yaml`, and every style uses that name: `@Orders.placeOrder` in `.ez`, the screen model `Orders.placeOrder` (same id) in step definitions and code journeys. An entry holds the locators, tried in order (`role=button[name="Place order"]`, then `testid=place-order`), a description and aliases ([elements.md](elements.md)). **Why:** when the application renames the button, one reviewed heal of one entry fixes every journey in every style; `eztest elements unused` lists unused entries and fails on references to unknown ones. Lint: `repeated-selector` (the same raw selector written in several steps).

### Assertions after every meaningful action

Every action that changes state, submits, signs in or navigates is followed by the outcome a user would check: an indented `Expect` line under it (a post-condition), or a check on the next line. API calls that change data check the status (`Expect the response status is 201`); database writes in setup are checked by reading back. Every journey ends with something checked. **Why:** an action without a check passes while the application is broken, and a healed step is accepted only when its post-conditions hold, so an unchecked click can never be healed safely. Lint: `missing-postcondition` (Save, Submit, Sign in, Search... clicks, link clicks, Enter in a field, non-GET API calls and INSERT/UPDATE/DELETE with nothing checked after them), `no-assertion` (a journey that checks nothing).

### Tags, ids, risk and requirements

Every journey has:

- an explicit, stable **id** (`Id:`, `@id:` on a scenario, `id:` in `journey()`), because history, flakiness, quarantine, heal memory and Azure DevOps test cases follow the id, and a default id changes when the file or the name changes;
- a **suite tag** (`@smoke` or `@regression`) and a **module tag** (`@orders`), which is how pipelines and npm scripts select it;
- `Risk:` (1 to 5; `@risk:` on scenarios, `risk` in code) for journeys that matter more or less than the default 3: the readiness policy blocks a release on any failed journey with risk 4 or 5, and `--budget` and `--risk` select by it;
- `Requirements:` (`@req:` on scenarios, `requirements` in code) for traceability: requirement coverage in reports, the `requirementsCovered` gate, and Azure DevOps links.

Lint: `missing-id`, `missing-tags`, `duplicate-id` (error, across all applications and styles).

### Log in once per role

Journeys sign in with `Log in as <role>` (or `Role:` and `Log in`, `ui.login()`, `Given I am logged in as "<role>"`), never by typing credentials. A role signs in once per run and environment; every later login, in any journey, worker or process, reuses the cached session after checking it is still valid, and parallel workers wait for the one that signs in. TOTP MFA, single sign-on gateways and Microsoft Entra ID are handled by the role's config ([configuration.md](configuration.md#roles-and-single-sign-on)). A journey that signs out, or changes the user's settings, gets a role of its own so it never ends a session other journeys share. **Why:** identity providers count logins, ask for MFA every time and lock accounts; one login per role keeps a large run fast and the accounts alive.

### Database checks

Check the database through the query catalogue: one reviewed `NAME.sql` per query, with its connection and parameters in the header, values always bound (never spliced), fragments for shared SQL. Journeys and code reference the name (`Expect query "WEB_ORDER_BY_NUMBER" ... returns 1 row`, `db.count('WEB_ORDER_BY_NUMBER', ...)`); `eztest validate` checks that every query exists, gets its parameters and has a configured connection, and `eztest queries check` prepares every query against the live database without executing writes. Point test connections at a read-only account where journeys only read, and grant writes only to the schemas setup needs: EZTest binds values and keeps the Studio's SQL console read-only by default, but it does not stop a journey's own `UPDATE`. **Why:** a catalogue makes SQL reviewable and reusable, and binding makes it safe with any data.

### API setup

Create preconditions through the API (or the database), not through the screens, and keep the UI for the behaviour under test: the code journey sample creates its order with `createOrder()` (`apps/<app>/helpers/orders-api.ts`) and checks it on screen. In `.ez`: `Call API "POST /api/orders" with body ... and store as order` with `Expect the response status is 201`. **Why:** API setup is ten to a hundred times faster and fails for one reason only; a journey that clicks through five screens to reach the one it tests fails for six.

### Parallel safety

Assume every journey runs next to others, on several workers (`-w 4`) and in shards on several machines. Use unique values, data pools and `Data:` leases for records; `Locks: account-<account>, ledger` for shared things journeys change (journeys holding a common key never run at the same time, across workers, processes and machines); `Setup:` journeys for run-wide preparation. **Why:** the suite only scales if adding workers never changes a result.

### Environments and hosts

Journeys use paths (`Open /orders`, `GET /api/orders`), never hosts: the host is `baseUrl` of the selected application and environment (`config/<app>/<env>.yaml`), and the pipeline can set it (`WEB_BASE_URL`). A second host is a variable from the environment layer (`${PARTNER_URL}`). Select the environment with `-e <env>` (or `EZTEST_ENV`), never by editing files. **Why:** the same journey must run on dev, SIT and UAT unchanged. Lint: `hardcoded-host` (absolute URLs in steps, `Base URL:` headers, feature steps and `ui.open()` / `api.*()` calls in code).

### Helpers or steps

- A **step definition** turns one business phrase into SDK calls and keeps no logic of its own beyond that; it lives in `apps/<app>/steps/`, or in `shared/steps/` when every application's features use the phrase.
- A **helper** holds what several steps or journeys need: API clients, calculations of expected values, data builders, database helpers. It lives in `apps/<app>/helpers/` or `shared/helpers/` and is imported by steps and code journeys, and called from `.ez` with `Run code`.
- A **screen model** holds element handles for code; the element repository holds the locators.

**Why:** step definitions stay one-liners a reviewer can read against the feature, and logic is tested once in a helper instead of copied into steps.

### BDD step definitions

Every Gherkin step binds to exactly one step definition, or is an EZTest phrasing (`I am logged in as "clerk"`, `the page contains "created"`). Write patterns with typed parameters (`{int}`, `{string}`, custom types), share state through the World, and keep each application's definitions in its own `steps/` folder; the project's `bdd.steps` per application keeps two applications' definitions of the same phrase from being ambiguous. `eztest validate` loads the definitions and binds every step (and prints a snippet for undefined ones); `eztest lint` checks the same statically, without running code. Lint: `undefined-step`, `ambiguous-step` (errors). A pattern built at run time is not seen by the static check; `eztest validate` is the authority.

### Studio and files

EZTest Studio (`npm run studio`) edits the same files: journeys, features, step definitions, code journeys, element files and data, with the same project and environment switchers. There is no Studio-only state to keep in sync, so use whichever is faster for the task (recording, debugging and heal review in the Studio; refactoring across files in an editor) and review the result as a normal diff. Heals accepted in the Studio's heal inbox change the element file or the journey, with a diff first.

### Quarantine, not deletion

A flaky journey goes on EZTest's quarantine list (`.eztest/quarantine.json`, committed, shared through the results server when there is one), with a reason, an owner and an expiry date; its failures then do not block the readiness decision while it is fixed. Never comment a journey out or delete its tag. Flakiness has a recorded cause per retry (overlay, timing, detached element, network, data); fix the cause.

## Lint rules

`eztest lint` checks journeys (`.ez`, YAML, JSON), Gherkin features, code (TypeScript, JavaScript, Java, Python, C#), test data (CSV, TSV, XLSX, JSON), the config layers and `.env.example`, reading code and step definitions as text (nothing is executed). Without paths it checks the journeys folder, the feature folders, and `shared/`, `config/`, `eztest.config.*` and `.env.example` when they exist. Every finding has a file, a line, the rule, a fix and this guide's section (`see:`).

| Rule | Default | Finds | Section |
|---|---|---|---|
| `hard-wait` | warning | `Wait 3 seconds`, `Pause for 500 ms`; `waitForTimeout`, `sleep(...)`, `Thread.sleep` in code | [No fixed waits](#no-fixed-waits) |
| `raw-selector` | warning | a target found only by CSS or XPath | [Locators](#locators) |
| `absolute-xpath` | warning | XPath from the document root | [Locators](#locators) |
| `positional-xpath` | warning | XPath with `[n]`, `position()`, `last()` | [Locators](#locators) |
| `text-only-locator` | warning | visible-text-only targets on a translated UI | [Locators](#locators) |
| `weak-locator` | info | a target whose best locator scores below 40 | [Locators](#locators) |
| `unsafe-xpath-quotes` | error | `\'` in XPath, values pasted inside XPath quotes in code | [Locators](#locators) |
| `repeated-selector` | warning | one raw selector (`css=`, `xpath=`, `testid=`) written in several steps | [The element repository](#the-element-repository) |
| `missing-postcondition` | warning | a state-changing, submitting, signing-in or navigating action with nothing checked after it | [Assertions](#assertions-after-every-meaningful-action) |
| `no-assertion` | warning | a journey that checks nothing (library, setup and manual journeys are exempt) | [Assertions](#assertions-after-every-meaningful-action) |
| `plaintext-secret` | error | passwords, tokens and keys in journeys, code, data, config layers and `.env.example` (values redacted) | [Secrets](#secrets) |
| `missing-id` | warning | a journey, scenario or code journey without an explicit id | [Tags, ids, risk and requirements](#tags-ids-risk-and-requirements) |
| `missing-tags` | warning | a journey without tags | [Tags, ids, risk and requirements](#tags-ids-risk-and-requirements) |
| `duplicate-id` | error | two journeys with one id, across applications and styles | [Tags, ids, risk and requirements](#tags-ids-risk-and-requirements) |
| `undefined-step` | error | a Gherkin step no definition matches and that is not an EZTest phrasing | [BDD step definitions](#bdd-step-definitions) |
| `ambiguous-step` | error | a Gherkin step several definitions match | [BDD step definitions](#bdd-step-definitions) |
| `undeclared-dependency` | warning | a journey using a value only another journey captures, without `Depends on:` | [Independent journeys](#independent-journeys) |
| `hardcoded-host` | warning | absolute URLs instead of `baseUrl` or a variable | [Environments and hosts](#environments-and-hosts) |
| `outside-layout` | warning | a test file outside the layout (projects with an `apps/` folder) | [The project layout](#the-project-layout) |
| `parse-error` | error | a file that does not parse | [Lint rules](#lint-rules) |

Configure the rules in `eztest.config.yaml`; `--rule` on the command line wins:

```yaml
lint:
  maxWarnings: 0              # warnings fail the build too (the enterprise template sets this)
  translatedUi: false         # true: report text-only locators everywhere
  rules:
    outside-layout: off       # a project that keeps its own layout
    missing-tags: error
    weak-locator: off
```

```bash
eztest lint                                    # text, exit 1 on errors or more warnings than lint.maxWarnings
eztest lint --format junit -o eztest-lint.xml  # a test case per file, for the CI's test view
eztest lint --format sarif -o lint.sarif       # code scanning
eztest lint --format json                      # scripting; findings carry rule, severity, file, line, message, suggestion, doc
eztest lint --project web --rule hard-wait=error apps/web/journeys/orders
```

`eztest validate` is the other half: it parses every journey, binds every Gherkin step by loading the real step definitions, and checks Examples sources and named queries against the selected project and environment. The pipeline runs both.

## Pull request review checklist

- [ ] The files are where the layout puts them, and named by the conventions (`eztest lint` is clean: no errors, no warnings).
- [ ] `eztest validate --project <app> -e dev` passes; new step definitions have no `pending()`.
- [ ] Each new journey tests one behaviour, has a stable id, a suite tag and a module tag, and `Risk:` / `Requirements:` where they apply.
- [ ] Every action that changes, submits or navigates has its expected outcome under it; the journey checks what the user and the system would see (screen, API, database).
- [ ] No fixed waits; no CSS or XPath where a name, label or test id works; anything used twice is an element.
- [ ] Data: per environment, unique where it must be, created or leased by the journey, cleaned up; no dependency on another journey without `Depends on:`.
- [ ] No secrets anywhere; logins are role logins; new secrets are named in `.env.example` and mapped in the pipeline.
- [ ] Database checks use the query catalogue; SQL is bound, not concatenated; writes are setup, not checks.
- [ ] Setup goes through the API where one exists.
- [ ] Logic lives in helpers; step definitions stay short; nothing is copied between applications that belongs in `shared/`.
- [ ] Heals accepted in this change were reviewed (the element file diff shows the new locator first).
- [ ] The journey passed on two workers locally (`npm run test:parallel`), not only alone.

## Smells

| Smell | Why it hurts | Lint rule |
|---|---|---|
| `Wait 3 seconds` before a check | slow every time, flaky on a slow day | `hard-wait` |
| `Click css=div.panel > div:nth-child(3) > button` | breaks on the next layout change | `raw-selector`, `positional-xpath`, `absolute-xpath`, `weak-locator` |
| The same `testid=` in twenty journeys | twenty fixes for one rename | `repeated-selector` |
| `Click the "Save" button` and nothing after it | passes while saving fails; cannot be healed safely | `missing-postcondition` |
| A journey of clicks with no `Expect` | proves only that the pages load | `no-assertion` |
| `Type "Summer#2026" into the Password field`, passwords in CSV or YAML | leaked accounts | `plaintext-secret` |
| A journey nobody can select | runs everywhere or nowhere | `missing-tags` |
| A file renamed, history and test case links lost | ids derived from names change | `missing-id` |
| Two journeys with one id | results and history mixed up | `duplicate-id` |
| A feature step that only fails at run time | undefined or ambiguous steps | `undefined-step`, `ambiguous-step` |
| Journey B reads `${orderNumber}` that journey A captured | passes in order, fails in parallel and in shards | `undeclared-dependency` |
| `Open https://web.sit.example.test/orders` | cannot run on another environment | `hardcoded-host` |
| `tests/new/stuff/x.ez` | nobody finds it, no project selects it | `outside-layout` |
| A login typed out in every journey | slow, MFA prompts, locked accounts | (review: use `Log in as <role>`) |
| A 200-step journey | one failure hides the rest; no behaviour named | (review: one behaviour per journey) |
| UI clicks to create test data | slow, fragile setup | (review: API setup) |

## CI

The template's pipeline (`pipelines/azure-pipelines.yml`, Azure DevOps) runs these stages, for every application in its `apps` parameter. For other systems, `eztest init --ci github|gitlab|jenkins|teamcity|bitbucket|circleci` writes a PR smoke job, a sharded nightly regression and a job per deployment ([pipelines.md](pipelines.md)); add `--project <app>` to their runs and the Checks stage's validate and lint steps in front.

1. **Checks**, on every run: `eztest validate --project <app> -e dev`, `eztest elements unused --project <app> -e dev` (unknown element references fail), and `eztest lint --format junit` with the results in the Tests tab. Nothing runs before these pass.
2. **Smoke**, on pull requests: `eztest run --project <app> --pipeline pr --headless`. The `pr` entry of `pipelines:` selects `@smoke`, uses `dev`, and fits a 10-minute budget; the readiness gate fails the job on NO_GO and `eztest pr report` sets the pull request's status and comment.
3. **Regression**, on the nightly schedule: `--pipeline nightly` selects `@regression and not @quarantined` on SIT in two parallel jobs; each job runs its shard (shards are balanced by historical duration), `eztest merge` makes one run with one verified evidence chain, `eztest gate` decides, and `eztest ado publish` publishes the results to Azure Test Plans when `EZTEST_PUBLISH_TEST_PLANS` is `true` (with the build's own token; the plan and suite come from `config/<env>.yaml`).
4. **TestSIT**, on main after the SIT deployment: a deployment job in the `sit` environment runs `--pipeline deploy-sit` with the readiness gate, so a NO_GO stops the release, and keeps a deployment record (on the results server and in Azure DevOps, when configured).

Secrets come from pipeline secret variables (or a variable group linked to Key Vault) with the names in `.env.example`, mapped into the steps that run journeys. More shards: raise `pipelines.nightly.shards` and the job's `parallel` together. More browsers: `browsers: [chromium, firefox]` in a pipeline entry. The readiness policy (`readiness-policy.yaml`) decides GO, GO_WITH_RISKS or NO_GO with cited reasons; a gate whose input is missing reports `no-data`, never a pass.

## Migrating from an in-house Playwright or Cucumber framework

In-house frameworks built on Playwright or Cucumber usually have the same parts under other names: page objects, a locator file, step definitions, a data reader, a database utility, environment property files, a login helper and a pipeline. Map them onto the layout and move one module at a time:

| In the in-house framework | In the EZTest project |
|---|---|
| Page objects | element files (`elements/<screen>.yaml`) for the locators, screen models (`screens/*.ts`) for code; `eztest elements import-screens` turns literal `screen()` entries into element files |
| Locator properties or JSON files | element files |
| Cucumber features and step definitions | keep them: native BDD runs `.feature` files with TypeScript step definitions; many steps become EZTest phrasings and need no definition |
| Playwright or Selenium test classes | `eztest import <files> --verify` writes `.ez` journeys and replays them; what does not convert becomes a TODO line with the reason, never silently dropped |
| Utility classes, data builders | `helpers/` and `shared/helpers/`, called from code and from `.ez` with `Run code` |
| Excel / CSV readers | `Examples: from data "..."`, `data.rows(...)` |
| SQL strings in code | the query catalogue (`queries/<connection>/*.sql`) |
| `env.properties`, `config-sit.json` | `config/<env>.yaml` and `config/<app>/<env>.yaml` |
| Passwords in property files | `.env` (git-ignored), `secret://` stores, roles in the Identity Vault |
| A login method called by every test | `Log in as <role>`, once per run per role |
| Retry analyzers, custom waits | EZTest's own waiting, retries with a recorded cause, and quarantine |
| Private step dialects | an importer plugin (`eztest import --from <name>`, [plugins.md](plugins.md#importer-plugins)) |

Order of work: scaffold with `eztest init --template enterprise --app <app>`, move config and secrets first (so `eztest doctor` is green), then elements, then one module's tests (import or keep the features), then run `eztest lint` and fix what it reports, then switch that module's pipeline job. Run the old and the new suite side by side for one release, compare results, and retire the old module.
