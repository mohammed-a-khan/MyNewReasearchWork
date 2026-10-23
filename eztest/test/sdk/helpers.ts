/** Shared helpers for the SDK tests: a copy of the synthetic shop project, the CLI, the demo app. */
import { cp, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startDemoApp, type DemoOptions, type DemoServer } from '../../examples/demo-app/server.js';
import { buildProgram } from '../../src/cli/index.js';
import type { JourneyResult, RunResult, StepResult } from '../../src/core/index.js';

export const SHOP_FIXTURE = resolve(__dirname, 'fixtures/shop');

export interface CliRun {
  out: string[];
  err: string[];
  exitCode: number;
}

export async function cli(cwd: string, args: string[]): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const before = process.exitCode;
  process.exitCode = 0;
  await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: process.env })
    .exitOverride()
    .parseAsync(['node', 'eztest', ...args]);
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = before;
  return { out, err, exitCode };
}

export async function latestRun(project: string): Promise<{ dir: string; run: RunResult }> {
  const root = join(project, 'eztest-results');
  const dirs = (await readdir(root)).filter((d) => d.startsWith('run-')).sort();
  const dir = join(root, dirs[dirs.length - 1]);
  return { dir, run: JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as RunResult };
}

/** A fresh copy of the shop project with the demo app running on its own SQLite file. */
export async function shopProject(opts: DemoOptions = {}): Promise<{ project: string; app: DemoServer; env: Record<string, string>; restore(): Promise<void> }> {
  const project = await mkdtemp(join(tmpdir(), 'eztest-sdk-'));
  await cp(SHOP_FIXTURE, project, { recursive: true });
  const app = await startDemoApp({ ...opts, dbFile: join(project, 'shop.db') });
  const env: Record<string, string> = { SHOP_URL: app.url, SHOP_DB: join(project, 'shop.db') };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  return {
    project, app, env,
    async restore() {
      await app.close().catch(() => undefined);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

export function byId(run: RunResult, id: string): JourneyResult {
  const j = run.journeys.find((x) => x.journeyId === id);
  if (!j) throw new Error(`no journey ${id} in ${run.journeys.map((x) => x.journeyId).join(', ')}`);
  return j;
}

/** Every step result, depth first. */
export function flat(steps: StepResult[]): StepResult[] {
  return steps.flatMap((s) => [s, ...flat(s.children ?? [])]);
}

/** A compact view of a result tree for failure messages. */
export function tree(steps: StepResult[], depth = 0): string {
  return steps.map((s) => `${'  '.repeat(depth)}${s.stepId} ${s.status} ${s.intent}${s.error ? ` -- ${s.error.message}` : ''}\n${tree(s.children ?? [], depth + 1)}`).join('');
}
