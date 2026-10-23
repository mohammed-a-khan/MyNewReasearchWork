/**
 * Document assurance: the review of a `compareDocument` step (PDF rendered
 * with highlights at the extracted positions, the three-way field ledger with
 * tolerances and verdicts, line-item reconciliation, PII) and the ad-hoc
 * "Compare documents" workspace (upload or pick PDFs, choose or edit a
 * template, PDF↔PDF diff side by side with synchronised scroll and zoom,
 * reconciliation against a configured document check, bulk regression).
 */
import { api, ApiError } from '../core/api.js';
import { add, clear, h, uid, type Child } from '../core/dom.js';
import { link, navigate } from '../core/router.js';
import { badge, button, card, copyText, emptyState } from '../ui/badge.js';
import { icon } from '../ui/icons.js';
import { confirmDialog, openModal } from '../ui/modal.js';
import { createTabs } from '../ui/tabs.js';
import { toast, toastError } from '../ui/toast.js';
import { createPdfViewer, syncScroll, type PdfViewerHandle, type ViewerHighlight } from './assurance-pdf.js';
import {
  dataTable,
  download,
  errorState,
  field,
  filePicker,
  loadingState,
  pageHeader,
  readAsBase64,
  runPicker,
  segmented,
  sevBadge,
  withStates,
  type SubPageDef,
} from './assurance-ui.js';

// ------------------------------------------------------------------ payload types

interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Highlight extends ViewerHighlight {
  doc: 'a' | 'b';
}

interface DocViewData {
  name: string;
  url: string;
  sha256: string;
  pages: Array<{ number: number; width: number; height: number }>;
  fields: Array<{ name: string; type: string; raw: string; normalized: string; page: number; bbox: BBox; confidence: number }>;
  tables: Array<{ name: string; columns: string[]; rows: Array<{ index: number; page: number; kind: string; bbox: BBox; cells: Record<string, { raw: string; page: number; bbox: BBox }> }> }>;
  findings: Array<{ code: string; severity: string; message: string; page?: number }>;
  pii: Array<{ type: string; page: number; bbox: BBox; masked: string }>;
}

type Source = 'ui' | 'pdf' | 'db';

interface FieldRow {
  name: string;
  values: Record<Source, { raw?: string; normalized?: string; page?: number; note?: string }>;
  verdict: string;
  oddOneOut?: Source;
  diagnosis: string;
  type: string;
  tolerance: string;
}

interface LinesView {
  table: string;
  key: string[];
  columns: string[];
  status: string;
  rows: Array<{ key: string; page: number; bbox: BBox; status: string; cells: Record<string, { raw: string; expected?: string; actual?: string; bad?: boolean }> }>;
  extra: Array<{ key: string; message: string }>;
}

interface ReviewData {
  verdict: { status: 'PASS' | 'FAIL'; headline: string; layer?: string };
  diagnosis: string[];
  fields: FieldRow[];
  lines?: LinesView;
  footing?: { name: string; passed: boolean; message: string };
  highlights: Highlight[];
  document?: DocViewData;
  warnings?: string[];
  check?: string;
}

interface RunDocDetail extends ReviewData {
  step: { journeyId: string; journeyName: string; stepId: string; intent: string; status: string; check?: string };
  unsupported?: string;
}

interface DocChange {
  category: string;
  subject: string;
  before?: string;
  after?: string;
  page?: number;
  description: string;
}

interface CompareResult {
  a: DocViewData;
  b?: DocViewData;
  diff?: { identical: boolean; changes: DocChange[]; summary: Record<string, number> };
  threeWay?: ReviewData;
  highlights: Highlight[];
}

const SOURCE_LABEL: Record<Source, string> = { ui: 'UI (captured)', pdf: 'Document', db: 'Database' };

// ------------------------------------------------------------------ shared viewer chrome

interface ViewerControls {
  el: HTMLElement;
  setCount(cur: number, total: number): void;
}

