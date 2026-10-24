/**
 * Results: run history (virtualized, sortable, filterable) and the run detail
 * with tabs contributed through `registerRunDetailTab` (Overview, Timeline,
 * Screenshots, Heal proposals, Triage, Evidence). Deep link:
 * `#/runs/<runId>/<journeyId>/<stepId>`.
 */
import { api, runAsset } from '../core/api.js';
import { add, clear, h } from '../core/dom.js';
import { dateTime, ms, pct, plural, relTime } from '../core/format.js';
import { registerCommandProvider, registerPage, registerRunDetailTab, runDetailTabs, type RunDetail, type RunDetailContext } from '../core/registry.js';
import { link, navigate, type Route } from '../core/router.js';
import { runsVersion } from '../core/state.js';
import { badge, button, copyText, emptyState, iconButton, stat, statusIcon } from '../ui/badge.js';
import { icon } from '../ui/icons.js';
import { openModal } from '../ui/modal.js';
import { createSplit } from '../ui/split.js';
import { createTable } from '../ui/table.js';
import { createTabs } from '../ui/tabs.js';
import { toastError } from '../ui/toast.js';
import { registerFeaturesTab } from './results-features.js';

export interface RunListItem {
  runId: string;
  startedAt?: string;
  durationMs?: number;
  summary?: { total: number; passed: number; passedHealed: number; failed: number; skipped: number; errors: number };
  hasReport: boolean;
  cancelled?: boolean;
  error?: string;
}

export function outcomeOf(r: RunListItem): string {
  const s = r.summary;
  if (!s) return 'error';
  if (r.cancelled) return 'cancelled';
  if (s.failed + s.errors > 0) return 'failed';
  if (s.passedHealed > 0) return 'passed-healed';
  return 'passed';
}

let runCache: RunListItem[] = [];

async function loadRuns(): Promise<RunListItem[]> {
  runCache = (await api.get<{ runs: RunListItem[] }>('/api/runs')).runs;
  return runCache;
}

// ------------------------------------------------------------------ screenshots + lightbox

interface Shot {
  src: string;
  journey: string;
  step: string;
  status: string;
  stepId: string;
  journeyId: string;
}

function screenshots(d: RunDetail): Shot[] {
  const out: Shot[] = [];
  for (const j of d.run.journeys) {
    for (const s of j.steps) {
      for (const eid of s.evidence ?? []) {
        const ev = d.evidence[eid];
        if (ev?.kind === 'screenshot') out.push({ src: runAsset(d.run.runId, ev.path), journey: j.name, step: s.intent, status: s.status, stepId: s.stepId, journeyId: j.journeyId });
      }
    }
  }
  return out;
}

interface VideoClip {
  journey: string;
  src: string;
  chapters?: string;
}

/** Per-journey videos (with their WebVTT chapter track) recorded in the run. */
function videos(d: RunDetail): VideoClip[] {
  const out: VideoClip[] = [];
  for (const j of d.run.journeys) {
    const ids = j.evidence ?? [];
    const video = ids.map((id) => d.evidence[id]).find((e) => e?.kind === 'video');
    if (!video) continue;
    const chapters = ids.map((id) => d.evidence[id]).find((e) => e?.kind === 'video-chapters');
    out.push({ journey: j.name, src: runAsset(d.run.runId, video.path), ...(chapters ? { chapters: runAsset(d.run.runId, chapters.path) } : {}) });
  }
  return out;
}

export function openLightbox(shots: Shot[], start: number): void {
  let i = start;
  const img = h('img', { class: 'lightbox-img', alt: '' });
  const caption = h('p', { class: 'lightbox-caption', 'aria-live': 'polite' });
  const counter = h('span', { class: 'muted' });
  const show = () => {
    const s = shots[i];
    img.src = s.src;
    img.alt = `Screenshot after step: ${s.step}`;
    clear(caption).append(statusIcon(s.status), h('strong', { text: s.journey }), h('span', { text: ` · ${s.step}` }));
    counter.textContent = `${i + 1} / ${shots.length}`;
  };
  const prev = iconButton('Previous screenshot', 'chevronLeft', () => ((i = (i - 1 + shots.length) % shots.length), show()));
  const next = iconButton('Next screenshot', 'chevronRight', () => ((i = (i + 1) % shots.length), show()));
  const body = h('div', { class: 'lightbox' }, h('div', { class: 'lightbox-stage' }, prev, img, next), h('div', { class: 'lightbox-foot' }, caption, counter, h('a', { class: 'link-btn', href: '', target: '_blank', rel: 'noopener noreferrer', ref: (a) => img.addEventListener('load', () => ((a as HTMLAnchorElement).href = img.src)), text: 'Open full size' })));
  const m = openModal({ title: 'Screenshot', body, size: 'xl', class: 'lightbox-modal', initialFocus: next });
  m.dialog.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') (e.preventDefault(), prev.click());
    else if (e.key === 'ArrowRight') (e.preventDefault(), next.click());
  });
  show();
}

