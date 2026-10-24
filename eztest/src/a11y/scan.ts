/**
 * Node side of EZTest's accessibility engine: selects rules, installs the
 * in-page engine through EZTest's driver, runs it in one evaluation per
 * document (same-origin frames and shadow trees are covered by their
 * parent's run; cross-origin frames come from the driver's frame list),
 * runs the dynamic checks (keyboard walk, reflow) when asked, and turns the
 * raw outcomes into findings with WCAG metadata.
 */
import type { Frame, Page } from '../browser/index.js';
import { EzTestError } from '../core/index.js';
import { A11Y_GLOBAL, a11ySource } from './bundle.js';
import { IMPACT_ORDER, RULES, RULES_BY_ID, ruleLevel, ruleTags, ruleUrl, type A11yImpact, type DynamicKind, type RuleMeta } from './catalogue.js';
import type { FocusStop, PageNode, PageRuleResult, PageRunOptions, PageRunResult, ReflowResult } from './protocol.js';
import type { A11yFinding, A11yNode, A11yScanOptions, A11yScanResult } from './types.js';
import { levelAtMost } from './wcag.js';

const G = `globalThis.${A11Y_GLOBAL}`;
let engineVersion: string | undefined;

function version(): string {
  if (!engineVersion) {
    const m = /eztest-a11y\/[\d.]+/.exec(a11ySource());
    engineVersion = m ? m[0] : 'eztest-a11y';
  }
  return engineVersion;
}

/** Install the engine in a frame's main world (once per document). */
async function install(frame: Frame): Promise<void> {
  const v = version();
  const present = await frame.evaluate(`(() => { const e = ${G}; return !!e && e.version === ${JSON.stringify(v)}; })()`);
  if (present) return;
  await frame.evaluate(`(() => { ${G} = ${a11ySource()}; return true; })()`);
}

const MISSING = '__eztestA11yMissing';

/** Call the engine; installs it first when the document does not have it (one round trip when it does). */
async function call<T>(frame: Frame, expr: string, installed = false): Promise<T> {
  if (installed) return (await frame.evaluate(`(() => ${G}.${expr})()`)) as T;
  const r = await frame.evaluate(`(() => { const e = ${G}; if (!e || e.version !== ${JSON.stringify(version())}) return '${MISSING}'; return e.${expr}; })()`);
  if (r !== MISSING) return r as T;
  await install(frame);
  return (await frame.evaluate(`(() => ${G}.${expr})()`)) as T;
}

/** A frame whose parent is same-origin: the parent's run already covered it (checked before installing anything). */
const COVERED = '(() => { try { return window.top !== window && window.frameElement !== null; } catch (e) { return false; } })()';

/** Which rules a set of options selects. */
export function selectRules(opts: A11yScanOptions = {}): RuleMeta[] {
  if (opts.minImpact && !IMPACT_ORDER.includes(opts.minImpact)) throw new EzTestError(`Unknown impact ${opts.minImpact}`, 'INVALID_INPUT');
  if (opts.tags && opts.tags.length === 0) throw new EzTestError('tags must not be empty when given', 'INVALID_INPUT');
  if (opts.level && !['A', 'AA', 'AAA'].includes(opts.level)) throw new EzTestError(`Unknown WCAG level ${opts.level}`, 'INVALID_INPUT');
  for (const id of [...(opts.rules ?? []), ...(opts.disableRules ?? [])]) {
    if (!RULES_BY_ID.has(id)) throw new EzTestError(`Unknown accessibility rule "${id}"`, 'INVALID_INPUT');
  }
  const dyn = dynamicKinds(opts);
  let list = RULES.filter((r) => !r.dynamic || dyn.has(r.dynamic));
  if (opts.rules?.length) list = list.filter((r) => opts.rules!.includes(r.id));
  else if (opts.tags) {
    const want = new Set(opts.tags.map((t) => t.toLowerCase()));
    list = list.filter((r) => ruleTags(r).some((t) => want.has(t)) || (r.dynamic && want.has('dynamic')));
  } else {
    const max = opts.level ?? 'AA';
    list = list.filter((r) => {
      const lvl = ruleLevel(r);
      return lvl ? levelAtMost(lvl, max) : opts.bestPractice !== false;
    });
  }
  if (opts.disableRules?.length) list = list.filter((r) => !opts.disableRules!.includes(r.id));
  return list;
}

