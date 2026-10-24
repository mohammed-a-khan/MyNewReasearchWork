/**
 * Heal Review inbox (#/quality/heals): every verified heal across runs,
 * deduplicated by journey, step and locator. Accept writes the healed locator
 * into the journey file after a diff preview; reject makes the healer refuse
 * that tier for the step from then on. Bulk actions and filters; keyboard:
 * j / k (or arrows) move, x selects, a accepts, r rejects.
 */
import { api, ApiError } from '../../core/api.js';
import { clear, h, uid } from '../../core/dom.js';
import { pct, plural, relTime } from '../../core/format.js';
import { registerPage } from '../../core/registry.js';
import { link, navigate, type Route } from '../../core/router.js';
import { badge, button } from '../../ui/badge.js';
import { icon } from '../../ui/icons.js';
import { openModal } from '../../ui/modal.js';
import { toast, toastError } from '../../ui/toast.js';
import { askReviewer, autoRefresh, confirmWith, diffView, locatorText, meter, qualityFrame, refreshQualitySummary, reviewer, reviewerField, TIER_LABEL, type DiffLine, type Locator } from './common.js';

interface Evidence {
  id: string;
  kind: string;
  url: string;
  description?: string;
}

export interface HealItem {
  key: string;
  journeyId: string;
  journeyName: string;
  stepId: string;
  intent: string;
  targetDescription?: string;
  original: Locator[];
  healed: Locator;
  tier: string;
  tiers: string[];
  confidence: number;
  minConfidence: number;
  reason: string;
  runs: Array<{ runId: string; startedAt: string; tier: string; confidence: number }>;
  runCount: number;
  firstSeen: string;
  lastSeen: string;
  lastRunId: string;
  evidence: Evidence[];
  conditions: Array<{ type: string; text: string; passed: boolean; actual?: string }>;
  impliedCheck?: string;
  status: 'pending' | 'accepted' | 'rejected' | 'applied';
  decision?: { decision: string; reviewer: string; decidedAt: string; reason?: string; rewrite?: string; file?: string };
  file?: { path: string; format: string };
  /** Shared repository element (accepting rewrites elements/*.yaml for every journey using it). */
  element?: string;
  /** Heal of a relative target's anchor (index). */
  anchor?: number;
  usages?: Array<{ journeyId: string; journeyName: string; stepId: string; intent: string }>;
}

interface Preview {
  files: Array<{ path: string; existed: boolean; diff: DiffLine[]; beforeHash: string }>;
  plans: Array<{ journeyId: string; stepId: string; method: string; summary: string; notes: string[] }>;
  errors: Array<{ journeyId: string; stepId: string; error: string }>;
}

const METHOD_LABEL: Record<string, string> = {
  'ez-phrase': 'Rewrite the .ez target phrase',
  'ez-sidecar': 'Add a locator hint to the .ez sidecar file',
  'feature-sidecar': 'Add a locator hint to the sidecar of the feature file (its text is unchanged)',
  'yaml-phrase': 'Rewrite the YAML step phrase',
  'yaml-target': 'Update the YAML step target',
  'json-phrase': 'Rewrite the JSON step phrase',
  'json-target': 'Update the JSON step target',
  'element-yaml': 'Update the shared element (every journey using it)',
  'element-json': 'Update the shared element (every journey using it)',
  'element-override': 'Override the screen element in the element repository',
};

const refOf = (it: HealItem) => ({ journeyId: it.journeyId, stepId: it.stepId, healed: it.healed, tier: it.tier, runId: it.lastRunId, original: it.original, ...(it.element ? { element: it.element } : {}), ...(it.anchor !== undefined ? { anchor: it.anchor } : {}) });

function screenshot(e: Evidence, caption: string): HTMLElement {
  const img = h('img', { src: e.url, alt: `${caption} (${e.id})`, loading: 'lazy', decoding: 'async' });
  return h(
    'button',
    {
      type: 'button',
      class: 'q-shot',
      'aria-label': `Enlarge screenshot ${e.id}: ${caption}`,
      onclick: () => openModal({ title: `${e.id}: ${caption}`, size: 'xl', body: h('figure', { class: 'q-lightbox' }, h('img', { src: e.url, alt: `${caption} (${e.id})` }), h('figcaption', { class: 'muted', text: e.description ?? '' })) }),
    },
    img,
    h('span', { class: 'q-shot-id', text: e.id }),
  );
}

