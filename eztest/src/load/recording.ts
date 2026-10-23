/**
 * Sources of user paths besides hand-written YAML:
 *
 * - browser recording through EZTest's own driver: every request and
 *   response of the session (bodies included) is captured, grouped by the
 *   page the user was on, then correlated into a user path;
 * - HAR import (HAR 1.2 is the browsers' standard export format);
 * - EZTest journeys: API steps become protocol-level requests, UI journeys
 *   become browser-level users driven by EZTest's driver;
 * - a run's captured network evidence (browser network logs and API steps).
 */
import { readFile } from 'node:fs/promises';
import { EzTestError } from '../core/index.js';
import type { Journey, Step, LocatorCandidate } from '../core/index.js';
import { normalizeNetworkLog, type NetworkEntry } from '../perf/network.js';
import { generateUserPath, type GenerateOptions, type GeneratedUserPath } from './correlation.js';

type Page = import('../browser/index.js').Page;

export async function importHar(file: string, o: GenerateOptions = {}): Promise<GeneratedUserPath> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    throw new EzTestError(`${file}: not a HAR file (${(e as Error).message})`, 'INVALID_INPUT');
  }
  if (!raw || typeof raw !== 'object' || !('log' in raw)) throw new EzTestError(`${file}: not a HAR file (no "log")`, 'INVALID_INPUT');
  return generateUserPath(normalizeNetworkLog(raw), { name: o.name ?? file, ...o });
}

export interface RecordOptions {
  url: string;
  headless?: boolean;
  executablePath?: string;
  /** Scripted recording (tests, CI): drive the page; the recording ends when it resolves. Interactive when absent: close the browser to finish. */
  drive?: (page: Page) => Promise<void>;
  /** Only keep requests to these origins (default: the start URL's origin). */
  origins?: string[];
  timeoutMs?: number;
}

/** Record a browser session through EZTest's driver into network entries grouped by page. */
export async function recordBrowserTraffic(o: RecordOptions): Promise<NetworkEntry[]> {
  const { chromium } = await import('../browser/index.js');
  const browser = await chromium.launch({ headless: o.headless ?? !!o.drive, ...(o.executablePath ? { executablePath: o.executablePath } : {}) });
  const origins = new Set(o.origins ?? [new URL(o.url).origin]);
  const entries: Array<NetworkEntry & { _seq: number }> = [];
  const pending: Array<Promise<void>> = [];
  let seq = 0;
  let group = 'start';
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) {
        try {
          group = new URL(f.url()).pathname || '/';
        } catch {
          /* about:blank */
        }
      }
    });
    page.on('response', (res) => {
      const req = res.request();
      let origin: string;
      try {
        origin = new URL(req.url()).origin;
      } catch {
        return;
      }
      if (!origins.has(origin)) return;
      const mySeq = seq++;
      const myGroup = req.isNavigationRequest() && req.frame() === page.mainFrame() ? new URL(req.url()).pathname || '/' : group;
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) group = myGroup;
      const t = req.timing();
      pending.push(
        (async () => {
          let body: string | undefined;
          const status = res.status();
          if (status < 300 || status >= 400) body = await res.text().catch(() => undefined);
          const headers = await res.allHeaders().catch(() => res.headers());
          const reqHeaders = await req.allHeaders().catch(() => req.headers());
          entries.push({
            _seq: mySeq,
            method: req.method(),
            url: req.url(),
            status,
            requestHeaders: reqHeaders,
            requestBody: req.postData() ?? undefined,
            responseHeaders: headers,
            responseBody: body,
            timing: { startTime: t.startTime > 0 ? t.startTime : Date.now(), duration: t.responseEnd > 0 ? t.responseEnd : undefined },
            group: myGroup,
          });
        })(),
      );
    });
    await page.goto(o.url, { timeout: o.timeoutMs ?? 30_000 });
    if (o.drive) await o.drive(page);
    else await new Promise<void>((resolve) => browser.on('disconnected', () => resolve()));
    await Promise.all(pending);
  } finally {
    await browser.close().catch(() => undefined);
  }
  return entries.sort((a, b) => a._seq - b._seq).map(({ _seq: _s, ...e }) => e);
}

// ------------------------------------------------------------------ journeys -> user paths

const UI_ACTIONS = new Set(['navigate', 'click', 'dblclick', 'fill', 'clear', 'select', 'check', 'uncheck', 'press', 'hover', 'assert', 'wait']);

