/**
 * Library dialects: what each widget library's DOM looks like, as data the
 * in-page engine interprets. Selectors follow each library's documented
 * markup (class names and ARIA it renders). Order matters within a kind:
 * library dialects come first, the generic ARIA/native dialect last, so the
 * most specific adapter claims a widget.
 */
import type {
  AccordionDialect, AdapterFixture, ComboDialect, DateDialect, DialogDialect, DropzoneDialect, EditorDialect, GridDialect, SliderDialect, TabsDialect, TreeDialect, WidgetKind,
} from './types.js';

export interface DialectEntry<D> {
  kind: WidgetKind;
  label: string;
  library: string;
  fixture: AdapterFixture;
  dialect: D;
}

const e = <D>(kind: WidgetKind, library: string, label: string, fixture: AdapterFixture, dialect: D): DialectEntry<D> => ({ kind, library, label, fixture, dialect });

// ------------------------------------------------------------------ grids

export const GRID_DIALECTS: Array<DialectEntry<GridDialect>> = [
  e('grid', 'ag-grid', 'ag-Grid', 'real', {
    id: 'ag-grid', root: '.ag-root-wrapper',
    headerCell: '.ag-header-cell[col-id]', headerExclude: '.ag-floating-filter', headerText: '.ag-header-cell-text', colIdAttr: 'col-id',
    row: '.ag-row', rowExclude: '.ag-row-loading, .ag-full-width-row', cell: '.ag-cell', rowKeyAttr: 'row-id', rowIndexAttr: 'row-index',
    viewport: '.ag-body-viewport, .ag-grid-viewport', hViewport: '.ag-center-cols-viewport, .ag-body-horizontal-scroll-viewport',
    busy: '.ag-overlay-loading-wrapper, .ag-overlay-loading-center',
    sortClick: '.ag-header-cell-label', sortAsc: '.ag-sort-ascending-icon:not(.ag-hidden)', sortDesc: '.ag-sort-descending-icon:not(.ag-hidden)',
    selectedRow: '.ag-row-selected', rowCheckbox: '.ag-selection-checkbox input, .ag-selection-checkbox .ag-checkbox-input',
    rowExpander: '.ag-group-contracted:not(.ag-hidden), .ag-group-expanded:not(.ag-hidden)',
    editTrigger: 'dblclick', editorPopup: '.ag-popup-editor input, .ag-popup-editor select, .ag-popup-editor textarea',
    pagerNext: '.ag-paging-panel [aria-label="Next Page"]', pagerPrev: '.ag-paging-panel [aria-label="Previous Page"]', pagerFirst: '.ag-paging-panel [aria-label="First Page"]',
  }),
  e('grid', 'mui', 'MUI X Data Grid', 'real', {
    id: 'mui-data-grid', root: '.MuiDataGrid-root',
    headerCell: '.MuiDataGrid-columnHeader[data-field]', headerText: '.MuiDataGrid-columnHeaderTitle', colIdAttr: 'data-field',
    row: '.MuiDataGrid-row', cell: '.MuiDataGrid-cell', rowKeyAttr: 'data-id', rowIndexAttr: 'data-rowindex',
    viewport: '.MuiDataGrid-virtualScroller', busy: '.MuiDataGrid-overlay .MuiCircularProgress-root, .MuiDataGrid-overlay .MuiLinearProgress-root, .MuiDataGrid-row .MuiSkeleton-root',
    selectedRow: '.Mui-selected', rowCheckbox: '.MuiDataGrid-cellCheckbox input',
    rowExpander: '.MuiDataGrid-detailPanelToggleCell button, .MuiDataGrid-treeDataGroupingCell button',
    editTrigger: 'dblclick', editor: '.MuiDataGrid-cell--editing input, .MuiDataGrid-cell--editing textarea, .MuiDataGrid-cell--editing [role=combobox]',
    pagerNext: '.MuiTablePagination-actions [data-mui-pagination-action=next], .MuiTablePagination-actions [aria-label="Go to next page"]',
    pagerPrev: '.MuiTablePagination-actions [data-mui-pagination-action=previous], .MuiTablePagination-actions [aria-label="Go to previous page"]',
    pagerFirst: '.MuiTablePagination-actions [data-mui-pagination-action=first], .MuiTablePagination-actions [aria-label="Go to first page"]',
    quickFilter: '.MuiDataGrid-toolbarQuickFilter input, .MuiDataGrid-toolbar input[type=search], .MuiDataGrid-toolbar input',
    quickFilterOpen: '.MuiDataGrid-toolbar button[aria-label="Search"]', extraFrame: true,
  }),
  e('grid', 'kendo', 'Kendo UI Grid (jQuery / Angular)', 'emulated', {
    id: 'kendo-grid', root: '.k-grid',
    headerCell: '.k-grid-header th.k-header, .k-grid-header th.k-table-th:not(.k-filter-row th)', headerText: '.k-column-title, .k-link',
    row: '.k-grid-content tr.k-master-row, .k-grid-content tr.k-table-row:not(.k-detail-row):not(.k-grouping-row):not(.k-grid-norecords)', rowClosest: 'tr', cell: 'td',
    rowKeyAttr: 'data-uid', viewport: '.k-grid-content, .k-virtual-content', busy: '.k-loading-mask',
    sortClick: '.k-link', sortAsc: '.k-i-sort-asc-small, .k-svg-i-sort-asc-small', sortDesc: '.k-i-sort-desc-small, .k-svg-i-sort-desc-small',
    selectedRow: '.k-selected, .k-state-selected', rowCheckbox: 'input.k-checkbox, input.k-select-checkbox', rowExpander: '.k-hierarchy-cell a, .k-hierarchy-cell [role=button]',
    rowExpandedState: '[aria-expanded=true], .k-i-minus, .k-svg-i-minus',
    editTrigger: 'click', editor: 'input.k-input-inner, input.k-textbox, input', editCommit: 'Enter',
    pagerNext: '.k-pager [title="Go to the next page"], .k-pager [aria-label="Go to the next page"]', pagerPrev: '.k-pager [title="Go to the previous page"]', pagerFirst: '.k-pager [title="Go to the first page"]',
  }),
  e('grid', 'devextreme', 'DevExtreme dxDataGrid', 'emulated', {
    id: 'dx-data-grid', root: '.dx-datagrid',
    headerCell: '.dx-datagrid-headers .dx-header-row > td[role=columnheader]', headerText: '.dx-datagrid-text-content', colIdAttr: 'aria-colindex',
    row: '.dx-datagrid-rowsview tr.dx-data-row', rowClosest: 'tr', cell: 'td[role=gridcell]', rowIndexAttr: 'aria-rowindex',
    viewport: '.dx-datagrid-rowsview .dx-scrollable-container', busy: '.dx-loadpanel-content:not(.dx-state-invisible)',
    sortAsc: '.dx-sort-up', sortDesc: '.dx-sort-down',
    selectedRow: '.dx-selection', rowCheckbox: '.dx-select-checkbox', checkboxChecked: '.dx-checkbox-checked',
    rowExpander: '.dx-command-expand', rowExpandedState: '.dx-datagrid-expand',
    editTrigger: 'click', editor: '.dx-texteditor-input', editCommit: 'Enter',
    pagerNext: '.dx-pager .dx-next-button', pagerPrev: '.dx-pager .dx-prev-button',
  }),
  e('grid', 'primeng', 'PrimeNG p-table', 'emulated', {
    id: 'primeng-table', root: '.p-datatable',
    headerCell: '.p-datatable-thead > tr:first-child > th',
    row: '.p-datatable-tbody > tr', rowExclude: '.p-datatable-emptymessage, .p-datatable-row-expansion, .p-rowgroup-header', rowClosest: 'tr', cell: 'td',
    viewport: '.p-scroller, .p-virtualscroller', busy: '.p-datatable-loading-overlay',
    selectedRow: '.p-highlight, .p-datatable-row-selected', rowCheckbox: '.p-checkbox-box, [role=checkbox]', checkboxChecked: '.p-highlight',
    rowExpander: '.p-row-toggler, [ptablerowtoggler]',
    editTrigger: 'click', editor: '.p-cell-editing input, td input.p-inputtext', editCommit: 'Enter',
    pagerNext: '.p-paginator-next', pagerPrev: '.p-paginator-prev', pagerFirst: '.p-paginator-first',
  }),
  e('grid', 'primefaces', 'PrimeFaces DataTable', 'emulated', {
    id: 'primefaces-datatable', root: '.ui-datatable',
    headerCell: 'thead th[role=columnheader], thead > tr:first-child > th', headerText: '.ui-column-title',
    row: 'tbody.ui-datatable-data > tr', rowExclude: '.ui-datatable-empty-message, .ui-expanded-row-content', rowClosest: 'tr', cell: 'td',
    rowKeyAttr: 'data-rk', rowIndexAttr: 'data-ri',
    sortAsc: '.ui-icon-triangle-1-n', sortDesc: '.ui-icon-triangle-1-s',
    selectedRow: '.ui-state-highlight', rowCheckbox: '.ui-chkbox-box', checkboxChecked: '.ui-state-active',
    editTrigger: 'click', editor: '.ui-cell-editor-input input, td input',
    pagerNext: '.ui-paginator-next', pagerPrev: '.ui-paginator-prev', pagerFirst: '.ui-paginator-first',
  }),
  e('grid', 'angular-material', 'Angular Material mat-table', 'emulated', {
    id: 'mat-table', root: '.mat-mdc-table, mat-table, table.mat-table',
    headerCell: '.mat-mdc-header-cell, mat-header-cell, th.mat-header-cell', headerText: '.mat-sort-header-content', colIdClass: 'mat-column-',
    row: '.mat-mdc-row, mat-row, tr.mat-row', cell: '.mat-mdc-cell, mat-cell, td.mat-cell',
    sortClick: '.mat-sort-header-container',
    selectedRow: '.ez-selected, .selected', rowCheckbox: 'mat-checkbox input, .mat-mdc-checkbox input',
    editTrigger: 'click',
    pagerNext: '.mat-mdc-paginator-navigation-next, .mat-paginator-navigation-next', pagerPrev: '.mat-mdc-paginator-navigation-previous', pagerFirst: '.mat-mdc-paginator-navigation-first',
  }),
  e('grid', 'oracle-jet', 'Oracle JET oj-table', 'emulated', {
    id: 'oj-table', root: 'oj-table, .oj-table',
    headerCell: 'th.oj-table-column-header-cell', headerText: '.oj-table-column-header-text',
    row: 'tr.oj-table-body-row', rowClosest: 'tr', cell: 'td.oj-table-data-cell',
    viewport: '.oj-table-scroller', loadMoreWaitMs: 1500, busy: '.oj-table-status-message',
    selectedRow: '.oj-selected', editTrigger: 'dblclick',
  }),
  e('grid', 'sap-ui5', 'SAP UI5 sap.m.Table', 'emulated', {
    id: 'sap-m-table', root: '.sapMTable',
    headerCell: 'th.sapMListTblCell[data-sap-ui-column], th.sapMListTblHeaderCell[data-sap-ui-column]', headerText: '.sapMColumnHeader, .sapMText', colIdAttr: 'data-sap-ui-column',
    row: 'tr.sapMListTblRow', rowExclude: '.sapMListTblHeader, .sapMListTblSubRow, .sapMGrowingListTrigger', rowClosest: 'tr', cell: 'td.sapMListTblCell',
    rowKeyAttr: 'id', sortable: false,
    selectedRow: '.sapMLIBSelected', rowCheckbox: '.sapMListTblSelCol .sapMCb, .sapMCb[role=checkbox], .sapMCb input', editTrigger: 'none',
    loadMore: '.sapMGrowingListTrigger', quickFilter: '.sapMSF input',
  }),
  e('grid', 'salesforce', 'Salesforce lightning-datatable', 'reused', {
    id: 'lightning-datatable', root: 'lightning-datatable', shadowInner: 'table',
    headerCell: 'thead th', headerText: '.slds-truncate',
    row: 'tbody tr', rowClosest: 'tr', cell: 'th[scope=row], td', rowKeyAttr: 'data-row-key-value', sortable: false, editTrigger: 'none',
  }),
  e('grid', 'd365', 'Dynamics 365 UCI grid', 'reused', {
    id: 'd365-grid', root: '[data-id="data-set-body-container"] [role=grid]',
    headerCell: '[role=columnheader][col-id]', colIdAttr: 'col-id',
    row: '[role=row][row-index]', cell: '[role=gridcell]', rowKeyAttr: 'data-id', rowIndexAttr: 'row-index', sortable: false, editTrigger: 'none',
  }),
  e('grid', 'aria', 'WAI-ARIA grid / native table', 'aria', {
    id: 'aria-grid', root: '[role=grid], [role=treegrid], [role=table], table', generic: true,
    headerCell: '[role=columnheader]', colIdAttr: 'aria-colindex',
    row: '[role=row], tr', rowClosest: '[role=row], tr', cell: '[role=gridcell], [role=cell], [role=rowheader], td, th[scope=row]', rowIndexAttr: 'aria-rowindex',
    busy: '[aria-busy=true]', sortClick: 'button', selectedRow: '[aria-selected=true]',
    editTrigger: 'dblclick', pagerNext: '[aria-label="Next page" i], [aria-label="Go to next page" i]', pagerPrev: '[aria-label="Previous page" i]', pagerFirst: '[aria-label="First page" i]',
  }),
];

