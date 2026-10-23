/**
 * Canonical .ez text for the advanced step types (the inverse of
 * rules-advanced.ts). Block steps render as their opener line; the caller
 * renders children and the closing "End".
 */
import { clockStepToText } from './rules-clock.js';
import { integrationStepToText } from '../integration/rules.js';
import { storeStepToText } from '../store/rules.js';
import type { Condition, FlowSpec, Step } from '../core/index.js';
import { conditionToText } from './conditions.js';
import { quoteText } from './quotes.js';
import { componentStepToText } from './rules-components.js';

type A = Record<string, unknown>;
const q = (v: unknown) => quoteText(String(v));
const word = (v: unknown) => (/^[\w.-]+$/.test(String(v)) ? String(v) : q(v));
const store = (k?: string) => (k ? ` and store it as ${k}` : '');
const storeResult = (k?: string) => (k ? ` and store the result as ${k}` : '');
const kvText = (o: Record<string, unknown>) => Object.entries(o).map(([k, v]) => `${k}=${q(v)}`).join(', ');

function cannot(s: Step, why: string): never {
  throw new Error(`Step ${s.id} (${s.action}) cannot be written as one .ez line: ${why}`);
}

/** Text of an If/While condition. */
export function flowConditionText(f: FlowSpec | undefined): string {
  if (f?.expr !== undefined) return f.expr;
  if (f?.condition) return conditionToText(f.condition as Condition);
  throw new Error('flow step without a condition');
}

