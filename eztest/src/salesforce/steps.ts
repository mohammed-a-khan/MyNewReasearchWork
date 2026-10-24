/**
 * Salesforce custom step handlers (keyed `sf.*`) for the runner. Each handler
 * stores evidence (screenshot and/or JSON) and records what it saw under the
 * `salesforce` ledger key, e.g. `${salesforce.recordId}`,
 * `${salesforce.fields.Name}`, `${salesforce.toast.message}`.
 * Credentials come from an injected provider (Identity-Vault style); they
 * are typed into the login form and never written to evidence or errors.
 */
import type { Locator, Page } from '../browser/index.js';
import { EzTestError, type Step } from '../core/index.js';
import type { SecretInput } from '../identity/oauth.js';
import { safeName } from '../runner/evidence.js';
import type { CustomStepHandler, StepContext } from '../runner/types.js';
import { SalesforceClient, type SalesforceRecord } from './client.js';
import {
  SalesforceUiError,
  closeAppLauncher,
  currentObject,
  currentRecordId,
  formatModalErrors,
  isReadOnlyInModal,
  layoutItem,
  locateUnique,
  loginWithPassword,
  modalErrors,
  navTabs,
  onListView,
  onRecordView,
  openModal,
  parseBool,
  parseNumber,
  poll,
  readControl,
  readListView,
  readOutput,
  readPath,
  readRelatedList,
  readToasts,
  searchAppLauncher,
  setControl,
  toIsoDate,
  valuesEqual,
  waitForListViewHeader,
  waitForModal,
  type FieldIo,
  type SfDateFormat,
  type Toast,
} from './lightning.js';
import { nameFieldOf, type DescribeSource, type FieldMeta, type SObjectDescribe } from './metadata.js';
import { SalesforceFieldResolver, controlFor, normalizeLabel, type ResolvedSfField } from './resolver.js';
import { soql } from './soql.js';

/** Username + password for a role; the password may be a secret handle or a resolver function. */
export interface SalesforceCredentials {
  username: string;
  password: SecretInput;
}
export type SalesforceCredentialsProvider = (role: string) => Promise<SalesforceCredentials>;

export type FieldAccessLevel = 'editable' | 'read-only' | 'hidden';

export interface SalesforceStepsOptions {
  /** Where labels and objects are resolved: a SalesforceClient or a StaticDescribeSource. */
  metadata: DescribeSource;
  /** REST client for "Verify in Salesforce" (SOQL) steps; defaults to `metadata` when it is a SalesforceClient. */
  client?: SalesforceClient;
  /** Lightning root URL (e.g. https://acme.lightning.force.com); defaults to the run/journey baseUrl. */
  appUrl?: string;
  /** Login page URL; defaults to appUrl. */
  loginUrl?: string;
  /** Credentials per role for "Log in to Salesforce as <role>". */
  credentials?: SalesforceCredentialsProvider;
  /** A REST client authenticated AS the role, for describe-as-user cross-checks of field access. */
  userClient?: (role: string) => SalesforceClient | undefined;
  /** Date format Lightning shows for the user's locale. Default M/d/yyyy. */
  dateFormat?: SfDateFormat;
  /** Upper bound for Lightning waits. Default: step timeout or 15000ms. */
  timeoutMs?: number;
  /** Store a screenshot per navigation/save/stage step. Default true. */
  screenshots?: boolean;
}

export const SALESFORCE_STEP_NAMES = [
  'sf.login',
  'sf.openTab',
  'sf.openRecord',
  'sf.newRecord',
  'sf.setField',
  'sf.save',
  'sf.cancel',
  'sf.expectToast',
  'sf.expectField',
  'sf.markStageComplete',
  'sf.expectPathStage',
  'sf.expectRelatedList',
  'sf.expectListView',
  'sf.verifySoql',
  'sf.expectFieldAccess',
  'sf.expectTab',
] as const;
export type SalesforceStepName = (typeof SALESFORCE_STEP_NAMES)[number];

interface Bag {
  user?: { role: string; username: string };
  object?: string;
  recordId?: string;
  records: Record<string, string>;
  fields: Record<string, string>;
  lookups: Record<string, { id?: string; name: string }>;
  toast?: Toast;
  stage?: string;
  listView?: { object: string; name: string; rows: number; matched: string[] };
  soql: Record<string, Record<string, unknown>>;
  access: Record<string, { ui: FieldAccessLevel; api?: FieldAccessLevel }>;
  errors?: string[];
}

function bag(ctx: StepContext): Bag {
  const cur = ctx.ledger.get('salesforce') as Partial<Bag> | undefined;
  return { records: {}, fields: {}, lookups: {}, soql: {}, access: {}, ...(cur ?? {}) };
}

