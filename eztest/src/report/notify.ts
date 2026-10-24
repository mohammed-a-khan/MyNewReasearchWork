/**
 * The run summary card for chat: a Microsoft Teams Adaptive Card and Slack
 * Block Kit blocks, built from the report model - verdict, key figures and
 * the change against the previous run, context, the top failures (each linked
 * to its permalink in the report) and buttons to the report, the Azure DevOps
 * test run, the build and the pull request.
 */
import type { ReportModel, TestModel } from './data.js';
import { fmtMs, fmtPct } from './charts.js';
import { safeHttpUrl } from './integrations.js';

export interface CardLinks {
  /** Where the HTML report is reachable (results server, CI artefact, ADO attachment...). */
  report?: string;
  adoRun?: string;
  build?: string;
  pullRequest?: string;
  resultsServer?: string;
}

/** Links for the card from the model's integrations and context (and an explicit report URL). */
export function cardLinks(m: ReportModel, o: { reportUrl?: string; runUrl?: string } = {}): CardLinks {
  const ado = m.integrations.ado;
  const report = safeHttpUrl(o.reportUrl) ?? safeHttpUrl(o.runUrl) ?? safeHttpUrl(m.integrations.resultsServer?.url);
  return {
    ...(report ? { report } : {}),
    ...(safeHttpUrl(ado?.publish?.runUrl) ? { adoRun: safeHttpUrl(ado!.publish!.runUrl) } : {}),
    ...((safeHttpUrl(ado?.build?.url) ?? safeHttpUrl(m.context?.build?.url)) ? { build: safeHttpUrl(ado?.build?.url) ?? safeHttpUrl(m.context?.build?.url) } : {}),
    ...((safeHttpUrl(m.integrations.pullRequest?.url) ?? safeHttpUrl(m.context?.pullRequest?.url)) ? { pullRequest: safeHttpUrl(m.integrations.pullRequest?.url) ?? safeHttpUrl(m.context?.pullRequest?.url) } : {}),
    ...(safeHttpUrl(o.runUrl) ? { resultsServer: safeHttpUrl(o.runUrl) } : {}),
  };
}

const VERDICT = { GO: 'GO', GO_WITH_RISKS: 'GO WITH RISKS', NO_GO: 'NO GO' } as const;

function headline(m: ReportModel): string {
  const k = m.kpis;
  const bad = k.failed + k.errors;
  return bad ? `${bad} of ${k.total} tests failed` : k.flaky ? `all ${k.total} tests passed, ${k.flaky} only on retry` : `all ${k.total} tests passed`;
}

function topFailures(m: ReportModel, n = 5): TestModel[] {
  return m.tests.filter((t) => t.state === 'failed' || t.state === 'error').sort((a, b) => b.risk - a.risk).slice(0, n);
}

