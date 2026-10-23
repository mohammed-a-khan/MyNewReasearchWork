import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

export interface MockServer {
  url: string;
  server: Server;
  requests: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }>;
  close(): Promise<void>;
}

export async function startMock(handler: (req: IncomingMessage, body: string, res: ServerResponse) => unknown): Promise<MockServer> {
  const requests: MockServer['requests'] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
    try {
      await handler(req, body, res);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
