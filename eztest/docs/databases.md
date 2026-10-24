# Databases

EZTest talks to SQLite, PostgreSQL, SQL Server and Oracle through one client
interface. Journeys query them inline or through a **named-query catalogue**.
The query results compare with UI tables, API bodies and other databases by
key, with typed and case-insensitive matching.

- [Connections](#connections)
- [Results: rows, types and column names](#results-rows-types-and-column-names)
- [Steps](#steps)
- [The named-query catalogue](#the-named-query-catalogue)
- [Oracle specifics](#oracle-specifics)
- [CLI: queries, validate, doctor](#cli-queries-validate-doctor)
- [Studio workbench](#studio-workbench)
- [Examples from a query](#examples-from-a-query)
- [Security notes](#security-notes)
- [Running the database tests](#running-the-database-tests)

## Connections

```yaml
db:
  connections:
    shop:   { type: sqlite, file: /abs/path/shop.db }
    erp:    { type: postgres, connectionString: "${ERP_DB_URL}" }
    crm:    { type: mssql, server: sql.test, database: crm, user: qa, password: secret://vault/CRM_PW }
    ledger:
      type: oracle
      host: ora.test
      port: 1521                     # default 1521
      serviceName: LEDGERPDB         # or sid: LEDGER
      # connectString: "ora.test:1521/LEDGERPDB"   # Easy Connect, a descriptor, or a TNS alias (with configDir)
      user: qa_reader
      password: secret://vault/LEDGER_PW
      pool: { min: 0, max: 4 }       # connections are pooled per alias
      # walletLocation: /secure/wallet      # mTLS / Autonomous Database (Thin mode reads ewallet.pem)
      # walletPassword: secret://vault/WALLET_PW
      # fetchAsString: [DATE, NUMBER]       # return these types as text
      # callTimeoutMs: 60000
```

`type:` and `driver:` are interchangeable. `postgresql` and `sqlserver` are
accepted as aliases. Connections open lazily on first use and close at the end
of the run.

| Dialect | Package | Install | Placeholders |
|---|---|---|---|
| SQLite | built in (`node:sqlite`, Node 22.5+) | nothing | `?`, `:name` |
| PostgreSQL | `pg` | `npm install pg` | `$1..$n` |
| SQL Server | `mssql` | `npm install mssql` | `@p1..@pn`, `@name` |
| Oracle | `oracledb` (Thin mode, pure JavaScript) | `npm install oracledb` | `:1..:n`, `:name` |

The drivers are optional peer dependencies. EZTest loads a driver only when a
connection uses it. When a driver is missing, the error names the command to
run. Oracle runs in **Thin mode only**: EZTest never calls
`initOracleClient()`, so no Instant Client or native code is needed. The
oracledb licence is Apache-2.0 OR UPL-1.0.

Passwords can be `secret://store/key` references, which are resolved through
`identity.secretStores` when the connection opens. They can also be `ENC(...)`
values, which are decrypted when the config loads. Either way, resolved values
are masked in logs, reports and evidence.

## Results: rows, types and column names

Rows keep the column names the database returns, so Oracle's `CUSTOMER_NAME`
stays upper case in reports and JSON. Lookups ignore case, though:
`${row.customer_name}`, `${row.CUSTOMER_NAME}`, `len(row.Customer_Name)` and
`'customer_name' in row` all work. The dataset comparison
(`Compare ${api.body} with ${ledger} by id`) also matches columns
case-insensitively. That lets an Oracle row set (`ACCOUNT_ID`) compare with an
API body (`account_id`) or a SQL Server table (`Account_Id`).

| Oracle type | Value |
|---|---|
| `NUMBER`, `BINARY_INTEGER` | `number`; a `string` with the exact digits when a double would lose precision (e.g. `NUMBER(30)`) |
| `DATE`, `TIMESTAMP` | `Date`. Oracle stores no time zone, so the value is read in the test machine's local time, as `pg` does for `timestamp` |
| `TIMESTAMP WITH TIME ZONE` | `Date` (the exact instant) |
| `CLOB`, `NCLOB` | `string` (fetched whole) |
| `BLOB`, `RAW` | `Buffer` |
| `NULL` (and `''`, which Oracle stores as NULL) | `null` |

`fetchAsString: [DATE, TIMESTAMP]` returns local ISO-like text instead
(`2026-03-01T14:05:00`). `[NUMBER]` returns the database's digits as text, for
example `.5`. Booleans bind as `1`/`0`.

The other dialects work the same way. Dates from `pg` and `mssql` are `Date`
objects, and `bigint` becomes a number when it is safe and a string otherwise.
The typed comparison treats `25000`, `"25000.00"` and `25000.0` as equal. It
treats a `Date` and the same instant written as ISO text as equal. It never
reads a date as a number.

## Steps

Inline SQL (any dialect):

```
Run query "SELECT * FROM orders WHERE status = '${status}'" on shop as rows
Get the value of query "SELECT total FROM orders WHERE id = ${id}" on shop as total
Wait until query "SELECT 1 FROM jobs WHERE id = ${job} AND done = 1" on shop returns 1 row within 30 seconds
Call procedure "close_order" on shop with params '[42]' as result
Call procedure "billing.close_invoice" on ledger with params '[42]' and out status, total:number as closed
```

Every `${var}` becomes a bound parameter. So does a quoted literal containing
one, such as `'%${name}%'`. Oracle gets `:1, :2, ...` in order of appearance,
and any `:x`/`?` markers you wrote keep their positions. Plain SQL may end with
`;`. A PL/SQL block keeps its `END;`. A procedure call on Oracle is sent as
`BEGIN name(:1, ...); END;`. With `out`, the OUT parameters are captured as one
record: `${closed.total}`. A `cursor` OUT parameter (`SYS_REFCURSOR`) comes
back as rows.

Catalogue queries are described below. The full list of phrasings is in
[ez-language.md](ez-language.md#databases).

## The named-query catalogue

Teams with hundreds of queries keep them as files instead of strings in code.
Put one query in each `NAME.sql` file under `db.queries.dir` (default
`queries/`, subfolders allowed). You can also list specific `files`, or define
short ones `inline`:

```yaml
db:
  queries:
    dir: queries
    # files: [queries/ledger, shared/common.sql]   # instead of scanning dir
    inline:
      LEDGER_PING: SELECT 1 AS ok FROM dual
```

A file may start with a header of `--` comments:

```sql
-- connection: ledger
-- description: Active customers of a region at or above a credit limit
-- params: region, min_limit:number = 0
SELECT c.customer_id, c.customer_name, c.credit_limit
  FROM ledger_customers c
 WHERE c.region = :region
   AND c.credit_limit >= :min_limit
   {{> active_only}}
 ORDER BY c.customer_id
```

- **connection**: the default alias. A step's `on <alias>` overrides it.
- **params**: `name`, `name:type` (`number`, `string`, `date`, `boolean`) and
  `name = default`. The header is optional. Without it, the params are the
  `:name` binds the SQL uses, and all of them are required. With it, every bind
  must be declared, and every declared param must be used.
- **Binds**: use `:name` (portable) or `?` (positional, passed with
  `with params '[...]'`), not both. EZTest rewrites them into each dialect's
  placeholders (`:1`, `$1`, `@p1`, `?`). A name used twice is bound twice.
- **Fragments**: `{{> active_only}}` includes another catalogue entry's SQL as
  text. Files under `fragments/`, or with `-- fragment: true`, are fragments.
  They can be included but not run on their own. Includes may nest, and a cycle
  is an error.

```sql
-- queries/fragments/active_only.sql
-- fragment: true
AND c.status = 'ACTIVE'
```

**No SQL splicing.** Catalogue SQL is bind-parameter only:

- `${var}` in a catalogue file is rejected.
- Any `{{...}}` other than `{{> fragment}}` is rejected.
- Includes come from catalogue files only and are resolved when the catalogue
  loads, never from runtime values.

This replaces the "string-spliced CTE" pattern, where code concatenated an
exclusions list into the SQL text. Make the shared SQL a fragment, and pass
everything that varies as a bind.

Steps:

```
Run query "CUSTOMERS_BY_REGION" on ledger with region=${region}, min_limit=1000 and store the rows as customers
Get the value of query "CUSTOMER_NAME" with id=7 as name
Get the first row of query "RANDOM_ACTIVE_CUSTOMER" as pick
Expect query "CUSTOMERS_BY_REGION" on ledger with region="EU" returns 2 rows
Wait until query "INVOICE_POSTED" on ledger with invoice_no=${no} returns 1 row within 30 seconds
```

YAML/JSON:

```yaml
steps:
  - query: CUSTOMERS_BY_REGION
    on: ledger
    with: { region: EU, min_limit: 1000 }
    as: customers
  - query: CUSTOMERS_BY_REGION
    with: { region: EU }
    returns: 2                  # "at least 1", "no rows"; add `within: 30 seconds` to wait
  - action: db                  # canonical form
    db: { connection: ledger, query: CUSTOMER_NAME, binds: { id: 7 }, capture: cell }
    captureAs: name
```

## Oracle specifics

- **Syntax passes through unchanged**, for example:
  - `FETCH FIRST n ROWS ONLY` and `OFFSET ... FETCH NEXT`;
  - `ORDER BY DBMS_RANDOM.VALUE`;
  - `TO_DATE(:d, 'YYYY-MM-DD')`, `SYSDATE` and `ROWNUM`;
  - `CONNECT BY`, `LISTAGG` and `q'[...]'` literals. A `:` inside `q'[...]'`
    or `'...'` is never treated as a bind.
- **PL/SQL**: `OracleDbClient.plsql(block, binds)` runs a block with IN, OUT
  and IN OUT binds. An OUT bind is written `{ out: 'number' }`, and an IN OUT
  bind `{ out: 'string', value: 'x' }`. `callProcedure(name, params, outs)`
  calls a stored procedure, and the `Call procedure ... and out ...` step is
  built on it.
- **Read-only**: `OracleDbClient.readOnly(fn)` runs `fn` inside
  `SET TRANSACTION READ ONLY` and always rolls back. Any DML fails with
  ORA-01456. DDL would commit implicitly, so callers must still block DDL; the
  Studio console does this with its statement check.
- **Health**: `ping()` returns the server version and latency, and
  `poolStatus()` returns the open and in-use connections.
- **Statement check**: `describe(sql)` parses SQL without executing it, using
  thin-mode `getStatementInfo`. It returns the bind names and columns, and
  raises ORA-00904/ORA-00942 for unknown columns and tables. DDL is neither
  parsed nor executed.

## CLI: queries, validate, doctor

| Command | What it does |
|---|---|
| `eztest queries list [--connection a] [--fragments] [--json]` | Name, connection, params with defaults, and description of each query |
| `eztest queries check [NAME...] [--connection a] [--json]` | Checks each query statically (includes, declared and unused params, mixed bind styles), then prepares it against the live database **without executing writes**. Oracle: thin-mode parse (`getStatementInfo`). PostgreSQL: `EXPLAIN` in a READ ONLY transaction that is rolled back. SQL Server: `sp_describe_first_result_set` for reads, inside a rolled-back transaction. SQLite: `EXPLAIN`. DDL is reported as skipped. Exits 1 on any error |
| `eztest validate` | Besides parsing, checks every catalogue step: the query exists, required params are supplied, no unknown params are passed, and the connection is configured |
| `eztest doctor [--no-db]` | Connects to every configured database and reports the dialect, server version, latency and, for Oracle, Thin mode and the pool. Also loads the catalogue |

## Studio workbench

The SQL console works on every dialect. It is **read-only by default**:

1. A statement check blocks anything that is not clearly a read. That includes
   PL/SQL blocks, DDL and multiple statements.
2. Each dialect then enforces read-only:
   - SQLite: the file is opened read-only.
   - PostgreSQL: `SET TRANSACTION READ ONLY`.
   - SQL Server: the statement runs in a transaction that is always rolled back.
   - Oracle: `SET TRANSACTION READ ONLY`, always rolled back.

"Allow writes for this session" works as before: you enable it, and then each
write asks for confirmation.

The **Queries** panel lists the catalogue with each query's connection, params
and expanded SQL. It runs a query with bound values (`${var}` takes
workbench variables) through the same read-only path. "Save as step" inserts a
validated `Run query "NAME" ... and store the rows as ...` line into a journey.

## Examples from a query

`Examples: from query "NAME" on <alias> [where a = "x" and b = 2]` makes a
journey run once per result row. The row's columns become variables, keeping
the database's casing (Oracle: `<CUSTOMER_ID>`, `${CUSTOMER_ID}`).

The resolver is `resolveQueryExamples(name, alias, params, ctx)` in
`@mohammed-a-khan/eztest/queries`, and `engine.queryExamples(name, alias, params)` wires it to
the configured catalogue and connections. `parseQueryExamplesSource(text)`
parses the `from query ...` part.

The `Examples: from data ...` grammar and its engine hook are added separately.
Once that hook exists, register the query source with one line:

```ts
// in the Examples data-source hook (engine): query sources resolve through the catalogue
if (src.kind === 'query') return engine.queryExamples(src.name, src.alias, src.params);
```

## Security notes

- **Values are always bound.** Values are never spliced into SQL text: not in
  inline SQL (`${var}` becomes a bind), not in catalogue SQL (`:name`/`?`
  only), not in procedure calls (names are validated identifiers, and
  arguments are binds). The tests insert and read back strings such as
  `x'); DROP TABLE ...; --` to prove they stay values.
- **Catalogue includes are static**: they are textual, they come only from
  catalogue files, and they are resolved at load time.
- **Read-only by default** in Studio, with dialect-level enforcement beneath
  the statement check (see above). `queries check` never executes DML or DDL.
- **Secrets**: use `secret://` or `ENC(...)` passwords. Resolved values are
  masked in logs, errors, reports, evidence and the workbench.
- **Least privilege**: point test connections at a read-only account where the
  journeys only read. Grant writes only to the schemas that test setup needs.
- **Thin mode** needs no native client libraries on test machines or CI
  agents.

## Running the database tests

The live database tests skip, with a message, unless their environment is set,
so CI without databases stays green.

```bash
# Oracle Free 23ai (app user eztest / EzTest_1, service FREEPDB1)
docker run -d --name ez-oracle -p 1521:1521 \
  -e ORACLE_PASSWORD=EzOracle_1 -e APP_USER=eztest -e APP_USER_PASSWORD=EzTest_1 \
  gvenzl/oracle-free:23-slim-faststart
# SQL Server 2022 (optional, for the cross-dialect test)
docker run -d --name ez-mssql -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='EzSql_Pass1' \
  -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest

npm install --no-save oracledb       # and mssql for the SQL Server test
export EZTEST_ORACLE_URL=oracle://eztest:EzTest_1@localhost:1521/FREEPDB1
#   (or EZTEST_ORACLE_HOST / _PORT / _SERVICE / _USER / _PASSWORD)
export EZTEST_MSSQL_URL=mssql://sa:EzSql_Pass1@localhost:1433/master
#   EZTEST_MSSQL_DRIVER=/path/to/node_modules/mssql   when mssql is installed elsewhere
npm test -- test/surfaces/db-oracle.test.ts test/surfaces/db-cross-dialect.test.ts test/e2e/oracle-journey.test.ts
```

| Test file | Needs | Covers |
|---|---|---|
| `test/surfaces/db-sql.test.ts` | nothing | the scanner, `${var}` binding per dialect, case-insensitive rows, Oracle type helpers, the catalogue (fragments, binds, splicing rejected), grammar, YAML and validation |
| `test/e2e/queries-sqlite.test.ts` | nothing | the catalogue end to end on SQLite: `validate`, `queries list/check`, `doctor`, a run, and Examples |
| `test/surfaces/db-oracle.test.ts` | Oracle | pooling, binds and injection, types and CLOB, `FETCH FIRST`/`DBMS_RANDOM`, PL/SQL OUT/IN OUT/REF CURSOR, read-only transactions, the catalogue, `queries check`, Examples |
| `test/e2e/oracle-journey.test.ts` | Oracle (+ Chromium) | `examples/oracle-project`: seeds a fictional ledger, then runs an API and UI journey cross-checked against Oracle, the CLI, and the Studio workbench |
| `test/surfaces/db-cross-dialect.test.ts` | Oracle + SQL Server | the same rows compared across dialects, and one catalogue query run and checked on both |
