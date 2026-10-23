/**
 * The workbench: title bar, activity bar (page navigation), the page area,
 * a resizable bottom panel (Problems, Output, ...) and the status bar. Pages,
 * panels and status items come from the registries, so features plug in
 * without touching this file.
 */
import { clear, h } from '../core/dom.js';
import { keyLabel } from '../core/keys.js';
import { pages, panels, pageForRoute, statusItems, type PageDef, type PageInstance } from '../core/registry.js';
import { link, navigate, route, type Route } from '../core/router.js';
import { session } from '../core/state.js';
import { store } from '../core/store.js';
import { effectiveTheme, toggleTheme } from '../core/theme.js';
import { openShortcutsHelp } from './help.js';
import { icon } from './icons.js';
import { openPalette } from './palette.js';
import { createSplit, type SplitHandle } from './split.js';
import { createTabs, type TabsHandle } from './tabs.js';

interface Mounted {
  def: PageDef;
  root: HTMLElement;
  instance: PageInstance;
}

export const DEFAULT_PAGE = 'home';

/** Bottom panel visibility (Mod+J). */
export const panelOpen = store(false);
let panelTabs: TabsHandle | undefined;
let panelSplit: SplitHandle | undefined;

/** Open the bottom panel on a tab (e.g. "problems"). */
export function showPanel(id?: string, focus = false): void {
  panelOpen.set(true);
  if (id) panelTabs?.select(id, focus);
}

export function togglePanel(): void {
  panelOpen.set(!panelOpen.get());
}

/** The page for a route: a two-segment route ("quality/heals") wins over its first segment. */
function resolvePage(r: Route): PageDef | undefined {
  return (r.segments[0] ? pageForRoute(`${r.page}/${r.segments[0]}`) : undefined) ?? pageForRoute(r.page || DEFAULT_PAGE);
}

