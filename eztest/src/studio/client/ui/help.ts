/** The keyboard shortcuts overlay ("?"). */
import { h } from '../core/dom.js';
import { keyLabel, shortcuts } from '../core/keys.js';
import { commands } from '../core/registry.js';
import { openModal } from './modal.js';

export function openShortcutsHelp(): void {
  const groups = new Map<string, Array<{ keys: string; title: string }>>();
  const seen = new Set<string>();
  const add = (group: string, keys: string, title: string) => {
    const k = `${keys}|${title}`;
    if (seen.has(k)) return;
    seen.add(k);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push({ keys, title });
  };
  for (const s of shortcuts.get()) add(s.group ?? 'General', s.keys, s.title);
  for (const c of commands.get()) if (c.shortcut) add(c.group ?? 'Commands', c.shortcut, c.title);
  add('Command palette', '>', 'Type ">" to search commands only');
  add('Command palette', '@', 'Type "@" to jump to a step of the open journey');
  add('Command palette', '#', 'Type "#" to open a run');
  const body = h(
    'div',
    { class: 'shortcut-groups' },
    [...groups.entries()].map(([g, list]) =>
      h(
        'section',
        { class: 'shortcut-group' },
        h('h3', { text: g }),
        h('dl', { class: 'shortcut-list' }, list.map((s) => [h('dt', null, h('kbd', { class: 'kbd', text: s.keys.length === 1 ? s.keys : keyLabel(s.keys) })), h('dd', { text: s.title })])),
      ),
    ),
  );
  openModal({ title: 'Keyboard shortcuts', body, size: 'lg', actions: [{ label: 'Close', kind: 'primary', run: () => true }] });
}
