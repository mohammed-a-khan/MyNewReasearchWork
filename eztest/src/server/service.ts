/**
 * Results-server operations, independent of HTTP: run ingest, shared team
 * state (heal decisions, quarantine, triage overrides), cross-machine locks,
 * readiness sign-off, retention and the read models behind the dashboards.
 * Every state change that matters for compliance is written to the audit log.
 */
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { createHash } from 'node:crypto';
import { verifyEvidence, type RunResult } from '../core/index.js';
import { scoreFlakiness, validateQuarantineEntry, type RunHistoryEntry, type FlakyScore } from '../insights/index.js';
import { durationsFromRuns, type DurationTable } from '../scale/durations.js';
import { AuditLog } from './audit.js';
import type { Principal } from './auth.js';
import { num, optNum, optStr, type Store } from './store.js';

export class ServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
export function checkName(kind: string, v: string): string {
  if (typeof v !== 'string' || !NAME.test(v) || v.includes('..')) throw new ServiceError(400, `Invalid ${kind} "${String(v).slice(0, 60)}"`);
  return v;
}

/** A run-relative file path: no absolute paths, no `..`, no backslashes or NUL. */
export function checkRelPath(p: string): string {
  if (typeof p !== 'string' || !p || p.length > 500 || p.includes('\0') || p.includes('\\') || isAbsolute(p) || p.split('/').some((s) => s === '..' || s === '')) {
    throw new ServiceError(400, 'Invalid file path');
  }
  return p;
}

export const STATE_KINDS = ['heal-decisions', 'quarantine', 'triage-overrides'] as const;
export type StateKind = (typeof STATE_KINDS)[number];
export const isStateKind = (v: string): v is StateKind => (STATE_KINDS as readonly string[]).includes(v);

const REPORT_FILES = new Set(['report.html', 'report.json', 'junit.xml', 'selection.json']);

interface ManifestLine {
  id: string;
  path: string;
  sha256: string;
}

export interface RunRow {
  project: string;
  runId: string;
  startedAt: string;
  finishedAt?: string;
  durationMs: number;
  summary: { total: number; passed: number; passedHealed: number; failed: number; skipped: number; errors: number };
  readiness?: string;
  readinessScore?: number;
  evidenceHead?: string;
  verified: boolean;
  state: string;
  branch?: string;
  commit?: string;
  uploadedBy?: string;
  uploadedAt?: string;
  filesBytes: number;
  evidenceDeletedAt?: string;
  signed: boolean;
  signedBy?: string;
  signedAt?: string;
  data: Record<string, unknown>;
}

function runFromRow(r: Record<string, unknown>): RunRow {
  return {
    project: String(r.project), runId: String(r.run_id), startedAt: String(r.started_at), finishedAt: optStr(r.finished_at), durationMs: num(r.duration_ms),
    summary: { total: num(r.total), passed: num(r.passed), passedHealed: num(r.healed), failed: num(r.failed), skipped: num(r.skipped), errors: num(r.errors) },
    readiness: optStr(r.readiness), readinessScore: optNum(r.readiness_score), evidenceHead: optStr(r.evidence_head), verified: num(r.verified) === 1,
    state: String(r.state ?? ''), branch: optStr(r.branch), commit: optStr(r.commit_sha), uploadedBy: optStr(r.uploaded_by), uploadedAt: optStr(r.uploaded_at),
    filesBytes: num(r.files_bytes), evidenceDeletedAt: optStr(r.evidence_deleted_at), signed: num(r.signed) === 1, signedBy: optStr(r.signed_by), signedAt: optStr(r.signed_at),
    data: r.data ? (JSON.parse(String(r.data)) as Record<string, unknown>) : {},
  };
}

export interface RetentionPolicy {
  defaultDays?: number;
  projects: Record<string, number>;
}

export class ResultsService {
  readonly audit: AuditLog;

  constructor(
    readonly store: Store,
    readonly dataDir: string,
    readonly opts: { maxUploadBytes: number; retention: RetentionPolicy },
  ) {
    this.audit = new AuditLog(store);
  }

