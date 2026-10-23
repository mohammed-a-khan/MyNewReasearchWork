/**
 * Git hooks for journey repositories:
 *  - pre-commit: validate and lint the *staged* version of every changed
 *    journey (parse errors, conflict markers, unconverted TODO lines, actions
 *    no expectation can verify);
 *  - pre-push (optional): run the journeys a push impacts (changed journeys,
 *    plus those an impact mapping selects for the changed files).
 *
 * `installHooks` writes small POSIX sh scripts (git runs hooks through sh on
 * every platform) that call `eztest hooks run <hook>`. A hook that was there
 * before is kept as `<hook>.pre-eztest` and still runs first.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Journey } from '../core/index.js';
import { analyzeImpact, loadImpactMapping, type ImpactResult } from '../insights/impact.js';
import { journeyToEzScript } from '../intent/index.js';
import { parseJourneyText, validateText, type JourneyFormat } from '../studio/authoring.js';
import { GitRepo } from './repo.js';

export const HOOK_MARKER = '# eztest-hook: managed by `eztest hooks install`';
export type HookName = 'pre-commit' | 'pre-push';

export interface InstallHooksOptions {
  hooks?: HookName[];
  /** Command that starts the eztest CLI, as argv (default: npx --no-install eztest). */
  command?: string[];
  /** Replace an existing managed hook / keep a foreign one as <hook>.pre-eztest. */
  force?: boolean;
  /** Extra arguments for `eztest hooks run <hook>` (e.g. --strict, --mapping file). */
  args?: Partial<Record<HookName, string[]>>;
}

function shQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function hookScript(hook: HookName, command: string[], args: string[] = []): string {
  const cmd = [...command, 'hooks', 'run', hook, ...args].map(shQuote).join(' ');
  return `#!/bin/sh
${HOOK_MARKER} (remove with \`eztest hooks uninstall\`)
# Skip once with: git ${hook === 'pre-commit' ? 'commit' : 'push'} --no-verify
here=$(dirname "$0")
if [ -x "$here/${hook}.pre-eztest" ]; then
  "$here/${hook}.pre-eztest" "$@" || exit $?
fi
exec ${cmd} "$@"
`;
}

export async function installHooks(cwd: string, o: InstallHooksOptions = {}): Promise<Array<{ hook: HookName; path: string; action: 'installed' | 'updated' | 'kept-existing-as-pre-eztest' }>> {
  const repo = await GitRepo.open(cwd);
  const dir = await repo.hooksDir();
  await mkdir(dir, { recursive: true });
  const out: Array<{ hook: HookName; path: string; action: 'installed' | 'updated' | 'kept-existing-as-pre-eztest' }> = [];
  for (const hook of o.hooks ?? ['pre-commit']) {
    const p = join(dir, hook);
    let action: 'installed' | 'updated' | 'kept-existing-as-pre-eztest' = 'installed';
    if (existsSync(p)) {
      const cur = await readFile(p, 'utf8');
      if (cur.includes(HOOK_MARKER)) action = 'updated';
      else {
        if (existsSync(`${p}.pre-eztest`) && !o.force) throw new Error(`${hook}: ${p}.pre-eztest already exists; pass --force to replace the current hook`);
        await rename(p, `${p}.pre-eztest`);
        action = 'kept-existing-as-pre-eztest';
      }
    }
    await writeFile(p, hookScript(hook, o.command ?? ['npx', '--no-install', 'eztest'], o.args?.[hook] ?? []));
    await chmod(p, 0o755);
    out.push({ hook, path: p, action });
  }
  return out;
}

export async function uninstallHooks(cwd: string, hooks: HookName[] = ['pre-commit', 'pre-push']): Promise<string[]> {
  const repo = await GitRepo.open(cwd);
  const dir = await repo.hooksDir();
  const removed: string[] = [];
  for (const hook of hooks) {
    const p = join(dir, hook);
    if (!existsSync(p) || !(await readFile(p, 'utf8')).includes(HOOK_MARKER)) continue;
    await rm(p);
    if (existsSync(`${p}.pre-eztest`)) await rename(`${p}.pre-eztest`, p);
    removed.push(hook);
  }
  return removed;
}

// ------------------------------------------------------------------ lint

export interface LintIssue {
  file: string;
  line?: number;
  severity: 'error' | 'warning';
  rule: string;
  message: string;
}

const JOURNEY_EXT = new Set(['.ez', '.yaml', '.yml', '.json']);
const CLICKY = new Set(['click', 'dblclick']);

/** Is this repository path a journey file? `.ez` anywhere; YAML/JSON only under a journeys directory. */
export function isJourneyPath(path: string, journeysDirs: string[] = ['journeys']): boolean {
  const ext = extname(path).toLowerCase();
  if (!JOURNEY_EXT.has(ext) || /\.locators\.json$/i.test(path)) return false;
  if (ext === '.ez') return true;
  return journeysDirs.some((d) => path === d || path.startsWith(`${d.replace(/\/+$/, '')}/`));
}

