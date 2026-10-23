# Manual and hybrid testing

Manual test cases live next to automated journeys, as `.ez` files, and their
results go into the same runs: the same `run.json`, the same hash-chained
evidence vault, readiness decision, traceability matrix, history and Azure
Test Plans publishing. A **hybrid** journey mixes the two: automated steps
run, the run pauses at a manual step for a tester's verdict, then the
automation continues on the same live page.

## Writing a manual case

```text
Journey: Refund a cancelled order
Type: manual
Assignee: Quinn
Preconditions: An order ORD-<order> exists and is cancelled
Requirements: ORD-9
Tags: @orders @regression
Risk: 4

Manual: Open order "ORD-<order>" in the back office
  Expected: The status is Cancelled
  Attachment: docs/refund-policy.pdf
Manual: Press Refund and confirm
  Expected: A refund of <amount> is shown
  Expected: The customer gets an e-mail

Examples:
  | order | amount |
  | 1     | 49.50  |
  | 2     | 99.00  |
```

- `Manual: <instruction>` (also `Manual step:`, `Manual check:`) is a step a
  person carries out. The indented `Expected:` lines are the expected results
  the tester checks; `Attachment:` names a reference file in the project
  (images, PDF, text) that the runner links.
- Parameters: an `Examples:` table runs the case once per row, `<column>` is
  replaced in instructions, expected results and preconditions; `${var}`
  variables work too.
- `Type: manual | hybrid | automated` is optional: it is inferred (only
  manual steps: manual; some: hybrid). A `Type: manual` case with an automated
  step, or a `Type: automated` one with a manual step, does not parse.
- `Assignee:` is the default tester (cycles can override it);
  `Preconditions:` is shown before the first step.
- `Expect …` lines under a manual step are **automated** checks, run on the
  live page after the tester's verdict (hybrid journeys).

### Hybrid journeys

```text
Journey: Cancel an order after a manual check
Log in as manager
Go to /orders/new
Click the "Submit order" button
  Expect the page to contain "created"
Manual: Check the new order shows the right customer and total
  Expected: Customer and total match the order you placed
  Expect the page to contain "Order"
Click the "Cancel order" button
  Expect the page to contain "cancelled"
```