function str(step: Step, ctx: StepContext, key: string, allowEmpty = false): string {
  const v = step.args?.[key];
  if (typeof v !== 'string') throw new EzTestError(`${step.handler}: missing argument "${key}"`, 'SF_BAD_STEP');
  const s = ctx.interpolate(v);
  if (!allowEmpty && !s.trim()) throw new EzTestError(`${step.handler}: argument "${key}" is empty`, 'SF_BAD_STEP');
  return s;
}

async function reveal(v: SecretInput): Promise<string> {
  if (typeof v === 'string') return v;
  if (typeof v === 'function') return v();
  return v.resolve();
}

const cssq = (s: string) => s.replace(/(["\\])/g, '\\$1');

export function createSalesforceSteps(opts: SalesforceStepsOptions): Record<SalesforceStepName, CustomStepHandler> {
  if (!opts?.metadata) throw new EzTestError('createSalesforceSteps needs a metadata source (SalesforceClient or StaticDescribeSource)', 'SF_CONFIG');
  const resolver = new SalesforceFieldResolver(opts.metadata);
  const client = opts.client ?? (opts.metadata instanceof SalesforceClient ? opts.metadata : undefined);
  const fmt: SfDateFormat = opts.dateFormat ?? 'M/d/yyyy';
  const shots = opts.screenshots ?? true;
  const timeout = (step: Step) => opts.timeoutMs ?? step.timeoutMs ?? 15_000;

  const evPath = (ctx: StepContext, step: Step, ext: string, suffix = '') =>
    `salesforce/${safeName(ctx.journey.id)}/${safeName(step.id)}${suffix ? '-' + safeName(suffix) : ''}-a${ctx.attempt}.${ext}`;
  const meta = (ctx: StepContext, step: Step, description: string) => ({ journeyId: ctx.journey.id, stepId: step.id, description });

  async function screenshot(page: Page, ctx: StepContext, step: Step, what: string, force = false): Promise<void> {
    if (!shots && !force) return;
    const png = await page.screenshot({ fullPage: true }).catch(() => undefined);
    if (png) await ctx.evidence.store('screenshot', evPath(ctx, step, 'png', what), png, meta(ctx, step, `salesforce ${what}`));
  }
  async function json(ctx: StepContext, step: Step, what: string, data: unknown): Promise<void> {
    await ctx.evidence.store('data', evPath(ctx, step, 'json', what), JSON.stringify(data, null, 2), meta(ctx, step, `salesforce ${what}`));
  }

  function appRoot(ctx: StepContext): string {
    const r = opts.appUrl ?? ctx.baseUrl;
    if (!r) throw new EzTestError('Salesforce steps need appUrl (Salesforce options) or a baseUrl to open Lightning pages', 'SF_CONFIG');
    return r.replace(/\/+$/, '');
  }

  /** Make sure a Lightning page is loaded (and the session is valid). */
  async function ensureLightning(page: Page, ctx: StepContext, t: number): Promise<void> {
    if (/^https?:/.test(page.url()) && new URL(page.url()).pathname.startsWith('/lightning/')) return;
    await page.goto(`${appRoot(ctx)}/lightning/page/home`, { timeout: t });
    if (!new URL(page.url()).pathname.startsWith('/lightning/')) {
      throw new SalesforceUiError('Not logged in to Salesforce (add "Log in to Salesforce as <role>" before this step)', 'SF_NOT_LOGGED_IN');
    }
  }

  async function pageError(page: Page): Promise<string | undefined> {
    const e = page.locator('.slds-illustration[role="alert"]');
    return (await e.count()) ? (await e.innerText()).replace(/\s+/g, ' ').trim() : undefined;
  }

  /** Open an object's tab: navigation bar first, then the App Launcher. */
  async function gotoTab(page: Page, ctx: StepContext, step: Step, d: SObjectDescribe): Promise<'nav' | 'app-launcher'> {
    const t = timeout(step);
    await ensureLightning(page, ctx, t);
    let via: 'nav' | 'app-launcher';
    const nav = page.locator(`one-app-nav-bar a[title="${cssq(d.labelPlural)}"]`);
    if ((await nav.count()) === 1 && (await nav.isVisible())) {
      await nav.click({ timeout: t });
      via = 'nav';
    } else {
      const { labels, items } = await searchAppLauncher(page, d.labelPlural, t);
      const exact = labels.map((l, i) => ({ l, i })).filter((x) => normalizeLabel(x.l) === normalizeLabel(d.labelPlural));
      if (exact.length !== 1) {
        await closeAppLauncher(page);
        throw new SalesforceUiError(
          `The "${d.labelPlural}" tab is not available to this user (not in the navigation bar or the App Launcher${labels.length ? `; launcher shows ${labels.map((l) => `"${l}"`).join(', ')}` : ''})`,
          'SF_TAB_HIDDEN',
        );
      }
      await items.nth(exact[0].i).click({ timeout: t });
      via = 'app-launcher';
    }
    const ok = await poll(async () => (onListView(page, d.name) ? true : (await pageError(page)) ? false : undefined), t);
    if (ok !== true) {
      const why = await pageError(page);
      throw new SalesforceUiError(`Could not open the ${d.labelPlural} tab${why ? `: ${why}` : ` (at ${new URL(page.url()).pathname})`}`, 'SF_TAB_FAILED');
    }
    return via;
  }

  async function fieldIo(page: Page, step: Step, ctx: StepContext, root?: Locator | Page): Promise<{ field: ResolvedSfField; io: FieldIo }> {
    const object = currentObject(page);
    const field = await resolver.resolveField(object, str(step, ctx, 'field'));
    return { field, io: { root: root ?? page, page, field, timeoutMs: timeout(step), dateFormat: fmt } };
  }

  async function waitRecordPage(page: Page, t: number): Promise<string> {
    const id = await poll(async () => (onRecordView(page) ? currentRecordId(page) : undefined), t);
    if (!id) throw new SalesforceUiError(`The record page did not open within ${t}ms (at ${new URL(page.url()).pathname})`, 'SF_NO_RECORD_PAGE');
    await page.locator('records-highlights2 h1').waitFor({ state: 'visible', timeout: t });
    return id;
  }

  async function uiAccess(page: Page, f: ResolvedSfField, t: number): Promise<FieldAccessLevel> {
    const modal = await openModal(page);
    const io: FieldIo = { root: modal ?? page, page, field: f, timeoutMs: Math.min(t, 2000), dateFormat: fmt };
    let item: Locator;
    try {
      item = await layoutItem(io);
    } catch (e) {
      if (e instanceof SalesforceUiError && e.code === 'SF_NOT_FOUND') return 'hidden';
      throw e;
    }
    if (modal) return (await isReadOnlyInModal(item, f)) ? 'read-only' : 'editable';
    return (await item.locator(`button[title="Edit ${cssq(f.label)}"]`).count()) === 1 ? 'editable' : 'read-only';
  }

  const handlers: Record<SalesforceStepName, CustomStepHandler> = {
    'sf.login': async (page, step, ctx) => {
      if (!opts.credentials) throw new EzTestError('"Log in to Salesforce" needs a credentials provider (Salesforce options.credentials)', 'SF_CONFIG');
      const role = str(step, ctx, 'role');
      const t = timeout(step);
      const cred = await opts.credentials(role);
      if (!cred?.username) throw new EzTestError(`No Salesforce username for role "${role}"`, 'SF_CONFIG');
      const outcome = await loginWithPassword(page, opts.loginUrl ?? appRoot(ctx), cred.username, await reveal(cred.password), t);
      if (!outcome.ok) {
        await screenshot(page, ctx, step, 'login-failed', true);
        throw new SalesforceUiError(`Salesforce login as ${role} (${cred.username}) failed: ${outcome.error}`, 'SF_LOGIN_FAILED');
      }
      const b = bag(ctx);
      b.user = { role, username: cred.username };
      ctx.ledger.set('salesforce', b);
      await json(ctx, step, 'login', { role, username: cred.username, landedOn: new URL(page.url()).pathname });
      await screenshot(page, ctx, step, 'home');
    },

    'sf.openTab': async (page, step, ctx) => {
      const d = await resolver.resolveObject(str(step, ctx, 'tab'));
      const via = await gotoTab(page, ctx, step, d);
      const list = await readListView(page, timeout(step));
      const b = bag(ctx);
      b.object = d.name;
      delete b.recordId;
      b.listView = { object: d.name, name: list.name, rows: list.rows.length, matched: [] };
      ctx.ledger.set('salesforce', b);
      await json(ctx, step, 'tab', { object: d.name, tab: d.labelPlural, via, listView: list.name, rows: list.rows.length });
      await screenshot(page, ctx, step, 'tab');
    },

    'sf.openRecord': async (page, step, ctx) => {
      const d = await resolver.resolveObject(str(step, ctx, 'object'));
      const name = str(step, ctx, 'name');
      const t = timeout(step);
      const nf = nameFieldOf(d);
      if (!onListView(page, d.name)) await gotoTab(page, ctx, step, d);
      const list = await readListView(page, t);
      const hits = list.rows.filter((r) => normalizeLabel(r.cells[nf.label] ?? '') === normalizeLabel(name));
      let via = 'list view';
      if (hits.length > 1) throw new SalesforceUiError(`${hits.length} ${d.label} rows named "${name}" in list view "${list.name}"`, 'SF_AMBIGUOUS');
      if (hits.length === 1) {
        await page.locator(`lightning-datatable tr[data-row-key-value="${cssq(hits[0].id ?? '')}"] a[data-recordid]`).click({ timeout: t });
      } else {
        if (!client) throw new SalesforceUiError(`No ${d.label} named "${name}" in list view "${list.name}" (and no REST client to search)`, 'SF_NOT_FOUND');
        const rows = await client.findByName(d.name, name, { limit: 2 });
        if (rows.length !== 1) throw new SalesforceUiError(`Salesforce has ${rows.length} ${d.label} record(s) named "${name}" (expected exactly one)`, rows.length ? 'SF_AMBIGUOUS' : 'SF_NOT_FOUND');
        await page.goto(`${appRoot(ctx)}/lightning/r/${d.name}/${String(rows[0].Id)}/view`, { timeout: t });
        via = 'SOQL';
      }
      const id = await waitRecordPage(page, t);
      const title = (await page.locator('records-highlights2 h1').innerText()).trim();
      if (normalizeLabel(title) !== normalizeLabel(name)) throw new SalesforceUiError(`Opened record shows "${title}", expected "${name}"`, 'SF_WRONG_RECORD');
      const b = bag(ctx);
      b.object = d.name;
      b.recordId = id;
      b.records[d.name] = id;
      ctx.ledger.set('salesforce', b);
      await json(ctx, step, 'record', { object: d.name, name, id, via });
      await screenshot(page, ctx, step, 'record');
    },

    'sf.newRecord': async (page, step, ctx) => {
      const d = await resolver.resolveObject(str(step, ctx, 'object'));
      const t = timeout(step);
      if (!onListView(page, d.name)) await gotoTab(page, ctx, step, d);
      // The header (and its New button) renders after the URL changes: read it once it is there.
      if (!(await waitForListViewHeader(page, t))) throw new SalesforceUiError(`The ${d.labelPlural} list view did not finish loading within ${t} ms (no list view header)`, 'SF_TAB_FAILED');
      const btn = page.locator('lst-list-view-manager-header a[title="New"], lst-list-view-manager-header button[name="New"]');
      if ((await btn.count()) !== 1) throw new SalesforceUiError(`No "New" button on the ${d.labelPlural} list view (the user may not be allowed to create ${d.labelPlural})`, 'SF_NO_CREATE');
      await btn.click({ timeout: t });
      await waitForModal(page, t, `The "New ${d.label}" modal`);
      const b = bag(ctx);
      b.object = d.name;
      delete b.recordId;
      ctx.ledger.set('salesforce', b);
      await screenshot(page, ctx, step, 'new');
    },

    'sf.setField': async (page, step, ctx) => {
      const t = timeout(step);
      let modal = await openModal(page);
      const { field } = await fieldIo(page, step, ctx);
      const value = str(step, ctx, 'value', true);
      if (step.args?.kind === 'lookup' && field.control !== 'lookup') {
        throw new SalesforceUiError(`"${field.label}" on ${field.object} is a ${field.field.type} field, not a lookup`, 'SF_BAD_STEP');
      }
      if (!modal) {
        if (!onRecordView(page)) throw new SalesforceUiError(`No record is being edited (open or create a ${field.object} first)`, 'SF_NO_MODAL');
        // Inline edit: the pencil next to the field opens the record in edit mode.
        const out = await locateUnique(page, field.containers, `Salesforce field "${field.label}" on the record page`, t);
        const pencil = out.locator.locator(`button[title="Edit ${cssq(field.label)}"]`);
        if ((await pencil.count()) !== 1) throw new SalesforceUiError(`Salesforce field "${field.label}" (${field.name}) is read-only for this user (no inline edit)`, 'SF_READ_ONLY');
        await pencil.click({ timeout: t });
        modal = await waitForModal(page, t);
      }
      const io: FieldIo = { root: modal, page, field, timeoutMs: t, dateFormat: fmt };
      const r = await setControl(io, value);
      const b = bag(ctx);
      b.object = field.object;
      b.fields[field.name] = r.readBack;
      if (field.control === 'lookup') b.lookups[field.name] = { ...(r.lookupId ? { id: r.lookupId } : {}), name: r.readBack };
      ctx.ledger.set('salesforce', b);
      await json(ctx, step, 'field', {
        object: field.object, field: field.label, apiName: field.name, type: field.field.type, control: field.control, value, readBack: r.readBack,
        locator: r.candidate, ...(r.lookupId ? { lookupId: r.lookupId } : {}),
      });
    },

    'sf.save': async (page, step, ctx) => {
      const t = timeout(step);
      const modal = await openModal(page);
      if (!modal) throw new SalesforceUiError('No record edit modal is open (nothing to save)', 'SF_NO_MODAL');
      const object = currentObject(page);
      const expectError = typeof step.args?.expectError === 'string' ? ctx.interpolate(step.args.expectError) : undefined;
      const { locator } = await locateUnique(modal, [{ strategy: 'css', value: 'button[name="SaveEdit"]' }, { strategy: 'role', value: 'button', name: 'Save' }], 'Save button', t);
      await locator.click({ timeout: t });
      const outcome = await poll(async () => {
        const m = await openModal(page);
        if (!m) return onRecordView(page) ? { ok: true as const } : undefined;
        if ((await m.locator('.slds-spinner_container').count()) > 0) return undefined;
        const errs = await modalErrors(m);
        if (errs.fields.length || errs.page.length) return { ok: false as const, errs };
        return undefined;
      }, t);
      if (!outcome) {
        await screenshot(page, ctx, step, 'save-timeout', true);
        throw new SalesforceUiError(`Save did not complete within ${t}ms`, 'SF_SAVE_TIMEOUT');
      }
      const b = bag(ctx);
      if (!outcome.ok) {
        const text = formatModalErrors(outcome.errs);
        b.errors = [text];
        ctx.ledger.set('salesforce', b);
        await screenshot(page, ctx, step, 'save-failed', true);
        await json(ctx, step, 'save-failed', { object, fieldErrors: outcome.errs.fields, pageErrors: outcome.errs.page });
        if (expectError !== undefined) {
          if (!text.toLowerCase().includes(expectError.toLowerCase())) throw new SalesforceUiError(`Save failed with "${text}", expected an error containing "${expectError}"`, 'SF_ASSERT');
          return;
        }
        throw new SalesforceUiError(`Save failed: ${text}`, 'SF_SAVE_FAILED', { fieldErrors: outcome.errs.fields, pageErrors: outcome.errs.page });
      }
      const id = await waitRecordPage(page, t);
      if (expectError !== undefined) throw new SalesforceUiError(`Expected the save to fail with "${expectError}" but the record was saved (${id})`, 'SF_ASSERT');
      const toast = await poll(async () => (await readToasts(page)).find((x) => x.type === 'success'), Math.min(t, 3000));
      b.object = object;
      b.recordId = id;
      b.records[object] = id;
      delete b.errors;
      if (toast) b.toast = toast;
      ctx.ledger.set('salesforce', b);
      if (step.captureAs) ctx.ledger.set(step.captureAs, id);
      await json(ctx, step, 'saved', { object, id, toast: toast?.message });
      await screenshot(page, ctx, step, 'saved');
    },

    'sf.cancel': async (page, step) => {
      const t = timeout(step);
      const modal = await openModal(page);
      if (!modal) throw new SalesforceUiError('No record edit modal is open (nothing to cancel)', 'SF_NO_MODAL');
      await modal.locator('button[name="CancelEdit"]').click({ timeout: t });
      const gone = await poll(async () => ((await openModal(page)) ? undefined : true), t);
      if (!gone) throw new SalesforceUiError('The record modal did not close after Cancel', 'SF_UI');
    },

    'sf.expectToast': async (page, step, ctx) => {
      const want = str(step, ctx, 'text');
      const b = bag(ctx);
      let seen: Toast[] = [];
      const hit = await poll(async () => {
        seen = await readToasts(page);
        return seen.find((x) => x.message.toLowerCase().includes(want.toLowerCase()));
      }, Math.min(timeout(step), 5000));
      // A toast captured by the save step may have auto-dismissed already.
      const found = hit ?? (b.toast && b.toast.message.toLowerCase().includes(want.toLowerCase()) ? b.toast : undefined);
      await json(ctx, step, 'toast', { expected: want, toasts: seen, captured: b.toast, passed: !!found });
      if (!found) {
        const all = [...seen.map((x) => `${x.type}: "${x.message}"`), ...(b.toast && !seen.length ? [`(earlier) ${b.toast.type}: "${b.toast.message}"`] : [])];
        throw new SalesforceUiError(`No toast contains "${want}" (toasts: ${all.join(', ') || 'none'})`, 'SF_ASSERT');
      }
      b.toast = found;
      ctx.ledger.set('salesforce', b);
    },

    'sf.expectField': async (page, step, ctx) => {
      const modal = await openModal(page);
      const { field, io } = await fieldIo(page, step, ctx, modal ?? page);
      const want = str(step, ctx, 'value', true);
      let last = '';
      const ok = await poll(async () => {
        last = modal ? await readControl(io) : await readOutput(io);
        return valuesEqual(field, last, want, fmt) ? true : undefined;
      }, Math.min(timeout(step), 5000));
      const b = bag(ctx);
      b.fields[field.name] = last;
      ctx.ledger.set('salesforce', b);
      await json(ctx, step, 'field-check', { object: field.object, field: field.label, apiName: field.name, expected: want, actual: last, where: modal ? 'edit modal' : 'record page', passed: !!ok });
      if (!ok) throw new SalesforceUiError(`Salesforce field "${field.label}" (${field.name}) is "${last}", expected "${want}"`, 'SF_ASSERT');
    },

    'sf.markStageComplete': async (page, step, ctx) => {
      const t = timeout(step);
      const before = await readPath(page, t);
      if (before.currentIndex >= before.stages.length - 1) throw new SalesforceUiError(`"${before.current}" is the last path stage`, 'SF_PATH_LAST');
      if (normalizeLabel(before.selected) !== normalizeLabel(before.current)) {
        await page.locator(`lightning-path a[role="option"][title="${cssq(before.current)}"]`).click({ timeout: t });
      }
      const errorsBefore = (await readToasts(page)).filter((x) => x.type === 'error').length;
      const btn = page.locator('lightning-path').getByRole('button', { name: 'Mark Stage as Complete', exact: true });
      if ((await btn.count()) !== 1) throw new SalesforceUiError('No "Mark Stage as Complete" button on the path', 'SF_PATH_NO_BUTTON');
      await btn.click({ timeout: t });
      const res = await poll(async () => {
        const errs = (await readToasts(page)).filter((x) => x.type === 'error');
        if (errs.length > errorsBefore) return { error: errs[errs.length - 1].message };
        const now = await readPath(page, t);
        return now.currentIndex !== before.currentIndex ? { stage: now.current } : undefined;
      }, t);
      if (!res) throw new SalesforceUiError(`The path did not move from "${before.current}" within ${t}ms`, 'SF_PATH_TIMEOUT');
      if ('error' in res) {
        await screenshot(page, ctx, step, 'stage-failed', true);
        throw new SalesforceUiError(`Could not mark "${before.current}" as complete: ${res.error}`, 'SF_PATH_BLOCKED');
      }
      const b = bag(ctx);
      b.stage = res.stage;
      ctx.ledger.set('salesforce', b);
      await json(ctx, step, 'stage', { from: before.current, to: res.stage, stages: before.stages });
      await screenshot(page, ctx, step, 'stage');
    },

    'sf.expectPathStage': async (page, step, ctx) => {
      const want = str(step, ctx, 'stage');
      let last = '';
      const ok = await poll(async () => {
        const s = await readPath(page, timeout(step));
        last = s.current;
        return normalizeLabel(s.current) === normalizeLabel(want) ? s : undefined;
      }, Math.min(timeout(step), 5000));
      await json(ctx, step, 'path', { expected: want, actual: last, passed: !!ok });
      if (!ok) throw new SalesforceUiError(`The path stage is "${last}", expected "${want}"`, 'SF_ASSERT');
      const b = bag(ctx);
      b.stage = ok.current;
      ctx.ledger.set('salesforce', b);
    },

    'sf.expectRelatedList': async (page, step, ctx) => {
      const label = str(step, ctx, 'list');
      const want = str(step, ctx, 'value');
      if (!onRecordView(page)) throw new SalesforceUiError(`Related lists are on record pages; open a record first (at ${new URL(page.url()).pathname})`, 'SF_NO_RECORD_PAGE');
      const { rows } = await readRelatedList(page, label, Math.min(timeout(step), 5000));
      const matched = rows.filter((r) => Object.values(r.cells).some((c) => normalizeLabel(c) === normalizeLabel(want)));
      await json(ctx, step, 'related-list', { list: label, expected: want, rows });
      if (!matched.length) {
        const shown = rows.slice(0, 10).map((r) => `"${Object.values(r.cells)[0] ?? ''}"`);
        throw new SalesforceUiError(`Related list "${label}" has no row with "${want}" (${rows.length} rows: ${shown.join(', ') || 'none'})`, 'SF_ASSERT');
      }
    },

    'sf.expectListView': async (page, step, ctx) => {
      const d = await resolver.resolveObject(str(step, ctx, 'object'));
      const want = str(step, ctx, 'value');
      if (!onListView(page, d.name)) await gotoTab(page, ctx, step, d);
      const list = await readListView(page, timeout(step));
      const matched = list.rows.filter((r) => Object.values(r.cells).some((c) => normalizeLabel(c) === normalizeLabel(want)));
      const b = bag(ctx);
      b.object = d.name;
      b.listView = { object: d.name, name: list.name, rows: list.rows.length, matched: matched.map((r) => r.id ?? '') };
      ctx.ledger.set('salesforce', b);
      await json(ctx, step, 'list-view', { object: d.name, listView: list.name, expected: want, rows: list.rows });
      await screenshot(page, ctx, step, 'list-view', !matched.length);
      if (!matched.length) {
        const nf = nameFieldOf(d);
        const names = list.rows.slice(0, 10).map((r) => `"${r.cells[nf.label] ?? Object.values(r.cells)[0] ?? ''}"`);
        throw new SalesforceUiError(`List view "${list.name}" has no row with "${want}" (${list.rows.length} rows: ${names.join(', ')})`, 'SF_ASSERT');
      }
    },

    'sf.verifySoql': async (_page, step, ctx) => {
      if (!client) throw new EzTestError('"Verify in Salesforce" needs a SalesforceClient (Salesforce options.client)', 'SF_CONFIG');
      const d = await resolver.resolveObject(str(step, ctx, 'object'));
      const name = str(step, ctx, 'name');
      const exp = step.args?.expect;
      if (!exp || typeof exp !== 'object' || !Object.keys(exp).length) throw new EzTestError('sf.verifySoql: no expectations given', 'SF_BAD_STEP');
      const nf = nameFieldOf(d);
      const wanted: Array<{ key: string; expected: string; field: FieldMeta; rel?: string }> = [];
      const select = new Set<string>(['Id', nf.name]);
      for (const [key, raw] of Object.entries(exp as Record<string, unknown>)) {
        const { field } = await resolver.resolveFieldMeta(d.name, key);
        select.add(field.name);
        let rel: string | undefined;
        if (field.type === 'reference' && field.relationshipName && (field.referenceTo ?? []).length === 1) {
          const target = await opts.metadata.describe(field.referenceTo![0]);
          rel = `${field.relationshipName}.${nameFieldOf(target).name}`;
          select.add(rel);
        }
        wanted.push({ key, expected: ctx.interpolate(String(raw)), field, rel });
      }
      const query = soql(d.name).select([...select]).where({ [nf.name]: name }).limit(2);
      const rows = await client.query(query);
      if (rows.length !== 1) {
        throw new SalesforceUiError(`Salesforce has ${rows.length} ${d.label} record(s) named "${name}" (expected exactly one)`, rows.length ? 'SF_AMBIGUOUS' : 'SF_NOT_FOUND');
      }
      const rec = rows[0];
      const checks = wanted.map((w) => {
        const actual = rec[w.field.name] ?? null;
        const relName = w.rel ? relValue(rec, w.rel) : undefined;
        return {
          field: w.key, apiName: w.field.name, expected: w.expected, actual, ...(w.rel ? { related: relName ?? null } : {}),
          passed: salesforceEquals(w.field, actual, w.expected, relName, fmt),
        };
      });
      const soqlText = await query.compile(opts.metadata);
      await json(ctx, step, 'soql', { object: d.name, name, id: rec.Id, soql: soqlText, checks });
      const b = bag(ctx);
      b.soql[d.name] = { Id: rec.Id, ...Object.fromEntries(checks.map((c) => [c.apiName, c.actual])) };
      ctx.ledger.set('salesforce', b);
      const bad = checks.filter((c) => !c.passed);
      if (bad.length) {
        throw new SalesforceUiError(
          `Salesforce ${d.label} "${name}": ${bad.map((c) => `${c.apiName} is ${JSON.stringify(c.related ?? c.actual)}, expected "${c.expected}"`).join('; ')}`,
          'SF_ASSERT',
        );
      }
    },

    'sf.expectFieldAccess': async (page, step, ctx) => {
      const wantRaw = str(step, ctx, 'access');
      const want = normalizeAccess(wantRaw);
      const object = currentObject(page);
      const f = await resolver.resolveField(object, str(step, ctx, 'field'));
      const ui = await uiAccess(page, f, timeout(step));
      const b = bag(ctx);
      let api: FieldAccessLevel | undefined;
      let apiError: string | undefined;
      const uc = b.user ? opts.userClient?.(b.user.role) : undefined;
      if (uc) {
        try {
          const d = await uc.describe(object);
          const df = d.fields.find((x) => x.name === f.name);
          api = !df ? 'hidden' : df.updateable || df.createable ? 'editable' : 'read-only';
        } catch (e) {
          apiError = (e as Error).message;
        }
      }
      b.access[`${object}.${f.name}`] = { ui, ...(api ? { api } : {}) };
      ctx.ledger.set('salesforce', b);
      await json(ctx, step, 'field-access', { object, field: f.label, apiName: f.name, user: b.user, expected: want, ui, api, apiError });
      const problems: string[] = [];
      if (ui !== want) problems.push(`the page shows it as ${ui}`);
      if (api && api !== want) problems.push(`describe as ${b.user?.username} says ${api}`);
      if (apiError) problems.push(`describe as ${b.user?.username} failed: ${apiError}`);
      if (problems.length) {
        await screenshot(page, ctx, step, 'field-access', true);
        throw new SalesforceUiError(`Salesforce field "${f.label}" (${object}.${f.name}) should be ${want}, but ${problems.join(' and ')}`, 'SF_ASSERT');
      }
    },

    'sf.expectTab': async (page, step, ctx) => {
      const d = await resolver.resolveObject(str(step, ctx, 'tab'));
      const vis = step.args?.visible;
      if (vis !== true && vis !== false && vis !== 'true' && vis !== 'false') throw new EzTestError('sf.expectTab: argument "visible" must be true or false', 'SF_BAD_STEP');
      const wantVisible = vis === true || vis === 'true';
      const t = timeout(step);
      await ensureLightning(page, ctx, t);
      const nav = await navTabs(page);
      const inNav = nav.some((l) => normalizeLabel(l) === normalizeLabel(d.labelPlural));
      const { labels } = await searchAppLauncher(page, d.labelPlural, t);
      await closeAppLauncher(page);
      const inLauncher = labels.some((l) => normalizeLabel(l) === normalizeLabel(d.labelPlural));
      const visible = inNav || inLauncher;
      await json(ctx, step, 'tab-visibility', { tab: d.labelPlural, object: d.name, user: bag(ctx).user, navigationBar: nav, inNav, inLauncher, expectedVisible: wantVisible });
      if (visible !== wantVisible) {
        await screenshot(page, ctx, step, 'tab', true);
        throw new SalesforceUiError(
          `The "${d.labelPlural}" tab should be ${wantVisible ? 'visible' : 'hidden'} but it is ${visible ? `visible (${inNav ? 'navigation bar' : 'App Launcher'})` : 'not available'}`,
          'SF_ASSERT',
        );
      }
    },
  };
  return handlers;
}

function relValue(rec: SalesforceRecord, path: string): string | undefined {
  let cur: unknown = rec;
  for (const p of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur === null || cur === undefined ? undefined : String(cur);
}

export function normalizeAccess(s: string): FieldAccessLevel {
  const v = s.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (v === 'read-only' || v === 'readonly' || v === 'read') return 'read-only';
  if (v === 'editable' || v === 'edit' || v === 'writable') return 'editable';
  if (v === 'hidden' || v === 'not-visible' || v === 'invisible') return 'hidden';
  throw new EzTestError(`Unknown field access "${s}" (use read-only, editable or hidden)`, 'SF_BAD_STEP');
}

/** Compare a REST/SOQL value with a user-written expectation, by field type. */
export function salesforceEquals(field: FieldMeta, actual: unknown, expected: string, related?: string, fmt: SfDateFormat = 'M/d/yyyy'): boolean {
  const e = expected.trim();
  if (actual === null || actual === undefined) return e === '' || /^null$/i.test(e);
  if (typeof actual === 'string' && actual === e) return true;
  switch (controlFor(field.type)) {
    case 'currency':
    case 'number': {
      const n = parseNumber(e);
      return n !== undefined && typeof actual === 'number' && n === actual;
    }
    case 'checkbox':
      try {
        return parseBool(e) === actual;
      } catch {
        return false;
      }
    case 'date': {
      const a = typeof actual === 'string' ? toIsoDate(actual) : undefined;
      return a !== undefined && a === toIsoDate(e, fmt);
    }
    case 'picklist': {
      const n = normalizeLabel(e);
      if (normalizeLabel(String(actual)) === n) return true;
      const pv = (field.picklistValues ?? []).find((p) => p.value === actual);
      return !!pv && normalizeLabel(pv.label) === n;
    }
    case 'lookup':
      return String(actual).toLowerCase() === e.toLowerCase() || (related !== undefined && normalizeLabel(related) === normalizeLabel(e));
    default:
      return typeof actual === 'string' && actual.replace(/\s+/g, ' ').trim() === e.replace(/\s+/g, ' ');
  }
}
