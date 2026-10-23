/**
 * Triage board: failures of a run clustered by signature, classified by the
 * rule-based triage (with reviewer overrides applied), with cited evidence,
 * first-seen run, ADO bug links and Markdown export.
 */
import { join, relative, resolve, sep } from 'node:path';
import type { AdoClient } from '../../alm-ado/index.js';
import { flattenStepResults } from '../../core/index.js';
import { identityVaultFromConfig } from '../../identity/index.js';
import {
  applyTriageOverrides,
  failingStep,
  loadRunArtifacts,
  loadTriageOverrides,
  triageRun,
  type AppliedVerdict,
  type TriageCategory,
} from '../../insights/index.js';
import type { StudioApp } from '../app.js';
import { failureTags } from '../../insights/failure-tags.js';
import { HttpError } from '../http.js';
import { completedRuns, evidenceView, flakyScores, journeyFiles, openHistory, qualityPaths, readJsonFile } from './common.js';

export interface FiledBug {
  runId: string;
  journeyId: string;
  signature: string;
  id: number;
  url: string;
  action: 'created' | 'deduped';
  at: string;
  by?: string;
}

export interface TriageCard {
  id: string;
  signature: string;
  category: TriageCategory;
  /** Category from the rules (before overrides) when it differs. */
  ruleCategory?: TriageCategory;
  message: string;
  error: string;
  size: number;
  cohesion: number;
  confidence: number;
  needsHuman: boolean;
  reasons: string[];
  journeys: Array<{ journeyId: string; name: string; stepId?: string; intent?: string; category: TriageCategory; confidence: number; status: string; override?: AppliedVerdict['override']; evidence: string[]; owners?: string[]; tags?: string[] }>;
  evidence: Array<NonNullable<ReturnType<typeof evidenceView>>>;
  firstSeen?: { runId: string; startedAt: string };
  occurrences: number;
  override?: AppliedVerdict['override'];
  bugs: FiledBug[];
}

export async function triageBoard(app: StudioApp, runId: string) {
  const out = await app.outputDir();
  const dir = join(out, runId);
  const art = await loadRunArtifacts(dir).catch((e: Error) => {
    throw new HttpError(404, e.message);
  });
  const run = art.run;
  const runs = await completedRuns(app);
  const started = new Map(runs.map((r) => [r.runId, r.startedAt ?? '']));
  const failed = run.journeys.filter((j) => j.status === 'failed' || j.status === 'error');
  const paths = await qualityPaths(app);
  const overrides = await loadTriageOverrides(paths.overrides).catch(() => ({ version: 1 as const, overrides: [] }));
  const bugs = (await readJsonFile<{ bugs: FiledBug[] }>(paths.bugs))?.bugs ?? [];
  const base = {
    runId,
    startedAt: run.startedAt,
    summary: run.summary,
    runs: runs.slice(0, 50).map((r) => ({ runId: r.runId, startedAt: r.startedAt, failed: (r.summary?.failed ?? 0) + (r.summary?.errors ?? 0) })),
  };
  if (!failed.length) return { ...base, cards: [] as TriageCard[], counts: {}, warnings: art.warnings };
  const flaky = await flakyScores(app);
  const report = triageRun({ run, evidence: art.evidence, networkLogs: art.networkLogs, flaky });
  const applied = applyTriageOverrides(report, overrides, (id) => started.get(id));
  const evById = new Map(art.evidence.map((e) => [e.id, e]));
  const history = await openHistory(app);
  // Smart tags (new failure, always failing, regressed, flaky) from history.
  const tagsOf = new Map((history?.runs.some((r) => r.runId === runId) ? failureTags(history.runs, runId) : []).map((t) => [t.journeyId, t.tags]));
  const routing = await journeyRouting(app);
  const cards: TriageCard[] = [];
  for (const c of report.clusters) {
    const members = applied.filter((v) => c.members.includes(v.journeyId));
    if (!members.length) continue;
    // Cluster category: the most common member category (ties: highest confidence).
    const tally = new Map<TriageCategory, number>();
    for (const m of members) tally.set(m.category, (tally.get(m.category) ?? 0) + 1 + m.confidence / 10);
    const category = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const rules = new Set(members.map((m) => m.ruleCategory));
    const lead = members.find((m) => m.category === category) ?? members[0];
    const evIds = [...new Set(members.flatMap((m) => m.evidence))];
    const sigs = new Set(members.map((m) => m.signature).filter((x): x is string => !!x));
    // First seen: earliest history run where any member failed with one of these signatures.
    let firstSeen: TriageCard['firstSeen'];
    let occurrences = 0;
    for (const r of history?.runs ?? []) {
      const hit = r.outcomes.some((o) => o.signature && sigs.has(o.signature));
      if (hit) {
        occurrences++;
        if (!firstSeen) firstSeen = { runId: r.runId, startedAt: r.startedAt };
      }
    }
    const jr = (id: string) => run.journeys.find((j) => j.journeyId === id)!;
    const err = (() => {
      const j = jr(lead.journeyId);
      const s = failingStep(j);
      return (s?.error ?? j.error)?.message ?? '';
    })();
    cards.push({
      id: c.id,
      signature: c.signature,
      category,
      ...(rules.size === 1 && [...rules][0] !== category ? { ruleCategory: [...rules][0] } : {}),
      message: c.normalized,
      error: err.slice(0, 4000),
      size: members.length,
      cohesion: c.cohesion,
      confidence: Math.max(...members.map((m) => m.confidence)),
      needsHuman: members.some((m) => m.status === 'needs-human' && !m.override),
      reasons: [...new Set(members.flatMap((m) => m.reasons))].slice(0, 6),
      journeys: members.map((m) => {
        const j = jr(m.journeyId);
        return {
          journeyId: m.journeyId,
          name: m.journeyName,
          stepId: m.stepId,
          intent: flattenStepResults(j.steps).find((x) => x.result.stepId === m.stepId)?.result.intent,
          category: m.category,
          confidence: m.confidence,
          status: j.status,
          override: m.override,
          evidence: m.evidence,
          ...(tagsOf.get(m.journeyId)?.length ? { tags: tagsOf.get(m.journeyId) } : {}),
          ...(routing.ownersOf(m.journeyId).length ? { owners: routing.ownersOf(m.journeyId) } : {}),
        };
      }),
      evidence: evIds.map((id) => evidenceView(runId, evById.get(id))).filter((x): x is NonNullable<typeof x> => !!x),
      firstSeen,
      occurrences,
      override: lead.override,
      bugs: bugs.filter((b) => sigs.has(b.signature) || members.some((m) => m.journeyId === b.journeyId && b.runId === runId)),
    });
  }
  const counts: Record<string, number> = {};
  for (const c of cards) counts[c.category] = (counts[c.category] ?? 0) + c.size;
  return { ...base, cards, counts, warnings: art.warnings };
}

