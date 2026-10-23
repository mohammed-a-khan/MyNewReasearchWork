/**
 * The browser clock: EZTest's own fake time for a browser context.
 *
 * An init script (written here, applied to every document of the context
 * before its own scripts) replaces `Date`, `setTimeout` / `setInterval` (and
 * their clear functions), `requestAnimationFrame` / `cancelAnimationFrame`,
 * `requestIdleCallback` and `performance.now()` with a clock EZTest controls:
 *
 * - `install(time)` / `setSystemTime(time)`: the clock shows `time` and keeps
 *   flowing at real speed; timers fire when their fake time comes.
 * - `setFixedTime(time)`: `Date` always says `time`; timers keep running.
 * - `pauseAt(time)` / `pause()`: time stands still until advanced or resumed.
 * - `fastForward(ms)`: jump ahead, firing every due timer at most once
 *   (an interval fires once, then is rescheduled from the new time).
 * - `runFor(ms)`: advance, firing every timer in order, intervals repeatedly.
 * - `runAll()` / `runToLast()`: fire timers until none are left / up to the
 *   last one scheduled now.
 * - `useRealTime()`: back to the real time, flowing.
 *
 * Node keeps the clock's state and replays it into every new document (a new
 * page, a navigation, an iframe), so time continues across navigations. All
 * frames of all pages follow every change. The script is EZTest's own code
 * with the state passed as JSON numbers; nothing from a journey is evaluated.
 */
import type { CrBrowserContext } from './chromium/browser.js';

/** Clock state replayed into new documents. */
interface ClockState {
  /** Fake epoch ms at `realAt`. */
  fakeAt: number;
  /** Real epoch ms when `fakeAt` was taken. */
  realAt: number;
  paused: boolean;
  /** setFixedTime: what Date says, whatever the timers do. */
  fixed?: number;
}

/**
 * Page-side clock (main world). Plain JavaScript in a string so no build
 * helper leaks into the page. Installs once per document; `__sync` sets the
 * state; the controller methods mirror BrowserClock.
 */