export function mountShell(root: HTMLElement): void {
  clear(root);
  root.classList.remove('boot');
  root.removeAttribute('aria-busy');

  // ---------------------------------------------------------- title bar
  const projectEl = h('span', { class: 'tb-project' });
  const branchEl = h('span', { class: 'tb-branch', hidden: true });
  const themeBtn = h('button', { type: 'button', class: 'icon-btn', id: 'theme-toggle', onclick: () => toggleTheme() });
  effectiveTheme.subscribe((t) => {
    clear(themeBtn).appendChild(icon(t === 'dark' ? 'sun' : 'moon'));
    const label = t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    themeBtn.setAttribute('aria-label', label);
    themeBtn.title = label;
  });
  const titlebar = h(
    'header',
    { class: 'titlebar' },
    h('a', { class: 'brand', href: link(DEFAULT_PAGE), title: 'Home' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true', text: 'EZ' }), h('span', { class: 'brand-name' }, 'EZTest ', h('span', { text: 'Studio' }))),
    h('div', { class: 'tb-context' }, projectEl, branchEl),
    h(
      'button',
      { type: 'button', class: 'tb-search', id: 'palette-trigger', onclick: () => openPalette(), 'aria-keyshortcuts': 'Control+K Meta+K' },
      icon('search'),
      h('span', { class: 'tb-search-text', text: 'Search or run a command' }),
      h('kbd', { class: 'kbd', text: keyLabel('Mod+K') }),
    ),
    h('div', { class: 'tb-actions' }, themeBtn, h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Keyboard shortcuts', title: 'Keyboard shortcuts (?)', onclick: () => openShortcutsHelp() }, icon('keyboard'))),
  );
  session.subscribe((s) => {
    projectEl.textContent = s ? s.project : '';
    branchEl.hidden = !s?.branch;
    clear(branchEl);
    if (s?.branch) branchEl.append(icon('branch', { size: 13 }), h('span', { text: s.branch }));
  });

  // ---------------------------------------------------------- activity bar
  const navPrimary = h('ul', { class: 'ab-list' });
  const navQuality = h('ul', { class: 'ab-list ab-group', 'aria-labelledby': 'ab-quality-label' });
  const qualityLabel = h('p', { class: 'ab-group-label', id: 'ab-quality-label', text: 'Quality' });
  const qualityGroup = h('div', { class: 'ab-section', hidden: true }, qualityLabel, navQuality);
  const navSecondary = h('ul', { class: 'ab-list ab-bottom' });
  const activity = h('nav', { class: 'activitybar', 'aria-label': 'Studio sections' }, h('div', { class: 'ab-top' }, navPrimary, qualityGroup), navSecondary);
  const renderNav = () => {
    clear(navPrimary);
    clear(navQuality);
    clear(navSecondary);
    const curDef = resolvePage(route.get());
    for (const p of pages.get()) {
      if (p.hidden) continue;
      const active = p === curDef;
      const a = h(
        'a',
        { class: 'ab-item', href: link(p.route ?? p.id), 'aria-current': active ? 'page' : undefined, title: p.shortcut ? `${p.title} (${keyLabel(p.shortcut)})` : p.title, dataset: { page: p.id } },
        icon(p.icon, { size: 20 }),
        h('span', { class: 'ab-label', text: p.title }),
      );
      (p.group === 'secondary' ? navSecondary : p.group === 'quality' ? navQuality : navPrimary).appendChild(h('li', null, a));
    }
    qualityGroup.hidden = navQuality.childElementCount === 0;
  };

  // ---------------------------------------------------------- pages
  const main = h('main', { id: 'main', class: 'pages', tabindex: '-1' });
  const mounted = new Map<string, Mounted>();
  let current: Mounted | undefined;
  let firstShow = true;

  const show = (r: Route) => {
    const def = resolvePage(r) ?? pageForRoute(DEFAULT_PAGE);
    if (!def) return;
    let m = mounted.get(def.id);
    if (!m) {
      const pageRoot = h('section', { class: 'page', id: `page-${def.id}`, 'aria-label': def.title, tabindex: '-1' });
      main.appendChild(pageRoot);
      const instance =
        def.mount({
          root: pageRoot,
          route,
          setTitle: (t) => {
            if (current?.def === def) document.title = t ? `${t} · EZTest Studio` : `${def.title} · EZTest Studio`;
          },
        }) ?? {};
      m = { def, root: pageRoot, instance };
      mounted.set(def.id, m);
    }
    if (current && current !== m) {
      current.root.hidden = true;
      current.instance.hide?.();
    }
    const changed = current !== m;
    current = m;
    m.root.hidden = false;
    document.title = `${def.title} · EZTest Studio`;
    m.instance.show?.(r);
    renderNav();
    if (changed && !firstShow) {
      if (m.instance.focus) m.instance.focus();
      else (m.root.querySelector<HTMLElement>('h1') ?? m.root).focus();
    }
    firstShow = false;
  };

  // ---------------------------------------------------------- bottom panel
  const panelHost = h('section', { class: 'bottom-panel', 'aria-label': 'Panel' });
  panelTabs = createTabs({
    label: 'Panel',
    tabs: [],
    class: 'panel-tabs',
    actions: h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close panel', title: `Close panel (${keyLabel('Mod+J')})`, onclick: () => panelOpen.set(false) }, icon('close')),
  });
  panelHost.appendChild(panelTabs.el);
  panels.subscribe((list) => {
    panelTabs!.setTabs(list.map((p) => ({ id: p.id, title: p.title, mount: (el) => p.mount(el) })), panelTabs!.selected);
    for (const p of list) p.badge?.subscribe((v) => panelTabs!.setBadge(p.id, v));
  });
  panelSplit = createSplit({ direction: 'column', first: main, second: panelHost, size: 220, min: 90, sizeSecond: true, storageKey: 'panel', label: 'Resize panel', class: 'main-split' });
  panelOpen.subscribe((open) => panelSplit!.toggle(open));

  // ---------------------------------------------------------- status bar
  const left = h('div', { class: 'sb-left' });
  const right = h('div', { class: 'sb-right' });
  const statusbar = h('footer', { class: 'statusbar', 'aria-label': 'Status bar' }, left, right);
  statusItems.subscribe((items) => {
    clear(left);
    clear(right);
    for (const s of items) {
      const el = h('div', { class: 'sb-item', dataset: { item: s.id } });
      (s.align === 'left' ? left : right).appendChild(el);
      s.mount(el);
    }
  });

  root.append(
    h('a', { class: 'skip-link', href: '#main', onclick: (e: MouseEvent) => (e.preventDefault(), main.focus()) }, 'Skip to content'),
    titlebar,
    h('div', { class: 'workbench' }, activity, panelSplit.el),
    statusbar,
    h('div', { id: 'ez-announcer', class: 'sr-only', role: 'status', 'aria-live': 'polite' }),
  );

  pages.subscribe(() => {
    renderNav();
    if (route.get()) show(route.get());
  }, false);
  route.subscribe((r) => show(r));
}

/** Navigate to a page by id. */
export function goToPage(id: string, ...segments: string[]): void {
  const p = pages.get().find((x) => x.id === id);
  navigate(link(p?.route ?? id, ...segments));
}
