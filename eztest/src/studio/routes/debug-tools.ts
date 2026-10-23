/**
 * Debugger UI helpers on top of `routes/debug.ts`: live step details (the
 * resolved locator, candidates tried, heal ladder, conditions, the step's
 * network and console) and a cheap "what is under the pointer" probe for the
 * element picker's hover highlight. Mounted next to the debug routes.
 */
import { pageFunction } from '../../heal/fingerprint.js';
import { debugOutline } from '../debug-outline.js';
import type { DebugInsight } from '../debug-insight.js';
import type { DebugSessionManager } from '../debug-session.js';
import { HttpError } from '../runs.js';
import { guarded, num, optInt, type RouteDef } from './types.js';

export interface HitResult {
  tag: string;
  label: string;
  box: { x: number; y: number; width: number; height: number };
}

/** Element at a viewport point (through open shadow roots): tag, a short label and its box. */
export const HIT_AT = pageFunction<{ x: number; y: number }, HitResult | null>(String.raw`(p) => {
  var el = document.elementFromPoint(p.x, p.y);
  while (el && el.shadowRoot) {
    var inner = el.shadowRoot.elementFromPoint(p.x, p.y);
    if (!inner || inner === el) break;
    el = inner;
  }
  if (!el || el === document.documentElement || el === document.body) return null;
  var r = el.getBoundingClientRect();
  var tag = el.tagName.toLowerCase();
  var id = el.id ? '#' + el.id : '';
  var tid = el.getAttribute('data-testid');
  var name = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  return { tag: tag, label: tag + id + (tid ? ' [data-testid=' + tid + ']' : '') + (name ? ' "' + name + '"' : ''), box: { x: r.x, y: r.y, width: r.width, height: r.height } };
}`);

export function debugToolRoutes(manager: DebugSessionManager, insight: DebugInsight): RouteDef[] {
  const route = (method: RouteDef['method'], path: RouteDef['path'], handler: RouteDef['handler']): RouteDef => ({ method, path, handler: guarded(handler) });
  return [
    route('GET', '/api/debug/details', ({ query }) => {
      manager.require();
      const index = optInt(query.get('index') ?? undefined, 'index');
      return { json: { ...insight.details(index), steps: insight.summary() } };
    }),
    route('POST', '/api/debug/outline', ({ body }) => ({ json: debugOutline(typeof body.content === 'string' ? body.content : '') })),
    route('POST', '/api/debug/hit', async ({ body }) => {
      const c = manager.require().controller;
      if (!c.isPaused) throw new HttpError(409, 'Cannot inspect: the debugger is not paused');
      const page = c.page;
      if (!page) throw new HttpError(409, 'No live page');
      const hit = await page.evaluate(HIT_AT, { x: num(body.x, 'x'), y: num(body.y, 'y') }).catch(() => null);
      return { json: { hit: hit ? c.maskDeep(hit) : null } };
    }),
  ];
}
