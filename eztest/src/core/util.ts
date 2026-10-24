import type { Logger, LogLevel } from './contracts.js';

/** Thrown when a feature or option is requested that EZTest does not implement. Never a silent no-op. */
export class NotSupportedError extends Error {
  constructor(what: string) {
    super(`Not supported: ${what}`);
    this.name = 'NotSupportedError';
  }
}

export class EzTestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'EzTestError';
  }
}

/**
 * Replace ${name} and ${name:-default} placeholders. Unknown names are left
 * intact unless `strict` is set, in which case they throw. `$${name}` is an
 * escape that yields a literal `${name}` (e.g. a config value that refers to a
 * value only known at run time).
 */
export function interpolate(
  template: string,
  vars: Record<string, unknown>,
  opts: { strict?: boolean } = {},
): string {
  return template.replace(/(\$?)\$\{([A-Za-z_][\w.]*)(?::-([^}]*))?\}/g, (whole, esc: string, name: string, def?: string) => {
    if (esc) return whole.slice(1);
    const v = lookup(vars, name);
    if (v !== undefined && v !== null) return String(v);
    if (def !== undefined) return def;
    if (opts.strict) throw new EzTestError(`Unknown variable \${${name}}`, 'UNKNOWN_VARIABLE', { name });
    return whole;
  });
}

/**
 * Variables whose values refer to other variables (`Variables: last=Okafor${tag}` with `tag` from the config or
 * the run) resolved against each other and `scope`, a few passes deep. References that nothing sets stay as
 * written, so the step that uses them still reports the missing variable.
 */
export function resolveVariableRefs(vars: Record<string, unknown>, scope: Record<string, unknown> = {}): Record<string, unknown> {
  let out: Record<string, unknown> = { ...vars };
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    const all = { ...scope, ...out };
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out)) {
      if (typeof v === 'string' && v.includes('${')) {
        // A value never refers to itself (x=${x}): that reference is left for the run-time lookup.
        const r = interpolate(v, { ...all, [k]: undefined });
        if (r !== v) changed = true;
        next[k] = r;
      } else next[k] = v;
    }
    out = next;
    if (!changed) break;
  }
  return out;
}

/** Names of `${name}` placeholders (not escaped, no `:-default`) that `vars` has no value for. */
export function unresolvedNames(template: string, vars: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(/(\$?)\$\{([A-Za-z_][\w.]*)(:-[^}]*)?\}/g)) {
    if (m[1] || m[3] !== undefined) continue;
    const v = lookup(vars, m[2]);
    if ((v === undefined || v === null) && !out.includes(m[2])) out.push(m[2]);
  }
  return out;
}

function lookup(vars: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = vars;
  for (const part of dotted.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createConsoleLogger(level: LogLevel = 'info', mask: (s: string) => string = (s) => s): Logger {
  const min = LEVELS[level];
  const out = (lvl: LogLevel, msg: string, data?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    const line = data ? `${msg} ${JSON.stringify(data)}` : msg;
    const text = `[eztest] ${lvl.toUpperCase()} ${mask(line)}`;
    if (lvl === 'error') console.error(text);
    else if (lvl === 'warn') console.warn(text);
    else console.log(text);
  };
  return {
    debug: (m, d) => out('debug', m, d),
    info: (m, d) => out('info', m, d),
    warn: (m, d) => out('warn', m, d),
    error: (m, d) => out('error', m, d),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
