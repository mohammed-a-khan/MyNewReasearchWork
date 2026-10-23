/**
 * Integration steps that need no external servers (always run): the
 * in-memory broker through the engine (every messaging phrasing, message
 * contracts recorded and verified), gRPC calls against EZTest's own gRPC mock (unary,
 * server-streaming, error statuses), local folder file drops with EDI
 * parsing, and an HTTP batch job.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { loadConfig } from '../../src/config/index.js';
import { flattenStepResults, type JourneyResult } from '../../src/core/index.js';
import { createEngine } from '../../src/engine/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { createGrpcMock, createIntegrationRuntime, memoryBroker, type GrpcMock } from '../../src/integration/index.js';
import { contractHash, messageProducersFromConfig, readContractFile, verifyContract, type MessageExpectation } from '../../src/contracts/index.js';

function steps(j: JourneyResult): string {
  return flattenStepResults(j.steps).map(({ result: s }) => `${s.stepId}: ${s.status}${s.error ? ` (${s.error.message})` : ''}`).join('\n');
}

async function project(cfg: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'eztest-local-'));
  await writeFile(join(dir, 'eztest.config.yaml'), toYaml({ outputDir: 'results', healing: { enabled: false }, ...cfg }));
  return dir;
}

async function runJourney(dir: string, ez: string): Promise<JourneyResult> {
  const engine = await createEngine(await loadConfig({ cwd: dir, environment: {} }), { cwd: dir, runOptions: { stepTimeoutMs: 15_000 } });
  try {
    return (await engine.run([parseEzScript(ez)])).journeys[0];
  } finally {
    await engine.close();
  }
}

const PROTO = `syntax = "proto3";
package shop;
service Orders {
  rpc Get (GetOrder) returns (Order);
  rpc Watch (GetOrder) returns (stream OrderEvent);
}
message GetOrder { int32 id = 1; }
message Order { int32 id = 1; string status = 2; double total = 3; repeated string skus = 4; }
message OrderEvent { int32 id = 1; string status = 2; }
`;

describe('in-memory broker through the engine', () => {
  it('runs publish / listen / wait / none / purge / stop with filters and capture', async () => {
    const dir = await project({ messaging: { brokers: { local: { type: 'memory' } } } });
    await mkdir(join(dir, 'payloads'), { recursive: true });
    await writeFile(join(dir, 'payloads', 'invoice.json'), '{"invoiceId": "INV-${n}", "orderId": ${n}, "amount": 12.5}');
    const j = await runJourney(dir, `Journey: Memory bus
Set variable n to 7
Start listening on memory topic "invoices" as inv
Publish message from file "payloads/invoice.json" to memory topic "invoices" with key "\${n}" with headers "type" = "invoice.created" as sent
Wait for a message in inv where "$.orderId" = 7 and key = "7" and header "type" = "invoice.created" within 2 s as invoice
  Expect response invoice "$.invoiceId" equals "INV-7"
Capture "$.amount" from invoice as amount
Expect \${amount} equals "12.5"
Publish message '{"orderId": 8}' to memory topic "invoices"
Publish message '{"orderId": 9}' to memory topic "invoices"
Wait for 2 messages in inv where "$.orderId" > 7 within 2 s as more
Expect len(more) == 2
Expect no message in inv where "$.orderId" = 100 within 300 ms
Publish message 'plain text' to memory queue "jobs"
Wait for a message on memory queue "jobs" where payload contains "plain" within 1 s as job
Expect \${job} equals "plain text"
Publish message 'x' to memory queue "dlq"
Purge memory queue "dlq"
Expect no message on memory queue "dlq" within 200 ms
Stop listening to inv
`);
    expect(j.status, steps(j)).toBe('passed');
  });

  it('records message contracts inside a contract session and verifies them against the provider\'s producer', async () => {
    const dir = await project({ messaging: { brokers: { local: { type: 'memory' } } } });
    const j = await runJourney(dir, `Journey: Billing UI consumer
Start a contract between consumer "billing-ui" and provider "billing-events"
Start listening on memory topic "invoices" as inv
Publish message '{"invoiceId": "INV-7", "orderId": 7, "amount": 12.5}' to memory topic "invoices"
Wait for a message in inv where "$.orderId" = 7 within 2 s as invoice
Publish message '{"orderId": 8}' to memory topic "invoices"
Publish message '{"orderId": 9}' to memory topic "invoices"
Wait for 2 messages in inv where "$.orderId" > 7 within 2 s as more
Stop listening to inv
Finish the contract
`);
    expect(j.status, steps(j)).toBe('passed');
    const c = await readContractFile(join(dir, 'contracts', 'billing-ui-billing-events.contract.json'));
    expect(c.expectations.map((e) => e.kind)).toEqual(['message', 'message', 'message']);
    const first = c.expectations[0] as MessageExpectation;
    expect(first.channel).toEqual({ transport: 'memory', destType: 'topic', dest: 'invoices', broker: 'local' });
    expect(first.message).toMatchObject({ contents: { invoiceId: 'INV-7', orderId: 7, amount: 12.5 }, contentType: 'application/json', match: { '$.invoiceId': { matchers: [{ kind: 'type' }] } } });
    // A wait for 2 messages records one expectation per message.
    expect(c.expectations.filter((e) => /2 messages/.test(e.description))).toHaveLength(2);

    // Provider side: the producer (from config) publishes on the expectation's channel; EZTest reads it there.
    const integration = createIntegrationRuntime({ baseDir: dir, messaging: { brokers: { local: { type: 'memory' } } } });
    try {
      const producers = messageProducersFromConfig({ '*': { timeoutMs: 2000 } }, integration, {});
      const publishSoon = (payload: string) => setTimeout(() => void memoryBroker('local').publish({ type: 'topic', name: 'invoices' }, { payload }), 100);
      publishSoon('{"invoiceId": "INV-99", "orderId": 99, "amount": 3}');
      const ok = await verifyContract({ ...c, expectations: [first] }, { baseUrl: 'http://unused', messageProducers: producers }, { hash: contractHash(c) });
      expect(ok.passed, JSON.stringify(ok.expectations)).toBe(true);
      expect(ok.expectations[0].kind).toBe('message');
      publishSoon('{"invoice_id": "x", "orderId": 1, "amount": 1}');
      const bad = await verifyContract({ ...c, expectations: [first] }, { baseUrl: 'http://unused', messageProducers: producers }, { hash: contractHash(c) });
      expect(bad.passed).toBe(false);
      expect(bad.expectations[0].mismatches.map((m) => m.message)).toContain('message $.invoiceId: is missing');
      const none = await verifyContract({ ...c, expectations: [first] }, { baseUrl: 'http://unused' }, { hash: contractHash(c) });
      expect(none.expectations[0].error).toMatch(/no message producer for "Wait for a message in inv/);
    } finally {
      await integration.close();
    }
  });

  it('names the broker when several are configured and none is said', async () => {
    const dir = await project({ messaging: { brokers: { a: { type: 'memory' }, b: { type: 'memory' } } } });
    const j = await runJourney(dir, 'Journey: Ambiguous\nPublish message \'{}\' to topic "t"\n');
    expect(steps(j)).toMatch(/Several brokers are configured \(a, b\); say which one/);
    memoryBroker('a');
  });
});

const grpcInstalled = await import('@grpc/grpc-js').then(() => true, () => false);
if (!grpcInstalled) console.warn('[eztest] @grpc/grpc-js is not installed; gRPC e2e skipped');

describe.skipIf(!grpcInstalled)('gRPC calls against the gRPC mock', () => {
  let mock: GrpcMock;
  let dir: string;
  beforeAll(async () => {
    dir = await project({});
    await writeFile(join(dir, 'orders.proto'), PROTO);
    mock = await createGrpcMock({
      proto: 'orders.proto', baseDir: dir,
      responses: {
        'shop.Orders/Get': [{ when: { id: 42 }, response: { id: 42, status: 'SHIPPED', total: 99.5, skus: ['SKU-200'] } }, { status: 'NOT_FOUND', message: 'no such order' }],
        'shop.Orders/Watch': [{ stream: [{ id: 42, status: 'PACKED' }, { id: 42, status: 'SHIPPED' }] }],
      },
    });
    await writeFile(join(dir, 'eztest.config.yaml'), toYaml({ outputDir: 'results', healing: { enabled: false }, grpc: { services: { orders: { address: mock.address, proto: 'orders.proto' } } } }));
  });
  afterAll(async () => {
    await mock?.close();
  });

  it('unary and server-streaming calls, metadata, expected error statuses', async () => {
    const j = await runJourney(dir, `Journey: gRPC orders
Call gRPC "shop.Orders/Get" on orders with '{"id":42}' with metadata "x-tenant" = "eu" as order
  Expect response order "$.status" equals "SHIPPED"
  Expect response order "$.skus[0]" equals "SKU-200"
Expect \${order_meta.status} equals "OK"
Call gRPC "shop.Orders/Watch" on orders with '{"id":42}' as events
Expect len(events) == 2
  Expect response events "$[1].status" equals "SHIPPED"
Call gRPC "shop.Orders/Get" on orders with '{"id":1}' expecting status NOT_FOUND as missing
Expect \${missing_meta.details} equals "no such order"
`);
    expect(j.status, steps(j)).toBe('passed');
    expect(mock.calls.map((c) => c.method)).toEqual(['shop.Orders/Get', 'shop.Orders/Watch', 'shop.Orders/Get']);
  });

  it('fails with the gRPC status name', async () => {
    const j = await runJourney(dir, `Journey: gRPC failure
Call gRPC "shop.Orders/Get" on orders with '{"id":1}' as order
`);
    expect(j.status).toBe('failed');
    expect(steps(j)).toMatch(/gRPC shop\.Orders\/Get returned NOT_FOUND: no such order/);
    const k = await runJourney(dir, `Journey: gRPC wrong expectation
Call gRPC "shop.Orders/Get" on orders with '{"id":42}' expecting status NOT_FOUND as order
`);
    expect(steps(k)).toMatch(/returned OK, expected NOT_FOUND/);
  });
});

const X12_850 = [
  'ISA*00*          *00*          *ZZ*BUYER          *ZZ*SELLER         *260115*0930*U*00401*000000101*0*T*>~',
  'GS*PO*BUYER*SELLER*20260115*0930*101*X*004010~',
  'ST*850*0001~',
  'BEG*00*SA*PO-1001**20260115~',
  'PO1*1*2*EA*49.50**VP*SKU-200~',
  'CTT*1~',
  'SE*5*0001~',
  'GE*1*101~',
  'IEA*1*000000101~',
].join('\n');

describe('local folder drops, EDI and HTTP batch jobs', () => {
  let jobs: Server;
  let base: string;
  let polls = 0;
  beforeAll(async () => {
    jobs = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/jobs/close-day') return res.end(JSON.stringify({ id: 'J-1' }));
      if (req.url === '/jobs/J-1') return res.end(JSON.stringify({ status: ++polls < 3 ? 'RUNNING' : 'SUCCEEDED', processed: 12 }));
      if (req.method === 'POST' && req.url === '/jobs/broken') return res.end(JSON.stringify({ id: 'J-2' }));
      if (req.url === '/jobs/J-2') return res.end(JSON.stringify({ status: 'FAILED' }));
      res.statusCode = 404;
      return res.end('{}');
    });
    await new Promise<void>((r) => jobs.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(jobs.address() as AddressInfo).port}`;
  });
  afterAll(() => jobs?.close());

  it('copies into a drop folder, waits for the file, parses it as EDI and runs HTTP batch jobs', async () => {
    const dir = await project({
      baseUrl: base,
      files: { pollMs: 100 },
      batch: { jobs: { 'close-day': { start: 'POST /jobs/close-day', statusUrl: '/jobs/$${jobId}', pollMs: 50 }, broken: { start: 'POST /jobs/broken', statusUrl: '/jobs/$${jobId}', pollMs: 50 } } },
    });
    await mkdir(join(dir, 'fixtures'), { recursive: true });
    await writeFile(join(dir, 'fixtures', 'po-1001.edi'), X12_850);
    const j = await runJourney(dir, `Journey: EDI drop
Copy "fixtures/po-1001.edi" to folder "drop/in"
Wait for a file matching "po-*.edi" in folder "drop/in" within 5 s as po
Read the file po as EDI into edi
  Expect response edi "$.valid" equals "true"
  Expect response edi "$.first.BEG.BEG03" equals "PO-1001"
  Expect response edi "$.transactions[0].type" equals "850"
  Expect response edi "$.count.PO1" equals "1"
List files in folder "drop/in" as dropped
Expect len(dropped) == 1
Run batch job "close-day" and wait up to 10 s as job
Expect \${job.status} equals "SUCCEEDED"
  Expect response job "$.result.processed" equals "12"
`);
    expect(j.status, steps(j)).toBe('passed');
    const k = await runJourney(dir, 'Journey: Failing job\nRun batch job "broken" and wait up to 5 s as job\n');
    expect(steps(k)).toMatch(/Batch job "broken" ended with status FAILED/);
    const outside = await runJourney(dir, 'Journey: Outside\nCopy "fixtures/po-1001.edi" to folder "/etc/eztest-drop"\n');
    expect(steps(outside)).toMatch(/Folder \/etc\/eztest-drop is outside the project; add it to files\.allowFolders/);
    expect(await readFile(join(dir, 'drop', 'in', 'po-1001.edi'), 'utf8')).toContain('BEG*00*SA*PO-1001');
  });
});
