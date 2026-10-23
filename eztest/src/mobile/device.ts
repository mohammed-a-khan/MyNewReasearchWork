/**
 * Device and app operations (`mobile` steps): gestures, orientation, app
 * lifecycle, deep links, web view contexts, files, permissions, network,
 * keyboard, lock, notifications and system alerts, executed through the
 * DeviceSession of the platform. An operation a platform does not offer
 * fails with NotSupportedError (never a silent no-op).
 */
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { EzTestError, NotSupportedError, sleep, type Step } from '../core/index.js';
import { center, directionalSwipe, intersects, longPress, pinch, swipe, tap, type Direction } from './gestures.js';
import type { NativeContext } from './native.js';
import { DeviceError, type Rect } from './session.js';

export interface DeviceOpContext {
  native: NativeContext;
  step: Step;
  interpolate(s: string): string;
  vars(): Record<string, unknown>;
  /** The resolved step target (when the operation acts on an element). */
  element?: string;
  timeoutMs: number;
  baseDir: string;
  /** How long to wait for a web view to appear. */
  webviewTimeoutMs: number;
  /** Resolve the step target without healing (swipe-until). */
  findVisible(): Promise<string | undefined>;
}

export interface DeviceOpOutcome {
  captured?: Record<string, unknown>;
  /** Raw bytes to store as evidence (pulled files). */
  file?: { name: string; data: Buffer };
}

/** Run a device call; an agent "not supported" answer becomes a NotSupportedError naming the operation. */
export async function orUnsupported<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DeviceError && e.unsupported) throw new NotSupportedError(`${what} (${e.message})`);
    throw e;
  }
}

function requireAppId(n: NativeContext, given?: unknown): string {
  const id = typeof given === 'string' && given ? given : n.appId;
  if (!id) throw new EzTestError('Which app? Give the app id ("Activate the app "com.example.shop"") or set the journey App: header', 'MISSING_VALUE');
  return id;
}

/** Attach a web view (by name, else the app's own, else the first) and make it the current context. Waits for it to appear. */
export async function switchToWebview(n: NativeContext, name: string | undefined, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = await n.device.webviews();
    const pick = name ? seen.find((w) => w.name === name) : (seen.find((w) => w.package && w.package === n.appId) ?? seen[0]);
    if (pick) {
      await n.setWebView(await n.device.attachWebView(pick));
      return pick.name;
    }
    if (Date.now() >= deadline) throw new EzTestError(`No web view${name ? ` "${name}"` : ''} appeared within ${timeoutMs} ms (seen: ${seen.map((w) => w.name).join(', ') || 'none'}); is WebView debugging enabled in the app (WebView.setWebContentsDebuggingEnabled)?`, 'NO_WEBVIEW');
    await sleep(500);
  }
}

/** Swipe in a direction until the target is displayed on screen (at most `max` swipes). */
async function swipeUntil(c: DeviceOpContext, direction: Direction, max: number): Promise<DeviceOpOutcome> {
  const win = await c.native.window();
  for (let i = 0; ; i++) {
    const el = await c.findVisible();
    if (el) {
      const rect = await c.native.ui.rect(el).catch(() => undefined);
      if (rect && intersects(rect, win) && (await c.native.ui.displayed(el).catch(() => false))) return { captured: { swipes: i } };
    }
    if (i >= max) throw new EzTestError(`${c.step.target?.description ?? 'target'} is not visible after ${max} swipe(s) ${direction}`, 'NOT_VISIBLE');
    await c.native.perform('swipeUntil', directionalSwipe(win, direction));
  }
}

