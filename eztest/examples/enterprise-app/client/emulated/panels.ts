/**
 * Emulated trees, tab sets, dialogs (stacked) and toasts per library, from
 * their documented markup.
 */
import { REGION_TREE, type TreeNode } from '../../data.js';
import { log } from '../page.js';
import { clear, h, uid } from './dom.js';

export type Lib = 'kendo' | 'devextreme' | 'primeng' | 'material' | 'ui5' | 'jet' | 'aria';

// ------------------------------------------------------------------ trees

interface TreeState {
  expanded: Set<string>;
  selected: string | null;
}

const key = (path: string[]) => path.join(' > ');

/** Children appear after a short delay the first time (lazy loading). */
function lazy(state: TreeState, k: string, render: () => void): void {
  if (state.expanded.has(k)) state.expanded.delete(k);
  else {
    state.expanded.add(k);
    setTimeout(render, 120);
    return;
  }
  render();
}

export function tree(host: HTMLElement, lib: Lib, label: string): void {
  const state: TreeState = { expanded: new Set(), selected: null };
  const render = () => {
    clear(host);
    host.appendChild(build());
  };
  const toggle = (k: string) => () => lazy(state, k, render);
  const select = (k: string) => () => {
    state.selected = k;
    log(`tree selected ${k}`);
    render();
  };
  const nodes = (list: TreeNode[], path: string[], level: number): HTMLElement[] => list.map((n) => {
    const p = [...path, n.label];
    const k = key(p);
    const open = state.expanded.has(k);
    const kids = n.children && open ? nodes(n.children, p, level + 1) : [];
    const leaf = !n.children;
    const sel = state.selected === k;
    const exp = leaf ? null : open ? 'true' : 'false';
    switch (lib) {
      case 'kendo':
        return h('li', { class: 'k-treeview-item', role: 'treeitem', 'aria-expanded': exp, 'aria-selected': sel ? 'true' : 'false', 'aria-level': level },
          h('div', { class: `k-treeview-${level === 1 ? 'top' : 'mid'}` },
            leaf ? null : h('span', { class: 'k-treeview-toggle', onclick: toggle(k) }, h('span', { class: `k-icon k-svg-icon ${open ? 'k-svg-i-caret-alt-down' : 'k-svg-i-caret-alt-right'}` })),
            h('span', { class: `k-treeview-leaf${sel ? ' k-selected' : ''}`, onclick: select(k) }, h('span', { class: 'k-treeview-leaf-text' }, n.label))),
          kids.length ? h('ul', { class: 'k-treeview-group', role: 'group' }, kids) : null);
      case 'devextreme':
        return h('li', { class: `dx-treeview-node${leaf ? ' dx-treeview-node-is-leaf' : ''}${sel ? ' dx-state-selected' : ''}`, role: 'treeitem', 'aria-expanded': exp, 'aria-level': level, 'aria-label': n.label, 'data-item-id': k },
          leaf ? null : h('div', { class: `dx-treeview-toggle-item-visibility${open ? ' dx-treeview-toggle-item-visibility-opened' : ''}`, onclick: toggle(k) }),
          h('div', { class: 'dx-item dx-treeview-item', onclick: select(k) }, h('div', { class: 'dx-item-content dx-treeview-item-content' }, h('span', {}, n.label))),
          kids.length ? h('ul', { class: 'dx-treeview-node-container dx-treeview-node-container-opened', role: 'group' }, kids) : null);
      case 'primeng':
        return h('p-treenode', {}, h('li', { class: 'p-treenode', role: 'treeitem', 'aria-label': n.label, 'aria-expanded': exp, 'aria-level': level, 'aria-selected': sel ? 'true' : 'false' },
          h('div', { class: `p-treenode-content p-treenode-selectable${sel ? ' p-highlight' : ''}` },
            h('button', { type: 'button', class: 'p-tree-toggler p-link', tabindex: -1, style: leaf ? 'visibility: hidden' : '', onclick: toggle(k) }, open ? 'v' : '>'),
            h('span', { class: 'p-treenode-label', onclick: select(k) }, h('span', {}, n.label))),
          kids.length ? h('ul', { class: 'p-treenode-children', role: 'group' }, kids) : null));
      case 'ui5':
        return h('li', { class: `sapMLIB sapMTreeItemBase${sel ? ' sapMLIBSelected' : ''}`, role: 'treeitem', 'aria-level': level, 'aria-expanded': exp, 'aria-selected': sel ? 'true' : 'false', style: `padding-left: ${level}rem` },
          leaf ? null : h('span', { class: 'sapMTreeItemBaseExpander sapUiIcon', role: 'presentation', onclick: toggle(k) }, open ? 'v' : '>'),
          h('div', { class: 'sapMSLIDiv', onclick: select(k) }, h('div', { class: 'sapMSLITitleOnly' }, n.label)));
      default:
        return h('li', { role: 'treeitem', 'aria-expanded': exp, 'aria-selected': sel ? 'true' : 'false', tabindex: -1, onclick: (e: Event) => {
          e.stopPropagation();
          if (leaf) select(k)();
          else toggle(k)();
        } }, h('span', { class: 'label' }, n.label), kids.length ? h('ul', { role: 'group' }, kids) : null);
    }
  });
  // mat-tree is a flat tree (siblings with aria-level), rendered separately.
  const flatMat = (): HTMLElement => {
    const rows: HTMLElement[] = [];
    const walk = (list: TreeNode[], path: string[], level: number) => {
      for (const n of list) {
        const p = [...path, n.label];
        const k = key(p);
        const open = state.expanded.has(k);
        rows.push(h('mat-tree-node', { class: 'mat-tree-node', role: 'treeitem', 'aria-level': level, 'aria-expanded': n.children ? (open ? 'true' : 'false') : null, style: `padding-left: ${(level - 1) * 40}px` },
          n.children ? h('button', { class: 'mdc-icon-button mat-mdc-icon-button', mattreenodetoggle: '', 'aria-label': `Toggle ${n.label}`, onclick: toggle(k) }, h('mat-icon', { class: 'mat-icon material-icons', 'aria-hidden': 'true' }, open ? 'expand_more' : 'chevron_right')) : h('button', { class: 'mdc-icon-button', disabled: true }),
          n.label));
        if (n.children && open) walk(n.children, p, level + 1);
      }
    };
    walk(REGION_TREE, [], 1);
    return h('mat-tree', { role: 'tree', class: 'mat-tree cdk-tree', 'aria-label': label }, rows);
  };
  const build = (): HTMLElement => {
    switch (lib) {
      case 'kendo': return h('div', { class: 'k-treeview', role: 'tree', 'aria-label': label }, h('ul', { class: 'k-treeview-lines k-treeview-group', role: 'none' }, nodes(REGION_TREE, [], 1)));
      case 'devextreme': return h('div', { class: 'dx-treeview dx-widget', role: 'tree', 'aria-label': label }, h('div', { class: 'dx-scrollable' }, h('ul', { class: 'dx-treeview-node-container dx-treeview-node-container-opened' }, nodes(REGION_TREE, [], 1))));
      case 'primeng': return h('p-tree', {}, h('div', { class: 'p-tree p-component' }, h('div', { class: 'p-tree-wrapper' }, h('ul', { class: 'p-tree-container', role: 'tree', 'aria-label': label }, nodes(REGION_TREE, [], 1)))));
      case 'ui5': {
        // sap.m.Tree renders flat list items with aria-level.
        const flat: HTMLElement[] = [];
        const walk = (list: TreeNode[], path: string[], level: number) => {
          for (const n of list) {
            const p = [...path, n.label];
            flat.push(...nodes([{ label: n.label, children: n.children }], path, level));
            if (n.children && state.expanded.has(key(p))) walk(n.children, p, level + 1);
          }
        };
        walk(REGION_TREE, [], 1);
        return h('div', { class: 'sapMList sapMTree' }, h('ul', { class: 'sapMListUl sapMListItems', role: 'tree', 'aria-label': label }, flat));
      }
      case 'material': return flatMat();
      default: return h('ul', { role: 'tree', 'aria-label': label }, nodes(REGION_TREE, [], 1));
    }
  };
  render();
}

