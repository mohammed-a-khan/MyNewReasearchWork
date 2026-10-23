/**
 * Test management › Cases (#/manual/cases[/<path>|/new]): manual and hybrid
 * cases with their assignee and latest result, and the case editor: plain
 * English steps with expected results, reference attachments and automated
 * checks, parameters (an Examples table), saved as `.ez` (previewed and
 * validated by the real parser before writing).
 */
import { api } from '../../core/api.js';
import { clear, h, uid } from '../../core/dom.js';
import { plural, relTime, splitList } from '../../core/format.js';
import { link, navigate } from '../../core/router.js';
import { refreshJourneys } from '../../core/state.js';
import { button, card } from '../../ui/badge.js';
import { icon } from '../../ui/icons.js';
import { confirmDialog } from '../../ui/modal.js';
import { toast, toastError } from '../../ui/toast.js';
import { errorState, loadingState, pageHeader, type SubPageDef } from '../assurance-ui.js';
import { askTester, kindChip, stateBadge, tester, type CaseListItem } from './common.js';

interface CaseStep {
  instruction?: string;
  automated?: string;
  expected?: string[];
  attachments?: string[];
  checks?: string[];
}

interface CaseModel {
  name: string;
  id?: string;
  type?: 'manual' | 'hybrid';
  description?: string;
  assignee?: string;
  preconditions?: string;
  requirements?: string[];
  tags?: string[];
  risk?: number;
  baseUrl?: string;
  steps: CaseStep[];
  parameters?: { columns: string[]; rows: string[][] };
}

const lines = (s: string) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

/** Start a guided run of cases and open the runner. */
export async function startGuidedRun(ids: string[], opts: { cycle?: string; headed?: boolean } = {}): Promise<void> {
  const who = await askTester();
  if (!who) return;
  try {
    const r = await api.post<{ id: string }>('/api/manual/run', { journeys: ids, tester: who, ...(opts.cycle ? { cycle: opts.cycle } : {}), ...(opts.headed ? { headed: true } : {}) });
    navigate(link('manual', 'run', r.id));
  } catch (e) {
    toastError((e as Error).message);
  }
}

