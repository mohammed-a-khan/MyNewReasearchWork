# Messaging and integration steps

Event-driven back ends make "click Pay, an event is emitted, the invoice is consumed" a core end-to-end check. EZTest covers this, and the other integration points batch-style systems use, as plain-English steps:

- message buses: Kafka, RabbitMQ (AMQP 0-9-1), MQTT, IBM MQ, and an in-memory broker;
- gRPC calls and mocks;
- SFTP and folder file drops;
- SSH commands and batch jobs;
- EDI files.

Email and SMS steps are in [ez-language.md](ez-language.md#email-and-sms).

## Client libraries

The client libraries are optional peer dependencies, loaded on first use like the database drivers. A step that needs a missing library fails with the command to install it.

| Broker / protocol | Package (license) | Install |
|---|---|---|
| Kafka | `kafkajs` (MIT) | `npm install kafkajs` |
| RabbitMQ / AMQP 0-9-1 | `amqplib` (MIT) | `npm install amqplib` |
| MQTT 3.1.1 / 5 | `mqtt` (MIT) | `npm install mqtt` |
| IBM MQ | nothing: the MQ REST messaging API (mqweb) over HTTPS | |
| gRPC | `@grpc/grpc-js`, `@grpc/proto-loader` (Apache-2.0) | `npm install @grpc/grpc-js @grpc/proto-loader` |
| SFTP / SSH | `ssh2` (MIT) | `npm install ssh2` |

**IBM MQ uses the REST messaging API, not the native client.** The `ibmmq` npm package needs the IBM MQ C client libraries installed on every machine that runs tests. The REST messaging API of the queue manager's web server (mqweb, port 9443 by default) needs nothing but HTTPS.

What the REST API supports:

- Put and destructive get on **queues** (topics are not available through it).
- MQMD correlation ids. A text id is UTF-8, padded to the 24-byte CorrelId.
- A correlation-id filter is pushed down to MQ as a selector.

What it does not support:

- Waits with other filters read messages destructively. Messages that do not match are put back when the step ends, with new message ids and at the end of the queue.
- Message user properties (`ibm-mq-usr-*`) depend on the MQ version. MQ 9.2 does not return them.

## Configuration

```yaml
messaging:
  lookbackMs: 60000      # a wait without a listener also finds messages from the last 60 s (Kafka)
  timeoutMs: 30000       # default for "Wait for a message" without "within"
  brokers:
    bus:    { type: kafka, brokers: [kafka-1:9092, kafka-2:9092], sasl: { mechanism: scram-sha-512, username: svc, password: secret://vault/kafka } }
    rabbit: { type: amqp, url: "amqp://svc:${RABBIT_PASSWORD}@rabbit:5672/shop" }
    iot:    { type: mqtt, url: mqtts://broker:8883, username: svc, password: secret://env/MQTT_PASSWORD }
    qm1:    { type: ibmmq, url: https://mq:9443, queueManager: QM1, username: app, password: secret://env/MQ_PASSWORD, ca: certs/mq-ca.pem }
    local:  { type: memory }
```

**Choosing a broker.** A step names its broker with `on <name>`. Otherwise EZTest uses the broker of the kind the step names (`Kafka topic`, `RabbitMQ queue`, ...), or the only broker configured.

**Secrets.** Passwords may be secret references. The resolved values are masked everywhere.

**IBM MQ certificates.** For a development queue manager with a self-signed certificate, `insecure: true` accepts that certificate. Prefer `ca:`.

**AMQP queues.** A queue that does not exist yet is declared (durable) the first time a step uses it. Set `assertQueues: false` to turn this off.

## Steps

```text
Publish message from file "payloads/order.json" to Kafka topic "orders" on bus with key "${orderId}"
Publish '{"orderId": ${orderId}}' to RabbitMQ exchange "orders" with routing key "order.created" with headers "source" = "eztest"
Publish ${order} to MQTT topic "shop/orders" with QoS 1 retained
Put message '{"order": 1}' on IBM MQ queue "DEV.QUEUE.1" with correlation id "order-${orderId}" as sent

Start listening on Kafka topic "invoices" as invoices
Click the "Pay" button
Wait for a message in invoices where "$.orderId" = ${orderId} and header "type" = "invoice.created" within 30 s matching schema "schemas/invoice.json" as invoice
  Expect response invoice "$.total" equals "99.5"
Capture "$.invoiceId" from invoice as invoiceId
Expect ${invoice_meta.key} equals "${orderId}"
Expect no message in invoices where "$.status" = "FAILED" within 5 s
Stop listening to invoices

Wait for a message on RabbitMQ queue "billing.replies" where correlation id = "${corr}" within 10 s as reply
Wait for 3 messages on Kafka topic "audit" where "$.orderId" = ${orderId} as audit
Purge RabbitMQ queue "billing.dlq"
```

### Payloads

A payload comes from a file, from quoted text, or from `${variable}`. An object or list variable is sent as JSON.

Payload files and text are templates: `${var}` and safe expressions such as `${json(items)}` are filled in.

A JSON payload gets `content-type: application/json` (an AMQP property, an MQTT 5 property, or a Kafka header).

### Filters

`where` takes conditions joined with `and`:

| Filter | Example |
|---|---|
| A JSONPath into the payload | `"$.orderId" = ${orderId}`, `"$.total" > 10`, `"$.status" != "VOID"`, `"$.tags" contains "eu"`, `"$.id" matches "^INV-"`, `"$.id" exists` |
| The message key | `key = "42"` |
| A header | `header "type" = "created"` |
| The correlation id | `correlation id = "c1"` (AMQP property, MQTT 5 correlation data, Kafka `correlation-id` header, IBM MQ CorrelId) |
| The raw payload text | `payload contains "PAID"` |

Comparisons follow the same rules as expectations: numbers compare as numbers.

### What a wait captures

A received message is stored under the step's name as its payload: parsed JSON, or text.

Its metadata goes to `<name>_meta`:

- broker, destination and key;
- headers and correlation id;
- message id and timestamp;
- Kafka partition and offset;
- AMQP routing key or MQTT topic.

`Wait for N messages` captures lists.

A wait `matching schema "file.json"` validates the payload against a JSON Schema. `"spec.yaml#/components/schemas/Invoice"` validates it against a schema in an OpenAPI file. A mismatch fails the step with JSON pointers.

**When nothing matches,** the failure says what was expected and what arrived:

```text
No message on Kafka topic "invoices" on bus matched $.orderId equals 42 within 30 s; 2 other message(s) arrived, e.g. {"orderId":41,...}
```

## Correlating a UI or API action with an event

The safe pattern is to listen before the action and wait after it:

```text
Start listening on Kafka topic "orders" as orderEvents
Click the "Submit order" button
Capture the text of testid=order-number as orderNumber
Wait for a message in orderEvents where "$.orderNumber" = "${orderNumber}" within 20 s as created
```

A listener starts at "now" and buffers everything that arrives. A wait takes the first buffered or future message that matches, so a fast producer cannot win the race. Each message satisfies at most one wait.

How a wait without a listener behaves depends on the broker:

| Broker | Without a listener |
|---|---|
| Kafka | Seeks every partition to "now minus `lookbackMs`" by broker timestamp, so an event emitted just before the step is found. |
| AMQP queue | Consumes from the queue. Messages already waiting are seen. Only the messages a wait matched are acknowledged; the rest go back to the queue. |
| AMQP exchange | Binds a private queue now. Use a listener before the action. |
| MQTT topic | Subscribes now. Use a listener before the action. |
| IBM MQ queue | Messages already waiting are seen. |

**Consumers never interfere with each other.** Each Kafka subscription uses its own consumer group, `eztest-<uuid>`, so test runs never take messages from each other or from the application. AMQP exchange listeners bind exclusive, auto-deleted queues.

## Evidence and masking

Every published and received message is stored as evidence (`messages/<journey>/<step>.json`) with its metadata. The payload is masked, the same as API bodies: configured secrets and values of `vars` whose names look like secrets never appear. Captured payloads in the ledger are masked as well.

**Studio › Project › Messages** shows each run's traffic per step.

## gRPC

```yaml
grpc:
  services:
    orders: { address: orders:50051, proto: protos/orders.proto, includeDirs: [protos], tls: false, metadata: { x-api-key: secret://env/ORDERS_KEY } }
```

```text
Call gRPC "shop.Orders/Get" on orders with '{"id":42}' as order
  Expect response order "$.status" equals "SHIPPED"
Call gRPC "shop.Orders/Watch" on orders with '{"id":42}' as events          (server streaming: a list)
Call gRPC "shop.Orders/Get" on orders with '{"id":1}' expecting status NOT_FOUND as missing
Call gRPC "shop.Orders/Get" on orders with ${request} with metadata "x-tenant" = "eu" with timeout 2 s as order
```

A non-OK status fails the step with the status name: `gRPC shop.Orders/Get returned NOT_FOUND: no such order`. Use `expecting status <NAME>` or `and allow errors` to test error paths.

`<name>_meta` holds:

- status and code;
- details;
- response metadata and trailers.

Only unary and server-streaming calls are supported (client and bidirectional streaming are not). Server reflection is not used: give the proto files.

**gRPC mocks:**

```bash
eztest mock grpc --proto protos/orders.proto --responses grpc-mocks.yaml --port 50051
```

```yaml
shop.Orders/Get:
  - when: { id: 42 }
    response: { id: 42, status: SHIPPED }
  - status: NOT_FOUND
    message: no such order
shop.Orders/Watch:
  - stream: [{ id: 42, status: PACKED }, { id: 42, status: SHIPPED }]
```

From code, use `createGrpcMock({ proto, responses })`.

## SFTP, folders, SSH and batch jobs

```yaml
files:
  sftp:
    partner: { host: sftp.partner.example, username: shop, privateKey: keys/partner, hostKeySha256: "nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8", root: /home/shop }
  ssh:
    batch-host: { host: batch.example, username: ops, password: secret://env/BATCH_PW, allowCommands: ["./close-day.sh *", "./status.sh"] }
  allowFolders: [/mnt/edi-drop]        # local folders outside the project that file steps may use
  pollMs: 1000
batch:
  jobs:
    close-day: { ssh: batch-host, command: "./close-day.sh $${date}", successExitCode: 0 }
    reindex:   { start: "POST /admin/jobs/reindex", statusUrl: "/admin/jobs/$${jobId}", statusPath: "$.state", success: [DONE], failure: [FAILED], asRole: admin }
```

`$${date}` keeps `${date}` for run time: the job's parameters, then the journey's variables. A plain `${...}` in config is a config variable.

```text
Upload "fixtures/batch.csv" to SFTP "partner" at "/in"
Wait for a file matching "ACK_*.csv" in "/out" on SFTP "partner" within 5 minutes as ack
Read the download ack as rows into ackRows
Expect rows ackRows equal query "ACKED_ITEMS" on ledger by key "id"
Download "/out/report.pdf" from SFTP "partner" as report
List files in "/out" on SFTP "partner" matching "*.csv" as files
Delete "/in/batch.csv" on SFTP "partner"

Copy "fixtures/orders.edi" to folder "/mnt/edi-drop/in"
Wait for a file matching "*.997" in folder "/mnt/edi-drop/out" within 2 minutes as ack997

Run command "./status.sh" on SSH "batch-host" as status
Run command "./close-day.sh 2026-01-31" on SSH "batch-host" expecting exit code 0 within 10 minutes as closing
Run batch job "close-day" with date=${businessDate} and wait up to 30 minutes as job
  Expect response job "$.stdout" contains "closed"
```

**Downloaded files.** Files that waits and downloads fetch are saved in the run directory as evidence. They are shaped like browser downloads, so row reading, document checks and EDI parsing work on them.

**Which file a wait picks.** A file wait picks the newest matching file modified within the last 10 minutes.

**What a command captures.** SSH commands and batch jobs capture `{ exitCode, stdout, stderr, durationMs }`, masked.

**Safety by default:**

- SSH runs **only** commands that match the host's `allowCommands`, either exactly or as a glob where `*` matches anything. Any other command fails without connecting.
- Local folders must be inside the project or listed in `allowFolders`.
- Host keys can be pinned with `hostKeySha256`.

**HTTP batch jobs** start with one request and poll `statusUrl` until a success or failure status. The job id is read from the start response with `idPath` and is available as `${jobId}`.

## EDI

```text
Read the file ack as EDI into edi
Load the EDI file "fixtures/850.edi" into po
  Expect response po "$.valid" equals "true"
  Expect response po "$.first.BEG.BEG03" equals "PO-1001"
  Expect response po "$.transactions[0].type" equals "850"
  Expect response po "$.count.PO1" equals "3"
```

ANSI X12 and UN/EDIFACT interchanges are parsed into JSON.

**Delimiters.** EZTest reads the delimiters from the ISA segment, or from the EDIFACT `UNA` service string advice and release character.

**Segments.** Each segment is an object keyed by element position, for example `{ id: "BEG", BEG01: "00", BEG03: "PO-1001" }`. `first.<SEG>` is the first segment with that id, and `count.<SEG>` is how many there are.

**Envelope checks** set `valid` and `errors`:

| Format | Checks |
|---|---|
| X12 | SE01 segment counts; control numbers ST02/SE02, GS06/GE02 and ISA13/IEA02; transaction and group counts |
| EDIFACT | UNT01 segment counts; control numbers UNH01/UNT02 and UNB05/UNZ02; message and group counts |

**Not included.** Composite elements stay as text (for example `SKU-200:VP`). Implementation-guide validation (code lists, mandatory segments per transaction set) is not included.

## Message contracts

Inside a contract session (`Start a contract between consumer "billing-ui" and provider "billing-events"`), every message a wait receives becomes a message expectation in EZTest's contract file, with matchers inferred from the payload. The provider side is verified against what the provider publishes; see [api-contracts.md](api-contracts.md#message-contracts).

## Testing EZTest's own messaging steps

The repository's e2e suites (`test/integration/*-e2e.test.ts`) run against real brokers:

| Broker | Image | Port |
|---|---|---|
| Kafka | `apache/kafka` | 19092 |
| RabbitMQ | `rabbitmq` | 15673 |
| Mosquitto (MQTT) | `eclipse-mosquitto` | 11883 |
| IBM MQ | `ibmcom/mq` (REST on 19443) | 19443 |
| SFTP | `atmoz/sftp` | 12222 |
| OpenSSH | `linuxserver/openssh-server` | 12223 |

The tests start these containers when Docker is running and the images are already pulled; tests never pull images. Each broker can instead come from an environment variable: `EZTEST_KAFKA_BROKERS`, `EZTEST_AMQP_URL`, `EZTEST_MQTT_URL`, `EZTEST_IBMMQ_URL`, `EZTEST_SFTP_URL`, `EZTEST_SSH_URL`. `EZTEST_DOCKER=0` turns Docker off. A suite whose broker is unavailable is skipped with a note.


## Phone calls (voice verification)

Some MFA and notification flows use a phone call. EZTest places or waits for a call, checks the spoken prompts and DTMF digits, and extracts a spoken one-time code — through a provider interface, with a local mock for tests.

```yaml
voice:
  provider: twilio
  accountSid: secret://env/TWILIO_SID
  authToken: secret://env/TWILIO_TOKEN
  from: "+15559990001"
  allowedNumbers: ["+1555012*"]   # outbound calls dial real phones: only these may be called
  transcripts: fixtures/transcripts.json   # optional: deterministic local transcripts (recording id / audio sha256 -> text)
```

```text
Place a call to "+15550100" saying "Your code is 4 8 2 9 1 5" and press "1w2" as ivr
Expect the call ivr to say "Press 1 for billing" then "Press 2 for support"
Expect the call ivr to have sent the digits "1w2"

Wait for a call to "+15550123" within 2 minutes and capture the 6-digit spoken code as otp
Type "${otp}" into the "Code" field
```

- **Provider:** Twilio Programmable Voice over its REST API (Calls with TwiML `<Say>`/`<Record transcribe>`, `SendDigits`, Recordings, Transcriptions). Credentials are `secret://` references, resolved and masked.
- **Transcription** comes only from the provider's own service or a local fixtures file (recording id, or the recording audio's SHA-256, mapped to text). No third-party speech or AI service is ever called. The transcript is normalised so spoken digits join up (`"four eight two"` -> `482`), which is what the `capture the spoken code` / `Extract the code` phrasings read.
- **Safety:** outbound calls are refused unless the number matches `allowedNumbers` (exact, or a prefix ending in `*`).
- **Testing:** `MemoryVoiceProvider` is an in-process call log; `TwilioMockServer` is a local stand-in for the subset of the Twilio REST API the provider uses, so the real provider code is exercised offline. Both are exported from `eztest/messaging`.