function viewerToolbar(viewers: () => PdfViewerHandle[], o: { onPrev(): void; onNext(): void; layers: Array<{ id: string; label: string; on: boolean }>; onLayers(hidden: string[]): void; sync?: { get(): boolean; set(v: boolean): void } }): ViewerControls {
  const zoomId = uid('zoom');
  const zoom = h('select', { id: zoomId, class: 'input input-sm', onchange: () => apply(zoom.value) }, [['fit', 'Fit width'], ['0.5', '50%'], ['0.75', '75%'], ['1', '100%'], ['1.25', '125%'], ['1.5', '150%'], ['2', '200%'], ['3', '300%']].map(([v, t]) => h('option', { value: v, text: t })));
  const apply = (v: string) => {
    for (const w of viewers()) w.setScale(v === 'fit' ? 'fit' : Number(v));
  };
  const step = (dir: number) => {
    const cur = viewers()[0]?.scale ?? 1;
    const next = Math.max(0.25, Math.min(4, Math.round((cur + dir * 0.25) * 4) / 4));
    zoom.value = [...zoom.options].some((x) => x.value === String(next)) ? String(next) : zoom.value;
    for (const w of viewers()) w.setScale(next);
  };
  const counter = h('span', { class: 'muted', 'aria-live': 'polite', id: uid('mm-count') });
  const checks = o.layers.map((l) => {
    const id = uid('layer');
    const input = h('input', { type: 'checkbox', id, checked: l.on, onchange: () => o.onLayers(o.layers.filter((x, i) => !inputs[i].checked).map((x) => x.id)) });
    return { input, el: h('label', { class: 'check', for: id }, input, h('span', { text: l.label })) };
  });
  const inputs = checks.map((c) => c.input);
  const syncBox = o.sync ? (() => {
    const id = uid('sync');
    const input = h('input', { type: 'checkbox', id, checked: o.sync.get(), onchange: () => o.sync!.set(input.checked) });
    return h('label', { class: 'check', for: id }, input, h('span', { text: 'Synchronised scroll' }));
  })() : null;
  const el = h(
    'div',
    { class: 'toolbar', role: 'toolbar', 'aria-label': 'Document viewer' },
    button('Zoom out', { small: true, icon: 'zoomOut', onclick: () => step(-1), ariaLabel: 'Zoom out' }),
    h('label', { class: 'sr-only', for: zoomId, text: 'Zoom' }),
    zoom,
    button('Zoom in', { small: true, icon: 'zoomIn', onclick: () => step(1), ariaLabel: 'Zoom in' }),
    h('span', { class: 'sep', 'aria-hidden': 'true' }),
    button('Previous mismatch', { small: true, icon: 'chevronUp', onclick: o.onPrev, title: 'Previous mismatch (P)' }),
    button('Next mismatch', { small: true, icon: 'chevronDown', onclick: o.onNext, title: 'Next mismatch (N)' }),
    counter,
    h('span', { class: 'sep', 'aria-hidden': 'true' }),
    checks.map((c) => c.el),
    syncBox,
  );
  return {
    el,
    setCount(cur, total) {
      counter.textContent = total ? (cur >= 0 ? `Mismatch ${cur + 1} of ${total}` : `${total} mismatch${total === 1 ? '' : 'es'}`) : 'No mismatches';
    },
  };
}

function bindNavKeys(el: HTMLElement, next: () => void, prev: () => void): void {
  el.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (e.key === 'n' || e.key === 'N') (e.preventDefault(), next());
    else if (e.key === 'p' || e.key === 'P') (e.preventDefault(), prev());
  });
}

function verdictBanner(v: ReviewData['verdict'], diagnosis: string[], extra?: Child): HTMLElement {
  const pass = v.status === 'PASS';
  return h(
    'section',
    { class: ['verdict-banner', pass ? 'v-pass' : 'v-fail'], 'aria-label': 'Verdict', id: uid('verdict') },
    h('span', { class: 'verdict-banner-icon' }, icon(pass ? 'check' : 'alert', { size: 22 })),
    h(
      'div',
      { class: 'grow' },
      h('p', { class: 'row wrap' }, badge(pass ? 'ok' : 'bad', pass ? 'PASS' : 'FAIL'), h('span', { class: 'verdict-headline', dataset: { testid: 'verdict' }, text: v.headline })),
      diagnosis.length ? h('ul', { class: 'bullets' }, diagnosis.map((d) => h('li', { text: d }))) : null,
      extra ?? null,
    ),
  );
}

function valueCell(v: FieldRow['values'][Source] | undefined, odd: boolean): Child {
  if (!v || v.raw === undefined) return h('span', { class: 'muted', text: v?.note ?? '—' });
  return h('span', { class: odd ? 'cell-bad' : undefined }, h('code', { text: v.raw }), v.page ? h('span', { class: 'muted', text: ` p.${v.page}` }) : null, odd ? h('span', { class: 'sr-only', text: ' (differs)' }) : null);
}

function ledgerTable(fields: FieldRow[], onShow: (name: string) => void): HTMLElement {
  return dataTable<FieldRow>({
    caption: 'Field ledger: expected versus actual per source',
    rows: fields,
    class: 'ledger',
    rowAttrs: (f) => ({ class: f.verdict === 'ALL_AGREE' ? 'row-ok' : f.verdict === 'INSUFFICIENT_DATA' ? 'row-warn' : 'row-bad', dataset: { ref: f.name } }),
    columns: [
      { title: 'Field', render: (f) => h('div', null, h('strong', { text: f.name }), h('div', { class: 'small muted', text: `${f.type}${f.tolerance ? ` · tolerance ${f.tolerance}` : ''}` })) },
      ...(['ui', 'pdf', 'db'] as Source[]).map((s) => ({ title: SOURCE_LABEL[s], render: (f: FieldRow) => valueCell(f.values[s], f.oddOneOut === s) })),
      { title: 'Verdict', class: 'verdict-cell', render: (f) => h('div', { class: 'stack-sm' }, sevBadge(f.verdict === 'ALL_AGREE' ? 'pass' : f.verdict === 'INSUFFICIENT_DATA' ? 'warn' : 'fail', f.verdict.replace(/_/g, ' ').toLowerCase()), h('p', { class: 'small', text: f.diagnosis })) },
      { title: 'Show in document', srOnly: true, render: (f) => (f.values.pdf?.page ? button('Show', { small: true, icon: 'target', onclick: () => onShow(f.name), ariaLabel: `Show ${f.name} in the document` }) : null) },
    ],
  });
}

