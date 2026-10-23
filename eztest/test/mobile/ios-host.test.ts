/**
 * iOS host side against the device-agent simulator (no macOS here): a
 * simulator session (agent on the loopback, Apple's simctl for simulator
 * services, recorded through an injected tool runner) and the switch on the
 * iOS predicate finder. The Swift agent itself is untested (see docs/mobile.md).
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from '../support/testkit.js';
import { createHealer } from '../../src/heal/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { createMobileDriver, type ToolRunner } from '../../src/mobile/index.js';
import { runJourneys } from '../../src/runner/index.js';
import { AgentSimulator } from './agent-sim.js';

let sim: AgentSimulator;
let tools: string[][];
beforeEach(async () => {
  sim = new AgentSimulator(readFileSync(resolve(__dirname, 'fixtures/shop-ios.xml'), 'utf8'));
  sim.platform = 'ios';
  await sim.start();
  tools = [];
});
afterEach(async () => {
  await sim.stop();
});

const run: ToolRunner = async (cmd, args) => {
  tools.push([cmd, ...args]);
  if (args.join(' ') === 'simctl list devices booted -j') return JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{ udid: 'SIM-1234', state: 'Booted', name: 'iPhone 16' }] } });
  return '';
};

it('runs an iOS journey on a booted simulator through the EZTest agent and simctl', async () => {
  const out = mkdtempSync(join(tmpdir(), 'ez-ios-'));
  const j = parseEzScript(`Journey: iOS login
Platform: ios
App: "com.shop.ios"
Type "alice" into the Username field
  Expect the Username field has value "alice"
Turn on the "Remember me" switch
Tap the "Log in" button
  Expect an alert saying "Welcome back"
Accept the system alert
Open the deep link "shop://orders"
Grant the app permission "photos"
Set the geolocation to 52.52, 13.405
Turn off wifi
`);
  const r = await runJourneys([j], {
    outputDir: out, fingerprintStore: join(out, 'fp.json'), healer: createHealer(), locateTimeoutMs: 300,
    platformDrivers: [createMobileDriver({ ios: { simulator: true, agentPort: sim.port, run }, launchSettleMs: 0 })],
  });
  const steps = r.journeys[0].steps.map((s) => `${s.status}${s.error ? ` ${s.error.message}` : ''}`);
  expect(steps.slice(0, -1)).toEqual(j.steps.slice(0, -1).map(() => 'passed'));
  expect(steps.at(-1)).toMatch(/^failed Not supported: changing network connectivity/);
  expect(r.journeys[0].browser).toBe('ios (Simulated Pixel)');
  expect(sim.nodes.find((n) => n.attrs.name === 'remember')?.attrs.value).toBe('1');
  // NSPredicate finders are used on iOS (after the accessibility id), the switch toggled through the app model.
  const finds = sim.requests.filter((q) => q.path === '/find').map((q) => (q.body as { using: string }).using);
  expect(finds).toContain('predicate');
  expect(sim.requests.filter((q) => q.path.startsWith('/app/')).map((q) => [q.path, (q.body as { appId: string }).appId])).toEqual([['/app/terminate', 'com.shop.ios'], ['/app/launch', 'com.shop.ios']]);
  expect(tools).toEqual([
    ['xcrun', 'simctl', 'list', 'devices', 'booted', '-j'],
    ['xcrun', 'simctl', 'openurl', 'SIM-1234', 'shop://orders'],
    ['xcrun', 'simctl', 'privacy', 'SIM-1234', 'grant', 'photos', 'com.shop.ios'],
    ['xcrun', 'simctl', 'location', 'SIM-1234', 'set', '52.52,13.405'],
  ]);
});
