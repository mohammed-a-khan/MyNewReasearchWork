/**
 * Visual depth (real Chromium): element-level baselines, comparison modes
 * (strict, ignore-colors, layout, content, anti-alias tolerance), pixel
 * differences grouped by the DOM change behind them, browser/viewport keyed
 * baselines with version fallback, several viewports in one assertion,
 * masking by selector, and baseline branches merged into the main set.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { PNG } from 'pngjs';
import { verifyEvidence } from '../../src/core/index.js';
import {
  baselineKey, compareImagesByMode, compareVisual, currentBranch, diffRegions, diffSnapshots, findBaseline, groupChanges, listBaselineBranches, mergeBaselineBranch,
  type DomSnapshot,
} from '../../src/lenses/index.js';

/** The native suite on Firefox (EZTEST_BROWSER=firefox): tests that only make sense on Chromium skip, saying why. */
const onFirefox = process.env.EZTEST_BROWSER === 'firefox';
const chromiumOnly = (title: string, reason: string) => (onFirefox ? `${title} [skipped on Firefox: ${reason}]` : title);

interface Variant {
  button?: string;
  shift?: number;
  total?: string;
  clock?: string;
  rename?: boolean;
}

function html(v: Variant = {}): string {
  const btn = v.button ?? '#1f6feb';
  return `<!doctype html><html><head><style>
  body { margin: 0; font-family: sans-serif; background: #fff; }
  header { padding: 12px; background: #f6f8fa; border-bottom: 1px solid #d0d7de; }
  .btn { background: ${btn}; color: #fff; border: 0; padding: 8px 14px; margin-right: 8px; font-size: 14px; }
  #summary { margin: ${20 + (v.shift ?? 0)}px 12px 0; padding: 12px; border: 2px solid #57606a; width: 300px; }
  #summary p { margin: 4px 0; }
  #clock { margin: 12px; font-size: 18px; }
  </style></head><body>
  <header id="hdr"><button class="btn" id="save">Save</button><button class="${v.rename ? 'btn-x' : 'btn'}" id="cancel"${v.rename ? ` style="background:${btn};color:#fff;border:0;padding:8px 14px;margin-right:8px;font-size:14px"` : ''}>Cancel</button></header>
  <div id="summary"><p>Order ORD-7</p><p>Total <span id="total">${v.total ?? '10.00'}</span></p><p>Status Open</p></div>
  <p id="clock">${v.clock ?? '12:00:01'}</p>
  </body></html>`;
}

let browser: Browser;
let page: Page;
let dir: string;
const base = () => join(dir, 'baselines');
const show = async (v: Variant = {}) => page.setContent(html(v));

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  dir = await mkdtemp(join(tmpdir(), 'ez-visual-depth-'));
});
afterAll(async () => {
  await browser?.close();
});

