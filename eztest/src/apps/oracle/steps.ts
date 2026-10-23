/**
 * Oracle custom steps (`oracle.*`) for Fusion Cloud Redwood pages and
 * E-Business Suite OA Framework (web) pages.
 *
 *  - Redwood: fields are Oracle JET core-pack elements found by their
 *    label-hint (oj-c-input-text, oj-c-input-number, oj-c-input-date-text,
 *    oj-c-select-single LOVs with type-ahead results, exact match only),
 *    required/readonly attributes, inline and banner messages, toasts,
 *    oj-c-table tables (cells by row and column header), oj-c-button.
 *  - OA Framework: x8 prompt labels (label for=), required markers, poplists,
 *    the "Search and Select" LOV in its modal iframe, OraMessageBox errors
 *    and confirmations, the Navigator (responsibility > function).
 *
 * Fusion REST cross-checks resolve attribute titles through describe.
 * Results go to the `oracle` ledger key (`${oracle.orderNumber}` etc.).
 */
import type { FrameLocator, Locator, Page } from '../../browser/index.js';
import { EzTestError, type Step } from '../../core/index.js';
import type { SecretInput } from '../../identity/oauth.js';
import type { CustomStepHandler, StepContext } from '../../runner/types.js';
import { AppPackError, argOpt, argPairs, argStr, cssq, ledgerBag, looseEquals, normalizeLabel, optText, packEvidence, poll, reveal } from '../common/kit.js';
import type { OracleRestClient } from './client.js';

export interface OracleCredentials { username: string; password: SecretInput }
export interface OracleStepsOptions {
  client: OracleRestClient;
  /** Fusion UI root, e.g. https://acme.fa.us2.oraclecloud.com */
  fusionUrl: string;
  /** EBS root, e.g. https://ebs.example.com (OA_HTML is appended). */
  ebsUrl?: string;
  credentials?: (role: string) => Promise<OracleCredentials>;
  timeoutMs?: number;
  screenshots?: boolean;
}

export const ORACLE_STEP_NAMES = [
  'oracle.login', 'oracle.navigate', 'oracle.setField', 'oracle.setCell', 'oracle.press', 'oracle.expectMessage', 'oracle.expectField', 'oracle.expectFieldState',
  'oracle.expectTable', 'oracle.expectPage', 'oracle.verifyRest',
] as const;
export type OracleStepName = (typeof ORACLE_STEP_NAMES)[number];

interface Bag {
  user?: { role: string; username: string; system: 'fusion' | 'ebs' };
  page?: string;
  fields: Record<string, string>;
  messages?: string[];
  number?: string;
  rest: Record<string, Record<string, unknown>>;
}
const KEY = 'oracle';
const bag = (ctx: StepContext) => ledgerBag<Bag>(ctx, KEY, () => ({ fields: {}, rest: {} }));
const save = (ctx: StepContext, b: Bag) => ctx.ledger.set(KEY, b);
const S = (step: Step, ctx: StepContext, k: string, allowEmpty = false) => argStr(step, ctx, k, 'ORA_BAD_STEP', allowEmpty);

export async function oracleLogin(page: Page, system: 'fusion' | 'ebs', root: string, username: string, password: string, t: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const fusion = system === 'fusion';
  await page.goto(`${root.replace(/\/+$/, '')}${fusion ? '/fscmUI/redwood/home' : '/OA_HTML/AppsLocalLogin.jsp'}`, { timeout: t });
  if (fusion ? (await page.locator('#navigator').count()) === 1 : (await page.locator('#NavigatorRN').count()) === 1) return { ok: true };
  await page.locator(fusion ? '#userid' : '#usernameField').fill(username, { timeout: t });
  await page.locator(fusion ? '#password' : '#passwordField').fill(password, { timeout: t });
  await page.locator(fusion ? '#btnActive' : '#ButtonBox').click({ timeout: t });
  const r = await poll(async () => {
    if ((await page.locator(fusion ? '#navigator' : '#NavigatorRN').count()) === 1) return { ok: true as const };
    const e = await optText(page.locator(fusion ? '#loginErrorMessage' : '#loginError'));
    return e ? { ok: false as const, error: e } : undefined;
  }, t);
  return r ?? { ok: false, error: `no home page after ${t}ms` };
}

const isoToUs = (v: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  return m ? `${m[2]}/${m[3]}/${m[1]}` : v;
};

