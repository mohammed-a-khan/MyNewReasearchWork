/**
 * When a target matches several elements (an Edit button in every row), say
 * how to name one: the relative phrasings that would pick each match, worked
 * out from the live page (the row each match sits in, the section heading
 * above it), plus the ordinal form. Read-only; the suggestions are text for
 * the failure message, never applied.
 */
import type { Locator } from '../browser/index.js';
import { quoteText } from '../intent/quotes.js';
import { pageFunction } from '../heal/fingerprint.js';

interface Place {
  row?: string;
  section?: string;
}

/** Where each match sits: its row's first distinctive text and its section heading. Our own page function, run read-only. */
const PLACES = `(els) => els.slice(0, 6).map((el) => {
  const text = (n) => (n && (n.innerText || n.textContent) || '').replace(/\\s+/g, ' ').trim();
  let row = null;
  for (let p = el.parentElement; p && p !== document.body && !row; p = p.parentElement) {
    const tag = p.tagName.toLowerCase(), role = p.getAttribute('role');
    if (tag === 'tr' || tag === 'li' || role === 'row' || role === 'listitem') row = p;
  }
  for (let p = el.parentElement; p && p !== document.body && !row; p = p.parentElement) {
    if (/^(td|th|p|span)$/i.test(p.tagName)) continue;
    const sibs = p.parentElement ? Array.from(p.parentElement.children).filter((c) => c.tagName === p.tagName && c.className === p.className).length : 0;
    if (sibs >= 2 && p.children.length > 1) row = p;
  }
  let rowText;
  if (row) {
    const cells = Array.from(row.children).filter((c) => !c.contains(el));
    rowText = cells.map(text).find((t) => t && t.length <= 40) || undefined;
  }
  let section;
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const label = p.getAttribute('aria-label');
    if (label && /^(section|form|fieldset|dialog|nav|aside|table)$/i.test(p.tagName)) { section = label; break; }
    const h = p.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > legend, :scope > * > h2, :scope > * > h3');
    if (h && !h.contains(el)) { section = text(h); break; }
  }
  return { row: rowText, section: section && section.length <= 40 ? section : undefined };
})`;

/** Up to three phrasings that name one of the matches of an ambiguous target. */
export async function scopeHints(loc: Locator, description: string, count: number): Promise<string[]> {
  let places: Place[];
  try {
    places = (await loc.evaluateAll(pageFunction<unknown, Place[]>(PLACES) as never)) as Place[];
  } catch {
    return [];
  }
  const out: string[] = [];
  const rows = places.map((p) => p.row).filter((r): r is string => !!r);
  if (rows.length === places.length && new Set(rows).size === rows.length) {
    out.push(`${description} in the row containing ${quoteText(rows[0])}`);
  }
  const secs = places.map((p) => p.section).filter((s): s is string => !!s);
  if (secs.length === places.length && new Set(secs).size === secs.length) {
    out.push(`${description} inside the ${quoteText(secs[0])} section`);
  }
  const base = description.replace(/^the\s+/i, '');
  if (count > 1) out.push(`the 2nd ${base}`);
  return out.slice(0, 3);
}
