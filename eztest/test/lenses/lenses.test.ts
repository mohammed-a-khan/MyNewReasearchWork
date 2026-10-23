import { describe, it, expect, beforeAll, afterAll } from '../support/testkit.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { startDemoApp, DEMO_CLIENT, type DemoServer } from '../../examples/demo-app/server.js';
import { EvidenceVault, verifyEvidence } from '../../src/core/index.js';
import {
  scanAccessibility,
  createA11yLens,
  compareScreenshot,
  compareImages,
  createVisualLens,
  checkSecurityHeaders,
  checkCookies,
  parseSetCookie,
  findMixedContent,
  scanPageSecurity,
  createSecurityLens,
  runAuthorizationMatrix,
  probeIdor,
} from '../../src/lenses/index.js';
import { solidPng } from '../insights/fixtures.js';

let demo: DemoServer;
let browser: Browser;

async function apiToken(): Promise<string> {
  const r = await fetch(demo.url + '/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${DEMO_CLIENT.id}&client_secret=${DEMO_CLIENT.secret}`,
  });
  return ((await r.json()) as { access_token: string }).access_token;
}

async function login(page: Page) {
  await page.goto(demo.url + '/login');
  await page.getByLabel('Username').fill('bob');
  await page.getByLabel('Password').fill('Builder#2');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard');
}

beforeAll(async () => {
  demo = await startDemoApp();
  const ins = demo.db.prepare('INSERT INTO orders (customer_id, created_by, status, total, created_at) VALUES (?, ?, ?, ?, ?)');
  ins.run(1, 'bob', 'Submitted', 19.99, '2026-10-01T00:00:00Z');
  ins.run(2, 'alice', 'Submitted', 49.5, '2026-10-02T00:00:00Z');
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await demo?.close();
});

describe('accessibility lens', () => {
  it('scans /login and returns structured findings with WCAG tag filtering', async () => {
    const page = await browser.newPage();
    await page.goto(demo.url + '/login');
    const clean = await scanAccessibility(page, { tags: ['wcag2a', 'wcag2aa'] });
    expect(clean.engine).toMatch(/^eztest-a11y\/\d+\.\d+\.\d+$/);
    expect(clean.url).toContain('/login');
    expect(clean.passes).toBeGreaterThan(0);
    expect(clean.violations).toEqual([]);

    // introduce real defects into the live page
    await page.evaluate(`(() => {
      const img = document.createElement('img'); img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='; img.id = 'logo'; document.querySelector('main').appendChild(img);
      const b = document.createElement('button'); b.id = 'icon-btn'; document.querySelector('form').appendChild(b);
    })()`);
    const res = await scanAccessibility(page, { tags: ['wcag2a', 'wcag2aa'] });
    const alt = res.violations.find((v) => v.ruleId === 'text-alt.img')!;
    expect(alt.impact).toBe('critical');
    expect(alt.helpUrl).toBe('https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html');
    expect(alt.sc).toEqual(['1.1.1']);
    expect(alt.nodes[0].failureSummary).toMatch(/no alt attribute/);
    expect(alt.nodes[0].box?.width).toBeGreaterThanOrEqual(0);
    expect(alt.tags).toContain('wcag2a');
    expect(alt.nodes[0].target).toEqual(['#logo']);
    expect(alt.nodes[0].html).toContain('<img');
    expect(res.violations.some((v) => v.ruleId === 'name.button' && v.nodes[0].target[0] === '#icon-btn')).toBe(true);
    expect(res.counts.critical).toBeGreaterThanOrEqual(2);

    const bp = await scanAccessibility(page, { tags: ['best-practice'] });
    expect(bp.violations.some((v) => v.ruleId === 'text-alt.img')).toBe(false);
    const filtered = await scanAccessibility(page, { exclude: ['#logo'], disableRules: ['name.button'] });
    expect(filtered.violations.some((v) => v.ruleId === 'text-alt.img' || v.ruleId === 'name.button')).toBe(false);
    const included = await scanAccessibility(page, { include: ['form'] });
    expect(included.violations.some((v) => v.ruleId === 'text-alt.img')).toBe(false);
    expect(included.violations.some((v) => v.ruleId === 'name.button')).toBe(true);
    await expect(scanAccessibility(page, { disableRules: ['image-alt'] })).rejects.toThrow(/Unknown accessibility rule/);
    await expect(scanAccessibility(page, { tags: [] })).rejects.toThrow(/tags/);

    // lens shape + evidence
    const runDir = await mkdtemp(join(tmpdir(), 'ez-lens-'));
    const vault = new EvidenceVault(runDir);
    await vault.init();
    const lens = createA11yLens({ failOn: 'critical' });
    expect(lens.name).toBe('a11y');
    const out = await lens.afterStep(page, { id: 's1', intent: 'Open login' }, { journeyId: 'login', vault });
    expect(out.passed).toBe(false);
    expect(out.evidence).toEqual(['E-1']);
    expect((await verifyEvidence(runDir)).ok).toBe(true);
    await page.close();
  });
});