function linesTable(lines: LinesView, onShow: (key: string) => void): HTMLElement {
  const cols = lines.columns;
  return h(
    'div',
    { class: 'stack-sm' },
    h('p', { class: 'row wrap' }, h('strong', { text: `Table "${lines.table}"` }), sevBadge(lines.status === 'PASS' ? 'pass' : lines.status === 'FAIL' ? 'fail' : 'neutral', lines.status), h('span', { class: 'muted', text: `key: ${lines.key.join(', ')}` })),
    dataTable<LinesView['rows'][number]>({
      caption: 'Line items: document rows reconciled with database rows',
      rows: lines.rows,
      rowAttrs: (r) => ({ class: r.status === 'ok' ? 'row-ok' : r.status === 'total' ? undefined : 'row-bad', dataset: { key: r.key } }),
      columns: [
        { title: 'Status', render: (r) => sevBadge(r.status === 'ok' ? 'pass' : r.status === 'total' ? 'neutral' : 'fail', r.status.replace(/-/g, ' ')) },
        ...cols.map((c) => ({
          title: c,
          render: (r: LinesView['rows'][number]) => {
            const cell = r.cells[c];
            if (!cell) return '';
            return cell.bad ? h('span', { class: 'cell-bad' }, h('code', { text: cell.raw }), h('span', { class: 'small', text: ` db: ${cell.actual ?? ''}` })) : h('span', { text: cell.raw });
          },
        })),
        { title: 'Show in document', srOnly: true, render: (r) => (r.status !== 'ok' ? button('Show', { small: true, icon: 'target', onclick: () => onShow(r.key), ariaLabel: `Show row ${r.key}` }) : null) },
      ],
    }),
    lines.extra.length ? h('div', { class: 'note note-bad' }, h('strong', { text: 'Rows in the database but not in the document:' }), h('ul', { class: 'bullets' }, lines.extra.map((x) => h('li', { text: `${x.key}: ${x.message}` })))) : null,
  );
}

function piiList(doc: DocViewData | undefined, onShow: (i: number) => void): HTMLElement {
  if (!doc || !doc.pii.length) return emptyState('No PII found', 'No SSN, payment card (Luhn), IBAN (mod-97) or e-mail address in the text layer.');
  return dataTable<DocViewData['pii'][number] & { i: number }>({
    caption: 'PII findings',
    rows: doc.pii.map((p, i) => ({ ...p, i })),
    columns: [
      { title: 'Type', render: (p) => sevBadge('warn', p.type) },
      { title: 'Masked value', render: (p) => h('code', { text: p.masked }) },
      { title: 'Page', render: (p) => String(p.page) },
      { title: 'Show', srOnly: true, render: (p) => button('Show', { small: true, icon: 'target', onclick: () => onShow(p.i), ariaLabel: `Show PII finding ${p.i + 1}` }) },
    ],
  });
}

function extractionPanel(doc: DocViewData | undefined): HTMLElement {
  if (!doc) return emptyState('No document', 'The document could not be extracted.');
  return h(
    'div',
    { class: 'stack' },
    h('p', { class: 'muted small', text: `SHA-256 ${doc.sha256} · ${doc.pages.length} page(s)` }),
    dataTable<DocViewData['fields'][number]>({
      caption: 'Extracted fields',
      rows: doc.fields,
      empty: 'No fields extracted.',
      columns: [
        { title: 'Field', render: (f) => h('strong', { text: f.name }) },
        { title: 'Raw', render: (f) => h('code', { text: f.raw }) },
        { title: 'Normalized', render: (f) => h('code', { text: f.normalized }) },
        { title: 'Page', render: (f) => String(f.page) },
        { title: 'Confidence', render: (f) => `${Math.round(f.confidence * 100)}%` },
      ],
    }),
    doc.findings.length ? h('ul', { class: 'bullets warn-text' }, doc.findings.map((f) => h('li', { text: `${f.code}: ${f.message}` }))) : null,
  );
}

/** Highlights for the viewer: mismatches from the server, PII, and (faint) every agreeing extracted field. */
function viewerHighlights(review: ReviewData, doc: DocViewData | undefined, side: 'a' | 'b' = 'a'): ViewerHighlight[] {
  const list: ViewerHighlight[] = review.highlights.filter((x) => x.doc === side && x.kind !== 'pii').map((x) => ({ ...x, layer: 'mismatch' as const }));
  for (const p of doc?.pii ?? []) list.push({ page: p.page, bbox: p.bbox, kind: 'pii', ref: p.type, severity: 'warning', label: `PII (${p.type}): ${p.masked}`, layer: 'pii' });
  const flagged = new Set(list.filter((x) => x.kind === 'field').map((x) => x.ref));
  const pdfNames = new Map(review.fields.map((f) => [f.name, f]));
  for (const f of doc?.fields ?? []) {
    const canonical = [...pdfNames.values()].find((r) => r.values.pdf?.raw === f.raw && r.values.pdf?.page === f.page)?.name ?? f.name;
    if (flagged.has(canonical)) continue;
    list.push({ page: f.page, bbox: f.bbox, kind: 'field', ref: canonical, severity: 'info', label: `${f.name}: ${f.raw}`, layer: 'field' });
  }
  return list;
}

