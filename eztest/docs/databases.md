# Databases

EZTest talks to SQLite, PostgreSQL, SQL Server, Oracle, MySQL and MariaDB
through one client interface. Journeys query them inline or through a **named-query catalogue**.
The query results compare with UI tables, API bodies and other databases by
key, with typed and case-insensitive matching.

- [Connections](#connections)
- [SQL Server authentication](#sql-server-authentication)
- [Results: rows, types and column names](#results-rows-types-and-column-names)
- [Steps](#steps)
- [The named-query catalogue](#the-named-query-catalogue)
- [Oracle specifics](#oracle-specifics)
- [MySQL and MariaDB](#mysql-and-mariadb)
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
    sales:                           # SQL Server from an ADO.NET connection string, Entra ID service principal
      type: mssql
      connectionString: "Server=tcp:sales.database.windows.net,1433;Database=sales;Encrypt=True;Authentication=Active Directory Service Principal;User ID=${SALES_APP_ID};Password=secret://vault/SALES_SP_SECRET;TenantId=${TENANT_ID}"
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
    hr:
      driver: mariadb                # or mysql: the same client
      host: hr-db.test
      port: 3306                     # default 3306
      database: orangehrm
      user: qa_reader
      password: secret://vault/HR_DB_PW
      ssl: { ca: /secure/hr-ca.pem } # TLS with the certificate verified (ssl: true uses the system roots)
      pool: { max: 4 }
      # connectionString: "mysql://qa_reader:secret://vault/HR_DB_PW@hr-db.test:3306/orangehrm?ssl=true"
```

`type:` and `driver:` are interchangeable. `postgresql`, `sqlserver` and
`mariadb` are accepted as aliases (`mariadb` is `mysql`). Connections open lazily on first use and close at the end
of the run.

| Dialect | Package | Install | Placeholders |
|---|---|---|---|
| SQLite | built in (`node:sqlite`, Node 22.5+) | nothing | `?`, `:name` |
| PostgreSQL | `pg` | `npm install pg` | `$1..$n`, `:name` (rewritten to `$n`; `::` casts and literals are left alone) |
| SQL Server | `mssql` | `npm install mssql` | `@p1..@pn`, `@name` |
| Oracle | `oracledb` (Thin mode, pure JavaScript) | `npm install oracledb` | `:1..:n`, `:name` |
| MySQL, MariaDB | built in (EZTest's own protocol client) | nothing | `?`, `:name` (rewritten to `?`) |

The drivers are optional peer dependencies. EZTest loads a driver only when a
connection uses it. When a driver is missing, the error names the command to
run. Oracle runs in **Thin mode only**: EZTest never calls
`initOracleClient()`, so no Instant Client or native code is needed. The
oracledb licence is Apache-2.0 OR UPL-1.0.

Passwords can be `secret://store/key` references, which are resolved through
`identity.secretStores` when the connection opens. They can also be `ENC(...)`
values, which are decrypted when the config loads. Either way, resolved values
are masked in logs, reports and evidence. A `secret://` reference may also sit
inside a connection string (`Password=secret://vault/PW;` or an `mssql://` URL
query value); it is resolved and quoted so the string still parses. Ports may
come from `${ENV}` text (`port: ${PG_PORT:-5432}`).

**Drivers installed elsewhere.** When a driver lives outside the project (a
shared drivers folder, a CI image), point EZTest at its package folder:
`EZTEST_PG_DRIVER`, `EZTEST_MSSQL_DRIVER` or `EZTEST_ORACLEDB_DRIVER`
(for example `EZTEST_PG_DRIVER=/opt/drivers/node_modules/pg`).

## SQL Server authentication

`authentication:` (or `Authentication=` in a connection string) picks how
EZTest signs in. Each mode maps onto the `authentication` option of the
mssql / tedious driver:

| `authentication.type` | Connection string | Driver option | Needs |
|---|---|---|---|
| `sql` (default) | `Authentication=Sql Password` | `default` | `user`, `password` |
| `ntlm` | `Authentication=Windows` or `Integrated Security=true` with `DOMAIN\user` | `ntlm` | `domain` (or `DOMAIN\user`), `user`, `password` |
| `kerberos` | `Integrated Security=SSPI` / `Trusted_Connection=yes` | the `mssql/msnodesqlv8` driver, `Trusted_Connection=Yes` | `npm install msnodesqlv8`, the Microsoft ODBC Driver 18, and a Kerberos ticket (`kinit` on Linux) |
| `entra-password` | `Authentication=Active Directory Password` | `azure-active-directory-password` | `user`, `password`, `clientId` (`ClientId=`), `tenantId` |
| `entra-service-principal` | `Authentication=Active Directory Service Principal` | `azure-active-directory-service-principal-secret` | `clientId` (`User ID=`), `clientSecret` (`Password=`), `tenantId` |
| `entra-managed-identity` | `Authentication=Active Directory Managed Identity` (or `MSI`) | `azure-active-directory-msi-vm`, or `-msi-app-service` when `IDENTITY_ENDPOINT` is set | `clientId` for a user-assigned identity |
| `entra-access-token` | `Authentication=Active Directory Access Token` + `AccessToken=` | `azure-active-directory-access-token` | `token` (a `secret://` reference) |
| `entra-default` | `Authentication=Active Directory Default` | `azure-active-directory-default` | the Azure credential chain of the machine |

```yaml
db:
  connections:
    crm:
      type: mssql
      server: sql.corp.test
      database: crm
      user: CORP\qa_reader            # or user: qa_reader + domain: CORP
      password: secret://vault/CRM_PW
      authentication: { type: ntlm }
    reports:
      type: mssql
      server: reports.database.windows.net
      database: reports
      authentication:
        type: entra-service-principal
        clientId: 11111111-2222-3333-4444-555555555555
        clientSecret: secret://vault/REPORTS_SP_SECRET
        tenantId: contoso.onmicrosoft.com
        tokenSource: eztest           # tokens from EZTest's own OAuth client
```

`mssql://user:password@host:1433/database?encrypt=true&trustServerCertificate=false&authentication=ntlm&domain=CORP`
is the URL form (`mssql://host/INSTANCE/database` names an instance). Fields
given next to a connection string win over it.

**`tokenSource: eztest`** (Entra password, service principal and managed
identity): EZTest gets the token itself (client credentials, resource-owner
password, or the managed identity endpoint: IMDS on a VM, `IDENTITY_ENDPOINT`
on App Service) for the scope the server asks for, caches it until 5 minutes
before it expires, and hands it to the driver as a token credential. The
driver's own Azure libraries are then not used at all.

What is proven, and how:

- **SQL logins**, from fields, an ADO.NET string with a `secret://` password and
  an `mssql://` URL: live against SQL Server 2022.
- **NTLM**: live against the same SQL Server. The container is not joined to a
  domain, so it answers the NTLM sign-in with "The login is from an untrusted
  domain and cannot be used with Integrated authentication": proof that the
  NTLM exchange reached the server and was handled as a Windows login. A
  successful NTLM login needs a domain-joined SQL Server.
- **Kerberos**: the mapping only (driver module, ODBC connection string). It
  was not run here: it needs `msnodesqlv8` (native), the ODBC driver and a KDC.
  tedious itself has no Kerberos support on any platform.
- **Entra ID modes**: every mapping is accepted by the real tedious driver's
  configuration check; the `tokenSource: eztest` credentials get tokens from
  local fake token and IMDS servers. No Azure SQL database was used.

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

### Transactions

```
In a transaction on clinic
  Run query "INSERT_VISIT" on clinic with visit_id=${visitId}, pet_id=${petId}, reason="check-up" as visit
  Run query "INSERT_INVOICE" on clinic with visit_id=${visitId}, amount=45 as invoice
End
```

The query steps inside the block run on one connection of the alias, in one transaction, on every
driver (SQLite, PostgreSQL, SQL Server, Oracle, MySQL and MariaDB): committed when every step passed,
rolled back when one failed (the block then fails with that step's error). The block's result says
`committed` or `rolled back` and how many statements ran, and its evidence lists each statement with the
number of bound values (never the values). Steps that do not use the alias run as usual. In code:
`db.transaction(async (tx) => ..., { connection })` and `db.executeAll([...], { connection })`
([sdk.md](sdk.md#transactions)).

### Cleanup queries

```
Snapshot query "PET_ROW" on clinic with pet_id=${petId} and restore it with "RESTORE_PET" after the journey
On cleanup run query "DELETE_VISIT" on clinic with visit_id=${visitId}
```

Both register an action that runs after the journey, newest first, also when it failed. They are written
to the cleanup journal first, so the next run's orphan sweep runs them when this run crashed
([reliability.md](reliability.md#cleanup-that-survives-crashes)). `RESTORE_PET` gets the snapshot row's
values for its `:binds`.

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

## MySQL and MariaDB

EZTest speaks the MySQL client/server protocol itself, so there is no driver
package to install, and MySQL 5.7/8.x and MariaDB 10.x/11.x work the same way.

- **Sign-in.** `mysql_native_password` (MariaDB's default),
  `caching_sha2_password` (MySQL 8's default), `sha256_password`, and
  `mysql_clear_password` over TLS only. A server's auth-switch request is
  followed. caching_sha2_password signs in by its fast path when the server has
  the user cached. Otherwise (the first sign-in after a restart or
  `FLUSH PRIVILEGES`, or a wrong password) the server asks for the password
  itself, which EZTest sends only over TLS or encrypted with the server's RSA
  key: give `serverPublicKey` (PEM text or a file), or set
  `allowPublicKeyRetrieval: true` to fetch it (a man in the middle could swap a
  fetched key, so it is off by default). Without either, the error says so.
- **TLS.** `ssl: true` verifies the certificate against the system roots and
  the host name; `ssl: { ca, cert, key, servername, rejectUnauthorized }` takes
  PEM text or file paths (`cert`/`key` for X.509 users). A host given as an IP
  address is checked against the certificate's IP SANs. URL forms:
  `?ssl=true`, `?ssl-mode=VERIFY_IDENTITY|VERIFY_CA` (verified), `REQUIRED` (TLS, not verified), `PREFERRED`
  (TLS when the server offers it), `DISABLED`, and `?ssl-ca=/path`.
- **Statements.** SQL without values goes as a plain query (several statements
  separated by `;` return several results). SQL with values is prepared on the
  server and executed with the values bound in the binary protocol; prepared
  statements are cached per connection (and prepared again after the table
  changes). `LOAD DATA LOCAL INFILE` is never allowed.
- **String rules.** MySQL string literals treat a backslash as an escape
  (`'it\'s'`). The `${var}` binder and the catalogue read MySQL SQL with those
  rules, so `'a\':b'` holds no bind. A catalogue query is read this way when its
  `-- connection:` is a MySQL connection (or every connection is).
- **Several results.** `MysqlDbClient.results(sql, params)` returns every result
  set and OK of a call, for example a `CALL` of a procedure that selects twice.
  `query()` returns the first result set; `Call procedure "raise" on hr with params '[1, 10.5]'`
  sends `CALL raise(?, ?)`.
- **Rows affected** count matched rows (as Connector/J reports them), so an
  `UPDATE` that sets a value it already had still counts its row.
- **Read-only**: `readOnly(fn)` runs fn in `START TRANSACTION READ ONLY` and
  rolls back; writes fail with error 1792. The Studio console uses it.
- **Statement check**: `describe(sql)` prepares a statement without running
  it, so `queries check` reports unknown tables and columns (error 1146, 1054)
  without executing anything, DML included.
- **Health and load monitor**: `ping()` and `poolStatus()` (`doctor` shows
  `MariaDB 10.11.x` or `MySQL 8.4.x (TLS)`); the load monitor reads sessions
  from `information_schema.PROCESSLIST` (the PROCESS privilege shows every
  session), statements from `Questions`, and top SQL from
  `performance_schema` when it is on.

| MySQL type | Value |
|---|---|
| `TINYINT` .. `INT`, `YEAR` | `number` |
| `BIGINT` (signed and unsigned) | `number`; the exact digits as a `string` beyond 2^53 |
| `DECIMAL` | `number` when a double holds every digit, else the exact text (`DECIMAL(30,10)`) |
| `FLOAT`, `DOUBLE` | `number` (a FLOAT read through a prepared statement is rounded to its 7 significant digits, as the text protocol shows it) |
| `DATETIME`, `TIMESTAMP` | `Date` in `timezone` (`local` by default, or `Z`, `+02:00`); `dateStrings: true` returns `'2026-03-01 14:05:00'` |
| `DATE` | `'YYYY-MM-DD'` text: a calendar date is not an instant, so no time zone can shift it |
| `TIME` | text (`'-838:59:59'`, `'12:00:00.250000'`) |
| `CHAR`, `VARCHAR`, `TEXT`, `ENUM`, `SET`, `JSON` | `string` (utf8mb4) |
| `BINARY`, `VARBINARY`, `BLOB`, `GEOMETRY` | `Buffer` |
| `BIT(n)` | `number` (n <= 48), else `Buffer` |
| `NULL` | `null` |
| zero dates (`'0000-00-00'`) | the text as stored |

Bound values: integers as `BIGINT`, other numbers as `DOUBLE`, booleans as
`1`/`0`, `bigint` as signed or unsigned 64-bit, `Date` as `DATETIME(3)` in
`timezone`, `Buffer`/`Uint8Array` as bytes, everything else as text.

The live tests run against MariaDB 10.11 and MySQL 8.4:

```bash
test/acceptance/enterprise/env/mysql.sh up    # both servers, TLS from a private CA, the test users
npm test -- test/integration/mysql-protocol.test.ts test/integration/mysql-journeys.test.ts
```

## CLI: queries, validate, doctor

| Command | What it does |
|---|---|
| `eztest queries list [--connection a] [--fragments] [--json]` | Name, connection, params with defaults, and description of each query |
| `eztest queries check [NAME...] [--connection a] [--json]` | Checks each query statically (includes, declared and unused params, mixed bind styles), then prepares it against the live database **without executing writes**. Oracle: thin-mode parse (`getStatementInfo`). PostgreSQL: `EXPLAIN` in a READ ONLY transaction that is rolled back. SQL Server: `sp_describe_first_result_set` for reads, inside a rolled-back transaction. MySQL/MariaDB: a server-side prepare (`COM_STMT_PREPARE`), never executed. SQLite: `EXPLAIN`. DDL is reported as skipped. Exits 1 on any error |
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
   - MySQL/MariaDB: `START TRANSACTION READ ONLY`, always rolled back.

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
`@eztech.com/eztest/queries`, and `engine.queryExamples(name, alias, params)` wires it to
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

# PostgreSQL 16 (pg_stat_statements loaded, for the top-SQL monitor)
docker run -d --name ez-postgres -p 5432:5432 -e POSTGRES_USER=eztest -e POSTGRES_PASSWORD=EzPg_Pass1 \
  -e POSTGRES_DB=eztest postgres:16-alpine -c shared_preload_libraries=pg_stat_statements

npm install --no-save oracledb       # and mssql / pg for the SQL Server / PostgreSQL tests
export EZTEST_ORACLE_URL=oracle://eztest:EzTest_1@localhost:1521/FREEPDB1
#   (or EZTEST_ORACLE_HOST / _PORT / _SERVICE / _USER / _PASSWORD)
export EZTEST_MSSQL_URL=mssql://sa:EzSql_Pass1@localhost:1433/master
#   EZTEST_MSSQL_DRIVER=/path/to/node_modules/mssql   when mssql is installed elsewhere
export EZTEST_PG_URL=postgres://eztest:EzPg_Pass1@localhost:5432/eztest
#   EZTEST_PG_DRIVER=/path/to/node_modules/pg         when pg is installed elsewhere
npm test -- test/surfaces/db-oracle.test.ts test/surfaces/db-cross-dialect.test.ts test/e2e/oracle-journey.test.ts
npm test -- test/surfaces/db-postgres.test.ts test/e2e/postgres-journey.test.ts test/surfaces/db-mssql.test.ts
```

| Test file | Needs | Covers |
|---|---|---|
| `test/surfaces/db-sql.test.ts` | nothing | the scanner, `${var}` binding per dialect, case-insensitive rows, Oracle type helpers, the catalogue (fragments, binds, splicing rejected), grammar, YAML and validation |
| `test/e2e/queries-sqlite.test.ts` | nothing | the catalogue end to end on SQLite: `validate`, `queries list/check`, `doctor`, a run, and Examples |
| `test/surfaces/db-oracle.test.ts` | Oracle | pooling, binds and injection, types and CLOB, `FETCH FIRST`/`DBMS_RANDOM`, PL/SQL OUT/IN OUT/REF CURSOR, read-only transactions, the catalogue, `queries check`, Examples |
| `test/e2e/oracle-journey.test.ts` | Oracle (+ Chromium) | `examples/oracle-project`: seeds a fictional ledger, then runs an API and UI journey cross-checked against Oracle, the CLI, and the Studio workbench |
| `test/surfaces/db-cross-dialect.test.ts` | Oracle + SQL Server | the same rows compared across dialects, and one catalogue query run and checked on both |
| `test/surfaces/db-postgres.test.ts` | PostgreSQL | pooling, `$n` and `:name` binds and injection, casts, pg types, transactions and SQLSTATE errors, the catalogue, `queries check` (EXPLAIN, read-only), Examples, the load test's database monitor |
| `test/e2e/postgres-journey.test.ts` | PostgreSQL (+ Chromium) | `examples/postgres-project`: API and UI compared with the ledger cell by cell, one run per query row (`Examples: from query`), the CLI, and a missing table triaged as `db-schema-missing` |
| `test/integration/mysql-protocol.test.ts` | MariaDB 10.11 + MySQL 8.4 (`env/mysql.sh up`) | the protocol client: TLS, every sign-in path, text and binary types, several results, >16 MB payloads, the pool, transactions, errors |
| `test/integration/mysql-journeys.test.ts` | MariaDB 10.11 + MySQL 8.4 | `.ez` steps, the catalogue, `queries check`, `doctor` and `run` through the CLI |
| `test/surfaces/db-mssql.test.ts` | nothing (+ SQL Server for the live part) | connection strings, every authentication mapping checked by the real tedious driver, Entra tokens from EZTest, live SQL login and NTLM |
