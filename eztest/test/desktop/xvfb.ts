/** Test helper: a virtual X display for desktop apps (Swing, Electron) when none is set. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface Display {
  display: string;
  stop(): void;
}

export function hasXvfb(): boolean {
  return spawnSync('which', ['Xvfb']).status === 0;
}

/** The current DISPLAY, or a fresh Xvfb server (undefined when neither exists). */
export async function ensureDisplay(): Promise<Display | undefined> {
  if (process.env.DISPLAY) return { display: process.env.DISPLAY, stop: () => undefined };
  if (!hasXvfb()) return undefined;
  for (let n = 90 + Math.floor(Math.random() * 100); n < 400; n++) {
    if (existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`)) continue;
    const p: ChildProcess = spawn('Xvfb', [`:${n}`, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      if (existsSync(`/tmp/.X11-unix/X${n}`)) return { display: `:${n}`, stop: () => p.kill() };
      if (p.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    p.kill();
  }
  return undefined;
}