  runDir(project: string, runId: string): string {
    return join(this.dataDir, 'runs', checkName('project', project), checkName('run id', runId));
  }

  packPath(project: string, runId: string): string {
    return join(this.dataDir, 'packs', checkName('project', project), `${checkName('run id', runId)}.zip`);
  }

  async ensureProject(project: string): Promise<void> {
    checkName('project', project);
    await this.store.tryInsert('INSERT INTO ez_projects (project, created_at) VALUES (?, ?)', [project, new Date().toISOString()]);
  }

  async projects(): Promise<Array<{ project: string; retentionDays?: number; runs: number; lastRunAt?: string }>> {
    const ps = await this.store.all('SELECT * FROM ez_projects ORDER BY project');
    const out = [];
    for (const p of ps) {
      const c = await this.store.one('SELECT COUNT(*) AS n, MAX(started_at) AS last FROM ez_runs WHERE project = ?', [String(p.project)]);
      out.push({ project: String(p.project), retentionDays: optNum(p.retention_days), runs: num(c?.n), lastRunAt: optStr(c?.last) });
    }
    return out;
  }

  // ------------------------------------------------------------------ ingest

  /** Step 1: register a run and its evidence manifest; returns the files the server still needs. */
  async beginRun(project: string, body: { run: RunResult; manifest?: string; analysis?: Record<string, unknown>; meta?: Record<string, unknown> }, who: Principal): Promise<{ runId: string; needed: Array<{ path: string; sha256: string }>; optional: string[] }> {
    const run = body.run;
    if (!run || typeof run !== 'object' || !Array.isArray(run.journeys) || typeof run.runId !== 'string') throw new ServiceError(400, '"run" must be a run.json object');
    checkName('run id', run.runId);
    await this.ensureProject(project);
    const existing = await this.store.one('SELECT state FROM ez_runs WHERE project = ? AND run_id = ?', [project, run.runId]);
    if (existing && existing.state === 'complete') throw new ServiceError(409, `Run ${run.runId} was already published to ${project}`);
    const manifest = String(body.manifest ?? '');
    const lines: ManifestLine[] = [];
    for (const l of manifest.split('\n').filter((x) => x.trim())) {
      let e: ManifestLine;
      try {
        e = JSON.parse(l) as ManifestLine;
      } catch {
        throw new ServiceError(400, 'Evidence manifest is not JSON lines');
      }
      checkRelPath(e.path);
      if (!/^[a-f0-9]{64}$/.test(String(e.sha256))) throw new ServiceError(400, `Manifest entry ${e.id}: bad sha256`);
      lines.push(e);
    }
    const dir = this.runDir(project, run.runId);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'evidence-manifest.jsonl'), manifest);
    await writeFile(join(dir, 'run.json'), JSON.stringify(run, null, 2));
    const s = run.summary ?? { total: 0, passed: 0, passedHealed: 0, failed: 0, skipped: 0, errors: 0 };
    const analysis = (body.analysis ?? {}) as { readiness?: { decision?: string; score?: number } };
    const meta = body.meta ?? {};
    await this.store.run('DELETE FROM ez_runs WHERE project = ? AND run_id = ?', [project, run.runId]);
    await this.store.run(
      `INSERT INTO ez_runs (project, run_id, started_at, finished_at, duration_ms, total, passed, healed, failed, skipped, errors, readiness, readiness_score,
        evidence_head, verified, state, branch, commit_sha, uploaded_by, uploaded_at, files_bytes, signed, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`.replace(/\s+/g, ' '),
      [
        project, run.runId, String(run.startedAt ?? new Date().toISOString()), run.finishedAt ?? null, Math.round(num(run.durationMs)),
        s.total, s.passed, s.passedHealed, s.failed, s.skipped, s.errors, analysis.readiness?.decision ?? null, analysis.readiness?.score ?? null,
        run.evidenceHead ?? null, 0, 'uploading', optStr(meta.branch) ?? null, optStr(meta.commit) ?? null, who.id, new Date().toISOString(), 0, 0,
        JSON.stringify({ analysis: body.analysis ?? {}, environment: run.environment ?? {}, meta }),
      ],
    );
    const needed = [...new Map(lines.map((l) => [l.path, { path: l.path, sha256: l.sha256 }])).values()];
    return { runId: run.runId, needed, optional: [...REPORT_FILES] };
  }

  /** Step 2: one file. Evidence files must match their manifest hash; report files are accepted by name. */
  async putFile(project: string, runId: string, relPath: string, body: Readable): Promise<{ path: string; bytes: number; sha256: string }> {
    checkRelPath(relPath);
    const row = await this.store.one('SELECT state FROM ez_runs WHERE project = ? AND run_id = ?', [project, runId]);
    if (!row) throw new ServiceError(404, 'Unknown run (start the upload first)');
    if (row.state !== 'uploading') throw new ServiceError(409, 'Run upload is already complete');
    const dir = this.runDir(project, runId);
    const lines = (await readFile(join(dir, 'evidence-manifest.jsonl'), 'utf8')).split('\n').filter((x) => x.trim()).map((l) => JSON.parse(l) as ManifestLine);
    const expected = lines.find((l) => l.path === relPath)?.sha256;
    if (!expected && !REPORT_FILES.has(relPath)) throw new ServiceError(400, `${relPath} is not in the run's evidence manifest`);
    if (relPath === 'evidence-manifest.jsonl' || relPath === 'run.json') throw new ServiceError(400, `${relPath} is written by the server`);
    const abs = resolve(dir, relPath);
    const rel = relative(dir, abs);
    if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) throw new ServiceError(400, 'Invalid file path');
    await mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.${randomBytes(6).toString('hex')}.part`;
    const hash = createHash('sha256');
    let bytes = 0;
    const max = this.opts.maxUploadBytes;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > max) return cb(new ServiceError(413, 'File too large'));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(body, meter, createWriteStream(tmp));
    } catch (e) {
      await rm(tmp, { force: true });
      throw e instanceof ServiceError ? e : new ServiceError(400, `Upload failed: ${(e as Error).message}`);
    }
    const sha = hash.digest('hex');
    if (expected && sha !== expected) {
      await rm(tmp, { force: true });
      throw new ServiceError(422, `${relPath}: content does not match the evidence manifest`);
    }
    await rename(tmp, abs);
    return { path: relPath, bytes, sha256: sha };
  }

  /** Step 3: verify the evidence chain, index journeys and heals, and record the publish in the audit log. */
  async completeRun(project: string, runId: string, who: Principal): Promise<{ verified: boolean; problems: string[]; entries: number }> {
    const row = await this.store.one('SELECT state, data FROM ez_runs WHERE project = ? AND run_id = ?', [project, runId]);
    if (!row) throw new ServiceError(404, 'Unknown run');
    const dir = this.runDir(project, runId);
    const v = await verifyEvidence(dir);
    const run = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as RunResult;
    if (run.evidenceHead && v.ok && v.head !== run.evidenceHead) v.problems.push(`evidence head ${v.head.slice(0, 16)} differs from run.json ${run.evidenceHead.slice(0, 16)}`);
    const verified = v.problems.length === 0;
    let bytes = 0;
    const walk = async (d: string) => {
      const { readdir } = await import('node:fs/promises');
      for (const e of await readdir(d, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(join(d, e.name));
        else bytes += (await stat(join(d, e.name))).size;
      }
    };
    await walk(dir);
    const data = row.data ? (JSON.parse(String(row.data)) as { analysis?: { triage?: { verdicts?: Array<{ journeyId: string; signature?: string }> } } }) : {};
    const sigs = new Map((data.analysis?.triage?.verdicts ?? []).map((t) => [t.journeyId, t.signature]));
    await this.store.tx(async (tx) => {
      await tx.run('DELETE FROM ez_journeys WHERE project = ? AND run_id = ?', [project, runId]);
      await tx.run('DELETE FROM ez_heals WHERE project = ? AND run_id = ?', [project, runId]);
      for (const j of run.journeys) {
        await tx.run(
          'INSERT INTO ez_journeys (project, run_id, journey_id, name, status, duration_ms, risk, attempt, signature, started_at, requirements, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [project, runId, j.journeyId, j.name, j.status, Math.round(j.durationMs), j.risk, j.attempt, sigs.get(j.journeyId) ?? null, run.startedAt, JSON.stringify(j.requirements ?? []), JSON.stringify(j.tags ?? [])],
        );
        const seenSteps = new Set<string>();
        for (const s of j.steps) {
          // One row per step (a conflicting insert would abort a PostgreSQL transaction).
          if (!s.heal || seenSteps.has(s.stepId)) continue;
          seenSteps.add(s.stepId);
          await tx.tryInsert('INSERT INTO ez_heals (project, run_id, journey_id, step_id, tier, confidence, verified, from_loc, to_loc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
            project, runId, j.journeyId, s.stepId, s.heal.tier, Math.round(s.heal.confidence * 100), s.heal.verified ? 1 : 0, JSON.stringify(s.heal.original), JSON.stringify(s.heal.healed),
          ]);
        }
      }
      await tx.run('UPDATE ez_runs SET state = ?, verified = ?, files_bytes = ? WHERE project = ? AND run_id = ?', ['complete', verified ? 1 : 0, bytes, project, runId]);
    });
    await this.audit.append({ actor: who.id, action: 'run.publish', project, target: runId, details: { journeys: run.journeys.length, verified, evidenceHead: v.head, summary: run.summary } });
    return { verified, problems: v.problems, entries: v.entries };
  }

  async listRuns(project: string, limit = 50, offset = 0): Promise<RunRow[]> {
    return (await this.store.all(`SELECT * FROM ez_runs WHERE project = ?${this.store.page('started_at DESC', limit, offset)}`, [project])).map(runFromRow);
  }

  async getRun(project: string, runId: string): Promise<RunRow | undefined> {
    const r = await this.store.one('SELECT * FROM ez_runs WHERE project = ? AND run_id = ?', [project, runId]);
    return r ? runFromRow(r) : undefined;
  }

  async runJourneys(project: string, runId: string, limit = 500, offset = 0): Promise<Array<Record<string, unknown>>> {
    const rows = await this.store.all(`SELECT * FROM ez_journeys WHERE project = ? AND run_id = ?${this.store.page('journey_id', limit, offset)}`, [project, runId]);
    return rows.map((r) => ({ journeyId: String(r.journey_id), name: String(r.name ?? ''), status: String(r.status), durationMs: num(r.duration_ms), risk: num(r.risk), attempt: num(r.attempt), requirements: JSON.parse(String(r.requirements ?? '[]')) as string[] }));
  }

  /** Run history in the local history-file shape (for durations and flaky scoring). */
  async history(project: string, maxRuns = 200): Promise<RunHistoryEntry[]> {
    const runs = (await this.store.all(`SELECT run_id, started_at FROM ez_runs WHERE project = ? AND state = ?${this.store.page('started_at DESC', maxRuns)}`, [project, 'complete'])).reverse();
    if (!runs.length) return [];
    const byRun = new Map<string, RunHistoryEntry>(runs.map((r) => [String(r.run_id), { runId: String(r.run_id), startedAt: String(r.started_at), outcomes: [] }]));
    const oldest = String(runs[0].started_at);
    for (const j of await this.store.all('SELECT run_id, journey_id, status, duration_ms, attempt, signature FROM ez_journeys WHERE project = ? AND started_at >= ?', [project, oldest])) {
      const e = byRun.get(String(j.run_id));
      if (!e) continue;
      e.outcomes.push({ journeyId: String(j.journey_id), status: String(j.status) as never, durationMs: num(j.duration_ms), attempt: num(j.attempt) || 1, ...(j.signature ? { signature: String(j.signature) } : {}) });
    }
    return [...byRun.values()].filter((r) => r.outcomes.length);
  }

  async durations(project: string, window = 10): Promise<DurationTable> {
    return durationsFromRuns(await this.history(project, 100), window);
  }

  async flaky(project: string): Promise<{ scores: FlakyScore[]; trend: Array<{ runId: string; startedAt: string; flaky: number; passRate: number; healRate: number }> }> {
    const hist = await this.history(project, 60);
    const statuses = new Map<string, Array<RunHistoryEntry['outcomes'][number]['status']>>();
    const trend: Array<{ runId: string; startedAt: string; flaky: number; passRate: number; healRate: number }> = [];
    for (const r of hist) {
      for (const o of r.outcomes) statuses.set(o.journeyId, [...(statuses.get(o.journeyId) ?? []), o.status]);
      let flaky = 0;
      for (const [id, st] of statuses) if (scoreFlakiness(id, st.slice(-20)).state === 'flaky') flaky++;
      const n = r.outcomes.length || 1;
      trend.push({
        runId: r.runId, startedAt: r.startedAt, flaky,
        passRate: Math.round((r.outcomes.filter((o) => o.status === 'passed' || o.status === 'passed-healed').length / n) * 1000) / 1000,
        healRate: Math.round((r.outcomes.filter((o) => o.status === 'passed-healed').length / n) * 1000) / 1000,
      });
    }
    const scores = [...statuses].map(([id, st]) => scoreFlakiness(id, st.slice(-20))).sort((a, b) => a.journeyId.localeCompare(b.journeyId));
    return { scores, trend: trend.slice(-30) };
  }

  /** Requirement -> journeys and their latest status in the newest complete run. */
  async traceability(project: string): Promise<Array<{ requirement: string; journeys: Array<{ journeyId: string; status: string }>; covered: boolean }>> {
    // Only evidence that verified counts as proof of coverage.
    const row = await this.store.one(`SELECT run_id FROM ez_runs WHERE project = ? AND state = ? AND verified = 1${this.store.page('started_at DESC', 1)}`, [project, 'complete']);
    if (!row) return [];
    const latest = { runId: String(row.run_id) };
    const map = new Map<string, Array<{ journeyId: string; status: string }>>();
    for (const j of await this.runJourneys(project, latest.runId, 10_000)) {
      for (const req of j.requirements as string[]) map.set(req, [...(map.get(req) ?? []), { journeyId: String(j.journeyId), status: String(j.status) }]);
    }
    return [...map].sort(([a], [b]) => a.localeCompare(b)).map(([requirement, journeys]) => ({
      requirement, journeys, covered: journeys.every((x) => x.status === 'passed' || x.status === 'passed-healed'),
    }));
  }

  async trendsCsv(project: string): Promise<string> {
    const rows = await this.listRuns(project, 1000);
    const head = 'run_id,started_at,duration_ms,total,passed,passed_healed,failed,skipped,errors,pass_rate,readiness,readiness_score,verified,signed';
    const q = (v: unknown) => {
      const s = v === undefined || v === null ? '' : String(v);
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // no formula injection when opened in a spreadsheet
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const lines = rows.reverse().map((r) => {
      const s = r.summary;
      const rate = s.total ? (s.passed + s.passedHealed) / s.total : 0;
      return [r.runId, r.startedAt, r.durationMs, s.total, s.passed, s.passedHealed, s.failed, s.skipped, s.errors, rate.toFixed(4), r.readiness, r.readinessScore, r.verified, r.signed].map(q).join(',');
    });
    return [head, ...lines].join('\n') + '\n';
  }

  // ------------------------------------------------------------------ heals

  async heals(project: string, limit = 100): Promise<Array<Record<string, unknown>>> {
    const rows = await this.store.all(`SELECT * FROM ez_heals WHERE project = ?${this.store.page('run_id DESC', limit)}`, [project]);
    return rows.map((r) => ({ runId: String(r.run_id), journeyId: String(r.journey_id), stepId: String(r.step_id), tier: String(r.tier), confidence: num(r.confidence) / 100, verified: num(r.verified) === 1, to: JSON.parse(String(r.to_loc ?? 'null')) as unknown }));
  }

  // ------------------------------------------------------------------ shared state

  async getState(project: string, kind: StateKind): Promise<{ data: Record<string, unknown>; updatedAt?: string; updatedBy?: string }> {
    const r = await this.store.one('SELECT * FROM ez_state WHERE project = ? AND kind = ?', [project, kind]);
    const empty = kind === 'heal-decisions' ? { version: 1, decisions: [] } : kind === 'quarantine' ? { version: 1, entries: [] } : { version: 1, overrides: [] };
    return r ? { data: JSON.parse(String(r.data)) as Record<string, unknown>, updatedAt: optStr(r.updated_at), updatedBy: optStr(r.updated_by) } : { data: empty };
  }

  /**
   * Upsert and remove entries of one shared-state kind. Entries are keyed
   * (heal: journey/step/tier/locator; quarantine: journeyId; triage: run/journey);
   * every addition, change and removal is audited with the actor.
   */
  async changeState(project: string, kind: StateKind, change: { upsert?: unknown[]; remove?: string[] }, who: Principal): Promise<{ data: Record<string, unknown>; changes: number }> {
    await this.ensureProject(project);
    const listKey = kind === 'heal-decisions' ? 'decisions' : kind === 'quarantine' ? 'entries' : 'overrides';
    const keyOf = stateKey(kind);
    const events: Array<{ action: string; target: string; details: Record<string, unknown> }> = [];
    const out = await this.store.tx(async (tx) => {
      const r = await tx.one('SELECT data FROM ez_state WHERE project = ? AND kind = ?', [project, kind]);
      const data = r ? (JSON.parse(String(r.data)) as Record<string, unknown>) : { version: 1, [listKey]: [] };
      const list = [...((data[listKey] as Array<Record<string, unknown>>) ?? [])];
      for (const raw of change.upsert ?? []) {
        const e = validateEntry(kind, raw);
        const k = keyOf(e);
        const i = list.findIndex((x) => keyOf(x) === k);
        if (i >= 0 && JSON.stringify(list[i]) === JSON.stringify(e)) continue;
        if (i >= 0) list[i] = e;
        else list.push(e);
        events.push({ action: auditAction(kind, e, i >= 0), target: k, details: e });
      }
      for (const k of change.remove ?? []) {
        const i = list.findIndex((x) => keyOf(x) === k);
        if (i < 0) continue;
        const [gone] = list.splice(i, 1);
        events.push({ action: `${kind === 'heal-decisions' ? 'heal.decision-removed' : kind === 'quarantine' ? 'quarantine.remove' : 'triage.override-removed'}`, target: k, details: gone });
      }
      const next = { ...data, version: 1, [listKey]: list };
      await tx.run('DELETE FROM ez_state WHERE project = ? AND kind = ?', [project, kind]);
      await tx.run('INSERT INTO ez_state (project, kind, data, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)', [project, kind, JSON.stringify(next), new Date().toISOString(), who.id]);
      return next;
    });
    for (const e of events) await this.audit.append({ actor: who.id, action: e.action, project, target: e.target, details: e.details });
    return { data: out, changes: events.length };
  }

  // ------------------------------------------------------------------ readiness sign-off and packs

  async signReadiness(project: string, runId: string, note: string, who: Principal): Promise<RunRow> {
    const run = await this.getRun(project, runId);
    if (!run) throw new ServiceError(404, 'Unknown run');
    if (run.state !== 'complete') throw new ServiceError(409, 'Run upload is not complete');
    if (!run.verified) throw new ServiceError(409, 'Run evidence did not verify; it cannot be signed');
    const at = new Date().toISOString();
    await this.store.run('UPDATE ez_runs SET signed = 1, signed_by = ?, signed_at = ? WHERE project = ? AND run_id = ?', [who.id, at, project, runId]);
    await this.audit.append({ actor: who.id, action: 'readiness.sign', project, target: runId, details: { decision: run.readiness ?? null, score: run.readinessScore ?? null, evidenceHead: run.evidenceHead ?? null, note } });
    return (await this.getRun(project, runId))!;
  }

  async putPack(project: string, runId: string, body: Readable, who: Principal): Promise<{ bytes: number; sha256: string }> {
    const run = await this.getRun(project, runId);
    if (!run) throw new ServiceError(404, 'Unknown run');
    const path = this.packPath(project, runId);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomBytes(6).toString('hex')}.part`;
    const hash = createHash('sha256');
    let bytes = 0;
    const max = this.opts.maxUploadBytes;
    try {
      await pipeline(body, new Transform({
        transform(c: Buffer, _e, cb) {
          bytes += c.length;
          if (bytes > max) return cb(new ServiceError(413, 'Pack too large'));
          hash.update(c);
          cb(null, c);
        },
      }), createWriteStream(tmp));
    } catch (e) {
      await rm(tmp, { force: true });
      throw e instanceof ServiceError ? e : new ServiceError(400, `Upload failed: ${(e as Error).message}`);
    }
    const head = await readFile(tmp).then((b) => b.subarray(0, 4));
    if (head.readUInt32LE(0) !== 0x04034b50) {
      await rm(tmp, { force: true });
      throw new ServiceError(400, 'An evidence pack must be a ZIP file');
    }
    await rename(tmp, path);
    const sha = hash.digest('hex');
    await this.audit.append({ actor: who.id, action: 'pack.upload', project, target: runId, details: { bytes, sha256: sha } });
    return { bytes, sha256: sha };
  }

  // ------------------------------------------------------------------ locks

  async acquireLock(project: string, key: string, owner: string, ttlMs: number): Promise<{ token: string; expiresAt: number } | { holder: string; expiresAt: number }> {
    if (typeof key !== 'string' || !key || key.length > 290) throw new ServiceError(400, 'Invalid lock key');
    const ttl = Math.max(1000, Math.min(3_600_000, Math.floor(ttlMs || 120_000)));
    const token = randomBytes(18).toString('base64url');
    const now = Date.now();
    if (await this.store.tryInsert('INSERT INTO ez_locks (project, lock_key, owner, token, expires_at) VALUES (?, ?, ?, ?, ?)', [project, key, owner, token, now + ttl])) {
      return { token, expiresAt: now + ttl };
    }
    // Take over an expired lease atomically.
    const took = await this.store.run('UPDATE ez_locks SET owner = ?, token = ?, expires_at = ? WHERE project = ? AND lock_key = ? AND expires_at < ?', [owner, token, now + ttl, project, key, now]);
    if (took > 0) return { token, expiresAt: now + ttl };
    const h = await this.store.one('SELECT owner, expires_at FROM ez_locks WHERE project = ? AND lock_key = ?', [project, key]);
    return { holder: String(h?.owner ?? 'unknown'), expiresAt: num(h?.expires_at) };
  }

  async renewLock(project: string, key: string, token: string, ttlMs: number): Promise<boolean> {
    const ttl = Math.max(1000, Math.min(3_600_000, Math.floor(ttlMs || 120_000)));
    return (await this.store.run('UPDATE ez_locks SET expires_at = ? WHERE project = ? AND lock_key = ? AND token = ?', [Date.now() + ttl, project, key, token])) > 0;
  }

  async releaseLock(project: string, key: string, token: string): Promise<boolean> {
    return (await this.store.run('DELETE FROM ez_locks WHERE project = ? AND lock_key = ? AND token = ?', [project, key, token])) > 0;
  }

  // ------------------------------------------------------------------ retention

  async setRetention(project: string, days: number | null, who: Principal): Promise<void> {
    await this.ensureProject(project);
    await this.store.run('UPDATE ez_projects SET retention_days = ? WHERE project = ?', [days, project]);
    await this.audit.append({ actor: who.id, action: 'retention.set', project, details: { days } });
  }

  async retentionDays(project: string): Promise<number | undefined> {
    const r = await this.store.one('SELECT retention_days FROM ez_projects WHERE project = ?', [project]);
    return optNum(r?.retention_days) ?? this.opts.retention.projects[project] ?? this.opts.retention.defaultDays;
  }

  /**
   * Delete the evidence files of runs older than their project's retention.
   * Run metadata, the audit log and uploaded signed packs are kept; a signed run
   * without an uploaded pack keeps its evidence (it is the only copy of what was signed).
   */
  async applyRetention(who: Principal, now = Date.now()): Promise<{ deleted: Array<{ project: string; runId: string }>; keptSigned: Array<{ project: string; runId: string }> }> {
    const deleted: Array<{ project: string; runId: string }> = [];
    const keptSigned: Array<{ project: string; runId: string }> = [];
    for (const p of await this.projects()) {
      const days = await this.retentionDays(p.project);
      if (!days) continue;
      const cutoff = new Date(now - days * 86_400_000).toISOString();
      const rows = await this.store.all('SELECT run_id, signed FROM ez_runs WHERE project = ? AND started_at < ? AND evidence_deleted_at IS NULL', [p.project, cutoff]);
      for (const r of rows) {
        const runId = String(r.run_id);
        const hasPack = existsSync(this.packPath(p.project, runId));
        if (num(r.signed) === 1 && !hasPack) {
          keptSigned.push({ project: p.project, runId });
          continue;
        }
        await rm(this.runDir(p.project, runId), { recursive: true, force: true });
        await this.store.run('UPDATE ez_runs SET evidence_deleted_at = ? WHERE project = ? AND run_id = ?', [new Date(now).toISOString(), p.project, runId]);
        deleted.push({ project: p.project, runId });
      }
      const n = deleted.filter((d) => d.project === p.project).length;
      if (n) await this.audit.append({ actor: who.id, action: 'retention.apply', project: p.project, details: { days, deletedRuns: n, cutoff } });
    }
    return { deleted, keptSigned };
  }
}

