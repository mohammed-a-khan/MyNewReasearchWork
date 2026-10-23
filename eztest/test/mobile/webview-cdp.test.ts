/**
 * Hybrid apps: the WebView bridge against a real Chromium DevTools endpoint.
 * The fake adb server reports a `webview_devtools_remote_<pid>` socket in
 * /proc/net/unix and forwards it (as `adb forward ... localabstract:...` does
 * on a device) to a headless Chromium's DevTools port; the journey switches
 * from the native app into the web view and back.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findChromium } from '../../src/browser/launcher/find.js';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createHealer } from '../../src/heal/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { createMobileDriver } from '../../src/mobile/index.js';
import { runJourneys } from '../../src/runner/index.js';
import { AgentSimulator } from './agent-sim.js';
import { FakeAdbServer } from './fake-adb.js';

// A real Chromium binary (also when the suite runs on Firefox: the web view side is always Chromium).
const exe = (() => {
  try {
    return findChromium().executablePath;
  } catch {
    return '/nonexistent';
  }
})();
const PAGE = `<!doctype html><title>Help center</title><h1>How can we help?</h1>
<input placeholder="Search" id="q"><button onclick="document.getElementById('result').textContent='Results for '+document.getElementById('q').value">Search</button>
<p id="result"></p>`;

describe.skipIf(!existsSync(exe))('web views over the DevTools socket (real Chromium)', () => {
  let browser: ChildProcess;
  let devtoolsPort = 0;
  let profile: string;
  beforeAll(async () => {
    profile = mkdtempSync(join(tmpdir(), 'ez-wv-profile-'));
    browser = spawn(exe, ['--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `data:text/html,${encodeURIComponent(PAGE)}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    devtoolsPort = await new Promise<number>((res, rej) => {
      let err = '';
      const t = setTimeout(() => rej(new Error(`Chromium did not start: ${err}`)), 20_000);
      browser.stderr!.on('data', (d: Buffer) => {
        err += d.toString();
        const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(err);
        if (m) {
          clearTimeout(t);
          res(Number(m[1]));
        }
      });
    });
  }, 30_000);
  afterAll(async () => {
    if (browser && browser.exitCode === null) await new Promise<void>((r) => { browser.once('exit', () => r()); browser.kill('SIGKILL'); });
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Chromium may still flush its profile; the temp dir is left behind.
    }
  });

  it('switches into the app web view, drives it, and switches back to the native app', async () => {
    const adb = new FakeAdbServer();
    const sim = new AgentSimulator(readFileSync(resolve(__dirname, 'fixtures/shop-android.xml'), 'utf8'));
    adb.shell = (_s, cmd) => {
      if (cmd.startsWith('pm path')) return 'package:/x\n';
      if (cmd.startsWith('am instrument')) return { stream: true };
      if (cmd === 'cat /proc/net/unix') return 'Num RefCount Protocol Flags Type St Inode Path\n0000000000000000: 00000002 00000000 00010000 0001 01 123456 @webview_devtools_remote_4242\n0000000000000000: 00000002 00000000 00010000 0001 01 123457 @jdwp-control\n';
      if (cmd === 'cat /proc/4242/cmdline') return 'com.shop.app\0';
      return '';
    };
    await adb.start();
    adb.targets.set('tcp:6790', await sim.start());
    adb.targets.set('localabstract:webview_devtools_remote_4242', devtoolsPort);
    const out = mkdtempSync(join(tmpdir(), 'ez-wv-'));
    try {
      const j = parseEzScript(`Journey: Hybrid help
Platform: android
App: "com.shop.app"
Tap the "Help" button
Switch to the web view
  Expect the title contains "Help center"
Type "refund" into the Search field
Tap the "Search" button
  Expect id=result contains "Results for refund"
Expect the page contains "How can we help?"
Switch to the native app
Tap the "Orders" button
  Expect the text of id=status is "Showing orders"
`);
      const r = await runJourneys([j], { outputDir: out, fingerprintStore: join(out, 'fp.json'), healer: createHealer(), locateTimeoutMs: 500, platformDrivers: [createMobileDriver({ android: { adb: { port: adb.port } }, launchSettleMs: 0 })] });
      const jr = r.journeys[0];
      expect(jr.steps.map((s) => `${s.status}${s.error ? ` ${s.error.message}` : ''}`)).toEqual(j.steps.map(() => 'passed'));
      expect(jr.steps[1].captured).toEqual({ context: 'WEBVIEW_com.shop.app' });
      expect(adb.services.some((s) => /forward:tcp:\d+;localabstract:webview_devtools_remote_4242$/.test(s))).toBe(true);
      // The web view forward is removed when the journey switches back.
      expect(adb.services.filter((s) => s.includes('killforward')).length).toBeGreaterThanOrEqual(1);
    } finally {
      await sim.stop();
      await adb.stop();
    }
  });
});