function selectorOf(c: LocatorCandidate | undefined): string | undefined {
  if (!c) return undefined;
  switch (c.strategy) {
    case 'css':
      return c.value;
    case 'xpath':
      return `xpath=${c.value}`;
    case 'testId':
      return `[data-testid="${c.value}"]`;
    case 'role':
      return `role=${c.value}${c.name ? `[name="${c.name.replace(/"/g, '\\"')}"]` : ''}`;
    case 'text':
      return `text=${c.value}`;
    case 'label':
      return `internal:label="${c.value.replace(/"/g, '\\"')}"i`;
    case 'placeholder':
      return `[placeholder="${c.value.replace(/"/g, '\\"')}"]`;
    case 'altText':
      return `[alt="${c.value.replace(/"/g, '\\"')}"]`;
    case 'title':
      return `[title="${c.value.replace(/"/g, '\\"')}"]`;
    case 'id':
      return `#${c.value}`;
    default:
      return undefined;
  }
}

const ezVars = (s: string) => s.replace(/\$\{([\w.]+)\}/g, (_m, v: string) => `\${${v}}`);

function stepToActions(step: Step, warnings: string[]): unknown[] {
  if (step.action === 'api' && step.api) {
    const a = step.api;
    const spec: Record<string, unknown> = { name: step.intent.slice(0, 80), method: a.method, url: ezVars(a.url) };
    if (a.headers) spec.headers = Object.fromEntries(Object.entries(a.headers).map(([k, v]) => [k, ezVars(v)]));
    if (a.form) spec.form = Object.fromEntries(Object.entries(a.form).map(([k, v]) => [k, ezVars(v)]));
    else if (a.body !== undefined) {
      if (typeof a.body === 'string') spec.body = ezVars(a.body);
      else spec.json = a.body;
    }
    if (a.query) {
      const q = new URLSearchParams(Object.entries(a.query)).toString().replace(/%24%7B([\w.]+)%7D/g, '${$1}');
      spec.url = `${spec.url}${String(spec.url).includes('?') ? '&' : '?'}${q}`;
    }
    const status = step.postconditions.find((c) => c.type === 'apiStatus') as { status?: number } | undefined;
    if (status?.status) spec.assert = [{ status: status.status }];
    if (step.captureAs) spec.captureAs = step.captureAs;
    if (a.asRole) warnings.push(`step "${step.intent}": asRole "${a.asRole}" needs auth in the scenario (options.auth or the path's auth)`);
    return [{ request: spec }];
  }
  if (step.action === 'wait' && step.value && /^\d+$/.test(step.value)) return [{ think: Number(step.value) }];
  if (UI_ACTIONS.has(step.action)) {
    const sel = selectorOf(step.target?.locators?.[0]);
    const name = step.intent.slice(0, 80);
    switch (step.action) {
      case 'navigate':
        return [{ browser: { name, goto: ezVars(step.value ?? '/') } }];
      case 'click':
      case 'dblclick':
        return sel ? [{ browser: { name, click: sel } }] : [];
      case 'fill':
      case 'clear':
        return sel ? [{ browser: { name, fill: sel, value: ezVars(step.value ?? '') } }] : [];
      case 'select':
        return sel ? [{ browser: { name, select: sel, value: ezVars(step.value ?? '') } }] : [];
      case 'check':
        return sel ? [{ browser: { name, check: sel } }] : [];
      case 'press':
        return sel ? [{ browser: { name, press: sel, key: step.value ?? 'Enter' } }] : [];
      case 'assert': {
        const text = step.postconditions.find((c) => c.type === 'pageContainsText' || c.type === 'textContains') as { value?: string } | undefined;
        if (text?.value) return [{ browser: { name, expectText: ezVars(text.value) } }];
        const url = step.postconditions.find((c) => c.type === 'urlContains') as { value?: string } | undefined;
        if (url?.value) return [{ browser: { name, expectUrl: url.value } }];
        return [];
      }
      default:
        return [];
    }
  }
  if (step.steps?.length) return step.steps.flatMap((s) => stepToActions(s, warnings));
  warnings.push(`step "${step.intent}" (${step.action}) has no load equivalent and was left out`);
  return [];
}

/** An EZTest journey as a user path: API steps at protocol level, UI steps as a browser-level user. */
export function journeyToUserPath(j: Journey): { path: { description: string; source: string; actions: unknown[]; variables: Record<string, string> }; browser: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const actions: unknown[] = [];
  for (const s of j.steps) {
    const acts = stepToActions(s, warnings);
    if (acts.length === 1) actions.push(acts[0]);
    else if (acts.length > 1) actions.push({ transaction: { name: s.intent.slice(0, 80), actions: acts } });
  }
  if (!actions.length) throw new EzTestError(`journey "${j.name}" has no steps that can run under load`, 'INVALID_INPUT');
  const browser = JSON.stringify(actions).includes('"browser"');
  return { path: { description: `From journey ${j.name}`, source: `journey:${j.id}`, actions, variables: { ...j.variables } }, browser, warnings };
}
