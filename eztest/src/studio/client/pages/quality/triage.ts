/**
 * Triage board (#/quality/triage/<runId>): failures of a run clustered by
 * signature, in columns by classification, with cited evidence, the first-seen
 * run, manual reclassification (with a reason, feeding history), one-click
 * Azure DevOps bugs and "Copy as Markdown".
 */
import { api } from '../../core/api.js';
import { clear, h, uid } from '../../core/dom.js';
import { pct, plural, relTime } from '../../core/format.js';
import { registerPage } from '../../core/registry.js';
import { link, navigate, type Route } from '../../core/router.js';
import { button, copyText } from '../../ui/badge.js';
import { icon } from '../../ui/icons.js';
import { openModal } from '../../ui/modal.js';
import { toast, toastError } from '../../ui/toast.js';
import { askReviewer, autoRefresh, CATEGORIES, CATEGORY_LABEL, confirmWith, qualityFrame, reviewer, reviewerField, runSelect, type RunOption } from './common.js';

interface Ev {
  id: string;
  kind: string;
  url: string;
  description?: string;
}

interface Card {
  id: string;
  signature: string;
  category: string;
  ruleCategory?: string;
  message: string;
  error: string;
  size: number;
  confidence: number;
  needsHuman: boolean;
  reasons: string[];
  journeys: Array<{ journeyId: string; name: string; stepId?: string; intent?: string; category: string; confidence: number; status: string; owners?: string[]; tags?: string[]; override?: { to: string; by: string; reason: string; at: string; inherited: boolean; runId: string } }>;
  evidence: Ev[];
  firstSeen?: { runId: string; startedAt: string };
  occurrences: number;
  override?: { to: string; from: string; by: string; reason: string; at: string; inherited: boolean; runId: string };
  bugs: Array<{ id: number; url: string; action: string; at: string }>;
}

interface Board {
  runId: string | null;
  startedAt?: string;
  summary?: { total: number; failed: number; errors: number };
  runs: RunOption[];
  cards: Card[];
  counts: Record<string, number>;
  warnings?: string[];
}

interface AdoStatus {
  configured: boolean;
  hint: string;
  project?: string;
}

