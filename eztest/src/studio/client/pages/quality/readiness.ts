/**
 * Release readiness (#/quality/readiness/<runId>): the GO / GO_WITH_RISKS /
 * NO_GO decision with every policy gate and its reasons, risk-weighted
 * coverage, the decision trend, what would make it GO, a validated policy
 * editor (diff before saving) and a named sign-off recorded in the run's
 * evidence vault (ed25519-signed when a key is configured).
 */
import { api, ApiError } from '../../core/api.js';
import { clear, h, uid } from '../../core/dom.js';
import { dateTime, pct, plural, relTime } from '../../core/format.js';
import { registerPage } from '../../core/registry.js';
import { link, navigate, type Route } from '../../core/router.js';
import { badge, button, card } from '../../ui/badge.js';
import { icon } from '../../ui/icons.js';
import { toast, toastError } from '../../ui/toast.js';
import { lineChart } from './charts.js';
import { askReviewer, autoRefresh, confirmWith, diffView, meter, qualityFrame, reviewer, runSelect, type DiffLine, type RunOption } from './common.js';

interface Gate {
  gate: string;
  severity: string;
  status: string;
  summary: string;
  cites: { evidence: string[]; journeys: string[]; requirements: string[] };
  exception?: { approver: string; reason: string; expires?: string };
}

interface Readiness {
  runId: string | null;
  startedAt?: string;
  policy: { path: string; exists: boolean; configured: boolean; text: string; hash?: string; error?: string; gates: string[] };
  result?: { decision: string; score: number; gates: Gate[]; rationale: Array<{ gate?: string; kind: string; text: string }>; quarantineIgnored?: string[]; exceptionsIgnored: Array<{ gate: string; why: string }> };
  recorded?: { decision: string; score: number; evaluatedAt: string };
  coverage?: { weighted: number; healedCredit: number; byRisk: Array<{ risk: number; total: number; passed: number; healed: number; failed: number; quarantined: number }> };
  quarantine?: { active: string[]; warnings: string[] };
  overrides?: Array<{ journeyId: string; from: string; to: string; by: string; inherited: boolean }>;
  toGo?: Array<{ gate?: string; action: string; link?: string; journeys?: string[] }>;
  signoffs?: Array<{ approver: string; comment: string; decision: string; score: number; signedAt: string; evidenceId: string; signature?: { keyFingerprint: string }; unsigned?: string; digest: string }>;
  signing?: { configured: boolean; source?: string; fingerprint?: string; hint: string };
  trend: Array<{ runId: string; startedAt?: string; decision?: string; score?: number }>;
}

const GATE_LABEL: Record<string, string> = {
  noFailedCriticalJourneys: 'No failed critical journeys',
  maxHealedRatio: 'Healed ratio within limit',
  minPassRate: 'Minimum pass rate',
  noOpenProductBugs: 'No open product bugs',
  perfBudgets: 'Performance budgets',
  a11yNoCritical: 'No critical accessibility issues',
  docsReconciled: 'Documents reconciled',
  requirementsCovered: 'Requirements covered',
};

const GATE_STATUS: Record<string, [string, string]> = { pass: ['ok', 'Pass'], fail: ['bad', 'Fail'], waived: ['warn', 'Waived'], 'no-data': ['warn', 'No data'] };

function decisionStrip(points: Readiness['trend']): HTMLElement {
  const label = (d?: string) => (d === 'GO' ? 'GO' : d === 'GO_WITH_RISKS' ? 'GO with risks' : d === 'NO_GO' ? 'NO GO' : 'no decision');
  return h(
    'ol',
    { class: 'q-decisions', 'aria-label': `Readiness decisions of the last ${points.length} runs, oldest first` },
    points.map((p) =>
      h('li', { class: `q-dec q-dec-${p.decision ?? 'none'}` }, h('a', { href: link('quality', 'readiness', p.runId), title: `${relTime(p.startedAt)}: ${label(p.decision)}${p.score !== undefined ? ` (${p.score})` : ''}` }, h('span', { class: 'sr-only', text: `${relTime(p.startedAt)}: ${label(p.decision)}` }), h('span', { 'aria-hidden': 'true', text: p.decision === 'GO' ? '✓' : p.decision === 'NO_GO' ? '✗' : p.decision ? '!' : '·' }))),
    ),
  );
}