function thumb(shots: Shot[], k: number, label: string): HTMLElement {
  return h('button', { type: 'button', class: 'thumb', 'aria-label': `View screenshot: ${label}`, onclick: () => openLightbox(shots, k) }, h('img', { src: shots[k].src, loading: 'lazy', alt: `Screenshot after step: ${label}` }));
}

// ------------------------------------------------------------------ built-in detail tabs

function registerBuiltInTabs(): void {
  registerRunDetailTab({
    id: 'overview',
    title: 'Overview',
    order: 10,
    mount(el, d) {
      const s = d.run.summary;
      const ins = (d.insights ?? {}) as { readiness?: { decision: string; score: number; rationale?: Array<{ text: string }> } };
      const v = d.verification;
      add(
        el,
        h('div', { class: 'stats' }, stat(s.total, 'Journeys'), stat(s.passed, 'Passed', 'ok'), stat(s.passedHealed, 'Healed', 'heal'), stat(s.failed, 'Failed', 'bad'), stat(s.skipped, 'Skipped'), stat(s.errors, 'Errors', 'bad'), stat(ms(d.run.durationMs), 'Duration')),
        h('div', { class: 'row wrap' }, v.ok ? badge('ok', `Evidence verified (${v.entries} entries)`) : badge('bad', 'Evidence NOT valid'), ins.readiness ? h('span', null, 'Release readiness: ', badge(ins.readiness.decision), h('span', { class: 'muted', text: ` score ${ins.readiness.score}` })) : null),
        !v.ok ? h('ul', { class: 'bullets warn-text' }, v.problems.slice(0, 10).map((p) => h('li', { text: p }))) : null,
        ins.readiness?.rationale?.length ? h('ul', { class: 'bullets' }, ins.readiness.rationale.slice(0, 8).map((r) => h('li', { text: r.text }))) : null,
        h(
          'table',
          { class: 'table compact' },
          h('caption', { class: 'sr-only', text: 'Journeys in this run' }),
          h('thead', null, h('tr', null, ['Journey', 'Status', 'Steps', 'Duration', 'Attempt'].map((t) => h('th', { scope: 'col', text: t })))),
          h(
            'tbody',
            null,
            d.run.journeys.map((j) =>
              h(
                'tr',
                null,
                h('td', null, h('a', { href: link('runs', d.run.runId, j.journeyId), text: j.name })),
                h('td', null, badge(j.status)),
                h('td', { text: String(j.steps.length) }),
                h('td', { text: ms(j.durationMs) }),
                h('td', { text: String(j.attempt) }),
              ),
            ),
          ),
        ),
        d.run.environment ? h('dl', { class: 'kv' }, Object.entries(d.run.environment).map(([k, val]) => [h('dt', { text: k }), h('dd', { text: val })])) : null,
      );
    },
  });

  registerRunDetailTab({
    id: 'timeline',
    title: 'Timeline',
    order: 20,
    mount(el, d, ctx) {
      const shots = screenshots(d);
      for (const j of d.run.journeys) {
        const det = h('details', { class: ['tl-journey', `st-${j.status}`], open: j.status !== 'passed' || ctx.journeyId === j.journeyId || d.run.journeys.length === 1, dataset: { journey: j.journeyId } });
        det.appendChild(h('summary', null, statusIcon(j.status), h('span', { class: 'tl-name', text: j.name }), h('span', { class: 'muted', text: ` ${ms(j.durationMs)} · attempt ${j.attempt}${j.browser ? ` · ${j.browser}` : ''}` })));
        if (j.error) det.appendChild(h('p', { class: 'error-note', text: j.error.message }));
        det.appendChild(
          h(
            'ol',
            { class: 'timeline' },
            j.steps.map((st) => {
              const k = shots.findIndex((x) => x.journeyId === j.journeyId && x.stepId === st.stepId);
              const target = ctx.journeyId === j.journeyId && ctx.stepId === st.stepId;
              return h(
                'li',
                { class: ['tl-step', `st-${st.status}`, target && 'target'], id: `step-${j.journeyId}-${st.stepId}`, dataset: { step: st.stepId } },
                h('div', { class: 'tl-row' }, statusIcon(st.status), h('a', { class: 'tl-intent', href: link('runs', d.run.runId, j.journeyId, st.stepId), text: st.intent }), st.actor ? h('span', { class: 'tag tl-actor', title: 'actor', text: st.actor }) : null, h('span', { class: 'muted', text: ms(st.durationMs) })),
                st.heal ? h('p', { class: 'heal-note' }, icon('heal', { size: 12 }), h('span', { text: `Healed via ${st.heal.tier} to ${st.heal.healed.strategy}=${st.heal.healed.value}${st.heal.verified ? ' (verified by post-conditions)' : ' (NOT verified)'}` })) : null,
                st.error ? h('p', { class: 'error-note', text: st.error.message }) : null,
                k >= 0 ? thumb(shots, k, st.intent) : null,
              );
            }),
          ),
        );
        el.appendChild(det);
      }
      if (ctx.stepId) setTimeout(() => el.querySelector('.tl-step.target')?.scrollIntoView({ block: 'center' }), 50);
    },
  });

  registerRunDetailTab({
    id: 'screenshots',
    title: 'Screenshots',
    order: 30,
    badge: (d) => screenshots(d).length || undefined,
    when: (d) => screenshots(d).length > 0,
    mount(el, d) {
      const shots = screenshots(d);
      const byJourney = new Map<string, number[]>();
      shots.forEach((s, k) => byJourney.set(s.journey, [...(byJourney.get(s.journey) ?? []), k]));
      for (const [name, ks] of byJourney) {
        el.append(
          h('h3', { class: 'h3', text: name }),
          h('ul', { class: 'gallery' }, ks.map((k) => h('li', { class: `gallery-item st-${shots[k].status}` }, thumb(shots, k, shots[k].step), h('p', { class: 'gallery-cap' }, statusIcon(shots[k].status), h('span', { text: shots[k].step }))))),
        );
      }
    },
  });

  registerRunDetailTab({
    id: 'video',
    title: 'Video',
    order: 35,
    badge: (d) => videos(d).length || undefined,
    when: (d) => videos(d).length > 0,
    mount(el, d) {
      for (const v of videos(d)) {
        const video = h('video', { controls: '', preload: 'metadata', playsinline: '', crossorigin: 'anonymous', src: v.src, class: 'detail-video' }) as HTMLVideoElement;
        if (v.chapters) video.appendChild(h('track', { kind: 'chapters', default: '', src: v.chapters, srclang: 'en', label: 'Steps' }));
        const list = h('ol', { class: 'chapters', 'aria-label': `Steps in the video of ${v.journey}` }) as HTMLOListElement;
        const build = (): void => {
          let tt: TextTrack | undefined;
          for (let i = 0; i < video.textTracks.length; i++) if (video.textTracks[i].kind === 'chapters') tt = video.textTracks[i];
          if (!tt) return;
          tt.mode = 'hidden';
          const cues = tt.cues;
          if (!cues || !cues.length) return;
          clear(list);
          for (let i = 0; i < cues.length; i++) {
            const cue = cues[i] as VTTCue;
            const b = h('button', { type: 'button', text: `${i + 1}. ${cue.text}` });
            b.addEventListener('click', () => {
              video.currentTime = cue.startTime + 0.001;
              void video.play().catch(() => undefined);
            });
            list.appendChild(h('li', null, b));
          }
        };
        const track = video.querySelector('track');
        if (track) track.addEventListener('load', build);
        video.addEventListener('loadedmetadata', () => setTimeout(build, 50));
        el.append(h('h3', { class: 'h3', text: v.journey }), h('div', { class: 'videowrap' }, video, list));
      }
    },
  });

  registerRunDetailTab({
    id: 'heals',
    title: 'Heal proposals',
    order: 40,
    badge: (d) => (d.healProposals?.proposals?.length ?? 0) + (d.healProposals?.rejected?.length ?? 0) || undefined,
    when: (d) => !!((d.healProposals?.proposals ?? []).length || (d.healProposals?.rejected ?? []).length),
    mount(el, d) {
      type P = { journeyName?: string; intent?: string; stepId?: string; tier?: string; confidence?: number; verified?: boolean; original?: Array<{ strategy: string; value: string }>; healed?: { strategy: string; value: string; name?: string } };
      const rows: Array<[P, boolean]> = [...((d.healProposals?.proposals ?? []) as P[]).map((p) => [p, true] as [P, boolean]), ...((d.healProposals?.rejected ?? []) as P[]).map((p) => [p, false] as [P, boolean])];
      el.appendChild(
        h(
          'table',
          { class: 'table' },
          h('caption', { class: 'sr-only', text: 'Heal proposals' }),
          h('thead', null, h('tr', null, ['Step', 'Was', 'Suggested locator', 'Tier', 'Confidence', 'Verified', ''].map((t, i) => h('th', { scope: 'col' }, i === 6 ? h('span', { class: 'sr-only', text: 'Actions' }) : t)))),
          h(
            'tbody',
            null,
            rows.map(([p, accepted]) => {
              const loc = p.healed ? `${p.healed.strategy}=${p.healed.value}${p.healed.name ? ` [name="${p.healed.name}"]` : ''}` : '';
              const copy = button('Copy locator', { small: true, icon: 'copy', ariaLabel: `Copy suggested locator for ${p.stepId ?? ''}` });
              copy.addEventListener('click', () => void copyText(loc, copy));
              return h(
                'tr',
                null,
                h('td', null, h('strong', { text: p.journeyName ?? '' }), h('br'), h('span', { text: p.intent ?? '' })),
                h('td', null, h('code', { text: (p.original ?? []).map((o) => `${o.strategy}=${o.value}`).join(' | ') })),
                h('td', null, h('code', { class: 'suggested-locator', text: loc })),
                h('td', { text: p.tier ?? '' }),
                h('td', { text: pct(p.confidence) }),
                h('td', null, accepted && p.verified ? badge('ok', 'Verified') : badge('bad', 'Rejected')),
                h('td', null, copy),
              );
            }),
          ),
        ),
      );
    },
  });

  registerRunDetailTab({
    id: 'triage',
    title: 'Triage',
    order: 50,
    when: (d) => !!((d.insights as { triage?: { verdicts?: unknown[] } })?.triage?.verdicts ?? []).length,
    mount(el, d) {
      const verdicts = ((d.insights as { triage?: { verdicts?: Array<{ journeyName?: string; journeyId: string; category: string; confidence: number; status?: string; reasons?: string[] }> } }).triage?.verdicts ?? []);
      el.appendChild(
        h(
          'ul',
          { class: 'verdicts' },
          verdicts.map((t) =>
            h('li', { class: 'verdict' }, h('p', null, h('strong', { text: t.journeyName ?? t.journeyId }), h('span', { class: 'chip', text: t.category }), h('span', { class: 'muted', text: ` ${pct(t.confidence)} confidence${t.status === 'needs-human' ? ' · needs human review' : ''}` })), (t.reasons ?? []).length ? h('ul', { class: 'bullets' }, t.reasons!.map((r) => h('li', { text: r }))) : null),
          ),
        ),
      );
    },
  });

  registerRunDetailTab({
    id: 'evidence',
    title: 'Evidence',
    order: 60,
    badge: (d) => Object.keys(d.evidence).length || undefined,
    mount(el, d) {
      const rows = Object.entries(d.evidence).map(([id, e]) => ({ id, ...e }));
      const table = createTable({
        label: 'Evidence files',
        key: (r) => r.id,
        rows,
        columns: [
          { id: 'kind', title: 'Kind', width: '8rem', value: (r) => r.kind, sortable: true },
          { id: 'path', title: 'File', width: 'minmax(12rem, 2fr)', value: (r) => r.path, sortable: true, render: (r) => h('a', { href: runAsset(d.run.runId, r.path), target: '_blank', rel: 'noopener noreferrer', class: 'mono', text: r.path }) },
          { id: 'desc', title: 'Description', width: 'minmax(8rem, 1fr)', value: (r) => r.description ?? '' },
        ],
        empty: 'No evidence recorded',
      });
      const filter = h('input', { type: 'search', class: 'input input-sm', placeholder: 'Filter evidence', 'aria-label': 'Filter evidence', oninput: (e: Event) => table.setFilter((e.target as HTMLInputElement).value) });
      el.append(h('div', { class: 'row' }, d.verification.ok ? badge('ok', `Hash chain verified (${d.verification.entries} entries)`) : badge('bad', 'Hash chain broken'), filter), h('div', { class: 'table-frame' }, table.el));
    },
  });
}

