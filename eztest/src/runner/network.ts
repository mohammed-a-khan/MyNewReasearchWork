/**
 * Network control for a journey's browser context: mock (fulfil) a route,
 * delay it, abort/block it (or whole resource types and analytics), add
 * request headers, stop mocking, go offline, throttle (Chromium), save the
 * recorded traffic as a HAR file (masked) and replay a HAR.
 *
 * Routes are context-wide, so popups and new tabs obey them too.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Route } from '../browser/index.js';
import { EzTestError, NotSupportedError, sleep, type Step } from '../core/index.js';
import type { ActionOutcome } from './actions.js';
import { safeName } from './evidence.js';
import { urlMatches } from './pages.js';
import type { BrowserSession } from './session.js';
import type { RunOptions, StepContext } from './types.js';

/** Network condition profiles (latency ms, download/upload kbit/s), after Chrome DevTools presets. */
export const THROTTLE_PROFILES: Record<string, { latency: number; download: number; upload: number }> = {
  slow3g: { latency: 400, download: 400, upload: 400 },
  fast3g: { latency: 150, download: 1600, upload: 750 },
  '4g': { latency: 60, download: 9000, upload: 9000 },
  dsl: { latency: 5, download: 2000, upload: 1000 },
};

const ANALYTICS = /google-analytics\.com|googletagmanager\.com|\/gtag\/|analytics\.|segment\.(?:io|com)|hotjar|mixpanel|doubleclick\.net|connect\.facebook\.net|clarity\.ms|amplitude\.com|plausible\.io|matomo|newrelic|nr-data\.net|sentry\.io/i;
const RESOURCE_PRESETS: Record<string, string[]> = {
  images: ['image'], image: ['image'], fonts: ['font'], font: ['font'], media: ['media'], video: ['media'], stylesheets: ['stylesheet'],
  css: ['stylesheet'], styles: ['stylesheet'], scripts: ['script'],
};

let routeIds = 0;

function matcherFor(pattern: string): (url: URL) => boolean {
  if (!pattern || pattern === '*' || pattern === '**') return () => true;
  return (u) => urlMatches(u.toString(), pattern);
}

async function addRoute(session: BrowserSession, url: string, op: string, handler: (route: Route) => Promise<void>): Promise<void> {
  const matcher = matcherFor(url);
  const entry = { id: ++routeIds, url, op, matcher, handler };
  session.routes.push(entry);
  await session.context.route(matcher, handler);
}

function needSession(ctx: StepContext): BrowserSession {
  if (!ctx.session) throw new EzTestError('network steps need a browser session', 'NO_SESSION');
  return ctx.session;
}

const str = (v: unknown, ctx: StepContext) => (v === undefined ? undefined : ctx.interpolate(String(v)));

