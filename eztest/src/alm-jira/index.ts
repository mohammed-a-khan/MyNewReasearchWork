/**
 * Jira integration (Cloud and Data Center), mirroring src/alm-ado:
 * - deduplicated bug filing from triage: one open bug per failure signature
 *   (label `ezsig-<hash>`); a repeat failure adds a comment instead of a
 *   duplicate; evidence files are attached; the run is linked to the issue;
 * - requirements pulled with JQL into traceability (uncovered ones are gaps).
 * Auth: Cloud uses email + API token (Basic), Data Center a personal access
 * token (Bearer). Secrets come through the Identity Vault (secret://...).
 */
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { EvidenceRef, JourneyResult, RunResult } from '../core/index.js';
import { EzTestError } from '../core/index.js';
import { failureSignature } from '../insights/signature.js';
import { failingStep } from '../insights/triage.js';
import type { RequirementInfo } from '../insights/traceability.js';

export interface JiraClientOptions {
  baseUrl: string;
  /** cloud: email + apiToken; datacenter: token (PAT). */
  deployment?: 'cloud' | 'datacenter';
  email?: string;
  apiToken?: string;
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class JiraClient {
  readonly base: string;
  readonly cloud: boolean;
  private readonly f: typeof fetch;

  constructor(readonly o: JiraClientOptions) {
    this.base = o.baseUrl.replace(/\/+$/, '');
    this.cloud = (o.deployment ?? (/\.atlassian\.net$/i.test(new URL(this.base).hostname) ? 'cloud' : o.token ? 'datacenter' : 'cloud')) === 'cloud';
    this.f = o.fetch ?? fetch;
  }

  get api(): string {
    return `/rest/api/${this.cloud ? 3 : 2}`;
  }

  private auth(): string {
    if (this.o.token) return `Bearer ${this.o.token}`;
    if (this.o.email && this.o.apiToken) return `Basic ${Buffer.from(`${this.o.email}:${this.o.apiToken}`).toString('base64')}`;
    throw new EzTestError('Jira needs email + apiToken (Cloud) or token (Data Center PAT)', 'JIRA_AUTH');
  }

  async request<T>(method: string, path: string, body?: unknown, extra: { form?: FormData } = {}): Promise<T> {
    const headers: Record<string, string> = { authorization: this.auth(), accept: 'application/json' };
    let payload: BodyInit | undefined;
    if (extra.form) {
      headers['x-atlassian-token'] = 'no-check';
      payload = extra.form;
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const r = await this.f(`${this.base}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000) });
    const text = await r.text();
    if (!r.ok) throw new EzTestError(`Jira ${method} ${path} returned HTTP ${r.status}: ${text.slice(0, 300)}`, 'JIRA_HTTP', { status: r.status });
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Issues matching a JQL query (paged). */
  async search(jql: string, fields: string[] = ['summary', 'status', 'labels'], max = 1000): Promise<Array<{ key: string; fields: Record<string, unknown> }>> {
    const out: Array<{ key: string; fields: Record<string, unknown> }> = [];
    if (this.cloud) {
      let next: string | undefined;
      do {
        const r = await this.request<{ issues: Array<{ key: string; fields: Record<string, unknown> }>; nextPageToken?: string }>('POST', '/rest/api/3/search/jql', { jql, fields, maxResults: 100, ...(next ? { nextPageToken: next } : {}) });
        out.push(...(r.issues ?? []));
        next = r.nextPageToken;
      } while (next && out.length < max);
    } else {
      let startAt = 0;
      for (;;) {
        const r = await this.request<{ issues: Array<{ key: string; fields: Record<string, unknown> }>; total: number }>('POST', '/rest/api/2/search', { jql, fields, startAt, maxResults: 100 });
        out.push(...(r.issues ?? []));
        startAt += r.issues?.length ?? 0;
        if (!r.issues?.length || startAt >= r.total || out.length >= max) break;
      }
    }
    return out.slice(0, max);
  }

  /** Plain text in the API's format (Atlassian Document Format on Cloud). */
  text(paragraphs: string[]): unknown {
    if (!this.cloud) return paragraphs.join('\n\n');
    return { type: 'doc', version: 1, content: paragraphs.map((p) => ({ type: 'paragraph', content: p ? [{ type: 'text', text: p }] : [] })) };
  }
}

const jqlString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export interface JiraBugOptions {
  client: JiraClient;
  projectKey: string;
  run: RunResult;
  runDir: string;
  journeyId: string;
  evidence: EvidenceRef[];
  classification?: { category: string; confidence?: number; reasons?: string[] };
  issueType?: string;
  extraLabels?: string[];
  runUrl?: string;
  maxAttachments?: number;
  maxAttachmentBytes?: number;
  /** Print what would be sent, send nothing. */
  dryRun?: boolean;
}

export interface JiraBugResult {
  key: string;
  action: 'created' | 'commented' | 'dry-run';
  signature: string;
  attachments: string[];
  warnings: string[];
  plan?: unknown;
}

export async function findJiraBug(c: JiraClient, projectKey: string, signature: string): Promise<string | undefined> {
  const hits = await c.search(`project = ${jqlString(projectKey)} AND labels = ${jqlString(`ezsig-${signature}`)} AND statusCategory != Done ORDER BY created ASC`, ['summary'], 1);
  return hits[0]?.key;
}

/** File (or comment on) the bug for one failed journey. */
export async function fileJiraBug(o: JiraBugOptions): Promise<JiraBugResult> {
  const c = o.client;
  const j: JourneyResult | undefined = o.run.journeys.find((x) => x.journeyId === o.journeyId);
  if (!j) throw new EzTestError(`Journey ${o.journeyId} is not in run ${o.run.runId}`, 'INVALID_INPUT');
  const f = failingStep(j);
  const err = f?.error ?? j.error;
  const message = err?.message ?? `Journey ${j.journeyId} ${j.status} at step ${f?.stepId ?? '?'}`;
  const sig = failureSignature({ message, stack: err?.stack, name: err?.name });
  const warnings: string[] = [];
  const ids = [...new Set([...(f?.evidence ?? []), ...(f?.heal?.evidence ?? [])])].slice(0, o.maxAttachments ?? 6);
  const cls = o.classification;
  const body = [
    `Journey: ${j.name} (${j.journeyId}), EZTest run ${o.run.runId}${o.runUrl ? ` - ${o.runUrl}` : ''}`,
    ...(cls ? [`Triage: ${cls.category}${cls.confidence !== undefined ? ` (${Math.round(cls.confidence * 100)}%)` : ''}${cls.reasons?.length ? `: ${cls.reasons.join('; ')}` : ''}`] : []),
    `Steps:\n${j.steps.map((s, i) => `${i + 1}. [${s.status}] ${s.intent}`).join('\n')}`,
    `Failure: ${message.slice(0, 2000)}`,
    `Evidence ids: ${ids.join(', ') || 'none'} (hash-chained in the run's evidence manifest). Signature: ${sig.hash}`,
  ];
  const summary = `[EZTest] ${j.name}: ${sig.normalized}`.replace(/\s+/g, ' ').slice(0, 250);
  if (o.dryRun) {
    return { key: '(dry run)', action: 'dry-run', signature: sig.hash, attachments: ids, warnings, plan: { summary, labels: ['eztest', `ezsig-${sig.hash}`, ...(o.extraLabels ?? [])], description: body } };
  }
  const existing = await findJiraBug(c, o.projectKey, sig.hash);
  let key: string;
  let action: JiraBugResult['action'];
  if (existing) {
    key = existing;
    action = 'commented';
    await c.request('POST', `${c.api}/issue/${encodeURIComponent(key)}/comment`, { body: c.text([`Failed again in EZTest run ${o.run.runId}${o.runUrl ? ` (${o.runUrl})` : ''}.`, `Failure: ${message.slice(0, 1000)}`]) });
  } else {
    const created = await c.request<{ key: string }>('POST', `${c.api}/issue`, {
      fields: { project: { key: o.projectKey }, issuetype: { name: o.issueType ?? 'Bug' }, summary, description: c.text(body), labels: ['eztest', `ezsig-${sig.hash}`, ...(o.extraLabels ?? [])] },
    });
    key = created.key;
    action = 'created';
  }
  const attachments: string[] = [];
  const byId = new Map(o.evidence.map((e) => [e.id, e]));
  for (const id of action === 'created' ? ids : []) {
    const ev = byId.get(id);
    if (!ev) {
      warnings.push(`evidence ${id} is not in the manifest; not attached`);
      continue;
    }
    const abs = resolve(o.runDir, ev.path);
    const rel = relative(o.runDir, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new EzTestError(`evidence path escapes the run directory: ${ev.path}`, 'PATH_ESCAPE');
    const size = (await stat(join(o.runDir, rel))).size;
    if (size > (o.maxAttachmentBytes ?? 10 * 1024 * 1024)) {
      warnings.push(`evidence ${id} is too large to attach`);
      continue;
    }
    const form = new FormData();
    const name = `${id}-${basename(ev.path)}`;
    form.append('file', new Blob([new Uint8Array(await readFile(join(o.runDir, rel)))]), name);
    await c.request('POST', `${c.api}/issue/${encodeURIComponent(key)}/attachments`, undefined, { form });
    attachments.push(name);
  }
  if (o.runUrl) {
    await c.request('POST', `${c.api}/issue/${encodeURIComponent(key)}/remotelink`, { globalId: `eztest:${o.run.runId}`, object: { url: o.runUrl, title: `EZTest run ${o.run.runId}` } }).catch((e: Error) => warnings.push(`run link not added: ${e.message}`));
  }
  return { key, action, signature: sig.hash, attachments, warnings };
}

/** Requirements from a JQL query, for computeTraceability (uncovered ones become gaps). */
export async function jiraRequirements(c: JiraClient, jql: string): Promise<RequirementInfo[]> {
  const issues = await c.search(jql, ['summary', 'status', 'components']);
  return issues.map((i) => ({
    id: i.key,
    title: typeof i.fields.summary === 'string' ? i.fields.summary : undefined,
    state: (i.fields.status as { name?: string } | undefined)?.name,
    area: ((i.fields.components as Array<{ name: string }> | undefined) ?? []).map((x) => x.name).join(', ') || undefined,
    source: 'jira',
  }));
}
