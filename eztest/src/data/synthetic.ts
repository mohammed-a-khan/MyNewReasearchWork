/**
 * Deterministic synthetic data. Every value comes from a seeded PRNG, so the
 * same seed always yields the same data. Contact data uses reserved/fictional
 * ranges (example.com domains, 555-01xx numbers); card numbers and IBANs are
 * checksum-valid test values, not real accounts.
 */
import { randomUUID } from 'node:crypto';
import { EzTestError } from '../core/index.js';
import { Prng } from './prng.js';

const FIRST = ['Alice', 'Bob', 'Carol', 'David', 'Eve', 'Farah', 'Gustav', 'Hiro', 'Ines', 'Jamal', 'Kofi', 'Lena', 'Mateo', 'Nora', 'Oskar', 'Priya', 'Quentin', 'Rosa', 'Sven', 'Tariq', 'Uma', 'Viktor', 'Wen', 'Ximena', 'Yusuf', 'Zoe'];
const LAST = ['Anders', 'Becker', 'Costa', 'Dubois', 'Eriksen', 'Fischer', 'Garcia', 'Hansen', 'Ito', 'Jansen', 'Kowalski', 'Larsen', 'Moreau', 'Nakamura', 'Okafor', 'Petrov', 'Quinn', 'Rossi', 'Schmidt', 'Tanaka', 'Usman', 'Vargas', 'Weber', 'Xu', 'Yilmaz', 'Zimmermann'];
const COMPANY_A = ['Blue', 'North', 'Bright', 'Silver', 'Green', 'Rapid', 'Summit', 'Harbor', 'Atlas', 'Cedar', 'Orbit', 'Prairie'];
const COMPANY_B = ['Widgets', 'Logistics', 'Analytics', 'Foods', 'Systems', 'Textiles', 'Energy', 'Labs', 'Traders', 'Works', 'Partners', 'Robotics'];
const COMPANY_SUFFIX = ['Ltd', 'Inc', 'GmbH', 'BV', 'LLC', 'SA', 'AB', 'Co'];
const STREETS = ['Main', 'Oak', 'Maple', 'Station', 'Church', 'Mill', 'Park', 'High', 'Bridge', 'Lake', 'River', 'Hill'];
const STREET_TYPES = ['Street', 'Road', 'Avenue', 'Lane', 'Way', 'Square'];
const CITIES = [
  { city: 'Springfield', country: 'US', region: 'US' },
  { city: 'Rivertown', country: 'US', region: 'US' },
  { city: 'Lakeside', country: 'GB', region: 'EU' },
  { city: 'Neustadt', country: 'DE', region: 'EU' },
  { city: 'Villeneuve', country: 'FR', region: 'EU' },
  { city: 'Nieuwdorp', country: 'NL', region: 'EU' },
  { city: 'Harbourview', country: 'AU', region: 'APAC' },
];
const DOMAINS = ['example.com', 'example.org', 'example.net'];

export type EdgeCaseKind = 'unicode' | 'emoji' | 'rtl' | 'sql' | 'html' | 'whitespace' | 'long' | 'empty';

export const EDGE_CASES: Record<EdgeCaseKind, readonly string[]> = {
  unicode: ['Zoë Ångström', 'Łukasz Żółć', 'Ŝtrâñgé Çhàrś', '测试用户', 'テストユーザー', 'Ünïcödé Ⅻ ß ﬁ', 'é (combining accent)'],
  emoji: ['😀', '👩🏽‍💻 dev', '🇩🇪🇺🇸', 'family 👨‍👩‍👧‍👦', '❤️‍🔥', 'skin 👍🏿'],
  rtl: ['مرحبا بالعالم', 'שלום עולם', 'mixed English עברית 123', '‮reversed‬'],
  sql: ["O'Brien", "'; DROP TABLE customers; --", '" OR "1"="1', '100% _wild_', 'back\\slash', "Robert'); --"],
  html: ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '&amp; &lt;b&gt;', '"double" \'single\'', '</textarea><b>bold</b>'],
  whitespace: [' leading', 'trailing ', '  both  ', 'tab\tinside', 'line\nbreak', ' nbsp', 'zero​width'],
  long: [],
  empty: [''],
};

export interface DateRange {
  from?: string | Date;
  to?: string | Date;
}

function toDate(v: string | Date | undefined, fallback: string): Date {
  const d = v === undefined ? new Date(fallback) : v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new EzTestError(`Invalid date "${String(v)}"`, 'DATA_SYNTHETIC');
  return d;
}

