# The `.ez` language

An `.ez` file is a journey written in plain English, with one step per line. EZTest turns each line into a structured step deterministically; no AI is involved. `eztest validate` reports any line it cannot understand, with its line number and the closest phrasings.

## File layout

```text
Journey: Checkout as a returning customer      # required
Id: checkout-returning                         # optional (default: from the file name)
Description: Card payment, saved address
Tags: @smoke @checkout
Role: shopper                                  # Identity Vault role used by "Log in"
Requirements: PAY-1, PAY-4                     # traceability
Risk: 4                                        # 1 (low) .. 5 (critical)
Base URL: https://shop.test
Variables: currency=EUR, qty=2
Lenses: a11y, security
Data: Customer as buyer where region=EU

Open /cart
Click the "Checkout" button
Expect the URL to contain "/checkout"          # post-condition of the Click
```

- `#` starts a comment; blank lines are ignored. Indentation is free.
- Text in quotes is kept exactly. `${name}` inserts a journey variable, a run variable, or anything captured earlier in the journey (`${order.lines.0.sku}` reaches inside captured values).
- Step options can follow in brackets: `Click the Save button [id=save optional timeout=5s risk=5]`.
  - `soft` makes a failure a soft one (the journey goes on and still fails at the end).
  - `retry=N every=500ms` repeats the step until its expectations hold ("retry until"), e.g. polling an API.
  - `unverified` marks a line an importer read from free text; it has no effect on the run, and `eztest import --verify` removes it once the journey passes a replay.

### More headers

