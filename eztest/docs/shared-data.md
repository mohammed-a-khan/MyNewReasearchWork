# Shared test data

A value one journey captures often has to reach another journey: in the same run, in a later run, on another machine or in a later stage of a deployment pipeline. EZTest has three ways to do that, from the narrowest to the widest:

| Scope | Use |
|---|---|
| One journey hands values to the next one in the same run | `Depends on:` with ledger handoff (see [reliability.md](reliability.md#dependencies-depends-on)) |
| One value for every journey of a run | a `Setup:` journey whose `Returns:` become run-wide values |
| Across runs, suites, machines and pipeline stages | the **shared store** and **data pools** (this page) |

The shared store holds named values with a namespace and an optional expiry. A data pool holds items that are consumed once: two parallel journeys never get the same item, on one machine or on many.

## The shared store

```
Journey: Create an order
Tags: @sit

Open /orders/new
...
Capture the text of testid=order-number as orderId
Save ${orderId} to the shared store as "pending-order" for 2 days
```

```
Journey: Approve the pending order
Tags: @uat

Load "pending-order" from the shared store as orderId
Open /orders/${orderId}
Click the "Approve" button
Delete "pending-order" from the shared store
```

| Phrasing | Does |
|---|---|
| `Save ${orderId} to the shared store as "pending-order"` | Saves a value. `${name}` alone keeps the variable's type (an object stays an object); other text is interpolated. |
| `... for 2 days` / `for 12 hours` / `for 30 minutes` / `for 1 week` | The value expires then (default: `store.defaultTtl`, else never). |
| `... in namespace "uat"` | A namespace other than the default (the environment, `--env`). |
| `... as a secret` | Encrypted at rest and masked everywhere (see [Secrets](#secrets)). |
| `... for the pipeline` | Also handed to the CI pipeline (see [Pipeline stages](#pipeline-stages)). |
| `Load "pending-order" from the shared store as orderId` | Loads it into `${orderId}`. Fails when the value is missing or expired, and says which, who saved it and when. |
| `... or use "ORD-0"` | A default instead of failing. |
| `Delete "pending-order" from the shared store` | Deletes it. |

Clauses can be combined in any order: `Save ${token} to the shared store as "api-token" as a secret for the pipeline for 1 day`. A clause EZTest cannot read is an error that says what it expected, never a silent guess.

Keys are letters, digits and `_ . : @ / -`. Namespaces keep environments apart: a value saved while running `--env sit` is in namespace `sit` and is not seen by a `--env uat` run unless the step names `in namespace "sit"`.

### YAML and JSON journeys

```yaml
steps:
  - store: { save: orderId, as: pending-order, ttl: 2 days, namespace: sit }
  - store: { load: pending-order, as: orderId, default: ORD-0 }
  - store: { delete: pending-order }
  - pool:  { add: "${policy}", to: approvable-policies }
  - pool:  { take: approvable-policies, as: policy, keep: true }
  - pool:  { fill: approvable-policies, from: data/policies.csv, column: policyNo }
  - pool:  { expect: approvable-policies, atLeast: 3 }
```

Plain-English strings work as well (`- Save ${orderId} to the shared store as "pending-order"`).

### Code journeys (SDK)

```ts
import { journey, store } from '@mohammed-a-khan/eztest/sdk';

journey('Approve a policy', async ({ ui }) => {
  const policy = await store.claim<{ policyNo: string }>('approvable-policies');  // released if the journey fails
  await ui.open(`/policies/${policy.policyNo}`);
  await store.save('approved-policy', policy.policyNo, { ttl: '2 days', pipeline: true });
  const last = await store.load<string>('pending-order', { default: 'ORD-0' });
});
```

`store.save`, `store.load`, `store.delete`, `store.add(pool, ...items)`, `store.claim(pool, { keep })` and `store.available(pool)` are steps like any other: they are reported, traced and in the evidence.

## Data pools

A data pool is a list of items (policy numbers, accounts, records in a given state) that journeys consume once.

```
Add ${policy} to pool "approvable-policies"
Fill pool "approvable-policies" from "data/policies.csv" column "policyNo"
Expect pool "approvable-policies" has at least 3 items
Take one item from pool "approvable-policies" as policy
```

- **Atomic claims.** `Take one item` claims one free item for this journey attempt. On the file backend the claim is a read-modify-write under an exclusive lock file; on the results server it is one guarded `UPDATE` (only a row nobody holds, or whose claim expired, can be taken). Parallel workers, parallel processes and machines never get the same item. This is tested with two processes on one pool directory and with two clients on one results server.
- **Consumed on pass, released on failure.** When the journey passes, its items are removed from the pool. When it fails, they go back, so a later run can use them again. With `store.releaseOnFailure: false` (or per pool) a failed journey's item is consumed anyway, for data a failed attempt may have left half-changed. `Take one item ... and keep it` keeps an item claimed by a failed journey out of the pool too.
- **Crashed runs.** A claim lasts `store.claimTtl` (30 minutes). When a run dies without settling its claims, the items are free again after that.
- **Seeding from a data file.** `Fill pool "x" from "file.csv"` (or `store.pools.x.from`, applied the first time the pool is used) adds one item per row (csv, xlsx, json): the whole row, or one `column`. Items are identified by their content, and a file is seeded once per content, so running the fill again does not bring back consumed items.
- An empty pool fails the step with what to do (`Add ... to pool`, or seed it); a pool whose items are all claimed says so.

`Expect pool "x" has at least 3 items` (also `at most`, or an exact count) checks the free items, for example as a `Requires:`-style first step of a long journey.

## Run-wide values: Setup and Teardown journeys

```
Setup: Create the test tenant
Returns: tenantId, adminToken

Call API "POST /api/tenants" with body '{"name":"qa-${runId}"}' and store as tenant
Set variable tenantId to tenant.body.id
Set variable adminToken to tenant.body.token
```

```
Teardown: Delete the test tenant

Call API "DELETE /api/tenants/${tenantId}"
```

- A file starting with `Setup:` (instead of `Journey:`) is a setup journey: it runs once, before every other journey of the run. Its `Returns:` become **run variables** that every journey of the run (and the teardown) can use as `${tenantId}`, as if it had captured them itself. `Depends on:` handoffs win over run values of the same name.
- `Teardown:` runs once after all others, with the same values.
- Setup and teardown journeys are not filtered by `--tags`: they run around whatever is selected (exclude them with `--exclude-tags setup`), and a shard runs them once per shard. When nothing else is selected, they do not run.
- When a setup journey fails, the other journeys are reported as `error: beforeAll hook "..." failed`, and the run says why.
- They are the same hooks as `hooks.beforeAll` / `hooks.afterAll` in the configuration; the config's own hooks run first (setup) and last (teardown).

In YAML, use `tags: [setup]` (or `[teardown]`) with `returns:`.

## Backends

```yaml
store:
  backend: auto                 # auto: the results server when server.url is set, else local files
  dir: .eztest/store            # the file backend's directory
  namespace: sit                # default namespace (default: the environment name)
  defaultTtl: 7d                # expiry of values saved without "for ..." (default: never)
  claimTtl: 30m                 # pool claims of crashed runs free themselves after this
  releaseOnFailure: true
  pipelineOutputs: true         # output variables for values saved "for the pipeline"
  key: secret://env/EZTEST_STORE_KEY   # key for secrets (default: EZTEST_STORE_KEY, then EZTEST_MASTER_KEY)
  pools:
    approvable-policies: { from: data/policies.csv, column: policyNo }
    claim-accounts: { releaseOnFailure: false, claimTtl: 2h, namespace: shared }
```

### Local files (default)

`.eztest/store/<namespace>/values.json` and `.eztest/store/<namespace>/pools/<pool>.json`. Every change is made under an exclusive lock file and written to a temporary file that replaces the old one, so parallel workers and processes never lose a write. A lock left by a crashed process is broken after 30 seconds. Put `dir` on a shared file system to share it between machines, or use the results server.

### The results server

With `server.url` configured (see [server.md](server.md)) the store and the pools live on the EZTest results server, per project:

- shared by every machine, CI agent and pipeline stage that uses the project;
- **RBAC**: viewers read; testers (`store.write`) save, delete, add and claim;
- **audited**: every save, delete, purge, pool add, claim, release, consume and removal is in the hash-chained audit log, with the token or person that did it;
- **namespaces per environment** and **TTL**, as for files.

`eztest store list | get | set | delete | purge | pools | pool-add` work on whichever backend is configured, for example to seed a pool from a pipeline step: `eztest store pool-add approvable-policies --from data/policies.csv --column policyNo`.

## Secrets

`Save ${token} to the shared store as "api-token" as a secret` (or `store.save(key, value, { secret: true })`, or `Add ... to pool "x" as a secret`):

- The value is **sealed on the machine that saves it**: AES-256-GCM with a fresh IV per value and a key derived (scrypt) from `EZTEST_STORE_KEY`, else `EZTEST_MASTER_KEY` (at least 16 characters), else `store.key`. Store files, the results server's database, the pipeline export and GitHub outputs hold only the sealed form (`EZS1:...`). The results server refuses a secret that is not sealed.
- Every machine that loads it needs the same key. A missing or wrong key fails with a clear message, never with garbage.
- The plain value is registered with the run's secret masker when it is saved or loaded: it is `****` in logs, step results, captured values, the stored run (`run.json` ledgers are masked) and reports, and Studio shows only `****`.
- In Azure Pipelines it is set with `issecret=true`; in GitHub Actions it is masked with `::add-mask::` and passed sealed.

## Pipeline stages

A value saved `for the pipeline` is handed to the CI system when the run ends, so a later stage can use it.

```
Save ${orderId} to the shared store as "pending-order" for the pipeline
```

When the run ends, EZTest:

1. writes `store-export.json` into the run directory and into the output directory (`eztest-results/store-export.json`): the values marked for the pipeline (secrets sealed);
2. in **Azure Pipelines** (`TF_BUILD`), prints `##vso[task.setvariable variable=pending_order;isOutput=true]ORD-7` (`issecret=true` for secrets). Names are the key with other characters replaced by `_`; values that are not text are JSON;
3. in **GitHub Actions** (`$GITHUB_OUTPUT`), appends `pending_order=ORD-7` (heredoc syntax for multi-line values).

`EZTEST_PIPELINE_OUTPUTS=azure,github` (or `none`) overrides the detection; `store.pipelineOutputs: false` turns it off.

A later stage `Load`s the value in one of three ways:

- **The results server:** with `server.url` configured, the value is simply there (the store is shared).
- **The export artifact:** publish `eztest-results/store-export.json` as an artifact, download it in the later stage and set `EZTEST_STORE_IMPORT=<file>` (several files: separated by `;` or `,`). A key this run did not write itself is read from the import first.
- **An output variable mapped into the environment:** `EZTEST_STORE_<KEY>` (key upper-cased, `-` as `_`), e.g. `EZTEST_STORE_PENDING_ORDER`. JSON values are parsed; sealed values are opened with the store key.

Azure Pipelines, a later stage reading an output variable of a deployment job:

```yaml
- stage: TestUAT
  dependsOn: TestSIT
  variables:
    EZTEST_STORE_PENDING_ORDER: $[ stageDependencies.TestSIT.eztest.outputs['eztest.eztest.pending_order'] ]
  jobs: ...
```

(For a regular job the expression is `stageDependencies.<stage>.<job>.outputs['<step>.<name>']`; for a `runOnce` deployment job the job name comes first inside the brackets too, `outputs['<job>.<step>.<name>']`, as above. The EZTest templates name the run step `eztest`.)

The artifact handoff:

```yaml
# stage SIT, after eztest run
- task: PublishPipelineArtifact@1
  inputs: { targetPath: eztest-results/store-export.json, artifact: eztest-store }
# stage UAT, before eztest run
- task: DownloadPipelineArtifact@2
  inputs: { artifact: eztest-store, path: $(Pipeline.Workspace)/store }
- script: npx eztest run --pipeline deploy-uat
  env: { EZTEST_STORE_IMPORT: $(Pipeline.Workspace)/store/store-export.json, EZTEST_STORE_KEY: $(EZTEST_STORE_KEY) }
```

GitHub Actions:

```yaml
jobs:
  sit:
    outputs: { pending_order: '${{ steps.eztest.outputs.pending_order }}' }
    steps:
      - id: eztest
        run: npx eztest run --pipeline deploy-sit
  uat:
    needs: sit
    steps:
      - run: npx eztest run --pipeline deploy-uat
        env: { EZTEST_STORE_PENDING_ORDER: '${{ needs.sit.outputs.pending_order }}' }
```

## Studio

**Project › Shared data** lists the store's values per namespace (secret values as `****`), when each expires and which journey saved it. Values can be added, edited (text or JSON, expiry, secret, for the pipeline), expired at once, deleted, and expired values purged. Each data pool opens to its items and claims: add items (one per line), release an item a crashed run still holds, or remove an item.

## Limits

- The file backend is shared across machines only through a shared file system; the lock protocol assumes the file system honours exclusive creates (local disks, NFSv4, SMB do).
- Pool seeding from a data file is idempotent per file content; a run on another machine can re-add a row in the few milliseconds between another machine's seeding and its seed marker. Seed big pools once (`eztest store pool-add --from`) in a pipeline step when that matters.
- Output variables are emitted when the run ends, not when the step runs.
- GitHub Actions cannot pass secret outputs between jobs in clear text: the sealed value is passed, and the next job needs the same store key.
