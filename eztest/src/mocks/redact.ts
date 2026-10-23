/**
 * Secret redaction shared by mocks, monitors and evidence packs. Deterministic
 * pattern-based: headers by name, JSON / form fields by name, and free text by
 * token-looking shapes (bearer credentials, JWTs, long opaque strings).
 */

export const REDACTED = '[REDACTED]';

export const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
]);

const SENSITIVE_FIELD = /^(access_token|refresh_token|id_token|token|client_secret|password|passwd|secret|api_key|apikey|private_key|session|sessionid)$/i;

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADERS.has(name.toLowerCase());
}

export function isSensitiveField(name: string): boolean {
  return SENSITIVE_FIELD.test(name);
}

/** Lower-case header names and replace sensitive values. */
export function redactHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    out[key] = isSensitiveHeader(key) ? REDACTED : Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

/** Recursively replace sensitive JSON fields with `replacement`. Returns a new value. */
export function redactJsonValue(value: unknown, replacement: string = REDACTED): unknown {
  if (Array.isArray(value)) return value.map((v) => redactJsonValue(v, replacement));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveField(k) && (typeof v === 'string' || typeof v === 'number') ? replacement : redactJsonValue(v, replacement);
    }
    return out;
  }
  return value;
}

/** Redact sensitive fields of an `application/x-www-form-urlencoded` body. */
export function redactFormBody(body: string, replacement: string = REDACTED): string {
  const params = new URLSearchParams(body);
  let changed = false;
  for (const key of [...new Set(params.keys())]) {
    if (isSensitiveField(key)) {
      params.set(key, replacement);
      changed = true;
    }
  }
  return changed ? params.toString() : body;
}

const TEXT_PATTERNS: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  // "Authorization: Bearer x", "authorization=..." etc.
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)(["']?\s*[:=]\s*["']?)([^"'\n,;}]+)/gi, (_m, k, sep) => `${k}${sep}${REDACTED}`],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g, (_m, scheme) => `${scheme} ${REDACTED}`],
  // JSON / query style key=value or "key":"value" for sensitive field names
  [
    /(["']?)(access_token|refresh_token|id_token|client_secret|password|passwd|api_key|apikey|secret|token)\1(\s*[:=]\s*)(["']?)([^"'&\s,}]+)\4/gi,
    (_m, q, k, sep, q2) => `${q}${k}${q}${sep}${q2}${REDACTED}${q2}`,
  ],
  // JWT
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, REDACTED],
  // Long opaque hex / base64url tokens (>= 32 chars, mixing letters and digits)
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, REDACTED],
];

/** Redact credentials and token-looking values from free text (log lines, error messages). */
export function redactText(text: string): string {
  let out = text;
  for (const [re, rep] of TEXT_PATTERNS) out = out.replace(re, rep as never);
  return out;
}

/** True when free text still contains something that looks like a live credential. */
export function containsSecret(text: string): string | undefined {
  const checks: Array<[string, RegExp]> = [
    ['authorization header', /["']?authorization["']?\s*[:=]\s*["']?(?!\[REDACTED\])(Bearer|Basic|Token)\s+\S{6,}/i],
    ['bearer credential', /\bBearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{12,}/],
    ['cookie header', /["'](set-)?cookie["']\s*:\s*["'](?!\[REDACTED\])[^"']*=[^"']+["']/i],
    ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
    ['secret field', /["'](access_token|refresh_token|id_token|client_secret|password|api_key)["']\s*:\s*["'](?!\[REDACTED\]|\{\{)[^"']{4,}["']/i],
  ];
  for (const [what, re] of checks) if (re.test(text)) return what;
  return undefined;
}