function formatOfPath(p: string): JourneyFormat {
  const e = extname(p).toLowerCase();
  return e === '.ez' ? 'ez' : e === '.json' ? 'json' : 'yaml';
}

/** Lint one journey text: validation errors plus authoring rules. */
export function lintJourneyText(file: string, text: string): LintIssue[] {
  const issues: LintIssue[] = [];
  if (/^<<<<<<< |^>>>>>>> /m.test(text)) {
    const line = text.split('\n').findIndex((l) => /^<<<<<<< |^>>>>>>> /.test(l)) + 1;
    return [{ file, line, severity: 'error', rule: 'conflict-markers', message: 'unresolved merge conflict markers' }];
  }
  const fmt = formatOfPath(file);
  const v = validateText(text, fmt);
  for (const e of v.errors) issues.push({ file, line: e.line, severity: 'error', rule: 'parse', message: e.message + (e.suggestions?.length ? ` (did you mean: ${e.suggestions.slice(0, 2).join(' | ')})` : '') });
  if (!v.ok) return issues;
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    if (/^\s*#\s*TODO\b/i.test(l)) issues.push({ file, line: i + 1, severity: 'warning', rule: 'todo', message: `unconverted step left as a TODO: ${l.replace(/^\s*#\s*/, '').slice(0, 120)}` });
  });
  let journey: Journey | undefined;
  try {
    journey = parseJourneyText(text, fmt);
  } catch {
    return issues;
  }
  for (const s of journey.steps) {
    if (CLICKY.has(s.action) && s.target && !s.postconditions?.length) {
      const line = fmt === 'ez' ? lines.findIndex((l) => l.trim() && s.intent && l.includes(s.intent.slice(0, 40))) + 1 || undefined : undefined;
      issues.push({ file, line, severity: 'warning', rule: 'unverifiable-action', message: `"${s.intent}" has no expectation after it, so a heal of it cannot be verified; add an "Expect ..." line` });
    }
  }
  if (fmt === 'ez') {
    try {
      journeyToEzScript(journey);
    } catch (e) {
      issues.push({ file, severity: 'warning', rule: 'render', message: `journey cannot be rendered back to .ez: ${(e as Error).message}` });
    }
  }
  return issues;
}

export interface PreCommitResult {
  files: string[];
  issues: LintIssue[];
  ok: boolean;
}

/** Validate and lint the staged version of every staged journey. Warnings fail only with `strict`. */
export async function preCommit(cwd: string, o: { journeysDirs?: string[]; strict?: boolean } = {}): Promise<PreCommitResult> {
  const repo = await GitRepo.open(cwd);
  const staged = (await repo.stagedFiles()).filter((f) => isJourneyPath(f, o.journeysDirs));
  const issues: LintIssue[] = [];
  for (const f of staged) {
    const text = (await repo.show(':0', f)) ?? '';
    issues.push(...lintJourneyText(f, text));
  }
  const ok = !issues.some((i) => i.severity === 'error' || (o.strict && i.severity === 'warning'));
  return { files: staged, issues, ok };
}

export interface PrePushPlan {
  base?: string;
  changedFiles: string[];
  journeyFiles: string[];
  impact?: ImpactResult;
}

/**
 * Journeys a push impacts: changed journey files, plus journeys an impact
 * mapping selects for the other changed files (base: the upstream, else the
 * default branch on origin).
 */
export async function prePushPlan(
  cwd: string,
  o: { base?: string; mapping?: string; journeys?: Array<{ id: string; file: string; name?: string; tags: string[]; requirements: string[]; risk: number }>; journeysDirs?: string[] } = {},
): Promise<PrePushPlan> {
  const repo = await GitRepo.open(cwd);
  let base = o.base;
  if (!base) {
    const up = await repo.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { okCodes: [128] });
    base = up.code === 0 ? up.stdout.trim() : undefined;
  }
  if (!base) {
    const def = await repo.defaultBranch();
    const remoteDef = def ? `origin/${def}` : undefined;
    if (remoteDef && (await repo.run(['rev-parse', '--verify', '-q', remoteDef], { okCodes: [1] })).code === 0) base = remoteDef;
  }
  if (!base) return { changedFiles: [], journeyFiles: [] };
  const changed = await repo.changedFiles(base, 'HEAD');
  const journeyFiles = changed.filter((f) => isJourneyPath(f, o.journeysDirs) && existsSync(join(repo.root, f)));
  let impact: ImpactResult | undefined;
  if (o.mapping && existsSync(o.mapping) && o.journeys?.length && changed.length) {
    impact = analyzeImpact(changed, o.journeys, await loadImpactMapping(o.mapping));
    for (const j of impact.impacted) {
      const f = o.journeys.find((x) => x.id === j.journeyId)?.file;
      if (f && !journeyFiles.includes(f)) journeyFiles.push(f);
    }
  }
  return { base, changedFiles: changed, journeyFiles, ...(impact ? { impact } : {}) };
}

/** Spawn the CLI (argv array, no shell) and resolve with its exit code; output is inherited. */
export function runCli(argv: string[], cwd: string, env?: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}
