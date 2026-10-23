/**
 * The Studio event hub: one multiplexed stream of typed events, grouped in
 * topics (run progress, recorder, file changes, problems, and topics added by
 * later features). Every event gets a global sequence number; the hub keeps
 * the last N events per topic so a reconnecting client can replay what it
 * missed (`Last-Event-ID`), and `/api/events` streams it all as SSE.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Payloads per topic. Feature modules extend this with declaration merging:
 *
 *   declare module '../events.js' { interface StudioTopics { debug: { type: 'paused'; stepId: string } } }
 */
export interface StudioTopics {
  /** Run progress: runner events (`run:start`, `step:end`, ...) plus Studio ones (`queued`, `analysis`, `cancelled`, `done`). */
  run: { type: string; runId: string; [k: string]: unknown };
  /** Recorder: `started`, `line`, `stopped`. */
  recorder: { type: string; [k: string]: unknown };
  /** Journey files changed on disk: `added`, `changed`, `removed`. */
  files: { type: 'added' | 'changed' | 'removed'; path: string };
  /** Validation problems of one journey file after it changed. */
  problems: { type: 'file'; path: string; errors: Array<{ line?: number; column?: number; message: string; suggestions: string[] }> };
  /** Hub housekeeping: `hello` on connect. */
  system: { type: string; [k: string]: unknown };
}

export type TopicName = keyof StudioTopics & string;

export interface HubEvent<T extends string = string> {
  seq: number;
  topic: T;
  /** ISO timestamp. */
  at: string;
  data: T extends TopicName ? StudioTopics[T] : { type: string; [k: string]: unknown };
}

export type HubListener = (e: HubEvent) => void;

export interface TopicOptions {
  /** How many recent events of this topic are kept for replay. Default 500. */
  replay?: number;
  description?: string;
}

interface TopicState {
  options: Required<Pick<TopicOptions, 'replay'>> & TopicOptions;
  buffer: HubEvent[];
}

export class EventHub {
  private seq = 0;
  private readonly topics = new Map<string, TopicState>();
  private readonly listeners = new Set<{ topics?: Set<string>; fn: HubListener }>();

  constructor() {
    this.registerTopic('run', { replay: 2000, description: 'Run progress' });
    this.registerTopic('recorder', { replay: 1000, description: 'Recorder lines' });
    this.registerTopic('files', { replay: 200, description: 'Journey file changes on disk' });
    this.registerTopic('problems', { replay: 200, description: 'Validation problems per file' });
    this.registerTopic('system', { replay: 20, description: 'Hub housekeeping' });
  }

  /** Declare a topic (idempotent; a later call updates its options). Publishing to an undeclared topic declares it with defaults. */
  registerTopic(name: string, options: TopicOptions = {}): void {
    const existing = this.topics.get(name);
    const opts = { replay: 500, ...existing?.options, ...options };
    if (existing) existing.options = opts;
    else this.topics.set(name, { options: opts, buffer: [] });
  }

  topicNames(): Array<{ name: string; replay: number; description?: string }> {
    return [...this.topics.entries()].map(([name, t]) => ({ name, replay: t.options.replay, description: t.options.description }));
  }

  get lastSeq(): number {
    return this.seq;
  }

  publish<T extends TopicName>(topic: T, data: StudioTopics[T]): HubEvent<T>;
  publish(topic: string, data: { type: string; [k: string]: unknown }): HubEvent;
  publish(topic: string, data: { type: string; [k: string]: unknown }): HubEvent {
    if (!this.topics.has(topic)) this.registerTopic(topic);
    const t = this.topics.get(topic)!;
    const e = { seq: ++this.seq, topic, at: new Date().toISOString(), data } as HubEvent;
    t.buffer.push(e);
    if (t.buffer.length > t.options.replay) t.buffer.splice(0, t.buffer.length - t.options.replay);
    for (const l of this.listeners) {
      if (l.topics && !l.topics.has(topic)) continue;
      try {
        l.fn(e);
      } catch {
        // A broken listener never breaks the publisher.
      }
    }
    return e;
  }

