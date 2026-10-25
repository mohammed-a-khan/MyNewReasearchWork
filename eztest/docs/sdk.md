# Code journeys: the TypeScript SDK (`@eztech.com/eztest/sdk`)

Most journeys are best written in plain English (`.ez`). Some logic is easier to write as
code: loops over query rows, `switch` on data, date arithmetic, file round trips, or
migrated test code. `@eztech.com/eztest/sdk` covers those cases. Every UI call in the SDK goes through
the same runner path as an `.ez` step:

- strict locating;
- the healing ladder (T0 cache, T1 fingerprint, T2 semantic), verified by post-conditions;
- evidence and the hash chain;
- traces, the report and the debugger.

Code journeys sit next to `.ez` journeys and are filtered, retried, quarantined, gated and
published the same way.

```ts
// journeys/orders.journey.ts
import { journey, step, expect } from '@eztech.com/eztest/sdk';
import { Login, NewOrder, Order } from '../screens/shop.js';

journey('Order for every EU customer', { tags: ['@orders'], requirements: ['REQ-12'], risk: 4 }, async ({ ui, db, dates, files, vars }) => {
  await step('Sign in', async () => {
    await ui.open('/login');
    await ui.fill(Login.username, 'bob');
    await ui.fill(Login.password, vars.text('SHOP_PASSWORD'));
    await ui.click(Login.signIn, { expect: { url: '/dashboard' } });
  });

  const customers = await db.query<{ name: string; credit_limit: number }>('CUSTOMERS_BY_REGION', { region: 'EU' });
  const created = [];
  for (const c of customers) {
    await step(`Order for ${c.name}`, async () => {
      await ui.open('/orders/new');
      await ui.select(NewOrder.customer, c.name);
      await ui.select(NewOrder.product, c.credit_limit >= 20000 ? 'Gadget (49.50)' : 'Widget (19.99)');
      await ui.click(NewOrder.submit, { expect: { text: 'created' } });
      await expect.ui.text(Order.customer).toBe(c.name);
      created.push({ order: await ui.text(Order.number), due: dates.addBusinessDays(dates.today(), 3) });
    });
  }
  await files.writeCsv('out/created.csv', created);
});
```

Run it like any journey: `eztest run`, `eztest run --grep orders`, `eztest run -t @orders`,
or from the Studio.

<!-- BEGIN SECTION: sdk-reference (maintained with src/sdk) -->

## Files and discovery

| File | What it holds | How it is found |
|---|---|---|
| `*.journey.ts` (also `.mts`, `.js`, `.mjs`) | `journey(...)` calls | Discovered by `eztest run` / `validate` in `journeysDir`, like `.ez` files |
| `*.steps.ts`, any `.ts` | `export const x = codeStep(...)` | Called from `.ez` with `Run code "file#x"` |
| `screens/*.ts` | `screen(...)` definitions | Imported by journeys and steps |

One file may hold several journeys. Ids default to the slug of the name; set `id` to keep
an id stable when you rename a journey. Step ids are `L<line>`, the source line of the
call, so reports, history and breakpoints all point at code.

## `journey(name, options?, fn)`

Registers a code journey. `fn` receives an `SdkContext` (`{ ui, api, db, data, files, dates,
identity, vars, log, expect, step, run, soft }`). The same objects can also be imported
from `@eztech.com/eztest/sdk`.

| Option | Meaning (same as the `.ez` header) |
|---|---|
| `id` | Stable id (default: slug of the name) |
| `description` | Free text |
| `tags` | `['@smoke', '@TestCaseId:123']`. Used by `-t`, quarantine and Azure DevOps publishing |
| `requirements` | Requirement ids, for traceability and readiness |
| `risk` | 1..5, default 3 |
| `role` | Identity Vault role. `ui.login()` with no argument uses it |
| `baseUrl`, `variables`, `lenses`, `emulation`, `loaders` | As in `.ez` |
| `examples` / `examplesFrom` | Runs once per row. Read the row with `vars.row()` |
| `params` / `returns` | When the journey is called with `Run journey` |

The journey passes when `fn` resolves and no soft assertion failed. It fails on the first
hard failure, or when `fn` throws. A thrown error becomes a reported step at the throwing
line, with a screenshot. Hooks, retries (`retries` in config), quarantine and readiness
treat the result exactly as they treat an `.ez` result.

## `step(name, fn)`

```ts
const total = await step('Read the total', async () => ui.text(Order.total));
```

