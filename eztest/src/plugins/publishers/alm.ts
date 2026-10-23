/**
 * First-party Jira publisher (plugin API): deduplicated bugs for failures
 * (with the run link and evidence attachments). Azure DevOps has its own
 * module (src/alm-ado). EZTest publishes to no test-management tool.
 *
 * Accepts `dryRun: true` (or `eztest publish --dry-run`): it returns what it
 * would file and sends nothing.
 */
import type { EvidenceRef } from '../../core/index.js';
import { readEvidenceManifest } from '../../insights/artifacts.js';
import { fileJiraBug, JiraClient } from '../../alm-jira/index.js';
import { definePlugin, PLUGIN_API_VERSION, type EzPlugin } from '../api.js';
import type { PublishContext, PublishResult } from '../registry.js';

type Opts = Record<string, unknown>;
const str = (o: Opts, k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : typeof o[k] === 'number' ? String(o[k]) : undefined);
const need = (o: Opts, k: string, who: string): string => {
  const v = str(o, k);
  if (!v) throw new Error(`${who} needs "${k}"`);
  return v;
};

async function evidenceMap(ctx: PublishContext): Promise<Map<string, EvidenceRef>> {
  return new Map((await readEvidenceManifest(ctx.runDir).catch(() => [])).map((e) => [e.id, e]));
}

const dry = (ctx: PublishContext) => ctx.options.dryRun === true;

// ------------------------------------------------------------------ Jira

async function publishJira(ctx: PublishContext): Promise<PublishResult> {
  const o = ctx.options;
  const client = new JiraClient({
    baseUrl: need(o, 'baseUrl', 'jira'), deployment: str(o, 'deployment') as 'cloud' | 'datacenter' | undefined,
    email: str(o, 'email'), apiToken: str(o, 'apiToken') ? await ctx.resolveSecret(str(o, 'apiToken')!) : undefined,
    token: str(o, 'token') ? await ctx.resolveSecret(str(o, 'token')!) : undefined, fetch: ctx.fetch,
  });
  const categories = Array.isArray(o.categories) ? (o.categories as string[]) : ['product-bug', 'unknown'];
  const verdicts = new Map((ctx.analysis.triage?.verdicts ?? []).map((v) => [v.journeyId, v]));
  const evidence = [...(await evidenceMap(ctx)).values()];
  const results = [];
  for (const j of ctx.run.journeys.filter((x) => x.status === 'failed' || x.status === 'error')) {
    const v = verdicts.get(j.journeyId);
    if (v && !categories.includes(v.category)) continue;
    results.push(await fileJiraBug({
      client, projectKey: need(o, 'projectKey', 'jira'), run: ctx.run, runDir: ctx.runDir, journeyId: j.journeyId, evidence, runUrl: ctx.runUrl,
      classification: v ? { category: v.category, confidence: v.confidence, reasons: v.reasons } : undefined, issueType: str(o, 'issueType'), dryRun: dry(ctx),
    }));
  }
  const created = results.filter((r) => r.action === 'created').length;
  const commented = results.filter((r) => r.action === 'commented').length;
  return { ok: true, message: dry(ctx) ? `dry run: ${results.length} bug(s) would be filed or updated` : `${created} bug(s) created, ${commented} existing bug(s) commented`, details: results };
}

const wrap = (name: string, fn: (ctx: PublishContext) => Promise<PublishResult>): EzPlugin =>
  definePlugin({ name: `eztest/${name}`, apiVersion: PLUGIN_API_VERSION, setup: (api) => api.registerPublisher({ name, publish: fn }) });

export const almPlugins: EzPlugin[] = [
  wrap('jira', publishJira),
];