// ------------------------------------------------------------------ combo boxes and selects

export const COMBO_DIALECTS: Array<DialectEntry<ComboDialect>> = [
  e('combobox', 'mui', 'MUI Autocomplete', 'real', {
    id: 'mui-autocomplete', root: '.MuiAutocomplete-root', input: 'input.MuiAutocomplete-input, input',
    trigger: '.MuiAutocomplete-popupIndicator', popup: '.MuiAutocomplete-popper', option: '[role=option]', loading: '.MuiAutocomplete-loading',
    chips: '.MuiChip-label', multiple: '.MuiAutocomplete-root:has(.MuiAutocomplete-tag), .MuiAutocomplete-root:has(.MuiChip-root)', closeAfter: true,
  }),
  e('combobox', 'mui', 'MUI Select', 'real', {
    id: 'mui-select', root: '.MuiInputBase-root:has(> .MuiSelect-select)', input: 'ezc-none', openClick: '.MuiSelect-select',
    popup: '.MuiMenu-paper, .MuiPopover-paper', option: '[role=option]', valueText: '.MuiSelect-select', closeAfter: true,
  }),
  e('combobox', 'angular-material', 'Angular Material mat-select', 'emulated', {
    id: 'mat-select', root: 'mat-select, .mat-mdc-select', input: 'input', openClick: '.mat-mdc-select-trigger, .mat-select-trigger',
    popup: '.cdk-overlay-pane .mat-mdc-select-panel, .cdk-overlay-pane .mat-select-panel', option: 'mat-option, .mat-mdc-option', optionText: '.mdc-list-item__primary-text',
    valueText: '.mat-mdc-select-value-text, .mat-select-value-text', placeholder: '.mat-mdc-select-placeholder', multiple: '.mat-mdc-select-multiple',
    chips: '.mat-mdc-select-value-text', closeAfter: true,
  }),
  e('combobox', 'angular-material', 'Angular Material mat-autocomplete', 'emulated', {
    id: 'mat-autocomplete', root: 'input.mat-mdc-autocomplete-trigger, input[matautocomplete]', input: 'input',
    popup: '.cdk-overlay-pane .mat-mdc-autocomplete-panel', option: 'mat-option, .mat-mdc-option', optionText: '.mdc-list-item__primary-text', closeAfter: true,
  }),
  e('combobox', 'kendo', 'Kendo ComboBox', 'emulated', {
    id: 'kendo-combobox', root: '.k-combobox', input: 'input.k-input-inner', trigger: '.k-input-button',
    popup: '.k-animation-container .k-list-container, .k-popup.k-list-container', option: '.k-list-item, li[role=option]', optionText: '.k-list-item-text',
    loading: '.k-i-loading, .k-svg-i-loading, .k-loading-icon', optionSelected: '.k-selected', closeAfter: true,
  }),
  e('combobox', 'kendo', 'Kendo DropDownList', 'emulated', {
    id: 'kendo-dropdownlist', root: '.k-dropdownlist, .k-dropdown', input: 'input.k-input-inner',
    popup: '.k-animation-container .k-list-container, .k-popup.k-list-container', popupSearch: '.k-list-filter input',
    option: '.k-list-item, li[role=option]', optionText: '.k-list-item-text', optionSelected: '.k-selected', valueText: '.k-input-value-text', closeAfter: true,
  }),
  e('combobox', 'kendo', 'Kendo MultiSelect', 'emulated', {
    id: 'kendo-multiselect', root: '.k-multiselect', input: 'input.k-input-inner',
    popup: '.k-animation-container .k-list-container, .k-popup.k-list-container', option: '.k-list-item, li[role=option]', optionText: '.k-list-item-text',
    chips: '.k-chip-label, .k-chip-content', multiple: '.k-multiselect', optionSelected: '.k-selected',
  }),
  e('combobox', 'devextreme', 'DevExtreme dxSelectBox / dxTagBox', 'emulated', {
    id: 'dx-selectbox', root: '.dx-selectbox, .dx-tagbox', input: 'input.dx-texteditor-input', trigger: '.dx-dropdowneditor-button', openClick: 'input.dx-texteditor-input',
    popup: '.dx-dropdowneditor-overlay .dx-overlay-content, .dx-selectbox-popup-wrapper .dx-overlay-content',
    option: '.dx-list-item', optionText: '.dx-list-item-content', optionSelected: '.dx-list-item-selected', loading: '.dx-loadindicator',
    chips: '.dx-tag-content > span', multiple: '.dx-tagbox', closeAfter: true,
  }),
  e('combobox', 'primeng', 'PrimeNG p-dropdown / p-select', 'emulated', {
    id: 'primeng-dropdown', root: '.p-dropdown, .p-select', input: 'input.p-dropdown-label, input.p-select-label',
    popup: '.p-dropdown-panel, .p-select-overlay', popupSearch: '.p-dropdown-filter, .p-select-filter',
    option: '.p-dropdown-item, .p-select-option, li[role=option]', optionSelected: '.p-highlight', valueText: '.p-dropdown-label, .p-select-label', placeholder: '.p-placeholder', closeAfter: true,
  }),
  e('combobox', 'primeng', 'PrimeNG p-autocomplete', 'emulated', {
    id: 'primeng-autocomplete', root: '.p-autocomplete', input: 'input', popup: '.p-autocomplete-panel, .p-autocomplete-overlay',
    option: '.p-autocomplete-item, .p-autocomplete-option', loading: '.p-autocomplete-loader', chips: '.p-autocomplete-token-label, .p-chip-label', multiple: '.p-autocomplete-multiple', closeAfter: true,
  }),
  e('combobox', 'primefaces', 'PrimeFaces selectOneMenu', 'emulated', {
    id: 'pf-selectonemenu', root: '.ui-selectonemenu', input: 'input.ui-selectonemenu-label', openClick: '.ui-selectonemenu-trigger',
    popup: '.ui-selectonemenu-panel', option: '.ui-selectonemenu-item', valueText: 'label.ui-selectonemenu-label, .ui-selectonemenu-label', closeAfter: true,
  }),
  e('combobox', 'oracle-jet', 'Oracle JET oj-select-single', 'emulated', {
    id: 'oj-select-single', root: 'oj-select-single, .oj-select-single', input: 'input.oj-text-field-input, input', trigger: '.oj-searchselect-arrow, .oj-searchselect-open-icon',
    popup: '.oj-listbox-drop', option: '.oj-listbox-result, [role=option]', optionText: '.oj-listbox-result-label', loading: '.oj-listbox-searching', closeAfter: true,
  }),
  e('combobox', 'sap-ui5', 'SAP UI5 sap.m.Select', 'emulated', {
    id: 'sap-m-select', root: '.sapMSlt', input: 'input.sapMSltInput:not([type=hidden])',
    popup: '.sapMSltPicker, .sapMSelectList', option: '.sapMSelectListItem', valueText: '.sapMSltLabel', closeAfter: true,
  }),
  e('combobox', 'salesforce', 'Salesforce lightning-combobox', 'reused', {
    id: 'lightning-combobox', root: 'lightning-combobox, lightning-base-combobox', input: 'input, button[role=combobox]',
    popup: '[role=listbox]', option: 'lightning-base-combobox-item[role=option]', closeAfter: true,
  }),
  e('combobox', 'aria', 'WAI-ARIA combobox / native select', 'aria', {
    id: 'aria-combobox', root: 'select, [role=combobox]', input: 'input',
    option: '[role=option]', valueText: '[data-value-text]', loading: '[aria-busy=true], .loading', closeAfter: true,
  }),
];

