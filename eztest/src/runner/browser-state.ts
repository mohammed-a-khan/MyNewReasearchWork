/**
 * Browser state and emulation: cookies, local/session storage, clearing
 * state, permissions, geolocation, timezone, locale, color scheme, reduced
 * motion, device emulation, viewport, clipboard, HTTP basic auth, extra
 * headers and user agent. Captured cookies and storage values are masked.
 *
 * Journey-level emulation (`Device:`, `Locale:`, `Timezone:` ... headers) is
 * applied when the browser context is created (see contextOptionsFor);
 * mid-journey changes of timezone, locale, device and user agent use the
 * DevTools protocol and therefore need Chromium.
 */
import { devices, type BrowserContextOptions } from '../browser/index.js';
import { EzTestError, NotSupportedError, interpolate, type Emulation, type Step } from '../core/index.js';
import type { ActionOutcome } from './actions.js';
import { maskDeep } from './dom.js';
import { clipboardRead, clipboardWrite, storageOp } from './inpage.js';
import type { BrowserSession } from './session.js';
import type { StepContext } from './types.js';
import { clockAction } from './clock.js';

/** EZTest device descriptor (src/browser/devices.ts) by name (case-insensitive). */
export function deviceByName(name: string): (typeof devices)[string] {
  const exact = devices[name];
  if (exact) return exact;
  const key = Object.keys(devices).find((k) => k.toLowerCase() === name.trim().toLowerCase());
  if (!key) {
    const close = Object.keys(devices).filter((k) => k.toLowerCase().includes(name.trim().toLowerCase().split(/\s+/)[0])).slice(0, 5);
    throw new EzTestError(`Unknown device "${name}"${close.length ? `. Did you mean: ${close.join(', ')}?` : ''}`, 'UNKNOWN_DEVICE');
  }
  return devices[key];
}

/** Browser context options for a journey's emulation block (variables interpolated). */
export function contextOptionsFor(e: Emulation | undefined, vars: Record<string, unknown>): BrowserContextOptions {
  if (!e) return {};
  const I = (s: string) => interpolate(s, vars);
  const out: BrowserContextOptions = {};
  if (e.device) {
    const d = deviceByName(e.device);
    Object.assign(out, { viewport: d.viewport, userAgent: d.userAgent, deviceScaleFactor: d.deviceScaleFactor, isMobile: d.isMobile, hasTouch: d.hasTouch });
  }
  if (e.viewport) out.viewport = e.viewport;
  if (e.locale) out.locale = e.locale;
  if (e.timezoneId) out.timezoneId = e.timezoneId;
  if (e.colorScheme) out.colorScheme = e.colorScheme;
  if (e.reducedMotion) out.reducedMotion = e.reducedMotion;
  if (e.geolocation) out.geolocation = e.geolocation;
  if (e.permissions) out.permissions = e.permissions;
  if (e.userAgent) out.userAgent = I(e.userAgent);
  if (e.extraHTTPHeaders) out.extraHTTPHeaders = Object.fromEntries(Object.entries(e.extraHTTPHeaders).map(([k, v]) => [k, I(v)]));
  if (e.httpCredentials) out.httpCredentials = { username: I(e.httpCredentials.username), password: I(e.httpCredentials.password) };
  if (e.offline !== undefined) out.offline = e.offline;
  if (e.hasTouch !== undefined) out.hasTouch = e.hasTouch;
  if (e.isMobile !== undefined) out.isMobile = e.isMobile;
  return out;
}

function needSession(ctx: StepContext): BrowserSession {
  if (!ctx.session) throw new EzTestError('browser steps need a browser session', 'NO_SESSION');
  return ctx.session;
}

