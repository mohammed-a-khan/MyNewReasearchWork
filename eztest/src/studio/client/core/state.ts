/**
 * Shared client state: the session, journey list, problems index, active run,
 * grammar and vocabulary. Kept live from the event hub so every page sees the
 * same data without polling.
 */
import { api } from './api.js';
import { onTopic, type HubMessage } from './events.js';
import { store } from './store.js';

export interface Session {
  project: string;
  journeysDir: string;
  run?: string;
  runState?: string;
  recording: boolean;
  branch?: string;
  node?: string;
  watching?: string;
  lastEventSeq: number;
}

export interface JourneyEntry {
  path: string;
  /** 'ts': code journeys (eztest/sdk). */
  format: 'ez' | 'yaml' | 'json' | 'ts';
  id?: string;
  name?: string;
  tags: string[];
  risk?: number;
  requirements: string[];
  steps?: number;
  error?: string;
  /** Code journey files: every journey() in the file, with its line. */
  code?: Array<{ id: string; name: string; line: number }>;
}

export interface Issue {
  line?: number;
  column?: number;
  message: string;
  suggestions: string[];
}

export interface GrammarGroup {
  category: string;
  kind: 'action' | 'expectation' | 'header';
  examples: Array<{ text: string; keywords: string[]; rule?: string }>;
}

export interface Vocabulary {
  roles: string[];
  connections: string[];
  documents: string[];
  entities: string[];
  tags: string[];
  variables: string[];
  lenses: string[];
}

export interface ActiveRun {
  id: string;
  state: string;
  total: number;
  done: number;
  failed: number;
  current?: string;
}

export const session = store<Session | undefined>(undefined);
export const journeys = store<JourneyEntry[]>([]);
export const problems = store<Record<string, Issue[]>>({});
export const activeRun = store<ActiveRun | undefined>(undefined);
export const grammar = store<GrammarGroup[]>([]);
export const vocabulary = store<Vocabulary>({ roles: [], connections: [], documents: [], entities: [], tags: [], variables: [], lenses: ['a11y', 'security', 'visual'] });
/** Bumped when a run finishes, so result lists can refresh. */
export const runsVersion = store(0);

export const problemCount = problems.select((p) => Object.values(p).reduce((n, list) => n + list.length, 0));

export async function loadSession(): Promise<Session> {
  const s = await api.get<Session>('/api/session');
  session.set(s);
  return s;
}

let journeysInflight: Promise<void> | undefined;
export function refreshJourneys(): Promise<void> {
  journeysInflight ??= api
    .get<{ journeys: JourneyEntry[] }>('/api/journeys')
    .then((r) => journeys.set(r.journeys))
    .finally(() => (journeysInflight = undefined));
  return journeysInflight;
}

export async function refreshProblems(): Promise<void> {
  const r = await api.get<{ files: Array<{ path: string; errors: Issue[] }> }>('/api/problems');
  problems.set(Object.fromEntries(r.files.map((f) => [f.path, f.errors])));
}

export async function loadGrammar(): Promise<GrammarGroup[]> {
  if (!grammar.get().length) grammar.set((await api.get<{ groups: GrammarGroup[] }>('/api/grammar')).groups);
  return grammar.get();
}

export async function refreshVocabulary(): Promise<void> {
  vocabulary.set(await api.get<Vocabulary>('/api/vocabulary'));
}

/** Set the problems of one open file from a live validation (the editor knows before the watcher does). */
export function setFileProblems(path: string, errors: Issue[]): void {
  problems.update((p) => {
    const next = { ...p };
    if (errors.length) next[path] = errors;
    else delete next[path];
    return next;
  });
}

let filesTimer: ReturnType<typeof setTimeout> | undefined;

function onRunEvent(m: HubMessage): void {
  const cur = activeRun.get();
  switch (m.type) {
    case 'queued': {
      const list = (m.journeys as Array<{ steps: unknown[] }>) ?? [];
      activeRun.set({ id: String(m.runId), state: 'running', total: list.reduce((n, j) => n + j.steps.length, 0), done: 0, failed: 0 });
      break;
    }
    case 'journey:start':
      if (cur) activeRun.set({ ...cur, current: String(m.name ?? m.journeyId) });
      break;
    case 'step:end':
      if (cur) activeRun.set({ ...cur, done: cur.done + 1, failed: cur.failed + (m.status === 'failed' ? 1 : 0) });
      break;
    case 'cancelling':
      if (cur) activeRun.set({ ...cur, state: 'cancelling' });
      break;
    case 'run:summary':
      if (cur && cur.state !== 'cancelling') activeRun.set({ ...cur, state: 'analyzing' });
      break;
    case 'done':
      activeRun.set(undefined);
      runsVersion.update((n) => n + 1);
      break;
  }
}

/** Wire hub topics into the shared stores. */
export function startState(): void {
  onTopic('files', () => {
    clearTimeout(filesTimer);
    filesTimer = setTimeout(() => void refreshJourneys().catch(() => undefined), 150);
  });
  onTopic('problems', (m) => setFileProblems(String(m.path), (m.errors as Issue[]) ?? []));
  onTopic('run', onRunEvent);
}

/** Restore the active run indicator after a page load during a run. */
export async function restoreActiveRun(): Promise<void> {
  const r = await api.get<{ active?: { id: string; state: string; journeys: Array<{ steps: number }> } }>('/api/runs');
  if (r.active) {
    activeRun.set({ id: r.active.id, state: r.active.state, total: r.active.journeys.reduce((n, j) => n + j.steps, 0), done: 0, failed: 0 });
  }
}
