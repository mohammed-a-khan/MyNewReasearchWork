/**
 * Which hosting provider a repository lives on, from its remote URL and the
 * CI system's variables (Azure Pipelines, GitHub Actions, GitLab CI,
 * Bitbucket Pipelines), and the commit / branch / pull request a CI job is
 * building.
 */
import type { ProviderKind, RepoRef } from './types.js';

export interface CiContext {
  ci?: 'azure-pipelines' | 'github-actions' | 'gitlab-ci' | 'bitbucket-pipelines';
  provider?: ProviderKind;
  sha?: string;
  branch?: string;
  /** Pull / merge request number. */
  pr?: number;
  targetBranch?: string;
  repoUrl?: string;
  buildUrl?: string;
  buildId?: string;
}

const stripGit = (s: string) => s.replace(/\.git$/, '');

/** Parse a remote URL (https, ssh or scp-like). `hosts` maps self-hosted domains to providers. */
export function parseRemoteUrl(url: string, hosts: Record<string, ProviderKind> = {}): RepoRef | undefined {
  const raw = url.trim();
  let host: string;
  let path: string;
  let scheme = 'https';
  const scp = /^(?:[^@\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(raw);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const u = new URL(raw);
    host = u.hostname + (u.port && !/^ssh/i.test(u.protocol) ? `:${u.port}` : '');
    path = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    scheme = u.protocol.replace(':', '');
  } else if (scp) {
    host = scp[1];
    path = scp[2].replace(/^\/+/, '');
    scheme = 'ssh';
  } else return undefined;
  const hostname = host.split(':')[0].toLowerCase();
  const parts = stripGit(path).split('/').filter(Boolean);

  // Azure Repos: dev.azure.com/{org}/{project}/_git/{repo}, {org}.visualstudio.com/{project}/_git/{repo},
  // ssh.dev.azure.com:v3/{org}/{project}/{repo}, on-prem {host}/{collection path}/{project}/_git/{repo}
  if (hostname === 'ssh.dev.azure.com' || hostname === 'vs-ssh.visualstudio.com') {
    const [v, org, project, repo] = parts;
    if (v === 'v3' && org && project && repo) return { provider: 'azure-devops', host: 'dev.azure.com', owner: org, project, repo, collectionUrl: `https://dev.azure.com/${encodeURIComponent(org)}` };
  }
  const gi = parts.indexOf('_git');
  if (gi >= 1 && parts[gi + 1]) {
    const repo = parts[gi + 1];
    const project = parts[gi - 1];
    if (hostname === 'dev.azure.com') {
      const org = parts[0];
      return { provider: 'azure-devops', host: 'dev.azure.com', owner: org, project, repo, collectionUrl: `https://dev.azure.com/${encodeURIComponent(org)}` };
    }
    if (hostname.endsWith('.visualstudio.com')) {
      const org = hostname.split('.')[0];
      return { provider: 'azure-devops', host: hostname, owner: org, project, repo, collectionUrl: `https://${hostname}` };
    }
    // Azure DevOps Server: everything before the project is the collection path.
    const collectionPath = parts.slice(0, gi - 1).join('/');
    const web = scheme === 'http' ? 'http' : 'https';
    return { provider: 'azure-devops', host, owner: parts[gi - 2] ?? '', project, repo, collectionUrl: `${web}://${host}/${collectionPath}` };
  }
  const kind: ProviderKind | undefined =
    hosts[hostname] ?? (hostname === 'github.com' ? 'github' : hostname === 'gitlab.com' ? 'gitlab' : hostname === 'bitbucket.org' ? 'bitbucket' : undefined);
  if (!kind || parts.length < 2) return undefined;
  if (kind === 'gitlab') {
    const projectPath = parts.join('/');
    return { provider: 'gitlab', host, owner: parts.slice(0, -1).join('/'), repo: parts[parts.length - 1], project: projectPath };
  }
  return { provider: kind, host, owner: parts[0], repo: parts[1] };
}

/** The CI job's repository, commit, branch and pull request from its environment variables. */
export function detectCi(env: Record<string, string | undefined>): CiContext {
  if (env.TF_BUILD === 'True' || env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI) {
    const pr = Number(env.SYSTEM_PULLREQUEST_PULLREQUESTID ?? env.SYSTEM_PULLREQUEST_PULLREQUESTNUMBER);
    const provider: ProviderKind | undefined =
      env.BUILD_REPOSITORY_PROVIDER === 'TfsGit' ? 'azure-devops' : env.BUILD_REPOSITORY_PROVIDER === 'GitHub' || env.BUILD_REPOSITORY_PROVIDER === 'GitHubEnterprise' ? 'github' : env.BUILD_REPOSITORY_PROVIDER === 'Bitbucket' ? 'bitbucket' : undefined;
    const coll = env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI?.replace(/\/+$/, '');
    return {
      ci: 'azure-pipelines',
      provider,
      sha: env.SYSTEM_PULLREQUEST_SOURCECOMMITID ?? env.BUILD_SOURCEVERSION,
      branch: (env.SYSTEM_PULLREQUEST_SOURCEBRANCH ?? env.BUILD_SOURCEBRANCH)?.replace(/^refs\/heads\//, ''),
      ...(Number.isFinite(pr) && pr > 0 ? { pr } : {}),
      targetBranch: env.SYSTEM_PULLREQUEST_TARGETBRANCH?.replace(/^refs\/heads\//, ''),
      repoUrl: env.BUILD_REPOSITORY_URI,
      buildId: env.BUILD_BUILDID,
      ...(coll && env.SYSTEM_TEAMPROJECT && env.BUILD_BUILDID ? { buildUrl: `${coll}/${encodeURIComponent(env.SYSTEM_TEAMPROJECT)}/_build/results?buildId=${env.BUILD_BUILDID}` } : {}),
    };
  }
  if (env.GITHUB_ACTIONS === 'true') {
    const m = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? '');
    const server = env.GITHUB_SERVER_URL ?? 'https://github.com';
    return {
      ci: 'github-actions',
      provider: 'github',
      sha: env.EZTEST_PR_HEAD_SHA ?? env.GITHUB_SHA,
      branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME,
      ...(m ? { pr: Number(m[1]) } : {}),
      targetBranch: env.GITHUB_BASE_REF || undefined,
      repoUrl: env.GITHUB_REPOSITORY ? `${server}/${env.GITHUB_REPOSITORY}` : undefined,
      buildId: env.GITHUB_RUN_ID,
      ...(env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? { buildUrl: `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` } : {}),
    };
  }
  if (env.GITLAB_CI === 'true') {
    const iid = Number(env.CI_MERGE_REQUEST_IID);
    return {
      ci: 'gitlab-ci',
      provider: 'gitlab',
      sha: env.CI_COMMIT_SHA,
      branch: env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME ?? env.CI_COMMIT_REF_NAME,
      ...(Number.isFinite(iid) && iid > 0 ? { pr: iid } : {}),
      targetBranch: env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME,
      repoUrl: env.CI_PROJECT_URL,
      buildId: env.CI_PIPELINE_ID,
      buildUrl: env.CI_PIPELINE_URL ?? env.CI_JOB_URL,
    };
  }
  if (env.BITBUCKET_BUILD_NUMBER) {
    const pr = Number(env.BITBUCKET_PR_ID);
    return {
      ci: 'bitbucket-pipelines',
      provider: 'bitbucket',
      sha: env.BITBUCKET_COMMIT,
      branch: env.BITBUCKET_BRANCH,
      ...(Number.isFinite(pr) && pr > 0 ? { pr } : {}),
      targetBranch: env.BITBUCKET_PR_DESTINATION_BRANCH,
      repoUrl: env.BITBUCKET_GIT_HTTP_ORIGIN,
      buildId: env.BITBUCKET_BUILD_NUMBER,
      ...(env.BITBUCKET_GIT_HTTP_ORIGIN ? { buildUrl: `${env.BITBUCKET_GIT_HTTP_ORIGIN}/addon/pipelines/home#!/results/${env.BITBUCKET_BUILD_NUMBER}` } : {}),
    };
  }
  return {};
}