Groups the calls inside `fn` into one reported, nested step and returns `fn`'s value.
Steps nest to any depth. A failure inside marks the step and its parents failed. In the
debugger, a step is a stop point and step-over runs it whole.

## `screen(name, elements)` and elements

```ts
export const Login = screen('Login', {
  username: { label: 'Username', testId: 'username' },          // several locators = ordered candidates
  signIn: { role: 'button', name: 'Sign in', css: '#login-btn' },
  total: 'testid=order-total',                                  // .ez locator syntax
  orderLink: (id: string) => ({ role: 'link', name: id, description: `order ${id}` }),
});
```

An element spec takes these fields:

- **Locators:** `css`, `xpath`, `role` + `name`, `text`, `label`, `testId`, `placeholder`, `title`, `altText`, `exact`.
- **Extra candidates:** `candidates: [{ strategy, value }]`.
- **Other:** `description` (used in reports and healing) and `frames` (an iframe selector chain).

All locators of one element are candidates for the strict locator and the healer, tried
in order. Use `el(spec, description)` for one-off elements, and `child(parent, spec)` and
`nth(el, i)` for scoped elements. Any argument named `TargetInput` also accepts a string
in `.ez` locator syntax (`'css=#id'`, `'text="Save"'`) or a spec object.

Each static entry of a screen has the element id `<screen>.<key>` (`Login.signIn`). The
runner keeps one fingerprint and one verified heal per id for every journey that uses it.
When the shared element repository (`elements/*.yaml`, see [elements.md](elements.md)) has
the id, its locators come first, so a heal accepted in the Quality Center reaches code journeys
too. Function entries (`orderLink(id)`) build a new element per call and keep per-step memory.

### Relative and scoped targets

A string uses the `.ez` phrases (`ui.click('the "Edit" button in the row containing "Acme"')`).
Helpers build the same scopes from elements:

```ts
import { within, inRow, below, above, rightOf, leftOf, near, nth } from '@eztech.com/eztest/sdk';

await ui.click(inRow('Acme', 'the "Edit" button'));
await ui.fill(within(Checkout.billing, below('"Email"', 'the field')), 'a@b.c');
await ui.fill(rightOf('the "Qty" label', 'the input'), '3');
await ui.click(near('"Total"', 'the "Recalculate" button', { maxDistance: 80 }));
await ui.click(nth('the "Delete" button', 1));               // the 2nd one
```

Every container, row and anchor must match exactly one element, as in `.ez`.

### `clock`

The browser clock of the journey's context (see [ez-language.md](ez-language.md#clock-and-time)):
`clock.set('2027-03-15 09:00')`, `clock.install(time?)`, `clock.freeze(time)`, `clock.pause()`,
`clock.pauseAt(time)`, `clock.resume()`, `clock.advance('2 hours')` (each due timer fires once),
`clock.runFor('30 minutes')` (every timer in order), `clock.runAll()`, `clock.runToLast()`,
`clock.useRealTime()` and `clock.now()` (the fake time as a `Date`). Times are strings, epoch ms or
`Date`s; durations are strings or ms. Each call is a step, so it shows up in the evidence and the trace.

## `ui`

Every call is a runner step with its own intent, evidence and trace entry.

| Kind | Calls |
|---|---|
| Navigation | `open(url)`, `reload()`, `back()`, `forward()`, `waitForUrl(p)`, `waitForLoad(state)` |
| Actions | `click(t, {button, newTab})`, `dblclick`, `hover`, `fill(t, value)`, `clear`, `select(t, option)`, `check`, `uncheck`, `press(key, t?)`, `upload(t, files)`, `download(t)` (returns the download record: `path`, `filename`, `sha256`, `size`), `scrollIntoView`, `focus` |
| Waits | `waitFor(t, state)` with `visible`, `hidden`, `attached`, `detached`, `enabled`, `disabled`, `checked`, `stable` and the other `.ez` element states; `wait(ms)` |
| Reads | `text`, `value`, `attribute(t, name)`, `texts`, `count`, `table` (rows as records), `url()`, `title()` |
| Probes | `isVisible`, `isHidden`, `isEnabled`, `isChecked`. These never fail; the default timeout is short |
| Dialogs and session | `acceptNextDialog(answer?)`, `dismissNextDialog()`, `lastDialog()`, `clearSession()` |
| Tabs, windows, frames | `switchToTab('new' \| 'main' \| 'previous' \| n \| { title } \| { url })`, `closeTab()`, `inFrame(['outer', 'inner'], async () => …)` (returns what the function returns; back in the page afterwards, also on failure) |
| Mouse | `drag(from, to)` (HTML5 drag and drop for draggable elements, else a mouse drag) |
| Any `.ez` step | `perform('Scroll down until the "Item 50" text is visible')`: one plain-English line, run exactly as in an `.ez` file |
| Components | `component(widget, name, op, args?)`: a grid, combo box, date picker, tree, tab, dialog or other library widget step, run like the `.ez` Components phrasings (strict widget lookup, library detection, read-back verification, healing, evidence); returns what `readCell`, `readAll` or `capture` reads. See [components.md](components.md) |
| Identity | `login(role?)`, the verified Identity Vault login with session reuse |
| Other | `screenshot(name)` (added to evidence), `page()`, the raw browser page from `@eztech.com/eztest/browser` (see below) |

