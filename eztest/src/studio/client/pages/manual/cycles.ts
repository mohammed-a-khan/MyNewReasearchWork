/**
 * Test management › Cycles (#/manual/cycles) and Dashboard (#/manual/dashboard):
 * suites (sets of cases, explicit or by tag), test cycles (suites + extra cases,
 * testers assigned per case, dates, state), running a cycle's open cases, and
 * progress: by state, by tester, by suite, burn-up over days, and "my
 * assignments" for the tester.
 */
import { api } from '../../core/api.js';
import { clear, h, uid } from '../../core/dom.js';
import { pct, plural, relTime, splitList } from '../../core/format.js';
import { link, navigate } from '../../core/router.js';
import { button, card, stat } from '../../ui/badge.js';
import { openModal } from '../../ui/modal.js';
import { toast, toastError } from '../../ui/toast.js';
import { errorState, loadingState, pageHeader, type SubPageDef } from '../assurance-ui.js';
import { lineChart } from '../quality/charts.js';
import { askTester, kindChip, stateBadge, stateBar, tester, testerField, type Cycle, type CycleProgress, type PlansOverview, type Suite } from './common.js';

const today = () => new Date().toISOString().slice(0, 10);

async function savePlans(plans: PlansOverview['plans']): Promise<PlansOverview | undefined> {
  try {
    const r = await api.put<PlansOverview>('/api/manual/plans', { plans, confirm: true });
    toast('Test plans saved', { kind: 'success' });
    return r;
  } catch (e) {
    toastError((e as Error).message);
    return undefined;
  }
}

