# Multi-actor journeys

Some flows need two live users at once: a chat, a maker-checker approval, a
segregation-of-duties check, a dispatcher and a courier. A multi-actor
journey runs several **actors** in one journey. Each web actor has its own
isolated browser context and session: cookies, storage, tabs, dialogs, the
network log and the identity it signed in with. Steps say which actor acts,
and branches can run at the same time.

```
Journey: Approval needs a second person
Actors: maker as clerk, approver as manager

As maker:
  Open /orders/new
  Click the "Submit for approval" button
    Expect the page contains "Waiting for approval"
As approver:
  Open /approvals
  Click the "Approve" button
As maker:
  Expect the page contains "Approved"          # no reload: the maker's page updates itself
```

## Writing actors in .ez

- **`Actors:`** (header) declares actors, in order, separated by commas:
  `name [as <role>] [on android|ios] [app "<id>"] [with device "<name>"] [with locale <code>]`.
  - `as <role>`: the Identity Vault role the actor signs in as. The sign-in
    runs as a `Log in as <role>` step when the actor first acts (its first
    As block or Switch to user), so it shows in the report like any step.
  - `with device` / `with locale`: emulation for that actor's context, over
    the journey's own (Device:, Locale:, ...).
  - `on android` / `on ios` + `app`: a native-app actor (below).
  - Actors you only name in steps (`As bob:`) are plain web users.
- **`As <actor>:`** starts a section: the lines after it run as that actor.
  The section ends at the next `As ...` or `Switch to user` line, at `End`,
  or at the end of the file. When the section is indented under its As
  line, it also ends at the first line that is not indented deeper (an
  `End` indented less than the As line ends the section and the block
  around it). `As <actor>: <step>` runs a single step.
- **`Switch to user "bob"`** (also `Switch to actor bob`, `Continue as bob`):
  the following steps of the same list run as bob. Expect lines right after
  it are checked in bob's session.
- **`In parallel:`** ... **`End`**: the steps inside (normally one As
  section per actor) run at the same time; the block fails when a branch
  fails, after every branch is done.
- **Who runs steps outside any As block:** the *primary* actor, which is
  the first declared web actor, else the first actor named in the steps,
  else `default`. The primary actor uses the journey's first context, so a
  journey with one actor costs nothing extra.

A two-user chat (the demo app's `/chat`, `test/e2e/multi-actor.test.ts`):

```
Journey: Two users chat
Actors: alice, bob

As alice:
  Open /chat/login
  Type "alice" into the Your name field
  Click the "Join the chat" button
As bob:
  Open /chat/login
  Type "bob" into the Your name field
  Click the "Join the chat" button

In parallel:
  As alice:
    Type "Hi Bob" into the Message field
    Click the "Send" button
    Expect the page contains "bob: Hi Alice"
  As bob:
    Expect the page contains "alice: Hi Bob"
    Type "Hi Alice" into the Message field
    Click the "Send" button
End

Switch to user "alice"
Expect the page contains "Signed in as alice"
```

Each branch waits for the other's message, so the exchange passes only
because the branches really run at the same time.

## YAML and JSON

```yaml
name: Two users chat
actors:
  alice: {}                    # or a role: "alice: chat-user"
  bob: { role: chat-user, emulation: { device: "iPhone 13" } }
steps:
  - as: alice
    steps: [Open /chat/login, ...]
  - parallel:
      - as: alice
        steps: ['Click the "Send" button']
      - as: bob
        steps: ['Expect the page contains "alice: Hi Bob"']
  - switchTo: bob
  - Expect the page contains "Signed in as bob"
```

The step objects are `{ action: actor, value: <name>, steps: [...] }` (an As
block), `{ action: actor, value: <name> }` (Switch to user) and
`{ action: parallel, steps: [...] }`.

## TypeScript SDK

```ts
import { journey, as } from '@mohammed-a-khan/eztest/sdk';

journey('Two users chat', { actors: { alice: {}, bob: 'chat-user' } }, async ({ actors, ui, expect }) => {
  await actors.alice.ui.open('/chat/login');
  await actors.bob.ui.open('/chat/login');
  await Promise.all([                                    // at the same time
    actors.alice.ui.fill({ label: 'Message' }, 'Hi Bob'),
    actors.bob.ui.fill({ label: 'Message' }, 'Hi Alice'),
  ]);
  await actors.bob.expect.ui.page().toContainText('alice: Hi Bob');
  await as('alice', async () => {                        // a whole block as alice
    await ui.click({ role: 'button', name: 'Send' });
  });
});
```

`actors.<name>` has `ui`, `expect`, `api` and `run(fn)`; `as(name, fn)` is
the same as `actors[name].run(fn)`. Plain `ui.*` calls run as the primary
actor (the first declared one). `actors:` takes a role string or a full
declaration (`{ role, emulation }`). Native actors are .ez / YAML only.

## Native-app actors (web + mobile in one journey)

```
Journey: Dispatcher and courier
Actors: dispatcher as ops, courier on android app "com.example.courier"
As dispatcher:
  Open /dispatch
  Set variable order = "ORD-7"
As courier:
  Tap the "Accept ${order}" button
  Capture the text of the Pickup code as pickup
As dispatcher:
  Expect the page contains "${pickup}"
```

The blocks of an `on android` / `on ios` actor run on the platform driver
(the EZTest mobile driver from `mobile:` in the config, or
`RunOptions.platformDrivers`), one driver attempt per block. The journey's
ledger is handed to the block as variables, and what the block captured
comes back into the ledger. The device session does not stay open between
two blocks of the same native actor (state on the device does, unless the
capabilities clear the app data). Native actors cannot be the primary actor
and cannot be switched to with `Switch to user`.

## What you get in results and evidence

- **Steps:** every step result has `actor` (report, JSON, Studio). As blocks
  and Switch steps say whose they are; parallel blocks keep their branches
  as children, in the order written.
- **Screenshots, failure DOM and ARIA snapshots** of an actor go to
  `journeys/<id>/attempt-<n>/actor-<name>/` and their descriptions end in
  `(<name>)`.
- **Traces and videos:** one per actor
  (`traces/<id>-attempt<n>-<actor>.zip`, described `browser trace (<actor>)`).
- **Console and network logs** are one log per journey attempt; every entry
  has `actor`.
- **Dialogs and WebSocket traffic** per actor
  (`actor-<name>/dialogs.json`, `websocket.json`).
- **Events:** `step:start` carries `actor`; the Studio Run timeline shows
  the actor next to the step.
- **Debugger:** the paused state and `debug.stepStarted` / `debug.paused`
  carry `actor`, the status line says "Paused before step 4 as bob", and the
  screencast follows the acting actor's page. While the debugger or the
  time-travel trace is on, `In parallel:` branches run one after the other
  (both follow one page at a time); the parallel block's result says
  `captured.sequential: true`. Branches that wait for each other need a
  normal run.

## Sessions, identity and reliability

- Session-expiry re-login works per actor: an actor whose session expires
  mid-journey signs in again as its own role.
- The reuse-context pool is not used for multi-actor journeys (each actor
  gets a fresh context).
- Cross-browser runs (`browsers:`) run every actor of a unit in that unit's
  browser.
- Resource locks, retries, Depends on and Examples work as for any journey.
