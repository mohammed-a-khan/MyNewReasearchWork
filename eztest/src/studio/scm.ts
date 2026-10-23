/**
 * Source Control for the Studio: the project's git status grouped into
 * journeys, queries and config; word-level diffs; stage, unstage, commit,
 * branches, pull and push (with the user's own git credentials: git never
 * prompts, and the Studio never asks); history and blame per journey mapped
 * to steps; conflict resolution for journey files; the Quality Center's branch
 * filter; and change proposals (heal accepted, baselines approved, quarantine)
 * that become a branch + commit + pull request on request or automatically.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { GitError, GitRepo, checkResolvedJourney, parseConflicts, resolveConflicts, type HunkChoice, type StatusEntry } from '../git/index.js';
import { parseIntent } from '../intent/index.js';
import { identityVaultFromConfig } from '../identity/index.js';
import { proposeChange, resolveProvider, type ChangeKind, type VcsProvider } from '../vcs/index.js';
import type { StudioApp } from './app.js';
import { HttpError } from './http.js';
import { isSensitive } from './security.js';

export type ScmCategory = 'journey' | 'query' | 'config' | 'other';

export interface ScmEntry extends Omit<StatusEntry, 'path' | 'from'> {
  /** Project-relative path. */
  path: string;
  from?: string;
  category: ScmCategory;
  /** Secrets and EZTest state: listed, but not diffed, blamed or staged from the Studio. */
  sensitive: boolean;
}

const JOURNEY_EXT = new Set(['.ez', '.yaml', '.yml', '.json']);