export async function acceptHeals(items: HealItem[]): Promise<boolean> {
  const who = await askReviewer();
  if (!who) return false;
  let preview: Preview;
  try {
    preview = await api.post<Preview>('/api/quality/heals/preview', { items: items.map(refOf) });
  } catch (e) {
    toastError(`Preview failed: ${(e as Error).message}`);
    return false;
  }
  const ok = preview.plans.length > 0;
  const note = h('textarea', { id: uid('note'), class: 'input', rows: 2, placeholder: 'Optional note for the audit trail' });
  const body = h(
    'div',
    { class: 'stack' },
    h('p', { text: `${plural(preview.plans.length, 'heal')} will be written into the files below${items.some((i) => i.element) ? ' (shared elements: every journey that uses them is fixed)' : ''}. The fingerprint store is updated and the decision recorded in .eztest/heal-decisions.json.` }),
    h(
      'ul',
      { class: 'q-plan-list' },
      preview.plans.map((p) => h('li', null, h('strong', { text: METHOD_LABEL[p.method] ?? p.method }), h('span', { text: `: ${p.summary}` }), p.notes.length ? h('ul', { class: 'bullets muted small' }, p.notes.map((n) => h('li', { text: n }))) : null)),
    ),
    preview.errors.length ? h('div', { class: 'q-callout tone-bad', role: 'alert' }, h('strong', { text: 'Cannot accept:' }), h('ul', { class: 'bullets' }, preview.errors.map((e) => h('li', { text: `${e.journeyId} / ${e.stepId}: ${e.error}` })))) : null,
    preview.files.length ? preview.files.map((f) => diffView(f.path, f.diff, { existed: f.existed })) : ok ? h('p', { class: 'muted', text: 'The journey already uses these locators; only the decision is recorded.' }) : null,
    h('div', { class: 'grid2' }, reviewerField(), h('div', { class: 'field' }, h('label', { for: note.id, text: 'Note' }), note)),
  );
  if (!ok) {
    await openModal({ title: 'Accept heal', body, size: 'xl', actions: [{ label: 'Close', run: () => true }] }).result;
    return false;
  }
  const confirmed = await confirmWith(`Accept ${plural(preview.plans.length, 'heal')}`, body, preview.files.length ? `Write ${plural(preview.files.length, 'file')}` : 'Record decision', {
    size: 'xl',
    validate: () => (reviewer.get() ? undefined : 'Enter your name as the reviewer'),
  });
  if (!confirmed) return false;
  try {
    const expected = Object.fromEntries(preview.files.map((f) => [f.path, f.beforeHash]));
    const r = await api.post<{ written: string[]; accepted: number; errors: Array<{ error: string }> }>('/api/quality/heals/accept', {
      items: items.map(refOf),
      expected,
      reviewer: reviewer.get(),
      reason: note.value.trim() || undefined,
      confirm: true,
    });
    toast(`Accepted ${plural(r.accepted, 'heal')}${r.written.length ? `; wrote ${r.written.join(', ')}` : ''}`, { kind: 'success' });
    refreshQualitySummary();
    return true;
  } catch (e) {
    toastError(e instanceof ApiError && e.status === 409 ? `${e.message}` : `Accept failed: ${(e as Error).message}`);
    return false;
  }
}

