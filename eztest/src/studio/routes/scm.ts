/** Source Control routes (`/api/scm/*`): see src/studio/scm.ts and docs/git.md. */
import { gitDirOf } from '../../git/branch.js';
import { HttpError, sendJson } from '../http.js';
import { assertIdle, publishQuality, requireConfirm, setBranchFilter } from '../quality/common.js';
import {
  listProposals,
  proposePullRequest,
  scmBlame,
  scmBranchOp,
  scmBranches,
  scmCommit,
  scmConflict,
  scmDiff,
  scmDiscard,
  scmLog,
  scmResolve,
  scmStage,
  scmStatus,
  scmSync,
} from '../scm.js';
import type { StudioRoute } from './route.js';

const changed = (app: Parameters<StudioRoute['handler']>[0]['app'], type: string) => app.hub.publish('scm', { type });

export const scmRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/scm/status',
    summary: 'Git status of the project: journeys, queries, config; branch, upstream, conflicts, proposals',
    async handler({ res, app }) {
      sendJson(res, 200, await scmStatus(app));
    },
  },
  {
    method: 'GET',
    path: '/api/scm/summary',
    summary: 'Branch, change and conflict counts for the status bar (repo: false outside a git repository)',
    async handler({ res, app }) {
      // Polled by the status bar on every page: answer outside git without spawning it.
      if (!app.env.GIT_DIR && !gitDirOf(app.cwd)) return sendJson(res, 200, { repo: false, reason: 'not a git repository' });
      try {
        const s = await scmStatus(app);
        sendJson(res, 200, { repo: true, branch: s.branch.head ?? null, changes: s.entries.length, conflicts: s.conflicts.length, ahead: s.branch.ahead, behind: s.branch.behind });
      } catch (e) {
        if (e instanceof HttpError && e.status === 412) sendJson(res, 200, { repo: false, reason: e.message });
        else throw e;
      }
    },
  },
  {
    method: 'GET',
    path: '/api/scm/diff',
    summary: 'Word-level and unified diff of one file (?path=&staged=1)',
    async handler({ res, app, query }) {
      sendJson(res, 200, await scmDiff(app, query.get('path'), query.get('staged') === '1' || query.get('staged') === 'true'));
    },
  },
  {
    method: 'POST',
    path: '/api/scm/stage',
    summary: 'Stage files',
    async handler({ res, app, body }) {
      await scmStage(app, body.paths, true);
      changed(app, 'staged');
      sendJson(res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    path: '/api/scm/unstage',
    summary: 'Unstage files',
    async handler({ res, app, body }) {
      await scmStage(app, body.paths, false);
      changed(app, 'unstaged');
      sendJson(res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    path: '/api/scm/discard',
    summary: 'Discard working-tree changes of tracked files (needs confirm)',
    async handler({ res, app, body }) {
      requireConfirm(body);
      await scmDiscard(app, body.paths);
      changed(app, 'discarded');
      sendJson(res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    path: '/api/scm/commit',
    summary: 'Commit what is staged (git config user.name / user.email are the author)',
    async handler({ res, app, body }) {
      const r = await scmCommit(app, body.message);
      changed(app, 'committed');
      sendJson(res, 200, r);
    },
  },
  {
    method: 'GET',
    path: '/api/scm/branches',
    summary: 'Local and remote branches',
    async handler({ res, app }) {
      sendJson(res, 200, await scmBranches(app));
    },
  },
  {
    method: 'POST',
    path: '/api/scm/branch',
    summary: 'Create a branch and switch to it',
    async handler({ res, app, body }) {
      assertIdle(app);
      const r = await scmBranchOp(app, 'create', body.name, body.from);
      changed(app, 'branch');
      sendJson(res, 200, r);
    },
  },
  {
    method: 'POST',
    path: '/api/scm/switch',
    summary: 'Switch branches (refused when local changes would be overwritten)',
    async handler({ res, app, body }) {
      assertIdle(app);
      const r = await scmBranchOp(app, 'switch', body.name);
      changed(app, 'branch');
      sendJson(res, 200, r);
    },
  },
  {
    method: 'POST',
    path: '/api/scm/pull',
    summary: 'Pull (merge) from the upstream with your git credentials; reports conflicts',
    async handler({ res, app }) {
      assertIdle(app);
      const r = await scmSync(app, 'pull');
      changed(app, 'pulled');
      sendJson(res, 200, r);
    },
  },
  {
    method: 'POST',
    path: '/api/scm/push',
    summary: 'Push the current branch (sets the upstream the first time)',
    async handler({ res, app }) {
      const r = await scmSync(app, 'push');
      changed(app, 'pushed');
      sendJson(res, 200, r);
    },
  },
  {
    method: 'GET',
    path: '/api/scm/log',
    summary: 'History of the project or of one file (?path=)',
    async handler({ res, app, query }) {
      sendJson(res, 200, await scmLog(app, query.get('path') ?? undefined, Math.min(200, Number(query.get('max') ?? 50) || 50)));
    },
  },
  {
    method: 'GET',
    path: '/api/scm/blame',
    summary: 'Blame of a journey, each line with its step id',
    async handler({ res, app, query }) {
      sendJson(res, 200, await scmBlame(app, query.get('path')));
    },
  },
  {
    method: 'GET',
    path: '/api/scm/conflict',
    summary: 'The conflict hunks of a file with base / ours / theirs',
    async handler({ res, app, query }) {
      sendJson(res, 200, await scmConflict(app, query.get('path')));
    },
  },
  {
    method: 'POST',
    path: '/api/scm/resolve',
    summary: 'Resolve a conflicted journey (preview, or write + stage after the journey validates)',
    async handler({ res, app, body }) {
      const preview = body.preview === true;
      if (!preview) {
        requireConfirm(body);
        assertIdle(app);
      }
      const r = await scmResolve(app, body.path, body.choices, body.hash, { preview });
      if (!preview) changed(app, 'resolved');
      sendJson(res, 200, r);
    },
  },
  {
    method: 'GET',
    path: '/api/scm/branch-filter',
    summary: 'The Quality Center branch filter',
    async handler({ res, app }) {
      const { branchFilter } = await import('../quality/common.js');
      sendJson(res, 200, { branch: branchFilter(app) ?? null });
    },
  },
  {
    method: 'POST',
    path: '/api/scm/branch-filter',
    summary: 'Filter the Quality Center (runs, history, flaky scores) by branch; null clears it',
    async handler({ res, app, body }) {
      const b = body.branch;
      if (b !== null && b !== undefined && (typeof b !== 'string' || b.length > 250)) throw new HttpError(400, '"branch" must be a branch name or null');
      setBranchFilter(app, typeof b === 'string' && b ? b : undefined);
      publishQuality(app, 'branch-filter', { branch: b ?? null });
      sendJson(res, 200, { branch: b || null });
    },
  },
  {
    method: 'GET',
    path: '/api/scm/proposals',
    summary: 'Changes from heal review, baseline approval and quarantine that can become pull requests',
    async handler({ res, app }) {
      sendJson(res, 200, { proposals: listProposals(app) });
    },
  },
  {
    method: 'POST',
    path: '/api/scm/propose',
    summary: 'Create a branch + commit + pull request for a proposal or files (working tree untouched; reviewers from CODEOWNERS)',
    async handler({ res, app, body }) {
      requireConfirm(body);
      const files = Array.isArray(body.files) ? body.files.map(String) : undefined;
      const r = await proposePullRequest(app, {
        id: typeof body.id === 'string' ? body.id : undefined,
        kind: typeof body.kind === 'string' ? (body.kind as never) : undefined,
        files,
        title: typeof body.title === 'string' ? body.title.slice(0, 200) : undefined,
        body: typeof body.body === 'string' ? body.body.slice(0, 4000) : undefined,
        by: typeof body.by === 'string' ? body.by.slice(0, 120) : undefined,
        draft: body.draft === true,
        push: body.push !== false,
      });
      sendJson(res, 200, r);
    },
  },
];
