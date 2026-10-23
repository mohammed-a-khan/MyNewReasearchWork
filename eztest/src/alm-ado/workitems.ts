/** Work item helpers shared by import, sync, boards and traceability: batch reads, WIQL, links and comments. */
import { EzTestError } from '../core/index.js';
import type { AdoClient } from './client.js';

export interface WorkItem {
  id: number;
  rev?: number;
  fields: Record<string, unknown>;
  relations?: Array<{ rel: string; url: string; attributes?: Record<string, unknown> }>;
  url?: string;
}

export const wiqlString = (s: string) => s.replace(/'/g, "''");

/** Web URL of a work item (for links in journeys, comments and reports). */
export function workItemWebUrl(c: AdoClient, id: number): string {
  return `${c.projectUrl}/_workitems/edit/${id}`;
}

/** REST URL of a work item, as used in relations. */
export function workItemApiUrl(c: AdoClient, id: number): string {
  return c.collection(`/_apis/wit/workItems/${id}`);
}

/** Id at the end of a work item relation URL. */
export function relationId(url: string): number | undefined {
  const m = /\/workItems\/(\d+)$/i.exec(url);
  return m ? Number(m[1]) : undefined;
}

/** Read work items in batches of 200 (workitemsbatch), keeping the requested order. */
export async function getWorkItems(c: AdoClient, ids: number[], o: { fields?: string[]; relations?: boolean } = {}): Promise<WorkItem[]> {
  const uniq = [...new Set(ids)];
  const byId = new Map<number, WorkItem>();
  for (let i = 0; i < uniq.length; i += 200) {
    const batch = uniq.slice(i, i + 200);
    const body: Record<string, unknown> = { ids: batch, errorPolicy: 'Omit' };
    // The API refuses fields together with $expand=Relations: relations bring every field.
    if (o.relations) body.$expand = 'Relations';
    else if (o.fields) body.fields = o.fields;
    const r = await c.request<{ value?: Array<WorkItem | null> }>('POST', '/_apis/wit/workitemsbatch', { body, idempotent: true });
    for (const w of r.data?.value ?? []) if (w) byId.set(w.id, w);
  }
  return uniq.map((id) => byId.get(id)).filter((w): w is WorkItem => !!w);
}

/** Ids a WIQL query returns (text, or a saved query id / path). Flat and tree (link) queries both work. */
export async function wiqlIds(c: AdoClient, q: { wiql?: string; savedQuery?: string; top?: number }): Promise<number[]> {
  let data: { workItems?: Array<{ id: number }>; workItemRelations?: Array<{ target?: { id: number } }> } | undefined;
  if (q.wiql) {
    if (!/^\s*select\b/i.test(q.wiql)) throw new EzTestError('WIQL must be a SELECT statement', 'INVALID_INPUT');
    data = (await c.request<typeof data>('POST', '/_apis/wit/wiql', { body: { query: q.wiql }, query: { $top: q.top ?? 20000 }, idempotent: true })).data;
  } else if (q.savedQuery) {
    let id = q.savedQuery;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      // A query path ("Shared Queries/Regression"): look it up first.
      const r = await c.request<{ id: string }>('GET', `/_apis/wit/queries/${id.split('/').map(encodeURIComponent).join('/')}`);
      id = r.data.id;
    }
    data = (await c.request<typeof data>('GET', `/_apis/wit/wiql/${encodeURIComponent(id)}`, { query: { $top: q.top ?? 20000 } })).data;
  } else throw new EzTestError('wiqlIds: wiql or savedQuery is required', 'INVALID_INPUT');
  const ids = [...(data?.workItems ?? []).map((w) => w.id), ...(data?.workItemRelations ?? []).map((r) => r.target?.id).filter((x): x is number => !!x)];
  return [...new Set(ids)];
}

/** JSON Patch for a work item update (application/json-patch+json). */
export async function patchWorkItem(c: AdoClient, id: number, ops: Array<Record<string, unknown>>, o: { bypassRules?: boolean } = {}): Promise<WorkItem> {
  return (await c.request<WorkItem>('PATCH', `/_apis/wit/workitems/${id}`, { body: ops, contentType: 'application/json-patch+json', idempotent: true, ...(o.bypassRules ? { query: { bypassRules: true } } : {}) })).data;
}

export async function createWorkItem(c: AdoClient, type: string, ops: Array<Record<string, unknown>>): Promise<WorkItem> {
  return (await c.request<WorkItem>('POST', `/_apis/wit/workitems/$${encodeURIComponent(type)}`, { body: ops, contentType: 'application/json-patch+json' })).data;
}

/** Work item comments (Boards discussion). Updates EZTest's own comment (found by marker) in place. */
export async function upsertWorkItemComment(c: AdoClient, id: number, marker: string, html: string): Promise<{ id: number; action: 'created' | 'updated' | 'unchanged' }> {
  const text = `${html}${marker}`;
  const list = await c.request<{ comments?: Array<{ id: number; text: string }> }>('GET', `/_apis/wit/workItems/${id}/comments`, { preview: 'preview.4', query: { $top: 200 } });
  const mine = list.data?.comments?.find((x) => x.text?.includes(marker));
  if (mine) {
    if (mine.text === text) return { id: mine.id, action: 'unchanged' };
    await c.request('PATCH', `/_apis/wit/workItems/${id}/comments/${mine.id}`, { preview: 'preview.4', body: { text }, idempotent: true });
    return { id: mine.id, action: 'updated' };
  }
  const r = await c.request<{ id: number }>('POST', `/_apis/wit/workItems/${id}/comments`, { preview: 'preview.4', body: { text } });
  return { id: r.data.id, action: 'created' };
}
