/**
 * Accessible tabs (ARIA tablist): arrow keys move between tabs, Home/End jump,
 * panels are mounted lazily on first selection and kept afterwards.
 */
import { clear, h, uid } from '../core/dom.js';

export interface TabDef {
  id: string;
  title: string;
  badge?: string | number;
  mount(panel: HTMLElement): void | (() => void);
}

export interface TabsHandle {
  el: HTMLElement;
  list: HTMLElement;
  select(id: string, focus?: boolean): void;
  readonly selected: string | undefined;
  setTabs(tabs: TabDef[], selected?: string): void;
  setBadge(id: string, badge: string | number | undefined): void;
}

export function createTabs(opts: { label: string; tabs: TabDef[]; selected?: string; onSelect?(id: string): void; class?: string; actions?: HTMLElement }): TabsHandle {
  const base = uid('tabs');
  const list = h('div', { class: 'tablist', role: 'tablist', 'aria-label': opts.label });
  const panels = h('div', { class: 'tabpanels' });
  const el = h('div', { class: ['tabs', opts.class] }, h('div', { class: 'tabbar' }, list, opts.actions ?? null), panels);
  let tabs: TabDef[] = [];
  let current: string | undefined;
  const mounted = new Map<string, { panel: HTMLElement; cleanup?: () => void }>();

  const tabEl = (id: string) => list.querySelector<HTMLElement>(`[data-tab="${CSS.escape(id)}"]`);

  const select = (id: string, focus = false) => {
    const def = tabs.find((t) => t.id === id) ?? tabs[0];
    if (!def) return;
    current = def.id;
    for (const t of tabs) {
      const b = tabEl(t.id);
      const on = t.id === def.id;
      b?.setAttribute('aria-selected', String(on));
      if (b) b.tabIndex = on ? 0 : -1;
      const m = mounted.get(t.id);
      if (m) m.panel.hidden = !on;
    }
    if (!mounted.has(def.id)) {
      const panel = h('div', { id: `${base}-panel-${def.id}`, class: 'tabpanel', role: 'tabpanel', 'aria-labelledby': `${base}-tab-${def.id}`, tabindex: '0' });
      panels.appendChild(panel);
      const cleanup = def.mount(panel) || undefined;
      mounted.set(def.id, { panel, cleanup });
    }
    if (focus) tabEl(def.id)?.focus();
    opts.onSelect?.(def.id);
  };

  const setTabs = (next: TabDef[], selected?: string) => {
    for (const m of mounted.values()) m.cleanup?.();
    mounted.clear();
    clear(panels);
    clear(list);
    tabs = next;
    for (const t of tabs) {
      list.appendChild(
        h(
          'button',
          {
            type: 'button',
            id: `${base}-tab-${t.id}`,
            class: 'tab',
            role: 'tab',
            'aria-selected': 'false',
            'aria-controls': `${base}-panel-${t.id}`,
            tabindex: '-1',
            dataset: { tab: t.id },
            onclick: () => select(t.id),
          },
          h('span', { text: t.title }),
          t.badge !== undefined && t.badge !== '' ? h('span', { class: 'tab-badge', text: String(t.badge) }) : null,
        ),
      );
    }
    if (tabs.length) select(selected && tabs.some((t) => t.id === selected) ? selected : tabs[0].id);
  };

  list.addEventListener('keydown', (e) => {
    const i = tabs.findIndex((t) => t.id === current);
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = tabs.length - 1;
    if (n < 0) return;
    e.preventDefault();
    select(tabs[n].id, true);
  });

  setTabs(opts.tabs, opts.selected);
  return {
    el,
    list,
    select,
    setTabs,
    get selected() {
      return current;
    },
    setBadge(id, badge) {
      const b = tabEl(id);
      if (!b) return;
      b.querySelector('.tab-badge')?.remove();
      if (badge !== undefined && badge !== '' && badge !== 0) b.appendChild(h('span', { class: 'tab-badge', text: String(badge) }));
    },
  };
}