export function luhnCheckDigit(partial: string): number {
  let sum = 0;
  for (let i = 0; i < partial.length; i++) {
    let d = Number(partial[partial.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

export function luhnValid(num: string): boolean {
  const s = num.replace(/[\s-]/g, '');
  if (!/^\d{12,19}$/.test(s)) return false;
  return luhnCheckDigit(s.slice(0, -1)) === Number(s[s.length - 1]);
}

function mod97(numeric: string): number {
  let r = 0;
  for (const ch of numeric) r = (r * 10 + Number(ch)) % 97;
  return r;
}
function ibanNumeric(s: string): string {
  return s.toUpperCase().replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
}
export function ibanValid(iban: string): boolean {
  const s = iban.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  return mod97(ibanNumeric(s.slice(4) + s.slice(0, 4))) === 1;
}

const IBAN_FORMATS: Record<string, Array<'n' | 'a'>> = {
  DE: Array(18).fill('n'),
  NL: [...Array(4).fill('a'), ...Array(10).fill('n')],
  GB: [...Array(4).fill('a'), ...Array(14).fill('n')],
};

export class Synthetic {
  readonly prng: Prng;
  constructor(readonly seed: string | number = 42) {
    this.prng = new Prng(seed);
  }

  int(min = 0, max = 1000): number {
    return this.prng.int(min, max);
  }
  float(min = 0, max = 1, decimals = 2): number {
    const f = 10 ** decimals;
    return Math.round((min + this.prng.float() * (max - min)) * f) / f;
  }
  pick<T>(items: readonly T[]): T {
    return this.prng.pick(items);
  }
  bool(p = 0.5): boolean {
    return this.prng.bool(p);
  }
  digits(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String(this.prng.int(0, 9));
    return s;
  }
  letters(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(65 + this.prng.int(0, 25));
    return s;
  }

  firstName(): string {
    return this.pick(FIRST);
  }
  lastName(): string {
    return this.pick(LAST);
  }
  fullName(): string {
    return `${this.firstName()} ${this.lastName()}`;
  }
  email(name?: string): string {
    const base = (name ?? this.fullName()).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
    return `${base}.${this.digits(3)}@${this.pick(DOMAINS)}`;
  }
  /** Fictional North American number in the reserved 555-0100..0199 range. */
  phone(): string {
    return `+1-${this.pick(['202', '312', '415', '617', '206'])}-555-01${this.digits(2)}`;
  }
  company(): string {
    return `${this.pick(COMPANY_A)} ${this.pick(COMPANY_B)} ${this.pick(COMPANY_SUFFIX)}`;
  }
  address(): { street: string; city: string; postcode: string; country: string; region: string } {
    const c = this.pick(CITIES);
    return { street: `${this.int(1, 299)} ${this.pick(STREETS)} ${this.pick(STREET_TYPES)}`, city: c.city, postcode: this.digits(5), country: c.country, region: c.region };
  }

  /** Date in [from, to] (defaults 2020-01-01..2030-12-31; never "now", to stay deterministic). */
  date(r: DateRange = {}): Date {
    const from = toDate(r.from, '2020-01-01T00:00:00Z').getTime();
    const to = toDate(r.to, '2030-12-31T00:00:00Z').getTime();
    if (to < from) throw new EzTestError('date(): "to" is before "from"', 'DATA_SYNTHETIC');
    const days = Math.floor((to - from) / 86_400_000);
    return new Date(from + this.int(0, days) * 86_400_000);
  }
  /** ISO date (YYYY-MM-DD) on a Monday..Friday within the range. */
  businessDay(r: DateRange = {}): string {
    const d = this.date(r);
    const to = toDate(r.to, '2030-12-31T00:00:00Z').getTime();
    for (let i = 0; i < 7; i++) {
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) return d.toISOString().slice(0, 10);
      const step = d.getTime() + 86_400_000 <= to ? 86_400_000 : -86_400_000;
      d.setTime(d.getTime() + step);
    }
    throw new EzTestError('No business day in the requested range', 'DATA_SYNTHETIC');
  }

  /** Luhn-valid test card number. */
  cardNumber(brand: 'visa' | 'mastercard' | 'amex' = 'visa'): string {
    const prefix = brand === 'visa' ? '4' : brand === 'mastercard' ? String(this.int(51, 55)) : this.pick(['34', '37']);
    const len = brand === 'amex' ? 15 : 16;
    const body = prefix + this.digits(len - prefix.length - 1);
    return body + String(luhnCheckDigit(body));
  }

  /** IBAN-shaped value with valid mod-97 check digits (synthetic, not a real account). */
  iban(country: 'DE' | 'NL' | 'GB' = 'DE'): string {
    const fmt = IBAN_FORMATS[country];
    if (!fmt) throw new EzTestError(`iban(): country ${country} not supported`, 'DATA_SYNTHETIC');
    const bban = fmt.map((t) => (t === 'n' ? String(this.int(0, 9)) : String.fromCharCode(65 + this.int(0, 25)))).join('');
    const check = 98 - mod97(ibanNumeric(bban + country + '00'));
    return `${country}${String(check).padStart(2, '0')}${bban}`;
  }

  /** RFC 4122 v4-shaped UUID from the seeded stream. */
  uuid(): string {
    const b = this.prng.bytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Buffer.from(b).toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  /** Unique-per-run suffix that is NOT deterministic, for values that must not collide across runs. */
  static runUnique(): string {
    return randomUUID().slice(0, 8);
  }

  // ----------------------------------------------------------- edge cases

  /** Values around the boundaries: min-1, min, min+1, max-1, max, max+1 (and 0 when inside). */
  boundaryNumbers(min: number, max: number, step = 1): number[] {
    if (max < min) throw new EzTestError('boundaryNumbers(): max < min', 'DATA_SYNTHETIC');
    const vals = [min - step, min, min + step, max - step, max, max + step];
    if (min < 0 && max > 0) vals.push(0);
    return [...new Set(vals.map((v) => Math.round(v * 1e9) / 1e9))].sort((a, b) => a - b);
  }

  /** Extreme numeric values for overflow/precision checks. */
  extremeNumbers(): number[] {
    return [0, -0, 1, -1, 2 ** 31 - 1, -(2 ** 31), 2 ** 53 - 1, Number.MAX_SAFE_INTEGER + 2, 0.1 + 0.2, 1e-7, Number.MAX_VALUE, Number.MIN_VALUE];
  }

  longString(length = 256, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'): string {
    if (length < 0) throw new EzTestError('longString(): negative length', 'DATA_SYNTHETIC');
    let s = '';
    for (let i = 0; i < length; i++) s += alphabet[this.prng.int(0, alphabet.length - 1)];
    return s;
  }

  edgeCases(kind: EdgeCaseKind): string[] {
    if (kind === 'long') return [this.longString(255), this.longString(256), this.longString(4000)];
    const list = EDGE_CASES[kind];
    if (!list) throw new EzTestError(`Unknown edge case kind "${kind}"`, 'DATA_SYNTHETIC');
    return [...list];
  }

  edgeCase(kind: EdgeCaseKind): string {
    return this.pick(this.edgeCases(kind));
  }

  /** Every string edge case, labelled, for data-driven negative tests. */
  allEdgeCases(): Array<{ kind: EdgeCaseKind; value: string }> {
    return (Object.keys(EDGE_CASES) as EdgeCaseKind[]).flatMap((kind) => this.edgeCases(kind).map((value) => ({ kind, value })));
  }

  /** Generate by name: "company", "email", "int:1:100", "date:2024-01-01:2024-12-31", "edge:sql", ... */
  byName(spec: string): unknown {
    const [name, a, b] = spec.split(':');
    switch (name) {
      case 'firstName': return this.firstName();
      case 'lastName': return this.lastName();
      case 'name':
      case 'fullName': return this.fullName();
      case 'email': return this.email();
      case 'phone': return this.phone();
      case 'company': return this.company();
      case 'street': return this.address().street;
      case 'city': return this.address().city;
      case 'postcode': return this.address().postcode;
      case 'country': return this.address().country;
      case 'region': return this.address().region;
      case 'int': return this.int(a !== undefined ? Number(a) : 0, b !== undefined ? Number(b) : 1000);
      case 'float': return this.float(a !== undefined ? Number(a) : 0, b !== undefined ? Number(b) : 1);
      case 'date': return this.date({ from: a, to: b }).toISOString().slice(0, 10);
      case 'businessDay': return this.businessDay({ from: a, to: b });
      case 'card': return this.cardNumber((a as 'visa' | 'mastercard' | 'amex') ?? 'visa');
      case 'iban': return this.iban((a as 'DE' | 'NL' | 'GB') ?? 'DE');
      case 'uuid': return this.uuid();
      case 'bool': return this.bool();
      case 'edge': return this.edgeCase(a as EdgeCaseKind);
      default:
        throw new EzTestError(`Unknown synthetic generator "${spec}"`, 'DATA_SYNTHETIC');
    }
  }
}
