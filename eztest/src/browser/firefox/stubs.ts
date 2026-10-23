/**
 * Stand-ins for the CDP objects of the Chromium engine. The Firefox engine
 * reuses the engine-independent page / frame / context code, whose few CDP
 * members it overrides; anything that still reaches for CDP gets a clear
 * error instead of a crash.
 */
import { EventEmitter } from 'node:events';

/** A CDPSession-shaped object whose commands fail with "<what> ... is not available in Firefox". */
export function cdpUnavailable(what: string): unknown {
  const fail = (method: string) => Promise.reject(new Error(`${method}: ${what} uses the Chrome DevTools Protocol, which is not available in Firefox (WebDriver BiDi)`));
  const em = new EventEmitter();
  return Object.assign(em, {
    sessionId: undefined,
    targetType: 'firefox',
    closed: false,
    send: (method: string) => fail(method),
    sendMayFail: async () => undefined,
    detach: async () => undefined,
  });
}

/** A TargetSession-shaped object for code that reads `page.mainSession` / `frame.session`. */
export function targetSessionUnavailable(): unknown {
  return { cdp: cdpUnavailable('this call'), isMain: true, contexts: new Map(), flushPendingContexts: () => undefined, updateInterception: async () => undefined };
}
