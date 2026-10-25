# Native BDD: Gherkin features and step definitions (`@eztech.com/eztest/bdd`)

EZTest runs Gherkin `.feature` files as they are. Teams keep their features and
write step definitions in TypeScript. Steps with no definition can still run when
their text is an EZTest plain-English phrasing, so a feature can need no glue code at
all, or mix EZTest phrasings with the team's own definitions.

Everything here is EZTest's own code: the Gherkin parser, the step expressions, the
tag expressions, the hooks and the runner integration. No other BDD or testing
package is used.

```gherkin
# features/orders/ordering.feature
@shop
Feature: Ordering
  Background:
    Given I am on "/login"
    When I type "bob" into the "Username" field
    And I type "Builder#2" into the "Password" field
    And I click the "Sign in" button

  @smoke @req:ORD-1
  Scenario: Place an order
    When I order 3 "Gadget (49.50)" for "Contoso Ltd"
    Then the page contains "created"
    And the database has 1 order for "Contoso Ltd"
```

```ts
// steps/orders.steps.ts
import { Given, When, Then } from '@eztech.com/eztest/bdd';

When('I order {int} {string} for {string}', async ({ ui, world }, qty, product, customer) => {
  await ui.open('/orders/new');
  await ui.select({ label: 'Customer' }, customer);
  await ui.select({ label: 'Product' }, product);
  await ui.fill({ label: 'Quantity' }, String(qty));
  await ui.click({ role: 'button', name: 'Submit order' }, { expect: { text: 'created' } });
  world.order = await ui.text('testid=order-number');
});

Then('the database has {int} order(s) for {string}', async ({ db, expect }, n, customer) => {
  const count = await db.on('shop').sqlValue`SELECT COUNT(*) FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.name = ${customer}`;
  await expect(Number(count), `orders for ${customer}`).toBe(n);
});
```

```bash
eztest run features/                          # every feature
eztest run --tags "@smoke and not @wip"       # tag expressions
eztest run features/orders/ordering.feature   # one file
eztest validate features/                     # bind every step without running; undefined steps print a snippet
```

The Background's four steps and `Then the page contains "created"` have no
definition: they run as EZTest steps. The other two run the definitions.

## Running features

- **Where features are.** `eztest run` with no paths runs `journeysDir`, then the feature folders:
  `bddDir` or `bdd.features` from the config, or `features/` when it exists. Paths given on the
  command line (`eztest run features/checkout`) can mix `.feature`, `.ez`, YAML, JSON and code
  journeys.
- **One journey per scenario.** Each scenario, and each Examples row of an outline, is one journey
  result. So each one gets everything a journey gets: verified healing, evidence and the hash chain,
  traces, the HTML, JSON and JUnit reports, readiness, flaky detection, history, sharding
  (`--shard`), retries, quarantine, burn-in, Azure DevOps publishing and Studio results.
- **Journey ids** are `<feature path>--<scenario>`: the feature's path without a leading
  `features/` folder, then the scenario name, both slugified (`orders-ordering--place-an-order`).
  Outline rows add `-1`, `-2` and so on. `@id:my-id` on a scenario sets the id.
