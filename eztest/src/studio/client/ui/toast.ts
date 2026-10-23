/** Toast notifications in a polite live region; errors stay until dismissed. */
import { h } from '../core/dom.js';
import { icon, type IconName } from './icons.js';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface ToastOptions {
  kind?: ToastKind;
  /** Milliseconds; 0 keeps it until dismissed. Default 4500 (errors: 0). */
  timeout?: number;
  action?: { label: string; run(): void };
}

const ICONS: Record<ToastKind, IconName> = { info: 'info', success: 'check', warning: 'warning', error: 'alert' };

function region(): HTMLElement {
  let r = document.getElementById('ez-toasts');
  if (!r) {
    r = h('div', { id: 'ez-toasts', class: 'toasts', role: 'region', 'aria-label': 'Notifications' });
    document.body.appendChild(r);
  }
  return r;
}

export function toast(message: string, opts: ToastOptions = {}): () => void {
  const kind = opts.kind ?? 'info';
  const timeout = opts.timeout ?? (kind === 'error' ? 0 : 4500);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    clearTimeout(timer);
    el.remove();
  };
  const el = h(
    'div',
    { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(ICONS[kind], { class: 'toast-icon' }),
    h('p', { class: 'toast-msg', text: message }),
    opts.action
      ? h('button', {
          type: 'button',
          class: 'btn btn-sm',
          onclick: () => {
            opts.action!.run();
            close();
          },
          text: opts.action.label,
        })
      : null,
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Dismiss notification', onclick: close }, icon('close')),
  );
  region().appendChild(el);
  if (timeout) timer = setTimeout(close, timeout);
  return close;
}

export const toastError = (message: string) => toast(message, { kind: 'error' });
