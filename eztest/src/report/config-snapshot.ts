/**
 * The effective configuration of a run, flattened for the report
 * ("healing.maxTier" = "T2-semantic"), with secrets masked: values of keys
 * that look sensitive, credentials in URLs and connection strings, and
 * token-shaped strings. secret:// references stay (they name where the
 * secret lives, not the secret).
 */

const SENSITIVE_KEY = /(pass(word|wd|phrase)?$|^pwd$|secret|token|authorization|cookie|api[-_]?key|^pat$|credential|private[-_]?key|totp|session[-_]?id|signature|webhook|connection[-_]?string|^dsn$)/i;
const TOKEN_VALUE = /\b(ezt_[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/g;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+)(:[^/\s@]*)?@/gi;
const URL_SECRET_PARAM = /([?&;](?:access_token|token|api[_-]?key|key|secret|password|pwd|pass|sig|signature|code)=)[^&#;\s]*/gi;
const KV_SECRET = /\b(password|pwd|secret|token|api[_-]?key)\s*=\s*(?!\*\*\*\*)[^;,&\s]+/gi;

/** Keys that name where or how a secret is used, not the secret ("tokenUrl", "secretStore.type"). */
const DESCRIPTIVE_KEY = /(url|uri|path|file|dir|endpoint|header|name|type|prefix|env|ttl|ms|seconds|enabled|scope|store|stores|provider)$/i;

export const MASK = '****';

/** Mask one configuration value given its key. */
export function maskConfigValue(key: string, value: string): string {
  if (/^secret:\/\//.test(value)) return value;
  // A webhook or connection string URL is itself the secret.
  if (SENSITIVE_KEY.test(key) && (!DESCRIPTIVE_KEY.test(key) || /webhook|connection/i.test(key)) && value.length) return MASK;
  return value
    .replace(TOKEN_VALUE, MASK)
    .replace(URL_USERINFO, (_m, scheme: string, user: string, pass?: string) => `${scheme}${pass ? `${user}:${MASK}` : MASK}@`)
    .replace(URL_SECRET_PARAM, `$1${MASK}`)
    .replace(KV_SECRET, (_m, k: string) => `${k}=${MASK}`);
}

/**
 * Flatten a configuration object to [key, value] pairs, masked. Arrays of plain values are joined;
 * arrays of objects are indexed. At most `max` entries; long values are cut.
 */
export function configSnapshot(config: unknown, o: { max?: number; maxValue?: number } = {}): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const max = o.max ?? 500;
  const maxValue = o.maxValue ?? 300;
  const put = (k: string, v: string) => {
    if (out.length >= max) return;
    const leaf = k.split('.').pop() ?? k;
    const masked = maskConfigValue(leaf.replace(/\[\d+\]$/, ''), v);
    out.push([k, masked.length > maxValue ? `${masked.slice(0, maxValue)}…` : masked]);
  };
  const walk = (v: unknown, key: string, depth: number) => {
    if (out.length >= max || v === undefined || typeof v === 'function') return;
    if (v === null || typeof v !== 'object') {
      if (key) put(key, String(v));
      return;
    }
    if (depth > 8) return;
    if (Array.isArray(v)) {
      if (!v.length) return;
      if (v.every((x) => x === null || typeof x !== 'object')) put(key, v.map(String).join(', '));
      else v.forEach((x, i) => walk(x, `${key}[${i}]`, depth + 1));
      return;
    }
    const entries = Object.entries(v as Record<string, unknown>);
    if (!entries.length) return;
    for (const [k, x] of entries.sort(([a], [b]) => a.localeCompare(b))) {
      // A sensitive object (e.g. `auth: { ... }`) is still walked: its leaves are masked by their own keys.
      walk(x, key ? `${key}.${k}` : k, depth + 1);
    }
  };
  walk(config, '', 0);
  return out;
}