export async function rejectHeals(items: HealItem[]): Promise<boolean> {
  const who = await askReviewer();
  if (!who) return false;
  const id = uid('reason');
  const reason = h('textarea', { id, class: 'input', rows: 3, placeholder: 'e.g. the button now submits a different form; this is a regression' });
  const tiers = [...new Set(items.map((i) => TIER_LABEL[i.tier] ?? i.tier))].join(', ');
  const ok = await confirmWith(
    `Reject ${plural(items.length, 'heal')}`,
    h(
      'div',
      { class: 'stack' },
      h('p', { text: `The ${tiers} heal${items.length === 1 ? '' : 's'} will not be trusted: next time ${items.length === 1 ? 'this step' : 'these steps'} would heal at that tier (or with the same locator), the step fails as a suspected regression instead.` }),
      h('ul', { class: 'bullets' }, items.slice(0, 12).map((i) => h('li', null, h('strong', { text: i.journeyName }), ` › ${i.intent} → `, h('code', { text: locatorText(i.healed) })))),
      h('div', { class: 'field' }, h('label', { for: id, text: 'Reason (required)' }), reason),
      reviewerField(),
    ),
    'Reject',
    { danger: true, size: 'lg', validate: () => (!reason.value.trim() ? 'A reason is required' : !reviewer.get() ? 'Enter your name as the reviewer' : undefined) },
  );
  if (!ok) return false;
  try {
    const r = await api.post<{ rejected: number; cacheCleared: number }>('/api/quality/heals/reject', { items: items.map(refOf), reviewer: reviewer.get(), reason: reason.value.trim(), confirm: true });
    toast(`Rejected ${plural(r.rejected, 'heal')}${r.cacheCleared ? ` and removed ${plural(r.cacheCleared, 'cached heal')}` : ''}`, { kind: 'success' });
    refreshQualitySummary();
    return true;
  } catch (e) {
    toastError(`Reject failed: ${(e as Error).message}`);
    return false;
  }
}