const permalink = (report: string | undefined, id: string) => (report && /report\.html(?:$|[?#])/.test(report) ? `${report.split('#')[0]}#test/${encodeURIComponent(id)}` : report);

function deltaText(m: ReportModel): string | undefined {
  const p = m.previous?.kpis;
  if (!p) return undefined;
  const d = (m.kpis.passRate - p.passRate) * 100;
  const f = m.kpis.failed + m.kpis.errors - (p.failed + p.errors);
  return `vs previous run: pass rate ${d >= 0 ? '+' : ''}${d.toFixed(1)} pp, ${f >= 0 ? '+' : ''}${f} failing`;
}

/** Adaptive Card 1.5 content (wrap it in a Teams message attachment). */
export function buildTeamsCard(m: ReportModel, links: CardLinks = {}): Record<string, unknown> {
  const k = m.kpis;
  const v = m.verdict.decision;
  const style = v === 'GO' ? 'good' : v === 'NO_GO' ? 'attention' : 'warning';
  const kpi = (label: string, value: string, color?: string) => ({
    type: 'Column', width: 'stretch',
    items: [
      { type: 'TextBlock', text: value, size: 'ExtraLarge', weight: 'Bolder', spacing: 'None', ...(color ? { color } : {}) },
      { type: 'TextBlock', text: label, size: 'Small', isSubtle: true, spacing: 'None' },
    ],
  });
  const ctx = m.context;
  const facts = [
    ...(ctx?.environment ? [{ title: 'Environment', value: ctx.environment }] : []),
    ...(ctx?.branch ? [{ title: 'Branch', value: ctx.branch }] : []),
    ...(ctx?.commit ? [{ title: 'Commit', value: ctx.commit.sha.slice(0, 10) }] : []),
    ...(ctx?.build ? [{ title: 'Build', value: `${ctx.build.pipeline ? `${ctx.build.pipeline} ` : ''}${ctx.build.number ?? ctx.build.id ?? ''}`.trim() }] : []),
    { title: 'Run', value: `${m.runId} (${fmtMs(m.durationMs)})` },
    ...(m.verdict.score !== undefined ? [{ title: 'Readiness score', value: `${m.verdict.score} / 100` }] : []),
  ];
  const fails = topFailures(m);
  const delta = deltaText(m);
  const actions = [
    ...(links.report ? [{ type: 'Action.OpenUrl', title: 'Open the report', url: links.report, style: 'positive' }] : []),
    ...(links.adoRun ? [{ type: 'Action.OpenUrl', title: 'Azure DevOps test run', url: links.adoRun }] : []),
    ...(links.build ? [{ type: 'Action.OpenUrl', title: 'Build', url: links.build }] : []),
    ...(links.pullRequest ? [{ type: 'Action.OpenUrl', title: 'Pull request', url: links.pullRequest }] : []),
  ];
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    msteams: { width: 'Full' },
    body: [
      {
        type: 'Container', style, bleed: true,
        items: [
          { type: 'TextBlock', text: m.brand.name, size: 'Small', weight: 'Bolder', isSubtle: true, spacing: 'None' },
          { type: 'TextBlock', text: m.title, size: 'Large', weight: 'Bolder', wrap: true, spacing: 'None' },
          { type: 'TextBlock', text: `${VERDICT[v]} — ${headline(m)}`, weight: 'Bolder', color: style === 'good' ? 'Good' : style === 'attention' ? 'Attention' : 'Warning', wrap: true },
        ],
      },
      { type: 'ColumnSet', spacing: 'Medium', columns: [kpi('Tests', String(k.total)), kpi('Passed', String(k.passed + k.healed + k.flaky), 'Good'), kpi('Failed', String(k.failed + k.errors), k.failed + k.errors ? 'Attention' : undefined), kpi('Flaky', String(k.flaky), k.flaky ? 'Warning' : undefined), kpi('Pass rate', fmtPct(k.passRate, 1))] },
      ...(delta ? [{ type: 'TextBlock', text: delta, size: 'Small', isSubtle: true, spacing: 'Small' }] : []),
      { type: 'FactSet', spacing: 'Medium', facts },
      ...(fails.length
        ? [{
            type: 'Container', spacing: 'Medium', separator: true,
            items: [
              { type: 'TextBlock', text: `Top failures${fails.length < k.failed + k.errors ? ` (${fails.length} of ${k.failed + k.errors})` : ''}`, weight: 'Bolder' },
              ...fails.map((t) => ({
                type: 'Container', spacing: 'Small',
                ...(permalink(links.report, t.id) ? { selectAction: { type: 'Action.OpenUrl', url: permalink(links.report, t.id), title: t.name } } : {}),
                items: [
                  { type: 'TextBlock', text: t.name, weight: 'Bolder', wrap: true, spacing: 'None' },
                  { type: 'TextBlock', text: `${t.failedStep ? `${t.failedStep}: ` : ''}${(t.error?.message ?? '').split('\n')[0].slice(0, 200)}`, size: 'Small', isSubtle: true, wrap: true, spacing: 'None' },
                  ...(t.triage || t.owners.length ? [{ type: 'TextBlock', text: [t.triage ? `probable cause: ${t.triage.category}` : '', t.owners.length ? `owners: ${t.owners.join(', ')}` : '', t.bugs.length ? `bug ${t.bugs.map((b) => b.id).join(', ')}` : ''].filter(Boolean).join(' · '), size: 'Small', isSubtle: true, wrap: true, spacing: 'None' }] : []),
                ],
              })),
            ],
          }]
        : []),
    ],
    actions,
  };
}

/** The Teams incoming-webhook message carrying the card. */
export function teamsMessage(card: Record<string, unknown>): Record<string, unknown> {
  return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }] };
}

const mrkdwn = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/** Slack Block Kit message (text fallback plus blocks). */
export function buildSlackMessage(m: ReportModel, links: CardLinks = {}): Record<string, unknown> {
  const k = m.kpis;
  const v = m.verdict.decision;
  const mark = v === 'GO' ? ':large_green_circle:' : v === 'NO_GO' ? ':red_circle:' : ':large_yellow_circle:';
  const title = `${m.brand.name}: ${VERDICT[v]} — ${headline(m)}`;
  const fails = topFailures(m);
  const delta = deltaText(m);
  const ctx = m.context;
  const buttons = [
    ...(links.report ? [{ type: 'button', text: { type: 'plain_text', text: 'Open the report' }, url: links.report, style: 'primary' }] : []),
    ...(links.adoRun ? [{ type: 'button', text: { type: 'plain_text', text: 'Azure DevOps test run' }, url: links.adoRun }] : []),
    ...(links.build ? [{ type: 'button', text: { type: 'plain_text', text: 'Build' }, url: links.build }] : []),
    ...(links.pullRequest ? [{ type: 'button', text: { type: 'plain_text', text: 'Pull request' }, url: links.pullRequest }] : []),
  ];
  return {
    text: title,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: title.slice(0, 150) } },
      { type: 'section', text: { type: 'mrkdwn', text: `${mark} *${mrkdwn(m.title)}*${delta ? `\n_${mrkdwn(delta)}_` : ''}` } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Tests*\n${k.total}` }, { type: 'mrkdwn', text: `*Pass rate*\n${fmtPct(k.passRate)}` },
        { type: 'mrkdwn', text: `*Failed*\n${k.failed + k.errors}` }, { type: 'mrkdwn', text: `*Flaky / healed*\n${k.flaky} / ${k.healed}` },
        { type: 'mrkdwn', text: `*Duration*\n${fmtMs(m.durationMs)}` }, { type: 'mrkdwn', text: `*Readiness*\n${VERDICT[v]}${m.verdict.score !== undefined ? ` (${m.verdict.score})` : ''}` },
      ] },
      ...(ctx ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: mrkdwn([ctx.environment, ctx.branch, ctx.commit?.sha.slice(0, 10), ctx.build?.number, m.runId].filter(Boolean).join(' · ')) }] }] : []),
      ...(fails.length ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Top failures*\n${fails.map((t) => { const u = permalink(links.report, t.id); return `• ${u ? `<${u}|${mrkdwn(t.name)}>` : `*${mrkdwn(t.name)}*`} — ${mrkdwn((t.error?.message ?? '').split('\n')[0].slice(0, 140))}`; }).join('\n')}` } }] : []),
      ...(buttons.length ? [{ type: 'actions', elements: buttons }] : []),
    ],
  };
}