// ------------------------------------------------------------------ date pickers

export const DATE_DIALECTS: Array<DialectEntry<DateDialect>> = [
  e('datepicker', 'mui', 'MUI X DatePicker', 'real', {
    id: 'mui-date-picker', root: '.MuiPickersTextField-root, .MuiFormControl-root:has(.MuiPickersSectionList-root)',
    sections: '.MuiPickersSectionList-sectionContent', sectionsRoot: '.MuiPickersSectionList-root', hiddenValue: 'input.MuiPickersInputBase-input',
    toggle: 'button[data-mui-picker-open-button], .MuiInputAdornment-root button',
    popup: '.MuiPickerPopper-root, .MuiDialog-root .MuiPickersLayout-root', title: '.MuiPickersCalendarHeader-label',
    prev: '.MuiPickersArrowSwitcher-root > button:first-of-type', next: '.MuiPickersArrowSwitcher-root > button:last-of-type',
    day: 'button[data-timestamp]', dayOutside: '[class*="dayOutsideMonth"]', dayDate: { attr: 'data-timestamp', format: 'ms' },
  }),
  e('datepicker', 'angular-material', 'Angular Material mat-datepicker', 'emulated', {
    id: 'mat-datepicker', root: '.mat-mdc-form-field:has(.mat-datepicker-input), mat-form-field:has(.mat-datepicker-input)', input: 'input.mat-datepicker-input',
    toggle: '.mat-datepicker-toggle button', popup: '.mat-datepicker-content', title: '.mat-calendar-period-button',
    prev: '.mat-calendar-previous-button', next: '.mat-calendar-next-button', day: 'button.mat-calendar-body-cell', dayLabel: true, dayText: '.mat-calendar-body-cell-content',
  }),
  e('datepicker', 'kendo', 'Kendo DatePicker', 'emulated', {
    id: 'kendo-datepicker', root: '.k-datepicker', input: 'input.k-input-inner', toggle: '.k-input-button',
    popup: '.k-calendar-container, .k-animation-container .k-calendar', title: '.k-calendar-title, .k-nav-fast',
    prev: '.k-calendar-nav-prev, .k-nav-prev', next: '.k-calendar-nav-next, .k-nav-next',
    day: 'td.k-calendar-td, td[role=gridcell]', dayOutside: '.k-other-month', dayDate: { attr: 'data-value', format: 'parts', monthBase: 0 }, dayClick: '.k-link',
  }),
  e('datepicker', 'devextreme', 'DevExtreme dxDateBox', 'emulated', {
    id: 'dx-datebox', root: '.dx-datebox', input: 'input.dx-texteditor-input', toggle: '.dx-dropdowneditor-button', hiddenValue: 'input[type=hidden]',
    popup: '.dx-datebox-wrapper .dx-overlay-content', title: '.dx-calendar-caption-button',
    prev: '.dx-calendar-navigator-previous-view', next: '.dx-calendar-navigator-next-view',
    day: 'td.dx-calendar-cell', dayOutside: '.dx-calendar-other-view, .dx-calendar-other-month', dayDate: { attr: 'data-value', format: 'parts' },
  }),
  e('datepicker', 'primeng', 'PrimeNG p-calendar / p-datepicker', 'emulated', {
    id: 'primeng-calendar', root: '.p-calendar, .p-datepicker:has(> input)', input: 'input', toggle: '.p-datepicker-trigger',
    popup: '.p-datepicker:not(.p-datepicker-inline):has(.p-datepicker-calendar), .p-datepicker-panel', title: '.p-datepicker-title',
    prev: '.p-datepicker-prev, .p-datepicker-prev-button', next: '.p-datepicker-next, .p-datepicker-next-button',
    day: '.p-datepicker-calendar td', dayOutside: '.p-datepicker-other-month', dayDate: { attr: 'data-date', format: 'parts', monthBase: 0 }, dayClick: 'span',
  }),
  e('datepicker', 'sap-ui5', 'SAP UI5 sap.m.DatePicker', 'emulated', {
    id: 'sap-m-datepicker', root: '.sapMDP', input: 'input.sapMInputBaseInner', toggle: '.sapMInputBaseIcon',
    popup: '.sapUiCal', title: '.sapUiCalHeadB1, .sapUiCalHeadB2', prev: '.sapUiCalHeadPrev', next: '.sapUiCalHeadNext',
    day: '.sapUiCalItem', dayOutside: '.sapUiCalItemOtherMonth', dayDate: { attr: 'data-sap-day', format: 'compact' },
  }),
  e('datepicker', 'aria', 'WAI-ARIA date picker dialog', 'aria', {
    id: 'aria-datepicker', root: '[data-datepicker], .datepicker, .date-picker, :is(div, span, p):has(> input:not([type=hidden])):has(> button[aria-haspopup=dialog])',
    input: 'input:not([type=hidden])', toggle: 'button[aria-haspopup=dialog], button[aria-label*="date" i]',
    popup: '[role=dialog]:has([role=grid])', title: 'h2, [aria-live]', prev: '[aria-label*="previous month" i]', next: '[aria-label*="next month" i]',
    day: '[role=grid] td[data-date], [role=grid] [role=gridcell][data-date]', dayOutside: '.disabled, [aria-disabled=true]', dayDate: { attr: 'data-date', format: 'parts' },
  }),
  e('datepicker', 'native', 'Native <input type="date">', 'aria', {
    id: 'native-date', root: 'input[type=date], input[type=datetime-local]', input: 'input', popup: ':not(*)', day: ':not(*)', native: true, typeFirst: true,
  }),
];

