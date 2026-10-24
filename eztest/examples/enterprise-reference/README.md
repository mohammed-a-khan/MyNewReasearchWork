# Larkspur enterprise reference

This folder holds a working insurance claims system and an EZTest regression suite for it. Together they answer one question with evidence: does EZTest cover what an enterprise test team needs? The needs in question are complex logic, external test data, cross-application and front-end-to-back-end integration, code where plain English runs out, and the release gate.

Larkspur Mutual, its people, its policies and its data are invented.

[FINDINGS.md](FINDINGS.md) is the candid log of what was tried, what broke in EZTest, what was fixed and what is still missing.

## The system under test

Start the whole system with one command: `node server.ts`. It needs Node 22.5 or later and has no dependencies beyond Node core (it uses `node:sqlite`).

| Part | Where | What it is |
|---|---|---|
| MyCover customer portal | http://127.0.0.1:4700 | Single-page app with login plus TOTP MFA, quote form, claim form with file upload, a declaration in an iframe, a help popup, and a virtualized claims grid (420 rows for the commercial customer) |
| ClaimDesk back office | http://127.0.0.1:4701 | Server-rendered staff app with an approve/reject queue, authority limits and a reject confirmation dialog |
| Partner API | http://127.0.0.1:4702 | REST (`app/openapi.yaml`) plus GraphQL, using OAuth2 client credentials with two clients (broker, read-only reporting) |
| Policy service | http://127.0.0.1:4703 | Legacy SOAP 1.1 |
| Claims database | `var/larkspur.db` | SQLite, seeded on start (`REF_RESET=1` re-seeds) |
| Event bus | Kafka on `127.0.0.1:19092` | Topic `larkspur.claims.events`, keyed by claim id, with an `event-type` header; there is an outbox, so events survive a broker outage |
| E-mail | SMTP to `127.0.0.1:2525` | EZTest's mail sink receives the settlement offer, which carries a link and a one-time code |
| Nightly batch | `POST /v1/batch/settlements` | Pays accepted settlements and writes `var/drop/outbound/SETTLEMENTS_<date>_<id>.csv` atomically |
| PDF statement | `GET /app/claims/<id>/statement.pdf` | Real PDF (FlateDecode) with a footing table |

Fault switches let the system deliberately break so the suite can show what it catches:

- `REF_BUG=premium-tax` charges insurance premium tax twice.
- `REF_BUG=payout-deductible` stops deducting the excess from payouts.
- `REF_VARIANT=b` renames the "Submit claim" button to "File claim" with a new id, a UI release that should be healed rather than failed.

Kafka comes from the repo's integration container (`eztest-it-kafka`). Without Kafka the system still runs; only the three event journeys fail.

## Running the suite

From `tests/`:

```bash
cp .env.example .env                       # test-only secrets for the local system
node ../server.ts &                        # or run it from the folder above
npx eztest validate                        # every journey parses, every reference resolves
npx eztest run -e dev -w 4                 # the whole suite, 4 workers, Chromium
npx eztest run -e dev -w 4 --browsers firefox
npx eztest run -e dev --shard 1/2          # and --shard 2/2 on a second agent, then:
npx eztest merge eztest-results/<run1> eztest-results/<run2> -o eztest-results/merged
npx eztest api-scan security/api-scan.yaml -e dev --yes --readiness eztest-results/<run>
npx eztest load run load/broker-quotes.load.yaml -e dev   # baseUrl and the client secret from .env
npx eztest analyze eztest-results/<run> --policy readiness-policy.yaml   # GO / NO_GO
```

`-e sit` and `-e uat` layer `config/sit.yaml` and `config/uat.yaml` over the base config, with different hosts, a different broker and Key Vault secrets. `pipelines/azure-pipelines.yml` runs all of this in Azure DevOps: smoke, then two Chromium shards in parallel with Firefox, then merge, API scan and the load slice, then the readiness gate.

## Need → where it is proven

