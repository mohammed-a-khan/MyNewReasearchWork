/** Shared pieces of the Test management pages: the tester identity, case and plan types, state badges. */
import { h, uid } from '../../core/dom.js';
import { store } from '../../core/store.js';
import { badge } from '../../ui/badge.js';
import { promptDialog } from '../../ui/modal.js';

const TESTER_KEY = 'eztest.manual.tester';
function saved(): string {
  try {
    return localStorage.getItem(TESTER_KEY) ?? '';
  } catch {
    return '';
  }
}
export const tester = store<string>(saved());
tester.subscribe((v) => {
  try {
    if (v) localStorage.setItem(TESTER_KEY, v);
  } catch {
    // private mode: kept for this session only
  }
});

/** The tester's name, asked once and remembered in this browser. */
export async function askTester(): Promise<string | undefined> {
  const cur = tester.get();
  if (cur) return cur;
  const v = await promptDialog({ title: 'Who is testing?', label: 'Your name', help: 'Recorded with every verdict and shown in cycle progress. Remembered in this browser.', confirm: 'Continue' });
  if (v) tester.set(v.trim());
  return v?.trim() || undefined;
}

/** A labelled tester field bound to the stored name, with known testers as suggestions. */
export function testerField(known: string[] = [], label = 'Tester'): HTMLElement {
  const id = uid('tester');
  const listId = uid('testers');
  const input = h('input', { id, class: 'input', value: tester.get(), autocomplete: 'name', placeholder: 'Your name', list: listId, oninput: (e: Event) => tester.set((e.target as HTMLInputElement).value.trim()) });
  return h('div', { class: 'field' }, h('label', { for: id, text: label }), input, h('datalist', { id: listId }, known.map((t) => h('option', { value: t }))));
}

export interface CaseListItem {
  id: string;
  name: string;
  path: string;
  type: 'automated' | 'manual' | 'hybrid';
  tags: string[];
  assignee?: string;
  steps: number;
  manualSteps?: number;
  requirements?: string[];
  risk?: number;
  last?: { runId: string; status: string; at: string; testers: string[]; pending: number };
}

export interface CaseState {
  id: string;
  name: string;
  type: string;
  assignee?: string;
  state: 'passed' | 'failed' | 'blocked' | 'skipped' | 'untested' | 'in-progress';
  runId?: string;
  at?: string;
  testers: string[];
  manualDone?: number;
  manualTotal?: number;
  missing?: boolean;
}

export interface CycleProgress {
  cycle: { id: string; name: string; state: string; start?: string; due?: string; release?: string };
  total: number;
  counts: Record<CaseState['state'], number>;
  executedRatio: number;
  passRatio: number;
  cases: CaseState[];
  byAssignee: Array<{ assignee: string; total: number; counts: Record<CaseState['state'], number> }>;
  bySuite: Array<{ suite: string; name: string; total: number; counts: Record<CaseState['state'], number> }>;
  burnup: Array<{ date: string; executed: number; passed: number }>;
}

export interface Suite {
  id: string;
  name: string;
  description?: string;
  cases: string[];
  tags: string[];
}

export interface Cycle {
  id: string;
  name: string;
  description?: string;
  release?: string;
  suites: string[];
  cases: string[];
  assignments: Record<string, string>;
  start?: string;
  due?: string;
  state: 'planned' | 'active' | 'closed';
  runs: string[];
  createdAt?: string;
  createdBy?: string;
}

export interface PlansOverview {
  path: string;
  plans: { version: 1; suites: Suite[]; cycles: Cycle[] };
  cases: Array<{ id: string; name: string; tags: string[]; type: string; assignee?: string; path?: string }>;
  testers: string[];
  progress: CycleProgress[];
}

const STATE: Record<string, [string, string]> = {
  passed: ['passed', 'Passed'],
  failed: ['failed', 'Failed'],
  blocked: ['blocked', 'Blocked'],
  skipped: ['skipped', 'Skipped'],
  untested: ['queued', 'Untested'],
  'in-progress': ['running', 'In progress'],
  'not-run': ['queued', 'Not run'],
  'passed-healed': ['passed-healed', 'Passed (healed)'],
};

export function stateBadge(s: string): HTMLElement {
  const [st, label] = STATE[s] ?? [s, s];
  return badge(st, label);
}

export function kindChip(kind: string): HTMLElement {
  return h('span', { class: `chip kind-${kind}`, text: kind === 'manual' ? 'Manual' : kind === 'hybrid' ? 'Hybrid' : 'Automated' });
}

/** A stacked progress bar of case states with a text legend (never colour alone). */
export function stateBar(counts: Record<string, number>, total: number, label: string): HTMLElement {
  const order: Array<CaseState['state']> = ['passed', 'failed', 'blocked', 'skipped', 'in-progress', 'untested'];
  const bar = h('div', { class: 'mt-bar', role: 'img', 'aria-label': `${label}: ${order.filter((k) => counts[k]).map((k) => `${counts[k]} ${STATE[k][1].toLowerCase()}`).join(', ') || 'no cases'}` },
    order.filter((k) => counts[k]).map((k) => h('span', { class: `mt-seg mt-${k}`, style: { width: `${(100 * counts[k]) / Math.max(1, total)}%` } })));
  const legend = h('p', { class: 'mt-legend small' }, order.filter((k) => counts[k]).map((k) => h('span', { class: 'mt-leg' }, h('span', { class: `mt-dot mt-${k}`, 'aria-hidden': 'true' }), `${STATE[k][1]} ${counts[k]}`)));
  return h('div', { class: 'mt-progress' }, bar, legend);
}

/** Read a File as base64 (no data: prefix). */
export function fileToBase64(f: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('could not read the file'));
    r.readAsDataURL(f);
  });
}
