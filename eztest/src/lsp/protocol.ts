/**
 * Minimal JSON-RPC 2.0 over the Language Server Protocol base framing
 * (`Content-Length: N\r\n\r\n<json>`), dependency free. Used by
 * `eztest lsp` over stdio and by tests driving the server.
 */
import type { Readable, Writable } from 'node:stream';

export interface Message {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ServerNotInitialized: -32002,
  RequestFailed: -32803,
} as const;

/** Incremental decoder of framed messages. */
export class MessageReader {
  private buf = Buffer.alloc(0);

  constructor(input: Readable, private readonly onMessage: (m: Message) => void, private readonly onError: (e: Error) => void = () => {}) {
    input.on('data', (chunk: Buffer | string) => this.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk));
  }

  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const header = this.buf.subarray(0, end).toString('ascii');
      const m = /content-length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.onError(new Error(`LSP header without Content-Length: ${header}`));
        this.buf = this.buf.subarray(end + 4);
        continue;
      }
      const len = Number(m[1]);
      if (this.buf.length < end + 4 + len) return;
      const body = this.buf.subarray(end + 4, end + 4 + len).toString('utf8');
      this.buf = this.buf.subarray(end + 4 + len);
      try {
        this.onMessage(JSON.parse(body) as Message);
      } catch (e) {
        this.onError(e as Error);
      }
    }
  }
}

/** Encode and write one message. */
export function writeMessage(out: Writable, m: Message): void {
  const body = Buffer.from(JSON.stringify(m), 'utf8');
  out.write(`Content-Length: ${body.length}\r\n\r\n`);
  out.write(body);
}
