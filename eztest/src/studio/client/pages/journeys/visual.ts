/**
 * The visual step view: the journey as a list of step cards (action, target,
 * value, post-conditions). Steps can be added, edited, reordered (drag, or
 * Alt+Up/Down), duplicated and deleted. Every change goes through the server's
 * parse/serialize round trip (`/api/model/apply`) and lands in the editor as
 * one undoable change, so the code view and the file stay the source of truth.
 */
import { api, ApiError } from '../../core/api.js';
import { add, announce, clear, h, uid } from '../../core/dom.js';
import { grammar } from '../../core/state.js';
import { button, emptyState, iconButton, tag } from '../../ui/badge.js';
import { icon } from '../../ui/icons.js';
import { confirmDialog } from '../../ui/modal.js';
import { toastError } from '../../ui/toast.js';
import type { Format } from './assist.js';

export interface StepCard {
  index: number;
  id: string;
  text: string;
  expects: string[];
  action: string;
  target?: string;
  value?: string;
  captureAs?: string;
  optional: boolean;
  line?: number;
  endLine?: number;
}

interface Model {
  ok: boolean;
  format: Format;
  header?: { id: string; name: string; tags: string[]; risk: number; requirements: string[]; role?: string; description?: string };
  steps: StepCard[];
  validation: { ok: boolean; errors: Array<{ line?: number; message: string }> };
}

/** One entry of the working list: an existing step (by original index) and/or new text. */
interface Entry {
  key: string;
  from?: number;
  text?: string;
  expects?: string[];
  card?: StepCard;
}

export interface VisualOptions {
  getText(): string;
  getFormat(): Format;
  /** Put new file text into the editor (one undoable change). */
  apply(text: string): void;
  /** Jump to a line in the code view. */
  showInCode(line: number): void;
  undo(): void;
}

export interface VisualHandle {
  el: HTMLElement;
  refresh(): Promise<void>;
  /** Focus the first card (or the add button). */
  focus(): void;
}

let keySeq = 0;
const newKey = () => `k${++keySeq}`;

function datalist(kind: 'action' | 'expectation'): HTMLDataListElement {
  const id = uid(`dl-${kind}`);
  const seen = new Set<string>();
  const opts: HTMLOptionElement[] = [];
  for (const g of grammar.get()) {
    if (g.kind !== kind) continue;
    for (const ex of g.examples) {
      const v = kind === 'expectation' ? ex.text.replace(/^Expect\s+/, '') : ex.text;
      if (!seen.has(v)) {
        seen.add(v);
        opts.push(h('option', { value: v }));
      }
    }
  }
  return h('datalist', { id }, opts);
}

