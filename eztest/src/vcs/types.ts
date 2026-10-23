/** The common interface every Git hosting provider implements (Azure Repos, GitHub, GitLab, Bitbucket). */
import type { Owner } from '../git/codeowners.js';

export type ProviderKind = 'azure-devops' | 'github' | 'gitlab' | 'bitbucket';

export interface RepoRef {
  provider: ProviderKind;
  /** Web host, e.g. github.com, dev.azure.com, gitlab.example.com. */
  host: string;
  /** GitHub owner, GitLab namespace path, Bitbucket workspace, ADO organisation. */
  owner: string;
  /** Repository name (GitLab: project name). */
  repo: string;
  /** ADO project; GitLab full project path (namespace/project). */
  project?: string;
  /** ADO collection URL (dev.azure.com/org or the on-prem collection). */
  collectionUrl?: string;
}

export type StatusState = 'success' | 'failure' | 'pending' | 'error';

export interface Annotation {
  /** Repository-relative path of the journey file. */
  path: string;
  line: number;
  endLine?: number;
  level: 'failure' | 'warning' | 'notice';
  title: string;
  message: string;
}

export interface StatusInput {
  sha: string;
  state: StatusState;
  /** Check/status name, e.g. "EZTest". */
  context: string;
  description: string;
  targetUrl?: string;
  /** Pull request the status belongs to (Azure Repos posts PR statuses; others use the commit). */
  pr?: number;
  /** Line annotations on the failing journeys (check runs, Code Insights, PR threads). */
  annotations?: Annotation[];
  /** Markdown details (check run summary / report details). */
  summary?: string;
}

export interface StatusResult {
  kind: 'check-run' | 'commit-status' | 'pr-status' | 'code-insights';
  id?: string | number;
  annotations: number;
  warnings: string[];
}

export interface CommentResult {
  id: string | number;
  action: 'created' | 'updated' | 'unchanged';
}

export interface PullRequestInput {
  source: string;
  target: string;
  title: string;
  description: string;
  reviewers?: Owner[];
  draft?: boolean;
}

export interface PullRequestResult {
  number: number;
  url: string;
  reviewers: string[];
  warnings: string[];
}

export interface VcsProvider {
  readonly kind: ProviderKind;
  readonly repo: RepoRef;
  setStatus(s: StatusInput): Promise<StatusResult>;
  /** Create or update (in place) the one comment that carries `marker`. */
  upsertComment(pr: number, marker: string, body: string): Promise<CommentResult>;
  createPullRequest(p: PullRequestInput): Promise<PullRequestResult>;
  findPullRequest(source: string): Promise<{ number: number; url: string } | undefined>;
  /** Redact the provider's credentials from a string. */
  redact(s: string): string;
}

/** Hidden marker that identifies EZTest's own PR comment so re-runs update it instead of adding new ones. */
export const COMMENT_MARKER = '<!-- eztest:pr-summary -->';
