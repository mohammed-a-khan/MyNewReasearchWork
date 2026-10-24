/** Generic row helpers for .ez journeys (code steps receive strings; captured rows are read from the variables). */
import { codeStep } from '@mohammed-a-khan/eztest/sdk';

type Row = Record<string, unknown>;

/** The single row of a captured table (`rows` names the variable) whose `column` equals `value`. */
export const findRow = codeStep<{ rows: string; column: string; value: string }>(({ vars }, p) => {
  const rows = vars.get<Row[]>(p.rows);
  if (!Array.isArray(rows)) throw new Error(`findRow: variable "${p.rows}" is not a list of rows`);
  const hits = rows.filter((r) => String(r[p.column] ?? '') === p.value);
  if (hits.length !== 1) throw new Error(`findRow: ${hits.length} rows of ${p.rows} have ${p.column} = "${p.value}" (expected exactly 1 of ${rows.length})`);
  return hits[0];
});
