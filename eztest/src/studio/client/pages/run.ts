/**
 * Run: choose journeys and options, start a run, and follow it live as a
 * per-journey step timeline (status, duration, heals, errors), with
 * cancellation and the analysis summary at the end. `#/run/<runId>` follows a
 * specific run started in this session.
 */
import { api } from '../core/api.js';
import { announce, clear, h, uid } from '../core/dom.js';
import { follow } from '../core/events.js';
import { ms, pct, plural, splitList } from '../core/format.js';
import { registerCommand, registerPage } from '../core/registry.js';
import { link, navigate, type Route } from '../core/router.js';
import { activeRun, journeys, refreshJourneys, session } from '../core/state.js';
import { badge, button, card, emptyState, stat, statusIcon, tag } from '../ui/badge.js';
import { icon } from '../ui/icons.js';
import { neededVariables, variableField } from '../core/run-variables.js';
import { createSplit } from '../ui/split.js';
import { toast, toastError } from '../ui/toast.js';

interface StepView {
  id: string;
  intent: string;
  status: string;
  durationMs?: number;
  heal?: string;
  error?: string;
  /** Multi-actor journeys: who ran the step. */
  actor?: string;
}

interface JourneyView {
  id: string;
  name: string;
  status: string;
  steps: StepView[];
}

let followedId: string | undefined;
let stopFollow: (() => void) | undefined;

export async function cancelActiveRun(): Promise<void> {
  const cur = activeRun.get();
  if (!cur) {
    toast('No run in progress');
    return;
  }
  try {
    await api.del(`/api/runs/${encodeURIComponent(cur.id)}`);
    toast('Cancelling the run: it stops after the current step.', { timeout: 3000 });
  } catch (e) {
    toastError(`Could not cancel: ${(e as Error).message}`);
  }
}

