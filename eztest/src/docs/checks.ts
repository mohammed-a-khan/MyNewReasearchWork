/**
 * Document checks: page count, required metadata, required clauses,
 * forbidden text (placeholders), PII detection in the text layer (SSN, card
 * numbers with Luhn, IBAN with mod-97, e-mail) and masking verification.
 * Evidence never contains the unmasked sensitive value.
 */
import { EzTestError } from '../core/index.js';
import type { CanonicalDocument, DocMetadata } from './model.js';
import { escapeRe, foldText } from './normalize.js';

export type PiiType = 'ssn' | 'card' | 'iban' | 'email';
export const PII_TYPES: PiiType[] = ['ssn', 'card', 'iban', 'email'];

export interface TextRule {
  /** Plain text (case/whitespace-insensitive) or a regex (when `regex` is true). */
  text: string;
  regex?: boolean;
  name?: string;
}

export interface MaskingRule {
  name: string;
  /** Which PII must not appear unmasked. */
  type: PiiType;
  /** Optional regex that a correctly masked value must match somewhere in the text, e.g. "\\*{4} \\*{4} \\*{4} \\d{4}". */
  expectMasked?: string;
}

export interface DocumentChecks {
  pages?: { min?: number; max?: number };
  requiredMetadata?: Array<keyof DocMetadata>;
  requiredText?: Array<string | TextRule>;
  forbiddenText?: Array<string | TextRule>;
  /** Shortcut: forbid common placeholders ({{, }}, TODO, TBD, lorem ipsum, XXX, [insert). */
  forbidPlaceholders?: boolean;
  /** Report PII of these types as failures. */
  pii?: { detect: PiiType[]; allow?: string[] };
  masking?: MaskingRule[];
}

export interface CheckFinding {
  check: string;
  passed: boolean;
  severity: 'error' | 'warning' | 'info';
  message: string;
  page?: number;
  /** Masked evidence, safe to store. */
  evidence?: string;
}

export interface DocumentCheckReport {
  kind: 'document-check';
  source: string;
  status: 'PASS' | 'FAIL';
  findings: CheckFinding[];
}

export const PLACEHOLDER_RULES: TextRule[] = [
  { name: 'placeholder {{', text: '\\{\\{|\\}\\}', regex: true },
  { name: 'TODO', text: '\\bTODO\\b', regex: true },
  { name: 'TBD', text: '\\bTBD\\b', regex: true },
  { name: 'lorem ipsum', text: '\\blorem\\b', regex: true },
  { name: 'XXX', text: '\\bXXX\\b', regex: true },
  { name: '[insert', text: '\\[\\s*insert\\b', regex: true },
];

// ----------------------------------------------------------------- validators

/** Luhn checksum for payment card numbers. */
export function luhnValid(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FR: 27,
  GB: 22, GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18,
  NO: 15, PL: 28, PT: 25, RO: 24, SA: 24, SE: 24, SI: 19, SK: 24, SM: 27, TR: 26,
};

/** IBAN validation: country length (when known) and ISO 7064 mod-97 == 1. */
export function ibanValid(input: string): boolean {
  const s = input.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const len = IBAN_LENGTHS[s.slice(0, 2)];
  if (len !== undefined && s.length !== len) return false;
  const re = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of re) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

// ----------------------------------------------------------------- masking

/** Mask a sensitive value for evidence: keep only what is needed to recognise it. */
export function maskPii(type: PiiType, value: string): string {
  switch (type) {
    case 'card': {
      const d = value.replace(/\D/g, '');
      return `**** **** **** ${d.slice(-4)}`;
    }
    case 'ssn':
      return `***-**-${value.replace(/\D/g, '').slice(-4)}`;
    case 'iban': {
      const s = value.replace(/\s+/g, '').toUpperCase();
      return `${s.slice(0, 2)}${'*'.repeat(Math.max(0, s.length - 6))}${s.slice(-4)}`;
    }
    case 'email': {
      const [u, d] = value.split('@');
      return `${u.slice(0, 1)}***@${d ?? ''}`;
    }
  }
}

export interface PiiHit {
  type: PiiType;
  page: number;
  /** Masked representation only. */
  masked: string;
}

/** Find PII in the text layer. Card numbers must pass Luhn, IBANs mod-97. */
export function detectPii(doc: CanonicalDocument, types: PiiType[] = PII_TYPES): PiiHit[] {
  const hits: PiiHit[] = [];
  const want = new Set(types);
  for (const page of doc.pages) {
    const text = page.lines.map((l) => l.text).join('\n');
    if (want.has('ssn')) {
      for (const m of text.matchAll(/\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g)) {
        hits.push({ type: 'ssn', page: page.number, masked: maskPii('ssn', m[0]) });
      }
    }
    if (want.has('card')) {
      for (const m of text.matchAll(/(?<![\d*])(?:\d[ -]?){12,18}\d(?!\d)/g)) {
        const digits = m[0].replace(/\D/g, '');
        if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
          hits.push({ type: 'card', page: page.number, masked: maskPii('card', digits) });
        }
      }
    }
    if (want.has('iban')) {
      for (const m of text.matchAll(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g)) {
        if (ibanValid(m[0])) hits.push({ type: 'iban', page: page.number, masked: maskPii('iban', m[0]) });
      }
    }
    if (want.has('email')) {
      for (const m of text.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)) {
        hits.push({ type: 'email', page: page.number, masked: maskPii('email', m[0]) });
      }
    }
  }
  return hits;
}

// ----------------------------------------------------------------- checks

