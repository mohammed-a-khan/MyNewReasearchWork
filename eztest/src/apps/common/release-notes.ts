/**
 * Vendor release notes / feature lists as AppChanges (Workday "What's New",
 * Oracle quarterly-update feature lists), one row per change:
 * Change_Type (Field Renamed | Field Required | Field Removed | Value Retired |
 * Task Retired | Page Retired | anything else = UI change), the objects it
 * affects (semicolon-separated), Field, New_Value, Description.
 */
import type { AppChange } from './impact.js';
import { normalizeLabel, type PackId } from './kit.js';

export function releaseNoteChanges(
  pack: PackId,
  rows: Array<Record<string, string>>,
  release: string,
  o: { objectColumn: string; objectPrefix: string; sourceLabel: string },
): AppChange[] {
  const out: AppChange[] = [];
  for (const r of rows) {
    const objs = (r[o.objectColumn] ?? '').split(/\s*;\s*/).filter(Boolean);
    const type = normalizeLabel(r.Change_Type ?? '');
    const source = `${o.sourceLabel}: ${r.Feature ?? r.Change_Type}`;
    for (const obj of objs) {
      const base = { pack, object: `${o.objectPrefix}${obj}`, objectNames: [obj, `${o.objectPrefix}${obj}`], source };
      const field = r.Field?.trim();
      if (type === 'field renamed' && field) out.push({ ...base, kind: 'field-relabeled', field, fieldNames: [field, r.New_Value].filter(Boolean), breakingNames: [field], severity: 'breaking', detail: `${obj}: "${field}" is renamed "${r.New_Value}" in ${release}` });
      else if (type === 'field required' && field) out.push({ ...base, kind: 'field-required', field, fieldNames: [field], severity: 'breaking', detail: `${obj}: "${field}" becomes required in ${release}` });
      else if (type === 'field removed' && field) out.push({ ...base, kind: 'field-removed', field, fieldNames: [field], severity: 'breaking', detail: `${obj}: "${field}" is removed in ${release}` });
      else if (type === 'value retired' && field) out.push({ ...base, kind: 'values-removed', field, fieldNames: [field], values: [r.New_Value].filter(Boolean), severity: 'breaking', detail: `${obj}: "${r.New_Value}" is retired from "${field}" in ${release}` });
      else if (type === 'task retired' || type === 'page retired') out.push({ ...base, kind: 'object-removed', severity: 'breaking', detail: `${obj} is retired in ${release}` });
      else out.push({ ...base, kind: 'ui-changed', severity: 'review', detail: `${obj}: ${r.Description || r.Feature} (${release})` });
    }
  }
  return out;
}

/** Parse a CSV export (header row, comma separated, double-quoted cells with "" escapes). */
export function parseCsvRows(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let cur: string[] = [];
  let cell = '';
  let q = false;
  const endRow = () => {
    cur.push(cell);
    cell = '';
    if (cur.some((x) => x.trim())) rows.push(cur);
    cur = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      cur.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else cell += c;
  }
  endRow();
  const [head, ...data] = rows;
  return data.map((r) => Object.fromEntries((head ?? []).map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}
