/**
 * Accessible tree view (ARIA tree): Up/Down move, Right expands or enters,
 * Left collapses or goes to the parent, Home/End jump, Enter activates, and
 * typing a letter jumps to the next matching item. Only one item is in the
 * tab order (roving tabindex).
 */
import { clear, h, type Child } from '../core/dom.js';
import { icon, type IconName } from './icons.js';

export interface TreeNode<D = unknown> {
  id: string;
  label: string;
  icon?: IconName;
  /** Secondary text after the label. */
  detail?: string;
  /** Extra content at the end of the row (badges). */
  decorations?: Child;
  /** Accessible description appended to the label. */
  description?: string;
  children?: Array<TreeNode<D>>;
  data?: D;
  class?: string;
}

export interface TreeOptions<D> {
  label: string;
  onActivate?(node: TreeNode<D>): void;
  onSelect?(node: TreeNode<D>): void;
  /** Expanded folder ids; default: all expanded. */
  expanded?: Set<string>;
  class?: string;
}

export interface TreeHandle<D> {
  el: HTMLElement;
  setNodes(nodes: Array<TreeNode<D>>): void;
  select(id: string | undefined, focus?: boolean): void;
  expandAll(open: boolean): void;
  focus(): void;
}

interface Flat<D> {
  node: TreeNode<D>;
  level: number;
  parent?: string;
  posinset: number;
  setsize: number;
}

export function createTree<D>(o: TreeOptions<D>): TreeHandle<D> {
  const el = h('ul', { class: ['tree', o.class], role: 'tree', 'aria-label': o.label });
  let nodes: Array<TreeNode<D>> = [];
  const collapsed = new Set<string>();
  let selected: string | undefined;
  let focusId: string | undefined;
  let flat: Array<Flat<D>> = [];

  const flatten = () => {
    flat = [];
    const walk = (list: Array<TreeNode<D>>, level: number, parent?: string) => {
      list.forEach((n, i) => {
        flat.push({ node: n, level, parent, posinset: i + 1, setsize: list.length });
        if (n.children && !collapsed.has(n.id)) walk(n.children, level + 1, n.id);
      });
    };
    walk(nodes, 1);
  };

  const render = () => {
    flatten();
    const hadFocus = el.contains(document.activeElement);
    if (!flat.some((f) => f.node.id === focusId)) focusId = (flat.find((f) => f.node.id === selected) ?? flat[0])?.node.id;
    clear(el);
    for (const f of flat) {
      const n = f.node;
      const isFolder = !!n.children;
      const open = isFolder && !collapsed.has(n.id);
      const li = h(
        'li',
        {
          class: ['tree-item', n.class, n.id === selected && 'selected'],
          role: 'treeitem',
          'aria-level': String(f.level),
          'aria-posinset': String(f.posinset),
          'aria-setsize': String(f.setsize),
          'aria-expanded': isFolder ? String(open) : undefined,
          'aria-selected': isFolder ? undefined : String(n.id === selected),
          tabindex: n.id === focusId ? '0' : '-1',
          dataset: { id: n.id },
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            focusId = n.id;
            if (isFolder) toggle(n.id);
            else activate(n);
          },
        },
        h(
          'span',
          { class: 'tree-row' },
          h('span', { class: 'tree-indent', 'aria-hidden': 'true' }),
          isFolder ? icon(open ? 'chevronDown' : 'chevronRight', { size: 14, class: 'tree-twisty' }) : h('span', { class: 'tree-twisty-space' }),
          icon(n.icon ?? (isFolder ? 'folder' : 'file'), { size: 15, class: 'tree-icon' }),
          h('span', { class: 'tree-label', text: n.label }),
          n.detail ? h('span', { class: 'tree-detail', text: n.detail }) : null,
          n.decorations ? h('span', { class: 'tree-deco' }, n.decorations) : null,
          n.description ? h('span', { class: 'sr-only', text: `, ${n.description}` }) : null,
        ),
      );
      (li.firstChild as HTMLElement).style.setProperty('--level', String(f.level - 1));
      el.appendChild(li);
    }
    if (hadFocus) focusItem(focusId);
  };

  const itemEl = (id: string | undefined) => (id === undefined ? null : el.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`));
  const focusItem = (id: string | undefined) => {
    focusId = id;
    el.querySelectorAll<HTMLElement>('[role="treeitem"]').forEach((x) => (x.tabIndex = x.dataset.id === id ? 0 : -1));
    itemEl(id)?.focus();
  };
  const toggle = (id: string, open?: boolean) => {
    const isOpen = !collapsed.has(id);
    if (open === undefined ? isOpen : !open) collapsed.add(id);
    else collapsed.delete(id);
    render();
    focusItem(id);
  };
  const activate = (n: TreeNode<D>) => {
    selected = n.id;
    render();
    focusItem(n.id);
    o.onSelect?.(n);
    o.onActivate?.(n);
  };

  el.addEventListener('keydown', (e) => {
    const i = flat.findIndex((f) => f.node.id === focusId);
    const f = flat[i];
    if (!f) return;
    const isFolder = !!f.node.children;
    let handled = true;
    switch (e.key) {
      case 'ArrowDown':
        focusItem(flat[Math.min(flat.length - 1, i + 1)]?.node.id);
        break;
      case 'ArrowUp':
        focusItem(flat[Math.max(0, i - 1)]?.node.id);
        break;
      case 'Home':
        focusItem(flat[0]?.node.id);
        break;
      case 'End':
        focusItem(flat[flat.length - 1]?.node.id);
        break;
      case 'ArrowRight':
        if (isFolder && collapsed.has(f.node.id)) toggle(f.node.id, true);
        else if (isFolder) focusItem(flat[i + 1]?.node.id);
        break;
      case 'ArrowLeft':
        if (isFolder && !collapsed.has(f.node.id)) toggle(f.node.id, false);
        else if (f.parent) focusItem(f.parent);
        break;
      case 'Enter':
      case ' ':
        if (isFolder) toggle(f.node.id);
        else activate(f.node);
        break;
      default:
        if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const ch = e.key.toLowerCase();
          const order = [...flat.slice(i + 1), ...flat.slice(0, i + 1)];
          const hit = order.find((x) => x.node.label.toLowerCase().startsWith(ch));
          if (hit) focusItem(hit.node.id);
        } else handled = false;
    }
    if (handled) e.preventDefault();
  });

  return {
    el,
    setNodes(next) {
      nodes = next;
      if (o.expanded) {
        const walk = (list: Array<TreeNode<D>>) => list.forEach((n) => {
          if (n.children) {
            if (!o.expanded!.has(n.id)) collapsed.add(n.id);
            walk(n.children);
          }
        });
        walk(nodes);
      }
      render();
    },
    select(id, focus = false) {
      selected = id;
      if (id) focusId = id;
      render();
      if (focus) focusItem(id);
      else itemEl(id)?.scrollIntoView({ block: 'nearest' });
    },
    expandAll(open) {
      if (open) collapsed.clear();
      else {
        const walk = (list: Array<TreeNode<D>>) => list.forEach((n) => {
          if (n.children) {
            collapsed.add(n.id);
            walk(n.children);
          }
        });
        walk(nodes);
      }
      render();
    },
    focus() {
      focusItem(focusId ?? flat[0]?.node.id);
    },
  };
}