// ------------------------------------------------------------------ trees

export const TREE_DIALECTS: Array<DialectEntry<TreeDialect>> = [
  e('tree', 'angular-material', 'Angular Material mat-tree', 'emulated', {
    id: 'mat-tree', root: 'mat-tree, .mat-tree', item: 'mat-tree-node, mat-nested-tree-node, .mat-tree-node', toggle: '[mattreenodetoggle], .mat-tree-node-toggle',
  }),
  e('tree', 'kendo', 'Kendo TreeView', 'emulated', {
    id: 'kendo-treeview', root: '.k-treeview', item: '.k-treeview-item', label: '.k-treeview-leaf-text, .k-in', toggle: '.k-treeview-toggle', group: '.k-treeview-group', selectedState: '.k-selected',
  }),
  e('tree', 'devextreme', 'DevExtreme dxTreeView', 'emulated', {
    id: 'dx-treeview', root: '.dx-treeview', item: '.dx-treeview-node', label: '.dx-treeview-item-content > span', toggle: '.dx-treeview-toggle-item-visibility', group: '.dx-treeview-node-container',
    selectedState: '.dx-state-selected',
  }),
  e('tree', 'primeng', 'PrimeNG p-tree', 'emulated', {
    id: 'primeng-tree', root: '.p-tree', item: '.p-treenode, .p-tree-node', label: '.p-treenode-label, .p-tree-node-label', toggle: '.p-tree-toggler, .p-tree-node-toggle-button',
    group: '.p-treenode-children, .p-tree-node-children', selectedState: '.p-highlight',
  }),
  e('tree', 'sap-ui5', 'SAP UI5 sap.m.Tree', 'emulated', {
    id: 'sap-m-tree', root: '.sapMTree', item: '.sapMTreeItemBase', label: '.sapMSLITitleOnly, .sapMSLITitle', toggle: '.sapMTreeItemBaseExpander', selectedState: '.sapMLIBSelected',
  }),
  e('tree', 'aria', 'WAI-ARIA tree', 'aria', { id: 'aria-tree', root: '[role=tree]', item: '[role=treeitem]', group: '[role=group]' }),
];

