/**
 * Which CI system, stage, job and deployment environment a run is in, from
 * the variables each CI system sets. `eztest run --pipeline auto` uses it to
 * pick the `pipelines:` entry, and deployment records use it for the build
 * links.
 */

export type CiSystem = 'azure' | 'github' | 'gitlab' | 'jenkins' | 'teamcity' | 'bitbucket' | 'circleci' | 'local';
export type CiReason = 'pr' | 'schedule' | 'push' | 'manual' | 'deploy' | 'unknown';

export interface CiContext {
  system: CiSystem;
  /** Stage (Azure, GitLab, Jenkins), workflow (GitHub, CircleCI) or build configuration (TeamCity). */
  stage?: string;
  job?: string;
  /** Deployment environment (Azure deployment jobs and classic releases, GitLab, Bitbucket). */
  environment?: string;
  reason: CiReason;
  buildId?: string;
  buildNumber?: string;
  url?: string;
  commit?: string;
  branch?: string;
  pullRequest?: string;
  /** Target branch of a pull request (impact selection base). */
  baseBranch?: string;
  /** A release / deployment id when there is one (Azure classic release, GitHub deployment). */
  releaseId?: string;
  /** Shard position from the CI's own parallelism (1-based) and count. */
  shard?: { index: number; total: number };
}

type Env = Record<string, string | undefined>;

