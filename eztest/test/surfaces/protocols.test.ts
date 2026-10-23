import { describe, it, expect, beforeAll, afterAll } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import {
  ApiClient,
  GraphQLClient,
  GraphQLRequestError,
  buildSoapEnvelope,
  parseSoapResponse,
  soapRequest,
  SoapFaultError,
  xmlGet,
  WsClient,
  SOAP_NS,
} from '../../src/surfaces/index.js';
import { startMock, json, type MockServer } from './mock-server.js';

describe('GraphQL', () => {
  let mock: MockServer;
  beforeAll(async () => {
    mock = await startMock((_req, body, res) => {
      const { query, variables, operationName } = JSON.parse(body);
      if (String(query).includes('broken')) return json(res, 200, { data: null, errors: [{ message: 'Cannot query field "broken"', path: ['broken'] }] });
      if (String(query).includes('partial')) return json(res, 200, { data: { a: 1 }, errors: [{ message: 'b failed', path: ['b'] }] });
      if (String(query).includes('html')) {
        res.writeHead(502, { 'content-type': 'text/html' });
        return res.end('<h1>Bad gateway</h1>');
      }
      return json(res, 200, { data: { order: { id: variables.id, op: operationName ?? null } } });
    });
  });
  afterAll(() => mock.close());

  it('sends query, variables and operationName and returns data', async () => {
    const gql = new GraphQLClient(new ApiClient({ baseUrl: mock.url }));
    const d = await gql.query<{ order: { id: number; op: string } }>('query GetOrder($id: Int!) { order(id: $id) { id } }', { id: 7 }, { operationName: 'GetOrder' });
    expect(d.order).toEqual({ id: 7, op: 'GetOrder' });
    const sent = JSON.parse(mock.requests.at(-1)!.body);
    expect(sent.variables).toEqual({ id: 7 });
  });
  it('surfaces GraphQL errors, including partial data', async () => {
    const gql = new GraphQLClient(new ApiClient({ baseUrl: mock.url }));
    const err = await gql.query('{ broken }').catch((e) => e);
    expect(err).toBeInstanceOf(GraphQLRequestError);
    expect(err.message).toMatch(/Cannot query field "broken" \(at broken\)/);
    const partial = await gql.request('{ partial }');
    expect(partial.data).toEqual({ a: 1 });
    expect(partial.errors).toHaveLength(1);
    await expect(gql.query('{ partial }')).rejects.toThrow(/b failed/);
    await expect(gql.request('{ html }')).rejects.toThrow(/without a GraphQL body/);
    await expect(gql.request('  ')).rejects.toThrow(/empty/);
  });
});

describe('SOAP', () => {
  let mock: MockServer;
  beforeAll(async () => {
    mock = await startMock((req, body, res) => {
      const is12 = String(req.headers['content-type']).startsWith('application/soap+xml');
      const ns = is12 ? SOAP_NS['1.2'] : SOAP_NS['1.1'];
      const ct = is12 ? 'application/soap+xml' : 'text/xml';
      if (body.includes('<sku>BAD</sku>')) {
        res.writeHead(500, { 'content-type': ct });
        return res.end(
          is12
            ? `<s:Envelope xmlns:s="${ns}"><s:Body><s:Fault><s:Code><s:Value>s:Sender</s:Value></s:Code><s:Reason><s:Text xml:lang="en">Unknown SKU</s:Text></s:Reason></s:Fault></s:Body></s:Envelope>`
            : `<s:Envelope xmlns:s="${ns}"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>Unknown SKU</faultstring><detail><sku>BAD</sku></detail></s:Fault></s:Body></s:Envelope>`,
        );
      }
      res.writeHead(200, { 'content-type': ct });
      return res.end(
        `<?xml version="1.0"?><s:Envelope xmlns:s="${ns}" xmlns:p="urn:price"><s:Body><p:GetPriceResponse><p:Price currency="EUR">00019.99</p:Price><p:Item>a</p:Item><p:Item>b</p:Item></p:GetPriceResponse></s:Body></s:Envelope>`,
      );
    });
  });
  afterAll(() => mock.close());

  it('builds 1.1 and 1.2 envelopes with escaped object bodies', () => {
    const env = buildSoapEnvelope({ body: { 'p:GetPrice': { 'p:sku': 'A&B<1>' } }, namespaces: { p: 'urn:price' } });
    expect(env).toContain(`xmlns:soap="${SOAP_NS['1.1']}"`);
    expect(env).toContain('<p:sku>A&amp;B&lt;1&gt;</p:sku>');
    expect(buildSoapEnvelope({ version: '1.2', body: '<x/>', header: '<h/>' })).toContain(`${SOAP_NS['1.2']}"><soap:Header><h/></soap:Header><soap:Body><x/>`);
    expect(() => buildSoapEnvelope({ body: '<x/>', namespaces: { 'bad prefix': 'u' } })).toThrow(/Invalid namespace/);
  });

  it('calls a 1.1 service with SOAPAction and reads values with paths', async () => {
    const api = new ApiClient({ baseUrl: mock.url });
    const r = await soapRequest(api, '/svc', { action: 'urn:GetPrice', body: '<p:GetPrice xmlns:p="urn:price"><sku>A</sku></p:GetPrice>' });
    const req = mock.requests.at(-1)!;
    expect(req.headers['soapaction']).toBe('"urn:GetPrice"');
    expect(r.version).toBe('1.1');
    expect(r.fault).toBeUndefined();
    expect(xmlGet(r.body, 'GetPriceResponse/Price')).toBe('00019.99');
    expect(xmlGet(r.body, 'GetPriceResponse/Price/@currency')).toBe('EUR');
    expect(xmlGet(r.document, '/Envelope/Body/GetPriceResponse/Item[1]')).toBe('b');
    expect(xmlGet(r.body, 'GetPriceResponse/Nope')).toBeUndefined();
  });

  it('detects 1.1 and 1.2 faults', async () => {
    const api = new ApiClient({ baseUrl: mock.url });
    const e11 = await soapRequest(api, '/svc', { body: '<sku>BAD</sku>' }).catch((e) => e);
    expect(e11).toBeInstanceOf(SoapFaultError);
    expect(e11.fault).toMatchObject({ code: 's:Client', reason: 'Unknown SKU' });
    const r12 = await soapRequest(api, '/svc', { version: '1.2', action: 'urn:x', body: '<sku>BAD</sku>', throwOnFault: false });
    expect(r12.version).toBe('1.2');
    expect(r12.fault).toMatchObject({ code: 's:Sender', reason: 'Unknown SKU' });
    expect(String(mock.requests.at(-1)!.headers['content-type'])).toContain('action="urn:x"');
  });

  it('rejects empty and malformed responses', () => {
    expect(() => parseSoapResponse('')).toThrow(/Empty/);
    expect(() => parseSoapResponse('<a><b></a>')).toThrow();
    expect(() => parseSoapResponse('<root/>')).toThrow(/no Envelope/);
  });
});

