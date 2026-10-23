/**
 * Read captured sessions from the three input formats and normalise them to
 * CapturedSession (model.ts):
 *   - EZTest capture files (the snippet's CaptureFile), richest;
 *   - HAR (navigations from top-level document responses, API calls from XHR/
 *     fetch entries) — useful even without a DOM;
 *   - rrweb-style event JSON: the full snapshot builds a node map, and
 *     incremental mouse-click and input events resolve to their element.
 *
 * Input values are treated as masked unless the capture format marks them as
 * allow-listed; rrweb input text is never kept (rrweb masks it, and we do not
 * trust it to carry real values).
 */
import type { CaptureFile, CapturedSession, ElementDescriptor, SemanticEvent } from './model.js';

export type SessionFormat = 'eztest' | 'har' | 'rrweb';

export function detectSessionFormat(doc: unknown): SessionFormat | undefined {
  if (!doc || typeof doc !== 'object') return undefined;
  const o = doc as Record<string, unknown>;
  if (o.eztestCapture) return 'eztest';
  if (o.log && typeof o.log === 'object' && 'entries' in (o.log as object)) return 'har';
  if (Array.isArray(o) || Array.isArray(o.events)) {
    const arr = (Array.isArray(o) ? o : o.events) as Array<{ type?: number }>;
    if (arr.some((e) => typeof e?.type === 'number')) return 'rrweb';
  }
  if (Array.isArray(doc) && (doc as Array<{ type?: number }>).some((e) => typeof e?.type === 'number')) return 'rrweb';
  return undefined;
}

export function parseSession(doc: unknown, file: string, idHint: string): CapturedSession | undefined {
  const fmt = detectSessionFormat(doc);
  if (fmt === 'eztest') return fromEztest(doc as CaptureFile, file, idHint);
  if (fmt === 'har') return fromHar(doc as HarDoc, file, idHint);
  if (fmt === 'rrweb') return fromRrweb(doc, file, idHint);
  return undefined;
}

function fromEztest(doc: CaptureFile, file: string, id: string): CapturedSession {
  const events = (doc.events ?? []).filter((e) => e && typeof (e as { kind?: string }).kind === 'string');
  return { id, source: 'eztest', file, ...(doc.startedAt ? { startedAt: doc.startedAt } : {}), baseUrl: doc.url ?? firstUrl(events), events };
}

// ------------------------------------------------------------------ HAR

interface HarEntry {
  startedDateTime?: string;
  request: { method: string; url: string };
  response?: { status: number; content?: { mimeType?: string } };
  _resourceType?: string;
}
interface HarDoc {
  log: { entries: HarEntry[]; pages?: Array<{ startedDateTime?: string; title?: string; id?: string }> };
}

function fromHar(doc: HarDoc, file: string, id: string): CapturedSession {
  const entries = [...(doc.log.entries ?? [])].sort((a, b) => Date.parse(a.startedDateTime ?? '0') - Date.parse(b.startedDateTime ?? '0'));
  const events: SemanticEvent[] = [];
  let base: string | undefined;
  for (const e of entries) {
    const t = Date.parse(e.startedDateTime ?? '') || 0;
    const mime = e.response?.content?.mimeType ?? '';
    const type = e._resourceType ?? (/html/.test(mime) ? 'document' : '');
    if (type === 'document' && e.request.method === 'GET') {
      base ??= e.request.url;
      events.push({ kind: 'navigate', url: e.request.url, t });
    } else if (/xhr|fetch/.test(type) || /json|application/.test(mime)) {
      events.push({ kind: 'api', method: e.request.method, url: e.request.url, ...(e.response ? { status: e.response.status } : {}), t });
    }
  }
  return { id, source: 'har', file, ...(base ? { baseUrl: base } : {}), events };
}

// ------------------------------------------------------------------ rrweb

interface RrwebNode {
  id: number;
  type: number; // 1 doctype, 2 element, 3 text, 11 comment
  tagName?: string;
  attributes?: Record<string, string>;
  childNodes?: RrwebNode[];
  textContent?: string;
}

