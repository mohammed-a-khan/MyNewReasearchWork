/**
 * Finding input fields on a 3270 screen the way an operator does: by the
 * label printed next to them ("USERID ===>"), by row and column, or by the
 * position recorded when the step last passed (the healing fallback).
 */
import { TerminalError, type ScreenField } from './screen.js';
import type { TerminalScreen } from '../types.js';

export interface FieldMatch {
  field: ScreenField;
  /** How the field was found. */
  via: 'label' | 'position' | 'fingerprint';
  /** Label occurrence that located it (row/col of the label text). */
  label?: { text: string; row: number; col: number };
}

/** Recorded traits of a terminal field, used to find it again when its label changes. */
export interface TerminalFieldFingerprint {
  label?: string;
  row: number;
  col: number;
  length: number;
  numeric?: boolean;
  hidden?: boolean;
}

const norm = (s: string) => s.replace(/[\s_.:=>\-]+$/g, '').replace(/^[\s_.:=>\-]+/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
const isWordChar = (c: string | undefined) => !!c && /[A-Za-z0-9]/.test(c);

/** The field containing 1-based row/col (or starting right after an attribute byte there). */
export function fieldAtRowCol(screen: TerminalScreen, row: number, col: number): ScreenField {
  const addr = screen.addressOf(row, col);
  const f = screen.fieldAt(addr) ?? screen.fields().find((x) => x.attrAddress === addr);
  if (!f) throw new TerminalError(`no field at row ${row} column ${col}${screen.formatted ? '' : ' (the screen is unformatted)'}`);
  return f;
}

/**
 * The unprotected field labelled `label`: the nearest input field to the
 * right of the label on the same row, else the nearest one below it. The label
 * must stand as whole words; two labels pointing at different fields are
 * ambiguous and fail rather than guess.
 */
export function fieldByLabel(screen: TerminalScreen, label: string): FieldMatch {
  const want = norm(label);
  if (!want) throw new TerminalError('empty field label');
  const rows = screen.textRows();
  const inputs = screen.fields().filter((f) => !f.protected && f.length > 0);
  if (!inputs.length) throw new TerminalError(`the screen has no input fields (looking for "${label}")`);
  const hits = new Map<number, FieldMatch>();
  rows.forEach((text, r) => {
    const upper = text.toUpperCase();
    for (let at = upper.indexOf(want); at >= 0; at = upper.indexOf(want, at + 1)) {
      if (isWordChar(text[at - 1]) || isWordChar(text[at + want.length])) continue;
      const addr = r * screen.cols + at;
      const inField = screen.fieldAt(addr);
      if (inField && !inField.protected) continue; // the text is typed data, not a label
      const end = addr + want.length;
      const row = r + 1;
      const right = inputs.find((f) => f.row === row && f.address >= end);
      // Below: a field on one of the next two rows that starts under the label.
      const below = right ? undefined : inputs.filter((f) => f.row > row && f.row <= row + 2 && f.col >= at - 1 && f.col <= at + want.length + 2).sort((a, b) => a.row - b.row || Math.abs(a.col - (at + 1)) - Math.abs(b.col - (at + 1)))[0];
      const f = right ?? below;
      if (f && !hits.has(f.attrAddress)) hits.set(f.attrAddress, { field: f, via: 'label', label: { text: text.slice(at, at + want.length), row, col: at + 1 } });
    }
  });
  if (!hits.size) throw new TerminalError(`no input field labelled "${label}" on the screen`);
  if (hits.size > 1) {
    const where = [...hits.values()].map((h) => `row ${h.field.row} column ${h.field.col}`).join(', ');
    throw new TerminalError(`"${label}" labels more than one input field (${where}); use "field at row R column C"`);
  }
  return [...hits.values()][0];
}

/** Fingerprint of a field (with the label text found to its left, if any). */
export function fingerprintField(screen: TerminalScreen, f: ScreenField, label?: string): TerminalFieldFingerprint {
  const left = label ?? labelLeftOf(screen, f);
  return { ...(left ? { label: left } : {}), row: f.row, col: f.col, length: f.length, ...(f.numeric ? { numeric: true } : {}), ...(f.hidden ? { hidden: true } : {}) };
}

/** Text immediately left of a field on its row (the operator-visible label). */
export function labelLeftOf(screen: TerminalScreen, f: ScreenField): string | undefined {
  const row = screen.textRows()[f.row - 1] ?? '';
  const left = row.slice(0, Math.max(0, f.col - 2));
  const m = /([A-Za-z0-9][A-Za-z0-9 /#()-]*?)[\s_.:=>\-]*$/.exec(left.replace(/\s+$/, ''));
  const t = m?.[1]?.trim();
  return t ? t.split(/\s{2,}/).pop() : undefined;
}

/**
 * Healing: the input field that best matches a stored fingerprint (same
 * length and type, nearest position). Returns undefined when nothing is close
 * enough or two candidates tie.
 */
export function fieldByFingerprint(screen: TerminalScreen, fp: TerminalFieldFingerprint): { match: FieldMatch; confidence: number } | undefined {
  const scored = screen
    .fields()
    .filter((f) => !f.protected && f.length > 0)
    .map((f) => {
      let s = 0;
      s += f.length === fp.length ? 0.4 : Math.max(0, 0.4 - Math.abs(f.length - fp.length) * 0.05);
      s += (fp.numeric ?? false) === f.numeric ? 0.1 : 0;
      s += (fp.hidden ?? false) === f.hidden ? 0.1 : 0;
      const d = Math.abs(f.row - fp.row) * 4 + Math.abs(f.col - fp.col) / 4;
      s += Math.max(0, 0.4 - d * 0.04);
      return { f, s };
    })
    .sort((a, b) => b.s - a.s);
  const [best, next] = scored;
  if (!best || best.s < 0.7) return undefined;
  if (next && best.s - next.s < 0.1) return undefined;
  return { match: { field: best.f, via: 'fingerprint' }, confidence: Math.round(best.s * 100) / 100 };
}
