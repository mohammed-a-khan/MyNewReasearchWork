/**
 * Visual assertions on a page or one element:
 *
 *   Expect the Header to look like the baseline
 *   Expect the Invoice panel to look like baseline "invoice-panel" in layout mode
 *   Expect the page to look like the baseline ignoring colors masking "testid=clock" at viewports 1280x720 and 375x667
 *
 * Comparison modes: strict (pixels, anti-alias tolerant), ignore-colors
 * (edges), layout (element boxes) and content (text + edges). Baselines are
 * keyed by browser and viewport (optionally browser version and platform)
 * and branched per git branch. Failures carry the pixel differences grouped
 * by the DOM change behind them; the Studio visual page approves them.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { Locator, Page } from '../browser/index.js';
import { EzTestError, slugify, type Step } from '../core/index.js';
import type { CustomStepHandler, StepContext } from '../runner/types.js';
import { resolveTarget, rootFor } from '../runner/locate.js';
import { masksFor, type Box, type VisualResult } from './visual.js';
import { compareImagesByMode, diffRegions, VISUAL_MODES, type VisualMode } from './visual-modes.js';
import { captureDomSnapshot, contentChanges, diffSnapshots, groupChanges, layoutChanges, type ChangeGroup, type DomSnapshot, type ElementChange } from './visual-dom.js';
import { baselineContext, baselineKey, findBaseline, type BaselineKeyPart } from './visual-baselines.js';

export interface VisualAssertOptions {
  /** Baseline name (before browser/viewport keys are added). */
  name: string;
  /** Root of the baselines (`.eztest/baselines`). */
  baselineDir: string;
  /** Actual/diff output. Default `<baselineDir>/../visual-output`. */
  outputDir?: string;
  /** Compare one element instead of the page. */
  target?: Locator;
  fullPage?: boolean;
  mode?: VisualMode;
  threshold?: number;
  antiAlias?: 'tolerate' | 'strict';
  maxDiffPixels?: number;
  maxDiffRatio?: number;
  /** Layout/content modes: allowed box movement in CSS px. Default 2. */
  layoutTolerance?: number;
  /** Selectors of dynamic content to mask (clocks, ads, ids). `testid=x` is accepted. */
  mask?: string[];
  /** Baseline key parts. Default browser + viewport. */
  keyBy?: BaselineKeyPart[];
  /** Compare at each viewport in turn (the original viewport is restored). */
  viewports?: Array<{ width: number; height: number }>;
  /** Git branch whose baselines shadow the main set (undefined: main set). */
  branch?: string;
  /** Write the current screenshot as the baseline. */
  update?: boolean;
}

export interface VisualAssertResult extends VisualResult {
  mode: VisualMode;
  /** The keyed baseline name (`header--chromium--1280x720`). */
  key: string;
  viewport?: { width: number; height: number };
  browser: string;
  /** The baseline set used or written: a branch name, or undefined for main. */
  branch?: string;
  /** A version-keyed baseline was missing and the same browser's other version was used. */
  fallbackFrom?: string;
  /** Pixel differences grouped by the DOM change behind them (failures only). */
  groups: ChangeGroup[];
  /** DOM changes found (after masking), before grouping. */
  domChanges: number;
  message: string;
}

const COLOR_STYLES = new Set(['color', 'background-color', 'border-top-color', 'box-shadow', 'opacity']);

function selectorFor(s: string): string {
  const m = /^(testid|test-id|data-testid)=(.+)$/i.exec(s.trim());
  return m ? `[data-testid="${m[2].replace(/"/g, '\\"')}"]` : s;
}

const within = (inner: Box, outer: Box) => {
  const w = Math.min(inner.x + inner.width, outer.x + outer.width) - Math.max(inner.x, outer.x);
  const h = Math.min(inner.y + inner.height, outer.y + outer.height) - Math.max(inner.y, outer.y);
  return w > 0 && h > 0 && w * h >= 0.5 * Math.max(1, inner.width * inner.height);
};

