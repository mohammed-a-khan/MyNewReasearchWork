/** The runner's entry point for `store` steps (shared store and data pools). */
import { EzTestError, Step } from '../core/index.js';
import { dbAction } from '../runner/data-steps.js';
import type { ActionOutcome } from '../runner/actions.js';
import type { RunOptions, StepContext } from '../runner/types.js';

export async function storeAction(step: Step, ctx: StepContext, opts: RunOptions): Promise<ActionOutcome> {
  if (!opts.store) {
    throw new EzTestError(
      `"${step.intent}" needs the shared store: run through the EZTest engine (eztest run), or pass RunOptions.store = new SharedStore({ backend: new FileStoreBackend('.eztest/store') })`,
      'NO_HANDLER',
    );
  }
  const a = (step.args ?? {}) as { op?: string; key?: string; orQuery?: { query: string; connection?: string; binds?: Record<string, string | number | boolean | null>; as: string } };
  if (a.op !== 'load' || !a.orQuery) return opts.store.perform(step, ctx);
  try {
    return await opts.store.perform(step, ctx);
  } catch (e) {
    const code = (e as EzTestError).code;
    if (code !== 'STORE_MISSING' && code !== 'STORE_EXPIRED') throw e;
    // `... or run query "ANY_OPEN_VISIT" on clinic as visit`: the query's first row instead (a value of this
    // environment that is there anyway). `visit` is the row; the load's own name gets its first column.
    const oq = a.orQuery;
    const read = Step.parse({ id: `${step.id}-query`, intent: `Run query ${oq.query}`, action: 'db', db: { connection: oq.connection ?? '', sql: '', query: oq.query, binds: oq.binds ?? {}, capture: 'row' }, captureAs: oq.as });
    let out: ActionOutcome;
    try {
      out = await dbAction(read, ctx, opts);
    } catch (qe) {
      throw new EzTestError(`${(e as Error).message.split('\n')[0]}; and query ${oq.query} found nothing either: ${(qe as Error).message.split('\n')[0]}`, 'STORE_MISSING');
    }
    const row = (ctx.ledger.get(oq.as) ?? {}) as Record<string, unknown>;
    const first = Object.values(row)[0];
    const as = step.captureAs ?? String(a.key);
    ctx.ledger.set(as, first ?? null);
    return { captured: { ...(out.captured ?? {}), [as]: first ?? null, from: `query ${oq.query}` } };
  }
}
