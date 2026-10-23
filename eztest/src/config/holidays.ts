/**
 * Holiday calendars for the business-day functions (config `dates.holidays`):
 * an inline list of YYYY-MM-DD dates, or a file holding a YAML/JSON list (or
 * `{ holidays: [...] }`, or entries `{ date: YYYY-MM-DD, name: ... }`), or plain
 * text / CSV with one date per line (anything after the date is ignored).
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { EzTestError } from '../core/index.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function fromValue(v: unknown, file: string): string[] {
  const list = Array.isArray(v) ? v : v && typeof v === 'object' && Array.isArray((v as { holidays?: unknown }).holidays) ? (v as { holidays: unknown[] }).holidays : undefined;
  if (!list) throw new EzTestError(`${file}: expected a list of dates (or { holidays: [...] })`, 'HOLIDAYS_INVALID');
  return list.map((x, i) => {
    const d = typeof x === 'string' ? x : x instanceof Date ? x.toISOString().slice(0, 10) : x && typeof x === 'object' ? String((x as { date?: unknown }).date ?? '') : String(x);
    if (!DATE.test(d)) throw new EzTestError(`${file}: entry ${i + 1} is not a YYYY-MM-DD date`, 'HOLIDAYS_INVALID');
    return d;
  });
}

/** Parse holiday file text by extension. */
export function parseHolidays(text: string, file = 'holidays'): string[] {
  if (/\.(?:ya?ml|json)$/i.test(file)) {
    let v: unknown;
    try {
      v = /\.json$/i.test(file) ? JSON.parse(text) : parseYaml(text);
    } catch (e) {
      throw new EzTestError(`${file}: ${(e as Error).message}`, 'HOLIDAYS_INVALID');
    }
    return fromValue(v, file);
  }
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^"?(\d{4}-\d{2}-\d{2})"?/.exec(t);
    if (m) out.push(m[1]);
    else if (!/^date\b/i.test(t)) throw new EzTestError(`${file}: line "${t.slice(0, 40)}" does not start with a YYYY-MM-DD date`, 'HOLIDAYS_INVALID');
  }
  return out;
}

/** Resolve config `dates.holidays` to a sorted, de-duplicated list of dates. */
export async function loadHolidays(spec: string | string[] | undefined, cwd = process.cwd()): Promise<string[]> {
  if (spec === undefined) return [];
  if (Array.isArray(spec)) return [...new Set(spec)].sort();
  const file = isAbsolute(spec) ? spec : resolve(cwd, spec);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new EzTestError(`Holiday calendar not found: ${file}`, 'HOLIDAYS_MISSING');
  }
  return [...new Set(parseHolidays(text, file))].sort();
}
