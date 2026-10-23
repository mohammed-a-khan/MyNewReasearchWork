/**
 * ServiceNow custom steps (`sn.*`). Forms are driven through the UI16
 * conventions: the `element.<table>.<field>` container of a dictionary field
 * (label resolved through sys_dictionary/sys_documentation, so a journey
 * names fields as users see them), reference fields through
 * `sys_display.<table>.<field>` and the autocomplete list (strict match),
 * choice lists by label or value, UI action buttons, output messages and
 * related lists. Service Portal catalog items are driven through their
 * variables (`sp_formfield_<name>`, labels from item_option_new). Results are
 * recorded under the `servicenow` ledger key: `${servicenow.number}`,
 * `${servicenow.sysId}`, `${servicenow.request.number}`.
 */
import type { Locator, Page } from '../../browser/index.js';
import { EzTestError, type Step } from '../../core/index.js';
import type { SecretInput } from '../../identity/oauth.js';
import type { CustomStepHandler, StepContext } from '../../runner/types.js';
import {
  AppPackError, argOpt, argPairs, argStr, cssq, didYouMean, ledgerBag, looseEquals, normalizeLabel, optAttr, optText, optValue, packEvidence, poll, reveal,
} from '../common/kit.js';
import { isSysId, snTerm, snValue, type ServiceNowClient, type SnField, type SnTable, type SnVariable } from './client.js';

export interface ServiceNowCredentials { username: string; password: SecretInput }
export type ServiceNowCredentialsProvider = (role: string) => Promise<ServiceNowCredentials>;

export interface ServiceNowStepsOptions {
  /** Table API client (dictionary, lookups, cross-checks). */
  client: ServiceNowClient;
  /** Instance URL for the UI; default the client's instance URL. */
  instanceUrl?: string;
  credentials?: ServiceNowCredentialsProvider;
  /** Service Portal suffix (default "sp"). */
  portal?: string;
  timeoutMs?: number;
  screenshots?: boolean;
}

export const SERVICENOW_STEP_NAMES = [
  'sn.login', 'sn.openList', 'sn.newRecord', 'sn.openRecord', 'sn.setField', 'sn.uiAction', 'sn.expectField', 'sn.expectFieldState',
  'sn.expectMessage', 'sn.expectRelatedList', 'sn.expectUiAction', 'sn.expectList', 'sn.openCatalogItem', 'sn.orderCatalogItem', 'sn.verifyRecord',
] as const;
export type ServiceNowStepName = (typeof SERVICENOW_STEP_NAMES)[number];

interface Bag {
  user?: { role: string; username: string };
  table?: string;
  sysId?: string;
  number?: string;
  records: Record<string, string>;
  fields: Record<string, string>;
  messages?: { info: string[]; error: string[] };
  catalogItem?: string;
  request?: { number: string; sysId: string; items: string[] };
  tableApi: Record<string, Record<string, unknown>>;
}
const KEY = 'servicenow';
const bag = (ctx: StepContext) => ledgerBag<Bag>(ctx, KEY, () => ({ records: {}, fields: {}, tableApi: {} }));
const save = (ctx: StepContext, b: Bag) => ctx.ledger.set(KEY, b);
const S = (step: Step, ctx: StepContext, k: string, allowEmpty = false) => argStr(step, ctx, k, 'SN_BAD_STEP', allowEmpty);

/** Output messages on a UI16 page (info and error), or Service Portal alerts. */
export async function readMessages(page: Page): Promise<{ info: string[]; error: string[] }> {
  // Messages already seen before an action are marked (data-ez-seen) and skipped, so a stale error never answers for a new click.
  const texts = async (sel: string) =>
    (await page.locator(sel).evaluateAll((els) => els.filter((e) => !e.closest('[data-ez-seen]')).map((e) => (e as HTMLElement).innerText)))
      .map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return {
    info: await texts('.outputmsg_info .outputmsg_text, .alert-success'),
    error: [...(await texts('.outputmsg_error .outputmsg_text')), ...(await texts('#sp_messages .alert-danger'))],
  };
}

