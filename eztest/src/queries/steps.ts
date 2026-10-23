/**
 * Query references in journeys, for `eztest validate`: every step that runs a
 * catalogue query must name an existing query, supply its required params,
 * use no unknown params, and target a configured connection.
 */
import type { Journey, Step } from '../core/index.js';
import type { QueryCatalogue } from './catalogue.js';

export interface QueryRef {
  stepId: string;
  intent: string;
  name: string;
  connection: string;
  binds: string[];
  positional: number;
}

function walk(steps: Step[] | undefined, out: QueryRef[]): void {
  for (const s of steps ?? []) {
    if (s.action === 'db' && s.db?.query) {
      out.push({ stepId: s.id, intent: s.intent, name: s.db.query, connection: s.db.connection, binds: Object.keys(s.db.binds ?? {}), positional: s.db.params?.length ?? 0 });
    }
    walk(s.steps, out);
    walk(s.else, out);
    walk(s.catch, out);
  }
}

export function queryRefs(journey: Journey): QueryRef[] {
  const out: QueryRef[] = [];
  walk(journey.steps, out);
  return out;
}

/** Problems with the catalogue queries a journey uses (empty when all is well). */
export function validateQueryRefs(journey: Journey, cat: QueryCatalogue, connections: string[]): string[] {
  const out: string[] = [];
  for (const r of queryRefs(journey)) {
    const where = `step "${r.intent}"`;
    const problems = cat.checkCall(r.name, r.binds, r.positional);
    for (const p of problems) out.push(`${where}: ${p}`);
    if (problems.length && !cat.has(r.name)) continue;
    const conn = r.connection || cat.get(r.name).connection;
    if (!conn) out.push(`${where}: query "${r.name}" has no connection (add "on <alias>" or a "-- connection:" header)`);
    else if (!connections.includes(conn)) out.push(`${where}: unknown connection "${conn}" (db.connections: ${connections.join(', ') || 'none'})`);
  }
  return out;
}
