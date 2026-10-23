/**
 * Modal dialogs on the native <dialog> element (focus containment, Escape and
 * an inert page come from the browser). `confirmDialog` and `promptDialog`
 * resolve with the user's answer; focus returns to where it was.
 */
import { h, type Child } from '../core/dom.js';
import { uid } from '../core/dom.js';
import { icon } from './icons.js';

export interface ModalAction<T> {
  label: string;
  kind?: 'primary' | 'danger' | 'default';
  /** Return a value to close the dialog with it; return undefined to keep it open. */
  run(): T | undefined | Promise<T | undefined>;
}

export interface ModalOptions<T> {
  title: string;
  body: Child;
  actions?: Array<ModalAction<T>>;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Element to focus first (default: first field, else primary action). */
  initialFocus?: HTMLElement;
  /** Called after the dialog closes. */
  onClose?(): void;
  class?: string;
}

export interface ModalHandle<T> {
  dialog: HTMLDialogElement;
  result: Promise<T | undefined>;
  close(value?: T): void;
}

export function openModal<T>(opts: ModalOptions<T>): ModalHandle<T> {
  const previous = document.activeElement as HTMLElement | null;
  const titleId = uid('modal-title');
  let resolve!: (v: T | undefined) => void;
  const result = new Promise<T | undefined>((r) => (resolve = r));
  let value: T | undefined;
  const footer = h('footer', { class: 'modal-actions' });
  const dialog = h(
    'dialog',
    { class: ['modal', `modal-${opts.size ?? 'md'}`, opts.class], 'aria-labelledby': titleId },
    h(
      'header',
      { class: 'modal-head' },
      h('h2', { id: titleId, class: 'modal-title', text: opts.title }),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close dialog', onclick: () => close() }, icon('close')),
    ),
    h('div', { class: 'modal-body' }, opts.body),
    opts.actions?.length ? footer : null,
  );
  const close = (v?: T) => {
    value = v;
    if (dialog.open) dialog.close();
  };
  for (const a of opts.actions ?? []) {
    const btn = h('button', {
      type: 'button',
      class: ['btn', a.kind === 'primary' && 'btn-primary', a.kind === 'danger' && 'btn-danger'],
      text: a.label,
      onclick: async () => {
        btn.disabled = true;
        try {
          const v = await a.run();
          if (v !== undefined) close(v);
        } finally {
          btn.disabled = false;
        }
      },
    });
    footer.appendChild(btn);
  }
  dialog.addEventListener('close', () => {
    dialog.remove();
    resolve(value);
    opts.onClose?.();
    if (previous && document.contains(previous)) previous.focus();
  });
  // Clicking the backdrop closes the dialog.
  dialog.addEventListener('mousedown', (e) => {
    if (e.target === dialog) close();
  });
  document.body.appendChild(dialog);
  dialog.showModal();
  const first =
    opts.initialFocus ??
    dialog.querySelector<HTMLElement>('.modal-body input, .modal-body textarea, .modal-body select') ??
    footer.querySelector<HTMLElement>('.btn-primary, .btn-danger') ??
    footer.querySelector<HTMLElement>('button');
  first?.focus();
  return { dialog, result, close };
}

export function confirmDialog(opts: { title: string; message: Child; confirm?: string; danger?: boolean }): Promise<boolean> {
  return openModal<boolean>({
    title: opts.title,
    size: 'sm',
    body: typeof opts.message === 'string' ? h('p', { text: opts.message }) : opts.message,
    actions: [
      { label: 'Cancel', run: () => false },
      { label: opts.confirm ?? 'OK', kind: opts.danger ? 'danger' : 'primary', run: () => true },
    ],
  }).result.then((v) => v === true);
}

export function promptDialog(opts: { title: string; label: string; value?: string; placeholder?: string; help?: string; confirm?: string; validate?(v: string): string | undefined }): Promise<string | undefined> {
  const id = uid('prompt');
  const helpId = uid('prompt-help');
  const input = h('input', { id, class: 'input', value: opts.value ?? '', placeholder: opts.placeholder, 'aria-describedby': helpId, autocomplete: 'off', spellcheck: 'false' });
  const err = h('p', { class: 'field-error', role: 'alert' });
  const submit = () => {
    const v = input.value.trim();
    const problem = opts.validate?.(v) ?? (v ? undefined : 'A value is required');
    err.textContent = problem ?? '';
    return problem ? undefined : v;
  };
  const m = openModal<string>({
    title: opts.title,
    size: 'sm',
    body: h('div', { class: 'field' }, h('label', { for: id, text: opts.label }), input, h('p', { id: helpId, class: 'help', text: opts.help ?? '' }), err),
    actions: [
      { label: 'Cancel', run: () => '' },
      { label: opts.confirm ?? 'OK', kind: 'primary', run: submit },
    ],
    initialFocus: input,
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = submit();
      if (v) m.close(v);
    }
  });
  input.select();
  return m.result.then((v) => (v ? v : undefined));
}
