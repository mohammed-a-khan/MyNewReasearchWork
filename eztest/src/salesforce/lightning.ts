/**
 * Lightning Experience page helpers: strict locating (through open shadow
 * roots), the record edit modal and its controls (input, combobox incl.
 * dependent picklists, lookup type-ahead, textarea, checkbox, date,
 * currency), field-level and page-level errors, toasts, the path component,
 * list views, related lists and navigation. Every wait is bounded and every
 * failure says what was seen.
 */
import type { Locator, Page } from '../browser/index.js';
import { EzTestError, NotSupportedError, sleep, type LocatorCandidate } from '../core/index.js';
import { describeCandidate } from '../runner/locate.js';
import { assertDrivable, controlSelector, normalizeLabel, type ResolvedSfField } from './resolver.js';

export class SalesforceUiError extends EzTestError {
  constructor(message: string, code = 'SF_UI', details?: Record<string, unknown>) {
    super(message, code, details);
    this.name = 'SalesforceUiError';
  }
}

export type SfDateFormat = 'M/d/yyyy' | 'd/M/yyyy' | 'yyyy-MM-dd';
export type Root = Page | Locator;

const POLL = 100;

/** Poll `fn` until it returns a value (not undefined) or the deadline passes. */
const NAVIGATION_RACE = /JavaScript context went away|frame was removed from the page|Execution context was destroyed|Cannot find context with specified id|frame (?:was|got) detached/i;

export async function poll<T>(fn: () => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v: T | undefined;
    try {
      v = await fn();
    } catch (e) {
      // Lightning re-renders and navigates after saves; a probe caught mid-navigation is "not yet", not a failure.
      if (!(e instanceof Error && NAVIGATION_RACE.test(e.message))) throw e;
    }
    if (v !== undefined) return v;
    if (Date.now() >= end) return undefined;
    await sleep(POLL);
  }
}

/** A driver locator for a candidate, relative to a page or a scoping locator. */
export function locatorFor(root: Root, c: LocatorCandidate): Locator {
  const exact = c.exact ?? true;
  switch (c.strategy) {
    case 'css': return root.locator(c.value);
    case 'label': return root.getByLabel(c.value, { exact });
    case 'text': return root.getByText(c.value, { exact });
    case 'role': return root.getByRole(c.value as Parameters<Page['getByRole']>[0], c.name !== undefined ? { name: c.name, exact } : {});
    case 'placeholder': return root.getByPlaceholder(c.value, { exact });
    case 'testId': return root.getByTestId(c.value);
    case 'title': return root.getByTitle(c.value, { exact });
    default: throw new NotSupportedError(`Salesforce locator strategy "${c.strategy}"`);
  }
}

/**
 * Resolve the first candidate that matches exactly one element. A candidate
 * matching several elements is an error (strict), not a reason to pick one.
 */
export async function locateUnique(root: Root, candidates: LocatorCandidate[], description: string, timeoutMs: number): Promise<{ locator: Locator; candidate: LocatorCandidate }> {
  if (!candidates.length) throw new SalesforceUiError(`No locator candidates for ${description}`, 'SF_NOT_FOUND');
  const found = await poll(async () => {
    for (const c of candidates) {
      const loc = locatorFor(root, c);
      const n = await loc.count();
      if (n === 1) return { locator: loc, candidate: c };
      if (n > 1) throw new SalesforceUiError(`${description}: ${describeCandidate(c)} matches ${n} elements (strict mode needs exactly one)`, 'SF_AMBIGUOUS');
    }
    return undefined;
  }, timeoutMs);
  if (!found) throw new SalesforceUiError(`${description} not found on the page (tried ${candidates.map(describeCandidate).join(', ')})`, 'SF_NOT_FOUND');
  return found;
}

// ------------------------------------------------------------------ location

/** sObject of the current Lightning page (/lightning/o/{Obj}/... or /lightning/r/{Obj}/{id}/...). */
export function currentObject(page: Page): string {
  const m = /^\/lightning\/[or]\/([A-Za-z][A-Za-z0-9_]*)\//.exec(new URL(page.url()).pathname);
  if (!m) throw new SalesforceUiError(`Not on a Lightning object page (${new URL(page.url()).pathname})`, 'SF_NO_OBJECT_PAGE');
  return m[1];
}

