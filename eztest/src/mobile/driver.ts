/**
 * The EZTest mobile platform driver: runs `Platform: android | ios` journeys
 * (and mobile web in the device browser) on EZTest's own device drivers:
 * the ADB client plus the EZTest Android agent, and the EZTest iOS XCTest
 * agent. One device connection per device per run (the agent stays up between
 * journeys); every journey attempt restarts the app under test so attempts
 * never share app state. A device pool spreads concurrent journeys.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { EzTestError, NotSupportedError, journeyStatusFrom, nowIso, sleep, type Journey, type JourneyResult } from '../core/index.js';
import type { EvidenceWriter } from '../runner/evidence.js';
import { safeName } from '../runner/evidence.js';
import type { PlatformDriver, PlatformRunEnv } from '../runner/platform.js';
import { TraceResourceStore } from '../runner/trace/store.js';
import type { ScreenshotPolicy } from '../runner/types.js';
import { AdbClient } from './adb.js';
import type { AgentCommandLog } from './agent.js';
import { AndroidDevice } from './android.js';
import { PREBUILT_APK } from './cli.js';
import { switchToWebview } from './device.js';
import { runNativeJourney, type NativeExecEnv } from './executor.js';
import { IosDevice, type ToolRunner } from './ios.js';
import { NativeContext } from './native.js';
import type { DeviceSession } from './session.js';
import { NativeTraceRecorder } from './trace.js';
import type { UsbmuxEndpoint } from './usbmux.js';
import { bddRecord } from '../runner/bdd-run.js';

export interface AndroidSettings {
  /** adb server (default 127.0.0.1:5037). */
  adb?: { host?: string; port?: number };
  /** Device serials to use (a pool for concurrent journeys). Default: the attached device. */
  devices?: string[];
  /** Agent APK (default: agents/android/prebuilt/eztest-agent.apk when present). */
  agentApk?: string;
  agentPort?: number;
  /** An agent that is already running and reachable (skips install/start/forward). */
  agentUrl?: string;
  /** `pm clear` the app before each journey attempt. Default false. */
  clearData?: boolean;
}

export interface IosSettings {
  /** Device / simulator UDIDs to use (a pool). Default: the booted simulator or the first USB device. */
  devices?: string[];
  simulator?: boolean;
  agentUrl?: string;
  agentPort?: number;
  /** Launch the agent with `xcodebuild test-without-building -xctestrun <file>`. */
  xctestrun?: string;
  usbmux?: UsbmuxEndpoint;
  run?: ToolRunner;
}

export interface MobileDriverOptions {
  /** Default app (package / bundle id, or an .apk/.app/.ipa to install) for journeys without `App:`. */
  app?: string;
  android?: AndroidSettings;
  ios?: IosSettings;
  /** Screenshot policy on devices (default: the run's policy). */
  screenshots?: ScreenshotPolicy;
  /** Page source evidence. Default on-failure (and on heals). */
  pageSource?: 'every-step' | 'on-failure' | 'off';
  /** Device logs collected at the end of each attempt: logcat (Android), syslog (iOS simulator). */
  logs?: string[];
  webviewTimeoutMs?: number;
  agentTimeoutMs?: number;
  /** How long to let the app settle after launching it. Default 500 ms. */
  launchSettleMs?: number;
  /** Directory relative app and file paths resolve against. */
  baseDir?: string;
  mask?: (s: string) => string;
  /** Seam for custom device drivers (src/desktop and tests): open a device session yourself. */
  connect?(platform: 'android' | 'ios', deviceId: string | undefined, onCommand: (e: AgentCommandLog) => void): Promise<DeviceSession>;
  /** Called with the device before a journey attempt ends (tools and tests). */
  beforeRelease?(device: DeviceSession, journey: Journey): Promise<void> | void;
}

interface Slot {
  platform: 'android' | 'ios';
  deviceId?: string;
  busy: boolean;
  session?: DeviceSession;
  log?: AgentCommandLog[];
  installed: Set<string>;
}

const APP_FILE = /\.(?:apk|aab|ipa|zip)$/i;

export class MobileDriver implements PlatformDriver {
  readonly name = 'eztest-mobile';
  readonly platforms = ['android', 'ios'] as const;
  private readonly slots: Slot[] = [];
  private readonly waiters: Array<() => void> = [];
  private readonly traceStores = new WeakMap<EvidenceWriter, TraceResourceStore>();

  constructor(readonly options: MobileDriverOptions = {}) {
    for (const [platform, list] of [['android', options.android?.devices], ['ios', options.ios?.devices]] as const) {
      for (const id of list?.length ? list : [undefined]) this.slots.push({ platform, deviceId: id, busy: false, installed: new Set() });
    }
  }

  environment(): Record<string, string> {
    const adb = this.options.android?.adb;
    return { mobileDriver: 'eztest (ADB + EZTest agents)', androidAdb: `${adb?.host ?? '127.0.0.1'}:${adb?.port ?? 5037}` };
  }

  private mask(s: string): string {
    return this.options.mask ? this.options.mask(s) : s;
  }

