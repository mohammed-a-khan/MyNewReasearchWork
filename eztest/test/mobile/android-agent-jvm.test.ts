/**
 * The real EZTest Android agent code on the JVM: its protocol core (Router,
 * Finder, Snapshot, HttpServer, Json) compiled with javac and driven (1) by its
 * own request-handler checks and (2) end to end by EZTest: a journey through
 * the mobile driver, the fake adb server's port forward and the agent's HTTP
 * server, over a fixture device. The UiAutomator half (UiAutomatorDevice,
 * AgentInstrumentation) needs the Android SDK and is not compiled here.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createHealer } from '../../src/heal/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { createMobileDriver } from '../../src/mobile/index.js';
import { runJourneys } from '../../src/runner/index.js';
import { FakeAdbServer } from './fake-adb.js';

const AGENT = resolve(__dirname, '../../agents/android/app/src');
const FIXTURE = resolve(__dirname, 'fixtures/shop-android.xml');
const hasJava = spawnSync('javac', ['-version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!hasJava)('EZTest Android agent core on the JVM', () => {
  let classes: string;
  beforeAll(() => {
    classes = mkdtempSync(join(tmpdir(), 'ez-agent-classes-'));
    const core = join(AGENT, 'main/java/io/eztest/agent/core');
    const test = join(AGENT, 'test/java/io/eztest/agent/core');
    const sources = [...readdirSync(core).map((f) => join(core, f)), ...['FixtureDevice.java', 'FixtureAgentMain.java', 'AgentCoreChecks.java'].map((f) => join(test, f))];
    execFileSync('javac', ['-Xlint:all', '-Werror', '-d', classes, ...sources], { stdio: 'pipe' });
  }, 120_000);
  afterAll(() => rmSync(classes, { recursive: true, force: true }));

  it('passes its request-handler checks', () => {
    const out = execFileSync('java', ['-cp', classes, 'io.eztest.agent.core.AgentCoreChecks', FIXTURE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(out).toMatch(/AGENT_CORE_CHECKS_PASSED \d+/);
  });

  /** Start the real agent (fixture device) with a session token; resolves with its port. */
  function startAgent(token: string | undefined, port = 0): { proc: ChildProcess; port: Promise<number> } {
    const proc = spawn('java', ['-cp', classes, 'io.eztest.agent.core.FixtureAgentMain', FIXTURE, String(port), ...(token ? [token] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
    return {
      proc,
      port: new Promise<number>((res, rej) => {
        let buf = '';
        const t = setTimeout(() => rej(new Error(`agent did not start: ${buf}`)), 20_000);
        proc.stdout!.on('data', (d: Buffer) => {
          buf += d.toString();
          const m = /EZTEST_AGENT_LISTENING (\d+)/.exec(buf);
          if (m) {
            clearTimeout(t);
            res(Number(m[1]));
          }
        });
      }),
    };
  }

  it('answers only requests with its session token (constant-time check, before any route)', async () => {
    for (const token of ['s3ss10n-t0ken-for-this-test-only', undefined]) {
      const a = startAgent(token);
      try {
        const port = await a.port;
        const anon = await fetch(`http://127.0.0.1:${port}/status`);
        expect(anon.status).toBe(401);
        expect(await anon.json()).toMatchObject({ error: { code: 'unauthorized', message: token ? 'missing or wrong session token' : expect.stringMatching(/started without a session token/) } });
        const wrong = await fetch(`http://127.0.0.1:${port}/source`, { headers: { 'x-eztest-agent-token': 'guess' } });
        expect(wrong.status).toBe(401);
        const right = await fetch(`http://127.0.0.1:${port}/status`, { headers: { 'x-eztest-agent-token': token ?? '' } });
        expect(right.status).toBe(token ? 200 : 401);
      } finally {
        a.proc.kill();
      }
    }
  });

  it('serves a journey run by EZTest through adb forward', async () => {
    // A free local port for the agent, which EZTest's `am instrument` starts with a fresh token.
    const { createServer } = await import('node:net');
    const port = await new Promise<number>((res) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => res(p));
      });
    });
    let agent: ChildProcess | undefined;
    let token: string | undefined;
    const adb = new FakeAdbServer();
    adb.shell = (_s, cmd) => {
      if (cmd.startsWith('pm path')) return 'package:/x\n';
      if (cmd.startsWith('am instrument')) {
        token = /-e token (\S+)/.exec(cmd)?.[1];
        agent = startAgent(token, port).proc;
        return { stream: true };
      }
      return cmd.startsWith('monkey') ? 'Events injected: 1\n' : '';
    };
    await adb.start();
    adb.targets.set('tcp:6790', port);
    const out = mkdtempSync(join(tmpdir(), 'ez-agent-jvm-'));
    try {
      const j = parseEzScript(`Journey: Real agent core
Platform: android
App: "com.shop.app"
Type "alice" into the Username field
  Expect the Username field has value "alice"
Tap the "Log in" button
  Expect an alert saying "Signed in as alice"
Accept the system alert
Expect the screen contains "ORD-1001 Shipped"
Check the "Remember me" checkbox
  Expect the "Remember me" checkbox is checked
Long press the Map image for 1 second
Rotate to landscape
Press the device back button
`);
      const r = await runJourneys([j], { outputDir: out, fingerprintStore: join(out, 'fp.json'), healer: createHealer(), locateTimeoutMs: 500, platformDrivers: [createMobileDriver({ android: { adb: { port: adb.port } }, launchSettleMs: 0 })] });
      expect(r.journeys[0].steps.map((s) => `${s.status}${s.error ? ` ${s.error.message}` : ''}`)).toEqual(j.steps.map(() => 'passed'));
      expect(r.journeys[0].browser).toBe('android (JVM fixture)');
      expect(token).toMatch(/^[0-9a-f]{48}$/);
    } finally {
      agent?.kill();
      await adb.stop();
      rmSync(out, { recursive: true, force: true });
    }
  });
});
