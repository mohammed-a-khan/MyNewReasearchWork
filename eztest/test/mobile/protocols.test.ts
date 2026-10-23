/**
 * Wire-level tests of EZTest's own device protocols: the ADB smart-socket
 * client (byte for byte against a fake adb server), the usbmuxd client and
 * plist codec (against a fake usbmuxd), and the agent protocol client.
 */
import { createServer, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from '../support/testkit.js';
import { AdbClient, AgentClient, buildPlist, DeviceError, encodeUsbmux, htons, parseDevices, parsePlist, shellQuote, UsbmuxClient, waitForAgent } from '../../src/mobile/index.js';
import { AgentSimulator } from './agent-sim.js';
import { FakeAdbServer } from './fake-adb.js';

describe('ADB client (smart-socket protocol)', () => {
  let adb: FakeAdbServer;
  let client: AdbClient;
  beforeEach(async () => {
    adb = new FakeAdbServer();
    await adb.start();
    client = new AdbClient({ port: adb.port });
  });
  afterEach(async () => {
    await adb.stop();
  });

  it('frames requests as 4 hex digits of length + service', async () => {
    expect(await client.version()).toBe(0x29);
    expect(adb.connections[0].toString('latin1')).toBe('000chost:version');
    await client.devices();
    expect(adb.connections[1].toString('latin1')).toBe('000ehost:devices-l');
  });

  it('parses devices -l', async () => {
    adb.devices.push({ serial: '192.168.1.5:5555', state: 'unauthorized' });
    expect(await client.devices()).toEqual([
      { serial: 'emulator-5554', state: 'device', props: { product: 'sdk_gphone64', model: 'Pixel_8', device: 'emu64a', transport_id: '1' } },
      { serial: '192.168.1.5:5555', state: 'unauthorized', props: {} },
    ]);
    expect(parseDevices('')).toEqual([]);
  });

  it('switches transport then runs a shell command, recovering the exit status', async () => {
    adb.shell = (serial, cmd) => (cmd === 'getprop ro.build.version.sdk' ? `34\n` : { output: 'boom', exit: 3 });
    expect(await client.shell('emulator-5554', 'getprop ro.build.version.sdk')).toEqual({ output: '34\n', exitCode: 0 });
    const bytes = adb.connections[0].toString('latin1');
    const svc = 'shell:getprop ro.build.version.sdk; echo __EZTEST_EXIT__$?';
    expect(bytes).toBe(`001chost:transport:emulator-5554${svc.length.toString(16).padStart(4, '0')}${svc}`);
    await expect(client.shellOk('emulator-5554', 'false', 'probe')).rejects.toThrow('probe failed on emulator-5554 (exit 3): boom');
  });

  it('reports FAIL messages from the server', async () => {
    await expect(client.shell('nope', 'ls')).rejects.toThrow("adb host:transport:nope: device 'nope' not found");
  });

  it('forwards and removes forwards (OKAY OKAY)', async () => {
    const echo = createServer((s: Socket) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
    const a = echo.address();
    adb.targets.set('localabstract:webview_devtools_remote_42', typeof a === 'object' && a ? a.port : 0);
    const { freePort } = await import('../../src/mobile/index.js');
    const local = await freePort();
    await client.forward('emulator-5554', `tcp:${local}`, 'localabstract:webview_devtools_remote_42');
    expect(adb.connections.at(-1)!.toString('latin1')).toBe(`${(`host-serial:emulator-5554:forward:tcp:${local};localabstract:webview_devtools_remote_42`).length.toString(16).padStart(4, '0')}host-serial:emulator-5554:forward:tcp:${local};localabstract:webview_devtools_remote_42`);
    await client.removeForward('emulator-5554', `tcp:${local}`);
    expect(adb.forwards.size).toBe(0);
    await expect(client.forward('emulator-5554', `tcp:${local}`, 'tcp:1')).rejects.toThrow('cannot bind to tcp:1');
    await new Promise<void>((r) => echo.close(() => r()));
  });

  it('pushes with sync SEND/DATA/DONE and pulls with RECV (multi-chunk), with STAT', async () => {
    const big = Buffer.alloc(150_000, 7);
    await client.push('emulator-5554', big, '/sdcard/big.bin', 0o600, 1_700_000_000);
    const f = adb.files.get('/sdcard/big.bin')!;
    expect(f.data.equals(big)).toBe(true);
    expect(f.mode).toBe(0o100600);
    expect(f.mtime).toBe(1_700_000_000);
    // Wire format after the transport + sync: requests: SEND <len LE> "path,mode", DATA chunks of 64 KiB, DONE <mtime LE>.
    const raw = adb.connections.at(-1)!;
    const afterSync = raw.subarray(raw.indexOf('sync:') + 5);
    expect(afterSync.subarray(0, 4).toString()).toBe('SEND');
    expect(afterSync.readUInt32LE(4)).toBe('/sdcard/big.bin,33152'.length);
    expect(afterSync.subarray(8, 8 + 21).toString()).toBe('/sdcard/big.bin,33152');
    const data1 = afterSync.subarray(29);
    expect(data1.subarray(0, 4).toString()).toBe('DATA');
    expect(data1.readUInt32LE(4)).toBe(65536);
    expect((await client.pull('emulator-5554', '/sdcard/big.bin')).equals(big)).toBe(true);
    expect(await client.stat('emulator-5554', '/sdcard/big.bin')).toEqual({ mode: 0o100600, size: 150_000, mtime: 1_700_000_000 });
    expect((await client.stat('emulator-5554', '/nope')).mode).toBe(0);
    await expect(client.pull('emulator-5554', '/nope')).rejects.toThrow('adb pull /nope: No such file or directory');
    await expect(client.push('emulator-5554', Buffer.from('x'), '/readonly/x')).rejects.toThrow('adb push /readonly/x: Read-only file sys');
  });

  it('runs a long-lived shell stream until it is killed', async () => {
    adb.shell = () => ({ stream: true, output: 'INSTRUMENTATION_STATUS: started\n' });
    const s = await client.shellStream('emulator-5554', 'am instrument -w x/.Y');
    await new Promise((r) => setTimeout(r, 50));
    expect(s.output()).toContain('started');
    s.kill();
    await s.done;
  });

  it('quotes shell arguments and fails clearly when the server is down', async () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    await expect(new AdbClient({ port: 9, timeoutMs: 2000 }).version()).rejects.toThrow(/cannot reach the adb server at 127\.0\.0\.1:9/);
  });
});

describe('usbmuxd client', () => {
  it('encodes plist messages with the 16-byte header and the network-order port', () => {
    const m = encodeUsbmux({ MessageType: 'Connect', DeviceID: 3, PortNumber: htons(8790) }, 7);
    expect(m.readUInt32LE(0)).toBe(m.length);
    expect(m.readUInt32LE(4)).toBe(1);
    expect(m.readUInt32LE(8)).toBe(8);
    expect(m.readUInt32LE(12)).toBe(7);
    expect(htons(8790)).toBe(0x5622);
    expect(parsePlist(m.subarray(16).toString())).toEqual({ MessageType: 'Connect', DeviceID: 3, PortNumber: 0x5622 });
  });

  it('round-trips plist values', () => {
    const v = { a: 'x<&>', n: 42, r: 1.5, t: true, f: false, d: Buffer.from('hi'), list: [1, 'two', { k: 'v' }] };
    expect(parsePlist(buildPlist(v))).toEqual(v);
  });

  it('lists devices and tunnels HTTP to the agent port through a fake usbmuxd', async () => {
    const sim = new AgentSimulator('<hierarchy width="390" height="844"><XCUIElementTypeApplication name="Shop" x="0" y="0" width="390" height="844"/></hierarchy>');
    sim.platform = 'ios';
    const agentPort = await sim.start();
    const seen: unknown[] = [];
    const mux = createServer((s) => {
      let buf = Buffer.alloc(0);
      const onData = (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        if (buf.length < 16 || buf.length < buf.readUInt32LE(0)) return;
        const len = buf.readUInt32LE(0);
        const msg = parsePlist(buf.subarray(16, len).toString()) as Record<string, unknown>;
        buf = buf.subarray(len);
        seen.push(msg);
        if (msg.MessageType === 'ListDevices') {
          s.write(encodeUsbmux({ DeviceList: [{ DeviceID: 5, MessageType: 'Attached', Properties: { SerialNumber: '00008110-AAAA', ConnectionType: 'USB', ProductID: 4776, DeviceID: 5 } }] }, msg.tag as number ?? 1));
        } else if (msg.MessageType === 'Connect') {
          if (msg.PortNumber !== htons(8790)) return void s.write(encodeUsbmux({ MessageType: 'Result', Number: 3 }, 1));
          s.write(encodeUsbmux({ MessageType: 'Result', Number: 0 }, 1));
          s.off('data', onData);
          const up = require('node:net').connect({ host: '127.0.0.1', port: agentPort }) as Socket;
          s.pipe(up);
          up.pipe(s);
        }
      };
      s.on('data', onData);
    });
    await new Promise<void>((r) => mux.listen(0, '127.0.0.1', () => r()));
    const a = mux.address();
    const client = new UsbmuxClient({ host: '127.0.0.1', port: typeof a === 'object' && a ? a.port : 0 });
    try {
      expect(await client.listDevices()).toEqual([{ deviceId: 5, udid: '00008110-AAAA', connectionType: 'USB', productId: 4776 }]);
      const dev = await client.device('00008110-AAAA');
      const t = await client.tunnel(dev.deviceId, 8790);
      const status = await waitForAgent(new AgentClient({ url: `http://127.0.0.1:${t.port}` }), 3000);
      expect(status).toMatchObject({ ready: true, platform: 'ios' });
      expect(seen.at(-1)).toMatchObject({ MessageType: 'Connect', DeviceID: 5, PortNumber: htons(8790), ProgName: 'eztest' });
      await expect(client.connect(5, 1234)).rejects.toThrow(/refused the connection to port 1234/);
      await expect(client.device('nope')).rejects.toThrow(/iOS device nope is not connected \(usbmuxd sees: 00008110-AAAA\)/);
      await t.close();
    } finally {
      await new Promise<void>((r) => mux.close(() => r()));
      await sim.stop();
    }
  });
});

describe('agent protocol client', () => {
  it('maps error objects to DeviceError codes and values to results', async () => {
    const sim = new AgentSimulator('<hierarchy width="100" height="100"><android.widget.Button text="Go" resource-id="a:id/go" bounds="[0,0][50,50]"/></hierarchy>');
    const port = await sim.start();
    const c = new AgentClient({ url: `http://127.0.0.1:${port}/` });
    try {
      const [id] = await c.find('id', 'go');
      expect(await c.rect(id)).toEqual({ x: 0, y: 0, width: 50, height: 50 });
      expect(await c.attribute(id, 'text')).toBe('Go');
      expect(await c.attribute(id, 'nope')).toBeNull();
      const e = await c.find('predicate', 'x').catch((x: unknown) => x);
      expect(e).toBeInstanceOf(DeviceError);
      expect((e as DeviceError).code).toBe('not supported');
      expect((e as DeviceError).unsupported).toBe(true);
      await expect(c.click('n99')).rejects.toThrow('stale element: element is gone (POST /element/n99/click)');
      await expect(c.alertText()).resolves.toBeUndefined();
      await expect(new AgentClient({ url: 'http://127.0.0.1:9', timeoutMs: 500 }).status()).rejects.toThrow(/device agent GET \/status failed/);
    } finally {
      await sim.stop();
    }
  });
});
