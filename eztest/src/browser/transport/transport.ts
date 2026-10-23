/**
 * Message transports for browser automation protocols. A transport moves
 * whole JSON messages (strings) in both directions and reports when the
 * other side goes away. Two implementations: a pipe (fd 3 / fd 4 with NUL
 * delimiters, Chromium `--remote-debugging-pipe`) and a WebSocket.
 */
import type { Readable, Writable } from 'node:stream';
import { SimpleWebSocket } from './websocket.js';

export interface Transport {
  /** Send one message. Silently dropped after close. */
  send(message: string): void;
  /** Close the transport (idempotent). */
  close(): void;
  /** Called for each received message. */
  onmessage?: (message: string) => void;
  /** Called once when the transport closes (either side). */
  onclose?: (reason?: string) => void;
}

/** NUL-delimited JSON over a pair of streams (what Chromium uses for --remote-debugging-pipe). */
export class PipeTransport implements Transport {
  onmessage?: (message: string) => void;
  onclose?: (reason?: string) => void;
  private chunks: Buffer[] = [];
  private closed = false;

  constructor(private readonly out: Writable, input: Readable) {
    input.on('data', (data: Buffer) => this.receive(data));
    input.on('close', () => this.finish('pipe closed'));
    input.on('error', () => this.finish('pipe error'));
    out.on('error', () => this.finish('pipe error'));
  }

  send(message: string): void {
    if (this.closed) return;
    this.out.write(message);
    this.out.write('\0');
  }

  close(): void {
    this.finish('closed by client');
  }

  private receive(data: Buffer): void {
    let start = 0;
    for (;;) {
      const end = data.indexOf(0, start);
      if (end === -1) break;
      this.chunks.push(data.subarray(start, end));
      const msg = Buffer.concat(this.chunks).toString('utf8');
      this.chunks = [];
      start = end + 1;
      // Deliver asynchronously so a handler that closes the connection cannot reorder later messages.
      try {
        this.onmessage?.(msg);
      } catch (e) {
        process.nextTick(() => {
          throw e;
        });
      }
    }
    if (start < data.length) this.chunks.push(data.subarray(start));
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.out.end();
    } catch {
      /* already gone */
    }
    this.onclose?.(reason);
  }
}

/** A WebSocket client transport (our own RFC 6455 client, see websocket.ts). */
export class WebSocketTransport implements Transport {
  onmessage?: (message: string) => void;
  onclose?: (reason?: string) => void;
  private closed = false;

  private constructor(private readonly ws: SimpleWebSocket) {
    ws.onmessage = (text) => this.onmessage?.(text);
    ws.onclose = (reason) => this.finish(reason);
  }

  /** Connect to a ws:// or wss:// endpoint (optional handshake headers, e.g. for a remote browser behind a gateway). */
  static async connect(url: string, timeoutMs = 30_000, headers?: Record<string, string>): Promise<WebSocketTransport> {
    const ws = await SimpleWebSocket.connect(url, timeoutMs, headers);
    // Browser protocol servers write many small messages; acknowledge them at once (see eagerAck).
    ws.eagerAck();
    return new WebSocketTransport(ws);
  }

  send(message: string): void {
    if (this.closed) return;
    this.ws.send(message);
  }

  close(): void {
    this.ws.close();
    this.finish('closed by client');
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.(reason);
  }
}
