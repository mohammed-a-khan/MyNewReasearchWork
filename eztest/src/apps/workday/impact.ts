/**
 * Workday release impact (semi-annual releases, e.g. 2026R1 -> 2026R2).
 *
 *  - Snapshots of production and the preview tenant: WQL data-source fields
 *    (alias, descriptor, type) and, when a signed-in page is given, the
 *    configured task forms as the preview shows them (field id, label,
 *    widget, required, prompt options). Diffing them lists relabeled,
 *    newly required, added/removed fields and retired prompt values.
 *  - The "What's New in Workday" report (a RaaS export) adds the release's
 *    own list of renamed fields, newly required fields, retired values and
 *    UI changes per task.
 */
import type { Page } from '../../browser/index.js';
import type { Step } from '../../core/index.js';
import { makeSnapshot, type AppChange, type AppFieldMeta, type AppObjectMeta, type AppSnapshot, type StepScoper } from '../common/impact.js';
import { AppPackError, normalizeLabel, poll } from '../common/kit.js';
import { releaseNoteChanges } from '../common/release-notes.js';
import { workdaySearch } from './steps.js';
import type { WorkdayClient } from './client.js';

const A = (id: string) => `[data-automation-id="${id}"]`;

/** Crawl a task form: open it through global search and read its fields (and prompt options). */
export async function crawlTask(page: Page, task: string, t = 10_000): Promise<AppFieldMeta[]> {
  await workdaySearch(page, task, t);
  const hit = page.locator(`${A('searchResults')} ${A('promptOption')}[data-category="tasks"][data-automation-label="${task.replace(/"/g, '\\"')}"] a`);
  if ((await hit.count()) !== 1) return [];
  await hit.click({ timeout: t });
  await page.locator(A('formFieldList')).waitFor({ state: 'visible', timeout: t });
  const rows = page.locator(`${A('formFieldList')} > li`);
  const n = await rows.count();
  const out: AppFieldMeta[] = [];
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const id = ((await row.getAttribute('data-automation-id')) ?? '').replace(/^formField-/, '');
    const label = (await row.locator(`${A('formLabel')} label`).innerText()).trim();
    const required = (await row.locator(A('formLabelRequired')).count()) > 0;
    let type = 'text';
    let values: string[] | undefined;
    if (await row.locator(A('multiselectInputContainer')).count()) {
      type = 'prompt';
      await row.locator(A('promptIcon')).click({ timeout: t });
      const list = row.locator(A('activeListContainer'));
      await poll(async () => ((await list.count()) ? true : undefined), t);
      values = await list.locator(A('promptOption')).evaluateAll((els) => els.map((e) => e.getAttribute('data-automation-label') ?? ''));
      // Close the popup (Escape; the prompt icon toggles it open again) and wait until it is gone, or it covers the next rows.
      await row.locator(A('searchBox')).press('Escape', { timeout: t });
      if ((await poll(async () => ((await list.count()) === 0 ? true : undefined), t)) !== true) {
        throw new AppPackError(`The "${label}" prompt list did not close after Escape`, 'WD_UI');
      }
    } else if (await row.locator(A('dateWidgetContainer')).count()) type = 'date';
    else if (await row.locator(A('checkboxPanel')).count()) type = 'checkbox';
    out.push({ name: id || normalizeLabel(label).replace(/\W+/g, '_'), label, type, required, ...(values ? { values } : {}), aliases: [label] });
  }
  return out;
}

export async function snapshotWorkday(client: WorkdayClient, o: { dataSources: string[]; tasks?: string[]; page?: Page; release?: string; source?: string }): Promise<AppSnapshot> {
  const objs: AppObjectMeta[] = [];
  for (const ds of o.dataSources) {
    const fields = await client.fields(ds);
    objs.push({ name: ds, label: ds, aliases: ds === 'allWorkers' ? ['worker', 'workers', 'Get_Workers'] : [], fields: fields.map((f) => ({ name: f.alias, label: f.descriptor, type: f.type, aliases: [f.alias] })) });
  }
  if (o.page) for (const task of o.tasks ?? []) objs.push({ name: `task:${task}`, label: task, aliases: [task], fields: await crawlTask(o.page, task) });
  return makeSnapshot('workday', objs, { source: o.source ?? client.tenant, release: o.release });
}

/** AppChanges from "What's New in Workday" rows (Functional_Area, Feature, Change_Type, Tasks_Affected, Field, New_Value, Description). */
export function whatsNewChanges(rows: Array<Record<string, string>>, release: string): AppChange[] {
  return releaseNoteChanges('workday', rows, release, { objectColumn: 'Tasks_Affected', objectPrefix: 'task:', sourceLabel: `Workday ${release} What's New` });
}

/** What a Workday step touches. */
export const workdayScoper: StepScoper = (step: Step, cur) => {
  const h = step.handler ?? '';
  const a = step.args ?? {};
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
  const texts = [step.intent].filter(Boolean);
  if (h === 'wd.openTask') {
    const t = s('task')!;
    return { carry: [`task:${t}`, t], scope: { objects: [`task:${t}`, t], fields: [], creates: `task:${t}`, texts } };
  }
  if (h === 'wd.relatedAction') {
    const t = (s('path') ?? '').split(/\s*>\s*/).pop()!;
    return { carry: [`task:${t}`, t], scope: { objects: [`task:${t}`, t], fields: [], creates: `task:${t}`, texts } };
  }
  if (h === 'wd.openWorker') return { carry: ['worker profile'], scope: { objects: ['worker profile'], fields: [], texts } };
  if (h === 'wd.setField' || h === 'wd.expectField' || h === 'wd.expectFieldState') {
    return { scope: { objects: cur.objects, fields: [{ ref: s('field')!, ...(s('value') !== undefined ? { value: s('value') } : {}) }], texts } };
  }
  if (h === 'wd.verifyWorker' || h === 'wd.verifySoap') {
    return { scope: { objects: h === 'wd.verifySoap' ? ['Get_Workers'] : ['worker', 'allWorkers'], fields: Object.entries((a.expect as Record<string, unknown>) ?? {}).map(([ref, v]) => ({ ref, value: String(v) })), texts } };
  }
  if (h === 'wd.expectTask') return { scope: { objects: [`task:${s('task')}`, s('task')!], fields: [], texts } };
  if (h.startsWith('wd.')) return { scope: { objects: cur.objects, fields: [], texts } };
  return {};
};
