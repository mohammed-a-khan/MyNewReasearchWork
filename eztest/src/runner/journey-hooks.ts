/**
 * Hooks (before/after all and each journey), Examples-table expansion and
 * per-journey session evidence.
 */
import { slugify, type Journey, type JourneyResult, type Step } from '../core/index.js';
import type { EvidenceWriter } from './evidence.js';
import type { BrowserSession } from './session.js';
import type { JourneyRunEnv } from './journey.js';
import type { RunOptions } from './types.js';
import { fillXPath } from './reliability/xpath.js';
import { DATA_PROBLEM_KEY } from './examples-source.js';

/** A "Run journey" step that runs a hook journey inside the current journey's browser context. */
export function hookStep(kind: 'before-each' | 'after-each', hook: Journey): Step {
  return {
    id: `${kind}-${hook.id}`, intent: `${kind === 'before-each' ? 'Before each' : 'After each'}: run journey "${hook.name}"`,
    action: 'runJourney', value: hook.id, postconditions: [], optional: false,
  };
}

/**
 * Expand journeys with an Examples table into one journey per row: the row's
 * values become variables and `<column>` placeholders in names and steps are
 * replaced. Ids get "-1", "-2", ... (or a slug of the first column).
 */
export function expandExamples(journeys: Journey[]): Journey[] {
  const out: Journey[] = [];
  for (const j of journeys) {
    if (!j.examples?.length) {
      out.push(j);
      continue;
    }
    const used = new Set<string>();
    j.examples.forEach((given, i) => {
      // A row whose live data could not be found (`resolve with query`) is a test-data problem: it fails as a precondition.
      const { [DATA_PROBLEM_KEY]: problem, ...row } = given;
      const fill = (s: string) => s.replace(/<([A-Za-z_][\w .-]*)>/g, (w, k: string) => (k in row ? row[k] : w));
      const { examples: _drop, ...base } = j;
      const firstVal = Object.values(row)[0];
      let suffix = firstVal ? slugify(firstVal).slice(0, 30) : String(i + 1);
      if (!suffix || used.has(suffix)) suffix = String(i + 1);
      used.add(suffix);
      // XPath candidates first, so a value with quotes is placed as a safe XPath literal; then every other string.
      const xpathSafe = JSON.parse(JSON.stringify(base.steps), (_k, v: unknown) =>
        v && typeof v === 'object' && (v as { strategy?: unknown }).strategy === 'xpath' && typeof (v as { value?: unknown }).value === 'string'
          ? { ...v, value: fillXPath((v as { value: string }).value, fill) } : v) as Step[];
      const steps = JSON.parse(JSON.stringify(xpathSafe), (_k, v: unknown) => (typeof v === 'string' ? fill(v) : v)) as Step[];
      // A cross-browser unit (sharded plans expand browsers before rows) keeps "@<browser>" last: <id>-<row>@<browser>.
      const unit = j.browser && j.id.endsWith(`@${j.browser}`) ? j.id.slice(0, -(j.browser.length + 1)) : undefined;
      const rowName = /<[^>]+>/.test(j.name) ? fill(j.name) : `${j.name} [${Object.entries(row).map(([k, v]) => `${k}=${v}`).join(', ')}]`;
      out.push({
        ...base,
        id: unit !== undefined ? `${unit}-${suffix}@${j.browser}` : `${j.id}-${suffix}`,
        name: rowName,
        variables: { ...j.variables, ...row },
        steps,
        ...(base.preconditions ? { preconditions: fill(base.preconditions) } : {}),
        ...(problem !== undefined ? { requires: [...(base.requires ?? []), { kind: 'expr' as const, expr: 'false', text: problem }] } : {}),
      });
    });
  }
  return out;
}

/** Store dialogs and WebSocket traffic recorded during a journey (masked) as evidence. */
export async function storeSessionEvidence(session: BrowserSession, evidence: EvidenceWriter, prefix: string, meta: { journeyId: string }): Promise<string[]> {
  const ids: string[] = [];
  if (session.dialogs.records.length) {
    ids.push((await evidence.store('log', `${prefix}/dialogs.json`, JSON.stringify(session.dialogs.records, null, 2), { ...meta, description: 'JavaScript dialogs' })).id);
  }
  if (session.wsFrames.length) {
    ids.push((await evidence.store('network', `${prefix}/websocket.json`, JSON.stringify(session.wsFrames, null, 2), { ...meta, description: 'WebSocket messages' })).id);
  }
  return ids;
}

/** All hook journeys of the run options (so "Run journey" can resolve them too). */
export function hookJourneys(opts: RunOptions): Journey[] {
  const h = opts.hooks ?? {};
  return [...(h.beforeAll ?? []), ...(h.beforeEach ?? []), ...(h.afterEach ?? []), ...(h.afterAll ?? [])];
}

/** Runs one hook attempt (inline: on this process's browser; process workers: on a worker). `teardown`: without the cancel signal. */
export type HookAttempt = (h: Journey, attempt: number, seed: Record<string, unknown> | undefined, teardown: boolean) => Promise<JourneyResult>;

/** Run beforeAll/afterAll hook journeys, each in its own browser context; results are tagged "hook". */
export async function runAllHook(kind: 'beforeAll' | 'afterAll', opts: RunOptions, run: HookAttempt, seed?: Record<string, unknown>): Promise<JourneyResult[]> {
  const out: JourneyResult[] = [];
  // Cancelled runs skip hook journeys, except teardown (afterAll) with teardownOnCancel, which runs without the signal.
  const teardown = kind === 'afterAll' && !!opts.signal?.aborted && !!opts.teardownOnCancel;
  for (const h of opts.hooks?.[kind] ?? []) {
    if (!teardown && opts.signal?.aborted) break;
    opts.events?.emit({ type: 'journey:start', journeyId: h.id, name: h.name });
    const r = await run(h, 1, seed, teardown);
    r.tags = [...new Set([...r.tags, 'hook', kind])];
    out.push(r);
    opts.events?.emit({ type: 'journey:end', journeyId: h.id, status: r.status });
  }
  return out;
}

/**
 * Run-wide values: the `Returns:` of the beforeAll (setup) journeys that passed, handed to every journey of
 * the run and to the afterAll (teardown) journeys as if each had captured them (docs/shared-data.md).
 */
export function runWideValues(hooks: Journey[], results: JourneyResult[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const h of hooks) {
    const r = results.find((x) => x.journeyId === h.id);
    if (!r || (r.status !== 'passed' && r.status !== 'passed-healed')) continue;
    for (const k of h.returns ?? []) if (r.ledger[k] !== undefined) out[k] = r.ledger[k];
  }
  return out;
}

/** Results for journeys that could not run because a beforeAll hook failed. */
export function blockedByHook(j: Journey, hook: JourneyResult, browser: string): JourneyResult {
  return {
    journeyId: j.id, name: j.name, status: 'error', startedAt: new Date().toISOString(), durationMs: 0, steps: [], tags: j.tags,
    requirements: j.requirements, risk: j.risk, attempt: 1, browser, ledger: {}, evidence: [],
    error: { message: `beforeAll hook "${hook.name}" ${hook.status}: ${hook.error?.message ?? hook.steps.find((s) => s.status === 'failed')?.error?.message ?? ''}` },
  };
}

/** The run environment for teardown after a cancel (RunOptions.teardownOnCancel): the same, without the signal. */
export function teardownEnv(env: JourneyRunEnv): JourneyRunEnv {
  return { ...env, opts: { ...env.opts, signal: undefined } };
}