const locKey = (l: unknown) => {
  const c = (l ?? {}) as { strategy?: string; value?: string; name?: string; exact?: boolean };
  return JSON.stringify([c.strategy, c.value, c.name ?? null, c.exact ?? true]);
};

export function stateKey(kind: StateKind): (e: Record<string, unknown>) => string {
  if (kind === 'heal-decisions') return (e) => `${String(e.journeyId)}/${String(e.stepId)}/${String(e.tier)}/${locKey(e.locator)}`;
  if (kind === 'quarantine') return (e) => String(e.journeyId);
  return (e) => `${String(e.runId)}/${String(e.journeyId)}`;
}

/** Tiers a shared heal decision may name (EZTest's deterministic healing ladder). */
const HEAL_DECISION_TIERS: readonly string[] = ['T0-cache', 'T1-fingerprint', 'T2-semantic'];

function validateEntry(kind: StateKind, raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ServiceError(400, 'Each entry must be an object');
  const e = raw as Record<string, unknown>;
  if (kind === 'heal-decisions') {
    if (typeof e.journeyId !== 'string' || typeof e.stepId !== 'string') throw new ServiceError(400, 'A heal decision needs journeyId and stepId');
    if (e.decision !== 'accepted' && e.decision !== 'rejected') throw new ServiceError(400, 'decision must be accepted or rejected');
    if (!HEAL_DECISION_TIERS.includes(String(e.tier))) throw new ServiceError(400, `Unknown heal tier (one of ${HEAL_DECISION_TIERS.join(', ')})`);
    const l = e.locator as { strategy?: unknown; value?: unknown } | undefined;
    if (!l || typeof l.strategy !== 'string' || typeof l.value !== 'string') throw new ServiceError(400, 'A heal decision needs its locator');
    if (typeof e.reviewer !== 'string' || !e.reviewer) throw new ServiceError(400, 'A heal decision needs a reviewer');
  } else if (kind === 'quarantine') {
    const p = validateQuarantineEntry(e);
    if (p.length) throw new ServiceError(400, `Quarantine entry: ${p.join('; ')}`);
  } else {
    if (typeof e.runId !== 'string' || typeof e.journeyId !== 'string' || typeof e.to !== 'string') throw new ServiceError(400, 'A triage override needs runId, journeyId and to');
    if (typeof e.reason !== 'string' || !e.reason.trim()) throw new ServiceError(400, 'A triage override needs a reason');
  }
  return e;
}

function auditAction(kind: StateKind, e: Record<string, unknown>, changed: boolean): string {
  if (kind === 'heal-decisions') return e.decision === 'accepted' ? 'heal.accept' : 'heal.reject';
  if (kind === 'quarantine') return changed ? 'quarantine.change' : 'quarantine.add';
  return 'triage.override';
}
