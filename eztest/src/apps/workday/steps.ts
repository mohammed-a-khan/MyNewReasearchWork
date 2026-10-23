/**
 * Workday custom steps (`wd.*`), driven through Workday's data-automation-id
 * conventions: fields by their form label (`formLabel`), prompts
 * (`multiselectInputContainer` / `searchBox` / `promptOption` /
 * `selectedItem`, exact match only), the segmented date widget
 * (`dateSectionMonth/Day/Year-input`), text inputs, the error bar, the
 * confirmation page ("You have submitted", "Up Next"), global search for
 * tasks and people, related actions (twinkie menu, "Job Change > Change Job")
 * and the business process inbox. Results go to the `workday` ledger key.
 */
import type { Locator, Page } from '../../browser/index.js';
import { EzTestError, type Step } from '../../core/index.js';
import type { SecretInput } from '../../identity/oauth.js';
import type { CustomStepHandler, StepContext } from '../../runner/types.js';
import { AppPackError, argOpt, argPairs, argStr, cssq, ledgerBag, looseEquals, normalizeLabel, optText, packEvidence, poll, reveal } from '../common/kit.js';
import type { WorkdayClient } from './client.js';

export interface WorkdayCredentials { username: string; password: SecretInput }
export interface WorkdayStepsOptions {
  client: WorkdayClient;
  /** UI root, e.g. https://impl.workday.com/<tenant> */
  uiUrl: string;
  credentials?: (role: string) => Promise<WorkdayCredentials>;
  /** WQL data source for "Verify in Workday that worker ..." (default allWorkers). */
  workerDataSource?: string;
  timeoutMs?: number;
  screenshots?: boolean;
}

export const WORKDAY_STEP_NAMES = [
  'wd.login', 'wd.openTask', 'wd.openWorker', 'wd.relatedAction', 'wd.setField', 'wd.submit', 'wd.expectConfirmation', 'wd.expectError', 'wd.expectField',
  'wd.expectFieldState', 'wd.expectTask', 'wd.openInboxItem', 'wd.inboxAction', 'wd.expectInbox', 'wd.verifyWorker', 'wd.verifySoap',
] as const;
export type WorkdayStepName = (typeof WORKDAY_STEP_NAMES)[number];

interface Bag {
  user?: { role: string; username: string };
  task?: string;
  worker?: string;
  confirmation?: { title: string; upNext?: string; employeeId?: string };
  errors?: string[];
  fields: Record<string, string>;
  wql: Record<string, Record<string, string>>;
  soap: Record<string, Record<string, string>>;
}
const KEY = 'workday';
const bag = (ctx: StepContext) => ledgerBag<Bag>(ctx, KEY, () => ({ fields: {}, wql: {}, soap: {} }));
const save = (ctx: StepContext, b: Bag) => ctx.ledger.set(KEY, b);
const S = (step: Step, ctx: StepContext, k: string, allowEmpty = false) => argStr(step, ctx, k, 'WD_BAD_STEP', allowEmpty);
const A = (id: string) => `[data-automation-id="${id}"]`;

export async function workdayLogin(page: Page, uiUrl: string, username: string, password: string, t: number): Promise<{ ok: true } | { ok: false; error: string }> {
  await page.goto(`${uiUrl.replace(/\/+$/, '')}/login.htmld`, { timeout: t });
  await page.locator(A('userName')).fill(username, { timeout: t });
  await page.locator(A('password')).fill(password, { timeout: t });
  await page.locator(A('signInSubmitButton')).click({ timeout: t });
  const r = await poll(async () => {
    if ((await page.locator(A('globalSearchInput')).count()) === 1) return { ok: true as const };
    const e = page.locator(`${A('authPanel')} ${A('errorMessage')}`);
    return (await e.count()) ? { ok: false as const, error: (await e.innerText()).trim() } : undefined;
  }, t);
  return r ?? { ok: false, error: `no Workday home page after ${t}ms` };
}

