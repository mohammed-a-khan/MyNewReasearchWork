import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunResult } from '../core/index.js';
import { EzTestError, NotSupportedError } from '../core/index.js';
import { readEvidenceManifest } from '../insights/index.js';
import { renderHtmlReport } from './html.js';
import { buildJsonReport } from './json.js';
import { renderJUnit } from './junit.js';
import type { ReportInsights } from './model.js';
import { largeReportThreshold, renderLargeHtmlReport } from '../scale/report.js';

export type ReportFormat = 'html' | 'json' | 'junit';
export const REPORT_FORMATS: ReportFormat[] = ['html', 'json', 'junit'];

export const REPORT_FILES: Record<ReportFormat, string> = {
  html: 'report.html',
  json: 'report.json',
  junit: 'junit.xml',
};

export interface WriteReportsOptions extends ReportInsights {
  formats: ReportFormat[];
  title?: string;
}

/**
 * Write the requested reports into the run directory (so the HTML report's
 * relative screenshot links resolve). The evidence manifest is read from the
 * run directory when not supplied. Returns the written paths per format.
 */
export async function writeReports(runDir: string, run: RunResult, opts: WriteReportsOptions): Promise<Partial<Record<ReportFormat, string>>> {
  if (!opts.formats || opts.formats.length === 0) throw new EzTestError('writeReports: no formats requested', 'INVALID_INPUT');
  for (const f of opts.formats) if (!REPORT_FORMATS.includes(f)) throw new NotSupportedError(`report format "${String(f)}"`);
  if (!run || run.journeys.length === 0) throw new EzTestError('writeReports: run has no journeys', 'INVALID_INPUT');
  await mkdir(runDir, { recursive: true });
  const insights: ReportInsights = { ...opts, evidence: opts.evidence ?? (await readEvidenceManifest(runDir)) };
  const out: Partial<Record<ReportFormat, string>> = {};
  for (const f of [...new Set(opts.formats)]) {
    const path = join(runDir, REPORT_FILES[f]);
    let content: string;
    // Large runs get the virtualised report (src/scale/report.ts); the full report would be tens of MB.
    if (f === 'html') content = run.journeys.length > largeReportThreshold() ? renderLargeHtmlReport(run, { ...insights, title: opts.title }) : renderHtmlReport(run, { ...insights, title: opts.title });
    else if (f === 'json') content = JSON.stringify(buildJsonReport(run, insights), null, 2);
    else content = renderJUnit(run, insights);
    await writeFile(path, content);
    out[f] = path;
  }
  return out;
}
