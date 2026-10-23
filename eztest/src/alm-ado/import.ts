/**
 * Import manual test cases from Azure Test Plans into `.ez` journeys.
 *
 * Source: a plan (every suite), a suite (optionally with its child suites),
 * a WIQL query or saved query, or explicit test case ids. For each test case
 * the steps (with shared steps expanded in place), expected results
 * (post-conditions of their step), parameters (an `Examples:` table, shared
 * parameter sets resolved), tags, priority and the requirements it tests are
 * read. Every line goes through the real EZ grammar; a line it cannot read is
 * kept as `# TODO (not converted): ...` with a link back to the test case and
 * step, so nothing is silently dropped.
 */
import { slugify } from '../core/index.js';
import { JourneyDraft } from '../importers/builder.js';
import type { ConvertedJourney, ImportReport, TodoItem } from '../importers/types.js';
import { emptyCoverage } from '../importers/types.js';
import { parseEzScript } from '../intent/index.js';
import type { AdoClient } from './client.js';
import { adoParamsToEz, parseSharedParameterSet, parseStepsXml, parseTestCaseParameters, type TcItem } from './steps.js';
import { getWorkItems, relationId, wiqlIds, workItemWebUrl, wiqlString, type WorkItem } from './workitems.js';

export interface ImportSource {
  planId?: number;
  suiteId?: number;
  /** Include the suite's child suites (default true for a plan without suite). */
  recursive?: boolean;
  wiql?: string;
  savedQuery?: string;
  ids?: number[];
}

export interface AdoImportOptions {
  client: AdoClient;
  source: ImportSource;
  /** Journey ids already taken (e.g. files on disk). */
  ids?: Set<string>;
  /** Extra tags for every journey. */
  tags?: string[];
  /** Add @TestPlanId / @TestSuiteId tags from the source (default true when the source is a suite). */
  planTags?: boolean;
  /** Mark lines read from free text with [unverified] until a replay passes (default true). */
  markUnverified?: boolean;
  /** manual: import as manual test cases (`Manual:` steps, run in Studio); hybrid: automate what the grammar reads, keep the rest manual. */
  manualMode?: 'automated' | 'manual' | 'hybrid';
}

interface Suite {
  id: number;
  name: string;
  parentSuite?: { id: number };
}

const F = {
  title: 'System.Title',
  type: 'System.WorkItemType',
  tags: 'System.Tags',
  steps: 'Microsoft.VSTS.TCM.Steps',
  params: 'Microsoft.VSTS.TCM.Parameters',
  data: 'Microsoft.VSTS.TCM.LocalDataSource',
  priority: 'Microsoft.VSTS.Common.Priority',
  area: 'System.AreaPath',
  description: 'System.Description',
};

const PRIORITY_RISK: Record<number, number> = { 1: 5, 2: 4, 3: 3, 4: 2 };

/** Test case ids (in order) a source names, with the suite each came from. */
export async function testCaseIdsOf(c: AdoClient, s: ImportSource): Promise<Array<{ id: number; planId?: number; suiteId?: number }>> {
  if (s.ids?.length) return s.ids.map((id) => ({ id, planId: s.planId, suiteId: s.suiteId }));
  if (s.wiql || s.savedQuery) {
    const ids = await wiqlIds(c, { wiql: s.wiql, savedQuery: s.savedQuery });
    return ids.map((id) => ({ id }));
  }
  if (!s.planId) throw new Error('ADO import: give a plan (and suite), a WIQL query, a saved query or test case ids');
  let suites: number[];
  if (s.suiteId && s.recursive === false) suites = [s.suiteId];
  else {
    const all = await c.getAll<Suite>(`/_apis/testplan/Plans/${s.planId}/suites`);
    if (!s.suiteId) suites = all.map((x) => x.id);
    else {
      const under = new Set([s.suiteId]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const x of all) if (x.parentSuite && under.has(x.parentSuite.id) && !under.has(x.id)) (under.add(x.id), (grew = true));
      }
      suites = all.map((x) => x.id).filter((id) => under.has(id));
      if (!suites.includes(s.suiteId)) suites.unshift(s.suiteId);
    }
  }
  const out: Array<{ id: number; planId?: number; suiteId?: number }> = [];
  const seen = new Set<number>();
  for (const suiteId of suites) {
    const cases = await c.getAll<{ workItem: { id: number } }>(`/_apis/testplan/Plans/${s.planId}/Suites/${suiteId}/TestCase`);
    for (const tc of cases) {
      if (seen.has(tc.workItem.id)) continue;
      seen.add(tc.workItem.id);
      out.push({ id: tc.workItem.id, planId: s.planId, suiteId });
    }
  }
  return out;
}

