/**
 * Browsers of a run: the cross-browser matrix and remote endpoints
 * (docs/browser-driver.md, "Cross-browser runs" and "Remote browsers").
 *
 * A run has one or more browser targets. With one target nothing changes:
 * journeys keep their ids. With several (`browsers: [chromium, firefox,
 * msedge]` / `--browsers chromium,firefox`) the run plan expands every journey
 * into journey x browser units whose ids end in `@<browser>`; history, flaky
 * scores, triage, reports and readiness then see each browser separately, and
 * `RunResult.browsers` holds the per-browser summaries next to the combined
 * one.
 *
 * Remote browsers are reached over the browser's own protocol only: a
 * Chrome/Edge DevTools endpoint (CDP) or a Firefox WebDriver BiDi WebSocket.
 * EZTest does not speak other test tools' protocols (no Playwright server, no
 * Selenium/WebDriver Grid sessions); a vendor grid works when it exposes the
 * browser's native CDP or BiDi endpoint.
 */
import { chromium, firefox, type Browser } from '../browser/index.js';
import type { FirefoxBrowserType } from '../browser/firefox/browser.js';
import { NotSupportedError, slugify, type Journey } from '../core/index.js';
import type { BrowserTarget, RemoteBrowserConnect, RunOptions } from './types.js';

/** Chromium builds addressed by channel (installed Chrome / Edge). */
const CHANNELS = new Set(['chrome', 'chrome-beta', 'chrome-dev', 'chrome-canary', 'msedge', 'msedge-beta', 'msedge-dev', 'msedge-canary']);

/** One resolved browser of a run. */
export interface ResolvedBrowser {
  /** Name in result ids, reports and history: chromium, firefox, msedge, chrome, ... */
  id: string;
  /** The engine / driver. */
  engine: 'chromium' | 'firefox';
  channel?: string;
  executablePath?: string;
  connect?: RemoteBrowserConnect;
}

/** Separator between a journey id and its browser in a cross-browser unit id. */
export const BROWSER_SEP = '@';

/** Normalise one browser target (a name or an entry). Throws for unknown names and for webkit. */
export function resolveBrowserTarget(t: BrowserTarget): ResolvedBrowser {
  const entry = typeof t === 'string' ? { name: t } : t;
  const name = String(entry.name ?? '').trim().toLowerCase();
  if (!name) throw new NotSupportedError('a browser entry without a name');
  if (name === 'webkit' || name === 'safari') throw new NotSupportedError('browser "webkit" (EZTest drives chromium, chrome, msedge and firefox)');
  const base: Omit<ResolvedBrowser, 'engine'> = {
    id: name,
    ...(entry.executablePath ? { executablePath: entry.executablePath } : {}),
    ...(entry.connect ? { connect: entry.connect } : {}),
  };
  if (name === 'firefox') {
    if (entry.connect?.cdpEndpoint) throw new NotSupportedError('a cdpEndpoint for firefox (Firefox is reached over WebDriver BiDi: use bidiEndpoint)');
    return { ...base, engine: 'firefox' };
  }
  if (name === 'chromium') {
    if (entry.connect?.bidiEndpoint) throw new NotSupportedError('a bidiEndpoint for chromium (Chrome and Edge are reached over their DevTools endpoint: use cdpEndpoint)');
    return { ...base, engine: 'chromium' };
  }
  if (CHANNELS.has(name)) {
    if (entry.connect?.bidiEndpoint) throw new NotSupportedError(`a bidiEndpoint for ${name} (use cdpEndpoint)`);
    return { ...base, engine: 'chromium', channel: name };
  }
  throw new NotSupportedError(`browser "${name}" (use chromium, chrome, msedge, firefox, or a channel such as chrome-beta / msedge-dev)`);
}

/** The browsers of a run: `browsers` when given, else the single `browser` (+ channel, executablePath, connect). */
export function runBrowsers(opts: Pick<RunOptions, 'browsers' | 'browser' | 'channel' | 'executablePath' | 'connect'>): ResolvedBrowser[] {
  if (opts.browsers?.length) {
    const out: ResolvedBrowser[] = [];
    for (const t of opts.browsers) {
      const r = resolveBrowserTarget(t);
      if (out.some((x) => x.id === r.id)) throw new NotSupportedError(`browser "${r.id}" listed twice in browsers`);
      // The run-level remote endpoint and executable apply to a single-entry list only.
      out.push(opts.browsers.length === 1 ? { ...r, ...(opts.connect && !r.connect ? { connect: opts.connect } : {}) } : r);
    }
    return out;
  }
  const kind = opts.browser ?? 'chromium';
  if (kind === 'webkit') throw new NotSupportedError('browser "webkit" (EZTest drives chromium, chrome, msedge and firefox)');
  if (opts.channel && kind !== 'chromium') throw new NotSupportedError(`browser channel "${opts.channel}" with ${kind} (channels are for chromium: msedge, chrome, ...)`);
  const r = resolveBrowserTarget({ name: kind, ...(opts.connect ? { connect: opts.connect } : {}) });
  // The single browser keeps the name "chromium" with a channel, as before (result ids and history do not change).
  return [{ ...r, ...(opts.channel && opts.channel !== 'chromium' ? { channel: opts.channel } : {}), ...(opts.executablePath ? { executablePath: opts.executablePath } : {}) }];
}

