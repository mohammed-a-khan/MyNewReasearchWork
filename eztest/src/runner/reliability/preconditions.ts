/**
 * Data-state preconditions (`Requires:`), checked before a journey's first
 * step. A journey whose data is not there is a *data problem*: it is reported
 * with the failing check (error name "DataPrecondition", triage category
 * "data"), its steps are not run, and nobody chases a product bug that is not
 * there. Data needs (`Data:` header) that cannot be satisfied are reported the
 * same way.
 */
import { DataNeed, EzTestError, evaluateExpression, truthy, type Precondition, type PreconditionResult } from '../../core/index.js';
import { createFetchApiHandler } from '../api.js';
import { bindSql } from '../data-steps.js';
import type { RunOptions, StepContext } from '../types.js';

export const DATA_PRECONDITION = 'DataPrecondition';

/** An error that marks a data problem (not a product failure). */
export class DataPreconditionError extends EzTestError {
  constructor(message: string, readonly results: PreconditionResult[] = []) {
    super(message, 'DATA_PRECONDITION');
    this.name = DATA_PRECONDITION;
  }
}

function label(p: Precondition): string {
  if (p.text) return p.text;
  switch (p.kind) {
    case 'db': return `db ${p.connection} query`;
    case 'query': return `query ${p.name}`;
    case 'api': return `api ${p.method} ${p.url} returns ${p.status}`;
    case 'data': return `data ${p.entity}`;
    case 'variable': return `variable ${p.name}`;
    case 'expr': return `that ${p.expr}`;
  }
}

async function check(p: Precondition, ctx: StepContext, opts: RunOptions): Promise<PreconditionResult> {
  const res = (passed: boolean, message?: string): PreconditionResult => ({ check: label(p), passed, ...(message ? { message } : {}) });
  switch (p.kind) {
    case 'variable': {
      const v = ctx.vars()[p.name];
      return v === undefined || v === null || v === '' ? res(false, `${p.name} is not set`) : res(true);
    }
    case 'expr': {
      try {
        const v = evaluateExpression(p.expr, ctx.vars());
        // A precondition that is false by construction (a row whose live data was not found) says only what it is.
        return truthy(v) ? res(true) : p.expr === 'false' && p.text ? res(false) : res(false, `${p.expr} is ${JSON.stringify(v)}`);
      } catch (e) {
        return res(false, (e as Error).message);
      }
    }
    case 'db': {
      if (!opts.db) return res(false, 'no database handler configured');
      const dialect = (await opts.db.dialect?.(p.connection)) ?? 'sqlite';
      const bound = bindSql(p.sql, [], ctx.vars(), dialect);
      const rows = await opts.db.query(p.connection, bound.sql, bound.params as never);
      return rows.length >= p.min ? res(true, `${rows.length} row(s)`) : res(false, `${rows.length} row(s), at least ${p.min} needed`);
    }
    case 'query': {
      if (!opts.db?.namedQuery) return res(false, 'no query catalogue configured (db.queries)');
      const c = await opts.db.namedQuery(p.name, p.connection, {});
      const rows = await opts.db.query(c.connection, c.sql, c.params as never);
      return rows.length >= p.min ? res(true, `${rows.length} row(s)`) : res(false, `${rows.length} row(s), at least ${p.min} needed`);
    }
    case 'api': {
      const handler = opts.api ?? createFetchApiHandler({ authHeaders: opts.apiAuth, clientCertificates: opts.clientCertificates });
      const r = await handler({ method: p.method, url: ctx.interpolate(p.url), ...(p.asRole ? { asRole: p.asRole } : {}) }, ctx);
      return r.status === p.status ? res(true, `HTTP ${r.status}`) : res(false, `HTTP ${r.status}, expected ${p.status}`);
    }
    case 'data': {
      if (!opts.data) return res(false, 'no data handler configured');
      const need = DataNeed.parse({ entity: p.entity, as: p.as ?? p.entity.toLowerCase(), where: Object.fromEntries(Object.entries(p.where).map(([k, v]) => [k, ctx.interpolate(v)])), strategy: 'find' });
      const rec = await opts.data(need, ctx);
      ctx.ledger.set(need.as, rec);
      return res(true, `found ${p.entity}`);
    }
  }
}

/**
 * Check every precondition (all of them, so the report lists every missing piece).
 * Throws DataPreconditionError when any does not hold; returns the results otherwise.
 */
export async function checkPreconditions(list: Precondition[], ctx: StepContext, opts: RunOptions): Promise<PreconditionResult[]> {
  const results: PreconditionResult[] = [];
  for (const p of list) {
    try {
      results.push(await check(p, ctx, opts));
    } catch (e) {
      results.push({ check: label(p), passed: false, message: (e as Error).message.split('\n')[0] });
    }
  }
  const bad = results.filter((r) => !r.passed);
  if (bad.length) {
    throw new DataPreconditionError(`data problem: ${bad.map((r) => `${r.check}${r.message ? ` (${r.message})` : ''}`).join('; ')}`, results);
  }
  return results;
}