/** Execute a `mobile` step. */
export async function performDeviceOp(c: DeviceOpContext): Promise<DeviceOpOutcome> {
  const { native: n, step } = c;
  const d = n.device;
  const a = (step.args ?? {}) as Record<string, unknown>;
  const op = String(a.op ?? '');
  const elRect = async (): Promise<Rect> => (c.element ? n.ui.rect(c.element) : n.window());
  const done = (out: DeviceOpOutcome = {}) => {
    n.invalidate();
    return out;
  };
  switch (op) {
    case 'swipeUntil':
      if (!step.target) throw new EzTestError('Swipe until needs a target', 'MISSING_TARGET');
      return swipeUntil(c, (a.direction as Direction) ?? 'up', Number(a.max ?? 10));
    case 'swipe':
      await n.perform('swipe', swipe(a.from as { x: number; y: number }, a.to as { x: number; y: number }, Number(a.durationMs ?? 400)));
      return {};
    case 'tapAt':
      await n.perform('tapAt', tap({ x: Number(a.x), y: Number(a.y) }));
      return {};
    case 'longPress':
      await n.perform('longPress', longPress(center(await elRect()), Number(a.durationMs ?? 1000)));
      return {};
    case 'pinch':
      await n.perform('pinch', pinch(await elRect(), a.direction === 'in' ? 'in' : 'out'));
      return {};
    case 'rotate':
      await orUnsupported('rotating the device', () => d.setOrientation(String(a.orientation).toLowerCase() === 'landscape' ? 'landscape' : 'portrait'));
      n.invalidate(true);
      return {};
    case 'back':
      await orUnsupported('the back button', () => d.pressKey('back'));
      return done();
    case 'home':
      await orUnsupported('the home button', () => d.pressKey('home'));
      return done();
    case 'background':
      await orUnsupported('putting the app in the background', () => d.backgroundApp(a.durationMs !== undefined ? Number(a.durationMs) / 1000 : -1));
      return done();
    case 'activateApp':
      await orUnsupported('activating the app', () => d.activateApp(requireAppId(n, a.appId)));
      return done();
    case 'terminateApp':
      await orUnsupported('terminating the app', () => d.terminateApp(requireAppId(n, a.appId)));
      return done();
    case 'restartApp': {
      const id = requireAppId(n, a.appId);
      await orUnsupported('restarting the app', () => d.terminateApp(id));
      await orUnsupported('restarting the app', () => d.launchApp(id));
      await n.setWebView(undefined);
      return done();
    }
    case 'installApp': {
      const p = resolvePath(c.baseDir, c.interpolate(step.value ?? ''));
      await orUnsupported('installing an app', () => d.installApp(p));
      return {};
    }
    case 'removeApp':
      await orUnsupported('removing an app', () => d.removeApp(requireAppId(n, a.appId)));
      return {};
    case 'deepLink': {
      const url = c.interpolate(step.value ?? '');
      if (!url) throw new EzTestError('Deep link needs a URL', 'MISSING_VALUE');
      await orUnsupported('opening a deep link', () => d.deepLink(url, n.appId));
      return done();
    }
    case 'context': {
      if (a.context === 'native') {
        await n.setWebView(undefined);
        return {};
      }
      const name = await switchToWebview(n, typeof a.name === 'string' ? c.interpolate(a.name) : undefined, c.webviewTimeoutMs);
      return { captured: { context: name } };
    }
    case 'pushFile': {
      const local = resolvePath(c.baseDir, c.interpolate(step.value ?? ''));
      const data = await readFile(local);
      await orUnsupported('pushing a file', () => d.pushFile(c.interpolate(String(a.remote ?? '')), data));
      return {};
    }
    case 'pullFile': {
      const remotePath = c.interpolate(step.value ?? '');
      const data = await orUnsupported('pulling a file', () => d.pullFile(remotePath));
      const name = remotePath.split('/').pop() || 'file';
      return { file: { name, data }, captured: { [step.captureAs ?? 'file']: { remotePath, size: data.length, base64: data.toString('base64') } } };
    }
    case 'permission': {
      const perms = (a.permissions as string[]).map((p) => c.interpolate(p));
      await orUnsupported('changing app permissions', () => d.setPermissions(requireAppId(n), perms, Boolean(a.grant)));
      return {};
    }
    case 'network': {
      const state: { wifi?: boolean; data?: boolean; airplane?: boolean } = {};
      if (a.airplane !== undefined) state.airplane = Boolean(a.airplane);
      if (a.wifi !== undefined) state.wifi = Boolean(a.wifi);
      if (a.data !== undefined) state.data = Boolean(a.data);
      await orUnsupported('changing network connectivity', () => d.setNetwork(state));
      return {};
    }
    case 'hideKeyboard':
      await orUnsupported('hiding the keyboard', () => d.hideKeyboard());
      return done();
    case 'shake':
      await orUnsupported('shaking the device', () => d.shake());
      return done();
    case 'lock':
      await orUnsupported('locking the device', () => d.lock(a.durationMs !== undefined ? Number(a.durationMs) / 1000 : undefined));
      return done();
    case 'unlock':
      await orUnsupported('unlocking the device', () => d.unlock());
      return done();
    case 'openNotifications':
      await orUnsupported('opening notifications', () => d.openNotifications());
      return done();
    case 'alert':
      if (a.accept) await d.acceptAlert();
      else await d.dismissAlert();
      return done();
    default:
      throw new NotSupportedError(`mobile operation "${op}"`);
  }
}