/** Log in through login.do. */
export async function serviceNowLogin(page: Page, instanceUrl: string, username: string, password: string, timeoutMs: number): Promise<{ ok: true } | { ok: false; error: string }> {
  await page.goto(`${instanceUrl.replace(/\/+$/, '')}/login.do`, { timeout: timeoutMs });
  await page.locator('#user_name').fill(username, { timeout: timeoutMs });
  await page.locator('#user_password').fill(password, { timeout: timeoutMs });
  await page.locator('#sysverb_login').click({ timeout: timeoutMs });
  const r = await poll(async () => {
    const path = new URL(page.url()).pathname;
    if (path !== '/login.do') return { ok: true as const };
    const err = await page.locator('.outputmsg_error .outputmsg_text').allInnerTexts();
    return err.length ? { ok: false as const, error: err.join(' ').trim() } : undefined;
  }, timeoutMs);
  return r ?? { ok: false, error: `still on the login page after ${timeoutMs}ms` };
}

export type FieldState = 'mandatory' | 'read-only' | 'editable' | 'hidden';

export function createServiceNowSteps(opts: ServiceNowStepsOptions): Record<ServiceNowStepName, CustomStepHandler> {
  if (!opts?.client) throw new EzTestError('createServiceNowSteps needs a ServiceNowClient', 'SN_CONFIG');
  const client = opts.client;
  const root = (opts.instanceUrl ?? client.instanceUrl).replace(/\/+$/, '');
  const portal = opts.portal ?? 'sp';
  const ev = packEvidence('servicenow', opts.screenshots ?? true);
  const timeout = (step: Step) => opts.timeoutMs ?? step.timeoutMs ?? 15_000;

  const onPortal = (page: Page) => /^https?:/.test(page.url()) && new URL(page.url()).pathname === `/${portal}`;
  /** Table of the form on screen (from the form id "<table>.do"). */
  async function formTable(page: Page): Promise<string> {
    const id = await optAttr(page.locator('form[id$=".do"]'), 'id');
    if (!id) throw new AppPackError('No ServiceNow form is open (open or create a record first)', 'SN_NO_FORM');
    return id.slice(0, -3);
  }

  async function ensureLoggedIn(page: Page): Promise<void> {
    if (/^https?:/.test(page.url()) && new URL(page.url()).pathname === '/login.do') {
      throw new AppPackError('Not logged in to ServiceNow (add "Log in to ServiceNow as <role>" first)', 'SN_NOT_LOGGED_IN');
    }
  }

  async function goto(page: Page, path: string, t: number): Promise<void> {
    await page.goto(`${root}${path}`, { timeout: t });
    await ensureLoggedIn(page);
  }

  /** Container of a dictionary field on the open form. */
  async function formField(page: Page, table: string, ref: string, t: number): Promise<{ f: SnField; box: Locator; meta: SnTable } | { f: SnField; box: undefined; meta: SnTable }> {
    const meta = await client.describe(table);
    const f = await client.resolveField(table, ref);
    const box = page.locator(`[id="element.${cssq(table)}.${cssq(f.element)}"]`);
    const found = await poll(async () => ((await box.count()) === 1 ? true : undefined), Math.min(t, 1500));
    return found ? { f, box, meta } : { f, box: undefined, meta };
  }

  async function control(box: Locator, table: string, f: SnField): Promise<{ kind: 'select' | 'reference' | 'boolean' | 'text'; el: Locator }> {
    const id = `${table}.${f.element}`;
    if ((await box.locator(`select[id="${cssq(id)}"]`).count()) === 1) return { kind: 'select', el: box.locator(`select[id="${cssq(id)}"]`) };
    if ((await box.locator(`input[id="sys_display.${cssq(id)}"]`).count()) === 1) return { kind: 'reference', el: box.locator(`input[id="sys_display.${cssq(id)}"]`) };
    if ((await box.locator(`input[type="checkbox"][id="ni.${cssq(id)}"]`).count()) === 1) return { kind: 'boolean', el: box.locator(`input[id="ni.${cssq(id)}"]`) };
    return { kind: 'text', el: box.locator(`[id="${cssq(id)}"]`).first() };
  }

  async function isReadOnly(el: Locator): Promise<boolean> {
    return el.evaluate((e) => e.hasAttribute('readonly') || e.hasAttribute('disabled') || (e as HTMLInputElement).disabled === true);
  }

  async function readControl(kind: string, el: Locator): Promise<string> {
    if (kind === 'select') return el.evaluate((e) => (e as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? '');
    if (kind === 'boolean') return (await el.isChecked()) ? 'true' : 'false';
    return (await el.inputValue()).trim();
  }

  async function chooseOption(el: Locator, value: string, label: string): Promise<string> {
    const options = await el.evaluate((e) => Array.from((e as HTMLSelectElement).options).map((o) => ({ value: o.value, text: o.textContent?.trim() ?? '' })));
    const hit = options.find((o) => normalizeLabel(o.text) === normalizeLabel(value)) ?? options.find((o) => o.value === value && o.value !== '');
    if (!hit) throw new AppPackError(`ServiceNow choice "${label}" has no option "${value}" (options: ${options.filter((o) => o.value).map((o) => o.text).join(', ')})`, 'SN_NO_OPTION');
    await el.selectOption(hit.value);
    return hit.text;
  }

  async function setReference(page: Page, el: Locator, label: string, value: string, t: number): Promise<string> {
    const id = (await el.getAttribute('id'))!.slice('sys_display.'.length);
    await el.fill('');
    await el.fill(value, { timeout: t });
    const dd = page.locator(`[id="AC.${cssq(id)}"]`);
    const rows = await poll(async () => ((await dd.count()) === 1 ? dd.locator('tr.ac_row, tr.ac_no_match').allInnerTexts() : undefined), t);
    const names = (rows ?? []).map((r) => r.trim()).filter((r) => r && r !== 'No matches found');
    const exact = names.filter((n) => normalizeLabel(n) === normalizeLabel(value));
    if (exact.length !== 1) {
      throw new AppPackError(`ServiceNow reference "${label}": ${exact.length ? `${exact.length} records` : 'no record'} named exactly "${value}" (results: ${names.length ? names.map((n) => `"${n}"`).join(', ') : 'none'})`, exact.length ? 'SN_AMBIGUOUS' : 'SN_NOT_FOUND');
    }
    await dd.locator('tr.ac_row').nth(names.indexOf(exact[0])).click({ timeout: t });
    const sysId = await page.locator(`input[type="hidden"][id="${cssq(id)}"]`).inputValue();
    if (!isSysId(sysId)) throw new AppPackError(`ServiceNow reference "${label}" did not take the value "${value}"`, 'SN_UI');
    return exact[0];
  }

  /** A catalog variable on the open Service Portal item. */
  async function portalVariable(page: Page, ref: string): Promise<{ v?: SnVariable; el: Locator; label: string }> {
    const b = await optText(page.locator('h1.sc-cat-item-name'));
    let v: SnVariable | undefined;
    if (b) {
      const item = await client.catalogItem(b).catch(() => undefined);
      v = item?.variables.find((x) => x.name === ref || normalizeLabel(x.label) === normalizeLabel(ref));
      if (item && !v) throw new AppPackError(`Catalog item "${b}" has no variable "${ref}".${didYouMean(ref, item.variables.map((x) => x.label))}`, 'SN_UNKNOWN_FIELD');
    }
    if (v) return { v, el: page.locator(`[id="sp_formfield_${cssq(v.name)}"]`), label: v.label };
    const labels = page.locator('label.field-label');
    const n = await labels.count();
    for (let i = 0; i < n; i++) {
      const l = labels.nth(i);
      if (normalizeLabel(await l.innerText()) === normalizeLabel(ref)) return { el: page.locator(`[id="${cssq((await l.getAttribute('for')) ?? '')}"]`), label: ref };
    }
    throw new AppPackError(`No catalog variable labelled "${ref}" on this item`, 'SN_UNKNOWN_FIELD');
  }

  /** Click and wait for the next page (or a client-side error message on this one). */
  async function clickAndSettle(page: Page, button: Locator, t: number): Promise<{ navigated: boolean; messages: { info: string[]; error: string[] } }> {
    await page.evaluate(() => {
      (window as unknown as { __ezSnMark?: number }).__ezSnMark = 1;
      document.querySelectorAll('.outputmsg, #sp_messages .alert').forEach((e) => e.setAttribute('data-ez-seen', '1'));
    });
    await button.click({ timeout: t });
    const r = await poll(async () => {
      const marked = await page.evaluate(() => (window as unknown as { __ezSnMark?: number }).__ezSnMark === 1).catch(() => false);
      const ready = await page.evaluate(() => document.readyState === 'complete').catch(() => false);
      if (!marked && ready) return { navigated: true };
      if (marked) {
        const m = await readMessages(page);
        if (m.error.length) return { navigated: false };
      }
      return undefined;
    }, t);
    if (!r) throw new AppPackError(`Nothing happened within ${t}ms after clicking ${await button.innerText().catch(() => 'the button')}`, 'SN_TIMEOUT');
    if (r.navigated) await page.waitForLoadState('load', { timeout: t }).catch(() => {});
    // The new page may still be settling: read its messages once it holds still.
    const messages = (await poll(() => readMessages(page), Math.min(t, 3000))) ?? { info: [], error: [] };
    return { navigated: r.navigated, messages };
  }

  async function recordKeyFields(table: string): Promise<string> {
    const t = await client.describe(table);
    return t.fields.some((f) => f.element === 'number') ? 'number' : t.fields.some((f) => f.element === 'name') ? 'name' : 'sys_id';
  }

  async function findSysId(table: string, key: string): Promise<string> {
    if (isSysId(key)) return key;
    const kf = await recordKeyFields(table);
    const rows = await client.query(table, { query: snTerm(kf, key), fields: ['sys_id'], limit: 2 });
    if (rows.length !== 1) throw new AppPackError(`ServiceNow has ${rows.length} ${table} records with ${kf} "${key}" (expected exactly one)`, rows.length ? 'SN_AMBIGUOUS' : 'SN_NOT_FOUND');
    return snValue(rows[0].sys_id);
  }

  async function afterFormLoad(page: Page, ctx: StepContext, table: string): Promise<void> {
    const b = bag(ctx);
    b.table = table;
    const sysId = await optValue(page.locator('#sys_uniqueValue'));
    if (isSysId(sysId)) {
      b.sysId = sysId;
      b.records[table] = sysId;
      const num = await optValue(page.locator(`[id="${cssq(table)}.number"]`));
      if (num) b.number = num;
    } else {
      delete b.sysId;
      delete b.number;
    }
    b.messages = await readMessages(page);
    save(ctx, b);
  }

  const handlers: Record<ServiceNowStepName, CustomStepHandler> = {
    'sn.login': async (page, step, ctx) => {
      if (!opts.credentials) throw new EzTestError('"Log in to ServiceNow" needs servicenow.users (credentials)', 'SN_CONFIG');
      const role = S(step, ctx, 'role');
      const cred = await opts.credentials(role);
      const t = timeout(step);
      const r = await serviceNowLogin(page, root, cred.username, (await reveal(cred.password)) ?? '', t);
      if (!r.ok) {
        await ev.screenshot(page, ctx, step, 'login-failed', true);
        throw new AppPackError(`ServiceNow login as ${role} (${cred.username}) failed: ${r.error}`, 'SN_LOGIN_FAILED');
      }
      const b = bag(ctx);
      b.user = { role, username: cred.username };
      save(ctx, b);
      await ev.json(ctx, step, 'login', { role, username: cred.username, landedOn: new URL(page.url()).pathname });
    },

    'sn.openList': async (page, step, ctx) => {
      const t = await client.resolveTable(S(step, ctx, 'table'));
      await goto(page, `/${t.name}_list.do`, timeout(step));
      const rows = await page.locator(`table[id="${t.name}_table"] tr.list_row`).count();
      const b = bag(ctx);
      b.table = t.name;
      save(ctx, b);
      await ev.json(ctx, step, 'list', { table: t.name, rows });
    },

    'sn.newRecord': async (page, step, ctx) => {
      const t = await client.resolveTable(S(step, ctx, 'table'));
      await goto(page, `/${t.name}.do?sys_id=-1`, timeout(step));
      if ((await page.locator(`form[id="${t.name}.do"]`).count()) !== 1) {
        const m = await readMessages(page);
        throw new AppPackError(`Could not open a new ${t.label} form${m.error.length ? `: ${m.error.join('; ')}` : ''}`, 'SN_NO_FORM');
      }
      await afterFormLoad(page, ctx, t.name);
      await ev.screenshot(page, ctx, step, 'new');
    },

    'sn.openRecord': async (page, step, ctx) => {
      const t = await client.resolveTable(S(step, ctx, 'table'));
      const key = S(step, ctx, 'key');
      const sysId = await findSysId(t.name, key);
      await goto(page, `/${t.name}.do?sys_id=${sysId}`, timeout(step));
      if ((await page.locator(`form[id="${t.name}.do"]`).count()) !== 1) {
        const m = await readMessages(page);
        throw new AppPackError(`Could not open ${t.label} "${key}"${m.error.length ? `: ${m.error.join('; ')}` : ''}`, 'SN_NO_FORM');
      }
      await afterFormLoad(page, ctx, t.name);
      await ev.json(ctx, step, 'record', { table: t.name, key, sysId });
      await ev.screenshot(page, ctx, step, 'record');
    },

    'sn.setField': async (page, step, ctx) => {
      const ref = S(step, ctx, 'field');
      const value = S(step, ctx, 'value', true);
      const t = timeout(step);
      const b = bag(ctx);
      if (onPortal(page)) {
        const { v, el, label } = await portalVariable(page, ref);
        const tag = await el.evaluate((e) => `${e.tagName.toLowerCase()}:${(e as HTMLInputElement).type ?? ''}`);
        let readBack: string;
        if (tag.startsWith('select')) readBack = await chooseOption(el, value, label);
        else if (tag === 'input:checkbox') {
          await el.setChecked(looseEquals(true, value));
          readBack = (await el.isChecked()) ? 'true' : 'false';
        } else {
          await el.fill(value, { timeout: t });
          readBack = await el.inputValue();
        }
        b.fields[v?.name ?? label] = readBack;
        save(ctx, b);
        await ev.json(ctx, step, 'variable', { item: b.catalogItem, variable: v?.name, label, value, readBack });
        return;
      }
      const table = await formTable(page);
      const r = await formField(page, table, ref, t);
      if (!r.box) throw new AppPackError(`ServiceNow field "${r.f.label}" (${table}.${r.f.element}) is not on this form for this user`, 'SN_NOT_ON_FORM');
      const c = await control(r.box, table, r.f);
      if (await isReadOnly(c.el)) throw new AppPackError(`ServiceNow field "${r.f.label}" (${table}.${r.f.element}) is read-only for this user`, 'SN_READ_ONLY');
      let readBack: string;
      if (c.kind === 'select') readBack = await chooseOption(c.el, value, r.f.label);
      else if (c.kind === 'reference') readBack = await setReference(page, c.el, r.f.label, value, t);
      else if (c.kind === 'boolean') {
        await c.el.setChecked(looseEquals(true, value));
        readBack = (await c.el.isChecked()) ? 'true' : 'false';
      } else {
        await c.el.fill(value, { timeout: t });
        readBack = await c.el.inputValue();
      }
      b.fields[r.f.element] = readBack;
      save(ctx, b);
      await ev.json(ctx, step, 'field', { table, field: r.f.label, element: r.f.element, type: r.f.type, control: c.kind, value, readBack });
    },

    'sn.uiAction': async (page, step, ctx) => {
      const action = S(step, ctx, 'action');
      const expectError = argOpt(step, ctx, 'expectError');
      const t = timeout(step);
      if (onPortal(page)) {
        if (!/^order(\s+now)?$/i.test(action)) throw new AppPackError(`No "${action}" action on the Service Portal (use "Order the ServiceNow catalog item")`, 'SN_BAD_STEP');
        return handlers['sn.orderCatalogItem'](page, step, ctx);
      }
      const table = await formTable(page);
      const buttons = page.locator('#ui_actions button.form_action_button');
      const labels = (await buttons.allInnerTexts()).map((s) => s.trim());
      const ids = await buttons.evaluateAll((els) => els.map((e) => e.id));
      const i = labels.findIndex((l) => normalizeLabel(l) === normalizeLabel(action));
      const j = i >= 0 ? i : ids.indexOf(action);
      if (j < 0) throw new AppPackError(`No ServiceNow UI action "${action}" on this ${table} form (available: ${labels.map((l) => `"${l}"`).join(', ') || 'none'})`, 'SN_NO_UI_ACTION');
      const isInsert = ids[j] === 'sysverb_insert';
      const r = await clickAndSettle(page, buttons.nth(j), t);
      const b = bag(ctx);
      b.messages = r.messages;
      const failed = r.messages.error.length > 0;
      if (failed) {
        save(ctx, b);
        await ev.screenshot(page, ctx, step, 'ui-action-failed', true);
        const text = r.messages.error.join('; ');
        if (expectError !== undefined) {
          if (!text.toLowerCase().includes(expectError.toLowerCase())) throw new AppPackError(`"${labels[j]}" failed with "${text}", expected an error containing "${expectError}"`, 'SN_ASSERT');
          return;
        }
        throw new AppPackError(`ServiceNow "${labels[j]}" failed: ${text}`, 'SN_UI_ACTION_FAILED', { messages: r.messages });
      }
      if (expectError !== undefined) throw new AppPackError(`Expected "${labels[j]}" to fail with "${expectError}" but it succeeded`, 'SN_ASSERT');
      if ((await page.locator(`form[id="${table}.do"]`).count()) === 1) await afterFormLoad(page, ctx, table);
      const after = bag(ctx);
      if (step.captureAs && after.number) ctx.ledger.set(step.captureAs, after.number);
      await ev.json(ctx, step, 'ui-action', { table, action: labels[j], id: ids[j], inserted: isInsert, sysId: after.sysId, number: after.number, messages: r.messages });
      await ev.screenshot(page, ctx, step, 'after-action');
    },

    'sn.expectField': async (page, step, ctx) => {
      const ref = S(step, ctx, 'field');
      const want = S(step, ctx, 'value', true);
      let actual: string;
      let label = ref;
      if (onPortal(page)) {
        const pv = await portalVariable(page, ref);
        label = pv.label;
        const tag = await pv.el.evaluate((e) => e.tagName.toLowerCase());
        actual = tag === 'select' ? await pv.el.evaluate((e) => (e as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? '') : await pv.el.inputValue();
      } else {
        const table = await formTable(page);
        const r = await formField(page, table, ref, timeout(step));
        if (!r.box) throw new AppPackError(`ServiceNow field "${r.f.label}" is not on this form for this user`, 'SN_NOT_ON_FORM');
        const c = await control(r.box, table, r.f);
        actual = await readControl(c.kind, c.el);
        label = `${r.f.label}" (${r.f.element})`;
        const b = bag(ctx);
        b.fields[r.f.element] = actual;
        save(ctx, b);
      }
      if (!looseEquals(actual, want)) throw new AppPackError(`ServiceNow field "${label.endsWith(')') ? label : `${label}"`} is "${actual}", expected "${want}"`, 'SN_ASSERT');
    },

    'sn.expectFieldState': async (page, step, ctx) => {
      const ref = S(step, ctx, 'field');
      const want = S(step, ctx, 'state') as FieldState;
      const table = await formTable(page);
      const r = await formField(page, table, ref, Math.min(timeout(step), 2000));
      let actual: FieldState;
      if (!r.box) actual = 'hidden';
      else {
        const c = await control(r.box, table, r.f);
        const mandatory = (await r.box.locator('span.required-marker.mandatory').count()) > 0;
        actual = (await isReadOnly(c.el)) ? 'read-only' : mandatory && want === 'mandatory' ? 'mandatory' : 'editable';
        if (want === 'mandatory' && mandatory) actual = 'mandatory';
      }
      await ev.json(ctx, step, 'field-state', { table, field: r.f.label, element: r.f.element, expected: want, actual });
      if (actual !== want) throw new AppPackError(`ServiceNow field "${r.f.label}" (${table}.${r.f.element}) is ${actual} for this user, expected ${want}`, 'SN_ASSERT');
    },

    'sn.expectMessage': async (page, step, ctx) => {
      const text = S(step, ctx, 'text');
      const kind = (argOpt(step, ctx, 'kind') ?? 'info') as 'info' | 'error';
      const m = await poll(async () => {
        const x = await readMessages(page);
        return x[kind].some((s) => s.toLowerCase().includes(text.toLowerCase())) ? x : undefined;
      }, Math.min(timeout(step), 5000));
      if (!m) {
        const x = await readMessages(page);
        throw new AppPackError(`No ServiceNow ${kind} message containing "${text}" (${kind} messages: ${x[kind].map((s) => `"${s}"`).join(', ') || 'none'})`, 'SN_ASSERT');
      }
    },

    'sn.expectRelatedList': async (page, step, ctx) => {
      const list = S(step, ctx, 'list');
      const value = S(step, ctx, 'value');
      const lists = page.locator('.related_lists .tabs2_list');
      const captions = await lists.evaluateAll((els) => els.map((e) => e.getAttribute('tab_caption') ?? ''));
      const i = captions.findIndex((c) => normalizeLabel(c) === normalizeLabel(list));
      if (i < 0) throw new AppPackError(`No ServiceNow related list "${list}" (lists: ${captions.map((c) => `"${c}"`).join(', ') || 'none'})`, 'SN_NO_LIST');
      const rows = (await lists.nth(i).locator('tr.list_row').allInnerTexts()).map((r) => r.replace(/\s+/g, ' ').trim());
      if (!rows.some((r) => r.toLowerCase().includes(value.toLowerCase()))) {
        throw new AppPackError(`Related list "${captions[i]}" has no row with "${value}" (${rows.length} rows: ${rows.map((r) => `"${r}"`).join(', ')})`, 'SN_ASSERT');
      }
    },

    'sn.expectUiAction': async (page, step, ctx) => {
      const action = S(step, ctx, 'action');
      const visible = step.args?.visible !== false;
      const labels = (await page.locator('#ui_actions button.form_action_button').allInnerTexts()).map((s) => s.trim());
      const has = labels.some((l) => normalizeLabel(l) === normalizeLabel(action));
      if (has !== visible) throw new AppPackError(`ServiceNow UI action "${action}" is ${has ? 'visible' : 'not available'} (actions: ${labels.join(', ') || 'none'}), expected ${visible ? 'visible' : 'hidden'}`, 'SN_ASSERT');
    },

    'sn.expectList': async (page, step, ctx) => {
      const t = await client.resolveTable(S(step, ctx, 'table'));
      const value = S(step, ctx, 'value');
      if (!/^https?:/.test(page.url()) || new URL(page.url()).pathname !== `/${t.name}_list.do`) await goto(page, `/${t.name}_list.do`, timeout(step));
      const rows = (await page.locator(`table[id="${t.name}_table"] tr.list_row`).allInnerTexts()).map((r) => r.replace(/\s+/g, ' ').trim());
      if (!rows.some((r) => r.toLowerCase().includes(value.toLowerCase()))) throw new AppPackError(`The ${t.label} list has no row with "${value}" (${rows.length} rows)`, 'SN_ASSERT');
    },

    'sn.openCatalogItem': async (page, step, ctx) => {
      const name = S(step, ctx, 'item');
      const item = await client.catalogItem(name);
      await goto(page, `/${portal}?id=sc_cat_item&sys_id=${item.sysId}`, timeout(step));
      const shown = (await page.locator('h1.sc-cat-item-name').innerText({ timeout: timeout(step) })).trim();
      if (normalizeLabel(shown) !== normalizeLabel(item.name)) throw new AppPackError(`Opened catalog item shows "${shown}", expected "${item.name}"`, 'SN_WRONG_ITEM');
      const b = bag(ctx);
      b.catalogItem = item.name;
      save(ctx, b);
      await ev.json(ctx, step, 'catalog-item', { item: item.name, sysId: item.sysId, variables: item.variables.map((v) => ({ name: v.name, label: v.label, mandatory: v.mandatory })) });
    },

    'sn.orderCatalogItem': async (page, step, ctx) => {
      const t = timeout(step);
      const expectError = argOpt(step, ctx, 'expectError');
      if (!onPortal(page)) throw new AppPackError('No Service Portal catalog item is open (use "Open the ServiceNow catalog item ...")', 'SN_NO_ITEM');
      const r = await clickAndSettle(page, page.locator('#order_now'), t);
      if (!r.navigated) {
        const text = r.messages.error.join('; ');
        await ev.screenshot(page, ctx, step, 'order-failed', true);
        if (expectError !== undefined && text.toLowerCase().includes(expectError.toLowerCase())) return;
        throw new AppPackError(`ServiceNow order failed: ${text}`, 'SN_ORDER_FAILED');
      }
      if (expectError !== undefined) throw new AppPackError(`Expected the order to fail with "${expectError}" but it was submitted`, 'SN_ASSERT');
      const number = (await page.locator('#request_number').innerText({ timeout: t })).trim();
      const items = await page.locator('li.requested-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-number') ?? ''));
      const reqId = new URL(page.url()).searchParams.get('sys_id') ?? '';
      const b = bag(ctx);
      b.request = { number, sysId: reqId, items };
      b.number = number;
      b.table = 'sc_request';
      b.records.sc_request = reqId;
      save(ctx, b);
      if (step.captureAs) ctx.ledger.set(step.captureAs, number);
      await ev.json(ctx, step, 'order', { item: b.catalogItem, request: number, items });
      await ev.screenshot(page, ctx, step, 'ordered');
    },

    'sn.verifyRecord': async (_page, step, ctx) => {
      const t = await client.resolveTable(S(step, ctx, 'table'));
      const key = S(step, ctx, 'key');
      const exp = argPairs(step, ctx, 'SN_BAD_STEP');
      const cols: Array<{ ref: string; path: string; label: string; expected: string }> = [];
      for (const [ref, expected] of Object.entries(exp)) {
        if (/^variables\.[a-z_][a-z0-9_]*$/.test(ref)) cols.push({ ref, path: ref, label: ref, expected });
        else if (/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_.]*$/.test(ref)) cols.push({ ref, path: ref, label: ref, expected });
        else {
          const f = await client.resolveField(t.name, ref);
          cols.push({ ref, path: f.element, label: f.label, expected });
        }
      }
      const kf = isSysId(key) ? 'sys_id' : await recordKeyFields(t.name);
      const rows = await client.query(t.name, { query: snTerm(kf, key), fields: ['sys_id', ...new Set(cols.map((c) => c.path))], displayValue: 'all', limit: 2 });
      if (rows.length !== 1) throw new AppPackError(`ServiceNow has ${rows.length} ${t.name} records with ${kf} "${key}" (expected exactly one; the integration user may not see it)`, rows.length ? 'SN_AMBIGUOUS' : 'SN_NOT_FOUND');
      const rec = rows[0];
      const checks = cols.map((c) => {
        const cell = rec[c.path] as { value?: unknown; display_value?: unknown } | string | undefined;
        if (cell === undefined) return { ...c, value: undefined, display: undefined, passed: false, missing: true };
        const value = typeof cell === 'object' ? String(cell.value ?? '') : String(cell);
        const display = typeof cell === 'object' ? String(cell.display_value ?? '') : String(cell);
        return { ...c, value, display, passed: looseEquals(value, c.expected) || looseEquals(display, c.expected) };
      });
      const sysId = snValue((rec.sys_id as { value?: string }).value ?? rec.sys_id);
      const b = bag(ctx);
      b.tableApi[t.name] = Object.fromEntries(checks.map((c) => [c.path, c.value]));
      save(ctx, b);
      await ev.json(ctx, step, 'table-api', { table: t.name, key, sysId, query: snTerm(kf, key), checks });
      const bad = checks.filter((c) => !c.passed);
      if (bad.length) {
        throw new AppPackError(`ServiceNow ${t.name} "${key}": ${bad.map((c) => ('missing' in c && c.missing ? `${c.label} is not readable by the integration user` : `${c.label} is "${c.display}"${c.display !== c.value ? ` (${c.value})` : ''}, expected "${c.expected}"`)).join('; ')}`, 'SN_ASSERT');
      }
    },
  };
  return handlers;
}
