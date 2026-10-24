/**
 * iOS devices and simulators: the EZTest iOS agent (agents/ios, an XCTest UI
 * test bundle that serves the EZTest agent protocol from inside XCTest) for
 * the UI and app lifecycle; Apple's own tools (`xcrun simctl`, `xcrun
 * devicectl`, `xcodebuild`) only to build/launch the agent and for simulator
 * services (permissions, location, install). Real devices are reached through
 * EZTest's usbmuxd client; simulators share the host's loopback.
 *
 * UNTESTED ON APPLE HARDWARE: this environment has no macOS. The host side is
 * tested against an agent simulator and a fake usbmuxd; see docs/mobile.md.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NotSupportedError } from '../core/index.js';
import { AgentClient, newAgentToken, waitForAgent, type AgentCommandLog, type AgentStatus } from './agent.js';
import { DeviceError, type DeviceSession, type FindStrategy, type Gesture, type Rect, type WebViewInfo, type WebViewSession } from './session.js';
import { UsbmuxClient, type UsbmuxEndpoint } from './usbmux.js';

export const IOS_AGENT_PORT = 8790;

/** Runs Apple's command-line tools (argument arrays, never a shell). Injected in tests. */
export type ToolRunner = (cmd: string, args: string[]) => Promise<string>;

export const defaultToolRunner: ToolRunner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new DeviceError(`${cmd} ${args.join(' ')} failed: ${(stderr || err.message).trim().slice(0, 400)}`, 'internal'));
      else resolve(stdout);
    });
  });

export interface IosConnectOptions {
  /** Device or simulator UDID. Default: the booted simulator, else the first usbmux device. */
  udid?: string;
  /** A simulator (the agent is on the host loopback). Default: true when `udid` is a booted simulator. */
  simulator?: boolean;
  /** Agent already running and reachable at this URL. */
  agentUrl?: string;
  /** Device-side agent port. Default 8790. */
  agentPort?: number;
  /** Session token of an agent started by hand. An agent EZTest starts (xctestrun) gets a fresh random one. */
  agentToken?: string;
  /** Launch the agent with `xcodebuild test-without-building -xctestrun <file>` (built by `eztest mobile build-agent --ios`). */
  xctestrun?: string;
  usbmux?: UsbmuxEndpoint;
  agentTimeoutMs?: number;
  run?: ToolRunner;
  onCommand?: (e: AgentCommandLog) => void;
}

export class IosDevice implements DeviceSession {
  readonly platform = 'ios' as const;
  info: Record<string, unknown> = {};
  appId?: string;

  constructor(
    readonly deviceId: string,
    readonly agent: AgentClient,
    readonly simulator: boolean,
    private readonly run: ToolRunner,
    private readonly cleanup: () => Promise<void>,
    status?: AgentStatus,
  ) {
    if (status) this.info = { agent: status.agent, agentVersion: status.version, simulator, ...(status.device ?? {}) };
  }

  static async connect(o: IosConnectOptions): Promise<IosDevice> {
    const run = o.run ?? defaultToolRunner;
    const port = o.agentPort ?? IOS_AGENT_PORT;
    let udid = o.udid;
    let simulator = o.simulator;
    if (!udid && simulator !== false && !o.agentUrl) {
      const booted = await bootedSimulator(run).catch(() => undefined);
      if (booted) {
        udid = booted;
        simulator = true;
      }
    }
    let xcodebuild: ChildProcess | undefined;
    let token = o.agentToken;
    if (o.xctestrun && !o.agentUrl) {
      if (!udid) throw new DeviceError('which iOS device? set mobile.ios.udid (or boot a simulator)', 'invalid argument');
      // xcodebuild hands TEST_RUNNER_* variables to the test runner (without the prefix).
      token = newAgentToken();
      xcodebuild = spawn('xcodebuild', ['test-without-building', '-xctestrun', o.xctestrun, '-destination', `id=${udid}`], {
        stdio: 'ignore', env: { ...process.env, TEST_RUNNER_EZTEST_AGENT_PORT: String(port), TEST_RUNNER_EZTEST_AGENT_TOKEN: token },
      });
    }
    let tunnel: { port: number; close(): Promise<void> } | undefined;
    let url = o.agentUrl;
    if (!url && simulator) url = `http://127.0.0.1:${port}`;
    if (!url) {
      const mux = new UsbmuxClient(o.usbmux);
      const dev = await mux.device(udid);
      udid = dev.udid;
      tunnel = await mux.tunnel(dev.deviceId, port);
      url = `http://127.0.0.1:${tunnel.port}`;
    }
    const agent = new AgentClient({ url, onCommand: o.onCommand, ...(token ? { token } : {}) });
    const cleanup = async () => {
      await agent.call('POST', '/shutdown', {}, 3000).catch(() => undefined);
      xcodebuild?.kill();
      await tunnel?.close();
    };
    try {
      const status = await waitForAgent(agent, o.agentTimeoutMs ?? 60_000);
      return new IosDevice(udid ?? String(status.device?.udid ?? 'ios'), agent, Boolean(simulator), run, cleanup, status);
    } catch (e) {
      await cleanup();
      throw e;
    }
  }

  private simctl(...args: string[]): Promise<string> {
    if (!this.simulator) throw new NotSupportedError(`"simctl ${args[0]}" on a real iOS device`);
    return this.run('xcrun', ['simctl', ...args]);
  }

