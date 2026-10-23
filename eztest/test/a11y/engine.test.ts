/**
 * EZTest's accessibility engine: the contrast formula and token validators,
 * rule selection, the result shape, shadow DOM, same-origin and
 * cross-origin frames, include/exclude, strict CSP pages, and that the
 * dynamic checks leave the page as they found it.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { RULES, RULES_BY_ID, SUCCESS_CRITERIA, a11ySource, ruleTags, scanAccessibility, selectRules } from '../../src/a11y/index.js';
import { blend, contrast, luminance, parseColor } from '../../src/a11y/page/color.js';
import { autocompleteProblem } from '../../src/a11y/page/rules-misc.js';
import { validLang } from '../../src/a11y/page/rules-structure.js';
import { valueProblem } from '../../src/a11y/page/rules-aria.js';
import { GIF, page as wrap } from './fixtures.js';

let browser: Browser;
let pg: Page;
let a: Server;
let b: Server;
let originA = '';
let originB = '';

function serve(handler: (path: string) => { type?: string; body: string; csp?: string }): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const r = handler(req.url ?? '/');
      res.writeHead(200, { 'content-type': r.type ?? 'text/html; charset=utf-8', ...(r.csp ? { 'content-security-policy': r.csp } : {}) });
      res.end(r.body);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
  });
}

beforeAll(async () => {
  const sa = await serve((path) => {
    if (path === '/csp') return { body: wrap(`<img src="${GIF}" width="10" height="10"><script>window.ran = true</script>`), csp: "default-src 'none'; img-src data:; script-src 'none'; style-src 'none'" };
    if (path === '/frames') return { body: wrap(`<iframe title="Same origin" src="/inner" width="300" height="120" style="margin-left:40px;border:0"></iframe><iframe title="Other origin" src="${originB}/inner" width="300" height="120" style="border:0"></iframe>`) };
    return { body: `<!doctype html><html lang="en"><head><title>Inner</title></head><body><main><h1>Inner A</h1><button id="inner-btn"></button></main></body></html>` };
  });
  a = sa.server;
  originA = sa.origin;
  const sb = await serve(() => ({ body: `<!doctype html><html lang="en"><head><title>Inner B</title></head><body><main><h1>Inner B</h1><img id="inner-img" src="${GIF}" width="10" height="10"></main></body></html>` }));
  b = sb.server;
  // A different host name is a different origin (and a separate renderer with site isolation).
  originB = sb.origin.replace('127.0.0.1', 'localhost');
  browser = await chromium.launch();
  pg = await browser.newPage({ viewport: { width: 1000, height: 700 } });
});
afterAll(async () => {
  await browser?.close();
  await new Promise((r) => a?.close(r));
  await new Promise((r) => b?.close(r));
});

describe('colour and value checks', () => {
  it('computes WCAG relative luminance and contrast', () => {
    const black = { r: 0, g: 0, b: 0, a: 1 };
    const white = { r: 255, g: 255, b: 255, a: 1 };
    expect(luminance(white)).toBeCloseTo(1, 6);
    expect(luminance(black)).toBe(0);
    expect(contrast(black, white)).toBeCloseTo(21, 6);
    expect(contrast(white, black)).toBeCloseTo(21, 6);
    expect(contrast(parseColor('rgb(119, 119, 119)')!, white)).toBeCloseTo(4.48, 2);
    expect(contrast(parseColor('rgb(118, 118, 118)')!, white)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(parseColor('rgb(89, 89, 89)')!, white)).toBeCloseTo(7, 0);
    // Half-transparent black over white is mid grey.
    const grey = blend(parseColor('rgba(0, 0, 0, 0.5)')!, white);
    expect(Math.round(grey.r)).toBe(128);
    expect(parseColor('rgb(10 20 30 / 50%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor('transparent')!.a).toBe(0);
  });

  it('validates autocomplete tokens, language tags and ARIA values', () => {
    for (const ok of ['on', 'off', 'email', 'shipping postal-code', 'section-x billing cc-number', 'work tel', 'home email webauthn', 'one-time-code']) expect(autocompleteProblem(ok), ok).toBeNull();
    expect(autocompleteProblem('mail')).toMatch(/not an autofill field name/);
    expect(autocompleteProblem('home name')).toMatch(/must be followed by a phone, email or impp field/);
    expect(autocompleteProblem('email shipping')).toMatch(/unexpected token "shipping"/);
    for (const ok of ['en', 'en-GB', 'pt-BR', 'zh-Hant-TW', 'sr-Latn', 'es-419', 'x-klingon', 'de-DE-1996']) expect(validLang(ok), ok).toBe(true);
    for (const bad of ['english', 'en_US', 'e', '12', 'en--GB']) expect(validLang(bad), bad).toBe(false);
    expect(valueProblem('aria-checked', 'mixed')).toBeNull();
    expect(valueProblem('aria-checked', 'yes')).toMatch(/"true", "false" or "mixed"/);
    expect(valueProblem('aria-level', '0')).toMatch(/at least 1/);
    expect(valueProblem('aria-valuenow', '1e3')).toBeNull();
    expect(valueProblem('aria-valuenow', 'ten')).toMatch(/number/);
    expect(valueProblem('aria-relevant', 'additions text')).toBeNull();
    expect(valueProblem('aria-relevant', 'additions everything')).toMatch(/"everything"/);
    expect(valueProblem('aria-activedescendant', 'a b')).toMatch(/single ID/);
    expect(valueProblem('aria-hidden', '')).toBeNull();
  });
});

describe('rule catalogue and selection', () => {
  it('has unique ids, known WCAG criteria, our own help texts and a page implementation for every static rule', async () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(RULES.length).toBeGreaterThanOrEqual(75);
    for (const r of RULES) {
      expect(r.id).toMatch(/^[a-z0-9-]+\.[a-z0-9-]+$/);
      for (const sc of r.sc) expect(SUCCESS_CRITERIA.has(sc), `${r.id} ${sc}`).toBe(true);
      expect(r.help.length).toBeGreaterThan(15);
      expect(r.description.length).toBeGreaterThan(30);
    }
    expect(new Set(RULES.map((r) => r.help)).size).toBe(RULES.length);
    await pg.setContent(wrap(''));
    await scanAccessibility(pg, { rules: ['page.title'] });
    const pageIds = (await pg.evaluate('globalThis.__eztestA11y.ruleIds')) as string[];
    const nodeSide = RULES.filter((r) => r.dynamic === 'keyboard' || r.dynamic === 'reflow' || r.dynamic === 'textSpacing').map((r) => r.id);
    expect(ids.filter((id) => !pageIds.includes(id) && !nodeSide.includes(id))).toEqual([]);
    expect(pageIds.filter((id) => !RULES_BY_ID.has(id))).toEqual([]);
    expect(a11ySource()).toContain('eztest-a11y/');
  });

  it('selects rules by tag, level, id and dynamic kind', () => {
    const def = selectRules().map((r) => r.id);
    expect(def).toContain('contrast.text');
    expect(def).toContain('heading.order');
    expect(def).not.toContain('contrast.text-enhanced'); // AAA is opt-in
    expect(def).not.toContain('keyboard.trap'); // dynamic is opt-in
    expect(selectRules({ level: 'AAA' }).map((r) => r.id)).toContain('target.size-enhanced');
    expect(selectRules({ level: 'A', bestPractice: false }).every((r) => !r.bestPractice && r.sc.some((sc) => SUCCESS_CRITERIA.get(sc)!.level === 'A'))).toBe(true);
    expect(selectRules({ tags: ['best-practice'] }).every((r) => r.bestPractice)).toBe(true);
    expect(selectRules({ tags: ['wcag22aa'] }).map((r) => r.id).sort()).toEqual(['target.size']);
    expect(selectRules({ tags: ['wcag22aa'], dynamic: true }).map((r) => r.id).sort()).toEqual(['focus.not-obscured', 'target.size']);
    expect(selectRules({ tags: ['wcag143'] }).map((r) => r.id)).toEqual(['contrast.text']);
    expect(selectRules({ tags: ['wcag22'] }).some((r) => r.bestPractice)).toBe(false);
    expect(selectRules({ dynamic: { keyboard: true } }).map((r) => r.id)).toContain('focus.visible');
    expect(selectRules({ dynamic: { keyboard: true } }).map((r) => r.id)).not.toContain('layout.reflow');
    expect(selectRules({ disableRules: ['contrast.text'] }).map((r) => r.id)).not.toContain('contrast.text');
    expect(ruleTags(RULES_BY_ID.get('contrast.text')!)).toEqual(expect.arrayContaining(['wcag2aa', 'wcag143', 'wcag22', 'cat.color']));
    expect(ruleTags(RULES_BY_ID.get('target.size')!)).toEqual(expect.arrayContaining(['wcag22aa', 'wcag258']));
    expect(() => selectRules({ tags: [] })).toThrow(/tags must not be empty/);
    expect(() => selectRules({ rules: ['image-alt'] })).toThrow(/Unknown accessibility rule "image-alt"/);
    expect(() => selectRules({ minImpact: 'huge' as never })).toThrow(/Unknown impact/);
  });
});

describe('scanning', () => {
  it('returns violations, needs-review and passes with counts, and caps node lists', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `<img src="${GIF}" id="i${i}" width="4" height="4">`).join('');
    await pg.setContent(wrap(`${many}<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table><button>OK</button>`));
    const r = await scanAccessibility(pg, { maxNodes: 5 });
    expect(r.engine).toMatch(/^eztest-a11y\//);
    const img = r.violations.find((v) => v.ruleId === 'text-alt.img')!;
    expect(img.nodeCount).toBe(30);
    expect(img.nodes).toHaveLength(5);
    expect(img.nodes[0].box).toEqual({ x: expect.any(Number), y: expect.any(Number), width: 4, height: 4 });
    expect(r.needsReview.map((x) => x.ruleId)).toContain('table.has-headers');
    expect(r.incomplete).toBe(r.needsReview.length);
    expect(r.passes).toBeGreaterThan(10);
    expect(r.passes + r.violations.length + r.inapplicable).toBe(r.rules.length);
    expect(r.counts.critical).toBe(r.violations.filter((v) => v.impact === 'critical').length);
    expect(r.totals.violations).toBeGreaterThanOrEqual(30);
    expect(r.page).toEqual({ width: expect.any(Number), height: expect.any(Number), dpr: expect.any(Number) });
    const serious = await scanAccessibility(pg, { minImpact: 'critical' });
    expect(serious.violations.every((v) => v.impact === 'critical')).toBe(true);
  });

  it('measures placeholder text and accounts for ::before/::after backgrounds', async () => {
    await pg.setContent(wrap(`
      <style>
        #faint::placeholder { color: #c8c8c8; opacity: 1; }
        #dark::placeholder { color: #555; opacity: 1; }
        .badge { position: relative; color: #fff; padding: 4px; }
        .badge::before { content: ""; position: absolute; inset: 0; background: #000; z-index: -1; }
        .plain { color: #fff; background: #000; }
      </style>
      <input id="faint" aria-label="Faint" placeholder="Search orders">
      <input id="dark" aria-label="Dark" placeholder="Search orders">
      <p><span class="badge">On a pseudo background</span></p>
      <p class="plain">Plain dark</p>`));
    const r = await scanAccessibility(pg, { rules: ['contrast.text'] });
    const v = r.violations.find((x) => x.ruleId === 'contrast.text')!;
    expect(v.nodes.map((n) => n.target[0])).toEqual(['#faint']);
    expect(v.nodes[0].failureSummary).toMatch(/placeholder text #c8c8c8 on #ffffff/);
    const review = r.needsReview.find((x) => x.ruleId === 'contrast.text')!;
    expect(review.nodes.map((n) => n.target[0])).toEqual(['span']);
    expect(review.nodes[0].failureSummary).toMatch(/::before\/::after background/);
  });

  it('looks into open shadow roots and reports " >>> " selectors', async () => {
    await pg.setContent(wrap(`<div id="host"></div><script>
      const root = document.getElementById('host').attachShadow({ mode: 'open' });
      root.innerHTML = '<p>In the shadow</p><button class="icon"></button><slot></slot>';
    </script>`));
    const r = await scanAccessibility(pg, { rules: ['name.button'] });
    const v = r.violations.find((x) => x.ruleId === 'name.button')!;
    expect(v.nodes[0].target).toEqual(['#host >>> button']);
    expect(v.nodes[0].box!.width).toBeGreaterThan(0);
    const inside = await scanAccessibility(pg, { rules: ['name.button'], include: ['#host >>> p'] });
    expect(inside.violations).toEqual([]);
    const outside = await scanAccessibility(pg, { rules: ['name.button'], exclude: ['#host'] });
    expect(outside.violations).toEqual([]);
  });

  it('scans same-origin frames in the page and cross-origin frames through the driver', async () => {
    await pg.goto(`${originA}/frames`);
    await expect.poll(() => pg.frames().length).toBe(3);
    await expect.poll(() => Promise.all(pg.frames().map((f) => f.evaluate('document.readyState')))).toEqual(['complete', 'complete', 'complete']);
    const r = await scanAccessibility(pg, { rules: ['name.button', 'text-alt.img', 'lang.page', 'name.frame'] });
    const btn = r.violations.find((x) => x.ruleId === 'name.button')!;
    expect(btn.nodes.map((n) => n.target)).toEqual([['iframe:nth-of-type(1)', '#inner-btn']]);
    const img = r.violations.find((x) => x.ruleId === 'text-alt.img')!;
    expect(img.nodes.map((n) => n.target)).toEqual([['iframe:nth-of-type(2)', '#inner-img']]);
    expect(r.frames.scanned).toBe(1);
    expect(r.frames.skipped).toEqual([]);
    // Boxes are in top-document coordinates: inside the frames, offset by their position.
    const frameBox = await pg.locator('iframe').first().boundingBox();
    expect(btn.nodes[0].box!.x).toBeGreaterThanOrEqual(frameBox!.x);
    const otherBox = await pg.locator('iframe').nth(1).boundingBox();
    expect(img.nodes[0].box!.y).toBeGreaterThanOrEqual(otherBox!.y);
    expect(r.violations.find((x) => x.ruleId === 'lang.page')).toBeUndefined();
    expect(r.violations.find((x) => x.ruleId === 'name.frame')).toBeUndefined();
    const excluded = await scanAccessibility(pg, { rules: ['name.button', 'text-alt.img'], exclude: ['iframe:nth-of-type(2)', 'iframe:nth-of-type(1)'] });
    expect(excluded.violations).toEqual([]);
    const onlyOther = await scanAccessibility(pg, { rules: ['name.button', 'text-alt.img'], include: ['iframe[title="Other origin"]'] });
    expect(onlyOther.violations.map((v) => v.ruleId)).toEqual(['text-alt.img']);
    const onlySame = await scanAccessibility(pg, { rules: ['name.button', 'text-alt.img'], include: ['iframe[title="Same origin"]'] });
    expect(onlySame.violations.map((v) => v.ruleId)).toEqual(['name.button']);
  });

  it('runs under a strict Content-Security-Policy that blocks page scripts', async () => {
    await pg.goto(`${originA}/csp`);
    expect(await pg.evaluate('window.ran === true')).toBe(false);
    const r = await scanAccessibility(pg, { rules: ['text-alt.img'] });
    expect(r.violations.map((v) => v.ruleId)).toEqual(['text-alt.img']);
  });

  it('restores focus, scroll, viewport and styles after the dynamic checks', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `<p><a href="#p${i}" id="p${i}">Link ${i}</a></p>`).join('');
    await pg.setContent(wrap(`<input id="field" aria-label="Field"><div style="height:20px;overflow:hidden">Clipped text</div>${long}`));
    await pg.evaluate(`document.getElementById('field').focus(); window.scrollTo(0, 120)`);
    const before = pg.viewportSize();
    const y = (await pg.evaluate('window.scrollY')) as number;
    expect(y).toBeGreaterThan(50);
    const r = await scanAccessibility(pg, { dynamic: true, maxTabStops: 20 });
    expect(r.rules).toEqual(expect.arrayContaining(['keyboard.trap', 'focus.visible', 'layout.reflow', 'text.spacing']));
    expect(pg.viewportSize()).toEqual(before);
    expect(await pg.evaluate('document.activeElement && document.activeElement.id')).toBe('field');
    expect(Math.abs(((await pg.evaluate('window.scrollY')) as number) - y)).toBeLessThanOrEqual(1); // Firefox scrolls by fractional pixels
    expect(await pg.evaluate('document.querySelectorAll("style[data-eztest-a11y]").length')).toBe(0);
    expect(await pg.evaluate('getComputedStyle(document.querySelector("p")).letterSpacing')).toBe('normal');
  });

  it('reinstalls itself after a navigation and keeps one copy per document', async () => {
    await pg.goto(`${originA}/inner`);
    expect((await scanAccessibility(pg, { rules: ['name.button'] })).violations).toHaveLength(1);
    const v1 = await pg.evaluate('globalThis.__eztestA11y.version');
    await pg.goto(`${originA}/csp`);
    expect(await pg.evaluate('typeof globalThis.__eztestA11y')).toBe('undefined');
    const r = await scanAccessibility(pg, { rules: ['name.button'] });
    expect(r.violations).toEqual([]);
    expect(await pg.evaluate('globalThis.__eztestA11y.version')).toBe(v1);
  });
});
