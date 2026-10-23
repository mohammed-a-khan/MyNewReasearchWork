/**
 * Emulated date pickers: one controller (month navigation, day choice, typed
 * input parsed with the widget's locale format) behind each library's
 * documented calendar markup: Kendo DatePicker, DevExtreme dxDateBox, PrimeNG
 * p-calendar, Angular Material mat-datepicker, SAP UI5 sap.m.DatePicker and
 * the WAI-ARIA APG date picker dialog.
 */
import { log } from '../page.js';
import { clear, fmtDate, h, monthGrid, monthName, onOutsideClick, parseDate, placeUnder, sameYmd, today, uid, type YMD } from './dom.js';

export interface DaySpec {
  date: YMD;
  outside: boolean;
  selected: boolean;
  today: boolean;
}

export interface CalendarSkin {
  /** Build the whole popup for the shown month; wire prev/next/day clicks with the callbacks. */
  render(shown: { y: number; m: number }, days: DaySpec[], cb: { prev(): void; next(): void; pick(d: YMD): void }, locale: string): HTMLElement;
}

export class DateController {
  value: YMD | null = null;
  shown: { y: number; m: number };
  private popup: HTMLElement | null = null;
  private off: (() => void) | null = null;

  constructor(
    readonly anchor: HTMLElement,
    readonly input: HTMLInputElement,
    readonly format: string,
    readonly locale: string,
    readonly skin: CalendarSkin,
    readonly name: string,
    readonly onSet: (d: YMD | null) => void = () => undefined,
  ) {
    const t = today();
    this.shown = { y: t.y, m: t.m };
    input.addEventListener('change', () => this.typed());
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') this.typed();
    });
  }

  private typed(): void {
    const d = parseDate(this.input.value, this.format, this.locale);
    if (d) this.set(d, false);
  }

  set(d: YMD | null, fromCalendar = true): void {
    this.value = d;
    this.input.value = d ? fmtDate(d, this.format, this.locale) : '';
    if (d) this.shown = { y: d.y, m: d.m };
    log(`${this.name}=${d ? `${d.y}-${String(d.m + 1).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : ''}${fromCalendar ? ' (calendar)' : ' (typed)'}`);
    this.onSet(d);
    if (fromCalendar) this.close();
  }

  get isOpen(): boolean {
    return !!this.popup;
  }

  toggle(): void {
    if (this.popup) this.close();
    else this.open();
  }

  open(): void {
    if (this.value) this.shown = { y: this.value.y, m: this.value.m };
    this.draw();
    this.off = onOutsideClick(() => [this.anchor, this.popup], () => this.close());
  }

  private draw(): void {
    const t = today();
    const days = monthGrid(this.shown.y, this.shown.m).map((x) => ({ ...x, selected: sameYmd(x.date, this.value), today: sameYmd(x.date, t) }));
    const step = (n: number) => () => {
      const d = new Date(this.shown.y, this.shown.m + n, 1);
      this.shown = { y: d.getFullYear(), m: d.getMonth() };
      // Real libraries animate the month change; re-render a moment later.
      setTimeout(() => this.draw(), 60);
    };
    const el = this.skin.render(this.shown, days, { prev: step(-1), next: step(1), pick: (d) => this.set(d) }, this.locale);
    if (this.popup) this.popup.replaceWith(el);
    else document.body.appendChild(el);
    placeUnder(el, this.anchor);
    this.popup = el;
  }

  close(): void {
    this.off?.();
    this.off = null;
    this.popup?.remove();
    this.popup = null;
  }
}

const weekRows = (days: DaySpec[]) => Array.from({ length: 6 }, (_, w) => days.slice(w * 7, w * 7 + 7));

// ------------------------------------------------------------------ Kendo

const kendoSkin: CalendarSkin = {
  render: (shown, days, cb, locale) => h('div', { class: 'k-animation-container' }, h('div', { class: 'k-calendar-container k-popup' },
    h('div', { class: 'k-calendar k-calendar-md', role: 'grid' },
      h('div', { class: 'k-calendar-header' },
        h('a', { href: '#', class: 'k-calendar-title k-title k-button k-button-flat', 'aria-live': 'polite', onclick: (e: Event) => e.preventDefault() }, `${monthName(shown.m, locale)} ${shown.y}`),
        h('span', { class: 'k-spacer' }),
        h('span', { class: 'k-calendar-nav' },
          h('a', { href: '#', class: 'k-calendar-nav-prev k-button k-button-flat k-icon-button', 'aria-label': 'Previous', role: 'button', onclick: (e: Event) => { e.preventDefault(); cb.prev(); } }, '<'),
          h('span', { class: 'k-calendar-nav-today' }, 'Today'),
          h('a', { href: '#', class: 'k-calendar-nav-next k-button k-button-flat k-icon-button', 'aria-label': 'Next', role: 'button', onclick: (e: Event) => { e.preventDefault(); cb.next(); } }, '>'))),
      h('div', { class: 'k-calendar-view k-calendar-monthview' }, h('table', { class: 'k-calendar-table k-content k-month', role: 'grid' },
        h('tbody', { class: 'k-calendar-tbody' }, weekRows(days).map((w) => h('tr', { class: 'k-calendar-tr' }, w.map((d) => h('td', {
          class: `k-calendar-td${d.outside ? ' k-other-month' : ''}${d.selected ? ' k-selected' : ''}${d.today ? ' k-today' : ''}`, role: 'gridcell',
        }, h('a', { class: 'k-link', 'data-value': `${d.date.y}/${d.date.m}/${d.date.d}`, title: new Intl.DateTimeFormat(locale, { dateStyle: 'full' }).format(new Date(d.date.y, d.date.m, d.date.d)), onclick: () => cb.pick(d.date) }, String(d.date.d)))))))))))),
};

export function kendoDatePicker(host: HTMLElement, label: string, locale: string): DateController {
  const id = uid('kdate');
  const fmt = locale.startsWith('de') ? 'dd.MM.yyyy' : 'M/d/yyyy';
  const input = h('input', { id, class: 'k-input-inner', role: 'combobox', 'aria-haspopup': 'grid', 'aria-expanded': 'false', autocomplete: 'off', placeholder: fmt.replace('yyyy', 'yyyy') }) as HTMLInputElement;
  const btn = h('button', { type: 'button', class: 'k-input-button k-button k-icon-button', 'aria-label': 'select', tabindex: -1 }, h('span', { class: 'k-icon k-svg-icon k-svg-i-calendar' }));
  const root = h('span', { class: 'k-datepicker k-input k-input-md k-rounded-md k-input-solid' }, input, btn);
  host.appendChild(h('label', { for: id, class: 'k-label' }, label));
  host.appendChild(root);
  const c = new DateController(root, input, fmt, locale, kendoSkin, label);
  btn.addEventListener('click', () => c.toggle());
  return c;
}

// ------------------------------------------------------------------ DevExtreme

const dxSkin: CalendarSkin = {
  render: (shown, days, cb, locale) => h('div', { class: 'dx-overlay-wrapper dx-dropdowneditor-overlay dx-popup-wrapper dx-datebox-wrapper dx-datebox-wrapper-calendar' },
    h('div', { class: 'dx-overlay-content dx-popup-normal', role: 'dialog' }, h('div', { class: 'dx-popup-content' }, h('div', { class: 'dx-calendar dx-widget', role: 'application' },
      h('div', { class: 'dx-calendar-navigator' },
        h('div', { class: 'dx-widget dx-button dx-calendar-navigator-previous-view dx-calendar-navigator-previous-month', role: 'button', 'aria-label': 'chevronleft', onclick: cb.prev }, '<'),
        h('div', { class: 'dx-widget dx-button dx-calendar-caption-button', role: 'button' }, h('div', { class: 'dx-button-content' }, h('span', { class: 'dx-button-text' }, `${monthName(shown.m, locale)} ${shown.y}`))),
        h('div', { class: 'dx-widget dx-button dx-calendar-navigator-next-view dx-calendar-navigator-next-month', role: 'button', 'aria-label': 'chevronright', onclick: cb.next }, '>')),
      h('div', { class: 'dx-calendar-body' }, h('div', { class: 'dx-calendar-views-wrapper' }, h('div', { class: 'dx-widget dx-calendar-view dx-calendar-view-month' },
        h('table', { role: 'grid' }, h('tbody', {}, weekRows(days).map((w) => h('tr', { role: 'row' }, w.map((d) => h('td', {
          class: `dx-calendar-cell${d.outside ? ' dx-calendar-other-view dx-calendar-other-month' : ''}${d.selected ? ' dx-calendar-selected-date' : ''}${d.today ? ' dx-calendar-today' : ''}`,
          role: 'gridcell', 'data-value': `${d.date.y}/${String(d.date.m + 1).padStart(2, '0')}/${String(d.date.d).padStart(2, '0')}`, onclick: () => cb.pick(d.date),
        }, h('span', {}, String(d.date.d))))))))))))))),
};

export function dxDateBox(host: HTMLElement, label: string, locale: string): DateController {
  const fmt = locale.startsWith('de') ? 'd.M.yyyy' : 'M/d/yyyy';
  const input = h('input', { class: 'dx-texteditor-input', type: 'text', role: 'combobox', 'aria-haspopup': 'true', 'aria-label': label, autocomplete: 'off' }) as HTMLInputElement;
  const hidden = h('input', { type: 'hidden', value: '' }) as HTMLInputElement;
  const btn = h('div', { class: 'dx-widget dx-button-mode-text dx-button dx-dropdowneditor-button', role: 'button', 'aria-label': 'Select' }, h('div', { class: 'dx-button-content' }, h('div', { class: 'dx-dropdowneditor-icon' })));
  const root = h('div', { class: 'dx-datebox dx-textbox dx-texteditor dx-dropdowneditor-button-visible dx-widget dx-dropdowneditor dx-datebox-date dx-datebox-calendar' },
    h('div', { class: 'dx-dropdowneditor-input-wrapper' }, h('div', { class: 'dx-texteditor-container' }, h('div', { class: 'dx-texteditor-input-container' }, input, hidden), h('div', { class: 'dx-texteditor-buttons-container' }, btn))));
  host.appendChild(h('div', { class: 'dx-field' }, h('div', { class: 'dx-field-label' }, label), h('div', { class: 'dx-field-value' }, root)));
  const c = new DateController(root, input, fmt, locale, dxSkin, label, (d) => (hidden.value = d ? `${d.y}/${String(d.m + 1).padStart(2, '0')}/${String(d.d).padStart(2, '0')}` : ''));
  btn.addEventListener('click', () => c.toggle());
  input.addEventListener('click', () => !c.isOpen && c.open());
  return c;
}

// ------------------------------------------------------------------ PrimeNG

const primengSkin: CalendarSkin = {
  render: (shown, days, cb, locale) => h('div', { class: 'p-datepicker p-component', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'p-datepicker-group-container' }, h('div', { class: 'p-datepicker-group' },
    h('div', { class: 'p-datepicker-header' },
      h('button', { class: 'p-datepicker-prev p-link', type: 'button', 'aria-label': 'Previous Month', onclick: cb.prev }, h('span', { class: 'p-datepicker-prev-icon pi pi-chevron-left' })),
      h('div', { class: 'p-datepicker-title' }, h('button', { type: 'button', class: 'p-datepicker-month p-link' }, monthName(shown.m, locale)), h('button', { type: 'button', class: 'p-datepicker-year p-link' }, String(shown.y))),
      h('button', { class: 'p-datepicker-next p-link', type: 'button', 'aria-label': 'Next Month', onclick: cb.next }, h('span', { class: 'p-datepicker-next-icon pi pi-chevron-right' }))),
    h('div', { class: 'p-datepicker-calendar-container' }, h('table', { class: 'p-datepicker-calendar', role: 'grid' }, h('tbody', {}, weekRows(days).map((w) => h('tr', {}, w.map((d) => h('td', {
      class: `${d.outside ? 'p-datepicker-other-month' : ''}${d.today ? ' p-datepicker-today' : ''}`, 'aria-label': String(d.date.d),
    }, h('span', { class: `${d.selected ? 'p-highlight' : ''}${d.outside ? ' p-disabled' : ''}`, 'data-date': `${d.date.y}-${d.date.m}-${d.date.d}`, draggable: 'false', onclick: () => !d.outside && cb.pick(d.date) }, String(d.date.d)))))))))))),
};

export function primengCalendar(host: HTMLElement, label: string, locale: string): DateController {
  const id = uid('pcal');
  const fmt = locale.startsWith('de') ? 'dd.MM.yyyy' : 'MM/dd/yyyy';
  const input = h('input', { id, type: 'text', class: 'p-inputtext p-component', role: 'combobox', 'aria-autocomplete': 'none', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', autocomplete: 'off', placeholder: locale.startsWith('de') ? 'dd.mm.yyyy' : 'mm/dd/yyyy' }) as HTMLInputElement;
  const btn = h('button', { type: 'button', class: 'p-datepicker-trigger p-button-icon-only p-button p-component', 'aria-label': 'Choose Date' }, h('span', { class: 'p-button-icon pi pi-calendar' }));
  const root = h('span', { class: 'p-calendar p-calendar-w-btn' }, input, btn);
  host.appendChild(h('label', { for: id }, label));
  host.appendChild(h('p-calendar', {}, root));
  const c = new DateController(root, input, fmt, locale, primengSkin, label);
  btn.addEventListener('click', () => c.toggle());
  return c;
}

// ------------------------------------------------------------------ Angular Material

const matSkin: CalendarSkin = {
  render: (shown, days, cb, locale) => {
    const container = document.querySelector('.cdk-overlay-container') ?? document.body.appendChild(h('div', { class: 'cdk-overlay-container' }));
    void container;
    const label = (d: YMD) => new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(d.y, d.m, d.d));
    return h('div', { class: 'cdk-overlay-pane mat-datepicker-popup' }, h('mat-datepicker-content', { class: 'mat-datepicker-content mat-datepicker-content-touch-false' },
      h('mat-calendar', { class: 'mat-calendar mat-datepicker-content-container' },
        h('mat-calendar-header', {}, h('div', { class: 'mat-calendar-header' }, h('div', { class: 'mat-calendar-controls' },
          h('button', { type: 'button', class: 'mat-calendar-period-button mdc-button mat-mdc-button', 'aria-label': 'Choose month and year' }, h('span', { class: 'mdc-button__label' }, `${monthName(shown.m, locale, 'short').toUpperCase()} ${shown.y}`)),
          h('div', { class: 'mat-calendar-spacer' }),
          h('button', { type: 'button', class: 'mat-calendar-previous-button mdc-icon-button mat-mdc-icon-button', 'aria-label': 'Previous month', onclick: cb.prev }),
          h('button', { type: 'button', class: 'mat-calendar-next-button mdc-icon-button mat-mdc-icon-button', 'aria-label': 'Next month', onclick: cb.next })))),
        h('div', { class: 'mat-calendar-content' }, h('mat-month-view', {}, h('table', { class: 'mat-calendar-table', role: 'grid' }, h('tbody', { class: 'mat-calendar-body', role: 'grid' },
          weekRows(days).map((w) => h('tr', { role: 'row' }, w.map((d) => d.outside ? h('td', { class: 'mat-calendar-body-cell-container', role: 'gridcell' }) : h('td', { class: 'mat-calendar-body-cell-container', role: 'gridcell' },
            h('button', { type: 'button', class: `mat-calendar-body-cell${d.selected ? ' mat-calendar-body-active' : ''}`, 'aria-label': label(d.date), 'aria-pressed': d.selected ? 'true' : 'false', onclick: () => cb.pick(d.date) },
              h('span', { class: `mat-calendar-body-cell-content mat-focus-indicator${d.selected ? ' mat-calendar-body-selected' : ''}${d.today ? ' mat-calendar-body-today' : ''}` }, String(d.date.d))))))))))))));
  },
};

export function matDatepicker(host: HTMLElement, label: string, locale: string): DateController {
  const id = uid('mat-input');
  const fmt = locale.startsWith('de') ? 'd.M.yyyy' : 'M/d/yyyy';
  const input = h('input', { id, class: 'mat-mdc-input-element mat-datepicker-input mat-mdc-form-field-input-control', 'aria-haspopup': 'dialog', autocomplete: 'off' }) as HTMLInputElement;
  const toggle = h('button', { type: 'button', class: 'mdc-icon-button mat-mdc-icon-button', 'aria-label': 'Open calendar' }, h('svg', {}));
  const field = h('mat-form-field', { class: 'mat-mdc-form-field mat-form-field-appearance-fill' }, h('div', { class: 'mat-mdc-text-field-wrapper' },
    h('label', { class: 'mdc-floating-label', for: id }, h('mat-label', {}, label)), input,
    h('div', { class: 'mat-mdc-form-field-icon-suffix' }, h('mat-datepicker-toggle', { class: 'mat-datepicker-toggle' }, toggle))));
  host.appendChild(field);
  const c = new DateController(field, input, fmt, locale, matSkin, label);
  toggle.addEventListener('click', () => c.toggle());
  return c;
}

// ------------------------------------------------------------------ SAP UI5

const ui5Skin: CalendarSkin = {
  render: (shown, days, cb, locale) => h('div', { class: 'sapMPopover sapMDPPopover', style: 'background: #fff; border: 1px solid #ccc' }, h('div', { class: 'sapUiCal sapUiCalSingleMonth', role: 'application' },
    h('div', { class: 'sapUiCalHead' },
      h('button', { class: 'sapUiCalHeadPrev', title: 'Previous', onclick: cb.prev }, '<'),
      h('button', { class: 'sapUiCalHeadB sapUiCalHeadB1' }, monthName(shown.m, locale)),
      h('button', { class: 'sapUiCalHeadB sapUiCalHeadB2' }, String(shown.y)),
      h('button', { class: 'sapUiCalHeadNext', title: 'Next', onclick: cb.next }, '>')),
    h('div', { class: 'sapUiCalMonthView', role: 'grid' }, weekRows(days).map((w) => h('div', { class: 'sapUiCalRow', role: 'row' }, w.map((d) => h('div', {
      class: `sapUiCalItem${d.outside ? ' sapUiCalItemOtherMonth' : ''}${d.selected ? ' sapUiCalItemSel' : ''}${d.today ? ' sapUiCalItemNow' : ''}`, role: 'gridcell',
      'data-sap-day': `${d.date.y}${String(d.date.m + 1).padStart(2, '0')}${String(d.date.d).padStart(2, '0')}`, onclick: () => cb.pick(d.date),
    }, h('span', { class: 'sapUiCalItemText' }, String(d.date.d))))))))),
};

export function ui5DatePicker(host: HTMLElement, label: string, locale: string): DateController {
  const id = uid('__picker');
  const de = locale.startsWith('de');
  const fmt = de ? 'dd.MM.yyyy' : 'MMM d, yyyy';
  const input = h('input', { id: `${id}-inner`, class: 'sapMInputBaseInner', type: 'text', role: 'combobox', 'aria-haspopup': 'grid', autocomplete: 'off', placeholder: de ? 'dd.MM.y' : 'MMM d, y' }) as HTMLInputElement;
  const icon = h('span', { class: 'sapUiIcon sapMInputBaseIcon', role: 'button', 'aria-label': 'Open Picker', title: 'Open Picker' }, '[cal]');
  const root = h('div', { id, class: 'sapMInputBase sapMDP sapMInputBaseHasEndIcons' }, h('div', { class: 'sapMInputBaseContentWrapper' },
    h('div', { class: 'sapMInputBaseDynamicContent' }, input), h('div', { class: 'sapMInputBaseIconContainer' }, icon)));
  host.appendChild(h('label', { class: 'sapMLabel', for: `${id}-inner` }, h('bdi', {}, label)));
  host.appendChild(root);
  const c = new DateController(root, input, fmt, locale, ui5Skin, label);
  icon.addEventListener('click', () => c.toggle());
  return c;
}

// ------------------------------------------------------------------ WAI-ARIA APG date picker dialog

const ariaSkin: CalendarSkin = {
  render: (shown, days, cb, locale) => {
    const labelId = uid('id-grid-label');
    return h('div', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelId, class: 'datepicker-dialog', style: 'background: #fff; border: 1px solid #888; padding: 6px' },
      h('div', { class: 'header' },
        h('button', { type: 'button', class: 'prev-month', 'aria-label': 'previous month', onclick: cb.prev }, '<'),
        h('h2', { id: labelId, class: 'month-year', 'aria-live': 'polite' }, `${monthName(shown.m, locale)} ${shown.y}`),
        h('button', { type: 'button', class: 'next-month', 'aria-label': 'next month', onclick: cb.next }, '>')),
      h('table', { class: 'dates', role: 'grid', 'aria-labelledby': labelId }, h('tbody', {}, weekRows(days).map((w) => h('tr', {}, w.map((d) => h('td', {
        tabindex: '-1', 'data-date': `${d.date.y}-${String(d.date.m + 1).padStart(2, '0')}-${String(d.date.d).padStart(2, '0')}`,
        class: d.outside ? 'disabled' : '', 'aria-selected': d.selected ? 'true' : null, onclick: () => !d.outside && cb.pick(d.date),
      }, String(d.date.d))))))));
  },
};

export function ariaDatePicker(host: HTMLElement, label: string, locale: string): DateController {
  const id = uid('id-textbox');
  const de = locale.startsWith('de');
  const fmt = de ? 'dd.MM.yyyy' : 'MM/dd/yyyy';
  const input = h('input', { type: 'text', id, placeholder: de ? 'TT.MM.JJJJ' : 'mm/dd/yyyy', 'aria-describedby': `${id}-desc` }) as HTMLInputElement;
  const btn = h('button', { type: 'button', class: 'icon', 'aria-haspopup': 'dialog', 'aria-label': 'Choose Date' }, '[cal]');
  const group = h('div', { class: 'date', 'data-datepicker': '' }, input, btn);
  host.appendChild(h('label', { for: id }, label));
  host.appendChild(group);
  const c = new DateController(group, input, fmt, locale, ariaSkin, label);
  btn.addEventListener('click', () => c.toggle());
  return c;
}

export { clear };
