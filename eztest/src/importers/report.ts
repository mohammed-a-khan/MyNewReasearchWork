/** Assembling and merging ImportReports. */
import type { JourneyDraft } from './builder.js';
import { addCoverage, emptyCoverage, type ConvertedJourney, type ImportReport, type TodoItem } from './types.js';

/** Build a report from finished drafts plus file-level TODOs/warnings. */
export function assembleReport(drafts: JourneyDraft[], files: string[], warnings: string[] = [], fileTodos: TodoItem[] = []): ImportReport {
  const converted: ConvertedJourney[] = [];
  const allWarnings = [...warnings];
  for (const d of drafts) {
    const cj = d.finish();
    converted.push(cj);
    allWarnings.push(...d.warnings);
  }
  return fromConverted(converted, files, allWarnings, fileTodos);
}

function fromConverted(converted: ConvertedJourney[], files: string[], warnings: string[], fileTodos: TodoItem[]): ImportReport {
  let coverage = emptyCoverage();
  const todo: TodoItem[] = [...fileTodos];
  for (const c of converted) {
    coverage = addCoverage(coverage, c.coverage);
    todo.push(...c.todo);
  }
  for (const t of fileTodos) {
    // File-level TODOs (e.g. a file that could not be read) count as unconverted source steps.
    if (!t.journeyId) coverage.sourceSteps++;
  }
  return {
    journeys: converted.flatMap((c) => (c.journey ? [c.journey] : [])),
    converted,
    todo,
    warnings,
    coverage,
    files,
  };
}

/** Merge several reports into one (journey ids are expected to be unique already). */
export function mergeReports(reports: ImportReport[]): ImportReport {
  const converted = reports.flatMap((r) => r.converted);
  const fileTodos = reports.flatMap((r) => r.todo.filter((t) => !t.journeyId));
  const merged = fromConverted(converted, [...new Set(reports.flatMap((r) => r.files))], reports.flatMap((r) => r.warnings), []);
  merged.todo = [...fileTodos, ...merged.todo];
  merged.coverage.sourceSteps += fileTodos.length;
  const diagnostics = reports.flatMap((r) => r.diagnostics ?? []);
  if (diagnostics.length) merged.diagnostics = diagnostics;
  const assets = reports.flatMap((r) => r.assets ?? []);
  if (assets.length) merged.assets = assets;
  const summaries = reports.filter((r) => r.summary);
  if (summaries.length) merged.summary = Object.assign({}, ...summaries.map((r) => r.summary));
  const markdown = reports.flatMap((r) => r.markdown ?? []);
  if (markdown.length) merged.markdown = markdown;
  return merged;
}