function newId(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** A checkbox list of cases (manual and hybrid first). */
function casePicker(all: PlansOverview['cases'], chosen: string[], label: string): { el: HTMLElement; value(): string[] } {
  const sorted = [...all].sort((a, b) => Number(a.type === 'automated') - Number(b.type === 'automated') || a.name.localeCompare(b.name));
  const boxes = sorted.map((c) => ({ c, box: h('input', { type: 'checkbox', value: c.id, checked: chosen.includes(c.id), id: uid('case') }) }));
  return {
    el: h('fieldset', { class: 'mt-picker' }, h('legend', { text: label }), h('ul', { class: 'mt-pick-list' }, boxes.map(({ c, box }) => h('li', null, h('label', { class: 'check', for: box.id }, box, h('span', { text: c.name }), kindChip(c.type)))))),
    value: () => boxes.filter((b) => b.box.checked).map((b) => b.c.id),
  };
}

async function suiteDialog(o: PlansOverview, s?: Suite): Promise<Suite | undefined> {
  const name = h('input', { class: 'input', id: 'suite-name', value: s?.name ?? '' });
  const desc = h('input', { class: 'input', id: 'suite-description', value: s?.description ?? '' });
  const tags = h('input', { class: 'input', id: 'suite-tags', value: (s?.tags ?? []).map((t) => `@${t}`).join(' '), placeholder: '@regression' });
  const picker = casePicker(o.cases, s?.cases ?? [], 'Cases');
  const err = h('p', { class: 'field-error', role: 'alert' });
  return openModal<Suite | null>({
    title: s ? `Edit suite ${s.name}` : 'New suite',
    size: 'lg',
    body: h('div', { class: 'stack' },
      h('div', { class: 'field' }, h('label', { for: name.id, text: 'Name' }), name),
      h('div', { class: 'field' }, h('label', { for: desc.id, text: 'Description' }), desc),
      h('div', { class: 'field' }, h('label', { for: tags.id, text: 'Also every case tagged' }), tags),
      picker.el, err),
    actions: [
      { label: 'Cancel', run: () => null },
      { label: s ? 'Save suite' : 'Create suite', kind: 'primary', run: () => {
        if (!name.value.trim()) {
          err.textContent = 'A suite needs a name.';
          return undefined;
        }
        return { id: s?.id ?? newId(name.value, o.plans.suites.map((x) => x.id)), name: name.value.trim(), ...(desc.value.trim() ? { description: desc.value.trim() } : {}), cases: picker.value(), tags: splitList(tags.value).map((t) => t.replace(/^@/, '')) };
      } },
    ],
  }).result.then((v) => v ?? undefined);
}

async function cycleDialog(o: PlansOverview, c?: Cycle): Promise<Cycle | undefined> {
  const name = h('input', { class: 'input', id: 'cycle-name', value: c?.name ?? '' });
  const release = h('input', { class: 'input', id: 'cycle-release', value: c?.release ?? '' });
  const start = h('input', { class: 'input', id: 'cycle-start', type: 'date', value: c?.start ?? today() });
  const due = h('input', { class: 'input', id: 'cycle-due', type: 'date', value: c?.due ?? '' });
  const suites = o.plans.suites.map((s) => ({ s, box: h('input', { type: 'checkbox', id: uid('suite'), value: s.id, checked: c?.suites.includes(s.id) ?? false }) }));
  const extra = casePicker(o.cases, c?.cases ?? [], 'Extra cases (outside the suites)');
  const err = h('p', { class: 'field-error', role: 'alert' });
  return openModal<Cycle | null>({
    title: c ? `Edit cycle ${c.name}` : 'New test cycle',
    size: 'lg',
    body: h('div', { class: 'stack' },
      h('div', { class: 'field' }, h('label', { for: name.id, text: 'Name' }), name),
      h('div', { class: 'q-grid2' }, h('div', { class: 'field' }, h('label', { for: release.id, text: 'Release' }), release), h('div', { class: 'q-grid2' }, h('div', { class: 'field' }, h('label', { for: start.id, text: 'Start' }), start), h('div', { class: 'field' }, h('label', { for: due.id, text: 'Due' }), due))),
      h('fieldset', { class: 'mt-picker' }, h('legend', { text: 'Suites' }), suites.length ? h('ul', { class: 'mt-pick-list' }, suites.map(({ s, box }) => h('li', null, h('label', { class: 'check', for: box.id }, box, h('span', { text: `${s.name} (${plural(s.cases.length, 'case')}${s.tags.length ? ` + tagged ${s.tags.map((t) => `@${t}`).join(' ')}` : ''})` }))))) : h('p', { class: 'muted small', text: 'No suites yet; pick cases below or create a suite first.' })),
      extra.el, err),
    actions: [
      { label: 'Cancel', run: () => null },
      { label: c ? 'Save cycle' : 'Create cycle', kind: 'primary', run: () => {
        if (!name.value.trim()) {
          err.textContent = 'A cycle needs a name.';
          return undefined;
        }
        const chosen = suites.filter((x) => x.box.checked).map((x) => x.s.id);
        if (!chosen.length && !extra.value().length) {
          err.textContent = 'Choose at least one suite or case.';
          return undefined;
        }
        return {
          id: c?.id ?? newId(name.value, o.plans.cycles.map((x) => x.id)), name: name.value.trim(), ...(release.value.trim() ? { release: release.value.trim() } : {}),
          suites: chosen, cases: extra.value(), assignments: c?.assignments ?? {}, ...(start.value ? { start: start.value } : {}), ...(due.value ? { due: due.value } : {}),
          state: c?.state ?? 'planned', runs: c?.runs ?? [], createdAt: c?.createdAt ?? new Date().toISOString(), ...(c?.createdBy || tester.get() ? { createdBy: c?.createdBy ?? tester.get() } : {}),
        };
      } },
    ],
  }).result.then((v) => v ?? undefined);
}

async function runCycle(id: string, onlyMine: boolean): Promise<void> {
  const who = await askTester();
  if (!who) return;
  try {
    const r = await api.post<{ id: string; journeys: string[] }>(`/api/manual/cycles/${encodeURIComponent(id)}/run`, { tester: who, onlyMine });
    toast(`Started ${plural(r.journeys.length, 'case')}`, { kind: 'success' });
    navigate(link('manual', 'run', r.id));
  } catch (e) {
    toastError((e as Error).message);
  }
}

function progressView(p: CycleProgress, o: PlansOverview, onAssign?: (caseId: string, who: string) => void): HTMLElement {
  const c = p.counts;
  const testers = o.testers;
  const listId = uid('assignees');
  return h('div', { class: 'stack', dataset: { cycle: p.cycle.id } },
    h('div', { class: 'stats' },
      stat(pct(p.executedRatio), 'Executed', p.executedRatio >= 1 ? 'ok' : 'warn'),
      stat(pct(p.passRatio), 'Passed', p.passRatio >= 0.95 ? 'ok' : 'warn'),
      stat(c.failed + c.blocked, 'Failed or blocked', c.failed + c.blocked ? 'bad' : 'ok'),
      stat(c.untested + c['in-progress'], 'Open')),
    stateBar(p.counts, p.total, `${p.cycle.name} progress`),
    h('div', { class: 'q-grid2' },
      h('div', null, h('p', { class: 'q-label', text: 'By tester' }), h('table', { class: 'table compact' }, h('caption', { class: 'sr-only', text: `${p.cycle.name} progress by tester` }), h('thead', null, h('tr', null, ['Tester', 'Executed', 'Failed or blocked', 'Open'].map((t) => h('th', { scope: 'col', text: t })))),
        h('tbody', null, p.byAssignee.map((a) => h('tr', null, h('th', { scope: 'row', text: a.assignee }), h('td', { class: 'num', text: `${a.total - a.counts.untested - a.counts['in-progress']}/${a.total}` }), h('td', { class: 'num', text: String(a.counts.failed + a.counts.blocked) }), h('td', { class: 'num', text: String(a.counts.untested + a.counts['in-progress']) })))))),
      p.burnup.length > 1
        ? h('div', null, h('p', { class: 'q-label', text: 'Burn-up' }), lineChart([{ id: 'exec', label: 'Executed', slot: 1, values: p.burnup.map((b) => b.executed) }, { id: 'pass', label: 'Passed', slot: 3, values: p.burnup.map((b) => b.passed) }], { label: `${p.cycle.name}: cases executed and passed by day`, x: p.burnup.map((b) => b.date), format: (v) => String(Math.round(v)), yMax: Math.max(1, p.total) }))
        : p.bySuite.length ? h('div', null, h('p', { class: 'q-label', text: 'By suite' }), h('ul', { class: 'bullets small' }, p.bySuite.map((s) => h('li', { text: `${s.name}: ${s.counts.passed}/${s.total} passed, ${s.counts.failed + s.counts.blocked} failed or blocked` })))) : h('span'),
    ),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table compact', id: `cycle-cases-${p.cycle.id}` },
      h('caption', { class: 'sr-only', text: `Cases of ${p.cycle.name}` }),
      h('thead', null, h('tr', null, ['Case', 'Type', 'Assigned to', 'State', 'Latest run'].map((t) => h('th', { scope: 'col', text: t })))),
      h('tbody', null, p.cases.map((x) => h('tr', { dataset: { case: x.id, state: x.state } },
        h('th', { scope: 'row', text: x.name }, x.missing ? h('span', { class: 'chip', text: 'missing' }) : null),
        h('td', null, kindChip(x.type)),
        h('td', null, onAssign ? h('input', { class: 'input input-sm', list: listId, value: x.assignee ?? '', 'aria-label': `Assign ${x.name} to`, onchange: (e: Event) => onAssign(x.id, (e.target as HTMLInputElement).value.trim()) }) : x.assignee ?? '—'),
        h('td', null, stateBadge(x.state), x.manualTotal ? h('span', { class: 'muted small', text: ` ${x.manualDone}/${x.manualTotal} steps` }) : null),
        h('td', null, x.runId ? h('a', { href: link('manual', 'run', x.runId), text: relTime(x.at) }) : '—'))))),
      h('datalist', { id: listId }, testers.map((t) => h('option', { value: t })))),
  );
}

