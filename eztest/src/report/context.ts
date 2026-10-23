/**
 * Run context for the report header and the "Run context" section: where the
 * run ran (environment, base URL, browsers, devices), what it built (CI build,
 * pipeline, branch, commit, pull request, trigger, user) and how (EZTest
 * version, machine, shards, start/end, time zone). Captured once into
 * context.json so a report rendered later (after publishing) shows the same.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus, hostname, totalmem, type as osType, release as osRelease, userInfo } from 'node:os';
import { join } from 'node:path';
import type { RunResult } from '../core/index.js';
import { EZTEST_VERSION } from '../ops/version.js';
import { detectCi, parseRemoteUrl } from '../vcs/detect.js';
import { adoWeb, safeHttpUrl } from './integrations.js';

export const CONTEXT_FILE = 'context.json';

export interface RunContext {
  environment?: string;
  baseUrl?: string;
  browsers: Array<{ name: string; version?: string }>;
  devices: string[];
  build?: { system: string; id?: string; number?: string; url?: string; pipeline?: string; reason?: string };
  release?: { name?: string; url?: string; environment?: string };
  repository?: { provider?: string; url?: string; name?: string };
  branch?: string;
  targetBranch?: string;
  commit?: { sha: string; url?: string; author?: string; message?: string };
  pullRequest?: { number: number; url?: string };
  trigger?: string;
  user?: string;
  eztestVersion: string;
  node: string;
  machine: { host?: string; os: string; cpus?: number; memoryGb?: number };
  shard?: { index: number; total: number };
  workers?: number;
  startedAt: string;
  finishedAt: string;
  timeZone: string;
  /** Other environment entries recorded by the run (driver versions, endpoints...). */
  extra: Record<string, string>;
}

const KNOWN_ENV = new Set(['node', 'platform', 'browser', 'browserVersion', 'baseUrl', 'gitCommit', 'gitBranch', 'gitAuthor', 'gitRemote', 'gitDirty', 'environment', 'fingerprintStore']);

function repoWeb(remote: string | undefined): { provider?: string; url?: string; name?: string; commit?: (sha: string) => string; pr?: (n: number) => string } {
  if (!remote) return {};
  const r = parseRemoteUrl(remote);
  if (!r) return {};
  if (r.provider === 'azure-devops' && r.collectionUrl && r.project) {
    const b = { collectionUrl: r.collectionUrl, project: r.project };
    return { provider: r.provider, url: `${adoWeb.project(b)}/_git/${encodeURIComponent(r.repo)}`, name: r.repo, commit: (s) => adoWeb.commit(b, r.repo, s), pr: (n) => adoWeb.pullRequest(b, r.repo, n) };
  }
  const base = r.provider === 'gitlab' ? `https://${r.host}/${r.project}` : `https://${r.host}/${r.owner}/${r.repo}`;
  if (r.provider === 'github') return { provider: r.provider, url: base, name: `${r.owner}/${r.repo}`, commit: (s) => `${base}/commit/${s}`, pr: (n) => `${base}/pull/${n}` };
  if (r.provider === 'gitlab') return { provider: r.provider, url: base, name: r.project, commit: (s) => `${base}/-/commit/${s}`, pr: (n) => `${base}/-/merge_requests/${n}` };
  return { provider: r.provider, url: base, name: `${r.owner}/${r.repo}`, commit: (s) => `${base}/commits/${s}`, pr: (n) => `${base}/pull-requests/${n}` };
}

function safeUser(env: Record<string, string | undefined>): string | undefined {
  const ci = env.BUILD_REQUESTEDFOR ?? env.RELEASE_REQUESTEDFOR ?? env.GITHUB_ACTOR ?? env.GITLAB_USER_NAME ?? env.EZTEST_USER;
  if (ci) return ci;
  try {
    return userInfo().username || undefined;
  } catch {
    return env.USER ?? env.USERNAME;
  }
}

