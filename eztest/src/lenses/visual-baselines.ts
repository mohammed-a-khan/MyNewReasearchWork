/**
 * Where visual baselines live:
 *
 * - keyed by browser (and optionally browser version, platform) and viewport:
 *   `<name>--chromium-141--1280x720.png`, so a font rendering difference
 *   between browsers, or a browser update, never fails another key's
 *   baseline. A missing version-keyed baseline falls back to the same
 *   browser's closest version and says so (infra-caused change, re-approve);
 * - branched per git branch: on a feature branch, new and approved
 *   baselines go to `branches/<branch>/` and shadow the main baselines;
 *   `mergeBaselineBranch` moves them into the main set, recorded in the
 *   approvals vault.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Page } from '../browser/index.js';
import { EvidenceVault, EzTestError, sha256, slugify } from '../core/index.js';

export type BaselineKeyPart = 'browser' | 'browserVersion' | 'viewport' | 'platform';

export interface BaselineContext {
  browser: string;
  /** Major version, e.g. "141". */
  browserVersion?: string;
  platform: string;
  viewport?: { width: number; height: number };
}

const DEFAULT_BRANCHES = new Set(['main', 'master', 'trunk', 'develop', 'default', '']);

/** Browser, version, platform and viewport of a page. */
export function baselineContext(page: Page): BaselineContext {
  const browser = page.context().browser();
  const name = browser?.browserType().name() ?? 'chromium';
  const version = browser?.version().split('.')[0];
  const vp = page.viewportSize() ?? undefined;
  return { browser: name, browserVersion: version, platform: process.platform, viewport: vp };
}

/** The key suffix for a baseline name (`--chromium-141--1280x720`). */
export function baselineKey(ctx: BaselineContext, parts: BaselineKeyPart[]): string {
  const out: string[] = [];
  if (parts.includes('browser') || parts.includes('browserVersion')) out.push(parts.includes('browserVersion') && ctx.browserVersion ? `${ctx.browser}-${ctx.browserVersion}` : ctx.browser);
  if (parts.includes('platform')) out.push(ctx.platform);
  if (parts.includes('viewport') && ctx.viewport) out.push(`${ctx.viewport.width}x${ctx.viewport.height}`);
  return out.map((p) => `--${p.replace(/[^A-Za-z0-9.-]+/g, '-')}`).join('');
}

/** The current git branch (EZTEST_BASELINE_BRANCH wins), read from .git/HEAD without spawning git. */
export function currentBranch(cwd: string, env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.EZTEST_BASELINE_BRANCH !== undefined) return env.EZTEST_BASELINE_BRANCH || undefined;
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const git = join(dir, '.git');
    if (existsSync(git)) {
      try {
        let gitDir = git;
        if (statSync(git).isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(git, 'utf8'));
          if (!m) return undefined;
          gitDir = resolve(dir, m[1].trim());
        }
        const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        return ref ? ref[1] : undefined;
      } catch {
        return undefined;
      }
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** The directory of a branch's baselines (undefined: the main set). */
export function branchDir(baselineDir: string, branch: string | undefined): string | undefined {
  if (!branch || DEFAULT_BRANCHES.has(branch)) return undefined;
  return join(baselineDir, 'branches', slugify(branch));
}

export interface BaselineLookup {
  /** File to compare against (undefined: none exists). */
  path?: string;
  /** Where a new or approved baseline is written. */
  writePath: string;
  /** Which baseline name was used (differs from the wanted one after a fallback). */
  usedName?: string;
  /** "branch" | "main". */
  source?: 'branch' | 'main';
  /** A version-keyed baseline was missing: this is the same browser's closest other version. */
  fallbackFrom?: string;
}

function versionOf(name: string, browser: string): number | undefined {
  const m = new RegExp(`--${browser}-(\\d+)(?:--|$)`).exec(name);
  return m ? Number(m[1]) : undefined;
}

/**
 * Find the baseline for `name` (already keyed): the branch set first, then the
 * main set; for a version-keyed name, the same browser's closest version.
 */
