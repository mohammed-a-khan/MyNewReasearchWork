/**
 * Flaky tests and quarantine (#/quality/flaky): flip-rate ranking with a
 * per-journey pass/fail strip over the last N runs, and quarantine with a
 * reason, an owner and an expiry. Quarantined journeys still run; their
 * failures do not fail `eztest run` or block readiness.
 */
import { api } from '../../core/api.js';
import { clear, h, uid } from '../../core/dom.js';
import { pct, plural, relTime } from '../../core/format.js';
import { registerPage } from '../../core/registry.js';
import { link } from '../../core/router.js';
import { badge, button } from '../../ui/badge.js';
import { icon } from '../../ui/icons.js';
import { toast, toastError } from '../../ui/toast.js';
import { askReviewer, autoRefresh, confirmWith, qualityFrame, refreshQualitySummary, reviewer, reviewerField } from './common.js';
import { outcomeStripSvg } from './charts.js';

interface QEntry {
  journeyId: string;
  reason: string;
  owner: string;
  expires: string;
  createdAt: string;
  createdBy?: string;
  ticket?: string;
  expired?: boolean;
  expiringSoon?: boolean;
}

interface Row {
  journeyId: string;
  name: string;
  onDisk: boolean;
  score: { state: string; samples: number; flips: number; flipRate: number; failRate: number; failRateInterval: { low: number; high: number }; healedRate: number; healedTrendRising: boolean; reasons: string[]; quarantine: { recommended: boolean; reason: string }; rootCause?: { cause: string; share: number; retriedPasses: number; advice: string } };
  strip: Array<{ runId: string; startedAt: string; status: string; attempts: number }>;
  retriedPasses: number;
  quarantine?: QEntry;
}

interface Data {
  runs: Array<{ runId: string; startedAt: string }>;
  rows: Row[];
  quarantine: { entries: QEntry[]; warnings: string[]; active: number; expired: number };
}

function inDays(d: number): string {
  return new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
}

export async function quarantineDialog(journeyId: string, name: string, existing?: QEntry): Promise<boolean> {
  const who = await askReviewer();
  if (!who) return false;
  const rid = uid('qr');
  const oid = uid('qo');
  const eid = uid('qe');
  const tid = uid('qt');
  const reason = h('textarea', { id: rid, class: 'input', rows: 2, value: existing?.reason ?? '', placeholder: 'e.g. intermittent timeout in the payment sandbox' });
  const owner = h('input', { id: oid, class: 'input', value: existing?.owner ?? who, autocomplete: 'off' });
  const expires = h('input', { id: eid, class: 'input', type: 'date', value: existing && !existing.expired ? existing.expires.slice(0, 10) : inDays(14), min: inDays(0) });
  const ticket = h('input', { id: tid, class: 'input', value: existing?.ticket ?? '', placeholder: 'Optional: work item or issue link' });
  const ok = await confirmWith(
    existing ? `Renew quarantine of ${name}` : `Quarantine ${name}`,
    h(
      'div',
      { class: 'stack' },
      h('p', { text: 'The journey keeps running and is reported separately, but its failures stop failing runs (exit code) and stop blocking release readiness until the expiry date. Written to .eztest/quarantine.json.' }),
      h('div', { class: 'field' }, h('label', { for: rid, text: 'Reason (required)' }), reason),
      h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', { for: oid, text: 'Owner (required)' }), owner), h('div', { class: 'field' }, h('label', { for: eid, text: 'Expires (required)' }), expires)),
      h('div', { class: 'field' }, h('label', { for: tid, text: 'Tracking ticket' }), ticket),
      reviewerField('Requested by'),
    ),
    existing ? 'Renew quarantine' : 'Quarantine',
    { size: 'md', validate: () => (!reason.value.trim() ? 'A reason is required' : !owner.value.trim() ? 'An owner is required' : !expires.value ? 'An expiry date is required' : expires.value < inDays(0) ? 'The expiry date is in the past' : undefined) },
  );
  if (!ok) return false;
  try {
    await api.post('/api/quality/quarantine', { journeyId, reason: reason.value.trim(), owner: owner.value.trim(), expires: expires.value, ticket: ticket.value.trim() || undefined, by: reviewer.get(), confirm: true });
    toast(`${name} is quarantined until ${expires.value}`, { kind: 'success' });
    refreshQualitySummary();
    return true;
  } catch (e) {
    toastError(`Quarantine failed: ${(e as Error).message}`);
    return false;
  }
}

