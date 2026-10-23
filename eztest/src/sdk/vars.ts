/**
 * `vars`: the journey's variables and ledger. Values set here are visible to
 * `.ez` steps (as `${name}`), to `Run journey` callers (Returns) and in the
 * run results (masked).
 */
import { interpolate } from '../core/util.js';
import { currentHost } from './runtime.js';

export const vars = {
  /** A variable (dotted paths read into objects: "order.id"). */
  get<T = unknown>(key: string): T {
    return currentHost('vars.get').getVar(key) as T;
  },
  /** A variable as a string ('' when unset). */
  text(key: string): string {
    const v = currentHost('vars.text').getVar(key);
    return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  },
  set(key: string, value: unknown): void {
    currentHost('vars.set').setVar(key, value);
  },
  has(key: string): boolean {
    return currentHost('vars.has').getVar(key) !== undefined;
  },
  delete(key: string): void {
    currentHost('vars.delete').deleteVar(key);
  },
  /** Every variable (journey < run < Examples row < ledger). */
  all(): Record<string, unknown> {
    return { ...currentHost('vars.all').vars() };
  },
  /** The Examples row of a data-driven journey ({} otherwise). */
  row(): Record<string, string> {
    return currentHost('vars.row').row();
  },
  /**
   * Replace placeholders in a text with variables (unknown names stay as written):
   * `${name}`, and the placeholder forms `{scenario:name}`, `{context:row.col}`, `{config:KEY}`,
   * `{env:KEY}`, `{{name}}`, `{{config:KEY}}`, `{{env:KEY}}` (handy for migrated code).
   */
  resolve(text: string): string {
    const all = currentHost('vars.resolve').vars();
    const look = (kind: string | undefined, name: string): string | undefined => {
      const key = name.trim();
      if (kind === 'env') return process.env[key];
      if (kind === 'config') return configValue(all, key);
      const v = lookup(all, key);
      return v === undefined || v === null ? undefined : typeof v === 'object' ? JSON.stringify(v) : String(v);
    };
    const braced = String(text)
      .replace(/\{\{\s*(?:(config|env|scenario|context|var)\s*:)?\s*([A-Za-z_][\w.-]*)\s*\}\}/g, (w, k: string | undefined, n: string) => look(k, n) ?? w)
      .replace(/\{(config|env|scenario|context|var)\s*:\s*([A-Za-z_][\w.-]*)\s*\}/g, (w, k: string, n: string) => look(k, n) ?? w);
    return interpolate(braced, all);
  },
  /** A configuration value: run variables (config `vars`, --var), then the environment; else the fallback. */
  config: config as {
    (key: string): string | undefined;
    (key: string, fallback: string): string;
  },
};

function config(key: string, fallback?: string): string | undefined {
  return configValue(currentHost('vars.config').vars(), key) ?? fallback;
}

function lookup(all: Record<string, unknown>, dotted: string): unknown {
  if (dotted in all) return all[dotted];
  let cur: unknown = all;
  for (const part of dotted.split('.')) {
    if (cur && typeof cur === 'object') {
      const o = cur as Record<string, unknown>;
      const k = part in o ? part : Object.keys(o).find((x) => x.toLowerCase() === part.toLowerCase());
      if (k === undefined) return undefined;
      cur = o[k];
    } else return undefined;
  }
  return cur;
}

function configValue(all: Record<string, unknown>, key: string): string | undefined {
  const v = all[key] ?? process.env[key];
  return v === undefined || v === null ? undefined : String(v);
}

export type Vars = typeof vars;
