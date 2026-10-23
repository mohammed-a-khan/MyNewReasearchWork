# Results server

`eztest server` is an optional central service for teams. Studio and the CLI stay local-first, and nothing requires the server to run tests. When `server:` is configured, the server adds the following:

- run history and evidence from every machine, with cross-team dashboards;
- shared heal decisions, quarantine and triage overrides;
- historical durations for sharding, and history for `--last-failed`;
- resource locks across CI agents that share no file system;
- an append-only, hash-chained audit log;
- evidence retention per project.

## Start it

```bash
EZTEST_SERVER_BOOTSTRAP_TOKEN=$(openssl rand -hex 32) eztest server --host 0.0.0.0 --port 8080 --data-dir /srv/eztest
```

Or use `deploy/docker-compose.yml`, which runs the server, PostgreSQL and a runner (see [operations.md](operations.md)).

`eztest-server.yaml` holds the settings. `${VAR}` is replaced from the environment:

```yaml
host: 0.0.0.0
port: 8080
dataDir: /srv/eztest                  # SQLite database (default) and run files
publicUrl: https://eztest.example.com # behind a proxy: the external URL (OIDC redirect, secure cookies)
trustProxy: true                      # trust X-Forwarded-For / -Proto from your proxy only
database:                             # default: { driver: sqlite } in dataDir
  driver: postgres                    # or mssql; uses the same optional pg / mssql drivers as DB steps
  connectionString: ${DATABASE_URL}
oidc:                                 # sign-in for people (any OpenID Connect provider)
  issuer: https://login.example.com/realms/qa
  clientId: eztest
  clientSecret: ${OIDC_CLIENT_SECRET} # omit for a public client (PKCE only)
  groupsClaim: groups
access:                               # roles for people, per project ("*" = all projects)
  - { subject: "group:qa-leads", project: "*", role: approver }
  - { subject: "user:ann@example.com", project: payments, role: admin }
retention:
  defaultDays: 90                     # delete run evidence after 90 days...
  projects: { payments: 400 }         # ...per-project overrides
maxUploadMb: 512
sessionHours: 12
authRateLimit: 20                     # sign-in and failed-token attempts per minute per client
anonymousRead: false                  # true only on trusted internal networks
```

`EZTEST_SERVER_DATABASE_URL` and `EZTEST_SERVER_PUBLIC_URL` override the database and the public URL, which is convenient in containers.

## Tokens, people and roles

- **API tokens** are for CI. Create one with `eztest server token create --name ci --grant payments:tester`, which works directly on the server database, or with `POST /api/tokens` as an admin. Tokens are shown once and stored only as SHA-256 hashes. Each token carries its own grants and can be revoked or given an expiry.
- **People** sign in with OIDC: the authorization code flow with PKCE (S256), `state` and `nonce`. The ID token is verified locally against the provider's JWKS (RS256, PS256 or ES256), and the issuer, audience, expiry and nonce are checked. Grants come from `access:` and from `PUT /api/projects/<p>/access` (`user:<email>`, `sub:<id>`, `group:<name>`). Without OIDC, a person can sign in to the dashboards with an API token.
- The bootstrap token in `EZTEST_SERVER_BOOTSTRAP_TOKEN` is an admin token for the first setup. It is never stored. Remove it once real admin tokens exist.

| Action | viewer | tester | approver | admin |
|---|---|---|---|---|
| Read runs, dashboards, history, durations, shared state, the shared store and pools, deployment records | ✓ | ✓ | ✓ | ✓ |
| Publish runs, use locks, override triage, write the shared store, claim pool items, record deployments | | ✓ | ✓ | ✓ |
| Accept or reject heals, change quarantine, sign readiness, upload signed packs, read the audit log | | | ✓ | ✓ |
| Manage tokens, access and retention | | | | ✓ |

Roles are granted per project. A grant on `*` applies to every project.

## Publishing runs

```bash
eztest run --publish                    # uses server.url
eztest publish eztest-results/run-...   # an existing run directory
eztest merge shards -o merged --publish
```

Publishing has three steps. The run (`run.json`) and its evidence manifest are registered. Every evidence file is uploaded and checked against its manifest hash; a mismatch is refused with HTTP 422. The server then re-verifies the whole chain and records the result, so the dashboards show `verified` or `NOT verified`. Paths are confined to the run, and only manifest files plus the standard report files are accepted.

## Shared state

With `server.sharedState: true` (the default), `eztest run` pulls heal decisions, quarantine and triage overrides before it runs. A heal that a reviewer rejected on the server therefore fails the step as a suspected regression on every machine.

`eztest studio` syncs these three kinds of state at start, every minute, and a second after the Studio changes one of them, pushing local changes with the reviewer's role. The local files in `.eztest/` are the working copy and the fallback: when the server cannot be reached, the run says so and uses them. Local changes that were not yet pushed, for example when a CI token lacks the approver role, are kept and merged over the server copy.

## Shared test data and deployment records