export function scmCategory(rel: string, journeysDir: string): ScmCategory {
  const p = rel.split('\\').join('/');
  const base = p.split('/').pop() ?? p;
  if (/^eztest\.config\.(ya?ml|json)$/i.test(base) || p.startsWith('config/') || /^readiness-policy\.ya?ml$/i.test(base) || /impact.*\.ya?ml$/i.test(base) || /^\.env/.test(base) || base === 'CODEOWNERS') return 'config';
  if (/\.sql$/i.test(p) || p.startsWith('queries/') || /(^|\/)queries\.ya?ml$/i.test(p)) return 'query';
  const jd = journeysDir.replace(/^\.\//, '').replace(/\/+$/, '');
  if (extname(p).toLowerCase() === '.ez' || (JOURNEY_EXT.has(extname(p).toLowerCase()) && (p === jd || p.startsWith(`${jd}/`)) && !/\.locators\.json$/i.test(p))) return 'journey';
  return 'other';
}

/** Git errors a user can act on: credentials, identity, local changes in the way. */
export function scmError(e: unknown): never {
  if (e instanceof HttpError) throw e;
  if (e instanceof GitError) {
    const t = `${e.message}\n${e.stderr}`;
    if (/terminal prompts disabled|could not read (Username|Password)|Authentication failed|Permission denied \(publickey\)|403|HTTP Basic: Access denied/i.test(t)) {
      throw new HttpError(409, 'git needs credentials for this remote. Set up a credential helper (e.g. Git Credential Manager) or an SSH key in your terminal; EZTest Studio uses your git credentials and never asks for them.', { kind: 'credentials' });
    }
    if (/Please tell me who you are|empty ident/i.test(t)) throw new HttpError(409, 'git does not know who you are: run git config user.name "Your Name" and git config user.email you@example.com', { kind: 'identity' });
    if (/would be overwritten|Please commit your changes or stash them/i.test(t)) throw new HttpError(409, 'Local changes would be overwritten: commit or discard them first.', { kind: 'local-changes' });
    if (e.code === 'GIT_NOT_A_REPO') throw new HttpError(412, 'This project is not inside a git repository (run git init, or clone it).', { kind: 'not-a-repo' });
    if (e.code === 'GIT_MISSING') throw new HttpError(412, 'git is not installed or not on PATH.', { kind: 'no-git' });
    if (e.code?.startsWith('GIT_UNSAFE') || e.code === 'GIT_INVALID' || e.code === 'GIT_EXISTS' || e.code === 'GIT_NOTHING') throw new HttpError(400, e.message);
    throw new HttpError(409, e.message);
  }
  throw e;
}

export async function scmRepo(app: StudioApp): Promise<GitRepo> {
  try {
    return await GitRepo.open(app.cwd, { timeoutMs: 120_000 });
  } catch (e) {
    scmError(e);
  }
}

/** Project-relative (from the repo-relative paths git reports). */
function toProject(repo: GitRepo, app: StudioApp, repoRel: string): string | undefined {
  const abs = resolve(repo.root, repoRel);
  const r = relative(app.cwd, abs);
  if (r.startsWith('..') || resolve(r) === r) return undefined;
  return r.split(sep).join('/');
}

/** A project-relative path from the client, as a repo path (confined to the project). */
function repoPath(repo: GitRepo, app: StudioApp, p: unknown): string {
  if (typeof p !== 'string' || !p) throw new HttpError(400, '"path" is required');
  const abs = app.confine(p);
  return repo.rel(abs);
}

function assertNotSensitive(app: StudioApp, p: string): void {
  if (isSensitive(p)) throw new HttpError(403, 'Secrets and EZTest state files are not shown or changed from the Studio');
}

export async function scmStatus(app: StudioApp) {
  const repo = await scmRepo(app);
  try {
    const st = await repo.status();
    const jd = await app.journeysDir();
    const entries: ScmEntry[] = [];
    let outside = 0;
    for (const e of st.entries) {
      if (e.kind === 'ignored') continue;
      const p = toProject(repo, app, e.path);
      if (!p) {
        outside++;
        continue;
      }
      const from = e.from ? toProject(repo, app, e.from) : undefined;
      entries.push({ ...e, path: p, ...(from ? { from } : {}), category: scmCategory(p, jd), sensitive: isSensitive(p) });
    }
    const remote = await repo.remoteUrl().catch(() => undefined);
    const { branchFilter } = await import('./quality/common.js');
    return {
      root: repo.root === app.cwd ? '.' : relative(repo.root, app.cwd).split(sep).join('/') || '.',
      branch: st.branch,
      operation: st.operation,
      entries,
      outsideProject: outside,
      conflicts: entries.filter((e) => e.conflicted).map((e) => e.path),
      remote: remote ? remote.replace(/\/\/[^@/]+@/, '//') : undefined,
      branchFilter: branchFilter(app) ?? null,
      proposals: proposalsOf(app).list,
    };
  } catch (e) {
    scmError(e);
  }
}

export async function scmDiff(app: StudioApp, p: unknown, staged: boolean) {
  const repo = await scmRepo(app);
  const rp = repoPath(repo, app, p);
  assertNotSensitive(app, String(p));
  try {
    const [hunks, unified] = await Promise.all([repo.wordDiff(rp, { staged }), repo.diff(rp, { staged })]);
    return { path: String(p), staged, hunks, unified, binary: /^Binary files /m.test(unified) };
  } catch (e) {
    scmError(e);
  }
}

export async function scmStage(app: StudioApp, paths: unknown, stage: boolean) {
  const repo = await scmRepo(app);
  if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, '"paths" must list files');
  for (const p of paths) assertNotSensitive(app, String(p));
  const rps = paths.map((p) => repoPath(repo, app, p));
  try {
    if (stage) await repo.stage(rps);
    else await repo.unstage(rps);
  } catch (e) {
    scmError(e);
  }
}

export async function scmDiscard(app: StudioApp, paths: unknown) {
  const repo = await scmRepo(app);
  if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, '"paths" must list files');
  for (const p of paths) assertNotSensitive(app, String(p));
  try {
    await repo.discard(paths.map((p) => repoPath(repo, app, p)));
  } catch (e) {
    scmError(e);
  }
}

export async function scmCommit(app: StudioApp, message: unknown) {
  const repo = await scmRepo(app);
  if (typeof message !== 'string' || !message.trim()) throw new HttpError(400, 'A commit message is required');
  if (message.length > 10_000) throw new HttpError(400, 'The commit message is too long');
  try {
    const staged = await repo.stagedFiles();
    if (!staged.length) throw new HttpError(400, 'Nothing is staged: stage the files to commit first');
    const sha = await repo.commit(message);
    return { sha, files: staged.length, subject: message.split('\n')[0] };
  } catch (e) {
    scmError(e);
  }
}

