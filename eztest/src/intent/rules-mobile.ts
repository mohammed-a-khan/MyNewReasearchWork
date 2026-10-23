/**
 * Mobile phrasings (native apps through EZTest's device agents; see docs/mobile.md). Every
 * rule builds a `mobile` step whose `args.op` names the device or gesture
 * operation; ordinary phrasings ("Tap the "Login" button", "Type ... into",
 * "Swipe left on ...", "Go back", "Open "shop://orders"") keep their web
 * actions and are executed natively by the mobile driver.
 *
 * The rules are spliced into the grammar before the advanced rules, so their
 * device-specific wording ("Press the device back button", "Turn on airplane
 * mode") wins over generic element phrasings.
 */
import type { Step } from '../core/index.js';
import { literal, quoteText, restoreQuotes } from './quotes.js';
import type { IntentRule, StepBody } from './rules.js';
import { describeTarget } from './target.js';

const Q = String.raw`⟦\d+⟧`;
const T = (s: string, q: string[]) => describeTarget(restoreQuotes(s.trim(), q));
const V = (s: string, q: string[]) => literal(s, q);
const NUM = String.raw`(\d+(?:\.\d+)?)`;
const SECS = String.raw`(?:\s+for\s+${NUM}\s*(ms|milliseconds?|s|secs?|seconds?))?`;
const APP_ID = String.raw`(?:\s+(${Q}|[\w.-]+\.[\w.-]+))?`;

function ms(n: string | undefined, unit: string | undefined): number | undefined {
  if (n === undefined) return undefined;
  const v = Number(n);
  return /^m/i.test(unit ?? 's') ? Math.round(v) : Math.round(v * 1000);
}

const mobile = (op: string, extra: Record<string, unknown> = {}, rest: Partial<StepBody> = {}): StepBody =>
  ({ action: 'mobile', ...rest, args: { op, ...extra } });

const cat = (rules: IntentRule[]): IntentRule[] => rules.map((r) => ({ ...r, category: 'Mobile' }));

