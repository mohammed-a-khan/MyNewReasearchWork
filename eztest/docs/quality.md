# EZTest Studio: Quality Center

The Quality Center is the "Quality" group of the Studio's activity bar. It
turns run results into decisions: which heals to trust, what each failure is,
which journeys are quarantined, whether a run is ready to release, and which
requirements are covered.

| Page | Route | What it does |
|---|---|---|
| Heal review | `#/quality/heals` | Verified heals across runs: accept (write the locator into the journey) or reject (never heal it again) |
| Triage | `#/quality/triage/<runId>` | Failures clustered by signature, in columns by classification, with cited evidence; reclassify; file Azure DevOps bugs |
| Flaky | `#/quality/flaky` | Flip-rate ranking, per-run outcome strips, quarantine |
| Readiness | `#/quality/readiness/<runId>` | GO / GO_WITH_RISKS / NO_GO with every gate, what would make it GO, policy editor, sign-off |
| Traceability | `#/quality/traceability` | Requirements x journeys x latest status, gaps, CSV / XLSX / HTML export |
| Compare | `#/quality/compare?a=<base>&b=<run>` | Journey and step status changes, durations, readiness change |
| Trends | `#/quality/trends` | Pass, heal and flaky rate, duration, failures by classification, slowest journeys and steps, tags and areas |
| Coverage | `#/quality/coverage` | UI, requirement, API, risk, change and manual coverage in one view; the UI coverage map with a heat overlay on stored DOM snapshots; UI and accessibility trends; failure tags ([coverage.md](coverage.md)) |

Manual and hybrid test cases, the guided runner, cycles and the progress
dashboard are under **Test management** (`#/manual`, [manual-testing.md](manual-testing.md)).
Triage cards show each journey's failure tags (new failure, always failing,
regressed, flaky).

Every write asks for confirmation, records who made it, and shows a diff when
a file changes. State lives in `.eztest/` next to the results directory:

| File | Written by | Read by |
|---|---|---|
| `heal-decisions.json` | Heal review (accept / reject) | the healer (`createEngine`) |
| `quarantine.json` | Flaky page | `eztest run` exit code, `analyzeRun` readiness, Studio |
| `triage-overrides.json` | Triage reclassify | triage board, readiness, trends |
| `triage-bugs.json` | "File bug in ADO" | triage board |
| `requirements.csv`, `requirements-ado.json` | Traceability | traceability |

## Heal review

A heal is listed once per journey, step and healed locator, however many runs
it healed in (a T0 cache hit is shown under the tier that first produced it).
Each card shows the old locators, the new one, the tier and confidence, the
screenshot, the post-conditions that verified it and the runs.

