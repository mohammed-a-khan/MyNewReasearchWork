/**
 * Database monitors over EZTest's own drivers (no agent on the DB host):
 * sessions (total / active), wait time per wait class (ms of waiting per
 * second, from the cumulative wait statistics), a throughput counter and
 * the top SQL by elapsed time.
 *
 *   Oracle      v$session, v$system_event, v$sysstat, v$sqlarea
 *   SQL Server  sys.dm_exec_sessions, sys.dm_os_wait_stats, sys.dm_os_performance_counters, sys.dm_exec_query_stats
 *   PostgreSQL  pg_stat_activity, pg_stat_database, pg_stat_statements (when installed)
 *
 * The monitoring user needs read access to those views (Oracle: SELECT_CATALOG_ROLE
 * or SELECT ANY DICTIONARY; SQL Server: VIEW SERVER STATE; Postgres: pg_monitor).
 */
import type { DbClient } from '../../surfaces/db.js';

export interface DbSample {
  values: Record<string, number>;
  topSql: Array<{ sql: string; executions: number; totalMs: number; avgMs: number }>;
  errors: string[];
}

/** Run thunks in order (sequential queries). */
async function seq(list: Array<() => Promise<Array<Record<string, unknown>>>>): Promise<Array<Array<Record<string, unknown>>>> {
  const out: Array<Array<Record<string, unknown>>> = [];
  for (const f of list) out.push(await f());
  return out;
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const pick = (row: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) for (const [rk, rv] of Object.entries(row)) if (rk.toLowerCase() === k.toLowerCase()) return rv;
  return undefined;
};

export class DbMonitor {
  private prevWaits?: { at: number; waits: Map<string, number>; counter?: number };
  constructor(readonly db: DbClient, readonly o: { topSql?: number } = {}) {}

  /** Queries run one after the other: a monitor must not add a burst of connections to the database it watches. */
  private async q(sql: string, errors: string[]): Promise<Array<Record<string, unknown>>> {
    try {
      return await this.db.query(sql);
    } catch (e) {
      errors.push(`${(e as Error).message.split('\n')[0].slice(0, 200)}`);
      return [];
    }
  }

