import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
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
import { applyIntegrationLinks, buildReportModel, type ReportModel, type ReportModelInput, type StepArtifacts } from './data.js';
import { loadOrCaptureContext } from './context.js';
import { readIntegrations } from './integrations.js';
import type { ReportInsights } from './model.js';

export type ReportFormat = 'html' | 'json' | 'junit' | 'csv' | 'summary';
export const REPORT_FORMATS: ReportFormat[] = ['html', 'json', 'junit', 'csv', 'summary'];

export const REPORT_FILES: Record<ReportFormat, string> = {
  html: 'report.html',
  json: 'report.json',
  junit: 'junit.xml',
  csv: 'tests.csv',
  summary: 'summary.html',
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

/**
 * API exchanges per step (api/... network evidence), and the browser network log and console of
 * failing journeys, for the test details. Bounded: at most `maxFiles` files are read.
 */
export async function collectStepArtifacts(runDir: string, run: RunResult, evidence: EvidenceRef[], o: { maxFiles?: number } = {}): Promise<StepArtifacts> {
  const out: StepArtifacts = { api: new Map(), network: new Map(), console: new Map(), chapters: new Map() };
  const failing = new Set(run.journeys.filter((j) => j.status === 'failed' || j.status === 'error' || j.attempt > 1).map((j) => j.journeyId));
  let budget = o.maxFiles ?? 4000;
  for (const ev of evidence) {
    if (budget <= 0) break;
    const isApi = ev.kind === 'network' && ev.path.startsWith('api/') && ev.stepId && ev.journeyId;
    const isNet = ev.kind === 'network' && /(^|\/)network\.json$/.test(ev.path) && ev.journeyId && failing.has(ev.journeyId);
    const isCon = ev.kind === 'console' && ev.journeyId && failing.has(ev.journeyId);
    const isVtt = ev.kind === 'video-chapters' && ev.journeyId;
    if (!isApi && !isNet && !isCon && !isVtt) continue;
    const abs = inside(runDir, ev.path);
    if (!abs || !existsSync(abs)) continue;
    budget--;
    try {
      if (isVtt) {
        out.chapters!.set(ev.journeyId!, parseVttCues(await readFile(abs, 'utf8')));
        continue;
      }
      const raw = JSON.parse(await readFile(abs, 'utf8')) as unknown;
      if (isCon) {
        const list = Array.isArray(raw) ? (raw as Array<{ type?: string; text?: string }>) : [];
        const lines = list.filter((c) => c && (c.type === 'error' || c.type === 'warning' || c.type === 'warn')).map((c) => `[${c.type}] ${String(c.text ?? '').slice(0, 500)}`);
        if (lines.length) out.console.set(ev.journeyId!, [...(out.console.get(ev.journeyId!) ?? []), ...lines]);
        continue;
      }
      const entries: NetworkEntry[] = normalizeNetworkLog(raw);
      if (isApi) out.api.set(`${ev.journeyId}\u0000${ev.stepId}`, entries);
      else out.network.set(ev.journeyId!, [...(out.network.get(ev.journeyId!) ?? []), ...entries]);
    } catch {
      // unreadable evidence is reported by the evidence verifier, not here
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
  return x;
}

/** Formats written for a request: the HTML report always brings its CSV and one-page summary. */
export function expandFormats(formats: ReportFormat[]): ReportFormat[] {
  const set = new Set(formats);
  if (set.has('html')) {
    set.add('csv');
    set.add('summary');
  }
  return REPORT_FORMATS.filter((f) => set.has(f));
}

async function writeModelOutputs(runDir: string, model: ReportModel, formats: ReportFormat[], run: RunResult | undefined, insights: ReportInsights | undefined, out: Partial<Record<ReportFormat, string>>): Promise<void> {
  const exportsList = exportsOf(formats);
  const large = model.tests.length > 2000;
  for (const f of formats) {
    const path = join(runDir, REPORT_FILES[f]);
    let content: string;
    if (f === 'html') content = renderReportModelHtml(model, { exports: exportsList });
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
    let content: string;
    if (f === 'html') content = renderReportModelHtml(model, { exports: exportsList });
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