The inbox also lists **improvements** (tier "Improvement"): a passing step whose
target scored low (XPath, classes, positions) and for which the runner found a
more robust locator (test id, role and name, label) that selects the same
element on the live page. The card shows the current and suggested locator
scores. Accepting writes the better locator into the journey like a heal;
rejecting records a decision with tier `improvement`. See [reliability.md](reliability.md#3-locators).

### Accept: what happens per format

Accepting first previews the change (`POST /api/quality/heals/preview`). The
write (`POST /api/quality/heals/accept`) is refused with 409 if any file no
longer hashes to what the preview showed.

**`.ez`**

1. *Phrase rewrite* (preferred). The target phrase on the step's line is
   replaced by one the grammar turns into the healed locator:
   `Click the "Submit order" button` becomes
   `Click the "Place order" button [id=click-the-submit-order-button]`.
   Candidates, most natural first: `the "<name>" <kind>` from the role
   (button, link, field, dropdown, checkbox ...), label and placeholder
   phrases for fields, and the selector forms the grammar already knows
   (`testid=<id>`, `#<id>`). The new line is re-parsed and must keep the same
   action, value and capture key and contain the healed locator; the whole
   file must parse back with the same step ids. The original step id is
   pinned with `[id=...]` so history, the fingerprint store and decisions
   keep matching.
2. *Sidecar* (fallback). When no phrase expresses the locator (an arbitrary
   CSS path or XPath), the `.ez` text is left alone and the locator goes into
   `<file>.ez.locators.json`: `{ "version": 1, "steps": { "<stepId>": { "locators": [...] } } }`.
   The journey loader (`loadJourneys`) puts sidecar locators first in the
   step's candidates; a later accepted heal for the same step goes in front of
   earlier ones. Sidecars are never picked up as journeys.

**`.yaml` / `.yml` / `.json`**

1. A plain-English string step is rewritten like an `.ez` line.
2. Otherwise the step's `target` becomes (or stays) an object whose
   `locators` list starts with the healed locator; a string target keeps its
   text as `description`, and a step that had no `target` gets one built from
   its intent. YAML comments and layout outside the step are preserved.

Accepting also updates the fingerprint store: the healed locator becomes the
step's last good locator and the cached heal (T0) is dropped, because it is
no longer a heal. The decision is recorded as `accepted`.

**Shared repository elements** (`the @Checkout.placeOrder button`, a matching
description, an SDK screen entry): the inbox shows one item per element and
healed locator, with every journey that healed it. Accepting rewrites the
element in `elements/*.yaml`, not the journeys. The healed locator goes first
in its `locators`, and the diff of that file is shown first. Every journey
that uses the element is fixed at once. An element from a TypeScript screen
gets an override entry in `elements/<Screen>.yaml`. The element's memory
(`@elements/<id>` in the fingerprint store) is reset to the accepted locator.
See [elements.md](elements.md).

**Anchors of relative targets** (`below "Email"`, `inside the "Customers" table`)
heal at run time with their own memory, but they are not rewritten
automatically. The inbox shows them; edit that part of the step by hand.

### Reject

A rejection is recorded in `.eztest/heal-decisions.json` with the reviewer and
a reason, and the T0 cache entry for that heal is cleared. From then on, when
the healing ladder would offer a candidate at the rejected tier for that step,
or the rejected locator itself at any tier (e.g. from the T0 cache), the
healer stops climbing and the step fails with
`suspected regression: this heal was rejected in review by <name>`. Triage
classifies that as a product bug (rule `rejected-heal`). "Undo decision"
removes the decision (files are not reverted).

## Flaky root causes

When a journey needed a retry to pass, the runner classified why the failed
attempt failed (timing, overlay, detached, network, data, environment; see
[reliability.md](reliability.md#flake-classifier)). The Flaky page shows the
dominant cause under each journey's state (`cause: overlay (67% of 3)`) with
advice in the tooltip, and a journey that keeps passing only on retry is
labelled flaky even though its final statuses were passes.

## Quarantine

`.eztest/quarantine.json` holds `{ journeyId, reason, owner, expires }`
entries. Quarantined journeys still run and are reported, but:

- `eztest run` exits 0 when the only failures are quarantined journeys (and
  prints `quarantined (not failing the run): ...`);
- readiness excludes their failures and triage verdicts from every gate and
  from the score, and says so in the rationale (`quarantineIgnored`);
- an entry past its expiry date stops applying (its failures count again) and
  produces a warning; entries expiring within 7 days warn too.

## Triage reclassification

A reclassification is stored per run and journey together with the failure
signature. The same signature in a later run starts with that classification
("inherited from" the earlier review). Trends and readiness read verdicts with
overrides applied.

"File bug in ADO" uses `ado.organizationUrl`, `ado.project` and the
credentials of [azure-devops.md](azure-devops.md#credentials) (a PAT through a
`secret://` reference, `System.AccessToken`, a service principal, workload
identity or managed identity). An open bug tagged with the failure signature
(`ezsig-<hash>`) is reused; otherwise a Bug is created with repro steps, the
triage reasons and the cited evidence files uploaded as attachments, linked to
the failing test case and the journey's requirements, assigned to the
journey's owner from CODEOWNERS and filed under the area / iteration of
`ado.paths`. Each failing journey on the board shows its CODEOWNERS owner.
Without configuration the button shows the setup.

**Branch filter.** The Source Control page can scope the Quality Center to
one branch (runs, history and flaky scores); see [git.md](git.md).

## Readiness and sign-off

The page evaluates the run live with the current policy, quarantine and
reclassifications, and shows whether that differs from the decision recorded
when the run was analyzed. "What would make this GO" lists concrete actions
for each failing gate. The policy editor validates as you type, previews the
decision for the selected run and shows a diff before saving; a save is
refused if the file changed since it was loaded.

A sign-off (approver and comment) is appended to the run's hash-chained
evidence manifest as `signoffs/signoff-<time>.json`, so `eztest evidence
verify` still passes and any later edit is detected. When an ed25519 key is
configured (`EZTEST_SIGNING_KEY` pointing at a PEM file, or
`eztest-signing.key.pem` / `.eztest/signing.key.pem` from `eztest keys
generate`) the canonical note is signed; otherwise it is recorded hashed and
unsigned, and the page says so.

## Traceability

Requirements come from journey `Requirements:` headers. Optionally a list is
loaded from a CSV (`id` / `requirement` / `key` column, or the first column)
or an Azure DevOps WIQL query, so requirements no journey covers appear as
gaps. Coverage per requirement: covered and passing, passing only with heals,
failing, only quarantined coverage, not run, or no journey.