function dynamicKinds(opts: A11yScanOptions): Set<DynamicKind> {
  const d = opts.dynamic;
  if (!d) return new Set();
  if (d === true) return new Set(['keyboard', 'reflow', 'textSpacing']);
  const s = new Set<DynamicKind>();
  if (d.keyboard) s.add('keyboard');
  if (d.reflow) s.add('reflow');
  if (d.textSpacing) s.add('textSpacing');
  return s;
}

type Merged = Record<string, PageRuleResult>;

function bucket(m: Merged, id: string): PageRuleResult {
  return (m[id] ??= { fail: [], review: [], failCount: 0, reviewCount: 0, pass: 0 });
}

function shift(nodes: PageNode[], prefix: string[], dx: number, dy: number): PageNode[] {
  return nodes.map((n) => ({ ...n, target: [...prefix, ...n.target], box: n.box ? { ...n.box, x: n.box.x + dx, y: n.box.y + dy } : undefined }));
}

function mergeInto(m: Merged, res: PageRunResult, prefix: string[], dx: number, dy: number, maxNodes: number): void {
  for (const [id, r] of Object.entries(res.rules)) {
    const b = bucket(m, id);
    b.fail.push(...shift(r.fail, prefix, dx, dy).slice(0, Math.max(0, maxNodes - b.fail.length)));
    b.review.push(...shift(r.review, prefix, dx, dy).slice(0, Math.max(0, maxNodes - b.review.length)));
    b.failCount += r.failCount;
    b.reviewCount += r.reviewCount;
    b.pass += r.pass;
  }
}

/** Selector path of a frame's owner elements, from the top document. */
async function framePrefix(frame: Frame, main: Frame, memo: Map<Frame, string[]>): Promise<string[]> {
  if (frame === main) return [];
  const cached = memo.get(frame);
  if (cached) return cached;
  const parent = frame.parentFrame();
  if (!parent) return [];
  const up = await framePrefix(parent, main, memo);
  const owner = await frame.frameElement();
  try {
    await install(parent);
    const sel = (await owner.evaluate(`(el) => ${G}.localSelector(el)`)) as string;
    const out = [...up, sel];
    memo.set(frame, out);
    return out;
  } finally {
    await owner.dispose().catch(() => undefined);
  }
}

/**
 * include / exclude for a frame the page cannot see into: decided by the
 * <iframe> of the top document that (eventually) holds it.
 */
async function frameInScope(f: Frame, main: Frame, opts: A11yScanOptions): Promise<boolean> {
  let top = f;
  while (top.parentFrame() && top.parentFrame() !== main) top = top.parentFrame()!;
  const owner = await top.frameElement();
  try {
    return (await owner.evaluate(
      `(el, o) => { const m = (s) => { try { return !!el.closest(s); } catch (e) { return false; } };
        if (o.exclude.some(m)) return false; return !o.include.length || o.include.some(m); }`,
      { include: opts.include ?? [], exclude: opts.exclude ?? [] },
    )) as boolean;
  } finally {
    await owner.dispose().catch(() => undefined);
  }
}