describe('visual lens', () => {
  it('creates a baseline, compares, detects change, masks it, and handles size mismatch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-visual-'));
    const baselineDir = join(dir, 'baselines');
    const outputDir = join(dir, 'out');
    const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
    await page.goto(demo.url + '/login');
    const missing = await compareScreenshot(page, { name: 'login', baselineDir, outputDir });
    expect(missing.status).toBe('missing-baseline');
    expect(missing.passed).toBe(false);
    expect(existsSync(missing.actualPath!)).toBe(true);

    const created = await compareScreenshot(page, { name: 'login', baselineDir, outputDir, update: true });
    expect(created.status).toBe('baseline-updated');
    expect(existsSync(created.baselinePath)).toBe(true);

    const same = await compareScreenshot(page, { name: 'login', baselineDir, outputDir });
    expect(same.status).toBe('match');
    expect(same.diffPixels).toBe(0);

    await page.evaluate(`document.querySelector('h1').textContent = 'Log on to EZ Store!'`); // same line, no reflow
    const changed = await compareScreenshot(page, { name: 'login', baselineDir, outputDir });
    expect(changed.status).toBe('mismatch');
    expect(changed.diffPixels).toBeGreaterThan(50);
    expect(existsSync(changed.diffPath!)).toBe(true);
    const diff = PNG.sync.read(await readFile(changed.diffPath!));
    expect(diff.width).toBe(640);

    const masked = await compareScreenshot(page, { name: 'login', baselineDir, outputDir, mask: ['h1'] });
    expect(masked.maskedBoxes).toHaveLength(1);
    expect(masked.status, JSON.stringify({ d: masked.diffPixels, boxes: masked.maskedBoxes, diff: masked.diffPath })).toBe('match');
    await expect(compareScreenshot(page, { name: 'login', baselineDir, outputDir, mask: ['#nope'] })).rejects.toThrow(/matched nothing/);

    await page.setViewportSize({ width: 600, height: 400 });
    const sized = await compareScreenshot(page, { name: 'login', baselineDir, outputDir });
    expect(sized.status).toBe('size-mismatch');
    expect(sized.passed).toBe(false);
    expect(sized.baselineSize).toEqual({ width: 640, height: 400 });

    const lens = createVisualLens({ baselineDir, outputDir, update: true });
    const res = await lens.afterStep(page, { id: 's9' }, { journeyId: '../../etc' });
    expect(res.data.baselinePath.startsWith(baselineDir)).toBe(true);
    await page.close();
  });

  it('pure image comparison with thresholds and anti-aliasing options', () => {
    const a = solidPng(20, 20, [255, 255, 255]);
    const b = PNG.sync.read(a);
    for (let i = 0; i < 4; i++) b.data[i * 4] = 0; // 4 different pixels
    const bb = PNG.sync.write(b);
    expect(compareImages(a, bb).diffPixels).toBe(4);
    expect(compareImages(a, bb).passed).toBe(false);
    expect(compareImages(a, bb, { maxDiffPixels: 4 }).passed).toBe(true);
    expect(compareImages(a, bb, { maxDiffRatio: 0.02 }).passed).toBe(true);
    expect(compareImages(a, bb, { maskBoxes: [{ x: 0, y: 0, width: 4, height: 1 }] }).passed).toBe(true);
    expect(compareImages(a, solidPng(21, 20, [255, 255, 255])).status).toBe('size-mismatch');
    expect(() => compareImages(a, bb, { threshold: 2 })).toThrow(/threshold/);
  });
});