/** The full review UI for one document check (run step or ad-hoc reconciliation). */
export function renderReview(el: HTMLElement, review: ReviewData, opts: { title?: string; extraBanner?: Child } = {}): () => void {
  const doc = review.document;
  const mismatches = review.highlights.filter((x) => x.doc === 'a' && x.kind !== 'pii').sort((x, y) => x.page - y.page || x.bbox.y - y.bbox.y);
  let cursor = -1;
  let viewer: PdfViewerHandle | undefined;
  const highlightRow = (ref: string | undefined) => {
    for (const r of el.querySelectorAll('tr.row-active')) r.classList.remove('row-active');
    if (!ref) return;
    const row = el.querySelector<HTMLElement>(`tr[data-ref="${CSS.escape(ref)}"]`) ?? el.querySelector<HTMLElement>(`tr[data-key="${CSS.escape(ref.replace(/^.*\[(.*)\].*$/, '$1'))}"]`);
    row?.classList.add('row-active');
    row?.scrollIntoView({ block: 'nearest' });
  };
  const goTo = (i: number) => {
    if (!mismatches.length || !viewer) return;
    cursor = (i + mismatches.length) % mismatches.length;
    const target = mismatches[cursor];
    viewer.reveal((x) => x.ref === target.ref && x.page === target.page && x.bbox.x === target.bbox.x && x.bbox.y === target.bbox.y, { focus: true });
    controls.setCount(cursor, mismatches.length);
    highlightRow(target.ref);
  };
  const controls = viewerToolbar(() => (viewer ? [viewer] : []), {
    onPrev: () => goTo(cursor - 1),
    onNext: () => goTo(cursor + 1),
    layers: [
      { id: 'mismatch', label: 'Mismatches', on: true },
      { id: 'pii', label: 'PII', on: true },
      { id: 'fields', label: 'Extracted fields', on: false },
    ],
    onLayers: (hidden) => viewer?.setLayers(hidden),
  });
  controls.setCount(-1, mismatches.length);

  const viewerHost = h('div', { class: 'doc-viewer-host' });
  if (doc) {
    viewer = createPdfViewer({
      url: doc.url,
      name: doc.name,
      label: `Document ${doc.name}`,
      highlights: viewerHighlights(review, doc),
      onHighlight: (hl) => {
        const i = mismatches.findIndex((m) => m.ref === hl.ref && m.page === hl.page);
        if (i >= 0) {
          cursor = i;
          controls.setCount(cursor, mismatches.length);
        }
        highlightRow(hl.ref);
      },
    });
    viewer.setLayers(['fields']);
    viewerHost.appendChild(viewer.el);
    viewer.ready.catch((e: Error) => viewerHost.replaceChildren(errorState(e)));
  } else viewerHost.appendChild(emptyState('Document not available', (review.warnings ?? []).join(' ') || 'The document could not be displayed.'));

  const showField = (name: string) => {
    const i = mismatches.findIndex((m) => m.ref === name);
    if (i >= 0) return goTo(i);
    viewer?.reveal((x) => x.ref === name, { focus: true });
    highlightRow(name);
  };
  const showRow = (key: string) => {
    const i = mismatches.findIndex((m) => m.ref.includes(`[${key}]`));
    if (i >= 0) goTo(i);
  };
  const panels = createTabs({
    label: 'Comparison details',
    tabs: [
      { id: 'ledger', title: 'Field ledger', badge: review.fields.filter((f) => f.verdict !== 'ALL_AGREE').length || undefined, mount: (p) => add(p, ledgerTable(review.fields, showField), review.footing ? h('p', { class: review.footing.passed ? 'ok-text' : 'bad-text' }, h('strong', { text: 'Footing: ' }), review.footing.message) : null) },
      ...(review.lines ? [{ id: 'lines', title: 'Line items', badge: review.lines.rows.filter((r) => r.status !== 'ok' && r.status !== 'total').length + review.lines.extra.length || undefined, mount: (p: HTMLElement) => p.append(linesTable(review.lines!, showRow)) }] : []),
      { id: 'pii', title: 'PII', badge: doc?.pii.length || undefined, mount: (p) => p.append(piiList(doc, (i) => viewer?.reveal((x) => x.kind === 'pii' && x.page === doc!.pii[i].page && x.bbox.y === doc!.pii[i].bbox.y, { focus: true }))) },
      { id: 'extraction', title: 'Extraction', mount: (p) => p.append(extractionPanel(doc)) },
    ],
    class: 'doc-panels card',
  });
  clear(el).append(
    h(
      'div',
      { class: 'stack' },
      opts.title ? h('h2', { class: 'h3', text: opts.title }) : null,
      verdictBanner(review.verdict, review.diagnosis, opts.extraBanner),
      ...(review.warnings ?? []).map((w) => h('p', { class: 'note note-warn', text: w })),
      controls.el,
      h('div', { class: 'doc-layout' }, viewerHost, panels.el),
    ),
  );
  bindNavKeys(el, () => goTo(cursor + 1), () => goTo(cursor - 1));
  return () => viewer?.destroy();
}

// ------------------------------------------------------------------ run documents

/** The review of one compareDocument step of a run (also used by the run-detail tab). */
export async function mountRunDocument(el: HTMLElement, runId: string, journeyId: string, stepId: string): Promise<() => void> {
  let dispose: () => void = () => undefined;
  const d = await withStates(el, () => api.get<RunDocDetail>(`/api/assurance/documents/runs/${encodeURIComponent(runId)}/${encodeURIComponent(journeyId)}/${encodeURIComponent(stepId)}`), {
    loading: 'Extracting the document and its positions…',
    retry: () => void mountRunDocument(el, runId, journeyId, stepId).then((f) => (dispose = f)),
  });
  if (!d) return dispose;
  if (d.unsupported) {
    el.appendChild(emptyState('Not a three-way comparison', d.unsupported));
    return dispose;
  }
  dispose = renderReview(el, d, {
    extraBanner: h('p', { class: 'small muted' }, `${d.step.journeyName} › `, h('a', { href: link('runs', runId, d.step.journeyId, d.step.stepId), text: d.step.intent }), d.check ? ` · check "${d.check}"` : ''),
  });
  return dispose;
}

interface RunDocItem {
  journeyId: string;
  journeyName: string;
  stepId: string;
  intent: string;
  status: string;
  check?: string;
  passed: boolean;
  verdict?: { status: string; headline: string };
}

