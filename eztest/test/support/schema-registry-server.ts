/**
 * An in-process schema registry for tests, serving the Confluent-compatible
 * REST API EZTest's client uses: subjects, versions, ids, registration (with
 * the subject's compatibility enforced for Avro), lookup, compatibility
 * checks, config and deletes. Optional basic authentication.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AvroSchema, avroCompatibility, canonicalForm } from '../../src/integration/avro.js';

interface Version { id: number; version: number; schema: string; schemaType: string; deleted?: boolean }

export interface TestSchemaRegistry {
  url: string;
  requests: Array<{ method: string; path: string; auth?: string }>;
  close(): Promise<void>;
}

export async function startSchemaRegistry(o: { username?: string; password?: string } = {}): Promise<TestSchemaRegistry> {
  const subjects = new Map<string, Version[]>();
  const byId = new Map<number, { schema: string; schemaType: string }>();
  const config = new Map<string, string>([['', 'BACKWARD']]);
  let nextId = 1;
  const requests: TestSchemaRegistry['requests'] = [];
  const key = (schema: string, type: string) => (type === 'AVRO' ? canonicalForm(schema) : schema.trim());

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      requests.push({ method: req.method ?? 'GET', path: url.pathname + url.search, ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
      const send = (status: number, b: unknown) => {
        res.writeHead(status, { 'content-type': 'application/vnd.schemaregistry.v1+json' });
        res.end(JSON.stringify(b));
      };
      const err = (status: number, code: number, message: string) => send(status, { error_code: code, message });
      if (o.username && req.headers.authorization !== `Basic ${Buffer.from(`${o.username}:${o.password}`).toString('base64')}`) return err(401, 40101, 'Unauthorized');
      let input: { schema?: string; schemaType?: string; compatibility?: string } = {};
      try {
        input = body ? JSON.parse(body) : {};
      } catch {
        return err(400, 400, 'bad JSON');
      }
      const live = (s: string) => (subjects.get(s) ?? []).filter((v) => !v.deleted);
      const pick = (s: string, v: string): Version | undefined => {
        const list = live(s);
        return v === 'latest' || v === '-1' ? list[list.length - 1] : list.find((x) => x.version === Number(v));
      };
      const level = (s: string) => config.get(s) ?? config.get('')!;
      const compat = (s: string, schema: string, type: string, against: Version[]): string[] => {
        if (type !== 'AVRO') return [];
        const mode = level(s).replace('_TRANSITIVE', '') as 'BACKWARD' | 'FORWARD' | 'FULL' | 'NONE';
        const next = new AvroSchema(schema);
        return against.flatMap((v) => avroCompatibility(next, new AvroSchema(v.schema), mode));
      };
      try {
        if (parts[0] === 'subjects' && parts.length === 1 && req.method === 'GET') return send(200, [...subjects.keys()].filter((s) => live(s).length));
        if (parts[0] === 'subjects' && parts.length >= 2) {
          const s = parts[1];
          if (parts.length === 2 && req.method === 'DELETE') {
            const list = live(s);
            if (!list.length) return err(404, 40401, `Subject '${s}' not found.`);
            for (const v of list) v.deleted = true;
            return send(200, list.map((v) => v.version));
          }
          if (parts.length === 2 && req.method === 'POST') {
            const type = input.schemaType ?? 'AVRO';
            const hit = live(s).find((v) => v.schemaType === type && key(v.schema, type) === key(input.schema ?? '', type));
            if (!hit) return err(404, 40403, 'Schema not found');
            return send(200, { subject: s, id: hit.id, version: hit.version, schema: hit.schema, ...(type !== 'AVRO' ? { schemaType: type } : {}) });
          }
          if (parts[2] === 'versions' && parts.length === 3 && req.method === 'GET') {
            const list = live(s);
            if (!list.length) return err(404, 40401, `Subject '${s}' not found.`);
            return send(200, list.map((v) => v.version));
          }
          if (parts[2] === 'versions' && parts.length === 3 && req.method === 'POST') {
            const type = input.schemaType ?? 'AVRO';
            if (!input.schema) return err(422, 42201, 'Empty schema');
            if (type === 'AVRO') {
              try {
                new AvroSchema(input.schema);
              } catch (e) {
                return err(422, 42201, `Invalid schema: ${(e as Error).message}`);
              }
            }
            const list = live(s);
            const same = list.find((v) => v.schemaType === type && key(v.schema, type) === key(input.schema!, type));
            if (same) return send(200, { id: same.id });
            const prior = level(s).endsWith('_TRANSITIVE') ? list : list.slice(-1);
            const problems = compat(s, input.schema, type, prior);
            if (problems.length) return err(409, 409, `Schema being registered is incompatible with an earlier schema for subject "${s}": ${problems.join('; ')}`);
            let id = [...byId.entries()].find(([, x]) => x.schemaType === type && key(x.schema, type) === key(input.schema!, type))?.[0];
            if (id === undefined) {
              id = nextId++;
              byId.set(id, { schema: input.schema, schemaType: type });
            }
            const all = subjects.get(s) ?? [];
            all.push({ id, version: (all[all.length - 1]?.version ?? 0) + 1, schema: input.schema, schemaType: type });
            subjects.set(s, all);
            return send(200, { id });
          }
          if (parts[2] === 'versions' && parts.length === 4 && req.method === 'GET') {
            const v = pick(s, parts[3]);
            if (!v) return err(404, live(s).length ? 40402 : 40401, live(s).length ? 'Version not found.' : `Subject '${s}' not found.`);
            return send(200, { subject: s, id: v.id, version: v.version, schema: v.schema, ...(v.schemaType !== 'AVRO' ? { schemaType: v.schemaType } : {}) });
          }
        }
        if (parts[0] === 'schemas' && parts[1] === 'ids' && parts.length === 3) {
          const x = byId.get(Number(parts[2]));
          if (!x) return err(404, 40403, 'Schema not found');
          return send(200, { schema: x.schema, ...(x.schemaType !== 'AVRO' ? { schemaType: x.schemaType } : {}) });
        }
        if (parts[0] === 'compatibility' && parts[1] === 'subjects' && parts[3] === 'versions') {
          const v = pick(parts[2], parts[4]);
          if (!v) return err(404, 40401, `Subject '${parts[2]}' not found.`);
          const messages = compat(parts[2], input.schema ?? '', input.schemaType ?? 'AVRO', [v]);
          return send(200, { is_compatible: messages.length === 0, ...(url.searchParams.get('verbose') === 'true' ? { messages } : {}) });
        }
        if (parts[0] === 'config') {
          const s = parts[1] ?? '';
          if (req.method === 'PUT') {
            config.set(s, String(input.compatibility));
            return send(200, { compatibility: input.compatibility });
          }
          if (s && !config.has(s) && url.searchParams.get('defaultToGlobal') !== 'true') return err(404, 40408, 'Subject does not have subject-level compatibility configured');
          return send(200, { compatibilityLevel: level(s) });
        }
        err(404, 404, 'not found');
      } catch (e) {
        err(500, 500, (e as Error).message);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}
