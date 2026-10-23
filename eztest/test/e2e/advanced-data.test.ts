/** E2E (real Chromium + demo app): REST/GraphQL/SOAP/WebSocket steps, databases with bound parameters, email and SMS. */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { MemorySmsProvider, SmtpSink } from '../../src/messaging/index.js';
import type { DbHandler } from '../../src/runner/index.js';
import { describeSteps, expectPasses, runEz } from './advanced-helpers.js';

let server: DemoServer;
let sink: SmtpSink;
let dir: string;
beforeAll(async () => {
  sink = await new SmtpSink().start();
  server = await startDemoApp({ smtpPort: sink.port });
  dir = await mkdtemp(join(tmpdir(), 'eztest-data-'));
  await writeFile(join(dir, 'order.schema.json'), JSON.stringify({
    type: 'object', required: ['id', 'qty'], properties: { id: { type: 'integer' }, qty: { type: 'integer' }, product: { type: 'string' } },
  }));
  await writeFile(join(dir, 'note.txt'), 'hello file');
  server.db.exec(`CREATE TABLE IF NOT EXISTS lab_products (name TEXT, price REAL);
    DELETE FROM lab_products;
    INSERT INTO lab_products VALUES ('Widget', 19.99), ('Gadget', 49.5), ('Doohickey', 5.25), ('Thingamajig', 12);`);
});
afterAll(async () => {
  await server.close();
  await sink.stop();
});

/** The demo sqlite database (connection "demo"); records every SQL text and its parameters. */
function demoDb(log: Array<{ sql: string; params: unknown[] }> = []): DbHandler {
  return {
    async query(connection, sql, params) {
      if (connection !== 'demo') throw new Error(`unknown connection ${connection}`);
      log.push({ sql, params: params ?? [] });
      return server.db.prepare(sql).all(...((params ?? []) as never[])) as Array<Record<string, unknown>>;
    },
  };
}

describe('API steps', () => {
  it('REST with query, headers, form, multipart, files; JSONPath captures; JSON Schema; response time; retry until', async () => {
    const { j } = await expectPasses(server.url, `Journey: REST
Call API "GET /lab/api/echo" with query page=2, q="a b" with header "x-trace" = "t1" and store as get
  Expect response get "$.query.page" equals "2"
  Expect response get "$.query.q" equals "a b"
  Expect response get "$.headers.x-trace" equals "t1"
  Expect response get responded within 2000 ms
Call API "POST /lab/api/echo" with form title=Hello, body="World wide" and store as form
  Expect response form "$.body.body" equals "World wide"
Call API "POST /lab/api/echo" with multipart file=@note.txt, name=doc and store as upload
  Expect response upload "$.body.file" equals "file:note.txt:10"
Call API "PUT /lab/api/echo" with body from file "order.schema.json" and store as put
  Expect response put "$.method" equals "PUT"
Call API "POST /lab/api/orders" with body '{"qty":2,"product":"Gadget"}' and store as created
  Expect the created response status is 201
  Expect response created matches schema "order.schema.json"
  Expect response created "$.qty" is greater than "1"
  Expect response created has "$.id"
  Expect response created does not have "$.missing"
Capture "$.id" from created as orderId
Capture the header "x-request-id" of created as requestId
Capture the status of created as code
Call API "DELETE /lab/api/echo" and store as del
Call API "GET /lab/api/jobs/42" and store as job [retry=10 every=50ms]
  Expect response job "$.status" equals "done"
Call API "GET /lab/api/error" with errors allowed and store as broken
  Expect the broken response status is 500
Call API "GET /lab/api/error" with errors allowed and store as broken2
`, { baseDir: dir });
    expect(j.ledger.orderId).toBe(101);
    expect(j.ledger.requestId).toBe('req-1');
    expect(j.ledger.code).toBe(201);
    expect((j.ledger.job as { body: { polls: number } }).body.polls).toBe(3);
  });

  it('GraphQL queries and mutations with variables (errors surface), SOAP with faults, WebSocket send/expect', async () => {
    const { j } = await expectPasses(server.url, `Journey: GraphQL SOAP WS
Send GraphQL query "{ orders { id status } }" to /graphql and store as gq
  Expect response gq "$.data.orders[0].status" equals "Shipped"
Run GraphQL mutation "mutation($title: String) { createNote(title: $title) { id title } }" on /graphql with variables '{"title":"Hi"}' and store as note
  Expect response note "$.data.createNote.title" equals "Hi"
Call SOAP action "GetOrder" on /soap with body "<GetOrder><Id>2</Id></GetOrder>" and store as soap
  Expect response soap "$.GetOrderResponse.Status" equals "Open"
Connect to websocket "/lab/ws" as feed
Wait for a websocket message containing "welcome" on feed
Send "ping" on websocket feed
Wait for a websocket message containing "pong" on feed and store it as reply
Send "hello" on websocket feed
  Expect websocket feed received "echo: hello"
Close websocket feed
`);
    expect(j.ledger.reply).toBe('pong');
    const bad = await runEz(server.url, `Journey: GraphQL errors
Send GraphQL query "{ boom }" to /graphql and store as gq`);
    expect(bad.j.steps[0].error?.message).toMatch(/GraphQL errors: Boom field failed/);
    const fault = await runEz(server.url, `Journey: SOAP fault
Call SOAP action "Fail" on /soap with body "<Fail/>" and store as s`);
    expect(fault.j.steps[0].error?.message).toMatch(/SOAP fault soap:Server: Order service unavailable|returned 500/);
  });
});