export const MOBILE_RULES: IntentRule[] = cat([
  // Finger direction (swipe up = the content scrolls down). "Scroll down until ..." stays the scroll-until rule; on a device it swipes the same way.
  { name: 'mobile-swipe-until', keywords: ['swipe'], example: 'Swipe up until "Settings" is visible',
    re: /^(swipe)\s+(up|down|left|right)\s+(?:until|till)\s+(.+?)\s+(?:is\s+(?:visible|shown|displayed)|appears|is\s+on\s+(?:the\s+)?screen)(?:\s+at\s+most\s+(\d+)\s+times?)?$/i,
    build: (m, q) => {
      return mobile('swipeUntil', { direction: m[2].toLowerCase(), ...(m[4] ? { max: Number(m[4]) } : {}) }, { target: T(m[3], q) });
    } },
  { name: 'mobile-swipe-coords', keywords: ['swipe', 'drag'], example: 'Swipe from 200, 700 to 200, 200',
    re: /^swipe\s+from\s+(\d+)\s*,\s*(\d+)\s+to\s+(\d+)\s*,\s*(\d+)(?:\s+in\s+(\d+)\s*ms)?$/i,
    build: (m) => mobile('swipe', { from: { x: Number(m[1]), y: Number(m[2]) }, to: { x: Number(m[3]), y: Number(m[4]) }, ...(m[5] ? { durationMs: Number(m[5]) } : {}) }) },
  { name: 'mobile-tap-at', keywords: ['tap'], example: 'Tap at 120, 640',
    re: /^tap\s+(?:the\s+screen\s+)?at\s+(\d+)\s*,\s*(\d+)$/i,
    build: (m) => mobile('tapAt', { x: Number(m[1]), y: Number(m[2]) }) },
  { name: 'mobile-long-press', keywords: ['long', 'press', 'touch'], example: 'Long press the "Photo" image for 2 seconds',
    re: new RegExp(String.raw`^(?:long[-\s]?press|long[-\s]?tap|touch\s+and\s+hold|tap\s+and\s+hold)\s+(?:on\s+)?(.+?)${SECS}$`, 'i'),
    build: (m, q) => mobile('longPress', m[2] ? { durationMs: ms(m[2], m[3]) } : {}, { target: T(m[1], q) }) },
  { name: 'mobile-pinch', keywords: ['pinch', 'zoom'], example: 'Pinch out on the Map',
    re: /^(?:pinch\s+(in|out|open|close)|zoom\s+(in|out))(?:\s+(?:on|over)\s+(.+?))?$/i,
    build: (m, q) => {
      // Zooming in spreads the fingers (pinch out); zooming out pinches them in.
      const dir = m[1] ? (/^(?:in|close)$/i.test(m[1]) ? 'in' : 'out') : m[2].toLowerCase() === 'in' ? 'out' : 'in';
      return mobile('pinch', { direction: dir }, m[3] ? { target: T(m[3], q) } : {});
    } },
  { name: 'mobile-rotate', keywords: ['rotate', 'set', 'turn'], example: 'Rotate to landscape',
    re: /^(?:rotate|turn)\s+(?:the\s+)?(?:device|screen|phone|tablet)?\s*(?:to\s+)?(landscape|portrait)(?:\s+mode)?$|^set\s+(?:the\s+)?(?:screen\s+|device\s+)?orientation\s+to\s+(landscape|portrait)$/i,
    build: (m) => mobile('rotate', { orientation: (m[1] ?? m[2]).toLowerCase() }) },
  { name: 'mobile-back', keywords: ['press'], example: 'Press the device back button',
    re: /^(?:press|tap|hit)\s+(?:the\s+)?(?:device|hardware|system|android|phone)\s+back(?:\s+button)?$/i,
    build: () => mobile('back') },
  { name: 'mobile-home', keywords: ['press', 'go'], example: 'Press the device home button',
    re: /^(?:(?:press|tap|hit)\s+(?:the\s+)?(?:device|hardware|system|phone)\s+home(?:\s+button)?|go\s+to\s+the\s+(?:device\s+)?home\s+screen)$/i,
    build: () => mobile('home') },
  { name: 'mobile-background', keywords: ['put', 'send', 'background'], example: 'Put the app in the background for 3 seconds',
    re: new RegExp(String.raw`^(?:(?:put|send|move)\s+the\s+app\s+(?:in|into|to)\s+the\s+background|background\s+the\s+app)${SECS}$`, 'i'),
    build: (m) => mobile('background', m[1] ? { durationMs: ms(m[1], m[2]) } : {}) },
  { name: 'mobile-foreground', keywords: ['bring', 'activate'], example: 'Bring the app to the foreground',
    re: new RegExp(String.raw`^(?:bring\s+the\s+app\s+(?:back\s+)?to\s+the\s+foreground|activate\s+the\s+app${APP_ID}|switch\s+to\s+the\s+app\s+(${Q}|[\w.-]+\.[\w.-]+))$`, 'i'),
    build: (m, q) => {
      const id = m[1] ?? m[2];
      return mobile('activateApp', id ? { appId: V(id, q) } : {});
    } },
  { name: 'mobile-terminate', keywords: ['close', 'terminate', 'kill', 'stop'], example: 'Close the app',
    re: new RegExp(String.raw`^(?:close|terminate|kill|stop|quit)\s+the\s+app${APP_ID}$`, 'i'),
    build: (m, q) => mobile('terminateApp', m[1] ? { appId: V(m[1], q) } : {}) },
  { name: 'mobile-restart', keywords: ['restart', 'relaunch'], example: 'Restart the app',
    re: /^(?:restart|relaunch|reopen)\s+the\s+app$/i,
    build: () => mobile('restartApp') },
  { name: 'mobile-install', keywords: ['install'], example: 'Install the app "apps/shop.apk"',
    re: new RegExp(String.raw`^install\s+the\s+app\s+(${Q})$`, 'i'),
    build: (m, q) => mobile('installApp', {}, { value: V(m[1], q) }) },
  { name: 'mobile-remove', keywords: ['uninstall', 'remove'], example: 'Uninstall the app "com.example.shop"',
    re: new RegExp(String.raw`^(?:uninstall|remove)\s+the\s+app\s+(${Q}|[\w.-]+\.[\w.-]+)$`, 'i'),
    build: (m, q) => mobile('removeApp', { appId: V(m[1], q) }) },
  { name: 'mobile-deep-link', keywords: ['open', 'follow'], example: 'Open the deep link "shop://orders/42"',
    re: new RegExp(String.raw`^(?:open|follow|launch)\s+(?:the\s+)?deep\s*link\s+(${Q}|\S+)$`, 'i'),
    build: (m, q) => mobile('deepLink', {}, { value: V(m[1], q) }) },
  { name: 'mobile-webview', keywords: ['switch'], example: 'Switch to the web view',
    re: new RegExp(String.raw`^(?:switch|change)\s+(?:back\s+)?to\s+the\s+web\s*view(?:\s+(${Q}|WEBVIEW\S*))?(?:\s+context)?$`, 'i'),
    build: (m, q) => mobile('context', { context: 'webview', ...(m[1] ? { name: V(m[1], q) } : {}) }) },
  { name: 'mobile-native', keywords: ['switch'], example: 'Switch to the native app',
    re: /^(?:switch|change)\s+(?:back\s+)?to\s+the\s+native\s+(?:app|context|view)$/i,
    build: () => mobile('context', { context: 'native' }) },
  { name: 'mobile-push-file', keywords: ['push', 'copy'], example: 'Push file "fixtures/photo.jpg" to "/sdcard/Pictures/photo.jpg"',
    re: new RegExp(String.raw`^(?:push|copy)\s+(?:the\s+)?file\s+(${Q})\s+to\s+(?:the\s+device\s+at\s+)?(${Q})$`, 'i'),
    build: (m, q) => mobile('pushFile', { remote: V(m[2], q) }, { value: V(m[1], q) }) },
  { name: 'mobile-pull-file', keywords: ['pull'], example: 'Pull file "/sdcard/Download/report.pdf" from the device as report',
    re: new RegExp(String.raw`^pull\s+(?:the\s+)?file\s+(${Q})\s+from\s+the\s+device\s+as\s+([A-Za-z_][\w.-]*)$`, 'i'),
    build: (m, q) => mobile('pullFile', {}, { value: V(m[1], q), captureAs: m[2] }) },
  { name: 'mobile-permission', keywords: ['grant', 'allow', 'revoke'], example: 'Grant the app permission "android.permission.CAMERA"',
    re: new RegExp(String.raw`^(grant|allow|revoke|deny)\s+the\s+app\s+(?:the\s+)?permissions?\s+((?:${Q})(?:\s*(?:,|and)\s*${Q})*)$`, 'i'),
    build: (m, q) => mobile('permission', {
      grant: /^(?:grant|allow)$/i.test(m[1]),
      permissions: m[2].split(/\s*(?:,|\band\b)\s*/i).map((p) => V(p, q)).filter(Boolean),
    }) },
  { name: 'mobile-network', keywords: ['turn', 'enable', 'disable'], example: 'Turn on airplane mode',
    re: /^(?:turn|switch)\s+(on|off)\s+(airplane|flight|aeroplane)\s+mode$|^(?:turn|switch)\s+(on|off)\s+(?:the\s+)?(wi-?fi|mobile\s+data|cellular\s+data|data)$/i,
    build: (m) => {
      if (m[1]) return mobile('network', { airplane: m[1].toLowerCase() === 'on' });
      const on = m[3].toLowerCase() === 'on';
      return mobile('network', /wi-?fi/i.test(m[4]) ? { wifi: on } : { data: on });
    } },
  { name: 'mobile-hide-keyboard', keywords: ['hide', 'dismiss', 'close'], example: 'Hide the keyboard',
    re: /^(?:hide|dismiss|close)\s+the\s+(?:on-?screen\s+|soft\s+|virtual\s+)?keyboard$/i,
    build: () => mobile('hideKeyboard') },
  { name: 'mobile-shake', keywords: ['shake'], example: 'Shake the device',
    re: /^shake\s+the\s+(?:device|phone)$/i,
    build: () => mobile('shake') },
  { name: 'mobile-lock', keywords: ['lock'], example: 'Lock the device for 2 seconds',
    re: new RegExp(String.raw`^lock\s+the\s+(?:device|phone|screen)${SECS}$`, 'i'),
    build: (m) => mobile('lock', m[1] ? { durationMs: ms(m[1], m[2]) } : {}) },
  { name: 'mobile-unlock', keywords: ['unlock'], example: 'Unlock the device',
    re: /^unlock\s+the\s+(?:device|phone|screen)$/i,
    build: () => mobile('unlock') },
  { name: 'mobile-notifications', keywords: ['open', 'pull'], example: 'Open the notifications',
    re: /^(?:open|pull\s+down|show)\s+the\s+notifications?(?:\s+(?:panel|shade|drawer))?$/i,
    build: () => mobile('openNotifications') },
  { name: 'mobile-alert', keywords: ['accept', 'dismiss', 'allow', 'deny'], example: 'Accept the system alert',
    re: /^(accept|dismiss|allow|deny|ok)\s+the\s+(?:system|permission|native|os|device)\s+(?:alert|dialog|popup|prompt)$/i,
    build: (m) => mobile('alert', { accept: /^(?:accept|allow|ok)$/i.test(m[1]) }) },
]);