/** Record id of the current record page, if any. */
export function currentRecordId(page: Page): string | undefined {
  return /^\/lightning\/r\/[A-Za-z][A-Za-z0-9_]*\/([A-Za-z0-9]{15,18})\/(?:view|edit)$/.exec(new URL(page.url()).pathname)?.[1];
}

export function onListView(page: Page, object: string): boolean {
  return new RegExp(`^/lightning/o/${object}/(?:list|home)$`).test(new URL(page.url()).pathname);
}

/**
 * Wait until the list view header has rendered (its title is visible): Lightning builds it after
 * the URL already says "list view", and the New button appears with it. Reading the buttons
 * before that reads an empty header. False when it did not render within `timeoutMs`.
 */
export async function waitForListViewHeader(page: Page, timeoutMs: number): Promise<boolean> {
  return page
    .locator('lst-list-view-manager-header .slds-page-header__title, lst-list-view-manager-header h1')
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .then(() => true, () => false);
}

export function onRecordView(page: Page): boolean {
  return /\/lightning\/r\/[^/]+\/[^/]+\/view$/.test(new URL(page.url()).pathname);
}

// ------------------------------------------------------------------ modal

export const MODAL_SELECTOR = 'section.slds-modal[role="dialog"][aria-modal="true"]';

/** The open record edit/create modal, or undefined. */
export async function openModal(page: Page): Promise<Locator | undefined> {
  const m = page.locator(MODAL_SELECTOR);
  const n = await m.count();
  if (n > 1) throw new SalesforceUiError(`${n} record modals are open; cannot pick one strictly`, 'SF_AMBIGUOUS');
  if (n === 1 && (await m.isVisible())) return m;
  return undefined;
}

export async function waitForModal(page: Page, timeoutMs: number, what = 'The record edit modal'): Promise<Locator> {
  const m = await poll(() => openModal(page), timeoutMs);
  if (!m) throw new SalesforceUiError(`${what} did not open within ${timeoutMs}ms (at ${new URL(page.url()).pathname})`, 'SF_NO_MODAL');
  // Components render on connect; wait for at least one layout item.
  await m.locator('records-record-layout-item').first().waitFor({ state: 'attached', timeout: timeoutMs });
  return m;
}

export interface ModalErrors {
  page: string[];
  fields: Array<{ label: string; message: string }>;
}

