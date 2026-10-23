/** Escaping helpers shared by the HTML and XML writers. */

const HTML_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

/** Escape text for HTML element content and quoted attribute values. */
export function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/[&<>"'`]/g, (c) => HTML_MAP[c]);
}

// XML 1.0 forbids most C0 control characters even when escaped.
// eslint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

export function escapeXml(v: unknown): string {
  return String(v ?? '')
    .replace(XML_INVALID, '\uFFFD')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/**
 * Turn an evidence path (relative to the run directory) into a safe relative
 * URL. Absolute paths, schemes and parent traversal are rejected (undefined).
 */
export function safeRelativeUrl(path: string): string | undefined {
  const p = path.split('\\').join('/');
  if (!p || p.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(p)) return undefined;
  const segs = p.split('/');
  if (segs.some((s) => s === '..' || s === '')) return undefined;
  return segs.map((s) => encodeURIComponent(s)).join('/');
}