export async function runDocumentList(runId: string): Promise<RunDocItem[]> {
  return (await api.get<{ documents: RunDocItem[] }>(`/api/assurance/documents/runs/${encodeURIComponent(runId)}`)).documents;
}

export const documentsSection: SubPageDef = {
  id: 'documents',
  title: 'Document checks',
  icon: 'document',
  description: 'Three-way ledgers of compareDocument steps',
  mount(root) {
    let runId: string | undefined;
    let dispose: () => void = () => undefined;
    const list = h('div', { class: 'doc-list' });
    const detail = h('div', { class: 'doc-detail' });
    const picker = runPicker({ label: 'Run', lens: 'documents', onChange: (id) => navigate(link('assurance', 'documents', id)) });
    root.append(h('div', { class: 'page-inner' }, pageHeader('Document checks', 'Every "Compare document" step: the PDF with mismatches highlighted where they were printed, the UI ↔ document ↔ database ledger and the line items.', [picker.el, button('Compare documents', { icon: 'compare', onclick: () => navigate(link('assurance', 'compare')) })]), list, detail));
    const load = async (segs: string[]) => {
      runId = await picker.set(segs[0]);
      if (!runId) {
        clear(list).appendChild(emptyState('No document checks yet', 'Run a journey with a "Compare document … using …" step (for example "Create an order and verify the invoice three ways") and its review appears here.', button('Go to Run', { icon: 'run', onclick: () => navigate(link('run')) })));
        clear(detail);
        return;
      }
      const items = await withStates(list, () => runDocumentList(runId!), { retry: () => void load(segs) });
      if (!items) return;
      if (!items.length) {
        list.appendChild(emptyState('No document checks in this run', 'This run has no "Compare document" steps.'));
        clear(detail);
        return;
      }
      const sel = items.find((i) => i.journeyId === segs[1] && i.stepId === segs[2]) ?? items[0];
      list.appendChild(
        h('ul', { class: 'list-cards', 'aria-label': 'Document checks in this run' }, items.map((i) =>
          h('li', null, h('a', { class: 'list-card', href: link('assurance', 'documents', runId!, i.journeyId, i.stepId), 'aria-current': String(i === sel) },
            h('span', { class: 'row' }, sevBadge(i.passed ? 'pass' : 'fail', i.passed ? 'PASS' : 'FAIL'), h('span', { class: 'list-card-title', text: i.verdict?.headline ?? i.intent })),
            h('span', { class: 'small muted', text: `${i.journeyName} › ${i.intent}` }))),
        )),
      );
      dispose();
      dispose = await mountRunDocument(detail, runId, sel.journeyId, sel.stepId);
    };
    return { show: (segs) => void load(segs), hide: () => undefined };
  },
};

// ------------------------------------------------------------------ ad-hoc compare

interface Sources {
  pdfs: Array<{ path: string; size: number }>;
  templates: Array<{ path: string }>;
  checks: Array<{ name: string; template: string; fields: string[]; params: string[] }>;
  runDocuments: Array<{ runId: string; path: string; journeyId: string }>;
}

type SrcKind = 'upload' | 'project' | 'run' | 'none';

function sourceChooser(label: string, sources: Sources, allowNone: boolean): { el: HTMLElement; value(): Promise<Record<string, unknown> | undefined>; setProject(path: string): void } {
  let kind: SrcKind = allowNone ? 'none' : 'upload';
  let uploaded: { id: string; name: string } | undefined;
  const status = h('span', { class: 'small muted', 'aria-live': 'polite' });
  const upload = filePicker({
    label: 'Choose a PDF…',
    accept: 'application/pdf,.pdf',
    onFile: async (f) => {
      status.textContent = `Uploading ${f.name}…`;
      try {
        const r = await api.post<{ id: string; name: string }>('/api/assurance/documents/upload', { name: f.name, data: await readAsBase64(f) });
        uploaded = r;
        status.textContent = `Uploaded ${r.name}`;
      } catch (e) {
        status.textContent = '';
        toastError(`Upload failed: ${(e as Error).message}`);
      }
    },
  });
  const project = h('select', { class: 'input input-sm' }, sources.pdfs.length ? sources.pdfs.map((p) => h('option', { value: p.path, text: p.path })) : h('option', { value: '', text: 'No PDFs in the project' }));
  const run = h('select', { class: 'input input-sm' }, sources.runDocuments.length ? sources.runDocuments.map((d) => h('option', { value: `${d.runId}::${d.path}`, text: `${d.runId} · ${d.path.split('/').pop()}` })) : h('option', { value: '', text: 'No downloaded PDFs in recent runs' }));
  const panes: Record<SrcKind, HTMLElement> = {
    none: h('p', { class: 'small muted', text: 'Only document A is extracted (reconcile it against a check below).' }),
    upload: h('div', { class: 'row wrap' }, upload, status),
    project: field('PDF in the project', project),
    run: field('PDF downloaded by a run', run),
  };
  const holder = h('div', null);
  const show = () => clear(holder).appendChild(panes[kind]);
  const seg = segmented<SrcKind>({
    label: `${label} source`,
    value: kind,
    options: [...(allowNone ? [{ value: 'none' as SrcKind, label: 'None' }] : []), { value: 'upload', label: 'Upload', icon: 'upload' }, { value: 'project', label: 'Project', icon: 'folder' }, { value: 'run', label: 'Run download', icon: 'results' }],
    onChange: (v) => {
      kind = v;
      show();
    },
  });
  show();
  return {
    el: h('fieldset', { class: 'fs' }, h('legend', { text: label }), seg.el, holder),
    async value() {
      if (kind === 'none') return undefined;
      if (kind === 'upload') {
        if (!uploaded) throw new Error(`${label}: choose a PDF to upload`);
        return { upload: uploaded.id };
      }
      if (kind === 'project') {
        if (!project.value) throw new Error(`${label}: there is no PDF in the project`);
        return { path: project.value };
      }
      if (!run.value) throw new Error(`${label}: no run download available`);
      const [runId, path] = run.value.split('::');
      return { run: runId, path };
    },
    setProject(path) {
      kind = 'project';
      seg.set('project');
      if (![...project.options].some((o) => o.value === path)) project.appendChild(h('option', { value: path, text: path }));
      project.value = path;
      show();
    },
  };
}