| Header | Meaning |
|---|---|
| `Params: role, product` | Parameters a caller passes with `Run journey ... with role=manager` (required unless a default is in `Variables:`) |
| `Returns: orderId, total` | Captured values handed back to the caller |
| `Device: iPhone 13` | Emulate a device from EZTest's device list (viewport, user agent, touch, mobile) |
| `Viewport: 1280x720` · `Locale: de-DE` · `Timezone: Europe/Berlin` | Browser context settings |
| `Clock: 2026-12-31T23:59 Europe/London` · `Clock: paused 2027-03-15 09:00` · `Clock: fixed 2027-01-01` | Start the journey on EZTest's browser clock (flowing, paused or with `Date` frozen); see [Clock and time](#clock-and-time) |
| `Color scheme: dark` · `Reduced motion: reduce` | Media features |
| `Geolocation: 52.52, 13.40` · `Permissions: geolocation, notifications` | Location and permissions |
| `User agent: EZBot/1.0` · `Headers: x-tenant=acme` · `Touch: on` · `Offline: yes` | Request headers and capabilities |
| `HTTP credentials: admin / ${adminPassword}` | HTTP basic auth (use secret variables) |
| `Platform: android` · `App: "com.shop.app"` · `Capabilities: serial="emulator-5554", clearData=true` | Run on a native Android or iOS app (see [mobile.md](mobile.md)); `Device:` is then recorded with the run |
| `App: electron "apps/orders/main.js"` | Desktop app journey (no `Platform:` header, or `Platform: web`): launch the Electron app and run the steps in its windows (see [desktop-and-legacy.md](desktop-and-legacy.md)) |
| `Loaders: ".busy", "#mask"` | Loader/spinner selectors waited out before every action and check (added to config `waits.loaders`) |
| `Requires: db demo "SELECT id FROM customers WHERE region = 'EU'" has rows; variable KEY` | Data-state preconditions checked before the journey; a miss is a data problem (see [reliability.md](reliability.md#preconditions-requires)) |
| `Setup: Create the test tenant` · `Teardown: Delete the test tenant` | Instead of `Journey:`: runs once before / after every other journey of the run; a setup's `Returns:` become run-wide values (see [shared-data.md](shared-data.md#run-wide-values-setup-and-teardown-journeys)) |
| `Depends on: create-order with orderNumber` | Prerequisite journeys run first; the named ledger values are handed over; dependents of a failure are skipped with the reason |
| `Locks: account-<account>, ledger` | Shared entities this journey touches: journeys holding a common key never run at the same time, across workers, processes and machines (see [scale.md](scale.md#resource-locks)) |
| `Examples:` + a table | Data-driven journey: one run per row (see below) |
| `Actors: manager as approver, customer as shopper` | Multi-actor journey: each actor has its own browser context and session; `As manager:` sections, `Switch to user "bob"`, `In parallel:` ... `End` (see [multi-actor.md](multi-actor.md)) |
| `Browsers: chromium, msedge` | In a cross-browser run (`browsers:` / `--browsers`), run this journey on these browsers only (see [browser-driver.md](browser-driver.md#cross-browser-runs)) |
| `Type: manual` · `Assignee: Quinn` · `Preconditions: A cancelled order exists` | Manual and hybrid test cases: the type (inferred when absent), the tester it is assigned to, what must be true first (see [manual-testing.md](manual-testing.md)) |

## Expectations are post-conditions

A line starting with `Expect`, `Then expect`, `And expect` or `Verify` that **follows an action** becomes a post-condition of that action: something that must be true after it. EZTest polls until it holds or the timeout expires.

Post-conditions matter beyond checking. They are how a heal gets verified: if a renamed button is found by healing, the step only passes (as `passed-healed`) when its expectations still hold. Click-like steps with no expectation cannot be healed safely, so add one. This holds at every depth: inside blocks, loops, sub-journeys and frames.

To write a standalone assertion, start the line with `Assert that …` or `Check that …`. A **soft assertion** (`Soft expect …`, `Expect softly …`, or `[soft]`) records its failure and lets the journey continue; the journey still ends as failed.

## Actions (368 phrasings)

Each phrasing accepts natural variants (articles, "I"/"the user", third person, synonyms such as switch/go/move, tab/window/page).

### Core

| Purpose | Examples |
|---|---|
| Navigate | `Open /login` · `Go to /orders/new` · `Start at /login` · `Reload the page` · `Go back` · `Go forward` |
| Log in | `Log in as manager` · `Log in` (uses the journey's `Role:`) |
| Click | `Click the "Sign in" button` · `Press the Save button` · `Follow the Orders link` · `Submit with the "Place order" button` · `Double-click the Order row` · `Right-click the Order row` · `Open the Orders tab` |
| Type | `Type "bob" into the Username field` · `Fill the Quantity field with 2` · `Fill "2" into the Quantity field` · `Put "2" in the Quantity field` · `Set the Quantity field to 2` · `Clear the Search field` |
| Choose | `Select "Gadget" from the Product dropdown` · `Set the Product dropdown to "Widget"` · `Check the Remember me checkbox` · `Uncheck the Newsletter checkbox` · `Turn on the Dark mode switch` · `Select the Express radio button` |
| Keyboard and mouse | `Press Enter` · `Press Enter in the Search field` · `Hover over the Help icon` |
| Files | `Upload "fixtures/po.pdf" to the Attachment field` · `Choose file "a.csv" for the Import field` · `Download the "Download invoice" link as invoice` |
| Capture values | `Capture the text of testid=order-number as orderNumber` · `Let total be the text of testid=order-total` · `Remember the order number link as orderNumber` |
| Wait | `Wait 2 seconds` · `Wait until the URL contains "/dashboard"` · `Wait for the text "Saved"` · `Wait for the spinner to disappear` · `Wait for the Orders table to appear` |
| API | `Call API "GET /api/orders" as manager and store as orders` · `Send a GET request to /api/orders and store as orders` · `GET /api/orders as manager and store as orders` |
| Database | `Run query "SELECT * FROM orders" on shop as rows` · `Query shop with "SELECT COUNT(*) AS n FROM orders" as count` |
| Test data | `Use data Customer as customer where region=EU` · `Given a Customer as buyer where region=EU` |
| Documents | `Compare document invoice to the order using invoice-vs-order and store as invoiceCheck` · `Expect document invoice to look like "baselines/invoice.pdf" within 0.5% ignoring page 1 400,40,150,20` (visual, see [documents.md](documents.md)) |
| Assertions | `Verify the page contains "Welcome"` · `Check that the URL contains "/dashboard"` · `I should see "Order created"` · `The Orders table should have 2 rows` · `Soft expect the page contains "Welcome"` |
| Relative targets | `Click the "Edit" button in the row containing "Acme"` · `Click the "Delete" button in the "Acme" row` · `Type "a@b.c" into the field below "Email"` · `Type "3" into the input right of the "Qty" label` · `Click the "Recalculate" button near "Total"` · `Type "Ann" into the "Name" field inside the "Billing" section` · `Click the 2nd "Delete" button` · `Click the last "Edit" button` (see [Relative and scoped targets](#relative-and-scoped-targets)) |
| Shared elements | `Click the @Checkout.placeOrder button` · `Click @Checkout.placeOrder` · `Click the Checkout button` (an element's description or alias; see [elements.md](elements.md)) |
| Custom | `Run step "seedCart" with items=3` (a handler you register in code) |

### Tabs, windows and popups

| Purpose | Examples |
|---|---|
| Open | `Open a new tab with /orders as orders` · `Open /report in a new tab` · `Open a new window` |
| Follow a popup | `Click the "Open report" link and switch to the new tab` · `Click the "Help" button and switch to the popup` · `Click the "Export" button and wait for the new tab` |
| Switch | `Switch to the new tab` · `Go to the newly opened window` · `Switch to the popup` · `Switch back to the main tab` · `Switch back to the previous tab` · `Switch to tab 2` · `Switch to the second window` · `Switch to the tab titled "Report"` · `Switch to the "Report" tab` · `Switch to the tab with URL "/report"` |
| Close | `Close the tab` · `Close the popup` · `Close tab 2` · `Close the "Report" tab` |
| Check | `Expect there are 2 tabs open` · `Expect 1 window is open` · `Expect the number of open tabs is at least 2` |

A popup or tab that opens later is waited for. The current tab is what every following step, post-condition, screenshot and heal works on.

### Frames

| Purpose | Examples |
|---|---|
| Block | `In the "payment" frame` … `End` · `In frame "outer" > "inner"` … `End` · `In the "inner" frame inside the "outer" frame: click the "OK" button` |
| Switch | `Switch to frame "payment"` · `Switch to the "payment" iframe` · `Switch to frame "outer" > "inner"` · `Switch to the parent frame` · `Switch to the main frame` |

A frame is found by name, id, title, aria-label or URL (`src` containing the text), or by a selector (`#pay`, `iframe.checkout`). Frames nest; the chain is per tab, and targets, post-conditions and healing all work inside it.

### Dialogs (alert, confirm, prompt, beforeunload)

| Purpose | Examples |
|---|---|
| Handle the next one | `Accept the next dialog` · `Dismiss the next confirm dialog` · `Answer the next prompt with "Ada"` · `Accept the next dialog and store it as message` |
| Check | `Expect a dialog saying "Saved"` · `Expect an alert saying "Order saved"` · `Expect a confirm dialog with text "Delete?" appeared` |
| Capture | `Capture the dialog text as message` |

A dialog nobody armed for never hangs the run: it is recorded as evidence (`dialogs.json`, text masked), handled by the configured policy (`dialogs.default`, dismiss unless set; `beforeunload` is accepted) and reported as a warning on the step.

### Keyboard

| Purpose | Examples |
|---|---|
| Combos | `Press Control+Shift+K` · `Press Mod+S` (Command on macOS, Control elsewhere) · `Use the keyboard shortcut Mod+K` · `Press Control+K on the page` |
| Repeat / target | `Press Tab 3 times` · `Press Backspace 2 times in the Search field` · `Press Enter in the Search field` |
| Hold | `Hold down Shift` · `Press and hold Control` · `Release Shift` |
| Type like a person | `Type "laptop" slowly into the Search field` · `Type "laptop" with a 250 ms delay into the Search field` · `Type "hello" on the keyboard` · `Insert text "Hello" into the Notes field` |

Named keys: Enter/Return, Tab, Escape/Esc, Space, Backspace, Delete/Del, Insert, Home, End, PageUp/PgUp, PageDown/PgDn, arrows (Up/ArrowUp ...), F1-F24, CapsLock, NumLock, PrintScreen, ContextMenu, Digit0-9, KeyA-Z, Numpad keys, and the modifiers Shift, Control/Ctrl, Alt/Option, Meta/Cmd/Win, Mod. Quote any other character: `Press "/"`.

### Mouse and gestures

| Purpose | Examples |
|---|---|
| Buttons | `Right-click the Order row` · `Open the context menu on the "Report.pdf" item` · `Middle-click the "Docs" link` · `Triple-click the Address field` |
| Modifiers | `Shift-click the "Row 3" cell` · `Ctrl+Shift-click the "Row 3" cell` · `Click the "Row 3" cell while holding Alt` |
| Position | `Click the Canvas at 10, 20` · `Click at 100, 200` · `Move the mouse to 100, 200` |
| Low level | `Press the mouse button on the Canvas` · `Release the mouse button over the Trash icon` · `Scroll the mouse wheel down by 300` |
| Drag and drop | `Drag the "Task A" text to the "Done" column` · `Drag #a to #b using HTML5 events` · `Drag #a to #b with the mouse` · `Drag the Slider handle by 100, 0` · `Drag the Slider handle 30 pixels left` |
| Scroll | `Scroll down` · `Scroll down by 500` · `Scroll to the bottom` · `Scroll the Results list down by 300` · `Scroll to the Footer section` · `Scroll the Footer section into view` · `Scroll down until the "Item 150" text is visible` (infinite lists) · `Scroll down in the Feed list until the "Item 9" text is visible at most 20 times` |
| Focus | `Focus the Search field` · `Blur the Email field` · `Remove focus from the Email field` |
| Touch | `Touch the "Menu" button` · `Swipe left on the Carousel` · `Swipe the Carousel up by 120` (with `Device:` or `Touch: on`) |

Drag and drop picks the right technique: elements with `draggable="true"` get real HTML5 `DataTransfer` events (which mouse-only dragging misses in many apps); everything else gets a stepwise mouse drag.

### DOM events

| Purpose | Examples |
|---|---|
| Dispatch | `Trigger the "change" event on the Quantity field` · `Fire a "custom-ping" event on #qty with detail '{"n":1}'` · `Dispatch the "input" event on the Search field with '{"bubbles": false}'` · `Trigger the "resize" event on the window` |
| Wait | `Listen for the "cart-updated" event on the window` · `Wait for the "cart-updated" event and store it as cart` |
| Network | `Wait for the response to /api/orders and store it as order` · `Wait for the POST response from /api/orders with status 201` · `Wait for a request to /api/track` |
| Console | `Capture the console errors as errors` · `Capture the requests to /api as calls` · `Expect there are no console errors` |

### DOM queries

| Purpose | Examples |
|---|---|
| Element facts | `Capture the "href" attribute of the "Docs" link as docsUrl` · `Capture the "checked" property of the Terms checkbox as terms` · `Capture the "color" css of #badge as color` · `Capture the bounding box of the Logo image as box` · `Capture the outer HTML of the Summary panel as html` · `Capture whether the Newsletter checkbox is checked as subscribed` · `Capture the text of #toast matching "ORD-\d+" as orderNumber` |
| Many elements | `Count the "Order" rows as orderCount` · `Capture the texts of the "Name" cells as names` · `Capture the rows of the Orders table as orders` (header-mapped records) |
| Page | `Capture the current URL as pageUrl` · `Capture the page title as title` |

No query runs code: each is a fixed, declarative read. **Shadow DOM:** role, label, text and CSS locators pierce open shadow roots automatically (`Type "SAVE10" into the Coupon field` works inside a web component; `css=ez-coupon .result` too). XPath does not pierce shadow roots.

### Page scripts (opt-in)

| Purpose | Examples |
|---|---|
| Inline | `Run JavaScript: return document.title` · `Run JavaScript and store the result as t: return document.querySelector("h1").textContent` · `Execute JS on the "Products" table: return element.rows.length` |
| File | `Run script "scripts/seed-cart.js" with items=3 and store the result as cart` |

Scripts run **in the browser page** (via the browser driver's evaluate), never in Node. The script is the body of an async function with `args` (and `element`) in scope. They are refused unless the config sets `security: { allowPageScripts: true }`. The script and its result are stored as evidence (masked). Node-side extensibility stays with registered custom steps (`Run step "..."`); EZTest itself never uses `eval` or `new Function` in Node.

### Network

| Purpose | Examples |
|---|---|
| Mock | `Mock GET /api/orders with status 200 and body "[]"` · `Stub /api/orders to return status 503` · `Mock the response to /api/orders with body from file "fixtures/orders.json"` · `Mock POST /api/orders with status 201 and header "location" = "/orders/9" and only 1 times` |
| Delay, block | `Delay /api/orders by 2 seconds` · `Block requests to /tracking` · `Abort POST requests to /api/orders` · `Block images` · `Block analytics` · `Make /api/orders fail` |
| Modify | `Set request header "x-test" to "1" for /api/*` · `Stop mocking /api/orders` · `Remove all mocks` |
| Conditions | `Go offline` · `Go back online` · `Throttle the network to slow 3G` · `Emulate a fast 3G network` · `Stop throttling` (Chromium) |
| Record, replay | `Save the network traffic as HAR "orders-flow"` · `Record HAR "checkout" for /api/*` · `Replay HAR "fixtures/orders.har"` |

URL patterns: a path or text matches by containment (`/api/orders`), `*`/`**` are globs, `/regex/` is a regular expression. Routes are browser-context wide, so popups obey them too. HAR files are written from the recorded traffic with headers, query strings and bodies masked.

### Browser state and emulation

| Purpose | Examples |
|---|---|
| Cookies | `Set cookie "theme" to "dark"` · `Add a cookie "ab" with value "B" for example.com` · `Delete cookie "theme"` · `Clear all cookies` · `Capture cookie "session" as sessionId` · `Capture all cookies as cookies` |
| Storage | `Set local storage "cart" to "[1,2]"` · `Set session storage item "step" to "2"` · `Remove "cart" from local storage` · `Clear session storage` · `Capture local storage "cart" as cart` · `Clear the browser state` |
| Permissions, location | `Grant permission "geolocation"` · `Allow notifications` · `Revoke all permissions` · `Set the geolocation to 52.52, 13.405` |
| Emulation | `Set the timezone to "Asia/Tokyo"` · `Set the locale to de-DE` · `Use dark mode` · `Prefer reduced motion` · `Emulate print media` · `Emulate device "iPhone 13"` · `Resize the viewport to 375x812` · `Set the user agent to "EZTestBot/1.0"` |
| Clipboard, auth, headers | `Copy "SAVE10" to the clipboard` · `Capture the clipboard as copied` · `Use basic auth with username "admin" and password "${adminPassword}"` · `Send header "x-tenant" = "acme" with every request` |

Mid-journey timezone, locale, device and user agent changes use the Chromium DevTools protocol; with Firefox/WebKit use the journey headers instead. Captured cookies and storage values go through the secret masker.

### Clock and time

| Purpose | Examples |
|---|---|
| Set the time | `Set the clock to 2027-03-15 09:00` · `Set the browser clock to "2026-12-31 23:59 Europe/London"` · `Install a fake clock` · `Install a fake clock at 2027-03-15 09:00` |
| Freeze or pause | `Freeze the clock at "2026-12-31 23:59"` · `Freeze time at 2027-01-01` · `Pause the clock` · `Pause the clock at 2027-01-01 08:00` · `Resume the clock` |
| Move time on | `Advance the clock by 2 hours` · `Fast-forward the clock by 15 seconds` · `Run the clock for 30 minutes` · `Run all timers` · `Run timers to the last one` |
| Back to real time | `Use the real clock` |

EZTest's browser clock is an init script of its own, installed in every document of the journey's browser context before the page's scripts. It replaces `Date`, `setTimeout`/`setInterval`, `requestAnimationFrame`, `requestIdleCallback` and `performance.now()`, and it works the same on Chromium and Firefox. EZTest keeps the clock's state and replays it into every new page, navigation and iframe, so time carries on across reloads.

- `Set the clock to …`: the page shows that time and time keeps flowing. Timers fire when their fake time comes.
- `Freeze …`: `Date` always says that time, while timers keep running.
- `Pause …`: time stands still until you advance it or resume it.
- `Advance … by …`: jumps ahead and fires each due timer once. `Run the clock for …` fires every timer in order, and intervals as often as they fall due.
- `Run all timers`: fires timers until none are left. It stops with a clear error after 10,000 timers, because an interval keeps scheduling more. `Run timers to the last one` fires up to the last timer scheduled now.

Times read as `YYYY-MM-DD[ HH:mm[:ss]]` in the journey's `Timezone:`, else the run's pinned `timezone:`, else the machine's zone. An explicit zone (`Europe/London`), `Z` or an offset (`+01:00`) wins. Durations: `2 hours`, `15 seconds`, `1h30m`, `1 minute and 30 seconds`, `01:30:00`. `today()` and `now()` in expressions follow the fake clock once it is installed. Each change is kept as evidence (`<step>.clock.json`, with the fake time after it). EZTest's own in-page helpers (actionability checks, waits) keep the real timers, so a paused clock never stalls a step. From code, use `clock.set(...)`, `clock.advance('2 hours')`, `clock.pauseAt(...)` and so on (see [sdk.md](sdk.md)).

### Files

| Purpose | Examples |
|---|---|
| Several files | `Upload "a.pdf" and "b.pdf" to the Attachments field` · `Attach "a.pdf", "b.pdf", "c.pdf" to the Attachments field` |
| Drag to upload | `Drop file "a.pdf" onto the Drop zone` · `Drag files "a.pdf", "b.pdf" to the Drop zone` |
| Downloads as data | `Read the download export as rows into rows` (CSV, TSV or XLSX; the delimiter is detected) · `Read the download book sheet "Lines" as rows into rows` · `... with delimiter ";"` |
| Download checks | `Expect the download invoice is named "INV-1.pdf"` · `Expect the download invoice name matches "INV-\d+\.pdf"` · `Expect the download invoice has type "pdf"` · `Expect the download invoice is at least 1 KB` |

### API, GraphQL, SOAP and WebSocket

| Purpose | Examples |
|---|---|
| REST options | `Call API "GET /api/accounts" with client certificate "partner" and store as accounts` (mTLS, see configuration.md) · `Call API "POST /api/notes" with form title=Hello, body=World and store as note` · `Call API "GET /api/orders" with query page=2, size=10 and store as page` · `Call API "GET /api/orders" as manager with header "x-trace" = "abc" and store as orders` · `Call API "POST /api/files" with multipart file=@fixtures/a.pdf, name=doc and store as upload` · `Call API "PUT /api/orders/1" with body from file "fixtures/order.json" with timeout 5s and store as put` · `Call API "GET /api/broken" with errors allowed and store as r` |
| Retry until | `Call API "GET /api/jobs/42" and store as job [retry=10 every=500ms]` + `Expect response job "$.status" equals "done"` |
| Read responses | `Capture "$.items[0].id" from orders as firstId` · `Capture the header "x-request-id" of orders as requestId` · `Capture the status of orders as code` |
| Check responses | `Expect the orders response status is 200` · `Expect response orders matches schema "schemas/orders.json"` · `Expect response orders "$[0].status" equals "Shipped"` · `Expect response orders has "$[0].id"` · `Expect the orders response took less than 500 ms` |
| GraphQL | `Send GraphQL query "{ orders { id } }" to /graphql and store as gq` · `Run GraphQL mutation "mutation($t: String) { add(t: $t) }" on /graphql with variables '{"t":"x"}' and store as m` (GraphQL errors fail the step) |
| SOAP | `Call SOAP action "GetOrder" on /soap with body "<GetOrder><Id>1</Id></GetOrder>" and store as order` · `... using SOAP 1.2 ...` (faults fail the step) · `Call SOAP operation "GetPolicy" on "policy" with PolicyId = "P-100" and store as policy` (a configured WSDL service: XSD-validated, WS-Security, MTOM; see [soap.md](soap.md)) |
| WebSocket | `Connect to websocket "/ws" as feed` · `Send "ping" on websocket feed` · `Wait for a websocket message containing "pong" on feed and store it as reply` · `Expect websocket feed received "pong"` · `Close websocket feed` |

### Databases

| Purpose | Examples |
|---|---|
| Query | `Run query "SELECT * FROM orders WHERE status = '${status}'" on shop as rows` · `Run query "SELECT ... WHERE id = ?" on shop with params '[42]' as rows` |
| Capture | `Get the value of query "SELECT total FROM orders WHERE id = ${id}" on shop as total` · `Get the first row of query "..." on shop as order` · `Count the rows of query "..." on shop as n` |
| Wait | `Wait until query "SELECT * FROM jobs WHERE done = 1" on shop returns 1 row within 10 seconds` |
| Procedures | `Call procedure "close_order" on shop with params '[42]' as result` (Postgres `CALL`, SQL Server `EXEC`, Oracle `BEGIN ... END;`) · `Call procedure "billing.close_invoice" on ledger with params '[42]' and out status, total:number as closed` (Oracle OUT parameters: string, number, date, clob, boolean, cursor) |
| Named queries | `Run query "OPEN_INVOICES" on ledger with customer_id=${customerId}, status="OPEN" and store the rows as invoices` · `Run query "OPEN_INVOICES" with customer_id=7 as invoices` (connection from the query's header) · `Run query "BY_POSITION" on ledger with params '[1, "x"]' as rows` |
| Named-query values | `Get the value of query "INVOICE_TOTAL" on ledger with invoice_no=${no} as total` · `Get the first row of query "ANY_OPEN_INVOICE" as pick` · `Get the row count of query "OPEN_INVOICES" with customer_id=7 as n` |
| Named-query checks | `Expect query "OPEN_INVOICES" on ledger with customer_id=7 returns 2 rows` · `... returns at least 1 row` · `... returns no rows` · `Wait until query "INVOICE_POSTED" with invoice_no=${no} returns 1 row within 30 seconds every 2 seconds` |
| Compare | `Compare ${dbRows} with ${uiRows} by id` · `Compare rows dbRows to apiRows by id, name ignoring case and store the result as diff` |
| Rows vs a named query | `Expect rows rows equal query "INVOICE_LINES" on ledger by key "Id" ignoring columns "Updated" with tolerance 0.01` · `... with params "OPEN", ${orderKey} ...` · `... on ledger with status="OPEN", region=${region} by key ...` (named binds) · `Expect rows uiRows equal rows dbRows by key "Id"` (a step of its own; column names match case-insensitively) |
| Check | `Expect query rows returns 2 rows` · `Expect the query rows returns more than 2 rows` · `Expect ${rows.0.status} equals "Open"` |

**SQL is never built from values.** Every `${var}` in SQL (and every quoted literal that contains one, such as `'%${name}%'`) becomes a bound parameter in the connection's placeholder style (`?`, `$n`, `@pN`, `:n` on Oracle). A captured value like `EU' OR '1'='1` stays a value.

**Named queries** come from the catalogue (`db.queries`, one `NAME.sql` file per query; see [databases.md](databases.md)). A quoted *name* (letters, digits, `_ . -`) selects the catalogue; quoted SQL text runs as inline SQL. Values after `with` are bound to the query's `:name` binds: quoted values are text, bare numbers, `true`/`false` and `null` are typed, and `${var}` is the variable's value (a lone `${var}` keeps its type). `Expect query "NAME" ... returns N rows` is a step of its own (it runs the query) and keeps the rows under `query_NAME`. Column lookups ignore case, so `${row.customer_name}` reads Oracle's `CUSTOMER_NAME`. In YAML/JSON: `- query: OPEN_INVOICES` with `on:`, `with: { customer_id: 7 }`, `as:`, `capture: value | row | count`, `returns: 2` and `within: 30 seconds`, or the canonical `{ action: db, db: { connection, query, binds }, captureAs }`.

### Email and SMS

| Purpose | Examples |
|---|---|
| Read | `Get the latest email to "bob@shop.test" with subject "Welcome" as mail` · `Wait for an email to "bob@shop.test" within 30 seconds as mail` · `Get the latest SMS to "+15550100" as sms` |
| Extract | `Extract the link from mail matching "verify" as link` · `Extract the 6-digit code from ${sms} as otp` · `Extract "INV-\d+" from ${mail.text} as invoice` |
| Continue | `Open ${link}` · `Type "${otp}" into the Code field` |

Providers come from config (`email: { provider: sink }` starts EZTest's built-in SMTP server; `sms: { provider: twilio }` with secret references), or from `RunOptions.mail`/`RunOptions.sms`.

### Phone calls (voice)

| Purpose | Examples |
|---|---|
| Place / receive | `Place a call to "+15550100" and press "1w2" as ivr` · `Wait for a call to "+15550100" within 2 minutes and capture the spoken code as otp` · `Answer the next call as call` |
| Check | `Expect the call ivr to say "Press 1 for billing" then "Press 2 for support"` · `Expect the call ivr to have sent the digits "1w2"` · `Expect ${ivr.status} equals "completed"` |
| Continue | `Type "${otp}" into the Code field` · `Extract the 6-digit code from call as otp` |

A call value exposes `transcript`, `text` (spoken digits joined, so codes extract), `prompts`, `digits` and `status`. Provider from config (`voice: { provider: twilio, accountSid, authToken (secret://), from, allowedNumbers, transcripts }`) or `RunOptions.voice`. Outbound calls dial real phones, so only numbers on `allowedNumbers` may be called; transcripts come from the provider's own transcription or a deterministic local fixtures file (no third-party AI). See [messaging.md](messaging.md).

### Component stories

A journey with a `Story:` header runs against a single component story mounted in isolation on EZTest's own harness (`eztest stories`), with the visual and a11y lenses. `Variables:` / `Examples:` set the story's args. See [components.md](components.md).

### Messaging, gRPC, files, batch jobs, EDI and contracts

| Purpose | Examples |
|---|---|
| Publish | `Publish message from file "order.json" to Kafka topic "orders" on bus with key "${orderId}"` · `Send a message "hello" to RabbitMQ queue "greetings"` · `Publish ${order} to RabbitMQ exchange "orders" with routing key "order.created"` · `Publish '{"on":true}' to MQTT topic "lights/1" with QoS 1 retained` · `Put message '{"a":1}' on IBM MQ queue "DEV.QUEUE.1" with correlation id "c-1"` · `... with headers "type" = "created" ... as sent` |
| Listen before an action | `Start listening on Kafka topic "invoices" as invoices` · `Subscribe to MQTT topic "sensors/+/temp" as temps` · `Listen to RabbitMQ exchange "events" with routing key "order.*" as ev` · `Stop listening to invoices` |
| Wait and assert | `Wait for a message on Kafka topic "invoices" where "$.orderId" = ${orderId} within 30 s as invoice` · `Wait for a message in invoices where key = "42" and header "type" = "created" and correlation id = "c1" as m` · `... where payload contains "PAID" matching schema "schemas/invoice.json" ...` · `Wait for 3 messages on queue "jobs" as batch` · then `Expect response invoice "$.total" equals "99.5"` and `Capture "$.id" from invoice as invoiceId` |
| Expect nothing | `Expect no message on RabbitMQ queue "errors" within 5 s` · `Verify no messages arrive in errs where "$.level" = "ERROR"` (a step of its own) |
| Queues | `Purge RabbitMQ queue "orders.dlq"` |
| gRPC | `Call gRPC "shop.Orders/Get" on orders with '{"id":42}' as order` · `... with metadata "x-tenant" = "eu" with timeout 2 s ...` · `... expecting status NOT_FOUND as missing` · server streaming captures the list of messages |
| SFTP and folders | `Upload "batch.csv" to SFTP "partner" at "/in"` · `Wait for a file matching "ACK_*.csv" in "/out" on SFTP "partner" within 5 minutes as ack` · `Download "/out/ack.csv" from SFTP "partner" as ack` · `List files in "/out" on SFTP "partner" matching "*.csv" as files` · `Delete "/in/batch.csv" on SFTP "partner"` · `Copy "fixtures/x.edi" to folder "drop/in"` · `Wait for a file matching "*.ack" in folder "drop/out" within 30 s as ack` |
| SSH and batch jobs | `Run command "./close-day.sh 2026-01-31" on SSH "batch-host" as closing` (only allow-listed commands) · `... expecting exit code 3 ...` · `Run batch job "close-day" with date=${today} and wait up to 10 minutes as job` |
| EDI | `Read the file ack as EDI into edi` · `Load the EDI file "fixtures/850.edi" into po` · then `Expect response po "$.first.BEG.BEG03" equals "PO-1001"` and `Expect response po "$.valid" equals "true"` |
| Contracts | `Start a contract between consumer "shop-web" and provider "orders-api"` · `Given provider state "order 42 exists" with id=42` · `Finish the contract` (writes `contracts/<consumer>-<provider>.contract.json`, see [api-contracts.md](api-contracts.md)) |

A received message is captured as its payload (parsed JSON, or text) under the step's name, and its metadata (broker, destination, key, headers, correlation id, timestamp, partition/offset, routing key) under `<name>_meta`. gRPC calls capture the response (or the stream as a list) and `<name>_meta` with the status name. Files from SFTP or folders are captured like browser downloads, so `Read the download ack as rows into r` and document checks work on them. Brokers, gRPC services, SFTP servers, SSH hosts and batch jobs come from config; see [messaging.md](messaging.md). Contract sessions, provider verification and `eztest contracts ...` are in [api-contracts.md](api-contracts.md).

### Waits

Auto-wait remains the default: every action waits for its element. Explicit waits:

| Purpose | Examples |
|---|---|
| Loaders | `Wait for loaders to disappear` · `Wait for spinners ".busy", "#mask" to disappear within 10 s` (the waits.loaders config and the Loaders header also wait automatically before every action and check) |
| Load state | `Wait for the page to load` · `Wait for the network to be idle` · `Wait for the DOM content to load` |
| URL | `Wait until the URL contains "/dashboard"` · `Wait for the URL to match "/orders/\d+/"` |
| Element state | `Wait for the Save button to be enabled` · `Wait until the Spinner is detached` · `Wait for #banner to be removed` · `Wait for the Chart to be stable` |
| Text change | `Wait for the text of the Status label to change` · `Wait until the Status label changes from "Pending" and store it as status` |
| Any condition | `Wait until the Status field has value "Shipped" within 30 seconds checking every 1 second` · `Poll until ${count} > 3 every 500 ms` |

### Manual steps

A step a tester carries out and gives a verdict on (pass, fail, blocked, skip) in the Studio's guided runner or with `eztest run --manual prompt`. Indented `Expected:` and `Attachment:` lines belong to it; `Expect` lines under it are automated checks made after the verdict. In a journey with automated steps (hybrid) the run pauses there. See [manual-testing.md](manual-testing.md).

| Purpose | Examples |
|---|---|
| Manual step | `Manual: Check the printed invoice matches the order` · `Manual step: Phone the customer and confirm the address` |

### Keyboard operability

A step of its own (it drives Tab through the page), not a post-condition: it fails, naming elements, on unreachable elements, keyboard traps and missing focus indicators. See [coverage.md](coverage.md#keyboard-operability).

| Purpose | Examples |
|---|---|
| Page or element | `Verify the page is keyboard operable` · `Check that the "Checkout" region is keyboard accessible within 40 tabs` |

### Visual baselines

A step of its own, not a post-condition. It also starts with `Expect`, for example `Expect the Header to look like the baseline`. See [Visual assertions](#visual-assertions-element-or-page-against-a-baseline) for modes, keys, branches and grouping.

| Purpose | Examples |
|---|---|
| Element or page | `Verify the Header looks like the baseline` · `Check that the "Recent orders" table looks like baseline "orders-grid" in layout mode` · `Verify the page matches the baseline ignoring colors masking "testid=clock"` · `Verify the full page looks like baseline "home" at viewports 1280x720 and 375x667 with tolerance 0.5%` |

### Accessibility

A step of its own, not a post-condition, even when it starts with `Expect`. It runs EZTest's accessibility engine with the static rules and the dynamic checks (keyboard walk, reflow, text spacing); see [accessibility.md](accessibility.md).

| Purpose | Examples |
|---|---|
| Whole page or one element | `Check accessibility` · `Check the page for accessibility issues at WCAG 2.2 level AA` · `Check accessibility of the Checkout form without dynamic checks` · `Audit accessibility to level AAA including best practices` · `Scan for accessibility violations failing on critical issues` · `Expect the page to be accessible` |

### Variables and expressions

| Purpose | Examples |
|---|---|
| Set | `Set variable total to ${price} * ${qty}` · `Set var greeting = upper(name)` · `Set ${due} to addDays(today(), 3)` · `Let label = "ORD-" + id` · `Calculate net as round(gross / 1.19, 2)` · `Increment count` · `Decrease stock by 2` |

Expressions are parsed by a small, safe evaluator, never by JavaScript. They support numbers, quoted text (with `${var}` inside), variables (`order.lines.0.sku`, `items[1]`), lists `[1, 2]`, `+ - * / %`, comparisons `== != < <= > >=`, `and or not`, `contains`, `in`, `matches`, `startsWith`, `endsWith`, and `cond ? a : b`. `+` adds when both sides are numbers (or numeric text) and joins text otherwise. Functions: `today now addDays addHours addMinutes addMonths daysBetween format formatNumber upper lower trim len substring replace split join concat contains startsWith endsWith padStart number int string round floor ceil abs min max sum random randomString uuid first last at keys pluck json parseJson match isEmpty coalesce range`.

### Shared data (see [shared-data.md](shared-data.md))

| Purpose | Examples |
|---|---|
| Shared store | `Save ${orderId} to the shared store as "pending-order"` · `Save ${orderId} to the shared store as "pending-order" for 2 days in namespace "sit"` · `Save ${token} to the shared store as "api-token" as a secret for the pipeline` · `Load "pending-order" from the shared store as orderId` · `Load "pending-order" from the shared store as orderId or use "ORD-0"` · `Delete "pending-order" from the shared store` |
| Data pools | `Add ${policy} to pool "approvable-policies"` · `Fill pool "approvable-policies" from "data/policies.csv" column "policyNo"` · `Take one item from pool "approvable-policies" as policy` · `Take one item from pool "accounts" as account and keep it` · `Expect pool "approvable-policies" has at least 3 items` |

### Flow control and reuse

```text
If the "Accept cookies" button is visible then
  Click the "Accept cookies" button
Otherwise if ${count} > 2 then
  Press Tab
Otherwise
  Press Escape
End

Repeat 3 times
  Press Tab
End

For each row in data "fixtures/users.csv"          # csv, tsv, json, xlsx (sheet "Name")
  Type "${row.email}" into the Email field
End

For each order in ${orders.body}
  Expect ${order.status} equals "Open"
End

While the "Load more" button is visible at most 20 times
  Click the "Load more" button
End

Retry up to 3 times every 2 seconds
  Click the "Refresh" button
    Expect the Status field has value "Done"
End

Try
  Click the "Dismiss" button
On failure
  Press Escape                                      # ${error} holds the failure message
End

Group "Checkout"
  Run journey "pay-by-card" with amount=10 and store the result as payment
End
```

| Purpose | Examples |
|---|---|
| Branch | `If <condition> then` · `Unless <condition> then` · `If ${count} > 3:` · `Otherwise` · `Otherwise if <condition> then` · `End` |
| Loop | `Repeat 3 times` · `Repeat ${n} times as i` · `For each item in ${items}` · `For each row in data "users.csv"` · `For each user in data "users.xlsx" sheet "Team"` · `While <condition> at most 20 times` · `Repeat until <condition>` |
| Recover | `Retry up to 3 times` · `Retry the following up to 5 times every 2 seconds` · `Try` · `On failure` |
| Organise | `Group "Checkout"` · `Run journey "login-and-open-orders" with role=manager` · `Run the "Fill name" journey with who="Ada" and store the result as filled` · `Include journey "accept-cookies"` · `Run code "steps/billing.steps.ts#settleOverdue" with region="EU" as result` (TypeScript using the EZTest SDK, see [sdk.md](sdk.md)) |
| One-liners | `If the "Accept cookies" button is visible then click the "Accept cookies" button` · `Repeat 3 times: press Tab` · `For each item in ${items}: type "${item}" into the Search field` · `In the "payment" frame: type "4242" into the Card number field` |

Conditions are any expectation phrasing or an expression. Every block ends with `End` (`End if`, `End repeat`, `Done` also work). `While` stops with a failure after its cap (default 100). Loop variables (`row`, `item`, `index`) are unbound after the loop. Results keep the nesting: block steps carry their children (with iteration numbers), and the HTML report shows them indented.

**Sub-journeys.** A journey with `Params:` and `Returns:` headers (tag it `@library` so `eztest run` does not run it on its own) can be called by id, name or file. It runs in the same browser with its own variables; its `Returns:` values come back into the caller (or as one record with `and store the result as`). **Hooks** (`hooks.beforeAll/beforeEach/afterEach/afterAll` in config, or `RunOptions.hooks`) are journeys too: before/after each run inside each journey's browser context.

**Data-driven journeys.** An `Examples:` table runs the journey once per row; the row's values are variables, and `<column>` placeholders in the name and steps are replaced:

```text
Journey: Search for <term>
Open /search
Type "<term>" into the Search field
  Expect the page contains "${expected}"

Examples:
  | term   | expected  |
  | laptop | 3 results |
  | desk   | 1 result  |
```

**External Examples.** The rows can come from a data file (JSON, CSV/TSV or XLSX) or a named query, read when the run starts. One journey instance runs per matching row, exactly as with an inline table:

```text
Examples: from data "data/orders.json" path "$.orders" where (scenarioId = ORD_01 or scenarioId = ORD_02) and runFlag = Yes
Examples: from data "data/users.xlsx" sheet "Active" where region = EU and age >= 18
Examples: from query "OPEN_ORDERS" on shop with region="EU" where status != closed
```

- Paths are relative to the project directory (where `eztest run` runs). `path` is a JSONPath to the row list; `sheet` picks a worksheet.
- The `where` filter compares columns with `=`, `!=`, `>`, `<`, `>=`, `<=` and `~` (contains), combined with `and`, `or`, `not` and parentheses (`and` binds tighter than `or`). Column names match case-insensitively; `=`, `!=` and `~` compare text case-insensitively, and numbers numerically. Quote values with spaces; `${var}` in a value is a run variable.
- `from query` rows come from the named-query catalogue (`db.queries`, see [databases.md](databases.md)) through the run's data-source resolver (`RunOptions.dataSourceResolver`).
- In YAML/JSON journeys: `examples: { from: data/orders.json, path: $.orders, where: "runFlag = Yes" }` or `examples: { query: OPEN_ORDERS, on: shop, with: { region: EU } }`.
- A source that yields no rows (or a missing file) does not run its journey: the run reports it as skipped with the reason. `eztest validate` checks sources before a run: missing files (error), filters that match nothing or name unknown columns, and placeholder values such as `REPLACE_WITH_*` left in the matched rows (`--placeholder <regex>` changes the pattern).

### Actors (several users in one journey; see [multi-actor.md](multi-actor.md))

```text
Actors: alice, bob as chat-user
As alice:                                   # the lines below run in alice's own browser context
  Open /chat
As bob: click the "Join the chat" button    # one step as bob
In parallel:                                # branches at the same time, closed by End
  As alice:
    Click the "Send" button
  As bob:
    Expect the page contains "alice: Hi"
End
Switch to user "alice"                      # also: Switch to actor alice, Continue as alice
```

### Desktop and legacy apps

These open a non-browser surface. While it is active, the ordinary phrasings (Click, Type into, Select, Check, Press, Read, Expect) act on it. See [desktop-and-legacy.md](desktop-and-legacy.md).

| Surface | Examples |
|---|---|
| Mainframe (TN3270) | `Connect to mainframe "cics"` · `Log on to the mainframe as "clerk"` · `Type "ACCT01" in field at row 5 column 20` · `Type "LOGOFF" at the cursor` · `Press PF3` · `Press PA1` · `Press Clear` · `Read the field at row 6 column 22 as name` · `Expect the field at row 8 column 22 to be "ACTIVE"` · `Disconnect from the mainframe` |
| IBM i (TN5250) | `Connect to IBM i "ez400"` · `Sign on to the IBM i as "clerk"` · `Press F3` · `Press Field Exit` · `Press Field+` · `Press Page Down` (Roll Up) · `Press Reset` · `Press Help` · `Press SysReq` · `Sign off from the IBM i` · `Switch to the IBM i` — plus every TN3270 phrasing (the field/row-column, read and expect lines are shared) |
| Windows and Java apps | `Launch the desktop app "invoice"` · `Launch the Java app "ledger"` · `Launch the Electron app "main.js"` · `Attach to the "Invoice Manager" window` · `Choose "File > Save As" from the menu` · `Expect the "Save As" window to be open` · `Choose "C:\data\orders.csv" in the file dialog` · `Read cell row 2 column "Amount" of the "Invoices" grid as amount` · `Expect cell row 2 column "Status" of the "Invoices" grid to be "Paid"` · `Set cell row 1 column "Qty" of the "Lines" grid to "3"` · `Expand "Customers > Europe" in the "Accounts" tree` · `Close the desktop app` |
| SAP GUI | `Connect to SAP "ERP"` · `Log on to SAP "ERP"` · `Run transaction "VA01"` · `Set SAP field "Sold-To Party" to "1000"` · `Press SAP button "Save"` · `Expect the SAP status bar to contain "has been saved"` · `Expect the SAP status bar to be a success message` · `Capture the number from the SAP status bar as orderNumber` · `Set cell row 1 column "Material" of SAP table "All Items" to "M-01"` · `Read cell row 1 column "Net Value" of SAP table "All Items" as net` |
| Image and OCR (Citrix/VDI, canvas) | `Connect to Citrix "desk1"` · `Use the browser page as the screen` · `Use the desktop app window as the screen` · `Use the screen image "fixtures/screen.png"` · `Click the image "citrix/ok-button.png"` · `Double-click the image "row.png"` · `Click the text "Submit" on screen` · `Click at 120,340 on screen` · `Read the text in region 10,20,300,40 as total` · `Read the screen text as screenText` · `Expect the image "citrix/logo.png" on screen` · `Wait for the image "citrix/ready.png" on screen within 60 seconds` · `Type "invoice 42" on screen` |
| Any surface | `Wait for the screen to contain "READY"` · `Read the "BALANCE" field as balance` · `Take a snapshot of the screen` · `Switch to the browser` · `Switch to the mainframe` |

### Mobile (native apps; see [mobile.md](mobile.md))

| Purpose | Examples |
|---|---|
| Gestures | `Swipe up until "Settings" is visible` · `Scroll down until the "Help" item is visible at most 5 times` · `Long press the "Photo" image for 2 seconds` · `Pinch out on the Map` · `Zoom in on the Map` · `Swipe from 200, 700 to 200, 200` · `Tap at 120, 640` |
| Device | `Rotate to landscape` · `Press the device back button` · `Press the device home button` · `Hide the keyboard` · `Lock the device for 2 seconds` · `Unlock the device` · `Open the notifications` · `Shake the device` · `Accept the system alert` · `Dismiss the permission dialog` |
| Apps | `Put the app in the background for 3 seconds` · `Bring the app to the foreground` · `Activate the app "com.shop.app"` · `Close the app` · `Restart the app` · `Install the app "apps/shop.apk"` · `Uninstall the app "com.old.app"` · `Open the deep link "shop://orders/42"` |
| Contexts | `Switch to the web view` · `Switch to the web view "WEBVIEW_com.shop.app"` · `Switch to the native app` |
| Files, permissions, network | `Push file "fixtures/a.jpg" to "/sdcard/a.jpg"` · `Pull file "/sdcard/report.pdf" from the device as report` · `Grant the app permission "android.permission.CAMERA"` · `Revoke the app permission "camera"` · `Turn on airplane mode` · `Turn off wifi` · `Turn on mobile data` |

On a device, the usual phrasings work natively: `Tap the "Log in" button`, `Type ... into ...`, `Go back`, `Press Enter`, `Open "shop://cart"` (a deep link) and `Expect the screen to contain "ORD-"`.

## Expectations (72 phrasings)

| Checks | Examples |
|---|---|
| Screen text (any surface) | `the screen contains "ACCOUNT FOUND"` · `the screen does not contain "ERROR"` · `Expect the screen to contain "READY"` |
| Captured values | `${mail.text} contains "approved"` · `${status} does not contain "Error"` |
| Page text | `the page contains "Saved"` · `the page does not contain "Error"` · `I see "Welcome"` · `I do not see "Error"` · `the text "Saved" is visible` |
| URL and title | `the URL contains "/orders"` · `the URL does not contain "/login"` · `the URL matches "orders/\d+"` · `the URL is "/dashboard"` · `the title contains "Orders"` |
| Elements | `the Save button is visible` · `the spinner is hidden` · `the Status field has value "Open"` · `the value of the Total field is "10.00"` · `the Heading has text "Orders"` · `the "Order created" toast contains "created"` |
| States | `the Save button is enabled` · `the Save button is disabled` · `the Name field is editable` · `the Reference field is read-only` · `the Search field is focused` · `the Terms checkbox is checked` · `the Terms checkbox is not checked` · `the Footer section is in the viewport` · `the Notes field is empty` · `the Chart is stable` · `the Spinner is detached` |
| Attributes, CSS, classes | `the "Docs" link has attribute "href"` · `the "href" attribute of the "Docs" link is "/docs"` · `the "class" attribute of #x contains "on"` · `the Name field does not have attribute "disabled"` · `the CSS "color" of #badge is "rgb(200, 0, 0)"` · `#badge has class "active"` · `#badge does not have class "inactive"` |
| Regex | `the text of the Order number matches "^ORD-\d+$"` · `the value of the Phone field matches "\d{3}-\d{4}"` · `the title matches "^Orders \d+"` · `the page text matches "/ord-\d{4}/i"` · `the page does not match "Error \d+"` |
| Negations | `the Status field does not contain "Error"` · `the Total does not have text "0.00"` · `the Quantity field does not have value "0"` |
| Accessible name, description, role | `the Save button has accessible name "Save order"` · `the accessible name of the Save button matches "^Save"` · `the Help link has accessible description "Opens the guide"` · `the accessible description of the Help link contains "guide"` · `the Terms box has role "checkbox"` · `the role of #badge is not "button"` |
| Aria snapshots | `the "Order summary" region matches the aria snapshot "order-summary"` · `the page matches the aria snapshot "snapshots/home.aria.yml"` (see [Aria snapshots](#aria-snapshots)) |
| Counts | `there are 2 rows in the Orders table` · `the Orders table has 2 rows` · `the Results list has 5 items` · `the number of Order rows is 3` · `there are more than 3 rows in the Orders table` · `the Orders table has at least 3 rows` · `there are fewer than 10 css=li` · `there are between 2 and 5 rows in the Orders table` · `the number of css=li is greater than 2` |
| Sort order | `css=td.name are sorted ascending` · `the "Price" column of the Products table is sorted descending` · `... sorted ascending numerically` |
| Tabs, dialogs | `there are 2 tabs open` · `a dialog saying "Saved"` · `an alert saying "Order saved"` · `a prompt dialog appeared` |
| Console | `there are no console errors` · `there are no JavaScript errors` · `the console has no warnings` · `there are at most 2 console warnings` · `the console contains "loaded"` · `the console has errors containing "CSP"` |
| Network | `a request was made to "/api/orders"` · `a POST request was sent to /api/orders with body containing "qty"` · `a request was made to "/api/orders" with header "x-trace" = "abc"` · `no request was made to "/analytics"` · `the request to /api/orders contains "Gadget"` · `a websocket message containing "pong" was received` · `websocket feed received "pong"` |
| Captured values | `${orderTotal} equals "148.50"` · `the captured value total is "148.50"` · `${total} > 100` · `len(orders.body) == 3 and orders.status == 200` · `the expression "len(items) >= 1" is true` |
| API contracts | `response orders conforms to OpenAPI "specs/shop.yaml"` · `response order conforms to the API spec operation "getOrder"` (uses api.spec) · `response order complies with the API contract` |
| API, DB, files | `the orders response status is 200` · `the status of orders is 200` · `response orders matches schema "schemas/orders.json"` · `response orders "$[0].total" is greater than 10` · `response orders has "$[0].id"` · `the orders response took less than 500 ms` · `the query rows returns 3 rows` · `the query rows returns more than 2 rows` · `the download invoice exists` · `the download invoice is named "INV-1.pdf"` |
| Cookies, storage | `cookie "theme" is "dark"` · `cookie "session" does not exist` · `local storage "cart" is "[]"` · `session storage has "step"` |
| Locale-aware values, layout direction | `the Total shows the amount "1234.50" in EUR for locale de-DE` · `testid=units shows the number "1234567.891"` · `the Due date shows the date "2026-03-01"` · `the page is right-to-left` · `the Sidebar is left-to-right` (see [reliability.md](reliability.md#9-locale-time-zone-rtl)) |

Assertion-library phrasing works too: `Expect the page to contain "Saved"`, `Expect the spinner not to be visible`, `Expect the URL to have "/x"`, `Expect the Save button to be disabled`.

### Aria snapshots

An aria snapshot is the accessibility tree of an element or of the page, written as YAML. EZTest's page engine computes it with accname 1.2 names and HTML-AAM roles:

```yaml
- region "Order summary"
  - heading "Order summary" [level=2]
  - list "Lines"
    - listitem
  - button "Confirm order"
```

`… matches the aria snapshot "order-summary"` compares the element with `.eztest/aria/order-summary.aria.yml`. A name ending in `.yml` or `.yaml` is a file relative to the project. In YAML and JSON journeys, an inline `snapshot:` works too. The match is **partial and ordered**:

- every node in the baseline must appear, in that order, with its children inside it;
- nodes that are not in the baseline are ignored;
- a node without a name matches any name, and a `/regex/` name matches by pattern;
- `[level=2]`, `[checked=true]`, `[expanded=false]`, `[disabled]` and `[selected]` must match when given;
- `text "…"` matches a substring.

When a node is missing, the failure names it (`missing - button "Confirm order"`) and shows a diff of the baseline against the actual tree. When there is no baseline yet, the step fails and prints the actual snapshot. `eztest run --update-snapshots` writes or rewrites the baselines and passes. The next run compares against them.

## How targets are found

A description like `the "Sign in" button` becomes an ordered list of locators: role `button` named "Sign in", then the text "Sign in", and so on. Only a locator that matches **exactly one** element is used. When none does, the verified healing ladder runs:

1. **T0 cache:** the last locator that worked and was verified.
2. **T1 fingerprint:** compares a stored element fingerprint (role, name, text, id, classes, label, position and more) against the current page, with an ambiguity margin.
3. **T2 semantic:** matches the description words against accessible names and labels.

You can also give an exact selector: `#id`, `css=…`, `xpath=…`, `testid=…`, `text=…` or `role=button[name="Save"]`; on native apps also `accessibility id=…` (or `~…`), `id=…` (resource id), `class=…` and `predicate=…` (iOS). Targets resolve in the current tab and frame; healing searches there too.

### Relative and scoped targets

When a label repeats (an Edit button in every row, the same fields in a billing and a shipping block), say where the element is instead of falling back to XPath:

| Phrase | Meaning |
|---|---|
| `in the row containing "Acme"` · `in the "Acme" row` · `on the row with "Acme"` | Inside the table row, list item or repeated card (an element repeated among its siblings) that contains the text |
| `inside the "Billing" section` · `in the "Billing" section` · `in the "Confirm" dialog` · `in the Orders table` · `inside #billing` | Inside a container: a landmark or group with that accessible name, a fieldset with that legend, or an element whose first heading has the text and holds more than it |
| `below "Email"` · `above "Total"` · `right of the "Qty" label` · `to the left of "Ref"` | The closest matching element on that side of the anchor. Aligned elements win: the off-axis gap counts three times. |
| `near "Total"` · `next to "Search"` · `within 20px of "Search"` | The closest matching element within 50 px (or the distance given) |
| `the 2nd "Delete" button` · `the third "Edit" button` · `the last row` | One match by position. Word ordinals apply only before a quoted name or a kind word, so `the first name field` is still the "first name" field. |

Scopes combine, and the last phrase is the outermost one. For example, `the field below "Email" inside the "Billing" section` finds the Billing section, then "Email" inside it, then the field below that. Every container, row and anchor must match **exactly one** element. When an anchor matches more, the step fails and says so (`anchor "Email" matched 2 elements`); EZTest never guesses. A container or row that is missing is named in the failure.

Healing works inside the scope. The element is healed within its resolved container, and the layout filters and the ordinal still apply. A renamed container or anchor (a table whose name changed) climbs the healing ladder with its own memory (`<step>~scope<n>` in the fingerprint store). Either kind of heal counts only when the step's expectations hold. An ambiguous anchor is never healed.

In YAML and JSON, a string step uses the same phrases. A structured target can list its scopes too: `scope: [{ relation: within, anchor: { description: …, locators: […] } }, { relation: below, anchor: … }]`, with `relation` set to `within`, `row` (with `text`), `above`, `below`, `leftOf`, `rightOf` or `near` (with an optional `maxDistance`), plus `nth`. In code, use `ui.click('the "Edit" button in the row containing "Acme"')`, or the helpers `within()`, `inRow()`, `below()`, `above()`, `rightOf()`, `leftOf()`, `near()` and `nth()` (see [sdk.md](sdk.md)). The browser driver offers the same through `locator.below(anchor)`, `rightOf`, `near`, `getBySection(text)`, `getByRow(text)` and the selectors `section="Billing"` and `row="Acme"`.

### Shared elements

`the @Checkout.placeOrder button` (or `@Checkout.placeOrder`) uses an element from the shared element repository (`elements/*.yaml`, or SDK and imported screens). A description that equals an element's description or one of its aliases uses it too. The repository's locators come first. The element keeps one fingerprint and one verified heal for every journey that uses it. Accepting a heal in the Quality Center rewrites the element entry, after showing a diff, so every journey is fixed at once. See [elements.md](elements.md).

A described element can carry its own ordered selectors: `Click the "Sign in" button at xpath=//form//button[@type='submit'] or css=#login-btn or text="Sign in"`. The quoted description names the element (reports, healing); the selectors after `at` are tried in order. Importers use this to keep a page object's locators and its alternatives.

## Visual assertions (element or page against a baseline)

A visual assertion is a step of its own, not a post-condition of the line above. It compares one element, the viewport or the full page with a baseline:

```text
Expect the Header to look like the baseline
Expect the "Recent orders" table to look like baseline "orders-grid" in layout mode
Expect the page to match the baseline ignoring colors masking "testid=clock" and "#ad-slot"
Verify the full page looks like baseline "home" at viewports 1280x720 and 375x667 with tolerance 0.5%
Expect testid=summary to look like the baseline in content mode
Expect the Logo to look like the baseline keyed by browser version
```

| Part | Meaning |
|---|---|
| subject | An element description (`the Header`, `testid=summary`, `the "Main" navigation`): only that element is captured. `the page` / `the screen` captures the viewport, `the full page` the whole scrollable page. |
| `baseline "name"` | The baseline name. Default: `<journey id>-<step id>`. |
| `in strict mode` (default) | Pixels, with anti-aliased pixels tolerated. `with strict anti-aliasing` counts them too. `with threshold 0.2` sets the per-pixel colour threshold (0..1). |
| `ignoring colors` / `in ignore-colors mode` | Grayscale edge maps compared with a one-pixel tolerance. A colour change that keeps the shapes passes; moved, added or removed shapes fail. |
| `in layout mode` | Compares element boxes from the DOM snapshot kept with the baseline (default tolerance 2 px; `with tolerance 3 px`). Text, colours and fonts are ignored, and so is a renamed CSS class. |
| `in content mode` | Compares the text of every element, plus the ignore-colors image check. |
| `masking "sel", "sel"` | Dynamic content (clocks, ads, ids) is painted out in both images, and DOM changes inside it are ignored. `testid=x`, CSS, `text=` and `xpath=` selectors work. Saved ignore regions (`masks.json`, drawn in Studio) apply too. |
| `at viewports 1280x720 and 375x667` | One assertion, several viewports. Each viewport has its own baseline, and the original viewport is restored. |
| `with tolerance 0.5%` / `with tolerance 20 px` | Allowed differing pixels (ratio or count). |
| `keyed by browser version` | Baselines are keyed by browser *version* as well as browser and viewport. |

**Baselines** live in `.eztest/baselines/` as `<name>--<browser>--<width>x<height>.png`, with a DOM snapshot next to each in `.dom.json`. A Firefox or WebKit run never compares against a Chromium baseline. With `keyed by browser version`, a browser update finds no baseline for the new version and falls back to the same browser's closest version. The result says so (`baseline from chromium 140: a browser update; re-approve to key ...`). Run `eztest run --update-baselines` to write baselines, or approve actual screenshots in Studio.

**Branches.** On a git branch other than main, master, trunk or develop, new and approved baselines go to `.eztest/baselines/branches/<branch>/`. They shadow the main set for that branch only. `EZTEST_BASELINE_BRANCH` overrides the branch read from `.git/HEAD`. After the feature branch is merged:

```bash
eztest visual branches                 # list branch baselines
eztest visual merge feature/new-header # copy them into the main set (recorded in .eztest/approvals/)
```

**Why did it change?** Every failure groups the differing pixels by the DOM change behind them. The comparison diffs the DOM snapshots taken with both screenshots and matches elements by tag, id or test id, and position (classes are ignored). Each change is collapsed into the highest element it explains, and changes with the same signature are grouped:

- `background-color changed rgb(31, 111, 235) -> rgb(45, 164, 78) on 2 elements: button#save, button#cancel`: one CSS rule, one finding;
- `div#summary moved by 0, 40 px (with 3 descendants)`: the panel's children are not listed separately;
- `span#total text changed from "10.00" to "12.00"`;
- `tr added`, `img#logo resized by 0, 8 px`;
- `pixels changed inside canvas#chart (no DOM change: image, canvas, font or rendering)`: pixels no DOM change explains.

A group has a stable id. The same CSS change seen in several screenshots, steps or viewports is one group in Studio (Assurance > Visual diff), and **Approve group** approves all its baselines in one action. The action is recorded in the approvals evidence vault.

## Components (45 phrasings)

Phrasings for the widgets component libraries render: data grids (virtualized, paged, with pinned or reordered columns), combo boxes and multi-selects with body-level popups, date pickers, trees, tabs, accordions, stacked dialogs, toasts, rich-text editors, sliders, masked inputs, drop zones, canvas charts and infinite lists. They are part of the action count above (category "Components" in the Studio palette). Each names the widget kind ("… grid", "… combobox", "… date picker", "… tree", "… editor", …), so ordinary lines keep their meaning: `Choose Contoso Ltd in the Customer dropdown` is still a native select, and `Expect the Orders table to have 2 rows` is still a post-condition.

At run time EZTest finds the widget (the role or region named like the description, its label, its aria-label, or the section a heading of that name introduces), then detects which library renders it (ag-Grid, MUI, Kendo UI, DevExtreme, PrimeNG, PrimeFaces, Angular Material, Oracle JET, SAP UI5, Salesforce Lightning, Dynamics 365, WAI-ARIA, native) and uses that library's adapter. The same sentence works for all of them. Rows are always found by their cell values, never by position; a row condition must match exactly one row unless you say "the first row". `Expect …` component lines are steps of their own (they read the widget), not post-conditions. See [components.md](components.md) for the adapters, the function API and what was tested against which library.

### Grids

| Purpose | Phrasings |
|---|---|
| Click a row by its values | `In the Orders grid, click the row where Customer is "Contoso" and Status is "Open"` · `Click the row where Id is "42" in the Orders grid` · `Double-click the row where Id is "42" in the Orders grid` |
| Act inside a row | `In the Orders grid, click "Edit" in the row where Id is "42"` · `Expand the row where Id is "42" in the Orders grid` |
| Edit a cell (verified by reading it back) | `Edit the Amount of the row where Id is "42" in the Orders grid to 150` · `Set the "Order date" of the row where Id is "42" in the Orders grid to "2027-01-01"` |
| Read and check cells | `Capture the Amount of the row where Id is "42" in the Orders grid as amount` · `Expect the Amount of the row where Id is "42" in the Orders grid to be "150.00"` |
| Count rows (all pages, all virtualized rows) | `Expect the Orders grid to have 3 rows where Status is "Open"` · `Expect the Orders grid to have at least 2 rows where Region is not "EU"` · `Expect the Orders grid to have a row where Id is "7"` · `Expect the Orders grid to have no rows where Status contains "hold"` |
| Sort, filter, select | `Sort the Orders grid by Amount descending` · `Filter the Orders grid where Region is "EU"` · `Select the rows where Status is "Open" in the Orders grid` · `Select the row where Id is "7" in the Orders grid` |
| Read everything (scrolls virtualized content, pages through paged grids) | `Capture all rows of the Orders grid as orders` · `Capture all rows of the Orders grid where Status is "Open" as open` |
| Order and columns | `Expect the Orders grid column Amount is sorted descending` · `Expect the Amount column of the Orders grid to be sorted ascending` · `Expect the Amount column of the Orders grid to be sorted descending` · `Expect the Orders grid to have columns "Id", "Customer" and "Amount" in this order` |
| Scroll | `Scroll the Orders grid to the row where Id is "9500"` |

Row conditions: `Column is "value"` (numbers compare as numbers, so `150` matches `150.00` and `$150.00`), `is not`, `contains`, `starts with`, `ends with`, `matches`, `>`, `>=`, `<`, `<=`, `is empty`, `is not empty`, joined with `and`. Quote column names that contain spaces and an operator word.

### Combo boxes, dates, trees, tabs and accordions

| Purpose | Phrasings |
|---|---|
| Choose options (type-ahead, async options, popups at body level, multi-selects) | `Choose "Berlin" in the City combobox` · `Choose "Logistics", "Sales" in the Skills multi-select` · `Pick "Acme" from the Customer lookup` · `Choose "Germany" in the Country select box` |
| Check a combo box | `Expect the City combobox to show "Berlin"` |
| Pick a date (calendar first, typing as fallback, page locale formats) | `Pick 15 March 2027 in the Due date picker` · `Pick 2027-03-15 in the Due date picker by typing` · `Pick 2027-03-15 in the Due date picker using format "dd.MM.yyyy"` · `Pick 2027-01-05 in the Due date picker using the calendar` · `Set the Due date picker to tomorrow` · `Set the Due date picker to 2027-03-15` |
| Check a date | `Expect the Due date picker to show 15 March 2027` |
| Trees | `Expand "Europe > Germany" in the Regions tree` · `Collapse "Europe" in the Regions tree` · `Select "Europe > Germany > Berlin" in the Regions tree` · `Expect "Europe > Germany" in the Regions tree to be expanded` · `Expect "Europe > Germany > Berlin" in the Regions tree to be visible` |
| Tabs | `Open the "Billing" tab in the Settings tabs` · `Expect the "Billing" tab in the Settings tabs to be selected` |
| Accordions | `Expand the "Shipping" section in the Details accordion` · `Collapse the "Shipping" section in the Details accordion` |

Dates can be written `15 March 2027`, `March 15, 2027`, `2027-03-15`, `15.03.2027`, `today`, `tomorrow`, `today + 3 days` or `in 2 months` (and `${due}`); slashed dates are accepted only when unambiguous.

### Dialogs, toasts, editors and other widgets

| Purpose | Phrasings |
|---|---|
| Stacked modals (the top dialog is the one in front) | `In the "Confirm delete" dialog, click "Delete"` · `In the top dialog, click "OK"` · `Close the "Confirm delete" dialog` · `Close the top dialog` |
| Check dialogs | `Expect the "Confirm delete" dialog to be open` · `Expect the "Confirm delete" dialog to be closed` · `Expect 2 dialogs to be open` |
| Toasts that vanish (recorded from the moment they are watched) | `Watch for toasts` · `Expect a toast containing "saved"` · `Expect a toast saying "Order saved"` · `Expect no toast containing "error"` |
| Rich-text editors (contenteditable, Quill, CKEditor, TinyMCE in its iframe) | `Type "Hello" in the Notes editor` · `Append " and goodbye" to the Notes editor` · `Clear the Notes editor` · `Expect the Notes editor to contain "Hello"` · `Expect the Notes editor to be empty` |
| Sliders | `Set the Price slider to 40` · `Set the Price range slider to 20 and 80` · `Expect the Price slider to be 40` |
| Masked inputs (typed keystroke by keystroke) | `Type "4111111111111111" into the Card number masked input` |
| Drop zones (file input when there is one, else a real drop event) | `Drop "fixtures/po.pdf" onto the Attachments drop zone` · `Upload "a.pdf" and "b.csv" to the Uploads drop zone` |
| Canvas charts (Chart.js, ECharts, Highcharts instances, else an accessible data table) | `Expect the chart Revenue to have 12 points` · `Expect the Revenue chart series "2025" to have 12 points` · `Expect the Revenue chart value for "Mar" to be 101` · `Capture the data of the Revenue chart as revenue` |
| Infinite lists (scrolled until they stop growing, bounded) | `Capture all items of the News feed as items` · `Capture all items of the News feed up to 100 as items` · `Expect the News feed to have 250 items in total` · `Capture all items of the Feed list as items` · `Expect the Feed list to have 250 items in total` |

Scans of virtualized or paged content are bounded: 60 seconds by default, or the step's `timeout=` when it is longer (`Capture all rows of the Orders grid as orders [timeout=3m]`). A scan that hits the bound fails and says how many rows it read.

## Salesforce phrasings (with a `salesforce:` config block)

| Phrasing | What it does |
|---|---|
| `Log in to Salesforce as rep` | Form login as a configured user (password from secrets) |
| `Open the Accounts tab` · `Open the Account "Acme"` · `Create a new Opportunity` | Navigation, record lookup by name, the New modal |
| `Set Salesforce field "Industry" to "Energy"` · `Set "Stage" to "Prospecting" on the record` | Fields by label, through shadow DOM: text, currency, date, checkbox, picklist, dependent picklist |
| `Set lookup "Account Name" to "Acme"` | Type-ahead lookup, strict: "Acme" never matches "Acme Holdings" |
| `Save the Salesforce record` · `Save the Salesforce record and expect the error "…"` · `Cancel the Salesforce record` | Save with toast, field-error and page-error detection, or a negative test |
| `Mark the stage as complete` · `Expect the path stage to be "Qualification"` | Opportunity path |
| `Expect Salesforce field "Stage" to be "Prospecting"` · `Expect field "Annual Revenue" to be read-only` · `Expect Salesforce field "Employees" to be hidden` | Field values and field-level security as the user sees it |
| `Expect the toast to contain "was created"` · `Expect the Accounts list view to contain "Acme"` · `Expect the related list "Contacts" to contain "Jane Doe"` · `Expect the Cases tab to be hidden` | Lightning UI checks |
| `Verify in Salesforce that Account "Acme" has Industry = "Energy"` | SOQL cross-check through the metadata-validated builder |

When both the Dynamics 365 and Salesforce add-ons are enabled, generic lines such as `Open the Account "X"` go to whichever add-on registers first; write `Open the Salesforce Account "X"` to be explicit.

## Packaged-app phrasings (73 phrasings, with `sap:`, `servicenow:`, `workday:`, `oracle:` or `powerapps:` config blocks)

Each pack registers its phrasings only when its config block is present. Every phrasing names its platform: Fiori (or SAP OData), ServiceNow, Workday, Oracle (or Oracle Fusion or Oracle EBS), or Power Apps (or Power Fx). So the packs never compete with each other, with the D365 and Salesforce add-ons, or with web lines.

For example, `Open the ServiceNow incident "INC0010001"`, `Open the Fiori list item "4711"`, `Open the Workday worker "Alex Jones"` and `Open the Oracle page "Purchase Orders"` all differ from D365's `Open the Account record "X"` and Salesforce's `Open the Account "X"`. Likewise, `Set Fiori field "…"` drives Fiori, while `Set SAP field "…"` stays with the SAP GUI rung.

The Power Apps pack reuses the D365 phrasing `Verify in Dataverse that account "X" has …`, and its handler. The pack contributes it only when there is no `d365:` block. All packs are tested against emulations of each product (`examples/<pack>-mock`), not real tenants.

| Pack | Count | Examples | Guide |
|---|---|---|---|
| SAP Fiori/UI5 | 15 | `Log in to SAP Fiori as clerk` · `Open the Fiori app "Manage Sales Orders"` · `Set Fiori field "Sold-To Party" to "17100002" using the value help` · `Save the Fiori object` · `Expect the Fiori message popover to contain "does not exist"` · `Verify in SAP OData that A_SalesOrder "4711" has SalesOrderType = "OR"` | [apps/sap.md](apps/sap.md) |
| ServiceNow | 17 | `Log in to ServiceNow as itil` · `Create a new ServiceNow incident` · `Set ServiceNow field "Caller" to "Abel Tuter"` · `Click the ServiceNow UI action "Resolve"` · `Order the ServiceNow catalog item` · `Verify in ServiceNow that incident "INC0010001" has state = "Resolved"` | [apps/servicenow.md](apps/servicenow.md) |
| Workday | 16 | `Open the Workday task "Hire Employee"` · `Set Workday field "Hire Date" to "2026-11-02"` · `Run the Workday related action "Job Change > Change Job"` · `Approve the Workday inbox item` · `Verify in Workday that worker "Ada Lovelace" has "Worker Status" = "Active"` | [apps/workday.md](apps/workday.md) |
| Oracle Fusion and EBS | 12 | `Log in to Oracle Fusion as buyer` · `Set Oracle field "Supplier" to "Lee Supplies"` · `Set Oracle table "Lines" row 1 column "Quantity" to "2"` · `Set Oracle field "Category" to "FURNITURE.CHAIRS" using the list of values` · `Verify in Oracle Fusion that purchase order "1002" has Supplier = "Lee Supplies"` | [apps/oracle.md](apps/oracle.md) |
| Power Apps canvas | 13 | `Open the Power Apps app "Account Manager"` · `Set Power Apps control "txtName" to "Contoso"` · `Select Power Apps control "btnSave"` · `In Power Apps gallery "galAccounts", select the item where "lblAccountName" is "Fabrikam"` · ``Expect Power Fx `CountRows(galAccounts.AllItems) = 3` `` | [apps/powerapps.md](apps/powerapps.md) |

## YAML and JSON

The same journey as YAML. Steps can be plain-English strings, or objects with overrides:

```yaml
id: login
name: Sign in
tags: [smoke]
steps:
  - Open /login
  - Type "bob" into the Username field
  - intent: Click the "Sign in" button
    expect: ['the URL contains "/dashboard"']
```

Blocks nest with `steps:` (and `else:` / `catch:`), or with readable sugar:

```yaml
steps:
  - if: the "Accept cookies" button is visible
    then: [Click the "Accept cookies" button]
    else: [Press Escape]
  - repeat: 3
    steps: [Press Tab]
  - forEach: ${orders.body}
    as: order
    steps: ['Expect ${order.status} equals "Open"']
  - forEach: { data: fixtures/users.csv, as: user }
    steps: ['Type "${user.email}" into the Email field']
  - while: the "Load more" button is visible
    max: 20
    steps: [Click the "Load more" button]
  - retry: 3
    steps: [Click the "Refresh" button]
  - try: [Click the "Dismiss" button]
    onFailure: [Press Escape]
  - frame: [outer, inner]
    steps: [Click the "OK" button]
  - runJourney: login
    with: { role: manager }
    as: session
```

The canonical JSON form is the Step model itself (`action: if`, `flow: { condition | expr | times | items | data | as | maxIterations | attempts }`, `steps`, `else`, `catch`), so existing flat journeys stay valid and every block round-trips between `.ez`, YAML and JSON. Convert between the formats with `eztest convert file.ez --to yaml`.

Component steps are `action: component` with the widget kind and operation in `args`; the target is the widget (any locator candidates):

```yaml
steps:
  - In the Orders grid, click the row where Customer is "Contoso" and Status is "Open"
  - id: edit-amount
    intent: Change the amount of order 42
    action: component
    target: { description: the Orders grid, locators: [{ strategy: testId, value: orders-grid }] }
    args:
      widget: grid          # grid | combobox | datepicker | tree | tabs | accordion | dialog | toast | richtext | slider | masked | dropzone | chart | list
      op: editCell          # see docs/components.md for every operation
      column: Amount
      where: [{ column: Id, op: equals, value: "42" }]
    value: "150"
```

## Programmatic API

Everything above is also available from code: `parseEzScript`, `parseIntent`, `runJourneys(journeys, { library, hooks, mail, sms, allowPageScripts, dialogs, mask, ... })`, `evaluateExpression`, and the providers `SmtpSink`, `MailpitProvider`, `MailHogProvider`, `TwilioSmsProvider`, `MemorySmsProvider`.
