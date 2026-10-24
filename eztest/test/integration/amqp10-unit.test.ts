/**
 * AMQP 1.0 without a broker: the type system against byte vectors from the
 * specification's encoding tables, framing, message sections, and the
 * connection, SASL, links, multi-frame transfers and CBS put-token (Azure
 * SAS) against a scripted peer built on the same frame reader.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createHmac } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import {
  array, binary, decode, described, encode, list, map, sym, timestamp, ubyte, uint, ulong, ushort, uuid, Described, type AmqpValue,
} from '../../src/integration/bus/amqp10-codec.js';
import {
  Amqp10Connection, CODES, createSasToken, decodeMessage, encodeFrame, encodeMessage, FrameReader, putToken, type Amqp10Delivery, type Frame,
} from '../../src/integration/bus/amqp10-client.js';

const hex = (b: Buffer) => b.toString('hex');

describe('AMQP 1.0 type system (Part 1 encodings)', () => {
  it('encodes the fixed and variable width types with the shortest constructor', () => {
    expect(hex(encode(null))).toBe('40');
    expect(hex(encode(true))).toBe('41');
    expect(hex(encode(false))).toBe('42');
    expect(hex(encode(uint(0)))).toBe('43');
    expect(hex(encode(uint(7)))).toBe('5207');
    expect(hex(encode(uint(70000)))).toBe('7000011170');
    expect(hex(encode(ulong(0)))).toBe('44');
    expect(hex(encode(ulong(0x10)))).toBe('5310');
    expect(hex(encode(ulong(2n ** 40n)))).toBe('800000010000000000');
    expect(hex(encode(ubyte(255)))).toBe('50ff');
    expect(hex(encode(ushort(258)))).toBe('600102');
    expect(hex(encode(-1))).toBe('54ff');
    expect(hex(encode(100000))).toBe('71000186a0');
    expect(hex(encode(2 ** 40))).toBe('810000010000000000');
    expect(hex(encode(1.5))).toBe('823ff8000000000000');
    expect(hex(encode('hi'))).toBe('a1026869');
    expect(hex(encode(sym('amqp:not-found')))).toBe('a30e616d71703a6e6f742d666f756e64');
    expect(hex(encode(binary(Buffer.from([1, 2]))))).toBe('a0020102');
    expect(hex(encode(timestamp(new Date(1000))))).toBe('8300000000000003e8');
    expect(hex(encode(uuid('00112233-4455-6677-8899-aabbccddeeff')))).toBe('9800112233445566778899aabbccddeeff');
    expect(hex(encode(list([])))).toBe('45');
    expect(hex(encode(list([true, uint(1)])))).toBe('c00402415201');
    expect(hex(encode(map([[sym('a'), 1]])))).toBe('c10602a301615401');
    expect(hex(encode(array('symbol', ['PLAIN'])))).toBe('e00b01b300000005504c41494e');
    // Large values switch to the 32-bit forms.
    const s = 'x'.repeat(300);
    expect(hex(encode(s)).slice(0, 10)).toBe('b10000012c');
  });

  it('decodes what it encodes, described types included', () => {
    const v = described(0x10, list(['container', null, uint(65536), ushort(255), uint(30000), array('symbol', ['a', 'b']), map([[sym('k'), 'v'], ['n', 2 ** 40]])]));
    const out = decode(encode(v)).value as Described;
    expect(out).toBeInstanceOf(Described);
    expect(out.descriptor).toBe(0x10);
    expect(out.value).toEqual(['container', null, 65536, 255, 30000, ['a', 'b'], { k: 'v', n: 2 ** 40 }]);
    expect(decode(Buffer.from('80ffffffffffffffff', 'hex')).value).toBe(2n ** 64n - 1n);
    expect(decode(Buffer.from('d000000007000000024152ff', 'hex')).value).toEqual([true, 255]);
    expect(() => decode(Buffer.from('a105616263', 'hex'))).toThrow(/Truncated/);
    expect(() => decode(Buffer.from('ee', 'hex'))).toThrow(/Unknown AMQP type constructor 0xee/);
  });

  it('message sections round trip (properties, application properties, data, amqp-value, sequence)', () => {
    const when = new Date('2024-05-01T10:00:00.000Z');
    const m = decodeMessage(encodeMessage({
      header: { durable: true, priority: 5, ttl: 60000 },
      messageAnnotations: { 'x-opt-partition-key': 'p1' },
      properties: { messageId: 'id-1', correlationId: 'c-9', subject: 'orders.created', replyTo: 'replies', contentType: 'application/json', creationTime: when, groupSequence: 3 },
      applicationProperties: { source: 'eztest', attempt: 2, ok: true },
      body: { type: 'data', data: Buffer.from('{"a":1}') },
    }));
    expect(m.header).toEqual({ durable: true, priority: 5, ttl: 60000 });
    expect(m.messageAnnotations).toEqual({ 'x-opt-partition-key': 'p1' });
    expect(m.properties).toEqual({ messageId: 'id-1', correlationId: 'c-9', subject: 'orders.created', replyTo: 'replies', contentType: 'application/json', creationTime: when, groupSequence: 3 });
    expect(m.applicationProperties).toEqual({ source: 'eztest', attempt: 2, ok: true });
    expect(m.body).toEqual({ type: 'data', data: Buffer.from('{"a":1}') });
    expect(decodeMessage(encodeMessage({ body: { type: 'value', value: 'text' } })).body).toEqual({ type: 'value', value: 'text' });
    expect(decodeMessage(encodeMessage({ body: { type: 'sequence', items: [1, 'a'] } })).body).toEqual({ type: 'sequence', items: [1, 'a'] });
  });

  it('frames: header + frames split across packets, heartbeats, size checks', () => {
    const open = encodeFrame(0, 0, described(CODES.open, list(['c1'])));
    const transfer = encodeFrame(0, 3, described(CODES.transfer, list([uint(1), uint(0)])), Buffer.from('payload'));
    const all = Buffer.concat([Buffer.from('AMQP\x00\x01\x00\x00', 'latin1'), open, encodeFrame(0, 0), transfer]);
    const r = new FrameReader();
    const headers: Buffer[] = [];
    const frames: Frame[] = [];
    for (let i = 0; i < all.length; i += 5) r.push(all.subarray(i, i + 5), (h) => headers.push(h), (f) => frames.push(f));
    expect(headers.map((h) => h.toString('latin1'))).toEqual(['AMQP\x00\x01\x00\x00']);
    expect(frames.map((f) => [f.channel, f.code])).toEqual([[0, CODES.open], [0, undefined], [3, CODES.transfer]]);
    expect(frames[2].payload.toString()).toBe('payload');
    expect(frames[0].fields).toEqual(['c1']);
    const bad = Buffer.alloc(8);
    bad.writeUInt32BE(4);
    expect(() => new FrameReader().push(Buffer.concat([Buffer.from('AMQP\x00\x01\x00\x00', 'latin1'), bad]), () => undefined, () => undefined)).toThrow(/Invalid frame size 4/);
  });

  it('SAS tokens: HMAC-SHA256 over the URL-encoded resource and expiry', () => {
    const t = createSasToken('sb://ns.servicebus.windows.net/orders', 'RootManageSharedAccessKey', 'a2V5', 3600, 1_700_000_000_000);
    const se = 1_700_000_000 + 3600;
    const sr = encodeURIComponent('sb://ns.servicebus.windows.net/orders');
    const sig = createHmac('sha256', 'a2V5').update(`${sr}\n${se}`).digest('base64');
    expect(t).toBe(`SharedAccessSignature sr=${sr}&sig=${encodeURIComponent(sig)}&se=${se}&skn=RootManageSharedAccessKey`);
  });
});

// ------------------------------------------------------------------ a scripted peer

interface PeerLog {
  sasl: string[];
  opens: AmqpValue[][];
  attaches: Array<{ name: string; role: 'sender' | 'receiver'; address: AmqpValue }>;
  received: Array<{ address: AmqpValue; message: ReturnType<typeof decodeMessage> }>;
  tokens: Array<{ audience: string; token: string }>;
}

function startPeer(o: { mechanisms?: string[]; saslCode?: number; maxFrameSize?: number; sasKey?: string } = {}): Promise<{ port: number; log: PeerLog; close(): Promise<void> }> {
  const log: PeerLog = { sasl: [], opens: [], attaches: [], received: [], tokens: [] };
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    const r = new FrameReader();
    const links = new Map<number, { name: string; role: 'sender' | 'receiver'; address: AmqpValue; mine: number; target?: AmqpValue }>();
    let mine = 0;
    let deliveryId = 0;
    const partial = new Map<number, Buffer[]>();
    const send = (ch: number, perf: Described, payload?: Buffer) => sock.write(encodeFrame(0, ch, perf, payload));
    const reply = (address: AmqpValue, msg: Parameters<typeof encodeMessage>[0]) => {
      // To the client's receiver whose target is the reply address (CBS), or whose source is the address.
      for (const [, l] of links) {
        if (l.role === 'receiver' && (l.target === address || l.address === address)) send(0, described(CODES.transfer, list([uint(l.mine), uint(deliveryId++), binary(Buffer.from([deliveryId])), uint(0), false, false])), encodeMessage(msg));
      }
    };
    sock.on('data', (chunk: Buffer) => r.push(chunk, (h) => {
      if (h[4] === 3) {
        sock.write(Buffer.from('AMQP\x03\x01\x00\x00', 'latin1'));
        sock.write(encodeFrame(1, 0, described(CODES.saslMechanisms, list([array('symbol', o.mechanisms ?? ['ANONYMOUS', 'PLAIN'])]))));
      } else sock.write(Buffer.from('AMQP\x00\x01\x00\x00', 'latin1'));
    }, (f) => {
      if (f.type === 1 && f.code === CODES.saslInit) {
        log.sasl.push(`${String(f.fields[0])}:${Buffer.from(f.fields[1] as Buffer).toString('utf8').replace(/\0/g, '|')}`);
        sock.write(encodeFrame(1, 0, described(CODES.saslOutcome, list([ubyte(o.saslCode ?? 0)]))));
        if ((o.saslCode ?? 0) === 0) r.expectHeader = true;
        return;
      }
      switch (f.code) {
        case CODES.open:
          log.opens.push(f.fields);
          send(0, described(CODES.open, list(['mock-peer', null, uint(o.maxFrameSize ?? 1024), ushort(10), uint(0)])));
          break;
        case CODES.begin:
          send(f.channel, described(CODES.begin, list([ushort(f.channel), uint(0), uint(100), uint(100)])));
          break;
        case CODES.attach: {
          const role = f.fields[2] === true ? 'receiver' : 'sender';
          const src = f.fields[5] as Described | null;
          const tgt = f.fields[6] as Described | null;
          const address = role === 'sender' ? (tgt?.value as AmqpValue[])?.[0] : (src?.value as AmqpValue[])?.[0];
          const target = role === 'receiver' ? (tgt?.value as AmqpValue[])?.[0] : undefined;
          log.attaches.push({ name: String(f.fields[0]), role, address });
          const h = mine++;
          links.set(Number(f.fields[1]), { name: String(f.fields[0]), role, address, mine: h, target });
          if (address === 'missing') {
            send(0, described(CODES.attach, list([f.fields[0], uint(h), role !== 'receiver', ubyte(0), ubyte(0), role === 'receiver' ? null : src, null])));
            send(0, described(CODES.detach, list([uint(h), true, described(CODES.error, list([sym('amqp:not-found'), 'no such node']))])));
            break;
          }
          send(0, described(CODES.attach, list([f.fields[0], uint(h), role !== 'receiver', ubyte(0), ubyte(0), src, tgt, null, null, uint(0)])));
          if (role === 'sender') send(0, described(CODES.flow, list([uint(0), uint(100), uint(0), uint(100), uint(h), uint(0), uint(50)])));
          break;
        }
        case CODES.transfer: {
          const l = links.get(Number(f.fields[0]))!;
          const id = f.fields[1] != null ? Number(f.fields[1]) : -1;
          if (id >= 0) partial.set(Number(f.fields[0]), []);
          partial.get(Number(f.fields[0]))!.push(f.payload);
          if (f.fields[5] === true) break;
          const message = decodeMessage(Buffer.concat(partial.get(Number(f.fields[0]))!));
          log.received.push({ address: l.address, message });
          send(0, described(CODES.disposition, list([true, uint(Number(f.fields[1] ?? 0)), null, true, described(CODES.accepted, list([]))])));
          if (l.address === '$cbs') {
            const ap = message.applicationProperties ?? {};
            const token = String((message.body as { value: string }).value);
            log.tokens.push({ audience: String(ap.name), token });
            // Check the SAS signature like the service would.
            const m = /sr=([^&]+)&sig=([^&]+)&se=(\d+)/.exec(token);
            const ok = !!m && createHmac('sha256', o.sasKey ?? '').update(`${m[1]}\n${m[3]}`).digest('base64') === decodeURIComponent(m[2]) && decodeURIComponent(m[1]) === String(ap.name).toLowerCase();
            reply(message.properties?.replyTo ?? '', { properties: { correlationId: message.properties?.messageId }, applicationProperties: { 'status-code': ok ? 200 : 401, 'status-description': ok ? 'OK' : 'InvalidSignature' } });
          } else if (l.address === 'echo') {
            reply('echo-out', message);
          }
          break;
        }
        case CODES.flow:
        case CODES.disposition:
          break;
        case CODES.detach:
          send(0, described(CODES.detach, list([uint(links.get(Number(f.fields[0]))?.mine ?? 0), true])));
          break;
        case CODES.end:
          send(f.channel, described(CODES.end, list([])));
          break;
        case CODES.close:
          send(0, described(CODES.close, list([])));
          sock.end();
          break;
      }
    }));
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => undefined);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: (server.address() as { port: number }).port, log,
    close: () => new Promise((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    }),
  })));
}

describe('AMQP 1.0 connection against a scripted peer', () => {
  let peer: Awaited<ReturnType<typeof startPeer>>;
  beforeAll(async () => {
    peer = await startPeer({ sasKey: 'c2VjcmV0LWtleQ==' });
  });
  afterAll(async () => {
    await peer.close();
  });

  it('SASL PLAIN, open with our limits, links, multi-frame transfers within the peer frame size, receive and settle', async () => {
    const conn = await Amqp10Connection.connect({ host: '127.0.0.1', port: peer.port, sasl: { username: 'u', password: 'p' }, hostname: 'vhost:/' });
    expect(peer.log.sasl.at(-1)).toBe('PLAIN:|u|p');
    expect(peer.log.opens.at(-1)!.slice(1, 3)).toEqual(['vhost:/', 256 * 1024]);
    expect(conn.frameLimit).toBe(1024);
    const s = await conn.createSession();
    const rcv = await s.createReceiver('echo-out');
    const got = new Promise<Amqp10Delivery>((res) => rcv.on('message', (d: Amqp10Delivery) => {
      rcv.settle(d.id, 'accepted');
      res(d);
    }));
    const snd = await s.createSender('echo');
    const big = Buffer.alloc(5000, 7);
    // 5000 bytes with a 1024-byte frame limit: several transfer frames.
    expect(await snd.send({ properties: { messageId: 'm-1' }, body: { type: 'data', data: big } })).toEqual({ state: 'accepted' });
    const d = await got;
    expect(d.message.properties?.messageId).toBe('m-1');
    expect(Buffer.compare((d.message.body as { data: Buffer }).data, big)).toBe(0);
    await expect(s.createSender('missing')).rejects.toThrow(/amqp:not-found \(no such node\)/);
    await snd.close();
    await rcv.close();
    await s.end();
    await conn.close();
  });

  it('CBS put-token with a SAS token over SASL ANONYMOUS (Azure Service Bus flow)', async () => {
    const conn = await Amqp10Connection.connect({ host: '127.0.0.1', port: peer.port, sasl: { mechanism: 'ANONYMOUS' } });
    expect(peer.log.sasl.at(-1)).toBe('ANONYMOUS:anonymous');
    const s = await conn.createSession();
    const audience = 'sb://ns.servicebus.windows.net/orders';
    const ok = await putToken(s, audience, createSasToken(audience, 'send', 'c2VjcmV0LWtleQ=='));
    expect(ok).toEqual({ status: 200, description: 'OK' });
    expect(peer.log.tokens.at(-1)!.audience).toBe(audience);
    expect(peer.log.attaches.filter((a) => a.address === '$cbs').map((a) => a.role).sort()).toEqual(['receiver', 'sender']);
    await expect(putToken(s, audience, createSasToken(audience, 'send', 'wrong-key'))).rejects.toThrow(/CBS put-token for sb:\/\/ns\.servicebus\.windows\.net\/orders was refused: 401 InvalidSignature/);
    await conn.close();
  });

  it('reports refused SASL and missing mechanisms', async () => {
    const refusing = await startPeer({ saslCode: 1 });
    try {
      await expect(Amqp10Connection.connect({ host: '127.0.0.1', port: refusing.port, sasl: { username: 'u', password: 'bad' } })).rejects.toThrow(/SASL PLAIN authentication failed/);
    } finally {
      await refusing.close();
    }
    const plainOnly = await startPeer({ mechanisms: ['PLAIN'] });
    try {
      await expect(Amqp10Connection.connect({ host: '127.0.0.1', port: plainOnly.port, sasl: { mechanism: 'ANONYMOUS' } })).rejects.toThrow(/does not offer SASL ANONYMOUS \(offers: PLAIN\)/);
    } finally {
      await plainOnly.close();
    }
  });
});
