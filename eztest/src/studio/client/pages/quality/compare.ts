/**
 * Run compare (#/quality/compare?a=<base>&b=<run>): journey and step status
 * changes (newly failing, fixed, newly healed), duration changes and the
 * readiness change between two runs. Step-level trace diffs live in the
 * Trace Viewer; this page is the run-level overview.
 */
import { api } from '../../core/api.js';
import { clear, h, uid } from '../../core/dom.js';
import { ms, relTime } from '../../core/format.js';
import { registerPage } from '../../core/registry.js';
import { link, navigate, type Route } from '../../core/router.js';
import { badge, button, card, stat } from '../../ui/badge.js';
import { icon } from '../../ui/icons.js';
import { autoRefresh, locatorText, qualityFrame, runSelect, type Locator, type RunOption } from './common.js';

interface StepChange {
  stepId: string;
  intent: string;
  a: string;
  b: string;
  change: string;
  durationA?: number;
  durationB?: number;
  healA?: { tier: string; locator: Locator };
  healB?: { tier: string; locator: Locator };
  errorB?: string;
}

interface Comparison {
  a: { runId: string; startedAt: string; summary: { total: number; passed: number; passedHealed: number; failed: number; errors: number }; durationMs: number; readiness?: { decision: string; score: number } };
  b: Comparison['a'];
  counts: Record<string, number>;
  journeys: Array<{ journeyId: string; name: string; a: string; b: string; change: string; durationA?: number; durationB?: number; steps: StepChange[] }>;
  durations: Array<{ journeyId: string; name: string; a: number; b: number; delta: number; ratio: number }>;
}

const CHANGE: Record<string, [string, string]> = {
  'newly-failing': ['bad', 'Newly failing'],
  'still-failing': ['failed', 'Still failing'],
  fixed: ['ok', 'Fixed'],
  'newly-healed': ['passed-healed', 'Newly healed'],
  'heal-resolved': ['ok', 'No longer needs healing'],
  added: ['new', 'Only in compared run'],
  removed: ['skipped', 'Not in compared run'],
  unchanged: ['stable', 'Unchanged'],
  other: ['warn', 'Changed'],
};

function statusCell(s: string): HTMLElement {
  return s === 'absent' ? h('span', { class: 'muted', text: '—' }) : badge(s);
}

function delta(a?: number, b?: number): HTMLElement {
  if (a === undefined || b === undefined) return h('span', { class: 'muted', text: '—' });
  const d = b - a;
  const big = Math.abs(d) >= 500 && a > 0 && Math.abs(d) / a >= 0.25;
  return h('span', { class: ['num', big && (d > 0 ? 'bad-text' : 'ok-text')], text: `${ms(a)} → ${ms(b)} (${d >= 0 ? '+' : '−'}${ms(Math.abs(d))})` });
}

