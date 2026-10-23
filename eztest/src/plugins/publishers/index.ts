/**
 * First-party publisher plugins: Slack and Microsoft Teams incoming webhooks,
 * and Jira bugs for failures. They are written against the public plugin API,
 * exactly like an organisation's own plugin would be.
 */
import type { RunResult } from '../../core/index.js';
import { definePlugin, PLUGIN_API_VERSION, type EzPlugin } from '../api.js';
import type { PublishContext, PublishResult } from '../registry.js';
import { almPlugins } from './alm.js';

function headline(run: RunResult, ctx: PublishContext): { title: string; ok: boolean; facts: Array<[string, string]>; failed: string[] } {
  const s = run.summary;
  const bad = s.failed + s.errors;
  const ready = ctx.analysis.readiness;
  const facts: Array<[string, string]> = [
    ['Journeys', `${s.total}`],
    ['Passed', `${s.passed}${s.passedHealed ? ` (+${s.passedHealed} healed)` : ''}`],
    ['Failed', `${bad}`],
    ['Duration', `${Math.round(run.durationMs / 1000)} s`],
  ];
  if (ready) facts.push(['Readiness', `${ready.decision} (score ${ready.score})`]);
  const failed = run.journeys.filter((j) => j.status === 'failed' || j.status === 'error').map((j) => j.name);
  const project = typeof ctx.options.title === 'string' ? ctx.options.title : 'EZTest';
  return { title: `${project}: ${bad ? `${bad} of ${s.total} journeys failed` : `all ${s.total} journeys passed`} (${run.runId})`, ok: bad === 0, facts, failed };
}

async function postJson(ctx: PublishContext, url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return ctx.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
}

const webhookOf = async (ctx: PublishContext): Promise<string> => {
  const raw = ctx.options.webhook ?? ctx.options.url;
  if (typeof raw !== 'string' || !raw) throw new Error('needs "webhook" (a secret reference such as secret://env/SLACK_WEBHOOK)');
  return ctx.resolveSecret(raw);
};

export const slackPlugin: EzPlugin = definePlugin({
  name: 'eztest/slack',
  apiVersion: PLUGIN_API_VERSION,
  setup(api) {
    api.registerPublisher({
      name: 'slack',
      async publish(ctx): Promise<PublishResult> {
        const h = headline(ctx.run, ctx);
        const lines = h.failed.slice(0, 10).map((n) => `• ${n}`);
        const body = {
          text: h.title,
          blocks: [
            { type: 'header', text: { type: 'plain_text', text: h.title.slice(0, 150) } },
            { type: 'section', fields: h.facts.map(([k, v]) => ({ type: 'mrkdwn', text: `*${k}*\n${v}` })) },
            ...(lines.length ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Failed*\n${lines.join('\n')}${h.failed.length > 10 ? `\n…and ${h.failed.length - 10} more` : ''}` } }] : []),
            ...(ctx.runUrl ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open run' }, url: ctx.runUrl }] }] : []),
          ],
        };
        if (ctx.options.dryRun) return { ok: true, message: 'dry run: would post to Slack', details: body };
        const r = await postJson(ctx, await webhookOf(ctx), body);
        return r.ok ? { ok: true, message: 'posted to Slack' } : { ok: false, message: `Slack webhook returned HTTP ${r.status}` };
      },
    });
  },
});

export const teamsPlugin: EzPlugin = definePlugin({
  name: 'eztest/teams',
  apiVersion: PLUGIN_API_VERSION,
  setup(api) {
    api.registerPublisher({
      name: 'teams',
      async publish(ctx): Promise<PublishResult> {
        const h = headline(ctx.run, ctx);
        const card = {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: h.title, weight: 'Bolder', size: 'Medium', wrap: true, color: h.ok ? 'Good' : 'Attention' },
            { type: 'FactSet', facts: h.facts.map(([title, value]) => ({ title, value })) },
            ...(h.failed.length ? [{ type: 'TextBlock', text: `Failed: ${h.failed.slice(0, 10).join(', ')}${h.failed.length > 10 ? ` and ${h.failed.length - 10} more` : ''}`, wrap: true }] : []),
          ],
          actions: ctx.runUrl ? [{ type: 'Action.OpenUrl', title: 'Open run', url: ctx.runUrl }] : [],
        };
        const body = { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }] };
        if (ctx.options.dryRun) return { ok: true, message: 'dry run: would post to Teams', details: body };
        const r = await postJson(ctx, await webhookOf(ctx), body);
        return r.ok || r.status === 202 ? { ok: true, message: 'posted to Teams' } : { ok: false, message: `Teams webhook returned HTTP ${r.status}` };
      },
    });
  },
});

export const firstPartyPlugins: EzPlugin[] = [slackPlugin, teamsPlugin, ...almPlugins];