| Need | Files | What they show |
|---|---|---|
| **Environments and secrets** | `eztest.config.yaml`, `config/{dev,sit,uat}.yaml`, `.env.example` | Layered environments. Passwords are `secret://env/...`; the senior adjuster's is `ENC(...)`, decrypted with `EZTEST_MASTER_KEY`. Six UI roles (the portal ones with TOTP MFA; `session-check` has a session of its own because its journey signs out) and two API-only OAuth roles live in the identity vault. Secrets are masked in every report. |
| **Excel test data** | `data/rating-matrix.xlsx` (built by `data/build-workbooks.ts`), `journeys/portal/quote-matrix-{home,motor}.ez` | One workbook with a sheet per product, each filtered to a row subset, giving 7 data rows in all |
| **CSV test data** | `data/fnol-negative.csv`, `journeys/api/fnol-validation.ez` | 7 negative API cases with expected status and error |
| **JSON with JSONPath** | `data/partner-submissions.json`, `journeys/portal/broker-claim-in-grid.ez` | Examples taken from nested JSON with a JSONPath filter |
| **DB-seeded preconditions and cleanup** | `steps/claims.steps.ts`, `journeys/backoffice/*.ez` | A code step inserts the claim the test needs and the cleanup removes it |
| **Unique data per run; leased data** | `eztest.config.yaml` (`data.entities`, `gen:unique:`), `journeys/data/leased-customer-claim.ez` | Data Fabric creates a customer that no other worker can hold, and the database query is driven by it |
| **Named, parameterised SQL** | `queries/*.sql` | Includes a UNION with named binds |
| **Complex logic** | `journeys/backoffice/decide-by-authority.ez` (nested If/Otherwise on authority level), `journeys/portal/quote-matrix-*.ez` (branch on the data row), `journeys/integration/nightly-settlement-batch.ez` (For each, retry-until polling), `journeys/smoke/legacy-soap-policy.ez` and `api/graphql-claim-graph.ez` (Try/Catch), `journeys/lib/*.ez` (sub-journeys that return values), `journeys/portal/dates-on-fake-clock.ez` (frozen clock), `journeys/code/adjuster-workload.journey.ts` (loops, try/catch and poll in TypeScript) | Branching, looping, retry, error handling, reuse and money arithmetic |
| **UI ↔ API ↔ DB** | `journeys/portal/claim-submit-ui-to-api-db.ez`, `journeys/portal/claims-grid-matches-db.ez` | One claim checked on screen, through the API and in the table. All 420 grid rows are compared with a named query. |
| **API contract and schema** | `app/openapi.yaml` (api.spec), `schemas/*.json`, `journeys/api/*.ez` | Every API call is validated against the spec. Coverage is recorded and gated. GraphQL and SOAP are included. |
| **Events** | `journeys/integration/claim-event-sequence.ez` | Kafka messages are checked for order, key, header and schema |
| **Batch, files, e-mail, PDF** | `journeys/integration/nightly-settlement-batch.ez`, `statement-pdf-three-way.ez` | The batch job is started and polled, the drop-folder CSV is reconciled with the payments table, and the PDF is checked three ways against the DB and the screen |
| **Cross-app end to end** | `journeys/e2e/claim-lifecycle-cross-app.ez` | 7 stages, two actors in parallel, and Kafka, e-mail, batch and PDF in one journey |
| **Code where English runs out** | `journeys/code/*.journey.ts`, `screens/*.ts`, `elements/*.yaml`, `lib/larkspur.ts`, `plugins/larkspur-steps.mjs` | TypeScript journeys use page objects and the element repository. A helper library computes expected premiums. A plugin adds custom steps. `.ez` calls code and code calls `.ez`. |
| **BDD** | `bdd/README.md` | Placeholder; Gherkin support is being built separately |
| **Accessibility** | `journeys/nonfunctional/accessibility-*.ez` | WCAG scan plus a keyboard walk on the key pages, gated on no critical findings |
| **Security** | `journeys/nonfunctional/security-*.ez`, `security/api-scan.yaml` | Passive security lens on both apps. API scan covers BOLA (broker vs reporting), auth bypass and injection, recorded for the gate. |
| **Load** | `load/broker-quotes.load.yaml` | Quote API at a fixed rate with p95 and error-rate thresholds |
| **Release gate** | `readiness-policy.yaml`, `pipelines/azure-pipelines.yml` | Critical journeys, pass rate, healing ratio, product bugs, documents, a11y, 52 requirement ids, API coverage and API security, decided GO or NO_GO |
