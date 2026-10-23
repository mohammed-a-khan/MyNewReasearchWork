/** Units of the integration module: EDI, topic/routing matching, allow-lists, folders, IBM MQ correlation ids, subscriptions, optional-client hints. */
import { describe, expect, it } from '../support/testkit.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  allowedFolder, BusSubscription, commandAllowed, fromCorrelId, loadClient, MemoryBroker, parseEdi, routingMatches, splitMethod, toCorrelId, topicMatches,
} from '../../src/integration/index.js';
import { importOpenApi, importPostman, postmanVars } from '../../src/importers/index.js';

const X12 = 'ISA*00*          *00*          *ZZ*BUYER          *ZZ*SELLER         *260115*0930*U*00401*000000101*0*T*>~GS*PO*BUYER*SELLER*20260115*0930*101*X*004010~ST*850*0001~BEG*00*SA*PO-1001**20260115~PO1*1*2*EA*49.50**VP*SKU-200~SE*4*0001~GE*1*101~IEA*1*000000101~';
const EDIFACT = "UNA:+.? 'UNB+UNOC:3+BUYER:14+SELLER:14+260115:0930+REF1'UNH+1+ORDERS:D:96A:UN'BGM+220+PO-1001'FTX+AAI+++price?+tax'LIN+1++SKU-200:VP'UNT+5+1'UNZ+1+REF1'";

describe('EDI', () => {
  it('parses X12 with envelope checks and per-element keys', () => {
    const d = parseEdi(X12);
    expect(d).toMatchObject({ format: 'x12', valid: true, interchange: { sender: 'BUYER', receiver: 'SELLER', control: '000000101' }, transactions: [{ type: '850', control: '0001' }] });
    expect(d.first.BEG).toEqual({ id: 'BEG', BEG01: '00', BEG02: 'SA', BEG03: 'PO-1001', BEG04: '', BEG05: '20260115' });
    expect(d.count).toMatchObject({ PO1: 1, ST: 1 });
    expect(d.groups[0]).toMatchObject({ id: 'PO', control: '101' });
  });

  it('reports broken X12 envelopes', () => {
    const bad = parseEdi(X12.replace('SE*4*0001', 'SE*9*0002').replace('IEA*1*000000101', 'IEA*2*000000999'));
    expect(bad.valid).toBe(false);
    expect(bad.errors).toEqual([
      'transaction 0001: SE01 says 9 segments, found 4',
      'transaction 0001: SE02 0002 does not match ST02 0001',
      'interchange: IEA01 says 2 groups, found 1',
      'interchange: IEA02 000000999 does not match ISA13 000000101',
    ]);
  });

  it('parses EDIFACT with UNA delimiters and release characters', () => {
    const d = parseEdi(EDIFACT);
    expect(d).toMatchObject({ format: 'edifact', valid: true, interchange: { sender: 'BUYER', receiver: 'SELLER', control: 'REF1', date: '260115', time: '0930' }, transactions: [{ type: 'ORDERS', control: '1' }] });
    expect(d.first.BGM.BGM02).toBe('PO-1001');
    expect(d.first.FTX.FTX04).toBe('price+tax');
    expect(parseEdi(EDIFACT.replace("UNT+5+1'", "UNT+4+1'")).errors).toEqual(['message 1: UNT01 says 4 segments, found 5']);
    expect(() => parseEdi('hello')).toThrow(/expected ISA \(X12\) or UNA\/UNB\/UNH \(EDIFACT\)/);
  });
});

describe('matching and safety rules', () => {
  it('MQTT topic filters and AMQP binding keys', () => {
    expect(topicMatches('a/+/c', 'a/b/c')).toBe(true);
    expect(topicMatches('a/#', 'a/b/c')).toBe(true);
    expect(topicMatches('a/+', 'a/b/c')).toBe(false);
    expect(routingMatches('order.*', 'order.created')).toBe(true);
    expect(routingMatches('order.*', 'order.created.eu')).toBe(false);
    expect(routingMatches('order.#', 'order')).toBe(true);
    expect(routingMatches('#.eu', 'order.created.eu')).toBe(true);
  });

  it('allow-lists commands exactly or by glob, and keeps folders inside the project', () => {
    expect(commandAllowed('./close-day.sh 2026-01-31', ['./close-day.sh *'])).toBe(true);
    expect(commandAllowed('./close-day.sh; rm -rf /', ['./close-day.sh'])).toBe(false);
    expect(commandAllowed('echo hi', [])).toBe(false);
    const base = join(tmpdir(), 'proj');
    expect(allowedFolder('drop/in', base, [])).toBe(join(base, 'drop/in'));
    expect(() => allowedFolder('../elsewhere', base, [])).toThrow(/outside the project/);
    expect(allowedFolder('/mnt/share/in', base, ['/mnt/share'])).toBe('/mnt/share/in');
  });

  it('IBM MQ correlation ids round trip as 24-byte CorrelIds', () => {
    const hex = toCorrelId('order-42');
    expect(hex).toHaveLength(48);
    expect(fromCorrelId(hex)).toBe('order-42');
    expect(toCorrelId('a'.repeat(48).replace(/a/g, 'f'))).toBe('f'.repeat(48));
    expect(() => toCorrelId('x'.repeat(25))).toThrow(/at most 24 bytes/);
  });

  it('gRPC method names', () => {
    expect(splitMethod('shop.Orders/Get')).toEqual({ service: 'shop.Orders', method: 'Get' });
    expect(splitMethod('/shop.Orders/Get')).toEqual({ service: 'shop.Orders', method: 'Get' });
    expect(splitMethod('shop.Orders.Get')).toEqual({ service: 'shop.Orders', method: 'Get' });
  });

  it('names the package to install when an optional client is missing', async () => {
    await expect(loadClient('eztest-no-such-client', 'Widget bus')).rejects.toThrow('Widget bus support needs the "eztest-no-such-client" package, which is not installed. Run: npm install eztest-no-such-client');
  });
});