// ------------------------------------------------------------------ tabs and accordions

export const TABS_DIALECTS: Array<DialectEntry<TabsDialect>> = [
  e('tabs', 'mui', 'MUI Tabs', 'real', { id: 'mui-tabs', root: '.MuiTabs-root', tab: '.MuiTab-root', tabSelected: '.Mui-selected' }),
  e('tabs', 'angular-material', 'Angular Material mat-tab-group', 'emulated', {
    id: 'mat-tab-group', root: 'mat-tab-group, .mat-mdc-tab-group', tab: '.mdc-tab, .mat-mdc-tab', tabLabel: '.mdc-tab__text-label', tabSelected: '.mdc-tab--active',
  }),
  e('tabs', 'kendo', 'Kendo TabStrip', 'emulated', { id: 'kendo-tabstrip', root: '.k-tabstrip', tab: '.k-tabstrip-item, .k-tabstrip-items .k-item', tabLabel: '.k-link', tabSelected: '.k-active, .k-state-active' }),
  e('tabs', 'devextreme', 'DevExtreme dxTabs / dxTabPanel', 'emulated', { id: 'dx-tabs', root: '.dx-tabpanel, .dx-tabs', tab: '.dx-tab', tabLabel: '.dx-tab-text', tabSelected: '.dx-tab-selected' }),
  e('tabs', 'primeng', 'PrimeNG p-tabView / p-tabs', 'emulated', { id: 'primeng-tabview', root: '.p-tabview, .p-tabs', tab: '.p-tabview-nav-link, .p-tab', tabLabel: '.p-tabview-title', tabSelected: '.p-highlight, .p-tab-active' }),
  e('tabs', 'sap-ui5', 'SAP UI5 sap.m.IconTabBar', 'emulated', { id: 'sap-m-icontabbar', root: '.sapMITB', tab: '.sapMITBFilter', tabLabel: '.sapMITBText', tabSelected: '.sapMITBSelected' }),
  e('tabs', 'aria', 'WAI-ARIA tabs', 'aria', { id: 'aria-tabs', root: '[role=tablist], :has(> [role=tablist])', tab: '[role=tab]' }),
];

