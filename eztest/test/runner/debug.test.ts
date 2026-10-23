import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { EventBus, type EzEvent } from '../../src/core/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { DebugController, DebugStateError, readTrace, runJourneys, startScreencast, type ScreencastFrame } from '../../src/runner/index.js';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { FAST, bobOrderJourney, runDirOf, tempDir } from './fixtures.js';

let server: DemoServer;
beforeAll(async () => {
  server = await startDemoApp({ variant: 'a' });
});
afterAll(async () => {
  await server.close();
});

const LOGIN = `Open /login
Type "bob" into the Username field
Type "Builder#2" into the Password field`;

function collect(): { bus: EventBus; events: EzEvent[] } {
  const bus = new EventBus();
  const events: EzEvent[] = [];
  bus.on((e) => events.push(e));
  return { bus, events };
}

describe('live step debugger (real Chromium, demo app)', () => {
  it('breakpoints (plain and conditional), step over, step into, run to step; state is masked', async () => {
    const out = await tempDir('dbg-bp');
    const { bus, events } = collect();
    const dbg = new DebugController({ breakpoints: [{ journeyId: 'bob-order', stepId: 'click-the-sign-in-button' }] });
    // Conditional breakpoints: one whose condition never holds, one that holds on the order page.
    dbg.addBreakpoint({ stepIndex: 5, condition: { type: 'urlContains', value: '/nowhere' } });
    const onOrder = dbg.addBreakpoint({ stepIndex: 8, condition: { type: 'pageContainsText', value: 'created' } });
    expect(() => dbg.retry()).toThrow(DebugStateError);
    const running = runJourneys([bobOrderJourney()], { ...FAST, baseUrl: server.url, outputDir: out, debug: dbg, events: bus });

    const s1 = await dbg.waitForPause();
    expect(s1).toMatchObject({ status: 'paused', journeyId: 'bob-order', stepIndex: 3, stepId: 'click-the-sign-in-button', phase: 'before-step', reason: 'breakpoint bp-1' });
    expect(s1.url).toMatch(/\/login$/);
    expect(s1.steps?.[3]).toMatchObject({ id: 'click-the-sign-in-button', edited: false });
    // The live page really is paused before the click.
    expect(dbg.page?.url()).toMatch(/\/login$/);

    dbg.stepOver();
    const s2 = await dbg.waitForPause();
    expect(s2).toMatchObject({ stepIndex: 4, reason: 'step', phase: 'before-step' });
    expect(s2.url).toMatch(/\/dashboard$/);

    dbg.runToStep({ stepIndex: 7 });
    const s3 = await dbg.waitForPause();
    expect(s3).toMatchObject({ stepIndex: 7, stepId: 'click-the-submit-order-button', reason: 'runToStep' });

    // Step into: pause again inside the same step, before its post-conditions are verified.
    dbg.stepInto();
    const s4 = await dbg.waitForPause();
    expect(s4).toMatchObject({ stepIndex: 7, phase: 'before-verify', reason: 'step' });
    expect(() => dbg.skip()).toThrow(/while paused before-verify/);

    dbg.resume();
    const s5 = await dbg.waitForPause();
    expect(s5).toMatchObject({ stepIndex: 8, reason: `breakpoint ${onOrder.id}` });
    expect(String(s5.ledger?.orderNumber ?? '')).toBe('');
    dbg.resume();

    const run = await running;
    expect(run.journeys[0].status).toBe('passed');
    expect(dbg.state().status).toBe('finished');
    expect(dbg.breakpoints.find((b) => b.stepIndex === 5)?.hits).toBe(0);
    const types = events.map((e) => e.type).filter((t) => t.startsWith('debug.'));
    expect(types.filter((t) => t === 'debug.paused')).toHaveLength(5);
    expect(types.filter((t) => t === 'debug.resumed')).toHaveLength(5);
    expect(types.filter((t) => t === 'debug.stepStarted')).toHaveLength(run.journeys[0].steps.length);
    expect(types.at(-1)).toBe('debug.finished');
    await expect(dbg.waitForPause()).rejects.toThrow(/finished/);
  });

  it('pauses on failure; edit-and-continue fixes the step and the journey passes; ad-hoc steps run against the live page', async () => {
    const out = await tempDir('dbg-edit');
    const dbg = new DebugController();
    const j = parseEzScript(`Journey: Typo
Id: typo
${LOGIN}
Click the "Sign on" button
  Expect the URL contains "/dashboard"
Verify the page contains "Welcome"`);
    const running = runJourneys([j], { ...FAST, baseUrl: server.url, outputDir: out, debug: dbg, timeTravel: { enabled: true, screenshots: false } });

    const s = await dbg.waitForPause();
    expect(s).toMatchObject({ stepIndex: 3, phase: 'failed', reason: 'failure' });
    expect(s.lastResult?.status).toBe('failed');
    expect(s.lastResult?.error?.message).toMatch(/Sign on/);
    // Secrets typed earlier never appear in debugger state.
    expect(JSON.stringify(s)).not.toContain('Builder#2');

    // Ad-hoc evaluation: a console for steps, not added to the journey.
    const check = await dbg.evaluate('Verify the page contains "Sign in to EZ Shop"');
    expect(check.status).toBe('passed');
    const bad = await dbg.evaluate('Verify the page contains "Not on this page"');
    expect(bad.status).toBe('failed');
    const count = await dbg.validate('the "Sign in" button', { highlight: true });
    expect(count).toMatchObject({ count: 1, highlighted: 1 });
    await expect(dbg.evaluate('Bogus words that parse to nothing')).rejects.toThrow(/cannot understand/);

    // Edit-and-continue: replace the step (keeps its id) and retry it.
    const edited = 'Click the "Sign in" button\n  Expect the URL contains "/dashboard"\n  Expect the page contains "Welcome"';
    dbg.retry(edited);
    const run = await running;
    const jr = run.journeys[0];
    expect(jr.steps.map((x) => x.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect(jr.steps[3]).toMatchObject({ stepId: 'click-the-sign-on-button', intent: 'Click the "Sign in" button', status: 'passed' });
    expect(jr.status).toBe('passed');
    expect(jr.steps[3].conditions.map((c) => c.passed)).toEqual([true, true]);

    // The trace keeps both executions of the edited step.
    const t = await readTrace(runDirOf(out, run), 'typo', 1);
    const execs = t.steps.filter((x) => x.index === 3).map((x) => [x.execution, x.status, x.edited ?? false]);
    expect(execs).toEqual([[1, 'failed', false], [2, 'passed', true]]);
    expect(t.steps.some((x) => x.stepId.startsWith('adhoc-'))).toBe(false);
  });

  it('skips a failing step on request, and edits an upcoming step before it runs', async () => {
    const out = await tempDir('dbg-skip');
    const dbg = new DebugController({ pauseAtStart: true });
    const j = parseEzScript(`Journey: Skip
Id: skip
Open /login
Click the "Does not exist" button
Go to /dashboard`);
    const running = runJourneys([j], { ...FAST, baseUrl: server.url, outputDir: out, debug: dbg });
    const s0 = await dbg.waitForPause();
    expect(s0).toMatchObject({ stepIndex: 0, reason: 'pause' });
    const step = dbg.replaceStep('Verify the page contains "Sign in to EZ Shop"', { index: 2 });
    expect(step.id).toBe('go-to-dashboard');
    expect(dbg.state().steps?.[2]).toMatchObject({ edited: true, intent: 'Verify the page contains "Sign in to EZ Shop"' });
    dbg.resume();
    const s1 = await dbg.waitForPause();
    expect(s1).toMatchObject({ stepIndex: 1, phase: 'failed' });
    expect(() => dbg.replaceStep('Open /login', { index: 0 })).toThrow(/already ran/);
    dbg.skip();
    const run = await running;
    expect(run.journeys[0].steps.map((x) => x.status)).toEqual(['passed', 'skipped', 'passed']);
    expect(run.journeys[0].steps[1].error?.message).toMatch(/skipped in the debugger after failing/);
  });

  it('forces concurrency 1 and the picker ranks locators with match counts; screencast streams frames; input is forwarded', async () => {
    const out = await tempDir('dbg-live');
    const { bus, events } = collect();
    const dbg = new DebugController({ breakpoints: [{ stepIndex: 1, journeyId: 'one' }] });
    const one = parseEzScript(`Journey: One\nId: one\n${LOGIN}`);
    const two = parseEzScript('Journey: Two\nId: two\nOpen /login');
    const running = runJourneys([one, two], { ...FAST, baseUrl: server.url, outputDir: out, debug: dbg, events: bus, concurrency: 4 });
    await dbg.waitForPause();
    const page = dbg.page!;

    // Picker on the Username input: test id first, then role/label; xpath last.
    const box = (await page.locator('#username').boundingBox())!;
    const pick = await dbg.pick({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    expect(pick.tag).toBe('input');
    const first = pick.candidates[0];
    expect(first).toMatchObject({ candidate: { strategy: 'testId', value: 'username' }, count: 1, unique: true, ezTarget: 'testid=username', ezResolves: true });
    expect(pick.candidates.at(-1)?.candidate.strategy).toBe('xpath');
    const label = pick.candidates.find((c) => c.candidate.strategy === 'label')!;
    expect(label).toMatchObject({ count: 1, unique: true, ezTarget: 'the "Username" field', ezResolves: true, ezStep: 'Type "…" into the "Username" field' });
    const role = pick.candidates.find((c) => c.candidate.strategy === 'role')!;
    expect(role).toMatchObject({ candidate: { value: 'textbox', name: 'Username' }, count: 1 });
    expect(pick.candidates.find((c) => c.candidate.strategy === 'css' && c.candidate.value === '#username')).toMatchObject({ count: 1, unique: true });
    for (let i = 1; i < pick.candidates.length - 1; i++) {
      const [p, c] = [pick.candidates[i - 1], pick.candidates[i]];
      if (p.unique === c.unique) expect(p.stability).toBeGreaterThanOrEqual(c.stability);
    }

    // Picker on a nav link: ambiguous text is counted, not hidden.
    const nav = await dbg.validate({ strategy: 'role', value: 'link' }, { highlight: true });
    expect(nav.count).toBe(3);
    expect(nav.boxes).toHaveLength(3);
    expect(nav.highlighted).toBe(3);
    expect(await page.locator('#__eztest_highlight__').count()).toBe(1);
    const linkBox = (await page.getByRole('link', { name: 'New order' }).boundingBox())!;
    const linkPick = await dbg.pick({ x: linkBox.x + 2, y: linkBox.y + linkBox.height / 2 });
    expect(linkPick.candidates[0]).toMatchObject({ candidate: { strategy: 'role', value: 'link', name: 'New order' }, unique: true, ezTarget: 'the "New order" link', ezStep: 'Click the "New order" link' });
    const css = linkPick.candidates.find((c) => c.candidate.strategy === 'css')!;
    expect(css.notes.join(' ')).toMatch(/nth-of-type|structural/);

    // Live view: frames arrive with metadata; input reaches the page.
    const frames: ScreencastFrame[] = [];
    const cast = await startScreencast(page, { maxFps: 10, onFrame: (f) => void frames.push(f) });
    await dbg.input({ type: 'mouse', action: 'click', x: box.x + box.width / 2, y: box.y + box.height / 2 });
    await dbg.input({ type: 'text', text: 'abc' });
    await dbg.input({ type: 'key', action: 'press', key: 'Backspace' });
    await dbg.input({ type: 'key', action: 'press', key: 'x' });
    expect(await page.inputValue('#username')).toBe('abx');
    const deadline = Date.now() + 5000;
    while (frames.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await cast.stop();
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(cast.stats.mode).toBe('stopped');
    expect(Buffer.from(frames[0].data, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(frames[0].metadata.deviceWidth).toBeGreaterThan(0);

    // The Firefox/WebKit fallback: periodic screenshots, same frame shape.
    const shots: ScreencastFrame[] = [];
    const poll = await startScreencast(page, { mode: 'screenshot', fallbackIntervalMs: 100, onFrame: (f) => void shots.push(f) });
    const until = Date.now() + 5000;
    while (shots.length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    await poll.stop();
    expect(shots.length).toBeGreaterThanOrEqual(2);
    expect(shots[0].metadata.deviceWidth).toBeGreaterThan(0);

    await dbg.evaluate('Type "bob" into the Username field');
    expect(await page.inputValue('#username')).toBe('bob');
    dbg.resume();
    // Highlights are removed on resume.
    const run = await running;
    expect(run.journeys.map((j) => j.status)).toEqual(['passed', 'passed']);
    const order = events.filter((e) => e.type === 'journey:start' || e.type === 'journey:end').map((e) => `${e.type}:${e.journeyId}`);
    expect(order).toEqual(['journey:start:one', 'journey:end:one', 'journey:start:two', 'journey:end:two']);
  });
});
