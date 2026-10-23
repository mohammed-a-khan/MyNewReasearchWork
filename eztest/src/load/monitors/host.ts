/**
 * Host monitor written for EZTest Load: CPU, memory, load average, disk
 * throughput and utilization, network throughput, and per-process CPU and
 * memory.
 *
 * - Linux: /proc (stat, meminfo, loadavg, diskstats, net/dev, <pid>/stat).
 * - Windows: `typeperf` performance counters (one sample per call).
 * - Elsewhere: Node's `os` module (CPU and memory only).
 *
 * Rates are deltas between consecutive samples, so the first sample of a
 * series reports only levels.
 */
import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const run = promisify(execFile);

export type HostValues = Record<string, number>;

interface CpuTimes {
  idle: number;
  total: number;
}

interface Prev {
  at: number;
  cpu?: CpuTimes;
  disk?: { read: number; write: number; ticks: number };
  net?: { rx: number; tx: number };
  procs?: Map<number, number>;
}

export function parseProcStat(text: string): CpuTimes | undefined {
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return undefined;
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (v[3] ?? 0) + (v[4] ?? 0);
  const total = v.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
  return { idle, total };
}

export function parseMeminfo(text: string): { totalKb: number; availableKb: number; swapTotalKb: number; swapFreeKb: number } {
  const get = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0);
  const available = get('MemAvailable') || get('MemFree') + get('Buffers') + get('Cached');
  return { totalKb: get('MemTotal'), availableKb: available, swapTotalKb: get('SwapTotal'), swapFreeKb: get('SwapFree') };
}

/** Whole-disk devices only (sda, nvme0n1, vda, xvda, dm-0), summed. Sectors are 512 bytes. */
export function parseDiskstats(text: string): { read: number; write: number; ticks: number; devices: number } {
  let read = 0;
  let write = 0;
  let ticks = 0;
  let devices = 0;
  for (const l of text.split('\n')) {
    const f = l.trim().split(/\s+/);
    if (f.length < 14) continue;
    const name = f[2];
    if (!/^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/.test(name)) continue;
    read += Number(f[5]) * 512;
    write += Number(f[9]) * 512;
    ticks = Math.max(ticks, Number(f[12]));
    devices++;
  }
  return { read, write, ticks, devices };
}

export function parseNetDev(text: string): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const l of text.split('\n').slice(2)) {
    const m = /^\s*([^:]+):\s*(.*)$/.exec(l);
    if (!m || m[1].trim() === 'lo') continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    rx += f[0] || 0;
    tx += f[8] || 0;
  }
  return { rx, tx };
}

