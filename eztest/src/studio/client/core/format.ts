/** Small formatting helpers for durations, percentages, times and lists. */
export function ms(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '';
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)} s`;
  const m = Math.floor(n / 60_000);
  return `${m} min ${Math.round((n % 60_000) / 1000)} s`;
}

export function pct(x: number | undefined | null): string {
  return `${Math.round((x ?? 0) * 100)}%`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 min ago", "yesterday", or a date. */
export function relTime(iso: string | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 172_800) return 'yesterday';
  return new Date(t).toLocaleDateString();
}

export function dateTime(iso: string | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
}

export function splitList(s: string): string[] {
  return String(s || '')
    .split(',')
    .map((x) => x.trim().replace(/^@/, ''))
    .filter(Boolean);
}

export function basename(p: string): string {
  return p.split('/').pop() ?? p;
}
