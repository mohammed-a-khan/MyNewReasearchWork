/**
 * Android end to end on EZTest's own stack, without a device: the ADB client
 * talks to a fake adb server (smart-socket protocol, real TCP port forwards)
 * and the forwarded agent port reaches the device-agent simulator (the EZTest
 * agent protocol over a fixture hierarchy). Journeys, verified healing,
 * gestures, device operations, evidence and the native trace.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from '../support/testkit.js';
import { verifyEvidence, type Journey, type RunResult } from '../../src/core/index.js';
import { createHealer } from '../../src/heal/index.js';
import { loadJourneyFile, parseEzScript } from '../../src/intent/index.js';
import { createMobileDriver, mobileRunOptions, type MobileDriverOptions } from '../../src/mobile/index.js';
import { listTraces, loadCodeJourneys, readTrace, renderSnapshot, runDirSource, runJourneys, SUSPECTED_REGRESSION, type RunOptions } from '../../src/runner/index.js';
import { AgentSimulator } from './agent-sim.js';
import { featureJourneys } from '../../src/bdd/index.js';
import { FakeAdbServer } from './fake-adb.js';

const FIX = resolve(__dirname, 'fixtures');
const SHOP = readFileSync(join(FIX, 'shop-android.xml'), 'utf8');
const SHOP_V2 = SHOP.replace('com.shop.app:id/loginBtn', 'com.shop.app:id/signInBtn');
const SHOP_REGRESSED = SHOP_V2.replace(' ez-alert="Signed in as {username}"', '');

let adb: FakeAdbServer;
let sim: AgentSimulator;
let sim2: AgentSimulator | undefined;
let shellLog: string[];
const tmp = () => mkdtempSync(join(tmpdir(), 'ez-android-'));

beforeEach(async () => {
  adb = new FakeAdbServer();
  sim = new AgentSimulator(SHOP);
  shellLog = [];
  adb.shell = (_serial, cmd) => {
    shellLog.push(cmd);
    if (cmd.startsWith('pm path io.eztest.agent')) return 'package:/data/app/io.eztest.agent/base.apk\n';
    if (cmd.startsWith('am instrument')) {
      // Like the real agent: it answers only requests carrying the token it was started with.
      const token = /-e token (\S+)/.exec(cmd)?.[1];
      if (_serial === 'emulator-5556' && sim2) sim2.token = token;
      else sim.token = token;
      return { stream: true, output: 'INSTRUMENTATION_STATUS: eztest=started\n' };
    }
    if (cmd.startsWith('monkey')) return 'Events injected: 1\n';
    return '';
  };
  await adb.start();
  adb.targets.set('tcp:6790', await sim.start());
});
afterEach(async () => {
  await sim.stop();
  await adb.stop();
});

const driverFor = (extra: Partial<MobileDriverOptions> = {}) => createMobileDriver({ android: { adb: { port: adb.port } }, launchSettleMs: 0, ...extra });
async function run(journeys: Journey[], extra: Partial<RunOptions> = {}, driverOpts: Partial<MobileDriverOptions> = {}, out = tmp()): Promise<RunResult> {
  return runJourneys(journeys, {
    outputDir: out, fingerprintStore: join(out, 'fingerprints.json'), healer: createHealer(), stepTimeoutMs: 3000, locateTimeoutMs: 300, conditionTimeoutMs: 800,
    platformDrivers: [driverFor(driverOpts)], ...extra,
  });
}
const statuses = (r: RunResult) => r.journeys[0].steps.map((s) => `${s.status}${s.error ? ` ${s.error.message}` : ''}`);

describe('Android journeys on the EZTest agent', () => {
  it('runs a plain-English .ez journey: agent started over adb, app launched, steps verified', async () => {
    const j = await loadJourneyFile(join(FIX, 'mobile-login.ez'));
    const out = tmp();
    const r = await run([j], {}, {}, out);
    const jr = r.journeys[0];
    expect(statuses(r)).toEqual(j.steps.map(() => 'passed'));
    expect(jr.status).toBe('passed');
    expect(jr.browser).toBe('android (Simulated Pixel)');
    expect(jr.ledger.firstOrder).toBe('ORD-1001 Shipped');
    // The agent was started by instrumentation over adb, reached through a forward, and the app launched by adb.
    expect(shellLog.find((c) => c.startsWith('am instrument'))).toMatch(/^am instrument -w -e port 6790 -e token [0-9a-f]{48} io\.eztest\.agent\/\.AgentInstrumentation$/);
    // Every request carried the session token; one without it is refused.
    expect(sim.token).toMatch(/^[0-9a-f]{48}$/);
    expect(sim.refused).toBe(0);
    const anon = await fetch(`http://127.0.0.1:${sim.port}/status`);
    expect(anon.status).toBe(401);
    expect(await anon.json()).toMatchObject({ error: { code: 'unauthorized' } });
    expect(adb.services.some((s) => /^host-serial:emulator-5554:forward:tcp:\d+;tcp:6790$/.test(s))).toBe(true);
    expect(shellLog).toContain("am force-stop 'com.shop.app'");
    expect(shellLog).toContain("monkey -p 'com.shop.app' -c android.intent.category.LAUNCHER 1");
    // The username was typed through the agent, the alert accepted, the device rotated and back.
    expect(sim.byId('username')?.attrs.text).toBe('alice');
    expect(sim.orientationValue).toBe('portrait');
    expect(sim.requests.filter((q) => q.path === '/orientation' && q.method === 'POST').map((q) => (q.body as { value: string }).value)).toEqual(['landscape', 'portrait']);
    // The agent connection is closed (and the forward removed) when the run ends.
    expect(sim.shutdowns).toBe(1);
    expect(adb.forwards.size).toBe(0);
    expect(r.environment).toMatchObject({ browser: 'none', mobileDriver: 'eztest (ADB + EZTest agents)' });
    expect((await verifyEvidence(join(out, r.runId))).ok).toBe(true);
  });

  it('finds elements by accessibility id, then exact text, then XPath over the hierarchy', async () => {
    const r = await run([parseEzScript('Journey: Finders\nPlatform: android\nApp: "com.shop.app"\nTap the "Log in" button\nTap the Map image\nTap id=helpBtn\nTap ~Username\n')]);
    expect(statuses(r)).toEqual(['passed', 'passed', 'passed', 'passed']);
    const finds = sim.requests.filter((q) => q.path === '/find').map((q) => q.body as { using: string; value: string });
    expect(finds.slice(0, 2)).toEqual([{ using: 'accessibility id', value: 'Log in' }, { using: 'text', value: 'Log in' }]);
    expect(finds).toContainEqual({ using: 'accessibility id', value: 'Map' });
    expect(finds).toContainEqual({ using: 'id', value: 'helpBtn' });
    expect(r.journeys[0].steps.map((s) => s.usedLocator?.strategy)).toEqual(['role', 'role', 'id', 'accessibilityId']);
  });

  it('heals a changed id (T1 fingerprint, verified), reuses it from the T0 cache and refuses an unverifiable heal', async () => {
    const j = parseEzScript('Journey: Sign in by id\nPlatform: android\nApp: "com.shop.app"\nTap id=loginBtn\n  Expect an alert saying "Signed in"\n');
    const out = tmp();
    const store = join(out, 'fp.json');
    expect((await run([j], { fingerprintStore: store }, {}, out)).journeys[0].status).toBe('passed');

    sim.load(SHOP_V2);
    sim.alert = undefined;
    const second = await run([j], { fingerprintStore: store }, {}, out);
    const step = second.journeys[0].steps[0];
    expect(step.status).toBe('passed-healed');
    expect(step.heal).toMatchObject({ tier: 'T1-fingerprint', verified: true, healed: { strategy: 'id', value: 'com.shop.app:id/signInBtn' }, original: [{ strategy: 'id', value: 'loginBtn' }] });
    const dir = join(out, second.runId);
    const proposals = JSON.parse(readFileSync(join(dir, 'heal-proposals.json'), 'utf8')) as { proposals: Array<{ healed: unknown }> };
    expect(proposals.proposals[0].healed).toEqual({ strategy: 'id', value: 'com.shop.app:id/signInBtn' });
    expect(readFileSync(join(dir, 'evidence-manifest.jsonl'), 'utf8')).toMatch(/tap-id-loginbtn\.source\.xml/);
    expect(step.heal!.evidence).toHaveLength(2);

    sim.alert = undefined;
    const third = await run([j], { fingerprintStore: store }, {}, out);
    expect(third.journeys[0].steps[0].heal).toMatchObject({ tier: 'T0-cache', verified: true });

    // A regressed build: the renamed button no longer signs in. The heal is tried and refused.
    const fresh = join(out, 'fp-regressed.json');
    sim.load(SHOP);
    sim.alert = undefined;
    await run([j], { fingerprintStore: fresh }, {}, out);
    sim.load(SHOP_REGRESSED);
    sim.alert = undefined;
    const bad = await run([j], { fingerprintStore: fresh }, {}, out);
    expect(bad.journeys[0].status).toBe('failed');
    expect(bad.journeys[0].steps[0].heal?.verified).toBe(false);
    expect(bad.journeys[0].steps[0].error?.message).toContain(SUSPECTED_REGRESSION);
  });

  it('heals a renamed button by its description (T2 semantic) when nothing was recorded', async () => {
    sim.load(SHOP.replace('text="Log in"', 'text="Log In now"'));
    const r = await run([parseEzScript('Journey: Semantic\nPlatform: android\nApp: "com.shop.app"\nTap the "Log In" button\n  Expect an alert saying "Signed in"\n')]);
    expect(r.journeys[0].steps[0]).toMatchObject({ status: 'passed-healed', heal: { tier: 'T2-semantic', verified: true, healed: { strategy: 'id', value: 'com.shop.app:id/loginBtn' } } });
  });

  it('performs gestures as finger paths and scrolls until an element is on screen', async () => {
    const j = parseEzScript(`Journey: Gestures
Platform: android
App: "com.shop.app"
Tap at 120, 640
Long press the Map image for 1 second
Pinch out on the Map image
Zoom out on the Map image
Double-tap the "Orders" button
Swipe from 900, 300 to 100, 300
Drag the "Orders" button to the "Help" button
Swipe up until "Settings" is visible
  Expect "Settings" is visible
Tap "Settings"
`);
    const out = tmp();
    const r = await run([j], {}, {}, out);
    expect(statuses(r)).toEqual(j.steps.map(() => 'passed'));
    expect(sim.gestures.map((g) => g.fingers.length)).toEqual([1, 1, 2, 2, 2, 1, 1, 1]);
    expect(sim.gestures[1].fingers[0].at(-1)!.t).toBe(1000);
    const swipeUntil = r.journeys[0].steps[7];
    expect(swipeUntil.captured).toEqual({ swipes: 1 });
    const gestures = JSON.parse(readFileSync(join(out, r.runId, 'journeys', 'gestures', 'attempt-1', 'gestures.json'), 'utf8')) as Array<{ op: string }>;
    expect(gestures.map((g) => g.op)).toEqual(['tapAt', 'longPress', 'pinch', 'pinch', 'doubleTap', 'swipe', 'drag', 'swipeUntil']);

    const r2 = await run([parseEzScript('Journey: Hidden\nPlatform: android\nApp: "com.shop.app"\nSwipe down until "Promo" is visible at most 2 times\n')]);
    expect(r2.journeys[0].steps[0].error?.message).toContain('"Promo" is not visible after 2 swipe(s) down');
  });

  it('runs device operations through adb and the agent', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'photo.jpg'), 'JPEG');
    adb.files.set('/sdcard/Download/report.txt', { data: Buffer.from('report body'), mode: 0o100644, mtime: 1 });
    const j = parseEzScript(`Journey: Device
Platform: android
App: "com.shop.app"
Press the device home button
Press the device back button
Open the deep link "shop://orders/42"
Open "shop://cart"
Grant the app permission "android.permission.CAMERA", "RECORD_AUDIO"
Turn on airplane mode
Go offline
Lock the device
Unlock the device
Open the notifications
Push file "photo.jpg" to "/sdcard/Pictures/photo.jpg"
Pull file "/sdcard/Download/report.txt" from the device as report
Uninstall the app "com.other"
Restart the app
Hide the keyboard
Press Enter
Accept the next dialog
Tap the "Log in" button
`);
    const out = tmp();
    const r = await run([j], {}, { baseDir: dir }, out);
    expect(statuses(r)).toEqual(j.steps.map(() => 'passed'));
    expect(sim.keys).toEqual(['home', 'back', 'enter']);
    expect(shellLog).toEqual(expect.arrayContaining([
      "am start -W -a android.intent.action.VIEW -d 'shop://orders/42' 'com.shop.app'",
      "am start -W -a android.intent.action.VIEW -d 'shop://cart' 'com.shop.app'",
      "pm grant 'com.shop.app' 'android.permission.CAMERA'",
      "pm grant 'com.shop.app' 'android.permission.RECORD_AUDIO'",
      'cmd connectivity airplane-mode enable',
      'svc wifi disable', 'svc data disable',
      'input keyevent 26', 'input keyevent 224 && wm dismiss-keyguard',
      'cmd statusbar expand-notifications',
      "pm uninstall 'com.other'",
    ]));
    expect(adb.files.get('/sdcard/Pictures/photo.jpg')?.data.toString()).toBe('JPEG');
    expect(r.journeys[0].ledger.report).toMatchObject({ remotePath: '/sdcard/Download/report.txt', size: 11 });
    // "Accept the next dialog" armed before the tap that raised the alert; it was accepted after the tap.
    expect(sim.alert).toBeUndefined();
    expect(r.journeys[0].ledger.lastDialog).toEqual({ text: 'Signed in as ', handled: 'accepted' });
    const pulled = readFileSync(join(out, r.runId, 'evidence-manifest.jsonl'), 'utf8');
    expect(pulled).toMatch(/downloads\/device\/pull-file-.*report\.txt/);
  });

  it('keeps screenshots, page source and a native time-travel trace as hash-chained evidence', async () => {
    const out = tmp();
    const r = await run([parseEzScript('Journey: Evidence\nPlatform: android\nApp: "com.shop.app"\nType "alice" into the Username field\nTap the "Missing" button\n')], { screenshots: 'every-step', timeTravel: { enabled: true } }, { logs: ['logcat'] }, out);
    const dir = join(out, r.runId);
    expect(r.journeys[0].status).toBe('failed');
    expect(r.journeys[0].steps[1].error?.message).toContain('no locator candidate matched exactly one element for the "Missing" button');
    const entries = readFileSync(join(dir, 'evidence-manifest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; path: string });
    const of = (k: string) => entries.filter((e) => e.kind === k).map((e) => e.path);
    expect(of('screenshot')).toHaveLength(2);
    expect(of('dom')).toEqual(['journeys/evidence/attempt-1/tap-the-missing-button.source.xml']);
    expect(of('data')).toContain('journeys/evidence/attempt-1/device.json');
    expect(of('log')).toEqual(expect.arrayContaining(['journeys/evidence/attempt-1/agent-commands.json', 'journeys/evidence/attempt-1/device-logcat.txt']));
    expect(shellLog).toContain('logcat -d -v threadtime -t 2000');
    expect((await verifyEvidence(dir)).ok).toBe(true);

    expect(await listTraces(dir)).toHaveLength(1);
    const t = await readTrace(dir, 'evidence', 1);
    expect(t.browser).toBe('android');
    expect(t.steps.map((s) => s.status)).toEqual(['passed', 'failed']);
    const typed = t.steps[0];
    expect(typed.snapshots.after?.engine).toBe('native-source');
    expect(typed.snapshots.after?.target?.box).toEqual({ x: 40, y: 220, width: 1000, height: 120 });
    const html = await renderSnapshot(runDirSource(dir), t, typed.snapshots.after!);
    expect(html).toContain('src="data:image/png;base64,');
    expect(html).toContain(`[data-ez-nid="${typed.snapshots.after!.target!.nid}"]{outline`);
    expect(gunzipSync(readFileSync(join(dir, typed.snapshots.after!.path))).toString()).toContain('android.widget.EditText');
  });
});

describe('code journeys (eztest/sdk) on Android', () => {
  it('runs ui.* calls on the device: strict targets, post-conditions, device screenshot', async () => {
    const journeys = await loadCodeJourneys(join(FIX, 'shop.journey.ts'), { cwd: tmp() });
    expect(journeys[0]).toMatchObject({ platform: 'android', app: 'com.shop.app' });
    const out = tmp();
    const r = await run(journeys, {}, {}, out);
    const jr = r.journeys[0];
    expect(jr.error, JSON.stringify(jr.steps, null, 1)).toBeUndefined();
    expect(jr.status).toBe('passed');
    expect(sim.byId('username')?.attrs.text).toBe('alice');
    expect(sim.requests.some((q) => q.path === '/find')).toBe(true);
    expect(readFileSync(join(out, r.runId, 'evidence-manifest.jsonl'), 'utf8')).toMatch(/code\/after-login\.png/);
  });
});

describe('Gherkin features (eztest/bdd) on Android', () => {
  it('runs a scenario on the device: EZTest phrasings and step definitions as native steps', async () => {
    const file = join(FIX, 'shop-mobile.feature');
    const journeys = featureJourneys(readFileSync(file, 'utf8'), file, { cwd: FIX, glue: [join(FIX, 'shop-mobile.steps.ts')] });
    expect(journeys[0]).toMatchObject({ id: 'shop-mobile--sign-in-on-the-device', platform: 'android', app: 'com.shop.app' });
    const out = tmp();
    const r = await run(journeys, {}, {}, out);
    const jr = r.journeys[0];
    expect(jr.status, JSON.stringify(jr.steps, null, 1)).toBe('passed');
    expect(jr.browser).toBe('android (Simulated Pixel)');
    expect(jr.bdd).toMatchObject({ feature: { name: 'Mobile sign-in' }, scenario: { name: 'Sign in on the device' } });
    const steps = jr.steps.filter((s) => s.gherkin?.kind === 'step');
    expect(steps.map((s) => [s.intent, s.gherkin?.match])).toEqual([
      ['When I type "alice" into the Username field', 'ez'],
      ['And I sign in on the device', 'definition'],
      ['Then the status reads "Ready"', 'definition'],
      ['And the screen contains "ORD-"', 'ez'],
    ]);
    // The phrasing typed through the agent; the definition's ui.* calls ran on the device.
    expect(sim.byId('username')?.attrs.text).toBe('alice');
    expect(steps[1].children!.map((c) => c.intent)).toEqual(expect.arrayContaining([expect.stringMatching(/Log in/)]));
    expect(readFileSync(join(out, r.runId, 'evidence-manifest.jsonl'), 'utf8')).toMatch(/code\/after-sign-in\.png/);
  });
});

describe('Android setup and failure paths', () => {
  it('installs the agent APK over adb (sync push + pm install) when it is missing', async () => {
    const dir = tmp();
    const apk = join(dir, 'eztest-agent.apk');
    writeFileSync(apk, 'APK');
    let installed = false;
    const base = adb.shell;
    adb.shell = (serial, cmd) => {
      if (cmd.startsWith('pm path io.eztest.agent')) return installed ? 'package:/x' : { output: '', exit: 1 };
      if (cmd.startsWith('pm install')) { installed = true; shellLog.push(cmd); return 'Success\n'; }
      return base(serial, cmd);
    };
    const r = await run([parseEzScript('Journey: Install\nPlatform: android\nApp: "com.shop.app"\nTap the "Log in" button\n')], {}, { android: { adb: { port: adb.port }, agentApk: apk } });
    expect(r.journeys[0].status).toBe('passed');
    expect(shellLog).toContain("pm install -r -g '/data/local/tmp/eztest-agent.apk'");
    expect(shellLog).toContain("rm -f '/data/local/tmp/eztest-agent.apk'");
  });

  it('explains how to get the agent when it is missing and no APK is available', async () => {
    adb.shell = (_s, cmd) => (cmd.startsWith('pm path') ? { output: '', exit: 1 } : '');
    const r = await run([parseEzScript('Journey: No agent\nPlatform: android\nApp: "com.shop.app"\nTap the "Log in" button\n')]);
    expect(r.journeys[0].status).toBe('error');
    expect(r.journeys[0].error?.message).toContain('eztest mobile build-agent');
  });

  it('reports no attached device, an unknown serial and an unreachable adb server', async () => {
    adb.devices = [{ serial: 'emulator-5554', state: 'offline' }];
    const r = await run([parseEzScript('Journey: Offline\nPlatform: android\nTap the "Log in" button\n')]);
    expect(r.journeys[0].error?.message).toMatch(/no Android device is attached and online \(adb: emulator-5554 \(offline\)\)/);
    const r2 = await run([parseEzScript('Journey: Serial\nPlatform: android\nCapabilities: serial="R58M123"\nTap the "Log in" button\n')], {}, { android: { adb: { port: adb.port }, devices: ['R58M123'] } });
    expect(r2.journeys[0].error?.message).toContain('Android device "R58M123" is not attached');
    const r3 = await run([parseEzScript('Journey: No adb\nPlatform: android\nTap the "Log in" button\n')], {}, { android: { adb: { port: 9 } } });
    expect(r3.journeys[0].error?.message).toMatch(/cannot reach the adb server at 127\.0\.0\.1:9/);
  });

  it('an operation the agent does not support fails the step as not supported', async () => {
    const r = await run([parseEzScript('Journey: Geo\nPlatform: android\nApp: "com.shop.app"\nSet the geolocation to 52.52, 13.405\nShake the device\n')]);
    expect(statuses(r)[0]).toMatch(/^failed Not supported: setting the location/);
  });

  it('a non-web journey without a configured driver is an error naming the fix', async () => {
    const r = await runJourneys([parseEzScript('Journey: X\nPlatform: android\nTap the "Log in" button\n')], { outputDir: tmp() });
    expect(r.journeys[0]).toMatchObject({ status: 'error', error: { name: 'NoPlatformDriver' } });
  });

  it('spreads concurrent journeys over a device pool, one agent per device', async () => {
    sim2 = new AgentSimulator(SHOP);
    adb.devices.push({ serial: 'emulator-5556', state: 'device' });
    adb.targets.set('emulator-5556|tcp:6790', await sim2.start());
    try {
      const js = [1, 2, 3, 4].map((i) => parseEzScript(`Journey: P${i}\nPlatform: android\nApp: "com.shop.app"\nTap the "Orders" button\n  Expect the text of id=status is "Showing orders"\n`));
      const r = await runJourneys(js, {
        outputDir: tmp(), concurrency: 2, platformDrivers: [driverFor({ android: { adb: { port: adb.port }, devices: ['emulator-5554', 'emulator-5556'] } })],
      });
      expect(r.journeys.map((x) => x.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
      expect(sim.requests.some((q) => q.path === '/find')).toBe(true);
      expect(sim2.requests.some((q) => q.path === '/find')).toBe(true);
      expect(adb.services.filter((s) => s.startsWith('shell:am instrument'))).toHaveLength(2);
      // One random token per agent session.
      expect(sim.token).toMatch(/^[0-9a-f]{48}$/);
      expect(sim2.token).toMatch(/^[0-9a-f]{48}$/);
      expect(sim2.token).not.toBe(sim.token);
      expect(sim.refused + sim2.refused).toBe(0);
    } finally {
      await sim2.stop();
      sim2 = undefined;
    }
  });

  it('builds the driver from a mobile: config block', () => {
    const o = mobileRunOptions({ platform: 'android', app: 'com.shop.app', android: { adb: { port: 5038 }, devices: ['a', 'b'] }, logs: ['logcat'] });
    expect(o.platform).toBe('android');
    expect(o.platformDrivers[0].environment()).toMatchObject({ androidAdb: '127.0.0.1:5038' });
    expect(() => mobileRunOptions({ cloud: { provider: 'x' } })).toThrow(/mobile: \(root\): Unrecognized key/);
  });
});
