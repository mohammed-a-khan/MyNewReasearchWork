/**
 * Test management › Run (#/manual/run/<runId>): the guided runner. The step
 * waiting for a verdict is shown with its instruction, expected results,
 * reference files, the automated checks that follow and (hybrid journeys) a
 * screenshot of the page where the automation paused. The tester marks it
 * passed / failed / blocked / skipped with notes, what they observed and
 * screenshots (uploaded or pasted); the run continues. Every verdict lands
 * in the run's evidence vault, like automated results.
 */
import { api, runAsset } from '../../core/api.js';
import { announce, clear, h, uid } from '../../core/dom.js';
import { onTopic } from '../../core/events.js';
import { plural, relTime } from '../../core/format.js';
import { link, navigate } from '../../core/router.js';
import { badge, button, card, statusIcon } from '../../ui/badge.js';
import { icon } from '../../ui/icons.js';
import { toast, toastError } from '../../ui/toast.js';
import { errorState, loadingState, pageHeader, type SubPageDef } from '../assurance-ui.js';
import { confirmEnd } from './cases.js';
import { fileToBase64, kindChip, tester, testerField } from './common.js';

interface Pending {
  key: string;
  since: string;
  runId: string;
  journeyId: string;
  journeyName: string;
  stepId: string;
  index: number;
  total: number;
  instruction: string;
  expected: string[];
  attachments: string[];
  checks: string[];
  hybrid: boolean;
  url?: string;
  title?: string;
  screenshot?: { evidenceId: string; path: string };
  assignee?: string;
  preconditions?: string;
}

interface Session {
  runId: string;
  state: string;
  request?: { tester?: string; cycle?: string };
  plan: Array<{ id: string; name: string; type: string; assignee?: string; preconditions?: string; steps: Array<{ id: string; intent: string; manual: boolean; instruction?: string; expected?: string[]; depth: number }> }>;
  status: Record<string, Record<string, string>>;
  verdicts: Record<string, Record<string, { verdict: string; tester?: string; notes?: string }>>;
  pending: Pending[];
  summary?: { total: number; passed: number; passedHealed: number; failed: number; skipped: number; errors: number };
  journeys?: Array<{ journeyId: string; status: string; manual?: { executed: number; pending: number; testers: string[] }; error?: { message: string } }>;
  report?: string;
}

interface Picked {
  name: string;
  type: string;
  data: string;
  url: string;
}

const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain';