export async function scmBranches(app: StudioApp) {
  const repo = await scmRepo(app);
  try {
    return { current: await repo.currentBranch(), branches: await repo.branches() };
  } catch (e) {
    scmError(e);
  }
}

export async function scmBranchOp(app: StudioApp, op: 'create' | 'switch', name: unknown, from?: unknown) {
  const repo = await scmRepo(app);
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'A branch name is required');
  try {
    if (op === 'create') await repo.createBranch(name.trim(), { checkout: true, ...(typeof from === 'string' && from ? { from } : {}) });
    else await repo.switchBranch(name.trim());
    return { current: await repo.currentBranch() };
  } catch (e) {
    scmError(e);
  }
}

export async function scmSync(app: StudioApp, op: 'pull' | 'push') {
  const repo = await scmRepo(app);
  try {
    if (op === 'pull') return await repo.pull();
    const branch = await repo.currentBranch();
    const up = await repo.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { okCodes: [128] });
    return { output: await repo.push({ branch, setUpstream: up.code !== 0 }) };
  } catch (e) {
    scmError(e);
  }
}

export async function scmLog(app: StudioApp, p: unknown, max = 50) {
  const repo = await scmRepo(app);
  const rp = typeof p === 'string' && p ? repoPath(repo, app, p) : undefined;
  if (rp) assertNotSensitive(app, String(p));
  try {
    return { path: p ?? null, commits: await repo.log({ path: rp, max }) };
  } catch (e) {
    scmError(e);
  }
}

/** Blame of a journey with the step each line belongs to ("who changed this step and when"). */
export async function scmBlame(app: StudioApp, p: unknown) {
  const repo = await scmRepo(app);
  const rp = repoPath(repo, app, p);
  assertNotSensitive(app, String(p));
  try {
    const lines = await repo.blame(rp);
    const isEz = /\.ez$/i.test(rp);
    return {
      path: p,
      lines: lines.map((l) => {
        let stepId: string | undefined;
        const t = l.text.trim();
        if (isEz && t && !t.startsWith('#') && !/^[A-Za-z ]+:\s/.test(t)) {
          try {
            stepId = parseIntent(t).id;
          } catch {
            stepId = undefined;
          }
        }
        return { ...l, ...(stepId ? { stepId } : {}) };
      }),
    };
  } catch (e) {
    scmError(e);
  }
}

export async function scmConflict(app: StudioApp, p: unknown) {
  const repo = await scmRepo(app);
  const rp = repoPath(repo, app, p);
  assertNotSensitive(app, String(p));
  try {
    const v = await repo.conflictVersions(rp);
    let parsed;
    try {
      parsed = parseConflicts(v.working);
    } catch (e) {
      throw new HttpError(422, (e as Error).message);
    }
    return { path: p, base: v.base ?? null, ours: v.ours ?? null, theirs: v.theirs ?? null, hash: parsed.hash, hunks: parsed.hunks, parts: parsed.parts.length };
  } catch (e) {
    scmError(e);
  }
}

