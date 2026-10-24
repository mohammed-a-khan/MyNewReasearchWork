/**
 * The driver's own wording for the messages it raises most often, kept in one
 * place so they read the same everywhere (and so classifiers in the runner and
 * insights can recognise them).
 */

/** The page, context or browser went away while an operation was running. */
export const CLOSED_TEXT = 'the page, context or browser was closed before this finished';

/** `${api}: the page, context or browser was closed before this finished`. */
export function closedMessage(api?: string): string {
  return api ? `${api}: ${CLOSED_TEXT}` : CLOSED_TEXT.charAt(0).toUpperCase() + CLOSED_TEXT.slice(1);
}

/**
 * A wait or action that ran out of time: `${api}: timed out after N ms`, plus,
 * when given, what the driver was doing (one line each).
 */
export function timeoutMessage(api: string, ms: number, doing: string[] = [], detail = ''): string {
  const head = `${api}: timed out after ${ms} ms${detail ? ` ${detail}` : ''}`;
  return doing.length ? `${head}\nWhat EZTest was doing:\n${doing.map((l) => `  - ${l}`).join('\n')}` : head;
}

/** A locator that must point at one element matched several. */
export function tooManyMatchesMessage(what: string, count: number, list: string[] = [], more = false): string {
  const items = list.length ? `:\n${list.map((d, i) => `    ${i + 1}) ${d}`).join('\n')}${more ? '\n    ...' : ''}` : '.';
  return `The locator ${what} matched ${count} elements, but this needs exactly one${items}\nNarrow it down, e.g. scope it to a container, add a filter ({ hasText }) or pick one with nth().`;
}

/** The element left the document (removed or re-rendered) during the operation. */
export const DETACHED_TEXT = 'the element is no longer in the page (it was removed or re-rendered)';

/** The JavaScript context the call ran in went away, usually because the page navigated. */
export const CONTEXT_GONE_TEXT = "the page's JavaScript context went away (most often because the page navigated)";

/** The frame the call was aimed at was removed from the page. */
export const FRAME_GONE_TEXT = 'the frame was removed from the page';

/** A handle from one frame or world was passed to another. */
export const FOREIGN_HANDLE_TEXT = 'This handle belongs to another frame or document; pass handles only to evaluate() calls of the frame they came from.';

/** Use of a handle after dispose(). */
export const DISPOSED_HANDLE_TEXT = 'This handle was disposed and can no longer be used';

/** A dialog answered twice. */
export function dialogHandledMessage(verb: 'accept' | 'dismiss'): string {
  return `dialog.${verb}: this dialog was already answered (each dialog takes exactly one accept() or dismiss())`;
}

/** Downloads were not enabled for the context. */
export const DOWNLOADS_OFF_TEXT = 'Downloads are turned off for this context; create it with newContext({ acceptDownloads: true }) to save or read them.';

/** A binding name used twice. */
export function bindingTakenMessage(name: string, where = ''): string {
  return `A function named "${name}" is already exposed${where}; pick another name or expose it once`;
}

/** A route handler answered twice. */
export function routeHandledMessage(api: string): string {
  return `${api}: this request was already answered (continue, fulfill, fallback or abort it once)`;
}
