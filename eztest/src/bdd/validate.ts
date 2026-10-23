/**
 * `eztest validate` for `.feature` files: parse, load the real step
 * definitions (their modules are imported, as when the scenario runs) and
 * bind every step: a definition, an EZTest phrasing, or a problem
 * (undefined, with a snippet; ambiguous, with the definitions that match).
 */
import { relative, sep } from 'node:path';
import type { Journey } from '../core/index.js';
import { ezFallback } from './fallback.js';
import { loadFeatureJourneys, loadGlue, type BddOptions } from './load.js';
import { matchStep } from './registry.js';
import { snippet } from './snippets.js';
import { validateExamplesSource } from '../runner/examples-source.js';

export interface FeatureProblem {
  severity: 'error' | 'warning';
  line?: number;
  message: string;
  snippet?: string;
}

export interface FeatureValidation {
  journeys: Journey[];
  problems: FeatureProblem[];
  /** Steps bound to a definition / to an EZTest phrasing. */
  bound: { definition: number; ez: number };
}

export async function validateFeature(file: string, o: BddOptions & { cwd?: string } = {}): Promise<FeatureValidation> {
  const cwd = o.cwd ?? process.cwd();
  const journeys = await loadFeatureJourneys(file, o);
  const problems: FeatureProblem[] = [];
  const bound = { definition: 0, ez: 0 };
  if (!journeys.length) return { journeys, problems: [{ severity: 'warning', message: 'no scenarios' }], bound };
  const glue = await loadGlue(journeys[0].bdd?.glue ?? [], { cwd });
  for (const e of glue.errors) problems.push({ severity: 'error', message: e });
  const seen = new Set<string>();
  // External Examples: the file exists and parses, the filter is valid, refers to known columns and matches rows.
  const sources = new Set<string>();
  for (const j of journeys) {
    if (!j.examplesFrom) continue;
    const key = JSON.stringify(j.examplesFrom);
    if (sources.has(key)) continue;
    sources.add(key);
    for (const i of await validateExamplesSource(j.examplesFrom, { baseDir: cwd })) {
      if (i.severity === 'info') continue;
      problems.push({ severity: i.severity, line: j.bdd?.examples?.line, message: `Examples: ${i.message}` });
    }
  }
  const show = (f: string) => relative(cwd, f).split(sep).join('/');
  for (const j of journeys) {
    for (const s of j.steps) {
      const a = (s.args ?? {}) as { type?: 'context' | 'action' | 'outcome'; docString?: { content: string }; dataTable?: string[][]; empty?: boolean };
      if (a.empty) continue;
      const text = s.value ?? '';
      const key = `${s.source?.line}\u0000${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = s.source?.line;
      // External Examples rows are read at run time: their <placeholders> are not bound here.
      if (/<[^<>]+>/.test(text) && j.examplesFrom) continue;
      const hits = matchStep(glue, text);
      if (hits.length > 1) {
        problems.push({ severity: 'error', ...(line ? { line } : {}), message: `ambiguous step "${text}": ${hits.map((h) => `${String(h.definition.pattern)} (${show(h.definition.file)}:${h.definition.line})`).join(', ')}` });
      } else if (hits.length === 1) {
        bound.definition++;
      } else if (j.bdd?.fallback !== false && ezFallback({ text, type: a.type ?? 'context', ...(a.docString ? { docString: a.docString } : {}), ...(a.dataTable ? { dataTable: a.dataTable } : {}) })) {
        bound.ez++;
      } else {
        const snip = snippet({ text, type: a.type ?? 'context', hasDataTable: !!a.dataTable, hasDocString: !!a.docString }, glue.params);
        problems.push({ severity: 'error', ...(line ? { line } : {}), message: `undefined step "${text}"`, snippet: snip });
      }
    }
  }
  return { journeys, problems, bound };
}
