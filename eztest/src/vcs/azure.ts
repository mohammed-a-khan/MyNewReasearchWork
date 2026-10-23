/**
 * Azure Repos through the AdoClient (PAT, System.AccessToken, Entra ID):
 * pull request statuses ("EZTest: GO / NO_GO"), commit statuses outside a PR,
 * one summary thread updated in place (resolved when the run is GO), line
 * threads on the failing journey lines (closed again once they pass), and
 * pull requests with reviewers resolved through the identities API.
 */
import type { AdoClient } from '../alm-ado/client.js';
import type { Owner } from '../git/codeowners.js';
import type { Annotation, CommentResult, PullRequestInput, PullRequestResult, RepoRef, StatusInput, StatusResult, VcsProvider } from './types.js';

interface Thread {
  id: number;
  status?: string;
  isDeleted?: boolean;
  comments?: Array<{ id: number; content?: string; isDeleted?: boolean }>;
  threadContext?: { filePath?: string; rightFileStart?: { line: number } };
}

const ANNOTATION_MARK = (a: { path: string; line: number }) => `<!-- eztest:annotation ${a.path}:${a.line} -->`;

export class AzureReposProvider implements VcsProvider {
  readonly kind = 'azure-devops' as const;
  readonly repo: RepoRef;
  private repoId?: string;

  constructor(
    private readonly c: AdoClient,
    repo: Omit<RepoRef, 'provider' | 'host' | 'owner'> & Partial<Pick<RepoRef, 'host' | 'owner'>>,
  ) {
    this.repo = { provider: 'azure-devops', host: new URL(c.collectionUrl).host, owner: '', ...repo };
  }

  redact(s: string): string {
    return this.c.redact(s);
  }

  private async id(): Promise<string> {
    if (!this.repoId) this.repoId = (await this.c.request<{ id: string }>('GET', `/_apis/git/repositories/${encodeURIComponent(this.repo.repo)}`)).data.id;
    return this.repoId;
  }

  private base = async () => `/_apis/git/repositories/${await this.id()}`;

  async setStatus(s: StatusInput): Promise<StatusResult> {
    const state = s.state === 'success' ? 'succeeded' : s.state === 'pending' ? 'pending' : s.state === 'error' ? 'error' : 'failed';
    const body = { state, description: s.description.slice(0, 400), context: { name: s.context, genre: 'eztest' }, ...(s.targetUrl ? { targetUrl: s.targetUrl } : {}) };
    const warnings: string[] = [];
    const base = await this.base();
    if (s.pr) {
      const r = await this.c.request<{ id: number }>('POST', `${base}/pullRequests/${s.pr}/statuses`, { body, preview: 'preview.1' });
      let annotations = 0;
      if (s.annotations) {
        try {
          annotations = await this.annotate(s.pr, s.annotations);
        } catch (e) {
          warnings.push(`line threads not posted: ${(e as Error).message}`);
        }
      }
      return { kind: 'pr-status', id: r.data?.id, annotations, warnings };
    }
    const r = await this.c.request<{ id: number }>('POST', `${base}/commits/${encodeURIComponent(s.sha)}/statuses`, { body });
    return { kind: 'commit-status', id: r.data?.id, annotations: 0, warnings };
  }

  private async threads(pr: number): Promise<Thread[]> {
    return (await this.c.request<{ value: Thread[] }>('GET', `${await this.base()}/pullRequests/${pr}/threads`)).data?.value ?? [];
  }

  /** Line threads on failing journey lines: created once, updated on re-runs, closed when the line no longer fails. */
  private async annotate(pr: number, list: Annotation[]): Promise<number> {
    const base = await this.base();
    const threads = await this.threads(pr);
    const live = new Set<number>();
    for (const a of list) {
      const mark = ANNOTATION_MARK(a);
      const content = `${mark}\n**EZTest ${a.level}: ${a.title}**\n\n${a.message}`;
      const t = threads.find((x) => !x.isDeleted && x.comments?.[0]?.content?.includes(mark));
      if (t) {
        live.add(t.id);
        if (t.comments![0].content !== content) await this.c.request('PATCH', `${base}/pullRequests/${pr}/threads/${t.id}/comments/${t.comments![0].id}`, { body: { content }, idempotent: true });
        if (t.status !== 'active') await this.c.request('PATCH', `${base}/pullRequests/${pr}/threads/${t.id}`, { body: { status: 'active' }, idempotent: true });
        continue;
      }
      const path = a.path.startsWith('/') ? a.path : `/${a.path}`;
      const r = await this.c.request<{ id: number }>('POST', `${base}/pullRequests/${pr}/threads`, {
        body: {
          comments: [{ parentCommentId: 0, content, commentType: 1 }],
          status: 'active',
          threadContext: { filePath: path, rightFileStart: { line: a.line, offset: 1 }, rightFileEnd: { line: a.endLine ?? a.line, offset: 1 } },
        },
      });
      live.add(r.data.id);
    }
    // Lines that passed this time: resolve their old threads.
    for (const t of threads) {
      if (t.isDeleted || live.has(t.id) || t.status !== 'active' || !t.comments?.[0]?.content?.includes('<!-- eztest:annotation ')) continue;
      await this.c.request('PATCH', `${base}/pullRequests/${pr}/threads/${t.id}`, { body: { status: 'fixed' }, idempotent: true });
    }
    return list.length;
  }

