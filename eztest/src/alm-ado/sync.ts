/**
 * Journeys -> Azure Test Plans test cases.
 *
 *  - Steps and expected results in ADO's format (an action per step, its
 *    expectations as the expected result; block steps keep their nesting as
 *    indented actions), `Examples:` rows as parameters and data;
 *  - associated automation (AutomatedTestName / Storage / Type / Id,
 *    AutomationStatus = Automated), so ADO lists the case as automated and
 *    pipeline results can be matched to it;
 *  - the test case id written back into the journey as `@TestCaseId:<id>`
 *    (planned as a diff first: nothing is written until the caller applies it);
 *  - requirements linked (Tests / Tested By) from the journey's `Requirements:`;
 *  - area and iteration paths from config (by tag or journey path).
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import YAML from 'yaml';
import type { Journey, Step } from '../core/index.js';
import { EzTestError } from '../core/index.js';
import { unifiedDiff, type DiffLine } from '../heal/apply.js';
import { globMatch } from '../insights/glob.js';
import { conditionToText, loadJourneyFile, stepToText } from '../intent/index.js';
import type { AdoClient } from './client.js';
import { addTestCasesToSuite } from './plans.js';
import { buildDataSourceXml, buildParametersXml, buildStepsXml, ezParamsToAdo } from './steps.js';
import { parseAdoTags } from './tags.js';
import { createWorkItem, getWorkItems, patchWorkItem, relationId, workItemApiUrl, workItemWebUrl } from './workitems.js';

export interface PathRule {
  tag?: string;
  journeys?: string;
  areaPath?: string;
  iterationPath?: string;
}

/** Area and iteration for a journey: the first rule whose tag or path glob matches, else the defaults. */
export function areaFor(j: { tags: string[]; path?: string }, rules: PathRule[], defaults: { areaPath?: string; iterationPath?: string } = {}): { areaPath?: string; iterationPath?: string } {
  for (const r of rules) {
    const tagHit = r.tag && j.tags.some((t) => t.replace(/^@/, '').toLowerCase() === r.tag!.replace(/^@/, '').toLowerCase());
    const pathHit = r.journeys && j.path && globMatch(r.journeys, j.path);
    if (tagHit || pathHit) return { areaPath: r.areaPath ?? defaults.areaPath, iterationPath: r.iterationPath ?? defaults.iterationPath };
  }
  return { ...defaults };
}

/** A stable GUID for a journey's automation (AutomatedTestId): same project + journey id -> same GUID. */
export function automatedTestId(project: string, journeyId: string): string {
  const h = createHash('sha1').update(`eztest:${project}:${journeyId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

export const automatedTestName = (journeyId: string) => `eztest.${journeyId}`;

/** Action / expected pairs for a journey (block children indented under their block, "End" closing it). */
export function journeyToAdoSteps(j: Journey): Array<{ action: string; expected: string; stepId: string }> {
  const names = Object.keys(j.examples?.[0] ?? {});
  const out: Array<{ action: string; expected: string; stepId: string }> = [];
  const walk = (steps: Step[], depth: number) => {
    for (const s of steps) {
      const indent = '  '.repeat(depth);
      const action = s.intent || stepToText(s);
      const expected = (s.postconditions ?? []).map((c) => {
        try {
          return conditionToText(c);
        } catch {
          return JSON.stringify(c);
        }
      });
      out.push({ action: ezParamsToAdo(indent + action, names), expected: ezParamsToAdo(expected.join('\n'), names), stepId: s.id });
      const kids = (s as Step & { steps?: Step[]; else?: Step[] }).steps;
      if (Array.isArray(kids) && kids.length) {
        walk(kids, depth + 1);
        const alt = (s as Step & { else?: Step[] }).else;
        if (Array.isArray(alt) && alt.length) {
          out.push({ action: `${indent}Otherwise`, expected: '', stepId: `${s.id}#else` });
          walk(alt, depth + 1);
        }
        out.push({ action: `${indent}End`, expected: '', stepId: `${s.id}#end` });
      }
    }
  };
  walk(j.steps, 0);
  return out;
}

export interface FileChange {
  path: string;
  before: string;
  after: string;
  diff: DiffLine[];
  unified: string;
}

export function fileChange(path: string, before: string, after: string): FileChange {
  const diff = unifiedDiff(before, after);
  const unified = [`--- a/${path}`, `+++ b/${path}`, ...diff.map((d) => `${d.kind}${d.text}`)].join('\n') + '\n';
  return { path, before, after, diff, unified };
}

