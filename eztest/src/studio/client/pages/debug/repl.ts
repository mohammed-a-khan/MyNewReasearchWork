/**
 * Bottom of the debugger: the step console (type any `.ez` line, run it
 * against the live page while paused, see the result, add it to the journey)
 * and edit-and-continue (when paused on a failure or before a step: edit the
 * step with live validation, then retry with it, skip it, or apply it to the
 * journey file keeping the step id).
 */
import { api } from '../../core/api.js';
import { add, announce, clear, h, uid } from '../../core/dom.js';
import { ms } from '../../core/format.js';
import { badge } from '../../ui/badge.js';
import { createMiniEditor, kitIcon, type MiniEditor } from './kit.js';
import { command, dbg, isPaused, type StepResultLite } from './state.js';

export interface ReplContext {
  /** Insert a step line into the journey at the cursor. */
  insertStep(text: string): void;
}

export function createStepConsole(ctx: ReplContext): { el: HTMLElement; focus(): void; run(text: string): Promise<void> } {
  const history: string[] = [];
  const log = h('div', { class: 'repl-log', id: 'repl-log', role: 'log', 'aria-label': 'Step console results', 'aria-live': 'polite' });
  const hint = h('span', { class: 'repl-hint muted small' });
  let editor: MiniEditor;
  const runBtn = h('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: () => void run(editor.get()) }, kitIcon('play', { size: 12 }), h('span', { text: 'Run' }));
  editor = createMiniEditor({
    label: 'Step console: type an .ez step and press Enter to run it against the live page',
    placeholder: 'Verify the page contains "Welcome"   (Enter runs, ↑ history)',
    onSubmit: (t) => void run(t),
    history: () => history,
    class: 'repl-input',
  });
  const el = h(
    'section',
    { class: 'repl', 'aria-label': 'Step console' },
    log,
    h('div', { class: 'repl-row' }, h('span', { class: 'repl-prompt', 'aria-hidden': 'true', text: '›' }), editor.el, runBtn),
    h('div', { class: 'repl-foot' }, hint),
  );

  const setEnabled = () => {
    const on = isPaused();
    editor.setEnabled(on);
    runBtn.disabled = !on;
    hint.textContent = on ? 'Runs against the live page; nothing is added to the journey unless you click "Add to journey".' : 'Pause the debugger to run steps against the live page.';
  };
  dbg.select((d) => d.phase).subscribe(setEnabled);

  async function run(text: string): Promise<void> {
    const line = text.trim();
    if (!line) return;
    if (!isPaused()) {
      setEnabled();
      return;
    }
    if (history[history.length - 1] !== line) history.push(line);
    editor.set('');
    const row = h('div', { class: 'repl-entry running' }, h('code', { class: 'repl-cmd', text: line }), h('span', { class: 'spinner', role: 'img', 'aria-label': 'running' }));
    log.appendChild(row);
    row.scrollIntoView({ block: 'nearest' });
    try {
      const r = await api.post<{ result: StepResultLite }>('/api/debug/evaluate', { step: line });
      const res = r.result;
      add(
        clear(row),
        h('div', { class: 'repl-line' }, badge(res.status), h('code', { class: 'repl-cmd', text: line }), h('span', { class: 'muted small', text: ms(res.durationMs) }), h('button', { type: 'button', class: 'btn btn-sm', onclick: () => ctx.insertStep(line) }, kitIcon('insert', { size: 12 }), h('span', { text: 'Add to journey' }))),
        res.error ? h('p', { class: 'error-note', text: res.error.message }) : null,
        res.usedLocator ? h('p', { class: 'muted small' }, 'Resolved: ', h('code', { text: `${res.usedLocator.strategy}=${res.usedLocator.value}${res.usedLocator.name ? ` [name="${res.usedLocator.name}"]` : ''}` })) : null,
        res.conditions?.length ? h('ul', { class: 'bullets small' }, res.conditions.map((c) => h('li', { class: c.passed ? 'ok-text' : 'bad-text', text: `${c.passed ? '✔' : '✖'} ${c.condition.type}${c.actual !== undefined ? ` (actual: ${c.actual})` : ''}${c.message && !c.passed ? `: ${c.message}` : ''}` }))) : null,
      );
      row.className = `repl-entry st-${res.status}`;
      announce(`Step console: ${res.status}`);
    } catch (e) {
      clear(row).append(h('div', { class: 'repl-line' }, badge('error', 'Error'), h('code', { class: 'repl-cmd', text: line })), h('p', { class: 'error-note', text: (e as Error).message }));
      row.className = 'repl-entry st-error';
    }
    row.scrollIntoView({ block: 'nearest' });
    editor.focus();
  }

  return { el, focus: () => editor.focus(), run };
}

export interface EditContext {
  /** `.ez` text of a step (step line plus Expect lines) from the journey file. */
  stepText(index: number): string | undefined;
  /** Write the edited step into the journey file, keeping its id. */
  applyToFile(index: number, text: string): Promise<boolean>;
  /** True while a code journey (eztest/sdk) is open: edit-and-continue is for .ez, YAML and JSON only. */
  codeOnly?(): boolean;
}

/** The edit-and-continue panel; visible while paused on a failure (and on demand before a step). */
export function createEditPanel(ctx: EditContext): { el: HTMLElement; open(): void } {
  const titleId = uid('ec');
  const title = h('h3', { class: 'ec-title', id: titleId });
  const errorP = h('p', { class: 'error-note ec-error' });
  const status = h('p', { class: 'ec-status', id: 'ec-status', role: 'status', 'aria-live': 'polite' });
  let index = -1;
  let valid = false;
  let timer = 0;
  const editor = createMiniEditor({
    label: 'Edit the step (Ctrl+Enter retries with it)',
    multiline: true,
    onChange: () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void check(), 250);
    },
    onSubmit: () => void retry(),
    class: 'ec-editor',
  });
  const retryBtn = h('button', { type: 'button', class: 'btn btn-sm btn-primary', id: 'ec-retry', onclick: () => void retry() }, kitIcon('restart', { size: 13 }), h('span', { text: 'Retry with this step' }));
  const skipBtn = h('button', { type: 'button', class: 'btn btn-sm', id: 'ec-skip', onclick: () => void command('skip') }, kitIcon('skip', { size: 13 }), h('span', { text: 'Skip' }));
  const applyBtn = h('button', { type: 'button', class: 'btn btn-sm', id: 'ec-apply', onclick: () => void apply() }, kitIcon('save', { size: 13 }), h('span', { text: 'Apply to file' }));
  const resetBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => load(true), text: 'Reset' });
  const codeNote = h('p', { class: 'muted small ec-code-note', id: 'ec-code-note', hidden: true, text: 'Edit-and-continue works for .ez, YAML and JSON journeys. This is a code journey: edit the TypeScript, save, and restart (Ctrl+Shift+F5). Skip and the step console still work.' });
  const el = h(
    'section',
    { class: 'edit-continue', id: 'edit-continue', 'aria-labelledby': titleId, hidden: true },
    h('div', { class: 'ec-head' }, kitIcon('edit'), title),
    errorP,
    codeNote,
    editor.el,
    status,
    h('div', { class: 'ec-actions' }, retryBtn, skipBtn, applyBtn, h('span', { class: 'tb-spacer' }), resetBtn),
  );
  /** Code journeys: no editing, only Skip. */
  const codeMode = () => {
    const code = !!ctx.codeOnly?.();
    codeNote.hidden = !code;
    editor.el.hidden = code;
    status.hidden = code;
    retryBtn.hidden = code;
    applyBtn.hidden = code;
    resetBtn.hidden = code;
    return code;
  };

  const check = async (): Promise<boolean> => {
    const text = editor.get().trim();
    if (!text) {
      valid = false;
      status.className = 'ec-status bad';
      status.textContent = 'Type the step.';
      return false;
    }
    try {
      const r = await api.post<{ ok: boolean; steps: unknown[]; validation: { errors: Array<{ message: string }> } }>('/api/model', { content: `Journey: Edit\n${text}\n`, format: 'ez' });
      valid = r.ok && r.steps.length === 1;
      status.className = `ec-status ${valid ? 'ok' : 'bad'}`;
      status.textContent = valid ? '✔ Valid step' : r.validation.errors.length ? `✖ ${r.validation.errors.map((e) => e.message.replace(/^line (\d+)/, (_m, n: string) => `line ${Number(n) - 1}`)).join('; ')}` : `✖ Expected exactly one step, found ${r.steps.length}`;
    } catch (e) {
      valid = false;
      status.className = 'ec-status bad';
      status.textContent = `✖ ${(e as Error).message}`;
    }
    retryBtn.disabled = !valid;
    applyBtn.disabled = !valid;
    return valid;
  };

  const retry = async () => {
    if (!(await check())) return;
    await command('retry', { step: editor.get().trim() });
  };

  const apply = async () => {
    if (!(await check())) return;
    if (await ctx.applyToFile(index, editor.get().trim())) {
      status.className = 'ec-status ok';
      status.textContent = '✔ Applied to the journey file (same step id). Retry to run it.';
    }
  };

  const load = (force = false) => {
    if (codeMode()) return;
    const d = dbg.get();
    const i = d.state?.stepIndex ?? -1;
    if (!force && i === index && editor.get()) return;
    index = i;
    editor.set(ctx.stepText(i) ?? d.state?.intent ?? '');
    void check();
  };

  dbg.subscribe((d) => {
    const failed = d.phase === 'paused' && d.state?.phase === 'failed';
    if (failed) {
      el.hidden = false;
      el.classList.add('failed');
      title.textContent = `Step ${(d.state?.stepIndex ?? 0) + 1} failed: edit and continue`;
      errorP.textContent = d.state?.lastResult?.error?.message ?? '';
      errorP.hidden = !errorP.textContent;
      load();
    } else if (d.phase === 'paused' && !el.hidden && d.state?.phase === 'before-step') {
      title.textContent = `Edit step ${(d.state?.stepIndex ?? 0) + 1} before it runs`;
      el.classList.remove('failed');
      errorP.hidden = true;
      load();
    } else if (d.phase !== 'paused') {
      el.hidden = true;
      index = -1;
    }
    skipBtn.disabled = !(d.phase === 'paused' && (d.state?.phase === 'failed' || d.state?.phase === 'before-step'));
  });

  return {
    el,
    open() {
      const d = dbg.get();
      if (d.phase !== 'paused') return;
      el.hidden = false;
      title.textContent = d.state?.phase === 'failed' ? `Step ${(d.state?.stepIndex ?? 0) + 1} failed: edit and continue` : `Edit step ${(d.state?.stepIndex ?? 0) + 1} before it runs`;
      load(true);
      editor.focus();
    },
  };
}
