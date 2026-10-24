/**
 * `eztest server audit verify` and `eztest server audit rotate-key`: on the server machine (the
 * database and key file directly) and through a running server (--url, a token). A rotation made
 * by the CLI while the server runs is taken over by the server: it signs with the new key, and a
 * later rotation through the API keeps the CLI's key (no entry becomes unverifiable).
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildProgram, type CliIO } from '../../src/cli/program.js';
import { BOOT, startTestServer, type TestServer } from './helpers.js';

let server: TestServer;
let cfgFile: string;
beforeAll(async () => {
  server = await startTestServer();
  cfgFile = join(server.dataDir, 'eztest-server.yaml');
  writeFileSync(cfgFile, `dataDir: ${JSON.stringify(server.dataDir)}\n`);
  // A few audited actions through the API.
  await server.token('ci', [{ project: 'pay', role: 'tester' }]);
  await server.token('ci2', [{ project: 'pay', role: 'viewer' }]);
});
afterAll(async () => {
  await server.close();
});

async function cli(args: string[]): Promise<{ out: string; err: string; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (s) => out.push(s), err: (s) => err.push(s), cwd: server.dataDir, env: { ...process.env, EZTEST_SERVER_TOKEN: '' } };
  process.exitCode = 0;
  await buildProgram(io).parseAsync(['node', 'eztest', ...args], { from: 'node' });
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { out: out.join('\n'), err: err.join('\n'), code };
}

const keyFile = () => JSON.parse(readFileSync(join(server.dataDir, 'audit-key.json'), 'utf8')) as { current: string; keys: Record<string, unknown> };
const lastEntry = async () => {
  const list = (await server.req('GET', '/api/audit?limit=1', { token: BOOT })).json as Array<{ action: string; hash: string }>;
  return list[0];
};

describe('eztest server audit', () => {
  it('verifies the chain on the server machine and through the API', async () => {
    const local = await cli(['server', 'audit', 'verify', '--config', cfgFile]);
    expect(local.code).toBe(0);
    expect(local.out).toMatch(/^VALID: \d+ audit entries, head [0-9a-z:-]+\.\.\.$/);
    const remote = await cli(['server', 'audit', 'verify', '--url', server.url, '--token', BOOT]);
    expect(remote.code).toBe(0);
    expect(remote.out).toMatch(/^VALID: /);
    const noToken = await cli(['server', 'audit', 'verify', '--url', server.url]);
    expect(noToken.code).toBe(2);
    expect(noToken.err).toMatch(/--url needs a token/);
  });

  it('rotates the key from the CLI while the server runs: the server signs with it, and an API rotation keeps it', async () => {
    const before = keyFile().current;
    const r = await cli(['server', 'audit', 'rotate-key', '--config', cfgFile]);
    expect(r.code).toBe(0);
    const viaCli = keyFile().current;
    expect(viaCli).not.toBe(before);
    expect(r.out).toBe(`audit key rotated: new entries are signed with ${viaCli}`);
    // The running server's next entry is signed with the CLI's key.
    await server.token('ci3', [{ project: 'pay', role: 'viewer' }]);
    expect((await lastEntry()).hash.split(':')[1]).toBe(viaCli);
    // Rotating through the API (admin token) keeps every older key in the file.
    const api = await cli(['server', 'audit', 'rotate-key', '--url', server.url, '--token', BOOT]);
    expect(api.code).toBe(0);
    const k = keyFile();
    expect(Object.keys(k.keys)).toEqual(expect.arrayContaining([before, viaCli, k.current]));
    expect((await lastEntry()).action).toBe('audit.key.rotate');
    const v = await cli(['server', 'audit', 'verify', '--config', cfgFile]);
    expect(v.code).toBe(0);
    expect(v.err).toBe('');
  });

  it('reports a tampered chain with exit code 1 (audit-verify is the same command)', async () => {
    const { Store } = await import('../../src/server/index.js');
    const store = await Store.open({ driver: 'sqlite', file: join(server.dataDir, 'eztest.db') } as never);
    try {
      await store.run("UPDATE ez_audit SET actor = 'mallory' WHERE seq = 1");
    } finally {
      await store.close();
    }
    for (const cmd of [['server', 'audit', 'verify'], ['server', 'audit-verify']]) {
      const v = await cli([...cmd, '--config', cfgFile]);
      expect(v.code).toBe(1);
      expect(v.out).toMatch(/^TAMPERED: /);
      expect(v.err).toMatch(/entry 1: content altered or forged/);
    }
  });
});
