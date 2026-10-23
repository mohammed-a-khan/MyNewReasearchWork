/**
 * Network emulation per population (WAN latency, jitter, bandwidth and
 * packet loss), done by EZTest's own connection shaper: a loopback relay
 * per destination that every shaped connection goes through. Each
 * direction of each connection is a FIFO with release times:
 *
 *   release = max(now + latency/2 ± jitter, previous release) + bytes / bandwidth
 *
 * and a lost "packet" (one chunk of at most `mtu` bytes, with probability
 * lossPercent) is delivered one retransmission timeout later, the way TCP
 * would recover it. Bandwidth is per connection (a browser opens several).
 */
import { createServer, connect as netConnect, type Server, type Socket } from 'node:net';
import type { NetworkSpec } from '../model.js';

export interface ShapeSettings {
  /** One-way delay in ms (half the round trip). */
  delayMs: number;
  jitterMs: number;
  /** Bytes per ms (0 = unlimited). */
  bytesPerMs: number;
  loss: number;
  rtoMs: number;
  mtu: number;
}

export function shapeSettings(n: NetworkSpec, direction: 'down' | 'up'): ShapeSettings {
  const kbps = direction === 'down' ? n.downloadKbps : n.uploadKbps;
  return {
    delayMs: n.latencyMs / 2,
    jitterMs: n.jitterMs / 2,
    bytesPerMs: kbps > 0 ? (kbps * 1000) / 8 / 1000 : 0,
    loss: n.lossPercent / 100,
    rtoMs: Math.max(200, n.latencyMs * 2),
    mtu: 1460,
  };
}

/** Pipe `from` into `to` with shaping; returns a function that stops it. */
export function shapedPipe(from: Socket, to: Socket, s: ShapeSettings, random: () => number = Math.random): void {
  const queue: Array<{ at: number; data: Buffer }> = [];
  let lastRelease = 0;
  let timer: NodeJS.Timeout | undefined;
  let ended = false;
  let queued = 0;
  const HIGH = 1 << 20;

  const flush = () => {
    timer = undefined;
    const now = performance.now();
    while (queue.length && queue[0].at <= now + 0.5) {
      const item = queue.shift()!;
      queued -= item.data.length;
      if (!to.destroyed) to.write(item.data);
    }
    if (queued < HIGH && from.isPaused()) from.resume();
    if (queue.length) timer = setTimeout(flush, Math.max(0, queue[0].at - performance.now()));
    else if (ended && !to.destroyed) to.end();
  };

  from.on('data', (chunk: Buffer) => {
    for (let off = 0; off < chunk.length; off += s.mtu) {
      const part = chunk.subarray(off, Math.min(chunk.length, off + s.mtu));
      const now = performance.now();
      let at = now + s.delayMs + (s.jitterMs ? (random() * 2 - 1) * s.jitterMs : 0);
      if (s.loss > 0 && random() < s.loss) at += s.rtoMs;
      at = Math.max(at, lastRelease);
      if (s.bytesPerMs > 0) at += part.length / s.bytesPerMs;
      lastRelease = at;
      queue.push({ at, data: Buffer.from(part) });
      queued += part.length;
    }
    if (queued >= HIGH) from.pause();
    if (!timer) timer = setTimeout(flush, Math.max(0, queue[0].at - performance.now()));
  });
  from.on('end', () => {
    ended = true;
    if (!queue.length && !timer && !to.destroyed) to.end();
  });
  const destroy = () => {
    if (timer) clearTimeout(timer);
    queue.length = 0;
    if (!to.destroyed) to.destroy();
  };
  from.on('error', destroy);
  from.on('close', (hadError) => {
    if (hadError) destroy();
  });
}

/**
 * Loopback relays, one per destination host:port, applying a population's
 * network settings. `target(host, port)` gives the local port to connect to.
 */
export class ConnectionShaper {
  private readonly relays = new Map<string, Promise<{ server: Server; port: number }>>();
  private readonly sockets = new Set<Socket>();
  readonly down: ShapeSettings;
  readonly up: ShapeSettings;

  constructor(readonly network: NetworkSpec, private readonly random: () => number = Math.random) {
    this.down = shapeSettings(network, 'down');
    this.up = shapeSettings(network, 'up');
  }

  get active(): boolean {
    const n = this.network;
    return n.latencyMs > 0 || n.jitterMs > 0 || n.downloadKbps > 0 || n.uploadKbps > 0 || n.lossPercent > 0;
  }

  target(host: string, port: number): Promise<{ host: string; port: number }> {
    const key = `${host}:${port}`;
    let p = this.relays.get(key);
    if (!p) {
      p = new Promise((resolve, reject) => {
        const server = createServer((client) => {
          const upstream = netConnect({ host, port });
          this.sockets.add(client);
          this.sockets.add(upstream);
          client.setNoDelay(true);
          upstream.setNoDelay(true);
          client.pause();
          upstream.once('connect', () => client.resume());
          shapedPipe(client, upstream, this.up, this.random);
          shapedPipe(upstream, client, this.down, this.random);
          const gone = () => {
            this.sockets.delete(client);
            this.sockets.delete(upstream);
          };
          client.on('close', () => {
            gone();
            if (!upstream.destroyed) upstream.destroy();
          });
          upstream.on('close', () => {
            gone();
            if (!client.destroyed) client.end();
          });
          upstream.on('error', () => client.destroy());
          client.on('error', () => upstream.destroy());
        });
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }));
      });
      this.relays.set(key, p);
    }
    return p.then((r) => ({ host: '127.0.0.1', port: r.port }));
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    const relays = await Promise.all([...this.relays.values()].map((p) => p.catch(() => undefined)));
    await Promise.all(relays.map((r) => (r ? new Promise<void>((res) => r.server.close(() => res())) : undefined)));
    this.relays.clear();
  }
}