const PAGE_CLOCK = String.raw`(function () {
  var g = globalThis;
  if (g.__eztestClock) return;
  var NativeDate = Date, nSetTimeout = g.setTimeout.bind(g), nClearTimeout = g.clearTimeout.bind(g);
  var nRaf = g.requestAnimationFrame ? g.requestAnimationFrame.bind(g) : function (f) { return nSetTimeout(function () { f(0); }, 16); };
  var nCaf = g.cancelAnimationFrame ? g.cancelAnimationFrame.bind(g) : nClearTimeout;
  var nSetInterval = g.setInterval.bind(g), nClearInterval = g.clearInterval.bind(g);
  var perf = g.performance, nPerfNow = perf && perf.now ? perf.now.bind(perf) : function () { return NativeDate.now(); };
  var realNow = function () { return NativeDate.now(); };
  var now = realNow(), paused = false, fixed = null, lastReal = realNow();
  var perfBaseReal = nPerfNow(), perfBaseFake = now;
  var timers = new Map(), nextId = 1, firing = false;
  function schedule(kind, fn, delay, args, interval) {
    var id = nextId++;
    var d = Math.max(0, Number(delay) || 0);
    timers.set(id, { id: id, kind: kind, fn: fn, args: args || [], at: now + (kind === 'raf' ? 16 : d), interval: interval ? Math.max(1, d) : 0 });
    return id;
  }
  // Animation frames requested while a run is firing wait for the next run (one frame per run, not one per 16 ms of a 2-hour jump).
  var rafFloor = Infinity;
  function earliest(limit) {
    var best = null;
    timers.forEach(function (t) { if (t.at <= limit && !(t.kind === 'raf' && t.id >= rafFloor) && (!best || t.at < best.at || (t.at === best.at && t.id < best.id))) best = t; });
    return best;
  }
  function call(t) {
    if (t.interval) t.at = Math.max(t.at + t.interval, now + 1); else timers.delete(t.id);
    try {
      if (t.kind === 'raf') t.fn(perfNow());
      else if (t.kind === 'idle') t.fn({ didTimeout: false, timeRemaining: function () { return 50; } });
      else if (typeof t.fn === 'function') t.fn.apply(g, t.args);
    } catch (e) { nSetTimeout(function () { throw e; }, 0); }
  }
  /** Fire timers in order until 'to' (each interval as often as it falls due), then set the time to 'to'. */
  function runTo(to, max) {
    if (firing) { now = Math.max(now, to); return 0; }
    firing = true;
    rafFloor = nextId;
    var n = 0;
    try {
      for (var t = earliest(to); t && n < (max || 100000); t = earliest(to)) { now = Math.max(now, t.at); call(t); n++; }
    } finally { firing = false; rafFloor = Infinity; }
    now = Math.max(now, to);
    return n;
  }
  /** Jump to 'to', firing each timer due by then once. */
  function jumpTo(to) {
    var due = [];
    timers.forEach(function (t) { if (t.at <= to) due.push(t); });
    due.sort(function (a, b) { return a.at - b.at || a.id - b.id; });
    now = Math.max(now, to);
    for (var i = 0; i < due.length; i++) { if (timers.has(due[i].id)) { if (due[i].interval) due[i].at = now; call(due[i]); } }
    return due.length;
  }
  function perfNow() { return perfBaseReal + (now - perfBaseFake); }
  function dateNow() { return fixed !== null ? fixed : Math.floor(now); }
  // Real time drives a flowing clock.
  function pump() {
    var r = realNow(), d = r - lastReal;
    lastReal = r;
    if (!paused && d > 0) runTo(now + d);
    nSetTimeout(pump, 16);
  }
  function ClockDate(a, b, c, d, e, f, h) {
    var n = arguments.length;
    if (!(this instanceof ClockDate)) return new NativeDate(dateNow()).toString();
    if (n === 0) return new NativeDate(dateNow());
    if (n === 1) return new NativeDate(a);
    return new NativeDate(a, b, n > 2 ? c : 1, n > 3 ? d : 0, n > 4 ? e : 0, n > 5 ? f : 0, n > 6 ? h : 0);
  }
  ClockDate.prototype = NativeDate.prototype;
  ClockDate.now = function () { return dateNow(); };
  ClockDate.UTC = NativeDate.UTC;
  ClockDate.parse = NativeDate.parse;
  Object.defineProperty(ClockDate, 'name', { value: 'Date' });
  ClockDate.toString = function () { return NativeDate.toString(); };
  g.Date = ClockDate;
  g.setTimeout = function (fn, delay) { return schedule('timeout', fn, delay, Array.prototype.slice.call(arguments, 2), false); };
  g.setInterval = function (fn, delay) { return schedule('interval', fn, delay, Array.prototype.slice.call(arguments, 2), true); };
  g.clearTimeout = g.clearInterval = function (id) { timers.delete(Number(id)); };
  g.requestAnimationFrame = function (fn) { return schedule('raf', fn, 16, [], false); };
  g.cancelAnimationFrame = function (id) { timers.delete(Number(id)); };
  if (g.requestIdleCallback) {
    g.requestIdleCallback = function (fn, o) { return schedule('idle', fn, o && o.timeout ? Math.min(o.timeout, 1) : 1, [], false); };
    g.cancelIdleCallback = function (id) { timers.delete(Number(id)); };
  }
  if (perf) { try { Object.defineProperty(perf, 'now', { value: perfNow, configurable: true, writable: true }); } catch (e) { /* frozen */ } }
  var api = {
    __sync: function (s) {
      var r = realNow();
      now = s.paused ? s.fakeAt : s.fakeAt + (r - s.realAt);
      perfBaseFake = now; perfBaseReal = nPerfNow();
      paused = !!s.paused; fixed = typeof s.fixed === 'number' ? s.fixed : null; lastReal = r;
    },
    now: function () { return now; },
    dateNow: dateNow,
    setSystemTime: function (t) { var delta = t - now; timers.forEach(function (x) { x.at += delta; }); now = t; perfBaseFake += delta; fixed = null; return now; },
    setFixedTime: function (t) { fixed = t; paused = false; return now; },
    pause: function () { paused = true; return now; },
    pauseAt: function (t) { if (t > now) jumpTo(t); else now = t; paused = true; fixed = null; return now; },
    resume: function () { paused = false; lastReal = realNow(); return now; },
    fastForward: function (ms) { jumpTo(now + ms); return now; },
    runFor: function (ms) { runTo(now + ms); return now; },
    runAll: function () {
      for (var i = 0; i < 10000; i++) { var t = earliest(Infinity); if (!t) return now; runTo(t.at, 1); }
      return { error: 'Run all timers stopped after 10000 timers: an interval or a timer chain keeps scheduling more (use "Run timers to the last one" or "Run the clock for ...")' };
    },
    runToLast: function () { var last = -Infinity; timers.forEach(function (t) { if (t.at > last) last = t.at; }); if (last > now) runTo(last); return now; },
    pending: function () { return timers.size; },
    /** The real timers, for EZTest's own in-page helpers (actionability probes, waits): they must not stop with the page clock. */
    native: Object.freeze({ setTimeout: nSetTimeout, clearTimeout: nClearTimeout, setInterval: nSetInterval, clearInterval: nClearInterval, requestAnimationFrame: nRaf, cancelAnimationFrame: nCaf, Date: NativeDate, performanceNow: nPerfNow }),
  };
  Object.defineProperty(g, '__eztestClock', { value: Object.freeze(api), enumerable: false, configurable: false, writable: false });
  nSetTimeout(pump, 16);
})();`;