export async function browserAction(step: Step, ctx: StepContext): Promise<ActionOutcome> {
  const a = step.args ?? {};
  const session = needSession(ctx);
  const context = session.context;
  const page = ctx.page;
  const op = String(a.op ?? '');
  const s = (v: unknown) => (v === undefined ? undefined : ctx.interpolate(String(v)));
  const mask = session.mask;
  const capture = (v: unknown): ActionOutcome => {
    if (!step.captureAs) throw new EzTestError(`Step "${step.intent}" needs captureAs`, 'MISSING_CAPTURE_KEY');
    const m = maskDeep(v, mask);
    ctx.ledger.set(step.captureAs, m);
    return { captured: { [step.captureAs]: m } };
  };
  switch (op) {
    // ---------------------------------------------------------- cookies
    case 'setCookie': {
      const url = s(a.url) ?? (page.url().startsWith('http') ? page.url() : ctx.baseUrl);
      if (!url && !a.domain) throw new EzTestError('Set cookie needs a page URL, a baseUrl or a domain', 'MISSING_VALUE');
      const value = s(a.value) ?? '';
      await context.addCookies([a.domain
        ? { name: s(a.name)!, value, domain: s(a.domain)!, path: s(a.path) ?? '/' }
        : { name: s(a.name)!, value, url: new URL(url!).origin }]);
      return {};
    }
    case 'getCookie': {
      const c = (await context.cookies()).find((x) => x.name === s(a.name));
      if (!c) throw new EzTestError(`No cookie "${s(a.name)}"`, 'NO_COOKIE');
      return capture(c.value);
    }
    case 'cookies': return capture((await context.cookies()).map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure })));
    case 'deleteCookie': await context.clearCookies({ name: s(a.name) }); return {};
    case 'clearCookies': await context.clearCookies(); return {};
    // ---------------------------------------------------------- storage
    case 'setStorage': await page.evaluate(storageOp, { area: String(a.area ?? 'local'), op: 'set', key: s(a.key), value: s(a.value) ?? '' }); return {};
    case 'getStorage': {
      const v = await page.evaluate(storageOp, { area: String(a.area ?? 'local'), op: a.key === undefined ? 'all' : 'get', key: s(a.key) });
      return capture(v);
    }
    case 'removeStorage': await page.evaluate(storageOp, { area: String(a.area ?? 'local'), op: 'remove', key: s(a.key) }); return {};
    case 'clearStorage': await page.evaluate(storageOp, { area: String(a.area ?? 'local'), op: 'clear' }); return {};
    case 'clearState': {
      await context.clearCookies();
      await context.clearPermissions();
      if (page.url().startsWith('http')) {
        await page.evaluate(storageOp, { area: 'local', op: 'clear' });
        await page.evaluate(storageOp, { area: 'session', op: 'clear' });
      }
      return {};
    }
    // ---------------------------------------------------------- permissions and emulation
    case 'grant': {
      const perms = (a.permissions as string[] | undefined) ?? [];
      await context.grantPermissions(perms, a.origin ? { origin: s(a.origin) } : page.url().startsWith('http') ? { origin: new URL(page.url()).origin } : {});
      return {};
    }
    case 'clearPermissions': await context.clearPermissions(); return {};
    case 'geolocation': {
      const geo = { latitude: Number(a.latitude), longitude: Number(a.longitude), ...(a.accuracy !== undefined ? { accuracy: Number(a.accuracy) } : {}) };
      if (!Number.isFinite(geo.latitude) || !Number.isFinite(geo.longitude)) throw new EzTestError('geolocation needs latitude and longitude', 'BAD_VALUE');
      await context.grantPermissions(['geolocation']);
      await context.setGeolocation(geo);
      return {};
    }
    case 'colorScheme': await page.emulateMedia({ colorScheme: String(a.value) as 'light' | 'dark' | 'no-preference' }); return {};
    case 'reducedMotion': await page.emulateMedia({ reducedMotion: String(a.value) as 'reduce' | 'no-preference' }); return {};
    case 'media': await page.emulateMedia({ media: String(a.value) as 'print' | 'screen' }); return {};
    case 'viewport': await page.setViewportSize({ width: Number(a.width), height: Number(a.height) }); return {};
    // ---------------------------------------------------------- clock and time (src/browser/clock.ts)
    case 'clock': return clockAction(step, ctx, context);
    case 'timezone': {
      const cdp = await session.cdpSession('Changing the timezone mid-journey (use the "Timezone:" header for other browsers)');
      await cdp.send('Emulation.setTimezoneOverride', { timezoneId: s(a.value)! });
      return {};
    }
    case 'locale': {
      const cdp = await session.cdpSession('Changing the locale mid-journey (use the "Locale:" header for other browsers)');
      await cdp.send('Emulation.setLocaleOverride', { locale: s(a.value)! });
      return {};
    }
    case 'userAgent': {
      const ua = s(a.value)!;
      try {
        const cdp = await session.cdpSession('Changing the user agent');
        await cdp.send('Network.setUserAgentOverride', { userAgent: ua });
        await cdp.send('Emulation.setUserAgentOverride', { userAgent: ua });
      } catch {
        // Other browsers: at least send it on requests.
        session.extraHeaders = { ...session.extraHeaders, 'user-agent': ua };
        await context.setExtraHTTPHeaders(session.extraHeaders);
      }
      return {};
    }
    case 'device': {
      const d = deviceByName(s(a.value)!);
      await page.setViewportSize(d.viewport);
      const cdp = await session.cdpSession('Emulating a device mid-journey (use the "Device:" header for other browsers)');
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: d.viewport.width, height: d.viewport.height, deviceScaleFactor: d.deviceScaleFactor, mobile: d.isMobile });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: d.hasTouch, maxTouchPoints: d.hasTouch ? 5 : 0 });
      await cdp.send('Network.setUserAgentOverride', { userAgent: d.userAgent });
      await cdp.send('Emulation.setUserAgentOverride', { userAgent: d.userAgent });
      return {};
    }
    // ---------------------------------------------------------- clipboard, auth, headers
    case 'clipboardWrite': {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
      await page.evaluate(clipboardWrite, s(a.value) ?? '');
      return {};
    }
    case 'clipboardRead': {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
      return capture(await page.evaluate(clipboardRead, undefined));
    }
    case 'basicAuth': {
      const username = s(a.username) ?? '';
      const password = s(a.password) ?? '';
      // Use secret variables for these; values never appear in evidence (headers are masked).
      await context.setHTTPCredentials({ username, password });
      return {};
    }
    case 'headers': {
      const h = Object.fromEntries(Object.entries((a.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), ctx.interpolate(String(v))]));
      session.extraHeaders = { ...session.extraHeaders, ...h };
      await context.setExtraHTTPHeaders(session.extraHeaders);
      return {};
    }
    default:
      throw new NotSupportedError(`browser op "${op}"`);
  }
}
