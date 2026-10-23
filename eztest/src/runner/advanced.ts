/**
 * Dispatcher for the advanced action types (tabs, frames, dialogs, input,
 * DOM queries, page scripts, network, browser state, waits, API extensions,
 * WebSockets, email/SMS, dataset comparison and variables). Block actions
 * (if, loops, try, groups, frame blocks, sub-journeys) are run by flow.ts and
 * never reach here.
 */
import type { Locator } from '../browser/index.js';
import { EzTestError, NotSupportedError, type Step } from '../core/index.js';
import type { ActionOutcome } from './actions.js';
import { browserAction } from './browser-state.js';
import { compareDataAction, dbAction, messageAction, setAction, wsAction } from './data-steps.js';
import { queryAction, SINGLE_ELEMENT_QUERIES } from './dom.js';
import { dispatchAction, dragAction, focusAction, keyboardAction, mouseAction, scrollAction, touchAction } from './input.js';
import { rootFor } from './locate.js';
import { networkAction } from './network.js';
import { resolveFrameSelector, type PageSelector } from './pages.js';
import { scriptAction } from './script.js';
import type { BrowserSession } from './session.js';
import type { RunOptions, StepContext } from './types.js';
import { waitAction } from './waits.js';
import { integrationAction } from '../integration/action.js';
import { componentAction } from './components/action.js';
import { voiceAction } from './voice-steps.js';

/** Whether an advanced step needs its target strictly resolved (and healable) before acting. */
export function advancedNeedsTarget(step: Step): boolean {
  if (!step.target) return false;
  const op = step.args?.op;
  switch (step.action) {
    case 'drag': case 'focus': case 'dispatch': case 'keyboard': case 'mouse': case 'script': return true;
    case 'component': return true;
    case 'touch': return true;
    case 'scroll': return op === 'element' || op === 'intoView';
    case 'query': return SINGLE_ELEMENT_QUERIES.has(String(step.args?.what ?? 'text'));
    default: return false;
  }
}

function needSession(ctx: StepContext): BrowserSession {
  if (!ctx.session) throw new EzTestError(`${ctx.step.action} steps need a browser session`, 'NO_SESSION');
  return ctx.session;
}

/** Parse a page selector from step args. */
export function pageSelectorOf(a: Record<string, unknown>, ctx: StepContext): PageSelector {
  const by = String(a.by ?? 'new');
  const v = a.value === undefined ? '' : ctx.interpolate(String(a.value));
  switch (by) {
    case 'new': case 'main': case 'previous': return { by };
    case 'index': return { by: 'index', index: Number(v) };
    case 'title': case 'url': case 'name': return { by, value: v };
    default: throw new NotSupportedError(`switch to tab by "${by}"`);
  }
}

async function tabAction(step: Step, ctx: StepContext, timeout: number): Promise<ActionOutcome> {
  const session = needSession(ctx);
  const reg = session.pages;
  const a = step.args ?? {};
  const op = String(a.op ?? 'switch');
  if (op === 'open') {
    const page = await session.context.newPage();
    const entry = reg.entries.find((e) => e.page === page) ?? (await reg.waitForNewPage(timeout));
    if (a.name) entry.name = ctx.interpolate(String(a.name));
    reg.activate(entry);
    if (step.value) {
      const { resolveUrl } = await import('./api.js');
      await page.goto(resolveUrl(ctx.interpolate(step.value), ctx.baseUrl), { timeout });
    }
    return {};
  }
  if (op === 'switch') {
    const entry = await reg.find(pageSelectorOf(a, ctx), timeout);
    if (a.name) entry.name = ctx.interpolate(String(a.name));
    reg.activate(entry);
    await entry.page.bringToFront().catch(() => undefined);
    return {};
  }
  if (op === 'close') {
    const entry = a.by ? await reg.find(pageSelectorOf(a, ctx), timeout) : reg.currentEntry;
    if (reg.open.length <= 1 && !a.force) throw new EzTestError('Refusing to close the last open tab (the journey would have no page left)', 'LAST_PAGE');
    await entry.page.close({ runBeforeUnload: a.beforeunload === true });
    for (let i = 0; i < 20 && reg.page.isClosed(); i++) await new Promise((r) => setTimeout(r, 25));
    return {};
  }
  throw new NotSupportedError(`tab op "${op}"`);
}

