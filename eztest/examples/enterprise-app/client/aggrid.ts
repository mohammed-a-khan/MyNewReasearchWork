/** ag-Grid Community (MIT): a 10,000-row virtualized Orders grid and a wide Shipments grid (column virtualization). */
import { AllCommunityModule, ModuleRegistry, createGrid, type ColDef, type GridApi } from 'ag-grid-community';
import { orders, type Order } from '../data.js';
import { log, page } from './page.js';

ModuleRegistry.registerModules([AllCommunityModule]);

declare global {
  interface Window {
    ordersApi?: GridApi<Order>;
  }
}

const columns: ColDef<Order>[] = [
  { field: 'id', headerName: 'Id', pinned: 'left', width: 100, filter: 'agNumberColumnFilter' },
  { field: 'customer', headerName: 'Customer', width: 170 },
  { field: 'region', headerName: 'Region', width: 110 },
  { field: 'status', headerName: 'Status', width: 120 },
  { field: 'amount', headerName: 'Amount', width: 130, editable: true, filter: 'agNumberColumnFilter', valueParser: (p) => Number(p.newValue), valueFormatter: (p) => (typeof p.value === 'number' ? p.value.toFixed(2) : '') },
  { field: 'orderDate', headerName: 'Order date', width: 130 },
];

const api = createGrid<Order>(document.getElementById('grid')!, {
  columnDefs: columns,
  rowData: orders(page.rows ?? 10_000),
  getRowId: (p) => String(p.data.id),
  defaultColDef: { sortable: true, filter: true, floatingFilter: true, resizable: true },
  rowSelection: { mode: 'multiRow', checkboxes: true, headerCheckbox: true, enableClickSelection: true },
  onCellValueChanged: (e) => log(`edited ${e.data.id} ${String(e.colDef.field)}=${String(e.newValue)}`),
});
window.ordersApi = api;

document.getElementById('reorder')!.addEventListener('click', () => {
  api.moveColumns(['amount'], 1);
  log('moved Amount');
});
document.getElementById('refresh')!.addEventListener('click', () => {
  api.setGridOption('rowData', orders(page.rows ?? 10_000));
});

// A wide grid: 20 columns in a narrow viewport, so ag-Grid virtualizes columns as well as rows.
interface Shipment { [k: string]: string | number }
const wideCols: ColDef<Shipment>[] = [
  { field: 'ref', headerName: 'Ref', pinned: 'left', width: 90 },
  ...Array.from({ length: 19 }, (_, i) => ({ field: `c${i + 2}`, headerName: i === 18 ? 'Carrier' : `Leg ${i + 2}`, width: 120 })),
];
const shipments: Shipment[] = Array.from({ length: 200 }, (_, r) => {
  const row: Shipment = { ref: `S-${1000 + r}` };
  for (let c = 2; c <= 20; c++) row[`c${c}`] = c === 20 ? ['DHL', 'UPS', 'FedEx', 'Maersk'][r % 4] : `L${c}-${r}`;
  return row;
});
createGrid<Shipment>(document.getElementById('wide')!, {
  columnDefs: wideCols,
  rowData: shipments,
  getRowId: (p) => String(p.data.ref),
  defaultColDef: { sortable: true },
});