The browser stays open while the run waits; the tester sees a screenshot of
the page where the automation paused (stored as evidence), carries out the
step (in the same app, or with `headed` runs in the run's own window), and
gives the verdict; the next automated step runs. A failed or blocked manual
step stops a hybrid journey like a failed automated step.

### In the Studio

**Test management › Cases** (`#/manual/cases`) lists manual and hybrid cases
with their assignee and latest result. **New case** opens the case editor:
name, assignee, requirements, tags, risk, preconditions, steps (a manual
instruction, or an automated EZ line for hybrid cases) with expected results,
reference attachments and automated checks, and parameters. **Preview .ez**
renders the file and validates it with the real parser; **Save case** writes
`<journeysDir>/<manual.casesDir>/<id>.ez` (default `journeys/manual/`).

## Running manual steps

### Guided runner (Studio)

Run cases from Cases ("Run" / "Run selected"), from a cycle or from the
dashboard. The guided runner (`#/manual/run/<runId>`) shows, step by step:

- the instruction, expected results, reference files and preconditions;
- for hybrid journeys, the page URL and a screenshot of the paused page, and
  the automated checks that will follow;
- a verdict (**Pass**, **Fail**, **Blocked**, **Skip**), what you observed,
  notes, and screenshots or files: upload them, or focus the paste area and
  paste a screenshot from the clipboard (PNG, JPEG, GIF, WebP, PDF or text, up
  to 4 MB each; images are checked by their magic bytes).

A failure or block needs notes or an observation. A failed step does not stop
a manual case (record every step); a blocked step blocks the rest.
**End run** stops early: the remaining manual steps are recorded as not
executed. The tester's name is asked once and remembered in the browser.

### Terminal

```text
eztest run journeys/manual/refund.ez --manual prompt
```

Each manual step is printed with its expected results; answer `p`, `f`, `b`,
`s` or `q`, then notes and attachment paths. `EZTEST_TESTER` sets the
tester. Without `--manual prompt` (in CI), manual steps are recorded as **not
executed**, never as passes: a manual case is `skipped`, and the
`manualVerified` gate blocks readiness.

### What a verdict records

For every manual step, the run's evidence vault gets
`journeys/<id>/attempt-N/<step>.manual.json` (instruction, expected, tester,
verdict, observed result, notes, time, attachment ids), each attachment, and
(hybrid) the pause screenshot. `StepResult.manual` carries the same, masked
like every other text (secrets never reach the vault), and
`JourneyResult.manual` summarises the journey: `{ type, executed, pending,
testers, assignee }`.

## Results everywhere

- **Readiness**: manual results count like automated ones in every gate and
  the risk-weighted score; `manualVerified` (blocker by default) fails while
  manual steps have no verdict.
- **Traceability**: requirements show manual and hybrid cases (marked) with
  their latest result.
- **Coverage**: Quality › Coverage has a *Manual verification* dimension
  (steps with a verdict / all manual steps). See [coverage.md](coverage.md).
- **Azure Test Plans**: `eztest ado publish` (or `publishers:`) publishes a
  manual case as a manual result (no automated test name), run by the
  tester, with per-step outcomes, the tester's notes as step comments and
  the screenshots as attachments. Hybrid journeys publish as automated
  results with the manual steps' notes.

## Test cycles, assignment and progress

`manual.plansFile` (default `test-plans.json`, commit it) holds:

- **suites**: named sets of cases, listed explicitly and/or by tag;
- **cycles**: a planned execution of suites (plus extra cases) for a release,
  with dates, a state (planned, active, closed), testers assigned per case
  (falling back to the case's `Assignee:`), and the runs that executed it.

Results are never stored in the plans file: a cycle's progress is read from
its runs. **Test management › Cycles** creates suites and cycles, assigns
testers in the cycle table and runs a cycle's open cases ("Run my open
cases", "Run all open cases"). **Dashboard** shows each active cycle's
progress by state (passed, failed, blocked, skipped, in progress, untested),
by tester, by suite and as a burn-up over days, and the open cases assigned
to you. From the terminal:

```text
eztest manual list                 manual and hybrid cases, assignee, latest result
eztest manual progress [cycle]     cycle progress by state, tester and suite
```

```json
{
  "version": 1,
  "suites": [{ "id": "orders", "name": "Orders", "cases": ["refund-a-cancelled-order"], "tags": ["orders"] }],
  "cycles": [{ "id": "r26", "name": "Release 26.10", "suites": ["orders"], "assignments": { "refund-a-cancelled-order": "Quinn" }, "state": "active", "due": "2026-10-31", "runs": [] }]
}
```

## From manual to automated

**Automate** (`#/manual/automate/<path>`, or "Automate" on a case):

- **Through the grammar**: instructions the EZ grammar reads as real steps
  become those steps (a key press must be real keys, a navigation a real
  location); expected results it reads as conditions become `Expect` lines.
  Everything else stays `Manual:`, so the result is a hybrid journey and
  nothing is lost. `eztest manual automate <file> [--write]` does the same.
- **With the recorder**: start the recorder at a URL, perform step 1 in its
  browser, press **Next step**, perform step 2, … then **Stop and convert**.
  The lines recorded for a step replace it (the instruction stays as a
  comment), expected results become `Expect` lines where the grammar reads
  them, and steps with nothing recorded stay manual.

The converted journey keeps the case's id, so its history, traceability and
cycle membership carry on. Writing it replaces the case after a confirmation
(source control keeps the old version).

## Importing manual cases

- **Excel / CSV** (`eztest import cases.xlsx --as manual`, or the Studio
  import page with "manual"): each row group becomes a case with `Manual:`
  steps and their `Expected:` results; `--as hybrid` automates what the
  grammar reads and keeps the rest manual instead of writing TODO lines.
- **Azure Test Plans** (`eztest ado import --plan 7 --suite 9 --as manual`):
  steps (shared steps expanded), expected results, parameters (as an
  `Examples:` table), requirements and the `@TestCaseId` tags, so publishing
  the run updates the same test points.

## API

```ts
import { runJourneys, parseEzScript } from 'eztest';
import { manual } from 'eztest';

const run = await runJourneys([parseEzScript(text)], {
  outputDir: 'eztest-results',
  manual: { verdict: async (req) => ({ status: 'passed', tester: 'Quinn', notes: `checked ${req.instruction}` }) },
});
const progress = manual.cycleProgress(cycle, plans, cases, runs);
```

A `ManualVerdictProvider` receives a `ManualStepRequest` (instruction,
expected, attachments, automated checks, page URL and screenshot for hybrid
pauses, position, assignee) and returns a `ManualVerdict` (status, tester,
notes, observed result, attachments). Throw `ManualRunEnded` to end the run.
