/**
 * Bitbucket Cloud through REST API 2.0: commit build statuses, Code Insights
 * reports with line annotations on the failing journeys, one PR comment
 * updated in place, pull requests with reviewers resolved from workspace
 * members (nickname, account id or e-mail-like display name).
 */
import type { Owner } from '../git/codeowners.js';
import { VcsHttp } from './http.js';
import type { CommentResult, PullRequestInput, PullRequestResult, RepoRef, StatusInput, StatusResult, VcsProvider } from './types.js';

export interface BitbucketOptions {
  repo: RepoRef;
  /** Repository/workspace access token (Bearer) ... */
  token?: string;
  /** ... or a username + app password (Basic). */
  username?: string;
  appPassword?: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const REPORT_ID = 'eztest';

export class BitbucketProvider implements VcsProvider {
  readonly kind = 'bitbucket' as const;
  readonly repo: RepoRef;
  private readonly http: VcsHttp;
  private readonly base: string;

  constructor(o: BitbucketOptions) {
    this.repo = o.repo;
    let auth: [string, string];
    if (o.token) auth = ['authorization', `Bearer ${o.token}`];
    else if (o.username && o.appPassword) auth = ['authorization', `Basic ${Buffer.from(`${o.username}:${o.appPassword}`).toString('base64')}`];
    else throw new Error('Bitbucket needs a token or a username and app password');
    this.http = new VcsHttp({ baseUrl: o.apiUrl ?? 'https://api.bitbucket.org/2.0', auth, secrets: [o.token ?? '', o.appPassword ?? '', `${o.username}:${o.appPassword}`], fetchImpl: o.fetchImpl, sleep: o.sleep });
    this.base = `/repositories/${encodeURIComponent(o.repo.owner)}/${encodeURIComponent(o.repo.repo)}`;
  }

  redact(s: string): string {
    return this.http.redact(s);
  }

  async setStatus(s: StatusInput): Promise<StatusResult> {
    const state = s.state === 'success' ? 'SUCCESSFUL' : s.state === 'pending' ? 'INPROGRESS' : 'FAILED';
    const warnings: string[] = [];
    await this.http.request('POST', `${this.base}/commit/${encodeURIComponent(s.sha)}/statuses/build`, {
      body: { key: s.context.toUpperCase().replace(/[^A-Z0-9_-]/g, '-'), state, name: s.context, description: s.description.slice(0, 255), url: s.targetUrl ?? 'https://bitbucket.org' },
      idempotent: true,
    });
    if (s.state === 'pending') return { kind: 'commit-status', annotations: 0, warnings };
    // Code Insights: PUT replaces the report (and drops its old annotations) on every re-run.
    const report = `${this.base}/commit/${encodeURIComponent(s.sha)}/reports/${REPORT_ID}`;
    await this.http.request('PUT', report, {
      body: {
        title: s.context,
        details: (s.summary ?? s.description).slice(0, 2000),
        report_type: 'TEST',
        reporter: 'EZTest',
        result: s.state === 'success' ? 'PASSED' : 'FAILED',
        ...(s.targetUrl ? { link: s.targetUrl } : {}),
      },
    });
    const ann = (s.annotations ?? []).map((a, i) => ({
      external_id: `eztest-${i}-${a.path}:${a.line}`.slice(0, 100),
      annotation_type: 'BUG',
      summary: a.title.slice(0, 450),
      details: a.message.slice(0, 2000),
      path: a.path,
      line: a.line,
      severity: a.level === 'failure' ? 'HIGH' : a.level === 'warning' ? 'MEDIUM' : 'LOW',
      result: a.level === 'failure' ? 'FAILED' : 'SKIPPED',
    }));
    for (let i = 0; i < ann.length; i += 100) await this.http.request('POST', `${report}/annotations`, { body: ann.slice(i, i + 100), idempotent: true });
    return { kind: 'code-insights', id: REPORT_ID, annotations: ann.length, warnings };
  }

  async upsertComment(pr: number, marker: string, body: string): Promise<CommentResult> {
    // Bitbucket renders Markdown but strips HTML comments from the view; the raw text keeps the marker.
    const text = `${marker}\n${body}`;
    const comments = await this.http.getAll<{ id: number; content: { raw: string }; deleted?: boolean }>(`${this.base}/pullrequests/${pr}/comments`, { pagelen: 100 });
    const mine = comments.find((c) => !c.deleted && c.content?.raw?.includes(marker));
    if (mine) {
      if (mine.content.raw === text) return { id: mine.id, action: 'unchanged' };
      await this.http.request('PUT', `${this.base}/pullrequests/${pr}/comments/${mine.id}`, { body: { content: { raw: text } } });
      return { id: mine.id, action: 'updated' };
    }
    const r = await this.http.request<{ id: number }>('POST', `${this.base}/pullrequests/${pr}/comments`, { body: { content: { raw: text } } });
    return { id: r.data.id, action: 'created' };
  }

  async findPullRequest(source: string): Promise<{ number: number; url: string } | undefined> {
    const r = await this.http.request<{ values: Array<{ id: number; links: { html: { href: string } } }> }>('GET', `${this.base}/pullrequests`, {
      query: { q: `source.branch.name="${source.replace(/"/g, '')}" AND state="OPEN"` },
    });
    const p = r.data?.values?.[0];
    return p ? { number: p.id, url: p.links?.html?.href } : undefined;
  }

  private async reviewers(owners: Owner[], warnings: string[]): Promise<Array<{ account_id?: string; uuid?: string; name: string }>> {
    if (!owners.length) return [];
    const members = await this.http.getAll<{ user: { nickname?: string; account_id?: string; uuid?: string; display_name?: string } }>(`/workspaces/${encodeURIComponent(this.repo.owner)}/members`, { pagelen: 100 });
    const out: Array<{ account_id?: string; uuid?: string; name: string }> = [];
    for (const o of owners) {
      const key = o.name.toLowerCase();
      const m = members.find((x) => [x.user.nickname, x.user.account_id, x.user.uuid, x.user.display_name].some((v) => v?.toLowerCase() === key));
      if (m) out.push({ ...(m.user.account_id ? { account_id: m.user.account_id } : { uuid: m.user.uuid }), name: m.user.nickname ?? m.user.display_name ?? o.name });
      else warnings.push(`reviewer ${o.raw} is not a member of workspace ${this.repo.owner}`);
    }
    return out;
  }

  async createPullRequest(p: PullRequestInput): Promise<PullRequestResult> {
    const warnings: string[] = [];
    const rv = await this.reviewers(p.reviewers ?? [], warnings);
    const existing = await this.findPullRequest(p.source);
    if (existing) return { number: existing.number, url: existing.url, reviewers: rv.map((r) => r.name), warnings };
    const r = await this.http.request<{ id: number; links: { html: { href: string } } }>('POST', `${this.base}/pullrequests`, {
      body: {
        title: p.title,
        description: p.description,
        source: { branch: { name: p.source } },
        destination: { branch: { name: p.target } },
        close_source_branch: true,
        ...(p.draft ? { draft: true } : {}),
        reviewers: rv.map(({ name: _n, ...id }) => id),
      },
    });
    return { number: r.data.id, url: r.data.links?.html?.href, reviewers: rv.map((x) => x.name), warnings };
  }
}