  private async acquire(platform: 'android' | 'ios', want?: string): Promise<Slot> {
    for (;;) {
      const candidates = this.slots.filter((s) => s.platform === platform && (!want || s.deviceId === want || s.deviceId === undefined));
      if (!candidates.length) throw new EzTestError(`device "${want}" is not in mobile.${platform}.devices`, 'CONFIG');
      const free = candidates.find((s) => !s.busy && (!want || s.deviceId === want)) ?? candidates.find((s) => !s.busy);
      if (free) {
        free.busy = true;
        return free;
      }
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }

  private release(slot: Slot): void {
    slot.busy = false;
    this.waiters.splice(0).forEach((w) => w());
  }

  private async connect(slot: Slot, want?: string): Promise<DeviceSession> {
    if (slot.session) return slot.session;
    const o = this.options;
    const onCommand = (e: AgentCommandLog) => slot.log?.push(e);
    const id = want ?? slot.deviceId;
    if (o.connect) slot.session = await o.connect(slot.platform, id, onCommand);
    else if (slot.platform === 'android') {
      const a = o.android ?? {};
      const bundled = PREBUILT_APK();
      slot.session = await AndroidDevice.connect({
        adb: new AdbClient({ host: a.adb?.host, port: a.adb?.port }), serial: id, agentApk: a.agentApk ? this.path(a.agentApk) : existsSync(bundled) ? bundled : undefined,
        agentPort: a.agentPort, agentUrl: a.agentUrl, agentTimeoutMs: o.agentTimeoutMs, onCommand,
      });
    } else {
      const i = o.ios ?? {};
      slot.session = await IosDevice.connect({ udid: id, simulator: i.simulator, agentUrl: i.agentUrl, agentPort: i.agentPort, xctestrun: i.xctestrun ? this.path(i.xctestrun) : undefined, usbmux: i.usbmux, run: i.run, agentTimeoutMs: o.agentTimeoutMs, onCommand });
    }
    slot.deviceId ??= slot.session.deviceId;
    return slot.session;
  }

  private path(p: string): string {
    return isAbsolute(p) ? p : resolve(this.options.baseDir ?? process.cwd(), p);
  }

  private traceStore(evidence: EvidenceWriter): TraceResourceStore {
    let s = this.traceStores.get(evidence);
    if (!s) {
      s = new TraceResourceStore(evidence);
      this.traceStores.set(evidence, s);
    }
    return s;
  }

  /** Install an app file once per device per run; returns the app id. */
  private async prepareApp(slot: Slot, device: DeviceSession, app: string, caps: Record<string, unknown>): Promise<string> {
    const file = this.path(app);
    // A path (with a separator), an .apk/.aab/.ipa/.zip, or an existing file / .app bundle; otherwise a package / bundle id.
    const isFile = /[\\/]/.test(app) || APP_FILE.test(app) || existsSync(file);
    if (!isFile) return app;
    if (!existsSync(file)) throw new EzTestError(`app file not found: ${file}`, 'MISSING_FILE');
    const declared = typeof caps.appId === 'string' ? caps.appId : undefined;
    if (!slot.installed.has(file)) {
      let before: Set<string> | undefined;
      if (!declared && device instanceof AndroidDevice) before = await packages(device);
      await device.installApp(file);
      slot.installed.add(file);
      if (!declared && before && device instanceof AndroidDevice) {
        const added = [...(await packages(device))].filter((p) => !before!.has(p));
        if (added.length === 1) {
          caps.appId = added[0];
          slot.installed.add(`${file}=>${added[0]}`);
        }
      }
    }
    const known = declared ?? [...slot.installed].find((k) => k.startsWith(`${file}=>`))?.split('=>')[1];
    if (!known) throw new EzTestError(`which app id does ${app} install? add "Capabilities: appId=\\"com.example.app\\"" to the journey (or mobile.app as the id)`, 'MISSING_VALUE');
    return known;
  }

  async runAttempt(journey: Journey, attempt: number, env: PlatformRunEnv): Promise<JourneyResult> {
    const platform = (journey.platform ?? env.opts.platform) === 'ios' ? 'ios' : 'android';
    const started = Date.now();
    const result: JourneyResult = {
      journeyId: journey.id, name: journey.name, status: 'error', startedAt: nowIso(), durationMs: 0, steps: [], tags: journey.tags,
      requirements: journey.requirements, risk: journey.risk, attempt, browser: platform, ledger: {}, evidence: [],
      ...(journey.bdd ? { bdd: bddRecord(journey, env.opts.baseDir) } : {}),
    };
    const prefix = `journeys/${safeName(journey.id)}/attempt-${attempt}`;
    const meta = (description: string) => ({ journeyId: journey.id, description });
    const caps: Record<string, unknown> = { ...(journey.capabilities ?? {}) };
    const want = typeof caps.serial === 'string' ? caps.serial : typeof caps.udid === 'string' ? caps.udid : undefined;
    let slot: Slot | undefined;
    let native: NativeContext | undefined;
    let trace: NativeTraceRecorder | undefined;
    const log: AgentCommandLog[] = [];
    try {
      slot = await this.acquire(platform, want);
      slot.log = log;
      const device = await this.connect(slot, want);
      result.browser = `${platform} (${String(device.info.model ?? device.deviceId)})`;
      const app = journey.app ?? this.options.app;
      const appId = app ? await this.prepareApp(slot, device, app, caps) : undefined;
      native = new NativeContext(device, appId);
      if (appId && caps.launch !== false) {
        await device.terminateApp(appId).catch(() => undefined);
        if ((caps.clearData ?? this.options.android?.clearData) === true && device instanceof AndroidDevice) await device.clearAppData(appId);
        await device.launchApp(appId);
        await sleep(this.options.launchSettleMs ?? 500);
      }
      const baseUrl = journey.baseUrl ?? env.opts.baseUrl;
      const mobileWeb = !app && !!baseUrl;
      if (mobileWeb) {
        if (platform === 'ios') throw new NotSupportedError('mobile web on iOS (Safari Web Inspector is not implemented); run the journey on the web platform with Device: "iPhone 15"');
        await device.deepLink(baseUrl!, 'com.android.chrome');
        await switchToWebview(native, undefined, this.options.webviewTimeoutMs ?? 10_000);
      }
      const info = { platform, deviceId: device.deviceId, device: device.info, appId: appId ?? null, mobileWeb, launch: caps };
      result.evidence.push((await env.evidence.store('data', `${prefix}/device.json`, this.mask(JSON.stringify(info, null, 2)), meta(`${platform} device session`))).id);
      if (env.opts.timeTravel?.enabled) {
        const masker = env.opts.timeTravel.masker;
        trace = new NativeTraceRecorder({
          runId: env.runId, journeyId: journey.id, journeyName: journey.name, attempt, platform, evidence: env.evidence, store: this.traceStore(env.evidence),
          mask: (s) => this.mask(masker ? masker.mask(s) : s), native,
        });
      }
      const exec: NativeExecEnv = {
        ...env, native, platform, trace, mobileWeb,
        settings: {
          screenshots: this.options.screenshots ?? env.opts.screenshots ?? 'on-failure',
          pageSource: this.options.pageSource ?? 'on-failure',
          webviewTimeoutMs: this.options.webviewTimeoutMs ?? 10_000,
          baseDir: this.options.baseDir ?? env.opts.baseDir ?? process.cwd(),
        },
      };
      await runNativeJourney(journey, attempt, exec, result);
      if (result.status === 'error' && !result.error) result.status = journeyStatusFrom(result.steps);
    } catch (e) {
      const err = e as Error;
      result.status = 'error';
      result.error = { message: this.mask(err.message.split('\n')[0]), name: err.name };
      env.logger.error('mobile journey error', { journeyId: journey.id, message: result.error.message });
    } finally {
      if (slot && native) {
        try {
          await this.finish(slot.session!, native, journey, result, env, prefix, trace);
        } catch (e) {
          env.logger.warn('could not finish the device session', { journeyId: journey.id, message: (e as Error).message });
        }
      }
      if (log.length) {
        const ref = await env.evidence.store('log', `${prefix}/agent-commands.json`, this.mask(JSON.stringify(log, null, 1)), meta('commands sent to the EZTest device agent')).catch(() => undefined);
        if (ref) result.evidence.push(ref.id);
      }
      if (slot) {
        slot.log = undefined;
        this.release(slot);
      }
    }
    result.durationMs = Date.now() - started;
    return result;
  }

  private async finish(device: DeviceSession, native: NativeContext, journey: Journey, result: JourneyResult, env: PlatformRunEnv, prefix: string, trace?: NativeTraceRecorder): Promise<void> {
    const meta = (description: string) => ({ journeyId: journey.id, description });
    if (native.gestures.length) result.evidence.push((await env.evidence.store('data', `${prefix}/gestures.json`, JSON.stringify(native.gestures, null, 1), meta('touch gestures performed'))).id);
    for (const kind of this.options.logs ?? []) {
      try {
        if (!device.logs) throw new NotSupportedError(`device logs on ${device.platform}`);
        result.evidence.push((await env.evidence.store('log', `${prefix}/device-${safeName(kind)}.txt`, this.mask(await device.logs(kind)), meta(`device log ${kind}`))).id);
      } catch (e) {
        env.logger.warn('could not collect device log', { kind, message: (e as Error).message });
      }
    }
    if (trace) {
      try {
        result.evidence.push(await trace.finish(result));
      } catch (e) {
        env.logger.warn('could not write the native trace', { journeyId: journey.id, message: (e as Error).message });
      }
    }
    await this.options.beforeRelease?.(device, journey);
    await native.setWebView(undefined);
  }

  async close(): Promise<void> {
    for (const s of this.slots) {
      await s.session?.close().catch(() => undefined);
      s.session = undefined;
    }
  }
}

async function packages(d: AndroidDevice): Promise<Set<string>> {
  const out = (await d.adb.shell(d.deviceId, 'pm list packages')).output;
  return new Set([...out.matchAll(/^package:(\S+)/gm)].map((m) => m[1]));
}

export function createMobileDriver(options: MobileDriverOptions = {}): MobileDriver {
  return new MobileDriver(options);
}
