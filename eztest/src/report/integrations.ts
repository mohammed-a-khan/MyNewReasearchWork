/**
 * What the run's integrations did, recorded next to the run (integrations.json)
 * so the HTML and JSON reports can show and link them: Azure DevOps (test run,
 * results, test cases, plan/suite, requirements, bugs, build, release, PR),
 * Jira bugs, Slack/Teams notifications, git and CODEOWNERS, and the EZTest
 * results server. Each publisher merges its part in; the reports are then
 * rendered again from report.json (see rerenderReports).
 */
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const INTEGRATIONS_FILE = 'integrations.json';

export type PublishStatus = 'success' | 'partial' | 'failed' | 'skipped';

export interface LinkRef {
  label: string;
  url?: string;
}

export interface AdoResultLink {
  journeyId: string;
  testCaseId: number;
  resultId?: number;
  outcome?: string;
  url?: string;
}

export interface AdoBugLink {
  journeyId: string;
  id: number;
  action: 'created' | 'deduped' | 'updated' | 'commented';
  url?: string;
  signature?: string;
}

export interface AdoIntegration {
  /** https://dev.azure.com/org or the on-prem collection URL. */
  collectionUrl?: string;
  project?: string;
  publish?: {
    status: PublishStatus;
    /** Why it was partial, failed or skipped. */
    reason?: string;
    at: string;
    runId?: number;
    runName?: string;
    runUrl?: string;
    planId?: number;
    suiteId?: number;
    results: AdoResultLink[];
    unmapped: string[];
    missingPoints: Array<{ journeyId: string; testCaseId: number }>;
    attachments: number;
    warnings: string[];
  };
  bugs?: AdoBugLink[];
  build?: { id?: string; number?: string; url?: string; definition?: string };
  release?: { name?: string; url?: string; environment?: string };
  requirementsCommented?: Array<{ requirement: string; action: string; url?: string }>;
}

export interface PullRequestIntegration {
  provider: string;
  number: number;
  url?: string;
  comment?: { action: string; id?: string | number };
  status?: { kind: string; state?: string; annotations: number };
  at: string;
}

export interface NotificationRecord {
  channel: string;
  ok: boolean;
  message: string;
  at: string;
  /** For dry runs and the report: what the card said (title / facts). */
  title?: string;
}

export interface JiraBugLink {
  journeyId: string;
  key: string;
  action: string;
  url?: string;
}

export interface IntegrationsRecord {
  version: 1;
  updatedAt: string;
  ado?: AdoIntegration;
  pullRequest?: PullRequestIntegration;
  jira?: { baseUrl?: string; bugs: JiraBugLink[]; status: PublishStatus; reason?: string };
  notifications?: NotificationRecord[];
  resultsServer?: { url: string; verified?: boolean; at: string };
  publishers?: Array<{ name: string; ok: boolean; message: string; skipped?: boolean }>;
}

export async function readIntegrations(runDir: string): Promise<IntegrationsRecord | undefined> {
  const p = join(runDir, INTEGRATIONS_FILE);
  if (!existsSync(p)) return undefined;
  try {
    const v = JSON.parse(await readFile(p, 'utf8')) as IntegrationsRecord;
    return v && v.version === 1 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Merge a part into integrations.json (shallow per top-level key; notifications and publishers append). */
export async function recordIntegration(runDir: string, patch: Partial<Omit<IntegrationsRecord, 'version' | 'updatedAt'>>): Promise<IntegrationsRecord> {
  const now = new Date().toISOString();
  const cur: IntegrationsRecord = (await readIntegrations(runDir)) ?? { version: 1, updatedAt: now };
  const next: IntegrationsRecord = { ...cur, updatedAt: now };
  if (patch.ado) next.ado = { ...cur.ado, ...patch.ado };
  if (patch.pullRequest) next.pullRequest = patch.pullRequest;
  if (patch.jira) next.jira = patch.jira;
  if (patch.resultsServer) next.resultsServer = patch.resultsServer;
  if (patch.notifications) {
    const keep = (cur.notifications ?? []).filter((n) => !patch.notifications!.some((m) => m.channel === n.channel));
    next.notifications = [...keep, ...patch.notifications];
  }
  if (patch.publishers) {
    const keep = (cur.publishers ?? []).filter((n) => !patch.publishers!.some((m) => m.name === n.name));
    next.publishers = [...keep, ...patch.publishers];
  }
  const p = join(runDir, INTEGRATIONS_FILE);
  const tmp = `${p}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2));
  await rename(tmp, p);
  return next;
}

// ------------------------------------------------------------------ Azure DevOps web links

const trimSlash = (s: string) => s.replace(/\/+$/, '');

export interface AdoWebBase {
  collectionUrl: string;
  project: string;
}

export const adoWeb = {
  project: (b: AdoWebBase) => `${trimSlash(b.collectionUrl)}/${encodeURIComponent(b.project)}`,
  workItem: (b: AdoWebBase, id: number | string) => `${adoWeb.project(b)}/_workitems/edit/${encodeURIComponent(String(id))}`,
  testRun: (b: AdoWebBase, runId: number) => `${adoWeb.project(b)}/_testManagement/runs?_a=runCharts&runId=${runId}`,
  testResult: (b: AdoWebBase, runId: number, resultId: number) => `${adoWeb.project(b)}/_testManagement/runs?_a=resultSummary&runId=${runId}&resultId=${resultId}`,
  testPlan: (b: AdoWebBase, planId: number, suiteId?: number) => `${adoWeb.project(b)}/_testPlans/execute?planId=${planId}${suiteId ? `&suiteId=${suiteId}` : ''}`,
  build: (b: AdoWebBase, buildId: number | string) => `${adoWeb.project(b)}/_build/results?buildId=${encodeURIComponent(String(buildId))}`,
  pullRequest: (b: AdoWebBase, repo: string, pr: number) => `${adoWeb.project(b)}/_git/${encodeURIComponent(repo)}/pullrequest/${pr}`,
  commit: (b: AdoWebBase, repo: string, sha: string) => `${adoWeb.project(b)}/_git/${encodeURIComponent(repo)}/commit/${encodeURIComponent(sha)}`,
};

/** Only http(s) links are ever rendered (a hostile config or record cannot inject javascript: URLs). */
export function safeHttpUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : undefined;
  } catch {
    return undefined;
  }
}