function templateEditor(path: string, onSaved: (path: string, text: string) => void, initial = ''): void {
  const ta = h('textarea', { class: 'input wb-textarea', rows: 18, spellcheck: 'false', value: initial, 'aria-label': `Template ${path}` });
  const err = h('p', { class: 'field-error', role: 'alert' });
  const pathInput = h('input', { class: 'input mono-input', value: path, 'aria-label': 'Template path' });
  if (!initial && path) {
    void api.get<{ text: string; error?: string }>(`/api/assurance/documents/template?path=${encodeURIComponent(path)}`).then((r) => {
      ta.value = r.text;
      err.textContent = r.error ?? '';
    }).catch((e: Error) => (err.textContent = e.message));
  }
  openModal<boolean>({
    title: 'Edit document template',
    size: 'lg',
    body: h('div', { class: 'stack' }, field('Save as (project path)', pathInput), h('p', { class: 'help', text: 'YAML or JSON: fields (label or regex, type) and tables (columns, key). Regexes are compiled, never evaluated.' }), ta, err),
    actions: [
      { label: 'Cancel', run: () => false },
      { label: 'Use without saving', run: () => (onSaved('', ta.value), true) },
      {
        label: 'Save template',
        kind: 'primary',
        run: async () => {
          if (!(await confirmDialog({ title: 'Save template?', message: `Write ${pathInput.value} in the project?`, confirm: 'Save' }))) return undefined;
          try {
            await api.put('/api/assurance/documents/template', { path: pathInput.value, text: ta.value });
            toast(`Saved ${pathInput.value}`, { kind: 'success' });
            onSaved(pathInput.value, ta.value);
            return true;
          } catch (e) {
            err.textContent = (e as Error).message;
            return undefined;
          }
        },
      },
    ],
  });
}

function renderPair(el: HTMLElement, r: CompareResult): () => void {
  const changes = (r.diff?.changes ?? []).map((c, i) => ({ c, i }));
  const real = changes.filter((x) => x.c.category !== 'masked');
  let cursor = -1;
  let synced = true;
  const hlA: ViewerHighlight[] = r.highlights.filter((x) => x.doc === 'a').map((x) => ({ ...x, layer: x.kind === 'pii' ? 'pii' : 'mismatch' }));
  const hlB: ViewerHighlight[] = r.highlights.filter((x) => x.doc === 'b').map((x) => ({ ...x, layer: x.kind === 'pii' ? 'pii' : 'mismatch' }));
  const va = createPdfViewer({ url: r.a.url, name: r.a.name, label: `Document A ${r.a.name}`, highlights: hlA, onHighlight: (x) => select(real.findIndex((c) => c.i === x.item)) });
  const vb = createPdfViewer({ url: r.b!.url, name: r.b!.name, label: `Document B ${r.b!.name}`, highlights: hlB, onHighlight: (x) => select(real.findIndex((c) => c.i === x.item)) });
  const unsync = syncScroll(va, vb, () => synced);
  const listEl = h('ol', { class: 'change-list', 'aria-label': 'Changes' });
  const select = (i: number) => {
    if (!real.length || i < 0) return;
    cursor = (i + real.length) % real.length;
    const ch = real[cursor];
    controls.setCount(cursor, real.length);
    synced = false;
    va.reveal((x) => x.item === ch.i);
    vb.reveal((x) => x.item === ch.i, { focus: true });
    setTimeout(() => (synced = syncChk), 800);
    for (const b of listEl.querySelectorAll<HTMLElement>('.change-item')) b.setAttribute('aria-current', String(Number(b.dataset.item) === ch.i));
  };
  let syncChk = true;
  const controls = viewerToolbar(() => [va, vb], {
    onPrev: () => select(cursor - 1),
    onNext: () => select(cursor + 1),
    layers: [
      { id: 'mismatch', label: 'Changes', on: true },
      { id: 'pii', label: 'PII', on: true },
    ],
    onLayers: (hidden) => {
      va.setLayers(hidden);
      vb.setLayers(hidden);
    },
    sync: { get: () => syncChk, set: (v) => (syncChk = synced = v) },
  });
  controls.setCount(-1, real.length);
  for (const { c, i } of changes) {
    listEl.appendChild(h('li', null, h('button', { type: 'button', class: 'change-item', dataset: { item: i }, onclick: () => select(real.findIndex((x) => x.i === i)) }, sevBadge(c.category === 'masked' ? 'info' : c.category.includes('added') || c.category.includes('removed') ? 'warn' : 'fail', c.category), h('span', { text: c.description }), c.page ? h('span', { class: 'muted small', text: `page ${c.page}` }) : null)));
  }
  const counts = Object.entries(r.diff?.summary ?? {}).filter(([, n]) => n > 0);
  clear(el).append(
    h('div', { class: 'stack' },
      verdictBanner({ status: r.diff?.identical ? 'PASS' : 'FAIL', headline: r.diff?.identical ? 'No significant changes' : `${real.length} change${real.length === 1 ? '' : 's'} between A and B` }, [], counts.length ? h('ul', { class: 'pill-list' }, counts.map(([k, n]) => h('li', { class: 'pill', text: `${k}: ${n}` }))) : null),
      controls.el,
      h('div', { class: 'doc-layout pair' }, va.el, vb.el),
      card('Changes', changes.length ? listEl : emptyState('Identical', 'No differences other than masked ones.')),
    ),
  );
  bindNavKeys(el, () => select(cursor + 1), () => select(cursor - 1));
  return () => {
    unsync();
    va.destroy();
    vb.destroy();
  };
}

