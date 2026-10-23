/**
 * JUnit XML. Healed steps stay visible through <properties> on the testcase
 * (eztest.status=passed-healed, eztest.heal.<stepId>=...), so CI dashboards
 * that only know pass/fail still carry the signal.
 */
import type { JourneyResult, RunResult } from '../core/index.js';
import { EzTestError } from '../core/index.js';
import { escapeXml as x } from './escape.js';
import { formatLocator, type ReportInsights } from './model.js';

const secs = (ms: number) => (ms / 1000).toFixed(3);

function prop(name: string, value: unknown): string {
  return `<property name="${x(name)}" value="${x(value)}"/>`;
}

function testcase(j: JourneyResult, insights: ReportInsights): string {
  const props: string[] = [
    prop('eztest.journeyId', j.journeyId),
    prop('eztest.status', j.status),
    prop('eztest.attempt', j.attempt),
    prop('eztest.risk', j.risk),
  ];
  for (const t of j.tags) props.push(prop('eztest.tag', t));
  for (const r of j.requirements) props.push(prop('eztest.requirement', r));
  const heals = j.steps.filter((s) => s.heal);
  if (heals.length) props.push(prop('eztest.healed', 'true'));
  for (const s of heals) {
    const h = s.heal!;
    props.push(
      prop(
        `eztest.heal.${s.stepId}`,
        `${h.tier} confidence=${h.confidence.toFixed(2)} verified=${h.verified} ${h.original.map(formatLocator).join(' | ')} -> ${formatLocator(h.healed)}`,
      ),
    );
  }
  const flaky = insights.flaky?.find((f) => f.journeyId === j.journeyId);
  if (flaky) props.push(prop('eztest.flaky', flaky.state));
  const tri = insights.triage?.verdicts.find((v) => v.journeyId === j.journeyId);
  if (tri) {
    props.push(prop('eztest.triage', `${tri.category} (${(tri.confidence * 100).toFixed(0)}%, ${tri.status})`));
    props.push(prop('eztest.triage.evidence', tri.evidence.join(',')));
  }
  const failing = j.steps.find((s) => s.status === 'failed' || s.status === 'blocked');
  const msg = failing?.error?.message ?? j.error?.message ?? (failing ? `Step ${failing.stepId} ${failing.status}` : `Journey ${j.status}`);
  const detail = [
    failing ? `Step ${failing.stepId}: ${failing.intent}` : '',
    ...(failing?.conditions.filter((c) => !c.passed).map((c) => `post-condition ${c.condition.type} failed${c.actual ? ` (actual: ${c.actual})` : ''}`) ?? []),
    failing?.error?.stack ?? j.error?.stack ?? '',
    failing?.evidence.length ? `evidence: ${failing.evidence.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  let outcome = '';
  if (j.status === 'failed') outcome = `<failure message="${x(msg)}" type="${x(failing?.error?.name ?? 'AssertionError')}">${x(detail)}</failure>`;
  else if (j.status === 'error') outcome = `<error message="${x(msg)}" type="${x(j.error?.name ?? 'Error')}">${x(detail)}</error>`;
  else if (j.status === 'skipped') outcome = '<skipped/>';
  const log = j.steps
    .map((s) => `[${s.status}] ${s.stepId} ${s.intent} (${s.durationMs} ms)${s.heal ? ` healed:${s.heal.tier}${s.heal.verified ? '' : ' UNVERIFIED'}` : ''}`)
    .join('\n');
  return `<testcase name="${x(j.name)}" classname="${x(`eztest.${j.journeyId}`)}" time="${secs(j.durationMs)}"><properties>${props.join('')}</properties>${outcome}<system-out>${x(log)}</system-out></testcase>`;
}

export function renderJUnit(run: RunResult, insights: ReportInsights = {}): string {
  if (run.journeys.length === 0) throw new EzTestError('renderJUnit: run has no journeys', 'INVALID_INPUT');
  const s = run.summary;
  const attrs = `tests="${s.total}" failures="${s.failed}" errors="${s.errors}" skipped="${s.skipped}" time="${secs(run.durationMs)}" timestamp="${x(run.startedAt)}"`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="${x(`eztest ${run.runId}`)}" ${attrs}>
<testsuite name="${x(run.runId)}" ${attrs}><properties>${prop('eztest.runId', run.runId)}${prop('eztest.passedHealed', s.passedHealed)}${Object.entries(run.environment)
    .map(([k, v]) => prop(`env.${k}`, v))
    .join('')}${run.evidenceHead ? prop('eztest.evidenceHead', run.evidenceHead) : ''}</properties>
${run.journeys.map((j) => testcase(j, insights)).join('\n')}
</testsuite>
</testsuites>
`;
}
