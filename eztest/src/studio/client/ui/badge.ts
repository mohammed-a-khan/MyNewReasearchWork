/** Status badges and small presentational helpers shared by pages. */
import { h, type Child } from '../core/dom.js';
import { icon, type IconName } from './icons.js';

const STATUS: Record<string, [IconName, string]> = {
  passed: ['check', 'Passed'],
  'passed-healed': ['heal', 'Passed (healed)'],
  failed: ['x', 'Failed'],
  skipped: ['skip', 'Skipped'],
  blocked: ['stop', 'Blocked'],
  error: ['alert', 'Error'],
  running: ['clock', 'Running'],
  queued: ['clock', 'Queued'],
  cancelling: ['stop', 'Cancelling'],
  cancelled: ['stop', 'Cancelled'],
  analyzing: ['activity', 'Analyzing'],
  done: ['check', 'Done'],
  GO: ['check', 'GO'],
  GO_WITH_RISKS: ['warning', 'GO with risks'],
  NO_GO: ['x', 'NO GO'],
  ok: ['check', 'OK'],
  bad: ['x', 'Problem'],
  warn: ['warning', 'Warning'],
  flaky: ['warning', 'Flaky'],
  broken: ['x', 'Broken'],
  stable: ['check', 'Stable'],
  new: ['dot', 'New'],
  recovering: ['refresh', 'Recovering'],
};

export function statusLabel(status: string): string {
  return STATUS[status]?.[1] ?? status;
}

/** A status pill with an icon and text (never colour alone). */
export function badge(status: string, label?: string): HTMLElement {
  const [ic, text] = STATUS[status] ?? (['dot', status] as [IconName, string]);
  return h('span', { class: `badge st-${status.replace(/[^\w-]/g, '')}` }, icon(ic, { size: 12 }), h('span', { text: label ?? text }));
}

/** A compact status icon with an accessible label. */
export function statusIcon(status: string): HTMLElement {
  const [ic, text] = STATUS[status] ?? (['dot', status] as [IconName, string]);
  return h('span', { class: `status-icon st-${status.replace(/[^\w-]/g, '')}`, role: 'img', 'aria-label': text, title: text }, icon(ic, { size: 14 }));
}

export function tag(text: string): HTMLElement {
  return h('span', { class: 'tag', text: `@${text}` });
}

export function kbd(text: string): HTMLElement {
  return h('kbd', { class: 'kbd', text });
}

/** A metric tile: big number with a caption. */
export function stat(value: Child, caption: string, tone?: string): HTMLElement {
  return h('div', { class: ['stat', tone && `tone-${tone}`] }, h('strong', { class: 'stat-value' }, value), h('span', { class: 'stat-caption', text: caption }));
}

/** An empty-state block with an optional call to action. */
export function emptyState(title: string, text: string, action?: HTMLElement): HTMLElement {
  return h('div', { class: 'empty' }, h('p', { class: 'empty-title', text: title }), h('p', { class: 'empty-text', text }), action ?? null);
}

/** A section card with a heading. */
export function card(title: string, body: Child, opts: { actions?: Child; id?: string; class?: string } = {}): HTMLElement {
  const hid = opts.id ? `${opts.id}-h` : undefined;
  return h(
    'section',
    { class: ['card', opts.class], id: opts.id, 'aria-labelledby': hid },
    h('header', { class: 'card-head' }, h('h2', { class: 'card-title', id: hid, text: title }), opts.actions ? h('div', { class: 'card-actions' }, opts.actions) : null),
    h('div', { class: 'card-body' }, body),
  );
}

export function button(label: string, opts: { icon?: IconName; kind?: 'primary' | 'danger' | 'ghost' | 'default'; onclick?: (e: MouseEvent) => void; disabled?: boolean; title?: string; small?: boolean; id?: string; ariaLabel?: string } = {}): HTMLButtonElement {
  return h(
    'button',
    {
      type: 'button',
      id: opts.id,
      class: ['btn', opts.kind && opts.kind !== 'default' && `btn-${opts.kind}`, opts.small && 'btn-sm'],
      onclick: opts.onclick,
      disabled: opts.disabled,
      title: opts.title,
      'aria-label': opts.ariaLabel,
    },
    opts.icon ? icon(opts.icon) : null,
    h('span', { text: label }),
  );
}

export function iconButton(label: string, ic: IconName, onclick: (e: MouseEvent) => void, opts: { pressed?: boolean; disabled?: boolean; id?: string } = {}): HTMLButtonElement {
  return h(
    'button',
    { type: 'button', id: opts.id, class: 'icon-btn', 'aria-label': label, title: label, onclick, disabled: opts.disabled, 'aria-pressed': opts.pressed === undefined ? undefined : String(opts.pressed) },
    icon(ic),
  );
}

/** Copy text and flash the button label. */
export async function copyText(text: string, btn?: HTMLElement): Promise<void> {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    ok = false;
  }
  if (btn) {
    const target = btn.querySelector('span') ?? btn;
    const before = target.textContent;
    target.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => (target.textContent = before), 1500);
  }
}
