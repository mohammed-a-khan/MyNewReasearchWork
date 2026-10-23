/**
 * Document assurance routes: the evidence behind `compareDocument` steps of a
 * run (three-way ledger, line items, footing) with the PDF's extracted text
 * positions, plus ad-hoc extraction, PDF↔PDF comparison, reconciliation
 * against a configured document check, bulk regression and PII findings.
 *
 * Every response carries positions in PDF points (top-left origin) so the
 * browser can draw highlights over pages rendered by pdf.js.
 */
import { existsSync } from 'node:fs';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { listRuns } from '../runs.js';
import { parse as parseYaml } from 'yaml';
import { interpolate } from '../../core/index.js';
import type { DocumentCheckConfig, EzTestConfig } from '../../config/index.js';
import {
  applyTemplate,
  autoFields,
  bulkCompare,
  detectPii,
  diffPdfs,
  extractPdf,
  formatNormalized,
  parseTemplate,
  reconcileThreeWay,
  unionBBox,
  type BBox,
  type CanonicalDocument,
  type DocChange,
  type DocTemplate,
  type PdfDiffResult,
  type ThreeWayMapping,
  type ThreeWayReport,
} from '../../docs/index.js';
import { DbRegistry, type DbConnectionSpec } from '../../surfaces/index.js';
import type { StudioApp } from '../app.js';
import { HttpError, sendJson, sendText } from '../http.js';
import { PathError, confinePath, relPosix } from '../security.js';
import {
  decodeUpload,
  findProjectFiles,
  loadRun,
  masker,
  projectPath,
  readRunJson,
  runAssetUrl,
  safeFileName,
  uploads,
  type LoadedRun,
} from './assurance-shared.js';
import type { StudioRoute } from './route.js';

// ------------------------------------------------------------------ views

export interface Highlight {
  doc: 'a' | 'b';
  page: number;
  bbox: BBox;
  kind: 'field' | 'cell' | 'row' | 'total' | 'line' | 'pii';
  /** Field name, "table[key].column", PII type... */
  ref: string;
  severity: 'error' | 'warning' | 'info';
  label: string;
  /** Index into the list of changes / findings this highlight belongs to (for "next mismatch"). */
  item?: number;
}

export interface DocView {
  name: string;
  url: string;
  sha256: string;
  pages: Array<{ number: number; width: number; height: number }>;
  metadata: Record<string, unknown>;
  fields: Array<{ name: string; type: string; raw: string; normalized: string; page: number; bbox: BBox; confidence: number }>;
  tables: Array<{
    name: string;
    columns: string[];
    rows: Array<{ index: number; page: number; kind: string; bbox: BBox; cells: Record<string, { raw: string; normalized: string; page: number; bbox: BBox }> }>;
  }>;
  findings: CanonicalDocument['findings'];
  pii: Array<{ type: string; page: number; bbox: BBox; masked: string }>;
}

/** PII per line, so each hit carries the position of the line it was found on. */
export function piiWithPositions(doc: CanonicalDocument): DocView['pii'] {
  const out: DocView['pii'] = [];
  for (const page of doc.pages) {
    for (const line of page.lines) {
      const mini: CanonicalDocument = { ...doc, pages: [{ ...page, lines: [line] }], fields: [], tables: [], findings: [] };
      for (const hit of detectPii(mini)) out.push({ type: hit.type, page: page.number, bbox: line.bbox, masked: hit.masked });
    }
  }
  return out;
}

