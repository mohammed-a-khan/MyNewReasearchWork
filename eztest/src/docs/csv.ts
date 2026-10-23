/**
 * RFC 4180 CSV parser: quoted fields, escaped quotes (""), CRLF/LF/CR line
 * breaks, line breaks inside quoted fields, optional BOM, custom delimiter.
 * Malformed input (stray quote, unterminated quote, ragged rows, duplicate
 * headers) is an error, never silently repaired.
 */
import { EzTestError } from '../core/index.js';

export interface CsvOptions {
  delimiter?: string;
  /** Treat the first record as a header row (default true). */
  header?: boolean;
  /** Allow records with a different number of fields than the header (default false). */
  relaxColumnCount?: boolean;
  /** Skip records whose fields are all empty (default true). */
  skipEmptyLines?: boolean;
}

export interface CsvTable {
  headers: string[];
  rows: Array<Record<string, string>>;
}

/** Parse CSV text into records (arrays of fields). */
export function parseCsvRecords(text: string, opts: Pick<CsvOptions, 'delimiter' | 'skipEmptyLines'> = {}): string[][] {
  const delim = opts.delimiter ?? ',';
  if (delim.length !== 1 || delim === '"' || delim === '\n' || delim === '\r') {
    throw new EzTestError(`Invalid CSV delimiter ${JSON.stringify(delim)}`, 'CSV_INVALID');
  }
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let i = 0;
  let line = 1;
  let quoted = false;
  let fieldStarted = false;
  const endField = () => {
    record.push(field);
    field = '';
    quoted = false;
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        // closing quote: next must be delimiter, line break or end
        const n = s[i + 1];
        if (n !== undefined && n !== delim && n !== '\n' && n !== '\r') {
          throw new EzTestError(`CSV line ${line}: unexpected character after closing quote`, 'CSV_INVALID', { line });
        }
        quoted = false;
        fieldStarted = true;
        i += 1;
        // mark that this field was quoted and closed; following chars are separators
        if (n === undefined) break;
        continue;
      }
      if (c === '\n') line++;
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      if (field !== '' || fieldStarted) {
        throw new EzTestError(`CSV line ${line}: quote inside an unquoted field`, 'CSV_INVALID', { line });
      }
      quoted = true;
      i += 1;
      continue;
    }
    if (c === delim) {
      endField();
      i += 1;
      continue;
    }
    if (c === '\r' || c === '\n') {
      endRecord();
      i += c === '\r' && s[i + 1] === '\n' ? 2 : 1;
      line++;
      continue;
    }
    field += c;
    i += 1;
  }
  if (quoted) throw new EzTestError(`CSV line ${line}: unterminated quoted field`, 'CSV_INVALID', { line });
  // Final record (no trailing newline) unless the input ended right after a line break.
  if (field !== '' || record.length > 0 || fieldStarted) endRecord();
  const skip = opts.skipEmptyLines ?? true;
  return skip ? records.filter((r) => !(r.length === 1 && r[0] === '')) : records;
}

/** Parse CSV text into header + row objects. */
export function parseCsv(text: string, opts: CsvOptions = {}): CsvTable {
  const records = parseCsvRecords(text, opts);
  if (opts.header === false) {
    const width = Math.max(0, ...records.map((r) => r.length));
    const headers = Array.from({ length: width }, (_, i) => `col${i + 1}`);
    return { headers, rows: records.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))) };
  }
  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0].map((h) => h.trim());
  const dup = headers.find((h, i) => headers.indexOf(h) !== i);
  if (dup !== undefined) throw new EzTestError(`CSV header "${dup}" appears more than once`, 'CSV_INVALID');
  if (headers.some((h) => h === '')) throw new EzTestError('CSV header contains an empty column name', 'CSV_INVALID');
  const rows: Array<Record<string, string>> = [];
  records.slice(1).forEach((r, idx) => {
    if (r.length !== headers.length && !opts.relaxColumnCount) {
      throw new EzTestError(`CSV record ${idx + 2} has ${r.length} fields, header has ${headers.length}`, 'CSV_INVALID', { record: idx + 2 });
    }
    rows.push(Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
  });
  return { headers, rows };
}
