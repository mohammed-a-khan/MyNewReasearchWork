/**
 * E2E (real browser): the browser clock against /lab/clock: set, advance,
 * pause, run timers, freeze, the Clock: header, navigation persistence,
 * performance.now and requestAnimationFrame, today() following the clock, and
 * the driver-level API. No wall-clock wait longer than a second.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { chromium } from '../../src/browser/index.js';
import { contextClock, parseClockDuration, parseClockTime } from '../../src/browser/clock.js';
import { flattenStepResults } from '../../src/core/index.js';
import { journeyToEzScript, parseEzScript, parseIntent } from '../../src/intent/index.js';
import { describeSteps, expectPasses, runEz } from './advanced-helpers.js';

let server: DemoServer;
beforeAll(async () => {
  server = await startDemoApp();
});
afterAll(async () => {
  await server.close();
});

describe('clock phrasings', () => {
  it('parse to clock steps and render back', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['Set the clock to 2027-03-15 09:00', { clock: 'set', time: '2027-03-15 09:00' }],
      ['Set the browser clock to "2026-12-31 23:59"', { clock: 'set', time: '2026-12-31 23:59' }],
      ['Freeze time at "2026-12-31 23:59 Europe/London"', { clock: 'fixed', time: '2026-12-31 23:59 Europe/London' }],
      ['Pause the clock', { clock: 'pause' }],
      ['Pause the clock at 2027-01-01T08:00', { clock: 'pauseAt', time: '2027-01-01T08:00' }],
      ['Resume the clock', { clock: 'resume' }],
      ['Advance the clock by 2 hours', { clock: 'fastForward', duration: '2 hours' }],
      ['Fast-forward the clock by 1h30m', { clock: 'fastForward', duration: '1h30m' }],
      ['Run the clock for 30 minutes', { clock: 'runFor', duration: '30 minutes' }],
      ['Run all timers', { clock: 'runAll' }],
      ['Run timers to the last one', { clock: 'runToLast' }],
      ['Use the real clock', { clock: 'real' }],
      ['Install a fake clock', { clock: 'install' }],
    ];
    for (const [line, args] of cases) {
      expect(parseIntent(line), line).toMatchObject({ action: 'browser', args: { op: 'clock', ...args } });
    }
    expect(() => parseIntent('Advance the clock by 2 fortnights')).toThrow();
    expect(() => parseIntent('Set the clock to 2027-13-45')).not.toThrow(); // shape only; the date is checked when it runs
    const j = parseEzScript(`Journey: Clock\nClock: 2026-12-31T23:59:50 Europe/London\n${cases.map((c) => c[0]).join('\n')}\n`);
    expect(j.clock).toBe('2026-12-31T23:59:50 Europe/London');
    expect(parseEzScript(journeyToEzScript(j))).toEqual(j);
  });

  it('read times and durations', () => {
    expect(parseClockTime('2026-12-31T23:59:50Z')).toBe(Date.UTC(2026, 11, 31, 23, 59, 50));
    expect(parseClockTime('2026-12-31 23:59', { timeZone: 'Europe/London' })).toBe(Date.UTC(2026, 11, 31, 23, 59));
    expect(parseClockTime('2026-07-01 12:00 Europe/Berlin')).toBe(Date.UTC(2026, 6, 1, 10, 0));
    expect(parseClockTime('2026-07-01T12:00+02:00')).toBe(Date.UTC(2026, 6, 1, 10, 0));
    expect(parseClockTime('2027-03-15', { timeZone: 'UTC' })).toBe(Date.UTC(2027, 2, 15));
    expect(() => parseClockTime('tomorrow-ish')).toThrow(/Cannot read the clock time/);
    expect(parseClockDuration('2 hours')).toBe(7_200_000);
    expect(parseClockDuration('1h30m')).toBe(5_400_000);
    expect(parseClockDuration('1 minute and 30 seconds')).toBe(90_000);
    expect(parseClockDuration('01:30:00')).toBe(5_400_000);
    expect(() => parseClockDuration('soon')).toThrow(/Cannot read the duration/);
  });
});

describe('clock in journeys', () => {
  it('New Year: set to 23:59:50, advance 15 s, the banner appears; no long wait', async () => {
    const t0 = Date.now();
    await expectPasses(server.url, `Journey: New year
Set the clock to "2026-12-31 23:59:50"
Open /lab/clock
Expect the page contains "2026-12-31"
Expect the "Happy new year" status is hidden
Advance the clock by 15 seconds
Expect the page contains "Happy new year 2027"
Expect #date has text "2027-01-01"
`);
    expect(Date.now() - t0).toBeLessThan(30_000);
  });

  it('pause stops time, runFor fires the 2-hour session timer, navigation keeps the time', async () => {
    const { j } = await expectPasses(server.url, `Journey: Session timeout
Clock: paused 2027-03-15 09:00
Open /lab/clock
Expect #now has text "09:00:00"
Click the "Start session" button
Expect the page contains "Session active"
Run the clock for 1 hour
Expect #now has text "10:00:00"
Expect the page contains "Session active"
Advance the clock by 1 hour
Expect the page contains "Session expired"
Click the "Measure" button
Expect #elapsed has text "7200 s"
Expect the text of #frames matches "^[1-9]"
Reload the page
Expect #now has text "11:00:00"
Set variable d to today()
Expect \${d} equals "2027-03-15"
`);
    expect(j.ledger.d).toBe('2027-03-15');
    const clockEvidence = flattenStepResults(j.steps).filter((s) => s.result.intent.startsWith('Run the clock'));
    expect(clockEvidence[0].result.evidence.length).toBe(1);
  });

  it('freeze keeps Date fixed while timers run; run all timers; real clock', async () => {
    await expectPasses(server.url, `Journey: Frozen
Freeze the clock at 2030-05-01T12:00:00Z
Open /lab/clock
Expect #date has text "2030-05-01"
Click the "Start session" button
Run timers to the last one
Expect the page contains "Session expired"
Use the real clock
Reload the page
Expect #date does not contain "2030-05-01"
`);
  });

  it('run all timers stops on a never-ending interval with a clear message', async () => {
    const { j } = await runEz(server.url, `Journey: Endless
Pause the clock at 2027-01-01 08:00
Open /lab/clock
Run all timers
`);
    expect(j.status).toBe('failed');
    expect(describeSteps(j)).toMatch(/stopped after 10000 timers/);
  });

  it('a bad time fails the step with a clear message', async () => {
    const { j } = await runEz(server.url, `Journey: Bad clock
Set variable t to "next tuesday"
Set the clock to \${t}
`);
    expect(j.status).toBe('failed');
    expect(describeSteps(j)).toMatch(/Cannot read the clock time "next tuesday"/);
  });
});

describe('driver API', () => {
  it('contextClock controls every page and frame of a context', async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ timezoneId: 'UTC' });
      const clock = contextClock(context);
      await clock.pauseAt(Date.UTC(2027, 0, 1, 0, 0, 0));
      const page = await context.newPage();
      await page.goto(`${server.url}/lab/clock`);
      expect(await page.locator('#date').textContent()).toBe('2027-01-01');
      expect(await page.evaluate('Date.now()')).toBe(Date.UTC(2027, 0, 1));
      await clock.fastForward(60_000);
      expect(await page.evaluate('Date.now()')).toBe(Date.UTC(2027, 0, 1, 0, 1));
      const second = await context.newPage();
      await second.goto(`${server.url}/lab/clock`);
      expect(await second.evaluate('Date.now()')).toBe(Date.UTC(2027, 0, 1, 0, 1));
      expect(await second.evaluate('new Date() instanceof Date && typeof Date.UTC === "function"')).toBe(true);
      await clock.resume();
      await new Promise((r) => setTimeout(r, 300));
      const flowing = (await page.evaluate('Date.now()')) as number;
      expect(flowing).toBeGreaterThan(Date.UTC(2027, 0, 1, 0, 1));
      expect(flowing).toBeLessThan(Date.UTC(2027, 0, 1, 0, 1, 5));
      expect(clock.history.map((h) => h.op)).toEqual(['install', 'pauseAt', 'fastForward', 'resume']);
    } finally {
      await browser.close();
    }
  });
});