/** Build the run context from the run's recorded environment and the CI variables. */
export function buildRunContext(run: RunResult, env: Record<string, string | undefined> = process.env, o: { environmentName?: string; workers?: number } = {}): RunContext {
  const e = run.environment ?? {};
  const ci = detectCi(env);
  const remote = e.gitRemote ?? (ci.repoUrl ? ci.repoUrl : undefined);
  const web = repoWeb(remote);
  const sha = e.gitCommit ?? ci.sha;
  const versions = new Map<string, string>();
  for (const part of (e.browserVersion ?? '').split(/,\s*/)) {
    const m = /^(\S+)\s+(.+)$/.exec(part.trim());
    if (m) versions.set(m[1], m[2]);
  }
  const browserNames = [...new Set([...(e.browser ? e.browser.split(',').map((s) => s.trim()).filter((s) => s && s !== 'none') : []), ...Object.keys(run.browsers ?? {}), ...run.journeys.map((j) => j.browser).filter((b): b is string => !!b)])];
  const browsers = browserNames.map((name) => ({ name, version: run.browsers?.[name]?.version ?? versions.get(name) ?? (browserNames.length === 1 && e.browserVersion && !versions.size ? e.browserVersion : undefined) }));
  const devices = [...new Set(Object.entries(e).filter(([k]) => /device|emulation|platformName/i.test(k)).map(([, v]) => v))];
  const shardRaw = env.EZTEST_SHARD;
  const shard = shardRaw && /^\d+\/\d+$/.test(shardRaw) ? { index: Number(shardRaw.split('/')[0]), total: Number(shardRaw.split('/')[1]) } : undefined;
  const coll = (env.SYSTEM_COLLECTIONURI ?? env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI)?.replace(/\/+$/, '');
  const buildSystem = ci.ci ?? (env.JENKINS_URL ? 'jenkins' : env.CI ? 'ci' : undefined);
  const build = buildSystem
    ? {
        system: buildSystem,
        ...(ci.buildId ? { id: ci.buildId } : {}),
        ...((env.BUILD_BUILDNUMBER ?? env.GITHUB_RUN_NUMBER ?? env.CI_PIPELINE_IID ?? env.BUILD_NUMBER) ? { number: env.BUILD_BUILDNUMBER ?? env.GITHUB_RUN_NUMBER ?? env.CI_PIPELINE_IID ?? env.BUILD_NUMBER } : {}),
        ...((safeHttpUrl(ci.buildUrl) ?? safeHttpUrl(env.BUILD_URL)) ? { url: safeHttpUrl(ci.buildUrl) ?? safeHttpUrl(env.BUILD_URL) } : {}),
        ...((env.BUILD_DEFINITIONNAME ?? env.GITHUB_WORKFLOW ?? env.CI_PROJECT_NAME ?? env.JOB_NAME) ? { pipeline: env.BUILD_DEFINITIONNAME ?? env.GITHUB_WORKFLOW ?? env.CI_PROJECT_NAME ?? env.JOB_NAME } : {}),
        ...((env.BUILD_REASON ?? env.GITHUB_EVENT_NAME ?? env.CI_PIPELINE_SOURCE) ? { reason: env.BUILD_REASON ?? env.GITHUB_EVENT_NAME ?? env.CI_PIPELINE_SOURCE } : {}),
      }
    : undefined;
  const release = env.RELEASE_RELEASENAME || env.RELEASE_RELEASEWEBURL
    ? { name: env.RELEASE_RELEASENAME, url: safeHttpUrl(env.RELEASE_RELEASEWEBURL) ?? (coll && env.SYSTEM_TEAMPROJECT && env.RELEASE_RELEASEID ? `${coll}/${encodeURIComponent(env.SYSTEM_TEAMPROJECT)}/_releaseProgress?releaseId=${env.RELEASE_RELEASEID}` : undefined), environment: env.RELEASE_ENVIRONMENTNAME }
    : undefined;
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(e)) if (!KNOWN_ENV.has(k) && typeof v === 'string') extra[k] = v;
  let tz = 'UTC';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    // keep UTC
  }
  return {
    ...(o.environmentName ?? e.environment ? { environment: o.environmentName ?? e.environment } : {}),
    ...(e.baseUrl ? { baseUrl: e.baseUrl } : {}),
    browsers,
    devices,
    ...(build ? { build } : {}),
    ...(release ? { release } : {}),
    ...(web.url || web.provider ? { repository: { provider: web.provider, url: web.url, name: web.name } } : {}),
    ...((e.gitBranch ?? ci.branch) ? { branch: e.gitBranch ?? ci.branch } : {}),
    ...(ci.targetBranch ? { targetBranch: ci.targetBranch } : {}),
    ...(sha ? { commit: { sha, ...(web.commit ? { url: web.commit(sha) } : {}), ...(e.gitAuthor ? { author: e.gitAuthor } : {}) } } : {}),
    ...(ci.pr ? { pullRequest: { number: ci.pr, ...(web.pr ? { url: web.pr(ci.pr) } : {}) } } : {}),
    ...((build?.reason ?? (buildSystem ? undefined : 'local')) ? { trigger: build?.reason ?? 'local' } : {}),
    ...(safeUser(env) ? { user: safeUser(env) } : {}),
    eztestVersion: EZTEST_VERSION,
    node: e.node ?? process.version,
    machine: { host: env.EZTEST_HIDE_HOST ? undefined : hostname(), os: `${osType()} ${osRelease()}`.trim(), cpus: cpus().length || undefined, memoryGb: Math.round(totalmem() / 1024 ** 3) || undefined },
    ...(shard ? { shard } : {}),
    ...(o.workers ? { workers: o.workers } : {}),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    timeZone: env.TZ || tz,
    extra,
  };
}

/** The context captured for this run (context.json), else captured now and saved. */
export async function loadOrCaptureContext(runDir: string, run: RunResult, env: Record<string, string | undefined> = process.env, o: { environmentName?: string; workers?: number } = {}): Promise<RunContext> {
  const p = join(runDir, CONTEXT_FILE);
  if (existsSync(p)) {
    try {
      const c = JSON.parse(await readFile(p, 'utf8')) as RunContext;
      if (c && c.startedAt === run.startedAt) return c;
    } catch {
      // re-capture
    }
  }
  const c = buildRunContext(run, env, o);
  await writeFile(p, JSON.stringify(c, null, 2)).catch(() => undefined);
  return c;
}
