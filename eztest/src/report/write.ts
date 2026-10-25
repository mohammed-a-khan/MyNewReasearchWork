import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { readTrace, renderSnapshot, runDirSource, traceDirName, TRACE_ROOT } from '../runner/trace/index.js';
import { safeName } from '../runner/evidence.js';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { EvidenceRef, RunResult } from '../core/index.js';
import { EzTestError, NotSupportedError } from '../core/index.js';
import { readEvidenceManifest } from '../insights/index.js';
import { normalizeNetworkLog, type NetworkEntry } from '../perf/network.js';
import { apiCoverageHtml } from '../contracts/coverage.js';
import { featuresBlock, renderReportModelHtml } from './html.js';
import { buildJsonReport, type JsonReport } from './json.js';
import { renderJUnit } from './junit.js';
import { renderTestsCsv } from './csv.js';
import { renderSummaryHtml } from './summary.js';
import { renderEmailHtml } from './email.js';
import { renderReportXlsx } from './xlsx.js';
import { renderReportPdf } from './pdf.js';
import { applyIntegrationLinks, buildReportModel, type ReportModel, type ReportModelInput, type StepArtifacts } from './data.js';
import { loadOrCaptureContext } from './context.js';
import { readIntegrations } from './integrations.js';
import type { ReportInsights } from './model.js';

export type ReportFormat = 'html' | 'json' | 'junit' | 'csv' | 'summary' | 'email' | 'xlsx' | 'pdf';
export const REPORT_FORMATS: ReportFormat[] = ['html', 'json', 'junit', 'csv', 'summary', 'email', 'xlsx', 'pdf'];

export const REPORT_FILES: Record<ReportFormat, string> = {
  html: 'report.html',
  json: 'report.json',
  junit: 'junit.xml',
  csv: 'tests.csv',
  summary: 'summary.html',
  email: 'email.html',
  xlsx: 'report.xlsx',
  pdf: 'report.pdf',
};

/** The report model, kept next to the reports so they can be rendered again (after publishing). */
export const REPORT_MODEL_FILE = 'report-model.json';

export interface WriteReportsOptions extends ReportInsights, Omit<ReportModelInput, keyof ReportInsights> {
  formats: ReportFormat[];
  title?: string;
  /** Environment variables for the run context (default process.env). */
  env?: Record<string, string | undefined>;
}

const LOGO_TYPES: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/** A logo file as a data: URI for the report header (svg, png, jpeg, gif, webp; at most 512 KiB). */
export async function loadLogo(path: string): Promise<string> {
  const type = LOGO_TYPES[extname(path).toLowerCase()];
  if (!type) throw new EzTestError(`report logo ${path}: use an .svg, .png, .jpg, .gif or .webp file`, 'INVALID_INPUT');
  const s = await stat(path);
  if (s.size > 512 * 1024) throw new EzTestError(`report logo ${path} is ${Math.round(s.size / 1024)} KiB; keep it under 512 KiB`, 'INVALID_INPUT');
  return `data:${type};base64,${(await readFile(path)).toString('base64')}`;
}

function inside(runDir: string, p: string): string | undefined {
  const abs = resolve(runDir, p);
  const rel = relative(runDir, abs);
  return rel.startsWith('..') || isAbsolute(rel) ? undefined : abs;
}

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
const SECRET_PARAM = /([?&](?:access_token|token|api[_-]?key|key|secret|password|pass|sig|signature|code)=)[^&#]*/gi;

/** Headers and URLs for the report: credentials masked even when the recorder did not. */
export function maskHeaders(h: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!h) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k] = SECRET_HEADER.test(k) ? '****' : String(v).slice(0, 500);
  return out;
}
export const maskUrl = (u: string) => u.replace(SECRET_PARAM, '$1****');