function relevant(mode: VisualMode, changes: ElementChange[]): ElementChange[] {
  if (mode === 'layout') return layoutChanges(changes);
  if (mode === 'content') return contentChanges(changes);
  if (mode === 'ignore-colors') return changes.filter((c) => !(c.kind === 'style' && COLOR_STYLES.has(c.property ?? '')));
  return changes;
}

async function readDom(path: string): Promise<DomSnapshot | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as DomSnapshot;
  } catch {
    return undefined;
  }
}

const domPath = (png: string) => png.replace(/\.png$/, '.dom.json');

async function compareOnce(page: Page, o: VisualAssertOptions, mode: VisualMode): Promise<VisualAssertResult> {
  const ctx = baselineContext(page);
  const base = /^[A-Za-z0-9._-]+$/.test(o.name) && !o.name.startsWith('.') ? o.name : slugify(o.name);
  const key = `${base}${baselineKey(ctx, o.keyBy ?? ['browser', 'viewport'])}`;
  const outDir = o.outputDir ?? join(o.baselineDir, '..', 'visual-output');
  await mkdir(outDir, { recursive: true });
  const origin: DomSnapshot['origin'] = o.target ? 'element' : o.fullPage ? 'page' : 'viewport';
  const maskLocators = (o.mask ?? []).map((s) => page.locator(selectorFor(s)));
  for (const [i, l] of maskLocators.entries()) {
    if ((await l.count()) === 0) throw new EzTestError(`mask selector matched nothing: ${o.mask![i]}`, 'MASK_NOT_FOUND');
  }
  const shotOpts = { animations: 'disabled' as const, caret: 'hide' as const };
  const shot = o.target ? await o.target.screenshot(shotOpts) : await page.screenshot({ ...shotOpts, fullPage: o.fullPage ?? false });
  const dom = await captureDomSnapshot(o.target ?? page, origin);
  // Mask boxes in the snapshot's coordinates (changes inside them are ignored too).
  const rootBox = o.target ? await o.target.boundingBox() : undefined;
  const scroll = origin === 'page' ? ((await page.evaluate('[window.scrollX, window.scrollY]')) as [number, number]) : [0, 0];
  const maskCss: Box[] = [];
  for (const l of maskLocators) {
    for (const el of await l.all()) {
      const b = await el.boundingBox();
      if (b) maskCss.push({ x: b.x - (rootBox?.x ?? -scroll[0]), y: b.y - (rootBox?.y ?? -scroll[1]), width: b.width, height: b.height });
    }
  }
  const png = PNG.sync.read(shot);
  const dpr = dom.devicePixelRatio || 1;
  // Masked regions are painted in both images: this screenshot's boxes plus the baseline's (a masked element may change size).
  dom.masks = maskCss.map((b) => ({ x: b.x * dpr, y: b.y * dpr, width: b.width * dpr, height: b.height * dpr }));
  const found = findBaseline(o.baselineDir, key, { branch: o.branch, ctx });
  const common = { name: key, key, mode, viewport: ctx.viewport, browser: ctx.browser, branch: o.branch, width: png.width, height: png.height, groups: [] as ChangeGroup[], domChanges: 0 };
  const saved = (await masksFor(o.baselineDir, base)).map(({ x, y, width, height }) => ({ x, y, width, height }));
  if (o.update) {
    await mkdir(join(found.writePath, '..'), { recursive: true });
    await writeFile(found.writePath, shot);
    await writeFile(domPath(found.writePath), JSON.stringify(dom));
    return { ...common, status: 'baseline-updated', passed: true, diffPixels: 0, diffRatio: 0, baselinePath: found.writePath, maskedBoxes: saved, message: `baseline ${key} written` };
  }
  const actualPath = join(outDir, `${key}.actual.png`);
  const writeActual = async () => {
    await writeFile(actualPath, shot);
    await writeFile(domPath(actualPath).replace(/\.actual\.dom\.json$/, '.actual.dom.json'), JSON.stringify(dom));
  };
  if (!found.path) {
    await writeActual();
    return { ...common, status: 'missing-baseline', passed: false, diffPixels: 0, diffRatio: 1, baselinePath: found.writePath, actualPath, maskedBoxes: saved, message: `no baseline ${key} yet: approve the actual screenshot (Studio > Assurance > Visual) or run with --update-baselines` };
  }
  const baselineDom = await readDom(domPath(found.path));
  if ((mode === 'layout' || mode === 'content') && !baselineDom) {
    await writeActual();
    return { ...common, status: 'mismatch', passed: false, diffPixels: 0, diffRatio: 0, baselinePath: found.path, actualPath, maskedBoxes: saved, fallbackFrom: found.fallbackFrom, message: `baseline ${key} has no DOM snapshot (needed for ${mode} mode): re-approve it` };
  }
  const imageMode = mode === 'strict' ? 'strict' : 'ignore-colors';
  const maskBoxes = [...saved, ...(dom.masks ?? []), ...(o.mask?.length ? baselineDom?.masks ?? [] : [])];
  const cmp = compareImagesByMode(shot, await readFile(found.path), { mode: imageMode, threshold: o.threshold, antiAlias: o.antiAlias, maxDiffPixels: o.maxDiffPixels, maxDiffRatio: o.maxDiffRatio, maskBoxes });
  const changes = baselineDom ? diffSnapshots(baselineDom, dom, mode === 'layout' || mode === 'content' ? o.layoutTolerance ?? 2 : 1).filter((c) => ![...maskCss, ...(o.mask?.length ? baselineDom.masks ?? [] : []).map((b) => ({ x: b.x / dpr, y: b.y / dpr, width: b.width / dpr, height: b.height / dpr }))].some((m) => within(c.after ?? c.before!, m))) : [];
  const rel = relevant(mode, changes);
  let passed: boolean;
  if (mode === 'layout') passed = rel.length === 0;
  else if (mode === 'content') passed = rel.length === 0 && cmp.passed;
  else passed = cmp.passed;
  let diffPath: string | undefined;
  let groups: ChangeGroup[] = [];
  if (!passed) {
    await writeActual();
    if (cmp.diffPng) {
      diffPath = join(outDir, `${key}.diff.png`);
      await writeFile(diffPath, cmp.diffPng);
    }
    const regions = mode === 'layout' || !cmp.mask ? [] : diffRegions(cmp.mask, cmp.width, cmp.height);
    groups = groupChanges(rel, regions, dom, dpr);
  }
  const what = groups.length ? groups.slice(0, 5).map((g) => g.summary).join('; ') : `${cmp.diffPixels} px differ (${(cmp.diffRatio * 100).toFixed(2)}%)`;
  const fb = found.fallbackFrom ? ` [baseline from ${found.fallbackFrom}: a browser update; re-approve to key ${key}]` : '';
  return {
    ...common, status: passed ? 'match' : cmp.status === 'size-mismatch' && mode !== 'layout' ? 'size-mismatch' : 'mismatch', passed,
    diffPixels: cmp.diffPixels, diffRatio: cmp.diffRatio, baselineSize: cmp.baselineSize, baselinePath: found.path, actualPath: passed ? undefined : actualPath, diffPath,
    maskedBoxes: maskBoxes, fallbackFrom: found.fallbackFrom, branch: found.source === 'branch' ? o.branch : undefined, groups, domChanges: rel.length,
    message: passed ? `matches ${key} (${mode})${fb}` : `${key} (${mode}) differs: ${what}${fb}`,
  };
}