/** Resolve a conflicted file: apply the choices, check the result is a valid journey, write it and stage it. */
export async function scmResolve(app: StudioApp, p: unknown, choices: unknown, hash: unknown, opts: { preview?: boolean } = {}) {
  const repo = await scmRepo(app);
  const rp = repoPath(repo, app, p);
  assertNotSensitive(app, String(p));
  const abs = join(repo.root, rp);
  const working = existsSync(abs) ? await readFile(abs, 'utf8') : '';
  const parsed = parseConflicts(working);
  if (!opts.preview && hash !== parsed.hash) throw new HttpError(409, 'The file changed since the conflict was loaded; reload it');
  if (!choices || typeof choices !== 'object') throw new HttpError(400, '"choices" must map hunk index to ours, theirs, both, base or {text}');
  const ch: Record<number, HunkChoice> = {};
  for (const [k, v] of Object.entries(choices as Record<string, unknown>)) {
    const i = Number(k);
    if (!Number.isInteger(i) || !parsed.hunks[i]) throw new HttpError(400, `No conflict hunk ${k}`);
    if (v === 'ours' || v === 'theirs' || v === 'both' || v === 'theirs-then-ours' || v === 'base') ch[i] = v;
    else if (v && typeof v === 'object' && typeof (v as { text?: unknown }).text === 'string') ch[i] = { text: (v as { text: string }).text };
    else throw new HttpError(400, `Invalid choice for hunk ${k}`);
  }
  const result = resolveConflicts(parsed, ch);
  const check = checkResolvedJourney(rp, result);
  if (opts.preview) return { result, check, resolved: Object.keys(ch).length, total: parsed.hunks.length };
  if (Object.keys(ch).length < parsed.hunks.length) throw new HttpError(400, `Resolve every conflict first (${parsed.hunks.length - Object.keys(ch).length} left)`);
  if (!check.ok) throw new HttpError(422, `The resolved file is not a valid journey: ${check.error}`, { check });
  await writeFile(abs, result);
  try {
    await repo.stage([rp]);
  } catch (e) {
    scmError(e);
  }
  return { result, check, staged: true };
}

// ------------------------------------------------------------------ change proposals (heal / baseline / quarantine PRs)

export interface Proposal {
  id: string;
  kind: ChangeKind;
  title: string;
  files: string[];
  at: string;
  /** Set once a PR (or a local branch) was created for it. */
  done?: { branch: string; url?: string; number?: number; pushed: boolean };
  error?: string;
}

const proposalState = new WeakMap<StudioApp, { list: Proposal[]; attached: boolean }>();

function proposalsOf(app: StudioApp) {
  let s = proposalState.get(app);
  if (!s) {
    s = { list: [], attached: false };
    proposalState.set(app, s);
  }
  return s;
}

async function providerFor(app: StudioApp): Promise<VcsProvider | undefined> {
  const loaded = await app.config();
  const vcs = loaded.config.vcs;
  let token: string | undefined;
  if (vcs.token) {
    const vault = identityVaultFromConfig(loaded.config, { cwd: app.cwd, masker: loaded.masker, env: app.env });
    token = vcs.token.startsWith('secret://') ? await vault.registry.resolve(vcs.token) : vcs.token;
  }
  try {
    const r = await resolveProvider({
      cwd: app.cwd,
      env: app.env,
      provider: vcs.provider,
      hosts: vcs.hosts,
      apiUrl: vcs.apiUrl,
      token,
      adoRepository: loaded.config.ado.repository,
      adoClient: async () => {
        const { adoClientFromConfig } = await import('../alm-ado/index.js');
        const vault = identityVaultFromConfig(loaded.config, { cwd: app.cwd, masker: loaded.masker, env: app.env });
        return adoClientFromConfig(loaded.config, { env: app.env, masker: loaded.masker, resolveSecret: (x) => vault.registry.resolve(x) });
      },
    });
    return r.provider;
  } catch {
    return undefined;
  }
}