const strip = (ref?: string) => ref?.replace(/^refs\/heads\//, '').replace(/^refs\/tags\//, '');

function shardFrom(i: string | undefined, n: string | undefined, zeroBased: boolean): CiContext['shard'] {
  const index = Number(i);
  const total = Number(n);
  if (!Number.isInteger(index) || !Number.isInteger(total) || total < 2) return undefined;
  return { index: zeroBased ? index + 1 : index, total };
}

export function detectCi(env: Env = process.env): CiContext {
  const c = detectSystem(env);
  // Any system: EZTEST_STAGE names the stage, EZTEST_DEPLOY_ENVIRONMENT the deployment environment.
  if (env.EZTEST_STAGE) c.stage = env.EZTEST_STAGE;
  if (env.EZTEST_DEPLOY_ENVIRONMENT && !c.environment) c.environment = env.EZTEST_DEPLOY_ENVIRONMENT;
  if (c.environment && (c.reason === 'push' || c.reason === 'unknown')) c.reason = 'deploy';
  return c;
}

function detectSystem(env: Env): CiContext {
  if (/^true$/i.test(env.TF_BUILD ?? '')) {
    const r = env.BUILD_REASON ?? '';
    const coll = env.SYSTEM_COLLECTIONURI?.replace(/\/+$/, '');
    const environment = env.ENVIRONMENT_NAME ?? env.RELEASE_ENVIRONMENTNAME;
    return {
      system: 'azure',
      stage: env.SYSTEM_STAGENAME ?? env.RELEASE_ENVIRONMENTNAME,
      job: env.SYSTEM_JOBNAME ?? env.AGENT_JOBNAME,
      environment,
      reason: r === 'PullRequest' ? 'pr' : r === 'Schedule' ? 'schedule' : env.RELEASE_RELEASEID || env.ENVIRONMENT_NAME ? 'deploy' : r === 'Manual' ? 'manual' : r ? 'push' : 'unknown',
      buildId: env.BUILD_BUILDID,
      buildNumber: env.BUILD_BUILDNUMBER,
      url: coll && env.SYSTEM_TEAMPROJECT && env.BUILD_BUILDID ? `${coll}/${encodeURIComponent(env.SYSTEM_TEAMPROJECT)}/_build/results?buildId=${env.BUILD_BUILDID}` : undefined,
      commit: env.BUILD_SOURCEVERSION,
      branch: strip(env.BUILD_SOURCEBRANCH) ?? env.BUILD_SOURCEBRANCHNAME,
      pullRequest: env.SYSTEM_PULLREQUEST_PULLREQUESTID ?? env.SYSTEM_PULLREQUEST_PULLREQUESTNUMBER,
      baseBranch: strip(env.SYSTEM_PULLREQUEST_TARGETBRANCH),
      releaseId: env.RELEASE_RELEASEID,
      shard: shardFrom(env.SYSTEM_JOBPOSITIONINPHASE, env.SYSTEM_TOTALJOBSINPHASE, false),
    };
  }
  if (env.GITHUB_ACTIONS === 'true') {
    const ev = env.GITHUB_EVENT_NAME ?? '';
    const server = env.GITHUB_SERVER_URL ?? 'https://github.com';
    return {
      system: 'github',
      stage: env.GITHUB_WORKFLOW,
      job: env.GITHUB_JOB,
      environment: env.EZTEST_DEPLOY_ENVIRONMENT,
      reason: /^pull_request/.test(ev) ? 'pr' : ev === 'schedule' ? 'schedule' : /^deployment/.test(ev) ? 'deploy' : ev === 'workflow_dispatch' ? 'manual' : ev ? 'push' : 'unknown',
      buildId: env.GITHUB_RUN_ID,
      buildNumber: env.GITHUB_RUN_NUMBER,
      url: env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined,
      commit: env.GITHUB_SHA,
      branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME,
      baseBranch: env.GITHUB_BASE_REF || undefined,
      pullRequest: /^refs\/pull\/(\d+)/.exec(env.GITHUB_REF ?? '')?.[1],
    };
  }
  if (env.GITLAB_CI === 'true') {
    const src = env.CI_PIPELINE_SOURCE ?? '';
    return {
      system: 'gitlab',
      stage: env.CI_JOB_STAGE,
      job: env.CI_JOB_NAME,
      environment: env.CI_ENVIRONMENT_NAME,
      reason: src === 'merge_request_event' ? 'pr' : src === 'schedule' ? 'schedule' : env.CI_ENVIRONMENT_NAME ? 'deploy' : src === 'web' || src === 'api' ? 'manual' : src ? 'push' : 'unknown',
      buildId: env.CI_PIPELINE_ID,
      buildNumber: env.CI_PIPELINE_IID,
      url: env.CI_PIPELINE_URL,
      commit: env.CI_COMMIT_SHA,
      branch: env.CI_COMMIT_REF_NAME,
      pullRequest: env.CI_MERGE_REQUEST_IID,
      baseBranch: env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME,
      shard: shardFrom(env.CI_NODE_INDEX, env.CI_NODE_TOTAL, false),
    };
  }
  if (env.BITBUCKET_BUILD_NUMBER) {
    return {
      system: 'bitbucket',
      environment: env.BITBUCKET_DEPLOYMENT_ENVIRONMENT,
      reason: env.BITBUCKET_PR_ID ? 'pr' : env.BITBUCKET_DEPLOYMENT_ENVIRONMENT ? 'deploy' : env.EZTEST_SCHEDULED === 'true' ? 'schedule' : 'push',
      buildNumber: env.BITBUCKET_BUILD_NUMBER,
      url: env.BITBUCKET_GIT_HTTP_ORIGIN ? `${env.BITBUCKET_GIT_HTTP_ORIGIN}/addon/pipelines/home#!/results/${env.BITBUCKET_BUILD_NUMBER}` : undefined,
      commit: env.BITBUCKET_COMMIT,
      branch: env.BITBUCKET_BRANCH,
      pullRequest: env.BITBUCKET_PR_ID,
      baseBranch: env.BITBUCKET_PR_DESTINATION_BRANCH,
      shard: shardFrom(env.BITBUCKET_PARALLEL_STEP, env.BITBUCKET_PARALLEL_STEP_COUNT, true),
    };
  }
  if (env.CIRCLECI === 'true') {
    return {
      system: 'circleci',
      stage: env.CIRCLE_WORKFLOW_NAME,
      job: env.CIRCLE_JOB,
      environment: env.EZTEST_DEPLOY_ENVIRONMENT,
      reason: env.CIRCLE_PULL_REQUEST ? 'pr' : env.EZTEST_SCHEDULED === 'true' ? 'schedule' : 'push',
      buildId: env.CIRCLE_WORKFLOW_ID,
      buildNumber: env.CIRCLE_BUILD_NUM,
      url: env.CIRCLE_BUILD_URL,
      commit: env.CIRCLE_SHA1,
      branch: env.CIRCLE_BRANCH,
      pullRequest: /\/pull\/(\d+)/.exec(env.CIRCLE_PULL_REQUEST ?? '')?.[1],
      shard: shardFrom(env.CIRCLE_NODE_INDEX, env.CIRCLE_NODE_TOTAL, true),
    };
  }
  if (env.TEAMCITY_VERSION) {
    return {
      system: 'teamcity',
      stage: env.TEAMCITY_BUILDCONF_NAME,
      environment: env.EZTEST_DEPLOY_ENVIRONMENT,
      reason: env.EZTEST_SCHEDULED === 'true' ? 'schedule' : env.EZTEST_DEPLOY_ENVIRONMENT ? 'deploy' : 'push',
      buildNumber: env.BUILD_NUMBER,
      commit: env.BUILD_VCS_NUMBER,
      branch: env.TEAMCITY_BUILD_BRANCH,
    };
  }
  if (env.JENKINS_URL) {
    return {
      system: 'jenkins',
      stage: env.STAGE_NAME,
      job: env.JOB_NAME,
      environment: env.EZTEST_DEPLOY_ENVIRONMENT,
      reason: env.CHANGE_ID ? 'pr' : env.EZTEST_SCHEDULED === 'true' ? 'schedule' : env.EZTEST_DEPLOY_ENVIRONMENT ? 'deploy' : 'push',
      buildNumber: env.BUILD_NUMBER,
      url: env.BUILD_URL,
      commit: env.GIT_COMMIT,
      branch: env.BRANCH_NAME ?? env.GIT_BRANCH,
      pullRequest: env.CHANGE_ID,
      baseBranch: env.CHANGE_TARGET,
    };
  }
  return { system: 'local', reason: 'manual' };
}

/** The deployed version: EZTEST_APP_VERSION, else the CI's build number, else a tag or the short commit. */
export function detectVersion(ci: CiContext, env: Env = process.env): string | undefined {
  return env.EZTEST_APP_VERSION || ci.buildNumber || (env.GITHUB_REF_TYPE === 'tag' ? env.GITHUB_REF_NAME : undefined) || env.CI_COMMIT_TAG || ci.commit?.slice(0, 12) || undefined;
}
