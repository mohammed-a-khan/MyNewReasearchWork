/**
 * Entry point of EZTest's in-page accessibility engine. The bundle (see
 * ../bundle.ts) evaluates to the object `createA11yEngine()` returns; the
 * driver installs it once per document and calls `run` in a single
 * evaluation.
 */
import { withCaches } from '../../browser/injected/page/dom.js';
import { withRoleCache } from '../../browser/injected/page/roles.js';
import type { FocusStop, PageRunOptions, PageRunResult, ReflowResult } from '../protocol.js';
import { Ctx, localSelector } from './context.js';
import { checkTextSpacing, kbFinish, kbOutside, kbPrepare, kbProbe, measureReflow } from './dynamic.js';
import { ARIA_RULES } from './rules-aria.js';
import { CONTRAST_RULES } from './rules-contrast.js';
import { MISC_RULES } from './rules-misc.js';
import { NAME_RULES, type RuleFn } from './rules-names.js';
import { STRUCTURE_RULES } from './rules-structure.js';
import { resetOwnerMemo } from './util.js';

export const A11Y_ENGINE_VERSION = 'eztest-a11y/1.0.0';

const ALL: Record<string, RuleFn> = { ...NAME_RULES, ...ARIA_RULES, ...CONTRAST_RULES, ...STRUCTURE_RULES, ...MISC_RULES };

export interface A11yEngine {
  version: string;
  ruleIds: string[];
  run(opts: PageRunOptions): PageRunResult;
  reflow(): ReflowResult;
  kbPrepare(): { tabbables: number };
  kbProbe(): FocusStop;
  kbOutside(keys: number[]): { container: string; outside: number };
  kbFinish(): void;
  localSelector(el: Element): string;
}

function coveredByParent(): boolean {
  try {
    return window.top !== window && window.frameElement !== null;
  } catch {
    return false;
  }
}

export function createA11yEngine(): A11yEngine {
  return {
    version: A11Y_ENGINE_VERSION,
    ruleIds: Object.keys(ALL),
    run(opts) {
      const started = performance.now();
      const doc = document;
      const base = {
        engine: A11Y_ENGINE_VERSION,
        url: location.href,
        scroll: { x: window.scrollX, y: window.scrollY },
        size: { width: Math.max(doc.documentElement.scrollWidth, doc.documentElement.clientWidth), height: Math.max(doc.documentElement.scrollHeight, doc.documentElement.clientHeight) },
        dpr: window.devicePixelRatio || 1,
      };
      if (coveredByParent()) return { ...base, coveredByParent: true, rules: {}, elements: 0, ms: 0 };
      let ctx!: Ctx;
      const timings: Record<string, number> = {};
      withCaches(() =>
        withRoleCache(() => {
          const t0 = performance.now();
          ctx = new Ctx(doc, opts);
          ctx.all();
          timings['(collect)'] = Math.round(performance.now() - t0);
          for (const d of ctx.docs) resetOwnerMemo(d.doc);
          for (const id of opts.rules) {
            const fn = ALL[id];
            if (!fn) continue;
            ctx.current = id;
            ctx.touch(id);
            const t = performance.now();
            try {
              fn(ctx);
              timings[id] = Math.round(performance.now() - t);
            } catch (e) {
              ctx.review(doc.documentElement, `The check could not complete: ${(e as Error).message}`);
            }
          }
        }),
      );
      if (opts.textSpacing && opts.rules.includes('text.spacing')) {
        ctx.touch('text.spacing');
        try {
          withRoleCache(() => checkTextSpacing(ctx));
        } catch (e) {
          ctx.current = 'text.spacing';
          ctx.review(doc.documentElement, `The text-spacing check could not complete: ${(e as Error).message}`);
        }
      }
      return { ...base, coveredByParent: false, rules: ctx.results, elements: ctx.all().length, ms: Math.round(performance.now() - started), timings };
    },
    reflow() {
      return withCaches(() => withRoleCache(() => measureReflow(new Ctx(document, {}))));
    },
    kbPrepare: () => kbPrepare(document),
    kbProbe: () => kbProbe(document),
    kbOutside: (keys) => kbOutside(keys),
    kbFinish: () => kbFinish(document),
    localSelector: (el) => localSelector(el),
  };
}
