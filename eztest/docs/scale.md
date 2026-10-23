# Running at scale

This guide covers suites of thousands of journeys that run on many machines, in many CI jobs and for several teams. Each topic below works alone, and the topics also combine.

| Need | Use |
|---|---|
| Split a suite across machines | `eztest run --shard i/n`, then `eztest merge` |
| Size the CI matrix | `eztest ci matrix --shards auto` |
| Keep two journeys off the same account | `Locks: account-123` |
| Run only what matters | `--changed-since`, `--only-failed`, `--last-failed`, `--risk`, `--budget` |
| Order and burn-in | `--failed-first`, `--shuffle`, `--repeat-each`, `--burn-in`, `--max-failures`, `--retry-strategy isolated`, `--fail-on-flaky` |
| Inner loop | `--watch` and `webServer:` |
| Share results, heal decisions and locks across a team | the results server (see [server.md](server.md)) |

## Sharding

```bash
eztest run --shard 2/4
```

Shards are balanced by **historical duration**, not by count. EZTest reads the median duration of each journey over its last 10 runs from the results server, or from `.eztest/history.json` when no server is configured. It then assigns the longest journeys first, each to the lightest shard. A journey with no history gets the median duration of the known journeys. Data-driven journeys are estimated from the rows recorded under their id.

Every machine computes the same plan from the same journeys and history, so shards need no coordination. Journeys that share a static lock key, such as `Locks: ledger`, are placed in the same shard when the group fits in one shard, so they wait for each other inside one machine rather than across machines.

To see the plan without running anything, use `--plan`:

```
$ eztest run --shard 1/3 --plan
shard 1/3: 412 journeys, ~9.8m (plan imbalance 1.02; balanced by historical duration)
```

A shard run writes its reports but does not record into history. The merged run does that.

On one machine, shards can derive ports or folders from `${EZTEST_SHARD_INDEX}`, which is also available as `EZTEST_SHARD_TOTAL` and `EZTEST_SHARD`. For example, an email sink can use `email: { provider: sink, port: 252${EZTEST_SHARD_INDEX} }`.

## Merging shard runs

```bash
eztest merge shards/ -o eztest-results/merged [--publish] [--policy readiness-policy.yaml]
```

`merge` accepts run directories, or directories that contain them, such as downloaded CI artifacts. The merged run directory contains the following:

- `shards/<runId>/`: a byte-for-byte copy of each shard, whose own evidence chain still verifies.
- A new evidence chain that re-records every shard artifact. Each artifact is re-hashed from the copy, so a mismatch is reported. The ids are renumbered, and every evidence reference in `run.json` and `heal-proposals.json` is remapped to the new ids.
- A `chain-link.json` for each shard. It names the shard chain head, the shard's entry count and the hash of its manifest. Both the link and the shard manifest are entries in the merged chain.

The merge then runs the full analysis: history, flaky scoring, triage, readiness and every report. `eztest evidence verify <merged>` checks the merged chain, every shard chain, and that each link still names the shard it was merged from. Changing a shard file after the merge breaks both chains.

## CI matrix

```bash
eztest ci matrix --shards auto --target 10m [--max 20] [--provider github|azure] [--plan]
```

With `auto`, EZTest picks enough shards that each one takes about the target time, and never more shards than there are journeys. The output is JSON in the provider's matrix shape:

- GitHub Actions: `{"include":[{"shard":"1/4","index":1,"total":4,"estimatedMinutes":9.6},...]}`.
- Azure DevOps: `{"shard_1":{"SHARD":"1/4","SHARD_INDEX":"1","SHARD_TOTAL":"4"},...}`.

`eztest init --ci github|azure` writes a pipeline with a `plan` job, one `test` job per shard, and a `merge` job. The merge job merges the shards, verifies the evidence and publishes to the results server when one is configured.

## Resource locks

Some journeys touch a shared entity that two journeys must not change at the same time. Declare that entity with a lock:

```
Journey: Close account
Locks: account-<account>, ledger

Examples:
| account |
| 123     |
```

In YAML, use `locks: [account-123]`. `<column>` and `${var}` are filled in from the journey's variables, so every Examples row locks its own account.

Two journeys that hold a common key never run at the same time. This holds for workers of one run, for parallel processes on one machine and for shards on different machines. While a journey waits, its worker runs other journeys that are ready. A journey whose locks stay busy longer than `locks.timeoutMinutes` (30 by default) is recorded as an error that names the holder.

