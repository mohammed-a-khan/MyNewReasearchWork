/**
 * Emulated combo boxes / drop-down lists / selects. A shared controller
 * (open, filter, async options with a loading state, choose, close on
 * outside click) renders each library's documented markup, including the
 * body-level popup containers they use (Kendo .k-animation-container,
 * DevExtreme .dx-overlay-wrapper, Angular CDK .cdk-overlay-container,
 * PrimeNG appended panels, Oracle JET .oj-listbox-drop, UI5 static area).
 */
import { CITIES, searchCities } from '../../data.js';
import { log } from '../page.js';
import { clear, h, onOutsideClick, placeUnder, uid } from './dom.js';

export interface ComboSkin {
  /** Build the popup shell; returns [shell appended to body, element options go into, optional search input]. */
  popup(id: string): { shell: HTMLElement; list: HTMLElement; search?: HTMLInputElement; loading?: HTMLElement };
  option(text: string, selected: boolean, i: number, id: string): HTMLElement;
  /** Class toggled on the root while open. */
  openClass?: string;
}

export interface ComboOptions {
  name: string;
  /** Static options, or undefined for async search against /api/cities. */
  options?: string[];
  async?: boolean;
  multiple?: boolean;
  /** Called after a choice with the selected values. */
  onChange(values: string[]): void;
}

/** Controller: knows nothing about markup except through the skin. */
export class ComboController {
  values: string[] = [];
  private shell: HTMLElement | null = null;
  private off: (() => void) | null = null;
  private query = '';
  private reqId = 0;
  readonly listId = uid('listbox');

  constructor(
    readonly root: HTMLElement,
    readonly anchor: HTMLElement,
    readonly skin: ComboSkin,
    readonly opts: ComboOptions,
    readonly ariaHost: HTMLElement,
  ) {
    ariaHost.setAttribute('aria-expanded', 'false');
    ariaHost.setAttribute('aria-controls', this.listId);
    ariaHost.setAttribute('aria-haspopup', 'listbox');
  }

  get isOpen(): boolean {
    return !!this.shell;
  }

  open(query = ''): void {
    this.query = query;
    if (!this.shell) {
      const p = this.skin.popup(this.listId);
      this.shell = p.shell;
      if (!p.shell.isConnected) {
        document.body.appendChild(p.shell);
        placeUnder(p.shell, this.anchor);
      }
      this.ariaHost.setAttribute('aria-expanded', 'true');
      if (this.skin.openClass) this.root.classList.add(this.skin.openClass);
      if (p.search) {
        p.search.addEventListener('input', () => this.filter(p.search!.value));
        setTimeout(() => p.search!.focus(), 0);
      }
      this.off = onOutsideClick(() => [this.root, this.shell], () => this.close());
    }
    this.fill();
  }

  filter(q: string): void {
    this.query = q;
    if (!this.shell) this.open(q);
    else this.fill();
  }

  private fill(): void {
    const shell = this.shell;
    if (!shell) return;
    const p = { list: shell.querySelector<HTMLElement>('[data-list]')!, loading: shell.querySelector<HTMLElement>('[data-loading]') };
    const id = ++this.reqId;
    const draw = (items: string[]) => {
      if (id !== this.reqId || !this.shell) return;
      placeUnder(this.shell, this.anchor);
      if (p.loading) p.loading.style.display = 'none';
      clear(p.list);
      items.forEach((t, i) => {
        const o = this.skin.option(t, this.values.includes(t), i, `${this.listId}-${i}`);
        o.addEventListener('mousedown', (e) => e.preventDefault());
        o.addEventListener('click', () => this.choose(t));
        p.list.appendChild(o);
      });
    };
    if (this.opts.async) {
      if (p.loading) p.loading.style.display = '';
      clear(p.list);
      fetch(`/api/cities?q=${encodeURIComponent(this.query)}&delay=350`).then((r) => r.json()).then(draw);
    } else {
      const all = this.opts.options ?? CITIES;
      draw(this.query ? all.filter((o) => o.toLowerCase().includes(this.query.toLowerCase())) : all);
    }
  }

