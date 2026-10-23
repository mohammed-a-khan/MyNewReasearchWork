/** Tiny DOM helpers for the emulated widget fixtures. */

type Attrs = Record<string, string | number | boolean | null | undefined | ((e: Event) => void)>;
type Child = Node | string | null | undefined | false | Child[];

export function h(tag: string, attrs: Attrs = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, '').toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

let seq = 0;
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** Place a body-level popup under its anchor (like the libraries' overlay services). */
export function placeUnder(popup: HTMLElement, anchor: Element): void {
  const r = anchor.getBoundingClientRect();
  popup.style.position = 'absolute';
  popup.style.left = `${r.left + window.scrollX}px`;
  popup.style.top = `${r.bottom + window.scrollY + 2}px`;
  popup.style.minWidth = `${Math.max(180, r.width)}px`;
  popup.style.zIndex = '1000';
}

/** Close a popup when the user clicks elsewhere. */
export function onOutsideClick(els: () => Array<Element | null>, close: () => void): () => void {
  const f = (e: MouseEvent) => {
    if (els().some((x) => x && x.contains(e.target as Node))) return;
    close();
  };
  setTimeout(() => document.addEventListener('mousedown', f), 0);
  return () => document.removeEventListener('mousedown', f);
}

export function el<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const x = root.querySelector<T>(sel);
  if (!x) throw new Error(`fixture: missing ${sel}`);
  return x;
}

// ------------------------------------------------------------------ dates

export interface YMD {
  y: number;
  m: number;
  d: number;
}

export function monthName(m: number, locale: string, style: 'long' | 'short' = 'long'): string {
  return new Intl.DateTimeFormat(locale, { month: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2021, m, 15)));
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Format with tokens d dd M MM MMM MMMM yyyy. */
export function fmtDate(d: YMD, fmt: string, locale: string): string {
  return fmt.replace(/yyyy|MMMM|MMM|MM|M|dd|d/g, (t) => {
    switch (t) {
      case 'yyyy': return String(d.y);
      case 'MMMM': return monthName(d.m, locale);
      case 'MMM': return monthName(d.m, locale, 'short');
      case 'MM': return pad(d.m + 1);
      case 'M': return String(d.m + 1);
      case 'dd': return pad(d.d);
      default: return String(d.d);
    }
  });
}

/** Parse a typed value with the widget's format (numeric tokens and month names). */
export function parseDate(s: string, fmt: string, locale: string): YMD | undefined {
  const order: string[] = [];
  const re = new RegExp(`^${fmt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/yyyy|MMMM|MMM|MM|M|dd|d/g, (t) => {
    order.push(t);
    return t.startsWith('MMM') ? '([^\\d\\s,.]+)\\.?' : t === 'yyyy' ? '(\\d{4})' : '(\\d{1,2})';
  })}$`);
  const m = re.exec(s.trim());
  if (!m) return undefined;
  const out: YMD = { y: 0, m: -1, d: 0 };
  order.forEach((t, i) => {
    const v = m[i + 1];
    if (t === 'yyyy') out.y = Number(v);
    else if (t.startsWith('MMM')) out.m = [...Array(12).keys()].find((k) => [monthName(k, locale), monthName(k, locale, 'short')].some((n) => n.toLowerCase().replace(/\.$/, '') === v.toLowerCase())) ?? -1;
    else if (t.startsWith('M')) out.m = Number(v) - 1;
    else out.d = Number(v);
  });
  if (out.y < 1000 || out.m < 0 || out.m > 11 || out.d < 1 || out.d > 31) return undefined;
  return out;
}

export function sameYmd(a: YMD | null | undefined, b: YMD | null | undefined): boolean {
  return !!a && !!b && a.y === b.y && a.m === b.m && a.d === b.d;
}

/** Days shown in a month view (6 weeks, Sunday first), with outside-month flags. */
export function monthGrid(year: number, month: number): Array<{ date: YMD; outside: boolean }> {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return { date: { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() }, outside: d.getMonth() !== month };
  });
}

export function today(): YMD {
  const n = new Date();
  return { y: n.getFullYear(), m: n.getMonth(), d: n.getDate() };
}