export function createVisualView(o: VisualOptions): VisualHandle {
  const listId = uid('steps');
  const status = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const header = h('div', { class: 'vs-header' });
  const list = h('ol', { id: listId, class: 'vs-list', 'aria-label': 'Steps' });
  const toolbar = h(
    'div',
    { class: 'vs-toolbar' },
    button('Add step', { icon: 'plus', kind: 'primary', small: true, onclick: () => startNew(entries.length) }),
    button('Undo', { icon: 'refresh', small: true, onclick: () => o.undo(), title: 'Undo the last change (also Ctrl+Z in the code view)' }),
    h('span', { class: 'vs-hint', text: 'Drag cards or use Alt+↑/↓ to reorder. Changes are written to the file text; save with Ctrl+S.' }),
  );
  const body = h('div', { class: 'vs-body' }, header, list);
  const el = h('div', { class: 'visual-steps' }, toolbar, body, status);
  let model: Model | undefined;
  let entries: Entry[] = [];
  let editing: string | undefined;
  let editDraft: { text: string; expects: string[] } | undefined;
  let editError: { message: string; suggestions: string[] } | undefined;
  let busy = false;
  let dragKey: string | undefined;
  const actionList = datalist('action');
  const expectList = datalist('expectation');
  el.append(actionList, expectList);

  const refresh = async () => {
    try {
      model = await api.post<Model>('/api/model', { content: o.getText(), format: o.getFormat() });
    } catch (e) {
      clear(list);
      list.appendChild(h('li', { class: 'vs-error', text: `Cannot read the steps: ${(e as Error).message}` }));
      return;
    }
    entries = model.steps.map((c) => ({ key: newKey(), from: c.index, card: c }));
    editing = undefined;
    editError = undefined;
    render();
  };

  /** Send the working list to the server and put the result into the editor. */
  const commit = async (next: Entry[], message: string): Promise<boolean> => {
    if (busy) return false;
    busy = true;
    try {
      const steps = next.map((e) => (e.text !== undefined ? { from: e.from, text: e.text, expects: e.expects ?? [] } : { from: e.from }));
      const r = await api.post<{ content: string }>('/api/model/apply', { content: o.getText(), format: o.getFormat(), steps });
      o.apply(r.content);
      await refresh();
      status.textContent = message;
      announce(message);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        editError = { message: e.message, suggestions: (e.body.suggestions as string[]) ?? [] };
        render();
        return false;
      }
      toastError(`Could not update the steps: ${(e as Error).message}`);
      return false;
    } finally {
      busy = false;
    }
  };

  const move = async (key: string, to: number) => {
    const i = entries.findIndex((e) => e.key === key);
    if (i < 0 || to < 0 || to >= entries.length || to === i) return;
    const next = [...entries];
    const [it] = next.splice(i, 1);
    next.splice(to, 0, it);
    if (await commit(next, `Moved step ${i + 1} to position ${to + 1}`)) focusCard(to);
  };

  const duplicate = async (key: string) => {
    const i = entries.findIndex((e) => e.key === key);
    const e = entries[i];
    if (!e?.card) return;
    const next = [...entries];
    next.splice(i + 1, 0, { key: newKey(), text: e.card.text, expects: e.card.expects });
    if (await commit(next, `Duplicated step ${i + 1}`)) focusCard(i + 1);
  };

  const remove = async (key: string) => {
    const i = entries.findIndex((e) => e.key === key);
    if (i < 0) return;
    if (entries.length === 1) {
      toastError('A journey needs at least one step.');
      return;
    }
    const ok = await confirmDialog({ title: 'Delete step?', message: `Delete step ${i + 1}: ${entries[i].card?.text ?? ''}`, confirm: 'Delete', danger: true });
    if (!ok) return;
    if (await commit(entries.filter((e) => e.key !== key), `Deleted step ${i + 1}`)) focusCard(Math.min(i, entries.length - 1));
  };

  const startNew = (at: number) => {
    const entry: Entry = { key: newKey() };
    entries.splice(at, 0, entry);
    editing = entry.key;
    editDraft = { text: '', expects: [] };
    editError = undefined;
    render();
  };

  const startEdit = (key: string) => {
    const e = entries.find((x) => x.key === key);
    if (!e?.card) return;
    editing = key;
    editDraft = { text: e.card.text, expects: [...e.card.expects] };
    editError = undefined;
    render();
  };

  const cancelEdit = () => {
    const i = entries.findIndex((x) => x.key === editing);
    if (i >= 0 && !entries[i].card) entries.splice(i, 1);
    editing = undefined;
    editError = undefined;
    render();
    focusCard(Math.max(0, i));
  };

  const saveEdit = async () => {
    const i = entries.findIndex((x) => x.key === editing);
    if (i < 0 || !editDraft) return;
    const next = entries.map((e, k) => (k === i ? { ...e, text: editDraft!.text.trim(), expects: editDraft!.expects.map((x) => x.trim()).filter(Boolean) } : e));
    const isNew = !entries[i].card;
    if (await commit(next, isNew ? `Added step ${i + 1}` : `Updated step ${i + 1}`)) focusCard(i);
  };

  const focusCard = (i: number) => {
    setTimeout(() => list.querySelectorAll<HTMLElement>('.vs-card')[i]?.focus(), 0);
  };

  const renderHeader = () => {
    clear(header);
    const hd = model?.header;
    if (!hd) return;
    add(
      header,
      h('h2', { class: 'vs-title', text: hd.name }),
      h(
        'p',
        { class: 'vs-meta' },
        h('span', { text: `id ${hd.id}` }),
        h('span', { text: `risk ${hd.risk}` }),
        hd.role ? h('span', { text: `role ${hd.role}` }) : null,
        hd.requirements.length ? h('span', { text: hd.requirements.join(', ') }) : null,
        hd.tags.map((t) => tag(t)),
      ),
      hd.description ? h('p', { class: 'vs-desc', text: hd.description }) : null,
    );
  };

  const editor = (entry: Entry, i: number) => {
    const draft = editDraft!;
    const textId = uid('step-text');
    const input = h('input', {
      id: textId,
      class: 'input mono',
      value: draft.text,
      list: actionList.id,
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'Click the "Save" button',
      oninput: (ev: Event) => (draft.text = (ev.target as HTMLInputElement).value),
      onkeydown: (ev: KeyboardEvent) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          void saveEdit();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          cancelEdit();
        }
      },
    });
    const exList = h('ul', { class: 'vs-expect-edit' });
    const renderExpects = () => {
      clear(exList);
      draft.expects.forEach((x, k) => {
        const id = uid('expect');
        exList.appendChild(
          h(
            'li',
            null,
            h('label', { for: id, class: 'sr-only', text: `Expectation ${k + 1}` }),
            h('span', { class: 'vs-expect-kw', 'aria-hidden': 'true', text: 'Expect' }),
            h('input', {
              id,
              class: 'input mono',
              value: x,
              list: expectList.id,
              autocomplete: 'off',
              spellcheck: 'false',
              oninput: (ev: Event) => (draft.expects[k] = (ev.target as HTMLInputElement).value),
            }),
            iconButton(`Remove expectation ${k + 1}`, 'trash', () => {
              draft.expects.splice(k, 1);
              renderExpects();
            }),
          ),
        );
      });
    };
    renderExpects();
    const err = editError
      ? h(
          'div',
          { class: 'vs-edit-error', role: 'alert' },
          h('p', { text: editError.message }),
          editError.suggestions.length
            ? h(
                'p',
                { class: 'vs-suggest' },
                'Did you mean: ',
                editError.suggestions.map((s) =>
                  button(s, {
                    small: true,
                    onclick: () => {
                      draft.text = s;
                      input.value = s;
                      input.focus();
                    },
                  }),
                ),
              )
            : null,
        )
      : null;
    setTimeout(() => input.focus(), 0);
    return h(
      'li',
      { class: 'vs-card editing', dataset: { key: entry.key } },
      h('div', { class: 'vs-num', 'aria-hidden': 'true', text: String(i + 1) }),
      h(
        'div',
        { class: 'vs-main' },
        h('div', { class: 'field' }, h('label', { for: textId, text: entry.card ? `Edit step ${i + 1}` : `New step ${i + 1}` }), input),
        h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Expectations (checked after the step)' }), exList, button('Add expectation', { small: true, icon: 'plus', onclick: () => (draft.expects.push(''), renderExpects(), exList.querySelector<HTMLInputElement>('li:last-child input')?.focus()) })),
        err,
        h('div', { class: 'vs-edit-actions' }, button('Apply', { kind: 'primary', small: true, onclick: () => void saveEdit() }), button('Cancel', { small: true, onclick: cancelEdit })),
      ),
    );
  };

  const cardEl = (entry: Entry, i: number) => {
    const c = entry.card!;
    const li = h(
      'li',
      {
        class: 'vs-card',
        tabindex: '0',
        draggable: 'true',
        'aria-label': `Step ${i + 1} of ${entries.length}: ${c.text}`,
        'aria-describedby': `${listId}-help`,
        dataset: { key: entry.key, index: i },
        onkeydown: (ev: KeyboardEvent) => {
          if (ev.target !== li) return;
          if (ev.altKey && ev.key === 'ArrowUp') (ev.preventDefault(), void move(entry.key, i - 1));
          else if (ev.altKey && ev.key === 'ArrowDown') (ev.preventDefault(), void move(entry.key, i + 1));
          else if (ev.key === 'ArrowDown') (ev.preventDefault(), focusCard(i + 1));
          else if (ev.key === 'ArrowUp') (ev.preventDefault(), focusCard(i - 1));
          else if (ev.key === 'Enter' || ev.key === 'F2') (ev.preventDefault(), startEdit(entry.key));
          else if (ev.key === 'Delete') (ev.preventDefault(), void remove(entry.key));
        },
        ondblclick: () => startEdit(entry.key),
        ondragstart: (ev: DragEvent) => {
          dragKey = entry.key;
          ev.dataTransfer?.setData('text/plain', entry.key);
          if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
          li.classList.add('dragging');
        },
        ondragend: () => {
          dragKey = undefined;
          li.classList.remove('dragging');
          list.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
        },
        ondragover: (ev: DragEvent) => {
          if (!dragKey || dragKey === entry.key) return;
          ev.preventDefault();
          const r = li.getBoundingClientRect();
          const after = ev.clientY > r.top + r.height / 2;
          li.classList.toggle('drop-after', after);
          li.classList.toggle('drop-before', !after);
        },
        ondragleave: () => li.classList.remove('drop-before', 'drop-after'),
        ondrop: (ev: DragEvent) => {
          ev.preventDefault();
          if (!dragKey) return;
          const from = entries.findIndex((e) => e.key === dragKey);
          const after = li.classList.contains('drop-after');
          let to = i + (after ? 1 : 0);
          if (from < to) to--;
          void move(dragKey, to);
        },
      },
      h('div', { class: 'vs-grip', 'aria-hidden': 'true' }, icon('grip')),
      h('div', { class: 'vs-num', 'aria-hidden': 'true', text: String(i + 1) }),
      h(
        'div',
        { class: 'vs-main' },
        h('p', { class: 'vs-text mono', text: c.text }),
        h(
          'dl',
          { class: 'vs-props' },
          h('div', null, h('dt', { text: 'Action' }), h('dd', null, h('span', { class: `chip act-${c.action}`, text: c.action }))),
          c.target ? h('div', null, h('dt', { text: 'Target' }), h('dd', { text: c.target })) : null,
          c.value !== undefined ? h('div', null, h('dt', { text: 'Value' }), h('dd', { class: 'mono', text: c.value })) : null,
          c.captureAs ? h('div', null, h('dt', { text: 'Stores as' }), h('dd', { class: 'mono', text: c.captureAs })) : null,
          c.optional ? h('div', null, h('dt', { text: 'Optional' }), h('dd', { text: 'yes' })) : null,
        ),
        c.expects.length
          ? h('ul', { class: 'vs-expects', 'aria-label': 'Expectations' }, c.expects.map((x) => h('li', null, icon('check', { size: 12 }), h('span', { class: 'mono', text: x }))))
          : null,
      ),
      h(
        'div',
        { class: 'vs-actions' },
        iconButton(`Edit step ${i + 1}`, 'edit', () => startEdit(entry.key)),
        iconButton(`Insert a step after step ${i + 1}`, 'plus', () => startNew(i + 1)),
        iconButton(`Duplicate step ${i + 1}`, 'copy', () => void duplicate(entry.key)),
        iconButton(`Move step ${i + 1} up`, 'up', () => void move(entry.key, i - 1), { disabled: i === 0 }),
        iconButton(`Move step ${i + 1} down`, 'down', () => void move(entry.key, i + 1), { disabled: i === entries.length - 1 }),
        c.line ? iconButton(`Show step ${i + 1} in code`, 'code', () => o.showInCode(c.line!)) : null,
        iconButton(`Delete step ${i + 1}`, 'trash', () => void remove(entry.key)),
      ),
    );
    return li;
  };

  const render = () => {
    renderHeader();
    clear(list);
    if (!model) return;
    if (!model.ok) {
      list.appendChild(
        h(
          'li',
          { class: 'vs-blocked' },
          emptyState(
            'Fix the problems first',
            `The visual view needs a journey that parses. ${model.validation.errors.length} problem(s) found; see the Problems panel or the code view.`,
            button('Show in code view', { onclick: () => o.showInCode(model!.validation.errors[0]?.line ?? 1) }),
          ),
        ),
      );
      return;
    }
    entries.forEach((e, i) => list.appendChild(e.key === editing ? editor(e, i) : cardEl(e, i)));
  };

  el.appendChild(h('p', { id: `${listId}-help`, class: 'sr-only', text: 'Enter to edit, Alt+Up or Alt+Down to move, Delete to remove.' }));

  return {
    el,
    refresh,
    focus() {
      (list.querySelector<HTMLElement>('.vs-card') ?? toolbar.querySelector<HTMLElement>('button'))?.focus();
    },
  };
}