  choose(t: string): void {
    if (this.opts.multiple) this.values = this.values.includes(t) ? this.values.filter((x) => x !== t) : [...this.values, t];
    else this.values = [t];
    log(`${this.opts.name}=${this.values.join(',')}`);
    this.opts.onChange(this.values);
    if (this.opts.multiple) this.fill();
    else this.close();
  }

  close(): void {
    this.off?.();
    this.off = null;
    this.shell?.remove();
    this.shell = null;
    this.ariaHost.setAttribute('aria-expanded', 'false');
    if (this.skin.openClass) this.root.classList.remove(this.skin.openClass);
  }
}

const loadingEl = (cls: string, text = 'Loading...') => h('div', { 'data-loading': '', class: cls, style: 'display: none' }, text);

// ------------------------------------------------------------------ Kendo

const kendoSkin = (filter = false): ComboSkin => ({
  popup: (id) => {
    const list = h('ul', { class: 'k-list-ul', role: 'listbox', id, 'data-list': '' });
    const search = filter ? (h('input', { class: 'k-input-inner', placeholder: 'Filter' }) as HTMLInputElement) : undefined;
    const shell = h('div', { class: 'k-animation-container' }, h('div', { class: 'k-popup k-list-container k-combobox-popup' },
      search ? h('div', { class: 'k-list-filter' }, h('span', { class: 'k-searchbox k-input' }, search)) : null,
      h('div', { class: 'k-list k-list-md' }, h('div', { class: 'k-list-content k-list-scroller', style: 'max-height: 200px; overflow: auto' }, list)),
      loadingEl('k-list-loading', ''),
      h('span', { 'data-loading': '', class: 'k-icon k-i-loading k-loading-icon', style: 'display: none' })));
    return { shell, list, search };
  },
  option: (t, sel, i, id) => h('li', { class: `k-list-item${sel ? ' k-selected' : ''}`, role: 'option', id, 'data-offset-index': i, 'aria-selected': sel ? 'true' : 'false' }, h('span', { class: 'k-list-item-text' }, t)),
});

/** Kendo ComboBox: editable input with type-ahead (async server filtering). */
export function kendoComboBox(host: HTMLElement, label: string): void {
  const id = uid('kcombo');
  const input = h('input', { id, class: 'k-input-inner', role: 'combobox', 'aria-autocomplete': 'list', autocomplete: 'off' }) as HTMLInputElement;
  const btn = h('button', { type: 'button', class: 'k-input-button k-button k-icon-button', 'aria-label': 'expand combobox', tabindex: -1 }, h('span', { class: 'k-icon k-svg-icon k-svg-i-caret-alt-down' }));
  const root = h('span', { class: 'k-combobox k-input k-input-md k-rounded-md k-input-solid' }, input, btn);
  host.appendChild(h('label', { for: id, class: 'k-label' }, label));
  host.appendChild(root);
  const c = new ComboController(root, root, kendoSkin(), { name: label, async: true, onChange: (v) => (input.value = v[0] ?? '') }, input);
  input.addEventListener('input', () => c.filter(input.value));
  btn.addEventListener('click', () => (c.isOpen ? c.close() : c.open(input.value)));
}

/** Kendo DropDownList: not editable; a filter box inside the popup. */
export function kendoDropDownList(host: HTMLElement, label: string, options: string[]): void {
  const labelId = uid('klabel');
  const valueText = h('span', { class: 'k-input-value-text' }, '');
  const root = h('span', { class: 'k-dropdownlist k-picker k-picker-md k-rounded-md k-picker-solid', role: 'combobox', tabindex: 0, 'aria-labelledby': labelId },
    h('span', { class: 'k-input-inner' }, valueText), h('button', { type: 'button', class: 'k-input-button k-button k-icon-button', 'aria-label': 'select', tabindex: -1 }, h('span', { class: 'k-icon k-svg-i-caret-alt-down' })));
  host.appendChild(h('span', { id: labelId, class: 'k-label' }, label));
  host.appendChild(root);
  const c = new ComboController(root, root, kendoSkin(true), { name: label, options, onChange: (v) => (valueText.textContent = v[0] ?? '') }, root);
  root.addEventListener('click', () => (c.isOpen ? c.close() : c.open()));
}