describe('comparison modes and DOM-change grouping', () => {
  it('a button colour change: strict fails with one grouped finding, ignore-colors passes', async () => {
    await show();
    await compareVisual(page, { name: 'colours', baselineDir: base(), update: true });
    await show({ button: '#2da44e' });
    const [strict] = await compareVisual(page, { name: 'colours', baselineDir: base() });
    expect(strict.passed).toBe(false);
    expect(strict.mode).toBe('strict');
    // Both buttons share the CSS rule: one finding, not two (nor hundreds of pixels).
    const colour = strict.groups.filter((g) => g.kind === 'style' && g.summary.startsWith('background-color'));
    expect(colour).toHaveLength(1);
    expect(colour[0].summary).toBe('background-color changed rgb(31, 111, 235) -> rgb(45, 164, 78) on 2 elements: button#save, button#cancel');
    expect(colour[0].diffPixels).toBeGreaterThan(100);
    expect(strict.groups.filter((g) => g.kind === 'pixels')).toEqual([]);
    const [ignore] = await compareVisual(page, { name: 'colours', baselineDir: base(), mode: 'ignore-colors' });
    expect(ignore.passed).toBe(true);
    // Layout and content modes do not care about colours either.
    expect((await compareVisual(page, { name: 'colours', baselineDir: base(), mode: 'layout' }))[0].passed).toBe(true);
    expect((await compareVisual(page, { name: 'colours', baselineDir: base(), mode: 'content' }))[0].passed).toBe(true);
  });

  it('a panel moved 40px: layout fails and the finding names div#summary (its children are one change)', async () => {
    await show();
    await compareVisual(page, { name: 'move', baselineDir: base(), update: true });
    await show({ shift: 40 });
    const [layout] = await compareVisual(page, { name: 'move', baselineDir: base(), mode: 'layout' });
    expect(layout.passed).toBe(false);
    const moved = layout.groups.find((g) => g.kind === 'moved')!;
    expect(moved.summary).toMatch(/^div#summary(, p#clock)? moved by 0, 40 px \(with \d+ descendants\)$/);
    expect(moved.elements).toContain('div#summary');
    // A class rename alone is not a layout change.
    await show({ rename: true });
    expect((await compareVisual(page, { name: 'move', baselineDir: base(), mode: 'layout' }))[0].passed).toBe(true);
  });

  it('content mode fails on changed text and names the element; layout mode ignores it', async () => {
    await show();
    await compareVisual(page, { name: 'text', baselineDir: base(), update: true });
    await show({ total: '12.00' });
    const [content] = await compareVisual(page, { name: 'text', baselineDir: base(), mode: 'content' });
    expect(content.passed).toBe(false);
    expect(content.groups[0].summary).toBe('span#total text changed from "10.00" to "12.00"');
    expect((await compareVisual(page, { name: 'text', baselineDir: base(), mode: 'layout' }))[0].passed).toBe(true);
  });

  it('element-level assertions ignore the rest of the page; masking by selector hides dynamic content', async () => {
    await show();
    await compareVisual(page, { name: 'header', baselineDir: base(), target: page.locator('#hdr'), update: true });
    await compareVisual(page, { name: 'full', baselineDir: base(), update: true, mask: ['#clock'] });
    await show({ clock: '12:00:59' });
    const [el] = await compareVisual(page, { name: 'header', baselineDir: base(), target: page.locator('#hdr') });
    expect(el.passed).toBe(true);
    const png = PNG.sync.read(await readFile(el.baselinePath));
    expect(png.width).toBe(800);
    expect(png.height).toBeLessThan(80);
    expect((await compareVisual(page, { name: 'full', baselineDir: base(), mask: ['#clock'] }))[0].passed).toBe(true);
    const [unmasked] = await compareVisual(page, { name: 'full', baselineDir: base() });
    expect(unmasked.passed).toBe(false);
    expect(unmasked.groups.map((g) => g.summary)).toContain('p#clock text changed from "12:00:01" to "12:00:59"');
    await expect(compareVisual(page, { name: 'full', baselineDir: base(), mask: ['#nope'] })).rejects.toThrow(/matched nothing/);
  });

  it('anti-alias tolerance: sub-pixel rendering noise passes by default and counts in strict anti-aliasing', () => {
    // A 1px light-gray fringe around a dark square, as anti-aliasing produces.
    const img = (fringe: boolean) => {
      const p = new PNG({ width: 20, height: 20 });
      for (let y = 0; y < 20; y++) {
        for (let x = 0; x < 20; x++) {
          const i = (y * 20 + x) * 4;
          const inside = x >= 5 && x < 15 && y >= 5 && y < 15;
          const edge = fringe && (x === 4 || x === 15) && y >= 5 && y < 15;
          const v = inside ? 30 : edge ? 140 : 255;
          p.data.set([v, v, v, 255], i);
        }
      }
      return PNG.sync.write(p);
    };
    const tolerant = compareImagesByMode(img(true), img(false));
    const strict = compareImagesByMode(img(true), img(false), { antiAlias: 'strict' });
    expect(strict.diffPixels).toBeGreaterThan(tolerant.diffPixels);
    expect(compareImagesByMode(img(true), img(false), { mode: 'ignore-colors' }).passed).toBe(true);
  });
});

describe('baseline keys, viewports and branches', () => {
  it.skipIf(onFirefox)(chromiumOnly('keys baselines by browser and viewport, and compares several viewports in one assertion', 'the expected baseline keys name chromium'), async () => {
    await show();
    const viewports = [{ width: 800, height: 600 }, { width: 375, height: 667 }];
    const made = await compareVisual(page, { name: 'home', baselineDir: base(), viewports, update: true });
    expect(made.map((r) => r.key)).toEqual(['home--chromium--800x600', 'home--chromium--375x667']);
    expect(existsSync(join(base(), 'home--chromium--375x667.png'))).toBe(true);
    expect(existsSync(join(base(), 'home--chromium--375x667.dom.json'))).toBe(true);
    expect(page.viewportSize()).toEqual({ width: 800, height: 600 });
    const again = await compareVisual(page, { name: 'home', baselineDir: base(), viewports });
    expect(again.map((r) => [r.viewport, r.passed])).toEqual([[{ width: 800, height: 600 }, true], [{ width: 375, height: 667 }, true]]);
    // A narrow layout differs from the wide one: each viewport has its own baseline.
    const a = PNG.sync.read(await readFile(join(base(), 'home--chromium--800x600.png')));
    const b = PNG.sync.read(await readFile(join(base(), 'home--chromium--375x667.png')));
    expect([a.width, b.width]).toEqual([800, 375]);
  });

  it.skipIf(onFirefox)(chromiumOnly('per browser version: a browser update falls back to the closest version and says so', 'the expected baseline keys name chromium'), async () => {
    await show();
    const [made] = await compareVisual(page, { name: 'ver', baselineDir: base(), keyBy: ['browserVersion', 'viewport'], update: true });
    const version = browser.version().split('.')[0];
    expect(made.key).toBe(`ver--chromium-${version}--800x600`);
    await rename(join(base(), `${made.key}.png`), join(base(), 'ver--chromium-99--800x600.png'));
    await rename(join(base(), `${made.key}.dom.json`), join(base(), 'ver--chromium-99--800x600.dom.json'));
    const [r] = await compareVisual(page, { name: 'ver', baselineDir: base(), keyBy: ['browserVersion', 'viewport'] });
    expect(r.passed).toBe(true);
    expect(r.fallbackFrom).toBe('chromium 99');
    expect(r.message).toMatch(/baseline from chromium 99: a browser update; re-approve to key ver--chromium-/);
    expect(baselineKey({ browser: 'firefox', browserVersion: '133', platform: 'linux', viewport: { width: 1280, height: 720 } }, ['browser', 'platform', 'viewport'])).toBe('--firefox--linux--1280x720');
  });

  it.skipIf(onFirefox)(chromiumOnly('branches baselines per git branch and merges them into the main set with an approval record', 'the expected baseline keys name chromium'), async () => {
    await show();
    await compareVisual(page, { name: 'branchy', baselineDir: base(), update: true });
    await show({ button: '#2da44e' });
    // On the feature branch the new look is approved into the branch set; main is untouched.
    const [upd] = await compareVisual(page, { name: 'branchy', baselineDir: base(), branch: 'feature/green-buttons', update: true });
    expect(upd.baselinePath).toBe(join(base(), 'branches', 'feature-green-buttons', 'branchy--chromium--800x600.png'));
    expect((await compareVisual(page, { name: 'branchy', baselineDir: base(), branch: 'feature/green-buttons' }))[0].passed).toBe(true);
    expect((await compareVisual(page, { name: 'branchy', baselineDir: base() }))[0].passed).toBe(false);
    // Other baselines still come from main on the branch.
    expect(findBaseline(base(), 'home--chromium--800x600', { branch: 'feature/green-buttons' }).source).toBe('main');
    expect((await listBaselineBranches(base())).map((b) => [b.branch, b.baselines])).toEqual([['feature-green-buttons', ['branchy--chromium--800x600']]]);
    const merged = await mergeBaselineBranch(base(), 'feature/green-buttons');
    expect(merged.merged.map((m) => m.name)).toEqual(['branchy--chromium--800x600']);
    expect((await verifyEvidence(merged.vault)).ok).toBe(true);
    expect(JSON.parse(await readFile(join(merged.vault, 'approval.json'), 'utf8'))).toMatchObject({ kind: 'visual-baseline-branch-merge', branch: 'feature/green-buttons' });
    expect(existsSync(join(base(), 'branches', 'feature-green-buttons'))).toBe(false);
    expect((await compareVisual(page, { name: 'branchy', baselineDir: base() }))[0].passed).toBe(true);
  });

  it('reads the current git branch from .git/HEAD (EZTEST_BASELINE_BRANCH wins)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ez-git-'));
    await writeFile(join(repo, '.git'), 'gitdir: real-git\n');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(repo, 'real-git'));
    await writeFile(join(repo, 'real-git', 'HEAD'), 'ref: refs/heads/feature/login\n');
    expect(currentBranch(join(repo), {})).toBe('feature/login');
    expect(currentBranch(repo, { EZTEST_BASELINE_BRANCH: 'release' })).toBe('release');
    expect(readdirSync(repo)).toContain('.git');
  });
});

