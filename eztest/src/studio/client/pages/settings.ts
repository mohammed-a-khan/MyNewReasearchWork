/** Settings: doctor, configuration warnings and layers, the effective configuration (secrets masked), appearance and shortcuts. */
import { api } from '../core/api.js';
import { add, clear, h, uid } from '../core/dom.js';
import { registerPage } from '../core/registry.js';
import { session } from '../core/state.js';
import { theme, type ThemeChoice } from '../core/theme.js';
import { badge, button, card } from '../ui/badge.js';
import { openShortcutsHelp } from '../ui/help.js';

interface SettingsResponse {
  ok: boolean;
  error?: string;
  config?: unknown;
  sources?: string[];
  warnings: string[];
  env?: string;
  doctor: Record<string, string>;
}

export function registerSettingsPage(): void {
  registerPage({
    id: 'settings',
    title: 'Settings',
    icon: 'settings',
    group: 'secondary',
    order: 900,
    shortcut: 'Alt+9',
    mount(ctx) {
      const heading = h('h1', { class: 'page-title', tabindex: '-1', text: 'Settings' });
      const body = h('div', { class: 'cards' });
      const radios = (['system', 'light', 'dark'] as ThemeChoice[]).map((t) => {
        const id = uid(`theme-${t}`);
        const input = h('input', { type: 'radio', name: 'theme', id, value: t, checked: theme.get() === t, onchange: () => theme.set(t) });
        return h('label', { class: 'check', for: id }, input, h('span', { text: t === 'system' ? 'Match the system' : t === 'light' ? 'Light' : 'Dark' }));
      });
      theme.subscribe((t) => radios.forEach((r) => ((r.querySelector('input') as HTMLInputElement).checked = (r.querySelector('input') as HTMLInputElement).value === t)));
      const appearance = card(
        'Appearance and keyboard',
        h('div', { class: 'stack' }, h('fieldset', { class: 'fs' }, h('legend', { text: 'Theme' }), h('div', { class: 'row wrap' }, radios)), button('Show keyboard shortcuts', { icon: 'keyboard', onclick: () => openShortcutsHelp() })),
      );
      ctx.root.classList.add('page-scroll');
      ctx.root.append(h('div', { class: 'page-inner' }, h('header', { class: 'page-head' }, heading, h('p', { class: 'muted', text: 'Read-only view of the effective configuration. Secrets are masked.' })), body));

      const load = async () => {
        clear(body).append(appearance, h('p', { class: 'muted', role: 'status', text: 'Checking the environment…' }));
        let r: SettingsResponse;
        try {
          r = await api.get<SettingsResponse>('/api/settings');
        } catch (e) {
          clear(body).append(appearance, h('p', { class: 'bad-text', text: `Could not load settings: ${(e as Error).message}` }));
          return;
        }
        const s = session.get();
        add(
          clear(body),
          card('Doctor', h('dl', { class: 'kv' }, [...Object.entries(r.doctor), ['project', s?.project ?? ''], ['git branch', s?.branch ?? 'not a git repository'], ['file watching', s?.watching ?? 'off']].map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])), { id: 'doctor' }),
          card(
            'Configuration warnings',
            h(
              'div',
              null,
              !r.ok ? h('p', { class: 'bad-text', text: `The configuration does not load: ${r.error ?? ''}` }) : null,
              !r.warnings.length && r.ok ? h('p', null, badge('ok', 'No warnings')) : h('ul', { class: 'bullets warn-text' }, r.warnings.map((w) => h('li', { text: w }))),
              r.sources ? h('p', { class: 'muted', text: `Layers (lowest to highest precedence): ${r.sources.join(' < ')}` }) : null,
            ),
            { id: 'warn' },
          ),
          appearance,
          r.config ? card('Effective configuration', h('pre', { class: 'code-preview tall', tabindex: '0', id: 'config-json', text: JSON.stringify(r.config, null, 2) }), { id: 'cfg', class: 'span-2' }) : null,
        );
      };
      return { show: () => void load(), focus: () => heading.focus() };
    },
  });
}