/** Parse `typeperf -sc 1` CSV output into counter -> value. */
export function parseTypeperf(text: string): Record<string, number> {
  const lines = text.split(/\r?\n/).filter((l) => l.startsWith('"'));
  if (lines.length < 2) return {};
  const cells = (l: string) => [...l.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
  const head = cells(lines[0]);
  const vals = cells(lines[lines.length - 1]);
  const out: Record<string, number> = {};
  for (let i = 1; i < head.length; i++) {
    const v = Number(vals[i]);
    if (Number.isFinite(v)) out[head[i].replace(/^\\\\[^\\]+/, '')] = v;
  }
  return out;
}

const CLK_TCK = 100;

export class HostMonitor {
  private prev: Prev = { at: 0 };
  constructor(readonly o: { processes?: string[]; platform?: NodeJS.Platform; procRoot?: string } = {}) {}

  private get root(): string {
    return this.o.procRoot ?? '/proc';
  }

  async sample(): Promise<HostValues> {
    const platform = this.o.platform ?? process.platform;
    if (platform === 'linux') return this.linux();
    if (platform === 'win32') return this.windows();
    return this.generic();
  }

  private async linux(): Promise<HostValues> {
    const now = Date.now();
    const v: HostValues = {};
    const dt = this.prev.at ? (now - this.prev.at) / 1000 : 0;
    const [stat, mem, load, disk, net] = await Promise.all(
      ['stat', 'meminfo', 'loadavg', 'diskstats', 'net/dev'].map((f) => readFile(`${this.root}/${f}`, 'utf8').catch(() => '')),
    );
    const cpu = parseProcStat(stat);
    if (cpu && this.prev.cpu && cpu.total > this.prev.cpu.total) {
      v.cpuPercent = round1(100 * (1 - (cpu.idle - this.prev.cpu.idle) / (cpu.total - this.prev.cpu.total)));
    }
    const m = parseMeminfo(mem);
    if (m.totalKb) {
      v.memUsedPercent = round1(100 * (1 - m.availableKb / m.totalKb));
      v.memUsedMb = Math.round((m.totalKb - m.availableKb) / 1024);
      if (m.swapTotalKb) v.swapUsedPercent = round1(100 * (1 - m.swapFreeKb / m.swapTotalKb));
    }
    const la = load.trim().split(/\s+/).map(Number);
    if (Number.isFinite(la[0])) v.load1 = la[0];
    v.cpus = os.cpus().length;
    const d = parseDiskstats(disk);
    if (d.devices && this.prev.disk && dt > 0) {
      v.diskReadKBps = round1((d.read - this.prev.disk.read) / 1024 / dt);
      v.diskWriteKBps = round1((d.write - this.prev.disk.write) / 1024 / dt);
      v.diskUtilPercent = round1(Math.min(100, ((d.ticks - this.prev.disk.ticks) / (dt * 1000)) * 100));
    }
    const n = parseNetDev(net);
    if (this.prev.net && dt > 0) {
      v.netRxKBps = round1((n.rx - this.prev.net.rx) / 1024 / dt);
      v.netTxKBps = round1((n.tx - this.prev.net.tx) / 1024 / dt);
    }
    const procs = new Map<number, number>();
    if (this.o.processes?.length) {
      const pids = (await readdir(this.root).catch(() => [] as string[])).filter((x) => /^\d+$/.test(x));
      const totals = new Map<string, { cpu: number; rss: number; count: number }>();
      const wanted = this.o.processes;
      // /proc/<pid>/stat carries the command name; the command line is read only when the name does not match
      const one = async (pid: string) => {
        const pstat = await readFile(`${this.root}/${pid}/stat`, 'utf8').catch(() => '');
        if (!pstat) return;
        const comm = pstat.slice(pstat.indexOf('(') + 1, pstat.lastIndexOf(')'));
        let name = wanted.find((p) => comm === p);
        if (!name) {
          const cmdline = (await readFile(`${this.root}/${pid}/cmdline`, 'utf8').catch(() => '')).replace(/\0/g, ' ');
          name = wanted.find((p) => cmdline.includes(p));
        }
        if (!name) return;
        const f = pstat.slice(pstat.lastIndexOf(')') + 2).split(' ');
        const ticks = Number(f[11]) + Number(f[12]);
        const rssPages = Number(f[21]);
        procs.set(Number(pid), ticks);
        const before = this.prev.procs?.get(Number(pid));
        const t = totals.get(name) ?? { cpu: 0, rss: 0, count: 0 };
        if (before !== undefined && dt > 0) t.cpu += ((ticks - before) / CLK_TCK / dt) * 100;
        t.rss += (rssPages * 4096) / 1024 / 1024;
        t.count++;
        totals.set(name, t);
      };
      for (let i = 0; i < pids.length; i += 32) await Promise.all(pids.slice(i, i + 32).map(one));
      for (const [name, t] of totals) {
        const k = name.replace(/[^\w]+/g, '_');
        v[`proc.${k}.cpuPercent`] = round1(t.cpu);
        v[`proc.${k}.rssMb`] = round1(t.rss);
        v[`proc.${k}.count`] = t.count;
      }
    }
    this.prev = { at: now, cpu, disk: d.devices ? d : undefined, net: n, procs };
    return v;
  }

  private async windows(): Promise<HostValues> {
    const counters = ['\\Processor(_Total)\\% Processor Time', '\\Memory\\% Committed Bytes In Use', '\\Memory\\Available MBytes', '\\PhysicalDisk(_Total)\\% Disk Time', '\\PhysicalDisk(_Total)\\Disk Read Bytes/sec', '\\PhysicalDisk(_Total)\\Disk Write Bytes/sec', '\\Network Interface(*)\\Bytes Received/sec', '\\Network Interface(*)\\Bytes Sent/sec'];
    const { stdout } = await run('typeperf', [...counters, '-sc', '1'], { timeout: 15_000, windowsHide: true });
    const c = parseTypeperf(stdout);
    const sum = (re: RegExp) => Object.entries(c).filter(([k]) => re.test(k)).reduce((a, [, x]) => a + x, 0);
    const v: HostValues = {
      cpuPercent: round1(sum(/Processor\(_Total\)\\% Processor Time/)),
      memUsedPercent: round1(sum(/% Committed Bytes In Use/)),
      memAvailableMb: Math.round(sum(/Available MBytes/)),
      diskUtilPercent: round1(Math.min(100, sum(/% Disk Time/))),
      diskReadKBps: round1(sum(/Disk Read Bytes\/sec/) / 1024),
      diskWriteKBps: round1(sum(/Disk Write Bytes\/sec/) / 1024),
      netRxKBps: round1(sum(/Bytes Received\/sec/) / 1024),
      netTxKBps: round1(sum(/Bytes Sent\/sec/) / 1024),
      cpus: os.cpus().length,
    };
    return v;
  }

  private async generic(): Promise<HostValues> {
    const cpus = os.cpus();
    const idle = cpus.reduce((a, c) => a + c.times.idle, 0);
    const total = cpus.reduce((a, c) => a + c.times.idle + c.times.user + c.times.sys + c.times.nice + c.times.irq, 0);
    const v: HostValues = { memUsedPercent: round1(100 * (1 - os.freemem() / os.totalmem())), load1: os.loadavg()[0], cpus: cpus.length };
    if (this.prev.cpu && total > this.prev.cpu.total) v.cpuPercent = round1(100 * (1 - (idle - this.prev.cpu.idle) / (total - this.prev.cpu.total)));
    this.prev = { at: Date.now(), cpu: { idle, total } };
    return v;
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
