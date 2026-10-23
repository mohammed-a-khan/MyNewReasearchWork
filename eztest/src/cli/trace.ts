/**
 * `eztest trace`: read time-travel traces from the terminal, CI logs or a
 * coding agent, without Studio.
 *
 *   eztest trace list <runDir>
 *   eztest trace steps <runDir> <journey> [--attempt 1] [--json]
 *   eztest trace step <runDir> <journey> <n> [--json]
 *   eztest trace snapshot <runDir> <journey> <n> [--before|--after] [-o file.html]
 *   eztest trace network <runDir> <journey> [<n>] [--json]
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { CliIO } from './program.js';
import { listTraces, readTrace, renderSnapshot, runDirSource, type TraceFile, type TraceStep } from '../runner/trace/index.js';

function pickStep(t: TraceFile, n: string): TraceStep {
  const byNumber = /^\d+$/.test(n) ? t.steps[Number(n) - 1] : undefined;
  const s = byNumber ?? t.steps.find((x) => x.stepId === n);
  if (!s) throw new Error(`No step ${n} in ${t.journeyId} (it has ${t.steps.length}; use a number from "eztest trace steps" or a step id)`);
  return s;
}

async function journeyId(runDir: string, ref: string): Promise<string> {
  const all = await listTraces(runDir);
  const hit = all.find((x) => x.journeyId === ref) ?? all.find((x) => x.journeyName === ref) ?? all.find((x) => x.journeyId.startsWith(ref));
  if (!hit) throw new Error(`No trace for "${ref}" in ${runDir} (traces: ${all.map((x) => x.journeyId).join(', ') || 'none; run with trace.timeTravel enabled'})`);
  return hit.journeyId;
}

export function registerTraceCommands(program: Command, io: CliIO): void {
  const trace = program.command('trace').description('read time-travel traces as text or JSON (steps, snapshots, network)');
  const json = (v: unknown) => io.out(JSON.stringify(v, null, 2));
  const load = async (runDir: string, ref: string, attempt: string | undefined) => {
    const dir = resolve(io.cwd, runDir);
    return { dir, t: await readTrace(dir, await journeyId(dir, ref), Number(attempt ?? 1)) };
  };

  trace
    .command('list')
    .argument('<runDir>')
    .option('--json', 'JSON output')
    .action(async (runDir: string, o: { json?: boolean }) => {
      const all = await listTraces(resolve(io.cwd, runDir));
      if (o.json) return json(all);
      for (const x of all) io.out(`${x.journeyId}  attempt ${x.attempt}  ${x.status}  ${x.steps} steps  ${x.durationMs} ms`);
      if (!all.length) io.out('No traces (enable trace.timeTravel in the config).');
    });

  trace
    .command('steps')
    .argument('<runDir>')
    .argument('<journey>', 'journey id or name')
    .option('--attempt <n>', 'attempt', '1')
    .option('--json', 'JSON output')
    .action(async (runDir: string, ref: string, o: { attempt?: string; json?: boolean }) => {
      const { t } = await load(runDir, ref, o.attempt);
      if (o.json) return json(t.steps.map((s, i) => ({ n: i + 1, stepId: s.stepId, intent: s.intent, status: s.status, durationMs: s.durationMs, error: s.error, healed: !!s.heal?.record })));
      t.steps.forEach((s, i) => io.out(`${String(i + 1).padStart(3)}  ${s.status.padEnd(13)} ${String(s.durationMs).padStart(6)} ms  ${s.intent}${s.error ? `  -- ${s.error.split('\n')[0]}` : ''}`));
    });

  trace
    .command('step')
    .argument('<runDir>')
    .argument('<journey>')
    .argument('<n>', 'step number (from "steps") or step id')
    .option('--attempt <n>', 'attempt', '1')
    .option('--json', 'JSON output')
    .action(async (runDir: string, ref: string, n: string, o: { attempt?: string; json?: boolean }) => {
      const { t } = await load(runDir, ref, o.attempt);
      const s = pickStep(t, n);
      if (o.json) return json(s);
      io.out(`${s.intent}\n  status   ${s.status} (${s.durationMs} ms)\n  action   ${s.action}${s.value !== undefined ? ` "${s.value}"` : ''}`);
      if (s.targetDescription) io.out(`  target   ${s.targetDescription}${s.locator.usedDescription ? ` via ${s.locator.usedDescription}` : ''}`);
      for (const c of s.locator.tried) io.out(`  tried    ${c.description}: ${c.count < 0 ? 'invalid' : `${c.count} match(es)`}`);
      if (s.heal?.record) io.out(`  healed   ${s.heal.record.tier} ${s.heal.record.verified ? '(verified)' : '(not verified)'}`);
      for (const c of s.conditions) io.out(`  ${c.passed ? 'ok  ' : 'FAIL'}     ${c.text}${c.actual !== undefined ? ` (actual: ${c.actual})` : ''}`);
      if (s.error) io.out(`  error    ${s.error}`);
      io.out(`  url      ${s.url.before ?? ''} -> ${s.url.after ?? ''}\n  network  ${s.network.length} request(s), console ${s.console.length} message(s)`);
    });

  trace
    .command('snapshot')
    .argument('<runDir>')
    .argument('<journey>')
    .argument('<n>')
    .option('--attempt <n>', 'attempt', '1')
    .option('--before', 'the DOM before the step')
    .option('--after', 'the DOM after the step (default)')
    .option('-o, --out <file>', 'write the self-contained HTML here (default: stdout)')
    .action(async (runDir: string, ref: string, n: string, o: { attempt?: string; before?: boolean; out?: string }) => {
      const { dir, t } = await load(runDir, ref, o.attempt);
      const s = pickStep(t, n);
      const snap = o.before ? s.snapshots.before : s.snapshots.after ?? s.snapshots.before;
      if (!snap) throw new Error(`Step ${n} has no ${o.before ? 'before' : 'after'} snapshot`);
      const html = await renderSnapshot(runDirSource(dir), t, snap);
      if (o.out) {
        await writeFile(resolve(io.cwd, o.out), html);
        io.out(`wrote ${o.out} (${snap.phase} snapshot of "${s.intent}", ${snap.url})`);
      } else io.out(html);
    });

  trace
    .command('network')
    .argument('<runDir>')
    .argument('<journey>')
    .argument('[n]', 'only this step')
    .option('--attempt <n>', 'attempt', '1')
    .option('--json', 'JSON output')
    .action(async (runDir: string, ref: string, n: string | undefined, o: { attempt?: string; json?: boolean }) => {
      const { t } = await load(runDir, ref, o.attempt);
      const entries = n ? pickStep(t, n).network : [...t.steps.flatMap((s) => s.network), ...t.unattributed.network];
      if (o.json) return json(entries);
      for (const e of entries) io.out(`${String(e.stepIndex + 1).padStart(3)}  ${e.method.padEnd(6)} ${String(e.status ?? e.failure ?? '-').padEnd(4)} ${String(e.durationMs ?? '').padStart(5)} ms  ${e.url}`);
    });
}