export const ACCORDION_DIALECTS: Array<DialectEntry<AccordionDialect>> = [
  e('accordion', 'mui', 'MUI Accordion', 'real', { id: 'mui-accordion', root: ':has(> .MuiAccordion-root)', header: '.MuiAccordionSummary-root' }),
  e('accordion', 'angular-material', 'Angular Material mat-accordion', 'emulated', { id: 'mat-accordion', root: 'mat-accordion, .mat-accordion', header: 'mat-expansion-panel-header, .mat-expansion-panel-header', headerLabel: '.mat-expansion-panel-header-title' }),
  e('accordion', 'aria', 'WAI-ARIA accordion', 'aria', { id: 'aria-accordion', root: ':has(button[aria-expanded], [role=button][aria-expanded])', header: 'button[aria-expanded], [role=button][aria-expanded]' }),
];

// ------------------------------------------------------------------ dialogs and toasts (document level)

export const DIALOG_DIALECTS: Array<DialectEntry<DialogDialect>> = [
  e('dialog', 'mui', 'MUI Dialog', 'real', { id: 'mui-dialog', root: '.MuiDialog-paper', dialog: '.MuiDialog-paper', title: '.MuiDialogTitle-root' }),
  e('dialog', 'angular-material', 'Angular Material mat-dialog', 'emulated', { id: 'mat-dialog', root: 'mat-dialog-container, .mat-mdc-dialog-container', dialog: 'mat-dialog-container', title: '.mat-mdc-dialog-title' }),
  e('dialog', 'kendo', 'Kendo Window / Dialog', 'emulated', { id: 'kendo-window', root: '.k-window', dialog: '.k-window', title: '.k-window-title', close: '.k-window-titlebar-action[aria-label="Close"], .k-window-action[aria-label="Close"]' }),
  e('dialog', 'devextreme', 'DevExtreme dxPopup', 'emulated', { id: 'dx-popup', root: '.dx-popup-wrapper:not(.dx-dropdowneditor-overlay) .dx-overlay-content', dialog: '.dx-popup-wrapper:not(.dx-dropdowneditor-overlay) .dx-overlay-content', title: '.dx-popup-title .dx-toolbar-label', close: '.dx-closebutton' }),
  e('dialog', 'primeng', 'PrimeNG p-dialog', 'emulated', { id: 'primeng-dialog', root: '.p-dialog', dialog: '.p-dialog', title: '.p-dialog-title', close: '.p-dialog-header-close' }),
  e('dialog', 'sap-ui5', 'SAP UI5 sap.m.Dialog', 'emulated', { id: 'sap-m-dialog', root: '.sapMDialog', dialog: '.sapMDialog', title: '.sapMDialogTitle, .sapMTitle' }),
  e('dialog', 'oracle-jet', 'Oracle JET oj-dialog', 'emulated', { id: 'oj-dialog', root: '.oj-dialog', dialog: '.oj-dialog', title: '.oj-dialog-title' }),
  e('dialog', 'aria', 'WAI-ARIA dialog / <dialog>', 'aria', { id: 'aria-dialog', root: '[role=dialog], [role=alertdialog], dialog[open]', dialog: '[role=dialog], [role=alertdialog], dialog[open]' }),
];