function str(w: WorkItem, f: string): string {
  const v = w.fields[f];
  return v === undefined || v === null ? '' : String(v);
}

export async function importTestCases(o: AdoImportOptions): Promise<ImportReport> {
  const c = o.client;
  const refs = await testCaseIdsOf(c, o.source);
  const warnings: string[] = [];
  const items = await getWorkItems(c, refs.map((r) => r.id), { relations: true });
  const cases = items.filter((w) => {
    const t = str(w, F.type);
    if (t && t !== 'Test Case') {
      warnings.push(`work item ${w.id} is a ${t}, not a Test Case; skipped`);
      return false;
    }
    return true;
  });
  // Shared steps and shared parameter sets referenced by the cases, fetched once.
  const parsed = new Map<number, TcItem[]>(cases.map((w) => [w.id, parseStepsXml(str(w, F.steps))]));
  const sharedIds = [...new Set([...parsed.values()].flat().filter((i): i is Extract<TcItem, { kind: 'shared' }> => i.kind === 'shared').map((i) => i.ref))];
  const shared = new Map((await getWorkItems(c, sharedIds, { fields: [F.title, F.steps, F.params] })).map((w) => [w.id, w]));
  const params = new Map(cases.map((w) => [w.id, parseTestCaseParameters(str(w, F.params), str(w, F.data))]));
  const setIds = [...new Set([...params.values()].flatMap((p) => p.sharedSetIds ?? []))];
  const sets = new Map((await getWorkItems(c, setIds, { fields: [F.title, F.params] })).map((w) => [w.id, parseSharedParameterSet(str(w, F.params))]));

  const ids = o.ids ?? new Set<string>();
  const converted: ConvertedJourney[] = [];
  const todo: TodoItem[] = [];
  let coverage = emptyCoverage();
  for (const w of cases) {
    const ref = refs.find((r) => r.id === w.id)!;
    const url = workItemWebUrl(c, w.id);
    const p = params.get(w.id)!;
    // Shared parameters: rows of every referenced set, mapped to the local names.
    let rows = p.rows;
    if (p.sharedSetIds?.length) {
      rows = [];
      for (const sid of p.sharedSetIds) {
        const set = sets.get(sid);
        if (!set) {
          warnings.push(`test case ${w.id}: shared parameter set ${sid} not found`);
          continue;
        }
        for (const r of set.rows) {
          const row: Record<string, string> = {};
          for (const n of p.names) row[n] = r[p.sharedMap?.[n] ?? n] ?? '';
          rows.push(row);
        }
      }
    }
    const names = p.names.length ? p.names : Object.keys(rows[0] ?? {});
    const tags = [
      `TestCaseId:${w.id}`,
      ...((o.planTags ?? !!ref.suiteId) && ref.planId ? [`TestPlanId:${ref.planId}`] : []),
      ...((o.planTags ?? !!ref.suiteId) && ref.suiteId ? [`TestSuiteId:${ref.suiteId}`] : []),
      ...str(w, F.tags).split(';').map((t) => t.trim()).filter(Boolean),
      ...(o.tags ?? []),
    ];
    const requirements = (w.relations ?? []).filter((r) => r.rel === 'Microsoft.VSTS.Common.TestedBy-Reverse').map((r) => relationId(r.url)).filter((x): x is number => !!x).map(String);
    const prio = Number(str(w, F.priority));
    const name = str(w, F.title);
    const d = new JourneyDraft(name || `Test case ${w.id}`, {
      kind: 'ado-test-plans',
      file: url,
      line: 1,
      ids,
      tags,
      id: slugify(name || `test-case-${w.id}`),
      description: `Imported from Azure Test Plans test case #${w.id} (${url})`,
      ...(requirements.length ? { requirements } : {}),
      ...(PRIORITY_RISK[prio] ? { risk: PRIORITY_RISK[prio] } : {}),
      markUnverified: o.manualMode === 'manual' ? false : o.markUnverified ?? true,
      ...(o.manualMode ? { manualMode: o.manualMode } : {}),
    });
    let n = 0;
    const addStep = (s: Extract<TcItem, { kind: 'step' }>, where: string) => {
      n++;
      const lines = adoParamsToEz(s.action, names).split('\n').filter((l) => l.trim());
      for (const line of lines) {
        const src = { line: n, original: `${line} (test case #${w.id} ${where}: ${url})` };
        try {
          d.english(line, src);
        } catch (e) {
          d.addTodo(src, `conversion error: ${(e as Error).message}`);
        }
      }
      for (const line of adoParamsToEz(s.expected, names).split('\n').filter((l) => l.trim())) {
        const body = line.replace(/^(?:verify|expect|check|ensure|confirm)\s+(?:that\s+)?/i, '').replace(/[.;]+$/, '');
        d.expect(body, { line: n, original: `Expected: ${line} (test case #${w.id} ${where}: ${url})` });
      }
    };
    let index = 0;
    for (const it of parsed.get(w.id) ?? []) {
      index++;
      if (it.kind === 'step') addStep(it, `step ${index}`);
      else {
        const sw = shared.get(it.ref);
        if (!sw) {
          d.addTodo({ line: index, original: `Shared steps #${it.ref} could not be read (test case #${w.id} step ${index}: ${url})` }, 'shared steps not found');
          continue;
        }
        d.comment(`Shared steps #${it.ref}: ${str(sw, F.title)} (${workItemWebUrl(c, it.ref)})`);
        let k = 0;
        for (const ss of parseStepsXml(str(sw, F.steps))) if (ss.kind === 'step') addStep(ss, `step ${index}.${++k} (shared steps #${it.ref})`);
      }
    }
    let cj = d.finish();
    if (rows.length && names.length && cj.ez) {
      // Parameters become an inline Examples table (one journey run per row).
      const cell = (v: string) => v.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || ' ';
      const table = ['', 'Examples:', `  | ${names.join(' | ')} |`, ...rows.map((r) => `  | ${names.map((x) => cell(r[x] ?? '')).join(' | ')} |`)].join('\n');
      const ez = cj.ez.trimEnd() + '\n' + table + '\n';
      try {
        cj = { ...cj, ez, journey: cj.journey ? parseEzScript(ez, { source: url }) : undefined };
      } catch (e) {
        warnings.push(`test case ${w.id}: parameters not added as Examples: ${(e as Error).message}`);
      }
    }
    if (!(parsed.get(w.id) ?? []).length) warnings.push(`test case ${w.id} has no steps`);
    warnings.push(...d.warnings);
    converted.push(cj);
    todo.push(...cj.todo);
    coverage = {
      sourceSteps: coverage.sourceSteps + cj.coverage.sourceSteps,
      convertedSteps: coverage.convertedSteps + cj.coverage.convertedSteps,
      assertions: coverage.assertions + cj.coverage.assertions,
      convertedAssertions: coverage.convertedAssertions + cj.coverage.convertedAssertions,
    };
  }
  return {
    journeys: converted.flatMap((x) => (x.journey ? [x.journey] : [])),
    converted,
    todo,
    warnings,
    coverage,
    files: cases.map((w) => workItemWebUrl(c, w.id)),
    summary: { source: o.source, testCases: cases.length, sharedSteps: sharedIds.length, sharedParameterSets: setIds.length },
  };
}

/** WIQL for test cases by area and/or tag (for `--area` / `--tag` imports). */
export function testCaseWiql(o: { area?: string; tag?: string; state?: string }): string {
  const where = ["[System.TeamProject] = @project", "[System.WorkItemType] = 'Test Case'"];
  if (o.area) where.push(`[System.AreaPath] UNDER '${wiqlString(o.area)}'`);
  if (o.tag) where.push(`[System.Tags] CONTAINS '${wiqlString(o.tag)}'`);
  if (o.state) where.push(`[System.State] = '${wiqlString(o.state)}'`);
  return `SELECT [System.Id] FROM WorkItems WHERE ${where.join(' AND ')} ORDER BY [System.Id]`;
}