// ------------------------------------------------------------------ tabs

export function tabs(host: HTMLElement, lib: Lib, label: string): void {
  const names = ['General', 'Billing', 'Security'];
  let active = 0;
  const render = () => {
    clear(host);
    const panel = h('div', { role: 'tabpanel', id: `${label}-panel-${active}` }, `${names[active]} settings panel`);
    const pick = (i: number) => () => {
      active = i;
      log(`tab ${names[i]}`);
      render();
    };
    switch (lib) {
      case 'kendo':
        host.appendChild(h('div', { class: 'k-tabstrip k-tabstrip-top', 'aria-label': label }, h('div', { class: 'k-tabstrip-items-wrapper k-hstack' },
          h('ul', { class: 'k-tabstrip-items k-reset', role: 'tablist' }, names.map((n, i) => h('li', { class: `k-item k-tabstrip-item${i === active ? ' k-active' : ''}`, role: 'tab', 'aria-selected': i === active ? 'true' : 'false', 'aria-controls': `${label}-panel-${i}`, onclick: pick(i) }, h('span', { class: 'k-link' }, n))))),
        h('div', { class: 'k-tabstrip-content k-active', role: 'tabpanel', id: `${label}-panel-${active}` }, `${names[active]} settings panel`)));
        return;
      case 'devextreme':
        host.appendChild(h('div', { class: 'dx-tabpanel dx-widget', 'aria-label': label }, h('div', { class: 'dx-tabpanel-tabs' }, h('div', { class: 'dx-tabs dx-widget', role: 'tablist' },
          h('div', { class: 'dx-tabs-wrapper' }, names.map((n, i) => h('div', { class: `dx-item dx-tab${i === active ? ' dx-tab-selected' : ''}`, role: 'tab', 'aria-selected': i === active ? 'true' : 'false', onclick: pick(i) }, h('div', { class: 'dx-item-content dx-tab-content' }, h('span', { class: 'dx-tab-text' }, n))))))), panel));
        return;
      case 'primeng':
        host.appendChild(h('p-tabview', {}, h('div', { class: 'p-tabview p-component', 'aria-label': label }, h('div', { class: 'p-tabview-nav-container' }, h('div', { class: 'p-tabview-nav-content' },
          h('ul', { class: 'p-tabview-nav', role: 'tablist' }, names.map((n, i) => h('li', { class: i === active ? 'p-highlight' : '', role: 'presentation' },
            h('a', { class: 'p-tabview-nav-link', role: 'tab', 'aria-selected': i === active ? 'true' : 'false', tabindex: 0, onclick: pick(i) }, h('span', { class: 'p-tabview-title' }, n))))))), h('div', { class: 'p-tabview-panels' }, panel))));
        return;
      case 'material':
        host.appendChild(h('mat-tab-group', { class: 'mat-mdc-tab-group', 'aria-label': label }, h('mat-tab-header', { class: 'mat-mdc-tab-header' }, h('div', { class: 'mat-mdc-tab-label-container' },
          h('div', { class: 'mat-mdc-tab-list', role: 'tablist' }, h('div', { class: 'mat-mdc-tab-labels' }, names.map((n, i) => h('div', { role: 'tab', class: `mdc-tab mat-mdc-tab mat-focus-indicator${i === active ? ' mdc-tab--active mdc-tab-indicator--active' : ''}`, 'aria-selected': i === active ? 'true' : 'false', onclick: pick(i) },
            h('span', { class: 'mdc-tab__content' }, h('span', { class: 'mdc-tab__text-label' }, n)))))))), h('div', { class: 'mat-mdc-tab-body-wrapper' }, panel)));
        return;
      case 'ui5':
        host.appendChild(h('div', { class: 'sapMITB', 'aria-label': label }, h('div', { class: 'sapMITH' }, h('div', { class: 'sapMITBHead', role: 'tablist' }, names.map((n, i) => h('div', { class: `sapMITBItem sapMITBFilter${i === active ? ' sapMITBSelected' : ''}`, role: 'tab', 'aria-selected': i === active ? 'true' : 'false', onclick: pick(i) }, h('div', { class: 'sapMITBText' }, n))))), h('div', { class: 'sapMITBContainerContent' }, panel)));
        return;
      default:
        host.appendChild(h('div', { class: 'tabs' }, h('div', { role: 'tablist', 'aria-label': label }, names.map((n, i) => h('button', { role: 'tab', 'aria-selected': i === active ? 'true' : 'false', 'aria-controls': `${label}-panel-${i}`, tabindex: i === active ? 0 : -1, onclick: pick(i) }, n))), panel));
    }
  };
  render();
}