/** Run the accessibility rules against the page (and its frames). */
export async function scanAccessibility(page: Page, opts: A11yScanOptions = {}): Promise<A11yScanResult> {
  const started = Date.now();
  const selected = selectRules(opts);
  if (!selected.length) throw new EzTestError('No accessibility rules match the given options', 'INVALID_INPUT');
  const ids = selected.map((r) => r.id);
  const maxNodes = opts.maxNodes ?? 100;
  const dyn = dynamicKinds(opts);
  const pageOpts: PageRunOptions = {
    rules: ids.filter((id) => !RULES_BY_ID.get(id)!.dynamic || RULES_BY_ID.get(id)!.dynamic === 'textSpacing'),
    include: opts.include,
    exclude: opts.exclude,
    textSpacing: dyn.has('textSpacing'),
    maxNodes,
  };
  const main = page.mainFrame();
  const top = await call<PageRunResult>(main, `run(${JSON.stringify(pageOpts)})`);
  const merged: Merged = {};
  const sx = top.scroll.x;
  const sy = top.scroll.y;
  mergeInto(merged, top, [], sx, sy, maxNodes);

  // Frames the main document could not reach (cross-origin, sandboxed): through the driver.
  const frames = { scanned: 0, skipped: [] as string[] };
  const prefixes = new Map<Frame, string[]>();
  for (const f of page.frames()) {
    if (f === main || f.isDetached()) continue;
    try {
      if (await f.evaluate(COVERED)) continue;
      const res = await call<PageRunResult>(f, `run(${JSON.stringify({ ...pageOpts, include: undefined, exclude: undefined })})`);
      if (res.coveredByParent) continue;
      if ((opts.include?.length || opts.exclude?.length) && !(await frameInScope(f, main, opts))) continue;
      const prefix = await framePrefix(f, main, prefixes);
      const off = await f.viewportOffset().catch(() => ({ x: 0, y: 0 }));
      mergeInto(merged, res, prefix, off.x + sx, off.y + sy, maxNodes);
      frames.scanned++;
    } catch (e) {
      frames.skipped.push(`${f.url() || f.name() || 'frame'}: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  const html = { target: ['html'], html: '<html>' };
  if (dyn.has('keyboard') && ids.some((id) => RULES_BY_ID.get(id)!.dynamic === 'keyboard')) {
    try {
      await keyboardWalk(page, merged, opts, maxNodes);
    } catch (e) {
      add(merged, 'keyboard.trap', 'review', { ...html, message: `The keyboard walk could not complete: ${(e as Error).message.split('\n')[0]}` }, maxNodes);
    }
  }
  if (dyn.has('reflow') && ids.includes('layout.reflow')) {
    try {
      await reflowCheck(page, merged, maxNodes);
    } catch (e) {
      add(merged, 'layout.reflow', 'review', { ...html, message: `The reflow check could not complete: ${(e as Error).message.split('\n')[0]}` }, maxNodes);
    }
  }

  return buildResult(top, merged, selected, opts, frames, Date.now() - started);
}

function buildResult(top: PageRunResult, merged: Merged, selected: RuleMeta[], opts: A11yScanOptions, frames: A11yScanResult['frames'], ms: number): A11yScanResult {
  const min = opts.minImpact ? IMPACT_ORDER.indexOf(opts.minImpact) : 0;
  const violations: A11yFinding[] = [];
  const needsReview: A11yFinding[] = [];
  let passes = 0;
  let inapplicable = 0;
  const totals = { violations: 0, needsReview: 0, passes: 0 };
  for (const meta of selected) {
    const r = merged[meta.id];
    if (!r || (!r.failCount && !r.reviewCount && !r.pass)) {
      inapplicable++;
      continue;
    }
    totals.passes += r.pass;
    const keep = IMPACT_ORDER.indexOf(meta.impact) >= min;
    const finding = (outcome: A11yFinding['outcome'], nodes: PageNode[], count: number): A11yFinding => ({
      ruleId: meta.id, outcome, impact: meta.impact, description: meta.description, help: meta.help, helpUrl: ruleUrl(meta), sc: meta.sc, tags: ruleTags(meta),
      nodes: nodes.map(toNode), nodeCount: count,
    });
    if (r.failCount) {
      totals.violations += r.failCount;
      if (keep) violations.push(finding('violation', r.fail, r.failCount));
    } else passes++;
    if (r.reviewCount) {
      totals.needsReview += r.reviewCount;
      if (keep) needsReview.push(finding('needs-review', r.review, r.reviewCount));
    }
  }
  const order = (a: A11yFinding, b: A11yFinding) => IMPACT_ORDER.indexOf(b.impact ?? 'minor') - IMPACT_ORDER.indexOf(a.impact ?? 'minor') || a.ruleId.localeCompare(b.ruleId);
  violations.sort(order);
  needsReview.sort(order);
  const counts: Record<A11yImpact, number> = { minor: 0, moderate: 0, serious: 0, critical: 0 };
  for (const v of violations) if (v.impact) counts[v.impact]++;
  return {
    url: top.url, engine: top.engine, violations, needsReview, incomplete: needsReview.length, passes, inapplicable, counts, totals,
    rules: selected.map((r) => r.id), frames, durationMs: ms, page: { width: top.size.width, height: top.size.height, dpr: top.dpr },
  };
}

function toNode(n: PageNode): A11yNode {
  const out: A11yNode = { target: n.target, html: n.html, failureSummary: n.message };
  if (n.box) out.box = { x: r1(n.box.x), y: r1(n.box.y), width: r1(n.box.width), height: r1(n.box.height) };
  return out;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function nodeOf(s: FocusStop, message: string): PageNode {
  return { target: s.target, html: s.html, message, box: s.box };
}

function add(m: Merged, id: string, outcome: 'fail' | 'review' | 'pass', node: PageNode | null, maxNodes: number): void {
  const b = bucket(m, id);
  if (outcome === 'pass') {
    b.pass++;
    return;
  }
  const list = outcome === 'fail' ? b.fail : b.review;
  if (node && list.some((x) => x.target.join('|') === node.target.join('|'))) return;
  if (outcome === 'fail') b.failCount++;
  else b.reviewCount++;
  if (node && list.length < maxNodes) list.push(node);
}

/**
 * Tab through the page with the driver's keyboard. Detects focus that never
 * leaves a component (2.1.2), stops without a visible indicator (2.4.7),
 * invisible stops, stops covered by other content (2.4.11) and moves that go
 * backwards on the page (2.4.3, for review).
 */
async function keyboardWalk(page: Page, m: Merged, opts: A11yScanOptions, maxNodes: number): Promise<void> {
  const main = page.mainFrame();
  // Focus styles (:focus, :focus-visible) only apply while the document has focus.
  await page.bringToFront().catch(() => undefined);
  await focusDocument(page, main);
  const prep = await call<{ tabbables: number }>(main, 'kbPrepare()');
  for (const id of ['keyboard.trap', 'focus.visible', 'focus.hidden-stop', 'focus.order', 'focus.not-obscured']) bucket(m, id);
  try {
    if (prep.tabbables === 0) return;
    let limit = Math.max(3, Math.min(prep.tabbables + 3, opts.maxTabStops ?? 80));
    const stops: FocusStop[] = [];
    const seen = new Map<number, number>();
    let cycleStart = -1;
    let inside = 0;
    for (let i = 0; i < limit; i++) {
      await page.keyboard.press('Tab');
      const s = await call<FocusStop>(main, 'kbProbe()', true);
      if (s.key === 0) {
        if (i > 0) break; // wrapped to the document: focus left every component
        continue;
      }
      if (seen.has(s.key)) {
        // Tab from the last stop moved focus to the browser UI and the document kept it (Firefox).
        if (s.last && stops[stops.length - 1]?.key === s.key) break;
        // The same element again right away: Tab moves between the parts of a composite native control
        // (the day, month and year of <input type=date>, the fields of time inputs). Not a cycle.
        if (stops[stops.length - 1]?.key === s.key && inside < 8) {
          inside++;
          limit++;
          continue;
        }
        cycleStart = seen.get(s.key)!;
        break;
      }
      inside = 0;
      seen.set(s.key, stops.length);
      stops.push(s);
      // The next Tab would leave the page for the browser UI (and Firefox does not hand focus back): stop here.
      if (s.last) break;
    }

    for (const s of stops) {
      if (s.inOpaqueFrame) continue;
      if (!s.visible) {
        add(m, 'focus.hidden-stop', 'fail', nodeOf(s, `Focus lands on ${s.label}, which is not visible.`), maxNodes);
        continue;
      }
      add(m, 'focus.hidden-stop', 'pass', null, maxNodes);
      if (s.indicator === false) add(m, 'focus.visible', 'fail', nodeOf(s, `${s.label} looks the same with and without keyboard focus.`), maxNodes);
      else if (s.indicator === true) add(m, 'focus.visible', 'pass', null, maxNodes);
      if (s.obscured) add(m, 'focus.not-obscured', 'fail', nodeOf(s, `${s.label} has focus but is entirely covered by other content.`), maxNodes);
      else add(m, 'focus.not-obscured', 'pass', null, maxNodes);
    }
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1];
      const b = stops[i];
      if (!a.box || !b.box || a.inOpaqueFrame || b.inOpaqueFrame || !a.visible || !b.visible) continue;
      const up = b.box.y + b.box.height <= a.box.y;
      const left = b.box.x + b.box.width <= a.box.x;
      if (up && left) add(m, 'focus.order', 'review', nodeOf(b, `Tab moves focus from ${a.label} back up and to the left to ${b.label}; check this follows the reading order.`), maxNodes);
      else add(m, 'focus.order', 'pass', null, maxNodes);
    }

    // A cycle that does not pass through the document and leaves tab stops unreachable is a trap.
    if (cycleStart >= 0) {
      const cycle = stops.slice(cycleStart);
      const keys = cycle.map((s) => s.key);
      const inModal = cycle.every((s) => s.inModal);
      const opaque = cycle.some((s) => s.inOpaqueFrame);
      const out = await call<{ container: string; outside: number }>(main, `kbOutside(${JSON.stringify(keys)})`);
      if (!inModal && !opaque && out.outside > 0 && cycle.length < prep.tabbables) {
        add(m, 'keyboard.trap', 'fail', nodeOf(cycle[0], `Tab cycles through ${cycle.length} element(s) inside ${out.container} (${cycle.slice(0, 4).map((s) => s.label).join(', ')}) and never reaches the ${out.outside} other tab stop(s) on the page.`), maxNodes);
      } else add(m, 'keyboard.trap', 'pass', null, maxNodes);
    } else if (stops.length) add(m, 'keyboard.trap', 'pass', null, maxNodes);
  } finally {
    // Tab past the last stop leaves focus in the browser UI (Firefox): bring it back before restoring.
    await focusDocument(page, main).catch(() => undefined);
    await call(main, 'kbFinish()').catch(() => undefined);
  }
}

/** When focus sits outside the document (browser UI), one Tab brings it back into the page. */
async function focusDocument(page: Page, main: Frame): Promise<void> {
  for (let i = 0; i < 2; i++) {
    if (await main.evaluate('document.hasFocus()')) return;
    await page.keyboard.press('Tab');
  }
}

/** Resize to 320 CSS px wide, measure horizontal overflow, restore. */
async function reflowCheck(page: Page, m: Merged, maxNodes: number): Promise<void> {
  const main = page.mainFrame();
  const original = page.viewportSize();
  bucket(m, 'layout.reflow');
  if (!original) {
    add(m, 'layout.reflow', 'review', { target: ['html'], html: '<html>', message: 'The viewport size is not fixed in this browser context, so reflow at 320px could not be checked.' }, maxNodes);
    return;
  }
  let res: ReflowResult;
  const scroll = (await main.evaluate('({ x: window.scrollX, y: window.scrollY })')) as { x: number; y: number };
  try {
    await page.setViewportSize({ width: 320, height: original.height });
    await main.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    res = await call<ReflowResult>(main, 'reflow()');
  } finally {
    await page.setViewportSize(original);
    await main.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))').catch(() => undefined);
    // Resizing moves the scroll position (scroll anchoring, clamping): put it back.
    await main.evaluate(`window.scrollTo(${scroll.x}, ${scroll.y})`).catch(() => undefined);
  }
  if (res.scrollWidth <= res.viewportWidth + 1) {
    add(m, 'layout.reflow', 'pass', null, maxNodes);
    return;
  }
  const real = res.offenders.filter((o) => !o.exempt);
  if (real.length) for (const o of real) add(m, 'layout.reflow', 'fail', { ...o, message: `${o.message} The page scrolls horizontally (${res.scrollWidth}px of content in ${res.viewportWidth}px).` }, maxNodes);
  else if (res.offenders.length) for (const o of res.offenders) add(m, 'layout.reflow', 'review', o, maxNodes);
  else add(m, 'layout.reflow', 'review', { target: ['html'], html: '<html>', message: `The page is ${res.scrollWidth}px wide at a ${res.viewportWidth}px viewport, but no single element could be blamed.` }, maxNodes);
}