function fromRrweb(doc: unknown, file: string, id: string): CapturedSession {
  const events = (Array.isArray(doc) ? doc : (doc as { events?: unknown[] }).events ?? []) as Array<Record<string, unknown>>;
  const nodes = new Map<number, RrwebNode>();
  const parentText = new Map<number, string>();
  let base: string | undefined;
  let startedAt: string | undefined;
  const out: SemanticEvent[] = [];
  const indexNode = (n: RrwebNode, parent?: RrwebNode) => {
    nodes.set(n.id, n);
    if (n.type === 3 && parent && n.textContent) parentText.set(parent.id, ((parentText.get(parent.id) ?? '') + ' ' + n.textContent).trim());
    for (const c of n.childNodes ?? []) indexNode(c, n);
  };
  const descriptorFor = (nodeId: number): ElementDescriptor | undefined => {
    const n = nodes.get(nodeId);
    if (!n || n.type !== 2) {
      // a text node: climb to its element parent via the index
      const t = nodes.get(nodeId);
      if (t) return undefined;
      return undefined;
    }
    const a = n.attributes ?? {};
    const tag = (n.tagName ?? '').toLowerCase();
    const text = (parentText.get(n.id) ?? '').replace(/\s+/g, ' ').trim();
    const role = a.role ?? (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'select' ? 'combobox' : tag === 'input' ? ((a.type ?? 'text') === 'checkbox' ? 'checkbox' : 'textbox') : tag);
    const d: ElementDescriptor = { tag, role };
    const name = a['aria-label'] || text || a.value;
    if (name && name.length <= 80) d.name = name;
    if (a.placeholder) d.placeholder = a.placeholder;
    if (a['data-testid']) d.testId = a['data-testid'];
    if (a.id) d.id = a.id;
    if (tag === 'input') d.inputType = (a.type ?? 'text').toLowerCase();
    return d;
  };
  for (const ev of events) {
    const type = ev.type as number;
    const t = (ev.timestamp as number) ?? 0;
    if (!startedAt && t) startedAt = new Date(t).toISOString();
    if (type === 4) {
      // Meta: href of the page
      const href = (ev.data as { href?: string } | undefined)?.href;
      if (href) {
        base ??= href;
        out.push({ kind: 'navigate', url: href, t });
      }
    } else if (type === 2) {
      // FullSnapshot: index the node tree
      const node = (ev.data as { node?: RrwebNode } | undefined)?.node;
      if (node) indexNode(node);
    } else if (type === 3) {
      const data = ev.data as { source?: number; type?: number; id?: number; text?: string; href?: string; adds?: Array<{ node: RrwebNode; parentId?: number }> };
      if (data.source === 0 && data.adds) for (const add of data.adds) indexNode(add.node, add.parentId !== undefined ? nodes.get(add.parentId) : undefined);
      if (data.source === 2 && data.type === 2 && data.id !== undefined) {
        // MouseInteraction Click
        const d = descriptorFor(data.id);
        if (d) out.push({ kind: 'click', target: d, t });
      } else if (data.source === 5 && data.id !== undefined) {
        // Input: value is masked; record which field, not the text
        const d = descriptorFor(data.id);
        if (d) out.push({ kind: 'input', target: d, masked: true, t });
      }
    }
  }
  return { id, source: 'rrweb', file, ...(startedAt ? { startedAt } : {}), ...(base ? { baseUrl: base } : {}), events: dedupeInputs(out) };
}

/** Collapse consecutive input events on the same field (rrweb emits one per keystroke). */
function dedupeInputs(events: SemanticEvent[]): SemanticEvent[] {
  const out: SemanticEvent[] = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    if (e.kind === 'input' && prev && prev.kind === 'input' && JSON.stringify(prev.target) === JSON.stringify(e.target)) continue;
    out.push(e);
  }
  return out;
}

function firstUrl(events: SemanticEvent[]): string | undefined {
  const nav = events.find((e) => e.kind === 'navigate') as { url?: string } | undefined;
  return nav?.url ?? (events.find((e) => 'url' in e && (e as { url?: string }).url) as { url?: string } | undefined)?.url;
}