/** Compare the page or an element with its baseline(s); one result per viewport. */
export async function compareVisual(page: Page, o: VisualAssertOptions): Promise<VisualAssertResult[]> {
  const mode = o.mode ?? 'strict';
  if (!VISUAL_MODES.includes(mode)) throw new EzTestError(`Unknown visual mode "${mode}" (use ${VISUAL_MODES.join(', ')})`, 'INVALID_INPUT');
  if (!o.viewports?.length) return [await compareOnce(page, o, mode)];
  const original = page.viewportSize();
  const out: VisualAssertResult[] = [];
  try {
    for (const vp of o.viewports) {
      await page.setViewportSize(vp);
      await page.evaluate('new Promise((r) => { const raf = globalThis.__eztestClock ? globalThis.__eztestClock.native.requestAnimationFrame : requestAnimationFrame; raf(() => raf(r)); })');
      out.push(await compareOnce(page, o, mode));
    }
  } finally {
    if (original) await page.setViewportSize(original);
  }
  return out;
}

// ------------------------------------------------------------------ the "Expect ... to look like the baseline" step

/** Name of the built-in custom step handler for visual assertions. */
export const VISUAL_STEP = 'eztest.visual';

export interface VisualStepOptions {
  baselineDir: string;
  outputDir?: string;
  /** Branch whose baselines shadow the main set. */
  branch?: string;
  /** Write baselines instead of comparing (checked per step). */
  update?: () => boolean;
  /** Default baseline key parts. */
  keyBy?: BaselineKeyPart[];
}