/** What one clock call does in the page. */
type PageOp =
  | { op: 'setSystemTime' | 'setFixedTime' | 'pauseAt'; time: number }
  | { op: 'fastForward' | 'runFor'; ms: number }
  | { op: 'pause' | 'resume' | 'runAll' | 'runToLast' };

/** A parsed time: epoch ms, a Date, an ISO / "YYYY-MM-DD HH:mm[:ss]" string (optionally with a zone), or "now". */
export type ClockTime = number | Date | string;

/** Options of {@link parseClockTime}. */
export interface ClockTimeOptions {
  /** IANA zone for times written without an offset (default: the browser's zone, i.e. the machine's or the emulated one). */
  timeZone?: string;
  /** "now" (and an empty string) means this. Default: the real time. */
  now?: number;
}

function zoneOffsetMs(epoch: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(epoch));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return wall - Math.floor(epoch / 1000) * 1000;
}

/** Epoch ms of a wall-clock time in a zone. */
function zonedEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, timeZone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  let t = guess - zoneOffsetMs(guess, timeZone);
  t = guess - zoneOffsetMs(t, timeZone);
  return t;
}

/**
 * Parse a clock time: `2027-03-15 09:00`, `2026-12-31T23:59:50`, `2026-12-31 23:59 Europe/London`,
 * `2026-12-31T23:59:00Z`, `2026-12-31T23:59:00+01:00`, `2027-03-15` (midnight), epoch ms, or `now`.
 */
export function parseClockTime(v: ClockTime, o: ClockTimeOptions = {}): number {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`Invalid clock time ${v}`);
    return v;
  }
  if (v instanceof Date) return v.getTime();
  const s = v.trim();
  if (!s || /^now$/i.test(s)) return o.now ?? Date.now();
  if (/^\d{10,}$/.test(s)) return Number(s);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?\s*(Z|[+-]\d{2}:?\d{2}|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+|UTC|GMT)?$/i.exec(s);
  if (!m) throw new Error(`Cannot read the clock time "${v}" (use e.g. 2027-03-15 09:00, 2026-12-31T23:59:50Z or 2026-12-31 23:59 Europe/London)`);
  const [y, mo, d, h, mi, sec, msec] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0', m[6] ?? '0', (m[7] ?? '0').padEnd(3, '0')].map(Number);
  const zone = m[8];
  if (zone && /^(?:Z|UTC|GMT)$/i.test(zone)) return Date.UTC(y, mo - 1, d, h, mi, sec, msec);
  if (zone && /^[+-]/.test(zone)) {
    const z = /^([+-])(\d{2}):?(\d{2})$/.exec(zone)!;
    const off = (Number(z[2]) * 60 + Number(z[3])) * 60_000 * (z[1] === '-' ? -1 : 1);
    return Date.UTC(y, mo - 1, d, h, mi, sec, msec) - off;
  }
  const tz = zone ?? o.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    return zonedEpoch(y, mo, d, h, mi, sec, msec, tz);
  } catch {
    throw new Error(`Unknown time zone "${tz}" in clock time "${v}"`);
  }
}