/** Kendo MultiSelect: chips + type-ahead. */
export function kendoMultiSelect(host: HTMLElement, label: string, options: string[]): void {
  const id = uid('kmulti');
  const chips = h('div', { class: 'k-chip-list k-selection-multiple', role: 'listbox' });
  const input = h('input', { id, class: 'k-input-inner', role: 'combobox', autocomplete: 'off' }) as HTMLInputElement;
  const root = h('div', { class: 'k-multiselect k-input k-input-md' }, h('div', { class: 'k-input-values' }, chips, input));
  host.appendChild(h('label', { for: id, class: 'k-label' }, label));
  host.appendChild(root);
  const c = new ComboController(root, root, kendoSkin(), { name: label, options, multiple: true, onChange: (v) => {
    clear(chips);
    v.forEach((t) => chips.appendChild(h('div', { class: 'k-chip k-chip-md', role: 'option', 'aria-selected': 'true' }, h('span', { class: 'k-chip-content' }, h('span', { class: 'k-chip-label' }, t)))));
    input.value = '';
  } }, input);
  input.addEventListener('input', () => c.filter(input.value));
  input.addEventListener('click', () => c.open(input.value));
}

// ------------------------------------------------------------------ DevExtreme

const dxSkin: ComboSkin = {
  popup: (id) => {
    const list = h('div', { class: 'dx-scrollview-content', 'data-list': '' });
    const shell = h('div', { class: 'dx-overlay-wrapper dx-dropdowneditor-overlay dx-popup-wrapper dx-dropdownlist-popup-wrapper dx-selectbox-popup-wrapper' },
      h('div', { class: 'dx-overlay-content dx-popup-normal dx-resizable' }, h('div', { class: 'dx-popup-content' },
        h('div', { class: 'dx-list dx-widget dx-collection', role: 'listbox', id }, h('div', { class: 'dx-scrollable-wrapper' }, h('div', { class: 'dx-scrollable-container', style: 'max-height: 200px; overflow: auto' }, h('div', { class: 'dx-scrollable-content' }, list)))),
        h('div', { 'data-loading': '', class: 'dx-loadindicator dx-widget', style: 'display: none' }, ''))));
    return { shell, list };
  },
  option: (t, sel, i, id) => h('div', { class: `dx-item dx-list-item${sel ? ' dx-list-item-selected' : ''}`, role: 'option', id, 'aria-selected': sel ? 'true' : 'false' }, h('div', { class: 'dx-item-content dx-list-item-content' }, t)),
  openClass: 'dx-state-focused',
};

/** dxSelectBox (searchEnabled: true, so the input is editable). */
export function dxSelectBox(host: HTMLElement, label: string, options: string[] | 'async', multiple = false): void {
  const input = h('input', { class: 'dx-texteditor-input', type: 'text', role: 'combobox', autocomplete: 'off', 'aria-label': label, 'aria-autocomplete': 'list' }) as HTMLInputElement;
  const tags = h('div', { class: 'dx-tag-container dx-texteditor-input-container' });
  const root = h('div', { class: `${multiple ? 'dx-tagbox' : 'dx-selectbox'} dx-textbox dx-texteditor dx-dropdowneditor-button-visible dx-editor-outlined dx-widget dx-dropdowneditor` },
    h('div', { class: 'dx-dropdowneditor-input-wrapper dx-selectbox-container' }, h('div', { class: 'dx-texteditor-container' }, multiple ? tags : null, h('div', { class: 'dx-texteditor-input-container' }, input),
      h('div', { class: 'dx-texteditor-buttons-container' }, h('div', { class: 'dx-widget dx-button-mode-text dx-button dx-dropdowneditor-button', role: 'button', 'aria-label': 'Select' }, h('div', { class: 'dx-button-content' }, h('div', { class: 'dx-dropdowneditor-icon' })))))));
  host.appendChild(h('div', { class: 'dx-field' }, h('div', { class: 'dx-field-label' }, label), h('div', { class: 'dx-field-value' }, root)));
  const c = new ComboController(root, root, dxSkin, { name: label, ...(options === 'async' ? { async: true } : { options }), multiple, onChange: (v) => {
    if (multiple) {
      clear(tags);
      v.forEach((t) => tags.appendChild(h('div', { class: 'dx-tag' }, h('div', { class: 'dx-tag-content' }, h('span', {}, t), h('div', { class: 'dx-tag-remove-button' })))));
      input.value = '';
    } else input.value = v[0] ?? '';
  } }, input);
  input.addEventListener('input', () => c.filter(input.value));
  input.addEventListener('click', () => (c.isOpen ? undefined : c.open(multiple ? '' : '')));
  root.querySelector('.dx-dropdowneditor-button')!.addEventListener('click', () => (c.isOpen ? c.close() : c.open()));
}