With `server.url` configured, the shared store and data pools ([shared-data.md](shared-data.md)) live on the server, so values and pool items are shared by every machine, CI agent and pipeline stage of the project. Values are kept per namespace (the environment) with their expiry; secret values arrive sealed by the client and are stored as they came (the server refuses a plain secret). Pool items are claimed with a single guarded `UPDATE` (only an item nobody holds, or whose claim expired), so concurrent claims from many machines never get the same item. Deployment test records ([pipelines.md](pipelines.md#deployment-test-records)) say what was tested in which environment for which version; `requires:` and release gates read them. Every save, delete, purge, pool add, claim, release, consume and removal and every deployment record is in the audit log. Databases created before these existed are migrated on start (schema 3).

## EZTest contracts

The server keeps EZTest contracts for `eztest contracts publish | verify --publish | record-release | can-release`: every contract published per consumer version and branch, every verification result per provider version (against the contract's content hash) and the version of each application released to each environment. `can-release` is answered from those records; see [api-contracts.md](api-contracts.md#publishing-releases-and-can-release-eztest-results-server). Each write is in the audit log. Databases created before contracts existed are migrated on start (schema 2).

## Audit log

Every state change that matters is appended to `ez_audit` with the actor, the action, the project, the target and the details. This covers:

- runs published;
- heals accepted or rejected;
- quarantine added, changed or removed;
- triage overrides;
- readiness sign-offs and evidence-pack uploads;
- shared store and data pool changes, and deployment test records;
- tokens and grants;
- retention changes and retention runs;
- sign-ins.

Each entry's hash covers its fields and the previous hash, so changing, deleting or inserting an entry breaks the chain at that point. `GET /api/audit/verify`, `eztest server audit-verify` and the `/ui/audit` page all check the chain.

## Retention

Run evidence older than the project's retention (`PUT /api/projects/<p>/retention`, else `retention.projects`, else `retention.defaultDays`) is deleted by a daily sweep, or on demand with `POST /api/retention/run`. Run metadata, the audit log and uploaded **signed evidence packs** are kept. A signed run without an uploaded pack keeps its evidence, because that evidence is the only copy of what was signed.

## Security

The server is built to be secure by default:

- **TLS:** set `tls: { cert, key }`, or terminate TLS at a reverse proxy and set `publicUrl: https://...` and `trustProxy: true`. HSTS is sent on secure deployments. Do not expose a plain-HTTP server beyond localhost.
- **CSRF:** cookie-authenticated writes need the session's CSRF token (header `X-CSRF-Token`, or `_csrf` in forms) and a same-origin `Origin`. Requests with a bearer token are not affected.
- **CSP:** dashboards are server-rendered HTML with `default-src 'none'; style-src 'self'` and no scripts at all. Uploaded run files are served with `sandbox`.
- **Cookies:** cookies are HttpOnly and SameSite=Lax, and Secure on HTTPS. Session ids are stored as hashes.
- **Rate limiting:** sign-in and failed-token attempts are rate limited per client address.
- **Logging:** logs are JSON lines with the method, path (no query string), status, duration and actor. Tokens, cookies, Authorization headers and token-shaped values are never written.

## Health

- `GET /healthz` reports liveness.
- `GET /readyz` reports that the database answers.
- `GET /api/version` returns the server and API versions.

## API summary

| Method and path | Role |
|---|---|
| `POST /api/projects/:p/runs`, `PUT .../runs/:id/files?path=`, `POST .../runs/:id/complete` | tester |
| `GET /api/projects/:p/runs[/:id[/journeys\|/files?path=]]` | viewer |
| `GET /api/projects/:p/{history,durations,flaky,traceability,heals,trends.csv}` | viewer |
| `GET\|POST /api/projects/:p/state/{heal-decisions,quarantine,triage-overrides}` | viewer / role per kind |
| `POST /api/projects/:p/locks/{acquire,renew,release}` | tester |
| `GET /api/projects/:p/store[?namespace=]`, `GET .../store/:ns/:key` · `GET /api/projects/:p/pools[?namespace=]`, `GET .../pools/:ns/:pool` | viewer |
| `PUT\|DELETE /api/projects/:p/store/:ns/:key`, `POST .../store-purge` · `POST .../pools/:ns/:pool/{items,claim,release,consume}`, `DELETE .../pools/:ns/:pool/items/:id` (permission `store.write`) | tester |
| `POST /api/projects/:p/deployments` (permission `deployment.record`) · `GET /api/projects/:p/deployments[?environment=&version=&pipeline=]` | tester · viewer |
| `POST /api/projects/:p/{contracts,verifications}` | tester |
| `POST /api/projects/:p/releases` (permission `contracts.release`) | approver |
| `GET /api/projects/:p/{contracts[/:consumer/:provider/:version],verifications,releases,can-release}` | viewer |
| `POST /api/projects/:p/runs/:id/sign`, `PUT .../runs/:id/pack` | approver |
| `GET /api/audit[?project=]`, `GET /api/audit/verify` | approver |
| `GET\|POST /api/tokens`, `DELETE /api/tokens/:id`, `PUT /api/projects/:p/access`, `PUT .../retention`, `POST /api/retention/run` | admin |

Dashboards are served at `/ui`, `/ui/p/<project>`, `/ui/p/<project>/runs/<id>` and `/ui/audit`, and they print cleanly.
