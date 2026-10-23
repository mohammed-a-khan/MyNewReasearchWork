/** MUI (MIT): X Data Grid, Autocomplete (async), X Date Picker (locale aware), Tabs, Accordion, stacked Dialogs, Snackbar, Slider. */
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import CircularProgress from '@mui/material/CircularProgress';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Snackbar from '@mui/material/Snackbar';
import Slider from '@mui/material/Slider';
import { DataGrid, type GridColDef } from '@mui/x-data-grid';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import 'dayjs/locale/de';
import 'dayjs/locale/en';
import type { Dayjs } from 'dayjs';
import { orders, type Order } from '../data.js';
import { log, page } from './page.js';

const columns: GridColDef<Order>[] = [
  { field: 'id', headerName: 'Id', width: 90, type: 'number' },
  { field: 'customer', headerName: 'Customer', width: 170 },
  { field: 'region', headerName: 'Region', width: 100 },
  { field: 'status', headerName: 'Status', width: 110 },
  { field: 'amount', headerName: 'Amount', width: 120, type: 'number', editable: true, valueFormatter: (v: number) => (typeof v === 'number' ? v.toFixed(2) : '') },
  { field: 'orderDate', headerName: 'Order date', width: 120 },
];

function OrdersGrid() {
  const rows = useMemo(() => orders(page.rows ?? 300), []);
  return (
    <section aria-labelledby="h-orders">
      <h2 id="h-orders">Orders</h2>
      <div style={{ height: 520, width: 900 }}>
        <DataGrid
          rows={rows}
          columns={columns}
          checkboxSelection
          disableRowSelectionOnClick
          showToolbar
          initialState={{ pagination: { paginationModel: { pageSize: 25, page: 0 } } }}
          pageSizeOptions={[25, 50]}
          processRowUpdate={(n: Order) => {
            log(`edited ${n.id} amount=${n.amount}`);
            return n;
          }}
        />
      </div>
    </section>
  );
}

function CityAutocomplete() {
  const [input, setInput] = useState('');
  const [options, setOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setLoading(true);
    fetch(`/api/cities?q=${encodeURIComponent(input)}&delay=400`).then((r) => r.json()).then((list: string[]) => {
      if (live) {
        setOptions(list);
        setLoading(false);
      }
    });
    return () => {
      live = false;
    };
  }, [input]);
  return (
    <Autocomplete
      sx={{ width: 300 }}
      options={options}
      value={value}
      loading={loading}
      filterOptions={(x) => x}
      onChange={(_, v) => {
        setValue(v);
        log(`city=${v ?? ''}`);
      }}
      onInputChange={(_, v) => setInput(v)}
      loadingText={<><CircularProgress size={14} /> Loading…</>}
      renderInput={(params) => <TextField {...params} label="City" />}
    />
  );
}

function SkillsMulti() {
  return (
    <Autocomplete
      multiple
      sx={{ width: 400, mt: 2 }}
      options={['Accounting', 'Forecasting', 'Logistics', 'Procurement', 'Reporting', 'Sales']}
      onChange={(_, v) => log(`skills=${v.join(',')}`)}
      renderInput={(params) => <TextField {...params} label="Skills" />}
    />
  );
}

function DueDate() {
  const [value, setValue] = useState<Dayjs | null>(null);
  return (
    <DatePicker
      label="Due date"
      value={value}
      onChange={(v) => {
        setValue(v);
        log(`due=${v && v.isValid() ? v.format('YYYY-MM-DD') : ''}`);
      }}
    />
  );
}

function SettingsTabs() {
  const [tab, setTab] = useState(0);
  const names = ['General', 'Billing', 'Security'];
  return (
    <section aria-labelledby="h-settings">
      <h2 id="h-settings">Settings</h2>
      <Tabs value={tab} onChange={(_, v: number) => setTab(v)} aria-label="Settings">
        {names.map((n, i) => <Tab key={n} label={n} id={`tab-${i}`} aria-controls={`panel-${i}`} />)}
      </Tabs>
      {names.map((n, i) => (
        <div key={n} role="tabpanel" id={`panel-${i}`} aria-labelledby={`tab-${i}`} hidden={tab !== i}>{n} settings panel</div>
      ))}
    </section>
  );
}

function Details() {
  return (
    <section aria-labelledby="h-details">
      <h2 id="h-details">Details</h2>
      <div aria-label="Details" role="region">
        {['Shipping', 'Payment', 'Notes'].map((s) => (
          <Accordion key={s}>
            <AccordionSummary aria-controls={`${s}-content`} id={`${s}-header`}>{s}</AccordionSummary>
            <AccordionDetails id={`${s}-content`}>{s} details</AccordionDetails>
          </Accordion>
        ))}
      </div>
    </section>
  );
}

function Dialogs() {
  const [first, setFirst] = useState(false);
  const [second, setSecond] = useState(false);
  const [toast, setToast] = useState('');
  return (
    <section>
      <Button variant="outlined" onClick={() => setFirst(true)}>Edit order</Button>{' '}
      <Button variant="outlined" onClick={() => setToast('Order saved')}>Save</Button>
      <Dialog open={first} onClose={() => setFirst(false)} aria-labelledby="dlg1-title">
        <DialogTitle id="dlg1-title">Edit order</DialogTitle>
        <DialogContent>Order 42</DialogContent>
        <DialogActions>
          <Button onClick={() => setSecond(true)}>Delete</Button>
          <Button onClick={() => setFirst(false)}>Close</Button>
        </DialogActions>
      </Dialog>
      <Dialog open={second} onClose={() => setSecond(false)} aria-labelledby="dlg2-title">
        <DialogTitle id="dlg2-title">Confirm delete</DialogTitle>
        <DialogContent>Delete order 42?</DialogContent>
        <DialogActions>
          <Button onClick={() => setSecond(false)}>Cancel</Button>
          <Button onClick={() => {
            setSecond(false);
            setFirst(false);
            setToast('Order deleted');
          }}>Delete</Button>
        </DialogActions>
      </Dialog>
      <Snackbar open={toast !== ''} autoHideDuration={1500} onClose={() => setToast('')} message={toast} />
    </section>
  );
}

function PriceSlider() {
  return (
    <section>
      <h2 id="h-price">Price</h2>
      <Slider sx={{ width: 300 }} defaultValue={10} min={0} max={100} step={1} aria-label="Price" valueLabelDisplay="auto" onChangeCommitted={(_, v) => log(`price=${String(v)}`)} />
    </section>
  );
}

function App() {
  const lang = page.locale.slice(0, 2);
  return (
    <LocalizationProvider dateAdapter={AdapterDayjs} adapterLocale={lang === 'de' ? 'de' : 'en'}>
      <OrdersGrid />
      <section><h2>Lookups</h2><CityAutocomplete /><SkillsMulti /></section>
      <section><h2>Dates</h2><DueDate /></section>
      <SettingsTabs />
      <Details />
      <Dialogs />
      <PriceSlider />
    </LocalizationProvider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