Action options (`ActionOptions`):

| Option | Meaning |
|---|---|
| `expect` | Post-conditions. An `.ez` Expect phrase (`'the URL contains "/done"'`), an object (`{ url, urlMatches, title, text, notText, visible, hidden, textOf: [t, s], value: [t, s], count: [t, n] }`) or an array of these. Post-conditions are what make a heal verifiable: a healed locator is accepted only when they hold |
| `timeoutMs` | Timeout for this action |
| `optional` | A failure is recorded as skipped and the journey continues |
| `poll` | `{ attempts, intervalMs }`: re-run the action until its post-conditions hold |
| `intent` | Report text (default: generated, e.g. `Click Sign in button`) |

`ui.page()` gives the raw browser page (the `Page` type of `@eztech.com/eztest/browser`) as an escape hatch. Calls made on it are not
located strictly, healed, verified or recorded as evidence. Prefer `ui.*`.

## `expect`

```ts
await expect(total, 'order total').toBe('49.50');        // value matchers, with .not
await expect.ui.text(Order.customer).toBe('Contoso Ltd'); // UI: retried until timeout, with a screenshot on failure
await expect.ui.visible(Dashboard.orders);
await expect.api(res).status(201);                        // also .json('$.id'), .header(name), .fasterThan(ms)
await expect.rows(rows).toContainRow({ customer: 'Contoso Ltd' });
await expect.rows(uiRows).toEqual(dbRows, { key: 'order', tolerance: 0.01 });
await expect.db('OPEN_ORDERS', { user: 'bob' }).toHaveCount(3);
await expect.soft(x).toBe(1);                             // one soft check
```

There are three kinds of matcher.

- **Value matchers:** `toBe`, `toEqual`, `toContain`, `toMatch`, `toBeOneOf`, `toBeTruthy`, `toBeFalsy`, `toBeNull`, `toBeDefined`, `toBeUndefined`, `toBeGreaterThan(OrEqual)`, `toBeLessThan(OrEqual)`, `toBeCloseTo`, `toHaveLength`.
- **UI checks:** `expect.ui.text | value | visible | hidden | enabled | disabled | checked | count | url | title | page`. The UI checks run as runner post-conditions: they wait, and they record evidence.
- **Row comparison:** `expect.rows(...)`, with typed comparison on key columns, a column subset and a numeric tolerance. A failure attaches the differing rows as JSON evidence.

Every expectation is a reported step.

### Soft assertions

```ts
await soft(async () => {
  await expect(a).toBe(1);
  await expect.ui.text(Order.total).toBe('49.50');
});
```

Inside `soft(fn)`, and with `expect.soft(...)`, a failed expectation is recorded with its
evidence and the journey continues. The journey then fails at the end. A `step()` that
holds soft failures is marked failed (soft).

## `api`

`api.get(url, o)`, `api.delete(url, o)`, `api.post | put | patch(url, body, o)` and `api.request(method, url, body, o)`
return `{ status, headers, body, durationMs }`. The options are `headers`, `query`, `form`, `asRole`, `clientCertificate`, `expectStatus`, `allowErrors` and `timeoutMs`. They
use the same client as the `.ez` API steps: safe retries, masking, and evidence of the
request and response. `api.path(res, '$.items[0].id')` and `jsonPath(value, path)` read JSONPath.

## `db`