describe('database steps', () => {
  it('binds ${vars} as parameters (never string-built), captures cells/rows/counts and asserts', async () => {
    const log: Array<{ sql: string; params: unknown[] }> = [];
    const { j } = await expectPasses(server.url, `Journey: DB
Variables: region=EU
Run query "SELECT name FROM customers WHERE region = '\${region}' ORDER BY id" on demo as eu
  Expect query eu returns 2 rows
  Expect the query eu returns at least 2 rows
Get the value of query "SELECT COUNT(*) AS n FROM customers WHERE region = \${region}" on demo as euCount
  Expect \${euCount} equals "2"
Get the first row of query "SELECT * FROM customers WHERE name LIKE '%\${needle}%'" on demo as row
Get the row count of query "SELECT * FROM customers" on demo as total
Set variable evil to "EU' OR '1'='1"
Run query "SELECT name FROM customers WHERE region = '\${evil}'" on demo as injected
  Expect query injected returns 0 rows
`, { db: demoDb(log), variables: { needle: 'Fabri' } });
    expect(j.ledger.euCount).toBe(2);
    expect((j.ledger.row as { name: string }).name).toBe('Fabrikam Inc');
    expect(j.ledger.total).toBe(3);
    // Every ${var} became a bound parameter: the SQL text never contains the values.
    expect(log.map((l) => l.sql)).toEqual([
      'SELECT name FROM customers WHERE region = ? ORDER BY id',
      'SELECT COUNT(*) AS n FROM customers WHERE region = ?',
      'SELECT * FROM customers WHERE name LIKE ?',
      'SELECT * FROM customers',
      'SELECT name FROM customers WHERE region = ?',
    ]);
    expect(log[2].params).toEqual(['%Fabri%']);
    expect(log[4].params).toEqual(["EU' OR '1'='1"]);
  });

  it('waits until a query returns rows (polling) and compares a query with a UI table', async () => {
    let inserted = false;
    const { j } = await expectPasses(server.url, `Journey: DB wait and compare
Run step "insertLater"
Wait until query "SELECT * FROM orders WHERE created_by = 'poller'" on demo returns 1 row within 5 seconds checking every 100 ms as polled
Open /lab/table
Capture the rows of the "Products" table as ui
Run query "SELECT name AS Name, printf('%.2f', price) AS Price FROM lab_products" on demo as db
Compare \${db} with \${ui} by Name and store the result as diff
`, {
      db: demoDb(),
      customSteps: {
        insertLater: async () => {
          setTimeout(() => {
            server.db.prepare("INSERT INTO orders (customer_id, created_by, status, total, created_at) VALUES (1, 'poller', 'Submitted', 1, 'now')").run();
            inserted = true;
          }, 400);
        },
      },
    });
    expect(inserted).toBe(true);
    expect((j.ledger.polled as unknown[]).length).toBe(1);
    expect(j.ledger.diff).toMatchObject({ passed: true, compared: 4 });
    const bad = await runEz(server.url, `Journey: Compare mismatch
Open /lab/table
Capture the rows of the "Products" table as ui
Run query "SELECT name AS Name, '0.00' AS Price FROM lab_products" on demo as db
Compare \${db} with \${ui} by Name`, { db: demoDb() });
    expect(bad.j.steps[3].error?.message, describeSteps(bad.j)).toMatch(/Data comparison failed/);
  });

  it('calls stored procedures with the dialect placeholder style', async () => {
    const seen: string[] = [];
    const pg: DbHandler = { query: async (_c, sql, params) => (seen.push(`${sql} ${JSON.stringify(params)}`), [{ ok: 1 }]), dialect: () => 'postgres' };
    await expectPasses(server.url, `Journey: Procedures
Variables: id=42
Call procedure "close_order" on shop with params '[7, "x"]' as closed
Run query "SELECT * FROM orders WHERE id = \${id} AND status = $1" on shop with params '["Open"]' as rows
`, { db: pg });
    expect(seen).toEqual(['CALL close_order($1, $2) [7,"x"]', 'SELECT * FROM orders WHERE id = $2 AND status = $1 ["Open","42"]']);
  });
});

describe('email and SMS', () => {
  it('signs up, reads the email from the built-in SMTP sink, extracts the link and code, and continues', async () => {
    const { j } = await expectPasses(server.url, `Journey: Email verification
Open /lab/mail
Type "ada@test.local" into the Email field
Click the "Sign up" button
  Expect the page contains "Check your inbox"
Get the latest email to "ada@test.local" with subject "Welcome" as mail
Extract the link from mail matching "verify" as link
Extract the 6-digit code from mail as code
Open \${link}
  Expect the page contains "Email verified"
`, { mail: sink });
    expect(String(j.ledger.link)).toMatch(/\/lab\/verify\?token=tok\d{6}$/);
    expect(String(j.ledger.code)).toMatch(/^\d{6}$/);
    expect((j.ledger.mail as { subject: string }).subject).toBe('Welcome to EZ Shop');
  });

  it('reads the latest SMS from a provider and extracts the OTP', async () => {
    const sms = new MemorySmsProvider();
    const { j } = await expectPasses(server.url, `Journey: SMS OTP
Run step "sendSms"
Get the latest SMS to "+15550100" containing "code" as sms
Extract the code from sms as otp
Set variable digits to len(otp)
`, { sms, customSteps: { sendSms: async () => void setTimeout(() => sms.push({ from: '+15550000', to: '+15550100', body: 'Your EZ code is 482913' }), 200) } });
    expect(j.ledger.otp).toBe('482913');
    expect(j.ledger.digits).toBe(6);
  });

  it('explains how to configure a missing mail provider', async () => {
    const { j } = await runEz(server.url, `Journey: No mail
Get the latest email as mail`);
    expect(j.steps[0].error?.message).toMatch(/No mail provider configured/);
  });
});
