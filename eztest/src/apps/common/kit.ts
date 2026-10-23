/**
 * Shared building blocks for the packaged-app packs (SAP Fiori, ServiceNow,
 * Workday, Oracle, Power Apps canvas): step arguments, per-pack ledger bags,
 * evidence, polling, label normalisation and value comparison. Each pack keeps
 * its own UI conventions, API client and phrasings; only the plumbing is here.
 */
import type { Page } from '../../browser/index.js';
import { EzTestError, type Journey, type Step } from '../../core/index.js';
import type { SecretInput } from '../../identity/oauth.js';
import { safeName } from '../../runner/evidence.js';
import type { StepContext } from '../../runner/types.js';

export type PackId = 'sap' | 'servicenow' | 'workday' | 'oracle' | 'powerapps';

export const PACK_TITLES: Record<PackId, string> = {
  sap: 'SAP Fiori', servicenow: 'ServiceNow', workday: 'Workday', oracle: 'Oracle', powerapps: 'Power Apps',
};

/** A UI or API failure inside a pack step (code e.g. SN_NOT_FOUND). */
export class AppPackError extends EzTestError {
  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message, code, details);
    this.name = 'AppPackError';
  }
}

export async function reveal(v: SecretInput | undefined): Promise<string | undefined> {
  if (v === undefined) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'function') return v();
  return v.resolve();
}

/** A required string argument of a custom step, interpolated. */
export function argStr(step: Step, ctx: StepContext, key: string, code: string, allowEmpty = false): string {
  const v = step.args?.[key];
  if (typeof v !== 'string') throw new EzTestError(`${step.handler}: missing argument "${key}"`, code);
  const s = ctx.interpolate(v);
  if (!allowEmpty && !s.trim()) throw new EzTestError(`${step.handler}: argument "${key}" is empty`, code);
  return s;
}

export function argOpt(step: Step, ctx: StepContext, key: string): string | undefined {
  const v = step.args?.[key];
  return typeof v === 'string' ? ctx.interpolate(v) : undefined;
}

/** Interpolated `Field = "value"` expectations of a verify step. */
export function argPairs(step: Step, ctx: StepContext, code: string): Record<string, string> {
  const exp = step.args?.expect;
  if (!exp || typeof exp !== 'object' || !Object.keys(exp).length) throw new EzTestError(`${step.handler}: no expectations given`, code);
  return Object.fromEntries(Object.entries(exp as Record<string, unknown>).map(([k, v]) => [k, ctx.interpolate(String(v))]));
}

/** The pack's ledger key (`${servicenow.sysId}` etc.), read-modify-write. */
export function ledgerBag<T extends object>(ctx: StepContext, key: string, defaults: () => T): T {
  const cur = ctx.ledger.get(key) as Partial<T> | undefined;
  return { ...defaults(), ...(cur ?? {}) } as T;
}

export interface PackEvidence {
  screenshot(page: Page, ctx: StepContext, step: Step, what: string, force?: boolean): Promise<void>;
  json(ctx: StepContext, step: Step, what: string, data: unknown): Promise<void>;
}

