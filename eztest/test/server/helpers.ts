import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerConfigSchema, startResultsServer, type ServerHandle } from '../../src/server/index.js';
import { createJsonLogger } from '../../src/ops/log.js';

export const BOOT = 'bootstrap-admin-token-for-tests-only-0123456789';

export interface TestServer extends ServerHandle {
  logs: string[];
  dataDir: string;
  req(method: string, path: string, o?: { token?: string; body?: unknown; cookie?: string; headers?: Record<string, string>; raw?: string | Buffer }): Promise<{ status: number; json: any; text: string; headers: Headers }>;
  token(name: string, grants: Array<{ project: string; role: string }>): Promise<string>;
}

export async function startTestServer(extra: Record<string, unknown> = {}): Promise<TestServer> {
  const dataDir = await mkdtemp(join(tmpdir(), 'ez-server-'));
  const logs: string[] = [];
  const config = ServerConfigSchema.parse({ port: 0, dataDir, ...extra });
  const h = await startResultsServer({ config: { ...config, baseDir: dataDir }, bootstrapToken: BOOT, logger: createJsonLogger({ out: (l) => logs.push(l), level: 'debug' }), retentionTimer: false });
  const req: TestServer['req'] = async (method, path, o = {}) => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.cookie) headers.cookie = o.cookie;
    let body: string | Buffer | undefined;
    if (o.raw !== undefined) body = o.raw;
    else if (o.body !== undefined) {
      headers['content-type'] ??= 'application/json';
      body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
    }
    const r = await fetch(`${h.url}${path}`, { method, headers, body: body as BodyInit | undefined, redirect: 'manual' });
    const text = await r.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: r.status, json, text, headers: r.headers };
  };
  return {
    ...h, logs, dataDir, req,
    async token(name, grants) {
      const r = await req('POST', '/api/tokens', { token: BOOT, body: { name, grants } });
      if (r.status !== 200) throw new Error(`token: ${r.status} ${r.text}`);
      return r.json.token as string;
    },
  };
}