function editor(root: HTMLElement, path: string | undefined, known: string[]): void {
  clear(root).appendChild(loadingState('Opening the case…'));
  const errors = h('div', { class: 'field-error', role: 'alert', id: 'case-errors' });
  const preview = h('pre', { class: 'code-preview code-block', tabindex: '0', 'aria-label': 'The case as .ez', id: 'case-preview' });
  const steps: CaseStep[] = [];
  const stepsEl = h('ol', { class: 'mt-steps', id: 'case-steps' });
  const field = (label: string, input: HTMLElement, help?: string) => {
    const id = input.id || uid('f');
    input.id = id;
    const helpId = help ? `${id}-help` : undefined;
    if (helpId) input.setAttribute('aria-describedby', helpId);
    return h('div', { class: 'field' }, h('label', { for: id, text: label }), input, help ? h('p', { class: 'muted small', id: helpId, text: help }) : null);
  };
  const name = h('input', { class: 'input', id: 'case-name', required: true, autocomplete: 'off' });
  const assignee = h('input', { class: 'input', id: 'case-assignee', list: 'case-testers', autocomplete: 'off' });
  const requirements = h('input', { class: 'input', id: 'case-requirements', placeholder: 'ORD-1, ORD-7', autocomplete: 'off' });
  const tags = h('input', { class: 'input', id: 'case-tags', placeholder: '@regression @orders', autocomplete: 'off' });
  const risk = h('select', { class: 'input', id: 'case-risk' }, [1, 2, 3, 4, 5].map((r) => h('option', { value: String(r), text: `${r}${r === 5 ? ' (critical)' : r === 1 ? ' (low)' : ''}`, selected: r === 3 })));
  const pre = h('textarea', { class: 'input', id: 'case-preconditions', rows: 2 });
  const baseUrl = h('input', { class: 'input', id: 'case-base-url', placeholder: 'optional, e.g. /orders', autocomplete: 'off' });
  const pcols = h('input', { class: 'input', id: 'case-param-columns', placeholder: 'order, amount', autocomplete: 'off' });
  const prows = h('textarea', { class: 'input', id: 'case-param-rows', rows: 3, placeholder: '1 | 49.50\n2 | 99.00' });

  const renderSteps = () => {
    clear(stepsEl);
    steps.forEach((s, i) => {
      const isAuto = s.automated !== undefined;
      const main = isAuto
        ? h('input', { class: 'input mono', id: `step-${i}-automated`, value: s.automated ?? '', 'aria-label': `Step ${i + 1}: automated EZ line`, oninput: (e: Event) => (s.automated = (e.target as HTMLInputElement).value) })
        : h('textarea', { class: 'input', id: `step-${i}-instruction`, rows: 2, value: s.instruction ?? '', 'aria-label': `Step ${i + 1}: what the tester does`, oninput: (e: Event) => (s.instruction = (e.target as HTMLTextAreaElement).value) });
      const expected = h('textarea', { class: 'input', id: `step-${i}-expected`, rows: 2, value: (s.expected ?? []).join('\n'), 'aria-label': `Step ${i + 1}: expected results, one per line`, oninput: (e: Event) => (s.expected = lines((e.target as HTMLTextAreaElement).value)) });
      const attach = h('input', { class: 'input', id: `step-${i}-attachments`, value: (s.attachments ?? []).join(', '), 'aria-label': `Step ${i + 1}: reference files (project paths)`, placeholder: 'docs/refund-policy.pdf', oninput: (e: Event) => (s.attachments = splitList((e.target as HTMLInputElement).value)) });
      const checks = h('input', { class: 'input mono', id: `step-${i}-checks`, value: (s.checks ?? []).join('; '), 'aria-label': `Step ${i + 1}: automated checks after the step`, placeholder: 'the page contains "Refunded"', oninput: (e: Event) => (s.checks = (e.target as HTMLInputElement).value.split(';').map((x) => x.trim()).filter(Boolean)) });
      stepsEl.appendChild(
        h(
          'li',
          { class: 'mt-step-edit', dataset: { index: i } },
          h('fieldset', null,
            h('legend', null, `Step ${i + 1} `, kindChip(isAuto ? 'automated' : 'manual')),
            h('div', { class: 'field' }, h('label', { for: main.id, text: isAuto ? 'Automated step (EZ line)' : 'What the tester does' }), main),
            h('div', { class: 'field' }, h('label', { for: expected.id, text: 'Expected results (one per line)' }), expected),
            h('div', { class: 'q-grid2' },
              h('div', { class: 'field' }, h('label', { for: attach.id, text: 'Reference attachments' }), attach),
              h('div', { class: 'field' }, h('label', { for: checks.id, text: 'Automated checks (separate with ;)' }), checks)),
            h('div', { class: 'row wrap' },
              button('Up', { small: true, icon: 'up', disabled: i === 0, ariaLabel: `Move step ${i + 1} up`, onclick: () => ([steps[i - 1], steps[i]] = [steps[i], steps[i - 1]], renderSteps()) }),
              button('Down', { small: true, icon: 'down', disabled: i === steps.length - 1, ariaLabel: `Move step ${i + 1} down`, onclick: () => ([steps[i + 1], steps[i]] = [steps[i], steps[i + 1]], renderSteps()) }),
              button('Remove', { small: true, icon: 'trash', kind: 'ghost', ariaLabel: `Remove step ${i + 1}`, onclick: () => (steps.splice(i, 1), renderSteps()) }),
            ),
          ),
        ),
      );
    });
  };

  const model = (): CaseModel => {
    const cols = splitList(pcols.value);
    const rows = lines(prows.value).map((r) => r.split('|').map((c) => c.trim()));
    return {
      name: name.value.trim(), type: steps.some((s) => s.automated !== undefined) ? 'hybrid' : 'manual', ...(id ? { id } : {}),
      assignee: assignee.value.trim(), requirements: splitList(requirements.value), tags: splitList(tags.value).map((t) => t.replace(/^@/, '')),
      risk: Number(risk.value), preconditions: pre.value.trim(), baseUrl: baseUrl.value.trim(), steps,
      ...(cols.length && rows.length ? { parameters: { columns: cols, rows } } : {}),
    };
  };

  let id: string | undefined;
  const doPreview = async (): Promise<boolean> => {
    errors.textContent = '';
    try {
      const r = await api.post<{ ez: string; manualSteps: number; kind: string }>('/api/manual/case/preview', { case: model() });
      preview.textContent = r.ez;
      return true;
    } catch (e) {
      errors.textContent = (e as Error).message;
      return false;
    }
  };
  const save = async () => {
    if (!(await doPreview())) return;
    try {
      const r = await api.put<{ path: string; created: boolean }>('/api/manual/case', { case: model(), ...(path ? { path } : {}), confirm: true });
      toast(`${r.created ? 'Created' : 'Saved'} ${r.path}`, { kind: 'success' });
      void refreshJourneys().catch(() => undefined);
      if (!path) navigate(link('manual', 'cases', ...r.path.split('/')));
    } catch (e) {
      errors.textContent = (e as Error).message;
    }
  };

  const mount = () => {
    clear(root).append(
      pageHeader(path ? `Edit case` : 'New manual case', path ? path : 'Plain-English steps a tester carries out, with expected results. Mix in automated EZ steps to make it a hybrid journey.',
        h('div', { class: 'row wrap' }, button('Back to cases', { icon: 'chevronLeft', small: true, onclick: () => navigate(link('manual', 'cases')) }))),
      h('form', { class: 'stack', id: 'case-form', novalidate: true, onsubmit: (e: Event) => (e.preventDefault(), void save()) },
        card('Case', h('div', { class: 'stack' },
          field('Name', name),
          h('div', { class: 'q-grid2' }, field('Assignee', assignee, 'The tester this case is assigned to.'), field('Risk', risk)),
          h('div', { class: 'q-grid2' }, field('Requirements', requirements, 'Work item or requirement ids, comma separated.'), field('Tags', tags)),
          field('Preconditions', pre, 'What must be true before the tester starts.'),
          field('Base URL', baseUrl),
          h('datalist', { id: 'case-testers' }, known.map((t) => h('option', { value: t }))),
        )),
        card(`Steps`, h('div', { class: 'stack' }, stepsEl, h('div', { class: 'row wrap' },
          button('Add manual step', { icon: 'plus', small: true, id: 'add-manual-step', onclick: () => (steps.push({ instruction: '', expected: [] }), renderSteps(), stepsEl.querySelector<HTMLElement>(`#step-${steps.length - 1}-instruction`)?.focus()) }),
          button('Add automated step', { icon: 'plus', small: true, id: 'add-automated-step', onclick: () => (steps.push({ automated: '' }), renderSteps(), stepsEl.querySelector<HTMLElement>(`#step-${steps.length - 1}-automated`)?.focus()) }),
        ))),
        card('Parameters', h('div', { class: 'stack' }, h('p', { class: 'muted small', text: 'Optional. The case runs once per row; write <column> in the steps to use a value.' }), h('div', { class: 'q-grid2' }, field('Columns (comma separated)', pcols), field('Rows (one per line, cells separated by |)', prows)))),
        card('Preview', h('div', { class: 'stack' }, errors, preview, h('div', { class: 'row wrap' },
          button('Preview .ez', { small: true, icon: 'eye', id: 'case-preview-btn', onclick: () => void doPreview() }),
          h('button', { type: 'submit', class: 'btn btn-primary', id: 'case-save' }, icon('save', { size: 14 }), h('span', { text: 'Save case' })),
          path ? button('Run this case', { small: true, icon: 'run', id: 'case-run', onclick: async () => {
            if (id) await startGuidedRun([id]);
          } }) : null,
          path ? button('Automate…', { small: true, icon: 'convert', id: 'case-automate', onclick: () => navigate(link('manual', 'automate', ...path.split('/'))) }) : null,
        ))),
      ),
    );
    renderSteps();
  };

  if (!path) {
    steps.push({ instruction: '', expected: [] });
    assignee.value = tester.get();
    mount();
    return;
  }
  api.get<{ path: string; ez: string; model: CaseModel }>(`/api/manual/case?path=${encodeURIComponent(path)}`).then((r) => {
    const m = r.model;
    id = m.id;
    name.value = m.name;
    assignee.value = m.assignee ?? '';
    requirements.value = (m.requirements ?? []).join(', ');
    tags.value = (m.tags ?? []).map((t) => `@${t}`).join(' ');
    risk.value = String(m.risk ?? 3);
    pre.value = m.preconditions ?? '';
    baseUrl.value = m.baseUrl ?? '';
    if (m.parameters) {
      pcols.value = m.parameters.columns.join(', ');
      prows.value = m.parameters.rows.map((x) => x.join(' | ')).join('\n');
    }
    steps.push(...m.steps);
    mount();
    preview.textContent = r.ez;
  }).catch((e: Error) => clear(root).appendChild(errorState(e, () => editor(root, path, known))));
}