describe('subscriptions and the in-memory broker', () => {
  it('hands each message to one wait, buffers early messages and times out', async () => {
    const sub = new BusSubscription({ type: 'topic', name: 't' });
    sub.push({ destination: 't', payload: '{"n":1}', headers: {}, timestamp: 1 });
    expect((await sub.next((m) => m.payload.includes('1'), 10))?.payload).toBe('{"n":1}');
    expect(await sub.next((m) => m.payload.includes('1'), 10)).toBeUndefined();
    const later = sub.next((m) => m.payload.includes('2'), 1000);
    sub.push({ destination: 't', payload: '{"n":2}', headers: {}, timestamp: 2 });
    expect((await later)?.payload).toBe('{"n":2}');
  });

  it('queues keep messages until a consumer subscribes; topics replay from a timestamp', () => {
    const b = new MemoryBroker();
    b.publish({ type: 'queue', name: 'q' }, { payload: 'early' });
    const s = b.subscribe({ type: 'queue', name: 'q' });
    expect(s.messages.map((m) => m.payload)).toEqual(['early']);
    b.publish({ type: 'topic', name: 'a/b' }, { payload: 'old' });
    expect(b.subscribe({ type: 'topic', name: 'a/+' }, { fromTimestamp: 0 }).messages.map((m) => m.payload)).toEqual(['old']);
    expect(b.subscribe({ type: 'topic', name: 'a/+' }).messages).toEqual([]);
  });
});

describe('API importers (units)', () => {
  it('OpenAPI: per-operation journeys, POST ids chained into /{id} paths, form bodies, headers', () => {
    const spec = JSON.stringify({
      openapi: '3.0.3', info: { title: 'Notes', version: '1' }, servers: [{ url: 'https://notes.example.com' }],
      paths: {
        '/notes': { post: { operationId: 'createNote', tags: ['notes'], parameters: [{ name: 'X-Tenant', in: 'header', required: true, schema: { type: 'string' }, example: 'eu' }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['title'], properties: { title: { type: 'string', example: 'Hello' } } } } } }, responses: { 201: { description: 'c', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'integer' } } } } } } } } },
        '/notes/{noteId}': { get: { operationId: 'getNote', tags: ['notes'], parameters: [{ name: 'noteId', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'ok' } } }, delete: { operationId: 'deleteNote', tags: ['notes'], parameters: [{ name: 'noteId', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 204: { description: 'gone' } } } },
        '/login': { post: { operationId: 'login', tags: ['auth'], requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { user: { type: 'string', example: 'ann' } } } } } }, responses: { 200: { description: 'ok' } } } },
      },
    });
    const r = importOpenApi(spec, { file: 'notes.json' });
    expect(r.journeys.map((j) => j.name)).toEqual(['Notes: notes', 'Notes: auth']);
    const ez = r.converted[0].ez;
    expect(ez).toContain('# servers in the spec: https://notes.example.com (the run uses baseUrl from the config)');
    expect(ez).toContain('Call API "POST /notes" with header "X-Tenant" = "eu" with body \'{"title":"Hello"}\' and store as createNote');
    expect(ez).toContain('Call API "GET /notes/${createNote.body.id}" and store as getNote');
    expect(ez).toContain('Call API "DELETE /notes/${createNote.body.id}" and store as deleteNote');
    expect(ez).toContain('  Expect response deleteNote status is 204');
    expect(r.converted[1].ez).toContain('Call API "POST /login" with form user="ann" and store as login');
    expect(r.coverage).toMatchObject({ sourceSteps: 4, convertedSteps: 4 });
    expect(importOpenApi(spec, { file: 'notes.json', groupBy: 'operation' }).journeys).toHaveLength(4);
  });

  it('Postman: variables, dynamic variables, auth never copies literal secrets, unconverted scripts become TODOs', () => {
    expect(postmanVars('{{base}}/x/{{$guid}}?t={{$timestamp}}')).toBe('${base}/x/${uuid()}?t=${now()}');
    const r = importPostman(JSON.stringify({
      info: { name: 'C', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      auth: { type: 'bearer', bearer: [{ key: 'token', value: 'literal-secret-abc' }] },
      item: [{ name: 'Ping', request: { method: 'GET', url: 'https://h/ping' }, event: [{ listen: 'prerequest', script: { exec: ['pm.variables.set("x", 1);'] } }, { listen: 'test', script: { exec: ['pm.response.to.have.status(404);'] } }] }],
    }), { file: 'c.json' });
    const ez = r.converted[0].ez;
    expect(ez).not.toContain('literal-secret-abc');
    expect(ez).toContain('with header "Authorization" = "Bearer ${token}" with errors allowed and store as ping');
    expect(ez).toContain('  Expect response ping status is 404');
    expect(ez).toContain('# TODO (not converted): pm.variables.set("x", 1);');
    expect(r.todo.map((t) => t.reason)).toEqual(['pre-request scripts are not converted']);
  });
});