function ruleRegex(r: string | TextRule): { re: RegExp; name: string } {
  const rule: TextRule = typeof r === 'string' ? { text: r } : r;
  try {
    const re = rule.regex
      ? new RegExp(rule.text, 'i')
      : new RegExp(escapeRe(foldText(rule.text)).replace(/ /g, '\\s+'), 'i');
    return { re, name: rule.name ?? rule.text };
  } catch (e) {
    throw new EzTestError(`Invalid text rule ${JSON.stringify(rule.text)}: ${(e as Error).message}`, 'CHECK_INVALID');
  }
}

/** Run document checks. An empty check list, or an empty document, fails. */
export function checkDocument(doc: CanonicalDocument, checks: DocumentChecks): DocumentCheckReport {
  const f: CheckFinding[] = [];
  const ok = (check: string, message: string, page?: number) => f.push({ check, passed: true, severity: 'info', message, ...(page ? { page } : {}) });
  const bad = (check: string, message: string, extra: Partial<CheckFinding> = {}) =>
    f.push({ check, passed: false, severity: 'error', message, ...extra });

  const configured =
    checks.pages !== undefined ||
    (checks.requiredMetadata?.length ?? 0) > 0 ||
    (checks.requiredText?.length ?? 0) > 0 ||
    (checks.forbiddenText?.length ?? 0) > 0 ||
    checks.forbidPlaceholders === true ||
    (checks.pii?.detect.length ?? 0) > 0 ||
    (checks.masking?.length ?? 0) > 0;
  if (!configured) bad('config', 'no checks configured');

  const textChecks =
    (checks.requiredText?.length ?? 0) > 0 ||
    (checks.forbiddenText?.length ?? 0) > 0 ||
    checks.forbidPlaceholders ||
    (checks.pii?.detect.length ?? 0) > 0 ||
    (checks.masking?.length ?? 0) > 0;
  const lineCount = doc.pages.reduce((n, p) => n + p.lines.length, 0);
  if (textChecks && lineCount === 0) bad('text-layer', 'document has no text layer; text, PII and masking checks cannot pass');

  if (checks.pages) {
    const n = doc.metadata.pageCount;
    const { min, max } = checks.pages;
    if ((min !== undefined && n < min) || (max !== undefined && n > max)) bad('pages', `page count ${n} outside [${min ?? '-'}, ${max ?? '-'}]`);
    else ok('pages', `page count ${n} within [${min ?? '-'}, ${max ?? '-'}]`);
  }
  for (const k of checks.requiredMetadata ?? []) {
    const v = doc.metadata[k];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) bad(`metadata:${String(k)}`, `required metadata "${String(k)}" is missing`);
    else ok(`metadata:${String(k)}`, `metadata "${String(k)}" present`);
  }

  const pageTexts = doc.pages.map((p) => ({ page: p.number, text: foldText(p.lines.map((l) => l.text).join(' '), { caseFold: false }) }));
  const fullText = pageTexts.map((p) => p.text).join(' ');
  if (lineCount > 0) {
    for (const r of checks.requiredText ?? []) {
      const { re, name } = ruleRegex(r);
      const hit = pageTexts.find((p) => re.test(p.text)) ?? (re.test(fullText) ? { page: undefined } : undefined);
      if (hit) ok(`required:${name}`, `required text found`, hit.page);
      else bad(`required:${name}`, `required text "${name}" not found`);
    }
    const forbidden = [...(checks.forbiddenText ?? []), ...(checks.forbidPlaceholders ? PLACEHOLDER_RULES : [])];
    for (const r of forbidden) {
      const { re, name } = ruleRegex(r);
      const pages = pageTexts.filter((p) => re.test(p.text)).map((p) => p.page);
      if (pages.length) bad(`forbidden:${name}`, `forbidden text "${name}" present`, { page: pages[0], evidence: `pages ${pages.join(', ')}` });
      else ok(`forbidden:${name}`, `forbidden text absent`);
    }
    if (checks.pii && checks.pii.detect.length) {
      const allow = new Set(checks.pii.allow ?? []);
      const hits = detectPii(doc, checks.pii.detect).filter((h) => !allow.has(h.masked));
      for (const h of hits) bad(`pii:${h.type}`, `unmasked ${h.type} found in text layer`, { page: h.page, evidence: h.masked });
      for (const t of checks.pii.detect) if (!hits.some((h) => h.type === t)) ok(`pii:${t}`, `no ${t} found`);
    }
    for (const m of checks.masking ?? []) {
      const leaks = detectPii(doc, [m.type]);
      for (const h of leaks) bad(`masking:${m.name}`, `${m.type} is not masked`, { page: h.page, evidence: h.masked });
      let expectedOk = true;
      if (m.expectMasked) {
        let re: RegExp;
        try {
          re = new RegExp(m.expectMasked);
        } catch (e) {
          throw new EzTestError(`Invalid expectMasked regex for ${m.name}: ${(e as Error).message}`, 'CHECK_INVALID');
        }
        const page = pageTexts.find((p) => re.test(p.text));
        if (!page) {
          expectedOk = false;
          bad(`masking:${m.name}`, `no correctly masked ${m.type} found (expected /${m.expectMasked}/)`);
        }
      }
      if (leaks.length === 0 && expectedOk) ok(`masking:${m.name}`, `${m.type} masked correctly`);
    }
  }
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  const findings = f.sort(
    (a, b) => Number(a.passed) - Number(b.passed) || cmp(a.check, b.check) || (a.page ?? 0) - (b.page ?? 0) || cmp(a.message, b.message),
  );
  return { kind: 'document-check', source: doc.source, status: findings.some((x) => !x.passed && x.severity === 'error') ? 'FAIL' : 'PASS', findings };
}
