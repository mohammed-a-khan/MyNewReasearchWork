/** Project › Elements: the shared element repository, each element's locators and where journeys use it. */
import { api } from '../core/api.js';
import { h } from '../core/dom.js';
import { badge, card, emptyState, stat } from '../ui/badge.js';
import { dataTable, pageHeader, sevBadge, withStates, type SubPageDef } from './assurance-ui.js';

interface Usage { journeyId: string; journeyName: string; stepId: string; intent: string; via: 'reference' | 'description'; role: string }
interface ElementRow {
  id: string; screen: string; key: string; description: string; aliases: string[]; file: string; line?: number; source: string;
  locators: string[]; hasFingerprint: boolean; usages: Usage[];
}
interface ElementsView {
  dir: string;
  elements: ElementRow[];
  unused: string[];
  unknown: Array<{ id: string; usages: Usage[] }>;
  duplicates: Array<{ reason: string; key: string; ids: string[] }>;
  problems: Array<{ file: string; message: string }>;
}

const REASON: Record<string, string> = { 'same-locators': 'same locators', 'same-locator': 'same first locator', 'same-description': 'same description' };

export const elementsSection: SubPageDef = {
  id: 'elements',
  title: 'Elements',
  icon: 'target',
  description: 'Shared elements and their usages',
  mount(root) {
    const body = h('div', { class: 'stack' });
    root.appendChild(h('div', { class: 'page-inner' }, pageHeader('Elements', 'Named elements defined once (elements/*.yaml, or screens) and used by many journeys as @Screen.key or by description. Accepting a heal for an element fixes every journey that uses it.'), body));
    const load = async () => {
      const v = await withStates(body, () => api.get<ElementsView>('/api/project/elements'), { retry: () => void load() });
      if (!v) return;
      const used = v.elements.length - v.unused.length;
      body.append(
        h('div', { class: 'stats' }, stat(v.elements.length, 'Elements'), stat(used, 'Used', 'ok'), stat(v.unused.length, 'Unused', v.unused.length ? 'warn' : 'ok'), stat(v.duplicates.length, 'Duplicate groups', v.duplicates.length ? 'warn' : 'ok')),
        v.problems.length ? card('Problems', h('ul', { class: 'bullets' }, v.problems.map((p) => h('li', { class: 'bad-text', text: `${p.file}: ${p.message}` })))) : h('span'),
        v.elements.length
          ? card('Elements', dataTable({
              caption: 'Shared elements with their locators and usages',
              rows: v.elements,
              columns: [
                { title: 'Element', render: (e) => h('div', { class: 'stack-sm' }, h('code', { text: `@${e.id}` }), h('span', { class: 'muted small', text: e.description }), e.aliases.length ? h('span', { class: 'muted small', text: `also: ${e.aliases.join(', ')}` }) : null) },
                { title: 'Locators', render: (e) => h('ol', { class: 'bullets small' }, e.locators.map((l) => h('li', null, h('code', { text: l })))) },
                { title: 'Defined in', render: (e) => h('span', { class: 'small', text: `${e.file}${e.line ? `:${e.line}` : ''}${e.source === 'screen' ? ' (screen)' : ''}` }) },
                {
                  title: 'Usages',
                  render: (e) => e.usages.length
                    ? h('details', null, h('summary', { text: `${e.usages.length} use${e.usages.length === 1 ? '' : 's'} in ${new Set(e.usages.map((u) => u.journeyId)).size} journey(s)` }),
                        h('ul', { class: 'bullets small' }, e.usages.map((u) => h('li', null, h('strong', { text: u.journeyName }), h('span', { text: ` · ${u.intent}` }), h('span', { class: 'muted', text: ` (${u.via === 'reference' ? '@reference' : u.via === 'code' ? 'in code' : 'by description'}${u.role !== 'target' ? `, ${u.role}` : ''})` })))))
                    : sevBadge('warn', 'unused'),
                },
                { title: 'Fingerprint', render: (e) => (e.hasFingerprint ? badge('ok', 'stored') : h('span', { class: 'muted small', text: 'from runs' })) },
              ],
            }))
          : emptyState('No shared elements', `Create ${v.dir}/<Screen>.yaml with "screen:" and "elements:" (see docs/elements.md), or set elements.screens to read SDK / imported screens.`),
        v.unknown.length ? card('Unknown references', h('ul', { class: 'bullets' }, v.unknown.map((u) => h('li', { class: 'bad-text', text: `@${u.id} is used by ${u.usages.map((x) => x.journeyName).join(', ')} but is not in the repository` })))) : h('span'),
        v.duplicates.length ? card('Likely duplicates', h('ul', { class: 'bullets' }, v.duplicates.map((d) => h('li', { text: `${d.ids.map((i) => `@${i}`).join(', ')}: ${REASON[d.reason] ?? d.reason}` })))) : h('span'),
      );
    };
    return { show: () => void load(), hide: () => undefined };
  },
};