// ------------------------------------------------------------------ dialogs (stacked) and toasts

export function toast(lib: Lib, text: string, ms = 1500): void {
  let el: HTMLElement;
  switch (lib) {
    case 'kendo': el = h('div', { class: 'k-notification k-notification-success', role: 'alert' }, h('div', { class: 'k-notification-content' }, text)); break;
    case 'devextreme': el = h('div', { class: 'dx-overlay-wrapper dx-toast-wrapper' }, h('div', { class: 'dx-overlay-content dx-toast-success', role: 'alert' }, h('div', { class: 'dx-toast-content' }, h('div', { class: 'dx-toast-message' }, text)))); break;
    case 'primeng': el = h('div', { class: 'p-toast p-component' }, h('div', { class: 'p-toast-message p-toast-message-success', role: 'alert' }, h('div', { class: 'p-toast-message-content' }, h('div', { class: 'p-toast-message-text' }, h('div', { class: 'p-toast-summary' }, 'Success'), h('div', { class: 'p-toast-detail' }, text))))); break;
    case 'material': el = h('div', { class: 'mat-mdc-snack-bar-container' }, h('div', { class: 'mdc-snackbar__surface' }, h('div', { class: 'mat-mdc-snack-bar-label mdc-snackbar__label', 'aria-live': 'polite' }, text))); break;
    case 'ui5': el = h('div', { class: 'sapMMessageToast', role: 'alert' }, text); break;
    case 'jet': el = h('div', { class: 'oj-message', role: 'alert' }, h('div', { class: 'oj-message-summary' }, text)); break;
    default: el = h('div', { role: 'status', class: 'toast' }, text);
  }
  el.style.position = 'fixed';
  el.style.bottom = '16px';
  el.style.right = '16px';
  el.style.background = '#333';
  el.style.color = '#fff';
  el.style.padding = '8px';
  el.style.zIndex = '3000';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

interface DialogSpec {
  title: string;
  body: string;
  buttons: Array<{ text: string; onClick(close: () => void): void }>;
}

let zTop = 1000;
/** Open dialogs, top last: Escape closes the top one (the overlay services listen on the document). */
const stack: Array<() => void> = [];
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stack.length) stack[stack.length - 1]();
});

