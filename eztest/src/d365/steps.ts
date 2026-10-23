/**
 * D365 custom step handlers (keyed `d365.*`) for the runner. Each handler
 * stores evidence (screenshot and/or JSON) and records what it saw under the
 * `d365` ledger key, e.g. `${d365.recordId}`, `${d365.fields.name}`.
 */
import type { Page } from '../browser/index.js';
import { EzTestError, type Step } from '../core/index.js';
import { safeName } from '../runner/evidence.js';
import type { CustomStepHandler, StepContext } from '../runner/types.js';
import { DataverseClient, FORMATTED_SUFFIX, type DataverseRecord } from './client.js';
import type { MetadataSource } from './metadata.js';
import { FieldResolver, controlTypeFor, normalizeLabel, webApiColumn } from './resolver.js';
import {
  D365UiError,
  currentEntity,
  formNotifications,
  locateUnique,
  parseNumber,
  parseTwoOption,
  poll,
  readField,
  readGrid,
  readStages,
  saveButtonSelector,
  saveStatus,
  setField,
  toIsoDate,
  urlParams,
  valuesEqual,
  waitForForm,
  type DateFormat,
} from './uci.js';

export interface D365StepsOptions {
  /** Where field labels and entities are resolved: a DataverseClient or a StaticMetadataSource. */
  metadata: MetadataSource;
  /** Web API client for "Verify in Dataverse" steps; defaults to `metadata` when it is a DataverseClient. */
  client?: DataverseClient;
  /** UCI root URL (e.g. https://contoso.crm.dynamics.com); defaults to the run/journey baseUrl. */
  appUrl?: string;
  /** Model-driven app id appended as appid= when opening pages by URL. */
  appId?: string;
  /** Date format the UCI date controls display (user setting). Default M/d/yyyy. */
  dateFormat?: DateFormat;
  /** Upper bound for UCI waits (save, flyouts, grids). Default: step timeout or 15000ms. */
  timeoutMs?: number;
  /** Store a screenshot per navigation/save/stage/view step. Default true. */
  screenshots?: boolean;
}

export const D365_STEP_NAMES = [
  'd365.openForm',
  'd365.openRecord',
  'd365.openView',
  'd365.setField',
  'd365.save',
  'd365.nextStage',
  'd365.expectStage',
  'd365.expectField',
  'd365.expectSaved',
  'd365.expectView',
  'd365.expectNotification',
  'd365.verifyDataverse',
] as const;
export type D365StepName = (typeof D365_STEP_NAMES)[number];

interface Bag {
  entity?: string;
  recordId?: string;
  records: Record<string, string>;
  fields: Record<string, string>;
  lookups: Record<string, { id?: string; name: string }>;
  stage?: string;
  view?: { entity: string; name: string; rows: number; matched: string[] };
  dataverse: Record<string, DataverseRecord>;
}

function bag(ctx: StepContext): Bag {
  const cur = ctx.ledger.get('d365') as Partial<Bag> | undefined;
  const b: Bag = { records: {}, fields: {}, lookups: {}, dataverse: {}, ...(cur ?? {}) };
  return b;
}

function str(step: Step, ctx: StepContext, key: string, allowEmpty = false): string {
  const v = step.args?.[key];
  if (typeof v !== 'string') throw new EzTestError(`${step.handler}: missing argument "${key}"`, 'D365_BAD_STEP');
  const s = ctx.interpolate(v);
  if (!allowEmpty && !s.trim()) throw new EzTestError(`${step.handler}: argument "${key}" is empty`, 'D365_BAD_STEP');
  return s;
}

