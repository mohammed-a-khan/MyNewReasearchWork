/**
 * page.pause(): hands control to a live debugger. The runner's debugger
 * (eztest debug, the Studio debugger) registers a handler for the browser
 * contexts of the journey it is debugging; page.pause() on one of their pages
 * pauses there until the debugger resumes. Without a debugger page.pause()
 * fails: it never silently continues.
 */
type PauseHandler = (page: unknown) => Promise<void>;

const handlers = new WeakMap<object, PauseHandler>();

/** Internal (the debugger): pause handler for a browser context, or undefined to remove it. */
export function setPauseHandler(context: object, handler: PauseHandler | undefined): void {
  if (handler) handlers.set(context, handler);
  else handlers.delete(context);
}

/** The handler registered for a context, if any. */
export function pauseHandlerFor(context: object): PauseHandler | undefined {
  return handlers.get(context);
}

export const NO_DEBUGGER_TEXT = 'page.pause() needs a live debugger: run the journey with `eztest debug` or from the Studio debugger (Debug tab). Outside a debugger there is nothing to hand control to, so EZTest stops here instead of continuing silently.';
