/**
 * Client side of the event hub: one EventSource on `/api/events`, fanned out
 * to topic listeners. The browser reconnects by itself and sends
 * Last-Event-ID, so the server replays what was missed; duplicates are
 * dropped by sequence number.
 */
import { store } from './store.js';

export interface HubMessage {
  seq: number;
  topic: string;
  at: string;
  type: string;
  [k: string]: unknown;
}

export type ConnectionState = 'connecting' | 'open' | 'reconnecting';

export const connection = store<ConnectionState>('connecting');

const listeners = new Map<string, Set<(m: HubMessage) => void>>();
let source: EventSource | undefined;
let lastSeq = 0;

/** Listen to one topic (`'*'` for all). Returns an unsubscribe function. */
export function onTopic(topic: string, fn: (m: HubMessage) => void): () => void {
  let set = listeners.get(topic);
  if (!set) listeners.set(topic, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

function dispatch(m: HubMessage): void {
  for (const key of [m.topic, '*']) {
    for (const fn of listeners.get(key) ?? []) {
      try {
        fn(m);
      } catch (e) {
        console.error(`listener for topic ${key} failed`, e);
      }
    }
  }
}

/** Connect, replaying only events newer than `since` (the session's last sequence number). */
export function startEvents(since: number): void {
  if (source) return;
  lastSeq = since;
  source = new EventSource(`/api/events?since=${since}`, { withCredentials: true });
  source.onopen = () => connection.set('open');
  source.onerror = () => connection.set(source?.readyState === EventSource.CLOSED ? 'reconnecting' : 'reconnecting');
  source.onmessage = (ev) => {
    let m: HubMessage;
    try {
      m = JSON.parse(ev.data) as HubMessage;
    } catch {
      return;
    }
    if (typeof m.seq === 'number') {
      if (m.seq <= lastSeq) return;
      lastSeq = m.seq;
    }
    dispatch(m);
  };
}

export function lastEventSeq(): number {
  return lastSeq;
}

/** Follow one resource's own SSE log (e.g. `/api/runs/<id>/events`) with full replay. */
export function follow(path: string, onEvent: (e: { type: string; [k: string]: unknown }) => void, isFinal: (e: { type: string }) => boolean): () => void {
  const src = new EventSource(path, { withCredentials: true });
  src.onmessage = (ev) => {
    let e: { type: string; [k: string]: unknown };
    try {
      e = JSON.parse(ev.data);
    } catch {
      return;
    }
    onEvent(e);
    if (isFinal(e)) src.close();
  };
  return () => src.close();
}
