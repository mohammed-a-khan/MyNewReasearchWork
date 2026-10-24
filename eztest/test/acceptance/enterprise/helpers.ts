/**
 * Shared helpers of the enterprise acceptance tests: the CLI in process, the latest run, a step tree for failure
 * messages, and the person-like mouse and keyboard used when recording.
 */
import { readFile, readdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { expect } from '../../support/testkit.js';
import type { Locator, Page } from '../../../src/browser/index.js';
import { buildProgram } from '../../../src/cli/index.js';
import type { JourneyResult, RunResult, StepResult } from '../../../src/core/index.js';

export async function cli(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ out: string[]; err: string[]; exitCode: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const before = process.exitCode;
  process.exitCode = 0;
  await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd, env }).exitOverride().parseAsync(['node', 'eztest', ...args]);
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = before;
  return { out, err, exitCode };
}

export async function lastRun(project: string): Promise<{ run: RunResult; dir: string }> {
  const root = join(project, 'eztest-results');
  const dirs = (await readdir(root)).filter((d) => d.startsWith('run-')).sort();
  const dir = join(root, dirs[dirs.length - 1]);
  return { run: JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as RunResult, dir };
}

/** Every step, depth first. */
export function flat(steps: StepResult[]): StepResult[] {
  return steps.flatMap((s) => [s, ...flat(s.children ?? [])]);
}

/** The steps that did not pass, one line each: what an assertion message should show. */
export function failures(journeys: JourneyResult[]): string[] {
  return journeys.flatMap((j) => flat(j.steps).filter((s) => s.status !== 'passed' && !s.children?.length).map((s) => `${j.name}: ${s.intent}: ${s.status}${s.error ? ` - ${s.error.message.slice(0, 400)}` : ''}`));
}

export function portOpen(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((done) => {
    const s = connect({ host, port });
    s.setTimeout(timeoutMs);
    s.on('connect', () => {
      s.destroy();
      done(true);
    });
    s.on('timeout', () => {
      s.destroy();
      done(false);
    });
    s.on('error', () => done(false));
  });
}

export async function urlUp(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    return r.status > 0;
  } catch {
    return false;
  }
}

/** A person's click: the mouse moves to the element's centre and presses there (real input events). */
export async function humanClick(page: Page, el: Locator): Promise<void> {
  await expect.poll(() => el.isVisible(), { timeout: 30_000 }).toBe(true);
  // A person scrolls a control below the fold into view before clicking it.
  await el.scrollIntoViewIfNeeded();
  const b = (await el.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}

/** A person's typing: one key at a time, with a short pause between keys. */
export async function humanType(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 40 });
}

/** A short random tag for the data a run creates (lower-case letters and digits). */
export function runTag(prefix = 'ezq'): string {
  return `${prefix}${Math.random().toString(36).slice(2, 7)}`;
}
