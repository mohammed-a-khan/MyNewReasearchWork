import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { chromium, type Browser } from '../../src/browser/index.js';
import { verifyEvidence } from '../../src/core/index.js';
import { SecretMasker } from '../../src/config/masker.js';
import { createHealer } from '../../src/heal/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import {
  diffTraces, exportTraceBundle, listTraces, readBrowserTrace, readTrace, readTraceAsset, readTraceBundle, renderSnapshot,
  readZip, runDirSource, runJourneys, serializePage, writeZip,
} from '../../src/runner/index.js';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { FAST, bobOrderJourney, manifest, runDirOf, tempDir } from './fixtures.js';

let server: DemoServer;
let browser: Browser;
beforeAll(async () => {
  server = await startDemoApp({ variant: 'a' });
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
  await server.close();
});

const PASSWORD = 'Builder#2';

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...(await filesUnder(p)));
    else out.push(p);
  }
  return out;
}

async function textOf(path: string): Promise<string> {
  const b = await readFile(path);
  return (path.endsWith('.gz') ? gunzipSync(b) : b).toString('latin1');
}

function assertNoSecret(text: string, where: string) {
  for (const form of [PASSWORD, encodeURIComponent(PASSWORD), Buffer.from(PASSWORD).toString('base64')]) {
    expect(text.includes(form), `${where} contains the password (${form})`).toBe(false);
  }
}

