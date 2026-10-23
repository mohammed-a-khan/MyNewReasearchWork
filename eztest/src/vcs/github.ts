/**
 * GitHub (github.com and GitHub Enterprise Server) through its REST API:
 * check runs with line annotations (falls back to a commit status when the
 * token cannot create checks), one PR comment updated in place, pull
 * requests with reviewers and team reviewers.
 */
import type { Owner } from '../git/codeowners.js';
import { VcsHttp, VcsHttpError } from './http.js';
import type { CommentResult, PullRequestInput, PullRequestResult, RepoRef, StatusInput, StatusResult, VcsProvider } from './types.js';

export interface GitHubOptions {
  repo: RepoRef;
  token: string;
  /** API base, default https://api.github.com (GHES: https://<host>/api/v3). */
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function githubApiUrl(host: string): string {
  return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
}

export class GitHubProvider implements VcsProvider {
  readonly kind = 'github' as const;
  readonly repo: RepoRef;
  private readonly http: VcsHttp;
  private readonly base: string;

  constructor(o: GitHubOptions) {
    this.repo = o.repo;
    this.http = new VcsHttp({
      baseUrl: o.apiUrl ?? githubApiUrl(o.repo.host),
      auth: ['authorization', `Bearer ${o.token}`],
      secrets: [o.token],
      extraHeaders: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      fetchImpl: o.fetchImpl,
      sleep: o.sleep,
    });
    this.base = `/repos/${encodeURIComponent(o.repo.owner)}/${encodeURIComponent(o.repo.repo)}`;
  }

  redact(s: string): string {
    return this.http.redact(s);
  }

  async setStatus(s: StatusInput): Promise<StatusResult> {
    const warnings: string[] = [];
    const ann = (s.annotations ?? []).map((a) => ({
      path: a.path,
      start_line: a.line,
      end_line: a.endLine ?? a.line,
      annotation_level: a.level,
      title: a.title.slice(0, 255),
      message: a.message.slice(0, 64_000),
    }));
    const conclusion = s.state === 'success' ? 'success' : s.state === 'pending' ? undefined : s.state === 'error' ? 'action_required' : 'failure';
    try {
      // Re-runs update the same check run (by name on the commit) instead of adding another.
      const existing = await this.http.request<{ check_runs: Array<{ id: number; name: string }> }>('GET', `${this.base}/commits/${encodeURIComponent(s.sha)}/check-runs`, { query: { check_name: s.context, filter: 'latest' } });
      const id = existing.data.check_runs?.find((c) => c.name === s.context)?.id;
      const output = { title: s.description.slice(0, 255), summary: (s.summary ?? s.description).slice(0, 65_000), annotations: ann.slice(0, 50) };
      const body = {
        name: s.context,
        head_sha: s.sha,
        status: conclusion ? 'completed' : 'in_progress',
        ...(conclusion ? { conclusion, completed_at: new Date().toISOString() } : {}),
        ...(s.targetUrl ? { details_url: s.targetUrl } : {}),
        output,
      };
      const r = id
        ? await this.http.request<{ id: number }>('PATCH', `${this.base}/check-runs/${id}`, { body, idempotent: true })
        : await this.http.request<{ id: number }>('POST', `${this.base}/check-runs`, { body });
      // The API takes at most 50 annotations per request: send the rest in further updates.
      for (let i = 50; i < ann.length; i += 50) {
        await this.http.request('PATCH', `${this.base}/check-runs/${r.data.id}`, { body: { output: { ...output, annotations: ann.slice(i, i + 50) } }, idempotent: true });
      }
      return { kind: 'check-run', id: r.data.id, annotations: ann.length, warnings };
    } catch (e) {
      if (!(e instanceof VcsHttpError) || (e.status !== 403 && e.status !== 404)) throw e;
      warnings.push(`check runs not available with this token (HTTP ${e.status}); posted a commit status without annotations`);
    }
    const r = await this.http.request<{ id: number }>('POST', `${this.base}/statuses/${encodeURIComponent(s.sha)}`, {
      body: { state: s.state, context: s.context, description: s.description.slice(0, 140), ...(s.targetUrl ? { target_url: s.targetUrl } : {}) },
      idempotent: true,
    });
    return { kind: 'commit-status', id: r.data.id, annotations: 0, warnings };
  }

  async upsertComment(pr: number, marker: string, body: string): Promise<CommentResult> {
    const text = `${marker}\n${body}`;
    const comments = await this.http.getAll<{ id: number; body: string }>(`${this.base}/issues/${pr}/comments`, { per_page: 100 });
    const mine = comments.find((c) => c.body?.includes(marker));
    if (mine) {
      if (mine.body === text) return { id: mine.id, action: 'unchanged' };
      await this.http.request('PATCH', `${this.base}/issues/comments/${mine.id}`, { body: { body: text }, idempotent: true });
      return { id: mine.id, action: 'updated' };
    }
    const r = await this.http.request<{ id: number }>('POST', `${this.base}/issues/${pr}/comments`, { body: { body: text } });
    return { id: r.data.id, action: 'created' };
  }

  async findPullRequest(source: string): Promise<{ number: number; url: string } | undefined> {
    const r = await this.http.request<Array<{ number: number; html_url: string }>>('GET', `${this.base}/pulls`, { query: { head: `${this.repo.owner}:${source}`, state: 'open' } });
    const p = r.data?.[0];
    return p ? { number: p.number, url: p.html_url } : undefined;
  }

  async createPullRequest(p: PullRequestInput): Promise<PullRequestResult> {
    const warnings: string[] = [];
    const existing = await this.findPullRequest(p.source);
    const pr = existing
      ? { number: existing.number, html_url: existing.url }
      : (await this.http.request<{ number: number; html_url: string }>('POST', `${this.base}/pulls`, { body: { title: p.title, head: p.source, base: p.target, body: p.description, draft: !!p.draft } })).data;
    const { users, teams, skipped } = splitOwners(p.reviewers ?? []);
    for (const s of skipped) warnings.push(`reviewer ${s} is not a GitHub user or team; not requested`);
    const reviewers: string[] = [];
    if (users.length || teams.length) {
      try {
        await this.http.request('POST', `${this.base}/pulls/${pr.number}/requested_reviewers`, { body: { reviewers: users, team_reviewers: teams } });
        reviewers.push(...users, ...teams.map((t) => `${this.repo.owner}/${t}`));
      } catch (e) {
        warnings.push(`requesting reviewers failed: ${(e as Error).message}`);
      }
    }
    return { number: pr.number, url: pr.html_url, reviewers, warnings };
  }
}

function splitOwners(owners: Owner[]): { users: string[]; teams: string[]; skipped: string[] } {
  const users: string[] = [];
  const teams: string[] = [];
  const skipped: string[] = [];
  for (const o of owners) {
    if (o.kind === 'user') users.push(o.name);
    else if (o.kind === 'team') teams.push(o.name.split('/').slice(1).join('/'));
    else skipped.push(o.raw);
  }
  return { users, teams, skipped };
}
