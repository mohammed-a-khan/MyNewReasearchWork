/**
 * Unified Interface page helpers: strict locating, reading and writing form
 * controls by type, form notifications, save status, business process flow
 * and grid views. Every wait is bounded and every failure says what was seen.
 */
import type { Locator, Page } from '../browser/index.js';
import { EzTestError, NotSupportedError, sleep, type LocatorCandidate } from '../core/index.js';
import { describeCandidate, toLocator } from '../runner/locate.js';
import { assertDrivable, lookupSelectors, normalizeLabel, type ResolvedField } from './resolver.js';

export class D365UiError extends EzTestError {
  constructor(message: string, code = 'D365_UI', details?: Record<string, unknown>) {
    super(message, code, details);
    this.name = 'D365UiError';
  }
}

export type DateFormat = 'M/d/yyyy' | 'd/M/yyyy' | 'yyyy-MM-dd';

const POLL = 100;

/** Poll `fn` until it returns a value (not undefined) or the deadline passes. */
const NAVIGATION_RACE = /JavaScript context went away|frame was removed from the page|Execution context was destroyed|Cannot find context with specified id|frame (?:was|got) detached/i;

export function isNavigationRace(e: unknown): boolean {
  return e instanceof Error && NAVIGATION_RACE.test(e.message);
}

export async function poll<T>(fn: () => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v: T | undefined;
    try {
      v = await fn();
    } catch (e) {
      // UCI navigates during saves, closes and stage moves; a probe that lands mid-navigation is "not yet", not a failure.
      if (!isNavigationRace(e)) throw e;
    }
    if (v !== undefined) return v;
    if (Date.now() >= end) return undefined;
    await sleep(POLL);
  }
}

/**
 * Resolve the first candidate that matches exactly one element. A candidate
 * matching several elements is an error (strict), not a reason to pick one.
 */
export async function locateUnique(
  page: Page,
  candidates: LocatorCandidate[],
  description: string,
  timeoutMs: number,
): Promise<{ locator: Locator; candidate: LocatorCandidate }> {
  if (!candidates.length) throw new D365UiError(`No locator candidates for ${description}`, 'D365_NOT_FOUND');
  const found = await poll(async () => {
    for (const c of candidates) {
      const loc = toLocator(page, c);
      const n = await loc.count();
      if (n === 1) return { locator: loc, candidate: c };
      if (n > 1) {
        throw new D365UiError(`${description}: ${describeCandidate(c)} matches ${n} elements (strict mode needs exactly one)`, 'D365_AMBIGUOUS');
      }
    }
    return undefined;
  }, timeoutMs);
  if (!found) {
    throw new D365UiError(`${description} not found on the page (tried ${candidates.map(describeCandidate).join(', ')})`, 'D365_NOT_FOUND');
  }
  return found;
}

/** Query parameters of the current UCI URL. */
export function urlParams(page: Page): URLSearchParams {
  return new URL(page.url()).searchParams;
}

/** Entity logical name of the open form / view (from `etn=` in the URL). */
export function currentEntity(page: Page): string {
  const etn = urlParams(page).get('etn');
  if (!etn) throw new D365UiError(`Not on a model-driven page (no etn= in ${new URL(page.url()).pathname})`, 'D365_NO_FORM');
  return etn.toLowerCase();
}

export function saveButtonSelector(etn: string, close = false): string {
  return `button[data-id="${etn}|NoRelationship|Form|Mscrm.${close ? 'SaveAndClosePrimary' : 'SavePrimary'}"]`;
}

export async function waitForForm(page: Page, etn: string, timeoutMs: number): Promise<void> {
  try {
    await page.locator(saveButtonSelector(etn)).waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    throw new D365UiError(`The ${etn} form did not load within ${timeoutMs}ms (no Save command at ${page.url()})`, 'D365_FORM_NOT_READY');
  }
}

