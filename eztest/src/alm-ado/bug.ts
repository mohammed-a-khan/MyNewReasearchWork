/**
 * File one triaged failure as an Azure DevOps Bug, the way `publishRun` does
 * for a whole run: deduplicated by failure signature (an `ezsig-<hash>` tag,
 * found with WIQL among open bugs), with repro steps, the cited evidence ids,
 * and the evidence files uploaded as work item attachments.
 */
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { EvidenceRef, JourneyResult, RunResult } from '../core/index.js';
import { EzTestError } from '../core/index.js';
import { failureSignature } from '../insights/signature.js';
import { failingStep as innermostFailingStep } from '../insights/triage.js';
import { escapeHtml } from '../report/escape.js';
import type { AdoClient } from './client.js';
import { parseAdoTags } from './tags.js';

export interface FileBugOptions {
  client: AdoClient;
  run: RunResult;
  runDir: string;
  journeyId: string;
  evidence: EvidenceRef[];
  /** Evidence ids to attach (cited by triage). Default: the failing step's evidence. */
  evidenceIds?: string[];
  /** Triage classification and reasons, written into the repro steps. */
  classification?: { category: string; confidence?: number; reasons?: string[] };
  areaPath?: string;
  iterationPath?: string;
  /** Assigned To (e.g. the journey's owner from CODEOWNERS). */
  assignedTo?: string;
  /** Link the requirements (numeric `Requirements:` ids) the journey traces to (default true). */
  linkRequirements?: boolean;
  extraTags?: string[];
  maxAttachmentBytes?: number;
  maxAttachments?: number;
}

export interface FileBugResult {
  id: number;
  action: 'created' | 'deduped';
  url: string;
  signature: string;
  attachments: string[];
  warnings: string[];
}

