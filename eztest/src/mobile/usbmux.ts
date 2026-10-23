/**
 * EZTest's own usbmuxd client (Apple's USB multiplexer that iTunes/Xcode use
 * to reach iOS devices): list devices and open a TCP tunnel to a port on a
 * device, so the host can talk to the EZTest iOS agent on a real iPhone.
 *
 * Wire format: a 16-byte little-endian header (total length, version 1,
 * message type 8 = plist, tag) followed by an XML plist. After a successful
 * "Connect" (Result Number 0) the socket is a raw byte tunnel to the device
 * port. The port is sent in network byte order inside the little-endian
 * integer (the classic usbmuxd quirk).
 */
import { connect, createServer, type Server, type Socket } from 'node:net';
import { EzTestError } from '../core/index.js';
import { buildPlist, parsePlist, type PlistValue } from './plist.js';

export interface UsbmuxEndpoint {
  /** Unix socket path (macOS / Linux). Default /var/run/usbmuxd. */
  path?: string;
  /** TCP endpoint (Windows: 127.0.0.1:27015; also tests). */
  host?: string;
  port?: number;
}

export interface UsbmuxDevice {
  deviceId: number;
  udid: string;
  connectionType: string;
  productId?: number;
}

const MSG_PLIST = 8;

function open(ep: UsbmuxEndpoint): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = ep.port !== undefined ? connect({ host: ep.host ?? '127.0.0.1', port: ep.port }) : connect({ path: ep.path ?? '/var/run/usbmuxd' });
    s.once('connect', () => resolve(s));
    s.once('error', (e) => reject(new EzTestError(`cannot reach usbmuxd (${e.message}); is the device connected and trusted?`, 'USBMUX')));
  });
}

export function encodeUsbmux(msg: Record<string, PlistValue>, tag: number): Buffer {
  const body = Buffer.from(buildPlist(msg), 'utf8');
  const h = Buffer.alloc(16);
  h.writeUInt32LE(16 + body.length, 0);
  h.writeUInt32LE(1, 4);
  h.writeUInt32LE(MSG_PLIST, 8);
  h.writeUInt32LE(tag, 12);
  return Buffer.concat([h, body]);
}

/** Read exactly one usbmux message from a socket (leaves the socket readable afterwards). */
function readMessage(s: Socket): Promise<Record<string, PlistValue>> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 16) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < len) return;
      s.off('data', onData);
      s.pause();
      const rest = buf.subarray(len);
      if (rest.length) s.unshift(rest);
      try {
        resolve(parsePlist(buf.subarray(16, len).toString('utf8')) as Record<string, PlistValue>);
      } catch (e) {
        reject(e);
      }
    };
    s.on('data', onData);
    s.once('error', reject);
    s.resume();
  });
}

/** Byte-swap a 16-bit port into network order (as usbmuxd expects it inside the LE integer). */
export function htons(port: number): number {
  return ((port & 0xff) << 8) | ((port >> 8) & 0xff);
}

export class UsbmuxClient {
  private tag = 1;

  constructor(readonly endpoint: UsbmuxEndpoint = {}) {}

  private base(type: string): Record<string, PlistValue> {
    return { MessageType: type, ClientVersionString: 'eztest', ProgName: 'eztest' };
  }

  async listDevices(): Promise<UsbmuxDevice[]> {
    const s = await open(this.endpoint);
    try {
      s.write(encodeUsbmux(this.base('ListDevices'), this.tag++));
      const r = await readMessage(s);
      const list = (r.DeviceList as Array<Record<string, PlistValue>> | undefined) ?? [];
      return list.map((d) => {
        const p = (d.Properties ?? {}) as Record<string, PlistValue>;
        return { deviceId: Number(d.DeviceID ?? p.DeviceID), udid: String(p.SerialNumber ?? ''), connectionType: String(p.ConnectionType ?? 'USB'), ...(p.ProductID !== undefined ? { productId: Number(p.ProductID) } : {}) };
      });
    } finally {
      s.destroy();
    }
  }

  /** A raw socket tunnelled to `port` on the device. */
  async connect(deviceId: number, port: number): Promise<Socket> {
    const s = await open(this.endpoint);
    s.write(encodeUsbmux({ ...this.base('Connect'), DeviceID: deviceId, PortNumber: htons(port) }, this.tag++));
    const r = await readMessage(s);
    if (r.MessageType !== 'Result' || Number(r.Number) !== 0) {
      s.destroy();
      throw new EzTestError(`usbmuxd refused the connection to port ${port} on device ${deviceId} (result ${String(r.Number)}); is the EZTest iOS agent running?`, 'USBMUX');
    }
    s.resume();
    return s;
  }

  /** Find a device by UDID (the first one when no UDID is given). */
  async device(udid?: string): Promise<UsbmuxDevice> {
    const list = await this.listDevices();
    const d = udid ? list.find((x) => x.udid === udid) : list[0];
    if (!d) throw new EzTestError(`iOS device ${udid ?? ''} is not connected (usbmuxd sees: ${list.map((x) => x.udid).join(', ') || 'none'})`, 'USBMUX');
    return d;
  }

  /** A local TCP server on 127.0.0.1 whose connections are tunnelled to `port` on the device. */
  async tunnel(deviceId: number, port: number): Promise<{ port: number; close(): Promise<void> }> {
    const server: Server = createServer((local) => {
      local.pause();
      this.connect(deviceId, port).then((remote) => {
        local.pipe(remote);
        remote.pipe(local);
        local.resume();
        const end = () => { local.destroy(); remote.destroy(); };
        local.on('close', end);
        remote.on('close', end);
        local.on('error', end);
        remote.on('error', end);
      }, () => local.destroy());
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const a = server.address();
    return { port: typeof a === 'object' && a ? a.port : 0, close: () => new Promise<void>((r) => server.close(() => r())) };
  }
}