  async upsertComment(pr: number, marker: string, body: string, opts: { resolved?: boolean } = {}): Promise<CommentResult> {
    const base = await this.base();
    const content = `${marker}\n${body}`;
    const status = opts.resolved ? 'closed' : 'active';
    const mine = (await this.threads(pr)).find((t) => !t.isDeleted && t.comments?.[0]?.content?.includes(marker));
    if (mine) {
      const first = mine.comments![0];
      const same = first.content === content;
      if (!same) await this.c.request('PATCH', `${base}/pullRequests/${pr}/threads/${mine.id}/comments/${first.id}`, { body: { content }, idempotent: true });
      if (mine.status !== status) await this.c.request('PATCH', `${base}/pullRequests/${pr}/threads/${mine.id}`, { body: { status }, idempotent: true });
      return { id: mine.id, action: same ? 'unchanged' : 'updated' };
    }
    const r = await this.c.request<{ id: number }>('POST', `${base}/pullRequests/${pr}/threads`, { body: { comments: [{ parentCommentId: 0, content, commentType: 1 }], status } });
    return { id: r.data.id, action: 'created' };
  }

  async findPullRequest(source: string): Promise<{ number: number; url: string } | undefined> {
    const r = await this.c.request<{ value: Array<{ pullRequestId: number }> }>('GET', `${await this.base()}/pullrequests`, {
      query: { 'searchCriteria.sourceRefName': `refs/heads/${source}`, 'searchCriteria.status': 'active' },
    });
    const p = r.data?.value?.[0];
    return p ? { number: p.pullRequestId, url: this.webUrl(p.pullRequestId) } : undefined;
  }

  webUrl(pr: number): string {
    return `${this.c.projectUrl}/_git/${encodeURIComponent(this.repo.repo)}/pullrequest/${pr}`;
  }

  /** Identity id for a CODEOWNERS owner (e-mail, @user, or [Project]\Group). */
  private async identity(o: Owner): Promise<{ id: string; displayName: string } | undefined> {
    const value = o.kind === 'group' || o.kind === 'email' ? o.name : o.name.replace(/^@/, '');
    const r = await this.c.request<{ value: Array<{ id: string; providerDisplayName?: string; customDisplayName?: string }> }>('GET', `${this.c.identityUrl}/_apis/identities`, {
      query: { searchFilter: 'General', filterValue: value, queryMembership: 'None' },
    });
    const i = r.data?.value?.[0];
    return i ? { id: i.id, displayName: i.customDisplayName ?? i.providerDisplayName ?? value } : undefined;
  }

  async createPullRequest(p: PullRequestInput): Promise<PullRequestResult> {
    const warnings: string[] = [];
    const reviewers: Array<{ id: string; displayName: string }> = [];
    for (const o of p.reviewers ?? []) {
      try {
        const i = await this.identity(o);
        if (i) reviewers.push(i);
        else warnings.push(`reviewer ${o.raw} not found in Azure DevOps`);
      } catch (e) {
        warnings.push(`reviewer ${o.raw}: ${(e as Error).message}`);
      }
    }
    const existing = await this.findPullRequest(p.source);
    if (existing) return { number: existing.number, url: existing.url, reviewers: reviewers.map((r) => r.displayName), warnings };
    const r = await this.c.request<{ pullRequestId: number }>('POST', `${await this.base()}/pullrequests`, {
      body: {
        sourceRefName: `refs/heads/${p.source}`,
        targetRefName: `refs/heads/${p.target}`,
        title: p.title,
        description: p.description.slice(0, 4000),
        isDraft: !!p.draft,
        reviewers: reviewers.map((x) => ({ id: x.id })),
      },
    });
    return { number: r.data.pullRequestId, url: this.webUrl(r.data.pullRequestId), reviewers: reviewers.map((x) => x.displayName), warnings };
  }
}
