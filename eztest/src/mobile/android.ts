/**
 * Android devices: EZTest's ADB client for the device side (install, shell,
 * files, permissions, connectivity, port forwards) plus the EZTest Android
 * agent (agents/android: an instrumentation APK using androidx.test.uiautomator)
 * for the UI (find, tap, type, gestures, hierarchy, screenshots, keys,
 * rotation, alerts). The agent listens on the device's loopback only; the host
 * reaches it through an `adb forward`.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { NotSupportedError, sleep } from '../core/index.js';
import { AdbClient, AdbError, shellQuote, type ShellStream } from './adb.js';
import { AgentClient, newAgentToken, waitForAgent, type AgentCommandLog, type AgentStatus } from './agent.js';
import { DeviceError, type DeviceSession, type FindStrategy, type Gesture, type Rect, type WebViewInfo, type WebViewSession } from './session.js';
import { CdpWebView } from './webview.js';

export const ANDROID_AGENT_PACKAGE = 'io.eztest.agent';
export const ANDROID_AGENT_INSTRUMENTATION = `${ANDROID_AGENT_PACKAGE}/.AgentInstrumentation`;
export const ANDROID_AGENT_PORT = 6790;

/** A free local TCP port for a forward. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export interface AndroidConnectOptions {
  adb: AdbClient;
  /** Device serial; default: the only attached device in state "device". */
  serial?: string;
  /** Agent APK to install when the agent is missing (default: the bundled prebuilt, when present). */
  agentApk?: string;
  /** Device-side agent port. Default 6790. */
  agentPort?: number;
  /** How long to wait for the agent to answer. Default 30 s. */
  agentTimeoutMs?: number;
  /** Do not install or start the agent (it is already running and forwarded), e.g. in tests or CI images. */
  agentUrl?: string;
  /** Session token of an agent started by hand (with agentUrl). An agent EZTest starts gets a fresh random one. */
  agentToken?: string;
  onCommand?: (e: AgentCommandLog) => void;
}

/** Resolve the device to use. */
export async function pickAndroidDevice(adb: AdbClient, serial?: string): Promise<string> {
  const devices = await adb.devices();
  if (serial) {
    const d = devices.find((x) => x.serial === serial);
    if (!d) throw new AdbError(`Android device "${serial}" is not attached (attached: ${devices.map((x) => `${x.serial} (${x.state})`).join(', ') || 'none'})`);
    if (d.state !== 'device') throw new AdbError(`Android device "${serial}" is ${d.state}`);
    return serial;
  }
  const ready = devices.filter((d) => d.state === 'device');
  if (ready.length === 0) throw new AdbError(`no Android device is attached and online (adb: ${devices.map((x) => `${x.serial} (${x.state})`).join(', ') || 'none'}); start an emulator or connect a device`);
  return ready[0].serial;
}

export class AndroidDevice implements DeviceSession {
  readonly platform = 'android' as const;
  info: Record<string, unknown> = {};
  appId?: string;
  private webForwards: string[] = [];

  constructor(
    readonly adb: AdbClient,
    readonly deviceId: string,
    readonly agent: AgentClient,
    private readonly cleanup: () => Promise<void>,
    status?: AgentStatus,
  ) {
    if (status) this.info = { agent: status.agent, agentVersion: status.version, ...(status.device ?? {}) };
  }