async function unquarantine(journeyId: string, name: string): Promise<boolean> {
  const who = await askReviewer();
  if (!who) return false;
  const ok = await confirmWith(`Un-quarantine ${name}`, h('p', { text: 'Its failures will fail runs and count for readiness again.' }), 'Un-quarantine', { size: 'sm', danger: true });
  if (!ok) return false;
  try {
    await api.del(`/api/quality/quarantine/${encodeURIComponent(journeyId)}`, { by: who, confirm: true });
    toast(`${name} is no longer quarantined`, { kind: 'success' });
    refreshQualitySummary();
    return true;
  } catch (e) {
    toastError((e as Error).message);
    return false;
  }
}

export function registerFlakyPage(): void {
  registerPage({
    id: 'quality-flaky',
    title: 'Flaky',
    icon: 'activity',
    route: 'quality/flaky',
    group: 'quality',
    order: 220,
    mount(ctx) {
      const f = qualityFrame(ctx, 'Flaky tests and quarantine', 'Journeys ranked by how often they flip between pass and fail. Quarantine a known-flaky journey so it keeps running without failing the build.', { wide: true });
      const nSel = h('select', { id: uid('n'), class: 'input input-sm' }, [10, 20, 50].map((n) => h('option', { value: String(n), selected: n === 20, text: `${n} runs` })));
      const onlyBad = h('input', { type: 'checkbox', id: uid('only') });
      f.toolbar.append(h('div', { class: 'q-inline-field' }, h('label', { for: nSel.id, text: 'Window' }), nSel), h('label', { class: 'check' }, onlyBad, h('span', { text: 'Only unstable' })));
      let data: Data | undefined;

      const row = (r: Row, i: number): HTMLElement => {
        const q = r.quarantine;
        const actions = q
          ? [button('Renew…', { small: true, icon: 'clock', ariaLabel: `Renew quarantine of ${r.name}`, onclick: async () => (await quarantineDialog(r.journeyId, r.name, q)) && void load() }), button('Un-quarantine', { small: true, icon: 'x', ariaLabel: `Un-quarantine ${r.name}`, onclick: async () => (await unquarantine(r.journeyId, r.name)) && void load() })]
          : button('Quarantine…', { small: true, icon: 'shield', ariaLabel: `Quarantine ${r.name}`, onclick: async () => (await quarantineDialog(r.journeyId, r.name)) && void load() });
        return h(
          'tr',
          { class: q ? 'is-quarantined' : undefined, dataset: { journey: r.journeyId } },
          h('td', { class: 'num', text: String(i + 1) }),
          h('th', { scope: 'row' }, h('span', { class: 'q-jname', text: r.name }), h('span', { class: 'muted small mono q-block', text: r.journeyId })),
          h('td', null, badge(r.score.state), r.score.quarantine.recommended && !q ? h('span', { class: 'q-flag small', title: r.score.quarantine.reason }, icon('warning', { size: 12 }), ' quarantine?') : null,
            // Root-cause category of the flakiness (classified from the failed attempts of retried passes).
            r.score.rootCause ? h('span', { class: 'muted small q-block', title: r.score.rootCause.advice, text: `cause: ${r.score.rootCause.cause} (${pct(r.score.rootCause.share)} of ${r.score.rootCause.retriedPasses})` }) : null),
          h('td', { class: 'num', title: `${r.score.flips} flips over ${r.score.samples} runs`, text: pct(r.score.flipRate) }),
          h('td', { class: 'num', title: `95% CI ${pct(r.score.failRateInterval.low)}–${pct(r.score.failRateInterval.high)}`, text: pct(r.score.failRate) }),
          h('td', { class: 'num', text: `${pct(r.score.healedRate)}${r.score.healedTrendRising ? ' ↑' : ''}` }),
          h('td', { class: 'num', text: String(r.retriedPasses) }),
          h('td', null, outcomeStripSvg(r.strip.map((s) => ({ status: s.status, label: `${relTime(s.startedAt)} (${s.runId})${s.attempts > 1 ? `, ${s.attempts} attempts` : ''}` })), r.name)),
          h('td', null, q ? h('div', { class: 'small' }, badge(q.expired ? 'bad' : q.expiringSoon ? 'warn' : 'warn', q.expired ? 'Expired' : 'Quarantined'), h('div', { class: 'muted', text: `${q.owner} · until ${q.expires}` })) : h('span', { class: 'muted small', text: '—' })),
          h('td', null, h('div', { class: 'q-actions' }, actions)),
        );
      };

      const render = () => {
        if (!data) return;
        const rows = onlyBad.checked ? data.rows.filter((r) => r.score.state !== 'stable' && r.score.state !== 'new') : data.rows;
        const qrows = data.rows.filter((r) => r.quarantine);
        if (!data.rows.length) return f.empty('No journeys yet', 'Add journeys and run them to see flakiness here.');
        const legend = h('ul', { class: 'q-legend small', 'aria-label': 'Strip legend' }, [['passed', 'Passed'], ['passed-healed', 'Passed with healing (dot)'], ['failed', 'Failed (cross)'], ['not-run', 'Not run']].map(([s, t]) => h('li', null, outcomeStripSvg([{ status: s, label: t }], t), h('span', { text: t }))));
        f.content(
          data.quarantine.warnings.length ? h('div', { class: 'q-callout tone-warn', role: 'status' }, icon('clock', { size: 14 }), h('ul', { class: 'bullets' }, data.quarantine.warnings.map((w) => h('li', { text: w })))) : null,
          h(
            'section',
            { class: 'card', 'aria-labelledby': 'q-flaky-h' },
            h('header', { class: 'card-head' }, h('h2', { class: 'card-title', id: 'q-flaky-h', text: `Flip-rate ranking (last ${data.runs.length} runs)` }), legend),
            h(
              'div',
              { class: 'card-body q-table-scroll' },
              h(
                'table',
                { class: 'table q-rank', id: 'flaky-table' },
                h('caption', { class: 'sr-only', text: 'Journeys ranked by flip rate' }),
                h('thead', null, h('tr', null, ['#', 'Journey', 'State', 'Flip rate', 'Fail rate', 'Healed', 'Retried passes', 'Outcomes (oldest → newest)', 'Quarantine', 'Actions'].map((t) => h('th', { scope: 'col', text: t })))),
                h('tbody', null, rows.map(row)),
              ),
              rows.length ? null : h('p', { class: 'muted', text: 'No unstable journeys in this window.' }),
            ),
          ),
          h(
            'section',
            { class: 'card', 'aria-labelledby': 'q-quar-h', id: 'quarantined' },
            h('header', { class: 'card-head' }, h('h2', { class: 'card-title', id: 'q-quar-h', text: `Quarantined (${data.quarantine.active} active${data.quarantine.expired ? `, ${data.quarantine.expired} expired` : ''})` })),
            h(
              'div',
              { class: 'card-body' },
              qrows.length
                ? h(
                    'ul',
                    { class: 'rank-list' },
                    qrows.map((r) => {
                      const last = [...r.strip].reverse().find((s) => s.status !== 'not-run');
                      return h(
                        'li',
                        null,
                        h('div', { class: 'rank-main' }, h('strong', { text: r.name }), last ? badge(last.status) : null, r.quarantine!.expired ? badge('bad', 'Expired: failures count again') : null),
                        h('div', { class: 'rank-sub' }, h('span', { text: r.quarantine!.reason }), h('span', { text: `owner ${r.quarantine!.owner}` }), h('span', { text: `until ${r.quarantine!.expires}` }), r.quarantine!.ticket ? h('span', { text: r.quarantine!.ticket }) : null, last ? h('a', { href: link('runs', last.runId), text: 'latest run' }) : null),
                      );
                    }),
                  )
                : h('p', { class: 'muted', text: 'Nothing is quarantined. Quarantined journeys still run, and their results are listed here separately.' }),
            ),
          ),
        );
      };

      const load = async () => {
        if (!data) f.loading();
        try {
          data = await api.get<Data>(`/api/quality/flaky?n=${nSel.value}`);
          render();
        } catch (e) {
          f.error((e as Error).message, () => void load());
        }
      };
      nSel.addEventListener('change', () => void load());
      onlyBad.addEventListener('change', render);
      autoRefresh(ctx, () => void load(), ['quarantine']);
      return { show: () => void load(), focus: () => f.heading.focus() };
    },
  });
}

