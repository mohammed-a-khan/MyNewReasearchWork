/**
 * Semantic PDF <-> PDF diff and bulk regression.
 *
 * diffPdfs compares metadata, page count, fields (template or auto-detected
 * "Label: value" pairs), table rows by key and the text layer (LCS line diff).
 * Masks (regexes for dates, ids, ...) hide volatile parts; a line that differs
 * only inside masked parts is reported as a "masked" change, which does not
 * count as a real difference.
 *
 * bulkCompare pairs files by name across two folders, diffs each pair and
 * clusters the changes by a pattern signature (numbers, dates and ids
 * normalized) so "312 documents: footer date changed (masked)" is one line.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { NotSupportedError } from '../core/index.js';
import type { BBox, CanonicalDocument, DocField, DocMetadata, DocTable, Line } from './model.js';
import { formatNormalized, valuesEqual, type NumberLocale } from './normalize.js';
import { autoFields } from './fields.js';
import { loadDocument, type PdfInput } from './extract.js';
import { applyTemplate, parseTemplate, type DocTemplate, type DocTemplateInput } from './template.js';

export interface Mask {
  pattern: string | RegExp;
  /** Placeholder label, e.g. "date" -> ‹date›. */
  label?: string;
}

export type MaskInput = string | RegExp | Mask;

/** Ready-made masks for common volatile values. */
export const COMMON_MASKS: Record<string, Mask> = {
  isoDateTime: { pattern: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/, label: 'datetime' },
  isoDate: { pattern: /\b\d{4}-\d{2}-\d{2}\b/, label: 'date' },
  numericDate: { pattern: /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/, label: 'date' },
  time: { pattern: /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\b/i, label: 'time' },
  uuid: { pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, label: 'uuid' },
};

export type ChangeCategory =
  | 'extraction'
  | 'metadata'
  | 'page-count'
  | 'field-changed'
  | 'field-added'
  | 'field-removed'
  | 'row-added'
  | 'row-removed'
  | 'row-changed'
  | 'text-changed'
  | 'text-added'
  | 'text-removed'
  | 'masked';

export const CHANGE_CATEGORIES: ChangeCategory[] = [
  'extraction',
  'page-count',
  'metadata',
  'field-changed',
  'field-added',
  'field-removed',
  'row-changed',
  'row-added',
  'row-removed',
  'text-changed',
  'text-added',
  'text-removed',
  'masked',
];

export interface DocChange {
  category: ChangeCategory;
  /** What changed, without values (safe to show when values are masked). */
  subject: string;
  before?: string;
  after?: string;
  page?: number;
  /** Full description, e.g. 'Total: 1,200.00 → 1,250.00'. */
  description: string;
}

export interface DiffOptions {
  masks?: MaskInput[];
  /** Template applied to both documents (fields/tables). Without it, "Label: value" fields are auto-detected. */
  template?: DocTemplate | DocTemplateInput | string;
  /** Table name -> key column(s); default: first column. */
  tableKeys?: Record<string, string | string[]>;
  /** Metadata keys not compared. Default: creationDate, modDate. */
  ignoreMetadata?: Array<keyof DocMetadata>;
  locale?: NumberLocale;
  dateFormats?: string[];
  /** Skip the line-level text diff. */
  skipText?: boolean;
  /** Max LCS matrix cells after trimming common prefix/suffix (default 25M). */
  maxLcsCells?: number;
}

export interface PdfDiffResult {
  kind: 'pdf-diff';
  a: string;
  b: string;
  /** True when there is no change other than masked ones. */
  identical: boolean;
  changes: DocChange[];
  summary: Record<ChangeCategory, number>;
}

interface CompiledMask {
  re: RegExp;
  label: string;
}

export function compileMasks(masks: MaskInput[] = []): CompiledMask[] {
  return masks.map((m) => {
    const mm: Mask = typeof m === 'string' || m instanceof RegExp ? { pattern: m } : m;
    const src = mm.pattern instanceof RegExp ? mm.pattern.source : mm.pattern;
    const flags = mm.pattern instanceof RegExp ? mm.pattern.flags.replace(/[gy]/g, '') : '';
    return { re: new RegExp(src, flags + 'g'), label: mm.label ?? 'masked' };
  });
}

export function applyMasks(text: string, masks: CompiledMask[]): string {
  let t = text;
  for (const m of masks) t = t.replace(m.re, `‹${m.label}›`);
  return t;
}

