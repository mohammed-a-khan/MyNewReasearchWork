/**
 * SAP Fiori custom steps (`fiori.*`). Fields are resolved the way UI5 binds
 * them: the journey's label is looked up in the app's OData $metadata
 * (sap:label / Common.Label) to find the property, and the Smart Field (or
 * Fiori elements field) bound to that property is found through the page's
 * own UI5 runtime (`sap.ui.getCore().byId(id).getBindingPath('value')`,
 * read-only, in the page's main world). Without a UI5 runtime the label's
 * `for` association is used. Controls follow UI5's DOM conventions: inputs
 * (`-inner`), value help icons (`-vhi`) and the value help dialog,
 * ComboBoxes with fixed values, DatePickers, the message toast and the
 * message popover. Results go to the `sap` ledger key (`${sap.key}`).
 */
import type { Locator, Page } from '../../browser/index.js';
import { EzTestError, type Step } from '../../core/index.js';
import type { SecretInput } from '../../identity/oauth.js';
import type { CustomStepHandler, StepContext } from '../../runner/types.js';
import { AppPackError, argOpt, argPairs, argStr, cssq, didYouMean, ledgerBag, looseEquals, normalizeLabel, packEvidence, poll, reveal } from '../common/kit.js';
import type { ODataEntitySet, ODataProperty, SapODataClient } from './odata.js';

export interface FioriApp {
  /** Tile title, e.g. "Manage Sales Orders". */
  title: string;
  /** Semantic object-action, e.g. "SalesOrder-manage". */
  intent?: string;
  /** OData service and main entity set of the app. */
  service: string;
  entitySet: string;
  /** SAP GUI transactions the app replaces or shares logic with (for transport impact). */
  tcodes?: string[];
  /** BSP/UI5 repository name of the app (R3TR WAPA). */
  ui5App?: string;
}

export interface SapCredentials { username: string; password: SecretInput }
export type SapCredentialsProvider = (role: string) => Promise<SapCredentials>;

export interface FioriStepsOptions {
  client: SapODataClient;
  apps: FioriApp[];
  /** Launchpad URL; default <url>/sap/bc/ui5_ui5/ui2/ushell/shells/abap/FioriLaunchpad.html?sap-client=<client>. */
  launchpadUrl: string;
  credentials?: SapCredentialsProvider;
  timeoutMs?: number;
  screenshots?: boolean;
}

export const FIORI_STEP_NAMES = [
  'fiori.login', 'fiori.openApp', 'fiori.setField', 'fiori.press', 'fiori.save', 'fiori.openItem', 'fiori.expectTable', 'fiori.expectField',
  'fiori.expectFieldState', 'fiori.expectMessage', 'fiori.expectTile', 'fiori.expectValueHelp', 'fiori.verifyOData',
] as const;
export type FioriStepName = (typeof FIORI_STEP_NAMES)[number];

interface Bag {
  user?: { role: string; username: string };
  app?: string;
  entitySet?: string;
  key?: string;
  fields: Record<string, string>;
  messages?: string[];
  toast?: string;
  odata: Record<string, Record<string, string>>;
}
const KEY = 'sap';
const bag = (ctx: StepContext) => ledgerBag<Bag>(ctx, KEY, () => ({ fields: {}, odata: {} }));
const save = (ctx: StepContext, b: Bag) => ctx.ledger.set(KEY, b);
const S = (step: Step, ctx: StepContext, k: string, allowEmpty = false) => argStr(step, ctx, k, 'SAP_BAD_STEP', allowEmpty);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** ISO date to the UI5 medium date style the DatePicker shows ("Nov 15, 2026"). */
export const ui5MediumDate = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : iso;
};

