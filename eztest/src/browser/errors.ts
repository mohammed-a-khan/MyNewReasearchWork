/** Errors raised by the EZTest browser driver. */
import { closedMessage } from './messages.js';

/** A wait or action ran out of time. `name` is 'TimeoutError'. */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** The page, context or browser went away while an operation was in flight. */
export class TargetClosedError extends Error {
  constructor(message = closedMessage()) {
    super(message);
    this.name = 'TargetClosedError';
  }
}

/** A protocol command failed (the browser answered with an error). */
export class ProtocolError extends Error {
  /** The protocol method that failed. */
  method: string;
  /** Browser error code, when given. */
  code?: number;
  constructor(method: string, message: string, code?: number) {
    super(`Protocol error (${method}): ${message}`);
    this.name = 'ProtocolError';
    this.method = method;
    this.code = code;
  }
}

/** True when an error means the target (page / frame / context) has gone away. */
export function isClosedError(e: unknown): boolean {
  if (e instanceof TargetClosedError) return true;
  const m = (e as Error | undefined)?.message ?? '';
  return /Target closed|Session closed|has been closed|No target with given id|No session with given id|Not attached to an active page|Browser has been closed|was closed before this finished|browser connection closed|browser target closed/i.test(m);
}

/** True when an evaluation failed because its JS context was destroyed (navigation). */
export function isContextGoneError(e: unknown): boolean {
  const m = (e as Error | undefined)?.message ?? '';
  return /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated or closed|Cannot find default execution context|Frame was detached|Node with given id does not belong to the document|Could not find node with given id|frame got detached|context was discarded|JavaScript context went away|frame was removed from the page/i.test(m);
}

/** Prefix an error message with the API name ("locator.click: ..."). Keeps the error class. */
export function rewriteError<E extends Error>(e: E, apiName: string): E {
  if (!e.message.startsWith(`${apiName}:`)) e.message = `${apiName}: ${e.message}`;
  return e;
}