  async sample(): Promise<DbSample> {
    const errors: string[] = [];
    const n = this.o.topSql ?? 5;
    const d = this.db.dialect;
    let sessions: Array<Record<string, unknown>> = [];
    let waits: Array<Record<string, unknown>> = [];
    let counter: Array<Record<string, unknown>> = [];
    let top: Array<Record<string, unknown>> = [];
    if (d === 'oracle') {
      [sessions, waits, counter, top] = await seq([
        () => this.q(`SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active FROM v$session WHERE type = 'USER'`, errors),
        () => this.q(`SELECT wait_class AS wclass, SUM(time_waited_micro) / 1000 AS wait_ms FROM v$system_event WHERE wait_class <> 'Idle' GROUP BY wait_class`, errors),
        () => this.q(`SELECT value AS counter FROM v$sysstat WHERE name = 'execute count'`, errors),
        () => n ? this.q(`SELECT * FROM (SELECT SUBSTR(sql_text, 1, 200) AS sql_text, executions, elapsed_time / 1000 AS total_ms FROM v$sqlarea WHERE executions > 0 ORDER BY elapsed_time DESC) WHERE ROWNUM <= ${n}`, errors) : Promise.resolve([]),
      ]);
    } else if (d === 'mssql') {
      [sessions, waits, counter, top] = await seq([
        () => this.q(`SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('running', 'runnable', 'suspended') THEN 1 ELSE 0 END) AS active FROM sys.dm_exec_sessions WHERE is_user_process = 1`, errors),
        () => this.q(`SELECT TOP 20 wait_type AS wclass, wait_time_ms AS wait_ms FROM sys.dm_os_wait_stats WHERE wait_time_ms > 0 AND wait_type NOT LIKE 'SLEEP%' AND wait_type NOT LIKE '%QUEUE%' AND wait_type NOT IN ('BROKER_TASK_STOP','CHECKPOINT_QUEUE','DIRTY_PAGE_POLL','HADR_FILESTREAM_IOMGR_IOCOMPLETION','LOGMGR_QUEUE','REQUEST_FOR_DEADLOCK_SEARCH','SQLTRACE_INCREMENTAL_FLUSH_SLEEP','WAITFOR','XE_DISPATCHER_WAIT','XE_TIMER_EVENT','SOS_WORK_DISPATCHER','QDS_PERSIST_TASK_MAIN_LOOP_SLEEP','QDS_ASYNC_QUEUE','PREEMPTIVE_OS_FLUSHFILEBUFFERS') ORDER BY wait_time_ms DESC`, errors),
        () => this.q(`SELECT cntr_value AS counter FROM sys.dm_os_performance_counters WHERE counter_name = 'Batch Requests/sec'`, errors),
        () => n ? this.q(`SELECT TOP ${n} SUBSTRING(t.text, 1, 200) AS sql_text, s.execution_count AS executions, s.total_elapsed_time / 1000 AS total_ms FROM sys.dm_exec_query_stats s CROSS APPLY sys.dm_exec_sql_text(s.sql_handle) t ORDER BY s.total_elapsed_time DESC`, errors) : Promise.resolve([]),
      ]);
    } else if (d === 'postgres') {
      [sessions, waits, counter, top] = await seq([
        () => this.q(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE state = 'active') AS active FROM pg_stat_activity WHERE backend_type = 'client backend'`, errors),
        // Postgres has no cumulative wait statistics: report sessions currently waiting per wait type (x1000 so the unit matches "ms per second").
        () => this.q(`SELECT wait_event_type AS wclass, COUNT(*) * 1000 AS wait_now FROM pg_stat_activity WHERE wait_event_type IS NOT NULL AND state = 'active' GROUP BY wait_event_type`, errors),
        () => this.q(`SELECT SUM(xact_commit + xact_rollback) AS counter FROM pg_stat_database`, errors),
        () => n ? this.q(`SELECT LEFT(query, 200) AS sql_text, calls AS executions, total_exec_time AS total_ms FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT ${n}`, []) : Promise.resolve([]),
      ]);
    } else {
      return { values: {}, topSql: [], errors: [`no database monitor for ${d}`] };
    }
    const values: Record<string, number> = {};
    // Every statistics view refused: name the privilege instead of returning an empty sample.
    if (errors.length && !sessions.length && !waits.length && !counter.length) {
      const need = d === 'oracle' ? 'SELECT_CATALOG_ROLE (or SELECT ANY DICTIONARY) for the V$ views' : d === 'mssql' ? 'VIEW SERVER STATE' : 'the pg_monitor role';
      errors.unshift(`the monitoring user cannot read the ${d} statistics views: grant it ${need}, or monitor with a user that has it`);
    }
    if (sessions[0]) {
      values.sessions = num(pick(sessions[0], 'total'));
      values.activeSessions = num(pick(sessions[0], 'active'));
    }
    const now = Date.now();
    const map = new Map<string, number>();
    for (const w of waits) map.set(String(pick(w, 'wclass')), num(pick(w, 'wait_ms', 'wait_now')));
    const c = counter[0] ? num(pick(counter[0], 'counter')) : undefined;
    if (d === 'postgres') for (const [k, v] of map) values[`wait.${k}`] = v;
    else if (this.prevWaits) {
      const dt = (now - this.prevWaits.at) / 1000;
      for (const [k, v] of map) {
        const before = this.prevWaits.waits.get(k);
        if (before !== undefined && v >= before) values[`wait.${k}`] = Math.round(((v - before) / dt) * 10) / 10;
      }
    }
    if (c !== undefined && this.prevWaits?.counter !== undefined) values.throughputPerSec = Math.round(((c - this.prevWaits.counter) / ((now - this.prevWaits.at) / 1000)) * 10) / 10;
    this.prevWaits = { at: now, waits: map, counter: c };
    const topSql = top.map((r) => {
      const executions = num(pick(r, 'executions'));
      const totalMs = Math.round(num(pick(r, 'total_ms')) * 10) / 10;
      return { sql: String(pick(r, 'sql_text') ?? '').replace(/\s+/g, ' ').trim(), executions, totalMs, avgMs: executions ? Math.round((totalMs / executions) * 100) / 100 : 0 };
    });
    return { values, topSql, errors };
  }
}
