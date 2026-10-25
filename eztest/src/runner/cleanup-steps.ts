/**
 * The `cleanup` step: registers an action that runs after the journey (src/runner/cleanup.ts).
 *
 *   On cleanup run query "DELETE_VISIT" on clinic with visit_id=${visitId}
 *     -> args { op: 'query', query, connection, binds }
 *   Snapshot query "PET_ROW" on clinic with pet_id=${petId} and restore it with "RESTORE_PET" after the journey
 *     -> args { op: 'snapshot', query, connection, binds, restore }: the row is read now; afterwards
 *        RESTORE_PET runs with the row's values (and the snapshot's own binds) for its `:binds`.
 *
 * Bind values are resolved when the step runs, so the action undoes exactly what this attempt did.
 */
import { EzTestError, Step, type DbQuery } from '../core/index.js';
import type { ActionOutcome } from './actions.js';
import type { CleanupBind } from './cleanup.js';
import { bindFromStep, dbAction } from './data-steps.js';
import type { RunOptions, StepContext } from './types.js';

type Binds = Record<string, CleanupBind>;

const plain = (v: unknown): CleanupBind => (v === null || v === undefined ? null : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' ? v : v instanceof Date ? v.toISOString() : JSON.stringify(v));

function describe(op: string, a: Record<string, unknown>, binds: Binds): string {
  const shown = Object.entries(binds).map(([k, v]) => `${k}=${String(v)}`).join(', ');
  return op === 'snapshot'
    ? `restore ${String(a.query)} with ${String(a.restore)}${shown ? ` (${shown})` : ''}`
    : `run query ${String(a.query)}${a.connection ? ` on ${String(a.connection)}` : ''}${shown ? ` with ${shown}` : ''}`;
}

export async function cleanupAction(step: Step, ctx: StepContext, opts: RunOptions): Promise<ActionOutcome> {
  const a = (step.args ?? {}) as Record<string, unknown>;
  const op = String(a.op ?? 'query');
  if (!ctx.cleanup) throw new EzTestError(`"${step.intent}" needs the web journey runner (cleanup actions run after the journey)`, 'NO_HANDLER');
  const query = String(a.query ?? '');
  if (!/^[A-Za-z_][\w.-]*$/.test(query)) throw new EzTestError(`"${step.intent}": "${query}" is not a catalogue query name`, 'BAD_STEP');
  const connection = typeof a.connection === 'string' ? ctx.interpolate(a.connection) : '';
  const given = (a.binds ?? {}) as Record<string, CleanupBind>;
  const binds: Binds = Object.fromEntries(Object.entries(given).map(([k, v]) => [k, plain(bindFromStep(v, ctx))]));
  if (op === 'query') {
    const description = typeof a.description === 'string' ? ctx.interpolate(a.description) : describe(op, { ...a, connection }, binds);
    await ctx.cleanup.addQuery({ connection, query, binds, description });
    return { captured: { cleanup: description } };
  }
  if (op !== 'snapshot') throw new EzTestError(`Unknown cleanup operation "${op}"`, 'BAD_STEP');
  const restore = String(a.restore ?? '');
  if (!/^[A-Za-z_][\w.-]*$/.test(restore)) throw new EzTestError(`"${step.intent}" needs a restore query ("and restore it with "NAME"")`, 'BAD_STEP');
  // The row as it is now.
  const key = step.captureAs ?? `snapshot_${query.replace(/\W/g, '_')}`;
  const read = Step.parse({ ...step, action: 'db', args: undefined, db: { connection, sql: '', query, binds: given, capture: 'row' } satisfies DbQuery, captureAs: key });
  await dbAction(read, ctx, opts);
  const row = (ctx.ledger.get(key) ?? {}) as Record<string, unknown>;
  // The restore query gets the binds it declares: from the row (by column, any case), else the snapshot's binds.
  const declared = (await opts.db?.queryParams?.(restore)) ?? [...new Set([...Object.keys(row), ...Object.keys(binds)])];
  const lower = new Map(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
  const lowerBinds = new Map(Object.entries(binds).map(([k, v]) => [k.toLowerCase(), v]));
  const restoreBinds: Binds = {};
  for (const name of declared) {
    const l = name.toLowerCase();
    if (lower.has(l)) restoreBinds[name] = plain(lower.get(l));
    else if (lowerBinds.has(l)) restoreBinds[name] = lowerBinds.get(l)!;
  }
  const description = typeof a.description === 'string' ? ctx.interpolate(a.description) : describe(op, a, binds);
  await ctx.cleanup.addQuery({ connection, query: restore, binds: restoreBinds, description });
  return { captured: { [key]: row, cleanup: description } };
}