/** Add `@TestCaseId:<id>` to a journey's text (the Tags header of .ez; the tags list of YAML/JSON). */
export function addTestCaseTag(path: string, text: string, id: number): string {
  const tag = `TestCaseId:${id}`;
  const ext = extname(path).toLowerCase();
  if (ext === '.ez') {
    const lines = text.split('\n');
    const tagsAt = lines.findIndex((l) => /^\s*tags\s*:/i.test(l));
    if (tagsAt >= 0) {
      if (new RegExp(`@?TestCaseId\\s*[:=]\\s*${id}\\b`, 'i').test(lines[tagsAt])) return text;
      const m = /^(.*?)(\s+#.*)?$/.exec(lines[tagsAt])!;
      lines[tagsAt] = `${m[1].trimEnd()} @${tag}${m[2] ?? ''}`;
      return lines.join('\n');
    }
    // Insert after the last header line of the leading header block.
    let at = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l || l.startsWith('#')) {
        if (at) break;
        continue;
      }
      if (/^[A-Za-z][A-Za-z ]*:\s*/.test(l) && !/^(?:expect|verify|assert|check)\b/i.test(l)) at = i + 1;
      else break;
    }
    lines.splice(at, 0, `Tags: @${tag}`);
    return lines.join('\n');
  }
  if (ext === '.json') {
    const j = JSON.parse(text) as { tags?: string[] };
    const tags = j.tags ?? [];
    if (tags.some((t) => parseAdoTags([t]).testCaseIds.includes(id))) return text;
    j.tags = [...tags, tag];
    return JSON.stringify(j, null, 2) + '\n';
  }
  const doc = YAML.parseDocument(text);
  const tags = doc.get('tags') as YAML.YAMLSeq | undefined;
  if (tags && YAML.isSeq(tags)) {
    if (tags.items.some((t) => parseAdoTags([String(YAML.isScalar(t) ? t.value : t)]).testCaseIds.includes(id))) return text;
    tags.add(tag);
  } else doc.set('tags', [tag]);
  return doc.toString();
}

export interface SyncJourneyFile {
  /** Absolute path. */
  path: string;
  /** Repository- or project-relative path (AutomatedTestStorage, area rules). */
  rel: string;
}

export interface SyncOptions {
  client: AdoClient;
  files: SyncJourneyFile[];
  planId?: number;
  suiteId?: number;
  configurationIds?: number[];
  areaPath?: string;
  iterationPath?: string;
  paths?: PathRule[];
  /** Update test cases that already exist (default true). */
  update?: boolean;
  /** Only plan: no ADO writes, no file writes (the diffs are returned). */
  dryRun?: boolean;
  /** Write the @TestCaseId tags into the journey files (default false: return the diffs). */
  writeBack?: boolean;
  /** Link requirements named in `Requirements:` (numeric ids) as Tested By (default true). */
  linkRequirements?: boolean;
}

export interface SyncItem {
  file: string;
  journeyId: string;
  testCaseId?: number;
  url?: string;
  action: 'created' | 'updated' | 'unchanged' | 'would-create' | 'would-update' | 'error';
  changedFields?: string[];
  change?: FileChange;
  linkedRequirements?: number[];
  error?: string;
}

const AUTOMATION_FIELDS = ['Microsoft.VSTS.TCM.AutomatedTestName', 'Microsoft.VSTS.TCM.AutomatedTestStorage', 'Microsoft.VSTS.TCM.AutomatedTestType', 'Microsoft.VSTS.TCM.AutomatedTestId', 'Microsoft.VSTS.TCM.AutomationStatus'];

/** The test case fields a journey maps to. */
export function testCaseFields(j: Journey, o: { project: string; rel: string; areaPath?: string; iterationPath?: string }): Record<string, string> {
  const steps = journeyToAdoSteps(j);
  const names = Object.keys(j.examples?.[0] ?? {});
  const tags = j.tags.filter((t) => !/^@?(TestCaseId|TestPlanId|TestSuiteId)\s*[:=]/i.test(t)).map((t) => t.replace(/^@/, ''));
  const f: Record<string, string> = {
    'System.Title': j.name.slice(0, 255),
    'Microsoft.VSTS.TCM.Steps': buildStepsXml(steps.map((s) => ({ action: s.action, expected: s.expected }))),
    'System.Tags': ['eztest', ...tags].join('; '),
    'Microsoft.VSTS.TCM.AutomatedTestName': automatedTestName(j.id),
    'Microsoft.VSTS.TCM.AutomatedTestStorage': o.rel,
    'Microsoft.VSTS.TCM.AutomatedTestType': 'EZTest',
    'Microsoft.VSTS.TCM.AutomatedTestId': automatedTestId(o.project, j.id),
    'Microsoft.VSTS.TCM.AutomationStatus': 'Automated',
  };
  if (j.description) f['System.Description'] = `<p>${j.description.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`;
  if (names.length) {
    f['Microsoft.VSTS.TCM.Parameters'] = buildParametersXml(names);
    f['Microsoft.VSTS.TCM.LocalDataSource'] = buildDataSourceXml(names, j.examples ?? []);
  }
  if (o.areaPath) f['System.AreaPath'] = o.areaPath;
  if (o.iterationPath) f['System.IterationPath'] = o.iterationPath;
  if (j.risk && j.risk !== 3) f['Microsoft.VSTS.Common.Priority'] = String(({ 5: 1, 4: 2, 3: 3, 2: 4, 1: 4 } as Record<number, number>)[j.risk] ?? 3);
  return f;
}

function normalizeField(v: unknown): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

