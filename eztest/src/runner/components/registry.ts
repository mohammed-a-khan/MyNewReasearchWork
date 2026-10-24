/**
 * Adapter registry and automatic detection: for a target element and a widget
 * kind, the first adapter (in priority order: custom, library, generic ARIA)
 * whose widget is at, around or uniquely inside the target is used.
 */
import type { Locator } from '../../browser/index.js';
import {
  ACCORDION_DIALECTS, COMBO_DIALECTS, DATE_DIALECTS, DROPZONE_DIALECTS, EDITOR_DIALECTS, GRID_DIALECTS, SLIDER_DIALECTS, TABS_DIALECTS, TREE_DIALECTS,
  type DialectEntry,
} from './dialects.js';
import { ComponentError, engine } from './engine.js';
import type { AdapterFixture, BaseDialect, ComponentAdapter, WidgetKind } from './types.js';
import { noteLocalRegistration } from '../workers/local.js';

/** A dialect-driven adapter: detection runs the shared engine with this adapter's root selector. */
export class DialectAdapter<D extends BaseDialect = BaseDialect> implements ComponentAdapter<D> {
  constructor(
    readonly kind: WidgetKind,
    readonly id: string,
    readonly label: string,
    readonly fixture: AdapterFixture,
    readonly dialect: D,
  ) {}

  async detect(root: Locator): Promise<boolean> {
    const [r] = await engine<Array<{ found: boolean }>>(root, 'detect', [this.dialect]);
    return !!r?.found;
  }
}

function fromEntries<D extends BaseDialect>(list: Array<DialectEntry<D>>): Array<DialectAdapter<D>> {
  return list.map((x) => new DialectAdapter<D>(x.kind, x.library, x.label, x.fixture, x.dialect));
}

const BUILT_IN: Partial<Record<WidgetKind, ComponentAdapter[]>> = {
  grid: fromEntries(GRID_DIALECTS),
  combobox: fromEntries(COMBO_DIALECTS),
  datepicker: fromEntries(DATE_DIALECTS),
  tree: fromEntries(TREE_DIALECTS),
  tabs: fromEntries(TABS_DIALECTS),
  accordion: fromEntries(ACCORDION_DIALECTS),
  richtext: fromEntries(EDITOR_DIALECTS),
  slider: fromEntries(SLIDER_DIALECTS),
  dropzone: fromEntries(DROPZONE_DIALECTS),
};

const CUSTOM: ComponentAdapter[] = [];

/**
 * Register an adapter for an in-house or unsupported library. Custom adapters
 * are tried before the built-in ones. Returns a function that removes it.
 */
export function registerComponentAdapter(adapter: ComponentAdapter): () => void {
  CUSTOM.unshift(adapter);
  const forget = noteLocalRegistration('a custom component adapter');
  return () => {
    const i = CUSTOM.indexOf(adapter);
    if (i >= 0) CUSTOM.splice(i, 1);
    forget();
  };
}

/** Every adapter of a kind, in detection order. */
export function adaptersFor(kind: WidgetKind): ComponentAdapter[] {
  return [...CUSTOM.filter((a) => a.kind === kind), ...(BUILT_IN[kind] ?? [])];
}

/** Every registered adapter (for docs and the adapter matrix). */
export function allAdapters(): ComponentAdapter[] {
  return [...CUSTOM, ...Object.values(BUILT_IN).flat()] as ComponentAdapter[];
}

/**
 * Find the adapter for the widget at `root`. Dialect adapters are detected in
 * one in-page call; custom adapters with their own detect() are asked in turn.
 */
export async function detectAdapter<D extends BaseDialect>(kind: WidgetKind, root: Locator, prefer?: string): Promise<ComponentAdapter<D>> {
  const list = adaptersFor(kind).filter((a) => !prefer || a.id === prefer || a.dialect.id === prefer);
  if (!list.length) throw new ComponentError(prefer ? `no ${kind} adapter "${prefer}"` : `no ${kind} adapters registered`, 'COMPONENT');
  const dialectOnly = list.every((a) => a instanceof DialectAdapter);
  if (dialectOnly) {
    const res = await engine<Array<{ id: string; found: boolean; count: number }>>(root, 'detect', list.map((a) => a.dialect));
    const i = res.findIndex((r) => r.found);
    if (i >= 0) return list[i] as ComponentAdapter<D>;
    const many = res.find((r) => r.count > 1);
    if (many) throw new ComponentError(`the target holds ${many.count} ${kind === 'grid' ? 'grids' : `${kind} widgets`}; name the one you mean`, 'COMPONENT_AMBIGUOUS');
  } else {
    for (const a of list) if (await a.detect(root)) return a as ComponentAdapter<D>;
  }
  throw new ComponentError(`no ${kind} found at the target (tried: ${list.map((a) => a.label).join(', ')})`, 'COMPONENT_NOT_FOUND');
}
