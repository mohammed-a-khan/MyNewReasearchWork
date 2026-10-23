/**
 * Builds the emulated-library pages. Every library page has the same
 * sections (Orders grid, City combobox, Status drop-down list, Skills
 * multi-select, Due date picker, Regions tree, Settings tabs, stacked
 * dialogs, toasts), so one .ez journey runs unchanged against each.
 */
import { CITIES, orders } from '../../data.js';
import { page } from '../page.js';
import { ariaAccordion, ariaCombobox, ariaGrid, ckEditor5, contentEditable, infiniteFeed, quillEditor } from './aria.js';
import { dxSelectBox, jetSelectSingle, kendoComboBox, kendoDropDownList, kendoMultiSelect, matSelect, pfSelectOneMenu, primengDropdown, ui5Select } from './combos.js';
import { ariaDatePicker, dxDateBox, kendoDatePicker, matDatepicker, primengCalendar, ui5DatePicker } from './dates.js';
import { h } from './dom.js';
import { dxGrid, GridModel, jetTable, kendoGrid, matTable, primefacesTable, primengTable, ui5Table } from './grids.js';
import { dialogDemo, tabs, tree, type Lib } from './panels.js';

const root = document.getElementById('root')!;
const STATUSES = ['Open', 'Shipped', 'Closed', 'On hold'];
const SKILLS = ['Accounting', 'Forecasting', 'Logistics', 'Procurement', 'Reporting', 'Sales'];

function section(title: string, id: string): HTMLElement {
  const host = h('div', { class: 'host' });
  root.appendChild(h('section', { 'aria-labelledby': `h-${id}` }, h('h2', { id: `h-${id}` }, title), host));
  return host;
}

/** A labelled field row ("City" + widget) inside a plain container, like a form. */
function field(host: HTMLElement): HTMLElement {
  const f = h('div', { class: 'field', style: 'margin: 6px 0' });
  host.appendChild(f);
  return f;
}

function libraryPage(lib: string): void {
  const locale = page.locale;
  const rows = orders(page.rows ?? 60);
  const grid = section('Orders', 'orders');
  const lookups = section('Lookups', 'lookups');
  const dates = section('Dates', 'dates');
  const regions = section('Regions', 'regions');
  const settings = section('Settings', 'settings');
  const actions = section('Actions', 'actions');
  const panelLib: Lib = lib === 'primefaces' ? 'primeng' : (lib as Lib);
  switch (lib) {
    case 'kendo':
      kendoGrid(grid, new GridModel(rows, 20));
      kendoComboBox(field(lookups), 'City');
      kendoDropDownList(field(lookups), 'Status', STATUSES);
      kendoMultiSelect(field(lookups), 'Skills', SKILLS);
      kendoDatePicker(field(dates), 'Due date', locale);
      break;
    case 'devextreme':
      dxGrid(grid, new GridModel(rows, 20));
      dxSelectBox(field(lookups), 'City', 'async');
      dxSelectBox(field(lookups), 'Status', STATUSES);
      dxSelectBox(field(lookups), 'Skills', SKILLS, true);
      dxDateBox(field(dates), 'Due date', locale);
      break;
    case 'primeng':
      primengTable(grid, new GridModel(rows, 20));
      primengDropdown(field(lookups), 'City', CITIES);
      primengDropdown(field(lookups), 'Status', STATUSES);
      primengCalendar(field(dates), 'Due date', locale);
      break;
    case 'primefaces':
      primefacesTable(grid, new GridModel(rows, 20));
      pfSelectOneMenu(field(lookups), 'City', CITIES);
      pfSelectOneMenu(field(lookups), 'Status', STATUSES);
      ariaDatePicker(field(dates), 'Due date', locale);
      break;
    case 'material':
      matTable(grid, new GridModel(rows, 20));
      matSelect(field(lookups), 'City', CITIES);
      matSelect(field(lookups), 'Status', STATUSES);
      matSelect(field(lookups), 'Skills', SKILLS, true);
      matDatepicker(field(dates), 'Due date', locale);
      break;
    case 'jet':
      jetTable(grid, new GridModel(orders(page.rows ?? 120), 1000));
      jetSelectSingle(field(lookups), 'City');
      ariaDatePicker(field(dates), 'Due date', locale);
      break;
    case 'ui5':
      ui5Table(grid, new GridModel(rows, 1000));
      ui5Select(field(lookups), 'City', CITIES);
      ui5Select(field(lookups), 'Status', STATUSES);
      ui5DatePicker(field(dates), 'Due date', locale);
      break;
    default:
      ariaGrid(grid, { label: 'Orders', rows: page.rows ?? 60 });
      ariaCombobox(field(lookups), 'City');
      field(lookups).append(h('label', { for: 'country' }, 'Country'), h('select', { id: 'country' }, ['', 'France', 'Germany', 'Spain'].map((c) => h('option', { value: c }, c))));
      field(dates).append(h('label', { for: 'start' }, 'Start date'), h('input', { id: 'start', type: 'date' }));
      ariaDatePicker(field(dates), 'Due date', locale);
      ariaAccordion(section('Details', 'details'), 'Details');
  }
  tree(regions, lib === 'jet' || lib === 'primefaces' ? 'aria' : panelLib, 'Regions');
  tabs(settings, lib === 'jet' || lib === 'primefaces' ? 'aria' : panelLib, 'Settings');
  dialogDemo(actions, lib === 'primefaces' ? 'primeng' : panelLib);
}

const path = page.path;
if (path.startsWith('/lib/')) libraryPage(path.slice('/lib/'.length));
else if (path === '/grid/aria') ariaGrid(section('Orders', 'orders'), { label: 'Orders', rows: page.rows ?? 10_000 });
else if (path === '/heal') ariaGrid(section(page.v === '2' ? 'Customer orders' : 'Orders', 'orders'), { label: 'Orders', rows: page.rows ?? 2000, version: page.v });
else if (path === '/editors') {
  contentEditable(section('Comments', 'comments'), 'Comments');
  quillEditor(section('Notes', 'notes'));
  ckEditor5(section('Summary', 'summary'), 'Summary');
} else if (path === '/list') infiniteFeed(section('News', 'news'), 'News', 250, 25);