export function registerHealInbox(): void {
  registerPage({
    id: 'quality-heals',
    title: 'Heal review',
    icon: 'heal',
    route: 'quality/heals',
    group: 'quality',
    order: 200,
    mount(ctx) {
      const f = qualityFrame(ctx, 'Heal review', 'Verified heals across runs. Accept writes the new locator into the journey (diff first); reject makes the healer treat that heal as a suspected regression.', { wide: true });
      let items: HealItem[] = [];
      let runFilter: string | undefined;
      const selected = new Set<string>();
      let focusKey: string | undefined;

      const statusSel = h('select', { id: uid('st'), class: 'input input-sm' }, [['pending', 'To review'], ['accepted', 'Accepted'], ['rejected', 'Rejected'], ['applied', 'Already in journey'], ['all', 'All']].map(([v, t]) => h('option', { value: v, text: t })));
      const tierSel = h('select', { id: uid('tier'), class: 'input input-sm' }, h('option', { value: '', text: 'All tiers' }), Object.entries(TIER_LABEL).map(([v, t]) => h('option', { value: v, text: t })));
      const confInput = h('input', { id: uid('conf'), class: 'input input-sm q-num', type: 'number', min: '0', max: '100', step: '5', value: '0', inputmode: 'numeric' });
      const journeySel = h('select', { id: uid('j'), class: 'input input-sm' }, h('option', { value: '', text: 'All journeys' }));
      const search = h('input', { id: uid('q'), class: 'input input-sm', type: 'search', placeholder: 'Filter by step or locator' });
      const field = (label: string, el: HTMLElement) => h('div', { class: 'q-inline-field' }, h('label', { for: el.id, text: label }), el);
      f.toolbar.append(field('Show', statusSel), field('Tier', tierSel), field('Min confidence %', confInput), field('Journey', journeySel), field('Search', search));

      const selectAll = h('input', { type: 'checkbox', id: uid('all'), 'aria-label': 'Select all heals shown' });
      const bulkInfo = h('span', { class: 'muted', role: 'status' });
      const acceptBtn = button('Accept selected', { icon: 'check', kind: 'primary', small: true, id: 'heals-accept-selected' });
      const rejectBtn = button('Reject selected', { icon: 'x', kind: 'danger', small: true, id: 'heals-reject-selected' });
      const bulk = h('div', { class: 'q-bulk', role: 'region', 'aria-label': 'Bulk actions' }, h('label', { class: 'check' }, selectAll, h('span', { text: 'Select all shown' })), bulkInfo, h('span', { class: 'grow' }), h('span', { class: 'muted small q-keys', text: 'Keys: j/k move · x select · a accept · r reject' }), acceptBtn, rejectBtn);
      const list = h('div', { class: 'q-heal-list', role: 'list', 'aria-label': 'Heals' });
      const filterNote = h('p', { class: 'muted small' });

      const visible = (): HealItem[] => {
        const st = statusSel.value;
        const tier = tierSel.value;
        const min = (Number(confInput.value) || 0) / 100;
        const j = journeySel.value;
        const q = search.value.trim().toLowerCase();
        return items.filter(
          (i) =>
            (st === 'all' || i.status === st) &&
            (!tier || i.tiers.includes(tier)) &&
            i.confidence >= min &&
            (!j || i.journeyId === j) &&
            (!runFilter || i.runs.some((r) => r.runId === runFilter)) &&
            (!q || `${i.journeyName} ${i.intent} ${locatorText(i.healed)} ${i.original.map(locatorText).join(' ')}`.toLowerCase().includes(q)),
        );
      };

      const syncBulk = () => {
        const vis = visible();
        const sel = vis.filter((i) => selected.has(i.key));
        selectAll.checked = vis.length > 0 && sel.length === vis.length;
        selectAll.indeterminate = sel.length > 0 && sel.length < vis.length;
        bulkInfo.textContent = sel.length ? `${sel.length} selected` : `${plural(vis.length, 'heal')}`;
        acceptBtn.disabled = rejectBtn.disabled = sel.length === 0;
      };

      const card = (it: HealItem, idx: number): HTMLElement => {
        const cb = h('input', { type: 'checkbox', checked: selected.has(it.key), 'aria-label': `Select heal of ${it.journeyName}: ${it.intent}`, onchange: (e: Event) => ((e.target as HTMLInputElement).checked ? selected.add(it.key) : selected.delete(it.key), syncBulk()) });
        const shots = it.evidence.filter((e) => e.kind === 'screenshot');
        const tone = it.confidence >= 0.85 ? 'ok' : it.confidence >= 0.7 ? 'warn' : 'bad';
        const titleId = uid('heal');
        const el = h(
          'article',
          { class: ['q-heal', `is-${it.status}`], role: 'listitem', tabindex: idx === 0 ? '0' : '-1', 'aria-labelledby': titleId, dataset: { key: it.key } },
          h(
            'header',
            { class: 'q-heal-head' },
            it.status === 'pending' ? cb : null,
            h('div', { class: 'q-heal-title' }, h('h2', { id: titleId, class: 'q-h2' }, h('span', { text: it.journeyName }), h('span', { class: 'muted', text: ' › ' }), h('span', { text: it.intent })), it.element
              ? h('p', { class: 'muted small' }, h('span', { text: 'Shared element ' }), h('code', { text: `@${it.element}` }), it.file ? h('span', { text: ` in ${it.file.path}` }) : null, h('span', { text: ` · used by ${(it.usages ?? []).map((u) => u.journeyName).join(', ')}` }))
              : h('p', { class: 'muted small' }, h('code', { text: it.stepId }), it.file ? h('span', null, ' in ', h('a', { href: link('journeys', it.file.path), text: it.file.path })) : h('span', { class: 'warn-text', text: ' (journey file not found)' }))),
            h('div', { class: 'q-heal-meta' }, h('span', { class: 'chip', title: 'Heal tier', text: TIER_LABEL[it.tier] ?? it.tier }), h('span', { class: 'q-conf' }, meter(it.confidence, `Confidence ${pct(it.confidence)}`, tone), h('span', { class: 'small', text: pct(it.confidence) })), h('span', { class: 'q-runs', title: `First seen ${relTime(it.firstSeen)}` }, icon('refresh', { size: 12 }), h('span', { text: ` healed in ${plural(it.runCount, 'run')}` }))),
          ),
          h(
            'div',
            { class: 'q-heal-body' },
            h(
              'div',
              { class: 'q-loc-compare' },
              h('div', { class: 'q-loc q-loc-old' }, h('p', { class: 'q-label', text: 'Old locators (did not match)' }), h('ul', null, it.original.map((l) => h('li', null, h('del', null, h('code', { text: locatorText(l) })))))),
              h('div', { class: 'q-arrow', 'aria-hidden': 'true' }, icon('chevronRight', { size: 18 })),
              h('div', { class: 'q-loc q-loc-new' }, h('p', { class: 'q-label', text: 'New locator (verified)' }), h('ins', null, h('code', { text: locatorText(it.healed) }))),
            ),
            h(
              'div',
              { class: 'q-verify' },
              h('p', { class: 'q-label', text: 'Verified by' }),
              it.conditions.length || it.impliedCheck
                ? h('ul', { class: 'q-checks' }, it.conditions.map((c) => h('li', null, icon(c.passed ? 'check' : 'x', { size: 13, label: c.passed ? 'held' : 'failed' }), h('span', { text: ` ${c.text}` }), c.actual ? h('span', { class: 'muted small', text: ` (actual: ${c.actual.slice(0, 60)})` }) : null)), it.impliedCheck ? h('li', null, icon('check', { size: 13, label: 'held' }), h('span', { text: ` ${it.impliedCheck}` })) : null)
                : h('p', { class: 'muted small', text: 'Action-implied check' }),
              h('p', { class: 'muted small q-reason', text: it.reason }),
            ),
            h('div', { class: 'q-shots' }, shots.length ? shots.slice(-2).map((s) => screenshot(s, `${it.journeyName}: ${it.intent}`)) : h('p', { class: 'muted small', text: 'No screenshot recorded' })),
          ),
          h(
            'footer',
            { class: 'q-heal-foot' },
            h('span', { class: 'muted small' }, 'Runs: ', it.runs.slice(0, 4).map((r, i) => [i ? ', ' : '', h('a', { href: link('runs', r.runId), text: relTime(r.startedAt) })])),
            h('span', { class: 'grow' }),
            it.decision
              ? h('span', { class: 'small' }, badge(it.decision.decision === 'accepted' ? 'ok' : 'bad', it.decision.decision === 'accepted' ? 'Accepted' : 'Rejected'), h('span', { class: 'muted', text: ` by ${it.decision.reviewer}, ${relTime(it.decision.decidedAt)}${it.decision.reason ? `: ${it.decision.reason}` : ''}` }))
              : it.status === 'applied'
                ? badge('ok', 'Already in the journey')
                : null,
            it.status === 'pending' || it.status === 'applied'
              ? [button(it.status === 'applied' ? 'Record as accepted' : 'Review & accept', { icon: 'check', kind: 'primary', small: true, onclick: () => void act('accept', [it]) }), button('Reject…', { icon: 'x', kind: 'danger', small: true, onclick: () => void act('reject', [it]) })]
              : button('Undo decision', { icon: 'refresh', small: true, onclick: () => void undo(it) }),
          ),
        );
        el.addEventListener('focus', () => (focusKey = it.key));
        return el;
      };

      const renderList = () => {
        const vis = visible();
        for (const k of [...selected]) if (!vis.some((i) => i.key === k)) selected.delete(k);
        clear(list);
        if (!vis.length) {
          list.appendChild(h('div', { class: 'empty', role: 'listitem' }, h('p', { class: 'empty-title', text: items.length ? 'Nothing matches these filters' : 'No heals to review' }), h('p', { class: 'empty-text', text: items.length ? 'Change the filters above to see other heals.' : 'Verified heals appear here when a run heals a changed locator (passed-healed steps).' })));
        } else vis.forEach((it, i) => list.appendChild(card(it, i)));
        filterNote.textContent = runFilter ? `Showing heals from run ${runFilter}. ` : '';
        if (runFilter) filterNote.appendChild(h('a', { href: link('quality', 'heals'), text: 'Show all runs' }));
        syncBulk();
      };

      const act = async (kind: 'accept' | 'reject', its: HealItem[]) => {
        if (!its.length) return;
        const done = kind === 'accept' ? await acceptHeals(its) : await rejectHeals(its);
        if (done) {
          for (const i of its) selected.delete(i.key);
          await load();
        }
      };
      const undo = async (it: HealItem) => {
        const ok = await confirmWith('Undo decision', h('p', { text: 'The review decision is removed (files already written are not reverted). The heal goes back to the inbox.' }), 'Undo', { size: 'sm' });
        if (!ok) return;
        try {
          await api.post('/api/quality/heals/undo', { item: refOf(it), confirm: true });
          toast('Decision removed', { kind: 'success' });
          await load();
        } catch (e) {
          toastError((e as Error).message);
        }
      };

      selectAll.addEventListener('change', () => {
        for (const i of visible()) selectAll.checked ? selected.add(i.key) : selected.delete(i.key);
        renderList();
      });
      acceptBtn.addEventListener('click', () => void act('accept', items.filter((i) => selected.has(i.key))));
      rejectBtn.addEventListener('click', () => void act('reject', items.filter((i) => selected.has(i.key))));
      for (const el of [statusSel, tierSel, journeySel]) el.addEventListener('change', renderList);
      confInput.addEventListener('input', renderList);
      search.addEventListener('input', renderList);

      // Keyboard: roving focus over cards.
      list.addEventListener('keydown', (e) => {
        if ((e.target as HTMLElement).closest('input, button, a, select, textarea') && !(e.target as HTMLElement).classList.contains('q-heal')) return;
        const cards = [...list.querySelectorAll<HTMLElement>('.q-heal')];
        const cur = cards.findIndex((c) => c === document.activeElement);
        if (cur < 0) return;
        const it = items.find((i) => i.key === cards[cur].dataset.key);
        const move = (d: number) => {
          const nx = cards[Math.max(0, Math.min(cards.length - 1, cur + d))];
          cards.forEach((c) => (c.tabIndex = -1));
          nx.tabIndex = 0;
          nx.focus();
          nx.scrollIntoView({ block: 'nearest' });
        };
        if (e.key === 'j' || e.key === 'ArrowDown') move(1);
        else if (e.key === 'k' || e.key === 'ArrowUp') move(-1);
        else if (e.key === 'Home') move(-cards.length);
        else if (e.key === 'End') move(cards.length);
        else if (e.key === 'x' && it && it.status === 'pending') {
          selected.has(it.key) ? selected.delete(it.key) : selected.add(it.key);
          const box = cards[cur].querySelector<HTMLInputElement>('input[type=checkbox]');
          if (box) box.checked = selected.has(it.key);
          syncBulk();
        } else if ((e.key === 'a' || e.key === 'Enter') && it && it.status !== 'rejected' && it.status !== 'accepted') void act('accept', [it]);
        else if (e.key === 'r' && it && it.status !== 'rejected') void act('reject', [it]);
        else return;
        e.preventDefault();
      });

      const load = async () => {
        if (!items.length) f.loading('Collecting heals from recent runs…');
        try {
          const r = await api.get<{ items: HealItem[]; runsScanned: number; warnings: string[] }>('/api/quality/heals');
          items = r.items;
          const cur = journeySel.value;
          clear(journeySel).append(h('option', { value: '', text: 'All journeys' }), ...[...new Map(items.map((i) => [i.journeyId, i.journeyName])).entries()].map(([id, n]) => h('option', { value: id, text: n, selected: id === cur })));
          const pending = items.filter((i) => i.status === 'pending').length;
          f.content(
            h('div', { class: 'q-summary-row' }, h('p', null, h('strong', { text: plural(pending, 'heal') }), ` to review from ${plural(r.runsScanned, 'run')}.`), filterNote),
            bulk,
            list,
            ...r.warnings.map((w) => h('p', { class: 'warn-text small', text: w })),
          );
          renderList();
          if (focusKey) list.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
        } catch (e) {
          f.error((e as Error).message, () => void load());
        }
      };
      autoRefresh(ctx, () => void load(), ['heals']);
      return {
        show(route: Route) {
          runFilter = route.query.get('run') ?? undefined;
          if (route.query.get('status')) statusSel.value = route.query.get('status')!;
          void load();
        },
        focus: () => f.heading.focus(),
      };
    },
  });
}

export function openHealInbox(runId?: string): void {
  navigate(`${link('quality', 'heals')}${runId ? `?run=${encodeURIComponent(runId)}` : ''}`);
}