describe('time-travel trace capture (real Chromium, demo app)', () => {
  it('records DOM before/after, target box, network and metadata; masks secrets; evidence verifies', async () => {
    const out = await tempDir('tt');
    const run = await runJourneys([bobOrderJourney()], { ...FAST, baseUrl: server.url, outputDir: out, timeTravel: { enabled: true } });
    const j = run.journeys[0];
    expect(j.status).toBe('passed');
    const dir = runDirOf(out, run);
    const t = await readTrace(dir, 'bob-order', 1);
    expect(t.format).toBe('eztest-trace');
    expect(t.steps).toHaveLength(j.steps.length);
    expect(await listTraces(dir)).toMatchObject([{ journeyId: 'bob-order', attempt: 1, status: 'passed', steps: j.steps.length }]);

    for (const s of t.steps) {
      expect(s.snapshots.before, s.stepId).toBeDefined();
      expect(s.snapshots.after, s.stepId).toBeDefined();
      expect(s.screenshot?.viewportJpeg, s.stepId).toMatch(/^trace\/resources\/[a-f0-9]{64}\.jpg\.gz$/);
    }
    const click = t.steps.find((s) => s.stepId === 'click-the-sign-in-button')!;
    const target = click.snapshots.before!.target!;
    expect(target.nid).toBeGreaterThan(0);
    expect(target.tag).toBe('button');
    expect(target.box.width).toBeGreaterThan(10);
    expect(target.box.height).toBeGreaterThan(5);
    expect(target.regionText).toContain('Sign in');
    expect(click.locator.used).toMatchObject({ strategy: 'role', value: 'button', name: 'Sign in' });
    expect(click.locator.tried[0]).toMatchObject({ count: 1, description: 'role=button "Sign in"' });
    expect(click.timings.locateMs).toBeGreaterThanOrEqual(0);
    expect(click.timings.actMs).toBeGreaterThanOrEqual(0);
    expect(click.timings.verifyMs).toBeGreaterThanOrEqual(0);
    expect(click.conditions[0]).toMatchObject({ type: 'urlContains', expected: '/dashboard', passed: true });
    expect(click.conditions[0].actual).toContain('/dashboard');
    expect(click.url.after).toContain('/dashboard');

    // Network: the login POST and the order POST, with redacted secrets.
    const login = click.network.find((n) => n.method === 'POST' && n.url.endsWith('/login'))!;
    expect(login.status).toBe(302);
    expect(login.requestBody?.text).toContain('username=bob');
    expect(login.requestBody?.text).toContain('password=****');
    expect(login.responseHeaders?.['set-cookie']).toBe('****');
    const submit = t.steps.find((s) => s.stepId === 'click-the-submit-order-button')!;
    const order = submit.network.find((n) => n.method === 'POST' && n.url.endsWith('/orders/new'))!;
    expect(order).toBeDefined();
    expect(order.status).toBe(302);
    expect(order.requestBody?.text).toContain('product=SKU-200');
    expect(order.requestHeaders.cookie).toBe('****');
    const doc = submit.network.find((n) => n.method === 'GET' && /\/orders\/\d+\?created=1$/.test(n.url));
    expect(doc?.responseBody?.text ?? doc?.responseBody?.path).toBeTruthy();

    // The password field step: value redacted, snapshot value blanked.
    const pw = t.steps.find((s) => s.stepId === 'type-builder-2-into-the-password-field')!;
    expect(pw.value).toBe('****');
    expect(pw.intent).toBe('Type "****" into the Password field');
    const pwAfter = (await readTraceAsset(runDirSource(dir), pw.snapshots.after!.path)).toString('utf8');
    expect(pwAfter).toMatch(/id="password"[^>]*value="" data-ez-redacted="1"/);

    // No trace file anywhere contains the password in any encoding.
    const traceFiles = await filesUnder(join(dir, 'trace'));
    expect(traceFiles.length).toBeGreaterThan(10);
    for (const f of traceFiles) assertNoSecret(await textOf(f), relative(dir, f));

    // Every trace file is in the hash-chained evidence manifest, and the chain verifies.
    const entries = await manifest(dir);
    const paths = new Set(entries.map((e) => e.path));
    for (const f of traceFiles) expect(paths.has(relative(dir, f).split('\\').join('/')), relative(dir, f)).toBe(true);
    expect(j.evidence).toContain(entries.find((e) => e.path === 'trace/bob-order-1/trace.json')!.id);
    const v = await verifyEvidence(dir);
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);

    // Rendered snapshot: self-contained, no scripts, target outlined, form state kept.
    const typed = t.steps.find((s) => s.stepId === 'type-bob-into-the-username-field')!;
    const html = await renderSnapshot(runDirSource(dir), t, typed.snapshots.after!);
    expect(html).toContain('Content-Security-Policy');
    expect(html).toMatch(/id="username"[^>]*value="bob"/);
    expect(html).toContain(`[data-ez-nid="${typed.snapshots.after!.target!.nid}"]`);
    expect(html.toLowerCase()).not.toContain('<script');
    // Inline <style> of the demo page survived.
    expect(html).toContain('border-collapse');

    // Standalone bundle round-trip, integrity checked.
    const zip = await exportTraceBundle(dir, 'bob-order', 1);
    const opened = readTraceBundle(zip);
    expect(opened.problems).toEqual([]);
    expect(opened.trace.steps).toHaveLength(t.steps.length);
    const fromBundle = await renderSnapshot(opened.source, opened.trace, typed.snapshots.after!);
    expect(fromBundle).toBe(html);
    assertNoSecret(zip.toString('latin1'), 'bundle');
    // Tampering is detected.
    const files = readZip(zip);
    const tracePath = 'trace/bob-order-1/trace.json';
    files.set(tracePath, Buffer.from(files.get(tracePath)!.toString('utf8').replace('"passed"', '"failed"')));
    const tampered = writeZip([...files].map(([name, data]) => ({ name, data })));
    expect(readTraceBundle(tampered).problems).toEqual([`altered ${tracePath}`]);
  });

  it('masks configured secrets and records console messages and page errors', async () => {
    const out = await tempDir('tt-console');
    const masker = new SecretMasker();
    masker.add('ORD-SECRET-TOKEN-42');
    const j = parseEzScript(`Journey: Console
Open /login
Run step "noise"`);
    const run = await runJourneys([j], {
      ...FAST, baseUrl: server.url, outputDir: out, timeTravel: { enabled: true, masker, screenshots: false },
      customSteps: {
        noise: async (page) => {
          await page.evaluate(() => {
            console.log('token is ORD-SECRET-TOKEN-42');
            setTimeout(() => {
              throw new Error('boom from page');
            }, 0);
          });
          await page.waitForTimeout(100);
        },
      },
    });
    const t = await readTrace(runDirOf(out, run), j.id, 1);
    const noise = t.steps[1];
    expect(noise.console.map((c) => [c.type, c.text])).toEqual([['log', 'token is ****'], ['pageerror', 'Error: boom from page']]);
    expect(noise.screenshot).toBeUndefined();
    for (const f of await filesUnder(join(runDirOf(out, run), 'trace'))) expect(await textOf(f)).not.toContain('ORD-SECRET-TOKEN-42');
  });

  it('serializes shadow DOM, same-origin iframes, scroll, form state; strips scripts and handlers', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<!doctype html><html><head><style>.x{color:red}</style><script>window.__x = 1</script></head>
<body onload="alert(1)"><div id="host"></div>
<input id="pw" type="password" value="hunter22"><input id="name" value="initial"><input id="cb" type="checkbox">
<select id="sel"><option value="a">A</option><option value="b">B</option></select><textarea id="ta">t</textarea>
<a id="js" href="javascript:alert(1)" onclick="evil()">x</a>
<div id="scroller" style="height:50px;overflow:auto"><div style="height:500px">tall</div></div>
<iframe id="fr" srcdoc="<p id=inner>inside frame</p><script>1</script>"></iframe>
<script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML = '<button id=shadowbtn>Shadow button</button>';</script>
</body></html>`);
      await page.fill('#name', 'typed value');
      await page.check('#cb');
      await page.selectOption('#sel', 'b');
      await page.fill('#ta', 'area text');
      await page.locator('#scroller').evaluate((el) => (el.scrollTop = 120));
      await page.waitForFunction(() => !!(document.getElementById('fr') as HTMLIFrameElement).contentDocument?.getElementById('inner'));
      const handle = await page.$('#host');
      const snap = await serializePage(page, handle);
      expect(snap.html).not.toMatch(/<script/i);
      expect(snap.html).not.toMatch(/\son(load|click)=/i);
      expect(snap.html).not.toContain('javascript:');
      expect(snap.html).not.toContain('hunter22');
      expect(snap.html).toMatch(/id="pw"[^>]*value="" data-ez-redacted="1"/);
      expect(snap.html).toMatch(/id="name"[^>]*value="typed value"/);
      expect(snap.html).toMatch(/id="cb"[^>]*checked/);
      expect(snap.html).toMatch(/<option[^>]*value="b" selected>B<\/option>/);
      expect(snap.html).toContain('area text</textarea>');
      expect(snap.html).toMatch(/id="scroller"[^>]*data-ez-scroll="0,120"/);
      expect(snap.html).toContain('<template shadowrootmode="open">');
      expect(snap.html).toContain('Shadow button');
      expect(snap.html).toMatch(/srcdoc="[^"]*inside frame/);
      expect(snap.html).not.toMatch(/srcdoc="[^"]*&lt;script/);
      expect(snap.target?.tag).toBe('div');
      expect(snap.viewport.width).toBeGreaterThan(0);
      expect(snap.text).toContain('tall');
    } finally {
      await page.close();
    }
  });

  it('diffs a normal run against a variant-b run of the same journey', async () => {
    const out = await tempDir('tt-diff');
    const store = join(out, 'fingerprints.json');
    const j = parseEzScript(`Journey: Sign in
Id: sign-in
Open /login
Type "bob" into the Username field
Type "Builder#2" into the Password field
Click the "Sign in" button
  Expect the URL contains "/dashboard"`);
    const runA = await runJourneys([j], { ...FAST, baseUrl: server.url, outputDir: out, fingerprintStore: store, healer: createHealer(), timeTravel: { enabled: true } });
    expect(runA.journeys[0].status).toBe('passed');
    const b = await startDemoApp({ variant: 'b' });
    let runB;
    try {
      runB = await runJourneys([j], { ...FAST, baseUrl: b.url, outputDir: out, fingerprintStore: store, healer: createHealer(), timeTravel: { enabled: true } });
    } finally {
      await b.close();
    }
    expect(runB.journeys[0].status).toBe('passed-healed');
    const ta = await readTrace(runDirOf(out, runA), 'sign-in', 1);
    const tb = await readTrace(runDirOf(out, runB), 'sign-in', 1);
    const d = diffTraces(ta, tb);
    expect(d.journeyId).toBe('sign-in');
    const click = d.steps.find((s) => s.stepId === 'click-the-sign-in-button')!;
    expect(click.status).toMatchObject({ a: 'passed', b: 'passed-healed', changed: true });
    expect(click.locator).toMatchObject({ a: 'role=button "Sign in"', b: 'role=button "Log in"', changed: true, healTier: { b: 'T1-fingerprint' } });
    expect(click.text.changed).toBe(true);
    expect(click.text.removed).toEqual(['Username', 'Sign']);
    expect(click.text.added).toEqual(['Email or username', 'Log']);
    expect(click.timing.deltaMs).toBeTypeOf('number');
    // The healed step's trace carries the ladder attempts with scores.
    const tbClick = tb.steps.find((s) => s.stepId === 'click-the-sign-in-button')!;
    expect(tbClick.heal?.attempts[0]).toMatchObject({ tier: 'T1-fingerprint', matches: 1 });
    expect(tbClick.heal?.attempts[0].confidence).toBeGreaterThan(0.7);
    expect(tbClick.locator.tried.every((x) => x.count === 0)).toBe(true);
    expect(d.summary.statusChanges).toEqual(expect.arrayContaining(['click-the-sign-in-button', 'type-bob-into-the-username-field']));
    // The login page itself already differs (renamed label and button): the first divergence.
    expect(d.summary.firstDivergence).toEqual({ stepId: 'open-login', reasons: ['page text changed'] });
    const open = d.steps.find((s) => s.stepId === 'open-login')!;
    expect(open.status.changed).toBe(false);
    expect(open.url.changed).toBe(false);
    expect(open.network.added).toEqual([]);
    expect(open.network.removed).toEqual([]);
  });

  it('opens a browser trace zip (context.tracing, EZTest browser trace format) in the time-travel model, secrets masked', async () => {
    const out = await tempDir('tt-browser');
    const context = await browser.newContext();
    await context.tracing.start({ screenshots: true, snapshots: true, title: 'browser login' });
    const page = await context.newPage();
    await page.goto(`${server.url}/login`);
    await page.evaluate(() => console.log('ez-trace-console-mark'));
    await page.getByLabel('Username').fill('bob');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/dashboard/);
    const zipPath = join(out, 'trace.zip');
    await context.tracing.stop({ path: zipPath });
    await context.close();

    const opened = await readBrowserTrace(zipPath);
    expect(opened.problems).toEqual([]);
    const t = opened.trace;
    expect(t.source).toBe('browser');
    // The browser that actually ran (Chromium, or Firefox with EZTEST_BROWSER=firefox).
    expect(t.browser).toBe(browser.browserType().name());
    expect(opened.manifest.browser).toBe(browser.browserType().name());
    expect(t.journeyName).toBe('browser login');
    expect(t.steps.map((s) => s.action)).toEqual(expect.arrayContaining(['goto', 'fill', 'click']));
    const fillUser = t.steps.find((s) => s.action === 'fill' && s.value === 'bob')!;
    expect(fillUser.snapshots.before).toBeDefined();
    expect(fillUser.snapshots.after).toBeDefined();
    const afterHtml = (await opened.source.read(fillUser.snapshots.after!.path)).toString('utf8');
    expect(afterHtml).toMatch(/id="username"[^>]*value="bob"/);
    expect(fillUser.snapshots.after!.target?.nid).toBeGreaterThan(0);
    expect(t.steps.filter((s) => s.action === 'fill').map((s) => s.value)).toEqual(['bob', '****']);
    const click = t.steps.find((s) => s.action === 'click')!;
    // The form post belongs to the click (or, when the browser sends it after the click returned, to the wait that follows).
    const posted = t.steps.slice(click.index, click.index + 2).some((s) => s.network.some((n) => n.method === 'POST' && n.url.endsWith('/login')));
    expect(posted).toBe(true);
    // Navigation traffic belongs to goto; the console message to the step it followed; nothing is lost.
    const goto = t.steps.find((s) => s.action === 'goto')!;
    expect(goto.network.some((n) => n.method === 'GET' && n.url.endsWith('/login') && n.status === 200)).toBe(true);
    const logged = t.steps.filter((s) => s.console.some((c) => c.text === 'ez-trace-console-mark'));
    expect(logged).toHaveLength(1);
    expect(logged[0].index).toBeGreaterThanOrEqual(goto.index);
    expect(logged[0].index).toBeLessThan(fillUser.index);
    expect(t.unattributed.console.filter((c) => c.text === 'ez-trace-console-mark')).toEqual([]);
    // Every action has a before snapshot; goto and fill an after one (a click that navigates may have none: the page is going away).
    expect(t.steps.filter((s) => !s.snapshots.before).map((s) => s.action)).toEqual([]);
    expect(t.steps.filter((s) => (s.action === 'goto' || s.action === 'fill') && !s.snapshots.after).map((s) => s.action)).toEqual([]);
    expect(t.steps.some((s) => s.screenshot?.viewportJpeg)).toBe(true);
    const html = await renderSnapshot(opened.source, t, click.snapshots.before!);
    expect(html).toContain('Sign in');
    expect(html.toLowerCase()).not.toContain('<script');
    // The password never survives into the viewer's model.
    assertNoSecret(JSON.stringify(t), 'browser trace.json');
    for (const s of t.steps) {
      for (const ref of [s.snapshots.before, s.snapshots.after]) if (ref) assertNoSecret((await opened.source.read(ref.path)).toString('utf8'), ref.path);
      for (const n of s.network) assertNoSecret(JSON.stringify(n), 'network');
    }
    // Integrity: an altered file is reported against the manifest's SHA-256 list.
    const files = readZip(await readFile(zipPath));
    files.set('actions.jsonl', Buffer.concat([files.get('actions.jsonl')!, Buffer.from('\n')]));
    const altered = await readBrowserTrace(writeZip([...files].map(([name, data]) => ({ name, data }))));
    expect(altered.problems).toEqual(['actions.jsonl was altered (SHA-256 differs from the manifest)']);
    await expect(readBrowserTrace(writeZip([{ name: 'trace.trace', data: Buffer.from('{}') }]))).rejects.toThrow(/not an EZTest browser trace/);
  });

  it('is off by default: no trace files, no extra evidence, same results', async () => {
    const out = await tempDir('tt-off');
    const run = await runJourneys([bobOrderJourney()], { ...FAST, baseUrl: server.url, outputDir: out });
    expect(run.journeys[0].status).toBe('passed');
    const entries = await manifest(runDirOf(out, run));
    expect(entries.some((e) => e.kind === 'trace' || e.path.startsWith('trace/'))).toBe(false);
    expect(await listTraces(runDirOf(out, run))).toEqual([]);
    const disabled = await runJourneys([bobOrderJourney()], { ...FAST, baseUrl: server.url, outputDir: out, timeTravel: { enabled: false } });
    expect((await manifest(runDirOf(out, disabled))).map((e) => e.kind).sort()).toEqual(entries.map((e) => e.kind).sort());
  });
});