/** Launch the browser, or attach to it when it has a remote endpoint. */
export async function openBrowser(b: ResolvedBrowser, opts: Pick<RunOptions, 'headless'>): Promise<Browser> {
  if (b.connect) return connectBrowser(b);
  const launch = {
    headless: opts.headless ?? true,
    ...(b.executablePath ? { executablePath: b.executablePath } : {}),
    ...(b.channel && !b.executablePath ? { channel: b.channel } : {}),
  };
  return b.engine === 'firefox' ? firefox.launch(launch) : chromium.launch(launch);
}

/**
 * Attach to a running browser over its own protocol. Only what the run creates (its browser contexts
 * and pages) is closed at the end; the remote browser keeps running.
 */
export async function connectBrowser(b: ResolvedBrowser): Promise<Browser> {
  const c = b.connect!;
  const headers = c.headers ?? {};
  const timeout = c.timeoutMs ?? 30_000;
  if (c.cdpEndpoint && c.bidiEndpoint) throw new NotSupportedError(`both cdpEndpoint and bidiEndpoint for ${b.id} (give one)`);
  if (b.engine === 'firefox') {
    if (!c.bidiEndpoint) throw new NotSupportedError(`firefox without a bidiEndpoint (Firefox is reached over WebDriver BiDi)`);
    const ff = firefox as unknown as FirefoxBrowserType;
    return (await ff.connectOverBiDi(c.bidiEndpoint, { headers, timeout })) as unknown as Browser;
  }
  if (!c.cdpEndpoint) throw new NotSupportedError(`${b.id} without a cdpEndpoint (Chrome and Edge are reached over their DevTools endpoint)`);
  return chromium.connectOverCDP(c.cdpEndpoint, { headers, timeout });
}

/** Where a browser runs, for run.json (no credentials: user info and query values are hidden). */
export function describeBrowser(b: ResolvedBrowser): string {
  if (!b.connect) return 'launched';
  const ep = b.connect.cdpEndpoint ?? b.connect.bidiEndpoint ?? '';
  try {
    const u = new URL(ep);
    u.username = '';
    u.password = '';
    u.search = '';
    return `${b.connect.cdpEndpoint ? 'cdp' : 'bidi'} ${u.protocol}//${u.host}`;
  } catch {
    return b.connect.cdpEndpoint ? 'cdp' : 'bidi';
  }
}

/** The journey id of a cross-browser unit id ("checkout@firefox" -> "checkout"); other ids unchanged. */
export function stripBrowser(id: string, browsers?: readonly string[]): string {
  const i = id.lastIndexOf(BROWSER_SEP);
  if (i <= 0) return id;
  const tail = id.slice(i + 1).replace(/~rep\d+$/, '');
  if (browsers ? !browsers.includes(tail) : !/^(?:chromium|firefox|webkit|chrome|msedge)(?:-[a-z]+)?$/.test(tail)) return id;
  return id.slice(0, i) + id.slice(i + 1 + tail.length);
}

/** The browser of a cross-browser unit id, if it has one. */
export function browserOfId(id: string): string | undefined {
  const s = stripBrowser(id);
  if (s === id) return undefined;
  return id.slice(id.lastIndexOf(BROWSER_SEP) + 1).replace(/~rep\d+$/, '');
}

/**
 * Expand journeys into journey x browser units (only when the run has more than one browser).
 * A unit's id is `<id>@<browser>`, its name ends in ` [browser]`, `Depends on:` points at the
 * prerequisite's unit on the same browser, and `${browser}` is available as a variable (unless the
 * journey defines one). A journey's `Browsers:` header limits it to those browsers. Journeys that
 * are units already (sharded plans) are kept as they are.
 */
export function expandBrowserMatrix(journeys: Journey[], browsers: readonly string[]): { journeys: Journey[]; excluded: Array<{ journey: Journey; reason: string }> } {
  if (browsers.length <= 1) return { journeys, excluded: [] };
  const byRef = (ref: string): Journey | undefined => {
    const slug = slugify(ref);
    return journeys.find((j) => j.id === ref) ?? journeys.find((j) => j.name === ref) ?? journeys.find((j) => j.id === slug || slugify(j.name) === slug);
  };
  const out: Journey[] = [];
  const excluded: Array<{ journey: Journey; reason: string }> = [];
  for (const j of journeys) {
    if (j.browser) {
      out.push(j);
      continue;
    }
    const want = j.browsers?.length ? browsers.filter((b) => j.browsers!.map((x) => x.toLowerCase()).includes(b)) : browsers;
    if (!want.length) {
      excluded.push({ journey: j, reason: `not run: the journey runs on ${j.browsers!.join(', ')} only (Browsers:), the run uses ${browsers.join(', ')}` });
      continue;
    }
    for (const b of want) {
      out.push({
        ...j,
        id: `${j.id}${BROWSER_SEP}${b}`,
        name: `${j.name} [${b}]`,
        browser: b,
        variables: 'browser' in j.variables ? j.variables : { ...j.variables, browser: b },
        ...(j.dependsOn?.length ? { dependsOn: j.dependsOn.map((d) => ({ ...d, journey: `${byRef(d.journey)?.id ?? d.journey}${BROWSER_SEP}${b}` })) } : {}),
      });
    }
  }
  return { journeys: out, excluded };
}