/** Open a branch + commit + PR for a proposal (or for given files). */
export async function proposePullRequest(app: StudioApp, input: { id?: string; kind?: ChangeKind; files?: string[]; title?: string; body?: string; by?: string; draft?: boolean; push?: boolean }) {
  const st = proposalsOf(app);
  const prop = input.id ? st.list.find((x) => x.id === input.id) : undefined;
  if (input.id && !prop) throw new HttpError(404, 'No such proposal');
  const kind = prop?.kind ?? input.kind ?? 'journey';
  const files = prop?.files ?? input.files ?? [];
  if (!files.length) throw new HttpError(400, 'No files to propose');
  const loaded = await app.config().catch(() => undefined);
  const pr = loaded?.config.vcs.pullRequests;
  const provider = input.push === false ? undefined : await providerFor(app);
  const title = input.title ?? prop?.title ?? `EZTest: ${kind} change`;
  const body = `${input.body ?? 'Proposed from EZTest Studio.'}${input.by ? `\n\nRequested by ${input.by}.` : ''}\n\nFiles:\n${files.map((f) => `- \`${f}\``).join('\n')}`;
  try {
    const r = await proposeChange({ cwd: app.cwd, kind, files: files.map((f) => app.confine(f)), title, body, provider, target: pr?.target, draft: input.draft ?? pr?.draft, push: input.push });
    if (prop) prop.done = { branch: r.branch, url: r.pr?.url, number: r.pr?.number, pushed: r.pushed };
    app.hub.publish('scm', { type: 'proposal', id: prop?.id, branch: r.branch, url: r.pr?.url });
    return { ...r, reviewers: r.reviewers.map((x) => x.raw) };
  } catch (e) {
    if (prop) prop.error = (e as Error).message;
    scmError(e);
  }
}

function addProposal(app: StudioApp, kind: ChangeKind, title: string, files: string[]): Proposal {
  const p: Proposal = { id: randomBytes(6).toString('hex'), kind, title, files, at: new Date().toISOString() };
  const st = proposalsOf(app);
  st.list.unshift(p);
  st.list.splice(50);
  app.hub.publish('scm', { type: 'proposal-added', id: p.id, kind });
  return p;
}

/**
 * Listen for Studio actions that write files the team reviews in a PR: an
 * accepted heal, approved baselines, a quarantine change. Each becomes a
 * proposal on the Source Control page; with `vcs.pullRequests.on*` it is
 * opened as a PR right away.
 */
export function attachScm(app: StudioApp): void {
  const st = proposalsOf(app);
  if (st.attached) return;
  st.attached = true;
  app.hub.registerTopic('scm', { replay: 50, description: 'Source control changes and pull request proposals' });
  const off = app.hub.subscribe((e) => {
    const d = e.data as { type: string; action?: string; files?: unknown[]; count?: number; names?: unknown[]; journeyId?: string };
    void (async () => {
      let p: Proposal | undefined;
      let auto = false;
      const cfg = (await app.config().catch(() => undefined))?.config.vcs.pullRequests;
      if (e.topic === 'quality' && d.type === 'heals' && d.action === 'accepted') {
        const files = (d.files ?? []).filter((f): f is string => typeof f === 'string');
        if (!files.length) return;
        p = addProposal(app, 'heal', `EZTest: accept ${Number(d.count ?? 1)} reviewed heal(s)`, files);
        auto = !!cfg?.onHealAccept;
      } else if (e.topic === 'assurance' && d.type === 'baselines-approved') {
        const names = (d.names ?? []).filter((n): n is string => typeof n === 'string' && /^[A-Za-z0-9_.-]+$/.test(n));
        if (!names.length) return;
        const { branchSlug, currentBranchSync } = await import('../git/branch.js');
        const shared = join('.eztest', 'baselines');
        const b = currentBranchSync(app.cwd, app.env);
        const dir = b && existsSync(join(app.cwd, shared, 'branches', branchSlug(b))) ? join(shared, 'branches', branchSlug(b)) : shared;
        p = addProposal(app, 'baseline', `EZTest: approve ${names.length} visual baseline(s)`, names.map((n) => join(dir, `${n}.png`).split(sep).join('/')));
        auto = !!cfg?.onBaselineApprove;
      } else if (e.topic === 'quality' && d.type === 'quarantine') {
        const j = String(d.journeyId ?? '');
        const q = (await import('./quality/common.js')).qualityPaths;
        const file = relative(app.cwd, (await q(app)).quarantine).split(sep).join('/');
        p = addProposal(app, 'quarantine', `EZTest: ${d.action === 'removed' ? 'release' : 'quarantine'} ${j}`, [file]);
        auto = !!cfg?.onQuarantine;
      }
      if (p && auto) await proposePullRequest(app, { id: p.id }).catch(() => undefined);
    })();
  }, ['quality', 'assurance']);
  app.onClose(off);
}

export function listProposals(app: StudioApp): Proposal[] {
  return proposalsOf(app).list;
}