export function cardMarkdown(c: Card, runId: string): string {
  const lines = [
    `### ${CATEGORY_LABEL[c.category] ?? c.category}: ${c.message.slice(0, 120)}`,
    '',
    `- **Run:** ${runId}`,
    `- **Classification:** ${CATEGORY_LABEL[c.category] ?? c.category} (${pct(c.confidence)} confidence${c.override ? `; ${c.override.inherited ? 'inherited from an earlier review' : 'reclassified'} by ${c.override.by}: ${c.override.reason}` : ''})`,
    `- **Signature:** \`${c.signature}\``,
    `- **First seen:** ${c.firstSeen ? `${c.firstSeen.runId} (${c.firstSeen.startedAt})` : 'this run'}; seen in ${c.occurrences || 1} run(s)`,
    `- **Affected journeys:**`,
    ...c.journeys.map((j) => `  - ${j.name} (\`${j.journeyId}\`)${j.intent ? ` at step "${j.intent}"` : ''}`),
    `- **Evidence:** ${c.evidence.map((e) => `${e.id} (${e.kind})`).join(', ') || 'none'}`,
    ...(c.bugs.length ? [`- **Bugs:** ${c.bugs.map((b) => `[#${b.id}](${b.url})`).join(', ')}`] : []),
    '',
    '**Why:**',
    ...c.reasons.map((r) => `- ${r}`),
    '',
    '```',
    c.error.slice(0, 1500),
    '```',
  ];
  return lines.join('\n') + '\n';
}

export function registerTriageBoard(): void {
  registerPage({
    id: 'quality-triage',
    title: 'Triage',
    icon: 'shield',
    route: 'quality/triage',
    group: 'quality',
    order: 210,
    mount(ctx) {
      const f = qualityFrame(ctx, 'Triage board', 'Failures clustered by signature and classified with cited evidence. Reclassify with a reason; file deduplicated Azure DevOps bugs in one click.', { wide: true });
      let runId: string | undefined;
      let board: Board | undefined;
      let ado: AdoStatus | undefined;
      const runHost = h('div');
      f.toolbar.append(runHost);

      const reclassify = async (c: Card) => {
        if (!board?.runId) return;
        const who = await askReviewer();
        if (!who) return;
        const sid = uid('cat');
        const rid = uid('why');
        const sel = h('select', { id: sid, class: 'input' }, CATEGORIES.map((k) => h('option', { value: k, selected: k === c.category, text: CATEGORY_LABEL[k] })));
        const why = h('textarea', { id: rid, class: 'input', rows: 3, placeholder: 'e.g. the staging database was being restored at the time' });
        const ok = await confirmWith(
          'Reclassify failure',
          h(
            'div',
            { class: 'stack' },
            h('p', null, `${plural(c.size, 'failing journey')} share this signature. Currently `, h('strong', { text: CATEGORY_LABEL[c.category] }), c.ruleCategory ? ` (rules said ${CATEGORY_LABEL[c.ruleCategory]})` : '', '. The new classification is saved with your reason, used by trends and readiness, and offered when the same failure comes back in later runs.'),
            h('div', { class: 'field' }, h('label', { for: sid, text: 'Classification' }), sel),
            h('div', { class: 'field' }, h('label', { for: rid, text: 'Reason (required)' }), why),
            reviewerField(),
          ),
          'Reclassify',
          { size: 'md', validate: () => (sel.value === c.category && !c.override ? 'Pick a different classification' : !why.value.trim() ? 'A reason is required' : !reviewer.get() ? 'Enter your name' : undefined) },
        );
        if (!ok) return;
        try {
          await api.post('/api/quality/triage/reclassify', { runId: board.runId, journeyIds: c.journeys.map((j) => j.journeyId), to: sel.value, reason: why.value.trim(), by: reviewer.get(), confirm: true });
          toast(`Reclassified as ${CATEGORY_LABEL[sel.value]}`, { kind: 'success' });
          await load();
        } catch (e) {
          toastError(`Reclassification failed: ${(e as Error).message}`);
        }
      };

      const fileBug = async (c: Card, btn: HTMLButtonElement) => {
        if (!board?.runId) return;
        if (!ado?.configured) {
          openModal({ title: 'Azure DevOps is not configured', size: 'md', body: h('div', { class: 'stack' }, h('p', { text: 'Filing bugs needs the ado section of eztest.config.yaml:' }), h('pre', { class: 'q-pre', text: ado?.hint ?? '' })), actions: [{ label: 'Close', run: () => true }] });
          return;
        }
        const j = c.journeys[0];
        const ok = await confirmWith(
          'File bug in Azure DevOps',
          h('div', { class: 'stack' }, h('p', null, 'Files a Bug in ', h('strong', { text: ado.project ?? '' }), ` for "${j.name}", with repro steps, the triage reasons and ${plural(c.evidence.length, 'evidence file')} attached. An open bug with the same failure signature is reused instead of creating a duplicate.`)),
          'File bug',
          { size: 'md' },
        );
        if (!ok) return;
        btn.disabled = true;
        try {
          const r = await api.post<{ id: number; url: string; action: string; attachments: string[]; warnings: string[] }>('/api/quality/triage/file-bug', { runId: board.runId, journeyId: j.journeyId, evidenceIds: c.evidence.map((e) => e.id), category: c.category, by: reviewer.get() || undefined, confirm: true });
          toast(r.action === 'created' ? `Created bug #${r.id} with ${plural(r.attachments.length, 'attachment')}` : `An open bug for this failure exists: #${r.id}`, { kind: 'success' });
          await load();
        } catch (e) {
          toastError((e as Error).message);
        } finally {
          btn.disabled = false;
        }
      };

      const TAG_LABEL: Record<string, string> = { 'new-failure': 'New failure', 'always-failing': 'Always failing', regressed: 'Regressed', flaky: 'Flaky' };
      const cardEl = (c: Card): HTMLElement => {
        const tid = uid('tc');
        const shots = c.evidence.filter((e) => e.kind === 'screenshot');
        const others = c.evidence.filter((e) => e.kind !== 'screenshot');
        const bugBtn = button(c.bugs.length ? 'File again / find bug' : 'File bug in ADO', { icon: 'external', small: true, title: ado?.configured ? `Azure DevOps project ${ado.project}` : 'Azure DevOps is not configured: click for setup' });
        bugBtn.addEventListener('click', () => void fileBug(c, bugBtn));
        const copyBtn = button('Copy as Markdown', { icon: 'copy', small: true });
        copyBtn.addEventListener('click', () => void copyText(cardMarkdown(c, board!.runId!), copyBtn));
        return h(
          'article',
          { class: 'q-tcard', tabindex: '0', 'aria-labelledby': tid, dataset: { cluster: c.id } },
          h('header', { class: 'q-tcard-head' }, h('h3', { id: tid, class: 'q-h3', text: c.message.slice(0, 140) || 'Failure' }), h('span', { class: 'count-pill', title: 'Failing journeys in this cluster' }, h('span', { 'aria-hidden': 'true', text: String(c.size) }), h('span', { class: 'sr-only', text: plural(c.size, 'failing journey') }))),
          h(
            'p',
            { class: 'small muted' },
            `${pct(c.confidence)} confidence`,
            c.needsHuman ? h('span', { class: 'q-flag' }, ' · ', icon('warning', { size: 12 }), ' needs a human') : null,
            c.override ? h('span', null, ` · ${c.override.inherited ? 'inherited from' : 'reclassified by'} ${c.override.by}`) : null,
          ),
          c.override ? h('p', { class: 'small q-override' }, icon('edit', { size: 12 }), h('span', { text: ` ${CATEGORY_LABEL[c.override.from] ?? 'rules'} → ${CATEGORY_LABEL[c.override.to]}: ${c.override.reason}` })) : null,
          h('ul', { class: 'q-tjourneys' }, c.journeys.map((j) => h('li', null, h('a', { href: link('runs', board!.runId!, j.journeyId, j.stepId ?? ''), text: j.name }), j.intent ? h('span', { class: 'muted small', text: ` at "${j.intent}"` }) : null, j.owners?.length ? h('span', { class: 'muted small', text: ` · owner ${j.owners.join(', ')}` }) : null, (j.tags ?? []).map((t) => h('span', { class: `chip tag-${t}`, text: TAG_LABEL[t] ?? t }))))),
          h('details', { class: 'q-err' }, h('summary', { text: 'Error' }), h('pre', { class: 'q-pre', text: c.error })),
          c.reasons.length ? h('ul', { class: 'bullets small' }, c.reasons.slice(0, 3).map((r) => h('li', { text: r }))) : null,
          h(
            'div',
            { class: 'q-cites', role: 'group', 'aria-label': 'Cited evidence' },
            shots.slice(0, 3).map((e) => h('a', { class: 'q-thumb', href: e.url, target: '_blank', rel: 'noopener', title: e.description ?? e.id }, h('img', { src: e.url, alt: `Evidence ${e.id}: ${e.description ?? 'screenshot'}`, loading: 'lazy' }), h('span', { class: 'q-shot-id', text: e.id }))),
            others.slice(0, 6).map((e) => h('a', { class: 'chip q-evchip', href: e.url, target: '_blank', rel: 'noopener', title: e.description ?? e.kind, text: `${e.id} ${e.kind}` })),
          ),
          h('p', { class: 'small muted' }, 'First seen ', c.firstSeen ? h('a', { href: link('runs', c.firstSeen.runId), text: relTime(c.firstSeen.startedAt) }) : 'in this run', ` · ${plural(c.occurrences || 1, 'run')}`),
          c.bugs.length ? h('p', { class: 'small' }, icon('external', { size: 12 }), ' ', c.bugs.map((b, i) => [i ? ', ' : '', h('a', { href: b.url, target: '_blank', rel: 'noopener noreferrer', text: `Bug #${b.id}` })])) : null,
          h('footer', { class: 'q-tcard-actions' }, button('Reclassify…', { icon: 'edit', small: true, onclick: () => void reclassify(c) }), bugBtn, copyBtn),
        );
      };

      const render = () => {
        if (!board) return;
        clear(runHost);
        if (board.runs.length) runHost.append(runSelect('Run', board.runs, board.runId ?? undefined, (id) => navigate(link('quality', 'triage', id))));
        if (!board.runId) return f.empty('No runs yet', 'Run some journeys; their failures are triaged here.', button('Run journeys', { kind: 'primary', icon: 'run', onclick: () => navigate(link('run')) }));
        const failed = (board.summary?.failed ?? 0) + (board.summary?.errors ?? 0);
        const adoNote = ado && !ado.configured ? h('p', { class: 'q-callout small' }, icon('info', { size: 14 }), h('span', { text: ' Azure DevOps is not configured, so "File bug" shows the setup steps. ' })) : null;
        if (!board.cards.length) {
          f.content(adoNote, h('div', { class: 'empty' }, h('p', { class: 'empty-title', text: failed ? 'Failures could not be triaged' : 'No failures in this run' }), h('p', { class: 'empty-text', text: failed ? 'See the run details.' : `${board.summary?.total ?? 0} journeys, none failed.` })));
          return;
        }
        const cols = CATEGORIES.map((cat) => {
          const cards = board!.cards.filter((c) => c.category === cat);
          const hid = uid('col');
          return h(
            'section',
            { class: ['q-col', `q-col-${cat}`], 'aria-labelledby': hid },
            h('header', { class: 'q-col-head' }, h('span', { class: `q-key q-cat-${cat}`, 'aria-hidden': 'true' }), h('h2', { id: hid, class: 'q-h2', text: CATEGORY_LABEL[cat] }), h('span', { class: 'count-pill' }, h('span', { 'aria-hidden': 'true', text: String(cards.reduce((s, c) => s + c.size, 0)) }), h('span', { class: 'sr-only', text: plural(cards.reduce((s, c) => s + c.size, 0), 'failure') }))),
            cards.length ? h('div', { class: 'q-col-cards' }, cards.map(cardEl)) : h('p', { class: 'muted small q-col-empty', text: 'None' }),
          );
        });
        f.content(
          h('p', { class: 'q-summary-row' }, h('strong', { text: plural(failed, 'failure') }), ` in ${plural(board.cards.length, 'cluster')} · run `, h('a', { href: link('runs', board.runId), text: board.runId }), ` · ${relTime(board.startedAt)}`),
          adoNote,
          h('div', { class: 'q-board', style: { gridTemplateColumns: CATEGORIES.map((cat) => (board!.cards.some((c) => c.category === cat) ? 'minmax(280px, 2fr)' : 'minmax(150px, 1fr)')).join(' ') } }, cols),
          ...(board.warnings ?? []).map((w) => h('p', { class: 'warn-text small', text: w })),
        );
      };

      const load = async () => {
        if (!board) f.loading();
        try {
          const [b, a] = await Promise.all([api.get<Board>(`/api/quality/triage${runId ? `?run=${encodeURIComponent(runId)}` : ''}`), ado ? Promise.resolve(ado) : api.get<AdoStatus>('/api/quality/ado/status').catch(() => undefined)]);
          board = b;
          ado = a;
          render();
        } catch (e) {
          f.error((e as Error).message, () => void load());
        }
      };
      autoRefresh(ctx, () => void load(), ['triage']);
      return {
        show(route: Route) {
          const next = route.segments[1] || undefined;
          if (next !== runId) board = undefined;
          runId = next;
          void load();
        },
        focus: () => f.heading.focus(),
      };
    },
  });
}
