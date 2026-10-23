/**
 * The Performance workspace (EZTest Load): scenario files (list, read,
 * validate with curve previews, save), the correlation assistant (from a
 * run's captured traffic or a HAR upload, with framework packs, project
 * rules and exclusions; one-VU replay check), run control (start, stop,
 * abort, add VUs, scale) with live snapshots on the `load` hub topic, and
 * results (list, details, comparison, trend).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import type { StudioApp } from '../app.js';
import { HttpError, sendJson } from '../http.js';
import { confinePath, relPosix } from '../security.js';
import { masker, loadRun } from './assurance-shared.js';
import type { StudioRoute } from './route.js';
import { normalizeNetworkLog, type NetworkEntry } from '../../perf/network.js';
import {
  appendHistory, compareRuns, CorrelationRuleSpec, FRAMEWORKS, generateUserPath, LoadTest, parseScenario, profileCurve, readHistory, readLoadResults, trend, writeLoadRun,
  type LoadResults, type LiveSnapshot, type Scenario,
} from '../../load/index.js';
import { checkScenario, runNetwork } from '../../load/cli.js';

const RULES_FILE = 'load/correlation-rules.yaml';
const HISTORY = '.eztest/load-history.json';

interface Active {
  test: LoadTest;
  path: string;
  startedAt: string;
  done: Promise<LoadResults | undefined>;
  error?: string;
}

const active = new WeakMap<StudioApp, Active>();
const lastDone = new WeakMap<StudioApp, { runId: string; verdict: string; error?: string }>();

async function listScenarioFiles(app: StudioApp): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 4 || !existsSync(dir)) return;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (/\.(ya?ml|json)$/i.test(e.name) && !/correlation-rules/.test(e.name)) out.push(relPosix(app.cwd, p));
    }
  };
  await walk(join(app.cwd, 'load'), 0);
  for (const e of existsSync(app.cwd) ? await readdir(app.cwd) : []) if (/\.load\.ya?ml$/i.test(e)) out.push(e);
  return out.sort();
}

function scenarioPath(app: StudioApp, p: unknown): string {
  if (typeof p !== 'string' || !/\.(ya?ml|json)$/i.test(p)) throw new HttpError(400, 'A scenario path ending in .yaml, .yml or .json is required');
  return confinePath(app.cwd, p);
}

function parseDoc(text: string, ext: string): unknown {
  return ext === '.json' ? JSON.parse(text) : parseYaml(text);
}

/** Summary of a scenario: populations, curves (sampled), SLAs, user path outlines. */
function describe(s: Scenario) {
  const total = s.populations.reduce((a, p) => a + p.share, 0);
  const outline = (actions: Scenario['userPaths'][string]['actions']): unknown[] =>
    actions.map((a) => {
      if (a.kind === 'transaction') return { kind: 'transaction', name: a.name, children: outline(a.actions) };
      if (a.kind === 'request') return { kind: 'request', name: a.spec.name ?? `${a.spec.method} ${a.spec.url}`, extract: (a.spec.extract ?? []).map((e) => e.var) };
      if (a.kind === 'think') return { kind: 'think', name: typeof a.time === 'number' ? `${a.time} ms` : JSON.stringify(a.time) };
      if (a.kind === 'browser') return { kind: 'browser', name: a.spec.name ?? Object.keys(a.spec).join(' ') };
      if (a.kind === 'if' || a.kind === 'loop') return { kind: a.kind, name: a.kind === 'if' ? a.cond : `${a.times ?? a.while}`, children: outline(a.kind === 'if' ? [...a.then, ...a.else] : a.actions) };
      return { kind: a.kind, name: 'spec' in a ? ((a.spec as { name?: string }).name ?? a.kind) : a.kind };
    });
  return {
    name: s.name, model: s.model, baseUrl: s.baseUrl,
    populations: s.populations.map((p) => {
      const c = profileCurve(p.profile ?? s.profile!, s.model).scale(p.share / total);
      return { ...p, percent: Math.round((p.share / total) * 1000) / 10, peak: Math.round(c.peak * 100) / 100, durationMs: c.durationMs, curve: c.sample(80), browser: p.browser ?? s.userPaths[p.userPath].browser };
    }),
    total: (() => {
      const curves = s.populations.map((p) => profileCurve(p.profile ?? s.profile!, s.model).scale(p.share / total));
      const d = Math.max(...curves.map((c) => c.durationMs));
      return Array.from({ length: 81 }, (_, i) => ({ at: Math.round((d * i) / 80), value: Math.round(curves.reduce((a, c) => a + c.at((d * i) / 80), 0) * 100) / 100 }));
    })(),
    userPaths: Object.values(s.userPaths).map((p) => ({ name: p.name, browser: p.browser, source: p.source, data: p.data, init: p.init.length, actions: outline(p.actions) })),
    sla: s.sla, monitors: s.monitors.map((m) => ({ type: m.type, name: m.name })), data: Object.keys(s.data),
  };
}