export const casesSection: SubPageDef = {
  id: 'cases',
  title: 'Cases',
  icon: 'list',
  description: 'Manual and hybrid test cases',
  mount(root) {
    let known: string[] = [];
    const list = async () => {
      clear(root).appendChild(loadingState('Loading cases…'));
      let data: { cases: CaseListItem[]; testers: string[] };
      try {
        data = await api.get('/api/manual/cases');
      } catch (e) {
        clear(root).appendChild(errorState(e, () => void list()));
        return;
      }
      known = data.testers;
      const selected = new Set<string>();
      const runBtn = button('Run selected', { icon: 'run', kind: 'primary', small: true, id: 'cases-run', disabled: true, onclick: () => void startGuidedRun([...selected]) });
      const mineOnly = h('input', { type: 'checkbox', id: 'cases-mine' });
      const body = h('div');
      const draw = () => {
        const rows = mineOnly.checked ? data.cases.filter((c) => c.assignee && c.assignee === tester.get()) : data.cases;
        clear(body).appendChild(
          rows.length
            ? h(
                'div',
                { class: 'table-wrap' },
                h(
                  'table',
                  { class: 'table compact', id: 'cases-table' },
                  h('caption', { class: 'sr-only', text: 'Manual and hybrid cases' }),
                  h('thead', null, h('tr', null, h('th', { scope: 'col' }, h('span', { class: 'sr-only', text: 'Select' })), ['Case', 'Type', 'Assignee', 'Steps', 'Latest result', 'Actions'].map((t) => h('th', { scope: 'col', text: t })))),
                  h(
                    'tbody',
                    null,
                    rows.map((c) => {
                      const cb = h('input', { type: 'checkbox', 'aria-label': `Select ${c.name}`, onchange: (e: Event) => {
                        if ((e.target as HTMLInputElement).checked) selected.add(c.id);
                        else selected.delete(c.id);
                        runBtn.disabled = !selected.size;
                      } });
                      return h(
                        'tr',
                        { dataset: { id: c.id } },
                        h('td', null, cb),
                        h('th', { scope: 'row' }, h('a', { href: link('manual', 'cases', ...c.path.split('/')), text: c.name }), h('span', { class: 'muted small q-block', text: c.path })),
                        h('td', null, kindChip(c.type)),
                        h('td', { text: c.assignee ?? '—' }),
                        h('td', { class: 'num', text: `${c.manualSteps ?? 0}/${c.steps}` }),
                        h('td', null, c.last ? [stateBadge(c.last.status), h('span', { class: 'muted small', text: ` ${relTime(c.last.at)}${c.last.testers.length ? ` by ${c.last.testers.join(', ')}` : ''}` }), h('a', { class: 'small q-block', href: link('manual', 'run', c.last.runId), text: 'Open run' })] : stateBadge('not-run')),
                        h('td', null, h('div', { class: 'row wrap' },
                          button('Run', { small: true, icon: 'run', ariaLabel: `Run ${c.name}`, onclick: () => void startGuidedRun([c.id]) }),
                          button('Automate', { small: true, kind: 'ghost', icon: 'convert', ariaLabel: `Automate ${c.name}`, onclick: () => navigate(link('manual', 'automate', ...c.path.split('/'))) }))),
                      );
                    }),
                  ),
                ),
              )
            : h('p', { class: 'muted', text: mineOnly.checked ? 'No cases are assigned to you.' : 'No manual or hybrid cases yet. Create one, import a spreadsheet (Import › manual cases as manual) or write "Manual:" steps in a journey.' }),
        );
      };
      mineOnly.addEventListener('change', draw);
      clear(root).append(
        pageHeader('Manual and hybrid cases', `${plural(data.cases.length, 'case')}. A manual case is plain-English steps a tester marks pass, fail or blocked; a hybrid one mixes automated steps that pause for the tester.`,
          h('div', { class: 'row wrap' }, runBtn, button('New case', { icon: 'plus', small: true, id: 'cases-new', onclick: () => navigate(link('manual', 'cases', 'new')) }))),
        h('label', { class: 'check' }, mineOnly, h('span', { text: 'Only cases assigned to me' })),
        body,
      );
      draw();
    };
    return {
      show(segments) {
        if (segments[0] === 'new') return editor(root, undefined, known);
        if (segments.length) return editor(root, segments.join('/'), known);
        void list();
      },
    };
  },
};

export async function confirmEnd(): Promise<boolean> {
  return confirmDialog({ title: 'End this run?', message: 'Manual steps without a verdict are recorded as not executed. The run is then analyzed (readiness, history, traceability).', confirm: 'End run', danger: true });
}
