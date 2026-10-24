# API security scan pack

EZTest's own deterministic security scanner over your API surfaces and OpenAPI specs. It extends the security lens (headers, cookies, authorization matrix, IDOR) into the OWASP API Security Top 10 (2023), writes evidence for every finding, and feeds a readiness gate. It shells out to nothing — there is no ZAP or any other scanner — so a scan is reproducible.

```
eztest api-scan scan.yaml --spec specs/shop.yaml --yes --readiness runs/<runId>
```

## Safe by default

A scan sends real requests, so it is locked down:

- It runs **only against hosts on `security.api.allowedHosts`** (exact or `*.example.com`) — never production — and refuses otherwise.
- It needs an explicit **opt-in** (`--yes`, or `confirm: true` in code).
- **Mutating probes** (mass assignment, injection on POST/PUT/PATCH) run only with `security.api.allowMutating` (or `--allow-mutating`).

```yaml
security:
  api:
    allowedHosts: ["staging-api.example.com", "127.0.0.1"]
    allowMutating: false
    failOn: medium   # the apiSecurity readiness gate fails on findings at or above this severity
```

## Probes and OWASP mapping

| Probe | What it does | OWASP API 2023 |
|---|---|---|
| authBypass | a protected endpoint answers 2xx with no credentials | API2 Broken Authentication |
| bola | one identity reads another's object (extends the IDOR probe) | API1 Broken Object Level Authorization |
| massAssignment | a write accepts a sensitive property it should ignore | API3 Broken Object Property Level Authorization |
| injection | safe, marked SQL/NoSQL/XSS/path-traversal/SSRF payloads; looks for DB errors, reflection or 500s | API8 / API7 |
| rateLimit | a burst is never throttled (no 429, no RateLimit header) | API4 Unrestricted Resource Consumption |
| securityHeaders | nosniff / HSTS / version disclosure on API responses | API8 Security Misconfiguration |
| cors | an arbitrary Origin is reflected (worse with credentials) | API8 |
| verboseErrors | a malformed request leaks a stack trace or framework internals | API8 |

Endpoints come from an OpenAPI spec (`--spec`, enumerated with their auth requirement and object-id parameters) and/or a scan file listing targets, tokens (`secret://`), a second identity for BOLA, object ids and sample bodies. Every finding carries masked request/response evidence and its OWASP category.

## Readiness

With `--readiness <runDir>` the report is written into the run (`api-security.json`) and recorded as evidence. Add the gate to the readiness policy:

```yaml
gates:
  apiSecurity: { failOn: medium }
```

The gate fails (a blocker) when any finding is at or above `failOn`, citing the recorded scan.

Exported from `@eztech/eztest/lenses` (`scanApiSecurity`, `ApiSecurityScanner`, `targetsFromSpec`, `evaluateApiSecurityGate`).
