# Findings: EZTest against an enterprise system

**The question:** "will this tool suffice the enterprise testing needs: the complex logic, test data support meaning external data files, BDD tests, cross app integration, backend and front end integration testing, advanced programming etc"

**Method.** A realistic system was built (see [README.md](README.md)), with the suite a test team would write for it. It was run the way a pipeline runs it: in parallel on Chromium and Firefox, in shards, against a deliberately broken build and against a UI release. Wherever EZTest got in the way, EZTest was fixed with a regression test, or the gap is recorded here.

## Short answer

Yes, for everything asked. BDD was built separately (native `.feature` execution, see [docs/bdd.md](../../docs/bdd.md)) and is not yet part of this suite. Getting there exposed 31 defects in EZTest, all fixed with regression tests. The worst were silent wrong answers, such as a grid check that passed after reading 14 of 420 rows. Next came long Firefox runs that ran out of memory and lost every result. Neither can happen now.

## Run numbers

| Run | Result | Wall time |
|---|---|---|
| Chromium ×3 (4 workers) | 43/43 each, 1,004 steps, no retries, nothing flaky | 21–24 s |
| Firefox ×3 (4 workers) | 43/43 each | 97–109 s |
| 2 shards, merged | 43/43; one verified evidence chain; GO 100 | 18–19 s per shard |
| `REF_BUG=premium-tax` | 9 failures, all 9 triaged as product bugs; NO_GO | — |
| `REF_VARIANT=b` (button renamed) | 2 steps healed and verified; GO 98.8 | — |
| Load | 1,433 requests, 0 errors, p95 6.6 ms | 28 s |
| API | 81.8% of operations covered, 0 contract violations; 1 medium security finding (no rate limit) | — |

Before the Firefox fixes the suite reached 37/43, and then a Firefox process grew to 12.7 GB, was killed for running out of memory, and the run wrote no results. After the fixes, Firefox peaks at about 4.7 GB.

## What broke in EZTest, and the fix

1. A one-page virtualized grid with no scrollable viewport was reported as completely read. It now fails with `COMPONENT_INCOMPLETE`. Header rows are counted from `aria-rowindex`, and a stale `aria-rowcount` is ignored once the grid has been scrolled or paged.
2. Page-text, regex and aria-snapshot conditions now check inside the frame you are in, not the main page.
3. Ledger comparisons fall back to journey variables and compare numbers as numbers.
4. An inline JSON body is sent as JSON, not `text/plain`.
5. `${x} contains "…"` is a value check (a new rule), not an element locator.
6. An unquoted expression on the right of a comparison is evaluated.
7. A `successUrl` such as `/app/home` is no longer mistaken for a regex.
8. API-only roles: OAuth client credentials, with no username or login URL.
9. `api.spec` entries can be `{file, baseUrl}`; only calls under that base URL are validated and counted.
10. A deliberately invalid request that the server refuses with a 4xx counts as a negative test, not a violation.
11. `Run journey` works when only a subfolder is run.
12. A journey's `Lenses:` header works without a run-level lens.
13. The `docsReconciled` gate is wired to document checks; it always said "no data" before.
14. The analysis no longer crashes on a clean accessibility run, and the gate cites the scans (`a11yScans`).
15. `api-scan` takes vault roles (`role`, `otherRole`).
16. `Expect rows … equal query` takes named binds.
17. `Data: A and B` is two entities; entities get column `defaults` and a `gen:unique:PREFIX` generator.
18. SQLite `busy_timeout` is set to 5 s.
19. Call-API phrasings accept `body`/`json` and a trailing `as role`.
20. Diagnosis lists the fields the browser's form validation rejects.
21. Two accessibility false positives fixed: tabbing through a date input's parts, and `lang` on an `about:blank` frame.
22. Parse errors hint how to use placeholders.
23. The run summary ends with a "failures:" section.
24. A browser that dies mid-run is launched again; the journeys it took down are reported as environment failures, and the run still writes `run.json`.
25. `reliability.recycleBrowserAfter` (default: every 15 journeys on Firefox, off on Chromium). Firefox keeps about 30 MB per closed window: windows grow, tabs don't. Data collectors and preload scripts are now removed before their context.
26. Firefox: a checkbox in an iframe below the fold can be clicked; the in-view check walks up through frame elements.
27. Firefox: the agent's `realm is null` error is retried with a fresh element, without disposing the realm.
28. Keyboard accessibility walk: the page is brought to the front, and stops probed without window focus are not judged. This removes false `focus.visible` and `focus.hidden-stop` findings in parallel runs.
29. Merged shard runs find document and API evidence under `shards/<run>/`, and `merge` records API coverage for the whole run.
30. Triage: a value that differs from the expected one is a suspected product bug, not "unknown".
31. `load run` reads `.env` and `.env.<env>` (with `-e`), and a scenario's `baseUrl` is a template.

The regression tests are in `test/integration/enterprise-findings.test.ts` (26) and `enterprise-findings-browser.test.ts` (8). The browser tests for the frame, accessibility, crash and Firefox iframe fixes were checked to fail with the fix reverted. Fix 28 has no dedicated regression test, because the focus loss could not be reproduced in isolation; it is shown by three clean Firefox suite runs.

## What EZTest caught in this suite and app

- The OpenAPI spec lacked a 403 response.
- The app's CSP blocked its own grid style. Together with fix 1, that is how the 14-of-420 read was found.
- A `step=1000` input blocked form submission.
- Accessibility: a broken aria reference, reflow at 320 px, and text contrast of 3.9:1.
- The `login-mfa` journey signed out a session other journeys shared. It showed up only on Firefox, where timing differs; that journey now uses its own role.
- The pipeline never handed its secrets to the test steps; `steps-setup.yml` now writes them into `.env`.

## Remaining gaps, ranked by how much a team would feel them

1. BDD features are not yet part of this suite (native BDD now exists in EZTest).
2. No escaping of quotes inside `.ez` strings; authors alternate `'` and `"`.
3. No `${expr}` inside expectation strings; a `Set variable` step is needed first.
4. No TOTP-code step in `.ez`; step-up MFA in the middle of a flow needs a code step.
5. No readiness gate for the passive security lens; `security:warn` lists only "high" findings.
6. Firefox still leaks about 30 MB per closed window (a Firefox issue). Recycling contains it but does not remove it.
7. The in-memory message broker works in-process only.
8. A plugin `.mjs` inside the repo can't `import 'eztest'`.
9. `EZTEST_*` environment variables that are not settings produce "unknown key" config warnings.
10. Examples placeholders don't fit numeric slots in some phrasings; the parse hint makes this discoverable, not seamless.