export function registerReadinessPage(): void {
  registerPage({
    id: 'quality-readiness',
    title: 'Readiness',
    icon: 'check',
    route: 'quality/readiness',
    group: 'quality',
    order: 230,
    mount(ctx) {
      const f = qualityFrame(ctx, 'Release readiness', 'Policy-based GO / NO GO with cited reasons. Evaluated live with the current policy, quarantine and triage reclassifications.', { wide: true });
      const runHost = h('div');
      f.toolbar.append(runHost);
      let runId: string | undefined;
      let data: Readiness | undefined;
      let runs: RunOption[] = [];

      const policyEditor = (d: Readiness): HTMLElement => {
        const id = uid('policy');
        const ta = h('textarea', { id, class: 'input q-code-input', rows: 14, spellcheck: 'false', value: d.policy.text, 'aria-describedby': `${id}-status` });
        const status = h('div', { id: `${id}-status`, class: 'q-policy-status', role: 'status' });
        const preview = h('div');
        const showStatus = (ok: boolean, msg: string) => {
          clear(status).append(icon(ok ? 'check' : 'alert', { size: 14 }), h('span', { class: ok ? 'ok-text' : 'bad-text', text: ` ${msg}` }));
        };
        if (d.policy.error) showStatus(false, d.policy.error);
        else if (!d.policy.exists) showStatus(false, `No policy file yet (${d.policy.path}); a starter policy is shown. Save it to enable decisions.`);
        else showStatus(true, `${d.policy.path} is valid.`);
        const validate = async (): Promise<{ ok: boolean; diff: DiffLine[]; baseHash: string } | undefined> => {
          try {
            const r = await api.post<{ ok: boolean; error?: string; preview?: { decision: string; score: number; gates: Array<{ gate: string; status: string }> }; diff: DiffLine[]; baseHash: string }>('/api/quality/readiness/policy/validate', { text: ta.value, runId: d.runId });
            showStatus(r.ok, r.ok ? 'Valid.' : r.error ?? 'Invalid');
            clear(preview);
            if (r.preview) preview.append(h('p', { class: 'small' }, 'With this draft: ', badge(r.preview.decision), ` score ${r.preview.score}`, h('span', { class: 'muted', text: ` · ${r.preview.gates.filter((g) => g.status === 'pass').length}/${r.preview.gates.length} gates pass` })));
            return r;
          } catch (e) {
            showStatus(false, (e as Error).message);
            return undefined;
          }
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        ta.addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(() => void validate(), 500);
        });
        const save = async () => {
          const r = await validate();
          if (!r?.ok) return;
          if (!r.diff.some((l) => l.kind !== ' ')) {
            toast('No changes to save');
            return;
          }
          const ok = await confirmWith(`Save ${d.policy.path}`, h('div', { class: 'stack' }, diffView(d.policy.path, r.diff, { existed: d.policy.exists }), d.policy.configured ? null : h('p', { class: 'muted small', text: `readiness.policyPath is not set in eztest.config.yaml; set it to ${d.policy.path} so runs use this policy.` })), 'Save policy', { size: 'xl' });
          if (!ok) return;
          try {
            await api.put('/api/quality/readiness/policy', { text: ta.value, baseHash: r.baseHash, confirm: true });
            toast(`Saved ${d.policy.path}`, { kind: 'success' });
            await load();
          } catch (e) {
            toastError(e instanceof ApiError && e.status === 409 ? e.message : `Save failed: ${(e as Error).message}`);
          }
        };
        return card(
          'Readiness policy',
          h('div', { class: 'stack' }, h('div', { class: 'field' }, h('label', { for: id }, 'Policy YAML ', h('code', { text: d.policy.path })), ta), status, preview, h('p', { class: 'muted small', text: `Gates: ${d.policy.gates.join(', ')}. Exceptions need a named approver.` })),
          { id: 'policy-editor', actions: [button('Validate', { small: true, icon: 'check', onclick: () => void validate() }), button('Save…', { small: true, kind: 'primary', icon: 'save', id: 'policy-save', onclick: () => void save() })] },
        );
      };

      const signoffCard = (d: Readiness): HTMLElement => {
        const cid = uid('c');
        const aid = uid('a');
        const approver = h('input', { id: aid, class: 'input', value: reviewer.get(), autocomplete: 'name' });
        const comment = h('textarea', { id: cid, class: 'input', rows: 3, placeholder: 'e.g. Approved for release 2.4; known risk in the export journey accepted by product.' });
        const sign = async () => {
          if (!d.result || !d.runId) return;
          if (!approver.value.trim() || !comment.value.trim()) {
            toastError('Enter the approver name and a comment');
            return;
          }
          const ok = await confirmWith(
            'Sign off this run',
            h(
              'div',
              { class: 'stack' },
              h('p', null, `${approver.value.trim()} signs off run `, h('code', { text: d.runId }), ' with decision ', badge(d.result.decision), ` (score ${d.result.score}).`),
              h('p', { text: d.signing?.configured ? `The note is signed with the ed25519 key ${d.signing.fingerprint?.slice(0, 16)}… and appended to the run's hash-chained evidence manifest.` : `${d.signing?.hint ?? ''}` }),
            ),
            'Sign off',
            { size: 'md' },
          );
          if (!ok) return;
          try {
            reviewer.set(approver.value.trim());
            const r = await api.post<{ evidenceId: string; note: { signature?: unknown } }>('/api/quality/readiness/signoff', { runId: d.runId, approver: approver.value.trim(), comment: comment.value.trim(), decision: d.result.decision, confirm: true });
            toast(`Sign-off recorded as evidence ${r.evidenceId}${r.note.signature ? ' (signed)' : ' (hashed, unsigned)'}`, { kind: 'success' });
            await load();
          } catch (e) {
            toastError(`Sign-off failed: ${(e as Error).message}`);
          }
        };
        return card(
          'Sign-off',
          h(
            'div',
            { class: 'stack' },
            (d.signoffs ?? []).length
              ? h('ul', { class: 'rank-list', 'aria-label': 'Recorded sign-offs' }, d.signoffs!.map((s) => h('li', null, h('div', { class: 'rank-main' }, icon(s.signature ? 'shield' : 'info', { size: 14 }), h('strong', { text: s.approver }), badge(s.decision), h('span', { class: 'chip', text: s.evidenceId })), h('div', { class: 'rank-sub' }, h('span', { text: s.comment }), h('span', { text: dateTime(s.signedAt) }), h('span', { text: s.signature ? `ed25519 ${s.signature.keyFingerprint.slice(0, 12)}…` : 'hashed, unsigned' })))))
              : h('p', { class: 'muted', text: 'No sign-off recorded for this run.' }),
            h('p', { class: ['small', d.signing?.configured ? 'ok-text' : 'warn-text'] }, icon(d.signing?.configured ? 'shield' : 'warning', { size: 13 }), h('span', { text: ` ${d.signing?.hint ?? ''}` })),
            d.result
              ? h('div', { class: 'stack' }, h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', { for: aid, text: 'Approver (required)' }), approver), h('div')), h('div', { class: 'field' }, h('label', { for: cid, text: 'Comment (required)' }), comment), h('div', null, button('Sign off…', { kind: 'primary', icon: 'shield', id: 'signoff-btn', onclick: () => void sign() })))
              : h('p', { class: 'muted', text: 'A valid policy is needed before signing off.' }),
          ),
          { id: 'signoff' },
        );
      };

      const render = (d: Readiness) => {
        clear(runHost);
        if (runs.length) runHost.append(runSelect('Run', runs, d.runId ?? undefined, (id) => navigate(link('quality', 'readiness', id))));
        if (!d.runId) {
          return f.content(h('div', { class: 'empty' }, h('p', { class: 'empty-title', text: 'No runs yet' }), h('p', { class: 'empty-text', text: 'Readiness is decided per run. Run your journeys first.' })), h('div', { class: 'q-grid2' }, policyEditor(d)));
        }
        const r = d.result;
        const gateRows = (r?.gates ?? []).map((g) => {
          const [tone, text] = GATE_STATUS[g.status] ?? ['warn', g.status];
          const reasons = (r?.rationale ?? []).filter((x) => x.gate === g.gate && x.text !== g.summary);
          return h(
            'tr',
            { dataset: { gate: g.gate } },
            h('th', { scope: 'row' }, h('span', { text: GATE_LABEL[g.gate] ?? g.gate }), h('span', { class: 'muted small mono', text: g.gate })),
            h('td', null, h('span', { class: 'chip', text: g.severity })),
            h('td', null, badge(tone, text)),
            h('td', null, h('p', { text: g.summary }), reasons.length ? h('ul', { class: 'bullets small' }, reasons.slice(0, 5).map((x) => h('li', { text: x.text }))) : null, g.exception ? h('p', { class: 'small warn-text', text: `Waived by ${g.exception.approver}: ${g.exception.reason}` }) : null),
            h('td', { class: 'small' }, [...g.cites.journeys.slice(0, 4).map((j) => h('code', { class: 'q-cite', text: j })), ...g.cites.evidence.slice(0, 4).map((e) => h('code', { class: 'q-cite', text: e })), ...g.cites.requirements.slice(0, 4).map((q) => h('code', { class: 'q-cite', text: q }))]),
          );
        });
        const scorePoints = d.trend.filter((p) => p.score !== undefined);
        f.content(
          h(
            'section',
            { class: 'q-hero', 'aria-label': 'Decision' },
            r
              ? [
                  h('div', { class: 'q-hero-main' }, h('p', { class: 'q-label', text: 'Decision' }), h('p', { class: 'q-decision', id: 'readiness-decision' }, badge(r.decision)), h('p', { class: 'q-score' }, h('strong', { text: String(r.score) }), h('span', { class: 'muted', text: ' / 100 risk-weighted score' }))),
                  h(
                    'div',
                    { class: 'q-hero-side' },
                    h('p', { class: 'small' }, `${r.gates.filter((g) => g.status === 'pass').length}/${plural(r.gates.length, 'gate')} pass · run `, h('a', { href: link('runs', d.runId), text: d.runId }), ` · ${relTime(d.startedAt)}`),
                    d.recorded && d.recorded.decision !== r.decision ? h('p', { class: 'small warn-text' }, `At analysis time the decision was ${d.recorded.decision} (score ${d.recorded.score}); it changed because of later reviews (quarantine, reclassification) or policy edits.`) : d.recorded ? h('p', { class: 'small muted', text: 'Matches the decision recorded when the run was analyzed.' }) : null,
                    r.quarantineIgnored?.length ? h('p', { class: 'small' }, icon('shield', { size: 12 }), ` Quarantined failures not counted: ${r.quarantineIgnored.join(', ')}`) : null,
                    (d.overrides ?? []).length ? h('p', { class: 'small' }, icon('edit', { size: 12 }), ` Reclassified: ${d.overrides!.map((o) => `${o.journeyId} → ${o.to}`).join(', ')}`) : null,
                  ),
                ]
              : h('div', { class: 'q-callout tone-warn', role: 'status' }, icon('warning', { size: 14 }), h('span', { text: d.policy.error ? ` The policy is invalid: ${d.policy.error}` : ` No readiness policy at ${d.policy.path}. Create one in the editor below.` })),
          ),
          r && (d.toGo ?? []).length
            ? card(
                'What would make this GO',
                h('ol', { class: 'q-togo' }, d.toGo!.map((t) => h('li', null, h('span', { text: t.action }), t.journeys?.length ? h('span', { class: 'muted small', text: ` (${t.journeys.slice(0, 5).join(', ')}${t.journeys.length > 5 ? '…' : ''})` }) : null, t.link ? [' ', h('a', { href: t.link, text: 'Open' })] : null))),
                { id: 'togo' },
              )
            : null,
          r
            ? card(
                'Policy gates',
                h('div', { class: 'q-table-scroll' }, h('table', { class: 'table', id: 'gates-table' }, h('caption', { class: 'sr-only', text: 'Every policy gate with its status and reasons' }), h('thead', null, h('tr', null, ['Gate', 'Severity', 'Status', 'Reasons', 'Cites'].map((t) => h('th', { scope: 'col', text: t })))), h('tbody', null, gateRows))),
                { id: 'gates' },
              )
            : null,
          h(
            'div',
            { class: 'q-grid2' },
            d.coverage
              ? card(
                  'Risk-weighted coverage',
                  h(
                    'div',
                    { class: 'stack' },
                    h('p', { class: 'q-big' }, h('strong', { text: pct(d.coverage.weighted) }), h('span', { class: 'muted small', text: ` of executed risk passed (healed passes count ${pct(d.coverage.healedCredit)})` })),
                    meter(d.coverage.weighted, `Risk-weighted coverage ${pct(d.coverage.weighted)}`, d.coverage.weighted >= 0.9 ? 'ok' : d.coverage.weighted >= 0.6 ? 'warn' : 'bad'),
                    h('table', { class: 'table compact' }, h('caption', { class: 'sr-only', text: 'Journeys by risk level' }), h('thead', null, h('tr', null, ['Risk', 'Journeys', 'Passed', 'Healed', 'Failed', 'Quarantined'].map((t) => h('th', { scope: 'col', text: t })))), h('tbody', null, d.coverage.byRisk.map((b) => h('tr', null, h('th', { scope: 'row', text: `${b.risk}${b.risk >= 4 ? ' (critical)' : ''}` }), [b.total, b.passed, b.healed, b.failed, b.quarantined].map((v) => h('td', { class: 'num', text: String(v) })))))),
                  ),
                  { id: 'coverage' },
                )
              : null,
            card(
              'Decision trend',
              d.trend.length
                ? h('div', { class: 'stack' }, decisionStrip(d.trend), scorePoints.length > 1 ? lineChart([{ id: 'score', label: 'Score', slot: 1, values: scorePoints.map((p) => p.score) }], { label: 'Readiness score per run', x: scorePoints.map((p) => relTime(p.startedAt)), xLong: scorePoints.map((p) => `${dateTime(p.startedAt)} (${p.runId})`), format: (v) => String(Math.round(v)), yMax: 100, height: 150 }) : null)
                : h('p', { class: 'muted', text: 'No decisions recorded yet.' }),
              { id: 'trend' },
            ),
          ),
          h('div', { class: 'q-grid2' }, signoffCard(d), policyEditor(d)),
        );
      };

      const load = async () => {
        if (!data) f.loading();
        try {
          const [d, rl] = await Promise.all([api.get<Readiness>(`/api/quality/readiness${runId ? `?run=${encodeURIComponent(runId)}` : ''}`), api.get<{ runs: Array<RunOption & { cancelled?: boolean }> }>('/api/runs').catch(() => ({ runs: [] as Array<RunOption & { cancelled?: boolean }> }))]);
          data = d;
          runs = rl.runs.filter((x) => x.summary && !x.cancelled);
          render(d);
        } catch (e) {
          f.error((e as Error).message, () => void load());
        }
      };
      autoRefresh(ctx, () => void load(), ['readiness', 'quarantine', 'triage']);
      return {
        show(route: Route) {
          const next = route.segments[1] || undefined;
          if (next !== runId) data = undefined;
          runId = next;
          void load();
        },
        focus: () => f.heading.focus(),
      };
    },
  });
}
