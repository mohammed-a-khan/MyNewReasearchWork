/**
 * Test management › Automate (#/manual/automate/<path>): turn a manual case
 * into an automated journey, either through the EZ grammar (instructions it
 * reads become steps, expected results it reads become Expect lines) or with
 * the recorder: perform each manual step in the recorder's browser while the
 * case's step list shows which step the recorded lines belong to. Steps with
 * nothing recorded stay manual, so the result is hybrid rather than lossy.
 */
import { api } from '../../core/api.js';
import { announce, clear, h, uid } from '../../core/dom.js';
import { onTopic } from '../../core/events.js';
import { plural } from '../../core/format.js';
import { link, navigate } from '../../core/router.js';
import { refreshJourneys } from '../../core/state.js';
import { button, card } from '../../ui/badge.js';
import { confirmDialog } from '../../ui/modal.js';
import { toast, toastError } from '../../ui/toast.js';
import { errorState, loadingState, pageHeader, type SubPageDef } from '../assurance-ui.js';
import { kindChip } from './common.js';

interface CaseRead {
  path: string;
  ez: string;
  kind: string;
  model: { name: string; id?: string; baseUrl?: string; steps: Array<{ instruction?: string; automated?: string; expected?: string[] }> };
  steps: Array<{ id: string; manual: boolean; text: string; expected: string[] }>;
  baseUrl?: string;
}

interface Automation {
  path: string;
  ez: string;
  kind: string;
  automated: string[];
  kept: string[];
  uncheckedExpectations: string[];
  written?: string;
}

interface PlanStep {
  id: string;
  instruction: string;
  expected: string[];
  lines: string[];
}

