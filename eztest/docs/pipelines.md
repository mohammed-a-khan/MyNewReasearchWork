# Pipelines: CI, schedules and deployments

This guide ties journeys to the places they run: pull requests, scheduled regressions and the stages of a deployment pipeline. It covers:

- the `pipelines:` block, which maps a trigger or a stage to a selection of journeys;
- `eztest run --pipeline`, which runs that selection with the entry's settings and gate;
- `eztest pipelines list | explain` and `eztest tags report`, which show what runs where and what runs nowhere;
- deployment test records: what was tested in which environment for which version;
- `eztest init --ci <system>`, which writes ready-made pipelines for seven CI systems.

For sharding, impact selection and budgets themselves, see [scale.md](scale.md). For values handed from one stage to the next, see [shared-data.md](shared-data.md#pipeline-stages). For Azure DevOps specifics, see [azure-devops.md](azure-devops.md#pipelines).

## The `pipelines:` block

```yaml
pipelines:
  pr:         { trigger: pr, tags: "@smoke", impact: true, budget: 10m, browsers: [chromium] }
  nightly:    { trigger: schedule, schedule: "0 2 * * *", tags: "@regression and not @quarantined", shards: 4, browsers: [chromium, firefox] }
  deploy-sit: { environment: sit, tags: "@sit or @smoke", testPlan: 417, gate: readiness }
  deploy-uat: { environment: uat, tags: "@uat", requires: [deploy-sit], gate: readiness }
```

| Key | Meaning |
|---|---|
| `tags` | A tag expression: `and`, `or`, `not`, parentheses, a comma for `or`, `@team-*` for a prefix. Case does not matter, the `@` is optional. |
| `journeys` | Journey files or folders (default: `journeysDir`). |
| `impact` | Only journeys impacted by the change: `true` compares with the pull request's target branch (`EZTEST_BASE_REF`, else the CI's target branch, else `origin/main`); a git ref compares with that ref. Uses the impact mapping ([scale.md](scale.md#test-selection)). |
| `budget` | The journeys with the highest risk per minute that fit, e.g. `10m`, from historical durations. |
| `risk` | Minimum risk, e.g. `4` or `">=4"`. |
| `shards` | Parallel CI jobs. With the CI's own parallelism (Azure `parallel`, GitLab `parallel`, CircleCI `parallelism`, Bitbucket parallel steps) each job picks its shard from the CI's variables; or pass `--shard i/n`. Shards are balanced by historical duration and merged with `eztest merge`. |
| `browsers` | The browsers of the run. Journeys whose `Browsers:` header excludes all of them are not selected. |
| `environment` | The environment (`config/<env>.yaml`, `.env.<env>`, the shared store namespace). An entry with an environment keeps a deployment record. |
| `testPlan`, `testSuite` | Azure Test Plans plan and suite to publish the results to. |
| `gate` | `readiness` (default): a NO_GO readiness decision fails the run. `none`: only failed journeys do. |
| `requires` | Pipelines that must have passed **for the same version** first (from the deployment records on the results server). |
| `retries`, `workers` | Overrides of `retries` and `concurrency`. |
| `stages` | CI stage, job or environment names that select this entry with `--pipeline auto` (default: the entry's own name). |
| `trigger`, `schedule` | When the CI templates run it (`pr`, `schedule`, `deploy`, `manual`) and the cron of a schedule. Also used by `--pipeline auto`. |
| `version` | The deployed version, text with `${ENV}` (default: `EZTEST_APP_VERSION`, else the CI's build number, a tag or the short commit). |
| `app` | The application in deployment records (default: the EZTest project). |
| `record` | Keep a deployment record (default: when `environment` is set). |
| `ado` | Azure DevOps reporting: `summary` (true), `tags` (true), `commentWorkItems`, `linkWorkItems`, `publishTestPlan` (true). |

`eztest init` writes this block into a new project's `eztest.config.yaml`.

## `eztest run --pipeline`

```bash
eztest run --pipeline deploy-sit
eztest run --pipeline auto        # detect the entry from the CI's stage, job, environment or trigger
EZTEST_PIPELINE=nightly eztest run
```

The entry decides the environment, the browsers, retries and workers, the impact base, the budget, the risk and (with sharding) the CI shard. Flags given on the command line win (`--env`, `--browsers`, `--shard`, ...). Then:

1. The entry's tag expression selects the journeys, before any `--changed-since` / `--budget` selection and sharding. `Setup:` and `Teardown:` journeys run around whatever is selected ([shared-data.md](shared-data.md#run-wide-values-setup-and-teardown-journeys)).
2. With `requires:`, the run stops (exit 1) unless each required pipeline has a passing deployment record for this version.
3. After the run and its analysis: the deployment record, Azure DevOps reporting, then the gate. With `gate: readiness`, NO_GO fails the run; otherwise failed journeys do, as always.

`--pipeline auto` picks the entry in this order:

1. `EZTEST_PIPELINE`;
2. an entry named like the CI's stage, job or deployment environment, or listing it under `stages:` (names compare without case, `_`, `.` or spaces: `Deploy_SIT` is `deploy-sit`);
3. the only entry whose `environment` is the deployment environment;
4. the trigger: a pull request picks the `trigger: pr` entry (or one named `pr`), a schedule the `trigger: schedule` entry (or `nightly`), a deployment the `trigger: deploy` entry.

If none fits, it fails with what it detected and the configured names.

| CI system | Stage / job | Deployment environment | Trigger | Shard |
|---|---|---|---|---|
| Azure Pipelines | `SYSTEM_STAGENAME`, `SYSTEM_JOBNAME` | `ENVIRONMENT_NAME` (deployment jobs), `RELEASE_ENVIRONMENTNAME` (classic releases) | `BUILD_REASON` | `SYSTEM_JOBPOSITIONINPHASE` / `SYSTEM_TOTALJOBSINPHASE` |
| GitHub Actions | `GITHUB_WORKFLOW`, `GITHUB_JOB` | `EZTEST_DEPLOY_ENVIRONMENT` | `GITHUB_EVENT_NAME` | (matrix: `--shard`) |
| GitLab CI/CD | `CI_JOB_STAGE`, `CI_JOB_NAME` | `CI_ENVIRONMENT_NAME` | `CI_PIPELINE_SOURCE` | `CI_NODE_INDEX` / `CI_NODE_TOTAL` |
| Jenkins | `STAGE_NAME`, `JOB_NAME` | `EZTEST_DEPLOY_ENVIRONMENT` | `CHANGE_ID` (pull requests) | (parallel stages: `--shard`) |
| TeamCity | `TEAMCITY_BUILDCONF_NAME` | `EZTEST_DEPLOY_ENVIRONMENT` | | (configurations: `--shard`) |
| Bitbucket Pipelines | | `BITBUCKET_DEPLOYMENT_ENVIRONMENT` | `BITBUCKET_PR_ID` | `BITBUCKET_PARALLEL_STEP` / `_COUNT` |
| CircleCI | `CIRCLE_WORKFLOW_NAME`, `CIRCLE_JOB` | `EZTEST_DEPLOY_ENVIRONMENT` | `CIRCLE_PULL_REQUEST` | `CIRCLE_NODE_INDEX` / `CIRCLE_NODE_TOTAL` |

On any system, `EZTEST_STAGE` names the stage and `EZTEST_DEPLOY_ENVIRONMENT` the environment; `EZTEST_SCHEDULED=true` marks a scheduled run where the system has no variable for it.

## What runs where

```
$ eztest pipelines list
1     pr: trigger pr · tags @smoke · impact · budget 10m · browsers chromium · gate readiness
212   nightly: trigger schedule (0 2 * * *) · tags @regression and not @quarantined · shards 4 · browsers chromium, firefox · gate readiness
38    deploy-sit: environment sit · tags @sit or @smoke · test plan 417 · gate readiness
17    deploy-uat: environment uat · tags @uat · gate readiness · requires deploy-sit
```

```
$ eztest pipelines explain deploy-sit
deploy-sit: environment sit · tags @sit or @smoke · test plan 417 · gate readiness
would run 38 journey(s) (+1 setup/teardown); 191 not selected
  ~ seed-tenant: Setup: journey, runs once before the selected journeys
  + login: tags match @sit or @smoke (has @smoke; lacks @sit)
  + order-approval: tags match @sit or @smoke (has @sit; lacks @smoke)
  - export-csv: tags do not match @sit or @smoke (lacks @sit, @smoke)
  - legacy-report: Browsers: firefox excludes chromium
```

`explain auto` shows which entry the current CI variables pick and why. `--dynamic` also applies impact and budget, as the run would (git and the history are needed); `--json` for tools.

```
$ eztest tags report
229 journeys, 4 pipelines
untagged (3): smoke-old, tmp-check, payments-edge
in no pipeline (5): smoke-old, tmp-check, payments-edge, refund-partial, refund-full
tags: @regression (212), @smoke (31), @sit (12), ...
```

`--strict` exits 1 when a journey is in no pipeline or a pipeline selects nothing, for a CI lint step.

## Deployment test records

A run of an entry with an `environment` keeps a record of what was tested:

- the app, the **version** or build, the **environment**, the pipeline;
- the CI system, stage, build id and number, build link, commit and branch;
- the selection (journey ids, the tag expression, shards, browsers);
- the results (passed, healed, failed, errors, skipped), the **readiness** decision, score and failing gates;
- the evidence: the run id and evidence chain head, the published run on the results server, the Azure Test Plans test run, the report link (`EZTEST_REPORT_URL`).

It is written to `<runDir>/deployment.json` with a Markdown summary (`eztest-deployment.md`), and sent to the results server (`POST /api/projects/<p>/deployments`, tester role, audited) when `server:` is configured.

```bash
eztest deployments list [--environment sit] [--version 2026.10.23.1] [--pipeline deploy-sit] [--json]
eztest deployments record eztest-results/merged --pipeline deploy-sit   # a merged, sharded run
```

`requires:` and release gates are answered from these records. **Studio › Quality › Deployments** shows them as a version × environment matrix (the latest verdict per cell) and as a list with links to the run, the build and the test run.

### Azure DevOps

Inside Azure Pipelines, with Azure DevOps credentials (see [azure-devops.md](azure-devops.md#credentials)), a deployment record also:

- attaches the summary to the build (`##vso[task.uploadsummary]`, the build's Extensions tab);
- tags the build `eztest-<env>` and `eztest-<env>-<verdict>` (e.g. `eztest-sit-GO`);
- with `ado.commentWorkItems`, comments the verdict on every work item linked to the build, updated in place for each environment; with `ado.linkWorkItems`, adds a hyperlink to the evidence;
- with `testPlan`, publishes the results to that plan and suite (the same publishing as `eztest ado publish`).

Release gates on environments are described in [azure-devops.md](azure-devops.md#release-gates).

## `eztest init --ci <system>`

```bash
eztest init --ci azure | github | gitlab | jenkins | teamcity | bitbucket | circleci
```

| System | File |
|---|---|
| Azure Pipelines | `azure-pipelines.yml` |
| GitHub Actions | `.github/workflows/eztest.yml` |
| GitLab CI/CD | `.gitlab-ci.yml` |
| Jenkins | `Jenkinsfile` (declarative) |
| TeamCity | `.teamcity/settings.kts` (Kotlin DSL) |
| Bitbucket Pipelines | `bitbucket-pipelines.yml` |
| CircleCI | `.circleci/config.yml` |

Each one has:

1. **A pull-request smoke job**: `eztest run --pipeline pr` (impacted `@smoke` journeys within 10 minutes). The job fails on failed journeys and on NO_GO.
2. **A scheduled nightly regression**: `--pipeline nightly` in parallel shards, merged into one verified run (`eztest merge`, `eztest evidence verify`), then `eztest gate`. The schedule and its time zone:

   | System | Schedule | Time zone |
   |---|---|---|
   | Azure Pipelines | `schedules:` cron | UTC |
   | GitHub Actions | `on.schedule` cron | UTC |
   | GitLab | Build › Pipeline schedules (`rules: $CI_PIPELINE_SOURCE == "schedule"`) | chosen in the schedule |
   | Jenkins | `triggers { cron('''TZ=UTC ...''') }` | the `TZ=` line (else the controller's) |
   | TeamCity | `schedule { daily { hour = 2; timezone = "UTC" } }` | `timezone` |
   | Bitbucket | Repository settings › Pipelines › Schedules on the `custom: nightly` pipeline | entered in local time, stored as UTC |
   | CircleCI | `triggers: - schedule: cron` (or a scheduled pipeline setting `nightly: true`) | UTC |

3. **An on-deploy job per environment**: deploy SIT, then `--pipeline deploy-sit`; deploy UAT (with an approval where the system has one), then `--pipeline deploy-uat`, which also checks that SIT passed for this version. On Azure these are deployment jobs in the `sit` / `uat` environments; on GitLab, `environment: { action: verify }` jobs; on Bitbucket, steps after the `sit` / `uat` deployment steps; on TeamCity, configurations triggered when the deployment configuration finishes.
4. **Parallel shards with result merging**, balanced by EZTest from historical durations.
5. **JUnit in the system's test view** (Azure Tests tab, GitLab `reports: junit`, Jenkins `junit`, TeamCity XML report processing, Bitbucket `test-results/`, CircleCI `store_test_results`; GitHub has no built-in test tab, so the job summary gets `eztest ci summary` and `junit.xml` is in the artifacts), the **HTML report as an artifact**, and the **readiness gate** failing the job on NO_GO.

Retries, quarantine and test splitting are EZTest's own: `retries` (per pipeline entry), the quarantine list (`not @quarantined` in the nightly tags, and quarantined journeys never fail a run), and `--shard`. The CI system only provides machines; none of the files calls another testing tool or the CI's own test splitter.

An existing file is never overwritten. The files are validated offline in EZTest's own tests (YAML parsed with unique keys and anchors resolved; the Jenkinsfile and the Kotlin DSL checked for balanced structure, sections and references) and compared with snapshots. They are not executed against the CI services themselves.

### `eztest gate` and `eztest ci summary`

`eztest gate <runDir> [--on-no-go fail] [--on-risks warn] [--on-missing warn]` is the readiness gate for any system: it exits 1 on a failing decision and writes an annotation in Azure Pipelines (`##vso[task.logissue]`) and GitHub Actions (`::error::`). `eztest ci summary <runDir>` prints a Markdown summary of a run (decision, failures with their journey line, heals to review), e.g. for `$GITHUB_STEP_SUMMARY`.

## Scheduling outside CI

CI schedules suit regressions. For production checks every few minutes, use `eztest monitor` on journeys tagged `@monitor` ([operations.md](operations.md)), which keeps uptime and latency and alerts; it is not a pipeline entry.