/** Enter, leave or reset the frame chain of the current page. */
export async function frameAction(step: Step, ctx: StepContext, timeout: number): Promise<ActionOutcome> {
  const session = needSession(ctx);
  const a = step.args ?? {};
  const op = String(a.op ?? 'enter');
  if (op === 'main') {
    session.pages.frames = [];
    return {};
  }
  if (op === 'parent') {
    session.pages.frames = session.pages.frames.slice(0, -1);
    return {};
  }
  if (op !== 'enter') throw new NotSupportedError(`frame op "${op}"`);
  const path = (Array.isArray(a.path) ? a.path : [step.value ?? '']).map((p) => ctx.interpolate(String(p)));
  const chain = [...session.pages.frames];
  for (const desc of path) {
    const sel = await resolveFrameSelector(rootFor(session.page, chain), desc, timeout);
    chain.push(sel);
  }
  session.pages.frames = chain;
  return {};
}

function dialogAction(step: Step, ctx: StepContext): ActionOutcome {
  const session = needSession(ctx);
  const a = step.args ?? {};
  const op = String(a.op ?? 'accept') as 'accept' | 'dismiss' | 'answer';
  const key = step.captureAs;
  session.dialogs.arm({
    op,
    ...(op === 'answer' ? { answer: ctx.interpolate(step.value ?? '') } : {}),
    ...(a.kind ? { kind: a.kind as 'alert' } : {}),
    ...(key ? { onHandled: (rec) => ctx.ledger.set(key, rec.message) } : {}),
  });
  return {};
}

/** Perform an advanced action. */
export async function performAdvancedAction(step: Step, loc: Locator | undefined, ctx: StepContext, opts: RunOptions, timeout: number): Promise<ActionOutcome> {
  switch (step.action) {
    case 'tab': return tabAction(step, ctx, timeout);
    case 'frame': return frameAction(step, ctx, timeout);
    case 'dialog': return dialogAction(step, ctx);
    case 'keyboard': await keyboardAction(step, loc, ctx, timeout); return {};
    case 'mouse': await mouseAction(step, loc, ctx, timeout); return {};
    case 'drag': {
      if (!loc) throw new EzTestError(`Step "${step.intent}" needs a target`, 'MISSING_TARGET');
      await dragAction(step, loc, ctx, timeout);
      return {};
    }
    case 'scroll': {
      const r = await scrollAction(step, loc, ctx, timeout);
      if (r && step.captureAs) {
        ctx.ledger.set(step.captureAs, r);
        return { captured: { [step.captureAs]: r } };
      }
      return {};
    }
    case 'focus': {
      if (!loc) throw new EzTestError(`Step "${step.intent}" needs a target`, 'MISSING_TARGET');
      await focusAction(step, loc, timeout);
      return {};
    }
    case 'touch': await touchAction(step, loc, ctx, timeout); return {};
    case 'dispatch': await dispatchAction(step, loc, ctx, timeout); return {};
    case 'query': return { captured: await queryAction(step, loc, ctx, timeout) };
    case 'script': return scriptAction(step, loc, ctx, opts, timeout);
    case 'network': return networkAction(step, ctx, opts);
    case 'browser': return browserAction(step, ctx);
    case 'email': case 'sms': return messageAction(step, ctx, opts, timeout);
    case 'voice': return voiceAction(step, ctx, opts);
    case 'ws': return wsAction(step, ctx, timeout);
    case 'compareData': return compareDataAction(step, ctx, opts);
    case 'set': return setAction(step, ctx);
    case 'integration': return integrationAction(step, ctx, opts, timeout);
    case 'component': return componentAction(step, loc, ctx, opts, timeout);
    case 'if': case 'repeat': case 'forEach': case 'while': case 'retry': case 'try': case 'group': case 'runJourney':
      throw new EzTestError(`"${step.action}" is a block step and is run by the flow engine; it has no ${step.action === 'runJourney' ? 'journey' : 'children'} here`, 'BAD_BLOCK');
    default:
      throw new NotSupportedError(`action "${step.action}"`);
  }
}

/** Advanced waits (wait steps with args.for), and DB steps with bound parameters. */
export { waitAction, dbAction };