/** The custom step handler behind `Expect <element|the page> to look like the baseline`. */
export function createVisualStepHandler(o: VisualStepOptions): CustomStepHandler {
  return async (page: Page, step: Step, ctx: StepContext) => {
    const a = (step.args ?? {}) as Record<string, unknown>;
    let target: Locator | undefined;
    if (step.target) {
      const r = await resolveTarget(rootFor(page, [...(ctx.session?.frames ?? []), ...(step.target.frames ?? [])]), step.target, ctx.vars(), step.timeoutMs ?? 10_000);
      if (!r.locator) throw new EzTestError(`${step.target.description}: not found exactly once (${r.notes.join('; ')})`, 'TARGET_NOT_FOUND');
      target = r.locator;
      await target.scrollIntoViewIfNeeded().catch(() => undefined);
    }
    const name = typeof a.baseline === 'string' && a.baseline ? ctx.interpolate(a.baseline) : `${ctx.journey.id}-${step.id}`;
    const results = await compareVisual(page, {
      name, baselineDir: o.baselineDir, outputDir: o.outputDir, target, branch: o.branch, update: o.update?.() ?? false,
      mode: (a.mode as VisualMode | undefined) ?? 'strict', fullPage: a.fullPage === true,
      mask: Array.isArray(a.mask) ? (a.mask as unknown[]).map((m) => ctx.interpolate(String(m))) : undefined,
      viewports: Array.isArray(a.viewports) ? (a.viewports as Array<{ width: number; height: number }>) : undefined,
      keyBy: Array.isArray(a.keyBy) ? (a.keyBy as BaselineKeyPart[]) : o.keyBy,
      threshold: typeof a.threshold === 'number' ? a.threshold : undefined,
      maxDiffRatio: typeof a.maxDiffRatio === 'number' ? a.maxDiffRatio : undefined,
      maxDiffPixels: typeof a.maxDiffPixels === 'number' ? a.maxDiffPixels : undefined,
      antiAlias: a.antiAlias === 'strict' ? 'strict' : undefined,
      layoutTolerance: typeof a.tolerancePx === 'number' ? a.tolerancePx : undefined,
    });
    // Stored like lens findings so EZTest Studio's visual page lists them (and approves them).
    const findings = results.map((r) => ({ lens: 'visual', severity: r.passed ? 'info' : 'error', message: r.message, details: r }));
    await ctx.evidence.store('data', `visual/${slugify(ctx.journey.id)}/lens-visual-${slugify(step.id)}.json`, JSON.stringify(findings, null, 2), {
      journeyId: ctx.journey.id, stepId: step.id, description: `visual assertion ${name}`,
    });
    const failed = results.filter((r) => !r.passed);
    if (failed.length) throw new EzTestError(`Visual check failed: ${failed.map((r) => r.message).join(' | ')}`, 'VISUAL_MISMATCH', { results: failed.map((r) => ({ key: r.key, status: r.status, groups: r.groups.map((g) => g.summary) })) });
  };
}
