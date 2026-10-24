/**
 * How oversubscribed the machine's CPUs are, for the testkit's own waits (`expect.poll`): a poll
 * that runs out while every CPU is busy and more tasks wait for one than there are CPUs gets more
 * time in proportion (at most 3x, TESTKIT_POLL_MAX), instead of failing a test that is only slow.
 * Measured from the CPU times and the run queue, never assumed; TESTKIT_ADAPTIVE=0 turns it off.
 */
import { readFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg } from 'node:os';

const CORES = Math.max(1, availableParallelism());

export interface CpuMark {
  idle: number;
  total: number;
}

export function cpuMark(): CpuMark {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    idle += c.times.idle;
    total += c.times.idle + c.times.user + c.times.nice + c.times.sys + c.times.irq;
  }
  return { idle, total };
}

function runnablePerCpu(): number {
  try {
    const n = Number(readFileSync('/proc/loadavg', 'utf8').split(/\s+/)[3]?.split('/')[0]);
    if (Number.isFinite(n)) return Math.max(0, n - 1) / CORES;
  } catch {
    // not Linux
  }
  return loadavg()[0] / CORES;
}

/** The deadline factor for a wait that started at `since`: 1 unless the CPUs were saturated. */
export function loadFactor(since: CpuMark): number {
  if (/^(0|false|off)$/i.test(process.env.TESTKIT_ADAPTIVE ?? '')) return 1;
  const now = cpuMark();
  const dt = now.total - since.total;
  if (dt <= 0) return 1;
  const busy = 1 - (now.idle - since.idle) / dt;
  const max = Math.min(10, Math.max(1, Number(process.env.TESTKIT_POLL_MAX) || 3));
  const q = runnablePerCpu();
  return busy >= 0.85 && q >= 1.15 ? Math.min(max, q) : 1;
}