// ----------------------------------------------------------------- LCS

type Op = { op: 'eq'; i: number; j: number } | { op: 'del'; i: number } | { op: 'ins'; j: number };

/** Line diff via LCS (common prefix/suffix trimmed first). */
export function diffSequences(a: string[], b: string[], maxCells = 25_000_000): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  if ((n + 1) * (m + 1) > maxCells) {
    throw new NotSupportedError(`text diff of ${n}x${m} changed lines (raise maxLcsCells or use skipText)`);
  }
  const W = m + 1;
  const dp = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = A[i] === B[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const ops: Op[] = [];
  for (let k = 0; k < pre; k++) ops.push({ op: 'eq', i: k, j: k });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      ops.push({ op: 'eq', i: i + pre, j: j + pre });
      i++;
      j++;
    } else if (j < m && (i === n || dp[i * W + j + 1] >= dp[(i + 1) * W + j])) {
      ops.push({ op: 'ins', j: j + pre });
      j++;
    } else {
      ops.push({ op: 'del', i: i + pre });
      i++;
    }
  }
  for (let k = 0; k < suf; k++) ops.push({ op: 'eq', i: a.length - suf + k, j: b.length - suf + k });
  return ops;
}

// ----------------------------------------------------------------- diff

function prepare(doc: CanonicalDocument, opts: DiffOptions): { fields: DocField[]; tables: DocTable[] } {
  if (opts.template !== undefined) {
    const tpl = typeof opts.template === 'string' ? parseTemplate(opts.template) : opts.template;
    if (doc.fields.length === 0 && doc.tables.length === 0) {
      const copy: CanonicalDocument = { ...doc, fields: [], tables: [], findings: [...doc.findings] };
      applyTemplate(copy, tpl, { locale: opts.locale, dateFormats: opts.dateFormats });
      return { fields: copy.fields, tables: copy.tables };
    }
  }
  if (doc.fields.length || doc.tables.length) return { fields: doc.fields, tables: doc.tables };
  return { fields: autoFields(doc, { locale: opts.locale, dateFormats: opts.dateFormats }), tables: [] };
}

function q(s: unknown): string {
  return JSON.stringify(s === undefined ? null : s);
}

function lineHolds(line: Line, page: number | undefined, bbox: BBox | undefined): boolean {
  if (!bbox || page !== line.page) return false;
  const cy = bbox.y + bbox.height / 2;
  return cy >= line.bbox.y - 1 && cy <= line.bbox.y + line.bbox.height + 1;
}