  /** Connect to a device: install and start the agent when needed, forward its port, wait until it answers. */
  static async connect(o: AndroidConnectOptions): Promise<AndroidDevice> {
    const serial = await pickAndroidDevice(o.adb, o.serial);
    if (o.agentUrl) {
      const agent = new AgentClient({ url: o.agentUrl, onCommand: o.onCommand, ...(o.agentToken ? { token: o.agentToken } : {}) });
      return new AndroidDevice(o.adb, serial, agent, async () => undefined, await waitForAgent(agent, o.agentTimeoutMs ?? 30_000));
    }
    const remotePort = o.agentPort ?? ANDROID_AGENT_PORT;
    const installed = await o.adb.shell(serial, `pm path ${ANDROID_AGENT_PACKAGE}`);
    if (!/package:/.test(installed.output)) {
      if (!o.agentApk || !existsSync(o.agentApk)) {
        throw new AdbError(`the EZTest Android agent is not installed on ${serial} and no agent APK is available; build it with "eztest mobile build-agent" (see docs/mobile.md) and set mobile.android.agentApk`);
      }
      await o.adb.install(serial, await readFile(o.agentApk), 'eztest-agent.apk');
    }
    // The instrumentation hosts the agent's HTTP server (device loopback) until it is stopped; it
    // answers only requests that carry this session's random token.
    const token = newAgentToken();
    const stream: ShellStream = await o.adb.shellStream(serial, `am instrument -w -e port ${remotePort} -e token ${token} ${ANDROID_AGENT_INSTRUMENTATION}`);
    const local = await freePort();
    await o.adb.forward(serial, `tcp:${local}`, `tcp:${remotePort}`);
    const agent = new AgentClient({ url: `http://127.0.0.1:${local}`, token, onCommand: o.onCommand });
    const cleanup = async () => {
      await agent.call('POST', '/shutdown', {}, 3000).catch(() => undefined);
      stream.kill();
      await o.adb.removeForward(serial, `tcp:${local}`).catch(() => undefined);
    };
    try {
      return new AndroidDevice(o.adb, serial, agent, cleanup, await waitForAgent(agent, o.agentTimeoutMs ?? 30_000));
    } catch (e) {
      await cleanup();
      throw new AdbError(`${(e as Error).message}; instrumentation output: ${stream.output().trim().slice(0, 400) || '(none)'}`);
    }
  }

  private sh(cmd: string, what?: string): Promise<string> {
    return this.adb.shellOk(this.deviceId, cmd, what);
  }