// ------------------------------------------------------------------ routing (CODEOWNERS, area paths)

/**
 * Who owns a journey (CODEOWNERS of its file) and where its bugs go (Assigned
 * To from an e-mail owner or `vcs.owners`, area / iteration from `ado.paths`).
 */
export async function journeyRouting(app: StudioApp): Promise<{ ownersOf(journeyId: string): string[]; bugFields(journeyId: string, tags: string[]): { assignedTo?: string; areaPath?: string; iterationPath?: string } }> {
  const { GitRepo, loadCodeowners, ownersOf, assigneeFor } = await import('../../git/index.js');
  const { areaFor } = await import('../../alm-ado/sync.js');
  let co: Awaited<ReturnType<typeof loadCodeowners>> | undefined;
  let root = app.cwd;
  try {
    const repo = await GitRepo.open(app.cwd);
    root = repo.root;
    co = await loadCodeowners(root);
  } catch {
    co = undefined;
  }
  const files = await journeyFiles(app).catch(() => []);
  const fileOf = (id: string) => (files.find((f) => f.id === id) ?? files.find((f) => id.startsWith(`${f.id}-`)))?.path;
  const repoPath = (p: string) => relative(root, resolve(app.cwd, p)).split(sep).join('/');
  let cfg: { owners: Record<string, string>; areaPath?: string; iterationPath?: string; paths: Array<{ tag?: string; journeys?: string; areaPath?: string; iterationPath?: string }> } = { owners: {}, paths: [] };
  try {
    const c = (await app.config()).config;
    cfg = { owners: c.vcs.owners, areaPath: c.ado.areaPath, iterationPath: c.ado.iterationPath, paths: c.ado.paths };
  } catch {
    // no config: no routing
  }
  const owners = (id: string) => {
    const f = fileOf(id);
    return co && f ? ownersOf(co, repoPath(f)) : [];
  };
  return {
    ownersOf: (id) => owners(id).map((o) => o.raw),
    bugFields: (id, tags) => {
      const assignedTo = assigneeFor(owners(id), cfg.owners);
      const p = areaFor({ tags, path: fileOf(id) }, cfg.paths, { areaPath: cfg.areaPath, iterationPath: cfg.iterationPath });
      return { ...(assignedTo ? { assignedTo } : {}), ...p };
    },
  };
}

// ------------------------------------------------------------------ Azure DevOps

export interface AdoStatus {
  configured: boolean;
  project?: string;
  organizationUrl?: string;
  missing: string[];
  hint: string;
}

export async function adoStatus(app: StudioApp): Promise<AdoStatus> {
  let config: Awaited<ReturnType<StudioApp['config']>>['config'];
  try {
    config = (await app.config()).config;
  } catch (e) {
    return { configured: false, missing: ['config'], hint: `The project config does not load: ${(e as Error).message}` };
  }
  const { adoSettings, hasAdoCredentials } = await import('../../alm-ado/index.js');
  const s = adoSettings(config);
  // PAT, System.AccessToken, a service principal, workload identity or a managed identity (docs/azure-devops.md).
  const missing = [...s.missing, ...(hasAdoCredentials(config) ? [] : ['ado.pat'])];
  const ado = { project: s.project, organizationUrl: s.collectionUrl };
  return {
    configured: missing.length === 0,
    project: ado.project,
    organizationUrl: ado.organizationUrl,
    missing,
    hint: missing.length
      ? `Add ${missing.join(', ')} to eztest.config.yaml, for example:\nado:\n  organizationUrl: https://dev.azure.com/<org>\n  project: <project>\n  pat: secret://env/ADO_PAT   # a PAT with Work Items (Read & write)`
      : `Bugs are filed in ${ado.project} (${ado.organizationUrl}), deduplicated by failure signature.`,
  };
}

/** An authenticated ADO client from config; throws 412 with a setup hint when not configured. */
export async function adoClient(app: StudioApp): Promise<{ client: AdoClient; config: { areaPath?: string } }> {
  const st = await adoStatus(app);
  if (!st.configured) throw new HttpError(412, `Azure DevOps is not configured. ${st.hint}`, { setup: st });
  const loaded = await app.config();
  const { adoClientFromConfig } = await import('../../alm-ado/index.js');
  const vault = identityVaultFromConfig(loaded.config, { cwd: app.cwd, masker: loaded.masker, env: app.env });
  const client = await adoClientFromConfig(loaded.config, { masker: loaded.masker, resolveSecret: (r) => vault.registry.resolve(r) });
  return { client, config: { areaPath: loaded.config.ado.areaPath } };
}
