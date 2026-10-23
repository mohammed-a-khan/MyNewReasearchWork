/**
 * A per-virtual-user cookie jar (RFC 6265 rules that matter for load
 * tests: host-only vs domain cookies, path prefix, Secure, expiry via
 * Max-Age/Expires, deletion by an expired Set-Cookie).
 */

interface Cookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  expires?: number;
}

function defaultPath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/';
  const i = pathname.lastIndexOf('/');
  return i <= 0 ? '/' : pathname.slice(0, i);
}

function domainMatch(host: string, domain: string): boolean {
  return host === domain || (host.endsWith(`.${domain}`) && !/^\d+\.\d+\.\d+\.\d+$/.test(host));
}

function pathMatch(reqPath: string, cookiePath: string): boolean {
  if (reqPath === cookiePath) return true;
  if (reqPath.startsWith(cookiePath)) return cookiePath.endsWith('/') || reqPath[cookiePath.length] === '/';
  return false;
}

export class CookieJar {
  private cookies: Cookie[] = [];

  /** Store the Set-Cookie headers of a response to `url`. */
  setFromResponse(url: URL, setCookie: string | string[] | undefined): void {
    if (!setCookie) return;
    for (const line of Array.isArray(setCookie) ? setCookie : [setCookie]) this.set(url, line);
  }

  set(url: URL, line: string): void {
    const parts = line.split(';');
    const first = parts.shift() ?? '';
    const eq = first.indexOf('=');
    if (eq <= 0) return;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    const host = url.hostname.toLowerCase();
    const c: Cookie = { name, value, domain: host, hostOnly: true, path: defaultPath(url.pathname), secure: false };
    let maxAge: number | undefined;
    for (const attr of parts) {
      const i = attr.indexOf('=');
      const k = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
      const v = i < 0 ? '' : attr.slice(i + 1).trim();
      if (k === 'domain' && v) {
        const d = v.replace(/^\./, '').toLowerCase();
        if (!domainMatch(host, d)) return; // a cookie for another domain is rejected
        c.domain = d;
        c.hostOnly = false;
      } else if (k === 'path' && v.startsWith('/')) c.path = v;
      else if (k === 'secure') c.secure = true;
      else if (k === 'max-age' && /^-?\d+$/.test(v)) maxAge = Number(v);
      else if (k === 'expires' && maxAge === undefined) {
        const t = Date.parse(v);
        if (Number.isFinite(t)) c.expires = t;
      }
    }
    if (maxAge !== undefined) c.expires = maxAge <= 0 ? 0 : Date.now() + maxAge * 1000;
    this.cookies = this.cookies.filter((x) => !(x.name === c.name && x.domain === c.domain && x.path === c.path));
    if (c.expires !== undefined && c.expires <= Date.now()) return;
    this.cookies.push(c);
  }

  /** The Cookie header for a request to `url` (undefined when none apply). */
  header(url: URL): string | undefined {
    const now = Date.now();
    const host = url.hostname.toLowerCase();
    const secure = url.protocol === 'https:' || url.protocol === 'wss:';
    const out: Cookie[] = [];
    this.cookies = this.cookies.filter((c) => c.expires === undefined || c.expires > now);
    for (const c of this.cookies) {
      if (c.hostOnly ? c.domain !== host : !domainMatch(host, c.domain)) continue;
      if (!pathMatch(url.pathname || '/', c.path)) continue;
      if (c.secure && !secure) continue;
      out.push(c);
    }
    if (!out.length) return undefined;
    out.sort((a, b) => b.path.length - a.path.length);
    return out.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  get(name: string): string | undefined {
    return this.cookies.find((c) => c.name === name)?.value;
  }

  clear(): void {
    this.cookies = [];
  }

  get size(): number {
    return this.cookies.length;
  }
}
