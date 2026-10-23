/**
 * The command palette (Ctrl/Cmd+K): fuzzy search over pages, commands and
 * provider items (journeys, runs, steps). Prefixes narrow the search: ">"
 * commands, plus any prefix a provider declares (e.g. "@" steps, "#" runs).
 * ARIA combobox pattern: the input owns a listbox; arrows move the active
 * option, Enter runs it, Escape closes.
 */
import { clear, h, uid } from '../core/dom.js';
import { fuzzyAny } from '../core/fuzzy.js';
import { keyLabel } from '../core/keys.js';
import { commands, pages, providers, type PaletteItem } from '../core/registry.js';
import { navigate, link } from '../core/router.js';
import { icon } from './icons.js';
import { openModal } from './modal.js';

interface Scored {
  item: PaletteItem;
  score: number;
  indexes: number[];
  shortcut?: string;
}

const MAX = 60;
let openHandle: { close(): void } | undefined;

function baseItems(): Array<PaletteItem & { shortcut?: string }> {
  const out: Array<PaletteItem & { shortcut?: string }> = [];
  for (const p of pages.get()) {
    out.push({ id: `page:${p.id}`, title: `Go to ${p.title}`, group: 'Pages', icon: p.icon, keywords: [p.title, p.id], shortcut: p.shortcut, run: () => navigate(link(p.route ?? p.id)) });
  }
  for (const c of commands.get()) {
    if (c.when && !c.when()) continue;
    out.push({ id: `cmd:${c.id}`, title: c.title, group: c.group ?? 'Commands', icon: c.icon, keywords: c.keywords, shortcut: c.shortcut, run: () => void c.run() });
  }
  return out;
}

async function search(query: string): Promise<Scored[]> {
  const prov = providers.get();
  const prefixed = prov.find((p) => p.prefix && query.startsWith(p.prefix));
  let items: Array<PaletteItem & { shortcut?: string }>;
  let q = query;
  if (query.startsWith('>')) {
    q = query.slice(1);
    items = baseItems().filter((i) => i.id.startsWith('cmd:'));
  } else if (prefixed) {
    q = query.slice(prefixed.prefix!.length);
    items = await prefixed.items(q);
  } else {
    items = baseItems();
    const extra = await Promise.all(prov.filter((p) => !p.prefix).map((p) => Promise.resolve(p.items(q)).catch(() => [])));
    items.push(...extra.flat());
  }
  const scored: Scored[] = [];
  for (const item of items) {
    const m = fuzzyAny(q, [item.title, item.detail, ...(item.keywords ?? [])]);
    if (m) scored.push({ item, score: m.score, indexes: m.indexes, shortcut: (item as { shortcut?: string }).shortcut });
  }
  if (q.trim()) {
    // Keep each group together, groups ordered by their best match.
    const best = new Map<string, number>();
    for (const s of scored) best.set(s.item.group, Math.max(best.get(s.item.group) ?? -Infinity, s.score));
    scored.sort((a, b) => best.get(b.item.group)! - best.get(a.item.group)! || (a.item.group === b.item.group ? b.score - a.score : a.item.group.localeCompare(b.item.group)));
  }
  return scored.slice(0, MAX);
}

function highlighted(text: string, indexes: number[]): Node[] {
  if (!indexes.length) return [document.createTextNode(text)];
  const set = new Set(indexes);
  const out: Node[] = [];
  let buf = '';
  let inMark = false;
  const flush = () => {
    if (!buf) return;
    out.push(inMark ? h('mark', { text: buf }) : document.createTextNode(buf));
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m !== inMark) {
      flush();
      inMark = m;
    }
    buf += text[i];
  }
  flush();
  return out;
}

/** Open the palette, optionally pre-filled (e.g. ">" for commands only). */
export function openPalette(initial = ''): void {
  if (openHandle) {
    openHandle.close();
  }
  const listId = uid('palette-list');
  const input = h('input', {
    class: 'palette-input',
    type: 'text',
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': listId,
    'aria-autocomplete': 'list',
    'aria-label': 'Search pages, journeys, runs and commands',
    placeholder: 'Search pages, journeys, runs and commands…  (> commands, @ steps, # runs)',
    autocomplete: 'off',
    spellcheck: 'false',
    value: initial,
  });
  const list = h('ul', { id: listId, class: 'palette-list', role: 'listbox', 'aria-label': 'Results' });
  const status = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  let results: Scored[] = [];
  let active = 0;
  let token = 0;

  const setActive = (i: number) => {
    active = Math.max(0, Math.min(results.length - 1, i));
    list.querySelectorAll<HTMLElement>('[role="option"]').forEach((el, k) => {
      el.setAttribute('aria-selected', String(k === active));
      if (k === active) {
        input.setAttribute('aria-activedescendant', el.id);
        el.scrollIntoView({ block: 'nearest' });
      }
    });
    if (!results.length) input.removeAttribute('aria-activedescendant');
  };

  const choose = (i: number) => {
    const r = results[i];
    if (!r) return;
    modal.close();
    // Run after the dialog has closed and focus was restored, so the action can move focus.
    setTimeout(() => r.item.run(), 0);
  };

  const refresh = async () => {
    const mine = ++token;
    const found = await search(input.value);
    if (mine !== token) return;
    results = found;
    clear(list);
    let lastGroup = '';
    results.forEach((r, i) => {
      if (r.item.group !== lastGroup) {
        lastGroup = r.item.group;
        list.appendChild(h('li', { class: 'palette-group', role: 'presentation', text: lastGroup }));
      }
      list.appendChild(
        h(
          'li',
          {
            id: `${listId}-${i}`,
            class: 'palette-item',
            role: 'option',
            'aria-selected': 'false',
            onmousedown: (e: MouseEvent) => e.preventDefault(),
            onclick: () => choose(i),
            onmousemove: () => active !== i && setActive(i),
          },
          r.item.icon ? icon(r.item.icon) : h('span', { class: 'icon-spacer', 'aria-hidden': 'true' }),
          h('span', { class: 'palette-title' }, highlighted(r.item.title, r.indexes)),
          r.item.detail ? h('span', { class: 'palette-detail', text: r.item.detail }) : null,
          r.shortcut ? h('kbd', { class: 'kbd', text: keyLabel(r.shortcut) }) : null,
        ),
      );
    });
    if (!results.length) list.appendChild(h('li', { class: 'palette-empty', role: 'presentation', text: 'No matches' }));
    status.textContent = `${results.length} result${results.length === 1 ? '' : 's'}`;
    setActive(0);
  };

  input.addEventListener('input', () => void refresh());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(active + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(active - 1);
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      setActive(active + 8);
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      setActive(active - 8);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(active);
    }
  });

  const modal = openModal<void>({
    title: 'Command palette',
    class: 'palette',
    size: 'lg',
    body: h('div', { class: 'palette-body' }, h('div', { class: 'palette-search' }, icon('search'), input), list, status),
    initialFocus: input,
    onClose: () => (openHandle = undefined),
  });
  openHandle = modal;
  input.setSelectionRange(input.value.length, input.value.length);
  void refresh();
}