function renderSingle(el: HTMLElement, r: CompareResult): () => void {
  if (r.threeWay) return renderReview(el, { ...r.threeWay, document: r.a, highlights: r.highlights });
  const review: ReviewData = { verdict: { status: r.a.pii.length ? 'FAIL' : 'PASS', headline: r.a.pii.length ? `${r.a.pii.length} PII finding(s) in the text layer` : 'Extracted' }, diagnosis: r.a.findings.map((f) => `${f.code}: ${f.message}`), fields: [], highlights: r.highlights, document: r.a };
  return renderReview(el, review);
}

interface BulkResult {
  status: string;
  pairs: number;
  identical: number;
  different: number;
  onlyInA: string[];
  onlyInB: string[];
  errors: Array<{ document: string; message: string }>;
  clusters: Array<{ signature: string; category: string; count: number; description: string; examples: string[]; documents: string[] }>;
  dirA: string;
  dirB: string;
}

export const compareSection: SubPageDef = {
  id: 'compare',
  title: 'Compare documents',
  icon: 'compare',
  description: 'PDF ↔ PDF, ↔ UI and DB, bulk regression',
  mount(root) {
    const inner = h('div', { class: 'page-inner' });
    root.appendChild(inner);
    let dispose: () => void = () => undefined;
    let sources: Sources | undefined;
    const build = async () => {
      const s = await withStates(inner, () => api.get<Sources>('/api/assurance/documents/sources'), { retry: () => void build() });
      if (!s) return;
      sources = s;
      const a = sourceChooser('Document A', s, false);
      const b = sourceChooser('Document B', s, true);
      const tplSel = h('select', { class: 'input' }, h('option', { value: '', text: 'Auto-detect "Label: value" fields' }), s.templates.map((t) => h('option', { value: t.path, text: t.path })));
      let tplText = '';
      const tplNote = h('span', { class: 'small muted', 'aria-live': 'polite' });
      tplSel.addEventListener('change', () => ((tplText = ''), (tplNote.textContent = '')));
      const editBtn = button('Edit template…', { small: true, icon: 'edit', onclick: () => templateEditor(tplSel.value || 'templates/new-template.yaml', (path, text) => {
        if (path) {
          if (![...tplSel.options].some((o) => o.value === path)) tplSel.appendChild(h('option', { value: path, text: path }));
          tplSel.value = path;
          tplText = '';
          tplNote.textContent = `Using saved ${path}`;
        } else {
          tplText = text;
          tplNote.textContent = 'Using the edited template (not saved)';
        }
      }) });
      const masks = h('input', { class: 'input mono-input', placeholder: '\\d{4}-\\d{2}-\\d{2}, INV-\\d+' });
      const checkSel = h('select', { class: 'input' }, h('option', { value: '', text: 'No reconciliation' }), s.checks.map((c) => h('option', { value: c.name, text: `${c.name} (${c.fields.join(', ')})` })));
      const paramsBox = h('div', { class: 'form-grid' });
      const uiBox = h('textarea', { class: 'input mono-input', rows: 3, placeholder: 'orderTotal=148.50\norderCustomer=Contoso Ltd', 'aria-label': 'Captured UI values (key=value per line)' });
      const renderParams = () => {
        clear(paramsBox);
        const c = s.checks.find((x) => x.name === checkSel.value);
        if (!c) return;
        for (const p of c.params) paramsBox.appendChild(field(`Query parameter ${p}`, h('input', { class: 'input', dataset: { param: p }, placeholder: 'e.g. ORD-1' })));
        paramsBox.appendChild(field('Captured UI values (optional)', uiBox, 'key=value per line, keys as in the check\'s "ui" mapping'));
      };
      checkSel.addEventListener('change', renderParams);
      const result = h('div', { class: 'compare-result', 'aria-live': 'polite' });
      const run = async () => {
        let body: Record<string, unknown>;
        try {
          body = { a: await a.value(), b: await b.value(), templatePath: tplText ? undefined : tplSel.value || undefined, template: tplText || undefined, masks: masks.value.split(',').map((x) => x.trim()).filter(Boolean) };
        } catch (e) {
          toastError((e as Error).message);
          return;
        }
        if (checkSel.value) {
          const params: Record<string, string> = {};
          for (const i of paramsBox.querySelectorAll<HTMLInputElement>('input[data-param]')) params[i.dataset.param!] = i.value.trim();
          const ui: Record<string, string> = {};
          for (const line of uiBox.value.split('\n')) {
            const m = /^\s*([\w.-]+)\s*=\s*(.*)$/.exec(line);
            if (m) ui[m[1]] = m[2].trim();
          }
          body.check = { name: checkSel.value, params, ui };
        }
        if (!body.b && !body.check) toast('Only document A: showing its extraction and PII. Add document B or a check to compare.');
        dispose();
        const r = await withStates(result, () => api.post<CompareResult>('/api/assurance/documents/compare', body), { loading: 'Extracting and comparing…', retry: () => void run() });
        if (!r) return;
        dispose = r.b ? renderPair(result, r) : renderSingle(result, r);
        result.querySelector<HTMLElement>('.verdict-banner')?.focus?.();
      };
      const form = h('form', { class: 'stack', onsubmit: (e: Event) => (e.preventDefault(), void run()) },
        h('div', { class: 'two-col' }, a.el, b.el),
        h('div', { class: 'form-grid' }, field('Template', tplSel), h('div', { class: 'row wrap' }, editBtn, tplNote), field('Masks (regex, comma separated)', masks, 'Volatile parts (dates, ids) that should not count as changes.')),
        h('fieldset', { class: 'fs' }, h('legend', { text: 'Reconcile document A against UI values and the database' }), field('Document check', checkSel, 'From "documents" in eztest.config.yaml: extraction template, DB query and field mapping.'), paramsBox),
        h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn btn-primary' }, icon('compare'), h('span', { text: 'Extract and compare' }))),
      );
      const bulk = bulkPanel(s, (dirA, dirB, name) => {
        tabs.select('compare', true);
        a.setProject(`${dirA}/${name}`);
        b.setProject(`${dirB}/${name}`);
        void run();
      });
      const tabs = createTabs({
        label: 'Comparison mode',
        tabs: [
          { id: 'compare', title: 'Compare', mount: (p) => p.append(h('div', { class: 'stack' }, form, result)) },
          { id: 'bulk', title: 'Bulk regression', mount: (p) => p.append(bulk) },
        ],
        class: 'card',
      });
      inner.append(pageHeader('Compare documents', 'Upload two PDFs or pick them from the project, choose or edit a template, and compare: changes highlighted where they are printed, synchronised side by side.'), tabs.el);
    };
    return {
      show: () => {
        if (!sources) void build();
      },
    };
  },
};

