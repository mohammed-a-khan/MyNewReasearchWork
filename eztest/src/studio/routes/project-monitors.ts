/**
 * Project › Monitors: journeys tagged @monitor, their schedule and safety
 * (write steps), the persisted monitor state (health, uptime, p50/p95), a
 * per-run history for uptime and latency charts, the status page, and a
 * monitor loop started and stopped from the Studio (same engine as the CLI's
 * `eztest monitor`, same state file).
 */
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { filterJourneys, loadJourneys } from '../../cli/journeys.js';
import { createEngine } from '../../engine/index.js';
import { findWriteSteps, loadMonitorState, renderStatusPage, runMonitor, summarizeMonitorState } from '../../monitor/index.js';
import type { StudioApp } from '../app.js';
import { HttpError, sendJson, sendText } from '../http.js';
import type { StudioRoute } from './route.js';

interface Loop {
  abort: AbortController;
  startedAt: string;
  intervalMs: number;
  iterations?: number;
  ticks: number;
  runs: number;
  lastEvent?: string;
  lastError?: string;
  done?: Promise<void>;
  journeys: string[];
}

const loops = new WeakMap<StudioApp, Loop>();

function files(app: StudioApp): { state: string; history: string } {
  return { state: resolve(app.cwd, '.eztest', 'monitor-state.json'), history: resolve(app.cwd, '.eztest', 'monitor-history.jsonl') };
}

async function monitorJourneys(app: StudioApp) {
  const cfg = (await app.config()).config;
  const { journeys, errors } = await loadJourneys([cfg.journeysDir], app.cwd);
  return { journeys: filterJourneys(journeys, { tags: ['monitor', 'monitor-safe'] }), errors };
}

async function readHistory(path: string, limit = 2000): Promise<Array<{ at: string; journeyId: string; status: string; durationMs: number; runId?: string }>> {
  if (!existsSync(path)) return [];
  const lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim());
  const out = [];
  for (const l of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(l));
    } catch {
      // skip a torn line
    }
  }
  return out;
}

function loopView(l: Loop | undefined) {
  if (!l) return { running: false };
  return { running: !l.abort.signal.aborted, startedAt: l.startedAt, intervalMs: l.intervalMs, iterations: l.iterations, ticks: l.ticks, runs: l.runs, lastEvent: l.lastEvent, lastError: l.lastError, journeys: l.journeys };
}

export const monitorRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/project/monitors',
    summary: '@monitor journeys, monitor state (health, uptime, latency), history and loop status',
    async handler({ res, app }) {
      const f = files(app);
      let list: Array<Record<string, unknown>> = [];
      let error: string | undefined;
      try {
        const { journeys } = await monitorJourneys(app);
        list = journeys.map((j) => ({ id: j.id, name: j.name, tags: j.tags, steps: j.steps.length, writes: findWriteSteps(j).map((w) => ({ stepId: w.stepId, reason: w.reason })) }));
      } catch (e) {
        error = (e as Error).message;
      }
      const state = existsSync(f.state) ? await loadMonitorState(f.state, new Date().toISOString()) : undefined;
      const history = await readHistory(f.history);
      sendJson(res, 200, {
        journeys: list,
        error,
        summary: state ? summarizeMonitorState(state) : undefined,
        durations: state ? Object.fromEntries(Object.values(state.journeys).map((j) => [j.journeyId, j.durations])) : {},
        history,
        loop: loopView(loops.get(app)),
        stateFile: '.eztest/monitor-state.json',
      });
    },
  },
  {
    method: 'POST',
    path: '/api/project/monitors/start',
    summary: 'Start the monitor loop for @monitor journeys',
    async handler({ res, app, body }) {
      const cur = loops.get(app);
      if (cur && !cur.abort.signal.aborted) throw new HttpError(409, 'The monitor loop is already running');
      const intervalSec = Number(body.intervalSec ?? 300);
      if (!Number.isFinite(intervalSec) || intervalSec < 5 || intervalSec > 86_400) throw new HttpError(400, 'The interval must be between 5 seconds and 24 hours');
      const iterations = body.iterations === undefined || body.iterations === null || body.iterations === '' ? undefined : Number(body.iterations);
      if (iterations !== undefined && (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000)) throw new HttpError(400, 'Iterations must be a whole number from 1');
      const allowWrites = body.allowWrites === true;
      const { journeys } = await monitorJourneys(app);
      if (!journeys.length) throw new HttpError(400, 'No journeys are tagged @monitor. Monitors only run journeys explicitly marked safe for production.');
      const unsafe = journeys.flatMap((j) => findWriteSteps(j).map((w) => `${j.id}/${w.stepId}: ${w.reason}`));
      if (unsafe.length && !allowWrites) throw new HttpError(422, `These monitor journeys write data: ${unsafe.join('; ')}. Allow writes explicitly to run them.`, { unsafe });
      const loaded = await app.config();
      const engine = await createEngine(loaded, { cwd: app.cwd, runOptions: { screenshots: 'on-failure' } });
      const f = files(app);
      await mkdir(dirname(f.state), { recursive: true });
      const loop: Loop = { abort: new AbortController(), startedAt: new Date().toISOString(), intervalMs: intervalSec * 1000, iterations, ticks: 0, runs: 0, journeys: journeys.map((j) => j.id) };
      loops.set(app, loop);
      app.onClose(() => loop.abort.abort());
      loop.done = runMonitor({
        journeys,
        run: (j) => engine.run(j),
        intervalMs: loop.intervalMs,
        iterations,
        signal: loop.abort.signal,
        stateFile: f.state,
        alerts: [],
        allowWrites,
        outputDir: engine.runOptions.outputDir,
        onEvent: (e) => {
          loop.lastEvent = new Date().toISOString();
          if (e.type === 'tick') loop.ticks = e.tick;
          if (e.type === 'run') {
            loop.runs++;
            const lines = e.result.journeys.map((j) => JSON.stringify({ at: new Date().toISOString(), journeyId: j.journeyId, status: j.status, durationMs: j.durationMs, runId: e.result.runId })).join('\n');
            void appendFile(f.history, lines + '\n').catch(() => undefined);
          }
          if (e.type === 'run-error') loop.lastError = loaded.masker.mask(e.error);
          app.hub.publish('monitor', { type: e.type, tick: 'tick' in e ? e.tick : undefined });
        },
      })
        .then(() => undefined)
        .catch((e: Error) => {
          loop.lastError = loaded.masker.mask(e.message);
        })
        .finally(async () => {
          loop.abort.abort();
          await engine.close().catch(() => undefined);
          app.hub.publish('monitor', { type: 'stopped' });
        });
      app.hub.publish('monitor', { type: 'started' });
      sendJson(res, 202, { loop: loopView(loop) });
    },
  },
  {
    method: 'POST',
    path: '/api/project/monitors/stop',
    summary: 'Stop the monitor loop (the current run finishes first)',
    async handler({ res, app }) {
      const l = loops.get(app);
      if (!l || l.abort.signal.aborted) throw new HttpError(409, 'The monitor loop is not running');
      l.abort.abort();
      sendJson(res, 200, { loop: loopView(l) });
    },
  },
  {
    method: ['GET', 'HEAD'],
    path: '/api/project/monitors/status-page',
    summary: 'The monitor status page (self-contained HTML, sandboxed)',
    async handler({ res, app, method }) {
      const f = files(app);
      const state = await loadMonitorState(f.state, new Date().toISOString());
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'");
      sendText(res, 200, 'text/html; charset=utf-8', renderStatusPage(state, { title: 'EZTest monitors' }), method === 'HEAD');
    },
  },
];

