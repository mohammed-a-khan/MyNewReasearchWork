/**
 * Shared building blocks of the Quality Center pages: the page frame with
 * loading / error / empty states, the reviewer identity, diff rendering,
 * locator text, run pickers and the live `quality` topic.
 */
import { api } from '../../core/api.js';
import { clear, h, uid, type Child } from '../../core/dom.js';
import { onTopic } from '../../core/events.js';
import { relTime } from '../../core/format.js';
import type { PageContext } from '../../core/registry.js';
import { runsVersion } from '../../core/state.js';
import { store } from '../../core/store.js';
import { button, emptyState } from '../../ui/badge.js';
import { icon } from '../../ui/icons.js';
import { openModal, promptDialog } from '../../ui/modal.js';

export interface Locator {
  strategy: string;
  value: string;
  name?: string;
  exact?: boolean;
}

export interface DiffLine {
  kind: ' ' | '+' | '-';
  text: string;
  oldNo?: number;
  newNo?: number;
}

/** Readable text for a locator, matching the grammar where possible. */
export function locatorText(l: Locator | undefined): string {
  if (!l) return '';
  if (l.strategy === 'role') return l.name ? `role=${l.value}[name="${l.name}"]` : `role=${l.value}`;
  if (l.strategy === 'testId') return `testid=${l.value}`;
  if (l.strategy === 'css' || l.strategy === 'xpath') return `${l.strategy}=${l.value}`;
  return `${l.strategy}="${l.value}"`;
}

export const CATEGORY_LABEL: Record<string, string> = {
  'product-bug': 'Product bug',
  'test-issue': 'Test issue',
  environment: 'Environment',
  data: 'Data',
  flaky: 'Flaky',
  unknown: 'Unknown',
};

export const CATEGORIES = ['product-bug', 'test-issue', 'environment', 'data', 'flaky', 'unknown'];

export const TIER_LABEL: Record<string, string> = { 'T0-cache': 'T0 cache', 'T1-fingerprint': 'T1 fingerprint', 'T2-semantic': 'T2 semantic', improvement: 'Improvement (more robust locator)' };

// ------------------------------------------------------------------ page frame

export interface QualityFrame {
  heading: HTMLElement;
  toolbar: HTMLElement;
  body: HTMLElement;
  loading(text?: string): void;
  error(message: string, retry?: () => void): void;
  empty(title: string, text: string, action?: HTMLElement): void;
  content(...children: Child[]): void;
}