```ts
const rows = await db.query<Customer>('CUSTOMERS_BY_REGION', { region: 'EU' });   // named query from db.queries
const one = await db.row('CUSTOMER', ['Contoso Ltd']);
const n = await db.count('OPEN_ORDERS', { user: 'bob' });
const v = await db.value<number>('ORDER_TOTAL', { id });
const { rows: r, rowCount } = await db.execute('CLOSE_ORDER', [id]);
const mine = await db.on('shop').sql`SELECT * FROM orders WHERE created_by = ${'bob'}`;  // ad-hoc, values bound
await db.procedure('SETTLE', [id], [{ name: 'status', type: 'string' }]);
```

`db.query`, `row`, `value`, `count`, `execute` and `procedure` take a **query name** from the
`db.queries` catalogue, never SQL text. Passing SQL to them is an error. Ad-hoc SQL goes
through the `sql` / `sqlValue` tagged templates, where every `${value}` becomes a bound
parameter and is never spliced into the text. Use `{ connection }` or `db.on(name)` to pick
a connection. Every call is a runner step with the query, its parameters and its row count
in the evidence.

## `data`

- `data.row`: the current Examples row.
- `data.rows(file, { sheet, where })`: rows from CSV, XLSX or JSON, with the same `where` filter syntax as `Examples: from data`.
- `data.lease(pool, o)`: a parallel-safe lease from a data pool.

## `files`

- **Read:** `rows(path, { sheet, delimiter })` reads CSV, XLSX or JSON by extension. There are also `readCsv`, `readXlsx`, `readJson`, `readText` and `readPdf` (text layer and pages).
- **Write:** `writeText`, `writeJson`, `writeCsv(path, rows, { columns })` and `writeXlsx(path, rows, { sheet })`. Each returns the absolute path.
- **Paths:** `exists(path)` and `path(rel)`.

Paths are relative to the project. Writes are recorded as evidence. `toCsv(rows)` gives the
CSV text.

## `dates`

These are the expression-language functions, so `.ez` and code agree to the day:

- `today()`, `now()`;
- `addDays | addMonths | addYears | addHours | addMinutes(d, n)`;
- `addBusinessDays(d, n)`, `businessDaysBetween(a, b)`;
- `format(d, pattern)`, `toUSDate(d)`, `inZone(d, tz)`;
- `startOfMonth`, `endOfMonth`, `parse`.

`Date`-object helpers:

- `toDate(input)`;
- `shift(d, n, unit)`, where `unit` includes `'businessDays'`;
- `startOf` / `endOf(d, unit)`;
- `diff(a, b, unit)`, `compare`, `isSame`, `isWeekend`;
- `formatWith(d, 'MM/DD/YYYY HH:mm', tz?)`.

## `identity`, `vars`, `log`

- `identity.loginAs(role)`, `identity.totp(secret)`.
- `vars.get<T>(k)`, `text(k)`, `set(k, v)`, `has`, `delete`, `all()`, `row()`. Variables are shared with `.ez` steps in the same journey.
- `vars.resolve('${x} {config:Y}')` expands EZ `${}` and the placeholder forms `{config:X}`, `{scenario:x}` and `{{x}}` that migrated code often uses.
- `vars.config(key, fallback?)` reads a config variable.
- `log.debug | info | warn | error(message, data?)` writes to the step log and the report.

Values from code are passed to the runner literally, so a `${` in data is never
interpolated a second time.

## `actors` and `as(name, fn)`: several users in one journey

```ts
journey('Maker and checker', { actors: { maker: 'clerk', checker: 'manager' } }, async ({ actors }) => {
  await actors.maker.ui.click({ role: 'button', name: 'Submit for approval' });
  await actors.checker.ui.click({ role: 'button', name: 'Approve' });
  await actors.maker.expect.ui.page().toContainText('Approved');
});
```

Each actor has its own browser context and session, signs in as its role on
first use, and its steps, screenshots and traces are labelled with it.
`Promise.all` runs actors at the same time; `as('maker', fn)` runs a block as
one actor. See [multi-actor.md](multi-actor.md).

## Interop

### `.ez` calls code: `Run code`

```text
Run code "steps/billing.steps.ts#orderTotals" with region="EU", minLimit="10000" as totals
Expect ${totals.count} == 2
```

```ts
// steps/billing.steps.ts
import { codeStep } from '@eztech.com/eztest/sdk';
export const orderTotals = codeStep<{ region: string; minLimit: string }>(async ({ db }, { region, minLimit }) => {
  const rows = await db.query<{ name: string; credit_limit: number }>('CUSTOMERS_BY_REGION', { region });
  const big = rows.filter((r) => r.credit_limit >= Number(minLimit));
  return { count: big.length, first: big[0]?.name };
});
```

