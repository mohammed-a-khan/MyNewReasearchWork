/**
 * Shared helpers of the file exports (Excel, PDF, e-mail): the run context as
 * rows, the steps of a test flattened in report order, and plain-text forms
 * of the model's values.
 */
import { STATE_LABEL, type ReportModel, type StepModel, type TestModel } from './data.js';
import { fmtMs } from './charts.js';

export const STEP_LABEL: Record<StepModel['s'], string> = { P: 'Passed', H: 'Passed (healed)', F: 'Failed', S: 'Skipped', B: 'Blocked' };

/** The run context as [label, value] rows (only the values that are known). */
export function contextRows(m: ReportModel): Array<[string, string]> {
  const c = m.context;
  const rows: Array<[string, string | undefined]> = [
    ['Run id', m.runId],
    ['Started', m.startedAt],
    ['Finished', m.finishedAt],
    ['Duration', fmtMs(m.durationMs)],
    ['Environment', c?.environment],
    ['Base URL', c?.baseUrl],
    ['Browsers', c?.browsers.map((b) => `${b.name}${b.version ? ` ${b.version}` : ''}`).join(', ') || undefined],
    ['Devices', c?.devices.join(', ') || undefined],
    ['CI', c?.build ? c.build.system : 'local run'],
    ['Pipeline', c?.build?.pipeline],
    ['Build', c?.build ? `${c.build.number ?? c.build.id ?? ''}${c.build.url ? ` ${c.build.url}` : ''}`.trim() : undefined],
    ['Release', c?.release ? `${c.release.name ?? ''}${c.release.environment ? ` (${c.release.environment})` : ''}` : undefined],
    ['Branch', c?.branch],
    ['Commit', c?.commit ? `${c.commit.sha.slice(0, 12)}${c.commit.author ? ` by ${c.commit.author}` : ''}` : undefined],
    ['Pull request', c?.pullRequest ? `#${c.pullRequest.number}` : undefined],
    ['Trigger', c?.trigger],
    ['Run by', c?.user],
    [m.brand.whiteLabel ? 'Engine version' : 'EZTest', c?.eztestVersion],
    ['Node.js', c?.node],
    ['Machine', c ? [c.machine.host, c.machine.os, c.machine.cpus ? `${c.machine.cpus} CPUs` : '', c.machine.memoryGb ? `${c.machine.memoryGb} GB` : ''].filter(Boolean).join(', ') : undefined],
    ['Time zone', c?.timeZone],
    ['Evidence head', m.evidenceHead],
  ];
  return rows.filter((r): r is [string, string] => r[1] !== undefined && r[1] !== '');
}

/** Every step of a test in report order: [number, depth, step]. */
export function flatSteps(t: TestModel): Array<[number, number, StepModel]> {
  const out: Array<[number, number, StepModel]> = [];
  const walk = (list: StepModel[], depth: number) => {
    for (const s of list) {
      out.push([out.length + 1, depth, s]);
      if (s.ch?.length) walk(s.ch, depth + 1);
    }
  };
  walk(t.steps, 0);
  return out;
}

/** The first failing step (the failure's step), its number and the screenshot evidence ids around it. */
export function failingStepOf(t: TestModel): { no: number; step: StepModel; shots: string[] } | undefined {
  const all = flatSteps(t);
  const hit = all.find(([, , s]) => (s.s === 'F' || s.s === 'B') && !s.so && !s.ch?.length) ?? all.find(([, , s]) => s.s === 'F' || s.s === 'B');
  if (!hit) return undefined;
  return { no: hit[0], step: hit[2], shots: hit[2].e ?? [] };
}

export const stateLabel = (t: TestModel) => STATE_LABEL[t.state];
export const firstLine = (s: string | undefined, n = 300) => (s ?? '').split('\n')[0].slice(0, n);
export const testCaseIds = (t: TestModel) => (t.ado?.testCases ?? []).map((c) => c.id);
