/** Post a run to its pull request: status / check with annotations, and the summary comment updated in place. */
import type { ImpactResult } from '../insights/impact.js';
import { GitRepo } from '../git/repo.js';
import type { CiContext } from './detect.js';
import { buildPrSummary, journeyFileIndex, loadRunForPr, type GatePolicy, type PrSummary } from './summary.js';
import { COMMENT_MARKER, type CommentResult, type StatusResult, type VcsProvider } from './types.js';
import type { AzureReposProvider } from './azure.js';

export interface PrReportOptions {
  provider: VcsProvider;
  runDir: string;
  /** Project directory (where journeys are found). */
  cwd: string;
  journeys?: string[];
  ci?: CiContext;
  sha?: string;
  pr?: number;
  impact?: ImpactResult;
  policy?: GatePolicy;
  context?: string;
  reportUrl?: string;
  /** Post the comment (default true when a PR is known). */
  comment?: boolean;
}

export interface PrReportResult {
  summary: PrSummary;
  sha?: string;
  pr?: number;
  status?: StatusResult;
  comment?: CommentResult;
  warnings: string[];
}

export async function reportPullRequest(o: PrReportOptions): Promise<PrReportResult> {
  const warnings: string[] = [];
  const loaded = await loadRunForPr(o.runDir);
  let root = o.cwd;
  try {
    root = (await GitRepo.open(o.cwd)).root;
  } catch {
    // not a checkout: paths stay relative to the project
  }
  const files = await journeyFileIndex(root, o.cwd, o.journeys ?? ['journeys']);
  const summary = buildPrSummary({ ...loaded, files, impact: o.impact, policy: o.policy, context: o.context, reportUrl: o.reportUrl, buildUrl: o.ci?.buildUrl });
  const sha = o.sha ?? o.ci?.sha ?? loaded.run.environment?.gitCommit;
  let pr = o.pr ?? o.ci?.pr;
  const branch = o.ci?.branch ?? loaded.run.environment?.gitBranch;
  if (!pr && branch) pr = (await o.provider.findPullRequest(branch).catch(() => undefined))?.number;
  let status: StatusResult | undefined;
  if (sha) {
    status = await o.provider.setStatus({ sha, state: summary.state, context: o.context ?? 'EZTest', description: summary.description, targetUrl: o.reportUrl ?? o.ci?.buildUrl, pr, annotations: summary.annotations, summary: summary.markdown });
    warnings.push(...status.warnings);
  } else warnings.push('no commit SHA known (not in CI and the run did not record one); status not posted');
  let comment: CommentResult | undefined;
  if (pr && o.comment !== false) {
    comment =
      o.provider.kind === 'azure-devops'
        ? await (o.provider as AzureReposProvider).upsertComment(pr, COMMENT_MARKER, summary.markdown, { resolved: summary.decision === 'GO' })
        : await o.provider.upsertComment(pr, COMMENT_MARKER, summary.markdown);
  } else if (!pr) warnings.push('no pull request found for this build; comment not posted');
  return { summary, sha, pr, status, comment, warnings };
}