/** Every dialog selector, for the document-level stack. */
export const ALL_DIALOGS = DIALOG_DIALECTS.map((d) => d.dialect.dialog).join(', ');
// Headings, and the title element of a Bootstrap / React-Bootstrap / jQuery UI dialog (often a plain div, demoqa.com).
export const ALL_DIALOG_TITLES = [...DIALOG_DIALECTS.map((d) => d.dialect.title).filter(Boolean), 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', '[role=heading]', '.modal-title', '.ui-dialog-title', '[class*="dialog-title"]', '[class*="modal-title"]'].join(', ');
export const ALL_DIALOG_CLOSE = [...DIALOG_DIALECTS.map((d) => d.dialect.close).filter(Boolean), '[aria-label="Close" i]', '[title="Close" i]'].join(', ');

export const TOAST_SELECTORS: Array<{ library: string; selector: string }> = [
  { library: 'mui', selector: '.MuiSnackbarContent-message, .MuiAlert-message' },
  { library: 'angular-material', selector: '.mat-mdc-snack-bar-label, .mat-simple-snackbar' },
  { library: 'kendo', selector: '.k-notification-content, .k-notification' },
  { library: 'devextreme', selector: '.dx-toast-message' },
  { library: 'primeng', selector: '.p-toast-message-content, .p-toast-detail' },
  { library: 'sap-ui5', selector: '.sapMMessageToast' },
  { library: 'oracle-jet', selector: '.oj-message-summary' },
  { library: 'salesforce', selector: '.forceToastMessage, .slds-notify_toast' },
  { library: 'toastify', selector: '.Toastify__toast-body' },
  { library: 'aria', selector: '[role=status]:not(:empty), [role=alert]:not(:empty), .toast' },
];
export const ALL_TOASTS = TOAST_SELECTORS.map((t) => t.selector).join(', ');

// ------------------------------------------------------------------ rich text, sliders, drop zones

export const EDITOR_DIALECTS: Array<DialectEntry<EditorDialect>> = [
  e('richtext', 'tinymce', 'TinyMCE (iframe)', 'real', { id: 'tinymce', root: '.tox-tinymce', iframe: 'iframe.tox-edit-area__iframe', editable: 'body' }),
  e('richtext', 'ckeditor', 'CKEditor 5', 'emulated', { id: 'ckeditor5', root: '.ck-editor, .ck.ck-editor__editable', editable: '.ck-editor__editable[contenteditable=true]' }),
  e('richtext', 'ckeditor', 'CKEditor 4 (iframe)', 'emulated', { id: 'ckeditor4', root: '.cke', iframe: 'iframe.cke_wysiwyg_frame', editable: 'body' }),
  e('richtext', 'quill', 'Quill', 'emulated', { id: 'quill', root: '.ql-container', editable: '.ql-editor' }),
  e('richtext', 'aria', 'contenteditable', 'aria', { id: 'contenteditable', root: '[contenteditable=true], [contenteditable=""], [role=textbox][aria-multiline=true]', editable: '[contenteditable=true], [contenteditable=""]' }),
];

export const SLIDER_DIALECTS: Array<DialectEntry<SliderDialect>> = [
  e('slider', 'nouislider', 'noUiSlider', 'real', { id: 'nouislider', root: '.noUi-target', handle: '.noUi-handle' }),
  e('slider', 'mui', 'MUI Slider', 'real', { id: 'mui-slider', root: '.MuiSlider-root', handle: 'input[type=range]' }),
  e('slider', 'kendo', 'Kendo Slider', 'emulated', { id: 'kendo-slider', root: '.k-slider', handle: '.k-draghandle' }),
  e('slider', 'aria', 'WAI-ARIA slider / range input', 'aria', { id: 'aria-slider', root: '[role=slider], input[type=range], :has(> [role=slider])', handle: '[role=slider], input[type=range]' }),
];

export const DROPZONE_DIALECTS: Array<DialectEntry<DropzoneDialect>> = [
  e('dropzone', 'dropzone', 'Dropzone.js', 'emulated', { id: 'dropzonejs', root: '.dropzone', fileName: '.dz-filename' }),
  e('dropzone', 'kendo', 'Kendo Upload', 'emulated', { id: 'kendo-upload', root: '.k-upload', fileName: '.k-file-name' }),
  e('dropzone', 'primeng', 'PrimeNG p-fileUpload', 'emulated', { id: 'primeng-fileupload', root: '.p-fileupload', fileName: '.p-fileupload-file-name' }),
  e('dropzone', 'devextreme', 'DevExtreme dxFileUploader', 'emulated', { id: 'dx-fileuploader', root: '.dx-fileuploader', fileName: '.dx-fileuploader-file-name' }),
  e('dropzone', 'aria', 'Generic drop zone', 'aria', { id: 'generic-dropzone', root: '*' }),
];
