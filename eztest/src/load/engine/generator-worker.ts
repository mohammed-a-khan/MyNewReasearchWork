/**
 * One load generator process (see generators.ts): it runs its share of the populations with its own
 * event loop, scheduler, connections and data slice, and streams one encoded interval per second
 * to the process that started it. It ends with that process (the IPC channel closing).
 */
import { parseScenario } from '../model.js';
import { MetricsCollector, type EncodedInterval } from '../metrics.js';
import { buildPopulations, steadyAfter } from '../run.js';
import { Executor } from './executor.js';
import { LoadRuntime } from './vu.js';
import type { GeneratorJob, ToThread } from './generators.js';

const port = {
  postMessage: (m: unknown) => {
    if (process.connected) process.send!(m);
  },
};
process.on('disconnect', () => {
  ex?.abort();
  setTimeout(() => process.exit(0), 3000).unref();
});
// The process that started this generator stops it (a terminal Ctrl+C reaches the whole process group).
process.on('SIGINT', () => undefined);
let ex: Executor | undefined;
let rt: LoadRuntime | undefined;
let metrics: MetricsCollector | undefined;
let job: GeneratorJob | undefined;
let pops: ReturnType<typeof buildPopulations> = [];

async function prepare(j: GeneratorJob): Promise<void> {
  job = j;
  const scenario = parseScenario(j.scenario, j.baseDir);
  metrics = new MetricsCollector(scenario.options.errorSamples);
  metrics.steadyAfterSec = steadyAfter(scenario);
  rt = new LoadRuntime(scenario, j.data, metrics, { vuIdOffset: j.vuIdOffset, ...(j.seed !== undefined ? { seed: j.seed } : {}) });
  pops = buildPopulations(scenario, rt, j.slices, { generators: j.of });
  port.postMessage({ type: 'ready', empty: !pops.length });
}

async function start(startAt: number): Promise<void> {
  const j = job!;
  if (!pops.length) {
    await rt!.close();
    port.postMessage({ type: 'final', details: [], errors: [], maxVus: 0 });
    return;
  }
  ex = new Executor({
    runtime: rt!, populations: pops, model: rt!.scenario.model, mode: 'agent', startAt, roundOffset: j.roundOffset, arrivalPhase: j.arrivalPhase,
    ...(j.durationMs !== undefined ? { durationMs: j.durationMs } : {}),
  });
  ex.on('interval', (e: EncodedInterval) => port.postMessage({ type: 'interval', data: e }));
  ex.on('vu-error', (e: Error) => port.postMessage({ type: 'vu-error', message: e?.message ?? String(e) }));
  try {
    await ex.run();
  } finally {
    await rt!.close();
  }
  port.postMessage({ type: 'final', details: metrics!.finalDetails(), errors: metrics!.errorSamples, maxVus: metrics!.maxVus });
}

process.on('message', (m: ToThread) => {
  const fail = (e: unknown) => port.postMessage({ type: 'error', message: (e as Error)?.message ?? String(e) });
  switch (m.type) {
    case 'prepare':
      prepare(m.job).catch(fail);
      break;
    case 'start':
      start(m.startAt).catch(fail);
      break;
    case 'stop':
      if (m.abort) ex?.abort();
      else ex?.stop();
      break;
    case 'control':
      try {
        if (m.addVus !== undefined) ex?.addVus(m.addVus, m.population);
        if (m.factor !== undefined) ex?.setFactor(m.factor);
      } catch (e) {
        port.postMessage({ type: 'vu-error', message: (e as Error).message });
      }
      break;
  }
});