describe('DOM change grouping (snapshots)', () => {
  const el = (key: string, parent: number, box: [number, number, number, number], styles: Record<string, string> = {}, text = '') => ({
    key, label: key.split('>').pop()!.replace(/:nth\(\d+\)$/, ''), tag: key.split('>').pop()!.replace(/[#[:].*$/, ''), parent,
    box: { x: box[0], y: box[1], width: box[2], height: box[3] }, text, styles,
  });
  const snap = (elements: DomSnapshot['elements']): DomSnapshot => ({ version: 1, origin: 'viewport', devicePixelRatio: 1, elements });

  it('collapses a moved container with its children and groups one style change across elements', () => {
    const before = snap([
      el('body', -1, [0, 0, 800, 600]),
      el('body>div#panel', 0, [10, 10, 300, 100]),
      el('body>div#panel>p:nth(1)', 1, [20, 20, 100, 20], {}, 'a'),
      el('body>div#panel>p:nth(2)', 1, [20, 50, 100, 20], {}, 'b'),
      el('body>button#one', 0, [10, 200, 80, 30], { color: 'rgb(0, 0, 0)' }),
      el('body>button#two', 0, [100, 200, 80, 30], { color: 'rgb(0, 0, 0)' }),
      el('body>button#three', 0, [190, 200, 80, 30], { color: 'rgb(0, 0, 0)' }),
    ]);
    const after = snap([
      el('body', -1, [0, 0, 800, 600]),
      el('body>div#panel', 0, [10, 50, 300, 100]),
      el('body>div#panel>p:nth(1)', 1, [20, 60, 100, 20], {}, 'a'),
      el('body>div#panel>p:nth(2)', 1, [20, 90, 100, 20], {}, 'b'),
      el('body>button#one', 0, [10, 200, 80, 30], { color: 'rgb(255, 0, 0)' }),
      el('body>button#two', 0, [100, 200, 80, 30], { color: 'rgb(255, 0, 0)' }),
      el('body>button#three', 0, [190, 200, 80, 30], { color: 'rgb(255, 0, 0)' }),
    ]);
    const changes = diffSnapshots(before, after);
    expect(changes.map((c) => [c.kind, c.key, c.covers])).toEqual([
      ['moved', 'body>div#panel', 2],
      ['style', 'body>button#one', 0],
      ['style', 'body>button#two', 0],
      ['style', 'body>button#three', 0],
    ]);
    const regions = [{ x: 10, y: 10, width: 300, height: 140, pixels: 900 }, { x: 10, y: 200, width: 260, height: 30, pixels: 300 }, { x: 600, y: 500, width: 20, height: 20, pixels: 40 }];
    const groups = groupChanges(changes, regions, after);
    expect(groups.map((g) => [g.kind, g.summary, g.diffPixels])).toEqual([
      ['moved', 'div#panel moved by 0, 40 px (with 2 descendants)', 900],
      ['style', 'color changed rgb(0, 0, 0) -> rgb(255, 0, 0) on 3 elements: button#one, button#two, button#three', 300],
      ['pixels', 'pixels changed inside body (no DOM change: image, canvas, font or rendering)', 40],
    ]);
    // The same CSS change in another screenshot has the same group id (approve them together).
    expect(groupChanges(changes, [], after).find((g) => g.kind === 'style')!.id).toBe(groups[1].id);
  });

  it('clusters differing pixels into regions', () => {
    const mask = new Uint8Array(100 * 100);
    for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) mask[y * 100 + x] = 1;
    for (let y = 70; y < 72; y++) for (let x = 80; x < 90; x++) mask[y * 100 + x] = 1;
    const r = diffRegions(mask, 100, 100);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ pixels: 100 });
    expect(r[0].x).toBeLessThanOrEqual(10);
  });
});
