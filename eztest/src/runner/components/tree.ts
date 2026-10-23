/**
 * Tree views: walk a path of labels ("Europe > Germany > Berlin") level by
 * level, expanding each node (toggle button, click, or ArrowRight as the
 * WAI-ARIA tree pattern defines), waiting for lazily loaded children, and
 * verify the final node is expanded, collapsed or selected.
 */
import type { Locator } from '../../browser/index.js';
import { ComponentError } from './engine.js';
import { detectAdapter } from './registry.js';
import type { ComponentReport, TreeDialect } from './types.js';
import { DEFAULT_TIMEOUT, ms, normText, poll, Scope, type OpOptions } from './util.js';

interface TreeItem {
  tag: string;
  label: string;
  level: number;
  expanded: boolean | null;
  selected: boolean;
  toggle: string | null;
  click: string;
}

export type TreeAction = 'expand' | 'collapse' | 'select' | 'reveal';

/** Split "Europe > Germany > Berlin" (also "/" or "→") into labels. */
export function treePath(path: string): string[] {
  return path.split(/\s*(?:>|→|\/)\s*/).map((s) => s.trim()).filter(Boolean);
}

export async function treeAction(loc: Locator, path: string[], action: TreeAction, opts: OpOptions = {}): Promise<ComponentReport> {
  const t0 = Date.now();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  if (!path.length) throw new ComponentError('name the tree node, e.g. "Europe > Germany"', 'COMPONENT_NO_NODE');
  const scope = await Scope.of(loc, timeout);
  await scope.call('clearMarks');
  const adapter = await detectAdapter<TreeDialect>('tree', scope.loc, opts.adapter);
  const d = adapter.dialect;
  const items = () => scope.call<TreeItem[]>('treeItems', { d });

  /** The child of the node at `parent` (index into the list, -1 = root) labelled `label`. */
  const childOf = (list: TreeItem[], parent: number, label: string): { hit?: TreeItem; index: number; siblings: string[] } => {
    const level = parent < 0 ? Math.min(...list.map((i) => i.level)) : list[parent].level + 1;
    const kids: Array<{ item: TreeItem; index: number }> = [];
    for (let i = parent + 1; i < list.length; i++) {
      if (parent >= 0 && list[i].level <= list[parent].level) break;
      if (list[i].level === level) kids.push({ item: list[i], index: i });
    }
    const n = normText(label);
    let hits = kids.filter((k) => k.item.label === n);
    if (!hits.length) hits = kids.filter((k) => k.item.label.toLowerCase() === n.toLowerCase());
    if (hits.length > 1) throw new ComponentError(`${hits.length} tree nodes are labelled "${label}" at the same level`, 'COMPONENT_AMBIGUOUS');
    return { hit: hits[0]?.item, index: hits[0]?.index ?? -1, siblings: kids.map((k) => k.item.label) };
  };

  const find = async (labels: string[]): Promise<{ item: TreeItem; index: number }> => {
    let list = await items();
    let parent = -1;
    let found: { item: TreeItem; index: number } | undefined;
    for (const [i, label] of labels.entries()) {
      let c = childOf(list, parent, label);
      if (!c.hit) {
        // Children may still be loading.
        const late = await poll(async () => {
          list = await items();
          const x = childOf(list, parent, label);
          return x.hit ? x : undefined;
        }, Math.min(timeout, 4000));
        if (!late) throw new ComponentError(`no node "${label}" under "${labels.slice(0, i).join(' > ') || 'the tree root'}" (found: ${c.siblings.map((s) => `"${s}"`).join(', ') || 'nothing'})`, 'COMPONENT_NO_NODE');
        c = late;
      }
      found = { item: c.hit!, index: c.index };
      parent = c.index;
    }
    return found!;
  };

  const setExpanded = async (labels: string[], want: boolean): Promise<void> => {
    const { item } = await find(labels);
    if (item.expanded === want) return;
    if (item.expanded === null && want) return; // a leaf: nothing to expand
    const tries: Array<() => Promise<void>> = [];
    if (item.toggle) tries.push(() => scope.el(item.toggle!, 'tree toggle').click({ timeout }));
    tries.push(() => scope.el(item.click, 'tree node').click({ timeout }));
    tries.push(async () => {
      await scope.el(item.tag, 'tree node').focus({ timeout });
      await scope.el(item.tag, 'tree node').press(want ? 'ArrowRight' : 'ArrowLeft', { timeout });
    });
    for (const t of tries) {
      await t();
      const ok = await poll(async () => ((await find(labels)).item.expanded === want ? true : undefined), Math.min(timeout, 2500));
      if (ok) return;
    }
    throw new ComponentError(`tree node "${labels.join(' > ')}" did not ${want ? 'expand' : 'collapse'}`, 'COMPONENT_VERIFY');
  };

  for (let i = 1; i < path.length; i++) await setExpanded(path.slice(0, i), true);
  let verified: string;
  if (action === 'expand') {
    await setExpanded(path, true);
    const it = (await find(path)).item;
    verified = it.expanded === null ? `"${path.join(' > ')}" is shown (a leaf node)` : `"${path.join(' > ')}" is expanded`;
  } else if (action === 'collapse') {
    await setExpanded(path, false);
    verified = `"${path.join(' > ')}" is collapsed`;
  } else if (action === 'select') {
    const { item } = await find(path);
    await scope.el(item.click, 'tree node').click({ timeout });
    const ok = await poll(async () => ((await find(path)).item.selected ? true : undefined), Math.min(timeout, 3000));
    if (!ok) throw new ComponentError(`tree node "${path.join(' > ')}" was clicked but is not selected`, 'COMPONENT_VERIFY');
    verified = `"${path.join(' > ')}" is selected`;
  } else {
    await find(path);
    verified = `"${path.join(' > ')}" is shown`;
  }
  return { kind: 'tree', adapter: d.id, library: adapter.id, op: action, verified: `${verified} (${adapter.label})`, ms: ms(t0), details: { path } };
}
