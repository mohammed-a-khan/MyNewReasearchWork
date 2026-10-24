/**
 * A WebSocket server for tests (RFC 6455, written here; no library): plain or
 * TLS (optionally requiring a client certificate), with the handshake
 * request, the client certificate and every frame visible to the test.
 * Also a tiny HTTP CONNECT proxy and a throwaway PKI made with openssl.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WsServerConn {
  req: IncomingMessage;
  /** The subprotocol the server picked. */
  protocol: string;
  /** Subject CN of the client certificate (TLS servers). */
  clientCertCn?: string;
  send(text: string): void;
  sendBinary(data: Buffer): void;
  ping(payload?: Buffer): void;
  close(code?: number, reason?: string): void;
  onmessage?: (data: Buffer, binary: boolean) => void;
  onpong?: (payload: Buffer) => void;
  pings: Buffer[];
}

export interface WsServerOptions {
  tls?: { key: Buffer; cert: Buffer; ca?: Buffer; requestCert?: boolean };
  /** Subprotocols the server supports (it picks the first offered one it supports). */
  protocols?: string[];
  /** Refuse the upgrade with this HTTP status (e.g. 401 when Authorization is wrong). */
  authorize?: (req: IncomingMessage) => number | undefined;
  /** Do not answer pings (to test dead-connection detection). */
  ignorePings?: boolean;
  onConnection(conn: WsServerConn): void;
}

function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 0xff]) : (() => {
    const b = Buffer.alloc(10);
    b[0] = 0x80 | opcode;
    b[1] = 127;
    b.writeBigUInt64BE(BigInt(len), 2);
    return b;
  })();
  return Buffer.concat([head, payload]);
}

export async function startWsServer(o: WsServerOptions): Promise<{ url: string; port: number; server: Server; upgrades: IncomingMessage[]; close(): Promise<void> }> {
  const server = o.tls ? createHttpsServer({ key: o.tls.key, cert: o.tls.cert, ...(o.tls.ca ? { ca: o.tls.ca } : {}), requestCert: !!o.tls.requestCert, rejectUnauthorized: !!o.tls.requestCert }) : createHttpServer();
  const upgrades: IncomingMessage[] = [];
  const sockets = new Set<Socket>();
  server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    upgrades.push(req);
    const status = o.authorize?.(req);
    if (status) {
      socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const protocol = offered.find((p) => (o.protocols ?? []).includes(p)) ?? '';
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}${GUID}`).digest('base64');
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []), '', ''].join('\r\n'));
    const peer = (socket as TLSSocket).getPeerCertificate?.();
    const conn: WsServerConn = {
      req, protocol, pings: [],
      ...(peer && peer.subject ? { clientCertCn: String(peer.subject.CN) } : {}),
      send: (t) => socket.write(frame(1, Buffer.from(t))),
      sendBinary: (d) => socket.write(frame(2, d)),
      ping: (p = Buffer.alloc(0)) => socket.write(frame(9, p)),
      close: (code = 1000, reason = '') => {
        const b = Buffer.alloc(2 + Buffer.byteLength(reason));
        b.writeUInt16BE(code, 0);
        b.write(reason, 2);
        socket.write(frame(8, b));
        socket.end();
      },
    };
    let buf = Buffer.alloc(0);
    let parts: Buffer[] = [];
    let partOp = 1;
    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (!(buf[1] & 0x80)) {
          socket.destroy(); // clients must mask (RFC 6455 5.1)
          return;
        }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        const fin = (buf[0] & 0x80) !== 0;
        const op = buf[0] & 0x0f;
        buf = buf.subarray(off + 4 + len);
        if (op === 8) {
          socket.write(frame(8, payload.subarray(0, 2)));
          socket.end();
          return;
        }
        if (op === 9) {
          conn.pings.push(payload);
          if (!o.ignorePings) socket.write(frame(10, payload));
          continue;
        }
        if (op === 10) {
          conn.onpong?.(payload);
          continue;
        }
        if (op === 1 || op === 2) {
          parts = [payload];
          partOp = op;
        } else if (op === 0) parts.push(payload);
        if (fin) conn.onmessage?.(Buffer.concat(parts), partOp === 2);
      }
    });
    socket.on('error', () => undefined);
    o.onConnection(conn);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `${o.tls ? 'wss' : 'ws'}://127.0.0.1:${port}`, port, server, upgrades,
    close: () => new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    }),
  };
}

/** A minimal HTTP CONNECT proxy; `seen` lists the tunnels it opened. */
export async function startConnectProxy(auth?: string): Promise<{ url: string; seen: string[]; close(): Promise<void> }> {
  const seen: string[] = [];
  const sockets = new Set<Socket>();
  const server = createHttpServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on('connect', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    sockets.add(socket);
    if (auth && req.headers['proxy-authorization'] !== `Basic ${Buffer.from(auth).toString('base64')}`) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    seen.push(`CONNECT ${req.url}`);
    const [host, port] = String(req.url).split(':');
    const up = connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    sockets.add(up);
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://${auth ? `${auth}@` : ''}127.0.0.1:${(server.address() as AddressInfo).port}`, seen,
    close: () => new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    }),
  };
}

export interface TestPki { dir: string; ca: Buffer; serverKey: Buffer; serverCert: Buffer; clientKey: Buffer; clientCert: Buffer }

/** A CA, a server certificate for localhost / 127.0.0.1 and a client certificate (CN eztest-ws-client), made with openssl. */
export function makeTestPki(): TestPki {
  const dir = mkdtempSync(join(tmpdir(), 'eztest-pki-'));
  const o = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  o('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=EZTest WS Test CA');
  writeFileSync(join(dir, 'server.ext'), 'subjectAltName=IP:127.0.0.1,DNS:localhost\n');
  o('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost');
  o('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '2', '-extfile', 'server.ext');
  o('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'client.key', '-out', 'client.csr', '-subj', '/CN=eztest-ws-client');
  o('x509', '-req', '-in', 'client.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'client.pem', '-days', '2');
  const r = (f: string) => readFileSync(join(dir, f));
  return { dir, ca: r('ca.pem'), serverKey: r('server.key'), serverCert: r('server.pem'), clientKey: r('client.key'), clientCert: r('client.pem') };
}

export function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
