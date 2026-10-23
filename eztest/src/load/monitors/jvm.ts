/**
 * JVM monitor. JMX travels over Java RMI (JRMP with Java object
 * serialization), which a Node process cannot speak without reimplementing
 * Java serialization, so EZTest reads the JVM where it runs: on the
 * monitored host (an EZTest host agent or this machine) it calls the JDK's
 * own `jstat -gcutil` and `jcmd` (GC.heap_info, Thread.print) and parses
 * them. Values: heap used/committed (MB), eden/old/metaspace occupancy (%),
 * young/full GC counts and time deltas, live threads.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EzTestError } from '../../core/index.js';

const run = promisify(execFile);

/** Parse `jstat -gcutil <pid>` (header line + one values line). */
export function parseJstatGcutil(text: string): Record<string, number> {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new EzTestError(`jstat: unexpected output "${text.slice(0, 80)}"`, 'LOAD_MONITOR');
  const head = lines[0].trim().split(/\s+/);
  const vals = lines[lines.length - 1].trim().split(/\s+/).map((x) => (x === '-' ? NaN : Number(x)));
  const out: Record<string, number> = {};
  head.forEach((h, i) => {
    if (Number.isFinite(vals[i])) out[h] = vals[i];
  });
  return out;
}

/** Parse `jcmd <pid> GC.heap_info`: total/used heap in KB for the common collectors. */
export function parseHeapInfo(text: string): { totalKb?: number; usedKb?: number; metaUsedKb?: number } {
  const heap = /(?:heap|generation)\s+total\s+(\d+)K,\s+used\s+(\d+)K/i.exec(text);
  const meta = /Metaspace\s+used\s+(\d+)K/i.exec(text);
  return { totalKb: heap ? Number(heap[1]) : undefined, usedKb: heap ? Number(heap[2]) : undefined, metaUsedKb: meta ? Number(meta[1]) : undefined };
}

/** Count threads in `jcmd <pid> Thread.print`. */
export function countThreads(text: string): number {
  return text.split('\n').filter((l) => /^"[^"]+"/.test(l)).length;
}

export class JvmMonitor {
  private prev?: { ygc: number; ygct: number; fgc: number; fgct: number; at: number };
  private pid?: number;
  constructor(readonly o: { pid: number | string; jstat?: string; jcmd?: string }) {}

  private async resolvePid(): Promise<number> {
    if (this.pid) return this.pid;
    if (typeof this.o.pid === 'number') return (this.pid = this.o.pid);
    if (/^\d+$/.test(this.o.pid)) return (this.pid = Number(this.o.pid));
    const { stdout } = await run(this.o.jcmd ?? 'jcmd', ['-l'], { timeout: 10_000 });
    const line = stdout.split('\n').find((l) => l.includes(String(this.o.pid)) && !/JCmd/.test(l));
    if (!line) throw new EzTestError(`no Java process matching "${this.o.pid}" (jcmd -l)`, 'LOAD_MONITOR');
    return (this.pid = Number(line.trim().split(/\s+/)[0]));
  }

  async sample(): Promise<Record<string, number>> {
    const pid = await this.resolvePid();
    const [gc, heap, threads] = await Promise.all([
      run(this.o.jstat ?? 'jstat', ['-gcutil', String(pid)], { timeout: 10_000 }).then((r) => parseJstatGcutil(r.stdout)),
      run(this.o.jcmd ?? 'jcmd', [String(pid), 'GC.heap_info'], { timeout: 10_000 }).then((r) => parseHeapInfo(r.stdout)).catch(() => ({}) as ReturnType<typeof parseHeapInfo>),
      run(this.o.jcmd ?? 'jcmd', [String(pid), 'Thread.print'], { timeout: 15_000, maxBuffer: 32 * 1024 * 1024 }).then((r) => countThreads(r.stdout)).catch(() => undefined),
    ]);
    const now = Date.now();
    const v: Record<string, number> = {};
    if (gc.E !== undefined) v.edenPercent = gc.E;
    if (gc.O !== undefined) v.oldPercent = gc.O;
    if (gc.M !== undefined) v.metaspacePercent = gc.M;
    if (heap.usedKb !== undefined) v.heapUsedMb = Math.round(heap.usedKb / 102.4) / 10;
    if (heap.totalKb !== undefined) v.heapCommittedMb = Math.round(heap.totalKb / 102.4) / 10;
    if (threads !== undefined) v.threads = threads;
    const ygc = gc.YGC ?? 0;
    const fgc = gc.FGC ?? 0;
    v.youngGcCount = ygc;
    v.fullGcCount = fgc;
    if (this.prev) {
      const dt = (now - this.prev.at) / 1000;
      v.youngGcPerSec = Math.round(((ygc - this.prev.ygc) / dt) * 100) / 100;
      v.gcTimePercent = Math.round(((((gc.YGCT ?? 0) - this.prev.ygct + ((gc.FGCT ?? 0) - this.prev.fgct)) / dt) * 100) * 100) / 100;
    }
    this.prev = { ygc, ygct: gc.YGCT ?? 0, fgc, fgct: gc.FGCT ?? 0, at: now };
    return v;
  }
}