function wiql(s: string): string {
  return s.replace(/'/g, "''");
}

function failingStep(j: JourneyResult) {
  return innermostFailingStep(j);
}

/** WIQL lookup of an open bug carrying the signature tag. */
export async function findBugBySignature(c: AdoClient, signature: string): Promise<number | undefined> {
  const q = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = 'Bug' AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved') AND [System.Tags] CONTAINS '${wiql(`ezsig-${signature}`)}' ORDER BY [System.Id]`;
  const r = await c.request<{ workItems?: Array<{ id: number }> }>('POST', '/_apis/wit/wiql', { body: { query: q }, idempotent: true });
  return r.data?.workItems?.[0]?.id;
}

export async function fileBug(o: FileBugOptions): Promise<FileBugResult> {
  const c = o.client;
  const j = o.run.journeys.find((x) => x.journeyId === o.journeyId);
  if (!j) throw new EzTestError(`Journey ${o.journeyId} is not in run ${o.run.runId}`, 'INVALID_INPUT');
  if (j.status !== 'failed' && j.status !== 'error') throw new EzTestError(`Journey ${o.journeyId} did not fail in run ${o.run.runId}`, 'INVALID_INPUT');
  const f = failingStep(j);
  const err = f?.error ?? j.error;
  const message = err?.message ?? `Journey ${j.journeyId} ${j.status} at step ${f?.stepId ?? '?'}`;
  const sig = failureSignature({ message, stack: err?.stack, name: err?.name });
  const warnings: string[] = [];
  const webUrl = (id: number) => `${c.projectUrl}/_workitems/edit/${id}`;

  const existing = await findBugBySignature(c, sig.hash);
  if (existing !== undefined) return { id: existing, action: 'deduped', url: webUrl(existing), signature: sig.hash, attachments: [], warnings };

  // Upload evidence first so the bug is created with its attachments in one write.
  const ids = o.evidenceIds ?? [...new Set([...(f?.evidence ?? []), ...(f?.heal?.evidence ?? [])])];
  const byId = new Map(o.evidence.map((e) => [e.id, e]));
  const maxBytes = o.maxAttachmentBytes ?? 10 * 1024 * 1024;
  const uploaded: Array<{ url: string; name: string; comment: string }> = [];
  for (const id of ids.slice(0, o.maxAttachments ?? 6)) {
    const ev = byId.get(id);
    if (!ev) {
      warnings.push(`evidence ${id} is not in the manifest; not attached`);
      continue;
    }
    const abs = resolve(o.runDir, ev.path);
    const rel = relative(o.runDir, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new EzTestError(`evidence path escapes the run directory: ${ev.path}`, 'PATH_ESCAPE');
    const file = join(o.runDir, rel);
    const size = (await stat(file)).size;
    if (size > maxBytes) {
      warnings.push(`evidence ${id} (${size} bytes) exceeds ${maxBytes}; not attached`);
      continue;
    }
    const name = `${id}-${basename(ev.path)}`;
    const r = await c.request<{ url: string }>('POST', '/_apis/wit/attachments', {
      query: { fileName: name, uploadType: 'Simple' },
      body: await readFile(file),
      contentType: 'application/octet-stream',
    });
    if (r.data?.url) uploaded.push({ url: r.data.url, name, comment: `EZTest evidence ${id} (${ev.kind}, sha256 ${ev.sha256.slice(0, 16)}...)` });
  }

  const cls = o.classification;
  const repro = `<p><b>Journey:</b> ${escapeHtml(j.name)} (<code>${escapeHtml(j.journeyId)}</code>), EZTest run ${escapeHtml(o.run.runId)}</p>
${cls ? `<p><b>Triage:</b> ${escapeHtml(cls.category)}${cls.confidence !== undefined ? ` (${Math.round(cls.confidence * 100)}%)` : ''}${(cls.reasons ?? []).length ? `: ${escapeHtml(cls.reasons!.join('; '))}` : ''}</p>` : ''}
<ol>${j.steps.map((s) => `<li>[${escapeHtml(s.status)}] ${escapeHtml(s.intent)}</li>`).join('')}</ol>
<p><b>Failure:</b></p><pre>${escapeHtml(message.slice(0, 2000))}</pre>
<p><b>Evidence ids:</b> ${escapeHtml(ids.join(', ') || 'none')} (hash-chained in the run's evidence manifest)</p><p><b>Signature:</b> ${escapeHtml(sig.hash)}</p>`;
  const ops: Array<Record<string, unknown>> = [
    { op: 'add', path: '/fields/System.Title', value: `[EZTest] ${j.name}: ${sig.normalized}`.slice(0, 250) },
    { op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: repro },
    { op: 'add', path: '/fields/System.Tags', value: ['eztest', `ezsig-${sig.hash}`, ...(o.extraTags ?? [])].join('; ') },
  ];
  if (o.areaPath) ops.push({ op: 'add', path: '/fields/System.AreaPath', value: o.areaPath });
  if (o.iterationPath) ops.push({ op: 'add', path: '/fields/System.IterationPath', value: o.iterationPath });
  if (o.assignedTo) ops.push({ op: 'add', path: '/fields/System.AssignedTo', value: o.assignedTo });
  for (const tc of parseAdoTags(j.tags).testCaseIds) {
    ops.push({ op: 'add', path: '/relations/-', value: { rel: 'Microsoft.VSTS.Common.TestedBy-Forward', url: `${c.collectionUrl}/_apis/wit/workItems/${tc}`, attributes: { comment: 'EZTest failing test case' } } });
  }
  if (o.linkRequirements !== false) {
    for (const r of j.requirements.filter((x) => /^\d+$/.test(x.trim()))) {
      ops.push({ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Related', url: `${c.collectionUrl}/_apis/wit/workItems/${r.trim()}`, attributes: { comment: 'EZTest: failing journey traces to this requirement' } } });
    }
  }
  for (const a of uploaded) ops.push({ op: 'add', path: '/relations/-', value: { rel: 'AttachedFile', url: a.url, attributes: { comment: a.comment } } });
  let id: number;
  try {
    id = (await c.request<{ id: number }>('POST', '/_apis/wit/workitems/$Bug', { body: ops, contentType: 'application/json-patch+json' })).data.id;
  } catch (e) {
    // A transient failure may have created it anyway: look before reporting failure.
    const found = await findBugBySignature(c, sig.hash).catch(() => undefined);
    if (found === undefined) throw e;
    warnings.push('bug creation reported an error but the bug exists; not re-sent');
    return { id: found, action: 'deduped', url: webUrl(found), signature: sig.hash, attachments: uploaded.map((u) => u.name), warnings };
  }
  return { id, action: 'created', url: webUrl(id), signature: sig.hash, attachments: uploaded.map((u) => u.name), warnings };
}