/** Canonical plain-English line for a `mobile` step (the inverse of MOBILE_RULES). */
export function mobileStepToText(s: Step): string {
  const a = (s.args ?? {}) as Record<string, unknown>;
  const d = s.target?.description ?? '';
  const secs = (v: unknown) => (typeof v === 'number' ? ` for ${v % 1000 === 0 ? `${v / 1000} seconds` : `${v} ms`}` : '');
  const id = (v: unknown) => (typeof v === 'string' ? ` ${quoteText(v)}` : '');
  switch (a.op) {
    case 'swipeUntil': return `Swipe ${String(a.direction)} until ${d} is visible${a.max !== undefined ? ` at most ${String(a.max)} times` : ''}`;
    case 'swipe': {
      const f = a.from as { x: number; y: number };
      const t = a.to as { x: number; y: number };
      return `Swipe from ${f.x}, ${f.y} to ${t.x}, ${t.y}${a.durationMs !== undefined ? ` in ${String(a.durationMs)} ms` : ''}`;
    }
    case 'tapAt': return `Tap at ${String(a.x)}, ${String(a.y)}`;
    case 'longPress': return `Long press ${d}${secs(a.durationMs)}`;
    case 'pinch': return `Pinch ${String(a.direction)}${d ? ` on ${d}` : ''}`;
    case 'rotate': return `Rotate to ${String(a.orientation)}`;
    case 'back': return 'Press the device back button';
    case 'home': return 'Press the device home button';
    case 'background': return `Put the app in the background${secs(a.durationMs)}`;
    case 'activateApp': return a.appId ? `Activate the app${id(a.appId)}` : 'Bring the app to the foreground';
    case 'terminateApp': return `Close the app${id(a.appId)}`;
    case 'restartApp': return 'Restart the app';
    case 'installApp': return `Install the app ${quoteText(s.value ?? '')}`;
    case 'removeApp': return `Uninstall the app${id(a.appId)}`;
    case 'deepLink': return `Open the deep link ${quoteText(s.value ?? '')}`;
    case 'context': return a.context === 'native' ? 'Switch to the native app' : `Switch to the web view${id(a.name)}`;
    case 'pushFile': return `Push file ${quoteText(s.value ?? '')} to ${quoteText(String(a.remote ?? ''))}`;
    case 'pullFile': return `Pull file ${quoteText(s.value ?? '')} from the device as ${s.captureAs ?? 'file'}`;
    case 'permission': return `${a.grant ? 'Grant' : 'Revoke'} the app permission ${(a.permissions as string[]).map(quoteText).join(', ')}`;
    case 'network': {
      if (a.airplane !== undefined) return `Turn ${a.airplane ? 'on' : 'off'} airplane mode`;
      if (a.wifi !== undefined) return `Turn ${a.wifi ? 'on' : 'off'} wifi`;
      return `Turn ${a.data ? 'on' : 'off'} mobile data`;
    }
    case 'hideKeyboard': return 'Hide the keyboard';
    case 'shake': return 'Shake the device';
    case 'lock': return `Lock the device${secs(a.durationMs)}`;
    case 'unlock': return 'Unlock the device';
    case 'openNotifications': return 'Open the notifications';
    case 'alert': return `${a.accept ? 'Accept' : 'Dismiss'} the system alert`;
    default: throw new Error(`Step ${s.id}: mobile operation "${String(a.op)}" cannot be expressed in .ez; keep this journey in YAML/JSON`);
  }
}