```yaml
locks:
  backend: auto        # auto: the results server when server.url is set, else lock files
  dir: .eztest/locks   # lock files; put it on a shared file system to lock across machines
  ttlSeconds: 120      # leases are renewed while held; a crashed runner frees them after the TTL
  timeoutMinutes: 30
```

`--no-locks` ignores locks for one run.

### Running in parallel safely

Teams that run with `PARALLEL=false` because their tests collide on shared data can switch parallelism on as follows:

- Declare the data each journey needs (`Data: Deal as d where ...`). The data fabric leases each record, so two workers never get the same record.
- Lock the entities that cannot be leased, such as a single shared account or a configuration screen.
- Role sessions are cached per role and environment. Concurrent workers write them atomically, so one worker never reads another worker's half-written session.
- Run ids, run directories and evidence are unique per run. Shards on one machine can take ports from `${EZTEST_SHARD_INDEX}`.

## Test selection

Each criterion filters the journeys, and a journey must pass every criterion given. `--budget` is applied last.

| Flag | Selects |
|---|---|
| `--changed-since origin/main` | Journeys that the impact mapping (`selection.impactMapping`, default `impact-mapping.yaml`) maps the changed files to, plus journeys whose own file changed |
| `--only-failed <runDir>` | Journeys that failed or errored in that run |
| `--last-failed` | Journeys that failed in the last recorded run (from history or the results server) |
| `--risk 4` (or `">=4"`) | Journeys with risk 4 or higher |
| `--budget 15m` | The set with the highest risk per minute that fits the budget, using historical durations. Value is risk², boosted for impacted and recently failed journeys |

The output explains each decision, and `selection.json`, which is stored in the evidence chain, records all of them:

```
selection: Selected 31 of 412 journeys (~14.6m) by changed since origin/main (5 files, 44 impacted), budget 15.0m.
  + checkout-card: impacted by src/payments/card.ts; fits budget (12.5 risk-value/min, ~2.0m)
  - export-csv: over budget (~6.0m, 0.7 risk-value/min)
```

The report header shows the summary too.

## Ordering, burn-in and fail-fast

| Flag | Effect |
|---|---|
| `--failed-first` | Journeys that failed last time run first, then journeys in risk order |
| `--shuffle [seed]` | Random but reproducible order. The seed is printed: `--shuffle 8812` repeats the order |
| `--repeat-each N` | Every selected journey runs N times. Copies are named `<id>~rep<k>` |
| `--burn-in [N]` | Only new journeys (not in history) and changed journeys (with `--changed-since`) run N times. The default is 5 |
| `--max-failures N` | The run is cancelled after N failed journeys. Journeys not yet started are recorded as `skipped` |
| `--retry-strategy isolated` | Failed journeys are retried after the main pass, one at a time, so they are not affected by parallel load |
| `--fail-on-flaky` | The run exits non-zero when a journey passed only on retry, or had mixed outcomes in burn-in |

After a repeat or burn-in run, a verdict is printed for each journey, for example `burn-in: checkout: 3/5 passed -> flaky`.

## Watch mode and managed app start

`eztest run --watch` runs the suite, then watches the journey files. When a file changes, EZTest re-runs that journey and every journey that calls it with `Run journey`, directly or through other journeys. Saves are debounced.

`webServer:` starts the app under test before the run and stops it afterwards:

```yaml
webServer:
  command: [npm, run, start]      # or a string; never run through a shell
  url: http://127.0.0.1:3000/     # ready when this URL answers (status < 500)
  waitFor: "listening on"         # and/or a pattern in the app's output
  timeoutSeconds: 60
  reuseExisting: true             # if the URL already answers, do not start another instance
```

## Reports for large runs

Above 1,000 journeys, the HTML report switches to a virtualised view. You can change the threshold with `EZTEST_REPORT_LARGE_THRESHOLD`. In this view:

- Journeys and steps are embedded once as compact JSON, and only the rows in view are in the DOM.
- A journey's steps, errors, heals and evidence links are built when you open it.
- The summary, readiness, triage counts and the failures table are static HTML, so the page prints as an executive summary.

Measured on a synthetic run of 5,000 journeys with 8 steps each and 40,000 evidence entries:

| | Full report | Large-run report |
|---|---|---|
| Size | 53.7 MB | 5.4 MB |
| Build time | ~1.2 s | ~0.4 s |
| Interactive in Chromium | (not usable) | ~0.3 s |

`eztest trends [--out trends.csv]` exports the local history as CSV, one row per run. The results server serves the same data per project at `/api/projects/<p>/trends.csv`.
