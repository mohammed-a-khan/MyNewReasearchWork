/**
 * In-process broker: topics fan out to every subscriber, queues hand each
 * message to one consumer (or keep it until one subscribes). Used for dry
 * runs, examples and unit tests; behaves like the real drivers.
 */
import { BusSubscription, decodePayload, type BusDestination, type BusDriver, type BusMessage, type OutgoingMessage, type PublishReceipt, type SubscribeOptions } from './types.js';

export class MemoryBroker {
  private readonly topics = new Map<string, BusMessage[]>();
  private readonly queues = new Map<string, BusMessage[]>();
  private readonly subs = new Set<{ dest: BusDestination; sub: BusSubscription }>();
  private seq = 0;

  publish(dest: BusDestination, msg: OutgoingMessage): PublishReceipt {
    const id = `mem-${++this.seq}`;
    const m: BusMessage = {
      destination: dest.name, ...decodePayload(msg.payload), ...(msg.key !== undefined ? { key: msg.key } : {}), headers: { ...(msg.headers ?? {}) },
      ...(msg.correlationId ? { correlationId: msg.correlationId } : {}), messageId: id, timestamp: Date.now(), offset: String(this.seq),
      ...(dest.routingKey ? { routingKey: dest.routingKey } : {}),
    };
    if (dest.type === 'queue') {
      const listener = [...this.subs].find((s) => s.dest.type === 'queue' && s.dest.name === dest.name && !s.sub.closed);
      if (listener) listener.sub.push(m);
      else this.list(this.queues, dest.name).push(m);
    } else {
      const key = `${dest.type}:${dest.name}`;
      this.list(this.topics, key).push(m);
      for (const s of this.subs) {
        if (s.sub.closed || s.dest.type !== dest.type || !topicMatches(s.dest.name, dest.name)) continue;
        if (dest.type === 'exchange' && s.dest.routingKey && dest.routingKey && !routingMatches(s.dest.routingKey, dest.routingKey)) continue;
        s.sub.push(m);
      }
    }
    return { messageId: id, offset: String(this.seq) };
  }

  subscribe(dest: BusDestination, opts: SubscribeOptions = {}): BusSubscription {
    const sub = new BusSubscription(dest);
    const entry = { dest, sub };
    this.subs.add(entry);
    sub.onClose = async () => {
      this.subs.delete(entry);
    };
    if (dest.type === 'queue') {
      const waiting = this.queues.get(dest.name) ?? [];
      this.queues.set(dest.name, []);
      for (const m of waiting) sub.push(m);
    } else if (opts.fromTimestamp !== undefined) {
      for (const [k, list] of this.topics) {
        const [type, name] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
        if (type !== dest.type || !topicMatches(dest.name, name)) continue;
        for (const m of list) if (m.timestamp >= opts.fromTimestamp) sub.push(m);
      }
    }
    return sub;
  }

  purge(dest: BusDestination): number {
    const n = this.queues.get(dest.name)?.length ?? 0;
    this.queues.set(dest.name, []);
    return n;
  }

  private list(map: Map<string, BusMessage[]>, k: string): BusMessage[] {
    let l = map.get(k);
    if (!l) {
      l = [];
      map.set(k, l);
    }
    return l;
  }
}

/** MQTT-style topic filters ("a/+/c", "a/#"); other kinds compare names exactly. */
export function topicMatches(filter: string, topic: string): boolean {
  if (filter === topic) return true;
  if (!filter.includes('+') && !filter.includes('#')) return false;
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

/** AMQP topic-exchange binding keys ("order.*", "order.#"). */
export function routingMatches(binding: string, key: string): boolean {
  const b = binding.split('.');
  const k = key.split('.');
  const go = (i: number, j: number): boolean => {
    if (i === b.length) return j === k.length;
    if (b[i] === '#') return go(i + 1, j) || (j < k.length && go(i, j + 1));
    if (j === k.length) return false;
    return (b[i] === '*' || b[i] === k[j]) && go(i + 1, j + 1);
  };
  return go(0, 0);
}

const brokers = new Map<string, MemoryBroker>();

/** A named shared in-process broker (the same name returns the same broker). */
export function memoryBroker(name = 'default'): MemoryBroker {
  let b = brokers.get(name);
  if (!b) {
    b = new MemoryBroker();
    brokers.set(name, b);
  }
  return b;
}

export class MemoryBusDriver implements BusDriver {
  readonly kind = 'memory' as const;
  constructor(readonly name: string, readonly broker: MemoryBroker = memoryBroker(name)) {}
  async publish(dest: BusDestination, msg: OutgoingMessage): Promise<PublishReceipt> {
    return this.broker.publish(dest, msg);
  }
  async subscribe(dest: BusDestination, opts?: SubscribeOptions): Promise<BusSubscription> {
    return this.broker.subscribe(dest, opts);
  }
  async purge(dest: BusDestination): Promise<number> {
    return this.broker.purge(dest);
  }
  async close(): Promise<void> {}
}
