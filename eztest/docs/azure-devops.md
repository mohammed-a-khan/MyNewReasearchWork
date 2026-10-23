# Azure DevOps

EZTest works with every part of Azure DevOps: Test Plans in both directions,
Boards, Repos and pull requests, and Pipelines (a task, a results tab and
multi-stage templates). Everything goes through EZTest's own REST client
(`src/alm-ado`), with no Azure DevOps SDK.

- [Connect](#connect): organisation or server URL, credentials
- [Test Plans](#test-plans): import, sync, suites, configurations, publish
- [Boards](#boards): bugs, requirements, comments, area and iteration
- [Repos and pull requests](#repos-and-pull-requests)
- [Pipelines](#pipelines): the EZTest task, the results tab, YAML templates
- [Limits](#limits)

## Connect

```yaml
ado:
  organizationUrl: https://dev.azure.com/contoso   # or https://tfs.contoso.com/tfs/DefaultCollection
  project: Shop
  apiVersion: '7.1'                              # Azure DevOps Server 2022: 7.0; 2020: 6.0
  repository: shop-web                           # Azure Repos repository (default: from the git remote)
  testPlanId: 417                                # per environment in config/<env>.yaml
  testSuiteId: 418
  auth:
    type: auto                                   # see below
```

In Azure Pipelines, `organizationUrl` and `project` default to
`System.CollectionUri` and `System.TeamProject`.

### Credentials

`ado.auth.type` picks how EZTest authenticates. With `auto` (the default) the
first that applies wins: a PAT, workload identity, a service principal secret,
then the pipeline's `System.AccessToken`.

| Type | Configure | Notes |
|---|---|---|
| `pat` | `ado.pat: secret://env/ADO_PAT` (or `ENC(...)`) | Basic auth. Scopes: Test Management (read & write), Work Items (read & write), Code (status, read & write) for PR features. |
| `system-access-token` | map it into the step: `env: { SYSTEM_ACCESSTOKEN: $(System.AccessToken) }` | No secret to store. Grant the project's build service "Create test runs", "Edit work items" and "Contribute to pull requests" as needed. The EZTest task picks it up without the mapping. |
| `service-principal` | `tenantId`, `clientId`, `clientSecret: secret://env/SP_SECRET` | Microsoft Entra ID client credentials grant for the Azure DevOps resource (`499b84ac-1321-427f-aa17-267ca6975798/.default`). Add the service principal to the organisation. |
| `workload-identity` | `tenantId`, `clientId`, `serviceConnectionId` | **No secret anywhere.** The federated assertion is an OIDC token from the Azure Resource Manager service connection (workload identity federation) of the pipeline (`System.OidcRequestUri`), from GitHub Actions (`permissions: id-token: write`) or from a projected token file (`federatedTokenFile` / `AZURE_FEDERATED_TOKEN_FILE`, e.g. AKS). |
| `managed-identity` | `managedIdentityClientId` (user-assigned) or nothing (system-assigned) | Azure VM / scale-set agents (IMDS) and App Service, Functions, Container Apps (`IDENTITY_ENDPOINT`). Add the identity to the organisation as a user. |

Workload identity in a pipeline:

```yaml
- task: EZTest@1
  inputs: { command: all, publishTestPlans: true }
  env:
    SYSTEM_ACCESSTOKEN: $(System.AccessToken)      # only used to request the OIDC token
    SYSTEM_OIDCREQUESTURI: $(System.OidcRequestUri)
```

```yaml
# eztest.config.yaml
ado:
  auth: { type: workload-identity, tenantId: <tenant-guid>, clientId: <app-guid>, serviceConnectionId: <service-connection-guid> }
```

Tokens are cached until five minutes before they expire, refreshed once on a
401, registered with the run's secret masker, and never logged: every error
message is redacted (raw and base64 forms). Credentials are only sent to the
organisation's own origins (plus its `vssps`, `vstmr` and `vsrm` hosts on
dev.azure.com), and never over plain HTTP except to localhost. A bad PAT shows
up as Azure DevOps' sign-in page (HTTP 203): EZTest reports it as an
authentication failure. `eztest ado whoami` checks the setup and prints the
identity and method, never the token.

**Azure DevOps Server (on-premises).** Set `organizationUrl` to the collection
URL and `apiVersion` to what the server supports (2022: `7.0`, 2020: `6.0`).
A request for a newer version fails with the server's own "out of range"
message. Identity calls go to the collection itself.

## Test Plans

### Import manual test cases

```bash
npx eztest ado import --plan 417 --suite 418          # the suite and its child suites
npx eztest ado import --query "SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'Test Case' AND [System.AreaPath] UNDER 'Shop\Checkout'"
npx eztest ado import --saved-query "Shared Queries/Regression" -o journeys/regression
npx eztest ado import --tag smoke                     # or --area 'Shop\Checkout'
```

For each test case:

- every step goes through the `.ez` grammar; its expected result becomes a
  post-condition of that step (`  Expect …`);
- shared steps are expanded where they are referenced, under a
  `# Shared steps #<id>: <title> (<link>)` comment;
- parameters become an `Examples:` table (`@term` becomes `<term>`), with
  shared parameter sets resolved;
- `Tags:` gets `@TestCaseId:<id>` (plus `@TestPlanId` / `@TestSuiteId` when
  imported from a suite) and the work item's tags; `Requirements:` gets the
  requirements the case tests; the priority becomes `Risk:`;
- a line the grammar cannot read is kept as
  `# TODO (not converted): <text> (test case #123 step 4: <link>)`, so nothing
  is dropped and every gap links back to the test case.

Lines read from free text are marked `[unverified]` until
`eztest import --verify` replays them; `import-report.md` lists coverage and
every TODO.

### Create and update test cases from journeys

```bash
npx eztest ado sync --dry-run                 # what would change, with the diff of each journey
npx eztest ado sync --write --plan 417 --suite 418
```

- Steps and expected results are written in Azure Test Plans' format (one
  action per step, its expectations as the expected result; blocks keep their
  nesting as indented actions ending in `End`), Examples rows as parameters
  and data.
- **Associated automation** is set (`AutomatedTestName` = `eztest.<journey
  id>`, `AutomatedTestStorage` = the journey file, `AutomatedTestType` =
  `EZTest`, a stable `AutomatedTestId`, `AutomationStatus` = Automated), so
  Azure DevOps lists the case as automated.
- New test cases get `@TestCaseId:<id>` written into the journey's `Tags:`
  (YAML and JSON journeys: the `tags` list). Without `--write` the diff is
  printed; a file that changed meanwhile is never overwritten.
- Existing test cases are updated in place, only the fields that changed.
- `Requirements:` with numeric ids are linked as Tests / Tested By.
- `@library` journeys are not test cases.

### Suites and configurations

```bash
npx eztest ado suite --plan 417 --tag smoke --prune     # static suite "@smoke" = the test cases of journeys tagged @smoke
npx eztest ado suite --plan 417 --name "Checkout (query)" --query "SELECT ... WHERE [System.Tags] CONTAINS 'checkout'"
npx eztest ado configurations list
npx eztest ado configurations ensure "Firefox on Linux" --browser firefox --os Linux
```

Map a browser or an environment to a test configuration:

```yaml
ado:
  configurations: { chromium: "Windows + Chrome", firefox: "Firefox on Linux", uat: 42 }
```

Publishing then uses the test points of that configuration (`--env` first,
then the run's browser).

### Publish results

```bash
npx eztest ado publish eztest-results/<run> --trace --create-bugs --flaky --comment-requirements
```

With `ado.publishResults: true`, `eztest run` publishes every run this way after its analysis.
Either way the publish result (success, partial or failed, and why), the test run, each
result, test case, plan and suite, the bugs, and the build and release are recorded in the run's
`integrations.json`; the HTML report is rendered again with those links and attached (with the
one-page `summary.html`) to the test run ([docs/reports.md](reports.md#what-the-report-shows)).

| What | How it appears in Azure Test Plans |
|---|---|
| Journeys | One result per test case and point, on the run's configuration |
| Examples rows | Iterations of that result (with the row's parameter values) |
| Steps | Action results per step (`actionPath` of the test case step), matched by text, then by `@parameter`, then by position |
| Screenshots, traces | Attached to the result, on the iteration and the step they belong to (`--trace` adds trace bundles) |
| Evidence pack | Attached to the run (`<runDir>/evidence-pack.zip` or `--evidence-pack`) |
| Healed steps | Result and action comments: `healed: <step> <tier> confidence=… verified=… old -> new \| outcome: passed with healed step(s) awaiting review in EZTest` |
| Build and release | Run linked to the build (`Build.BuildId`), release and environment (`Release.ReleaseUri`, `Release.EnvironmentUri`); owner and runner from `Build.RequestedFor` |
| Re-runs | A journey that passed on a retry says so in the result comment ("re-run: … passed on attempt 2") |
| Flaky | `--flaky` marks retried passes and journeys the history scores as flaky through the flaky-test result metadata API, per branch; a server without that API gets a warning instead |
| Commit | The run comment names the commit and branch the run tested |

Publishing is safe to repeat: POSTs are never blindly retried; after a
transient failure EZTest looks up what the server already has (run by name,
results by test point, attachments by name, bugs by signature) and sends only
what is missing.

## Boards

- **Bugs** (`--create-bugs`, or "File bug in ADO" in Studio triage) are
  deduplicated by failure signature (`ezsig-<hash>` tag), carry repro steps,
  cited evidence ids, the commit and branch, `Found In` = the build number,
  link the failing test case (Tested By) and the journey's requirements
  (Related), and are assigned to the journey's owner from CODEOWNERS (an
  e-mail owner, or `vcs.owners: { "@alice": "alice@contoso.com" }`).
- **Area and iteration paths** for bugs and created test cases:

  ```yaml
  ado:
    areaPath: Shop
    iterationPath: Shop\Sprint 42
    paths:
      - { tag: payments, areaPath: Shop\Payments }
      - { journeys: "journeys/admin/**", areaPath: Shop\Admin, iterationPath: Shop\Admin\Backlog }
  ```

- **Requirements by WIQL into traceability.** `eztest ado requirements
  --area Shop` (or `--query`, `--saved-query`) writes
  `.eztest/requirements-ado.json`, which the Quality Center's traceability
  page already reads (the page's "Load from Azure DevOps" uses the same code).
  Requirements no journey covers show as gaps.
- **Result comments on user stories.** `--comment-requirements` (or
  `ado.commentOnRequirements: true`) posts one comment per requirement the run
  covers (journeys, status, test cases, run link), updated in place on later
  runs.

## Repos and pull requests

`eztest pr report <runDir>` (the EZTest task does it in PR builds) posts:

- the **status** `EZTest` on the pull request: `succeeded` for GO, `failed`
  for NO_GO; GO_WITH_RISKS is `succeeded` unless `--on-risks failure` (use it
  as a required status in a branch policy);
- one **summary thread**: failures with the journey file and line, triage,
  heals awaiting review, impacted journeys (`--mapping impact.yaml`) and
  failing readiness gates. Re-runs edit the same thread; it is resolved when
  the run is GO;
- **line threads** on each failing journey step (and warnings on healed
  steps), reused on re-runs and marked fixed once the line passes.

Outside a pull request the status goes on the commit.

**Pull requests from Studio.** Accepting a heal, approving visual baselines or
changing the quarantine in Studio adds a proposal to the Source Control page.
"Open pull request" (or `vcs.pullRequests.onHealAccept` / `onBaselineApprove`
/ `onQuarantine: true` to do it automatically) commits the changed files on a
new branch based on the target branch, pushes it with your git credentials
and opens a pull request in Azure Repos with reviewers from CODEOWNERS
(resolved through the identities API; `[Project]\Team` groups and e-mail
addresses work). Your checkout, index and current branch are not touched: the
commit is built in a private index. See [git.md](git.md#pull-requests-from-studio).

## Pipelines

### The EZTest task

The extension in `integrations/azure-devops/` contributes the **EZTest** task
and an **EZTest** tab on pipeline runs.

```yaml
- task: EZTest@1
  inputs:
    command: all              # install -> run -> summary -> publish -> PR -> gate
    environment: sit          # config/sit.yaml: that environment's URLs and Test Plans ids
    shard: auto               # one shard per parallel job (System.JobPositionInPhase / TotalJobsInPhase)
    publishTestPlans: true
    createBugs: true
    onNoGo: fail              # fail | warn | pass
    onRisks: warn             # fail | warn | pass
```

What it does, in order: `npm ci` (when there is a lockfile), an optional
setup command, `eztest run` (with `--shard i/n` when the installed EZTest
supports it; otherwise every job runs everything and the task warns),
`eztest ado summary` (the results tab data and the build summary), the JUnit
results to the pipeline Tests tab, the run directory as a pipeline artifact,
an optional signed evidence pack, Azure Test Plans, the PR status and comment,
and the readiness gate. `command: merge` merges shard runs with `eztest merge`
when that command is available.

The gate decides the step result: **NO_GO fails the step (and so the stage),
GO_WITH_RISKS makes it "succeeded with issues"**, both configurable. Without a
readiness policy, failing journeys fail the step (`failOnTestFailure`).
Output variables: `EztestDecision`, `EztestRunDir`.

The job's own token (`System.AccessToken`) is passed to EZTest and masked;
the task's inputs are not passed to child processes. Every command is spawned
without a shell.

### The results tab

The task attaches `eztest-tab.json` to the build
(`##vso[task.addattachment type=eztest.report]`); the tab
(`web/results-tab.html`) reads it through the Build REST API with the
extension's token and shows the decision, the failing gates, the failures with
their journey line, the heals awaiting review and every journey's status (one
section per job when the run was sharded). It renders text only (no HTML from
the report), follows the host theme and has its own strict CSP.

### Package and install

```bash
cd integrations/azure-devops
npm install                    # tfx-cli and azure-devops-extension-sdk (dev dependencies of the extension only)
npm run validate               # task.json against the official task schema, the manifest against its schema
npm run package -- --publisher <your-publisher-id>   # dist/<publisher>.eztest-1.0.0.vsix
```

Upload the `.vsix` to your organisation (Organization settings > Extensions >
Manage extensions > Upload), or publish it to your private Marketplace
publisher. Without the extension, the YAML templates run the same steps with
the CLI (`useTask: false`).

### YAML templates

`integrations/azure-devops/templates/` (also shipped in the npm package):

| File | Use |
|---|---|
| `eztest-steps.yml` | The steps (task or CLI), parameters: environment, journeys, tags, Test Plans ids, configuration, gate actions |
| `eztest-stage.yml` | One stage per environment with parallel shard jobs; NO_GO fails the stage so promotion stops |
| `azure-pipelines.multistage.yml` | Example: PR validation (smoke, PR status), then deploy and test SIT and UAT, each with its own plan and suite |

`eztest init --ci azure` writes a single-stage pipeline that points here.

## Limits

- Not verified against a live Azure DevOps organisation or server in this
  repository's test suite: everything is tested against
  `test/alm-ado/mock-ado-server.ts`, which implements the endpoints, api-version
  rules, auth, paging and error shapes as documented.
- The flaky-test result metadata API (`vstmr` host, `7.1-preview.4`) is a
  preview API; when it is missing the result is commented as a re-run instead.
- Step results map journey steps to test case steps by text and position;
  test cases imported from free text whose steps were heavily edited may map
  only partly (unmatched steps get no action result). Shared steps inside a
  test case are not given per-step results.
- Re-runs are reported in the result comment; earlier attempts' results are
  not kept by the runner, so they are not published as sub-results.
- Bug assignment needs an e-mail owner or a `vcs.owners` mapping; GitHub-style
  `@user` owners are not Azure DevOps identities.
- The results tab uses the build attachments API; very large runs are
  summarised (the full report is in the pipeline artifact).
