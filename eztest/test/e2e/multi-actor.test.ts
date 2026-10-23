/**
 * Multi-actor journeys (docs/multi-actor.md): several users in one journey, each
 * in an isolated browser context, against the demo app's two-user chat (/chat).
 * The parallel exchange can only pass when the branches really run at the same
 * time (each waits for the other's message before it is done).
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { flattenStepResults, type JourneyResult, type StepResult } from '../../src/core/index.js';
import { journeyToEzScript, normalizeJourneyInput, parseEzScript } from '../../src/intent/index.js';
import { actorNames, isMultiActor, primaryActor, runJourneys, type PlatformDriver } from '../../src/runner/index.js';
import { loadCodeJourneys } from '../../src/runner/code-journeys.js';
import { debugOutline } from '../../src/studio/debug-outline.js';
import { describeSteps, FAST, outDir } from './advanced-helpers.js';

const CHAT = `Journey: Two users chat
Tags: @chat
Actors: alice, bob

As alice:
  Open /chat/login
  Type "alice" into the Your name field
  Click the "Join the chat" button
  Expect the page contains "Signed in as alice"
As bob:
  Open /chat/login
  Type "bob" into the Your name field
  Click the "Join the chat" button
  Expect the page contains "Signed in as bob"

In parallel:
  As alice:
    Type "Hi Bob" into the Message field
    Click the "Send" button
    Expect the page contains "bob: Hi Alice"
  As bob:
    Expect the page contains "alice: Hi Bob"
    Type "Hi Alice" into the Message field
    Click the "Send" button
End

As alice:
  Expect the page contains "Signed in as alice"
Switch to user "bob"
Expect the page contains "Signed in as bob"
Expect the page contains "alice: Hi Bob"
`;

let app: DemoServer;
beforeAll(async () => {
  app = await startDemoApp();
});
afterAll(async () => {
  await app.close();
});

const all = (j: JourneyResult): StepResult[] => flattenStepResults(j.steps).map((x) => x.result);

describe('.ez, YAML and JSON: actor syntax', () => {
  it('parses As sections, Switch to user, In parallel and the Actors header; renders back', () => {
    const j = parseEzScript(CHAT);
    expect(Object.keys(j.actors ?? {})).toEqual(['alice', 'bob']);
    expect(j.steps.map((s) => `${s.action}:${s.value ?? ''}`)).toEqual(['actor:alice', 'actor:bob', 'parallel:', 'actor:alice', 'actor:bob']);
    expect(j.steps[0].steps).toHaveLength(3); // the Expect after the click is its post-condition
    const par = j.steps[2];
    expect(par.steps!.map((s) => s.value)).toEqual(['alice', 'bob']);
    expect(par.steps![1].steps).toHaveLength(3);
    expect(j.steps[4].steps).toBeUndefined(); // Switch to user: no children; the Expect lines after it are its post-conditions
    expect(j.steps[4].postconditions).toHaveLength(2);
    expect(isMultiActor(j)).toBe(true);
    expect(primaryActor(j)).toBe('alice');
    // Round trip through the renderer.
    const again = parseEzScript(journeyToEzScript(j));
    // (A standalone Expect first in a block renders as "Assert that ...": same step, other wording.)
    const noIntent = (v: unknown) => JSON.parse(JSON.stringify(v), (k, x: unknown) => (k === 'intent' ? undefined : x)) as unknown;
    expect(noIntent(again.steps)).toEqual(noIntent(j.steps));
    expect(again.actors).toEqual(j.actors);
  });

  it('ends As sections at the next As, at End (or an outdented End with its block), and at the end of the file', () => {
    const j = parseEzScript(`Journey: Sections
As a:
  Open /a
As b: click the "Go" button
If the page contains "x" then
  As a:
    Open /b
End
In parallel:
  As a:
    Open /c
  End
  As b:
    Open /d
  End
End
As b:
  Open /e`);
    expect(j.steps.map((s) => s.action)).toEqual(['actor', 'actor', 'if', 'parallel', 'actor']);
    expect(j.steps[1].steps).toHaveLength(1); // inline As
    expect(j.steps[2].steps![0].steps).toHaveLength(1);
    expect(j.steps[3].steps!.map((s) => s.value)).toEqual(['a', 'b']);
    expect(j.steps[4].steps).toHaveLength(1);
    // The Studio debugger outline nests the same way.
    const o = debugOutline(`Journey: x\nAs a:\n  Open /a\nIn parallel:\n  As a:\n    Open /c\n  As b:\n    Open /d\nEnd\nAs b:\n  Open /e\n`);
    expect(o.ok, o.error).toBe(true);
    expect(o.entries.filter((e) => e.depth === 0).map((e) => e.text)).toEqual(['As a:', 'In parallel:', 'As b:']);
  });

  it('reads Actors options and fails loudly on bad ones', () => {
    const j = parseEzScript(`Journey: Options\nActors: manager as approver, shopper as customer with device "iPhone 13", courier on android app "com.x.courier"\nAs manager:\n  Open /`);
    expect(j.actors).toEqual({
      manager: { role: 'approver' },
      shopper: { role: 'customer', emulation: { device: 'iPhone 13' } },
      courier: { platform: 'android', app: 'com.x.courier' },
    });
    // A native actor is never the primary (web) one.
    expect(primaryActor({ actors: { courier: { platform: 'android' }, web: {} }, steps: [] })).toBe('web');
    expect(() => parseEzScript('Journey: Bad\nActors: manager speaks french\nOpen /')).toThrow(/unknown actor option/);
    expect(() => parseEzScript('Journey: Open\nIn parallel:\n  As a:\n    Open /a\n')).toThrow(/no matching "End"/);
  });

  it('YAML/JSON: actors map, - as: + steps, - switchTo:, - parallel:', () => {
    const j = normalizeJourneyInput(YAML.parse(`
name: YAML chat
actors: { alice: chat-user, bob: {} }
steps:
  - as: alice
    steps: [Open /chat]
  - parallel:
      - as: alice
        steps: ['Click the "Send" button']
      - as: bob
        steps: [Open /chat]
  - switchTo: bob
  - Expect the page contains "x"
`));
    expect(j.actors).toEqual({ alice: { role: 'chat-user' }, bob: {} });
    expect(j.steps.map((s) => s.action)).toEqual(['actor', 'parallel', 'actor', 'assert']);
    expect(j.steps[1].steps!.map((s) => s.value)).toEqual(['alice', 'bob']);
    expect(j.steps[2]).toMatchObject({ action: 'actor', value: 'bob' });
    expect(j.steps[2].steps).toBeUndefined();
    expect(actorNames(j)).toEqual(['alice', 'bob']);
  });
});

describe('multi-actor journeys in real browsers (demo chat)', () => {
  it('two users chat in isolated contexts; the parallel exchange runs at the same time; evidence is labelled per actor', async () => {
    const out = await outDir('actors');
    const run = await runJourneys([parseEzScript(CHAT)], { ...FAST, conditionTimeoutMs: 6000, baseUrl: app.url, outputDir: out, screenshots: 'every-step', trace: true });
    const j = run.journeys[0];
    expect(j.status, `${j.error?.message ?? ''}\n${describeSteps(j)}`).toBe('passed');
    // Every leaf step says whose session ran it.
    const leaves = all(j).filter((s) => !s.children?.length);
    expect(leaves.every((s) => s.actor === 'alice' || s.actor === 'bob'), JSON.stringify(leaves.map((s) => [s.stepId, s.actor]))).toBe(true);
    const par = j.steps[2];
    expect(par.children!.map((c) => c.actor)).toEqual(['alice', 'bob']);
    expect(par.captured).toMatchObject({ branches: 2 });
    // Isolation: each context kept its own cookie (one context would have made alice "bob").
    expect(j.steps[3].children!.every((c) => c.status === 'passed')).toBe(true);
    expect(j.steps[4]).toMatchObject({ actor: 'bob', status: 'passed' });
    expect(j.steps[4].conditions.map((c) => c.passed)).toEqual([true, true]);
    expect(app.chat.messages.map((m) => `${m.from}: ${m.text}`).sort()).toEqual(['alice: Hi Bob', 'bob: Hi Alice']);
    // Evidence: screenshots in per-actor folders with the actor in the description; a trace per actor.
    const manifest = readFileSync(join(out, run.runId, 'evidence-manifest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; path: string; description?: string });
    const shots = manifest.filter((m) => m.kind === 'screenshot');
    expect(shots.some((m) => m.path.includes('/actor-alice/') && /\(alice\)$/.test(m.description ?? ''))).toBe(true);
    expect(shots.some((m) => m.path.includes('/actor-bob/') && /\(bob\)$/.test(m.description ?? ''))).toBe(true);
    const traces = manifest.filter((m) => m.kind === 'trace').map((m) => m.description);
    expect(traces).toEqual(expect.arrayContaining(['browser trace (alice)', 'browser trace (bob)']));
    for (const m of manifest.filter((x) => x.kind === 'trace')) expect(existsSync(join(out, run.runId, m.path))).toBe(true);
    // The network log says whose request each entry was.
    const net = manifest.find((m) => m.kind === 'network' && m.path.endsWith('/network.json'))!;
    const entries = JSON.parse(readFileSync(join(out, run.runId, net.path), 'utf8')) as Array<{ url: string; actor?: string }>;
    expect(new Set(entries.filter((e) => e.url.includes('/chat')).map((e) => e.actor))).toEqual(new Set(['alice', 'bob']));
  });

  it('a sequential "parallel" (the debugger / time-travel mode) would deadlock the exchange: the branches really overlap', async () => {
    app.chat.messages = [];
    const ez = CHAT.replace('Journey: Two users chat', 'Journey: Chat in order');
    const run = await runJourneys([parseEzScript(ez)], { ...FAST, conditionTimeoutMs: 1500, baseUrl: app.url, outputDir: await outDir('actors-seq'), timeTravel: { enabled: true } });
    const j = run.journeys[0];
    // Branches one after the other: alice waits for bob's message before bob may send it.
    expect(j.status).toBe('failed');
    expect(j.steps[2].captured).toMatchObject({ sequential: true });
    expect(j.steps[2].error?.message).toContain('bob: Hi Alice');
  });

  it('declared roles sign in when the actor first acts; a native actor runs its blocks on a platform driver with ledger handoff', async () => {
    const logins: string[] = [];
    const seen: Array<{ id: string; platform?: string; app?: string; steps: string[]; vars: Record<string, string> }> = [];
    const driver: PlatformDriver = {
      name: 'fake-mobile',
      platforms: ['android'],
      async runAttempt(journey, attempt) {
        seen.push({ id: journey.id, platform: journey.platform, app: journey.app, steps: journey.steps.map((s) => s.intent), vars: journey.variables });
        const now = new Date().toISOString();
        return {
          journeyId: journey.id, name: journey.name, status: 'passed', startedAt: now, durationMs: 1, tags: [], requirements: [], risk: 3, attempt, browser: 'android', evidence: [],
          steps: journey.steps.map((s) => ({ stepId: s.id, intent: s.intent, status: 'passed' as const, startedAt: now, durationMs: 1, conditions: [], evidence: [] })),
          ledger: { pickup: 'PK-42' },
        };
      },
    };
    const j = parseEzScript(`Journey: Courier and dispatcher
Actors: dispatcher as ops, courier on android app "com.example.courier"
As dispatcher:
  Open /chat/login
  Set variable order = "ORD-7"
As courier:
  Tap the "Accept \${order}" button
As dispatcher:
  Type "\${pickup}" into the Your name field
  Expect the value of the Your name field to be "PK-42"
`);
    const run = await runJourneys([j], {
      ...FAST, baseUrl: app.url, outputDir: await outDir('actors-mixed'), platformDrivers: [driver],
      login: async (page, role) => {
        logins.push(role);
        await page.goto(`${app.url}/chat/login`);
      },
    });
    const r = run.journeys[0];
    expect(r.status, `${r.error?.message ?? ''}\n${describeSteps(r)}`).toBe('passed');
    expect(logins).toEqual(['ops']); // once, on the dispatcher's first block
    expect(r.steps[0].children![0]).toMatchObject({ intent: 'Log in as ops', actor: 'dispatcher' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: 'courier-and-dispatcher~courier', platform: 'android', app: 'com.example.courier', steps: ['Tap the "Accept ${order}" button'] });
    expect(seen[0].vars.order).toBe('ORD-7');
    expect(r.steps[1].children![0]).toMatchObject({ actor: 'courier', status: 'passed' });
    expect(r.ledger.pickup).toBe('PK-42');
  });

  it('SDK: actors.<name>.ui and as(name, fn), each in its own context, in parallel with Promise.all', async () => {
    app.chat.messages = [];
    const dir = await mkdtemp(join(tmpdir(), 'eztest-actors-sdk-'));
    const file = join(dir, 'chat.journey.ts');
    await writeFile(file, `import { journey, as } from ${JSON.stringify(join(process.cwd(), 'src/sdk/index.ts'))};
journey('SDK chat', { actors: { carol: {}, dave: {} } }, async ({ actors, ui, expect }) => {
  for (const name of ['carol', 'dave']) {
    const a = actors[name];
    await a.ui.open('/chat/login');
    await a.ui.fill({ label: 'Your name' }, name);
    await a.ui.click({ role: 'button', name: 'Join the chat' });
  }
  await Promise.all([
    actors.carol.ui.fill({ label: 'Message' }, 'from carol').then(() => actors.carol.ui.click({ role: 'button', name: 'Send' })),
    actors.dave.ui.fill({ label: 'Message' }, 'from dave').then(() => actors.dave.ui.click({ role: 'button', name: 'Send' })),
  ]);
  await actors.dave.expect.ui.page().toContainText('carol: from carol');
  await as('carol', async () => {
    await expect.ui.page().toContainText('Signed in as carol');
    await expect.ui.page().toContainText('dave: from dave');
  });
  // Plain ui.* calls run as the primary (first declared) actor.
  await expect(await ui.text({ testId: 'chat-user' })).toBe('carol');
});
`);
    const journeys = await loadCodeJourneys(file, { cwd: dir });
    const run = await runJourneys(journeys, { ...FAST, baseUrl: app.url, outputDir: await outDir('actors-sdk'), baseDir: dir });
    const r = run.journeys[0];
    expect(r.status, `${r.error?.message ?? ''}\n${describeSteps(r)}`).toBe('passed');
    const actorsSeen = new Set(all(r).map((s) => s.actor).filter(Boolean));
    expect(actorsSeen).toEqual(new Set(['carol', 'dave']));
    expect(app.chat.messages.map((m) => m.from).sort()).toEqual(['carol', 'dave']);
  });
});