function bulkPanel(s: Sources, open: (dirA: string, dirB: string, name: string) => void): HTMLElement {
  const dirs = [...new Set(s.pdfs.map((p) => p.path.split('/').slice(0, -1).join('/')).filter(Boolean))];
  const listId = uid('dirs');
  const dirA = h('input', { class: 'input mono-input', list: listId, placeholder: 'invoices/baseline' });
  const dirB = h('input', { class: 'input mono-input', list: listId, placeholder: 'invoices/candidate' });
  const tpl = h('select', { class: 'input' }, h('option', { value: '', text: 'Auto-detect fields' }), s.templates.map((t) => h('option', { value: t.path, text: t.path })));
  const masks = h('input', { class: 'input mono-input', placeholder: '\\d{4}-\\d{2}-\\d{2}' });
  const out = h('div', { 'aria-live': 'polite' });
  const run = async () => {
    const r = await withStates(out, () => api.post<BulkResult>('/api/assurance/documents/bulk', { dirA: dirA.value.trim(), dirB: dirB.value.trim(), templatePath: tpl.value || undefined, masks: masks.value.split(',').map((x) => x.trim()).filter(Boolean) }), { loading: 'Comparing every pair…' });
    if (!r) return;
    out.append(
      verdictBanner({ status: r.status === 'PASS' ? 'PASS' : 'FAIL', headline: `${r.pairs} pair(s): ${r.identical} identical, ${r.different} different` }, [
        ...(r.onlyInA.length ? [`Only in ${r.dirA}: ${r.onlyInA.join(', ')}`] : []),
        ...(r.onlyInB.length ? [`Only in ${r.dirB}: ${r.onlyInB.join(', ')}`] : []),
        ...r.errors.map((e) => `${e.document}: ${e.message}`),
      ]),
      r.clusters.length
        ? h('ul', { class: 'rule-list', 'aria-label': 'Clusters of differences' }, r.clusters.map((c) =>
            h('li', null, h('details', { class: 'rule' },
              h('summary', null, h('span', { class: 'count-pill', text: String(c.count) }), sevBadge(c.category === 'masked' ? 'info' : 'fail', c.category), h('span', { text: c.signature })),
              h('div', { class: 'rule-body' }, h('ul', { class: 'node-list' }, c.documents.map((d) => h('li', { class: 'node-item row-between' }, h('code', { text: d }), c.category.startsWith('only') || c.category === 'error' ? null : button('Open pair', { small: true, icon: 'compare', onclick: () => open(r.dirA, r.dirB, d), ariaLabel: `Open pair ${d}` })))))))))
        : emptyState('No differences', 'Every pair is identical.'),
    );
  };
  return h('form', { class: 'stack', onsubmit: (e: Event) => (e.preventDefault(), void run()) },
    h('p', { class: 'muted', text: 'Pairs files with the same name in two folders, diffs each pair and clusters the differences by pattern ("12 documents: footer date changed"). Open any pair to see it side by side.' }),
    h('datalist', { id: listId }, dirs.map((d) => h('option', { value: d }))),
    h('div', { class: 'form-grid' }, field('Folder A (baseline)', dirA), field('Folder B (candidate)', dirB), field('Template', tpl), field('Masks', masks)),
    h('div', null, h('button', { type: 'submit', class: 'btn btn-primary' }, icon('layers'), h('span', { text: 'Run bulk comparison' }))),
    out,
  );
}

export { copyText, download, loadingState, ApiError };