export function findBaseline(baselineDir: string, name: string, o: { branch?: string; ctx?: BaselineContext } = {}): BaselineLookup {
  const bdir = branchDir(baselineDir, o.branch);
  const writePath = join(bdir ?? baselineDir, `${name}.png`);
  for (const [dir, source] of [[bdir, 'branch'], [baselineDir, 'main']] as const) {
    if (!dir) continue;
    const p = join(dir, `${name}.png`);
    if (existsSync(p)) return { path: p, writePath, usedName: name, source };
  }
  const browser = o.ctx?.browser;
  const want = browser ? versionOf(name, browser) : undefined;
  if (browser && want !== undefined) {
    const pattern = name.replace(`--${browser}-${want}`, `--${browser}-*`);
    const [pre, post] = pattern.split('*');
    for (const [dir, source] of [[bdir, 'branch'], [baselineDir, 'main']] as const) {
      if (!dir || !existsSync(dir)) continue;
      const candidates = readdirSync(dir)
        .filter((f) => f.endsWith('.png') && f.startsWith(pre) && f.slice(0, -4).endsWith(post) && /^\d+$/.test(f.slice(pre.length, f.length - 4 - post.length)))
        .map((f) => ({ f, v: Number(f.slice(pre.length, f.length - 4 - post.length)) }))
        .sort((a, b) => Math.abs(a.v - want) - Math.abs(b.v - want) || b.v - a.v);
      if (candidates.length) return { path: join(dir, candidates[0].f), writePath, usedName: candidates[0].f.slice(0, -4), source, fallbackFrom: `${browser} ${candidates[0].v}` };
    }
  }
  return { writePath };
}

export interface BranchInfo {
  branch: string;
  dir: string;
  baselines: string[];
}

/** Baseline branches with their baselines. */
export async function listBaselineBranches(baselineDir: string): Promise<BranchInfo[]> {
  const root = join(baselineDir, 'branches');
  if (!existsSync(root)) return [];
  const out: BranchInfo[] = [];
  for (const b of (await readdir(root)).sort()) {
    const dir = join(root, b);
    if (!statSync(dir).isDirectory()) continue;
    out.push({ branch: b, dir, baselines: (await readdir(dir)).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)).sort() });
  }
  return out;
}

export interface MergeResult {
  branch: string;
  merged: Array<{ name: string; previousSha256: string | null; sha256: string }>;
  vault: string;
}

/**
 * Merge a branch's baselines into the main set (after the feature branch is
 * merged): baseline PNGs and their DOM snapshots are copied over, the branch
 * set is removed and the merge is recorded in a hash-chained approvals vault.
 */
export async function mergeBaselineBranch(baselineDir: string, branch: string, o: { approvalsDir?: string; keep?: boolean } = {}): Promise<MergeResult> {
  const dir = join(baselineDir, 'branches', slugify(branch));
  if (!existsSync(dir)) throw new EzTestError(`No baselines for branch "${branch}" (${dir})`, 'NOT_FOUND');
  const approvals = o.approvalsDir ?? join(dirname(baselineDir), 'approvals');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const vaultDir = join(approvals, `${stamp}-merge-${slugify(branch)}-${randomBytes(3).toString('hex')}`);
  const vault = new EvidenceVault(vaultDir);
  await vault.init();
  const merged: MergeResult['merged'] = [];
  for (const f of (await readdir(dir)).sort()) {
    if (!/\.(png|dom\.json)$/.test(f)) continue;
    const src = join(dir, f);
    const dst = join(baselineDir, f);
    const before = existsSync(dst) ? sha256(readFileSync(dst)) : null;
    await mkdir(baselineDir, { recursive: true });
    await copyFile(src, dst);
    if (f.endsWith('.png')) {
      const bytes = readFileSync(src);
      const ref = await vault.store('screenshot', `baselines/${f}`, bytes, { description: `merged baseline ${basename(f, '.png')} from branch ${branch}` });
      merged.push({ name: f.slice(0, -4), previousSha256: before, sha256: ref.sha256 });
    }
  }
  let approver = 'unknown';
  try {
    approver = userInfo().username;
  } catch {
    approver = 'unknown';
  }
  await vault.store('data', 'approval.json', JSON.stringify({ kind: 'visual-baseline-branch-merge', approvedAt: new Date().toISOString(), approver, via: 'eztest visual merge', branch, approved: merged }, null, 2), { description: 'visual baseline branch merge record' });
  if (!o.keep) await rm(dir, { recursive: true, force: true });
  return { branch, merged, vault: vaultDir };
}
