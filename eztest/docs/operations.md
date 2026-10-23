# Packaging and operations

## Docker

The official image is built from `Dockerfile` on `node:22-bookworm-slim`. It contains Node 22, the system libraries and fonts Chrome and Firefox need, Chrome for Testing installed by EZTest itself (`eztest install-browsers`, into `/opt/eztest/browsers`), the `eztest` CLI and the PostgreSQL driver for the results server. No other testing tool and no third-party browser image is involved.

```bash
docker build -t eztest .
docker build --build-arg EZTEST_BROWSERS="chromium firefox" -t eztest .    # Firefox too
docker build --build-arg EZTEST_BROWSERS="chromium@141.0.7390.54" -t eztest .   # pin the Chrome build
docker run --rm -v "$PWD:/work" eztest run --base-url https://app.example.com
docker run --rm -v "$PWD:/work" eztest evidence verify eztest-results/<run>
docker run --rm -p 8080:8080 -v eztest-data:/data eztest server --host 0.0.0.0 --data-dir /data
```

Build arguments:

| Argument | Default | Meaning |
|---|---|---|
| `EZTEST_BROWSERS` | `chromium` | Space-separated `eztest install-browsers` targets: `chromium`, `chrome-headless-shell`, `firefox`, `firefox-esr`, each optionally `@<version>` |
| `NODE_IMAGE` / `RUNTIME_IMAGE` | `node:22-bookworm-slim` | Base images of the build and runtime stages |
| `SYSTEM_DEPS` | `apt` | `none` skips the apt step when the runtime image already has the browser libraries |

Browser support: Chrome, Edge, Chromium and Electron over CDP; Firefox over WebDriver BiDi. There is no Safari/WebKit. `docker run --rm eztest doctor` lists the browsers the image has.

The image runs as the unprivileged `eztest` user (uid 10001) with `/work` as the working directory. Mount your project there. To reach an app on the Docker host, use `--network host` (Linux) or `http://host.docker.internal:<port>`. Behind a TLS-inspecting proxy, build with `--secret id=ca,src=/path/ca.crt` and `--build-arg HTTPS_PROXY=...`; `eztest install-browsers` honours `HTTPS_PROXY` / `NO_PROXY`. Without access to Google's or Mozilla's download servers, point `EZTEST_CFT_DOWNLOAD_BASE` / `EZTEST_FIREFOX_DOWNLOAD_BASE` at a mirror.

`deploy/docker-compose.yml` runs the results server, PostgreSQL, and a runner that tests the mounted project and publishes the run:

```bash
cp deploy/.env.example deploy/.env       # set POSTGRES_PASSWORD, EZTEST_SERVER_BOOTSTRAP_TOKEN, ...
docker compose -f deploy/docker-compose.yml up -d --wait postgres server
docker compose -f deploy/docker-compose.yml run --rm runner
```

## Health

`eztest doctor --json` prints one report with the EZTest version, the config schema version, the plugin API version and every check: Node, Chromium (launched, with where it was found), Firefox (found or not), config per project, databases, plugins and the results server. It exits non-zero on errors. Use it as a container or CI gate.

The results server answers `/healthz` (liveness), `/readyz` (the database answers) and `/api/version`.

## Structured logs

`eztest run --log-format json` prints one JSON object per line. Each line has `ts`, `level`, `msg` and `service`, and the run, journey and step ids where they apply:

```json
{"ts":"2026-10-22T09:12:01.120Z","level":"info","msg":"step end","service":"eztest","runId":"run-20261022-091200-1a2b3c","journeyId":"checkout","stepId":"click-pay","status":"passed","durationMs":184}
```

Sensitive fields (passwords, tokens, cookies, Authorization headers) are replaced, and token-shaped values are masked. The config's secret masker also runs on every line. The results server logs requests in the same format.

## OpenTelemetry traces

`eztest run --otlp http://collector:4318` exports the run as an OpenTelemetry trace over OTLP/HTTP JSON. The exporter is implemented directly, with no SDK dependency. The trace has:

- one root span for the run;
- one span per journey;
- one span per step, with block children nested.

Failures carry status `ERROR` and the masked message. The trace id is derived from the run id, so exporting the same run twice is idempotent. Large runs are sent in batches. To export every run, set it in config:

```yaml
telemetry:
  otlp:
    endpoint: http://collector:4318     # default: OTEL_EXPORTER_OTLP_ENDPOINT
    headers: { x-api-key: "${OTEL_KEY}" }
    serviceName: eztest-payments
```

## Configuration schema versioning

`eztest.config.*` carries `configVersion`. A file without it is version 1. EZTest refuses a config from a newer EZTest with a clear message. `eztest upgrade-config [--dry-run]` migrates a file to the current version and keeps YAML comments and layout. Version 1 is the baseline: there are no migrations yet, and upgrading only adds `configVersion: 1`. See [versioning.md](versioning.md).

## Managed app start

`webServer:` in config starts the app under test before `eztest run` and stops it afterwards. See [scale.md](scale.md#watch-mode-and-managed-app-start).
