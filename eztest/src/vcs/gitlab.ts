/**
 * GitLab (gitlab.com and self-managed) through REST API v4: commit statuses,
 * one merge request note updated in place, merge requests with reviewers
 * (usernames resolved to user ids), and line annotations as unresolved MR
 * diff discussions on the failing journey lines (one per line, reused on
 * re-runs) plus a Code Quality report for the MR widget.
 */
import type { Owner } from '../git/codeowners.js';
import { VcsHttp } from './http.js';
import type { Annotation, CommentResult, PullRequestInput, PullRequestResult, RepoRef, StatusInput, StatusResult, VcsProvider } from './types.js';

export interface GitLabOptions {
  repo: RepoRef;
  token: string;
  /** "private" (PRIVATE-TOKEN, a personal/project access token) or "job" (CI_JOB_TOKEN, limited) or "oauth" (Bearer). */
  tokenType?: 'private' | 'job' | 'oauth';
  /** API base, default https://<host>/api/v4 (CI_API_V4_URL in GitLab CI). */
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class GitLabProvider implements VcsProvider {
  readonly kind = 'gitlab' as const;
  readonly repo: RepoRef;
  private readonly http: VcsHttp;
  private readonly base: string;

  constructor(o: GitLabOptions) {
    this.repo = o.repo;
    const t = o.tokenType ?? 'private';
    this.http = new VcsHttp({
      baseUrl: o.apiUrl ?? `https://${o.repo.host}/api/v4`,
      auth: t === 'oauth' ? ['authorization', `Bearer ${o.token}`] : t === 'job' ? ['job-token', o.token] : ['private-token', o.token],
      secrets: [o.token],
      fetchImpl: o.fetchImpl,
      sleep: o.sleep,
    });
    this.base = `/projects/${encodeURIComponent(o.repo.project ?? `${o.repo.owner}/${o.repo.repo}`)}`;
  }

  redact(s: string): string {
    return this.http.redact(s);
  }

  async setStatus(s: StatusInput): Promise<StatusResult> {
    const state = s.state === 'success' ? 'success' : s.state === 'pending' ? 'running' : 'failed';
    const r = await this.http.request<{ id: number }>('POST', `${this.base}/statuses/${encodeURIComponent(s.sha)}`, {
      query: { state, name: s.context, description: s.description.slice(0, 255), ...(s.targetUrl ? { target_url: s.targetUrl } : {}) },
      idempotent: true,
    });
    const warnings: string[] = [];
    let annotations = 0;
    if (s.pr && s.annotations?.length) {
      try {
        annotations = await this.annotate(s.pr, s.sha, s.annotations);
      } catch (e) {
        warnings.push(`MR line discussions not posted: ${(e as Error).message}`);
      }
    }
    return { kind: 'commit-status', id: r.data?.id, annotations, warnings };
  }

  /** One unresolved diff discussion per failing line, found again by its marker on re-runs. */
  private async annotate(iid: number, sha: string, list: Annotation[]): Promise<number> {
    const versions = await this.http.request<Array<{ base_commit_sha: string; head_commit_sha: string; start_commit_sha: string }>>('GET', `${this.base}/merge_requests/${iid}/versions`);
    const v = versions.data?.[0];
    if (!v) return 0;
    const discussions = await this.http.getAll<{ id: string; notes: Array<{ id: number; body: string }> }>(`${this.base}/merge_requests/${iid}/discussions`, { per_page: 100 });
    let n = 0;
    for (const a of list) {
      const marker = `<!-- eztest:annotation ${a.path}:${a.line} -->`;
      const body = `${marker}\n**EZTest ${a.level}: ${a.title}**\n\n${a.message}`;
      const found = discussions.find((d) => d.notes?.[0]?.body?.includes(marker));
      if (found) {
        if (found.notes[0].body !== body) await this.http.request('PUT', `${this.base}/merge_requests/${iid}/discussions/${found.id}/notes/${found.notes[0].id}`, { body: { body } });
      } else {
        await this.http.request('POST', `${this.base}/merge_requests/${iid}/discussions`, {
          body: { body, position: { position_type: 'text', base_sha: v.base_commit_sha, start_sha: v.start_commit_sha, head_sha: v.head_commit_sha ?? sha, new_path: a.path, old_path: a.path, new_line: a.line } },
        });
      }
      n++;
    }
    return n;
  }

  async upsertComment(pr: number, marker: string, body: string): Promise<CommentResult> {
    const text = `${marker}\n${body}`;
    const notes = await this.http.getAll<{ id: number; body: string; system?: boolean }>(`${this.base}/merge_requests/${pr}/notes`, { per_page: 100, sort: 'asc' });
    const mine = notes.find((n) => !n.system && n.body?.includes(marker));
    if (mine) {
      if (mine.body === text) return { id: mine.id, action: 'unchanged' };
      await this.http.request('PUT', `${this.base}/merge_requests/${pr}/notes/${mine.id}`, { body: { body: text } });
      return { id: mine.id, action: 'updated' };
    }
    const r = await this.http.request<{ id: number }>('POST', `${this.base}/merge_requests/${pr}/notes`, { body: { body: text } });
    return { id: r.data.id, action: 'created' };
  }

  async findPullRequest(source: string): Promise<{ number: number; url: string } | undefined> {
    const r = await this.http.request<Array<{ iid: number; web_url: string }>>('GET', `${this.base}/merge_requests`, { query: { source_branch: source, state: 'opened' } });
    const m = r.data?.[0];
    return m ? { number: m.iid, url: m.web_url } : undefined;
  }

  private async userIds(owners: Owner[], warnings: string[]): Promise<{ ids: number[]; names: string[] }> {
    const ids: number[] = [];
    const names: string[] = [];
    for (const o of owners) {
      if (o.kind !== 'user' && o.kind !== 'email') {
        warnings.push(`reviewer ${o.raw}: groups cannot be MR reviewers; not requested`);
        continue;
      }
      const r = await this.http.request<Array<{ id: number; username: string }>>('GET', '/users', { query: o.kind === 'user' ? { username: o.name } : { search: o.name } });
      const u = r.data?.[0];
      if (u) {
        ids.push(u.id);
        names.push(u.username);
      } else warnings.push(`reviewer ${o.raw} not found on GitLab`);
    }
    return { ids, names };
  }

  async createPullRequest(p: PullRequestInput): Promise<PullRequestResult> {
    const warnings: string[] = [];
    const existing = await this.findPullRequest(p.source);
    const { ids, names } = await this.userIds(p.reviewers ?? [], warnings);
    if (existing) {
      if (ids.length) await this.http.request('PUT', `${this.base}/merge_requests/${existing.number}`, { body: { reviewer_ids: ids } });
      return { number: existing.number, url: existing.url, reviewers: names, warnings };
    }
    const r = await this.http.request<{ iid: number; web_url: string }>('POST', `${this.base}/merge_requests`, {
      body: { source_branch: p.source, target_branch: p.target, title: p.draft ? `Draft: ${p.title}` : p.title, description: p.description, remove_source_branch: true, ...(ids.length ? { reviewer_ids: ids } : {}) },
    });
    return { number: r.data.iid, url: r.data.web_url, reviewers: names, warnings };
  }
}

/** GitLab Code Quality report (artifacts:reports:codequality) for annotations: shown inline in the MR diff. */
export function gitlabCodeQuality(annotations: Annotation[]): Array<Record<string, unknown>> {
  return annotations.map((a) => ({
    description: `${a.title}: ${a.message}`.slice(0, 1000),
    check_name: 'eztest',
    fingerprint: Buffer.from(`${a.path}:${a.line}:${a.title}`).toString('base64url').slice(0, 64),
    severity: a.level === 'failure' ? 'major' : a.level === 'warning' ? 'minor' : 'info',
    location: { path: a.path, lines: { begin: a.line } },
  }));
}