export function dialog(lib: Lib, spec: DialogSpec): void {
  const titleId = uid('dlg-title');
  zTop += 10;
  let el: HTMLElement;
  const close = () => {
    el.remove();
    overlay?.remove();
    const i = stack.indexOf(close);
    if (i >= 0) stack.splice(i, 1);
  };
  stack.push(close);
  const btns = spec.buttons.map((b) => {
    const cls = lib === 'kendo' ? 'k-button k-button-md' : lib === 'devextreme' ? 'dx-button dx-widget' : lib === 'primeng' ? 'p-button p-component' : lib === 'material' ? 'mdc-button mat-mdc-button' : lib === 'ui5' ? 'sapMBtn' : lib === 'jet' ? 'oj-button' : '';
    const label = lib === 'ui5' ? h('span', { class: 'sapMBtnContent' }, h('bdi', {}, b.text)) : lib === 'primeng' ? h('span', { class: 'p-button-label' }, b.text) : b.text;
    return h('button', { type: 'button', class: cls, onclick: () => b.onClick(close) }, label);
  });
  const closeX = (cls: string) => h('button', { type: 'button', class: cls, 'aria-label': 'Close', onclick: close }, 'x');
  let overlay: HTMLElement | null = null;
  switch (lib) {
    case 'kendo':
      overlay = h('div', { class: 'k-overlay' });
      el = h('div', { class: 'k-window k-dialog', role: 'dialog', 'aria-labelledby': titleId, 'aria-modal': 'true' },
        h('div', { class: 'k-window-titlebar k-dialog-titlebar' }, h('span', { class: 'k-window-title k-dialog-title', id: titleId }, spec.title), h('div', { class: 'k-window-titlebar-actions' }, closeX('k-window-titlebar-action k-button k-icon-button'))),
        h('div', { class: 'k-window-content k-dialog-content' }, spec.body), h('div', { class: 'k-dialog-actions k-actions' }, btns));
      break;
    case 'devextreme':
      el = h('div', { class: 'dx-overlay-wrapper dx-popup-wrapper dx-overlay-modal dx-overlay-shader' }, h('div', { class: 'dx-overlay-content dx-popup-normal dx-resizable', role: 'dialog', 'aria-labelledby': titleId },
        h('div', { class: 'dx-popup-title dx-toolbar dx-widget' }, h('div', { class: 'dx-toolbar-items-container' }, h('div', { class: 'dx-toolbar-before' }, h('div', { class: 'dx-item dx-toolbar-item dx-toolbar-label' }, h('div', { class: 'dx-item-content dx-toolbar-item-content', id: titleId }, spec.title))),
          h('div', { class: 'dx-toolbar-after' }, h('div', { class: 'dx-closebutton dx-button dx-widget', role: 'button', 'aria-label': 'Close', onclick: () => close() }, 'x')))),
        h('div', { class: 'dx-popup-content' }, spec.body), h('div', { class: 'dx-popup-bottom dx-toolbar' }, btns)));
      break;
    case 'primeng':
      el = h('div', { class: 'p-dialog-mask p-component-overlay p-component-overlay-enter' }, h('div', { class: 'p-dialog p-component', role: 'dialog', 'aria-labelledby': titleId, 'aria-modal': 'true' },
        h('div', { class: 'p-dialog-header' }, h('span', { class: 'p-dialog-title', id: titleId }, spec.title), h('div', { class: 'p-dialog-header-icons' }, closeX('p-dialog-header-icon p-dialog-header-close p-link'))),
        h('div', { class: 'p-dialog-content' }, spec.body), h('div', { class: 'p-dialog-footer' }, btns)));
      break;
    case 'material': {
      const container = document.querySelector('.cdk-overlay-container') ?? document.body.appendChild(h('div', { class: 'cdk-overlay-container' }));
      el = h('div', { class: 'cdk-global-overlay-wrapper' }, h('div', { class: 'cdk-overlay-pane mat-mdc-dialog-panel' }, h('mat-dialog-container', { class: 'mat-mdc-dialog-container mdc-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
        h('div', { class: 'mdc-dialog__container' }, h('div', { class: 'mat-mdc-dialog-surface mdc-dialog__surface' },
          h('h2', { class: 'mat-mdc-dialog-title mdc-dialog__title', id: titleId }, spec.title), h('mat-dialog-content', { class: 'mat-mdc-dialog-content mdc-dialog__content' }, spec.body), h('mat-dialog-actions', { class: 'mat-mdc-dialog-actions mdc-dialog__actions' }, btns))))));
      container.appendChild(el);
      el.style.position = 'fixed';
      el.style.inset = '0';
      el.style.zIndex = String(zTop);
      el.style.background = 'rgba(0,0,0,0.2)';
      return;
    }
    case 'ui5':
      el = h('div', { class: 'sapMDialog sapMPopup-CTX', role: 'dialog', 'aria-labelledby': titleId, 'aria-modal': 'true' },
        h('header', {}, h('div', { class: 'sapMDialogTitleGroup' }, h('div', { class: 'sapMIBar sapMBar' }, h('div', { class: 'sapMBarMiddle' }, h('h1', { class: 'sapMTitle sapMDialogTitle', id: titleId }, spec.title))))),
        h('section', { class: 'sapMDialogSection' }, spec.body), h('footer', { class: 'sapMDialogFooter' }, btns));
      break;
    case 'jet':
      el = h('oj-dialog', { class: 'oj-dialog oj-component', role: 'dialog', 'aria-labelledby': titleId }, h('div', { class: 'oj-dialog-header' }, h('div', { class: 'oj-dialog-title', id: titleId }, spec.title)), h('div', { class: 'oj-dialog-body' }, spec.body), h('div', { class: 'oj-dialog-footer' }, btns));
      break;
    default:
      el = h('div', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, class: 'dialog' }, h('h2', { id: titleId }, spec.title), h('p', {}, spec.body), h('div', {}, btns, closeX('close')));
  }
  for (const x of [overlay, el]) {
    if (!x) continue;
    x.style.position = 'fixed';
    x.style.zIndex = String(zTop);
  }
  if (overlay) {
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(0,0,0,0.2)';
    document.body.appendChild(overlay);
  }
  el.style.top = `${60 + (zTop % 100)}px`;
  el.style.left = `${120 + (zTop % 100)}px`;
  el.style.background = '#fff';
  el.style.border = '1px solid #888';
  el.style.padding = '12px';
  document.body.appendChild(el);
}

/** "Edit order" opens a dialog whose Delete opens a second (stacked) confirmation. */
export function dialogDemo(host: HTMLElement, lib: Lib): void {
  host.appendChild(h('button', { type: 'button', id: 'open-dialog', onclick: () => dialog(lib, {
    title: 'Edit order', body: 'Order 42',
    buttons: [
      { text: 'Delete', onClick: (closeFirst) => dialog(lib, { title: 'Confirm delete', body: 'Delete order 42?', buttons: [
        { text: 'Cancel', onClick: (c) => c() },
        { text: 'Delete', onClick: (c) => {
          c();
          closeFirst();
          toast(lib, 'Order deleted', 700);
        } },
      ] }) },
      { text: 'Close', onClick: (c) => c() },
    ],
  }) }, 'Edit order'));
  host.appendChild(h('button', { type: 'button', id: 'save', onclick: () => toast(lib, 'Order saved', 400) }, 'Save'));
}