export function advancedStepToText(s: Step): string {
  const a: A = s.args ?? {};
  const d = s.target?.description ?? '';
  const v = s.value ?? '';
  const f = s.flow ?? {};
  switch (s.action) {
    case 'component': return componentStepToText(s);
    // ------------------------------------------------------------ flow
    case 'if': return `${f.negate ? 'Unless' : 'If'} ${flowConditionText(f)} then`;
    case 'repeat': return `Repeat ${f.times} times${f.as ? ` as ${f.as}` : ''}`;
    case 'forEach':
      if (f.data) return `For each ${f.as ?? 'row'} in data ${q(f.data)}${f.sheet ? ` sheet ${q(f.sheet)}` : ''}`;
      return `For each ${f.as ?? 'item'} in ${f.items}`;
    case 'while':
      if (f.delayMs) cannot(s, 'a While delay is YAML/JSON only');
      return `${f.negate ? 'Repeat until' : 'While'} ${flowConditionText(f)}${f.maxIterations ? ` at most ${f.maxIterations} times` : ''}`;
    case 'retry': return `Retry up to ${f.attempts ?? 3} times${f.delayMs !== undefined ? ` every ${f.delayMs} ms` : ''}`;
    case 'try': return 'Try';
    case 'group': return `Group ${q(v || s.intent)}`;
    case 'runJourney': return `Run journey ${q(v)}${s.args && Object.keys(s.args).length ? ` with ${kvText(s.args)}` : ''}${storeResult(s.captureAs)}`;
    case 'code': return `Run code ${q(v)}${s.args && Object.keys(s.args).length ? ` with ${kvText(s.args)}` : ''}${s.captureAs ? ` as ${s.captureAs}` : ''}`;
    case 'set': {
      const ex = a.extract as { from: string; kind?: string; pattern?: string; path?: string; name?: string } | undefined;
      if (!ex) return `Set variable ${s.captureAs} to ${v}`;
      const src = ex.from;
      switch (ex.kind ?? 'regex') {
        case 'link': return `Extract the link from ${src}${ex.pattern ? ` matching ${q(ex.pattern)}` : ''} as ${s.captureAs}`;
        case 'code': {
          const digits = ex.pattern ? /^\\b\(\\d\{(\d+)\}\)\\b$/.exec(ex.pattern) : null;
          if (digits) return `Extract the ${digits[1]}-digit code from ${src} as ${s.captureAs}`;
          return `Extract the code from ${src}${ex.pattern ? ` matching ${q(ex.pattern)}` : ''} as ${s.captureAs}`;
        }
        case 'regex': return `Extract ${q(ex.pattern)} from ${src} as ${s.captureAs}`;
        case 'jsonPath': return `Capture ${q(ex.path)} from ${src} as ${s.captureAs}`;
        case 'header': return `Capture the header ${q(ex.name)} of ${src} as ${s.captureAs}`;
        case 'status': return `Capture the status of ${src} as ${s.captureAs}`;
        case 'rows': {
          const e = ex as { sheet?: string; delimiter?: string };
          return `Read the download ${src}${e.sheet ? ` sheet ${q(e.sheet)}` : ''} as rows into ${s.captureAs}${e.delimiter ? ` with delimiter ${q(e.delimiter)}` : ''}`;
        }
      }
      return cannot(s, `extract kind ${ex.kind}`);
    }
    // ------------------------------------------------------------ tabs, frames, dialogs
    case 'tab': {
      if (a.op === 'open') return `Open a new tab${v ? ` with ${q(v)}` : ''}${a.name ? ` as ${q(a.name)}` : ''}`;
      if (a.op === 'close') {
        if (a.by === 'index') return `Close tab ${a.value}`;
        if (a.by === 'title') return `Close the tab titled ${q(a.value)}`;
        if (a.by) cannot(s, `close by ${String(a.by)}`);
        return 'Close the tab';
      }
      switch (a.by) {
        case 'new': return 'Switch to the new tab';
        case 'main': return 'Switch back to the main tab';
        case 'previous': return 'Switch back to the previous tab';
        case 'index': return `Switch to tab ${a.value}`;
        case 'title': return `Switch to the tab titled ${q(a.value)}`;
        case 'url': return `Switch to the tab with URL ${q(a.value)}`;
      }
      return cannot(s, `switch by ${String(a.by)}`);
    }
    case 'frame': {
      if (a.op === 'main') return 'Switch to the main frame';
      if (a.op === 'parent') return 'Switch to the parent frame';
      const path = ((a.path as string[] | undefined) ?? [v]).map(q).join(' > ');
      return s.steps ? `In frame ${path}` : `Switch to frame ${path}`;
    }
    case 'dialog': {
      const kind = a.kind && a.op !== 'answer' ? `${String(a.kind)} ` : '';
      if (a.op === 'answer') return `Answer the next prompt with ${q(v)}${store(s.captureAs)}`;
      return `${a.op === 'dismiss' ? 'Dismiss' : 'Accept'} the next ${kind}dialog${store(s.captureAs)}`;
    }
    // ------------------------------------------------------------ input
    case 'keyboard': {
      if (a.op === 'down') return `Hold down ${v}`;
      if (a.op === 'up') return `Release ${v}`;
      if (a.op === 'insert') return `Insert text ${q(v)}${d ? ` into ${d}` : ''}`;
      const delay = Number(a.delayMs ?? 100);
      if (a.clear) cannot(s, 'clear-before-typing is YAML/JSON only');
      if (!d && delay === 0) return `Type ${q(v)} on the keyboard`;
      if (delay === 100) return `Type ${q(v)} slowly${d ? ` into ${d}` : ''}`;
      return `Type ${q(v)} with a ${delay} ms delay${d ? ` into ${d}` : ''}`;
    }
    case 'mouse': {
      const btn = a.button ? `${String(a.button)} ` : '';
      switch (a.op) {
        case 'move': if (d) cannot(s, 'mouse move to an element: use "Hover over"'); return `Move the mouse to ${a.x}, ${a.y}`;
        case 'down': return `Press the ${btn}mouse button${d ? ` on ${d}` : ''}`;
        case 'up': return `Release the ${btn}mouse button${d ? ` over ${d}` : ''}`;
        case 'clickAt': if (d) cannot(s, 'use "Click X at x, y"'); return `Click at ${a.x}, ${a.y}`;
        case 'wheel': {
          const dx = Number(a.dx ?? 0);
          const dy = Number(a.dy ?? 0);
          if (dx && dy) cannot(s, 'diagonal wheel');
          const dir = dy > 0 ? 'down' : dy < 0 ? 'up' : dx > 0 ? 'right' : 'left';
          return `Scroll the mouse wheel ${dir} by ${Math.abs(dx || dy)}`;
        }
      }
      return cannot(s, `mouse op ${String(a.op)}`);
    }
    case 'drag': {
      const off = a.offset as { x?: number; y?: number } | undefined;
      if (off) return `Drag ${d} by ${off.x ?? 0}, ${off.y ?? 0}`;
      return `Drag ${d} to ${s.to?.description ?? ''}${a.mode === 'html5' ? ' using HTML5 events' : a.mode === 'mouse' ? ' with the mouse' : ''}`;
    }
    case 'scroll': {
      const dir = String(a.direction ?? 'down');
      const by = a.amount !== undefined ? ` by ${a.amount}` : '';
      switch (a.op) {
        case 'page': return dir === 'top' || dir === 'bottom' ? `Scroll to the ${dir}` : `Scroll ${dir}${by}`;
        case 'element': return dir === 'top' || dir === 'bottom' ? `Scroll ${d} to the ${dir}` : `Scroll ${d} ${dir}${by}`;
        case 'intoView': return `Scroll ${d} into view`;
        case 'untilVisible': {
          const c = a.container as { description: string } | undefined;
          return `Scroll ${dir}${c ? ` in ${c.description}` : ''} until ${d} is visible${a.max !== undefined ? ` at most ${a.max} times` : ''}`;
        }
      }
      return cannot(s, `scroll op ${String(a.op)}`);
    }
    case 'focus': return `${a.op === 'blur' ? 'Blur' : 'Focus'} ${d}`;
    case 'touch':
      if (a.op === 'tap') return `Touch ${d}`;
      return `Swipe ${String(a.direction ?? 'left')}${d ? ` on ${d}` : ''}${a.distance !== undefined ? ` by ${a.distance}` : ''}`;
    case 'dispatch': {
      const init = a.init as Record<string, unknown> | undefined;
      const where = d ? ` on ${d}` : a.on ? ` on the ${String(a.on)}` : '';
      let w = '';
      if (init) w = Object.keys(init).length === 1 && 'detail' in init ? ` with detail ${quoteText(JSON.stringify(init.detail))}` : ` with ${quoteText(JSON.stringify(init))}`;
      return `Trigger the ${q(v)} event${where}${w}`;
    }
    // ------------------------------------------------------------ queries and scripts
    case 'query': {
      const k = s.captureAs;
      switch (a.what) {
        case 'attribute': case 'property': case 'css': return `Capture the ${q(a.name)} ${String(a.what)} of ${d} as ${k}`;
        case 'box': return `Capture the bounding box of ${d} as ${k}`;
        case 'html': return `Capture the ${a.outer ? 'outer ' : ''}HTML of ${d} as ${k}`;
        case 'count': return `Count ${d} as ${k}`;
        case 'texts': return `Capture the texts of ${d} as ${k}`;
        case 'table': return `Capture the rows of ${d} as ${k}`;
        case 'url': return `Capture the current URL as ${k}`;
        case 'title': return `Capture the page title as ${k}`;
        case 'state': return `Capture whether ${d} is ${String(a.name)} as ${k}`;
        case 'console': return `Capture the console ${a.level === 'error' ? 'errors' : a.level === 'warning' ? 'warnings' : 'messages'} as ${k}`;
        case 'requests': return `Capture the requests${a.name ? ` to ${q(a.name)}` : ''} as ${k}`;
        case 'dialog': return `Capture the dialog text as ${k}`;
        case 'text': case 'value':
          if (a.pattern !== undefined) return `Capture the ${String(a.what)} of ${d} matching ${q(a.pattern)} as ${k}`;
      }
      return cannot(s, `query ${String(a.what)}`);
    }
    case 'script': {
      if (typeof a.file === 'string') {
        const params = a.params as Record<string, unknown> | undefined;
        return `Run script ${q(a.file)}${d ? ` on ${d}` : ''}${params && Object.keys(params).length ? ` with ${kvText(params)}` : ''}${storeResult(s.captureAs)}`;
      }
      if (/\n/.test(v)) cannot(s, 'multi-line script');
      return `Run JavaScript${d ? ` on ${d}` : ''}${s.captureAs ? ` and store the result as ${s.captureAs}` : ''}: ${v}`;
    }
    // ------------------------------------------------------------ network
    case 'network': {
      const m = a.method ? `${String(a.method)} ` : '';
      switch (a.op) {
        case 'mock': {
          const parts = a.status !== undefined ? [`status ${a.status}`] : [];
          if (a.body !== undefined) parts.push(`body ${q(a.body)}`);
          if (a.bodyFile !== undefined) parts.push(`body from file ${q(a.bodyFile)}`);
          for (const [k, val] of Object.entries((a.headers ?? {}) as Record<string, string>)) parts.push(`header ${q(k)} = ${q(val)}`);
          if (a.contentType !== undefined) parts.push(`content type ${q(a.contentType)}`);
          if (a.times !== undefined) parts.push(`only ${a.times} times`);
          return `Mock ${m}${q(a.url)} with ${parts.join(' and ')}`;
        }
        case 'delay': return `Delay ${m}${q(a.url)} by ${a.ms} ms`;
        case 'block': return a.preset ? `Block ${String(a.preset)}` : `Block ${m}requests to ${q(a.url)}`;
        case 'headers': {
          const h = Object.entries((a.headers ?? {}) as Record<string, string>);
          if (h.length !== 1 || a.method) cannot(s, 'several request headers');
          return `Set request header ${q(h[0][0])} to ${q(h[0][1])}${a.url ? ` for ${q(a.url)}` : ''}`;
        }
        case 'unroute': return a.url ? `Stop mocking ${q(a.url)}` : 'Remove all mocks';
        case 'offline': return 'Go offline';
        case 'online': return 'Go online';
        case 'throttle': return a.profile === 'none' ? 'Stop throttling' : `Throttle the network to ${String(a.profile)}`;
        case 'har': return `Save the network traffic as HAR${a.name ? ` ${q(a.name)}` : ''}${a.url ? ` for ${q(a.url)}` : ''}`;
        case 'replayHar': return `Replay HAR ${q(a.file)}${a.url ? ` for ${q(a.url)}` : ''}`;
      }
      return cannot(s, `network op ${String(a.op)}`);
    }
    // ------------------------------------------------------------ browser state
    case 'browser': {
      const k = s.captureAs;
      switch (a.op) {
        case 'setCookie': return `Set cookie ${q(a.name)} to ${q(a.value)}${a.domain ? ` for ${q(a.domain)}` : a.url ? ` for ${q(a.url)}` : ''}`;
        case 'deleteCookie': return `Delete cookie ${q(a.name)}`;
        case 'clearCookies': return 'Delete all cookies';
        case 'getCookie': return `Capture cookie ${q(a.name)} as ${k}`;
        case 'cookies': return `Capture all cookies as ${k}`;
        case 'setStorage': return `Set ${String(a.area)} storage ${q(a.key)} to ${q(a.value)}`;
        case 'removeStorage': return `Remove ${q(a.key)} from ${String(a.area)} storage`;
        case 'clearStorage': return `Clear ${String(a.area)} storage`;
        case 'getStorage': return `Capture ${String(a.area)} storage${a.key !== undefined ? ` ${q(a.key)}` : ''} as ${k}`;
        case 'clearState': return 'Clear the browser state';
        case 'grant': return `Grant permissions ${((a.permissions as string[]) ?? []).map(q).join(', ')}${a.origin ? ` for ${q(a.origin)}` : ''}`;
        case 'clearPermissions': return 'Revoke all permissions';
        case 'geolocation': if (a.accuracy !== undefined) cannot(s, 'accuracy'); return `Set the geolocation to ${a.latitude}, ${a.longitude}`;
        case 'timezone': return `Set the timezone to ${q(a.value)}`;
        case 'clock': return clockStepToText(s) ?? cannot(s, `clock op ${String(a.clock)}`);
        case 'locale': return `Set the locale to ${q(a.value)}`;
        case 'colorScheme': return `Set the color scheme to ${String(a.value)}`;
        case 'reducedMotion': return a.value === 'reduce' ? 'Prefer reduced motion' : 'Allow motion';
        case 'media': return `Emulate ${String(a.value)} media`;
        case 'device': return `Emulate device ${q(a.value)}`;
        case 'viewport': return `Resize the viewport to ${a.width}x${a.height}`;
        case 'clipboardWrite': return `Copy ${q(a.value)} to the clipboard`;
        case 'clipboardRead': return `Capture the clipboard as ${k}`;
        case 'basicAuth': return `Use basic auth with username ${q(a.username)} and password ${q(a.password)}`;
        case 'headers': {
          const h = Object.entries((a.headers ?? {}) as Record<string, string>);
          if (h.length !== 1) cannot(s, 'several headers');
          return `Send header ${q(h[0][0])} = ${q(h[0][1])} with every request`;
        }
        case 'userAgent': return `Set the user agent to ${q(a.value)}`;
      }
      return cannot(s, `browser op ${String(a.op)}`);
    }
    // ------------------------------------------------------------ messaging, sockets, data
    case 'email':
      return `Get the latest email${a.to ? ` to ${q(a.to)}` : ''}${a.subject ? ` with subject ${q(a.subject)}` : ''}${a.timeoutMs ? ` within ${a.timeoutMs} ms` : ''} as ${s.captureAs ?? 'email'}`;
    case 'sms':
      return `Get the latest SMS${a.to ? ` to ${q(a.to)}` : ''}${a.from ? ` from ${q(a.from)}` : ''}${a.contains ? ` containing ${q(a.contains)}` : ''}${a.timeoutMs ? ` within ${a.timeoutMs} ms` : ''} as ${s.captureAs ?? 'sms'}`;
    case 'ws':
      switch (a.op) {
        case 'connect': return `Connect to websocket ${q(a.url)} as ${String(a.socket ?? 'ws')}`;
        case 'send': return `Send ${q(v)} on websocket ${String(a.socket ?? 'ws')}`;
        case 'expect': return `Wait for a websocket message containing ${q(a.contains)} on ${String(a.socket ?? 'ws')}${store(s.captureAs)}`;
        case 'close': return `Close websocket ${String(a.socket ?? 'ws')}`;
      }
      return cannot(s, `websocket op ${String(a.op)}`);
    case 'compareData': {
      if (a.expectedQuery || a.ignore || a.caseInsensitiveColumns) {
        if (a.columns || a.map || a.failOnExtra === false || s.captureAs) cannot(s, 'compare options are YAML/JSON only');
        const eq = a.expectedQuery as { name: string; connection?: string; params?: string[] } | undefined;
        const keys = Array.isArray(a.key) ? (a.key as string[]) : [String(a.key)];
        const target = eq
          ? `query ${q(eq.name)}${eq.connection ? ` on ${eq.connection}` : ''}${eq.params?.length ? ` with params ${eq.params.map((p) => (/^[\w.-]+$|^\$\{[\w.]+\}$/.test(p) ? p : q(p))).join(', ')}` : ''}`
          : `rows ${String(a.expected)}`;
        const ignore = (a.ignore as string[] | undefined)?.length ? ` ignoring columns ${(a.ignore as string[]).map((c) => q(c)).join(', ')}` : '';
        return `Expect rows ${String(a.actual)} equal ${target} by key ${keys.map((k) => q(k)).join(', ')}${ignore}${a.tolerance !== undefined ? ` with tolerance ${String(a.tolerance)}` : ''}${a.ignoreCase ? ' ignoring case' : ''}`;
      }
      if (a.columns || a.tolerance !== undefined || a.map || a.failOnExtra === false) cannot(s, 'compare options are YAML/JSON only');
      const keys = Array.isArray(a.key) ? (a.key as string[]) : [String(a.key)];
      return `Compare ${String(a.expected)} with ${String(a.actual)} by ${keys.map(word).join(', ')}${a.ignoreCase ? ' ignoring case' : ''}${s.captureAs ? ` and store the result as ${s.captureAs}` : ''}`;
    }
  }
  if (s.action === 'integration') return integrationStepToText(s);
  if (s.action === 'store') return storeStepToText(s);
  return cannot(s, 'no plain-English form');
}