The path resolves against the code journey's own folder, then the project root, then
`journeys/`. Without `#name`, the default export is called. `#journey:<id>` runs a code
journey as a sub-journey. The parameters arrive as strings. The return value is stored
under `as <name>` (objects can be read with `${totals.count}`). The code step's calls appear
as children of the `Run code` step.

The YAML and JSON forms are equivalent:

```yaml
steps:
  - runCode: steps/billing.steps.ts#orderTotals
    with: { region: EU, minLimit: "10000" }
    as: totals
```

```json
{ "action": "code", "value": "steps/billing.steps.ts#orderTotals", "args": { "region": "EU" }, "captureAs": "totals" }
```

### Code calls `.ez`: `run(id, params)`

```ts
const out = await run('login-as', { user: 'bob', password: vars.text('PW') });
await expect(out.welcome).toBe('bob');
```

`run` runs any `.ez`, YAML, JSON or code journey by id, as a nested sub-journey. It returns
the journey's `Returns:` values.

## How TypeScript is loaded (and why there is no eval)

EZTest never evaluates user code with `eval` or `new Function`. A source-scan test enforces
this. Code is loaded with ordinary module `import()` of a file, and only in one module,
`src/runner/code-journeys.ts`. The strategy is chosen in this order:

1. `.js` / `.mjs` files are imported as they are.
2. If the process already runs under **tsx**, the `.ts` file is imported directly.
3. If **esbuild** is available (from the project or EZTest's install), the file and its
   relative imports are bundled into `<project>/.eztest/code-cache/<name>-<hash>.mjs`, with
   an inline source map, and that file is imported.
   - Packages stay external, resolved to absolute paths, so your own dependencies load
     from your `node_modules`.
   - `eztest` and `eztest/*` are pinned to the EZTest that is running, so the journey and the
     runner share one SDK runtime.
   - The cache key is the content hash of every bundled input, so an edit gives a new bundle.
4. If Node strips types itself (Node 22.18+ or 23.6+), the `.ts` file is imported directly.
   This needs explicit `.ts` extensions on relative imports and no enums or parameter
   properties.
5. If the **tsx** package is installed, its `tsImport` API is used.
6. Otherwise loading fails with a message that says how to fix it.

`EZTEST_CODE_LOADER=esbuild|native|tsx` forces one strategy (a reserved variable; config
files cannot set it). The esbuild path is the default because it handles every TypeScript
feature, keeps source lines exact through the source map, and needs no loader hooks in the
host process.

Discovery for the Studio's file list is a **static scan** of `journey(...)` calls. Listing
journeys never executes code. Code runs only when a journey runs or validates.

Typecheck with your own `tsc --noEmit`. The SDK ships `.d.ts` files (`@eztech.com/eztest/sdk`). The
Studio checks syntax as you type but does not typecheck.

## Studio, trace and debugger

- **Editor.** `.ts` journeys and steps open with TypeScript highlighting and SDK
  autocomplete (`ui.`, `expect.ui.`, `db.` and so on, with signatures). The outline lists the
  `journey()`, `step()` and SDK call lines.
- **Run, trace and results.** A code journey runs from the editor like any other journey.
  Its steps carry source lines, so the trace viewer and report link back to code. Code
  journeys appear in Results, flaky trends and the Quality Center (requirements, risk,
  readiness) next to `.ez` journeys.
- **Debugger.**
  - Line breakpoints go on `step()` and `ui.*` / `expect` / `db` / `api` calls: click the
    gutter or press F9 on the line. Conditional breakpoints work too.
  - **Step over** runs to the next call at the same depth.
  - **Run to cursor** stops at a line.
  - Variables, the page and evidence can be inspected at each stop.
- **Edit-and-continue is `.ez`, YAML and JSON only.** Code cannot be swapped in a running
  module safely, so the debugger refuses to replace a step of a code journey and says so in
  the console. Edit the file and re-run instead.

## Limits

- Code journeys run Node-side: anything outside `ui.*` (plain computation, `fs`, third-party
  libraries) is your code and is not healed or verified. Only the SDK calls are steps.
- Breakpoints stop at SDK calls, not at arbitrary statements between them.
- `ui.page()` bypasses strict locating, healing and evidence.

<!-- END SECTION: sdk-reference -->
