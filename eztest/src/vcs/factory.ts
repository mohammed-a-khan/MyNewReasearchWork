/**
 * Pick and build the hosting provider for a repository: from `vcs.provider`,
 * the CI system, or the remote URL; credentials from `vcs.token` (a secret
 * reference) or the CI's own token variables. Azure Repos reuses the Azure
 * DevOps client (PAT, System.AccessToken, Entra ID).
 */
import type { AdoClient } from '../alm-ado/client.js';
import { EzTestError } from '../core/index.js';
import { GitRepo } from '../git/repo.js';
import { AzureReposProvider } from './azure.js';
import { BitbucketProvider } from './bitbucket.js';
import { detectCi, parseRemoteUrl, type CiContext } from './detect.js';
import { GitHubProvider, githubApiUrl } from './github.js';
import { GitLabProvider } from './gitlab.js';
import type { ProviderKind, RepoRef, VcsProvider } from './types.js';

export interface ProviderOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  provider?: ProviderKind;
  hosts?: Record<string, ProviderKind>;
  apiUrl?: string;
  /** Token from configuration (already resolved from its secret reference). */
  token?: string;
  /** For Azure Repos: a ready client (from adoClientFromConfig). */
  adoClient?: () => Promise<AdoClient>;
  /** Azure Repos repository name (default: from the remote URL or Build.Repository.Name). */
  adoRepository?: string;
  /** Use this remote URL instead of `git remote get-url origin`. */
  remoteUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface ResolvedProvider {
  provider: VcsProvider;
  repo: RepoRef;
  ci: CiContext;
}

export async function resolveProvider(o: ProviderOptions): Promise<ResolvedProvider> {
  const env = o.env ?? process.env;
  const ci = detectCi(env);
  let remote = o.remoteUrl ?? ci.repoUrl;
  if (!remote) {
    try {
      remote = await (await GitRepo.open(o.cwd)).remoteUrl();
    } catch {
      remote = undefined;
    }
  }
  let repo = remote ? parseRemoteUrl(remote, o.hosts) : undefined;
  const kind = o.provider ?? ci.provider ?? repo?.provider;
  if (!kind) throw new EzTestError(`Cannot tell the hosting provider${remote ? ` of ${remote.replace(/\/\/[^@/]+@/, '//')}` : ''}; set vcs.provider (and vcs.hosts for self-hosted domains)`, 'VCS_UNKNOWN');
  if (kind === 'azure-devops') {
    if (!o.adoClient) throw new EzTestError('Azure Repos needs Azure DevOps configuration (ado.organizationUrl, ado.project and credentials)', 'VCS_CONFIG');
    const c = await o.adoClient();
    const name = o.adoRepository ?? env.BUILD_REPOSITORY_NAME ?? (repo?.provider === 'azure-devops' ? repo.repo : undefined);
    if (!name) throw new EzTestError('Azure Repos repository not known: set ado.repository', 'VCS_CONFIG');
    const p = new AzureReposProvider(c, { repo: name, project: c.project, collectionUrl: c.collectionUrl, owner: repo?.owner ?? '' });
    return { provider: p, repo: p.repo, ci };
  }
  if (!repo || repo.provider !== kind) {
    // e.g. GitHub Actions with GITHUB_REPOSITORY but a different remote: build the ref from CI variables.
    if (kind === 'github' && env.GITHUB_REPOSITORY) {
      const [owner, name] = env.GITHUB_REPOSITORY.split('/');
      repo = { provider: 'github', host: new URL(env.GITHUB_SERVER_URL ?? 'https://github.com').host, owner, repo: name };
    } else if (kind === 'gitlab' && env.CI_PROJECT_PATH) {
      const parts = env.CI_PROJECT_PATH.split('/');
      repo = { provider: 'gitlab', host: new URL(env.CI_SERVER_URL ?? 'https://gitlab.com').host, owner: parts.slice(0, -1).join('/'), repo: parts[parts.length - 1], project: env.CI_PROJECT_PATH };
    } else if (kind === 'bitbucket' && env.BITBUCKET_REPO_FULL_NAME) {
      const [owner, name] = env.BITBUCKET_REPO_FULL_NAME.split('/');
      repo = { provider: 'bitbucket', host: 'bitbucket.org', owner, repo: name };
    } else throw new EzTestError(`The remote does not look like a ${kind} repository; set vcs.provider and the remote, or run in CI`, 'VCS_UNKNOWN');
  }
  const f = { fetchImpl: o.fetchImpl, sleep: o.sleep };
  if (kind === 'github') {
    const token = o.token ?? env.EZTEST_GITHUB_TOKEN ?? env.GITHUB_TOKEN ?? env.GH_TOKEN;
    if (!token) throw new EzTestError('GitHub token not found: set GITHUB_TOKEN (Actions: permissions checks: write, pull-requests: write) or vcs.token', 'VCS_AUTH');
    return { provider: new GitHubProvider({ repo, token, apiUrl: o.apiUrl ?? env.GITHUB_API_URL ?? githubApiUrl(repo.host), ...f }), repo, ci };
  }
  if (kind === 'gitlab') {
    const token = o.token ?? env.EZTEST_GITLAB_TOKEN ?? env.GITLAB_TOKEN;
    const job = !token && env.CI_JOB_TOKEN ? env.CI_JOB_TOKEN : undefined;
    if (!token && !job) throw new EzTestError('GitLab token not found: set GITLAB_TOKEN (a project access token with api scope) or vcs.token', 'VCS_AUTH');
    return { provider: new GitLabProvider({ repo, token: (token ?? job)!, tokenType: token ? 'private' : 'job', apiUrl: o.apiUrl ?? env.CI_API_V4_URL, ...f }), repo, ci };
  }
  const token = o.token ?? env.EZTEST_BITBUCKET_TOKEN ?? env.BITBUCKET_TOKEN;
  if (!token && !(env.BITBUCKET_USERNAME && env.BITBUCKET_APP_PASSWORD)) throw new EzTestError('Bitbucket credentials not found: set BITBUCKET_TOKEN (repository access token) or BITBUCKET_USERNAME + BITBUCKET_APP_PASSWORD', 'VCS_AUTH');
  return {
    provider: new BitbucketProvider({ repo, ...(token ? { token } : { username: env.BITBUCKET_USERNAME, appPassword: env.BITBUCKET_APP_PASSWORD }), apiUrl: o.apiUrl, ...f }),
    repo,
    ci,
  };
}