/**
 * Global search: submit `q` and read the results of THIS search. The page may
 * already show results of an earlier search, so waiting for the results
 * element alone can read the old page or land mid-navigation. The current
 * document is marked first; results count only from a new document whose
 * query is `q`. Probes that hit the navigation are retried by poll().
 */
export async function workdaySearch(page: Page, q: string, t: number): Promise<Array<{ label: string; category: string; i: number }>> {
  await page.evaluate(() => {
    (window as unknown as { __ezWdSearch?: number }).__ezWdSearch = 1;
  });
  const box = page.locator(A('globalSearchInput'));
  await box.fill(q, { timeout: t });
  await box.press('Enter');
  const results = await poll(async () => {
    const fresh = await page.evaluate(
      (query) => (window as unknown as { __ezWdSearch?: number }).__ezWdSearch !== 1 && document.readyState === 'complete' && !!document.querySelector('[data-automation-id="searchResults"]') && new URLSearchParams(location.search).get('q') === query,
      q,
    );
    if (!fresh) return undefined;
    return page.locator(`${A('searchResults')} ${A('promptOption')}`).evaluateAll((els) => els.map((e, i) => ({ label: e.getAttribute('data-automation-label') ?? '', category: e.getAttribute('data-category') ?? '', i })));
  }, t);
  if (!results) throw new AppPackError(`Workday search for "${q}" showed no results page within ${t}ms`, 'WD_TIMEOUT');
  return results;
}

/** Normalise a date the journey wrote (ISO, M/D/YYYY) to [month, day, year]. */
export function dateParts(v: string): [string, string, string] {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v.trim());
  if (m) return [String(Number(m[2])).padStart(2, '0'), String(Number(m[3])).padStart(2, '0'), m[1]];
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v.trim());
  if (m) return [m[1].padStart(2, '0'), m[2].padStart(2, '0'), m[3]];
  throw new AppPackError(`Workday date "${v}" must be YYYY-MM-DD or MM/DD/YYYY`, 'WD_BAD_DATE');
}