  findElements(using: FindStrategy, value: string): Promise<string[]> {
    if (using === 'css') return Promise.reject(new DeviceError('CSS selectors work in web views only', 'not supported'));
    return this.agent.find(using, value);
  }
  click(el: string) { return this.agent.click(el); }
  clear(el: string) { return this.agent.clear(el); }
  type(el: string, text: string) { return this.agent.type(el, text); }
  text(el: string) { return this.agent.text(el); }
  attribute(el: string, name: string) { return this.agent.attribute(el, name); }
  rect(el: string): Promise<Rect> { return this.agent.rect(el); }
  displayed(el: string) { return this.agent.displayed(el); }
  enabled(el: string) { return this.agent.enabled(el); }
  selected(el: string) { return this.agent.selected(el); }
  source() { return this.agent.source(); }
  screenshot() { return this.agent.screenshot(); }
  window() { return this.agent.window(); }
  gesture(g: Gesture) { return this.agent.gesture(g); }
  pressKey(key: string) { return this.agent.key(key); }
  typeText(text: string) { return this.agent.keys(text); }
  orientation() { return this.agent.orientation(); }
  setOrientation(o: 'portrait' | 'landscape') { return this.agent.setOrientation(o); }
  alertText() { return this.agent.alertText(); }
  acceptAlert() { return this.agent.acceptAlert(); }
  dismissAlert() { return this.agent.dismissAlert(); }
  hideKeyboard() { return this.agent.hideKeyboard(); }
  launchApp(appId: string) { return this.agent.app('launch', appId); }
  activateApp(appId: string) { return this.agent.app('activate', appId); }
  terminateApp(appId: string) { return this.agent.app('terminate', appId); }
  backgroundApp(seconds: number) { return this.agent.background(seconds); }
  async installApp(path: string): Promise<void> {
    if (this.simulator) await this.simctl('install', this.deviceId, path);
    else await this.run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', this.deviceId, path]);
  }
  async removeApp(appId: string): Promise<void> {
    if (this.simulator) await this.simctl('uninstall', this.deviceId, appId);
    else await this.run('xcrun', ['devicectl', 'device', 'uninstall', 'app', '--device', this.deviceId, appId]);
  }
  async deepLink(url: string): Promise<void> {
    if (this.simulator) await this.simctl('openurl', this.deviceId, url);
    else await this.agent.deepLink(url);
  }
  async pushFile(remotePath: string, data: Buffer): Promise<void> {
    if (!this.simulator) throw new NotSupportedError('pushing files to a real iOS device (no platform file service; use the app container from Xcode)');
    const m = /^@([\w.-]+)\/(.+)$/.exec(remotePath);
    if (!m) throw new DeviceError('iOS simulator paths look like "@<bundle id>/Documents/file.txt" (inside the app container)', 'invalid argument');
    const container = (await this.simctl('get_app_container', this.deviceId, m[1], 'data')).trim();
    await writeFile(join(container, m[2]), data);
  }
  async pullFile(remotePath: string): Promise<Buffer> {
    if (!this.simulator) throw new NotSupportedError('pulling files from a real iOS device');
    const m = /^@([\w.-]+)\/(.+)$/.exec(remotePath);
    if (!m) throw new DeviceError('iOS simulator paths look like "@<bundle id>/Documents/file.txt"', 'invalid argument');
    const container = (await this.simctl('get_app_container', this.deviceId, m[1], 'data')).trim();
    return readFile(join(container, m[2]));
  }
  async setPermissions(appId: string, permissions: string[], grant: boolean): Promise<void> {
    for (const p of permissions) await this.simctl('privacy', this.deviceId, grant ? 'grant' : 'revoke', p, appId);
  }
  async setNetwork(): Promise<void> {
    throw new NotSupportedError('changing network connectivity on iOS (no platform API; use a Network Link Conditioner profile)');
  }
  lock(seconds?: number) { return this.agent.lock(seconds); }
  unlock() { return this.agent.unlock(); }
  async openNotifications(): Promise<void> {
    throw new NotSupportedError('opening the notification centre on iOS (swipe down from the top edge instead)');
  }
  async setGeolocation(latitude: number, longitude: number): Promise<void> {
    if (this.simulator) await this.simctl('location', this.deviceId, 'set', `${latitude},${longitude}`);
    else await this.agent.geolocation(latitude, longitude);
  }
  shake() { return this.agent.shake(); }
  async webviews(): Promise<WebViewInfo[]> {
    return [];
  }
  async attachWebView(): Promise<WebViewSession> {
    throw new NotSupportedError('attaching to iOS web views (the Web Inspector protocol is not implemented yet)');
  }
  async logs(kind: string): Promise<string> {
    if (!this.simulator || kind !== 'syslog') throw new NotSupportedError(`device log "${kind}" on iOS (simulator syslog only)`);
    return this.simctl('spawn', this.deviceId, 'log', 'show', '--last', '5m', '--style', 'compact');
  }
  close(): Promise<void> {
    return this.cleanup();
  }
}

/** UDID of the first booted simulator (`xcrun simctl list devices booted -j`). */
export async function bootedSimulator(run: ToolRunner): Promise<string | undefined> {
  const j = JSON.parse(await run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'])) as { devices: Record<string, Array<{ udid: string; state: string }>> };
  for (const list of Object.values(j.devices ?? {})) for (const d of list) if (d.state === 'Booted') return d.udid;
  return undefined;
}