export function docView(doc: CanonicalDocument, url: string, name: string): DocView {
  return {
    name,
    url,
    sha256: doc.sha256,
    pages: doc.pages.map((p) => ({ number: p.number, width: p.width, height: p.height })),
    metadata: { ...doc.metadata },
    fields: doc.fields.map((f) => ({
      name: f.name, type: f.type, raw: f.value.raw, normalized: formatNormalized(f.value.normalized), page: f.value.page, bbox: f.value.bbox, confidence: f.value.confidence,
    })),
    tables: doc.tables.map((t) => ({
      name: t.name,
      columns: t.columns,
      rows: t.rows.map((r) => {
        const cells = Object.fromEntries(Object.entries(r.cells).map(([c, v]) => [c, { raw: v.raw, normalized: formatNormalized(v.normalized), page: v.page, bbox: v.bbox }]));
        return { index: r.index, page: r.page, kind: r.kind, bbox: unionBBox(Object.values(r.cells).filter((c) => c.page === r.page).map((c) => c.bbox)), cells };
      }),
    })),
    findings: doc.findings,
    pii: piiWithPositions(doc),
  };
}

// ------------------------------------------------------------------ templates and checks

async function templateFrom(app: StudioApp, input: { templatePath?: unknown; template?: unknown }): Promise<DocTemplate | undefined> {
  if (typeof input.template === 'string' && input.template.trim()) {
    try {
      return parseTemplate(input.template);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }
  if (typeof input.templatePath === 'string' && input.templatePath) {
    const abs = projectPath(app, input.templatePath, { exts: ['.yaml', '.yml', '.json'] });
    if (!existsSync(abs)) throw new HttpError(404, `Template ${input.templatePath} not found`);
    try {
      return parseTemplate(await readFile(abs, 'utf8'));
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }
  return undefined;
}

async function checkTemplate(app: StudioApp, check: DocumentCheckConfig): Promise<DocTemplate> {
  const abs = projectPath(app, check.template, { exts: ['.yaml', '.yml', '.json'] });
  return parseTemplate(parseYaml(await readFile(abs, 'utf8')) as never);
}

function headline(report: ThreeWayReport): { status: 'PASS' | 'FAIL'; headline: string; layer?: string } {
  const odd = report.fields.map((f) => f.oddOneOut).filter(Boolean);
  if (odd.includes('pdf')) return { status: report.status, headline: 'Document generation defect', layer: 'pdf' };
  if (odd.includes('ui')) return { status: report.status, headline: 'UI display / binding defect', layer: 'ui' };
  if (odd.includes('db')) return { status: report.status, headline: 'Persistence defect', layer: 'db' };
  if (report.status === 'PASS') return { status: 'PASS', headline: 'UI, document and database agree' };
  if (report.lines?.status === 'FAIL') return { status: 'FAIL', headline: 'Line items do not reconcile', layer: 'lines' };
  if (report.footing && !report.footing.passed) return { status: 'FAIL', headline: 'Document does not foot (line total ≠ printed total)', layer: 'pdf' };
  return { status: 'FAIL', headline: 'Sources disagree' };
}

function refKey(ref: unknown): string | undefined {
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object' && typeof (ref as { key?: unknown }).key === 'string') return (ref as { key: string }).key;
  return undefined;
}

function tolText(t: { abs?: number; rel?: number } | undefined): string {
  if (!t) return '';
  return [t.abs !== undefined ? `±${t.abs}` : '', t.rel !== undefined ? `±${(t.rel * 100).toFixed(2)}%` : ''].filter(Boolean).join(' / ');
}

/** Field table, highlights and line rows for a three-way report over an extracted document. */
export function threeWayView(report: ThreeWayReport, doc: CanonicalDocument, check: Pick<DocumentCheckConfig, 'fields' | 'lines' | 'footing'>) {
  const highlights: Highlight[] = [];
  const fields = report.fields.map((f, i) => {
    const map = check.fields.find((x) => x.name === f.name);
    const pdfKey = refKey(map?.pdf);
    const docField = pdfKey ? doc.fields.find((x) => x.name === pdfKey) : undefined;
    const bad = f.verdict !== 'ALL_AGREE';
    if (docField && bad && f.verdict !== 'INSUFFICIENT_DATA') {
      highlights.push({
        doc: 'a', page: docField.value.page, bbox: docField.value.bbox, kind: 'field', ref: f.name,
        severity: f.oddOneOut === 'pdf' || f.verdict === 'ALL_DISAGREE' ? 'error' : 'warning',
        label: `${f.name}: ${f.diagnosis}`, item: i,
      });
    }
    return {
      name: f.name, values: f.values, verdict: f.verdict, oddOneOut: f.oddOneOut, diagnosis: f.diagnosis,
      type: map?.type ?? 'text', tolerance: tolText(map?.tolerance),
      position: docField ? { page: docField.value.page, bbox: docField.value.bbox } : undefined,
    };
  });

  // Line items: PDF rows with the findings for their key.
  let lines: undefined | {
    table: string; key: string[]; columns: string[]; status: string;
    rows: Array<{ key: string; page: number; bbox: BBox; status: 'ok' | 'mismatch' | 'missing-in-db' | 'total'; cells: Record<string, { raw: string; expected?: string; actual?: string; bad?: boolean; page: number; bbox: BBox }> }>;
    extra: Array<{ key: string; message: string }>;
    findings: NonNullable<ThreeWayReport['lines']>['findings'];
  };
  if (check.lines) {
    const t = doc.tables.find((x) => x.name === check.lines!.pdfTable);
    const keyCols = Array.isArray(check.lines.key) ? check.lines.key : [check.lines.key];
    const findings = report.lines?.findings ?? [];
    const rows = (t?.rows ?? []).map((r) => {
      const key = keyCols.map((k) => r.cells[k]?.raw ?? '').join('|');
      const mine = findings.filter((f) => f.key === key || f.key.split('|').map((x) => x.trim()).join('|') === key);
      const status = r.kind !== 'data' ? 'total' as const : mine.some((f) => f.type === 'MISSING') ? 'missing-in-db' as const : mine.some((f) => f.type === 'MISMATCH') ? 'mismatch' as const : 'ok' as const;
      const cells: Record<string, { raw: string; expected?: string; actual?: string; bad?: boolean; page: number; bbox: BBox }> = {};
      for (const [c, v] of Object.entries(r.cells)) {
        const f = mine.find((x) => x.column === c && x.type === 'MISMATCH');
        cells[c] = { raw: v.raw, page: v.page, bbox: v.bbox, ...(f ? { expected: f.expected, actual: f.actual, bad: true } : {}) };
        if (f) highlights.push({ doc: 'a', page: v.page, bbox: v.bbox, kind: 'cell', ref: `${t!.name}[${key}].${c}`, severity: 'error', label: `${c} of ${key}: document ${f.expected ?? ''} vs database ${f.actual ?? ''}`, item: fields.length + findings.indexOf(f) });
      }
      const bbox = unionBBox(Object.values(r.cells).filter((c) => c.page === r.page).map((c) => c.bbox));
      if (status === 'missing-in-db') highlights.push({ doc: 'a', page: r.page, bbox, kind: 'row', ref: `${t!.name}[${key}]`, severity: 'error', label: `Row ${key} is not in the database`, item: fields.length + findings.findIndex((f) => mine.includes(f)) });
      return { key, page: r.page, bbox, status, cells };
    });
    if (check.footing && report.footing && !report.footing.passed) {
      const total = rows.find((r) => r.status === 'total');
      if (total) highlights.push({ doc: 'a', page: total.page, bbox: total.bbox, kind: 'total', ref: `${check.footing.pdfTable}.total`, severity: 'error', label: report.footing.message, item: fields.length + findings.length });
    }
    lines = {
      table: check.lines.pdfTable, key: keyCols, columns: t?.columns ?? Object.keys(check.lines.fieldMap), status: report.lines?.status ?? 'n/a', rows,
      extra: findings.filter((f) => f.type === 'EXTRA').map((f) => ({ key: f.key, message: f.message })),
      findings,
    };
  }
  return { verdict: headline(report), diagnosis: report.diagnosis, fields, lines, footing: report.footing, highlights };
}

// ------------------------------------------------------------------ runs

const COMPARE_INTENT = /compare\s+(?:the\s+)?document\s+(\S+)\s+(?:to|with|against)\s+(.+?)(?:\s+using\s+(\S+?))?(?:\s+and\s+(?:store|save|keep).*)?$/i;

interface CompareEvidence {
  passed: boolean;
  details: ThreeWayReport | unknown;
}

interface DocStep {
  journeyId: string;
  journeyName: string;
  stepId: string;
  intent: string;
  status: string;
  check?: string;
  documentKey?: string;
  pdfPath?: string;
  evidencePath: string;
}

function documentSteps(r: LoadedRun): DocStep[] {
  const out: DocStep[] = [];
  for (const j of r.run.journeys) {
    for (const s of j.steps) {
      // A failed comparison throws after storing its evidence, so look it up in the manifest, not only on the step.
      const isCompare = (e: { kind: string; path: string } | undefined) => e?.kind === 'data' && e.path.startsWith('compare/');
      const ev = (s.evidence ?? []).map((id) => r.evidence.get(id)).find(isCompare) ?? [...r.evidence.values()].find((e) => isCompare(e) && e.journeyId === j.journeyId && e.stepId === s.stepId);
      if (!ev) continue;
      const m = COMPARE_INTENT.exec(s.intent.replace(/["“”]/g, ''));
      const documentKey = m?.[1];
      const check = m?.[3] ?? m?.[2]?.trim();
      const dl = documentKey ? (j.ledger?.[documentKey] as { relPath?: string; path?: string } | undefined) : undefined;
      const pdfPath = dl?.relPath && dl.relPath.toLowerCase().endsWith('.pdf') ? dl.relPath : undefined;
      out.push({ journeyId: j.journeyId, journeyName: j.name, stepId: s.stepId, intent: s.intent, status: s.status, check, documentKey, pdfPath, evidencePath: ev.path });
    }
  }
  return out;
}

async function runDocumentDetail(app: StudioApp, runId: string, journeyId: string, stepId: string): Promise<Record<string, unknown>> {
  const r = await loadRun(app, runId);
  const step = documentSteps(r).find((s) => s.journeyId === journeyId && s.stepId === stepId);
  if (!step) throw new HttpError(404, 'No document comparison at this step');
  const evidence = await readRunJson<CompareEvidence>(r, step.evidencePath);
  if (!evidence) throw new HttpError(404, 'The comparison evidence is missing');
  const report = evidence.details as ThreeWayReport;
  if (!report || report.kind !== 'three-way') {
    return { step, evidence, unsupported: 'This comparison is not a three-way ledger' };
  }
  const cfg = (await app.config()).config;
  const check = step.check ? cfg.documents[step.check] : undefined;
  let doc: CanonicalDocument | undefined;
  const warnings: string[] = [];
  if (step.pdfPath && check) {
    try {
      doc = await extractPdf(join(r.dir, step.pdfPath), { template: await checkTemplate(app, check), source: step.documentKey });
    } catch (e) {
      warnings.push(`The document could not be re-extracted for positions: ${(e as Error).message}`);
    }
  } else if (!step.pdfPath) warnings.push('The downloaded document was not found in the run ledger, so it cannot be displayed.');
  else warnings.push(`The document check "${step.check}" is no longer in the configuration; highlights are unavailable.`);
  const view = doc ? threeWayView(report, doc, check!) : { verdict: headline(report), diagnosis: report.diagnosis, fields: report.fields.map((f) => ({ ...f, tolerance: '', type: 'text' })), lines: undefined, footing: report.footing, highlights: [] };
  const m = await masker(app);
  return m.maskDeep({
    step,
    check: step.check,
    report: { status: report.status, diagnosis: report.diagnosis },
    ...view,
    document: doc ? docView(doc, runAssetUrl(runId, step.pdfPath!), basename(step.pdfPath!)) : undefined,
    warnings,
  });
}

// ------------------------------------------------------------------ ad-hoc sources

interface SourceRef {
  upload?: string;
  path?: string;
  run?: string;
}

async function loadSourceBytes(app: StudioApp, ref: unknown): Promise<{ bytes: Buffer; name: string; url: string }> {
  const s = (ref ?? {}) as SourceRef;
  if (s.upload) {
    const b = uploads.get(s.upload);
    return { bytes: b.bytes, name: b.name, url: `/api/assurance/documents/blob/${s.upload}` };
  }
  if (s.run && s.path) {
    const r = await loadRun(app, s.run);
    const abs = confinePath(r.dir, s.path);
    if (extname(abs).toLowerCase() !== '.pdf' || s.path.split('/').some((p) => p.startsWith('.'))) throw new PathError('Only PDF files of the run can be compared');
    if (!existsSync(abs)) throw new HttpError(404, `${s.path} not found in run ${s.run}`);
    return { bytes: await readFile(abs), name: basename(abs), url: runAssetUrl(s.run, s.path) };
  }
  if (s.path) {
    const abs = projectPath(app, s.path, { exts: ['.pdf'] });
    if (!existsSync(abs)) throw new HttpError(404, `${s.path} not found`);
    return { bytes: await readFile(abs), name: basename(abs), url: `/api/assurance/documents/file?path=${encodeURIComponent(s.path)}` };
  }
  throw new HttpError(400, 'A document source needs "upload", "path" or "run" + "path"');
}

async function extractFor(bytes: Buffer, name: string, template: DocTemplate | undefined): Promise<CanonicalDocument> {
  try {
    const doc = await extractPdf(new Uint8Array(bytes), { source: name });
    if (template) applyTemplate(doc, template);
    else doc.fields = autoFields(doc);
    return doc;
  } catch (e) {
    throw new HttpError(422, (e as Error).message);
  }
}

function keyOfRow(row: CanonicalDocument['tables'][number]['rows'][number], keyCols: string[]): string {
  return row.kind !== 'data' ? `‹${row.kind}›` : keyCols.map((k) => (row.cells[k] ? formatNormalized(row.cells[k].normalized) : '')).join('|');
}

/** Positions for each diff change, in A and/or B. */
export function diffHighlights(diff: PdfDiffResult, a: CanonicalDocument, b: CanonicalDocument, tableKeys: Record<string, string | string[]> = {}): Highlight[] {
  const out: Highlight[] = [];
  const sev = (c: DocChange): Highlight['severity'] => (c.category === 'masked' ? 'info' : c.category.endsWith('added') || c.category.endsWith('removed') ? 'warning' : 'error');
  const lineAt = (doc: CanonicalDocument, page: number | undefined, text: string | undefined) => {
    if (text === undefined) return undefined;
    const lines = doc.pages.flatMap((p) => p.lines);
    return lines.find((l) => l.text === text && (page === undefined || l.page === page)) ?? lines.find((l) => l.text === text);
  };
  diff.changes.forEach((c, i) => {
    const add = (doc: 'a' | 'b', page: number, bbox: BBox, kind: Highlight['kind'], ref: string) => out.push({ doc, page, bbox, kind, ref, severity: sev(c), label: c.description, item: i });
    const field = /^Field "(.+)"/.exec(c.subject);
    if (field) {
      const fa = a.fields.find((f) => f.name === field[1]);
      const fb = b.fields.find((f) => f.name === field[1]);
      if (fa) add('a', fa.value.page, fa.value.bbox, 'field', field[1]);
      if (fb) add('b', fb.value.page, fb.value.bbox, 'field', field[1]);
      return;
    }
    const cell = /^Table "(.+)" row (.*) column "(.+)"$/.exec(c.subject);
    const row = /^Table "(.+)" row$/.exec(c.subject);
    if (cell || row) {
      const table = (cell ?? row)![1];
      for (const [side, doc] of [['a', a], ['b', b]] as const) {
        const t = doc.tables.find((x) => x.name === table);
        if (!t) continue;
        const k = tableKeys[table];
        const keyCols = k === undefined ? [t.columns[0]] : Array.isArray(k) ? k : [k];
        const key = cell ? cell[2] : side === 'a' ? c.before : c.after;
        const r = t.rows.find((x) => keyOfRow(x, keyCols) === key);
        if (!r) continue;
        const target = cell ? r.cells[cell[3]] : undefined;
        if (target) add(side, target.page, target.bbox, 'cell', `${table}[${key}].${cell![3]}`);
        else if (!cell) add(side, r.page, unionBBox(Object.values(r.cells).filter((x) => x.page === r.page).map((x) => x.bbox)), 'row', `${table}[${key}]`);
      }
      return;
    }
    if (c.category.startsWith('text-') || (c.category === 'masked' && c.subject.startsWith('Line'))) {
      const la = lineAt(a, c.category === 'text-changed' || c.category === 'masked' ? undefined : c.page, c.before);
      const lb = lineAt(b, c.page, c.after);
      if (la) add('a', la.page, la.bbox, 'line', `line ${la.page}:${la.index}`);
      if (lb) add('b', lb.page, lb.bbox, 'line', `line ${lb.page}:${lb.index}`);
    }
  });
  return out;
}

async function reconcileAgainstCheck(app: StudioApp, cfg: EzTestConfig, doc: CanonicalDocument, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const name = String(body.name ?? '');
  const check = cfg.documents[name];
  if (!check) throw new HttpError(400, `No document check "${name}" in the configuration`);
  // Re-apply the check's own template so the fields it maps exist.
  const tpl = await checkTemplate(app, check);
  const withTpl: CanonicalDocument = { ...doc, fields: [], tables: [], findings: [] };
  applyTemplate(withTpl, tpl);
  const vars = Object.fromEntries(Object.entries((body.params ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  const ui = Object.fromEntries(Object.entries((body.ui ?? {}) as Record<string, unknown>).filter(([, v]) => v !== '' && v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
  let dbRow: Record<string, unknown> | undefined;
  let lineRows: Array<Record<string, unknown>> = [];
  if (check.db) {
    const dbs = new DbRegistry(cfg.db.connections as unknown as Record<string, DbConnectionSpec>);
    try {
      const client = await dbs.get(check.db.connection);
      const params = check.db.params.map((p) => (typeof p === 'string' ? interpolate(p, vars) : p));
      const missing = params.filter((p) => typeof p === 'string' && /\$\{/.test(p));
      if (missing.length) throw new HttpError(400, `Give a value for ${missing.join(', ')} (query parameters)`);
      dbRow = (await client.query(check.db.query, params))[0];
      if (check.db.linesQuery) lineRows = await client.query(check.db.linesQuery, params);
    } finally {
      await dbs.closeAll().catch(() => undefined);
    }
  }
  const mapping: ThreeWayMapping = { fields: check.fields, lines: check.lines ? { ...check.lines, dbRows: lineRows } : undefined, footing: check.footing };
  const report = reconcileThreeWay({ ui: Object.keys(ui).length ? ui : undefined, pdf: withTpl, db: dbRow }, mapping);
  return { check: name, report: { status: report.status, diagnosis: report.diagnosis }, ...threeWayView(report, withTpl, check), document: withTpl };
}

// ------------------------------------------------------------------ routes

export const documentRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: /^\/api\/assurance\/documents\/runs\/([^/]+)$/,
    summary: 'Document comparisons (compareDocument steps) of a run',
    async handler({ res, app, params }) {
      const r = await loadRun(app, params[0]);
      const steps = documentSteps(r);
      const out = [];
      for (const s of steps) {
        const ev = await readRunJson<CompareEvidence>(r, s.evidencePath);
        const rep = ev?.details as ThreeWayReport | undefined;
        out.push({ ...s, passed: ev?.passed ?? false, verdict: rep?.kind === 'three-way' ? headline(rep) : undefined, diagnosis: rep?.kind === 'three-way' ? rep.diagnosis : [] });
      }
      sendJson(res, 200, { runId: r.id, documents: (await masker(app)).maskDeep(out) });
    },
  },
  {
    method: 'GET',
    path: /^\/api\/assurance\/documents\/runs\/([^/]+)\/([^/]+)\/([^/]+)$/,
    summary: 'One document comparison: ledger, line items, highlights at extracted positions, PII',
    async handler({ res, app, params }) {
      sendJson(res, 200, await runDocumentDetail(app, params[0], params[1], params[2]));
    },
  },
  {
    method: 'GET',
    path: '/api/assurance/documents/sources',
    summary: 'PDFs, templates and document checks available for ad-hoc comparison',
    async handler({ res, app }) {
      const pdfs = await findProjectFiles(app, ['.pdf'], { includeOutput: false });
      const templates = (await findProjectFiles(app, ['.yaml', '.yml', '.json'])).filter((f) => /template|templates\//i.test(f.path));
      let checks: Array<{ name: string; template: string; fields: string[]; params: string[] }> = [];
      try {
        const cfg = (await app.config()).config;
        checks = Object.entries(cfg.documents).map(([name, c]) => ({
          name, template: c.template, fields: c.fields.map((f) => f.name),
          params: [...new Set((c.db?.params ?? []).flatMap((p) => (typeof p === 'string' ? [...p.matchAll(/\$\{([\w.]+)\}/g)].map((m) => m[1]) : [])))],
        }));
        for (const c of checks) if (!templates.some((t) => t.path === c.template)) templates.push({ path: c.template, size: 0, mtime: '' });
      } catch {
        checks = [];
      }
      // Recent run downloads (newest runs first).
      const runDocs: Array<{ runId: string; path: string; journeyId: string }> = [];
      try {
        for (const run of (await listRuns(await app.outputDir())).slice(0, 10)) {
          const r = await loadRun(app, run.runId).catch(() => undefined);
          if (!r) continue;
          for (const e of r.evidence.values()) if (e.kind === 'download' && e.path.toLowerCase().endsWith('.pdf')) runDocs.push({ runId: r.id, path: e.path, journeyId: e.journeyId ?? '' });
        }
      } catch {
        // no runs
      }
      sendJson(res, 200, { pdfs, templates, checks, runDocuments: runDocs.slice(0, 30) });
    },
  },
  {
    method: 'GET',
    path: '/api/assurance/documents/template',
    summary: 'Read a document template',
    async handler({ res, app, query }) {
      const abs = projectPath(app, query.get('path'), { exts: ['.yaml', '.yml', '.json'] });
      if (!existsSync(abs)) throw new HttpError(404, 'Template not found');
      const text = await readFile(abs, 'utf8');
      let error: string | undefined;
      try {
        parseTemplate(text);
      } catch (e) {
        error = (e as Error).message;
      }
      sendJson(res, 200, { path: relPosix(app.cwd, abs), text, error });
    },
  },
  {
    method: 'PUT',
    path: '/api/assurance/documents/template',
    summary: 'Save a document template (validated first)',
    async handler({ res, app, body }) {
      const abs = projectPath(app, body.path, { exts: ['.yaml', '.yml', '.json'] });
      const text = typeof body.text === 'string' ? body.text : '';
      try {
        parseTemplate(text);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, text.endsWith('\n') ? text : `${text}\n`);
      sendJson(res, 200, { ok: true, path: relPosix(app.cwd, abs) });
    },
  },
  {
    method: 'POST',
    path: '/api/assurance/documents/upload',
    summary: 'Upload a PDF for comparison (kept in memory only)',
    async handler({ res, body }) {
      const bytes = decodeUpload(body.data);
      if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HttpError(400, 'The file is not a PDF');
      const name = safeFileName(body.name, 'document.pdf');
      sendJson(res, 200, { id: uploads.put(name, bytes), name, size: bytes.length });
    },
  },
  {
    method: ['GET', 'HEAD'],
    path: /^\/api\/assurance\/documents\/blob\/([a-f0-9]{24})$/,
    summary: 'Bytes of an uploaded PDF',
    handler({ res, params, method }) {
      const b = uploads.get(params[0]);
      sendText(res, 200, 'application/pdf', b.bytes, method === 'HEAD');
    },
  },
  {
    method: ['GET', 'HEAD'],
    path: '/api/assurance/documents/file',
    summary: 'Bytes of a project PDF',
    async handler({ res, app, query, method }) {
      const abs = projectPath(app, query.get('path'), { exts: ['.pdf'] });
      if (!existsSync(abs) || !(await stat(abs)).isFile()) throw new HttpError(404, 'File not found');
      sendText(res, 200, 'application/pdf', await readFile(abs), method === 'HEAD');
    },
  },
  {
    method: 'POST',
    path: '/api/assurance/documents/compare',
    summary: 'Extract one or two PDFs with a template; diff them and/or reconcile against a document check',
    async handler({ res, app, body }) {
      const template = await templateFrom(app, body);
      const masks = Array.isArray(body.masks) ? body.masks.map(String).filter(Boolean) : [];
      for (const mk of masks) {
        try {
          new RegExp(mk);
        } catch (e) {
          throw new HttpError(400, `Invalid mask ${JSON.stringify(mk)}: ${(e as Error).message}`);
        }
      }
      const srcA = await loadSourceBytes(app, body.a);
      const a = await extractFor(srcA.bytes, srcA.name, template);
      const out: Record<string, unknown> = {};
      const highlights: Highlight[] = [];
      const piiOf = (v: DocView, doc: 'a' | 'b') => v.pii.map((p) => ({ doc, page: p.page, bbox: p.bbox, kind: 'pii' as const, ref: p.type, severity: 'warning' as const, label: `PII (${p.type}): ${p.masked}` }));
      let viewA = docView(a, srcA.url, srcA.name);
      if (body.b) {
        const srcB = await loadSourceBytes(app, body.b);
        const b = await extractFor(srcB.bytes, srcB.name, template);
        const diff = await diffPdfs(a, b, { masks, tableKeys: Object.fromEntries((template?.tables ?? []).filter((t) => t.key).map((t) => [t.name, t.key!])) });
        highlights.push(...diffHighlights(diff, a, b, Object.fromEntries((template?.tables ?? []).filter((t) => t.key).map((t) => [t.name, t.key!]))));
        const viewB = docView(b, srcB.url, srcB.name);
        out.b = viewB;
        out.diff = diff;
        highlights.push(...piiOf(viewB, 'b'));
      }
      if (body.check && typeof body.check === 'object') {
        const cfg = (await app.config()).config;
        const r = await reconcileAgainstCheck(app, cfg, a, body.check as Record<string, unknown>);
        const doc = r.document as CanonicalDocument;
        delete r.document;
        viewA = docView(doc, srcA.url, srcA.name);
        out.threeWay = r;
        highlights.push(...((r.highlights as Highlight[]) ?? []));
      }
      out.a = viewA;
      highlights.push(...piiOf(viewA, 'a'));
      out.highlights = highlights;
      sendJson(res, 200, (await masker(app)).maskDeep(out));
    },
  },
  {
    method: 'POST',
    path: '/api/assurance/documents/bulk',
    summary: 'Bulk regression of two folders of PDFs, clustered by change pattern',
    async handler({ res, app, body }) {
      const dirA = projectPath(app, body.dirA);
      const dirB = projectPath(app, body.dirB);
      for (const d of [dirA, dirB]) if (!existsSync(d) || !(await stat(d)).isDirectory()) throw new HttpError(404, `Folder not found: ${relPosix(app.cwd, d)}`);
      const template = await templateFrom(app, body);
      const masks = Array.isArray(body.masks) ? body.masks.map(String).filter(Boolean) : [];
      const r = await bulkCompare(dirA, dirB, { template, masks, maxExamples: 8 });
      sendJson(res, 200, (await masker(app)).maskDeep({ ...r, dirA: relPosix(app.cwd, dirA), dirB: relPosix(app.cwd, dirB) }));
    },
  },
];