/** Semantic diff of two documents. */
export async function diffPdfs(
  aIn: CanonicalDocument | PdfInput,
  bIn: CanonicalDocument | PdfInput,
  opts: DiffOptions = {},
): Promise<PdfDiffResult> {
  const a = await loadDocument(aIn, { locale: opts.locale, dateFormats: opts.dateFormats });
  const b = await loadDocument(bIn, { locale: opts.locale, dateFormats: opts.dateFormats });
  const masks = compileMasks(opts.masks);
  const changes: DocChange[] = [];
  const add = (c: DocChange) => changes.push(c);
  const consumedA = new Set<string>();
  const consumedB = new Set<string>();
  const linesA = a.pages.flatMap((p) => p.lines);
  const linesB = b.pages.flatMap((p) => p.lines);
  const consume = (side: 'a' | 'b', page: number | undefined, bbox: BBox | undefined) => {
    const lines = side === 'a' ? linesA : linesB;
    const set = side === 'a' ? consumedA : consumedB;
    for (const l of lines) if (lineHolds(l, page, bbox)) set.add(`${l.page}:${l.index}`);
  };

  for (const [doc, label] of [[a, 'A'], [b, 'B']] as const) {
    if (doc.pages.every((p) => p.lines.length === 0)) {
      add({ category: 'extraction', subject: `Document ${label} has no text layer`, description: `Document ${label} (${doc.source}) has no extractable text` });
    }
  }

  // Page count & metadata
  if (a.metadata.pageCount !== b.metadata.pageCount) {
    add({ category: 'page-count', subject: 'Page count', before: String(a.metadata.pageCount), after: String(b.metadata.pageCount), description: `Page count: ${a.metadata.pageCount} → ${b.metadata.pageCount}` });
  }
  const ignore = new Set<string>(opts.ignoreMetadata ?? ['creationDate', 'modDate']);
  const metaKeys: Array<keyof DocMetadata> = ['title', 'author', 'subject', 'keywords', 'creator', 'producer', 'creationDate', 'modDate', 'pdfVersion', 'encrypted'];
  for (const k of metaKeys) {
    if (ignore.has(k)) continue;
    const va = a.metadata[k];
    const vb = b.metadata[k];
    if (q(va) !== q(vb)) {
      const ma = va === undefined ? undefined : applyMasks(String(va), masks);
      const mb = vb === undefined ? undefined : applyMasks(String(vb), masks);
      if (ma !== undefined && ma === mb) {
        add({ category: 'masked', subject: `Metadata ${k} (masked)`, before: String(va), after: String(vb), description: `Metadata ${k} changed only in masked parts: ${ma}` });
      } else {
        add({ category: 'metadata', subject: `Metadata ${k}`, before: va === undefined ? undefined : String(va), after: vb === undefined ? undefined : String(vb), description: `Metadata ${k}: ${q(va)} → ${q(vb)}` });
      }
    }
  }
  const sizeA = a.metadata.pageSizes.map((s) => `${s.width}x${s.height}`).join(',');
  const sizeB = b.metadata.pageSizes.map((s) => `${s.width}x${s.height}`).join(',');
  if (sizeA !== sizeB && a.metadata.pageCount === b.metadata.pageCount) {
    add({ category: 'metadata', subject: 'Page sizes', before: sizeA, after: sizeB, description: `Page sizes: ${sizeA} → ${sizeB}` });
  }

  // Fields
  const pa = prepare(a, opts);
  const pb = prepare(b, opts);
  const fb = new Map(pb.fields.map((f) => [f.name, f]));
  const fa = new Map(pa.fields.map((f) => [f.name, f]));
  for (const f of pa.fields) {
    const g = fb.get(f.name);
    if (!g) {
      add({ category: 'field-removed', subject: `Field "${f.name}"`, before: f.value.raw, page: f.value.page, description: `Field removed: ${f.name}: ${f.value.raw}` });
      consume('a', f.value.page, f.value.bbox);
      continue;
    }
    if (valuesEqual(f.value.normalized, g.value.normalized)) continue;
    const ma = applyMasks(f.value.raw, masks);
    const mb = applyMasks(g.value.raw, masks);
    if (ma === mb) {
      add({ category: 'masked', subject: `Field "${f.name}" (masked)`, before: f.value.raw, after: g.value.raw, page: g.value.page, description: `Field ${f.name} changed only in masked parts: ${ma}` });
    } else {
      add({ category: 'field-changed', subject: `Field "${f.name}"`, before: f.value.raw, after: g.value.raw, page: g.value.page, description: `${f.name}: ${f.value.raw} → ${g.value.raw}` });
    }
    consume('a', f.value.page, f.value.bbox);
    consume('b', g.value.page, g.value.bbox);
  }
  for (const g of pb.fields) {
    if (fa.has(g.name)) continue;
    add({ category: 'field-added', subject: `Field "${g.name}"`, after: g.value.raw, page: g.value.page, description: `Field added: ${g.name}: ${g.value.raw}` });
    consume('b', g.value.page, g.value.bbox);
  }

  // Tables
  for (const ta of pa.tables) {
    const tb = pb.tables.find((t) => t.name === ta.name);
    if (!tb) continue;
    const keyCols = (() => {
      const k = opts.tableKeys?.[ta.name];
      return k === undefined ? [ta.columns[0]] : Array.isArray(k) ? k : [k];
    })();
    const keyOf = (r: DocTable['rows'][number]) =>
      r.kind !== 'data' ? `‹${r.kind}›` : keyCols.map((k) => (r.cells[k] ? formatNormalized(r.cells[k].normalized) : '')).join('|');
    const rowsB = new Map(tb.rows.map((r) => [keyOf(r), r]));
    const rowsA = new Map(ta.rows.map((r) => [keyOf(r), r]));
    const cols = [...new Set([...ta.columns, ...tb.columns])];
    for (const [k, ra] of rowsA) {
      const rb = rowsB.get(k);
      const anyCell = Object.values(ra.cells)[0];
      if (!rb) {
        add({ category: 'row-removed', subject: `Table "${ta.name}" row`, before: k, page: ra.page, description: `${ta.name}: row ${k} removed` });
        if (anyCell) consume('a', anyCell.page, anyCell.bbox);
        continue;
      }
      for (const c of cols) {
        const ca = ra.cells[c];
        const cb = rb.cells[c];
        if (ca && cb && valuesEqual(ca.normalized, cb.normalized)) continue;
        if (!ca && !cb) continue;
        const before = ca?.raw ?? '';
        const after = cb?.raw ?? '';
        const masked = applyMasks(before, masks) === applyMasks(after, masks);
        add({
          category: masked ? 'masked' : 'row-changed',
          subject: `Table "${ta.name}" row ${k} column "${c}"`,
          before,
          after,
          page: cb?.page ?? rb.page,
          description: masked ? `${ta.name}[${k}].${c} changed only in masked parts` : `${ta.name}[${k}].${c}: ${before} → ${after}`,
        });
        if (ca) consume('a', ca.page, ca.bbox);
        if (cb) consume('b', cb.page, cb.bbox);
      }
    }
    for (const [k, rb] of rowsB) {
      if (rowsA.has(k)) continue;
      add({ category: 'row-added', subject: `Table "${ta.name}" row`, after: k, page: rb.page, description: `${ta.name}: row ${k} added` });
      const anyCell = Object.values(rb.cells)[0];
      if (anyCell) consume('b', anyCell.page, anyCell.bbox);
    }
  }

  // Text lines
  if (!opts.skipText) {
    const ma = linesA.map((l) => applyMasks(l.text, masks));
    const mb = linesB.map((l) => applyMasks(l.text, masks));
    const ops = diffSequences(ma, mb, opts.maxLcsCells);
    const isConsumedA = (i: number) => consumedA.has(`${linesA[i].page}:${linesA[i].index}`);
    const isConsumedB = (j: number) => consumedB.has(`${linesB[j].page}:${linesB[j].index}`);
    let dels: number[] = [];
    let ins: number[] = [];
    const flush = () => {
      const n = Math.min(dels.length, ins.length);
      for (let k = 0; k < n; k++) {
        const la = linesA[dels[k]];
        const lb = linesB[ins[k]];
        if (isConsumedA(dels[k]) && isConsumedB(ins[k])) continue;
        add({ category: 'text-changed', subject: `Line on page ${lb.page}`, before: la.text, after: lb.text, page: lb.page, description: `Line changed: ${q(la.text)} → ${q(lb.text)}` });
      }
      for (const i of dels.slice(n)) {
        if (isConsumedA(i)) continue;
        add({ category: 'text-removed', subject: `Line on page ${linesA[i].page}`, before: linesA[i].text, page: linesA[i].page, description: `Line removed: ${q(linesA[i].text)}` });
      }
      for (const j of ins.slice(n)) {
        if (isConsumedB(j)) continue;
        add({ category: 'text-added', subject: `Line on page ${linesB[j].page}`, after: linesB[j].text, page: linesB[j].page, description: `Line added: ${q(linesB[j].text)}` });
      }
      dels = [];
      ins = [];
    };
    for (const op of ops) {
      if (op.op === 'del') dels.push(op.i);
      else if (op.op === 'ins') ins.push(op.j);
      else {
        flush();
        const la = linesA[op.i];
        const lb = linesB[op.j];
        if (la.text !== lb.text && !isConsumedA(op.i) && !isConsumedB(op.j)) {
          add({ category: 'masked', subject: `Line on page ${lb.page} (masked)`, before: la.text, after: lb.text, page: lb.page, description: `Line changed only in masked parts: ${q(ma[op.i])}` });
        }
      }
    }
    flush();
  }

  const summary = Object.fromEntries(CHANGE_CATEGORIES.map((c) => [c, 0])) as Record<ChangeCategory, number>;
  for (const c of changes) summary[c.category]++;
  const order = (c: DocChange) => CHANGE_CATEGORIES.indexOf(c.category);
  const sorted = changes
    .map((c, i) => ({ c, i }))
    .sort((x, y) => order(x.c) - order(y.c) || (x.c.page ?? 0) - (y.c.page ?? 0) || x.i - y.i)
    .map((x) => x.c);
  return {
    kind: 'pdf-diff',
    a: a.source,
    b: b.source,
    identical: sorted.every((c) => c.category === 'masked'),
    changes: sorted,
    summary,
  };
}

