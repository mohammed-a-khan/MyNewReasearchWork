/**
 * The device agents are reachable by their EZTest session only: they listen on
 * the loopback and refuse requests without the session token. The Android
 * agent's HTTP server is exercised on the JVM (android-agent-jvm.test.ts); the
 * iOS agent cannot be compiled here (no Xcode), so its source is checked for
 * the same guarantees, and the host client for sending and reporting the token.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { describe, expect, it } from '../support/testkit.js';
import { AGENT_TOKEN_HEADER, AgentClient, newAgentToken } from '../../src/mobile/agent.js';

const IOS = resolve(__dirname, '../../agents/ios/EZTestAgentUITests');

describe('device agent session tokens', () => {
  it('the iOS agent listens on the loopback only, on simulators and devices alike', () => {
    const src = readFileSync(resolve(IOS, 'AgentServer.swift'), 'utf8');
    expect(src).toMatch(/params\.requiredLocalEndpoint = NWEndpoint\.hostPort\(host: "127\.0\.0\.1"/);
    expect(src).not.toMatch(/NWListener\(using: params, on:/);
    expect(src).not.toMatch(/targetEnvironment\(simulator\)/);
  });

  it('the iOS agent refuses requests without its token before they reach the runner', () => {
    const src = readFileSync(resolve(IOS, 'AgentServer.swift'), 'utf8');
    const tests = readFileSync(resolve(IOS, 'AgentTests.swift'), 'utf8');
    expect(tests).toMatch(/env\["EZTEST_AGENT_TOKEN"\]/);
    expect(tests).toMatch(/AgentServer\(port: port, token: token\)/);
    expect(src).toMatch(/kv\[0\]\.lowercased\(\) == "x-eztest-agent-token"/);
    // The check comes before the request is queued for the XCUI thread.
    const check = src.indexOf('guard self.authorized(req.token)');
    const queue = src.indexOf('self.pending.append(req)');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(queue);
    expect(src).toMatch(/req\.respond\(401/);
    expect(src).toMatch(/guard let p = presented, !token\.isEmpty else \{ return false \}/);
  });

  it('the host sends a fresh random token per session and reports a refusal clearly', async () => {
    const a = newAgentToken();
    const b = newAgentToken();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(b).not.toBe(a);
    const seen: Array<string | undefined> = [];
    const server = createServer((req, res) => {
      seen.push(req.headers[AGENT_TOKEN_HEADER] as string | undefined);
      const ok = req.headers[AGENT_TOKEN_HEADER] === a;
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? { ready: true, agent: 'x', version: '1', platform: 'android' } : { error: { code: 'unauthorized', message: 'missing or wrong session token' } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await new AgentClient({ url, token: a }).status()).toMatchObject({ ready: true });
      await expect(new AgentClient({ url, token: b }).status()).rejects.toThrow(/the device agent refused GET \/status: its session token does not match/);
      await expect(new AgentClient({ url }).status()).rejects.toThrow(/no session token was sent.*mobile\.<platform>\.agentToken/);
      expect(seen).toEqual([a, b, undefined]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