// ------------------------------------------------------------------ PrimeNG

/** p-dropdown with [filter]="true": a filter input in the overlay panel. */
export function primengDropdown(host: HTMLElement, label: string, options: string[]): void {
  const labelId = uid('plabel');
  const valueLabel = h('span', { class: 'p-dropdown-label p-inputtext p-placeholder', role: 'combobox', tabindex: 0, 'aria-labelledby': labelId }, 'Select a City');
  const root = h('div', { class: 'p-dropdown p-component p-inputwrapper' }, valueLabel, h('div', { class: 'p-dropdown-trigger', role: 'button', 'aria-label': 'dropdown trigger' }, h('span', { class: 'p-dropdown-trigger-icon pi pi-chevron-down' })));
  host.appendChild(h('label', { id: labelId }, label));
  host.appendChild(h('p-dropdown', {}, root));
  const skin: ComboSkin = {
    popup: (id) => {
      const list = h('ul', { class: 'p-dropdown-items', role: 'listbox', id, 'data-list': '' });
      const search = h('input', { type: 'text', class: 'p-dropdown-filter p-inputtext p-component', role: 'searchbox', autocomplete: 'off' }) as HTMLInputElement;
      const shell = h('div', { class: 'p-dropdown-panel p-component p-ripple-disabled' },
        h('div', { class: 'p-dropdown-header' }, h('div', { class: 'p-dropdown-filter-container' }, search, h('span', { class: 'p-dropdown-filter-icon pi pi-search' }))),
        h('div', { class: 'p-dropdown-items-wrapper', style: 'max-height: 200px; overflow: auto' }, list));
      return { shell, list, search };
    },
    option: (t, sel, i, id) => h('p-dropdownitem', {}, h('li', { class: `p-dropdown-item${sel ? ' p-highlight' : ''}`, role: 'option', id, 'aria-label': t, 'aria-selected': sel ? 'true' : 'false' }, h('span', {}, t))),
    openClass: 'p-dropdown-open',
  };
  const c = new ComboController(root, root, skin, { name: label, options, onChange: (v) => {
    valueLabel.textContent = v[0] ?? 'Select a City';
    valueLabel.classList.toggle('p-placeholder', !v[0]);
  } }, valueLabel);
  root.addEventListener('click', (e) => {
    if ((e.target as Element).closest('.p-dropdown-panel')) return;
    if (c.isOpen) c.close();
    else c.open();
  });
}

/** PrimeFaces selectOneMenu. */
export function pfSelectOneMenu(host: HTMLElement, label: string, options: string[]): void {
  const labelId = uid('pflabel');
  const valueLabel = h('label', { class: 'ui-selectonemenu-label ui-inputfield ui-corner-all' }, 'Select One');
  const root = h('div', { class: 'ui-selectonemenu ui-widget ui-state-default ui-corner-all', role: 'combobox', 'aria-labelledby': labelId },
    valueLabel, h('div', { class: 'ui-selectonemenu-trigger ui-state-default ui-corner-right' }, h('span', { class: 'ui-icon ui-icon-triangle-1-s ui-c' })));
  host.appendChild(h('label', { id: labelId }, label));
  host.appendChild(root);
  const skin: ComboSkin = {
    popup: (id) => {
      const list = h('ul', { class: 'ui-selectonemenu-items ui-selectonemenu-list ui-widget-content', role: 'listbox', id, 'data-list': '' });
      return { shell: h('div', { class: 'ui-selectonemenu-panel ui-widget ui-widget-content ui-corner-all ui-helper-hidden ui-shadow ui-input-overlay', style: 'display: block' }, h('div', { class: 'ui-selectonemenu-items-wrapper', style: 'max-height: 200px; overflow: auto' }, list)), list };
    },
    option: (t, sel, i, id) => h('li', { class: `ui-selectonemenu-item ui-selectonemenu-list-item ui-corner-all${sel ? ' ui-state-highlight' : ''}`, role: 'option', id, 'data-label': t }, t),
  };
  const c = new ComboController(root, root, skin, { name: label, options, onChange: (v) => (valueLabel.textContent = v[0] ?? '') }, root);
  root.addEventListener('click', () => (c.isOpen ? c.close() : c.open()));
}