- **Tags** are inherited from Feature, Rule, Scenario and Examples. A few tags also fill journey
  fields: `@req:ORD-1` (or `@requirement:`) adds a requirement for traceability and readiness,
  `@risk:5` sets the risk, and `@role:manager` sets the Identity Vault role. `@TestCaseId:123`
  links a scenario to an Azure DevOps test case, as for any journey (custom test-id tags such as
  `@TC-VISIT_1` map to test cases with `ado.testCaseTag`, see [azure-devops.md](azure-devops.md#publish-results)).
  `@actors:desk=receptionist,doc=vet` and `@depends-on:<journey-id> with visitId` are described below.
  Scenarios tagged with one of `run.excludeTags` (for example `["@skip"]`) are left out unless `--tags`
  names that tag.
- **Native apps and browsers.** `@platform:android` (or `ios`) with `@app:com.shop.app` runs the
  scenario on the mobile driver ([mobile.md](mobile.md)): EZTest phrasings and the `ui.*` calls of
  step definitions become native steps on the device. `@capability:serial=R58M123` sets a
  capability, and `@browser:firefox` (one tag per browser) limits the browsers of a cross-browser run.
- **Scenarios as sub-journeys.** `Run journey "orders-ordering--place-an-order"` in an `.ez` journey
  (or `run('...')` in code) runs a scenario with its definitions, phrasings and hooks.
- **Step results map one to one to Gherkin steps.** A scenario's results are its Background steps,
  then its own steps, each with the Gherkin text as the step name (`When I order 3 ...`) and its
  line (`L15`). Before and After hooks are results of their own, marked as hooks; an After hook
  that passed without making an SDK call or an attachment is not listed. A step's
  definition calls (`ui.click`, `api.post`, `expect`) are its children. After a failed step the
  remaining steps are skipped, and After hooks still run.

### Tag expressions

`--tags` (`-t`) takes a tag expression, EZTest's own implementation:

| Expression | Runs |
|---|---|
| `@smoke` | scenarios tagged `@smoke` |
| `@smoke and not @wip` | smoke scenarios that are not work in progress |
| `(@orders or @billing) and not @slow` | parentheses group; `not` binds tightest, then `and`, then `or` |
| `@smoke,@regression` | a comma list still means "any of these" |

Tags match without the `@` and without case. Inside a tag, `\(`, `\)`, `\ ` and `\\` escape those
characters. The same expressions work for `.ez`, YAML, JSON and code journeys. They also filter
hooks (`Before('@db and not @readonly', ...)`).

## Configuration

```yaml
# eztest.config.yaml
bddDir: features                  # shorthand for bdd.features: [features]
bdd:
  features: [features, specs]     # several folders (optional)
  steps:                          # step definition files (globs); the default is below
    - "steps/**/*.steps.ts"
    - "features/**/step_definitions/**/*.ts"
  fallback: true                  # run EZTest phrasings for steps without a definition (default true)
  resolveArguments: true          # interpolate definition arguments, cells and doc strings (default true)
  language: en                    # language of files without "# language:" (default en)
  worldParameters:                # passed to every World as `parameters`
    tenant: acme
```

Without `bdd.steps`, step definitions are every `*.steps.ts` (`.mts`, `.js`, `.mjs`) file in the
project and every file under a `step_definitions/` or `step-definitions/` folder.
`node_modules`, `dist` and dot folders are skipped. Step files are TypeScript modules, loaded the
same way as code journeys (see [sdk.md](sdk.md#how-typescript-is-loaded-and-why-there-is-no-eval)):
esbuild when it is available, then tsx, then Node type stripping. They are imported when a scenario
runs or is validated, never when journeys are listed.

## Step definitions

```ts
import { Given, When, Then, Step, defineParameterType, type DataTable } from '@eztech.com/eztest/bdd';

Given('the customer {string} has {int} orders', async ({ ui, api, db, vars, data, world }, name, n) => { /* ... */ });
When(/^I pay (\d+) (EUR|USD)$/, async ({ api }, amount, currency) => { /* amount is a number (see below), currency a string */ });
Then('the totals are:', async ({ expect }, table: DataTable) => { /* the data table is the last argument */ });
When('I send this request:', async ({ api }, body: string) => { /* so is the doc string */ });
Step('any keyword', async () => {});
Given('a slow step', { timeout: 30_000 }, async () => {});
Then('the lab result is in', { retry: { attempts: 5, every: 2000 } }, async ({ api, expect }) => { /* tried again until it passes */ });
```

- **`retry`** runs the definition again when it fails: up to `attempts` tries in all (default 3),
  `every` ms apart (default 1000). The report keeps the last try's calls; each earlier failure is a
  warning on the step ("attempt 1 of 5 failed: ..."), and `captured.attempts` says how many it took.

- **The first argument** is a context with the whole SDK (`ui`, `api`, `db`, `data`, `files`,
  `dates`, `identity`, `vars`, `log`, `expect`, `step`, `run`, `soft`, `actors`, `cleanup`, `poll`;
  see [sdk.md](sdk.md)), plus:
  - `world`: the scenario's World;
  - `scenario`: name, tags, feature, rule, file, line and the Examples row;
  - `gherkinStep`: keyword, text and line;
  - `dataTable` and `docString` (`{ content, mediaType }`);
  - `attach(name, content)`: adds text or bytes to the evidence.
- **`this`** is the World too, for `function () {}` definitions.
- **The remaining arguments** are the parameters, then the data table (a `DataTable`) or the doc
  string (its text).
- **Keywords do not matter for matching.** `Given`, `When`, `Then` and `Step` all register into one
  list, as Gherkin intends. `And`, `But` and `*` take the meaning of the step before them.
- **Every SDK call is a runner step.** It is located strictly, healed and verified by
  post-conditions, and gets evidence, a trace entry and a debugger stop, exactly like in code
  journeys.

### Expressions

| Syntax | Matches | Argument |
|---|---|---|
| `{int}` | `42`, `-3` | number |
| `{float}` | `49.50`, `.5`, `3` | number |
| `{string}` | `"double"` or `'single'` quoted text (`\"` escapes) | the text without quotes |
| `{word}` | text without whitespace | string |
| `{}` | anything | string |
| `{double}`, `{long}`, `{short}`, `{byte}` | numbers | number |
| `{bigint}`, `{biginteger}` | whole numbers | bigint |
| `{bigdecimal}` | decimals | the digits as a string |
| `order(s)` | `order` or `orders` (optional text) | |
| `card/cash/cheque` | one of the words (alternatives, per word) | |
| `\(`, `\)`, `\{`, `\}`, `\/`, `\\` | the character itself | |

A bad expression (an unknown `{type}`, an unclosed `(`) fails the scenarios that load it, with
the column of the problem.

### Custom parameter types

```ts
defineParameterType({ name: 'money', regexp: /\d+\.\d\d/, transformer: (s) => Number(s) });
defineParameterType({
  name: 'customer',
  regexp: [/the customer "([^"]+)"/, /customer #(\d+)/],
  transformer: async function (nameOrId) { return lookUp(nameOrId); },   // `this` is the World; may be async
});

Then('the quote total is {money}', async ({ expect, world }, total: number) => { /* ... */ });
```

The transformer receives the regexp's capture groups, or the whole match when it has none.
Patterns may use a type defined later in the same file.

### Regular expressions

The top-level capture groups of a regex definition are its arguments (groups nested inside them,
and `(?:...)` groups, are not). Each one is converted:

- a **named group** whose name is a parameter type is converted with that type:
  `(?<int>\d+)`, `(?<float>[\d.]+)`, `"(?<string>[^"]*)"`, `(?<money>\S+)` (a custom type; its own
  regexp then gives the transformer its groups);
- an **unnamed group** whose pattern is a type's own pattern is converted with that type: `(\d+)` and
  `(-?\d+)` are `{int}`, the `{float}` and `{string}` patterns convert too, and so does a custom type's
  regexp (`(red|blue)` for a type defined with `/red|blue/`);
- every other group arrives as a string, or `undefined` when it took no part in the match.

```ts
When(/^I pay (?<money>\S+) for (\d+) (?<color>\w+) items$/, async (ctx, price, count, color) => { /* typed */ });
```

### Undefined and ambiguous steps

A step that no definition matches and that is not an EZTest phrasing fails as **undefined**. Its
result carries a snippet to paste, which `eztest validate` and the Studio show too:

```ts
When('I do something nobody defined with {string} and {int}', async ({ ui, api, db, world }, string, int) => {
  // Turn the phrase above into ui / api / db calls.
  throw new Error('pending');
});
```

A step that two or more definitions match fails as **ambiguous**, and the error lists each
pattern with its `file:line`. `pending()` (exported) marks a definition as not done yet: the step
fails as pending.

## Values in steps: variables, expressions and secrets

Before a step definition runs, EZTest resolves its captured arguments, every data table cell and the
doc string the same way it resolves its own phrasings:

| Written | Becomes |
|---|---|
| `${petId}`, `${visit.pet_id}`, `${rows.0.name}` | a journey, run or config variable; dotted paths read into objects and lists |
| `${city:-Lyon}` | the variable, or `Lyon` when nothing sets it |
| `$${petId}` | the literal text `${petId}` |
| `${unique('VIS-')}`, `${uuid()}`, `${format(addBusinessDays(today(), 2), "MM/DD/YYYY")}` | an inline expression (see below) |
| `secret://vault/VET_PIN`, `ENC(v1:...)` (a whole value) | the secret, resolved when the step runs and masked in every result |

A `${name}` that nothing sets fails the step with `MISSING_VARIABLE` before the definition runs, so a
definition never receives a placeholder as if it were data. `bdd.resolveArguments: false` hands the text
over as written.

**Fetch, then reference.** A Background (or an earlier step) fetches a value; an Examples row refers to
it; the definition gets the value:

```gherkin
Background:
  Given I get the value of query "OWNER_NAME" on clinic with owner_id=1 as dbOwnerName

Scenario Outline: Book a visit for <ownerName>
  When the owner "<ownerName>" books "<reason>"

  Examples:
    | ownerName      | reason   |
    | ${dbOwnerName} | check-up |
```

`<ownerName>` becomes `${dbOwnerName}` in the step text, and the definition receives `Mira Okafor`.
`eztest validate` warns when a row refers to a variable that no earlier step sets (an EZTest phrasing
that captures it `as dbOwnerName`, or a definition that calls `vars.set('dbOwnerName', ...)`).

**Inline expressions.** A `${...}` holding a call is evaluated by EZTest's safe expression evaluator (the
functions of [ez-language.md](ez-language.md#variables-and-expressions), never JavaScript). Each distinct
expression is evaluated once per scenario attempt: `${unique('VIS-')}` is the same visit reference in every
step of the scenario, and a retry gets a new one. The values are kept in the attempt's ledger under
`$expressions`, and on the result of the step that first used them. They work in step text, cells, doc
strings, Examples values and in EZTest phrasings (`Type "${unique('VIS-')}" into the "Reference" field`).
Inside a `{string}` argument, quote the expression's own text with single quotes.

## Several users in one scenario

Tag a scenario (or a feature) with its actors, then say who acts:

```gherkin
@actors:desk=receptionist,doc=vet
Scenario: The front desk books, the vet confirms
  Given I act as "desk"
  And I am on "/visits/new"
  When I continue as "doc"
  And I am on "/visits"
  Then the page contains "Biscuit"
```

- `@actors:name=role,...` declares the actors and their Identity Vault roles (a name without `=role` is a
  plain web user). Each actor has its own browser context and session, as in
  [multi-actor.md](multi-actor.md); the first one is the primary actor.
- `I act as "desk"`, `I continue as "doc"` and `I switch to user "doc"` make the following steps run as
  that actor. An actor with a role signs in when it first acts (a `Log in as` step under the switch).
- Every step result says which actor it ran as. In a definition, `ctx.actors.doc.ui.click(...)` and
  `ctx.actors.desk.expect.ui.page().toContainText(...)` act as a named actor.

`Log in as <role>` (and `I am logged in as "<role>"`) in a context that is already signed in as another
role first clears that context's cookies and local and session storage, then signs in. The step's
`captured` says who was signed out and who signed in.

## Depending on another feature

```gherkin
@depends-on:visits--book-a-visit with visitId
Feature: Follow-up visits
  Scenario: The vet closes the visit
    Then the visit "${visitId}" is in the database
```

`@depends-on:<journey-id> with value, ...` (on a feature, a rule or a scenario) is the `Depends on:`
handoff of `.ez` journeys ([reliability.md](reliability.md#dependencies-depends-on)): the prerequisite
runs first, the named ledger values are handed over, and the scenario is skipped with the reason when the
prerequisite did not pass. The `with ...` list is part of the tag (an EZTest extension; other Gherkin
tools read `with` as an error).

When the value usually comes from another pipeline stage, the shared store can fall back to the
database:

```gherkin
Given I load "open-visit" from the shared store as visitId or run query "ANY_OPEN_VISIT" on clinic as visit
```

When the store has no `open-visit` (or it expired), the query runs: `visit` is its first row and
`visitId` its first column ([shared-data.md](shared-data.md)).

## Cleanup

What a scenario creates, it can undo. Definitions register actions on `ctx.cleanup`; they run in reverse
order after the scenario (after the After hooks), also when it failed, each as a cleanup step of the
result:

```ts
When('the desk books visit {string} for {string}', async ({ db, cleanup }, id: string, pet: string) => {
  await db.execute('INSERT_VISIT', { visit_id: id, pet_id: pet, reason: 'check-up' });
  await cleanup.query('DELETE_VISIT', { visit_id: id }, { connection: 'clinic' });
});
```

`cleanup.add(description, fn)`, `cleanup.query(NAME, binds, { connection })` and
`cleanup.snapshot(NAME, binds, { restore: RESTORE_NAME })` are described in [sdk.md](sdk.md#cleanup).
The EZTest phrasings `On cleanup run query "DELETE_VISIT" on clinic with visit_id=${visitId}` and
`Snapshot query "PET_ROW" on clinic with pet_id=${petId} and restore it with "RESTORE_PET" after the journey`
work as steps too.

## The World

Each scenario attempt gets a new World. Steps share state through it, and a retry starts clean.
By default the World is a plain object. `setWorldConstructor(MyWorld)` replaces it: the class is
created with `{ parameters }`, the `bdd.worldParameters` from the config.

```ts
import { setWorldConstructor } from '@eztech.com/eztest/bdd';
class ShopWorld {
  order?: string;
  constructor(readonly options: { parameters: Record<string, unknown> }) {}
}
setWorldConstructor(ShopWorld);
```

Journey variables are also available, through `vars` (`vars.set('order', n)`, `vars.get('order')`),
and they show up in the result's ledger.

## Hooks

```ts
import { Before, After, BeforeStep, AfterStep, BeforeAll, AfterAll } from '@eztech.com/eztest/bdd';

BeforeAll({ tags: '@api', name: 'get a token' }, async ({ api, shared }) => {
  shared.token = (await api.post('/oauth/token', { grant_type: 'client_credentials' })).body.access_token;
});
AfterAll(async ({ db, shared }) => { /* clean up what the run created */ });

Before(async ({ db }) => { /* every scenario */ });
Before('@db and not @readonly', async ({ db }) => { /* tag-filtered */ });
Before({ tags: '@api', name: 'get a token', order: 10 }, async ({ api, world }) => { /* ... */ });
After(async ({ result, attach, ui }) => { if (result?.status === 'failed') await attach('note.txt', 'details'); });
BeforeStep('@trace', async ({ gherkinStep, log }) => log.info(`> ${gherkinStep?.text}`));
AfterStep(async ({ result }) => { /* result of the step */ });
```

- **Order.** Before hooks run in `order` (lower first, default 1000), then registration order.
  After hooks run in the reverse order. BeforeStep and AfterStep run around every step of the
  scenarios they match.
- **Failures.** A failed Before hook skips the scenario's steps. After hooks always run, also when
  a step failed, and get `result` (`status`, `error`). A failed After hook fails the scenario.
- **Reporting.** Before and After hooks are results of their own (`Before hook: get a token
  (steps/hooks.steps.ts:12)`), so their SDK calls have evidence and traces too. An After hook that
  passed without an SDK call or an `attach()` did nothing to report and is not listed; one that
  fails or attaches something is. `attach()` evidence belongs to the step or hook that made it.
  BeforeStep and AfterStep calls are children of the step they surround.

### BeforeAll and AfterAll

- **Scope: once per run.** A run is one `eztest run`, one Studio run or one debug session. Every
  `--workers` slot shares it. With `--shard i/n` each shard is a run of its own (on its own machine),
  so each shard runs the hook once. Shards are not coordinated with each other: for setup that must
  happen once across shards, use a CI step before the shards, or the config `hooks.beforeAll`
  journeys in a pipeline stage of their own.
- **When.** Before the scenarios start, each BeforeAll that applies to at least one scenario of the
  run (by its tag expression) runs as a hook journey of its own, `BeforeAll hook: get a token
  (steps/hooks.steps.ts:3)`, tagged `hook`, `beforeAll` and `bdd`. It has a browser context and the
  whole SDK (`ui`, `api`, `db` ...), evidence and a trace. After the scenarios, each AfterAll that
  applies to a scenario that ran runs the same way.
- **Values for the World.** What a BeforeAll sets on `ctx.shared` (or returns as an object) is
  copied into the World of every scenario the hook applies to (`world.token`). AfterAll gets the
  `shared` values of every BeforeAll.
- **Failures.** A failed BeforeAll fails the scenarios it applies to without running them (their
  first result says which hook failed and why). Other scenarios run. A failed AfterAll is a failed
  result of the run.
- **Without the run's preparation.** A scenario run as a sub-journey of another journey
  (`Run journey`) runs a BeforeAll it needs itself, once per run, inside its own result. AfterAll
  hooks run only in runs that ran scenarios themselves.

## The plain-English fallback

When no definition matches, EZTest reads the step text with its own grammar (see
[ez-language.md](ez-language.md)). The keyword and a leading `I`, `we` or `the user` are dropped.
`Then` steps are read as expectations first.

| Gherkin step | Runs as |
|---|---|
| `When I click the "Save" button` | `Click the "Save" button` |
| `Then the page contains "Saved"` | `Expect the page contains "Saved"` |
| `Given I am on "/login"` (or `I am on the "/login" page`) | `Open "/login"` |
| `Given I am logged in as "manager"` | `Log in as "manager"` (Identity Vault) |
| `Then I should be on "/dashboard"` | `Expect the URL contains "/dashboard"` |
| `When I type "bob" into the "Username" field` | `Type "bob" into the "Username" field` |
| `Then the "Recent orders" table is visible` | `Expect the "Recent orders" table is visible` |
| `Then the page contains:` plus a one-line doc string | the doc string as quoted text |
| `When I fill in the form:` plus a two-column table | one `Type "<value>" into the "<field>" field` per row (a `field \| value` header row is skipped) |

The step runs as that EZTest step, with the Gherkin text as its name: strict locating, verified
healing and evidence included. Its heals are listed in the heal proposals, the reports and the
Studio's Quality > Heal review, also when the step ran inside a group (with step hooks, or a form
table). Accepting one writes the healed locator to the feature's sidecar,
`<file>.feature.locators.json`, and leaves the `.feature` text unchanged; every scenario and Examples
row that runs that line uses the accepted locator first. A heal of a locator written inside a step
definition (or a code journey) is listed too, and the review says which line of code to change.
A healed click is accepted only when the step itself checks the outcome: `When I click ...` has no
post-condition of its own, so a heal of it is not verified (the next `Then` step is a step of its
own); check outcomes in a definition (`ui.click(t, { expect })`) where healing a click matters. Nothing is guessed. Domain steps such as `Given the customer
"Acme" has 3 orders` are never read as EZTest steps: they need a definition. Definitions always
win over the fallback. Set `bdd.fallback: false` to require a definition for every step.

## Data tables, doc strings and outlines

- **Data tables** come to the definition as a `DataTable`:
  - `raw()`: every row;
  - `rows()`: the rows after the header;
  - `hashes()`: one object per row, keyed by the header;
  - `rowsHash()`: a two-column table as key -> value;
  - `transpose()`.
- **Doc strings** (`"""` or three backticks, optionally with a media type such as `"""json`) come
  as their text. The context's `docString` also has the `mediaType`.
- **Scenario Outlines** (or Scenario Templates) run once per Examples row. `<placeholders>` are
  replaced in the scenario name, the step text, doc strings and tables. Several Examples blocks
  may each have their own tags and name; `--tags` selects rows by them. The row's values are also
  journey variables (`${qty}` in an EZTest phrasing, `vars.get('qty')`).

### External Examples (EZTest extension)

An Examples block can read its rows from EZTest's data sources instead of a table:

```gherkin
Scenario Outline: Quote <sku> x <qty>
  When I request a quote for <qty> of "<sku>"
  Then the quote total is <total>

  @csv
  Examples: from data "data/quotes.csv" where qty > 1
  Examples: from data "data/quotes.xlsx" sheet "Quotes"
  Examples: from data "data/rows.json" path "$.quotes"
  Examples: from query "OPEN_QUOTES" on shop with region="EU"
```

The rows are read when the run starts: CSV, TSV, XLSX (with a sheet), JSON (with an optional
JSONPath) or a named query from the `db.queries` catalogue. They are filtered with the same
`where` language as `.ez` Examples (`=`, `!=`, `>`, `<`, `>=`, `<=`, `~`, `^=` starts with, `$=` ends
with, `in (a, b)`, `and`, `or`, `not`, parentheses). Each row is one journey (`<id>-<first value>`). A
source that matches no rows is reported as skipped with the reason. `eztest validate` checks the file,
the filter and the columns. This line is not standard Gherkin: other Gherkin tools read it as an
Examples block named `from data ...` without a table.

Two more clauses come after the filter:

```gherkin
Examples: from data "data/visits.csv" where species in (cat, dog) with ref = unique("VIS-"), due = addDays(today(), 14)
Examples: from data "data/treatments.csv" resolve with query "FIND_PET_FOR_STATE" on clinic with state=<requiredState> as pet when dataMode = live
Examples: from data "data/treatments.csv" resolve with query "FIND_PET_FOR_STATE" on clinic with state=<requiredState> as pet or keep row values
```

- **Derived columns** (`with name = expression, ...`): each row gets these columns; they are inline
  expressions, evaluated once per attempt with the row's values as variables (`<ref>` and `${ref}` are the
  same value in every step).
- **Live data per row** (`resolve with query ... as pet`): for each row matching `when` (every row without
  it; the condition reads the row and the run variables), the named query runs with the binds (`<column>`
  is the row's value, `${var}` a variable) and its first row joins the row as `pet.<column>`
  (`<pet.name>` in steps, `${pet.name}` in values). A query that finds nothing makes that row a test-data
  problem: the journey is an error named `DataPrecondition` ("no test data: query FIND_PET_FOR_STATE on
  clinic with state=discharged returned no row for pet"), classified as data, not as a product failure.
  With `or keep row values` the row runs with its own values instead.

## Gherkin coverage

EZTest's parser follows the Gherkin reference:

- **Blocks.**
  - `Feature` with tags and a description.
  - `Rule` with tags, a description and its own `Background`.
  - `Background`: one per Feature and per Rule, before the scenarios.
  - `Scenario` / `Example`.
  - `Scenario Outline` / `Scenario Template` with any number of `Examples` / `Scenarios` blocks,
    each with tags, a name and a description. A plain `Scenario` with Examples is an outline too.
- **Steps.** `Given`, `When`, `Then`, `And`, `But` and `*`, each with a doc string (`"""` or three
  backticks, a media type, `\"\"\"` escapes, indentation removed) or a data table (`\|`, `\\` and
  `\n` escapes; rows must have the same number of cells).
- **Other lines.**
  - Tags on Feature, Rule, Scenario and Examples, with comments after them.
  - `#` comment lines anywhere.
  - Free-text descriptions.
  - A BOM and CRLF line ends.
- **Languages.** `# language: <code>` with English (`en`), German (`de`), French (`fr`, keywords
  such as `Lorsqu'` included), Spanish (`es`), Italian (`it`), Portuguese (`pt`), Dutch (`nl`),
  Polish (`pl`), Swedish (`sv`) and Russian (`ru`). `bdd.language` sets the default.

Syntax errors carry the line and column. The parser keeps going after an error, so the Studio
and `eztest validate` show every problem at once:

```
features/checkout.feature:5:7: inconsistent cell count: this row has 1 cells, the header has 2
features/checkout.feature:9:5: a step must be inside a Scenario or a Background (got "Given ...")
```

## Reports

- **HTML.** A **Features** section lists each feature with its counts, then its rules, then each
  scenario and Examples row. Every Gherkin step is shown with its status, how it was bound (step
  definition with `file:line`, EZTest phrasing, undefined, ambiguous) and its error. Scenarios link
  to their journey's step-by-step viewer.
- **JSON** (`report.json`). A `bdd` object holds `features[]` (name, file, status, counts, rules,
  scenarios and steps) and `totals`. `run.json` has, for every scenario, `journeys[].bdd` (feature,
  rule, scenario and Examples row) and `steps[].gherkin` (keyword, text, line, match, location and
  snippet).
- **JUnit** (`junit.xml`). One `<testsuite>` per feature, named after the feature, and one
  `<testcase>` per scenario and Examples row. The classname is the feature, plus `.<rule>` for
  scenarios in a rule. Azure DevOps, Jenkins and GitLab group the tests by these. Journeys that
  are not features stay in the run's own suite.

## Studio

- **Journeys editor.**
  - `.feature` files from the journeys folder and the feature folders are listed, one entry per
    scenario and Examples row.
  - Files open with Gherkin highlighting: keywords in every supported language, tags, comments,
    doc strings, tables, quoted text, numbers and `<placeholders>`.
  - The outline lists blocks and steps.
  - **Format** re-indents the file and aligns tables.
  - After a step keyword, autocomplete offers the project's step definitions, then EZTest
    phrasings.
- **Diagnostics as you type.**
  - Syntax errors, with line and column.
  - For every step, one of: the step definition it binds to (`file:line`), the EZTest phrasing it
    runs as, **undefined** (with a "Copy snippet" fix) or **ambiguous** (listing the definitions).
  - The Studio finds definitions by reading the step files' text, without running them. It sees
    `Given('literal', ...)`, `Given(/regex/, ...)` and `defineParameterType({ name, regexp })` with
    literal values. Patterns built at run time are only seen by `eztest validate` and the run
    itself.
- **Run and debug.**
  - **Run** runs the scenario at the cursor, or every Examples row of the outline at the cursor,
    or the whole file.
  - **Debug** opens the scenario at the cursor. Breakpoints go on step lines (gutter or F9),
    step over moves from step to step, and variables, the page and evidence can be inspected.
  - Edit-and-continue is for `.ez`, YAML and JSON only: edit the feature and run again.
- **Results.** A **Features** tab groups a run's scenarios by feature and rule, shows each step's
  binding, shows snippets for undefined steps, and links to the timeline and the feature file.

## API

```ts
import { bdd } from '@eztech.com/eztest';   // or: import { parseGherkin, ... } from '@eztech.com/eztest/bdd'

const doc = bdd.parseGherkin(text, 'checkout.feature');          // AST with line and column
const { pickles } = bdd.compilePickles(doc);                      // scenarios and rows, backgrounds included
const journeys = bdd.featureJourneys(text, '/abs/checkout.feature', { cwd });
const expr = bdd.stepExpression('pay {int} to {string}', new bdd.ParameterTypeRegistry());
bdd.parseTagExpression('@smoke and not @wip');
bdd.analyzeFeature(text, 'checkout.feature', { definitions });    // the Studio's diagnostics
bdd.formatFeature(text);
```

## Migrating instead

To turn features into `.ez` journeys once (and drop Gherkin), use the importer:
`eztest import features/ -o journeys/`. To keep the features and run them, use native BDD as
described here.

## Limits

- BeforeAll / AfterAll run once per run, and with `--shard` once per shard; shards are not
  coordinated with each other.
- Step definitions run in Node. Like code journeys, only their SDK calls are steps (healed,
  verified, traced). Other code inside a definition is not.
- The Studio's step diagnostics come from a static scan. A definition whose pattern is computed
  at run time shows as undefined in the editor, while `eztest validate` and the run bind it.
- `eztest import` remains the way to convert features to `.ez`. Native runs do not convert
  anything.