async function readRules(app: StudioApp): Promise<CorrelationRuleSpec[]> {
  const f = join(app.cwd, RULES_FILE);
  if (!existsSync(f)) return [];
  const raw = parseYaml(await readFile(f, 'utf8')) as { rules?: unknown[] } | null;
  return (raw?.rules ?? []).map((r) => CorrelationRuleSpec.parse(r));
}

async function loadRuns(app: StudioApp): Promise<Array<{ runId: string; scenario: string; startedAt: string; durationMs: number; verdict: string; requests: number; rps: number; errorRate: number; p95: number; maxVus: number; agents: number }>> {
  const out = await app.outputDir();
  if (!existsSync(out)) return [];
  const list = [];
  for (const d of await readdir(out)) {
    const f = join(out, d, 'load-results.json');
    if (!existsSync(f)) continue;
    try {
      const r = JSON.parse(await readFile(f, 'utf8')) as LoadResults;
      list.push({ runId: r.runId, scenario: r.scenario.name, startedAt: r.startedAt, durationMs: r.durationMs, verdict: r.verdict, requests: r.totals.requests, rps: Math.round(r.totals.rps * 10) / 10, errorRate: r.totals.errorRate, p95: r.totals.latency.p95, maxVus: r.totals.maxVus, agents: r.agents.length });
    } catch {
      // not readable
    }
  }
  return list.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

async function loadRunResults(app: StudioApp, runId: string): Promise<LoadResults> {
  if (!/^[\w.-]+$/.test(runId)) throw new HttpError(400, 'invalid run id');
  const dir = join(await app.outputDir(), runId);
  if (!existsSync(join(dir, 'load-results.json'))) throw new HttpError(404, `no load run ${runId}`);
  return readLoadResults(dir);
}

function snapshotOf(app: StudioApp): (LiveSnapshot & { path: string; startedAt: string; error?: string }) | null {
  const a = active.get(app);
  if (!a) return null;
  return { ...a.test.snapshot(), path: a.path, startedAt: a.startedAt, error: a.error };
}

export const loadRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/load/scenarios',
    summary: 'Load scenario files of the project (load/**/*.yaml, *.load.yaml) with a summary each',
    async handler({ res, app }) {
      const files = await listScenarioFiles(app);
      const out = [];
      for (const f of files) {
        try {
          const abs = confinePath(app.cwd, f);
          const s = parseScenario(parseDoc(await readFile(abs, 'utf8'), extname(f).toLowerCase()), dirname(abs));
          out.push({ path: f, name: s.name, model: s.model, populations: s.populations.length, userPaths: Object.keys(s.userPaths).length, sla: s.sla.length });
        } catch (e) {
          out.push({ path: f, error: (e as Error).message.slice(0, 300) });
        }
      }
      sendJson(res, 200, { scenarios: out, frameworks: FRAMEWORKS });
    },
  },
  {
    method: 'GET',
    path: '/api/load/scenario',
    summary: 'A scenario file: its document, validation and curve previews',
    async handler({ res, app, query }) {
      const abs = scenarioPath(app, query.get('path'));
      if (!existsSync(abs)) throw new HttpError(404, 'no such scenario');
      const text = await readFile(abs, 'utf8');
      const doc = parseDoc(text, extname(abs).toLowerCase());
      try {
        const s = parseScenario(doc, dirname(abs));
        sendJson(res, 200, { path: relPosix(app.cwd, abs), doc, text, valid: true, summary: describe(s) });
      } catch (e) {
        sendJson(res, 200, { path: relPosix(app.cwd, abs), doc, text, valid: false, error: (e as Error).message });
      }
    },
  },
  {
    method: 'POST',
    path: '/api/load/preview',
    summary: 'Validate a scenario document and preview its load curves',
    async handler({ res, app, body }) {
      try {
        const doc = typeof body.text === 'string' ? parseYaml(body.text) : body.doc;
        const s = parseScenario(doc, app.cwd);
        sendJson(res, 200, { valid: true, summary: describe(s) });
      } catch (e) {
        sendJson(res, 200, { valid: false, error: (e as Error).message });
      }
    },
  },
  {
    method: 'PUT',
    path: '/api/load/scenario',
    summary: 'Save a scenario file (validated first)',
    async handler({ res, app, body }) {
      const abs = scenarioPath(app, body.path);
      const doc = typeof body.text === 'string' ? parseYaml(body.text) : body.doc;
      try {
        parseScenario(doc, dirname(abs));
      } catch (e) {
        throw new HttpError(422, (e as Error).message);
      }
      await mkdir(dirname(abs), { recursive: true });
      const text = typeof body.text === 'string' ? body.text : extname(abs).toLowerCase() === '.json' ? JSON.stringify(doc, null, 2) : `# EZTest Load scenario (docs/load.md)\n${toYaml(doc, { lineWidth: 0 })}`;
      await writeFile(abs, text);
      sendJson(res, 200, { saved: relPosix(app.cwd, abs) });
    },
  },
  {
    method: 'GET',
    path: '/api/load/rules',
    summary: 'Project correlation rules (the rule editor) and the framework packs',
    async handler({ res, app }) {
      sendJson(res, 200, { file: RULES_FILE, rules: await readRules(app), frameworks: FRAMEWORKS });
    },
  },
  {
    method: 'PUT',
    path: '/api/load/rules',
    summary: 'Save the project correlation rules',
    async handler({ res, app, body }) {
      const list = Array.isArray(body.rules) ? body.rules : [];
      let rules: CorrelationRuleSpec[];
      try {
        rules = list.map((r) => CorrelationRuleSpec.parse(r));
        for (const r of rules) {
          if (!r.regex && !r.json && !r.boundary && r.from !== 'header' && r.from !== 'cookie') throw new Error(`rule "${r.name}" needs regex, json or boundary`);
          if (r.regex) new RegExp(r.regex);
        }
      } catch (e) {
        throw new HttpError(422, (e as Error).message);
      }
      const f = join(app.cwd, RULES_FILE);
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, `# EZTest Load correlation rules (docs/load.md#correlation)\n${toYaml({ rules }, { lineWidth: 0 })}`);
      sendJson(res, 200, { saved: RULES_FILE, rules });
    },
  },
  {
    method: 'POST',
    path: '/api/load/correlate',
    summary: 'Correlation assistant: generate a correlated user path from a run\'s traffic or a HAR',
    async handler({ res, app, body }) {
      let entries: NetworkEntry[];
      if (typeof body.runId === 'string' && body.runId) {
        const run = await loadRun(app, body.runId);
        entries = await runNetwork(run.dir, typeof body.journeyId === 'string' && body.journeyId ? body.journeyId : undefined);
      } else if (typeof body.har === 'string') {
        try {
          entries = normalizeNetworkLog(JSON.parse(body.har));
        } catch (e) {
          throw new HttpError(422, `not a HAR file: ${(e as Error).message}`);
        }
      } else throw new HttpError(400, 'give runId or har');
      if (!entries.length) throw new HttpError(404, 'no captured traffic to correlate');
      const rules = await readRules(app);
      try {
        const g = generateUserPath(entries, {
          name: typeof body.name === 'string' ? body.name : undefined,
          frameworks: Array.isArray(body.frameworks) ? body.frameworks.map(String) : undefined,
          rules,
          exclude: Array.isArray(body.exclude) ? body.exclude.map(String) : undefined,
          parameters: body.parameters && typeof body.parameters === 'object' ? (body.parameters as Record<string, string>) : undefined,
          includeStatic: body.includeStatic === true,
        });
        const m = await masker(app);
        sendJson(res, 200, m.maskDeep({ ...g, rules: rules.length }));
      } catch (e) {
        throw new HttpError(422, (e as Error).message);
      }
    },
  },
  {
    method: 'POST',
    path: '/api/load/check',
    summary: 'One virtual user, one iteration per user path: every request with its outcome',
    async handler({ res, app, body }) {
      const abs = scenarioPath(app, body.path);
      const s = parseScenario(parseDoc(await readFile(abs, 'utf8'), extname(abs).toLowerCase()), dirname(abs));
      sendJson(res, 200, (await masker(app)).maskDeep({ paths: await checkScenario(s) }));
    },
  },
  {
    method: 'POST',
    path: '/api/load/runs',
    summary: 'Start a load test of a scenario (one at a time); live snapshots on the "load" event topic',
    async handler({ res, app, body }) {
      const cur = active.get(app);
      if (cur && cur.test.snapshot().state !== 'done' && cur.test.snapshot().state !== 'failed') throw new HttpError(409, 'a load test is already running');
      const abs = scenarioPath(app, body.path);
      let s: Scenario;
      try {
        s = parseScenario(parseDoc(await readFile(abs, 'utf8'), extname(abs).toLowerCase()), dirname(abs));
      } catch (e) {
        throw new HttpError(422, (e as Error).message);
      }
      const durationMs = typeof body.durationMs === 'number' && body.durationMs > 0 ? body.durationMs : undefined;
      const test = new LoadTest(s, { durationMs, monitors: body.monitors !== false });
      const rel = relPosix(app.cwd, abs);
      const entry: Active = { test, path: rel, startedAt: new Date().toISOString(), done: Promise.resolve(undefined) };
      app.hub.registerTopic('load', { replay: 120, description: 'Load test live snapshots' });
      let last = 0;
      test.on('point', (_p, snap: LiveSnapshot) => {
        const now = Date.now();
        if (now - last < 900) return;
        last = now;
        app.hub.publish('load', { type: 'point', snapshot: snap });
      });
      entry.done = test.run().then(
        async (r) => {
          const out = await app.outputDir();
          await writeLoadRun(r, { outputDir: out, scenarioText: await readFile(abs, 'utf8') });
          await appendHistory(join(app.cwd, HISTORY), r);
          lastDone.set(app, { runId: r.runId, verdict: r.verdict });
          app.hub.publish('load', { type: 'done', runId: r.runId, verdict: r.verdict });
          return r;
        },
        (e: Error) => {
          entry.error = e.message;
          lastDone.set(app, { runId: test.runId, verdict: 'error', error: e.message });
          app.hub.publish('load', { type: 'failed', runId: test.runId, error: e.message });
          return undefined;
        },
      );
      active.set(app, entry);
      app.hub.publish('load', { type: 'started', runId: test.runId, path: rel });
      sendJson(res, 202, { runId: test.runId, path: rel });
    },
  },
  {
    method: 'GET',
    path: '/api/load/active',
    summary: 'The running (or last) load test: live snapshot',
    handler({ res, app }) {
      sendJson(res, 200, { active: snapshotOf(app), last: lastDone.get(app) ?? null });
    },
  },
  {
    method: 'POST',
    path: '/api/load/active/control',
    summary: 'Control the running load test: stop, abort, add VUs, scale',
    async handler({ res, app, body }) {
      const a = active.get(app);
      if (!a) throw new HttpError(404, 'no load test is running');
      try {
        switch (body.op) {
          case 'stop':
            a.test.stop('stopped from the Studio');
            break;
          case 'abort':
            a.test.abort();
            break;
          case 'vus':
            a.test.addVus(Number(body.n), typeof body.population === 'string' && body.population ? body.population : undefined);
            break;
          case 'factor':
            a.test.setFactor(Number(body.factor));
            break;
          default:
            throw new HttpError(400, 'op must be stop, abort, vus or factor');
        }
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(422, (e as Error).message);
      }
      sendJson(res, 200, { ok: true, snapshot: snapshotOf(app) });
    },
  },
  {
    method: 'GET',
    path: '/api/load/results',
    summary: 'Load runs in the results directory',
    async handler({ res, app }) {
      sendJson(res, 200, { runs: await loadRuns(app) });
    },
  },
  {
    method: 'GET',
    path: /^\/api\/load\/results\/([\w.-]+)$/,
    summary: 'One load run\'s results',
    async handler({ res, app, params }) {
      sendJson(res, 200, (await masker(app)).maskDeep(await loadRunResults(app, params[0])));
    },
  },
  {
    method: 'GET',
    path: '/api/load/compare',
    summary: 'Compare two load runs (baseline, current)',
    async handler({ res, app, query }) {
      const b = await loadRunResults(app, String(query.get('baseline') ?? ''));
      const c = await loadRunResults(app, String(query.get('current') ?? ''));
      sendJson(res, 200, compareRuns(b, c));
    },
  },
  {
    method: 'GET',
    path: '/api/load/trend',
    summary: 'p95 trend per transaction over the load run history',
    async handler({ res, app, query }) {
      const scenario = query.get('scenario') ?? undefined;
      sendJson(res, 200, trend(await readHistory(join(app.cwd, HISTORY), scenario || undefined), 30));
    },
  },
];