// ------------------------------------------------------------------ page

export function registerResultsPage(): void {
  registerBuiltInTabs();
  registerFeaturesTab();
  registerPage({
    id: 'runs',
    title: 'Results',
    icon: 'results',
    order: 40,
    shortcut: 'Alt+4',
    mount(ctx) {
      const heading = h('h1', { class: 'pane-title', tabindex: '-1', text: 'Run history' });
      const search = h('input', { type: 'search', class: 'input input-sm', placeholder: 'Filter runs', 'aria-label': 'Filter runs' });
      const statusSel = h(
        'select',
        { class: 'input input-sm', 'aria-label': 'Filter by outcome' },
        [['', 'All outcomes'], ['passed', 'Passed'], ['passed-healed', 'Healed'], ['failed', 'Failed'], ['cancelled', 'Cancelled'], ['error', 'Unreadable']].map(([v, t]) => h('option', { value: v, text: t })),
      );
      const count = h('p', { class: 'explorer-count', role: 'status', 'aria-live': 'polite' });
      let selectedId: string | undefined;
      const table = createTable<RunListItem>({
        label: 'Past runs, newest first',
        key: (r) => r.runId,
        sort: { id: 'started', dir: 'desc' },
        rowHeight: 52,
        columns: [
          {
            id: 'started',
            title: 'Run',
            width: 'minmax(9rem, 1.6fr)',
            sortable: true,
            value: (r) => r.startedAt ?? r.runId,
            render: (r) => h('div', { class: 'run-cell' }, h('span', { class: 'run-when', text: r.startedAt ? relTime(r.startedAt) : r.runId, title: dateTime(r.startedAt) }), h('span', { class: 'run-id mono', text: r.runId })),
          },
          {
            id: 'outcome',
            title: 'Outcome',
            width: 'minmax(7rem, 1.4fr)',
            sortable: true,
            value: (r) => outcomeOf(r),
            render: (r) =>
              r.summary
                ? h('div', { class: 'run-cell' }, badge(outcomeOf(r)), h('span', { class: 'muted small', text: `${r.summary.passed} passed · ${r.summary.passedHealed} healed · ${r.summary.failed + r.summary.errors} failed` }))
                : h('span', { class: 'muted', text: r.error ?? 'unknown' }),
          },
          { id: 'duration', title: 'Duration', width: '5.5rem', sortable: true, align: 'end', value: (r) => r.durationMs, render: (r) => ms(r.durationMs) },
        ],
        filter: (r, q) => [r.runId, r.startedAt, outcomeOf(r)].some((x) => x?.toLowerCase().includes(q)),
        onActivate: (r) => navigate(link('runs', r.runId)),
        empty: 'No runs yet. Start one from the Run page.',
      });
      const applyFilters = async () => {
        const st = statusSel.value;
        const all = runCache;
        const rows = st ? all.filter((r) => outcomeOf(r) === st) : all;
        table.setRows(rows);
        table.setFilter(search.value);
        count.textContent = `${table.visibleRows.length} of ${plural(all.length, 'run')}`;
        if (selectedId) table.select(selectedId, { scroll: false });
      };
      search.addEventListener('input', () => void applyFilters());
      statusSel.addEventListener('change', () => void applyFilters());
      const refresh = async () => {
        try {
          await loadRuns();
          await applyFilters();
        } catch (e) {
          count.textContent = `Could not list runs: ${(e as Error).message}`;
        }
      };
      const list = h(
        'aside',
        { class: 'runs-list', 'aria-label': 'Run history' },
        h('div', { class: 'pane-head' }, heading, h('div', { class: 'pane-actions' }, iconButton('Refresh runs', 'refresh', () => void refresh()))),
        h('div', { class: 'explorer-filters' }, search, statusSel),
        count,
        h('div', { class: 'table-frame grow' }, table.el),
      );
      const detail = h('div', { class: 'run-detail', id: 'run-detail', 'aria-live': 'polite' });
      const split = createSplit({ direction: 'row', first: list, second: detail, size: 420, min: 300, max: 720, storageKey: 'runs-list', label: 'Resize run history' });
      ctx.root.classList.add('page-results');
      ctx.root.appendChild(split.el);
      runsVersion.subscribe(() => void refresh(), false);

      let shownKey = '';
      const showDetail = async (id: string | undefined, journeyId?: string, stepId?: string, tab?: string) => {
        const key = `${id}|${journeyId}|${stepId}|${tab}`;
        if (key === shownKey) return;
        shownKey = key;
        selectedId = id;
        if (id) table.select(id);
        clear(detail);
        if (!id) {
          detail.appendChild(emptyState('Choose a run', 'Pick a run on the left to see its timeline, screenshots, heals, triage and evidence.'));
          return;
        }
        detail.appendChild(h('p', { class: 'muted', role: 'status', text: `Loading run ${id}…` }));
        let d: RunDetail & { state?: string };
        try {
          d = await api.get(`/api/runs/${encodeURIComponent(id)}`);
        } catch (e) {
          clear(detail).appendChild(h('p', { class: 'bad-text', text: `Could not open run: ${(e as Error).message}` }));
          return;
        }
        clear(detail);
        if (!d.run) {
          detail.appendChild(emptyState(`Run ${id} is ${d.state ?? 'in progress'}`, 'Open it again when it has finished, or follow it live.', button('Follow live', { icon: 'activity', onclick: () => navigate(link('run', id)) })));
          return;
        }
        const failedIds = d.run.journeys.filter((j) => j.status === 'failed' || j.status === 'error').map((j) => j.journeyId);
        const title = h('h2', { class: 'detail-title', id: 'run-detail-title', tabindex: '-1', text: `Run ${d.run.runId}` });
        detail.appendChild(
          h(
            'header',
            { class: 'detail-head' },
            h('div', null, title, h('p', { class: 'muted', text: `${dateTime(d.run.startedAt)} · ${ms(d.run.durationMs)} · ${plural(d.run.journeys.length, 'journey')}` })),
            h(
              'div',
              { class: 'row' },
              d.report ? h('a', { class: 'btn btn-sm', href: d.report, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), h('span', { text: 'Open the full HTML report' })) : h('span', { class: 'muted', text: 'No HTML report' }),
              failedIds.length
                ? button('Re-run failed', {
                    small: true,
                    icon: 'refresh',
                    onclick: async () => {
                      try {
                        const r = await api.post<{ id: string }>('/api/runs', { journeys: failedIds });
                        navigate(link('run', r.id));
                      } catch (e) {
                        toastError((e as Error).message);
                      }
                    },
                  })
                : null,
            ),
          ),
        );
        const dctx: RunDetailContext = { journeyId, stepId, selectTab: (t) => tabs.select(t) };
        const defs = runDetailTabs.get().filter((t) => !t.when || t.when(d));
        const tabs = createTabs({
          label: 'Run details',
          tabs: defs.map((t) => ({ id: t.id, title: t.title, badge: t.badge?.(d), mount: (el) => t.mount(el, d, dctx) })),
          selected: tab && defs.some((t) => t.id === tab) ? tab : journeyId ? 'timeline' : undefined,
        });
        detail.appendChild(tabs.el);
        if (!journeyId) title.focus({ preventScroll: true });
      };

      return {
        show(r: Route) {
          void refresh().then(() => {
            // `#/runs/<id>/<journeyId>/<stepId>/<tab>` opens a detail tab (e.g. "trace") at that step.
            const [id, journeyId, stepId, tab] = r.segments;
            void showDetail(id ?? selectedId ?? runCache[0]?.runId, journeyId, stepId, tab);
          });
        },
        focus: () => heading.focus(),
      };
    },
  });

  registerCommandProvider({
    id: 'runs',
    prefix: '#',
    hint: 'Runs',
    items: async () => {
      const runs = runCache.length ? runCache : await loadRuns().catch(() => []);
      return runs.slice(0, 200).map((r) => ({
        id: `run:${r.runId}`,
        title: r.runId,
        detail: `${outcomeOf(r)} · ${relTime(r.startedAt)}`,
        group: 'Runs',
        icon: 'results' as const,
        run: () => navigate(link('runs', r.runId)),
      }));
    },
  });
}