export const automateSection: SubPageDef = {
  id: 'automate',
  title: 'Automate',
  icon: 'convert',
  description: 'Convert a manual case with the grammar or the recorder',
  mount(root) {
    let path: string | undefined;
    let steps: PlanStep[] = [];
    let current = 0;
    let recording = false;
    const result = h('div', { class: 'stack', id: 'automate-result' });
    const stepList = h('ol', { class: 'mt-plan-steps mt-rec-steps', id: 'automate-steps' });

    const showResult = (r: Automation, method: 'grammar' | 'recording') => {
      clear(result).append(
        h('p', { class: 'small', id: 'automate-summary' }, kindChip(r.kind), ` ${plural(r.automated.length, 'step')} automated, ${plural(r.kept.length, 'step')} kept manual${r.uncheckedExpectations.length ? `, ${plural(r.uncheckedExpectations.length, 'expected result')} to write as Expect lines` : ''}.`),
        h('pre', { class: 'code-preview code-block tall', tabindex: '0', 'aria-label': 'The converted journey', id: 'automate-ez', text: r.ez }),
        h('div', { class: 'row wrap' }, button('Replace the case with this journey', { kind: 'primary', icon: 'save', id: 'automate-write', onclick: async () => {
          if (!(await confirmDialog({ title: 'Replace the manual case?', message: `${r.path} is rewritten as ${r.kind === 'hybrid' ? 'a hybrid' : 'an automated'} journey with the same id, so its history and traceability carry on. Source control keeps the old version.`, confirm: 'Replace' }))) return;
          try {
            const w = await api.post<Automation>('/api/manual/automate', { path: r.path, method, recorded: method === 'recording' ? steps.map((s) => ({ stepId: s.id, lines: s.lines })) : [], write: true, confirm: true });
            toast(`Wrote ${w.written}`, { kind: 'success' });
            void refreshJourneys().catch(() => undefined);
            navigate(link('journeys', ...(w.written ?? r.path).split('/')));
          } catch (e) {
            toastError((e as Error).message);
          }
        } })),
      );
    };

    const drawSteps = () => {
      clear(stepList);
      steps.forEach((s, i) => stepList.appendChild(h('li', { class: ['mt-plan-step', i === current && recording && 'is-current'], 'aria-current': i === current && recording ? 'step' : undefined, dataset: { step: s.id } },
        h('p', null, h('strong', { text: `${i + 1}. ` }), s.instruction),
        s.expected.length ? h('p', { class: 'muted small', text: `Expected: ${s.expected.join('; ')}` }) : null,
        s.lines.length ? h('pre', { class: 'q-pre', 'aria-label': `Recorded for step ${i + 1}`, text: s.lines.join('\n') }) : h('p', { class: 'muted small', text: recording && i === current ? 'Recording into this step…' : 'Nothing recorded (stays manual)' }))));
    };

    const show = async () => {
      if (!path) {
        clear(root).append(pageHeader('Automate a manual case', 'Open a case from Cases and choose Automate.'), button('Choose a case', { icon: 'list', onclick: () => navigate(link('manual', 'cases')) }));
        return;
      }
      clear(root).appendChild(loadingState());
      let c: CaseRead;
      let baseUrl = '';
      try {
        c = await api.get<CaseRead>(`/api/manual/case?path=${encodeURIComponent(path)}`);
        baseUrl = c.model.baseUrl && /^https?:/.test(c.model.baseUrl) ? c.model.baseUrl : c.baseUrl ?? '';
      } catch (e) {
        clear(root).appendChild(errorState(e, () => void show()));
        return;
      }
      // Manual steps only: automated steps of a hybrid case are kept as they are.
      steps = c.steps.filter((x) => x.manual).map((x) => ({ id: x.id, instruction: x.text, expected: x.expected, lines: [] }));
      const url = h('input', { class: 'input', id: uid('rec-url'), value: baseUrl, placeholder: 'http://localhost:3000/' });
      const exp = h('input', { class: 'input mono', id: uid('rec-expect'), placeholder: 'the page contains "Refunded"' });
      const controls = h('div', { class: 'row wrap', id: 'automate-rec-controls' });
      const drawControls = () => {
        const parts: Array<HTMLElement | null> = [
          !recording ? button('Start recording', { icon: 'record', kind: 'primary', small: true, id: 'automate-rec-start', onclick: async () => {
            try {
              await api.post('/api/record', { url: url.value, name: c.model.name });
              recording = true;
              current = 0;
              for (const s of steps) s.lines = [];
              drawSteps();
              drawControls();
              announce('Recording. Perform step 1 in the recorder window.');
            } catch (e) {
              toastError((e as Error).message);
            }
          } }) : null,
          recording ? button('Next step', { icon: 'chevronRight', small: true, id: 'automate-rec-next', disabled: current >= steps.length - 1, onclick: () => {
            current = Math.min(steps.length - 1, current + 1);
            drawSteps();
            drawControls();
            announce(`Recording into step ${current + 1}: ${steps[current].instruction}`);
          } }) : null,
          recording ? h('div', { class: 'field' }, h('label', { for: exp.id, text: 'Add an expectation to the last recorded step' }), h('div', { class: 'row' }, exp, button('Add', { small: true, onclick: async () => {
            if (!exp.value.trim()) return;
            try {
              await api.post('/api/record/expect', { text: exp.value });
              exp.value = '';
            } catch (e) {
              toastError((e as Error).message);
            }
          } }))) : null,
          recording ? button('Stop and convert', { icon: 'stop', small: true, kind: 'primary', id: 'automate-rec-stop', onclick: async () => {
            try {
              await api.post('/api/record/stop');
            } catch (e) {
              toastError((e as Error).message);
            }
            recording = false;
            drawSteps();
            drawControls();
            try {
              showResult(await api.post<Automation>('/api/manual/automate', { path, method: 'recording', recorded: steps.map((s) => ({ stepId: s.id, lines: s.lines })) }), 'recording');
            } catch (e) {
              toastError((e as Error).message);
            }
          } }) : null,
        ];
        clear(controls).append(...parts.filter((x): x is HTMLElement => !!x));
      };
      clear(root).append(
        pageHeader(`Automate: ${c.model.name}`, `${c.path} · ${plural(steps.length, 'step')}`, h('div', { class: 'row wrap' }, button('Back to the case', { small: true, icon: 'chevronLeft', onclick: () => navigate(link('manual', 'cases', ...c.path.split('/'))) }))),
        h('div', { class: 'q-grid2' },
          card('Through the grammar', h('div', { class: 'stack' },
            h('p', { class: 'small muted', text: 'Each instruction that reads as an EZ step becomes that step; expected results that read as conditions become Expect lines. The rest stays manual.' }),
            button('Convert with the grammar', { icon: 'convert', small: true, id: 'automate-grammar', onclick: async () => {
              try {
                showResult(await api.post<Automation>('/api/manual/automate', { path, method: 'grammar' }), 'grammar');
              } catch (e) {
                toastError((e as Error).message);
              }
            } }))),
          card('With the recorder', h('div', { class: 'stack' },
            h('p', { class: 'small muted', text: 'Perform each step in the recorder\'s browser; press Next step between steps. The recorded lines replace that manual step.' }),
            h('div', { class: 'field' }, h('label', { for: url.id, text: 'Start URL' }), url),
            controls, stepList))),
        card('Result', result, { id: 'automate-result-card' }),
      );
      drawSteps();
      drawControls();
    };

    onTopic('recorder', (m) => {
      if (!recording || m.type !== 'line' || typeof m.line !== 'string') return;
      const s = steps[current];
      if (!s) return;
      const line = String(m.line);
      s.lines.push(line.trim());
      drawSteps();
    });

    return {
      show(segments) {
        const p = segments.join('/');
        if (p !== path) {
          path = p || undefined;
          clear(result);
        }
        void show();
      },
    };
  },
};
