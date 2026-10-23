/**
 * Page scripts (opt-in): "Run script "scripts/x.js" with a=1" and
 * "Run JavaScript: return document.title" execute IN THE BROWSER PAGE via
 * the driver's evaluate, never in Node. They are disabled unless the config
 * sets `security.allowPageScripts: true` (RunOptions.allowPageScripts).
 *
 * The script body runs as the body of an async function with `args` (the
 * step's parameters) and, for element scripts, `element` in scope; its return
 * value (JSON-serialisable) can be captured. Node-side extensibility stays
 * with registered custom steps.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Locator } from '../browser/index.js';
import { EzTestError, type Step } from '../core/index.js';
import { maskDeep } from './dom.js';
import type { ActionOutcome } from './actions.js';
import { safeName } from './evidence.js';
import { pageFunction } from '../heal/fingerprint.js';
import type { RunOptions, StepContext } from './types.js';

export const PAGE_SCRIPTS_DISABLED =
  'Page scripts are disabled. They run in the browser page (never in Node), but because they execute code from journey files they are opt-in: ' +
  'set "security: { allowPageScripts: true }" in eztest.config.yaml (or RunOptions.allowPageScripts = true) to enable "Run script" and "Run JavaScript" steps.';

/**
 * Wrap a script body as an in-page async function. Node never evaluates it:
 * the text is handed to the browser driver, which runs it in the browser page.
 */
function wrapPage(body: string): (args: Record<string, unknown>) => unknown {
  return pageFunction<Record<string, unknown>, unknown>(`async (args) => {\n${body}\n}`);
}
function wrapElement(body: string): (el: Element, args: Record<string, unknown>) => unknown {
  return pageFunction<Record<string, unknown>, unknown>(`async (element, args) => {\n${body}\n}`) as unknown as (el: Element, args: Record<string, unknown>) => unknown;
}

export async function scriptAction(step: Step, loc: Locator | undefined, ctx: StepContext, opts: RunOptions, timeout: number): Promise<ActionOutcome> {
  if (!opts.allowPageScripts) throw new EzTestError(PAGE_SCRIPTS_DISABLED, 'PAGE_SCRIPTS_DISABLED');
  const a = step.args ?? {};
  let body: string;
  if (typeof a.file === 'string') {
    const path = resolve(opts.baseDir ?? process.cwd(), ctx.interpolate(a.file));
    body = await readFile(path, 'utf8');
  } else if (step.value !== undefined) body = step.value;
  else throw new EzTestError('script step needs a file or inline code', 'MISSING_VALUE');
  // An inline one-liner without "return" is an expression: return its value.
  if (typeof a.file !== 'string' && !/\breturn\b|;|\n/.test(body.trim())) body = `return (${body});`;
  const params = Object.fromEntries(Object.entries((a.params ?? {}) as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? ctx.interpolate(v) : v]));
  const page = ctx.page;
  const result = loc
    ? await loc.evaluate(wrapElement(body), params, { timeout })
    : await page.evaluate(wrapPage(body), params);
  const mask = ctx.session?.mask ?? ((s: string) => s);
  const ref = await ctx.evidence.store('data', `scripts/${safeName(ctx.journey.id)}/${safeName(step.id)}.json`,
    mask(JSON.stringify({ file: a.file ?? null, inline: a.file ? null : body, params, result: result ?? null }, null, 2)),
    { journeyId: ctx.journey.id, stepId: step.id, description: 'page script and result' });

  if (step.captureAs) {
    const v = maskDeep(result ?? null, mask);
    ctx.ledger.set(step.captureAs, v);
    return { captured: { [step.captureAs]: v }, evidence: [ref.id] };
  }
  return { evidence: [ref.id] };
}