type Field = { kind: 'redwood'; el: Locator; tag: string; label: string } | { kind: 'oaf'; el: Locator; tag: string; label: string; box: Locator };

export function createOracleSteps(opts: OracleStepsOptions): Record<OracleStepName, CustomStepHandler> {
  if (!opts?.client) throw new EzTestError('createOracleSteps needs an OracleRestClient', 'ORA_CONFIG');
  const ev = packEvidence('oracle', opts.screenshots ?? true);
  const timeout = (step: Step) => opts.timeoutMs ?? step.timeoutMs ?? 15_000;
  const isEbs = (page: Page) => /^https?:/.test(page.url()) && new URL(page.url()).pathname.startsWith('/OA_HTML/');

  async function labels(page: Page): Promise<string[]> {
    if (isEbs(page)) return (await page.locator('td.x8 label').allInnerTexts()).map((x) => x.trim());
    return page.locator('main [label-hint]').evaluateAll((els) => els.filter((e) => !e.closest('tbody')).map((e) => e.getAttribute('label-hint') ?? ''));
  }

  async function field(page: Page, label: string, t: number, scope?: Locator): Promise<Field | undefined> {
    return poll(async () => {
      if (isEbs(page) && !scope) {
        const ls = page.locator('td.x8 label');
        const texts = (await ls.allInnerTexts()).map((x) => x.trim());
        const i = texts.findIndex((x) => normalizeLabel(x) === normalizeLabel(label));
        if (i < 0) return undefined;
        const id = (await ls.nth(i).getAttribute('for')) ?? '';
        const el = page.locator(`[id="${cssq(id)}"]`);
        return { kind: 'oaf' as const, el, tag: await el.evaluate((e) => e.tagName.toLowerCase()), label: texts[i], box: ls.nth(i).locator('xpath=ancestor::tr[1]') };
      }
      const root = scope ?? page.locator('main');
      const els = root.locator('[label-hint]');
      const hints = await els.evaluateAll((xs, inTable) => xs.map((e) => (inTable || !e.closest('tbody') ? e.getAttribute('label-hint') ?? '' : '\u0000')), !!scope);
      const i = hints.findIndex((x) => normalizeLabel(x) === normalizeLabel(label));
      if (i < 0) return undefined;
      const el = els.nth(i);
      return { kind: 'redwood' as const, el, tag: await el.evaluate((e) => e.tagName.toLowerCase()), label: hints[i] };
    }, t);
  }

  async function readOnly(f: Field): Promise<boolean> {
    if (f.kind === 'redwood') return f.el.evaluate((e) => e.hasAttribute('readonly') || !!e.querySelector('input[readonly]') || !e.querySelector('input'));
    return f.el.evaluate((e) => (e as HTMLInputElement).readOnly || (e as HTMLInputElement).disabled);
  }

  async function read(f: Field): Promise<string> {
    if (f.kind === 'oaf') return f.tag === 'select' ? f.el.evaluate((e) => (e as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? '') : (await f.el.inputValue()).trim();
    const ro = f.el.locator('.oj-text-field-readonly');
    if (await ro.count()) return (await ro.innerText()).trim();
    return (await f.el.locator('input').first().inputValue()).trim();
  }

  async function setRedwood(page: Page, f: Extract<Field, { kind: 'redwood' }>, value: string, t: number): Promise<string> {
    const input = f.el.locator('input').first();
    if (f.tag === 'oj-c-select-single') {
      await input.fill(value, { timeout: t });
      const id = await f.el.getAttribute('id');
      const drop = page.locator(`[id="${cssq(id ?? '')}_drop"]`);
      const results = await poll(async () => ((await drop.count()) ? drop.locator('.oj-listbox-result, .oj-listbox-no-results').allInnerTexts() : undefined), t);
      const opts2 = (results ?? []).map((x) => x.trim()).filter((x) => x !== 'No results found');
      const i = opts2.findIndex((x) => normalizeLabel(x) === normalizeLabel(value));
      if (i < 0) throw new AppPackError(`Oracle list of values "${f.label}" has no value "${value}" (results: ${opts2.map((x) => `"${x}"`).join(', ') || 'none'})`, 'ORA_NO_OPTION');
      await drop.locator('.oj-listbox-result').nth(i).click({ timeout: t });
      await poll(async () => ((await f.el.getAttribute('data-value')) === opts2[i] ? true : undefined), t);
      return (await input.inputValue()).trim();
    }
    await input.fill(f.tag === 'oj-c-input-date-text' ? isoToUs(value) : value, { timeout: t });
    return (await input.inputValue()).trim();
  }

  async function setOaf(page: Page, f: Extract<Field, { kind: 'oaf' }>, value: string, lov: boolean, t: number): Promise<string> {
    if (f.tag === 'select') {
      const options = await f.el.evaluate((e) => Array.from((e as HTMLSelectElement).options).map((o) => o.textContent?.trim() ?? ''));
      const i = options.findIndex((x) => normalizeLabel(x) === normalizeLabel(value));
      if (i < 0) throw new AppPackError(`Oracle EBS poplist "${f.label}" has no value "${value}" (values: ${options.filter(Boolean).join(', ')})`, 'ORA_NO_OPTION');
      await f.el.selectOption({ index: i });
      return options[i];
    }
    if (!lov) {
      await f.el.fill(value, { timeout: t });
      return (await f.el.inputValue()).trim();
    }
    const icon = page.locator(`a[title="Search: ${cssq(f.label)}"]`);
    if ((await icon.count()) !== 1) throw new AppPackError(`Oracle EBS field "${f.label}" has no list of values`, 'ORA_NO_LOV');
    await icon.click({ timeout: t });
    const frame: FrameLocator = page.frameLocator(`iframe[title="Search and Select: ${cssq(f.label)}"]`);
    await frame.locator('#searchText').fill(value, { timeout: t });
    await frame.locator('#lovGo').click({ timeout: t });
    const rows = frame.locator('table[summary="Results"] tbody tr');
    // The LOV window reloads with the search results; wait until every row matches the search (or give up and read what is there).
    const texts = await poll(async () => {
      const x = (await rows.allInnerTexts()).map((r) => r.trim());
      return x.length && x.every((r) => r.toLowerCase().includes(value.toLowerCase())) ? x : undefined;
    }, Math.min(t, 2000));
    const all = texts ?? (await rows.allInnerTexts()).map((r) => r.trim());
    const i = all.findIndex((x) => normalizeLabel(x) === normalizeLabel(value));
    if (i < 0) {
      throw new AppPackError(`Oracle EBS "Search and Select: ${f.label}" finds no exact "${value}" (results: ${all.map((x) => `"${x}"`).join(', ') || 'none'})`, 'ORA_NOT_FOUND');
    }
    await rows.nth(i).locator('input[type="radio"]').check({ timeout: t });
    await frame.locator('#lovSelect').click({ timeout: t });
    await poll(async () => ((await page.locator('iframe[title^="Search and Select"]').count()) === 0 ? true : undefined), t);
    return (await f.el.inputValue()).trim();
  }

  async function messages(page: Page): Promise<{ errors: string[]; info: string[] }> {
    const t = async (sel: string) => (await page.locator(sel).allInnerTexts()).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
    return {
      errors: [...(await t('.oj-message-banner-error .oj-message-banner-summary')), ...(await t('.oj-text-field-messages .oj-message-error .oj-message-summary')), ...(await t('.oj-c-message-toast.oj-message-error .oj-message-summary')), ...(await t('.OraMessageBoxError .OraErrorText'))],
      info: [...(await t('.oj-c-message-toast:not(.oj-message-error) .oj-message-summary')), ...(await t('.OraMessageBoxConfirmation .OraInstructionText'))],
    };
  }

  async function table(page: Page, name: string): Promise<{ root: Locator; headers: string[]; rows: Locator }> {
    const t = page.locator(`table[aria-label="${cssq(name)}"]`);
    if ((await t.count()) !== 1) {
      const names = await page.locator('table[aria-label]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
      throw new AppPackError(`No Oracle table "${name}" on this page (tables: ${names.map((x) => `"${x}"`).join(', ') || 'none'})`, 'ORA_NO_TABLE');
    }
    return { root: t, headers: (await t.locator('thead th').allInnerTexts()).map((x) => x.trim()), rows: t.locator('tbody tr') };
  }

  const handlers: Record<OracleStepName, CustomStepHandler> = {
    'oracle.login': async (page, step, ctx) => {
      if (!opts.credentials) throw new EzTestError('"Log in to Oracle" needs oracle.users', 'ORA_CONFIG');
      const role = S(step, ctx, 'role');
      const system = (argOpt(step, ctx, 'system') ?? 'fusion') as 'fusion' | 'ebs';
      const root = system === 'ebs' ? opts.ebsUrl : opts.fusionUrl;
      if (!root) throw new EzTestError('Oracle EBS steps need oracle.ebsUrl', 'ORA_CONFIG');
      const cred = await opts.credentials(role);
      const r = await oracleLogin(page, system, root, cred.username, (await reveal(cred.password)) ?? '', timeout(step));
      if (!r.ok) {
        await ev.screenshot(page, ctx, step, 'login-failed', true);
        throw new AppPackError(`Oracle ${system === 'ebs' ? 'EBS' : 'Fusion'} sign-in as ${role} (${cred.username}) failed: ${r.error}`, 'ORA_LOGIN_FAILED');
      }
      const b = bag(ctx);
      b.user = { role, username: cred.username, system };
      save(ctx, b);
      await ev.json(ctx, step, 'login', b.user);
    },

    'oracle.navigate': async (page, step, ctx) => {
      const target = S(step, ctx, 'page');
      const t = timeout(step);
      if (isEbs(page) || argOpt(step, ctx, 'system') === 'ebs') {
        const [resp, fn] = target.includes('>') ? target.split(/\s*>\s*/) : [undefined, target];
        await page.goto(`${opts.ebsUrl!.replace(/\/+$/, '')}/OA_HTML/OA.jsp?OAFunc=OAHOMEPAGE`, { timeout: t });
        const items = page.locator('#NavigatorRN li.x3h');
        const n = await items.count();
        const seen: string[] = [];
        for (let i = 0; i < n; i++) {
          const r = (await items.nth(i).locator('.OraNavigatorResp').innerText()).trim();
          const links = items.nth(i).locator('a');
          const names = (await links.allInnerTexts()).map((x) => x.trim());
          seen.push(...names.map((x) => `${r} > ${x}`));
          const j = names.findIndex((x) => normalizeLabel(x) === normalizeLabel(fn));
          if (j >= 0 && (!resp || normalizeLabel(r) === normalizeLabel(resp))) {
            await links.nth(j).click({ timeout: t });
            await page.locator('#pageTitle').waitFor({ timeout: t });
            const b = bag(ctx);
            b.page = fn;
            save(ctx, b);
            return;
          }
        }
        throw new AppPackError(`The EBS Navigator has no "${target}" for this user (functions: ${seen.map((x) => `"${x}"`).join(', ') || 'none'})`, 'ORA_NO_FUNCTION');
      }
      if ((await page.locator('#navigator').count()) !== 1) await page.goto(`${opts.fusionUrl.replace(/\/+$/, '')}/fscmUI/redwood/home`, { timeout: t });
      if ((await page.locator('#navigator').count()) !== 1) throw new AppPackError('Not signed in to Oracle Fusion (add "Log in to Oracle Fusion as <role>" first)', 'ORA_NOT_LOGGED_IN');
      await page.locator('#navigator button').click({ timeout: t });
      const links = page.locator('#navMenu a.oj-navigationlist-item-label');
      const names = (await links.allInnerTexts()).map((x) => x.trim());
      const i = names.findIndex((x) => normalizeLabel(x) === normalizeLabel(target));
      if (i < 0) throw new AppPackError(`The Oracle Navigator has no "${target}" for this user (pages: ${names.map((x) => `"${x}"`).join(', ') || 'none'})`, 'ORA_NO_PAGE');
      await links.nth(i).click({ timeout: t });
      await poll(async () => (normalizeLabel(await optText(page.locator('#pageTitle'))) === normalizeLabel(target) ? true : undefined), t);
      const b = bag(ctx);
      b.page = target;
      save(ctx, b);
    },

    'oracle.setField': async (page, step, ctx) => {
      const label = S(step, ctx, 'field');
      const value = S(step, ctx, 'value', true);
      const t = timeout(step);
      const f = await field(page, label, Math.min(t, 3000));
      if (!f) throw new AppPackError(`No Oracle field "${label}" on this page (fields: ${(await labels(page)).map((x) => `"${x}"`).join(', ')})`, 'ORA_UNKNOWN_FIELD');
      if (await readOnly(f)) throw new AppPackError(`Oracle field "${f.label}" is read-only`, 'ORA_READ_ONLY');
      const readBack = f.kind === 'redwood' ? await setRedwood(page, f, value, t) : await setOaf(page, f, value, step.args?.lov === true, t);
      const b = bag(ctx);
      b.fields[f.label] = readBack;
      save(ctx, b);
      await ev.json(ctx, step, 'field', { field: f.label, component: f.tag, ui: f.kind, value, readBack });
    },

    'oracle.setCell': async (page, step, ctx) => {
      const { headers, rows } = await table(page, S(step, ctx, 'table'));
      const row = Number(step.args?.row ?? 0);
      const column = S(step, ctx, 'column');
      const value = S(step, ctx, 'value', true);
      const t = timeout(step);
      const n = await rows.count();
      if (row < 1 || row > n) throw new AppPackError(`The Oracle table has ${n} rows; there is no row ${row}${n === 0 ? ' (add a line first?)' : ''}`, 'ORA_NO_ROW');
      const c = headers.findIndex((h) => normalizeLabel(h) === normalizeLabel(column));
      if (c < 0) throw new AppPackError(`The Oracle table has no column "${column}" (columns: ${headers.join(', ')})`, 'ORA_NO_COLUMN');
      const cell = rows.nth(row - 1).locator('td').nth(c);
      const f = await field(page, column, Math.min(t, 2000), cell);
      if (!f || f.kind !== 'redwood') throw new AppPackError(`Row ${row} column "${column}" is not editable`, 'ORA_READ_ONLY');
      const readBack = await setRedwood(page, f, value, t);
      const b = bag(ctx);
      b.fields[`${column}[${row}]`] = readBack;
      save(ctx, b);
    },

    'oracle.press': async (page, step, ctx) => {
      const label = S(step, ctx, 'button');
      const t = timeout(step);
      const b = isEbs(page) ? page.locator(`button[title="${cssq(label)}"]`) : page.locator(`oj-c-button[label="${cssq(label)}"] button`);
      if ((await b.count()) !== 1) throw new AppPackError(`No Oracle button "${label}" on this page`, 'ORA_NO_BUTTON');
      await page.evaluate(() => {
        (window as unknown as { __ezOra?: number }).__ezOra = 1;
        document.querySelectorAll('.oj-message, .oj-c-message-toast, .OraMessageBox, oj-c-message-banner').forEach((e) => e.setAttribute('data-ez-seen', '1'));
      });
      await b.click({ timeout: t });
      // Wait for the page to settle: a navigation, a message, or nothing more to happen.
      await poll(async () => {
        const navigated = await page.evaluate(() => (window as unknown as { __ezOra?: number }).__ezOra !== 1).catch(() => false);
        const fresh = await page.locator('.oj-message:not([data-ez-seen]), .oj-c-message-toast:not([data-ez-seen]), .OraMessageBox:not([data-ez-seen]), oj-c-message-banner:not([data-ez-seen])').count().catch(() => 0);
        return navigated || fresh ? true : undefined;
      }, Math.min(t, /^(submit|save|go|search|select|log in)$/i.test(label) ? t : 600));
      await page.waitForLoadState('load', { timeout: t }).catch(() => {});
      const m = await messages(page);
      const bg = bag(ctx);
      bg.messages = [...m.errors, ...m.info];
      const num = /(?:Purchase order|Requisition)\s+(\d+)/i.exec(m.info.join(' ') + ' ' + (await optText(page.locator('#pageTitle'))))?.[1];
      if (num) bg.number = num;
      save(ctx, bg);
      if (step.captureAs && num) ctx.ledger.set(step.captureAs, num);
      await ev.screenshot(page, ctx, step, 'pressed');
    },

    'oracle.expectMessage': async (page, step, ctx) => {
      const text = S(step, ctx, 'text');
      const kind = argOpt(step, ctx, 'kind') ?? 'any';
      const got = await poll(async () => {
        const m = await messages(page);
        const xs = kind === 'error' ? m.errors : kind === 'info' ? m.info : [...m.errors, ...m.info];
        return xs.some((x) => x.toLowerCase().includes(text.toLowerCase())) ? xs : undefined;
      }, Math.min(timeout(step), 4000));
      if (!got) {
        const m = await messages(page);
        throw new AppPackError(`No Oracle ${kind === 'any' ? '' : `${kind} `}message containing "${text}" (errors: ${m.errors.map((x) => `"${x}"`).join(', ') || 'none'}; messages: ${m.info.map((x) => `"${x}"`).join(', ') || 'none'})`.replace('  ', ' '), 'ORA_ASSERT');
      }
    },

    'oracle.expectField': async (page, step, ctx) => {
      const label = S(step, ctx, 'field');
      const want = S(step, ctx, 'value', true);
      const f = await field(page, label, Math.min(timeout(step), 3000));
      if (!f) throw new AppPackError(`No Oracle field "${label}" on this page (fields: ${(await labels(page)).map((x) => `"${x}"`).join(', ')})`, 'ORA_UNKNOWN_FIELD');
      const v = await read(f);
      if (!looseEquals(v, want)) throw new AppPackError(`Oracle field "${f.label}" is "${v}", expected "${want}"`, 'ORA_ASSERT');
    },

    'oracle.expectFieldState': async (page, step, ctx) => {
      const label = S(step, ctx, 'field');
      const want = S(step, ctx, 'state');
      const f = await field(page, label, Math.min(timeout(step), 2000));
      let actual = 'hidden';
      if (f) {
        const ro = await readOnly(f);
        const req = f.kind === 'redwood' ? await f.el.evaluate((e) => e.hasAttribute('required')) : (await f.box.locator('span.x6[title="Required"]').count()) > 0;
        actual = ro ? 'read-only' : want === 'mandatory' && req ? 'mandatory' : 'editable';
      }
      if (actual !== want) throw new AppPackError(`Oracle field "${label}" is ${actual}, expected ${want}`, 'ORA_ASSERT');
    },

    'oracle.expectTable': async (page, step, ctx) => {
      const { rows } = await table(page, S(step, ctx, 'table'));
      const texts = (await rows.allInnerTexts()).map((x) => x.replace(/\s+/g, ' ').trim());
      const value = argOpt(step, ctx, 'value');
      if (value !== undefined && !texts.some((x) => x.toLowerCase().includes(value.toLowerCase()))) throw new AppPackError(`The Oracle table has no row with "${value}" (${texts.length} rows)`, 'ORA_ASSERT');
      if (typeof step.args?.count === 'number' && texts.length !== step.args.count) throw new AppPackError(`The Oracle table has ${texts.length} rows, expected ${step.args.count}`, 'ORA_ASSERT');
    },

    'oracle.expectPage': async (page, step, ctx) => {
      const target = S(step, ctx, 'page');
      const visible = step.args?.visible !== false;
      if ((await page.locator('#navigator').count()) !== 1) await page.goto(`${opts.fusionUrl.replace(/\/+$/, '')}/fscmUI/redwood/home`, { timeout: timeout(step) });
      const names = await page.locator('#navMenu a.oj-navigationlist-item-label').evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ''));
      const has = names.some((x) => normalizeLabel(x) === normalizeLabel(target));
      if (has !== visible) throw new AppPackError(`The Oracle page "${target}" is ${has ? 'in' : 'not in'} this user's Navigator, expected ${visible ? 'available' : 'unavailable'}`, 'ORA_ASSERT');
    },

    'oracle.verifyRest': async (_page, step, ctx) => {
      const res = opts.client.resource(S(step, ctx, 'resource'));
      const key = S(step, ctx, 'key');
      const exp = argPairs(step, ctx, 'ORA_BAD_STEP');
      const attrs = await Promise.all(Object.keys(exp).map((k) => opts.client.attribute(res.name, k)));
      const { q, items } = await opts.client.query(res.name, { where: { [res.key]: key }, fields: [...new Set([res.key, ...attrs.map((a) => a.name)])], limit: 2 });
      if (items.length !== 1) throw new AppPackError(`Oracle ${res.name} has ${items.length} records with ${res.key} "${key}"`, items.length ? 'ORA_AMBIGUOUS' : 'ORA_NOT_FOUND');
      const checks = Object.entries(exp).map(([k, expected], i) => ({ field: k, attribute: attrs[i].name, title: attrs[i].title, expected, actual: items[0][attrs[i].name], passed: looseEquals(items[0][attrs[i].name], expected) }));
      const b = bag(ctx);
      b.rest[res.name] = items[0];
      save(ctx, b);
      await ev.json(ctx, step, 'rest', { resource: res.name, q, checks });
      const bad = checks.filter((c) => !c.passed);
      if (bad.length) throw new AppPackError(`Oracle ${res.name} "${key}": ${bad.map((c) => `${c.title} (${c.attribute}) is "${String(c.actual)}", expected "${c.expected}"`).join('; ')}`, 'ORA_ASSERT');
    },
  };
  return handlers;
}