export function createD365Steps(opts: D365StepsOptions): Record<D365StepName, CustomStepHandler> {
  if (!opts?.metadata) throw new EzTestError('createD365Steps needs a metadata source (DataverseClient or StaticMetadataSource)', 'D365_CONFIG');
  const resolver = new FieldResolver(opts.metadata);
  const client = opts.client ?? (opts.metadata instanceof DataverseClient ? opts.metadata : undefined);
  const fmt: DateFormat = opts.dateFormat ?? 'M/d/yyyy';
  const shots = opts.screenshots ?? true;
  const timeout = (step: Step) => opts.timeoutMs ?? step.timeoutMs ?? 15_000;

  const evPath = (ctx: StepContext, step: Step, ext: string, suffix = '') =>
    `d365/${safeName(ctx.journey.id)}/${safeName(step.id)}${suffix ? '-' + safeName(suffix) : ''}-a${ctx.attempt}.${ext}`;
  const meta = (ctx: StepContext, step: Step, description: string) => ({ journeyId: ctx.journey.id, stepId: step.id, description });

  async function screenshot(page: Page, ctx: StepContext, step: Step, what: string, force = false): Promise<void> {
    if (!shots && !force) return;
    const png = await page.screenshot({ fullPage: true }).catch(() => undefined);
    if (png) await ctx.evidence.store('screenshot', evPath(ctx, step, 'png', what), png, meta(ctx, step, `d365 ${what}`));
  }
  async function json(ctx: StepContext, step: Step, what: string, data: unknown): Promise<void> {
    await ctx.evidence.store('data', evPath(ctx, step, 'json', what), JSON.stringify(data, null, 2), meta(ctx, step, `d365 ${what}`));
  }

  function rootUrl(ctx: StepContext): string {
    const r = opts.appUrl ?? ctx.baseUrl;
    if (!r) throw new EzTestError('D365 steps need appUrl (D365 options) or a baseUrl to open model-driven pages', 'D365_CONFIG');
    return r.endsWith('/') ? r : r + '/';
  }
  function pageUrl(ctx: StepContext, pagetype: 'entityrecord' | 'entitylist', etn: string, id?: string): string {
    const p = new URLSearchParams();
    if (opts.appId) p.set('appid', opts.appId);
    p.set('pagetype', pagetype);
    p.set('etn', etn);
    if (id) p.set('id', id);
    return new URL(`main.aspx?${p.toString()}`, rootUrl(ctx)).toString();
  }

  async function openView(page: Page, ctx: StepContext, step: Step, etn: string): Promise<void> {
    const nav = page.locator(`li[data-id="sitemap-entity-${etn}"]`);
    if ((await nav.count()) === 1 && (await nav.isVisible())) {
      await nav.click({ timeout: timeout(step) });
      await page.waitForURL((u) => u.searchParams.get('pagetype') === 'entitylist' && u.searchParams.get('etn') === etn, { timeout: timeout(step) });
    } else {
      await page.goto(pageUrl(ctx, 'entitylist', etn), { timeout: timeout(step) });
    }
  }

  function onView(page: Page, etn: string): boolean {
    const p = urlParams(page);
    return p.get('pagetype') === 'entitylist' && p.get('etn') === etn;
  }

  async function fieldOnForm(page: Page, step: Step, ctx: StepContext) {
    const etn = currentEntity(page);
    const field = await resolver.resolveField(etn, str(step, ctx, 'field'));
    return { etn, field, io: { page, field, timeoutMs: timeout(step), dateFormat: fmt } };
  }

  const handlers: Record<D365StepName, CustomStepHandler> = {
    'd365.openForm': async (page, step, ctx) => {
      const ent = await resolver.resolveEntity(str(step, ctx, 'entity'));
      await page.goto(pageUrl(ctx, 'entityrecord', ent.logicalName), { timeout: timeout(step) });
      await waitForForm(page, ent.logicalName, timeout(step));
      const b = bag(ctx);
      b.entity = ent.logicalName;
      delete b.recordId;
      ctx.ledger.set('d365', b);
      await screenshot(page, ctx, step, 'form');
    },

    'd365.openRecord': async (page, step, ctx) => {
      const ent = await resolver.resolveEntity(str(step, ctx, 'entity'));
      const name = str(step, ctx, 'name');
      if (!onView(page, ent.logicalName)) await openView(page, ctx, step, ent.logicalName);
      const grid = await readGrid(page, timeout(step));
      const hits = grid.rows.filter((r) => normalizeLabel(r.cells[ent.primaryNameAttribute] ?? '') === normalizeLabel(name));
      if (hits.length !== 1) {
        throw new D365UiError(`${hits.length === 0 ? 'No' : hits.length} ${ent.logicalName} row(s) named "${name}" in view "${grid.name}"`, hits.length ? 'D365_AMBIGUOUS' : 'D365_NOT_FOUND');
      }
      const link = page.locator(`[role="grid"] [role="row"][data-id="row-${hits[0].id}"] [col-id="${ent.primaryNameAttribute}"] a`);
      await link.click({ timeout: timeout(step) });
      await waitForForm(page, ent.logicalName, timeout(step));
      const b = bag(ctx);
      b.entity = ent.logicalName;
      b.recordId = urlParams(page).get('id') ?? hits[0].id;
      if (b.recordId) b.records[ent.logicalName] = b.recordId;
      ctx.ledger.set('d365', b);
      await screenshot(page, ctx, step, 'record');
    },

    'd365.openView': async (page, step, ctx) => {
      const ent = await resolver.resolveEntity(str(step, ctx, 'entity'));
      await openView(page, ctx, step, ent.logicalName);
      const grid = await readGrid(page, timeout(step));
      const b = bag(ctx);
      b.entity = ent.logicalName;
      b.view = { entity: ent.logicalName, name: grid.name, rows: grid.rows.length, matched: [] };
      ctx.ledger.set('d365', b);
      await screenshot(page, ctx, step, 'view');
    },

    'd365.setField': async (page, step, ctx) => {
      const { etn, field, io } = await fieldOnForm(page, step, ctx);
      const value = str(step, ctx, 'value', true);
      if (step.args?.kind === 'lookup' && field.control !== 'lookup') {
        throw new D365UiError(`"${field.label ?? field.logicalName}" on ${etn} is a ${field.attribute.attributeType} field, not a lookup`, 'D365_BAD_STEP');
      }
      const r = await setField(io, value);
      const b = bag(ctx);
      b.entity = etn;
      b.fields[field.logicalName] = r.readBack;
      if (field.control === 'lookup') b.lookups[field.logicalName] = { id: 'lookupId' in r ? r.lookupId : undefined, name: r.readBack };
      ctx.ledger.set('d365', b);
      await json(ctx, step, 'field', {
        entity: etn, field: field.label, logicalName: field.logicalName, type: field.attribute.attributeType, control: field.control,
        value, readBack: r.readBack, locator: 'candidate' in r ? r.candidate : field.container,
      });
    },

    'd365.save': async (page, step, ctx) => {
      const etn = currentEntity(page);
      const close = step.args?.close === true || step.args?.close === 'true';
      const t = timeout(step);
      const { locator } = await locateUnique(page, [{ strategy: 'css', value: saveButtonSelector(etn, close) }], `${close ? 'Save & Close' : 'Save'} command`, t);
      await locator.click({ timeout: t });
      const outcome = await poll(async () => {
        const errs = await formNotifications(page);
        if (errs.length) return { errors: errs };
        const busy = await page.locator('[data-id="saveProgressIndicator"]').isVisible().catch(() => false);
        if (busy) return undefined;
        if (close) return onView(page, etn) ? { errors: [] as string[] } : undefined;
        const status = await saveStatus(page);
        return status === 'Saved' && urlParams(page).get('id') ? { errors: [] as string[] } : undefined;
      }, t);
      if (!outcome) {
        await screenshot(page, ctx, step, 'save-timeout', true);
        throw new D365UiError(`Save did not complete within ${t}ms (status "${await saveStatus(page)}")`, 'D365_SAVE_TIMEOUT');
      }
      if (outcome.errors.length) {
        await screenshot(page, ctx, step, 'save-failed', true);
        await json(ctx, step, 'save-failed', { entity: etn, notifications: outcome.errors });
        throw new D365UiError(`Save failed: ${outcome.errors.join(' | ')}`, 'D365_SAVE_FAILED', { notifications: outcome.errors });
      }
      const b = bag(ctx);
      b.entity = etn;
      if (!close) {
        b.recordId = urlParams(page).get('id') ?? undefined;
        if (b.recordId) b.records[etn] = b.recordId;
      }
      ctx.ledger.set('d365', b);
      if (step.captureAs && b.recordId) ctx.ledger.set(step.captureAs, b.recordId);
      await screenshot(page, ctx, step, close ? 'saved-closed' : 'saved');
    },

    'd365.nextStage': async (page, step, ctx) => {
      const t = timeout(step);
      const before = await readStages(page, t);
      if (before.activeIndex >= before.stages.length - 1) throw new D365UiError(`"${before.active}" is the last business process stage`, 'D365_BPF_LAST');
      await page.locator('[data-id="processStageArea"] [role="button"][aria-current="step"]').click({ timeout: t });
      const next = page.getByRole('button', { name: 'Next Stage', exact: true });
      try {
        await next.waitFor({ state: 'visible', timeout: t });
      } catch {
        throw new D365UiError(`No "Next Stage" button in the ${before.active} stage flyout`, 'D365_BPF_NO_NEXT');
      }
      await next.click({ timeout: t });
      const res = await poll(async () => {
        const errs = await formNotifications(page);
        if (errs.length) return { errors: errs, stage: before.active };
        const now = await readStages(page, t);
        return now.activeIndex !== before.activeIndex ? { errors: [] as string[], stage: now.active } : undefined;
      }, t);
      if (!res) throw new D365UiError(`The stage did not move from "${before.active}" within ${t}ms`, 'D365_BPF_TIMEOUT');
      if (res.errors.length) {
        await screenshot(page, ctx, step, 'stage-failed', true);
        throw new D365UiError(`Could not move to the next stage: ${res.errors.join(' | ')}`, 'D365_BPF_BLOCKED', { notifications: res.errors });
      }
      const b = bag(ctx);
      b.stage = res.stage;
      ctx.ledger.set('d365', b);
      await screenshot(page, ctx, step, 'stage');
    },

    'd365.expectStage': async (page, step, ctx) => {
      const want = str(step, ctx, 'stage');
      const t = timeout(step);
      let last = '';
      const ok = await poll(async () => {
        const s = await readStages(page, t);
        last = s.active;
        return normalizeLabel(s.active) === normalizeLabel(want) ? s : undefined;
      }, Math.min(t, 5000));
      if (!ok) throw new D365UiError(`Business process stage is "${last}", expected "${want}"`, 'D365_ASSERT');
      const b = bag(ctx);
      b.stage = ok.active;
      ctx.ledger.set('d365', b);
      await json(ctx, step, 'stage', ok);
    },

    'd365.expectField': async (page, step, ctx) => {
      const { etn, field, io } = await fieldOnForm(page, step, ctx);
      const want = str(step, ctx, 'value', true);
      let last = '';
      const ok = await poll(async () => {
        last = await readField(io);
        return (want === '' ? last === '' : valuesEqual(field, last, want, fmt)) ? true : undefined;
      }, Math.min(timeout(step), 5000));
      const b = bag(ctx);
      b.fields[field.logicalName] = last;
      ctx.ledger.set('d365', b);
      await json(ctx, step, 'field-check', { entity: etn, field: field.label, logicalName: field.logicalName, expected: want, actual: last, passed: !!ok });
      if (!ok) throw new D365UiError(`D365 field "${field.label ?? field.logicalName}" (${field.logicalName}) is "${last}", expected "${want}"`, 'D365_ASSERT');
    },

    'd365.expectSaved': async (page, step, ctx) => {
      const etn = currentEntity(page);
      let why = '';
      const ok = await poll(async () => {
        const errs = await formNotifications(page);
        const status = await saveStatus(page);
        const id = urlParams(page).get('id');
        why = errs.length ? `form notifications: ${errs.join(' | ')}` : !id ? 'the record has no id (never saved)' : status === 'Unsaved' || status === 'Saving...' ? `status is "${status}"` : '';
        return why ? undefined : id!;
      }, Math.min(timeout(step), 5000));
      if (!ok) {
        await screenshot(page, ctx, step, 'not-saved', true);
        throw new D365UiError(`The ${etn} record is not saved: ${why}`, 'D365_ASSERT');
      }
      const b = bag(ctx);
      b.recordId = ok;
      b.records[etn] = ok;
      ctx.ledger.set('d365', b);
      await json(ctx, step, 'saved', { entity: etn, id: ok });
    },

    'd365.expectView': async (page, step, ctx) => {
      const ent = await resolver.resolveEntity(str(step, ctx, 'entity'));
      const want = str(step, ctx, 'value');
      if (!onView(page, ent.logicalName)) await openView(page, ctx, step, ent.logicalName);
      const grid = await readGrid(page, timeout(step));
      const matched = grid.rows.filter((r) => Object.values(r.cells).some((c) => normalizeLabel(c) === normalizeLabel(want)));
      const b = bag(ctx);
      b.view = { entity: ent.logicalName, name: grid.name, rows: grid.rows.length, matched: matched.map((r) => r.id ?? '') };
      ctx.ledger.set('d365', b);
      await json(ctx, step, 'view', { entity: ent.logicalName, view: grid.name, expected: want, rows: grid.rows });
      await screenshot(page, ctx, step, 'view', !matched.length);
      if (!matched.length) {
        const names = grid.rows.slice(0, 10).map((r) => `"${r.cells[ent.primaryNameAttribute] ?? Object.values(r.cells)[0] ?? ''}"`);
        throw new D365UiError(`View "${grid.name}" has no row with "${want}" (${grid.rows.length} rows: ${names.join(', ')})`, 'D365_ASSERT');
      }
    },

    'd365.expectNotification': async (page, step, ctx) => {
      const want = str(step, ctx, 'text');
      let seen: string[] = [];
      const ok = await poll(async () => {
        seen = await formNotifications(page);
        return seen.some((s) => s.toLowerCase().includes(want.toLowerCase())) ? true : undefined;
      }, Math.min(timeout(step), 5000));
      await json(ctx, step, 'notifications', { expected: want, notifications: seen });
      if (!ok) throw new D365UiError(`No form notification contains "${want}" (notifications: ${seen.map((s) => `"${s}"`).join(', ') || 'none'})`, 'D365_ASSERT');
    },

    'd365.verifyDataverse': async (_page, step, ctx) => {
      if (!client) throw new EzTestError('"Verify in Dataverse" needs a DataverseClient (D365 options.client)', 'D365_CONFIG');
      const ent = await resolver.resolveEntity(str(step, ctx, 'entity'));
      const name = str(step, ctx, 'name');
      const exp = step.args?.expect;
      if (!exp || typeof exp !== 'object' || !Object.keys(exp).length) throw new EzTestError('d365.verifyDataverse: no expectations given', 'D365_BAD_STEP');
      const rows = await client.findByName(ent.logicalName, name, { formatted: true, top: 5 });
      if (rows.length !== 1) {
        throw new D365UiError(`Dataverse has ${rows.length} ${ent.logicalName} record(s) named "${name}" (expected exactly one)`, rows.length ? 'D365_AMBIGUOUS' : 'D365_NOT_FOUND');
      }
      const rec = rows[0];
      const checks: Array<{ field: string; column: string; expected: string; actual: unknown; formatted?: unknown; passed: boolean }> = [];
      for (const [key, rawExpected] of Object.entries(exp as Record<string, unknown>)) {
        const expected = ctx.interpolate(String(rawExpected));
        const attr = await resolver.resolveAttribute(ent.logicalName, key);
        const column = webApiColumn(attr);
        if (!(column in rec)) throw new D365UiError(`Dataverse ${ent.logicalName} record has no column "${column}"`, 'D365_UNKNOWN_FIELD');
        const actual = rec[column];
        const formatted = rec[column + FORMATTED_SUFFIX];
        checks.push({ field: key, column, expected, actual, ...(formatted !== undefined ? { formatted } : {}), passed: dataverseEquals(attr.attributeType, actual, formatted, expected, attr.booleanLabels, fmt) });
      }
      const id = String(rec[ent.primaryIdAttribute] ?? '');
      await json(ctx, step, 'dataverse', { entity: ent.logicalName, name, id, checks });
      const b = bag(ctx);
      b.dataverse[ent.logicalName] = { id, ...Object.fromEntries(checks.map((c) => [c.column, c.actual])) };
      ctx.ledger.set('d365', b);
      const bad = checks.filter((c) => !c.passed);
      if (bad.length) {
        throw new D365UiError(
          `Dataverse ${ent.logicalName} "${name}": ${bad.map((c) => `${c.column} is ${JSON.stringify(c.formatted ?? c.actual)}, expected "${c.expected}"`).join('; ')}`,
          'D365_ASSERT',
        );
      }
    },
  };
  return handlers;
}

/** Compare a Web API value (+ formatted annotation) with a user-written expectation. */
export function dataverseEquals(
  attributeType: string,
  actual: unknown,
  formatted: unknown,
  expected: string,
  booleanLabels?: { true: string; false: string },
  fmt: DateFormat = 'M/d/yyyy',
): boolean {
  const e = expected.trim();
  if (actual === null || actual === undefined) return e === '' || /^null$/i.test(e);
  if (String(actual) === e) return true;
  if (typeof formatted === 'string' && normalizeLabel(formatted) === normalizeLabel(e)) return true;
  switch (controlTypeFor(attributeType)) {
    case 'money':
    case 'number': {
      const n = parseNumber(e);
      return n !== undefined && typeof actual === 'number' && n === actual;
    }
    case 'twooptions':
      try {
        return parseTwoOption(e, booleanLabels) === actual;
      } catch {
        return false;
      }
    case 'date': {
      const a = typeof actual === 'string' ? toIsoDate(actual) : undefined;
      return a !== undefined && a === toIsoDate(e, fmt);
    }
    case 'lookup':
      return typeof actual === 'string' && actual.toLowerCase() === e.toLowerCase();
    default:
      return false;
  }
}