  /** Listen to some topics (or all when omitted). Returns an unsubscribe function. */
  subscribe(fn: HubListener, topics?: string[]): () => void {
    const entry = { topics: topics?.length ? new Set(topics) : undefined, fn };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  /** Buffered events after `afterSeq`, oldest first, optionally limited to topics. */
  replay(afterSeq = 0, topics?: string[]): HubEvent[] {
    const want = topics?.length ? new Set(topics) : undefined;
    const out: HubEvent[] = [];
    for (const [name, t] of this.topics) {
      if (want && !want.has(name)) continue;
      for (const e of t.buffer) if (e.seq > afterSeq) out.push(e);
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

/** SSE framing for one hub event: the payload is `{ seq, topic, at, ...data }`. */
export function sseFrame(e: HubEvent): string {
  return `id: ${e.seq}\ndata: ${JSON.stringify({ seq: e.seq, topic: e.topic, at: e.at, ...e.data })}\n\n`;
}

export interface SseOptions {
  /** Replay buffered events after this sequence number (default: Last-Event-ID header, else 0). */
  since?: number;
  topics?: string[];
  /** Filter for this stream (applied to replay and live events). */
  filter?: (e: HubEvent) => boolean;
  /** Format an event (default `sseFrame`). */
  frame?: (e: HubEvent) => string;
  /** End the stream after this event has been sent. */
  isFinal?: (e: HubEvent) => boolean;
  heartbeatMs?: number;
}

/** Stream hub events to an SSE response: replay first, then live, with heartbeats. */
export function streamHub(hub: EventHub, req: IncomingMessage, res: ServerResponse, opts: SseOptions = {}): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  // On reconnect the browser sends Last-Event-ID; it wins over the URL's initial `since`.
  const headerId = Number(req.headers['last-event-id'] ?? 0) || 0;
  const since = Math.max(opts.since ?? 0, headerId);
  const frame = opts.frame ?? sseFrame;
  let ended = false;
  let off: () => void = () => {};
  const finish = () => {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    off();
    res.end();
  };
  const send = (e: HubEvent) => {
    if (ended || (opts.filter && !opts.filter(e))) return;
    res.write(frame(e));
    if (opts.isFinal?.(e)) finish();
  };
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), opts.heartbeatMs ?? 15_000);
  res.write('retry: 2000\n\n');
  // Subscribe before replaying so nothing published in between is lost; dedupe by seq.
  const queued: HubEvent[] = [];
  let replaying = true;
  off = hub.subscribe((e) => (replaying ? queued.push(e) : send(e)), opts.topics);
  let last = since;
  for (const e of hub.replay(since, opts.topics)) {
    send(e);
    last = e.seq;
  }
  replaying = false;
  for (const e of queued) if (e.seq > last) send(e);
  req.on('close', finish);
}

/** An event of a single run or recording log (per-log sequence numbers). */
export interface StudioEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

/**
 * Stream one run's or recording's own log as SSE (the per-resource endpoints
 * such as `/api/runs/:id/events`): replay, then live, until a final event.
 * The payload is `{ type, ...data }`.
 */
export function streamLog(
  req: IncomingMessage,
  res: ServerResponse,
  history: StudioEvent[],
  subscribe: (l: (e: StudioEvent) => void) => () => void,
  isFinal: (e: StudioEvent) => boolean,
): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const lastId = Number(req.headers['last-event-id'] ?? 0) || 0;
  let ended = false;
  let off: () => void = () => {};
  const finish = () => {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    off();
    res.end();
  };
  const send = (e: StudioEvent) => {
    if (ended) return;
    res.write(`id: ${e.seq}\ndata: ${JSON.stringify({ type: e.type, ...e.data })}\n\n`);
    if (isFinal(e)) finish();
  };
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
  res.write('retry: 2000\n\n');
  for (const e of history) if (e.seq > lastId) send(e);
  if (!ended) off = subscribe(send);
  req.on('close', finish);
}
