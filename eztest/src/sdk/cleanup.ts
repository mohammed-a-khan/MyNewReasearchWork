/**
 * `cleanup`: actions that undo what a journey or scenario did, run in reverse after it (also when it
 * failed), each reported as a cleanup step.
 *
 * ```ts
 * cleanup.add('cancel the visit', async () => { await api.delete(`/api/visits/${id}`); });
 * await cleanup.query('DELETE_VISIT', { visit_id: id }, { connection: 'clinic' });
 * await cleanup.snapshot('PET_ROW', { pet_id: petId }, { restore: 'RESTORE_PET' });
 * ```
 *
 * Query actions are journaled with their values before the journey goes on, so the next run's orphan
 * sweep runs them when this run crashes. A code action (`add`) runs only in this run.
 */
import { callSite } from './callsite.js';
import type { BindValue } from './db.js';
import { literal, run } from './internal.js';
import { currentHost } from './runtime.js';

export interface CleanupQueryOptions {
  /** Connection alias (default: the query's `-- connection:` header). */
  connection?: string;
  /** Text of the cleanup step (default: generated from the query and its values). */
  description?: string;
}

export interface CleanupSnapshotOptions extends CleanupQueryOptions {
  /** Catalogue query run afterwards with the snapshot row's values (and these binds) for its `:binds`. */
  restore: string;
}

const binds = (b: Record<string, BindValue> | undefined) => Object.fromEntries(Object.entries(b ?? {}).map(([k, v]) => [k, typeof v === 'string' ? literal(v) : v]));

export const cleanup = {
  /** A code action: its SDK calls (ui, api, db ...) become the cleanup step's children. */
  add(description: string, fn: () => Promise<unknown> | unknown): void {
    if (typeof description !== 'string' || !description.trim()) throw new TypeError('cleanup.add needs a description');
    if (typeof fn !== 'function') throw new TypeError('cleanup.add needs a function');
    const host = currentHost('cleanup.add');
    if (!host.addCleanup) throw new TypeError('cleanup.add needs EZTest\'s web journey runner');
    host.addCleanup(description, async () => fn());
  },
  /** Run a catalogue query after the journey, with these values (resolved now). */
  async query(name: string, params: Record<string, BindValue> = {}, o: CleanupQueryOptions = {}): Promise<void> {
    await run({
      intent: `On cleanup run query ${name}${o.connection ? ` on ${o.connection}` : ''}`, action: 'cleanup',
      args: { op: 'query', query: name, ...(o.connection ? { connection: literal(o.connection) } : {}), binds: binds(params), ...(o.description ? { description: literal(o.description) } : {}) },
    }, { source: callSite() });
  },
  /** Read the query's first row now; after the journey run `restore` with the row's values. Returns the row. */
  async snapshot<T extends object = Record<string, unknown>>(name: string, params: Record<string, BindValue>, o: CleanupSnapshotOptions): Promise<T> {
    if (!o?.restore) throw new TypeError('cleanup.snapshot needs { restore: "RESTORE_QUERY" }');
    const key = `snapshot_${name.replace(/\W/g, '_')}`;
    const r = await run({
      intent: `Snapshot query ${name}${o.connection ? ` on ${o.connection}` : ''} and restore it with ${o.restore} after the journey`, action: 'cleanup', captureAs: key,
      args: { op: 'snapshot', query: name, restore: o.restore, ...(o.connection ? { connection: literal(o.connection) } : {}), binds: binds(params), ...(o.description ? { description: literal(o.description) } : {}) },
    }, { source: callSite() });
    return (r.captured?.[key] ?? {}) as T;
  },
};

export type CleanupSurface = typeof cleanup;
