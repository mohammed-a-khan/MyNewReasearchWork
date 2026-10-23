/**
 * Password rotation providers: a role's password derived from a rule instead of
 * being stored. This exists as a MIGRATION AID for shared test accounts whose
 * password rotates on a schedule (for example "prefix + YYYYMM + suffix, rotating
 * on the first Friday of the month"). A rule anyone can read is a weak secret:
 * keep the variable parts (prefix, suffix) in a secret store, and plan to move the
 * accounts to a vault-managed password.
 *
 * Nothing about any particular formula is built in: the `monthly-formula` provider
 * is configured entirely by the user, and other providers can be registered with
 * `registerPasswordRotationProvider`.
 */
import { EzTestError } from '../core/index.js';
import type { PasswordRotationConfig } from '../config/index.js';
import { SecretHandle, type SecretRegistry } from './handle.js';

export interface PasswordRotationProvider {
  readonly type: string;
  /** The password valid at `now`. */
  current(now?: Date): Promise<string>;
  /** A description without any secret part (for reports and the Studio). */
  describe(): string;
}

export interface RotationContext {
  registry: SecretRegistry;
  /** Role name, for messages. */
  role: string;
}

export type PasswordRotationFactory = (config: PasswordRotationConfig, ctx: RotationContext) => PasswordRotationProvider;

const FACTORIES = new Map<string, PasswordRotationFactory>();

/** Add a provider type usable as `passwordRotation: { type: <name>, ... }`. */
export function registerPasswordRotationProvider(type: string, factory: PasswordRotationFactory): void {
  if (!/^[a-z][a-z0-9-]*$/.test(type)) throw new EzTestError(`Invalid password rotation provider type "${type}"`, 'IDENTITY_CONFIG');
  FACTORIES.set(type, factory);
}

export function passwordRotationTypes(): string[] {
  return [...FACTORIES.keys()].sort();
}

export function createPasswordRotationProvider(config: PasswordRotationConfig, ctx: RotationContext): PasswordRotationProvider {
  const f = FACTORIES.get(config.type);
  if (!f) throw new EzTestError(`Role ${ctx.role}: unknown passwordRotation type "${config.type}" (known: ${passwordRotationTypes().join(', ')})`, 'IDENTITY_CONFIG');
  return f(config, ctx);
}

/** A SecretHandle whose value comes from a rotation provider (resolved at use, masked like any secret). */
export function rotationHandle(provider: PasswordRotationProvider, registry: SecretRegistry, role: string): SecretHandle {
  return new SecretHandle(`secret://rotation/${role.replace(/[^A-Za-z0-9_.-]/g, '_')}`, async () => {
    const v = await provider.current();
    registry.masker.add(v);
    return v;
  });
}

// ------------------------------------------------------------------ monthly formula

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Calendar parts of `d` in a time zone (default UTC). */
function partsIn(d: Date, timeZone?: string): { y: number; m: number; day: number } {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), day: Number(p.day) };
}

/** Day of month on which month `m` (1-12) of year `y` rotates. */
export function rotationDay(y: number, m: number, rule: string | number): number {
  if (typeof rule === 'number') return rule;
  const r = rule.trim().toLowerCase();
  if (/^\d+$/.test(r)) return Number(r);
  const mm = /^(first|second|third|fourth|last)[-\s](sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(r);
  if (!mm) throw new EzTestError(`rotatesOn "${rule}" is not understood (use a day number, or e.g. first-friday, last-monday)`, 'IDENTITY_CONFIG');
  const wd = WEEKDAYS.indexOf(mm[2]);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (mm[1] === 'last') {
    for (let d = days; d > 0; d--) if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === wd) return d;
  }
  const nth = ['first', 'second', 'third', 'fourth'].indexOf(mm[1]);
  let seen = -1;
  for (let d = 1; d <= days; d++) {
    if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === wd && ++seen === nth) return d;
  }
  throw new EzTestError(`rotatesOn "${rule}" has no day in ${y}-${m}`, 'IDENTITY_CONFIG');
}

/** The (year, month) whose password is valid at `now`: before this month's rotation day it is still last month's. */
export function rotationPeriod(now: Date, rule: string | number = 1, timeZone?: string): { year: number; month: number } {
  const { y, m, day } = partsIn(now, timeZone);
  if (day >= rotationDay(y, m, rule)) return { year: y, month: m };
  return m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 };
}

/** Format a (year, month) period with tokens YYYY YY MMMM MMM MM M. */
export function formatPeriod(p: { year: number; month: number }, pattern: string): string {
  return pattern.replace(/YYYY|YY|MMMM|MMM|MM|M/g, (t) => {
    switch (t) {
      case 'YYYY': return String(p.year);
      case 'YY': return String(p.year).slice(-2);
      case 'MMMM': return MONTHS[p.month - 1];
      case 'MMM': return MONTHS[p.month - 1].slice(0, 3);
      case 'MM': return String(p.month).padStart(2, '0');
      default: return String(p.month);
    }
  });
}

registerPasswordRotationProvider('monthly-formula', (config, ctx) => {
  const c = config as PasswordRotationConfig & { prefix?: string; suffix?: string; format?: string; rotatesOn?: string | number; timezone?: string };
  const format = typeof c.format === 'string' ? c.format : 'YYYYMM';
  const rule = c.rotatesOn ?? 1;
  rotationDay(2000, 1, rule); // validate early
  const part = (v: unknown, label: string) => (typeof v === 'string' && v !== '' ? ctx.registry.from(v, `${ctx.role}.${label}`) : undefined);
  const prefix = part(c.prefix, 'prefix');
  const suffix = part(c.suffix, 'suffix');
  return {
    type: 'monthly-formula',
    async current(now = new Date()) {
      const period = rotationPeriod(now, rule, c.timezone);
      return `${prefix ? await prefix.resolve() : ''}${formatPeriod(period, format)}${suffix ? await suffix.resolve() : ''}`;
    },
    describe: () => `monthly formula: ${prefix ? 'prefix + ' : ''}${format}${suffix ? ' + suffix' : ''}, rotates on ${String(rule)}${c.timezone ? ` (${c.timezone})` : ''}`,
  };
});
