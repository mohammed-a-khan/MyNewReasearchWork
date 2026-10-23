/**
 * Live-database test switches. Oracle and SQL Server tests run only when their
 * environment is set; otherwise they are skipped with a message saying how to
 * enable them (see docs/databases.md):
 *
 *   EZTEST_ORACLE_URL=oracle://eztest:EzTest_1@localhost:1521/FREEPDB1
 *     (or EZTEST_ORACLE_HOST, _PORT, _SERVICE, _USER, _PASSWORD)
 *   EZTEST_MSSQL_URL=mssql://sa:EzSql_Pass1@localhost:1433/master
 *     (+ EZTEST_MSSQL_DRIVER=/path/to/node_modules/mssql when mssql is not installed here)
 */
import type { OracleOptions } from '../../src/surfaces/index.js';

export interface OracleEnv extends OracleOptions {
  host: string;
  port: number;
  serviceName: string;
  user: string;
  password: string;
}

export function oracleEnv(env: NodeJS.ProcessEnv = process.env): OracleEnv | undefined {
  if (env.EZTEST_ORACLE_URL) {
    const u = new URL(env.EZTEST_ORACLE_URL);
    return { host: u.hostname, port: Number(u.port || 1521), serviceName: decodeURIComponent(u.pathname.replace(/^\//, '')), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
  }
  if (env.EZTEST_ORACLE_HOST && env.EZTEST_ORACLE_USER && env.EZTEST_ORACLE_PASSWORD) {
    return { host: env.EZTEST_ORACLE_HOST, port: Number(env.EZTEST_ORACLE_PORT || 1521), serviceName: env.EZTEST_ORACLE_SERVICE || 'FREEPDB1', user: env.EZTEST_ORACLE_USER, password: env.EZTEST_ORACLE_PASSWORD };
  }
  return undefined;
}

export const ORACLE_SKIP = 'Oracle tests skipped: set EZTEST_ORACLE_URL=oracle://user:password@host:1521/SERVICE (docs/databases.md has the docker command)';

export interface MssqlEnv {
  server: string;
  port: number;
  database: string;
  user: string;
  password: string;
  driverPath?: string;
}

export function mssqlEnv(env: NodeJS.ProcessEnv = process.env): MssqlEnv | undefined {
  if (!env.EZTEST_MSSQL_URL) return undefined;
  const u = new URL(env.EZTEST_MSSQL_URL);
  return { server: u.hostname, port: Number(u.port || 1433), database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'master', user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), driverPath: env.EZTEST_MSSQL_DRIVER };
}

export const MSSQL_SKIP = 'SQL Server tests skipped: set EZTEST_MSSQL_URL=mssql://sa:password@host:1433/master (docs/databases.md)';

/** The mssql module: installed here, or from EZTEST_MSSQL_DRIVER. */
export async function loadMssql(path?: string): Promise<unknown | undefined> {
  for (const spec of [path ? `${path.replace(/\/$/, '')}/index.js` : undefined, 'mssql'].filter(Boolean) as string[]) {
    try {
      const m = (await import(spec)) as { default?: unknown };
      return m.default ?? m;
    } catch {
      // try the next one
    }
  }
  return undefined;
}

/** Print the skip reason once per file so a green CI run says what did not run. */
export function announceSkip(on: boolean, message: string): void {
  if (!on) console.warn(`[eztest] ${message}`);
}