export const runSection: SubPageDef = {
  id: 'run',
  title: 'Run',
  icon: 'run',
  description: 'Guided runner: verdicts step by step',
  mount(root) {
    let runId: string | undefined;
    let session: Session | undefined;
    let shownKey: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const picked: Picked[] = [];

    const verdictForm = (p: Pending): HTMLElement => {
      const name = uid('verdict');
      const statuses: Array<[string, string, string]> = [['passed', 'Pass', 'check'], ['failed', 'Fail', 'x'], ['blocked', 'Blocked', 'stop'], ['skipped', 'Skip', 'skip']];
      const err = h('p', { class: 'field-error', role: 'alert', id: 'verdict-error' });
      const notes = h('textarea', { class: 'input', id: 'verdict-notes', rows: 3, placeholder: 'What went wrong, or anything worth recording' });
      const actual = h('textarea', { class: 'input', id: 'verdict-actual', rows: 2, placeholder: 'What you saw' });
      const thumbs = h('ul', { class: 'mt-thumbs', id: 'verdict-attachments', 'aria-label': 'Attached files' });
      const drawThumbs = () => {
        clear(thumbs);
        picked.forEach((f, i) => thumbs.appendChild(h('li', null,
          f.type.startsWith('image/') ? h('img', { src: f.url, alt: `Attached screenshot ${f.name}` }) : h('span', { class: 'chip', text: f.name }),
          button('Remove', { small: true, kind: 'ghost', ariaLabel: `Remove ${f.name}`, onclick: () => (URL.revokeObjectURL(f.url), picked.splice(i, 1), drawThumbs()) }))));
      };
      const add = async (files: Iterable<File>) => {
        for (const f of files) {
          if (!ACCEPT.split(',').includes(f.type)) {
            toastError(`${f.name || 'pasted file'}: only images, PDF and text can be attached`);
            continue;
          }
          if (f.size > 4 * 1024 * 1024) {
            toastError(`${f.name}: larger than 4 MB`);
            continue;
          }
          picked.push({ name: f.name || `pasted-${picked.length + 1}.png`, type: f.type, data: await fileToBase64(f), url: URL.createObjectURL(f) });
        }
        drawThumbs();
        announce(`${plural(picked.length, 'file')} attached`);
      };
      const fileInput = h('input', { type: 'file', id: 'verdict-files', multiple: true, accept: ACCEPT, onchange: (e: Event) => {
        const t = e.target as HTMLInputElement;
        void add(t.files ?? []).then(() => (t.value = ''));
      } });
      // Pasted images come as clipboard files, or only as file items (some browsers); dropped files work too.
      const filesOf = (d: DataTransfer | null): File[] => {
        if (!d) return [];
        const files = [...d.files];
        if (files.length) return files;
        return [...d.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f);
      };
      const label = 'Paste or drop a screenshot here (focus, then Ctrl+V or Cmd+V)';
      const paste = h('div', {
        class: 'mt-paste', tabindex: '0', role: 'button', id: 'verdict-paste', 'aria-label': label,
        onpaste: (e: ClipboardEvent) => {
          const files = filesOf(e.clipboardData);
          if (files.length) {
            e.preventDefault();
            void add(files);
          }
        },
        ondragover: (e: DragEvent) => e.preventDefault(),
        ondrop: (e: DragEvent) => {
          const files = filesOf(e.dataTransfer);
          if (files.length) {
            e.preventDefault();
            void add(files);
          }
        },
      }, icon('image', { size: 16 }), h('span', { text: ` ${label}` }));
      const submit = async () => {
        err.textContent = '';
        const checked = root.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
        if (!checked) {
          err.textContent = 'Choose a verdict.';
          root.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.focus();
          return;
        }
        const who = tester.get().trim();
        if (!who) {
          err.textContent = 'Enter your name as the tester.';
          root.querySelector<HTMLInputElement>('.mt-runner input[autocomplete="name"]')?.focus();
          return;
        }
        try {
          await api.post('/api/manual/verdict', { key: p.key, status: checked.value, tester: who, notes: notes.value, actual: actual.value, attachments: picked.map((f) => ({ name: f.name, contentType: f.type, data: f.data })) });
          for (const f of picked.splice(0)) URL.revokeObjectURL(f.url);
          toast(`Step ${p.index} of ${p.journeyName}: ${checked.value}`, { kind: checked.value === 'passed' ? 'success' : 'info' });
          shownKey = undefined;
          void load();
        } catch (e) {
          err.textContent = (e as Error).message;
        }
      };
      return h('form', { class: 'stack', id: 'verdict-form', onsubmit: (e: Event) => (e.preventDefault(), void submit()) },
        h('fieldset', { class: 'mt-verdicts' }, h('legend', { text: 'Verdict' }),
          statuses.map(([v, label, ic]) => {
            const id = `verdict-${v}`;
            return h('label', { class: `mt-verdict mt-${v}`, for: id }, h('input', { type: 'radio', name, id, value: v }), icon(ic as never, { size: 14 }), h('span', { text: label }));
          })),
        h('div', { class: 'field' }, h('label', { for: actual.id, text: 'What you observed' }), actual),
        h('div', { class: 'field' }, h('label', { for: notes.id, text: 'Notes' }), notes),
        h('div', { class: 'field' }, h('label', { for: fileInput.id, text: 'Screenshots and files' }), fileInput, paste, thumbs),
        err,
        h('div', { class: 'row wrap' }, h('button', { type: 'submit', class: 'btn btn-primary', id: 'verdict-submit' }, icon('check', { size: 14 }), h('span', { text: 'Record verdict' }))),
      );
    };

    const pendingCard = (p: Pending): HTMLElement =>
      card(
        `${p.journeyName}: step ${p.index} of ${p.total}`,
        h('div', { class: 'stack', id: 'manual-current', dataset: { step: p.stepId, journey: p.journeyId } },
          p.preconditions && p.index === 1 ? h('p', { class: 'q-callout' }, icon('info', { size: 14 }), h('span', null, h('strong', { text: 'Preconditions: ' }), p.preconditions)) : null,
          h('p', { class: 'mt-instruction', id: 'manual-instruction', text: p.instruction }),
          p.expected.length ? h('div', null, h('p', { class: 'q-label', text: 'Expected' }), h('ul', { class: 'bullets', id: 'manual-expected' }, p.expected.map((e) => h('li', { text: e })))) : null,
          p.attachments.length ? h('div', null, h('p', { class: 'q-label', text: 'References' }), h('ul', { class: 'bullets small' }, p.attachments.map((a) => h('li', null, h('a', { href: `/api/manual/reference?path=${encodeURIComponent(a)}`, target: '_blank', rel: 'noopener noreferrer', text: a }))))) : null,
          p.checks.length ? h('div', null, h('p', { class: 'q-label', text: 'Checked automatically after your verdict' }), h('ul', { class: 'bullets small' }, p.checks.map((c) => h('li', { text: c })))) : null,
          p.hybrid ? h('div', { class: 'mt-pause' },
            h('p', { class: 'small' }, kindChip('hybrid'), ` The automation paused on ${p.title ? `"${p.title}" ` : ''}`, p.url ? h('code', { text: p.url }) : null, '. Carry out the step, then give the verdict; the journey continues with the next automated step.'),
            p.screenshot ? h('img', { class: 'mt-shot', src: runAsset(p.runId, p.screenshot.path), alt: `The page where the automation paused before "${p.instruction}"`, id: 'manual-pause-shot' }) : null) : null,
          verdictForm(p),
        ),
        { id: 'manual-step-card' },
      );

    const planList = (s: Session): HTMLElement =>
      h('ol', { class: 'mt-plan', id: 'manual-plan', 'aria-label': 'Steps of this run' },
        s.plan.map((j) => h('li', null,
          h('p', { class: 'mt-plan-j' }, kindChip(j.type), ' ', h('strong', { text: j.name })),
          h('ol', { class: 'mt-plan-steps' }, j.steps.filter((x) => x.depth === 0 || x.manual).map((st) => {
            const status = s.status[j.id]?.[st.id];
            const v = s.verdicts[j.id]?.[st.id];
            const waiting = s.pending.some((p) => p.journeyId === j.id && p.stepId === st.id);
            const label = waiting ? 'waiting' : v?.verdict ?? status ?? 'queued';
            return h('li', { class: ['mt-plan-step', waiting && 'is-current', st.manual && 'is-manual'], dataset: { step: st.id, status: label }, 'aria-current': waiting ? 'step' : undefined },
              statusIcon(waiting ? 'running' : label === 'pending' ? 'skipped' : label),
              h('span', { text: ` ${st.manual ? st.instruction ?? st.intent : st.intent}` }),
              v?.tester ? h('span', { class: 'muted small', text: ` · ${v.tester}` }) : null);
          })))));

    const render = () => {
      const s = session;
      if (!s) return;
      // The run was started for a tester: use that name when this browser has none yet.
      if (!tester.get() && s.request?.tester) tester.set(s.request.tester);
      const p = s.pending[0];
      const finished = !['running', 'cancelling', 'analyzing'].includes(s.state);
      const verdictCount = Object.values(s.verdicts).reduce((n, m) => n + Object.values(m).filter((v) => v.verdict !== 'pending').length, 0);
      if (p && shownKey === p.key) return; // keep the tester's half-filled form
      shownKey = p?.key;
      clear(root).append(
        pageHeader('Guided run', `${s.runId} · ${plural(verdictCount, 'verdict')} so far`,
          h('div', { class: 'row wrap' }, badge(s.state), !finished ? button('End run', { small: true, kind: 'danger', icon: 'stop', id: 'manual-end', onclick: async () => {
            if (!(await confirmEnd())) return;
            await api.post('/api/manual/end', { runId: s.runId }).catch((e: Error) => toastError(e.message));
            void load();
          } }) : null)),
        h('div', { class: 'mt-runner' },
          h('aside', { class: 'mt-side' }, testerField([], 'Tester'), planList(s)),
          h('div', { class: 'mt-main stack' },
            p ? pendingCard(p)
              : finished
                ? card('Run finished', h('div', { class: 'stack', id: 'manual-finished' },
                    s.summary ? h('p', { text: `${s.summary.total} journeys: ${s.summary.passed} passed, ${s.summary.failed} failed, ${s.summary.skipped} not executed or skipped.` }) : null,
                    h('ul', { class: 'bullets small' }, (s.journeys ?? []).map((j) => h('li', null, badge(j.status), ` ${j.journeyId}`, j.manual ? ` · ${j.manual.executed} verdict(s)${j.manual.pending ? `, ${j.manual.pending} not executed` : ''}` : '', j.error ? h('span', { class: 'muted', text: ` · ${j.error.message}` }) : null))),
                    h('div', { class: 'row wrap' },
                      h('a', { class: 'btn btn-sm', href: link('runs', s.runId), text: 'Run details and evidence' }),
                      h('a', { class: 'btn btn-sm', href: link('quality', 'readiness', s.runId), text: 'Readiness' }),
                      h('a', { class: 'btn btn-sm', href: link('quality', 'traceability'), text: 'Traceability' }),
                      s.request?.cycle ? h('a', { class: 'btn btn-sm', href: link('manual', 'dashboard'), text: 'Cycle progress' }) : null),
                  ), { id: 'manual-done' })
                : card('Running', h('p', { class: 'muted', role: 'status', id: 'manual-waiting', text: 'Automated steps are running; the next manual step appears here.' })),
          ),
        ),
      );
      if (p) {
        announce(`Manual step ${p.index} of ${p.total}: ${p.instruction}`);
        root.querySelector<HTMLElement>('#manual-instruction')?.setAttribute('tabindex', '-1');
      }
    };

    const load = async () => {
      if (!runId) return;
      clearTimeout(timer);
      try {
        session = await api.get<Session>(`/api/manual/session/${encodeURIComponent(runId)}`);
        render();
        if (['running', 'cancelling', 'analyzing'].includes(session.state)) timer = setTimeout(() => void load(), session.pending.length ? 5000 : 1500);
      } catch (e) {
        clear(root).appendChild(errorState(e, () => void load()));
      }
    };

    const recent = async () => {
      clear(root).appendChild(loadingState());
      const d = await api.get<{ pending: Array<{ request: Pending; since: string }> }>('/api/manual/pending').catch(() => ({ pending: [] }));
      const runs = [...new Set(d.pending.map((p) => p.request.runId))];
      clear(root).append(
        pageHeader('Guided run', 'Start a run from Cases, Cycles or the Dashboard. Runs waiting for a tester are listed here.'),
        runs.length
          ? h('ul', { class: 'bullets', id: 'manual-waiting-runs' }, runs.map((r) => h('li', null, h('a', { href: link('manual', 'run', r), text: r }), h('span', { class: 'muted small', text: ` · waiting since ${relTime(d.pending.find((p) => p.request.runId === r)!.since)}` }))))
          : h('p', { class: 'muted', text: 'No run is waiting for a verdict.' }),
        button('Choose cases to run', { icon: 'list', onclick: () => navigate(link('manual', 'cases')) }),
      );
    };

    onTopic('manual', (m) => {
      if (runId && (m.runId === runId || m.type === 'ended')) void load();
    });
    onTopic('run', (m) => {
      if (runId && m.runId === runId && (m.type === 'done' || m.type === 'step:end' || m.type === 'analysis')) void load();
    });
    return {
      show(segments) {
        const id = segments[0];
        if (!id) {
          runId = undefined;
          void recent();
          return;
        }
        if (id !== runId) {
          runId = id;
          session = undefined;
          shownKey = undefined;
          clear(root).appendChild(loadingState('Opening the run…'));
        }
        void load();
      },
      hide() {
        clearTimeout(timer);
      },
    };
  },
};