/** Field-level help errors and page-level ("We hit a snag.") errors in the modal. */
export async function modalErrors(modal: Locator): Promise<ModalErrors> {
  const out: ModalErrors = { page: [], fields: [] };
  const items = modal.locator('records-record-layout-item');
  const n = await items.count();
  for (let i = 0; i < n; i++) {
    const item = items.nth(i);
    const help = item.locator('.slds-form-element__help');
    const k = await help.count();
    for (let j = 0; j < k; j++) {
      const h = help.nth(j);
      if (!(await h.isVisible())) continue;
      const msg = (await h.innerText()).replace(/\s+/g, ' ').trim();
      if (msg) out.fields.push({ label: (await item.getAttribute('field-label')) ?? `field ${i + 1}`, message: msg });
    }
  }
  const snag = modal.locator('.pageLevelErrors');
  if ((await snag.count()) === 1 && (await snag.isVisible())) {
    const pe = (await snag.locator('.pageError').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
    out.page.push(...pe);
    if (!pe.length && !out.fields.length) out.page.push((await snag.innerText()).replace(/\s+/g, ' ').trim());
  }
  return out;
}

export function formatModalErrors(e: ModalErrors): string {
  return [...e.fields.map((f) => `${f.label}: ${f.message}`), ...e.page].join(' | ');
}

// ------------------------------------------------------------------ toasts

export interface Toast {
  type: string;
  message: string;
}

export async function readToasts(page: Page): Promise<Toast[]> {
  return page.locator('.forceToastMessage').evaluateAll((els) =>
    els.map((e) => ({
      type: e.getAttribute('data-key') ?? (/(success|error|warning|info)/.exec(e.className)?.[1] ?? ''),
      message: (e.querySelector('.toastMessage')?.textContent ?? e.textContent ?? '').replace(/\s+/g, ' ').trim(),
    })),
  );
}

// ------------------------------------------------------------------ values

/** Parse a user-written number / currency / percent ("$1,250,000.00", "15%"). */
export function parseNumber(s: string): number | undefined {
  const t = s.replace(/[\s,$€£¥%\u00a0]/g, '');
  if (!t || !/^-?\d+(?:\.\d+)?$/.test(t)) return undefined;
  return Number(t);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Normalise a date to YYYY-MM-DD (ISO, the configured short format, or "Oct 22, 2026"). */
export function toIsoDate(s: string, fmt: SfDateFormat = 'M/d/yyyy'): string | undefined {
  const t = s.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(t);
  if (m) {
    const [mo, d] = fmt === 'd/M/yyyy' ? [m[2], m[1]] : [m[1], m[2]];
    return `${m[3]}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})$/.exec(t);
  if (m) {
    const i = MONTHS.indexOf(m[1].toLowerCase());
    if (i >= 0) return `${m[3]}-${String(i + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return undefined;
}

export function formatUiDate(iso: string, fmt: SfDateFormat): string {
  const [y, mo, d] = iso.split('-');
  if (fmt === 'yyyy-MM-dd') return iso;
  if (fmt === 'd/M/yyyy') return `${Number(d)}/${Number(mo)}/${y}`;
  return `${Number(mo)}/${Number(d)}/${y}`;
}

/** Parse a checkbox value (true/false, yes/no, checked/unchecked, on/off, 1/0). */
export function parseBool(value: string): boolean {
  const v = normalizeLabel(value);
  if (['true', 'yes', 'checked', 'on', '1'].includes(v)) return true;
  if (['false', 'no', 'unchecked', 'off', '0', ''].includes(v)) return false;
  throw new SalesforceUiError(`"${value}" is not a checkbox value (use true/false, yes/no or checked/unchecked)`, 'SF_BAD_VALUE');
}

/** Picklist label for an API value or label written by the user (undefined if neither). */
export function picklistLabel(f: ResolvedSfField, v: string): string | undefined {
  const n = normalizeLabel(v);
  const hit = (f.field.picklistValues ?? []).find((p) => normalizeLabel(p.label) === n) ?? (f.field.picklistValues ?? []).find((p) => normalizeLabel(p.value) === n);
  return hit?.label;
}

/** Do a displayed value and an expected value agree for this field type? */
export function valuesEqual(f: ResolvedSfField, actual: string, expected: string, fmt: SfDateFormat = 'M/d/yyyy'): boolean {
  if (expected.trim() === '') return actual.trim() === '';
  switch (f.control) {
    case 'currency':
    case 'number': {
      const a = parseNumber(actual);
      const e = parseNumber(expected);
      return a === undefined || e === undefined ? actual.trim() === expected.trim() : a === e;
    }
    case 'date': {
      const a = toIsoDate(actual, fmt);
      return a !== undefined && a === toIsoDate(expected, fmt);
    }
    case 'checkbox':
      try {
        return parseBool(actual) === parseBool(expected);
      } catch {
        return false;
      }
    case 'picklist': {
      const a = normalizeLabel(actual);
      return a === normalizeLabel(expected) || a === normalizeLabel(picklistLabel(f, expected) ?? '\u0000');
    }
    case 'lookup':
      return normalizeLabel(actual) === normalizeLabel(expected);
    default:
      return actual.replace(/\s+/g, ' ').trim() === expected.replace(/\s+/g, ' ').trim();
  }
}

// ------------------------------------------------------------------ controls

export interface FieldIo {
  /** Scope: the open modal (edit) or the page (record view). */
  root: Root;
  page: Page;
  field: ResolvedSfField;
  timeoutMs: number;
  dateFormat: SfDateFormat;
}

/** The field's layout item inside `root` (strict). */
export async function layoutItem(io: FieldIo): Promise<Locator> {
  return (await locateUnique(io.root, io.field.containers, `Salesforce field "${io.field.label}" (${io.field.name})`, io.timeoutMs)).locator;
}

/** Is the field rendered read-only in the modal (no editable control)? */
export async function isReadOnlyInModal(item: Locator, f: ResolvedSfField): Promise<boolean> {
  if ((await item.getAttribute('data-readonly')) !== null) return true;
  const inner = controlSelector(f.control);
  if (!inner) return true;
  const c = item.locator(inner);
  if ((await c.count()) !== 1) return true;
  if (f.control === 'picklist') return false; // disabled dependent picklists are editable once the controller is set
  return !(await c.isEditable());
}

/** Read the value shown by the field's editable control in the modal. */
export async function readControl(io: FieldIo): Promise<string> {
  const { field } = io;
  assertDrivable(field);
  const item = await layoutItem(io);
  if ((await item.getAttribute('data-readonly')) !== null) {
    return (await item.locator('.slds-form-element__static').innerText()).trim();
  }
  const c = item.locator(controlSelector(field.control)!);
  if ((await c.count()) !== 1) throw new SalesforceUiError(`Salesforce field "${field.label}" has no ${field.control} control`, 'SF_NOT_FOUND');
  switch (field.control) {
    case 'checkbox': return (await c.isChecked()) ? 'true' : 'false';
    case 'picklist': {
      const t = (await c.innerText()).trim();
      return t === '--None--' ? '' : t;
    }
    case 'lookup': return (await c.getAttribute('data-value')) ? (await c.inputValue()).trim() : '';
    default: return c.inputValue();
  }
}

/** Read the field's displayed value on the record page (details panel). */
export async function readOutput(io: FieldIo): Promise<string> {
  const { field } = io;
  const { locator } = await locateUnique(io.root, io.field.outputs, `Salesforce field "${field.label}" (${field.name}) on the record page`, io.timeoutMs);
  if (field.control === 'checkbox') {
    const cb = locator.locator('input[type="checkbox"]');
    if ((await cb.count()) === 1) return (await cb.isChecked()) ? 'true' : 'false';
  }
  return (await locator.innerText()).replace(/\s+/g, ' ').trim();
}

export interface SetResult {
  readBack: string;
  candidate?: LocatorCandidate;
  lookupId?: string;
}

/** Set a field through its Lightning control in the open modal and verify the read-back. */
export async function setControl(io: FieldIo, value: string): Promise<SetResult> {
  const { field } = io;
  assertDrivable(field);
  const desc = `Salesforce field "${field.label}" (${field.name})`;
  const item = await layoutItem(io);
  if (await isReadOnlyInModal(item, field)) {
    throw new SalesforceUiError(`${desc} is read-only for this user (no editable control on the layout)`, 'SF_READ_ONLY');
  }
  const { locator, candidate } = await locateUnique(io.root, field.candidates, desc, io.timeoutMs);
  let lookupId: string | undefined;
  switch (field.control) {
    case 'picklist': await setPicklist(io, item, locator, value); break;
    case 'lookup': lookupId = await setLookup(io, item, locator, value); break;
    case 'checkbox': await locator.setChecked(parseBool(value), { timeout: io.timeoutMs }); break;
    case 'date': {
      let text = '';
      if (value.trim() !== '') {
        const iso = toIsoDate(value, io.dateFormat);
        if (!iso) throw new SalesforceUiError(`${desc}: "${value}" is not a date (use YYYY-MM-DD or ${io.dateFormat})`, 'SF_BAD_VALUE');
        text = formatUiDate(iso, io.dateFormat);
      }
      await locator.fill(text, { timeout: io.timeoutMs });
      await locator.press('Tab');
      break;
    }
    case 'currency':
    case 'number':
      if (value.trim() !== '' && parseNumber(value) === undefined) throw new SalesforceUiError(`${desc}: "${value}" is not a number`, 'SF_BAD_VALUE');
      await locator.fill(value.trim() === '' ? '' : String(parseNumber(value)), { timeout: io.timeoutMs });
      await locator.press('Tab');
      break;
    case 'text':
    case 'textarea':
      await locator.fill(value, { timeout: io.timeoutMs });
      await locator.press('Tab');
      break;
    default:
      throw new NotSupportedError(`Salesforce control ${field.control}`);
  }
  const readBack = await readControl(io);
  if (!valuesEqual(field, readBack, value, io.dateFormat)) throw new SalesforceUiError(`${desc} shows "${readBack}" after setting "${value}"`, 'SF_SET_FAILED');
  return { readBack, candidate, ...(lookupId ? { lookupId } : {}) };
}

async function setPicklist(io: FieldIo, item: Locator, button: Locator, value: string): Promise<void> {
  const { field } = io;
  const desc = `Salesforce picklist "${field.label}"`;
  if (await button.isDisabled()) {
    const dep = field.controllerLabel ? ` (it depends on "${field.controllerLabel}"; set that first)` : '';
    throw new SalesforceUiError(`${desc} is disabled${dep}`, 'SF_DISABLED');
  }
  await button.click({ timeout: io.timeoutMs });
  const list = item.locator('[role="listbox"]');
  await list.waitFor({ state: 'visible', timeout: io.timeoutMs });
  const options = list.locator('lightning-base-combobox-item[role="option"]');
  const items = await options.evaluateAll((els) =>
    els.map((e) => ({ value: e.getAttribute('data-value') ?? '', label: (e.querySelector('[title]')?.getAttribute('title') ?? e.textContent ?? '').trim() })),
  );
  const want = normalizeLabel(value);
  let hits = items.map((x, i) => ({ ...x, i })).filter((x) => (value.trim() === '' ? x.value === '' : normalizeLabel(x.label) === want));
  if (!hits.length && value.trim() !== '') hits = items.map((x, i) => ({ ...x, i })).filter((x) => x.value !== '' && normalizeLabel(x.value) === want);
  if (hits.length !== 1) {
    await button.click({ timeout: io.timeoutMs }).catch(() => undefined);
    const shown = items.filter((x) => x.value !== '').map((x) => x.label);
    const dep = field.controllerLabel && !shown.length ? ` for the current "${field.controllerLabel}"` : '';
    throw new SalesforceUiError(
      hits.length ? `${desc} has ${hits.length} options named "${value}"` : `${desc} has no option "${value}"${dep} (options: ${shown.join(', ') || 'none'})`,
      'SF_BAD_VALUE',
      { options: shown },
    );
  }
  await options.nth(hits[0].i).click({ timeout: io.timeoutMs });
}

async function setLookup(io: FieldIo, item: Locator, input: Locator, value: string): Promise<string | undefined> {
  const { field } = io;
  const desc = `Salesforce lookup "${field.label}"`;
  if (await input.getAttribute('data-value')) {
    const clear = item.locator('button[title="Clear Selection"]');
    if ((await clear.count()) !== 1) throw new SalesforceUiError(`${desc} has a selection but no "Clear Selection" button`, 'SF_UI');
    await clear.click({ timeout: io.timeoutMs });
    await poll(async () => ((await input.getAttribute('data-value')) ? undefined : true), io.timeoutMs);
  }
  if (value.trim() === '') return undefined;
  await input.fill(value, { timeout: io.timeoutMs });
  const list = item.locator('[role="listbox"]');
  const ready = await poll(async () => ((await list.isVisible()) && (await list.getAttribute('aria-busy')) === 'false' ? true : undefined), io.timeoutMs);
  if (!ready) throw new SalesforceUiError(`${desc}: the search results did not open for "${value}"`, 'SF_LOOKUP_NO_RESULTS');
  const options = list.locator('lightning-base-combobox-item[role="option"]');
  const items = await options.evaluateAll((els) =>
    els.map((e) => ({ id: e.getAttribute('data-value') ?? '', name: (e.querySelector('[title]')?.getAttribute('title') ?? e.getAttribute('aria-label') ?? '').trim() })),
  );
  const exact = items.map((x, i) => ({ ...x, i })).filter((x) => normalizeLabel(x.name) === normalizeLabel(value));
  if (!exact.length) {
    throw new SalesforceUiError(`${desc}: no record named exactly "${value}" (results: ${items.map((x) => `"${x.name}"`).join(', ') || 'none'})`, 'SF_LOOKUP_NO_MATCH');
  }
  if (exact.length > 1) throw new SalesforceUiError(`${desc}: ${exact.length} records are named "${value}"; cannot choose strictly`, 'SF_LOOKUP_AMBIGUOUS');
  await options.nth(exact[0].i).click({ timeout: io.timeoutMs });
  await poll(async () => ((await input.getAttribute('data-value')) ? true : undefined), io.timeoutMs);
  return (await input.getAttribute('data-value')) ?? exact[0].id;
}

// ------------------------------------------------------------------ path

export interface PathState {
  stages: string[];
  current: string;
  currentIndex: number;
  selected: string;
}

export async function readPath(page: Page, timeoutMs: number): Promise<PathState> {
  const opts = page.locator('lightning-path .slds-path__nav a[role="option"]');
  const ok = await poll(async () => ((await opts.count()) > 0 ? true : undefined), timeoutMs);
  if (!ok) throw new SalesforceUiError('This record page shows no path component', 'SF_NO_PATH');
  const items = await opts.evaluateAll((els) =>
    els.map((a) => ({
      title: (a.getAttribute('title') ?? a.querySelector('.slds-path__title')?.textContent ?? '').trim(),
      current: (a.parentElement?.className ?? '').split(/\s+/).includes('slds-is-current'),
      selected: a.getAttribute('aria-selected') === 'true',
    })),
  );
  const cur = items.filter((i) => i.current);
  if (cur.length !== 1) throw new SalesforceUiError(`Expected one current path stage, found ${cur.length}`, 'SF_PATH_STATE');
  return { stages: items.map((i) => i.title), current: cur[0].title, currentIndex: items.findIndex((i) => i.current), selected: items.find((i) => i.selected)?.title ?? cur[0].title };
}

// ------------------------------------------------------------------ tables

export interface TableRow {
  id?: string;
  cells: Record<string, string>;
}

async function readRows(table: Locator): Promise<TableRow[]> {
  return table.locator('tbody tr').evaluateAll((rows) =>
    rows.map((r) => {
      const cells: Record<string, string> = {};
      for (const c of Array.from(r.children)) {
        const label = c.getAttribute('data-label');
        if (!label || label === 'Actions') continue;
        cells[label] = (c.textContent ?? '').replace(/\s+/g, ' ').trim();
      }
      return { id: r.getAttribute('data-row-key-value') ?? undefined, cells };
    }),
  );
}

/** Wait for the list view datatable to finish loading and read it. */
export async function readListView(page: Page, timeoutMs: number): Promise<{ name: string; rows: TableRow[] }> {
  const tables = page.locator('lightning-datatable table[role="grid"]');
  const ready = await poll(async () => {
    const n = await tables.count();
    if (n > 1) throw new SalesforceUiError(`${n} list view tables on the page; cannot pick one strictly`, 'SF_AMBIGUOUS');
    if (n === 0) return undefined;
    return (await tables.getAttribute('aria-busy')) === 'true' ? undefined : true;
  }, timeoutMs);
  if (!ready) throw new SalesforceUiError(`The list view did not finish loading within ${timeoutMs}ms`, 'SF_LIST_NOT_READY');
  return { name: (await tables.getAttribute('aria-label')) ?? '', rows: await readRows(tables) };
}

/** Read a related list on the record page by its label (e.g. "Contacts"). */
export async function readRelatedList(page: Page, label: string, timeoutMs: number): Promise<{ rows: TableRow[] }> {
  const all = page.locator('force-related-list-single-container');
  const found = await poll(async () => {
    const names = (await all.evaluateAll((els) => els.map((e) => e.getAttribute('data-related-list') ?? ''))).filter(Boolean);
    const hits = names.filter((n) => normalizeLabel(n) === normalizeLabel(label));
    if (hits.length > 1) throw new SalesforceUiError(`${hits.length} related lists are labelled "${label}"`, 'SF_AMBIGUOUS');
    return hits.length === 1 ? { name: hits[0], names } : names.length ? { name: '', names } : undefined;
  }, timeoutMs);
  if (!found?.name) {
    throw new SalesforceUiError(`No related list "${label}" on this record page (related lists: ${found?.names.map((n) => `"${n}"`).join(', ') || 'none'})`, 'SF_NO_RELATED_LIST');
  }
  const table = page.locator(`force-related-list-single-container[data-related-list="${found.name.replace(/(["\\])/g, '\\$1')}"] table`);
  return { rows: (await table.count()) ? await readRows(table) : [] };
}

// ------------------------------------------------------------------ navigation

/** Labels of the tabs in the app's navigation bar. */
export async function navTabs(page: Page): Promise<string[]> {
  return page.locator('one-app-nav-bar li.slds-context-bar__item a[title]').evaluateAll((els) => els.map((a) => a.getAttribute('title') ?? ''));
}

/** Search the App Launcher; returns the matching item labels (and leaves the launcher open). */
export async function searchAppLauncher(page: Page, text: string, timeoutMs: number): Promise<{ labels: string[]; items: Locator }> {
  const btn = page.getByRole('button', { name: 'App Launcher', exact: true });
  if ((await btn.count()) !== 1) throw new SalesforceUiError('No App Launcher button on this page', 'SF_NO_LAUNCHER');
  const search = page.getByPlaceholder('Search apps and items...', { exact: true });
  if (!(await search.isVisible())) await btn.click({ timeout: timeoutMs });
  await search.waitFor({ state: 'visible', timeout: timeoutMs });
  await search.fill(text);
  const items = page.locator('[role="dialog"][aria-label="App Launcher"] a[data-label]');
  // Results refresh asynchronously after typing; wait until they reflect the query.
  const labels = await poll(async () => {
    const ls = await items.evaluateAll((els) => els.map((a) => a.getAttribute('data-label') ?? ''));
    return ls.every((l) => l.toLowerCase().includes(text.toLowerCase())) ? ls : undefined;
  }, Math.min(timeoutMs, 3000));
  return { labels: labels ?? [], items };
}

export async function closeAppLauncher(page: Page): Promise<void> {
  const search = page.getByPlaceholder('Search apps and items...', { exact: true });
  if ((await search.count()) === 1 && (await search.isVisible())) await page.getByRole('button', { name: 'App Launcher', exact: true }).click();
}

// ------------------------------------------------------------------ login

/**
 * Username/password login on the Salesforce login page. Cookies are cleared
 * first so a different user can sign in. The password is only typed into the
 * password field; it never appears in errors.
 */
export async function loginWithPassword(page: Page, loginUrl: string, username: string, password: string, timeoutMs: number): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  await page.context().clearCookies();
  await page.goto(`${loginUrl.replace(/\/+$/, '')}/`, { timeout: timeoutMs });
  const user = await locateUnique(page, [{ strategy: 'css', value: 'input#username' }, { strategy: 'label', value: 'Username', exact: true }], 'Salesforce login username field', timeoutMs);
  const pass = await locateUnique(page, [{ strategy: 'css', value: 'input#password' }, { strategy: 'label', value: 'Password', exact: true }], 'Salesforce login password field', timeoutMs);
  await user.locator.fill(username);
  await pass.locator.fill(password);
  const submit = await locateUnique(page, [{ strategy: 'css', value: 'input#Login' }, { strategy: 'role', value: 'button', name: 'Log In' }], 'Salesforce "Log In" button', timeoutMs);
  await submit.locator.click({ timeout: timeoutMs });
  const outcome = await poll(async () => {
    if (/^https?:/.test(page.url()) && new URL(page.url()).pathname.startsWith('/lightning/')) return { ok: true as const, url: page.url() };
    const e = page.locator('#error');
    if ((await e.count()) === 1 && (await e.isVisible())) return { ok: false as const, error: (await e.innerText()).replace(/\s+/g, ' ').trim() };
    return undefined;
  }, timeoutMs);
  if (!outcome) throw new SalesforceUiError(`Salesforce login as ${username} did not complete within ${timeoutMs}ms`, 'SF_LOGIN_TIMEOUT');
  if (outcome.ok) await page.locator('one-app-nav-bar nav').waitFor({ state: 'visible', timeout: timeoutMs });
  return outcome;
}