// ------------------------------------------------------------ minimal RFC 6455 echo server (node:http upgrade)
function startWsEcho(): Promise<{ url: string; server: Server }> {
  const server = createServer((_q, r) => r.end());
  const frame = (opcode: number, payload: Buffer) => {
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : Buffer.from([0x80 | opcode, 126, len >> 8, len & 0xff]);
    return Buffer.concat([head, payload]);
  };
  server.on('upgrade', (req, socket: Duplex) => {
    const key = String(req.headers['sec-websocket-key']);
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(frame(1, Buffer.from(JSON.stringify({ type: 'welcome' }))));
    let buf = Buffer.alloc(0);
    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          len = buf.readUInt16BE(2);
          off = 4;
        }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buf = buf.subarray(off + 4 + len);
        if (opcode === 8) {
          socket.end(frame(8, payload));
          return;
        }
        const text = payload.toString('utf8');
        socket.write(frame(1, Buffer.from(text.startsWith('{') ? JSON.stringify({ type: 'echo', of: JSON.parse(text) }) : `echo:${text}`)));
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      r({ url: `ws://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`, server });
    }),
  );
}

describe('WebSocket client', () => {
  let ws: { url: string; server: Server };
  beforeAll(async () => {
    ws = await startWsEcho();
  });
  afterAll(() => new Promise<void>((r) => { ws.server.closeAllConnections(); ws.server.close(() => r()); }));

  it('connects, receives buffered and future messages, matches with predicates', async () => {
    const c = await WsClient.connect(ws.url);
    const welcome = await c.waitForMessage((m) => (m.json() as { type?: string })?.type === 'welcome', 2000);
    expect(welcome.text).toContain('welcome');
    c.send('hello');
    c.send({ n: 42 });
    const echoJson = await c.waitForMessage((m) => (m.json() as { type?: string })?.type === 'echo', 2000);
    expect(echoJson.json()).toEqual({ type: 'echo', of: { n: 42 } });
    const echoText = await c.waitForMessage((m) => m.text.startsWith('echo:'), 2000);
    expect(echoText.text).toBe('echo:hello');
    await expect(c.waitForMessage((m) => m.text === 'never', 150)).rejects.toThrow(/No matching WebSocket message within 150ms/);
    await c.close();
    expect(c.isOpen).toBe(false);
    expect(() => c.send('x')).toThrow(/not open/);
    await expect(c.waitForMessage(() => true, 100)).rejects.toThrow(/closed/);
  });

  it('fails to connect to a closed port', async () => {
    await expect(WsClient.connect('ws://127.0.0.1:1', { timeoutMs: 2000 })).rejects.toThrow(/failed|timed out/);
  });
});
