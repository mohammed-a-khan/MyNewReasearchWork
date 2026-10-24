/** Record: drive the app in a browser window; every action becomes a plain-English step, then save it as a journey. */
import { api } from '../core/api.js';
import { clear, h, uid } from '../core/dom.js';
import { follow } from '../core/events.js';
import { plural, splitList } from '../core/format.js';
import { registerPage } from '../core/registry.js';
import { link, navigate } from '../core/router.js';
import { refreshJourneys, session } from '../core/state.js';
import { button, card } from '../ui/badge.js';
import { toast, toastError } from '../ui/toast.js';

interface RecordResult {
  ez: string;
  yaml: string;
  steps: number;
  warnings: string[];
  variables: string[];
  suggestedPath: string;
}

export function registerRecordPage(): void {
  registerPage({
    id: 'record',
    title: 'Record',
    icon: 'record',
    order: 60,
    shortcut: 'Alt+6',
    mount(ctx) {
      const ids = { url: uid('rec-url'), name: uid('rec-name'), tags: uid('rec-tags'), expect: uid('rec-expect'), ez: uid('rec-ez'), path: uid('rec-path') };
      const heading = h('h1', { class: 'page-title', tabindex: '-1', text: 'Record a journey' });
      const url = h('input', { id: ids.url, class: 'input', type: 'url', required: true, placeholder: 'http://localhost:3000/login' });
      const name = h('input', { id: ids.name, class: 'input', placeholder: 'Sign in and create an order' });
      const tags = h('input', { id: ids.tags, class: 'input', placeholder: 'recorded, smoke' });
      const startBtn = button('Start recording', { kind: 'primary', icon: 'record' });
      startBtn.type = 'submit';
      const stopBtn = button('Stop recording', { icon: 'stop', disabled: true, onclick: () => void stop() });
      const status = h('p', { class: 'run-status', role: 'status', 'aria-live': 'polite', text: 'Not recording.' });
      const lines = h('ol', { class: 'code-list', 'aria-label': 'Recorded steps' });
      const expectIn = h('input', { id: ids.expect, class: 'input mono', placeholder: 'the page contains "Saved"' });
      const expectForm = h(
        'form',
        { class: 'row', hidden: true, onsubmit: (e: Event) => (e.preventDefault(), void addExpect()) },
        h('div', { class: 'field grow' }, h('label', { for: ids.expect, text: 'Add an expectation to the last step' }), expectIn),
        h('button', { type: 'submit', class: 'btn', text: 'Add' }),
      );
      const ez = h('textarea', { id: ids.ez, class: 'input mono', rows: 14, spellcheck: 'false', wrap: 'off' });
      const pathIn = h('input', { id: ids.path, class: 'input mono' });
      const warnings = h('ul', { class: 'bullets warn-text' });
      const saveStatus = h('p', { class: 'muted', role: 'status', 'aria-live': 'polite' });
      const result = card(
        'Save the recording',
        h(
          'div',
          { class: 'stack' },
          h('div', { class: 'field' }, h('label', { for: ids.ez, text: 'Journey (you can edit it before saving)' }), ez),
          warnings,
          h('div', { class: 'row' }, h('div', { class: 'field grow' }, h('label', { for: ids.path, text: 'Save as (path in the project)' }), pathIn), button('Save journey', { kind: 'primary', icon: 'save', onclick: () => void save() })),
          saveStatus,
        ),
        { id: 'rec-result' },
      );
      result.hidden = true;
      const form = h(
        'form',
        { class: 'stack', onsubmit: (e: Event) => (e.preventDefault(), void start()) },
        h('p', { class: 'help', text: 'A browser window opens on your computer. Use the app as a user would; every action becomes a plain-English step. Alt+Click an element to assert its text.' }),
        h(
          'div',
          { class: 'grid3' },
          h('div', { class: 'field' }, h('label', { for: ids.url, text: 'Start URL' }), url),
          h('div', { class: 'field' }, h('label', { for: ids.name, text: 'Journey name' }), name),
          h('div', { class: 'field' }, h('label', { for: ids.tags, text: 'Tags' }), tags),
        ),
        h('div', { class: 'row' }, startBtn, stopBtn),
      );
      ctx.root.classList.add('page-scroll');
      ctx.root.append(
        h(
          'div',
          { class: 'page-inner narrow' },
          h('header', { class: 'page-head' }, heading),
          card('Recorder', form, { id: 'rec-form' }),
          card('Recorded steps', h('div', null, status, lines, expectForm), { id: 'rec-live' }),
          result,
        ),
      );

      let stopFollow: (() => void) | undefined;
      const setRecording = (on: boolean) => {
        startBtn.disabled = on;
        stopBtn.disabled = !on;
        expectForm.hidden = !on;
      };
      const showResult = (r: RecordResult) => {
        setRecording(false);
        status.textContent = `Recording stopped: ${plural(r.steps, 'step')}.`;
        result.hidden = false;
        ez.value = r.ez || r.yaml;
        pathIn.value = `${session.get()?.journeysDir ?? 'journeys'}/${r.suggestedPath}`;
        clear(warnings);
        for (const w of r.warnings ?? []) warnings.appendChild(h('li', { text: w }));
        if (r.variables?.length) warnings.appendChild(h('li', { text: `Supply at run time (values are never recorded): ${r.variables.join(', ')}` }));
      };
      const followRecording = () => {
        stopFollow?.();
        clear(lines);
        stopFollow = follow(
          '/api/record/events',
          (e) => {
            if (e.type === 'started') status.textContent = `Recording ${String(e.url)}. Use the browser window, then press Stop recording.`;
            else if (e.type === 'line') lines.appendChild(h('li', { text: String(e.line) }));
            else if (e.type === 'stopped') showResult(e as unknown as RecordResult);
          },
          (e) => e.type === 'stopped',
        );
      };
      const start = async () => {
        result.hidden = true;
        status.textContent = 'Starting the browser…';
        try {
          await api.post('/api/record', { url: url.value.trim(), name: name.value.trim() || undefined, tags: splitList(tags.value) });
          setRecording(true);
          followRecording();
        } catch (e) {
          status.textContent = `Could not start recording: ${(e as Error).message}`;
        }
      };
      const stop = async () => {
        status.textContent = 'Stopping…';
        try {
          const r = await api.post<{ result?: RecordResult }>('/api/record/stop', {});
          if (r.result) showResult(r.result);
        } catch (e) {
          status.textContent = `Could not stop: ${(e as Error).message}`;
        }
      };
      const addExpect = async () => {
        try {
          await api.post('/api/record/expect', { text: expectIn.value });
          expectIn.value = '';
        } catch (e) {
          toastError((e as Error).message);
        }
      };
      const save = async () => {
        const p = pathIn.value.trim();
        try {
          const r = await api.put<{ saved: string; validation: { ok: boolean } }>('/api/file', { path: p, content: ez.value, create: true });
          saveStatus.textContent = `Saved ${r.saved}${r.validation.ok ? '' : ' (it has validation problems; open it in Journeys)'}`;
          void refreshJourneys();
          toast(`Saved ${r.saved}`, { kind: 'success', action: { label: 'Open', run: () => navigate(link('journeys', r.saved)) } });
        } catch (e) {
          saveStatus.textContent = `Not saved: ${(e as Error).message}`;
        }
      };
      return {
        async show() {
          try {
            const r = await api.get<{ state: string; result?: RecordResult }>('/api/record');
            if (r.state === 'recording') {
              setRecording(true);
              if (!stopFollow) followRecording();
            }
          } catch {
            // ignore
          }
        },
        focus: () => heading.focus(),
      };
    },
  });
}