export function packEvidence(pack: string, screenshots = true): PackEvidence {
  const evPath = (ctx: StepContext, step: Step, ext: string, suffix: string) =>
    `${pack}/${safeName(ctx.journey.id)}/${safeName(step.id)}${suffix ? '-' + safeName(suffix) : ''}-a${ctx.attempt}.${ext}`;
  const meta = (ctx: StepContext, step: Step, description: string) => ({ journeyId: ctx.journey.id, stepId: step.id, description });
  return {
    async screenshot(page, ctx, step, what, force = false) {
      if (!screenshots && !force) return;
      const png = await page.screenshot({ fullPage: true }).catch(() => undefined);
      if (png) await ctx.evidence.store('screenshot', evPath(ctx, step, 'png', what), png, meta(ctx, step, `${pack} ${what}`));
    },
    async json(ctx, step, what, data) {
      await ctx.evidence.store('data', evPath(ctx, step, 'json', what), JSON.stringify(data, null, 2), meta(ctx, step, `${pack} ${what}`));
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NAVIGATION_RACE = /context was destroyed|navigat|Target closed|frame was detached|Cannot find context|Execution context|does not belong to the document|No node with given id|Cannot find object with id/i;

/** Poll `fn` until it returns a value (not undefined), or give up after `timeoutMs`. Probes caught mid-navigation count as "not yet". */
export async function poll<T>(fn: () => Promise<T | undefined>, timeoutMs: number, intervalMs = 100): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v: T | undefined;
    try {
      v = await fn();
    } catch (e) {
      if (!(e instanceof Error && NAVIGATION_RACE.test(e.message))) throw e;
    }
    if (v !== undefined) return v;
    if (Date.now() >= end) return undefined;
    await sleep(intervalMs);
  }
}

/** Lower-case, collapse whitespace, drop a trailing colon/asterisk (labels as users write them). */
export function normalizeLabel(s: string): string {
  return s.replace(/[\u00a0\s]+/g, ' ').replace(/[*:]+\s*$/, '').trim().toLowerCase();
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/** Up to `n` known names closest to `wanted` (for "Did you mean ...?"). */
export function closest(wanted: string, known: string[], n = 3): string[] {
  const w = normalizeLabel(wanted);
  return [...new Set(known)]
    .map((k) => ({ k, d: distance(w, normalizeLabel(k)) - (normalizeLabel(k).includes(w) || w.includes(normalizeLabel(k)) ? 2 : 0) }))
    .filter((x) => x.d <= Math.max(3, Math.floor(w.length / 3)))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map((x) => x.k);
}

export function didYouMean(wanted: string, known: string[]): string {
  const c = closest(wanted, known);
  return c.length ? ` Did you mean ${c.map((x) => `"${x}"`).join(' or ')}?` : '';
}

/** Parse "1,250,000.00", "$1,250,000", "1.250.000,00 €" (when unambiguous) into a number. */
export function parseNumberLoose(s: string): number | undefined {
  let t = s.replace(/[\s\u00a0]/g, '').replace(/[^\d.,+-]/g, '');
  if (!t || !/\d/.test(t)) return undefined;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

const TRUE = new Set(['true', 'yes', 'y', 'on', '1', 'x', 'checked']);
const FALSE = new Set(['false', 'no', 'n', 'off', '0', '', 'unchecked']);

/** Compare what the UI or an API shows with what a journey expects: text (case/space-insensitive), numbers, booleans, ISO dates. */
export function looseEquals(actual: unknown, expected: string): boolean {
  if (actual === null || actual === undefined) return expected.trim() === '';
  const a = String(actual).replace(/[\u00a0\s]+/g, ' ').trim();
  const e = expected.replace(/[\u00a0\s]+/g, ' ').trim();
  if (a.toLowerCase() === e.toLowerCase()) return true;
  if (typeof actual === 'boolean' || TRUE.has(a.toLowerCase()) || FALSE.has(a.toLowerCase())) {
    const ab = TRUE.has(a.toLowerCase()) ? true : FALSE.has(a.toLowerCase()) ? false : undefined;
    const eb = TRUE.has(e.toLowerCase()) ? true : FALSE.has(e.toLowerCase()) ? false : undefined;
    if (ab !== undefined && eb !== undefined) return ab === eb;
  }
  const iso = (x: string) => /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(x)?.slice(1, 4).join('-');
  const ia = iso(a);
  const ie = iso(e);
  if (ia && ie) return ia === ie;
  const sapDate = /^\/Date\((-?\d+)\)\/$/.exec(a);
  if (sapDate && ie) return new Date(Number(sapDate[1])).toISOString().slice(0, 10) === ie;
  if (/\d/.test(a) && /\d/.test(e) && !/[A-Za-z]{2}/.test(a + e)) {
    const na = parseNumberLoose(a);
    const ne = parseNumberLoose(e);
    if (na !== undefined && ne !== undefined) return Math.abs(na - ne) < 1e-9;
  }
  return false;
}

/** Every step of a journey in document order, including nested blocks. */
export function* walkSteps(steps: Step[]): Generator<Step> {
  for (const s of steps) {
    yield s;
    if (s.steps) yield* walkSteps(s.steps);
    if (s.else) yield* walkSteps(s.else);
    if (s.catch) yield* walkSteps(s.catch);
  }
}

export function journeySteps(j: Journey): Step[] {
  return [...walkSteps(j.steps)];
}

export const cssq = (s: string) => s.replace(/(["\\])/g, '\\$1');
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Text of the first match, or '' when there is none (never waits for the element to appear). */
export async function optText(loc: import('../../browser/index.js').Locator): Promise<string> {
  return (await loc.count()) ? (await loc.first().innerText()).trim() : '';
}
/** Input value of the first match, or ''. */
export async function optValue(loc: import('../../browser/index.js').Locator): Promise<string> {
  return (await loc.count()) ? (await loc.first().inputValue()).trim() : '';
}
/** Attribute of the first match, or undefined. */
export async function optAttr(loc: import('../../browser/index.js').Locator, name: string): Promise<string | undefined> {
  return (await loc.count()) ? ((await loc.first().getAttribute(name)) ?? undefined) : undefined;
}