/** Parse "2 hours", "15 seconds", "1h30m", "90 min", "1 day", "01:30:00", "500ms" into ms. */
export function parseClockDuration(v: number | string): number {
  if (typeof v === 'number') return v;
  const s = v.trim().toLowerCase();
  const hms = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (hms) return ((Number(hms[1]) * 60 + Number(hms[2])) * 60 + Number(hms[3] ?? 0)) * 1000;
  const unit: Record<string, number> = {
    ms: 1, millisecond: 1, milliseconds: 1, millis: 1, s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
    m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000, h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
    d: 86_400_000, day: 86_400_000, days: 86_400_000, w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
  };
  let total = 0;
  let rest = s.replace(/\band\b|,/g, ' ');
  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let any = false;
  for (const mm of rest.matchAll(re)) {
    const u = unit[mm[2]];
    if (u === undefined) throw new Error(`Unknown time unit "${mm[2]}" in "${v}"`);
    total += Number(mm[1]) * u;
    any = true;
  }
  rest = rest.replace(re, '').trim();
  if (!any || rest) throw new Error(`Cannot read the duration "${v}" (use e.g. 2 hours, 15 seconds, 1h30m or 01:30:00)`);
  return Math.round(total);
}

/** The controllable clock of one browser context (see the module comment). Get it with {@link contextClock}. */
export class BrowserClock {
  private state?: ClockState;
  private installing?: Promise<void>;
  /** Changes applied so far, for evidence and traces (`{ at, op, time? }`). */
  readonly history: Array<{ at: string; op: string; fakeTime: string }> = [];

  constructor(private readonly context: CrBrowserContext) {}

  /** True once the fake clock is installed. */
  get installed(): boolean {
    return !!this.state;
  }

  /** The fake time now (epoch ms), from the Node side's copy of the state; undefined before install. */
  now(): number | undefined {
    const s = this.state;
    if (!s) return undefined;
    return s.paused ? s.fakeAt : s.fakeAt + (Date.now() - s.realAt);
  }

  /** What Date says in the pages now (the fixed time when one is set). */
  dateNow(): number | undefined {
    return this.state?.fixed ?? this.now();
  }

  /** Install the fake clock (idempotent); the clock starts at `time` (default: now) and flows. */
  async install(time?: number): Promise<void> {
    if (!this.state) {
      this.state = { fakeAt: time ?? Date.now(), realAt: Date.now(), paused: false };
      this.installing = (async () => {
        await this.context.addInitScript(PAGE_CLOCK);
        await this.everyFrame(PAGE_CLOCK);
      })();
      await this.installing;
      await this.syncAll();
      this.record('install');
      return;
    }
    await this.installing;
    if (time !== undefined) await this.setSystemTime(time);
  }

  /** Change the time without firing timers (time keeps flowing from there). */
  setSystemTime(time: number): Promise<void> {
    return this.apply({ op: 'setSystemTime', time }, (s) => ({ ...s, fakeAt: time, realAt: Date.now(), fixed: undefined }));
  }

  /** Date always says `time`; timers keep running. */
  setFixedTime(time: number): Promise<void> {
    return this.apply({ op: 'setFixedTime', time }, (s) => ({ ...s, fixed: time, paused: false }));
  }

  /** Stop time. */
  pause(): Promise<void> {
    return this.apply({ op: 'pause' }, (s) => ({ ...s, fakeAt: this.now()!, realAt: Date.now(), paused: true }));
  }

  /** Jump to `time` (firing due timers once) and stop there. */
  pauseAt(time: number): Promise<void> {
    return this.apply({ op: 'pauseAt', time }, (s) => ({ ...s, fakeAt: time, realAt: Date.now(), paused: true, fixed: undefined }));
  }