export const cyclesSection: SubPageDef = {
  id: 'cycles',
  title: 'Cycles',
  icon: 'layers',
  description: 'Suites, test cycles and assignments',
  mount(root) {
    let o: PlansOverview | undefined;
    const draw = () => {
      if (!o) return;
      const ov = o;
      const plans = ov.plans;
      const persist = async () => {
        const r = await savePlans(plans);
        if (r) {
          o = r;
          draw();
        }
      };
      clear(root).append(
        pageHeader('Suites and test cycles', `Saved in ${ov.path}. Results come from the runs a cycle records; nothing here edits a result.`,
          h('div', { class: 'row wrap' },
            button('New suite', { icon: 'plus', small: true, id: 'suite-new', onclick: async () => {
              const s = await suiteDialog(ov);
              if (s) (plans.suites.push(s), await persist());
            } }),
            button('New cycle', { icon: 'plus', small: true, kind: 'primary', id: 'cycle-new', onclick: async () => {
              const c = await cycleDialog(ov);
              if (c) (plans.cycles.push(c), await persist());
            } }))),
        card('Suites', plans.suites.length
          ? h('ul', { class: 'mt-suites', id: 'suites' }, plans.suites.map((s) => h('li', { dataset: { suite: s.id } },
              h('div', null, h('strong', { text: s.name }), h('span', { class: 'muted small', text: ` · ${plural(s.cases.length, 'case')}${s.tags.length ? ` + tagged ${s.tags.map((t) => `@${t}`).join(' ')}` : ''}` })),
              h('div', { class: 'row wrap' },
                button('Edit', { small: true, kind: 'ghost', ariaLabel: `Edit suite ${s.name}`, onclick: async () => {
                  const n = await suiteDialog(ov, s);
                  if (n) (Object.assign(s, n), await persist());
                } }),
                button('Delete', { small: true, kind: 'ghost', ariaLabel: `Delete suite ${s.name}`, disabled: plans.cycles.some((c) => c.suites.includes(s.id)), title: plans.cycles.some((c) => c.suites.includes(s.id)) ? 'Used by a cycle' : undefined, onclick: async () => {
                  plans.suites = plans.suites.filter((x) => x.id !== s.id);
                  await persist();
                } })))))
          : h('p', { class: 'muted', text: 'No suites yet. A suite groups cases (picked, or by tag) for cycles.' }), { id: 'suites-card' }),
        ...(plans.cycles.length ? plans.cycles.map((c) => {
          const p = ov.progress.find((x) => x.cycle.id === c.id);
          return card(`${c.name}${c.release ? ` · ${c.release}` : ''}`,
            h('div', { class: 'stack' },
              h('p', { class: 'small muted', text: `${c.state}${c.start ? ` · from ${c.start}` : ''}${c.due ? ` · due ${c.due}` : ''} · ${plural(c.runs.length, 'run')}` }),
              p ? progressView(p, ov, async (caseId, who) => {
                if (who) c.assignments[caseId] = who;
                else delete c.assignments[caseId];
                await persist();
              }) : null,
              h('div', { class: 'row wrap' },
                c.state !== 'closed' ? button('Run my open cases', { small: true, icon: 'run', kind: 'primary', ariaLabel: `Run my open cases of ${c.name}`, onclick: () => void runCycle(c.id, true) }) : null,
                c.state !== 'closed' ? button('Run all open cases', { small: true, icon: 'run', ariaLabel: `Run all open cases of ${c.name}`, onclick: () => void runCycle(c.id, false) }) : null,
                button('Edit', { small: true, kind: 'ghost', ariaLabel: `Edit cycle ${c.name}`, onclick: async () => {
                  const n = await cycleDialog(ov, c);
                  if (n) (Object.assign(c, n), await persist());
                } }),
                button(c.state === 'closed' ? 'Reopen' : 'Close cycle', { small: true, kind: 'ghost', ariaLabel: `${c.state === 'closed' ? 'Reopen' : 'Close cycle'} ${c.name}`, onclick: async () => {
                  c.state = c.state === 'closed' ? 'active' : 'closed';
                  await persist();
                } }))),
            { id: `cycle-${c.id}`, class: 'mt-cycle' });
        }) : [card('Test cycles', h('p', { class: 'muted', text: 'No cycles yet. A cycle plans a release\'s test execution: suites, testers, dates.' }))]),
      );
    };
    const load = async () => {
      clear(root).appendChild(loadingState());
      try {
        o = await api.get<PlansOverview>('/api/manual/plans');
        draw();
      } catch (e) {
        clear(root).appendChild(errorState(e, () => void load()));
      }
    };
    return { show: () => void load() };
  },
};