export async function syncJourneys(o: SyncOptions): Promise<{ items: SyncItem[]; warnings: string[] }> {
  const c = o.client;
  const items: SyncItem[] = [];
  const warnings: string[] = [];
  const created: number[] = [];
  const all: number[] = [];
  for (const file of o.files) {
    let j: Journey;
    let text: string;
    try {
      text = await readFile(file.path, 'utf8');
      j = await loadJourneyFile(file.path);
    } catch (e) {
      items.push({ file: file.rel, journeyId: '', action: 'error', error: (e as Error).message });
      continue;
    }
    if (j.tags.includes('library') || j.tags.includes('@library')) {
      warnings.push(`${file.rel}: @library journeys are not test cases; skipped`);
      continue;
    }
    const tcIds = parseAdoTags(j.tags).testCaseIds;
    if (tcIds.length > 1) warnings.push(`${file.rel}: several @TestCaseId tags; syncing ${tcIds[0]} only`);
    const paths = areaFor({ tags: j.tags, path: file.rel }, o.paths ?? [], { areaPath: o.areaPath, iterationPath: o.iterationPath });
    const fields = testCaseFields(j, { project: c.project, rel: file.rel, ...paths });
    const reqIds = (o.linkRequirements ?? true) ? j.requirements.map((r) => r.trim()).filter((r) => /^\d+$/.test(r)).map(Number) : [];
    const relationOps = (have: number[]) =>
      reqIds.filter((r) => !have.includes(r)).map((r) => ({ op: 'add', path: '/relations/-', value: { rel: 'Microsoft.VSTS.Common.TestedBy-Reverse', url: workItemApiUrl(c, r), attributes: { comment: 'EZTest: journey traces to this requirement' } } }));
    try {
      if (tcIds.length) {
        const id = tcIds[0];
        all.push(id);
        const [cur] = await getWorkItems(c, [id], { relations: true });
        if (!cur) throw new EzTestError(`test case ${id} (from @TestCaseId) does not exist`, 'ADO_NOT_FOUND');
        // Fields set by hand in ADO that EZTest does not own (area, iteration) are only set when configured.
        const changed = Object.keys(fields).filter((k) => normalizeField(cur.fields[k]) !== normalizeField(fields[k]));
        const linked = (cur.relations ?? []).filter((r) => r.rel === 'Microsoft.VSTS.Common.TestedBy-Reverse').map((r) => relationId(r.url)).filter((x): x is number => !!x);
        const rel = relationOps(linked);
        if (!changed.length && !rel.length) {
          items.push({ file: file.rel, journeyId: j.id, testCaseId: id, url: workItemWebUrl(c, id), action: 'unchanged' });
          continue;
        }
        if (o.update === false) {
          items.push({ file: file.rel, journeyId: j.id, testCaseId: id, url: workItemWebUrl(c, id), action: 'unchanged', changedFields: changed });
          continue;
        }
        if (o.dryRun) {
          items.push({ file: file.rel, journeyId: j.id, testCaseId: id, url: workItemWebUrl(c, id), action: 'would-update', changedFields: changed, linkedRequirements: reqIds.filter((r) => !linked.includes(r)) });
          continue;
        }
        await patchWorkItem(c, id, [...changed.map((k) => ({ op: 'add', path: `/fields/${k}`, value: fields[k] })), ...rel]);
        items.push({ file: file.rel, journeyId: j.id, testCaseId: id, url: workItemWebUrl(c, id), action: 'updated', changedFields: changed, linkedRequirements: reqIds.filter((r) => !linked.includes(r)) });
        continue;
      }
      if (o.dryRun) {
        items.push({ file: file.rel, journeyId: j.id, action: 'would-create', change: fileChange(file.rel, text, addTestCaseTag(file.path, text, 0).replace('TestCaseId:0', 'TestCaseId:<new id>')), linkedRequirements: reqIds });
        continue;
      }
      const ops = [...Object.entries(fields).map(([k, v]) => ({ op: 'add', path: `/fields/${k}`, value: v })), ...relationOps([])];
      const w = await createWorkItem(c, 'Test Case', ops);
      created.push(w.id);
      all.push(w.id);
      const after = addTestCaseTag(file.path, text, w.id);
      const change = fileChange(file.rel, text, after);
      if (o.writeBack && after !== text) {
        // Write only if the file did not change since it was read.
        const now = await readFile(file.path, 'utf8');
        if (now !== text) warnings.push(`${file.rel} changed while syncing; @TestCaseId:${w.id} not written (apply the diff by hand)`);
        else await writeFile(file.path, after);
      }
      items.push({ file: file.rel, journeyId: j.id, testCaseId: w.id, url: workItemWebUrl(c, w.id), action: 'created', change, linkedRequirements: reqIds });
    } catch (e) {
      items.push({ file: file.rel, journeyId: j.id, action: 'error', error: (e as Error).message });
    }
  }
  if (!o.dryRun && o.planId && o.suiteId && all.length) {
    const added = await addTestCasesToSuite(c, o.planId, o.suiteId, all, o.configurationIds);
    if (added.length) warnings.push(`added ${added.length} test case(s) to suite ${o.suiteId}`);
  }
  return { items, warnings };
}

/** Field names that mark a test case as automated by EZTest. */
export { AUTOMATION_FIELDS };