/** Wait steps with args.for (advanced waits). */
export function advancedWaitToText(s: Step): string | undefined {
  const a: A = s.args ?? {};
  const d = s.target?.description ?? '';
  switch (a.for) {
    case 'load': return a.state === 'networkidle' ? 'Wait for the network to be idle' : a.state === 'domcontentloaded' ? 'Wait for the DOM content to load' : 'Wait for the page to load';
    case 'url': return `Wait for the URL to match ${q(a.url)}`;
    case 'state': {
      const map: Record<string, string> = { readonly: 'read-only', inViewport: 'in the viewport' };
      return `Wait for ${d} to be ${map[String(a.state)] ?? String(a.state)}`;
    }
    case 'textChange': return `Wait for the text of ${d} to change${a.from !== undefined ? ` from ${q(a.from)}` : ''}${store(s.captureAs)}`;
    case 'request': case 'response':
      return `Wait for the ${a.method ? `${String(a.method)} ` : ''}${String(a.for)} to ${q(a.url)}${a.status !== undefined ? ` with status ${a.status}` : ''}${store(s.captureAs)}`;
    case 'event': return `Wait for the ${q(a.event)} event${d ? ` on ${d}` : a.on ? ` on the ${String(a.on)}` : ''}${store(s.captureAs)}`;
    case 'listen': return `Listen for the ${q(a.event)} event${d ? ` on ${d}` : a.on ? ` on the ${String(a.on)}` : ''}`;
    case 'loaders': {
      const sel = (a.selectors as string[] | undefined) ?? [];
      return `Wait for loaders${sel.length ? ` ${sel.map((x) => q(x)).join(', ')}` : ''} to disappear${a.timeoutMs !== undefined ? ` within ${a.timeoutMs} ms` : ''}`;
    }
    case 'condition': {
      const cond = a.condition ? conditionToText(a.condition as Condition) : String(a.expr);
      return `Wait until ${cond}${a.timeoutMs !== undefined ? ` within ${a.timeoutMs} ms` : ''}${a.intervalMs !== undefined ? ` every ${a.intervalMs} ms` : ''}`;
    }
  }
  return undefined;
}