export async function networkAction(step: Step, ctx: StepContext, opts: RunOptions): Promise<ActionOutcome> {
  const a = step.args ?? {};
  const session = needSession(ctx);
  const op = String(a.op ?? '');
  const url = str(a.url, ctx) ?? '';
  const method = a.method ? String(a.method).toUpperCase() : undefined;
  const methodOk = (r: Route) => !method || r.request().method() === method;
  switch (op) {
    case 'mock': {
      const status = a.status === undefined ? 200 : Number(a.status);
      let body: string | Buffer | undefined = str(a.body, ctx);
      if (a.bodyFile) body = await readFile(resolve(opts.baseDir ?? process.cwd(), String(str(a.bodyFile, ctx))));
      const headers = Object.fromEntries(Object.entries((a.headers ?? {}) as Record<string, string>).map(([k, v]) => [k, ctx.interpolate(String(v))]));
      let contentType = str(a.contentType, ctx) ?? headers['content-type'];
      if (!contentType) {
        const text = typeof body === 'string' ? body.trim() : String(a.bodyFile ?? '');
        contentType = /^[[{]/.test(text) || /\.json$/i.test(text) ? 'application/json' : 'text/plain';
      }
      let left = a.times === undefined ? Infinity : Number(a.times);
      await addRoute(session, url, 'mock', async (route) => {
        if (!methodOk(route) || left <= 0) return route.fallback();
        left--;
        await route.fulfill({ status, body, headers: { ...headers, 'content-type': contentType! } });
      });
      return {};
    }
    case 'delay': {
      const ms = Number(a.ms ?? 1000);
      await addRoute(session, url, 'delay', async (route) => {
        if (!methodOk(route)) return route.fallback();
        await sleep(ms);
        await route.fallback();
      });
      return {};
    }
    case 'abort':
    case 'block': {
      const preset = a.preset ? String(a.preset).toLowerCase() : undefined;
      const types = preset ? RESOURCE_PRESETS[preset] : undefined;
      if (preset && !types && preset !== 'analytics' && preset !== 'trackers') {
        throw new EzTestError(`Unknown block preset "${preset}" (images, fonts, media, stylesheets, scripts, analytics)`, 'BAD_VALUE');
      }
      await addRoute(session, preset ? '*' : url, 'block', async (route) => {
        const req = route.request();
        const hit = types ? types.includes(req.resourceType()) : preset ? ANALYTICS.test(req.url()) : methodOk(route);
        if (!hit) return route.fallback();
        await route.abort(String(a.errorCode ?? 'blockedbyclient'));
      });
      return {};
    }
    case 'headers': {
      const add = Object.fromEntries(Object.entries((a.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), ctx.interpolate(String(v))]));
      await addRoute(session, url || '*', 'headers', async (route) => {
        if (!methodOk(route)) return route.fallback();
        await route.fallback({ headers: { ...route.request().headers(), ...add } });
      });
      return {};
    }
    case 'unroute': {
      const keep: typeof session.routes = [];
      for (const r of session.routes.splice(0)) {
        if (!url || r.url === url) await session.context.unroute(r.matcher, r.handler);
        else keep.push(r);
      }
      session.routes.push(...keep);
      return {};
    }
    case 'offline': await session.context.setOffline(true); return {};
    case 'online': await session.context.setOffline(false); return {};
    case 'throttle': {
      const cdp = await session.cdpSession('Network throttling');
      const name = String(a.profile ?? 'slow3g').toLowerCase().replace(/[\s-]/g, '');
      await cdp.send('Network.enable');
      if (name === 'none' || name === 'off') {
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        return {};
      }
      const p = THROTTLE_PROFILES[name] ?? (a.latencyMs !== undefined ? { latency: Number(a.latencyMs), download: Number(a.downloadKbps ?? 1000), upload: Number(a.uploadKbps ?? 1000) } : undefined);
      if (!p) throw new EzTestError(`Unknown network profile "${String(a.profile)}" (slow 3G, fast 3G, 4G, DSL, none)`, 'BAD_VALUE');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: p.latency, downloadThroughput: (p.download * 1024) / 8, uploadThroughput: (p.upload * 1024) / 8 });
      return {};
    }
    case 'har': {
      const name = safeName(str(a.name, ctx) ?? step.captureAs ?? step.id);
      const har = await buildHar(session, str(a.url, ctx));
      const ref = await ctx.evidence.store('network', `har/${safeName(ctx.journey.id)}/${name.endsWith('.har') ? name : `${name}.har`}`, JSON.stringify(har, null, 2),
        { journeyId: ctx.journey.id, stepId: step.id, description: 'HAR (masked)' });
      if (step.captureAs) {
        const rec = { path: ref.path, entries: har.log.entries.length, evidenceId: ref.id };
        ctx.ledger.set(step.captureAs, rec);
        return { captured: { [step.captureAs]: rec }, evidence: [ref.id] };
      }
      return { evidence: [ref.id] };
    }
    case 'replayHar': {
      const file = resolve(opts.baseDir ?? process.cwd(), String(str(a.file, ctx)));
      await session.context.routeFromHAR(file, { notFound: 'fallback', ...(url ? { url: (u: URL) => urlMatches(u.toString(), url) } as never : {}) });
      return {};
    }
    default:
      throw new NotSupportedError(`network op "${op}"`);
  }
}

/** HAR 1.2 from the session's recorded traffic (headers and bodies masked; text bodies up to 64 KiB). */
export async function buildHar(session: BrowserSession, urlPattern?: string) {
  const entries = [];
  for (const r of session.requests) {
    if (urlPattern && !urlMatches(r.url, urlPattern)) continue;
    let content: { size: number; mimeType: string; text?: string } = { size: -1, mimeType: r.responseHeaders?.['content-type'] ?? '' };
    if (r.response && /json|text|xml|javascript|html/.test(content.mimeType)) {
      const text = await r.response.text().catch(() => undefined);
      if (text !== undefined) content = { size: text.length, mimeType: content.mimeType, text: session.mask(text.slice(0, 64 * 1024)) };
    }
    const u = new URL(r.url);
    entries.push({
      startedDateTime: new Date(r.startedAt).toISOString(),
      time: r.durationMs ?? 0,
      request: {
        method: r.method, url: r.url, httpVersion: 'HTTP/1.1', cookies: [], headersSize: -1, bodySize: r.postData?.length ?? 0,
        headers: Object.entries(r.headers).map(([name, value]) => ({ name, value })),
        queryString: [...u.searchParams].map(([name, value]) => ({ name, value: session.mask(value) })),
        ...(r.postData ? { postData: { mimeType: r.headers['content-type'] ?? '', text: r.postData } } : {}),
      },
      response: {
        status: r.status ?? 0, statusText: r.failure ?? '', httpVersion: 'HTTP/1.1', cookies: [], headersSize: -1, bodySize: content.size, redirectURL: '',
        headers: Object.entries(r.responseHeaders ?? {}).map(([name, value]) => ({ name, value })), content,
      },
      cache: {},
      timings: { send: 0, wait: r.durationMs ?? 0, receive: 0 },
      _resourceType: r.resourceType,
    });
  }
  return { log: { version: '1.2', creator: { name: 'EZTest', version: '0.1.0' }, entries } };
}
