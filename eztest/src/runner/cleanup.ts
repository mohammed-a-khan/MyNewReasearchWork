/**
 * Cleanup actions a journey registers while it runs, run in reverse after the journey (or the
 * Gherkin scenario) even when it failed, each as a cleanup step of the result:
 *
 *   On cleanup run query "DELETE_VISIT" on clinic with visit_id=${visitId}
 *   Snapshot query "PET_ROW" on clinic with pet_id=${petId} and restore it with "RESTORE_PET" after the journey
 *   cleanup.add('remove the visit', async () => { ... })          // code journeys and step definitions
 *   cleanup.query('DELETE_VISIT', { visit_id: id }, { connection: 'clinic' })
 *   cleanup.snapshot('PET_ROW', { pet_id: id }, { restore: 'RESTORE_PET' })
 *
 * Query actions are written to the run's cleanup journal (`.eztest/cleanup`, see src/data/cleanup.ts)
 * with their resolved bind values before the journey goes on, and marked done once they ran. When a
 * run crashes, the next run's orphan sweep runs what is left.
 */
import { CleanupJournal, type JournalEntry } from '../data/cleanup.js';
import { nowIso, slugify, Step, type StepResult } from '../core/index.js';

/** Journal provider name of query cleanups (replayed by the orphan sweep). */
export const CLEANUP_PROVIDER = 'eztest-cleanup';

export type CleanupBind = string | number | boolean | null;

/** What the journal keeps of a query cleanup: enough to run it again after a crash. */
export interface QueryCleanupRecord {
  connection: string;
  query: string;
  binds: Record<string, CleanupBind>;
  description: string;
  journeyId: string;
}

interface Entry {
  description: string;
  run(id: string): Promise<StepResult>;
  journalId?: string;
}

const journals = new Map<string, CleanupJournal>();

/** One journal per cleanup directory and process. */
export function cleanupJournal(dir: string | undefined): CleanupJournal | undefined {
  if (!dir) return undefined;
  let j = journals.get(dir);
  if (!j) journals.set(dir, (j = new CleanupJournal(dir)));
  return j;
}

/** The db step a query cleanup runs. */
export function cleanupQueryStep(id: string, r: Pick<QueryCleanupRecord, 'connection' | 'query' | 'binds' | 'description'>): Step {
  // Bind values were resolved when the action was registered: they are literal now.
  const binds = Object.fromEntries(Object.entries(r.binds).map(([k, v]) => [k, typeof v === 'string' ? v.replace(/\$\{/g, '$${') : v]));
  return Step.parse({ id, intent: `Cleanup: ${r.description}`, action: 'db', db: { connection: r.connection, sql: '', query: r.query, binds }, captureAs: `cleanup_${id.replace(/\W/g, '_')}` });
}

export class AttemptCleanup {
  private readonly entries: Entry[] = [];
  /** Runs a step through the journey's runner path (set by the journey runner). */
  exec?: (step: Step) => Promise<StepResult>;

  constructor(private readonly o: { journeyId: string; journal?: CleanupJournal }) {}

  get size(): number {
    return this.entries.length;
  }

  /** Descriptions of the registered actions, in registration order. */
  pending(): string[] {
    return this.entries.map((e) => e.description);
  }

  /** A code action (its SDK calls are the cleanup step's children). */
  addCode(description: string, run: (id: string) => Promise<StepResult>): void {
    this.entries.push({ description, run });
  }

  /** A named-query action; journaled first so a crashed run's leftovers are swept. */
  async addQuery(r: Omit<QueryCleanupRecord, 'journeyId'>): Promise<void> {
    const record: QueryCleanupRecord = { ...r, journeyId: this.o.journeyId };
    const journalId = this.o.journal
      ? await this.o.journal.record({ provider: CLEANUP_PROVIDER, entity: 'query', recordId: `${this.o.journeyId}: ${r.description}`, record: record as unknown as Record<string, unknown> })
      : undefined;
    this.entries.push({
      description: r.description,
      ...(journalId ? { journalId } : {}),
      run: async (id) => {
        if (!this.exec) throw new Error('cleanup has no runner');
        return this.exec(cleanupQueryStep(id, r));
      },
    });
  }

  /** Run every action in reverse registration order; each one is attempted even when others fail. */
  async runAll(): Promise<StepResult[]> {
    const list = this.entries.splice(0).reverse();
    const out: StepResult[] = [];
    const used = new Map<string, number>();
    for (const e of list) {
      const base = `cleanup-${slugify(e.description).slice(0, 40)}`;
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      const id = n > 1 ? `${base}-${n}` : base;
      let r: StepResult;
      try {
        r = await e.run(id);
      } catch (err) {
        r = { stepId: id, intent: `Cleanup: ${e.description}`, status: 'failed', startedAt: nowIso(), durationMs: 0, conditions: [], evidence: [], error: { message: (err as Error).message.split('\n')[0] } };
      }
      r = { ...r, intent: r.intent.startsWith('Cleanup: ') ? r.intent : `Cleanup: ${e.description}`, cleanup: true };
      if (e.journalId && (r.status === 'passed' || r.status === 'passed-healed')) await this.o.journal?.done(e.journalId).catch(() => undefined);
      out.push(r);
    }
    return out;
  }
}

/** True for a journal entry written by a query cleanup. */
export function isQueryCleanup(e: JournalEntry): e is JournalEntry & { record: QueryCleanupRecord & Record<string, unknown> } {
  return e.provider === CLEANUP_PROVIDER && typeof (e.record as Partial<QueryCleanupRecord>).query === 'string';
}
