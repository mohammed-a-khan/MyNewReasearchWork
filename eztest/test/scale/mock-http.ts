/** A recording HTTP server for publisher / exporter tests. */
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export async function startRecorder(respond: (r: Recorded) => { status?: number; body?: unknown; type?: string } = () => ({})): Promise<{ url: string; requests: Recorded[]; close(): Promise<void> }> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString('latin1')));
    req.on('end', () => {
      const r: Recorded = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body };
      requests.push(r);
      const out = respond(r);
      const text = out.body === undefined ? '' : typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
      res.writeHead(out.status ?? 200, { 'content-type': out.type ?? 'application/json' });
      res.end(text);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}
