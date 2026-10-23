/**
 * Config -> runner: the browsers of a run and remote endpoints, with
 * secret:// references in headers and credentials resolved through the
 * Identity Vault and registered with the masker (they never reach logs,
 * evidence or reports).
 */
import type { BrowserConnectConfig, EzTestConfig } from '../config/index.js';
import type { BrowserTarget, RemoteBrowserConnect, RunOptions } from '../runner/index.js';

type Resolve = (ref: string) => Promise<string>;

/** Resolve one `connect:` block: secrets in headers and auth, auth turned into a header or a query parameter. */
export async function remoteConnectFromConfig(c: BrowserConnectConfig, resolveSecret: Resolve, mask: (secret: string) => void): Promise<RemoteBrowserConnect> {
  const value = async (v: string | undefined): Promise<string | undefined> => {
    if (v === undefined) return undefined;
    if (!v.startsWith('secret://')) return v;
    const s = await resolveSecret(v);
    mask(s);
    return s;
  };
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.headers ?? {})) {
    const s = (await value(v)) ?? '';
    // Header values are credentials as often as not (tokens, API keys): masked even when written in plain text.
    if (/^(?:authorization|proxy-authorization|x-api-key|api-key|cookie)$/i.test(k) || /token|key|secret/i.test(k)) mask(s);
    headers[k] = s;
  }
  let cdp = c.cdpEndpoint;
  let bidi = c.bidiEndpoint;
  const a = c.auth;
  if (a) {
    const token = await value(a.token);
    const user = await value(a.username);
    const pass = await value(a.password);
    if (token) mask(token);
    if (pass) mask(pass);
    if (token && a.queryParam) {
      const add = (ep: string | undefined) => {
        if (!ep) return ep;
        const u = new URL(ep);
        u.searchParams.set(a.queryParam!, token);
        return u.toString();
      };
      cdp = add(cdp);
      bidi = add(bidi);
    } else if (token) {
      headers.Authorization ??= `Bearer ${token}`;
    } else if (user !== undefined) {
      const basic = Buffer.from(`${user}:${pass ?? ''}`).toString('base64');
      mask(basic);
      headers.Authorization ??= `Basic ${basic}`;
    }
  }
  if (headers.Authorization) mask(headers.Authorization);
  return {
    ...(cdp ? { cdpEndpoint: cdp } : {}), ...(bidi ? { bidiEndpoint: bidi } : {}),
    ...(Object.keys(headers).length ? { headers } : {}), ...(c.timeoutMs ? { timeoutMs: c.timeoutMs } : {}),
  };
}

/** `browsers:` and `browser.connect` from config, as run options. */
export async function browserRunOptions(config: Pick<EzTestConfig, 'browsers' | 'browserConnect'>, resolveSecret: Resolve, mask: (secret: string) => void): Promise<Pick<RunOptions, 'browsers' | 'connect'>> {
  const out: Pick<RunOptions, 'browsers' | 'connect'> = {};
  if (config.browserConnect) out.connect = await remoteConnectFromConfig(config.browserConnect, resolveSecret, mask);
  if (config.browsers?.length) {
    const list: BrowserTarget[] = [];
    for (const b of config.browsers) {
      if (typeof b === 'string') list.push(b);
      else list.push({ name: b.name, ...(b.executablePath ? { executablePath: b.executablePath } : {}), ...(b.connect ? { connect: await remoteConnectFromConfig(b.connect, resolveSecret, mask) } : {}) });
    }
    out.browsers = list;
  }
  return out;
}