export function createWorkdaySteps(opts: WorkdayStepsOptions): Record<WorkdayStepName, CustomStepHandler> {
  if (!opts?.client) throw new EzTestError('createWorkdaySteps needs a WorkdayClient', 'WD_CONFIG');
  const root = opts.uiUrl.replace(/\/+$/, '');
  const ds = opts.workerDataSource ?? 'allWorkers';
  const ev = packEvidence('workday', opts.screenshots ?? true);
  const timeout = (step: Step) => opts.timeoutMs ?? step.timeoutMs ?? 15_000;

  async function ensureIn(page: Page): Promise<void> {
    if (!/^https?:/.test(page.url()) || (await page.locator(A('globalSearchInput')).count()) !== 1) {
      throw new AppPackError('Not logged in to Workday (add "Log in to Workday as <role>" first)', 'WD_NOT_LOGGED_IN');
    }
  }

  /** The form field row whose label matches. */
  async function fieldRow(page: Page, label: string, t: number): Promise<Locator | undefined> {
    return poll(async () => {
      const rows = page.locator(`${A('pageContent')} li:has(${A('formLabel')})`);
      const labels = (await rows.locator(`${A('formLabel')} label`).allInnerTexts()).map((x) => x.trim());
      const i = labels.findIndex((x) => normalizeLabel(x) === normalizeLabel(label));
      return i >= 0 ? rows.nth(i) : undefined;
    }, t);
  }
  async function formLabels(page: Page): Promise<string[]> {
    return (await page.locator(`${A('pageContent')} ${A('formLabel')} label`).allInnerTexts()).map((x) => x.trim());
  }

  async function search(page: Page, q: string, t: number): Promise<Array<{ label: string; category: string; i: number }>> {
    await ensureIn(page);
    return workdaySearch(page, q, t);
  }

  async function pageErrors(page: Page): Promise<string[]> {
    return (await page.locator(`${A('errorWidgetBarMessage')}, ${A('errorWidgetBarCanvas')}:not(:has(${A('errorWidgetBarMessage')}))`).allInnerTexts()).map((x) => x.trim()).filter(Boolean);
  }

  async function title(page: Page): Promise<string> {
    return optText(page.locator(A('pageHeaderTitleText')));
  }

  async function choosePrompt(page: Page, row: Locator, label: string, value: string, t: number): Promise<string> {
    const c = row.locator(A('multiselectInputContainer'));
    const existing = c.locator(`${A('selectedItem')} ${A('DELETE_charm')}`);
    if (await existing.count()) await existing.first().click({ timeout: t });
    const box = c.locator(A('searchBox'));
    await box.fill(value, { timeout: t });
    await box.press('Enter');
    const list = c.locator(A('activeListContainer'));
    await list.waitFor({ state: 'visible', timeout: t });
    const opts2 = await list.locator(A('promptOption')).evaluateAll((els) => els.map((e) => e.getAttribute('data-automation-label') ?? ''));
    const i = opts2.findIndex((x) => normalizeLabel(x) === normalizeLabel(value));
    if (i < 0) {
      await box.press('Escape').catch(() => {});
      throw new AppPackError(`Workday prompt "${label}" has no option "${value}" (search results: ${opts2.map((x) => `"${x}"`).join(', ') || 'no matches'})`, 'WD_NO_OPTION');
    }
    await list.locator(A('promptOption')).nth(i).click({ timeout: t });
    const pill = await poll(async () => (await c.locator(A('selectedItem')).evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? '')))[0], t);
    if (!pill || normalizeLabel(pill) !== normalizeLabel(value)) throw new AppPackError(`Workday prompt "${label}" did not take "${value}"`, 'WD_UI');
    return pill;
  }

  async function readRow(row: Locator): Promise<{ widget: string; value: string; editable: boolean }> {
    const view = row.locator(A('textView'));
    if (await view.count()) return { widget: 'view', value: (await view.innerText()).trim(), editable: false };
    if (await row.locator(A('multiselectInputContainer')).count()) return { widget: 'prompt', value: (await row.locator(A('selectedItem')).evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? '')))[0] ?? '', editable: true };
    if (await row.locator(A('dateWidgetContainer')).count()) return { widget: 'date', value: await row.locator(`${A('dateWidgetContainer')} input[type="hidden"]`).inputValue(), editable: true };
    if (await row.locator(A('checkboxPanel')).count()) return { widget: 'checkbox', value: (await row.locator(A('checkboxPanel')).isChecked()) ? 'true' : 'false', editable: true };
    const input = row.locator(A('textInputBox'));
    return { widget: 'text', value: (await input.inputValue()).trim(), editable: !(await input.evaluate((e) => (e as HTMLInputElement).readOnly || (e as HTMLInputElement).disabled)) };
  }

  async function afterSubmit(page: Page, ctx: StepContext, step: Step, what: string, expectError: string | undefined, t: number): Promise<void> {
    const r = await poll(async () => {
      const errs = await pageErrors(page);
      if (errs.length) return { ok: false as const, errs };
      if ((await page.locator(A('confirmationPage')).count()) === 1) return { ok: true as const };
      return undefined;
    }, t);
    if (!r) throw new AppPackError(`Workday did not confirm the ${what} within ${t}ms`, 'WD_TIMEOUT');
    const b = bag(ctx);
    if (!r.ok) {
      b.errors = r.errs;
      save(ctx, b);
      await ev.screenshot(page, ctx, step, 'errors', true);
      const text = r.errs.join('; ');
      if (expectError !== undefined) {
        if (!text.toLowerCase().includes(expectError.toLowerCase())) throw new AppPackError(`Workday rejected the ${what} with "${text}", expected an error containing "${expectError}"`, 'WD_ASSERT');
        return;
      }
      throw new AppPackError(`Workday rejected the ${what}: ${text}`, 'WD_SUBMIT_FAILED', { errors: r.errs });
    }
    if (expectError !== undefined) throw new AppPackError(`Expected the ${what} to fail with "${expectError}" but Workday confirmed it`, 'WD_ASSERT');
    const upNext = await optText(page.locator(A('upNext')));
    const employeeId = await optText(page.locator(A('employeeId')));
    b.confirmation = { title: await title(page), ...(upNext ? { upNext } : {}), ...(employeeId ? { employeeId } : {}) };
    delete b.errors;
    save(ctx, b);
    if (step.captureAs && employeeId) ctx.ledger.set(step.captureAs, employeeId);
    await ev.json(ctx, step, 'confirmation', b.confirmation);
    await ev.screenshot(page, ctx, step, 'confirmation');
  }

  const handlers: Record<WorkdayStepName, CustomStepHandler> = {
    'wd.login': async (page, step, ctx) => {
      if (!opts.credentials) throw new EzTestError('"Log in to Workday" needs workday.users', 'WD_CONFIG');
      const role = S(step, ctx, 'role');
      const cred = await opts.credentials(role);
      const r = await workdayLogin(page, root, cred.username, (await reveal(cred.password)) ?? '', timeout(step));
      if (!r.ok) {
        await ev.screenshot(page, ctx, step, 'login-failed', true);
        throw new AppPackError(`Workday sign-in as ${role} (${cred.username}) failed: ${r.error}`, 'WD_LOGIN_FAILED');
      }
      const b = bag(ctx);
      b.user = { role, username: cred.username };
      save(ctx, b);
      await ev.json(ctx, step, 'login', { role, username: cred.username });
    },

    'wd.openTask': async (page, step, ctx) => {
      const task = S(step, ctx, 'task');
      const t = timeout(step);
      const hits = (await search(page, task, t)).filter((x) => x.category === 'tasks');
      const exact = hits.filter((x) => normalizeLabel(x.label) === normalizeLabel(task));
      if (exact.length !== 1) throw new AppPackError(`Workday search finds no task "${task}" for this user (tasks found: ${hits.map((x) => `"${x.label}"`).join(', ') || 'none'})`, 'WD_NO_TASK');
      await page.locator(`${A('searchResults')} ${A('promptOption')}`).nth(exact[0].i).locator('a').click({ timeout: t });
      await poll(async () => (normalizeLabel(await title(page)) === normalizeLabel(task) ? true : undefined), t);
      const b = bag(ctx);
      b.task = task;
      delete b.confirmation;
      save(ctx, b);
      await ev.json(ctx, step, 'task', { task, fields: await formLabels(page) });
    },

    'wd.openWorker': async (page, step, ctx) => {
      const who = S(step, ctx, 'worker');
      const t = timeout(step);
      const hits = (await search(page, who, t)).filter((x) => x.category === 'people');
      const exact = hits.filter((x) => normalizeLabel(x.label) === normalizeLabel(who));
      if (exact.length !== 1) throw new AppPackError(`Workday search finds ${exact.length} people named "${who}" (people found: ${hits.map((x) => `"${x.label}"`).join(', ') || 'none'})`, exact.length ? 'WD_AMBIGUOUS' : 'WD_NOT_FOUND');
      await page.locator(`${A('searchResults')} ${A('promptOption')}`).nth(exact[0].i).locator('a').click({ timeout: t });
      await poll(async () => (normalizeLabel(await title(page)) === normalizeLabel(who) ? true : undefined), t);
      const b = bag(ctx);
      b.worker = who;
      save(ctx, b);
    },

    'wd.relatedAction': async (page, step, ctx) => {
      const path = S(step, ctx, 'path').split(/\s*>\s*/).filter(Boolean);
      const t = timeout(step);
      if (path.length !== 2) throw new AppPackError('A Workday related action is "Category > Action", e.g. "Job Change > Change Job"', 'WD_BAD_STEP');
      const btn = page.locator(A('relatedActionsButton'));
      if ((await btn.count()) !== 1) throw new AppPackError('No related actions button on this page (open a worker first)', 'WD_NO_RELATED_ACTIONS');
      await btn.click({ timeout: t });
      const menu = page.locator(A('relatedActionsMenu'));
      await menu.waitFor({ state: 'visible', timeout: t });
      const cats = (await menu.locator(A('relatedActionsItem')).allInnerTexts()).map((x) => x.trim());
      const ci = cats.findIndex((x) => normalizeLabel(x) === normalizeLabel(path[0]));
      if (ci < 0) throw new AppPackError(`No related action category "${path[0]}" for this user (categories: ${cats.map((x) => `"${x}"`).join(', ') || 'none'})`, 'WD_NO_RELATED_ACTION');
      await menu.locator(A('relatedActionsItem')).nth(ci).click({ timeout: t });
      const sub = menu.locator(A('relatedActionsSubmenu')).nth(ci);
      await sub.waitFor({ state: 'visible', timeout: t });
      const items = (await sub.locator(A('relatedActionsItemLabel')).allInnerTexts()).map((x) => x.trim());
      const ii = items.findIndex((x) => normalizeLabel(x) === normalizeLabel(path[1]));
      if (ii < 0) throw new AppPackError(`No related action "${path[1]}" under "${cats[ci]}" (actions: ${items.map((x) => `"${x}"`).join(', ')})`, 'WD_NO_RELATED_ACTION');
      await sub.locator(A('relatedActionsItemLabel')).nth(ii).click({ timeout: t });
      await poll(async () => (normalizeLabel(await title(page)) === normalizeLabel(path[1]) ? true : undefined), t);
      const b = bag(ctx);
      b.task = path[1];
      save(ctx, b);
    },

    'wd.setField': async (page, step, ctx) => {
      const label = S(step, ctx, 'field');
      const value = S(step, ctx, 'value', true);
      const t = timeout(step);
      const row = await fieldRow(page, label, Math.min(t, 3000));
      if (!row) throw new AppPackError(`No Workday field "${label}" on this page (fields: ${(await formLabels(page)).map((x) => `"${x}"`).join(', ')})`, 'WD_UNKNOWN_FIELD');
      const cur = await readRow(row);
      if (!cur.editable) throw new AppPackError(`Workday field "${label}" is read-only here`, 'WD_READ_ONLY');
      let readBack: string;
      if (cur.widget === 'prompt') readBack = await choosePrompt(page, row, label, value, t);
      else if (cur.widget === 'date') {
        const [m, d, y] = dateParts(value);
        await row.locator(A('dateSectionMonth-input')).fill(m, { timeout: t });
        await row.locator(A('dateSectionDay-input')).fill(d, { timeout: t });
        await row.locator(A('dateSectionYear-input')).fill(y, { timeout: t });
        readBack = await row.locator(`${A('dateWidgetContainer')} input[type="hidden"]`).inputValue();
      } else if (cur.widget === 'checkbox') {
        await row.locator(A('checkboxPanel')).setChecked(looseEquals(true, value));
        readBack = String(await row.locator(A('checkboxPanel')).isChecked());
      } else {
        await row.locator(A('textInputBox')).fill(value, { timeout: t });
        readBack = await row.locator(A('textInputBox')).inputValue();
      }
      const b = bag(ctx);
      b.fields[label] = readBack;
      save(ctx, b);
      await ev.json(ctx, step, 'field', { task: b.task, field: label, widget: cur.widget, value, readBack });
    },

    'wd.submit': async (page, step, ctx) => {
      const t = timeout(step);
      const btn = page.locator(`${A('wd-CommandButtonBar')} button[title="${cssq(argOpt(step, ctx, 'button') ?? 'Submit')}"]`);
      if ((await btn.count()) !== 1) throw new AppPackError(`No Workday "${argOpt(step, ctx, 'button') ?? 'Submit'}" button on this page`, 'WD_NO_BUTTON');
      await btn.click({ timeout: t });
      await afterSubmit(page, ctx, step, bag(ctx).task ?? 'task', argOpt(step, ctx, 'expectError'), t);
    },

    'wd.expectConfirmation': async (page, step, ctx) => {
      const text = S(step, ctx, 'text');
      const all = [await title(page), await optText(page.locator(A('confirmationPage')))].join(' ').replace(/\s+/g, ' ');
      if (!all.toLowerCase().includes(text.toLowerCase())) throw new AppPackError(`The Workday confirmation does not contain "${text}" (it says "${all}")`, 'WD_ASSERT');
    },

    'wd.expectError': async (page, step, ctx) => {
      const text = S(step, ctx, 'text');
      const errs = await pageErrors(page);
      if (!errs.some((e) => e.toLowerCase().includes(text.toLowerCase()))) throw new AppPackError(`No Workday error containing "${text}" (errors: ${errs.map((e) => `"${e}"`).join(', ') || 'none'})`, 'WD_ASSERT');
    },

    'wd.expectField': async (page, step, ctx) => {
      const label = S(step, ctx, 'field');
      const want = S(step, ctx, 'value', true);
      const row = await fieldRow(page, label, Math.min(timeout(step), 3000));
      if (!row) throw new AppPackError(`No Workday field "${label}" on this page (fields: ${(await formLabels(page)).map((x) => `"${x}"`).join(', ')})`, 'WD_UNKNOWN_FIELD');
      const { value } = await readRow(row);
      if (!looseEquals(value, want)) throw new AppPackError(`Workday field "${label}" is "${value}", expected "${want}"`, 'WD_ASSERT');
    },

    'wd.expectFieldState': async (page, step, ctx) => {
      const label = S(step, ctx, 'field');
      const want = S(step, ctx, 'state');
      const row = await fieldRow(page, label, Math.min(timeout(step), 2000));
      let actual = 'hidden';
      if (row) {
        const { editable } = await readRow(row);
        const req = (await row.locator(A('formLabelRequired')).count()) > 0;
        actual = !editable ? 'read-only' : want === 'mandatory' && req ? 'mandatory' : 'editable';
      }
      if (actual !== want) throw new AppPackError(`Workday field "${label}" is ${actual}, expected ${want}`, 'WD_ASSERT');
    },

    'wd.expectTask': async (page, step, ctx) => {
      const task = S(step, ctx, 'task');
      const visible = step.args?.visible !== false;
      const hits = (await search(page, task, timeout(step))).filter((x) => x.category === 'tasks' && normalizeLabel(x.label) === normalizeLabel(task));
      if ((hits.length > 0) !== visible) throw new AppPackError(`The Workday task "${task}" is ${hits.length ? 'available' : 'not available'} to this user, expected ${visible ? 'available' : 'unavailable'}`, 'WD_ASSERT');
    },

    'wd.openInboxItem': async (page, step, ctx) => {
      const text = S(step, ctx, 'item');
      const t = timeout(step);
      await ensureIn(page);
      await page.locator(A('inboxButton')).click({ timeout: t });
      await page.locator(A('inboxList')).waitFor({ state: 'visible', timeout: t });
      const items = (await page.locator(`${A('inbox_row')} ${A('inboxItemTitle')}`).allInnerTexts()).map((x) => x.trim());
      const hit = items.map((x, i) => ({ x, i })).filter((y) => y.x.toLowerCase().includes(text.toLowerCase()));
      if (hit.length !== 1) throw new AppPackError(`${hit.length ? `${hit.length} inbox items match` : 'No inbox item matches'} "${text}" (inbox: ${items.map((x) => `"${x}"`).join(', ') || 'empty'})`, hit.length ? 'WD_AMBIGUOUS' : 'WD_NOT_FOUND');
      await page.locator(`${A('inbox_row')} ${A('inboxItemTitle')}`).nth(hit[0].i).click({ timeout: t });
      await page.locator(A('inboxDetail')).waitFor({ state: 'visible', timeout: t });
      const b = bag(ctx);
      b.task = items[hit[0].i];
      save(ctx, b);
    },

    'wd.inboxAction': async (page, step, ctx) => {
      const action = S(step, ctx, 'action');
      const t = timeout(step);
      const btn = page.locator(`${A('inboxDetail')} button[title="${cssq(action)}"]`);
      if ((await btn.count()) !== 1) throw new AppPackError(`No "${action}" action on this inbox item (this user may not be the approver)`, 'WD_NO_BUTTON');
      await btn.click({ timeout: t });
      await afterSubmit(page, ctx, step, `"${action}" of ${bag(ctx).task ?? 'the inbox item'}`, argOpt(step, ctx, 'expectError'), t);
    },

    'wd.expectInbox': async (page, step, ctx) => {
      const text = S(step, ctx, 'item');
      const present = step.args?.present !== false;
      await ensureIn(page);
      await page.locator(A('inboxButton')).click({ timeout: timeout(step) });
      await page.locator(A('inboxList')).waitFor({ state: 'visible', timeout: timeout(step) });
      const items = (await page.locator(`${A('inbox_row')} ${A('inboxItemTitle')}`).allInnerTexts()).map((x) => x.trim());
      const has = items.some((x) => x.toLowerCase().includes(text.toLowerCase()));
      if (has !== present) throw new AppPackError(`The Workday inbox ${has ? 'has' : 'has no'} item "${text}" (inbox: ${items.map((x) => `"${x}"`).join(', ') || 'empty'})`, 'WD_ASSERT');
    },

    'wd.verifyWorker': async (_page, step, ctx) => {
      const who = S(step, ctx, 'worker');
      const exp = argPairs(step, ctx, 'WD_BAD_STEP');
      const fields = await Promise.all(Object.keys(exp).map((k) => opts.client.field(ds, k)));
      const keyField = /^\d+$/.test(who) ? 'employeeID' : 'fullName';
      const { query, rows } = await opts.client.wql(ds, [...new Set(['workdayID', keyField, ...fields.map((f) => f.alias)])], { [keyField]: who }, 2);
      if (rows.length !== 1) throw new AppPackError(`Workday WQL finds ${rows.length} workers with ${keyField} "${who}"`, rows.length ? 'WD_AMBIGUOUS' : 'WD_NOT_FOUND');
      const checks = Object.entries(exp).map(([k, expected], i) => ({ field: k, alias: fields[i].alias, label: fields[i].descriptor, expected, actual: rows[0][fields[i].alias], passed: looseEquals(rows[0][fields[i].alias], expected) }));
      const b = bag(ctx);
      b.wql[who] = rows[0];
      save(ctx, b);
      await ev.json(ctx, step, 'wql', { query, checks });
      const bad = checks.filter((c) => !c.passed);
      if (bad.length) throw new AppPackError(`Workday worker "${who}": ${bad.map((c) => `${c.label} is "${c.actual}", expected "${c.expected}"`).join('; ')}`, 'WD_ASSERT');
    },

    'wd.verifySoap': async (_page, step, ctx) => {
      const id = S(step, ctx, 'employeeId');
      const exp = argPairs(step, ctx, 'WD_BAD_STEP');
      const flat = await opts.client.getWorker(id);
      const checks = Object.entries(exp).map(([k, expected]) => {
        const key = Object.keys(flat).find((x) => x === k || normalizeLabel(x.replace(/_/g, ' ')) === normalizeLabel(k));
        return { field: k, element: key, expected, actual: key ? flat[key] : undefined, passed: key !== undefined && looseEquals(flat[key], expected) };
      });
      const b = bag(ctx);
      b.soap[id] = flat;
      save(ctx, b);
      await ev.json(ctx, step, 'soap', { operation: 'Get_Workers', employeeId: id, checks });
      const bad = checks.filter((c) => !c.passed);
      if (bad.length) throw new AppPackError(`Workday Get_Workers ${id}: ${bad.map((c) => (c.element ? `${c.element} is "${c.actual}", expected "${c.expected}"` : `no element ${c.field} in the response`)).join('; ')}`, 'WD_ASSERT');
    },
  };
  return handlers;
}
