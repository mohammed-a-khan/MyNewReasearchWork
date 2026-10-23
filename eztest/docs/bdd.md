# Native BDD: Gherkin features and step definitions (`eztest/bdd`)

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
import { Given, When, Then } from 'eztest/bdd';

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
  links a scenario to an Azure DevOps test case, as for any journey.
- **Step results map one to one to Gherkin steps.** A scenario's results are its Background steps,
  then its own steps, each with the Gherkin text as the step name (`When I order 3 ...`) and its
  line (`L15`). Before and After hooks are results of their own, marked as hooks. A step's
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
import { Given, When, Then, Step, defineParameterType, type DataTable } from 'eztest/bdd';

Given('the customer {string} has {int} orders', async ({ ui, api, db, vars, data, world }, name, n) => { /* ... */ });
When(/^I pay (\d+) (EUR|USD)$/, async ({ api }, amount, currency) => { /* regex groups arrive as strings */ });
Then('the totals are:', async ({ expect }, table: DataTable) => { /* the data table is the last argument */ });
When('I send this request:', async ({ api }, body: string) => { /* so is the doc string */ });
Step('any keyword', async () => {});
Given('a slow step', { timeout: 30_000 }, async () => {});
```

- **The first argument** is a context with the whole SDK (`ui`, `api`, `db`, `data`, `files`,
  `dates`, `identity`, `vars`, `log`, `expect`, `step`, `run`, `soft`, `actors`; see
  [sdk.md](sdk.md)), plus:
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

## The World

Each scenario attempt gets a new World. Steps share state through it, and a retry starts clean.
By default the World is a plain object. `setWorldConstructor(MyWorld)` replaces it: the class is
created with `{ parameters }`, the `bdd.worldParameters` from the config.

```ts
import { setWorldConstructor } from 'eztest/bdd';
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
import { Before, After, BeforeStep, AfterStep } from 'eztest/bdd';

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
  (steps/hooks.steps.ts:12)`), so their SDK calls have evidence and traces too. BeforeStep and
  AfterStep calls are children of the step they surround.

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
healing and evidence included. Nothing is guessed. Domain steps such as `Given the customer
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
`where` language as `.ez` Examples (`=`, `!=`, `>`, `<`, `>=`, `<=`, `~`, `and`, `or`, `not`,
parentheses). Each row is one journey (`<id>-<first value>`). A source that matches no rows is
reported as skipped with the reason. `eztest validate` checks the file, the filter and the
columns. This line is not standard Gherkin: other Gherkin tools read it as an Examples block named
`from data ...` without a table.

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
import { bdd } from 'eztest';   // or: import { parseGherkin, ... } from 'eztest/bdd'

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

- No `BeforeAll` / `AfterAll` hooks. Use the config `hooks:`, `webServer:` or a library journey
  for one-time setup.
- Regex definitions pass their capture groups as strings. The `{...}` parameter conversion
  applies to expressions only.
- Step definitions run in Node. Like code journeys, only their SDK calls are steps (healed,
  verified, traced). Other code inside a definition is not.
- The Studio's step diagnostics come from a static scan. A definition whose pattern is computed
  at run time shows as undefined in the editor, while `eztest validate` and the run bind it.
- `eztest import` remains the way to convert features to `.ez`. Native runs do not convert
  anything.