/** UI5 controls with a value binding, read through the page's own UI5 runtime. */
export async function ui5BoundControls(page: Page): Promise<Array<{ id: string; type?: string; path: string; inFilterBar: boolean; visible: boolean }>> {
  return page.evaluate(() => {
    const w = window as unknown as { sap?: { ui?: { getCore?: () => { byId(id: string): { getMetadata?: () => { getName(): string }; getBindingPath?: (p: string) => string | undefined } | undefined } } } };
    const core = w.sap?.ui?.getCore?.();
    if (!core) return [];
    const out: Array<{ id: string; type?: string; path: string; inFilterBar: boolean; visible: boolean }> = [];
    for (const el of Array.from(document.querySelectorAll('[data-sap-ui]'))) {
      const c = core.byId(el.id);
      if (!c) continue;
      let path: string | undefined;
      let type: string | undefined;
      try {
        path = c.getBindingPath?.('value');
        type = c.getMetadata?.().getName();
      } catch {
        continue;
      }
      if (!path) continue;
      out.push({ id: el.id, type, path: path.replace(/^\//, ''), inFilterBar: !!el.closest('.sapUiCompSmartFilterBar'), visible: (el as HTMLElement).getClientRects().length > 0 });
    }
    return out;
  });
}

export async function fioriLogin(page: Page, launchpadUrl: string, username: string, password: string, t: number): Promise<{ ok: true } | { ok: false; error: string }> {
  await page.goto(launchpadUrl, { timeout: t });
  if ((await page.locator('#shell-header').count()) === 1) return { ok: true };
  await page.locator('#USERNAME_FIELD-inner').fill(username, { timeout: t });
  await page.locator('#PASSWORD_FIELD-inner').fill(password, { timeout: t });
  await page.locator('#LOGIN_LINK').click({ timeout: t });
  const r = await poll(async () => {
    if ((await page.locator('#shell-header').count()) === 1) return { ok: true as const };
    const e = page.locator('#LOGON_MESSAGE');
    return (await e.count()) ? { ok: false as const, error: (await e.innerText()).trim() } : undefined;
  }, t);
  return r ?? { ok: false, error: `no launchpad after ${t}ms` };
}

export function createFioriSteps(opts: FioriStepsOptions): Record<FioriStepName, CustomStepHandler> {
  if (!opts?.client) throw new EzTestError('createFioriSteps needs a SapODataClient', 'SAP_CONFIG');
  const client = opts.client;
  const ev = packEvidence('sap', opts.screenshots ?? true);
  const timeout = (step: Step) => opts.timeoutMs ?? step.timeoutMs ?? 15_000;
  const appOf = (name: string) => opts.apps.find((a) => normalizeLabel(a.title) === normalizeLabel(name) || a.intent === name);

  async function idle(page: Page, t: number): Promise<void> {
    await poll(async () => ((await page.locator('.sapUiLocalBusyIndicator, .sapUiBusy').count()) === 0 ? true : undefined), t, 50);
  }

  async function currentApp(page: Page): Promise<FioriApp | undefined> {
    const hash = await page.evaluate(() => location.hash.slice(1).split('&/')[0]);
    return opts.apps.find((a) => a.intent === hash);
  }

  /** The entity set of the screen: the app's main set, else the set whose properties cover the bound controls. */
  async function screenSet(page: Page): Promise<{ service: string; set: ODataEntitySet }> {
    const app = await currentApp(page);
    if (app) return { service: app.service, set: (await client.metadata(app.service)).entitySets[app.entitySet] };
    const paths = new Set((await ui5BoundControls(page)).map((c) => c.path));
    let best: { service: string; set: ODataEntitySet; n: number } | undefined;
    for (const s of client.services) {
      for (const set of Object.values((await client.metadata(s.name)).entitySets)) {
        const n = set.properties.filter((p) => paths.has(p.name)).length;
        if (n && (!best || n > best.n)) best = { service: s.name, set, n };
      }
    }
    if (!best) throw new AppPackError('No Fiori app is open (open one with "Open the Fiori app ...")', 'SAP_NO_APP');
    return best;
  }

  /** The Smart Field root for a label: $metadata label -> property -> UI5 control bound to it. */
  async function field(page: Page, ref: string, where: 'form' | 'filter', t: number): Promise<{ prop: ODataProperty; root?: Locator; set: ODataEntitySet; via: string }> {
    await idle(page, t);
    const { set } = await screenSet(page);
    const prop = client.property(set, ref);
    const found = await poll(async () => {
      const ctrls = (await ui5BoundControls(page)).filter((c) => c.path === prop.name && c.visible && c.inFilterBar === (where === 'filter'));
      if (ctrls.length === 1) return { id: ctrls[0].id, via: `UI5 control ${ctrls[0].type ?? ''} bound to ${prop.name}`.replace(/\s+/g, ' ') };
      if (ctrls.length > 1) throw new AppPackError(`${ctrls.length} visible Fiori fields are bound to ${prop.name}`, 'SAP_AMBIGUOUS');
      // No UI5 runtime: the label's for= association.
      const scope = where === 'filter' ? '.sapUiCompSmartFilterBar ' : '.sapUiForm ';
      const labels = page.locator(`${scope}label.sapMLabel`);
      const n = await labels.count();
      for (let i = 0; i < n; i++) {
        if (normalizeLabel(await labels.nth(i).innerText()) === normalizeLabel(prop.label)) {
          const forId = (await labels.nth(i).getAttribute('for')) ?? '';
          const rootId = await page.locator(`[id="${cssq(forId)}"]`).evaluate((e) => e.closest('.sapUiCompSmartField')?.id ?? '').catch(() => '');
          if (rootId) return { id: rootId, via: `label "${prop.label}"` };
        }
      }
      return undefined;
    }, Math.min(t, 3000));
    return { prop, set, root: found ? page.locator(`[id="${cssq(found.id)}"]`) : undefined, via: found?.via ?? '' };
  }

  async function readField(root: Locator): Promise<{ editable: boolean; text: string }> {
    const input = root.locator('input.sapMInputBaseInner');
    if ((await input.count()) === 1) return { editable: !(await input.evaluate((e) => (e as HTMLInputElement).readOnly || (e as HTMLInputElement).disabled)), text: (await input.inputValue()).trim() };
    return { editable: false, text: (await root.innerText()).replace(/\s+/g, ' ').trim() };
  }

  const matchesItem = (text: string, value: string) => {
    const n = normalizeLabel(value);
    const t = normalizeLabel(text);
    const m = /^(.*)\s+\(([^)]*)\)$/.exec(text.trim());
    return t === n || (!!m && (normalizeLabel(m[1]) === n || normalizeLabel(m[2]) === n));
  };

  async function chooseInComboBox(page: Page, root: Locator, label: string, value: string, t: number): Promise<string> {
    const input = root.locator('input[role="combobox"]');
    await root.locator('[id$="-arrow"]').click({ timeout: t });
    const popupId = `${(await input.getAttribute('id'))!.replace(/-inner$/, '')}-popup`;
    const items = page.locator(`[id="${cssq(popupId)}"] li[role="option"]`);
    const texts = await poll(async () => ((await items.count()) ? items.allInnerTexts() : undefined), t);
    const list = (texts ?? []).map((x) => x.trim());
    const i = list.findIndex((x) => matchesItem(x, value));
    if (i < 0) {
      await input.press('Escape').catch(() => {});
      throw new AppPackError(`Fiori field "${label}" has no option "${value}" (options: ${list.join(', ') || 'none'})`, 'SAP_NO_OPTION');
    }
    await items.nth(i).click({ timeout: t });
    return (await input.inputValue()).trim();
  }

  async function chooseInValueHelp(page: Page, root: Locator, label: string, value: string, t: number): Promise<string> {
    await root.locator('[id$="-vhi"]').click({ timeout: t });
    const dialog = page.locator('.sapUiCompValueHelpDialog[role="dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: t });
    await dialog.locator('input.sapMSFI').fill(value, { timeout: t });
    await dialog.locator('button.sapMBtn', { hasText: 'Go' }).click({ timeout: t });
    const rows = dialog.locator('tbody tr');
    const cells = await poll(async () => {
      const n = await rows.count();
      const out: string[][] = [];
      for (let i = 0; i < n; i++) out.push((await rows.nth(i).locator('td').allInnerTexts()).map((x) => x.trim()));
      return out;
    }, Math.min(t, 2000));
    const all = cells ?? [];
    const exact = all.map((c, i) => ({ c, i })).filter((x) => x.c.some((cell) => normalizeLabel(cell) === normalizeLabel(value)));
    if (exact.length !== 1) {
      await dialog.locator('[id$="-cancel"]').click({ timeout: t }).catch(() => {});
      throw new AppPackError(`Fiori value help "${label}": ${exact.length ? `${exact.length} rows match` : 'no row matches'} "${value}" exactly (rows: ${all.map((c) => `"${c.join(' / ')}"`).join(', ') || 'none'})`, exact.length ? 'SAP_AMBIGUOUS' : 'SAP_NOT_FOUND');
    }
    await rows.nth(exact[0].i).click({ timeout: t });
    await dialog.locator('[id$="-ok"]').click({ timeout: t });
    await dialog.waitFor({ state: 'detached', timeout: t }).catch(() => {});
    return (await root.locator('input.sapMInputBaseInner').inputValue()).trim();
  }

  async function popoverMessages(page: Page): Promise<string[]> {
    return (await page.locator('.sapMMsgPopover li.sapMMsgViewItem .sapMSLITitleOnly').allInnerTexts()).map((x) => x.trim()).filter(Boolean);
  }
  async function toasts(page: Page): Promise<string[]> {
    return (await page.locator('.sapMMessageToast').allInnerTexts()).map((x) => x.trim()).filter(Boolean);
  }

  async function button(page: Page, label: string, t: number): Promise<Locator> {
    const r = await poll(async () => {
      const btns = page.locator('.sapMDialog .sapMBtn, .sapUxAPObjectPageFloatingFooter .sapMBtn, #application-container .sapMBtn');
      const texts = (await btns.allInnerTexts()).map((x) => x.trim());
      const idx = texts.map((x, i) => ({ x, i })).filter((y) => normalizeLabel(y.x) === normalizeLabel(label));
      return idx.length ? { btns, idx, texts } : undefined;
    }, Math.min(t, 3000));
    if (!r) {
      const texts = (await page.locator('.sapMBtn').allInnerTexts()).map((x) => x.trim()).filter(Boolean);
      throw new AppPackError(`No Fiori button "${label}" (buttons: ${texts.map((x) => `"${x}"`).join(', ') || 'none'})`, 'SAP_NO_BUTTON');
    }
    // A dialog button wins over the page behind it.
    return r.btns.nth(r.idx[0].i);
  }

  const handlers: Record<FioriStepName, CustomStepHandler> = {
    'fiori.login': async (page, step, ctx) => {
      if (!opts.credentials) throw new EzTestError('"Log in to SAP Fiori" needs sap.users', 'SAP_CONFIG');
      const role = S(step, ctx, 'role');
      const cred = await opts.credentials(role);
      const r = await fioriLogin(page, opts.launchpadUrl, cred.username, (await reveal(cred.password)) ?? '', timeout(step));
      if (!r.ok) {
        await ev.screenshot(page, ctx, step, 'login-failed', true);
        throw new AppPackError(`SAP Fiori logon as ${role} (${cred.username}) failed: ${r.error}`, 'SAP_LOGIN_FAILED');
      }
      const b = bag(ctx);
      b.user = { role, username: cred.username };
      save(ctx, b);
      await ev.json(ctx, step, 'login', { role, username: cred.username });
    },

    'fiori.openApp': async (page, step, ctx) => {
      const name = S(step, ctx, 'app');
      const t = timeout(step);
      if ((await page.locator('#shell-header').count()) !== 1 || !(await page.evaluate(() => location.hash === '' || location.hash === '#Shell-home'))) {
        await page.goto(`${opts.launchpadUrl.split('#')[0]}#Shell-home`, { timeout: t });
      }
      if ((await page.locator('#shell-header').count()) !== 1) throw new AppPackError('Not logged in to SAP Fiori (add "Log in to SAP Fiori as <role>" first)', 'SAP_NOT_LOGGED_IN');
      const tiles = page.locator('.sapUshellTile');
      await poll(async () => ((await tiles.count()) || (await page.locator('#tiles').count()) ? true : undefined), t);
      const titles = await tiles.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
      const i = titles.findIndex((x) => normalizeLabel(x) === normalizeLabel(name));
      if (i < 0) throw new AppPackError(`The Fiori app "${name}" is not on this user's launchpad (tiles: ${titles.map((x) => `"${x}"`).join(', ') || 'none'})`, 'SAP_NO_TILE');
      await tiles.nth(i).click({ timeout: t });
      await poll(async () => ((await page.locator('#application-container .sapFDynamicPage, #application-container .sapUxAPObjectPageLayout, #application-container .sapMMessagePage').count()) ? true : undefined), t);
      await idle(page, t);
      const err = page.locator('.sapMMessagePage .sapMMessagePageMainText');
      if (await err.count()) throw new AppPackError(`Could not open the Fiori app "${name}": ${(await err.innerText()).trim()}`, 'SAP_APP_FAILED');
      const app = appOf(name);
      const b = bag(ctx);
      b.app = titles[i];
      if (app) b.entitySet = app.entitySet;
      delete b.key;
      save(ctx, b);
      await ev.json(ctx, step, 'app', { app: titles[i], intent: await page.evaluate(() => location.hash), entitySet: app?.entitySet });
      await ev.screenshot(page, ctx, step, 'app');
    },

    'fiori.setField': async (page, step, ctx) => {
      const ref = S(step, ctx, 'field');
      const value = S(step, ctx, 'value', true);
      const where = step.args?.filter === true ? 'filter' : 'form';
      const t = timeout(step);
      const f = await field(page, ref, where, t);
      if (!f.root) throw new AppPackError(`No Fiori ${where === 'filter' ? 'filter' : 'field'} "${f.prop.label}" (${f.set.name}.${f.prop.name}) on this screen`, 'SAP_NOT_ON_SCREEN');
      const cur = await readField(f.root);
      if (!cur.editable) throw new AppPackError(`Fiori field "${f.prop.label}" (${f.prop.name}) is read-only here${where === 'form' ? ' (press "Edit" first?)' : ''}`, 'SAP_READ_ONLY');
      let readBack: string;
      let control: string;
      if ((await f.root.locator('.sapMComboBox').count()) === 1) {
        control = 'ComboBox';
        readBack = await chooseInComboBox(page, f.root, f.prop.label, value, t);
      } else if (step.args?.valueHelp === true) {
        if ((await f.root.locator('[id$="-vhi"]').count()) !== 1) throw new AppPackError(`Fiori field "${f.prop.label}" has no value help`, 'SAP_NO_VALUE_HELP');
        control = 'Input + value help dialog';
        readBack = await chooseInValueHelp(page, f.root, f.prop.label, value, t);
      } else {
        const isDate = (await f.root.locator('.sapMDP').count()) === 1;
        control = isDate ? 'DatePicker' : 'Input';
        const input = f.root.locator('input.sapMInputBaseInner');
        await input.fill(isDate ? ui5MediumDate(value) : value, { timeout: t });
        await input.press('Tab').catch(() => {});
        readBack = (await input.inputValue()).trim();
      }
      const b = bag(ctx);
      b.fields[f.prop.name] = readBack;
      save(ctx, b);
      await ev.json(ctx, step, 'field', { entitySet: f.set.name, label: f.prop.label, property: f.prop.name, type: f.prop.type, control, resolvedBy: f.via, value, readBack, filter: where === 'filter' });
    },

    'fiori.press': async (page, step, ctx) => {
      const label = S(step, ctx, 'button');
      const t = timeout(step);
      await idle(page, t);
      await (await button(page, label, t)).click({ timeout: t });
      await idle(page, t);
    },

    'fiori.save': async (page, step, ctx) => {
      const t = timeout(step);
      const expectError = argOpt(step, ctx, 'expectError');
      await idle(page, t);
      const footer = page.locator('.sapUxAPObjectPageFloatingFooter');
      if (!(await footer.count())) throw new AppPackError('No Fiori object is being edited (no Save/Create in the footer)', 'SAP_NOT_EDITING');
      const btn = footer.locator('[id$="--save"]');
      const before = await toasts(page);
      await btn.click({ timeout: t });
      const outcome = await poll(async () => {
        const errs = await popoverMessages(page);
        if (errs.length) return { ok: false as const, errs };
        const ts = (await toasts(page)).filter((x) => !before.includes(x));
        if (ts.length && !(await page.locator('.sapUxAPObjectPageFloatingFooter').count())) return { ok: true as const, toast: ts[0] };
        return undefined;
      }, t, 50);
      if (!outcome) throw new AppPackError(`Save did not complete within ${t}ms`, 'SAP_SAVE_TIMEOUT');
      const b = bag(ctx);
      if (!outcome.ok) {
        b.messages = outcome.errs;
        save(ctx, b);
        await ev.screenshot(page, ctx, step, 'save-failed', true);
        const text = outcome.errs.join('; ');
        if (expectError !== undefined) {
          if (!text.toLowerCase().includes(expectError.toLowerCase())) throw new AppPackError(`Save failed with "${text}", expected an error containing "${expectError}"`, 'SAP_ASSERT');
          return;
        }
        throw new AppPackError(`Fiori save failed: ${text}`, 'SAP_SAVE_FAILED', { messages: outcome.errs });
      }
      if (expectError !== undefined) throw new AppPackError(`Expected the save to fail with "${expectError}" but it succeeded ("${outcome.toast}")`, 'SAP_ASSERT');
      await idle(page, t);
      const key = await page.evaluate(() => /\('([^']*)'\)$/.exec(location.hash)?.[1]);
      b.toast = outcome.toast;
      if (key && key !== 'new') b.key = decodeURIComponent(key);
      delete b.messages;
      save(ctx, b);
      if (step.captureAs && b.key) ctx.ledger.set(step.captureAs, b.key);
      await ev.json(ctx, step, 'saved', { toast: outcome.toast, key: b.key });
      await ev.screenshot(page, ctx, step, 'saved');
    },

    'fiori.openItem': async (page, step, ctx) => {
      const value = S(step, ctx, 'value');
      const t = timeout(step);
      await idle(page, t);
      const rows = page.locator('#application-container table.sapMListTbl tr.sapMListTblRow');
      const n = await rows.count();
      const cells: string[][] = [];
      for (let i = 0; i < n; i++) cells.push((await rows.nth(i).locator('td').allInnerTexts()).map((x) => x.trim()));
      const hit = cells.map((c, i) => ({ c, i })).filter((x) => x.c.some((cell) => matchesItem(cell, value)));
      if (hit.length !== 1) throw new AppPackError(`${hit.length ? `${hit.length} rows` : 'No row'} in the Fiori table ${hit.length ? 'match' : 'matches'} "${value}" (${n} rows${n ? `: ${cells.map((c) => `"${c[0]}"`).join(', ')}` : ''})`, hit.length ? 'SAP_AMBIGUOUS' : 'SAP_NOT_FOUND');
      await rows.nth(hit[0].i).click({ timeout: t });
      await poll(async () => ((await page.locator('.sapUxAPObjectPageLayout').count()) ? true : undefined), t);
      await idle(page, t);
      const key = await page.evaluate(() => /\('([^']*)'\)$/.exec(location.hash)?.[1]);
      const b = bag(ctx);
      if (key) b.key = decodeURIComponent(key);
      save(ctx, b);
    },

    'fiori.expectTable': async (page, step, ctx) => {
      const t = timeout(step);
      await idle(page, t);
      const rows = (await page.locator('#application-container table.sapMListTbl tr.sapMListTblRow').allInnerTexts()).map((r) => r.replace(/\s+/g, ' ').trim());
      const value = argOpt(step, ctx, 'value');
      const count = step.args?.count;
      if (value !== undefined && !rows.some((r) => r.toLowerCase().includes(value.toLowerCase()))) throw new AppPackError(`The Fiori table has no row with "${value}" (${rows.length} rows)`, 'SAP_ASSERT');
      if (typeof count === 'number' && rows.length !== count) throw new AppPackError(`The Fiori table has ${rows.length} rows, expected ${count}`, 'SAP_ASSERT');
    },

    'fiori.expectField': async (page, step, ctx) => {
      const want = S(step, ctx, 'value', true);
      const f = await field(page, S(step, ctx, 'field'), 'form', timeout(step));
      if (!f.root) throw new AppPackError(`No Fiori field "${f.prop.label}" (${f.prop.name}) on this screen`, 'SAP_NOT_ON_SCREEN');
      const { text } = await readField(f.root);
      if (!(looseEquals(text, want) || matchesItem(text, want))) throw new AppPackError(`Fiori field "${f.prop.label}" (${f.prop.name}) is "${text}", expected "${want}"`, 'SAP_ASSERT');
      const b = bag(ctx);
      b.fields[f.prop.name] = text;
      save(ctx, b);
    },

    'fiori.expectFieldState': async (page, step, ctx) => {
      const want = S(step, ctx, 'state');
      const f = await field(page, S(step, ctx, 'field'), 'form', Math.min(timeout(step), 3000));
      let actual: string;
      if (!f.root) actual = 'hidden';
      else {
        const { editable } = await readField(f.root);
        const required = await f.root.evaluate((e) => !!e.parentElement?.querySelector('label.sapMLabelRequired'));
        actual = !editable ? 'read-only' : want === 'mandatory' && required ? 'mandatory' : 'editable';
      }
      if (actual !== want) throw new AppPackError(`Fiori field "${f.prop.label}" (${f.prop.name}) is ${actual}, expected ${want}`, 'SAP_ASSERT');
    },

    'fiori.expectMessage': async (page, step, ctx) => {
      const text = S(step, ctx, 'text');
      const kind = argOpt(step, ctx, 'kind') ?? 'toast';
      const got = await poll(async () => {
        const xs = kind === 'toast' ? [...(await toasts(page)), ...(bag(ctx).toast ? [bag(ctx).toast!] : [])] : await popoverMessages(page);
        return xs.some((x) => x.toLowerCase().includes(text.toLowerCase())) ? xs : undefined;
      }, Math.min(timeout(step), 4000), 50);
      if (!got) {
        const xs = kind === 'toast' ? await toasts(page) : await popoverMessages(page);
        throw new AppPackError(`No Fiori ${kind === 'toast' ? 'message toast' : 'message popover entry'} containing "${text}" (${xs.map((x) => `"${x}"`).join(', ') || 'none shown'})`, 'SAP_ASSERT');
      }
    },

    'fiori.expectTile': async (page, step, ctx) => {
      const name = S(step, ctx, 'app');
      const visible = step.args?.visible !== false;
      await page.goto(`${opts.launchpadUrl.split('#')[0]}#Shell-home`, { timeout: timeout(step) });
      const titles = await page.locator('.sapUshellTile').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
      const has = titles.some((x) => normalizeLabel(x) === normalizeLabel(name));
      if (has !== visible) throw new AppPackError(`The Fiori tile "${name}" is ${has ? 'on' : 'not on'} the launchpad (tiles: ${titles.join(', ') || 'none'}), expected ${visible ? 'visible' : 'hidden'}`, 'SAP_ASSERT');
    },

    'fiori.expectValueHelp': async (page, step, ctx) => {
      const value = S(step, ctx, 'value');
      const t = timeout(step);
      const f = await field(page, S(step, ctx, 'field'), step.args?.filter === true ? 'filter' : 'form', t);
      if (!f.root || !(await f.root.locator('[id$="-vhi"]').count())) throw new AppPackError(`Fiori field "${f.prop.label}" has no value help here`, 'SAP_NO_VALUE_HELP');
      await f.root.locator('[id$="-vhi"]').click({ timeout: t });
      const dialog = page.locator('.sapUiCompValueHelpDialog[role="dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: t });
      const rows = await poll(async () => {
        const r = (await dialog.locator('tbody tr').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ').trim());
        return r.length ? r : undefined;
      }, Math.min(t, 2000));
      await dialog.locator('[id$="-cancel"]').click({ timeout: t });
      if (!(rows ?? []).some((r) => r.toLowerCase().includes(value.toLowerCase()))) throw new AppPackError(`The value help for "${f.prop.label}" has no entry "${value}" (${(rows ?? []).map((r) => `"${r}"`).join(', ') || 'empty'})`, 'SAP_ASSERT');
    },

    'fiori.verifyOData': async (_page, step, ctx) => {
      const { service, set } = await client.entitySet(S(step, ctx, 'entity'), argOpt(step, ctx, 'service'));
      const key = S(step, ctx, 'key');
      const exp = argPairs(step, ctx, 'SAP_BAD_STEP');
      if (set.keys.length !== 1) throw new AppPackError(`${set.name} has a composite key (${set.keys.join(', ')}); not supported by this phrasing`, 'SAP_BAD_STEP');
      const checks = Object.entries(exp).map(([ref, expected]) => ({ ref, prop: client.property(set, ref), expected }));
      const rows = await client.query(service.name, set.name, { filter: { [set.keys[0]]: key }, select: [set.keys[0], ...new Set(checks.map((c) => c.prop.name))], top: 2 });
      if (rows.length !== 1) throw new AppPackError(`SAP ${service.name}/${set.name} has ${rows.length} entities with ${set.keys[0]} = "${key}"`, rows.length ? 'SAP_AMBIGUOUS' : 'SAP_NOT_FOUND');
      const results = checks.map((c) => ({ field: c.ref, property: c.prop.name, label: c.prop.label, expected: c.expected, actual: rows[0][c.prop.name], passed: looseEquals(rows[0][c.prop.name], c.expected) }));
      const b = bag(ctx);
      b.odata[set.name] = rows[0];
      save(ctx, b);
      await ev.json(ctx, step, 'odata', { service: service.name, version: service.version, entitySet: set.name, key, checks: results });
      const bad = results.filter((r) => !r.passed);
      if (bad.length) throw new AppPackError(`SAP ${set.name} "${key}": ${bad.map((r) => `${r.label} (${r.property}) is "${r.actual}", expected "${r.expected}"`).join('; ')}`, 'SAP_ASSERT');
    },
  };
  void didYouMean;
  return handlers;
}
