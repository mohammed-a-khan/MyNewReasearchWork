/**
 * The EZTest Load controller/agent protocol: newline-delimited JSON frames
 * over TCP, or TLS (optionally mutual TLS: the controller requires and
 * verifies agent client certificates).
 *
 * Authentication with a shared token is a mutual HMAC challenge-response;
 * the token never crosses the wire:
 *
 *   controller -> agent   { type: "hello", nonce: Nc, version }
 *   agent -> controller   { type: "register", id, host, zone, capacity, nonce: Na, mac: HMAC(token, "agent|" + Nc + "|" + Na + "|" + id) }
 *   controller -> agent   { type: "welcome", index, mac: HMAC(token, "controller|" + Na + "|" + Nc) }
 *
 * Either side drops the connection on a bad MAC. Frames above 64 MB are
 * refused. Heartbeats (ping/pong) detect lost agents.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

export const PROTOCOL_VERSION = 1;
const MAX_FRAME = 64 * 1024 * 1024;

export type Frame = { type: string; [k: string]: unknown };

export function mac(token: string, ...parts: string[]): string {
  return createHmac('sha256', token).update(parts.join('|')).digest('hex');
}

export function macEqual(a: string, b: string): boolean {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function nonce(): string {
  return randomBytes(16).toString('hex');
}

/** A framed JSON connection. Emits 'frame' and 'close'. */
export class Channel extends EventEmitter {
  private buf = '';
  closed = false;

  constructor(readonly socket: Socket | TLSSocket) {
    super();
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.on('data', (chunk: string) => {
      this.buf += chunk;
      if (this.buf.length > MAX_FRAME) {
        this.emit('error', new Error('frame too large'));
        this.close();
        return;
      }
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        let f: Frame;
        try {
          f = JSON.parse(line) as Frame;
        } catch {
          this.emit('error', new Error('malformed frame'));
          this.close();
          return;
        }
        if (!f || typeof f.type !== 'string') continue;
        this.emit('frame', f);
      }
    });
    socket.on('close', () => {
      this.closed = true;
      this.emit('close');
    });
    socket.on('error', (e) => this.emit('error', e));
  }

  send(f: Frame): boolean {
    if (this.closed || this.socket.destroyed) return false;
    return this.socket.write(JSON.stringify(f) + '\n');
  }

  /** Next frame of a type (or rejects on close / timeout). */
  next(type: string, timeoutMs = 30_000): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const onFrame = (f: Frame) => {
        if (f.type !== type) return;
        cleanup();
        resolve(f);
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`connection closed while waiting for "${type}"`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`no "${type}" within ${timeoutMs} ms`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off('frame', onFrame);
        this.off('close', onClose);
      };
      this.on('frame', onFrame);
      this.on('close', onClose);
    });
  }

  close(): void {
    if (!this.socket.destroyed) this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }
}

export interface TlsFiles {
  cert?: string;
  key?: string;
  ca?: string;
}

export function readTls(t: TlsFiles | undefined): { cert?: Buffer; key?: Buffer; ca?: Buffer } | undefined {
  if (!t || (!t.cert && !t.key && !t.ca)) return undefined;
  return { cert: t.cert ? readFileSync(t.cert) : undefined, key: t.key ? readFileSync(t.key) : undefined, ca: t.ca ? readFileSync(t.ca) : undefined };
}

/** "host:port", ":port" or "port". */
export function parseHostPort(s: string, defHost = '127.0.0.1', defPort = 7400): { host: string; port: number } {
  const t = s.trim();
  if (/^\d+$/.test(t)) return { host: defHost, port: Number(t) };
  const m = /^\[?([^\]]*?)\]?:(\d+)$/.exec(t);
  if (m) return { host: m[1] || defHost, port: Number(m[2]) };
  return { host: t || defHost, port: defPort };
}