/** Error/warning texts in the form notification bar. */
export async function formNotifications(page: Page): Promise<string[]> {
  const items = page.locator('[data-id="notificationWrapper"] [data-level="ERROR"], [data-id="notificationWrapper"] [role="alert"]');
  const texts = (await items.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return [...new Set(texts)];
}

export async function saveStatus(page: Page): Promise<string> {
  const s = page.locator('[data-id="header_saveStatus"]');
  return (await s.count()) ? (await s.innerText()).trim() : '';
}

// ------------------------------------------------------------------ values

/** Parse a user-written number / money value ("$1,250,000.00", "1250000"). */
export function parseNumber(s: string): number | undefined {
  const t = s.replace(/[\s,$€£¥ ]/g, '');
  if (!t || !/^-?\d+(?:\.\d+)?$/.test(t)) return undefined;
  return Number(t);
}

/** Normalise a date string to YYYY-MM-DD (accepts ISO and the configured UI format). */
export function toIsoDate(s: string, fmt: DateFormat = 'M/d/yyyy'): string | undefined {
  const t = s.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(t);
  if (m) {
    const [mo, d] = fmt === 'd/M/yyyy' ? [m[2], m[1]] : [m[1], m[2]];
    return `${m[3]}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return undefined;
}

export function formatUiDate(iso: string, fmt: DateFormat): string {
  const [y, mo, d] = iso.split('-');
  if (fmt === 'yyyy-MM-dd') return iso;
  if (fmt === 'd/M/yyyy') return `${Number(d)}/${Number(mo)}/${y}`;
  return `${Number(mo)}/${Number(d)}/${y}`;
}

/** Parse a two-option value against the field's labels (Yes/No, true/false, on/off, 1/0). */
export function parseTwoOption(value: string, labels?: { true: string; false: string }): boolean {
  const v = normalizeLabel(value);
  if (labels && v === normalizeLabel(labels.true)) return true;
  if (labels && v === normalizeLabel(labels.false)) return false;
  if (['yes', 'true', 'on', '1', 'checked'].includes(v)) return true;
  if (['no', 'false', 'off', '0', 'unchecked'].includes(v)) return false;
  throw new D365UiError(`"${value}" is not a two-option value${labels ? ` (expected "${labels.true}" or "${labels.false}")` : ''}`, 'D365_BAD_VALUE');
}

/** Do a displayed value and an expected value agree for this field type? */
export function valuesEqual(f: ResolvedField, actual: string, expected: string, fmt: DateFormat = 'M/d/yyyy'): boolean {
  switch (f.control) {
    case 'money':
    case 'number': {
      const a = parseNumber(actual);
      const e = parseNumber(expected);
      return a === undefined || e === undefined ? actual.trim() === expected.trim() : a === e;
    }
    case 'date': {
      const a = toIsoDate(actual, fmt);
      const e = toIsoDate(expected, fmt);
      return a !== undefined && a === e;
    }
    case 'twooptions':
      try {
        return parseTwoOption(actual, f.attribute.booleanLabels) === parseTwoOption(expected, f.attribute.booleanLabels);
      } catch {
        return false;
      }
    case 'optionset':
      return normalizeLabel(actual) === normalizeLabel(expected);
    default:
      return actual.replace(/\s+/g, ' ').trim() === expected.replace(/\s+/g, ' ').trim();
  }
}

// ------------------------------------------------------------------ controls

export interface FieldIo {
  page: Page;
  field: ResolvedField;
  timeoutMs: number;
  dateFormat: DateFormat;
}

/** Read the displayed value of a field (option label, Yes/No label, lookup name...). */
export async function readField(io: FieldIo): Promise<string> {
  const { page, field } = io;
  assertDrivable(field);
  const desc = `D365 field "${field.label ?? field.logicalName}"`;
  if (field.control === 'lookup') {
    const sel = lookupSelectors(field.logicalName);
    await locateUnique(page, [field.container], `${desc} container`, io.timeoutMs);
    const tags = page.locator(sel.selectedTag);
    const n = await tags.count();
    if (n === 0) return '';
    return (await tags.allInnerTexts()).map((t) => t.trim()).join('; ');
  }
  const { locator } = await locateUnique(page, field.candidates, desc, io.timeoutMs);
  const tag = await locator.evaluate((el) => el.tagName.toLowerCase());
  if (field.control === 'optionset' || tag === 'select') {
    const text = await locator.evaluate((el) => {
      const s = el as HTMLSelectElement;
      const o = s.selectedIndex >= 0 ? s.options[s.selectedIndex] : undefined;
      return o && o.value !== '' ? (o.textContent ?? '').trim() : '';
    });
    return text;
  }
  if (field.control === 'twooptions') {
    const checked = await locator.isChecked();
    const l = field.attribute.booleanLabels ?? { true: 'Yes', false: 'No' };
    return checked ? l.true : l.false;
  }
  return locator.inputValue();
}

/** Set a field through its UCI control and verify the control now shows the value. */
export async function setField(io: FieldIo, value: string): Promise<{ readBack: string; candidate?: LocatorCandidate; lookupId?: string }> {
  const { page, field } = io;
  assertDrivable(field);
  const desc = `D365 field "${field.label ?? field.logicalName}"`;
  if (field.control === 'lookup') return setLookup(io, value);
  const { locator, candidate } = await locateUnique(page, field.candidates, desc, io.timeoutMs);
  if (!(await locator.isEditable({ timeout: io.timeoutMs }).catch(() => false))) {
    throw new D365UiError(`${desc} is read-only or disabled`, 'D365_READ_ONLY');
  }
  switch (field.control) {
    case 'optionset': {
      const labels = await locator.evaluate((el) => Array.from((el as HTMLSelectElement).options).map((o) => (o.textContent ?? '').trim()));
      const hit = labels.filter((l) => normalizeLabel(l) === normalizeLabel(value));
      if (value === '') {
        await locator.selectOption({ index: 0 });
        break;
      }
      if (hit.length !== 1) {
        throw new D365UiError(`${desc} has no option "${value}" (options: ${labels.filter((l) => l !== '---').join(', ')})`, 'D365_BAD_VALUE');
      }
      await locator.selectOption({ label: hit[0] });
      break;
    }
    case 'twooptions': {
      const want = parseTwoOption(value, field.attribute.booleanLabels);
      const tag = await locator.evaluate((el) => el.tagName.toLowerCase());
      if (tag === 'select') {
        const l = field.attribute.booleanLabels ?? { true: 'Yes', false: 'No' };
        await locator.selectOption({ label: want ? l.true : l.false });
      } else await locator.setChecked(want);
      break;
    }
    case 'date': {
      let text = '';
      if (value !== '') {
        const iso = toIsoDate(value, io.dateFormat);
        if (!iso) throw new D365UiError(`${desc}: "${value}" is not a date (use YYYY-MM-DD or ${io.dateFormat})`, 'D365_BAD_VALUE');
        text = formatUiDate(iso, io.dateFormat);
      }
      await locator.fill(text);
      await locator.press('Tab');
      break;
    }
    case 'money':
    case 'number': {
      if (value !== '' && parseNumber(value) === undefined) throw new D365UiError(`${desc}: "${value}" is not a number`, 'D365_BAD_VALUE');
      await locator.fill(value);
      await locator.press('Tab');
      break;
    }
    case 'text':
      await locator.fill(value);
      await locator.press('Tab');
      break;
    default:
      throw new NotSupportedError(`D365 control ${field.control}`);
  }
  const readBack = await readField(io);
  const ok = value === '' ? readBack === '' : valuesEqual(field, readBack, value, io.dateFormat);
  if (!ok) throw new D365UiError(`${desc} shows "${readBack}" after setting "${value}"`, 'D365_SET_FAILED');
  return { readBack, candidate };
}

async function setLookup(io: FieldIo, value: string): Promise<{ readBack: string; lookupId?: string }> {
  const { page, field } = io;
  const desc = `D365 lookup "${field.label ?? field.logicalName}"`;
  const sel = lookupSelectors(field.logicalName);
  await locateUnique(page, [field.container], `${desc} container`, io.timeoutMs);
  // Clear a current selection first.
  const del = page.locator(sel.deleteTag);
  const existing = await del.count();
  if (existing > 1) throw new NotSupportedError(`${desc}: multi-select lookups (partylist)`);
  if (existing === 1) {
    await del.click({ timeout: io.timeoutMs });
    await page.locator(sel.selectedTag).waitFor({ state: 'detached', timeout: io.timeoutMs });
  }
  if (value === '') return { readBack: await readField(io) };
  const input = page.locator(sel.input);
  await input.waitFor({ state: 'visible', timeout: io.timeoutMs });
  await input.fill(value);
  const results = page.locator(sel.results);
  // Wait for the flyout to show results for this search.
  const opts = await poll(async () => {
    if (!(await results.isVisible())) return undefined;
    if ((await results.getAttribute('aria-busy')) === 'true') return undefined;
    return page.locator(sel.option);
  }, io.timeoutMs);
  if (!opts) throw new D365UiError(`${desc}: the results flyout did not open for "${value}"`, 'D365_LOOKUP_NO_FLYOUT');
  const items = await opts.evaluateAll((els) =>
    els.map((e) => ({ id: e.getAttribute('data-id') ?? '', name: (e.getAttribute('aria-label') ?? e.querySelector('[data-id$="_primaryField"]')?.textContent ?? e.textContent ?? '').trim() })),
  );
  const exact = items.map((x, i) => ({ ...x, i })).filter((x) => normalizeLabel(x.name) === normalizeLabel(value));
  if (exact.length === 0) {
    throw new D365UiError(`${desc}: no record named exactly "${value}" (results: ${items.map((x) => `"${x.name}"`).join(', ') || 'none'})`, 'D365_LOOKUP_NO_MATCH');
  }
  if (exact.length > 1) {
    throw new D365UiError(`${desc}: ${exact.length} records are named "${value}"; cannot choose strictly`, 'D365_LOOKUP_AMBIGUOUS');
  }
  await opts.nth(exact[0].i).click({ timeout: io.timeoutMs });
  const tag = page.locator(sel.selectedTag);
  await tag.waitFor({ state: 'visible', timeout: io.timeoutMs });
  const readBack = await readField(io);
  if (normalizeLabel(readBack) !== normalizeLabel(value)) throw new D365UiError(`${desc} shows "${readBack}" after choosing "${value}"`, 'D365_SET_FAILED');
  return { readBack, lookupId: exact[0].id || undefined };
}

// ------------------------------------------------------------------ business process flow

export interface StageState {
  stages: string[];
  active: string;
  activeIndex: number;
}

export async function readStages(page: Page, timeoutMs: number): Promise<StageState> {
  const area = page.locator('[data-id="processStageArea"]');
  try {
    await area.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    throw new D365UiError('This form shows no business process flow (no processStageArea)', 'D365_NO_BPF');
  }
  const stages = await area.locator('[role="button"]').evaluateAll((els) =>
    els.map((e) => ({
      name: (e.querySelector('[data-id="processStageName"]')?.textContent ?? e.getAttribute('aria-label')?.split(',')[0] ?? '').trim(),
      active: e.getAttribute('aria-current') === 'step' || /,\s*Active$/i.test(e.getAttribute('aria-label') ?? ''),
    })),
  );
  const act = stages.filter((s) => s.active);
  if (act.length !== 1) throw new D365UiError(`Expected one active business process stage, found ${act.length}`, 'D365_BPF_STATE');
  return { stages: stages.map((s) => s.name), active: act[0].name, activeIndex: stages.findIndex((s) => s.active) };
}

// ------------------------------------------------------------------ grids

export interface GridRow {
  id?: string;
  cells: Record<string, string>;
}

/** Wait for the main view grid to finish loading and read its rows. */
export async function readGrid(page: Page, timeoutMs: number): Promise<{ name: string; rows: GridRow[] }> {
  const grids = page.locator('[data-id="data-set-body-container"] [role="grid"]');
  const ready = await poll(async () => {
    const n = await grids.count();
    if (n > 1) throw new D365UiError(`${n} grids on the page; cannot pick the view strictly`, 'D365_AMBIGUOUS');
    if (n === 0) return undefined;
    return (await grids.getAttribute('aria-busy')) === 'true' ? undefined : true;
  }, timeoutMs);
  if (!ready) throw new D365UiError(`The view grid did not finish loading within ${timeoutMs}ms`, 'D365_GRID_NOT_READY');
  const name = (await grids.getAttribute('aria-label')) ?? '';
  const rows = await grids.locator('[role="row"]').evaluateAll((els) =>
    els
      .filter((r) => r.querySelector('[role="gridcell"]'))
      .map((r) => {
        const cells: Record<string, string> = {};
        for (const c of Array.from(r.querySelectorAll('[role="gridcell"]'))) cells[c.getAttribute('col-id') ?? ''] = (c.textContent ?? '').trim();
        const id = r.getAttribute('data-id')?.replace(/^row-/, '') ?? undefined;
        return { id, cells };
      }),
  );
  return { name, rows };
}