// ----------------------------------------------------------------- bulk

/** Normalize a change description into a pattern signature (numbers, dates, ids, quoted values generalized). */
export function changeSignature(c: DocChange): string {
  const d = c.description
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?\b/g, '<date>')
    .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, '<date>')
    .replace(/\b[A-Z]{2,}[-_]?\d+[A-Z0-9-]*\b/g, '<id>')
    .replace(/[-+(]?\b\d[\d,.' ]*\d\b\)?|\b\d\b/g, '<n>')
    .replace(/<n>(?:\s*<n>)+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  return `${c.category}: ${d}`;
}

export interface BulkCluster {
  signature: string;
  category: ChangeCategory | 'only-in-a' | 'only-in-b' | 'error';
  /** Number of documents with this change. */
  count: number;
  /** Human-readable, e.g. '4 documents: field-changed: Total: <n> → <n>'. */
  description: string;
  examples: string[];
  documents: string[];
}

export interface BulkCompareResult {
  kind: 'bulk-compare';
  dirA: string;
  dirB: string;
  status: 'PASS' | 'FAIL';
  pairs: number;
  identical: number;
  different: number;
  onlyInA: string[];
  onlyInB: string[];
  errors: Array<{ document: string; message: string }>;
  clusters: BulkCluster[];
  documents: Array<{ name: string; identical: boolean; changes: number; signatures: string[] }>;
}

export interface BulkOptions extends DiffOptions {
  /** File name filter (default /\.pdf$/i). */
  filter?: RegExp;
  maxExamples?: number;
}

/** Diff every same-named file pair in two folders and cluster the differences. */
export async function bulkCompare(dirA: string, dirB: string, opts: BulkOptions = {}): Promise<BulkCompareResult> {
  const filter = opts.filter ?? /\.pdf$/i;
  const list = async (d: string) => (await readdir(d, { withFileTypes: true })).filter((e) => e.isFile() && filter.test(e.name)).map((e) => e.name).sort();
  const filesA = await list(dirA);
  const filesB = await list(dirB);
  const setB = new Set(filesB);
  const setA = new Set(filesA);
  const pairs = filesA.filter((f) => setB.has(f));
  const onlyInA = filesA.filter((f) => !setB.has(f));
  const onlyInB = filesB.filter((f) => !setA.has(f));
  const clusters = new Map<string, { category: BulkCluster['category']; docs: string[] }>();
  const addTo = (sig: string, category: BulkCluster['category'], doc: string) => {
    const c = clusters.get(sig) ?? { category, docs: [] };
    if (!c.docs.includes(doc)) c.docs.push(doc);
    clusters.set(sig, c);
  };
  const documents: BulkCompareResult['documents'] = [];
  const errors: BulkCompareResult['errors'] = [];
  let identical = 0;
  for (const name of pairs) {
    try {
      const r = await diffPdfs(join(dirA, name), join(dirB, name), opts);
      const sigs = [...new Set(r.changes.map(changeSignature))].sort();
      for (const c of r.changes) addTo(changeSignature(c), c.category, name);
      if (r.identical) identical++;
      documents.push({ name, identical: r.identical, changes: r.changes.length, signatures: sigs });
    } catch (e) {
      const msg = (e as Error).message;
      errors.push({ document: name, message: msg });
      addTo(`error: ${msg.replace(/\d+/g, '<n>')}`, 'error', name);
    }
  }
  for (const f of onlyInA) addTo('only-in-a: document has no counterpart in B', 'only-in-a', f);
  for (const f of onlyInB) addTo('only-in-b: document has no counterpart in A', 'only-in-b', f);
  const max = opts.maxExamples ?? 5;
  const out: BulkCluster[] = [...clusters.entries()]
    .map(([signature, c]) => {
      const docs = [...c.docs].sort();
      const suffix = c.category === 'masked' ? ' (masked)' : '';
      return {
        signature,
        category: c.category,
        count: docs.length,
        description: `${docs.length} document${docs.length === 1 ? '' : 's'}: ${signature}${suffix}`,
        examples: docs.slice(0, max),
        documents: docs,
      };
    })
    .sort((x, y) => y.count - x.count || (x.signature < y.signature ? -1 : x.signature > y.signature ? 1 : 0));
  const status = pairs.length > 0 && identical === pairs.length && onlyInA.length === 0 && onlyInB.length === 0 && errors.length === 0 ? 'PASS' : 'FAIL';
  return {
    kind: 'bulk-compare',
    dirA,
    dirB,
    status,
    pairs: pairs.length,
    identical,
    different: pairs.length - identical - errors.length,
    onlyInA,
    onlyInB,
    errors,
    clusters: out,
    documents,
  };
}