// ------------------------------------------------------------------ Angular Material

const cdkOverlay = (): HTMLElement => {
  let c = document.querySelector<HTMLElement>('.cdk-overlay-container');
  if (!c) {
    c = h('div', { class: 'cdk-overlay-container' });
    document.body.appendChild(c);
  }
  return c;
};

/** mat-select inside a mat-form-field (panel in the CDK overlay container). */
export function matSelect(host: HTMLElement, label: string, options: string[], multiple = false): void {
  const labelId = uid('mat-mdc-form-field-label');
  const valueId = uid('mat-select-value');
  const value = h('div', { class: 'mat-mdc-select-value', id: valueId }, h('span', { class: 'mat-mdc-select-placeholder mat-mdc-select-min-line' }, ''));
  const select = h('mat-select', { role: 'combobox', 'aria-haspopup': 'listbox', class: `mat-mdc-select${multiple ? ' mat-mdc-select-multiple' : ''}`, tabindex: 0, 'aria-labelledby': `${labelId} ${valueId}`, ...(multiple ? { 'aria-multiselectable': 'true' } : {}) },
    h('div', { class: 'mat-mdc-select-trigger' }, value, h('div', { class: 'mat-mdc-select-arrow-wrapper' }, h('div', { class: 'mat-mdc-select-arrow' }))));
  host.appendChild(h('mat-form-field', { class: 'mat-mdc-form-field mat-mdc-form-field-type-mat-select' }, h('div', { class: 'mat-mdc-text-field-wrapper' },
    h('label', { class: 'mdc-floating-label', id: labelId }, h('mat-label', {}, label)), select)));
  // The CDK puts the panel in its own overlay container at the end of <body>.
  const realSkin: ComboSkin = {
    option: (t, sel, i, id) => h('mat-option', { role: 'option', class: `mat-mdc-option mdc-list-item${sel ? ' mdc-list-item--selected mat-mdc-option-active' : ''}`, id, 'aria-selected': sel ? 'true' : 'false' },
      multiple ? h('mat-pseudo-checkbox', { class: `mat-pseudo-checkbox${sel ? ' mat-pseudo-checkbox-checked' : ''}` }) : null, h('span', { class: 'mdc-list-item__primary-text' }, t)),
    popup: (id) => {
      const list = h('div', { role: 'listbox', id, class: 'mat-mdc-select-panel mdc-menu-surface mdc-menu-surface--open', 'aria-labelledby': labelId, 'data-list': '', style: 'max-height: 220px; overflow: auto; background: #fff' });
      const pane = h('div', { class: 'cdk-overlay-connected-position-bounding-box' }, h('div', { class: 'cdk-overlay-pane' }, list));
      cdkOverlay().appendChild(pane);
      placeUnder(pane, select);
      return { shell: pane, list };
    },
  };
  const c = new ComboController(select, select, realSkin, { name: label, options, multiple, onChange: (v) => {
    clear(value);
    value.appendChild(v.length ? h('span', { class: 'mat-mdc-select-value-text' }, h('span', { class: 'mat-mdc-select-min-line' }, v.join(', '))) : h('span', { class: 'mat-mdc-select-placeholder mat-mdc-select-min-line' }, ''));
  } }, select);
  select.addEventListener('click', () => (c.isOpen ? c.close() : c.open()));
  select.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') c.close();
  });
}

// ------------------------------------------------------------------ Oracle JET

