/**
 * The results-server token with the configuration `eztest init` writes (its env
 * secret store has the prefix EZTEST_SECRET_): EZTEST_SERVER_TOKEN is read as
 * it is, by the CLI and by the engine (shared store), and `server.token:
 * secret://env/NAME` still resolves through the env store.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from '../support/testkit.js';
import { appendFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { initProject } from '../../src/cli/init.js';
import { serverClientFor } from '../../src/cli/scale.js';
import { loadConfig } from '../../src/config/index.js';
import { createEngine, resolveServerToken } from '../../src/engine/index.js';
import { tempDir } from '../runner/fixtures.js';

let server: Server;
let url: string;
const auth: string[] = [];
const saved = { token: process.env.EZTEST_SERVER_TOKEN, secret: process.env.EZTEST_SECRET_SERVER_TOKEN };

beforeAll(async () => {
  server = createServer((req, res) => {
    auth.push(String(req.headers.authorization ?? ''));
    res.setHeader('content-type', 'application/json');
    res.end(req.url?.includes('/durations') ? '{"journeys":{}}' : '{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

afterEach(() => {
  auth.length = 0;
  for (const [k, v] of [['EZTEST_SERVER_TOKEN', saved.token], ['EZTEST_SECRET_SERVER_TOKEN', saved.secret]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function initWithServer(extra = ''): Promise<string> {
  const dir = await tempDir('server-token');
  await initProject(dir);
  await appendFile(join(dir, 'eztest.config.yaml'), `\nserver:\n  url: ${url}\n  project: shop\n${extra}`);
  return dir;
}

describe('EZTEST_SERVER_TOKEN with the init config', () => {
  it('the CLI reads it directly (not as EZTEST_SECRET_EZTEST_SERVER_TOKEN) and sends it as the bearer token', async () => {
    const dir = await initWithServer();
    process.env.EZTEST_SERVER_TOKEN = 'tok-direct-123';
    const loaded = await loadConfig({ cwd: dir, environment: process.env });
    expect(loaded.config.identity.secretStores).toEqual([{ type: 'env', prefix: 'EZTEST_SECRET_' }]);
    const client = await serverClientFor(loaded, dir);
    expect(client!.o.token).toBe('tok-direct-123');
    await client!.durations().catch(() => undefined);
    expect(auth).toContain('Bearer tok-direct-123');
    expect(loaded.masker.mask('x tok-direct-123 y')).not.toContain('tok-direct-123');
  });

  it('the engine (shared store on the results server) uses it too', async () => {
    const dir = await initWithServer();
    process.env.EZTEST_SERVER_TOKEN = 'tok-engine-456';
    const loaded = await loadConfig({ cwd: dir, environment: process.env });
    const engine = await createEngine(loaded, { cwd: dir });
    try {
      await engine.store.backend.get('ns', 'k').catch(() => undefined);
    } finally {
      await engine.close();
    }
    expect(auth.length).toBeGreaterThan(0);
    expect(auth.every((a) => a === 'Bearer tok-engine-456')).toBe(true);
  });

  it('server.token: secret://env/NAME still resolves through the env store, and wins over the variable', async () => {
    const dir = await initWithServer('  token: secret://env/SERVER_TOKEN\n');
    process.env.EZTEST_SERVER_TOKEN = 'not-this-one';
    process.env.EZTEST_SECRET_SERVER_TOKEN = 'tok-from-store-789';
    const loaded = await loadConfig({ cwd: dir, environment: process.env });
    expect((await serverClientFor(loaded, dir))!.o.token).toBe('tok-from-store-789');
  });

  it('resolveServerToken: literal, reference, variable, none', async () => {
    const resolve = async (ref: string) => `resolved(${ref})`;
    expect(await resolveServerToken({ token: 'lit' }, resolve, {})).toBe('lit');
    expect(await resolveServerToken({ token: 'secret://vault/x' }, resolve, { EZTEST_SERVER_TOKEN: 'v' })).toBe('resolved(secret://vault/x)');
    expect(await resolveServerToken({}, resolve, { EZTEST_SERVER_TOKEN: 'v' })).toBe('v');
    expect(await resolveServerToken(undefined, resolve, { EZTEST_SERVER_TOKEN: '' })).toBeUndefined();
  });
});
