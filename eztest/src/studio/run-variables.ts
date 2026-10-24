/**
 * Run-time variables a set of journeys needs and nobody supplies: `${name}` placeholders whose name is not a journey
 * variable, a config `vars:` entry, an Examples column, a parameter, or a value the journey captures itself.
 * Recorded passwords are such placeholders (`Type "${password}" into the Password field`): the Run page asks for them.
 */
import type { Journey } from '../core/index.js';
import { SECRET_VAR_NAME } from '../engine/index.js';

export interface NeededVariable {
  name: string;
  /** Looks like a password, token or key: entered masked and never stored. */
  secret: boolean;
  /** Journeys that use it. */
  journeys: string[];
}

const PLACEHOLDER = /(\$?)\$\{([A-Za-z_][\w]*)(?:\.[\w.]*)?(:-[^}]*)?\}/g;
/** Names bound by the journey itself: captures, loop items, stored responses. */
const BINDING_KEYS = new Set(['captureAs', 'storeAs', 'as', 'into', 'saveAs', 'itemAs', 'indexAs', 'rowAs']);
/** Names EZTest provides at run time. */
const BUILT_IN = new Set(['env', 'run', 'journey', 'step', 'row', 'item', 'index', 'i', 'attempt', 'browser', 'actor', 'today', 'now', 'random', 'uuid']);

function collect(v: unknown, used: Set<string>, bound: Set<string>, key?: string): void {
  if (typeof v === 'string') {
    if (key && BINDING_KEYS.has(key) && /^[A-Za-z_]\w*$/.test(v)) bound.add(v);
    for (const m of v.matchAll(PLACEHOLDER)) if (!m[1] && m[3] === undefined) used.add(m[2]);
  } else if (Array.isArray(v)) for (const x of v) collect(x, used, bound);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) collect(x, used, bound, k);
}

export function neededVariables(journeys: Journey[], configVars: Record<string, unknown>): NeededVariable[] {
  const out = new Map<string, NeededVariable>();
  for (const j of journeys) {
    const used = new Set<string>();
    const bound = new Set<string>([...Object.keys(j.variables ?? {}), ...((j as { params?: string[] }).params ?? [])]);
    for (const row of (j as { examples?: Array<Record<string, string>> }).examples ?? []) for (const k of Object.keys(row)) bound.add(k);
    collect(j.steps, used, bound);
    for (const name of used) {
      if (bound.has(name) || BUILT_IN.has(name) || configVars[name] !== undefined) continue;
      const n = out.get(name) ?? { name, secret: SECRET_VAR_NAME.test(name), journeys: [] };
      if (!n.journeys.includes(j.id)) n.journeys.push(j.id);
      out.set(name, n);
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