/** oj-select-single with an async data provider (search as you type). */
export function jetSelectSingle(host: HTMLElement, label: string): void {
  const id = uid('oj-select');
  const labelId = `${id}-label`;
  const input = h('input', { id: `${id}|input`, class: 'oj-text-field-input oj-searchselect-input', role: 'combobox', 'aria-autocomplete': 'list', autocomplete: 'off', 'aria-labelledby': labelId }) as HTMLInputElement;
  const root = h('oj-select-single', { id, class: 'oj-select-single oj-searchselect oj-form-control oj-text-field oj-complete', 'label-hint': label },
    h('div', { class: 'oj-text-field-container', role: 'presentation' }, h('div', { class: 'oj-text-field-middle' }, input),
      h('span', { class: 'oj-searchselect-arrow oj-searchselect-open-icon oj-component-icon', role: 'presentation' })));
  host.appendChild(h('oj-label', { id: labelId, for: id }, h('label', {}, label)));
  host.appendChild(root);
  const skin: ComboSkin = {
    popup: (lid) => {
      const list = h('ul', { class: 'oj-listbox-results', role: 'listbox', id: lid, 'data-list': '' });
      return { shell: h('div', { class: 'oj-listbox-drop oj-select-results', style: 'background: #fff; border: 1px solid #ccc' }, h('div', { 'data-loading': '', class: 'oj-listbox-searching', style: 'display: none' }, 'Searching'), list), list };
    },
    option: (t, sel, i, oid) => h('li', { class: `oj-listbox-result oj-listbox-result-selectable${sel ? ' oj-selected' : ''}`, role: 'option', id: oid, 'aria-selected': sel ? 'true' : 'false' }, h('div', { class: 'oj-listbox-result-label' }, t)),
  };
  const c = new ComboController(root, root, skin, { name: label, async: true, onChange: (v) => (input.value = v[0] ?? '') }, input);
  input.addEventListener('input', () => c.filter(input.value));
  root.querySelector('.oj-searchselect-arrow')!.addEventListener('click', () => (c.isOpen ? c.close() : c.open()));
}

// ------------------------------------------------------------------ SAP UI5

/** sap.m.Select: picker in the UI5 static area. */
export function ui5Select(host: HTMLElement, label: string, options: string[]): void {
  const labelId = uid('__label');
  const text = h('span', { class: 'sapMSltLabel' }, h('span', { class: 'sapMSelectListItemText' }, options[0]));
  const root = h('div', { id: uid('__select'), class: 'sapMSlt sapMSltDefault sapMSltWithArrow', role: 'combobox', tabindex: 0, 'aria-labelledby': labelId },
    text, h('span', { class: 'sapMSltArrow', role: 'presentation' }), h('input', { class: 'sapMSltInput', type: 'hidden', value: options[0] }));
  host.appendChild(h('label', { id: labelId, class: 'sapMLabel' }, h('span', { class: 'sapMLabelTextWrapper' }, h('bdi', {}, label))));
  host.appendChild(root);
  let area = document.getElementById('sap-ui-static');
  if (!area) {
    area = h('div', { id: 'sap-ui-static', 'data-sap-ui-area': 'sap-ui-static' });
    document.body.appendChild(area);
  }
  const skin: ComboSkin = {
    popup: (id) => {
      const list = h('ul', { id, class: 'sapMSelectList', role: 'listbox', 'data-list': '' });
      return { shell: h('div', { class: 'sapMPopover sapMSltPicker', style: 'background: #fff; border: 1px solid #ccc' }, h('div', { class: 'sapMPopoverCont' }, list)), list };
    },
    option: (t, sel, i, id) => h('li', { id, class: `sapMSelectListItemBase sapMSelectListItem sapMSelectListItemBaseHoverable${sel ? ' sapMSelectListItemBaseSelected' : ''}`, role: 'option', 'aria-selected': sel ? 'true' : 'false' }, t),
    openClass: 'sapMSltPressed',
  };
  const c = new ComboController(root, root, skin, { name: label, options, onChange: (v) => {
    clear(text);
    text.appendChild(h('span', { class: 'sapMSelectListItemText' }, v[0] ?? ''));
  } }, root);
  root.addEventListener('click', () => (c.isOpen ? c.close() : c.open()));
}

export { searchCities };