describe('security lens', () => {
  it('flags missing headers and checks cookie flags on real demo responses', async () => {
    const res = await fetch(demo.url + '/login');
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    const ids = checkSecurityHeaders({ url: demo.url + '/login', headers }).map((f) => f.id).sort();
    expect(ids).toEqual(['csp-missing', 'frame-protection-missing', 'xcto-missing']);

    const post = await fetch(demo.url + '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=bob&password=Builder%232',
      redirect: 'manual',
    });
    const cookie = parseSetCookie(post.headers.get('set-cookie')!);
    expect(cookie).toMatchObject({ name: 'ezsid', httpOnly: true, secure: false, sameSite: 'Lax' });
    expect(checkCookies([cookie], demo.url)).toEqual([]); // http: Secure not required
    const httpsFindings = checkCookies([cookie], 'https://shop.example/login');
    expect(httpsFindings.map((f) => [f.id, f.severity])).toEqual([['cookie-no-secure', 'high']]);

    const page = await browser.newPage();
    await login(page);
    const scan = await scanPageSecurity(page);
    expect(scan.findings.map((f) => f.id)).toContain('csp-missing');
    expect(scan.findings.some((f) => f.id.startsWith('cookie-'))).toBe(false);
    const lens = createSecurityLens({ failOn: 'medium' });
    const out = await lens.afterStep(page, { id: 's3' });
    expect(out.passed).toBe(false);
    await page.close();
  });

  it('unit checks: HSTS, CSP quality, mixed content, SameSite=None', () => {
    const f = checkSecurityHeaders({
      url: 'https://a.example/?token=SECRET',
      headers: { 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'", 'x-content-type-options': 'nosniff', 'strict-transport-security': 'max-age=600', 'x-powered-by': 'Express 4.1' },
    });
    expect(f.map((x) => x.id).sort()).toEqual(['csp-unsafe-eval', 'csp-unsafe-inline', 'frame-protection-missing', 'hsts-short', 'version-disclosure']);
    expect(JSON.stringify(f)).not.toContain('SECRET');
    expect(checkSecurityHeaders({ url: 'https://a.example', headers: { 'content-type': 'text/html' } }).some((x) => x.id === 'hsts-missing')).toBe(true);
    expect(findMixedContent('https://a.example/', ['http://cdn.example/x.js', 'https://ok.example/y.css'])).toHaveLength(1);
    expect(findMixedContent('http://a.example/', ['http://cdn.example/x.js'])).toEqual([]);
    expect(checkCookies([parseSetCookie('pref=1; SameSite=None')], 'http://a').map((x) => x.id)).toEqual(['cookie-no-httponly', 'cookie-samesite-none-insecure']);
  });

  it('authorization matrix against the demo API with and without a token', async () => {
    const report = await runAuthorizationMatrix({
      baseUrl: demo.url,
      roles: [
        { name: 'client', token: apiToken },
        { name: 'anonymous', token: () => undefined },
        { name: 'forged', token: () => 'deadbeefdeadbeefdeadbeefdeadbeef' },
      ],
      cases: [
        { path: '/api/orders', expect: { client: 'allow', anonymous: 'deny', forged: 'deny' } },
        { path: '/api/customers', expect: { client: 'allow', anonymous: 'deny', forged: 'deny' } },
        // a wrong expectation: the matrix must report it
        { name: 'customers should be public', path: '/api/customers', expect: { client: 'allow', anonymous: 'allow', forged: 'deny' } },
      ],
    });
    expect(report.results).toHaveLength(9);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toMatchObject({ case: 'customers should be public', role: 'anonymous', status: 401, actual: 'deny', expected: 'allow' });
    expect(report.passed).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/[0-9a-f]{32}/); // tokens never appear in results
    await expect(runAuthorizationMatrix({ baseUrl: demo.url, roles: [{ name: 'x', token: () => undefined }], cases: [{ path: '/', expect: {} }] })).rejects.toThrow(/no expectation/);
    await expect(runAuthorizationMatrix({ baseUrl: demo.url, roles: [], cases: [] })).rejects.toThrow(/at least one role/);
  });

  it('IDOR probe detects cross-user access to orders', async () => {
    const r = await probeIdor({
      baseUrl: demo.url,
      users: [
        { name: 'bob', token: apiToken, resources: ['/api/orders/1'] },
        { name: 'alice', token: apiToken, resources: ['/api/orders/2', '/api/orders/999'] },
      ],
    });
    expect(r.vulnerable).toBe(true);
    const v = r.findings.find((x) => x.path === '/api/orders/1')!;
    expect(v).toMatchObject({ owner: 'bob', requester: 'alice', ownerStatus: 200, requesterStatus: 200, verdict: 'vulnerable' });
    expect(r.findings.find((x) => x.path === '/api/orders/999')!.verdict).toBe('inconclusive');
    const anon = await probeIdor({
      baseUrl: demo.url,
      users: [
        { name: 'bob', token: apiToken, resources: ['/api/orders/1'] },
        { name: 'anon', token: () => undefined, resources: ['/api/orders/2'] },
      ],
    });
    expect(anon.findings[0].verdict).toBe('protected');
  });
});