  // ---------------------------------------------------------------- elements (agent)
  findElements(using: FindStrategy, value: string): Promise<string[]> {
    if (using === 'predicate') return Promise.reject(new DeviceError('NSPredicate strategies are iOS only', 'not supported'));
    if (using === 'css') return Promise.reject(new DeviceError('CSS selectors work in web views only (switch to the web view first)', 'not supported'));
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

  // ---------------------------------------------------------------- apps and device (adb)
  async launchApp(appId: string): Promise<void> {
    await this.sh(`monkey -p ${shellQuote(appId)} -c android.intent.category.LAUNCHER 1`, `launching ${appId}`);
  }
  async activateApp(appId: string): Promise<void> {
    await this.launchApp(appId);
  }
  async terminateApp(appId: string): Promise<void> {
    await this.sh(`am force-stop ${shellQuote(appId)}`, `stopping ${appId}`);
  }
  async backgroundApp(seconds: number): Promise<void> {
    const current = this.appId;
    await this.agent.key('home');
    if (seconds < 0) return;
    await sleep(seconds * 1000);
    if (current) await this.activateApp(current);
  }
  async installApp(path: string): Promise<void> {
    await this.adb.install(this.deviceId, await readFile(path), 'eztest-app.apk');
  }
  async removeApp(appId: string): Promise<void> {
    await this.sh(`pm uninstall ${shellQuote(appId)}`, `uninstalling ${appId}`);
  }
  async clearAppData(appId: string): Promise<void> {
    await this.sh(`pm clear ${shellQuote(appId)}`, `clearing ${appId}`);
  }
  async deepLink(url: string, appId?: string): Promise<void> {
    await this.sh(`am start -W -a android.intent.action.VIEW -d ${shellQuote(url)}${appId ? ` ${shellQuote(appId)}` : ''}`, `opening ${url}`);
  }
  async pushFile(remotePath: string, data: Buffer): Promise<void> {
    await this.adb.push(this.deviceId, data, remotePath);
  }
  pullFile(remotePath: string): Promise<Buffer> {
    return this.adb.pull(this.deviceId, remotePath);
  }
  async setPermissions(appId: string, permissions: string[], grant: boolean): Promise<void> {
    for (const p of permissions) {
      const perm = p.includes('.') ? p : `android.permission.${p.toUpperCase()}`;
      await this.sh(`pm ${grant ? 'grant' : 'revoke'} ${shellQuote(appId)} ${shellQuote(perm)}`, `${grant ? 'granting' : 'revoking'} ${perm}`);
    }
  }
  async setNetwork(state: { wifi?: boolean; data?: boolean; airplane?: boolean }): Promise<void> {
    if (state.airplane !== undefined) await this.sh(`cmd connectivity airplane-mode ${state.airplane ? 'enable' : 'disable'}`, 'airplane mode');
    if (state.wifi !== undefined) await this.sh(`svc wifi ${state.wifi ? 'enable' : 'disable'}`, 'wifi');
    if (state.data !== undefined) await this.sh(`svc data ${state.data ? 'enable' : 'disable'}`, 'mobile data');
  }
  async lock(seconds?: number): Promise<void> {
    await this.sh('input keyevent 26', 'locking the device');
    if (seconds !== undefined) {
      await sleep(seconds * 1000);
      await this.unlock();
    }
  }
  async unlock(): Promise<void> {
    await this.sh('input keyevent 224 && wm dismiss-keyguard', 'unlocking the device');
  }
  async openNotifications(): Promise<void> {
    await this.sh('cmd statusbar expand-notifications', 'opening notifications');
  }
  async setGeolocation(latitude: number, longitude: number): Promise<void> {
    await this.agent.geolocation(latitude, longitude).catch((e: unknown) => {
      if (e instanceof DeviceError && e.unsupported) throw new NotSupportedError('setting the location on this Android device (the agent needs mock-location permission: adb shell appops set io.eztest.agent android:mock_location allow)');
      throw e;
    });
  }
  async shake(): Promise<void> {
    throw new NotSupportedError('shaking an Android device (no platform API; send the app its shake event from a custom step)');
  }

  // ---------------------------------------------------------------- web views (DevTools sockets)
  /** WebView and Chrome DevTools sockets from /proc/net/unix, with the owning package. */
  async webviews(): Promise<WebViewInfo[]> {
    const unix = (await this.adb.shell(this.deviceId, 'cat /proc/net/unix')).output;
    const sockets = [...new Set([...unix.matchAll(/@((?:webview_devtools_remote|chrome_devtools_remote)(?:_(\d+))?)\s*$/gm)].map((m) => m[1]))];
    const out: WebViewInfo[] = [];
    for (const socket of sockets) {
      const pid = /_(\d+)$/.exec(socket)?.[1];
      let pkg: string | undefined = socket.startsWith('chrome') ? 'com.android.chrome' : undefined;
      if (pid) pkg = (await this.adb.shell(this.deviceId, `cat /proc/${pid}/cmdline`)).output.replace(/\0[\s\S]*$/, '').trim() || undefined;
      out.push({ name: `WEBVIEW_${pkg ?? socket}`, socket, ...(pid ? { pid: Number(pid) } : {}), ...(pkg ? { package: pkg } : {}) });
    }
    return out;
  }

  async attachWebView(info: WebViewInfo): Promise<WebViewSession> {
    if (!info.socket) throw new DeviceError(`web view ${info.name} has no DevTools socket`, 'no such context');
    const local = await freePort();
    await this.adb.forward(this.deviceId, `tcp:${local}`, `localabstract:${info.socket}`);
    this.webForwards.push(`tcp:${local}`);
    return CdpWebView.attach(info.name, `http://127.0.0.1:${local}`, async () => {
      await this.adb.removeForward(this.deviceId, `tcp:${local}`).catch(() => undefined);
      this.webForwards = this.webForwards.filter((f) => f !== `tcp:${local}`);
    });
  }

  async logs(kind: string): Promise<string> {
    if (kind !== 'logcat') throw new NotSupportedError(`device log "${kind}" on Android (use logcat)`);
    return (await this.adb.shell(this.deviceId, 'logcat -d -v threadtime -t 2000')).output;
  }

  async close(): Promise<void> {
    for (const f of this.webForwards) await this.adb.removeForward(this.deviceId, f).catch(() => undefined);
    await this.cleanup();
  }
}