export function registerRunPage(): void {
  registerPage({
    id: 'run',
    title: 'Run',
    icon: 'run',
    order: 30,
    shortcut: 'Alt+3',
    mount(ctx) {
      // ------------------------------------------------ form
      const jFilter = h('input', { type: 'search', class: 'input input-sm', placeholder: 'Filter journeys', 'aria-label': 'Filter journeys to run' });
      const checklist = h('div', { class: 'checklist', role: 'group', 'aria-label': 'Journeys to run' });
      const selCount = h('p', { class: 'help', role: 'status' });
      const ids = { tags: uid('run-tags'), browser: uid('run-browser'), workers: uid('run-workers'), retries: uid('run-retries') };
      const tagsIn = h('input', { id: ids.tags, class: 'input', placeholder: 'smoke, orders' });
      // The browsers come from the server (EZTest's supported browsers, /api/session): filled once the session is loaded.
      const browserSel = h('select', { id: ids.browser, class: 'input' }, h('option', { value: '', text: 'From config' }));
      const workersIn = h('input', { id: ids.workers, class: 'input', type: 'number', min: '1', max: '16', placeholder: 'config' });
      const retriesIn = h('input', { id: ids.retries, class: 'input', type: 'number', min: '0', max: '5', placeholder: 'config' });
      // Cross-browser run: ticking browsers runs every journey on each of them (journey x browser units).
      let browserBoxes: HTMLInputElement[] = [];
      const browserRow = h('div', { class: 'row wrap' });
      const headed = h('input', { type: 'checkbox', id: uid('headed') });
      const heal = h('input', { type: 'checkbox', id: uid('heal'), checked: true });
      const lensBoxes = ['a11y', 'security', 'visual'].map((l) => h('input', { type: 'checkbox', name: 'lens', value: l, id: uid(`lens-${l}`) }));
      const lensWarn = h('input', { type: 'checkbox', id: uid('lens-warn'), checked: true });
      const startBtn = button('Start run', { kind: 'primary', icon: 'run', id: 'btn-run' });
      const cancelBtn = button('Cancel run', { kind: 'danger', icon: 'stop', id: 'btn-cancel', disabled: true, onclick: () => void cancelActiveRun() });
      // Values the chosen journeys use as ${name} and the project does not set (a recorded password): asked per run, never saved.
      const varsFields = h('div', { class: 'grid2' });
      const varsBox = h(
        'fieldset',
        { class: 'fs', id: 'run-variables', hidden: true },
        h('legend', { text: 'Variables' }),
        h('p', { class: 'help', text: 'These journeys use values the project does not set. They are used for this run only and are not saved.' }),
        varsFields,
      );
      let varInputs: HTMLInputElement[] = [];
      let needsSeq = 0;
      const refreshNeeds = async () => {
        const seq = ++needsSeq;
        const needed = await neededVariables([...selected], splitList(tagsIn.value)).catch(() => []);
        if (seq !== needsSeq) return;
        const typed = new Map(varInputs.map((i) => [i.dataset.var!, i.value]));
        const fields = needed.map((v) => variableField(v, typed.get(v.name)));
        varInputs = fields.map((f) => f.input);
        clear(varsFields).append(...fields.map((f) => f.el));
        varsBox.hidden = !fields.length;
      };
      const check = (input: HTMLInputElement, label: string) => h('label', { class: 'check', for: input.id }, input, h('span', { text: label }));
      const form = h(
        'form',
        { class: 'run-form', 'aria-label': 'Run configuration', onsubmit: (e: Event) => (e.preventDefault(), void start()) },
        h(
          'fieldset',
          { class: 'fs' },
          h('legend', { text: 'Journeys' }),
          h('p', { class: 'help', text: 'Leave all unticked to run every journey (optionally filtered by tags).' }),
          h(
            'div',
            { class: 'row' },
            jFilter,
            button('All', { small: true, onclick: () => setAll(true), ariaLabel: 'Select all shown journeys' }),
            button('None', { small: true, onclick: () => setAll(false), ariaLabel: 'Select none' }),
          ),
          checklist,
          selCount,
        ),
        h(
          'div',
          { class: 'grid2' },
          h('div', { class: 'field' }, h('label', { for: ids.tags, text: 'Tags (comma separated)' }), tagsIn),
          h('div', { class: 'field' }, h('label', { for: ids.browser, text: 'Browser' }), browserSel),
          h('div', { class: 'field' }, h('label', { for: ids.workers, text: 'Workers' }), workersIn),
          h('div', { class: 'field' }, h('label', { for: ids.retries, text: 'Retries' }), retriesIn),
        ),
        h(
          'fieldset',
          { class: 'fs', id: 'run-browsers' },
          h('legend', { text: 'Cross-browser run' }),
          browserRow,
          h('p', { class: 'help', text: 'Tick two or more to run every journey on each browser; results, history and readiness are kept per browser. Overrides the Browser field.' }),
        ),
        varsBox,
        h('div', { class: 'row wrap' }, check(headed, 'Show the browser (headed)'), check(heal, 'Self-healing')),
        h(
          'fieldset',
          { class: 'fs' },
          h('legend', { text: 'Lenses (after every step)' }),
          h('div', { class: 'row wrap' }, check(lensBoxes[0], 'Accessibility'), check(lensBoxes[1], 'Security'), check(lensBoxes[2], 'Visual')),
          check(lensWarn, 'Report findings without failing'),
          h('p', { class: 'help', text: 'With no lens ticked, the lenses from the configuration are used.' }),
        ),
        h('div', { class: 'row form-actions' }, startBtn, cancelBtn),
      );
      startBtn.type = 'submit';
      session.subscribe((s) => {
        if (!s?.browsers) return;
        const keep = browserSel.value;
        clear(browserSel).append(h('option', { value: '', text: 'From config' }), ...s.browsers.engines.map((b) => h('option', { value: b, text: b })));
        browserSel.value = s.browsers.engines.includes(keep) ? keep : '';
        const ticked = new Set(browserBoxes.filter((b) => b.checked).map((b) => b.value));
        browserBoxes = s.browsers.targets.map((b) => h('input', { type: 'checkbox', name: 'run-browsers', value: b, id: uid(`browsers-${b}`), checked: ticked.has(b) }));
        clear(browserRow).append(...browserBoxes.map((b) => check(b, b.value)));
      });

      const selected = new Set<string>();
      const renderChecklist = () => {
        clear(checklist);
        const q = jFilter.value.trim().toLowerCase();
        const list = journeys.get().filter((j) => !j.error && j.id && (!q || [j.name, j.id, j.path, ...j.tags].some((x) => x?.toLowerCase().includes(q))));
        for (const j of list) {
          const id = uid('rj');
          const cb = h('input', {
            type: 'checkbox',
            id,
            name: 'run-journey',
            value: j.id!,
            checked: selected.has(j.id!),
            onchange: (e: Event) => {
              if ((e.target as HTMLInputElement).checked) selected.add(j.id!);
              else selected.delete(j.id!);
              updateCount();
            },
          });
          checklist.appendChild(
            h(
              'label',
              { class: 'check-row', for: id },
              cb,
              h('span', { class: 'check-text' }, h('span', { class: 'check-name', text: j.name ?? j.id! }), h('span', { class: 'check-meta' }, h('span', { class: 'muted', text: `(${j.id})` }), j.tags.slice(0, 3).map((t) => tag(t)))),
            ),
          );
        }
        if (!list.length) checklist.appendChild(h('p', { class: 'muted', text: journeys.get().length ? 'No journeys match the filter.' : 'No runnable journeys found.' }));
        updateCount();
      };
      const updateCount = () => {
        selCount.textContent = selected.size ? `${plural(selected.size, 'journey')} selected` : 'All journeys will run';
        void refreshNeeds();
      };
      tagsIn.addEventListener('change', () => void refreshNeeds());
      const setAll = (on: boolean) => {
        checklist.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
          cb.checked = on;
          if (on) selected.add(cb.value);
          else selected.delete(cb.value);
        });
        updateCount();
      };
      jFilter.addEventListener('input', renderChecklist);
      journeys.subscribe(renderChecklist);

      // ------------------------------------------------ live progress
      const heading = h('h1', { class: 'page-title', tabindex: '-1', text: 'Run journeys' });
      const status = h('p', { class: 'run-status', id: 'run-status', role: 'status', 'aria-live': 'polite', text: 'No run started yet.' });
      const progress = h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Run progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, h('div', { class: 'progress-bar' }));
      const counts = h('p', { class: 'run-counts' });
      const timeline = h('div', { class: 'run-timeline', id: 'run-steps' });
      const summary = h('div', { class: 'run-summary', id: 'run-summary' });
      const live = h('div', { class: 'run-live' }, h('header', { class: 'page-head' }, heading, status, progress, counts), timeline, summary);
      const split = createSplit({ direction: 'row', first: h('div', { class: 'run-config' }, h('h2', { class: 'pane-title', text: 'Configuration' }), form), second: live, size: 380, min: 300, max: 640, storageKey: 'run-config', label: 'Resize run configuration' });
      ctx.root.classList.add('page-run');
      ctx.root.appendChild(split.el);

      let jv: JourneyView[] = [];
      /** Why the followed run failed (the `run-error` event); kept when `done` arrives. */
      let runError: string | undefined;
      const byId = new Map<string, JourneyView>();
      let total = 0;
      let done = 0;

      const setProgress = () => {
        const p = total ? Math.round((done / total) * 100) : 0;
        progress.setAttribute('aria-valuenow', String(p));
        (progress.firstChild as HTMLElement).style.width = `${p}%`;
        const f = jv.reduce((n, j) => n + j.steps.filter((s) => s.status === 'failed').length, 0);
        const healed = jv.reduce((n, j) => n + j.steps.filter((s) => s.status === 'passed-healed').length, 0);
        counts.textContent = total ? `${done} of ${plural(total, 'step')} · ${healed} healed · ${f} failed` : '';
      };

      const renderTimeline = () => {
        clear(timeline);
        for (const j of jv) {
          const doneSteps = j.steps.filter((s) => !['pending', 'running'].includes(s.status)).length;
          timeline.appendChild(
            h(
              'section',
              { class: ['jt', `jt-${j.status}`], 'aria-label': `${j.name}: ${j.status}` },
              h('header', { class: 'jt-head' }, statusIcon(j.status), h('h3', { class: 'jt-name', text: j.name }), h('span', { class: 'muted', text: `${doneSteps}/${j.steps.length}` })),
              h(
                'ol',
                { class: 'jt-steps' },
                j.steps.map((s) =>
                  h(
                    'li',
                    { class: ['jt-step', `st-${s.status}`], dataset: { status: s.status, step: s.id } },
                    s.status === 'running' ? h('span', { class: 'spinner', role: 'img', 'aria-label': 'Running' }) : statusIcon(s.status === 'pending' ? 'queued' : s.status),
                    h('span', { class: 'jt-intent', text: s.intent }),
                    s.actor ? h('span', { class: 'tag jt-actor', title: 'actor', text: s.actor }) : null,
                    h('span', { class: 'jt-dur', text: ms(s.durationMs) }),
                    s.heal ? h('p', { class: 'jt-note heal-note' }, icon('heal', { size: 12 }), h('span', { text: s.heal })) : null,
                    s.error ? h('p', { class: 'jt-note error-note', text: s.error }) : null,
                  ),
                ),
              ),
            ),
          );
        }
      };

      const renderSummary = (r: Record<string, unknown>) => {
        clear(summary);
        const s = (r.summary ?? {}) as Record<string, number>;
        const readiness = r.readiness as { decision: string; score: number; rationale: string[] } | undefined;
        const perBrowser = r.browsers as Record<string, { total: number; passed: number; passedHealed: number; failed: number; errors: number; skipped: number; version?: string }> | undefined;
        const readyByBrowser = r.readinessByBrowser as Record<string, { decision: string; score: number }> | undefined;
        const triage = (r.triage as Array<{ journeyName?: string; journeyId: string; category: string; confidence: number; status: string; reasons: string[] }>) ?? [];
        summary.appendChild(
          card(
            'Summary',
            h(
              'div',
              null,
              h('div', { class: 'stats' }, stat(s.total ?? '-', 'Journeys'), stat(s.passed ?? '-', 'Passed', 'ok'), stat(s.passedHealed ?? '-', 'Healed', 'heal'), stat(s.failed ?? '-', 'Failed', 'bad'), stat(s.skipped ?? '-', 'Skipped'), stat(s.errors ?? '-', 'Errors', 'bad')),
              readiness
                ? h('div', { class: 'readiness', id: 'readiness' }, h('span', { text: 'Release readiness: ' }), badge(readiness.decision), h('span', { class: 'muted', text: ` score ${readiness.score}` }), readiness.rationale?.length ? h('ul', { class: 'bullets' }, readiness.rationale.slice(0, 6).map((t) => h('li', { text: t }))) : null)
                : h('p', { class: 'muted', text: r.cancelled ? 'The run was cancelled, so it was not analyzed.' : 'No readiness policy configured, so no release decision was made.' }),
              perBrowser
                ? h('div', { id: 'run-browser-summary' }, h('h3', { class: 'h3', text: 'Per browser' }), h('ul', { class: 'bullets' }, Object.entries(perBrowser).map(([b, x]) => h('li', null, h('strong', { text: b }), `${x.version ? ` ${x.version}` : ''}: ${x.passed + x.passedHealed}/${x.total} passed, ${x.failed + x.errors} failed`, readyByBrowser?.[b] ? h('span', null, ' · readiness ', badge(readyByBrowser[b].decision)) : null))))
                : null,
              triage.length ? h('div', null, h('h3', { class: 'h3', text: 'Triage' }), h('ul', { class: 'bullets' }, triage.map((v) => h('li', null, h('strong', { text: v.journeyName ?? v.journeyId }), `: ${v.category} (${pct(v.confidence)})${v.status === 'needs-human' ? ', needs human review' : ''}${v.reasons[0] ? ` – ${v.reasons[0]}` : ''}`)))) : null,
              ((r.warnings as string[]) ?? []).map((w) => h('p', { class: 'warn-text', text: `Warning: ${w}` })),
              h(
                'div',
                { class: 'row' },
                r.report ? h('a', { class: 'btn', href: String(r.report), target: '_blank', rel: 'noopener noreferrer' }, icon('external'), h('span', { text: 'Open the full HTML report' })) : null,
                button('View in Results', { icon: 'results', onclick: () => navigate(link('runs', String(r.runId))) }),
              ),
            ),
          ),
        );
      };

      const reset = () => {
        jv = [];
        runError = undefined;
        byId.clear();
        total = 0;
        done = 0;
        clear(timeline);
        clear(summary);
        status.removeAttribute('data-state');
        setProgress();
      };

      const step = (journeyId: string, stepId: string): StepView | undefined => byId.get(journeyId)?.steps.find((s) => s.id === stepId);

      const onEvent = (e: { type: string; [k: string]: unknown }) => {
        const id = followedId;
        switch (e.type) {
          case 'queued': {
            reset();
            jv = (e.journeys as Array<{ id: string; name: string; steps: Array<{ id: string; intent: string }> }>).map((j) => ({
              id: j.id,
              name: j.name,
              status: 'queued',
              steps: j.steps.map((s) => ({ id: s.id, intent: s.intent, status: 'pending' })),
            }));
            jv.forEach((j) => byId.set(j.id, j));
            total = jv.reduce((n, j) => n + j.steps.length, 0);
            status.textContent = `Run ${id} queued (${plural(jv.length, 'journey')})`;
            break;
          }
          case 'run:start':
            status.textContent = `Running ${id}…`;
            announce('Run in progress');
            break;
          case 'journey:start': {
            const j = byId.get(String(e.journeyId));
            if (j) j.status = 'running';
            status.textContent = `Running: ${String(e.name)}`;
            break;
          }
          case 'step:start': {
            const s = step(String(e.journeyId), String(e.stepId));
            if (s) {
              s.status = 'running';
              if (typeof e.actor === 'string') s.actor = e.actor;
            }
            break;
          }
          case 'step:end': {
            const s = step(String(e.journeyId), String(e.stepId));
            if (s) {
              s.status = String(e.status);
              s.durationMs = Number(e.durationMs);
              done++;
            }
            break;
          }
          case 'heal': {
            const s = step(String(e.journeyId), String(e.stepId));
            if (s) s.heal = `Healed via ${String(e.tier)}${e.verified ? ' (verified)' : ' (not verified)'}`;
            break;
          }
          case 'journey:end': {
            const j = byId.get(String(e.journeyId));
            if (j) {
              j.status = String(e.status);
              for (const s of j.steps) if (s.status === 'pending' || s.status === 'running') s.status = 'skipped';
            }
            break;
          }
          case 'cancelling':
            status.textContent = 'Cancelling: the run stops after the current step…';
            break;
          case 'run:summary':
            status.textContent = 'Run finished, analyzing results…';
            break;
          case 'cancelled':
            for (const j of jv) {
              if (j.status === 'queued' || j.status === 'running') j.status = 'cancelled';
              for (const s of j.steps) if (s.status === 'pending' || s.status === 'running') s.status = 'skipped';
            }
            renderSummary({ ...e, cancelled: true });
            break;
          case 'analysis':
            renderSummary(e);
            break;
          case 'run-error':
            runError = String(e.message);
            status.textContent = `Run failed: ${runError}`;
            break;
          case 'done': {
            const state = String(e.state);
            const reason = runError ?? (typeof e.error === 'string' ? e.error : undefined);
            status.setAttribute('data-state', state === 'done' ? 'complete' : state);
            status.textContent = state === 'done' ? `Run ${id} complete.` : state === 'cancelled' ? `Run ${id} cancelled.` : `Run ${id} failed: ${reason ?? 'unknown error'}`;
            if (state === 'error') {
              clear(summary);
              summary.appendChild(card('Run failed', h('div', null, h('p', { class: 'bad-text', id: 'run-error', text: reason ?? 'The run ended with an error.' }), h('div', { class: 'row' }, button('View in Results', { icon: 'results', onclick: () => navigate(link('runs', String(id))) })))));
            }
            announce(status.textContent);
            setButtons(false);
            break;
          }
        }
        renderTimeline();
        setProgress();
      };

      const setButtons = (running: boolean) => {
        startBtn.disabled = running;
        cancelBtn.disabled = !running;
      };

      const followRun = (id: string) => {
        if (followedId === id && stopFollow) return;
        stopFollow?.();
        followedId = id;
        reset();
        setButtons(true);
        status.textContent = `Connecting to run ${id}…`;
        stopFollow = follow(`/api/runs/${encodeURIComponent(id)}/events`, onEvent, (e) => e.type === 'done');
      };

      const start = async () => {
        const warn = lensWarn.checked;
        const lenses = lensBoxes.filter((b) => b.checked).map((b) => b.value + (warn ? ':warn' : ''));
        const body: Record<string, unknown> = { journeys: [...selected], tags: splitList(tagsIn.value), headed: headed.checked, heal: heal.checked };
        if (browserSel.value) body.browser = browserSel.value;
        const matrix = browserBoxes.filter((b) => b.checked).map((b) => b.value);
        if (matrix.length) body.browsers = matrix;
        if (workersIn.value) body.workers = Number(workersIn.value);
        if (retriesIn.value) body.retries = Number(retriesIn.value);
        if (lenses.length) body.lenses = lenses;
        const missing = varInputs.filter((i) => !i.value);
        if (missing.length) {
          status.textContent = `Enter a value for ${missing.map((i) => i.dataset.var).join(', ')} under Variables.`;
          missing[0].focus();
          return;
        }
        if (varInputs.length) body.variables = Object.fromEntries(varInputs.map((i) => [i.dataset.var!, i.value]));
        reset();
        status.textContent = 'Starting…';
        try {
          const r = await api.post<{ id: string }>('/api/runs', body);
          followRun(r.id);
          navigate(link('run', r.id), { replace: true });
        } catch (e) {
          status.textContent = `Could not start: ${(e as Error).message}`;
          toastError(`Could not start the run: ${(e as Error).message}`);
        }
      };

      activeRun.subscribe((r) => {
        if (!r) return;
        if (r.id !== followedId && !ctx.root.hidden) followRun(r.id);
        setButtons(true);
      });

      const empty = emptyState('Ready when you are', 'Choose journeys on the left and start a run. Progress streams here step by step.');
      timeline.appendChild(empty);

      return {
        show(r: Route) {
          void refreshJourneys().catch(() => undefined);
          const id = r.segments[0];
          if (id) followRun(id);
          else {
            const cur = activeRun.get();
            if (cur) followRun(cur.id);
          }
        },
        focus: () => heading.focus(),
      };
    },
  });
  registerCommand({ id: 'run.cancel', title: 'Cancel the run in progress', group: 'Run', icon: 'stop', when: () => !!activeRun.get(), run: () => cancelActiveRun() });
  registerCommand({ id: 'run.all', title: 'Run all journeys', group: 'Run', icon: 'run', when: () => !activeRun.get(), run: async () => {
    try {
      const r = await api.post<{ id: string }>('/api/runs', {});
      navigate(link('run', r.id));
    } catch (e) {
      toastError((e as Error).message);
    }
  } });
  registerCommand({ id: 'run.open', title: 'Show live run progress', group: 'Run', icon: 'activity', run: () => navigate(link('run')) });
}