export function registerComparePage(): void {
  registerPage({
    id: 'quality-compare',
    title: 'Compare',
    icon: 'convert',
    route: 'quality/compare',
    group: 'quality',
    order: 250,
    mount(ctx) {
      const f = qualityFrame(ctx, 'Run compare', 'What changed between two runs: journeys and steps that broke, got fixed or started healing, durations and the readiness decision.', { wide: true });
      const pickers = h('div', { class: 'row wrap' });
      f.toolbar.append(pickers);
      let a: string | undefined;
      let b: string | undefined;
      let showUnchanged = false;

      const go = (na?: string, nb?: string) => navigate(`${link('quality', 'compare')}?${new URLSearchParams({ ...(na ? { a: na } : {}), ...(nb ? { b: nb } : {}) }).toString()}`);

      const render = (runs: RunOption[], c: Comparison | null) => {
        clear(pickers);
        if (runs.length >= 2) {
          const ca = c?.a.runId ?? a;
          const cb = c?.b.runId ?? b;
          pickers.append(runSelect('Base', runs, ca, (id) => go(id, cb), 'compare-a'), button('Swap', { small: true, icon: 'convert', ariaLabel: 'Swap base and compared run', onclick: () => go(cb, ca) }), runSelect('Compared', runs, cb, (id) => go(ca, id), 'compare-b'));
        }
        if (!c) return f.empty(runs.length ? 'Pick two runs' : 'Not enough runs', runs.length < 2 ? 'Compare needs at least two completed runs.' : 'Choose a base run and a run to compare.');
        const ra = c.a.readiness;
        const rb = c.b.readiness;
        const changed = c.journeys.filter((j) => j.change !== 'unchanged' || j.steps.some((s) => s.change !== 'unchanged'));
        const list = showUnchanged ? c.journeys : changed;
        const toggle = h('input', { type: 'checkbox', id: uid('unch'), checked: showUnchanged, onchange: (e: Event) => ((showUnchanged = (e.target as HTMLInputElement).checked), render(runs, c)) });
        f.content(
          h(
            'div',
            { class: 'q-grid2' },
            card(
              'Summary',
              h(
                'div',
                { class: 'stack' },
                h('div', { class: 'stats', id: 'compare-counts' }, stat(c.counts['newly-failing'] ?? 0, 'Newly failing', (c.counts['newly-failing'] ?? 0) ? 'bad' : undefined), stat(c.counts.fixed ?? 0, 'Fixed', (c.counts.fixed ?? 0) ? 'ok' : undefined), stat(c.counts['newly-healed'] ?? 0, 'Newly healed', (c.counts['newly-healed'] ?? 0) ? 'heal' : undefined), stat(c.counts['still-failing'] ?? 0, 'Still failing'), stat((c.counts.added ?? 0) + (c.counts.removed ?? 0), 'In one run only')),
                h('p', { class: 'small muted' }, h('a', { href: link('runs', c.a.runId), text: `Base ${relTime(c.a.startedAt)}` }), ` (${ms(c.a.durationMs)}) → `, h('a', { href: link('runs', c.b.runId), text: `compared ${relTime(c.b.startedAt)}` }), ` (${ms(c.b.durationMs)})`),
              ),
            ),
            card(
              'Readiness',
              h('p', { class: 'q-readiness-change', id: 'compare-readiness' }, ra ? badge(ra.decision) : h('span', { class: 'muted', text: 'no decision' }), ra ? h('span', { class: 'muted', text: ` ${ra.score}` }) : null, icon('chevronRight', { size: 16 }), rb ? badge(rb.decision) : h('span', { class: 'muted', text: 'no decision' }), rb ? h('span', { class: 'muted', text: ` ${rb.score}` }) : null, ra && rb && ra.decision !== rb.decision ? h('strong', { class: rb.decision === 'GO' ? 'ok-text' : 'bad-text', text: ' changed' }) : null),
            ),
          ),
          card(
            `Journeys (${changed.length} changed)`,
            h(
              'div',
              { class: 'stack' },
              h('label', { class: 'check' }, toggle, h('span', { text: 'Show unchanged journeys' })),
              list.length
                ? h(
                    'div',
                    { class: 'q-table-scroll' },
                    h(
                      'table',
                      { class: 'table', id: 'compare-table' },
                      h('caption', { class: 'sr-only', text: 'Journey status changes' }),
                      h('thead', null, h('tr', null, ['Journey', 'Change', 'Base', 'Compared', 'Duration'].map((t) => h('th', { scope: 'col', text: t })))),
                      h(
                        'tbody',
                        null,
                        list.flatMap((j) => {
                          const [tone, text] = CHANGE[j.change] ?? ['warn', j.change];
                          const steps = j.change === 'added' || j.change === 'removed' ? [] : j.steps.filter((s) => s.change !== 'unchanged');
                          return [
                            h('tr', { dataset: { journey: j.journeyId, change: j.change } }, h('th', { scope: 'row', text: j.name }), h('td', null, badge(tone, text)), h('td', null, statusCell(j.a)), h('td', null, statusCell(j.b)), h('td', null, delta(j.durationA, j.durationB))),
                            steps.length
                              ? h(
                                  'tr',
                                  { class: 'q-subrow' },
                                  h(
                                    'td',
                                    { colspan: '5' },
                                    h(
                                      'ul',
                                      { class: 'q-steps-changed', 'aria-label': `Step changes in ${j.name}` },
                                      steps.map((s) => {
                                        const [st, sl] = CHANGE[s.change] ?? ['warn', s.change];
                                        return h('li', null, badge(st, sl), h('span', { text: ` ${s.intent} ` }), h('span', { class: 'muted small', text: `${s.a} → ${s.b}` }), s.healB ? h('span', { class: 'small' }, ' healed via ', h('code', { text: locatorText(s.healB.locator) })) : null, s.errorB ? h('p', { class: 'error-note', text: s.errorB }) : null, h('a', { class: 'small', href: link('runs', c.b.runId, j.journeyId, s.stepId), text: ' open step' }));
                                      }),
                                    ),
                                  ),
                                )
                              : null,
                          ].filter(Boolean) as HTMLElement[];
                        }),
                      ),
                    ),
                  )
                : h('p', { class: 'ok-text' }, icon('check', { size: 14 }), h('span', { text: ' No journey or step changed status.' })),
            ),
          ),
          card(
            'Largest duration changes',
            c.durations.length
              ? h('ol', { class: 'q-durations' }, c.durations.slice(0, 10).map((d) => h('li', null, h('strong', { text: d.name }), ' ', delta(d.a, d.b))))
              : h('p', { class: 'muted', text: 'No journeys ran in both runs.' }),
          ),
        );
      };

      const load = async () => {
        f.loading();
        try {
          const r = await api.get<{ runs: RunOption[]; comparison: Comparison | null }>(`/api/quality/compare?${new URLSearchParams({ ...(a ? { a } : {}), ...(b ? { b } : {}) }).toString()}`);
          render(r.runs, r.comparison);
        } catch (e) {
          f.error((e as Error).message, () => void load());
        }
      };
      autoRefresh(ctx, () => void load());
      return {
        show(route: Route) {
          a = route.query.get('a') ?? undefined;
          b = route.query.get('b') ?? undefined;
          void load();
        },
        focus: () => f.heading.focus(),
      };
    },
  });
}
