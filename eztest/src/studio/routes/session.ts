/** Session info, git branch, and API discoverability (`/api/routes`, `/api/topics`). */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { BROWSER_ENGINES, BROWSER_TARGETS } from '../../core/browsers.js';
import { sendJson } from '../http.js';
import type { StudioRoute } from './route.js';

/** Current git branch of the project, read from `.git/HEAD` (no git process is started). */
export function gitBranch(cwd: string): string | undefined {
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    const git = join(dir, '.git');
    if (existsSync(git)) {
      try {
        let gitDir = git;
        if (statSync(git).isFile()) {
          // Worktrees and submodules: ".git" is a file "gitdir: <path>".
          const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(git, 'utf8'));
          if (!m) return undefined;
          gitDir = m[1].trim().startsWith('/') || /^[A-Za-z]:/.test(m[1].trim()) ? m[1].trim() : join(dir, m[1].trim());
        }
        const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        return ref ? ref[1] : head.slice(0, 12);
      } catch {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export const sessionRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/session',
    summary: 'Project name, journeys dir, active run/recording, git branch',
    async handler({ res, app }) {
      const cur = app.runs.current;
      sendJson(res, 200, {
        project: app.cwd.split(sep).pop(),
        journeysDir: await app.journeysDir(),
        run: cur?.id,
        runState: cur?.state,
        recording: app.recorder.current?.state === 'recording',
        branch: gitBranch(app.cwd),
        node: process.versions.node,
        watching: app.watcher?.mode,
        lastEventSeq: app.hub.lastSeq,
        // The browsers the Run and Debug pages offer (EZTest's supported browsers; no WebKit).
        browsers: { engines: BROWSER_ENGINES, targets: BROWSER_TARGETS },
      });
    },
  },
  {
    method: 'GET',
    path: '/api/topics',
    summary: 'Event hub topics',
    handler({ res, app }) {
      sendJson(res, 200, { topics: app.hub.topicNames(), lastSeq: app.hub.lastSeq });
    },
  },
];