/** Evidence file sizes and chain positions (seq) from the manifest. */
async function evidenceMeta(runDir: string, evidence: EvidenceRef[]): Promise<Map<string, { size?: number; seq?: number }>> {
  const out = new Map<string, { size?: number; seq?: number }>();
  const p = join(runDir, 'evidence-manifest.jsonl');
  const seqs = new Map<string, number>();
  if (existsSync(p)) {
    for (const line of (await readFile(p, 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { id?: string; seq?: number };
        if (e.id && typeof e.seq === 'number') seqs.set(e.id, e.seq);
      } catch {
        // the verifier reports a broken manifest
      }
    }
  }
  const many = evidence.length > 20_000;
  for (const ev of evidence) {
    let size: number | undefined;
    if (!many) {
      const abs = inside(runDir, ev.path);
      if (abs) size = await stat(abs).then((x) => x.size).catch(() => undefined);
    }
    out.set(ev.id, { ...(size !== undefined ? { size } : {}), ...(seqs.has(ev.id) ? { seq: seqs.get(ev.id) } : {}) });
  }
  return out;
}

const dataUri = async (path: string | undefined, max = 1_500_000): Promise<string | undefined> => {
  if (!path || !existsSync(path)) return undefined;
  const b = await readFile(path);
  if (b.length > max) return undefined;
  const type = /\.jpe?g$/i.test(path) ? 'image/jpeg' : 'image/png';
  return `data:${type};base64,${b.toString('base64')}`;
};

/**
 * What the test details show from the run directory, bounded in size: API exchanges per step,
 * the browser network log and console (all levels), video chapters, evidence sizes and chain
 * positions, the time-travel trace (per-step heal notes, requests, console and sanitised DOM
 * snapshots), visual comparisons (baseline, actual, diff) and the trace zips.
 */
export async function collectStepArtifacts(runDir: string, run: RunResult, evidence: EvidenceRef[], o: { maxFiles?: number; snapshotBudget?: number; maxLensFiles?: number } = {}): Promise<StepArtifacts> {
  const out: StepArtifacts = { api: new Map(), network: new Map(), console: new Map(), chapters: new Map(), traces: new Map(), snapshots: new Map(), visual: new Map(), traceZips: new Map(), lenses: [] };
  const failing = new Set(run.journeys.filter((j) => j.status === 'failed' || j.status === 'error' || j.attempt > 1).map((j) => j.journeyId));
  out.evidenceMeta = await evidenceMeta(runDir, evidence);
  let budget = o.maxFiles ?? 4000;
  // Lens findings (accessibility, security, performance) for the run-level Quality section.
  let lensBudget = o.maxLensFiles ?? 3000;
  for (const ev of evidence) {
    if (lensBudget <= 0) break;
    if (ev.kind !== 'data' || !ev.journeyId || !/(^|\/)lens-(a11y|security|perf)-[^/]*\.json$/.test(ev.path)) continue;
    const abs = inside(runDir, ev.path);
    if (!abs || !existsSync(abs)) continue;
    lensBudget--;
    try {
      out.lenses!.push({ journeyId: ev.journeyId, ...(ev.stepId ? { stepId: ev.stepId } : {}), evidenceId: ev.id, findings: JSON.parse(await readFile(abs, 'utf8')) as unknown });
    } catch {
      // unreadable evidence is reported by the evidence verifier
    }
  }
  for (const ev of evidence) {
    if (budget <= 0) break;
    const isApi = ev.kind === 'network' && ev.path.startsWith('api/') && ev.stepId && ev.journeyId;
    const isNet = ev.kind === 'network' && /(^|\/)network\.json$/.test(ev.path) && ev.journeyId && failing.has(ev.journeyId);
    const isCon = ev.kind === 'console' && ev.journeyId && failing.has(ev.journeyId);
    const isVtt = ev.kind === 'video-chapters' && ev.journeyId;
    const isVisual = ev.kind === 'data' && /(^|\/)lens-visual-[^/]*\.json$/.test(ev.path) && ev.journeyId && ev.stepId;
    if (!isApi && !isNet && !isCon && !isVtt && !isVisual) continue;
    const abs = inside(runDir, ev.path);
    if (!abs || !existsSync(abs)) continue;
    budget--;
    try {
      if (isVtt) {
        const cues = parseVttCues(await readFile(abs, 'utf8'));
        if (!out.chapters!.has(ev.journeyId!)) out.chapters!.set(ev.journeyId!, cues);
        out.chapters!.set(`${ev.journeyId}\u0000${ev.id}`, cues);
        continue;
      }
      const raw = JSON.parse(await readFile(abs, 'utf8')) as unknown;
      if (isCon) {
        const t0 = Date.parse(run.journeys.find((j) => j.journeyId === ev.journeyId)?.startedAt ?? '');
        const list = Array.isArray(raw) ? (raw as Array<{ type?: string; text?: string; at?: string; stepId?: string; location?: string; ignored?: boolean }>) : [];
        const entries = list.filter((c) => c && typeof c.text === 'string').map((c) => {
          const at = Date.parse(c.at ?? '');
          return { l: String(c.type ?? 'log'), t: String(c.text).slice(0, 1000), ...(Number.isFinite(at) && Number.isFinite(t0) ? { at: Math.max(0, at - t0) } : {}), ...(c.stepId ? { stepId: c.stepId } : {}), ...(c.location ? { loc: c.location } : {}), ...(c.ignored ? { ig: 1 } : {}) };
        });
        if (entries.length) out.console.set(ev.journeyId!, [...(out.console.get(ev.journeyId!) ?? []), ...entries]);
        continue;
      }
      if (isVisual) {
        const findings = (Array.isArray(raw) ? raw : []) as Array<{ message?: string; details?: { key?: string; passed?: boolean; diffRatio?: number; baselinePath?: string; actualPath?: string; diffPath?: string } }>;
        const vd = [];
        for (const f of findings.filter((x) => x.details && x.details.passed === false).slice(0, 3)) {
          const d = f.details!;
          vd.push({ key: String(d.key ?? 'visual'), message: String(f.message ?? '').slice(0, 400), ...(typeof d.diffRatio === 'number' ? { ratio: d.diffRatio } : {}), ...((await dataUri(d.baselinePath)) ? { baseline: await dataUri(d.baselinePath) } : {}), ...((await dataUri(d.actualPath)) ? { actual: await dataUri(d.actualPath) } : {}), ...((await dataUri(d.diffPath)) ? { diff: await dataUri(d.diffPath) } : {}) });
        }
        if (vd.length) out.visual!.set(`${ev.journeyId}\u0000${ev.stepId}`, vd);
        continue;
      }
      const entries: NetworkEntry[] = normalizeNetworkLog(raw).map((x) => ({ ...x, url: maskUrl(x.url), ...(x.requestHeaders ? { requestHeaders: maskHeaders(x.requestHeaders) } : {}), ...(x.responseHeaders ? { responseHeaders: maskHeaders(x.responseHeaders) } : {}) }));
      if (isApi) out.api.set(`${ev.journeyId}\u0000${ev.stepId}`, entries);
      else out.network.set(ev.journeyId!, [...(out.network.get(ev.journeyId!) ?? []), ...entries]);
    } catch {
      // unreadable evidence is reported by the evidence verifier, not here
    }
  }
  // Trace zips (`--trace`): traces/<journey>-attempt<n>.zip
  const zipDir = join(runDir, 'traces');
  if (existsSync(zipDir)) {
    const names = await readdir(zipDir).catch(() => [] as string[]);
    for (const j of run.journeys) {
      const base = safeName(j.journeyId);
      const z = names.filter((n) => n.endsWith('.zip') && (n.startsWith(`${base}-attempt`) || n.startsWith(`${base}.`))).sort();
      if (z.length) out.traceZips!.set(j.journeyId, z.map((n) => `traces/${n}`));
    }
  }
  // Time-travel traces: heal notes, requests, console and DOM snapshots per step.
  if (existsSync(join(runDir, TRACE_ROOT)) && run.journeys.length <= 2000) {
    const source = runDirSource(runDir);
    let snapBudget = o.snapshotBudget ?? 8_000_000;
    const order = [...run.journeys].sort((a, b) => Number(failing.has(b.journeyId)) - Number(failing.has(a.journeyId)));
    for (const j of order) {
      let t: Awaited<ReturnType<typeof readTrace>>;
      try {
        t = await readTrace(runDir, j.journeyId, j.attempt);
      } catch {
        continue;
      }
      const t0 = Date.parse(j.startedAt);
      const rel = (iso: string) => {
        const at = Date.parse(iso);
        return Number.isFinite(at) && Number.isFinite(t0) ? Math.max(0, at - t0) : 0;
      };
      const stepIdOf = new Map(t.steps.map((s) => [s.index, s.stepId]));
      const steps = new Map<string, { notes?: string[]; sn?: { b?: string; a?: string } }>();
      const failed = failing.has(j.journeyId);
      for (const s of t.steps) {
        const entry = steps.get(s.stepId) ?? {};
        if (s.heal?.notes?.length) entry.notes = s.heal.notes.slice(0, 8);
        for (const phase of ['before', 'after'] as const) {
          const ref = s.snapshots?.[phase];
          if (!ref || snapBudget <= 0) continue;
          // Failing tests get every step; passing ones only the after-snapshots while the budget lasts.
          if (!failed && phase === 'before') continue;
          try {
            const html = await renderSnapshot(source, t, ref, { highlight: true });
            if (html.length > 900_000) continue;
            const key = `${out.snapshots!.size + 1}`;
            out.snapshots!.set(key, html);
            snapBudget -= html.length;
            entry.sn = { ...entry.sn, [phase === 'before' ? 'b' : 'a']: key };
          } catch {
            // a missing snapshot file: the step shows no snapshot
          }
        }
        steps.set(s.stepId, entry);
      }
      const network = t.steps.flatMap((s) => s.network.map((n) => ({
        m: n.method, u: maskUrl(n.url), ...(n.status !== undefined ? { s: n.status } : {}), st: rel(n.startedAt), ...(n.durationMs !== undefined ? { d: n.durationMs } : {}),
        ...(n.sizes ? { sz: n.sizes.responseBody } : {}), ...(n.resourceType ? { ty: n.resourceType } : {}), ...(n.mimeType ? { mime: n.mimeType } : {}), ...(n.failure ? { f: n.failure } : {}),
        ...(stepIdOf.get(n.stepIndex) ? { stepId: stepIdOf.get(n.stepIndex) } : {}), ...(n.requestHeaders ? { rq: maskHeaders(n.requestHeaders) } : {}), ...(n.responseHeaders ? { rs: maskHeaders(n.responseHeaders) } : {}), ...(n.timing ? { w: n.timing } : {}),
      }))).sort((a, b) => a.st - b.st);
      const consoleEntries = t.steps.flatMap((s) => s.console.map((c) => ({ l: c.type, t: c.text.slice(0, 1000), at: rel(c.at), ...(stepIdOf.get(c.stepIndex) ? { stepId: stepIdOf.get(c.stepIndex) } : {}), ...(c.location ? { loc: c.location } : {}) })));
      out.traces!.set(j.journeyId, { steps, network, console: consoleEntries, dir: `${TRACE_ROOT}/${traceDirName(j.journeyId, j.attempt)}` });
    }
  }
  return out;
}

const vttTime = (t: string): number => {
  const p = t.trim().split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
};

/** Cues of a WebVTT file: [start s, end s, text]. */
export function parseVttCues(vtt: string): Array<[number, number, string]> {
  const out: Array<[number, number, string]> = [];
  for (const block of vtt.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const text = lines.slice(i + 1).join(' ').trim();
    if (text) out.push([vttTime(a), vttTime(b.trim().split(/\s/)[0]), text.slice(0, 300)]);
  }
  return out.slice(0, 500);
}

function exportsOf(formats: ReportFormat[]): Array<{ label: string; href: string }> {
  const x: Array<{ label: string; href: string }> = [];
  if (formats.includes('json')) x.push({ label: 'JSON (report.json)', href: REPORT_FILES.json });
  if (formats.includes('junit')) x.push({ label: 'JUnit XML', href: REPORT_FILES.junit });
  if (formats.includes('csv')) x.push({ label: 'CSV of tests', href: REPORT_FILES.csv });
  if (formats.includes('summary')) x.push({ label: 'One-page summary (PDF-ready)', href: REPORT_FILES.summary });
  if (formats.includes('pdf')) x.push({ label: 'PDF report', href: REPORT_FILES.pdf });
  if (formats.includes('xlsx')) x.push({ label: 'Excel workbook', href: REPORT_FILES.xlsx });
  if (formats.includes('email')) x.push({ label: 'E-mail summary (HTML)', href: REPORT_FILES.email });
  return x;
}

/** Formats written for a request: the HTML report always brings its CSV, one-page summary, e-mail summary, Excel workbook and PDF. */
export function expandFormats(formats: ReportFormat[]): ReportFormat[] {
  const set = new Set(formats);
  if (set.has('html')) {
    for (const f of ['csv', 'summary', 'email', 'xlsx', 'pdf'] as const) set.add(f);
  }
  return REPORT_FORMATS.filter((f) => set.has(f));
}

async function writeModelOutputs(runDir: string, model: ReportModel, formats: ReportFormat[], run: RunResult | undefined, insights: ReportInsights | undefined, out: Partial<Record<ReportFormat, string>>): Promise<void> {
  const exportsList = exportsOf(formats);
  const large = model.tests.length > 2000;
  for (const f of formats) {
    const path = join(runDir, REPORT_FILES[f]);
    let content: string | Buffer;
    if (f === 'html') content = renderReportModelHtml(model, { exports: exportsList });
    else if (f === 'email') content = renderEmailHtml(model);
    else if (f === 'xlsx') content = await renderReportXlsx(model);
    else if (f === 'pdf') content = renderReportPdf(model, { runDir });
    else if (f === 'json') {
      let doc: JsonReport;
      if (run) doc = buildJsonReport(run, insights, model);
      else {
        const prev = JSON.parse(await readFile(path, 'utf8')) as JsonReport;
        doc = { ...prev, version: 2, generatedAt: new Date().toISOString(), model };
      }
      content = large ? JSON.stringify(doc) : JSON.stringify(doc, null, 2);
    } else if (f === 'junit') {
      if (!run) continue;
      content = renderJUnit(run, insights ?? {});
    } else if (f === 'csv') content = renderTestsCsv(model);
    else content = renderSummaryHtml(model);
    await writeFile(path, content);
    out[f] = path;
  }
  await writeFile(join(runDir, REPORT_MODEL_FILE), JSON.stringify(model));
}

/**
 * Write the requested reports into the run directory (so the HTML report's
 * relative evidence links resolve). The evidence manifest, the run context
 * and integrations.json are read from the run directory when not supplied.
 * The HTML report also writes tests.csv and summary.html. Returns the
 * written paths per format.
 */
export async function writeReports(runDir: string, run: RunResult, opts: WriteReportsOptions): Promise<Partial<Record<ReportFormat, string>>> {
  if (!opts.formats || opts.formats.length === 0) throw new EzTestError('writeReports: no formats requested', 'INVALID_INPUT');
  for (const f of opts.formats) if (!REPORT_FORMATS.includes(f)) throw new NotSupportedError(`report format "${String(f)}"`);
  if (!run || run.journeys.length === 0) throw new EzTestError('writeReports: run has no journeys', 'INVALID_INPUT');
  await mkdir(runDir, { recursive: true });
  const evidence = opts.evidence ?? (await readEvidenceManifest(runDir));
  const context = opts.context ?? (await loadOrCaptureContext(runDir, run, opts.env));
  const integrations = opts.integrations ?? (await readIntegrations(runDir));
  const artifacts = opts.artifacts ?? (await collectStepArtifacts(runDir, run, evidence));
  const extraHtml = [...(opts.extraHtml ?? []), ...(opts.apiCoverage ?? []).map(apiCoverageHtml)];
  const model = buildReportModel(run, { ...opts, evidence, context, integrations, artifacts, extraHtml });
  const features = featuresBlock(run);
  if (features) model.featuresHtml = features;
  const formats = expandFormats([...new Set(opts.formats)]);
  const out: Partial<Record<ReportFormat, string>> = {};
  const insights: ReportInsights = { triage: opts.triage, readiness: opts.readiness, flaky: opts.flaky, evidence, apiCoverage: opts.apiCoverage };
  await writeModelOutputs(runDir, model, formats, run, insights, out);
  return out;
}

/**
 * Render the reports of a run directory again from its saved model, with the
 * links of integrations.json (written by the Azure DevOps, Jira, Slack/Teams,
 * PR and results-server publishers). Only the files that exist are rewritten.
 */
export async function rerenderReports(runDir: string): Promise<Partial<Record<ReportFormat, string>>> {
  const p = join(runDir, REPORT_MODEL_FILE);
  if (!existsSync(p)) return {};
  const model = JSON.parse(await readFile(p, 'utf8')) as ReportModel;
  const integrations = await readIntegrations(runDir);
  applyIntegrationLinks(model, { integrations, ...model.linkConfig });
  model.generatedAt = new Date().toISOString();
  const formats = REPORT_FORMATS.filter((f) => f !== 'junit' && existsSync(join(runDir, REPORT_FILES[f])));
  const out: Partial<Record<ReportFormat, string>> = {};
  // The export menu lists every companion file that is there.
  const all = REPORT_FORMATS.filter((f) => existsSync(join(runDir, REPORT_FILES[f])));
  const exportsList = exportsOf(all);
  for (const f of formats) {
    const path = join(runDir, REPORT_FILES[f]);
    let content: string | Buffer;
    if (f === 'html') content = renderReportModelHtml(model, { exports: exportsList });
    else if (f === 'email') content = renderEmailHtml(model);
    else if (f === 'xlsx') content = await renderReportXlsx(model);
    else if (f === 'pdf') content = renderReportPdf(model, { runDir });
    else if (f === 'json') {
      const prev = JSON.parse(await readFile(path, 'utf8')) as JsonReport;
      content = JSON.stringify({ ...prev, version: 2, generatedAt: model.generatedAt, model }, null, model.tests.length > 2000 ? undefined : 2);
    } else if (f === 'csv') content = renderTestsCsv(model);
    else content = renderSummaryHtml(model);
    await writeFile(path, content);
    out[f] = path;
  }
  await writeFile(p, JSON.stringify(model));
  return out;
}

/** The saved model of a run directory (report-model.json, else report.json's model). */
export async function readReportModel(runDir: string): Promise<ReportModel | undefined> {
  for (const f of [REPORT_MODEL_FILE, REPORT_FILES.json]) {
    const p = join(runDir, f);
    if (!existsSync(p)) continue;
    const v = JSON.parse(await readFile(p, 'utf8')) as ReportModel | JsonReport;
    if ((v as ReportModel).format === 'eztest-report-model') return v as ReportModel;
    if ((v as JsonReport).model) return (v as JsonReport).model;
  }
  return undefined;
}