  /** Let paused time flow again. */
  resume(): Promise<void> {
    return this.apply({ op: 'resume' }, (s) => ({ ...s, fakeAt: this.now()!, realAt: Date.now(), paused: false }));
  }

  /** Jump ahead `ms`, firing every due timer at most once. */
  fastForward(ms: number): Promise<void> {
    if (!(ms >= 0)) throw new Error(`Cannot move the clock back (${ms} ms); set the clock to an earlier time instead`);
    return this.apply({ op: 'fastForward', ms }, (s) => ({ ...s, fakeAt: this.now()! + ms, realAt: Date.now() }));
  }

  /** Advance `ms`, firing every timer in order (intervals repeatedly). */
  runFor(ms: number): Promise<void> {
    if (!(ms >= 0)) throw new Error(`Cannot run the clock backwards (${ms} ms)`);
    return this.apply({ op: 'runFor', ms }, (s) => ({ ...s, fakeAt: this.now()! + ms, realAt: Date.now() }));
  }

  /** Fire every pending timer (and the ones they schedule), up to 1000 rounds. */
  runAll(): Promise<void> {
    return this.apply({ op: 'runAll' }, (s) => s, true);
  }

  /** Fire timers up to the last one scheduled now. */
  runToLast(): Promise<void> {
    return this.apply({ op: 'runToLast' }, (s) => s, true);
  }

  /** Back to the real time (flowing); the fake timers keep working. */
  async useRealTime(): Promise<void> {
    if (!this.state) return;
    await this.setSystemTime(Date.now());
    if (this.state.paused) await this.resume();
  }

  private async apply(op: PageOp, next: (s: ClockState) => ClockState, readBack = false): Promise<void> {
    if (!this.state) await this.install();
    await this.installing;
    this.state = next(this.state!);
    const call = `globalThis.__eztestClock && globalThis.__eztestClock.${op.op}(${'time' in op ? op.time : 'ms' in op ? op.ms : ''})`;
    const results = await this.everyFrame(call);
    const err = results.find((r): r is { error: string } => !!r && typeof r === 'object' && typeof (r as { error?: unknown }).error === 'string');
    if (err) throw new Error(err.error);
    // Timers may have advanced the page clock (runAll): take the page's time as the truth.
    const pageNow = results.find((r): r is number => typeof r === 'number');
    if (readBack && pageNow !== undefined) this.state = { ...this.state!, fakeAt: pageNow, realAt: Date.now() };
    await this.context.addInitScript(`${PAGE_CLOCK}\nglobalThis.__eztestClock.__sync(${JSON.stringify(this.state)});`);
    this.record(op.op);
  }

  private async syncAll(): Promise<void> {
    const sync = `globalThis.__eztestClock && globalThis.__eztestClock.__sync(${JSON.stringify(this.state)})`;
    await this.everyFrame(sync);
    await this.context.addInitScript(`${PAGE_CLOCK}\nglobalThis.__eztestClock.__sync(${JSON.stringify(this.state)});`);
  }

  private record(op: string): void {
    const t = this.dateNow();
    this.history.push({ at: new Date().toISOString(), op, fakeTime: t === undefined ? '' : new Date(t).toISOString() });
  }

  /** Evaluate in the main world of every frame of every open page; frames that are gone are skipped. */
  private async everyFrame(source: string): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const page of this.context.pages()) {
      for (const frame of page.frames()) {
        try {
          out.push(await frame.evaluate(source));
        } catch {
          // detached or navigating: the init script covers the next document
        }
      }
    }
    return out;
  }
}

const CLOCKS = new WeakMap<object, BrowserClock>();

/** The clock of a browser context (one per context, created on first use; nothing is installed until a call). */
export function contextClock(context: CrBrowserContext): BrowserClock {
  let c = CLOCKS.get(context);
  if (!c) CLOCKS.set(context, (c = new BrowserClock(context)));
  return c;
}

/** The context's clock when it was installed, else undefined. */
export function installedClock(context: CrBrowserContext): BrowserClock | undefined {
  const c = CLOCKS.get(context);
  return c?.installed ? c : undefined;
}
