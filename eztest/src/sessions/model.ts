/**
 * Captured user sessions turned into candidate journeys (gap G36), the
 * deterministic alternative to AI session-to-test generation.
 *
 * A session is a sequence of semantic events (navigate, click, input, select,
 * submit, assert), each with a stable element descriptor. Keystroke values
 * are never kept unless the field is allow-listed, and allow-listed values
 * are masked by the capture snippet. Sessions come from EZTest's own capture
 * snippet, from HAR files, or from rrweb-style event JSON.
 */

export interface ElementDescriptor {
  /** ARIA role, or the tag name when there is no role. */
  role?: string;
  /** Accessible name / visible text (for the plain-English target). */
  name?: string;
  /** Associated <label> text. */
  label?: string;
  placeholder?: string;
  testId?: string;
  id?: string;
  /** Input type (text, email, password, checkbox, ...). */
  inputType?: string;
  tag?: string;
}

export type SemanticEvent =
  | { kind: 'navigate'; url: string; title?: string; t: number }
  | { kind: 'click'; target: ElementDescriptor; t: number; url?: string }
  | { kind: 'input'; target: ElementDescriptor; value?: string; masked: boolean; t: number; url?: string }
  | { kind: 'select'; target: ElementDescriptor; value?: string; masked: boolean; t: number; url?: string }
  | { kind: 'check' | 'uncheck'; target: ElementDescriptor; t: number; url?: string }
  | { kind: 'submit'; target?: ElementDescriptor; t: number; url?: string }
  | { kind: 'assert'; text: string; t: number; url?: string }
  | { kind: 'api'; method: string; url: string; status?: number; t: number };

export interface CapturedSession {
  id: string;
  /** Where the session was captured from, for the report. */
  source: 'eztest' | 'har' | 'rrweb';
  file?: string;
  startedAt?: string;
  /** First document URL (the journey's base). */
  baseUrl?: string;
  events: SemanticEvent[];
}

/** The EZTest capture format (what the snippet posts): a header plus the semantic events. */
export interface CaptureFile {
  eztestCapture: 1;
  startedAt?: string;
  url?: string;
  events: SemanticEvent[];
}

/** A stable key for an element, for clustering and matching (role+name, else label/testid/id/placeholder). */
export function elementKey(d: ElementDescriptor | undefined): string {
  if (!d) return '';
  // Prefer the human-visible identity (role + name/label), so a generated path and
  // a hand-written journey that use the same wording match for clustering and coverage.
  if (d.role && d.name) return `${d.role}:${d.name.toLowerCase()}`;
  if (d.label) return `label:${d.label.toLowerCase()}`;
  if (d.name) return `text:${d.name.toLowerCase()}`;
  if (d.placeholder) return `ph:${d.placeholder.toLowerCase()}`;
  if (d.testId) return `testid:${d.testId}`;
  if (d.id) return `id:${d.id}`;
  return d.tag ?? '';
}

/** A signature of one event for clustering: its kind plus the element/url it targets. */
export function eventSignature(e: SemanticEvent): string {
  switch (e.kind) {
    case 'navigate':
      return `navigate:${pathOf(e.url)}`;
    case 'api':
      return `api:${e.method} ${pathOf(e.url)}`;
    case 'assert':
      return `assert`;
    default:
      return `${e.kind}:${elementKey((e as { target?: ElementDescriptor }).target)}`;
  }
}

/** URL path without query/host specifics, with numeric and id-like segments generalised. */
export function pathOf(url: string): string {
  try {
    const u = new URL(url, 'http://x');
    return u.pathname.replace(/\/\d+(?=\/|$)/g, '/{id}').replace(/\/[0-9a-f]{8,}(?=\/|$)/gi, '/{id}') || '/';
  } catch {
    return url.split('?')[0];
  }
}

/** The clustering signature of a whole session: its interaction path (navigations + actions, asserts and API calls dropped). */
export function sessionSignature(s: CapturedSession): string {
  return s.events.filter((e) => e.kind !== 'assert' && e.kind !== 'api').map(eventSignature).join(' > ');
}
