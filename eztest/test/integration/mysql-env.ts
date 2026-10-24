/**
 * Live MySQL and MariaDB servers for the wire-protocol tests. Each server comes from an environment variable when
 * set, otherwise from the containers test/acceptance/enterprise/env/mysql.sh starts (it is run here when Docker is
 * available and the servers are not up yet). Without either, the tests are skipped with a message.
 *
 *   EZTEST_MARIADB_URL=mysql://eztest:EzMaria_1@127.0.0.1:13306/eztest      (+ EZTEST_MARIADB_ROOT_URL)
 *   EZTEST_MYSQL_URL=mysql://eztest:EzMysql_1@127.0.0.1:13307/eztest        (+ EZTEST_MYSQL_ROOT_URL)
 *   EZTEST_MYSQL_CA=/path/to/ca.pem     the CA that signed both servers' certificates
 *   EZTEST_DOCKER=0                     never start containers
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface MysqlServer {
  label: 'MariaDB 10.11' | 'MySQL 8.4';
  flavor: 'mariadb' | 'mysql';
  url: string;
  rootUrl: string;
  host: string;
  port: number;
}

export interface MysqlEnv {
  servers: MysqlServer[];
  ca?: string;
  skip?: string;
}

const SCRIPT = resolve(__dirname, '../acceptance/enterprise/env/mysql.sh');
const STATE = join(process.env.EZTEST_ENV_DIR ?? join(homedir(), '.cache/eztest-enterprise-env'), 'mysql');

function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = connect({ host, port });
    s.setTimeout(1500);
    s.on('connect', () => {
      s.destroy();
      done(true);
    });
    s.on('timeout', () => {
      s.destroy();
      done(false);
    });
    s.on('error', () => done(false));
  });
}

function server(label: MysqlServer['label'], flavor: MysqlServer['flavor'], url: string, rootUrl: string): MysqlServer {
  const u = new URL(url);
  return { label, flavor, url, rootUrl, host: u.hostname, port: Number(u.port || 3306) };
}

let cached: Promise<MysqlEnv> | undefined;

export function mysqlEnv(): Promise<MysqlEnv> {
  return (cached ??= (async () => {
    const e = process.env;
    const wanted = [
      server('MariaDB 10.11', 'mariadb', e.EZTEST_MARIADB_URL ?? 'mysql://eztest:EzMaria_1@127.0.0.1:13306/eztest', e.EZTEST_MARIADB_ROOT_URL ?? 'mysql://root:EzMaria_Root1@127.0.0.1:13306/eztest'),
      server('MySQL 8.4', 'mysql', e.EZTEST_MYSQL_URL ?? 'mysql://eztest:EzMysql_1@127.0.0.1:13307/eztest', e.EZTEST_MYSQL_ROOT_URL ?? 'mysql://root:EzMysql_Root1@127.0.0.1:13307/eztest'),
    ];
    const up = async () => (await Promise.all(wanted.map((s) => portOpen(s.host, s.port)))).every(Boolean);
    let ready = await up();
    if (!ready && e.EZTEST_DOCKER !== '0' && !e.EZTEST_MARIADB_URL && !e.EZTEST_MYSQL_URL) {
      try {
        await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 8000 });
        console.warn('[eztest] starting MariaDB 10.11 and MySQL 8.4 containers (test/acceptance/enterprise/env/mysql.sh up)');
        await run('bash', [SCRIPT, 'up'], { timeout: 420_000 });
        ready = await up();
      } catch (err) {
        return { servers: [], skip: `MySQL/MariaDB tests skipped: Docker is not available or the containers did not start (${String((err as Error).message).split('\n')[0]}); run ${SCRIPT} up or set EZTEST_MARIADB_URL / EZTEST_MYSQL_URL` };
      }
    }
    if (!ready) return { servers: [], skip: `MySQL/MariaDB tests skipped: no server at ${wanted.map((s) => `${s.host}:${s.port}`).join(' / ')}; run ${SCRIPT} up or set EZTEST_MARIADB_URL / EZTEST_MYSQL_URL` };
    const ca = e.EZTEST_MYSQL_CA ?? (existsSync(join(STATE, 'certs/ca.pem')) ? join(STATE, 'certs/ca.pem') : undefined);
    return { servers: wanted, ca };
  })());
}