export function qualityFrame(ctx: PageContext, title: string, subtitle: string, opts: { wide?: boolean } = {}): QualityFrame {
  const heading = h('h1', { class: 'page-title', tabindex: '-1', text: title });
  const toolbar = h('div', { class: 'q-toolbar', role: 'toolbar', 'aria-label': `${title} options` });
  const body = h('div', { class: 'q-body', 'aria-live': 'off' });
  ctx.root.classList.add('page-scroll', 'q-page');
  ctx.root.append(
    h('div', { class: ['page-inner', opts.wide && 'q-wide'] }, h('header', { class: 'page-head row-between' }, h('div', null, h('p', { class: 'q-eyebrow', text: 'Quality' }), heading, h('p', { class: 'muted', text: subtitle })), toolbar), body),
  );
  return {
    heading,
    toolbar,
    body,
    loading(text = 'Loading…') {
      body.setAttribute('aria-busy', 'true');
      clear(body).appendChild(h('div', { class: 'q-loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { text })));
    },
    error(message, retry) {
      body.removeAttribute('aria-busy');
      clear(body).appendChild(
        h('div', { class: 'q-error', role: 'alert' }, icon('alert', { size: 18 }), h('div', null, h('p', { class: 'q-error-title', text: 'Could not load this page' }), h('p', { text: message }), retry ? button('Try again', { icon: 'refresh', small: true, onclick: retry }) : null)),
      );
    },
    empty(t, text, action) {
      body.removeAttribute('aria-busy');
      clear(body).appendChild(emptyState(t, text, action));
    },
    content(...children) {
      body.removeAttribute('aria-busy');
      clear(body);
      for (const c of children) if (c) body.append(c as Node);
    },
  };
}

/** Re-run `load` when a run finishes or Quality data changes, if the page is visible. */
export function autoRefresh(ctx: PageContext, load: () => void, topics: string[] = []): void {
  let t: ReturnType<typeof setTimeout> | undefined;
  const kick = () => {
    if (ctx.root.hidden) return;
    clearTimeout(t);
    t = setTimeout(load, 120);
  };
  runsVersion.subscribe(kick, false);
  onTopic('quality', (m) => {
    if (!topics.length || topics.includes(String(m.type))) kick();
  });
}

// ------------------------------------------------------------------ reviewer

const REVIEWER_KEY = 'eztest.quality.reviewer';
function savedReviewer(): string {
  try {
    return localStorage.getItem(REVIEWER_KEY) ?? '';
  } catch {
    return '';
  }
}
export const reviewer = store<string>(savedReviewer());
reviewer.subscribe((v) => {
  try {
    if (v) localStorage.setItem(REVIEWER_KEY, v);
  } catch {
    // storage unavailable (private mode): the name is kept for this session only
  }
});

/** The reviewer's name for audit records; asked once and remembered in this browser. */
export async function askReviewer(): Promise<string | undefined> {
  const cur = reviewer.get();
  if (cur) return cur;
  const v = await promptDialog({ title: 'Who is reviewing?', label: 'Your name', help: 'Recorded with every decision (heal reviews, reclassifications, quarantine, sign-off). Remembered in this browser.', confirm: 'Continue' });
  if (v) reviewer.set(v);
  return v;
}

/** A labelled text field bound to the reviewer name. */
export function reviewerField(label = 'Reviewer'): HTMLElement {
  const id = uid('reviewer');
  const input = h('input', { id, class: 'input', value: reviewer.get(), autocomplete: 'name', placeholder: 'Your name', oninput: (e: Event) => reviewer.set((e.target as HTMLInputElement).value.trim()) });
  return h('div', { class: 'field' }, h('label', { for: id, text: label }), input);
}

// ------------------------------------------------------------------ diffs

/** A unified diff block: line numbers, +/- markers (never colour alone). */
export function diffView(path: string, lines: DiffLine[], opts: { existed?: boolean } = {}): HTMLElement {
  const adds = lines.filter((l) => l.kind === '+').length;
  const dels = lines.filter((l) => l.kind === '-').length;
  return h(
    'figure',
    { class: 'q-diff' },
    h('figcaption', { class: 'q-diff-head' }, icon('file', { size: 14 }), h('code', { text: path }), opts.existed === false ? h('span', { class: 'chip', text: 'new file' }) : null, h('span', { class: 'muted small', text: `+${adds} −${dels}` })),
    h(
      'pre',
      { class: 'q-diff-body', tabindex: '0', 'aria-label': `Changes to ${path}: ${adds} added, ${dels} removed lines` },
      lines.map((l) =>
        h(
          'span',
          { class: ['q-dl', l.kind === '+' ? 'q-add' : l.kind === '-' ? 'q-del' : 'q-ctx'] },
          h('span', { class: 'q-ln', 'aria-hidden': 'true', text: l.oldNo ?? '' }),
          h('span', { class: 'q-ln', 'aria-hidden': 'true', text: l.newNo ?? '' }),
          h('span', { class: 'q-mark', text: l.kind === ' ' ? ' ' : l.kind === '+' ? '+' : '−' }),
          h('span', { class: 'q-code', text: l.text || ' ' }),
          '\n',
        ),
      ),
    ),
  );
}

// ------------------------------------------------------------------ misc

export interface RunOption {
  runId: string;
  startedAt?: string;
  failed?: number;
  summary?: { total: number; passed: number; passedHealed: number; failed: number; errors: number };
}

export function runLabel(r: RunOption): string {
  const s = r.summary;
  return `${relTime(r.startedAt)} · ${r.runId}${s ? ` · ${s.passed}✓ ${s.passedHealed}⟳ ${s.failed + s.errors}✗` : r.failed !== undefined ? ` · ${r.failed} failed` : ''}`;
}

/** A labelled run <select>. */
export function runSelect(label: string, runs: RunOption[], current: string | undefined, onChange: (id: string) => void, id = uid('run')): HTMLElement {
  const sel = h('select', { id, class: 'input input-sm', onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) }, runs.map((r) => h('option', { value: r.runId, selected: r.runId === current, text: runLabel(r) })));
  return h('div', { class: 'q-inline-field' }, h('label', { for: id, text: label }), sel);
}

/** Small "n" pill; the label is read instead of the bare number (a span cannot carry aria-label). */
export function countPill(n: number | string, label?: string): HTMLElement {
  if (!label) return h('span', { class: 'count-pill', text: String(n) });
  return h('span', { class: 'count-pill' }, h('span', { 'aria-hidden': 'true', text: String(n) }), h('span', { class: 'sr-only', text: label }));
}

/** A labelled meter (0..1). */
export function meter(value: number, label: string, tone: 'ok' | 'warn' | 'bad' | 'heal' = 'ok'): HTMLElement {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return h('div', { class: `q-meter tone-${tone}`, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': label }, h('div', { class: 'q-meter-fill', style: { width: `${pct}%` } }));
}

/** Open a modal that shows a confirmation with arbitrary content; resolves true on confirm. */
export function confirmWith(title: string, body: Child, confirm: string, opts: { danger?: boolean; size?: 'sm' | 'md' | 'lg' | 'xl'; validate?: () => string | undefined } = {}): Promise<boolean> {
  const err = h('p', { class: 'field-error', role: 'alert' });
  return openModal<boolean>({
    title,
    size: opts.size ?? 'lg',
    body: h('div', { class: 'stack' }, body, err),
    actions: [
      { label: 'Cancel', run: () => false },
      {
        label: confirm,
        kind: opts.danger ? 'danger' : 'primary',
        run: () => {
          const problem = opts.validate?.();
          err.textContent = problem ?? '';
          return problem ? undefined : true;
        },
      },
    ],
  }).result.then((v) => v === true);
}

/** Live Quality summary (pending heals per run etc.), refreshed on changes. */
export interface QualitySummary {
  pendingHeals: number;
  pendingByRun: Record<string, number>;
  quarantine: { active: number; expiringSoon: number; expired: number };
  latestRun?: { runId: string; failed: number; healed: number };
}

export const qualitySummary = store<QualitySummary | undefined>(undefined);

let summaryTimer: ReturnType<typeof setTimeout> | undefined;
export function refreshQualitySummary(): void {
  clearTimeout(summaryTimer);
  summaryTimer = setTimeout(() => {
    api
      .get<QualitySummary>('/api/quality/summary')
      .then((s) => qualitySummary.set(s))
      .catch(() => undefined);
  }, 150);
}

export function startQualitySummary(): void {
  refreshQualitySummary();
  runsVersion.subscribe(() => refreshQualitySummary(), false);
  onTopic('quality', () => refreshQualitySummary());
}