export const dashboardSection: SubPageDef = {
  id: 'dashboard',
  title: 'Dashboard',
  icon: 'gauge',
  description: 'Progress and my assignments',
  mount(root) {
    const load = async () => {
      clear(root).appendChild(loadingState());
      let d: { cycles: CycleProgress[]; mine: Array<CycleProgress['cases'][number] & { cycle: string; cycleName: string }>; testers: string[] };
      let o: PlansOverview;
      try {
        [d, o] = await Promise.all([api.get<typeof d>(`/api/manual/dashboard${tester.get() ? `?tester=${encodeURIComponent(tester.get())}` : ''}`), api.get<PlansOverview>('/api/manual/plans')]);
      } catch (e) {
        clear(root).appendChild(errorState(e, () => void load()));
        return;
      }
      const field = testerField(d.testers, 'Show assignments of');
      field.querySelector('input')?.addEventListener('change', () => void load());
      clear(root).append(
        pageHeader('Test management dashboard', 'Progress of active cycles, and the cases waiting for you.'),
        h('div', { class: 'row wrap' }, field),
        card(`My open assignments${tester.get() ? ` (${tester.get()})` : ''}`, d.mine.length
          ? h('table', { class: 'table compact', id: 'my-assignments' }, h('caption', { class: 'sr-only', text: 'My open assignments' }),
              h('thead', null, h('tr', null, ['Case', 'Cycle', 'State', ''].map((t) => h('th', { scope: 'col', text: t })))),
              h('tbody', null, d.mine.map((x) => h('tr', { dataset: { case: x.id } }, h('th', { scope: 'row', text: x.name }), h('td', { text: x.cycleName }), h('td', null, stateBadge(x.state)), h('td', null, button('Run', { small: true, icon: 'run', ariaLabel: `Run ${x.name}`, onclick: async () => {
                const who = await askTester();
                if (!who) return;
                try {
                  const r = await api.post<{ id: string }>('/api/manual/run', { journeys: [x.id], tester: who, cycle: x.cycle });
                  navigate(link('manual', 'run', r.id));
                } catch (e) {
                  toastError((e as Error).message);
                }
              } }))))))
          : h('p', { class: 'muted', text: tester.get() ? 'Nothing open is assigned to you.' : 'Enter your name to see your assignments.' }), { id: 'dash-mine' }),
        ...(d.cycles.length ? d.cycles.map((p) => card(`${p.cycle.name}`, progressView(p, o), { id: `dash-cycle-${p.cycle.id}` })) : [card('Active cycles', h('p', { class: 'muted', text: 'No active cycles. Plan one under Cycles.' }), { id: 'dash-cycles' })]),
      );
    };
    return { show: () => void load() };
  },
};
