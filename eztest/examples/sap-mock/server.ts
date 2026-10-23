/**
 * An SAP S/4HANA emulation for EZTest's SAP Fiori pack, built from SAP's
 * public documentation of Fiori/UI5 and OData conventions. It is NOT SAP:
 * the pack is tested against this mock, not against a real system.
 *
 *  - ABAP-style logon page (USERNAME_FIELD-inner / PASSWORD_FIELD-inner /
 *    LOGIN_LINK) and a Fiori launchpad (FioriLaunchpad.html, hash intents)
 *    with tiles per user catalog. Apps (launchpad.js) render UI5 DOM
 *    conventions: Smart Filter Bar, responsive table, object page with Smart
 *    Fields (Input + value help, ComboBox for fixed values, DatePicker),
 *    value help dialog, message toast and message popover. A minimal
 *    `sap.ui.getCore().byId()` exposes controls with getBindingPath().
 *  - OData V2 (SD_SALESORDER_MANAGE_SRV, API_SALES_ORDER_SRV) with
 *    $metadata (sap:label, Nullable, value-list annotations), $filter eq /
 *    substringof, $select, $top, $inlinecount, d.results JSON, /Date()/
 *    values, CSRF token fetch for writes and SAP error bodies.
 *  - OData V4 (api_product) with Common.Label annotations and value JSON.
 *  - ADT: /sap/bc/adt/cts/transportrequests/{nr} (object lists) and
 *    /sap/bc/adt/ddic/dataelements/{name} (field labels).
 *  - system 'QAS' (baseline) or 'DEV' (transports DEVK900123/DEVK900130
 *    applied: PO number relabeled and mandatory, order type CR removed,
 *    Material Group relabeled Product Group).
 *
 * Run standalone: `npx tsx examples/sap-mock/server.ts`.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export type SapSystem = 'QAS' | 'DEV';
type Row = Record<string, string>;

interface Prop { name: string; type: 'Edm.String' | 'Edm.DateTime' | 'Edm.Date' | 'Edm.Decimal'; label: string; maxLength?: number; required?: boolean; creatable?: boolean; updatable?: boolean; valueList?: { collection: string; fixed: boolean } }
interface EntitySet { name: string; type: string; label: string; keys: string[]; props: Prop[]; source: 'orders' | 'customers' | 'orderTypes' | 'products' }
interface Service { name: string; version: 2 | 4; path: string; namespace: string; sets: EntitySet[]; users: string[] }

export interface SapMockServer {
  url: string;
  client: string;
  system: SapSystem;
  users: Record<'clerk' | 'productManager' | 'admin' | 'integration', { username: string; password: string }>;
  data: { orders: Row[]; customers: Row[]; orderTypes: Row[]; products: Row[] };
  stats: { odata: string[]; csrfFetches: number };
  close(): Promise<void>;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

function services(system: SapSystem): Service[] {
  const dev = system === 'DEV';
  const poLabel = dev ? 'Purchase Order Number' : 'Customer Reference';
  const order = (name: string, ui: boolean): EntitySet => ({
    name, type: `${name}Type`, label: 'Sales Order', keys: ['SalesOrder'], source: 'orders',
    props: [
      { name: 'SalesOrder', type: 'Edm.String', label: 'Sales Order', maxLength: 10, required: true, creatable: false, updatable: false },
      { name: 'SalesOrderType', type: 'Edm.String', label: 'Sales Order Type', maxLength: 4, required: true, ...(ui ? { valueList: { collection: 'I_SalesDocumentTypeVH', fixed: true } } : {}) },
      { name: 'SalesOrganization', type: 'Edm.String', label: 'Sales Organization', maxLength: 4, required: true },
      ...(ui ? [] : [{ name: 'DistributionChannel', type: 'Edm.String' as const, label: 'Distribution Channel', maxLength: 2 }]),
      { name: 'SoldToParty', type: 'Edm.String', label: 'Sold-To Party', maxLength: 10, required: true, ...(ui ? { valueList: { collection: 'I_CustomerVH', fixed: false } } : {}) },
      { name: 'PurchaseOrderByCustomer', type: 'Edm.String', label: poLabel, maxLength: 35, required: dev },
      { name: 'RequestedDeliveryDate', type: 'Edm.DateTime', label: 'Requested Delivery Date' },
      { name: 'TotalNetAmount', type: 'Edm.Decimal', label: 'Net Value', creatable: false, updatable: false },
      { name: 'TransactionCurrency', type: 'Edm.String', label: 'Currency', maxLength: 5 },
      { name: 'OverallSDProcessStatus', type: 'Edm.String', label: 'Overall Status', maxLength: 1, creatable: false, updatable: false },
    ],
  });
  return [
    {
      name: 'SD_SALESORDER_MANAGE_SRV', version: 2, path: '/sap/opu/odata/sap/SD_SALESORDER_MANAGE_SRV', namespace: 'SD_SALESORDER_MANAGE_SRV', users: ['clerk', 'admin', 'integration'],
      sets: [
        order('C_SalesOrder', true),
        { name: 'I_SalesDocumentTypeVH', type: 'I_SalesDocumentTypeVHType', label: 'Sales Document Type', keys: ['SalesDocumentType'], source: 'orderTypes', props: [{ name: 'SalesDocumentType', type: 'Edm.String', label: 'Sales Document Type', maxLength: 4 }, { name: 'SalesDocumentType_Text', type: 'Edm.String', label: 'Description', maxLength: 20 }] },
        { name: 'I_CustomerVH', type: 'I_CustomerVHType', label: 'Customer', keys: ['Customer'], source: 'customers', props: [{ name: 'Customer', type: 'Edm.String', label: 'Customer', maxLength: 10 }, { name: 'CustomerName', type: 'Edm.String', label: 'Name of Customer', maxLength: 80 }] },
      ],
    },
    { name: 'API_SALES_ORDER_SRV', version: 2, path: '/sap/opu/odata/sap/API_SALES_ORDER_SRV', namespace: 'API_SALES_ORDER_SRV', users: ['clerk', 'admin', 'integration'], sets: [order('A_SalesOrder', false)] },
    {
      name: 'api_product', version: 4, path: '/sap/opu/odata4/sap/api_product/srvd_a2x/sap/product/0001', namespace: 'com.sap.gateway.srvd_a2x.api_product.v0001', users: ['productManager', 'admin', 'integration'],
      sets: [{
        name: 'Product', type: 'ProductType', label: 'Product', keys: ['Product'], source: 'products',
        props: [
          { name: 'Product', type: 'Edm.String', label: 'Product', maxLength: 18, required: true, updatable: false },
          { name: 'ProductType', type: 'Edm.String', label: 'Product Type', maxLength: 4, required: true },
          { name: 'ProductGroup', type: 'Edm.String', label: dev ? 'Product Group' : 'Material Group', maxLength: 9 },
          { name: 'BaseUnit', type: 'Edm.String', label: 'Base Unit of Measure', maxLength: 3 },
          { name: 'ProductDescription', type: 'Edm.String', label: 'Product Description', maxLength: 40 },
        ],
      }],
    },
  ];
}

function v2Metadata(s: Service): string {
  const types = s.sets.map((e) => `<EntityType Name="${e.type}" sap:label="${esc(e.label)}" sap:content-version="1"><Key>${e.keys.map((k) => `<PropertyRef Name="${k}"/>`).join('')}</Key>${e.props.map((p) =>
    `<Property Name="${p.name}" Type="${p.type}" Nullable="${p.required ? 'false' : 'true'}"${p.maxLength ? ` MaxLength="${p.maxLength}"` : ''}${p.type === 'Edm.Decimal' ? ' Precision="16" Scale="3"' : ''}${p.type === 'Edm.DateTime' ? ' Precision="0" sap:display-format="Date"' : ''} sap:label="${esc(p.label)}"${p.creatable === false ? ' sap:creatable="false"' : ''}${p.updatable === false ? ' sap:updatable="false"' : ''}${p.valueList ? ` sap:value-list="${p.valueList.fixed ? 'fixed-values' : 'standard'}"` : ''}/>`).join('')}</EntityType>`).join('');
  const sets = s.sets.map((e) => `<EntitySet Name="${e.name}" EntityType="${s.namespace}.${e.type}" sap:creatable="${e.source === 'orders'}" sap:updatable="${e.source === 'orders'}" sap:deletable="false" sap:content-version="1"/>`).join('');
  const ann = s.sets.flatMap((e) => e.props.filter((p) => p.valueList).map((p) => `<Annotations Target="${s.namespace}.${e.type}/${p.name}" xmlns="http://docs.oasis-open.org/odata/ns/edm"><Annotation Term="com.sap.vocabularies.Common.v1.ValueList"><Record><PropertyValue Property="CollectionPath" String="${p.valueList!.collection}"/><PropertyValue Property="SearchSupported" Bool="true"/></Record></Annotation></Annotations>`)).join('');
  return `<?xml version="1.0" encoding="utf-8"?><edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" xmlns:sap="http://www.sap.com/Protocols/SAPData"><edmx:DataServices m:DataServiceVersion="2.0"><Schema Namespace="${s.namespace}" xml:lang="en" sap:schema-version="1" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">${types}<EntityContainer Name="${s.namespace}_Entities" m:IsDefaultEntityContainer="true" sap:supported-formats="atom json xlsx">${sets}</EntityContainer>${ann}</Schema></edmx:DataServices></edmx:Edmx>`;
}

function v4Metadata(s: Service): string {
  const types = s.sets.map((e) => `<EntityType Name="${e.type}"><Key>${e.keys.map((k) => `<PropertyRef Name="${k}"/>`).join('')}</Key>${e.props.map((p) => `<Property Name="${p.name}" Type="${p.type === 'Edm.DateTime' ? 'Edm.Date' : p.type}" Nullable="${p.required ? 'false' : 'true'}"${p.maxLength ? ` MaxLength="${p.maxLength}"` : ''}/>`).join('')}</EntityType>`).join('');
  const sets = s.sets.map((e) => `<EntitySet Name="${e.name}" EntityType="${s.namespace}.${e.type}"/>`).join('');
  const ann = s.sets.flatMap((e) => [
    `<Annotations Target="${s.namespace}.${e.type}"><Annotation Term="com.sap.vocabularies.Common.v1.Label" String="${esc(e.label)}"/></Annotations>`,
    ...e.props.map((p) => `<Annotations Target="${s.namespace}.${e.type}/${p.name}"><Annotation Term="com.sap.vocabularies.Common.v1.Label" String="${esc(p.label)}"/>${p.updatable === false ? '<Annotation Term="Org.OData.Core.V1.Immutable" Bool="true"/>' : ''}</Annotations>`),
  ]).join('');
  return `<?xml version="1.0" encoding="utf-8"?><edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices><Schema Namespace="${s.namespace}" xmlns="http://docs.oasis-open.org/odata/ns/edm">${types}<EntityContainer Name="Container">${sets}</EntityContainer>${ann}</Schema></edmx:DataServices></edmx:Edmx>`;
}

class ODataError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: Array<{ code: string; message: string; target: string; severity: string }> = []) {
    super(message);
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of (req.headers.cookie ?? '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return out;
}

const LAUNCHPAD_JS = readFileSync(new URL('./launchpad.js', import.meta.url), 'utf8');

export async function startSapMock(o: { system?: SapSystem; port?: number; client?: string } = {}): Promise<SapMockServer> {
  const system = o.system ?? 'QAS';
  const sapClient = o.client ?? '100';
  const svc = services(system);
  const pw = (p: string) => `${p}-${randomBytes(6).toString('hex')}`;
  const users = {
    clerk: { username: 'FIORI_CLERK', password: pw('Clk') },
    productManager: { username: 'PROD_MGR', password: pw('Prd') },
    admin: { username: 'EZ_ADMIN', password: pw('Adm') },
    integration: { username: 'COMM_EZTEST', password: pw('Com') },
  };
  const roleOf = (u: string) => (Object.entries(users).find(([, x]) => x.username === u.toUpperCase())?.[0] ?? '') as keyof typeof users | '';
  const data = {
    orders: [
      { SalesOrder: '4711', SalesOrderType: 'OR', SalesOrganization: '1710', DistributionChannel: '10', SoldToParty: '17100001', PurchaseOrderByCustomer: 'PO-ACME-1', RequestedDeliveryDate: '2026-11-15', TotalNetAmount: '1250.000', TransactionCurrency: 'USD', OverallSDProcessStatus: 'A' },
      { SalesOrder: '4712', SalesOrderType: 'OR', SalesOrganization: '1710', DistributionChannel: '10', SoldToParty: '17100002', PurchaseOrderByCustomer: 'PO-GLOBEX-7', RequestedDeliveryDate: '2026-12-01', TotalNetAmount: '980.500', TransactionCurrency: 'USD', OverallSDProcessStatus: 'B' },
    ] as Row[],
    customers: [
      { Customer: '17100001', CustomerName: 'Domestic Customer US 1' }, { Customer: '17100002', CustomerName: 'Domestic Customer US 2' },
      { Customer: '17100011', CustomerName: 'Domestic Customer US 11' }, { Customer: '10100001', CustomerName: 'Inlandskunde DE 1' },
    ] as Row[],
    orderTypes: [
      { SalesDocumentType: 'OR', SalesDocumentType_Text: 'Standard Order' }, { SalesDocumentType: 'RE', SalesDocumentType_Text: 'Returns' },
      ...(system === 'QAS' ? [{ SalesDocumentType: 'CR', SalesDocumentType_Text: 'Credit Memo Request' }] : []),
    ] as Row[],
    products: [
      { Product: 'TG11', ProductType: 'HAWA', ProductGroup: 'L001', BaseUnit: 'PC', ProductDescription: 'Trading Good 11' },
      { Product: 'FG29', ProductType: 'FERT', ProductGroup: 'L004', BaseUnit: 'PC', ProductDescription: 'Finished Good 29' },
    ] as Row[],
  };
  let nextOrder = 4713;
  const stats = { odata: [] as string[], csrfFetches: 0 };
  const sessions = new Map<string, string>();
  const csrf = new Map<string, string>();

  const authUser = (req: IncomingMessage): string | undefined => {
    const h = req.headers.authorization ?? '';
    if (h.startsWith('Basic ')) {
      const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
      const r = roleOf(u);
      if (r && users[r].password === p.join(':')) return r;
      return undefined;
    }
    return sessions.get(cookies(req)[`SAP_SESSIONID_EZ1_${sapClient}`] ?? '');
  };

  const catalog: Record<string, Array<{ title: string; subtitle: string; intent: string }>> = {
    clerk: [{ title: 'Manage Sales Orders', subtitle: 'Display, change and create', intent: 'SalesOrder-manage' }],
    productManager: [{ title: 'Manage Products', subtitle: 'Master data', intent: 'Product-manage' }],
    admin: [{ title: 'Manage Sales Orders', subtitle: 'Display, change and create', intent: 'SalesOrder-manage' }, { title: 'Manage Products', subtitle: 'Master data', intent: 'Product-manage' }],
    integration: [],
  };

  // ---------------------------------------------------------------- OData
  const v2Value = (p: Prop, v: string | undefined): unknown => {
    if (v === undefined || v === '') return p.type === 'Edm.DateTime' ? null : '';
    if (p.type === 'Edm.DateTime') return `/Date(${Date.parse(`${v}T00:00:00Z`)})/`;
    return v;
  };
  const fromV2 = (p: Prop, v: unknown): string => {
    if (v === null || v === undefined) return '';
    const m = /^\/Date\((-?\d+)\)\/$/.exec(String(v));
    if (m) return new Date(Number(m[1])).toISOString().slice(0, 10);
    if (p.type === 'Edm.DateTime' && /^\d{4}-\d{2}-\d{2}/.test(String(v))) return String(v).slice(0, 10);
    return String(v);
  };
  const parseFilter = (f: string): Array<(r: Row) => boolean> =>
    f.split(/\s+and\s+/i).filter(Boolean).map((t) => {
      let m = /^(\w+)\s+eq\s+'((?:[^']|'')*)'$/.exec(t.trim());
      if (m) {
        const [, k, v] = m;
        return (r: Row) => (r[k] ?? '') === v.replace(/''/g, "'");
      }
      m = /^substringof\('((?:[^']|'')*)',\s*(\w+)\)(?:\s+eq\s+true)?$/i.exec(t.trim()) ?? /^contains\((\w+),\s*'((?:[^']|'')*)'\)$/i.exec(t.trim());
      if (m) {
        const [a, b] = t.trim().toLowerCase().startsWith('contains') ? [m[2], m[1]] : [m[1], m[2]];
        return (r: Row) => (r[b] ?? '').toLowerCase().includes(a.replace(/''/g, "'").toLowerCase());
      }
      throw new ODataError(400, 'SY/530', `Invalid filter expression: ${t}`);
    });

  const sendJson = (res: ServerResponse, status: number, body: unknown, h: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...h });
    res.end(JSON.stringify(body));
  };

  async function odata(req: IncomingMessage, res: ServerResponse, url: URL, s: Service, rest: string): Promise<void> {
    const role = authUser(req);
    if (!role) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="SAP NetWeaver Application Server [EZ1/100]"', 'content-type': 'text/plain' });
      res.end('Logon failed');
      return;
    }
    if (!s.users.includes(role)) throw new ODataError(403, '/IWFND/CM_CONSUMER/101', `No authorization to access service ${s.name} (S_SERVICE)`);
    const token = (req.headers['x-csrf-token'] as string | undefined) ?? '';
    const headers: Record<string, string> = { 'sap-system': 'EZ1', 'dataserviceversion': s.version === 2 ? '2.0' : '' };
    if (token.toLowerCase() === 'fetch') {
      stats.csrfFetches++;
      const t = randomBytes(12).toString('base64');
      csrf.set(role, t);
      headers['x-csrf-token'] = t;
    }
    if (rest === '' || rest === '/') return sendJson(res, 200, s.version === 2 ? { d: { EntitySets: s.sets.map((e) => e.name) } } : { value: s.sets.map((e) => ({ name: e.name, kind: 'EntitySet', url: e.name })) }, headers);
    if (rest === '/$metadata') {
      res.writeHead(200, { 'content-type': 'application/xml', ...headers });
      res.end(s.version === 2 ? v2Metadata(s) : v4Metadata(s));
      return;
    }
    const m = /^\/(\w+)(?:\((?:'([^']*)'|\w+='([^']*)')\))?$/.exec(rest);
    const set = m ? s.sets.find((e) => e.name === m[1]) : undefined;
    if (!m || !set) throw new ODataError(404, '/IWFND/MED/170', `No service found for ${rest}`);
    const rows = data[set.source];
    const key = m[2] ?? m[3];
    stats.odata.push(`${req.method} ${s.name}/${m[1]}${key !== undefined ? `('${key}')` : ''}${url.search ? decodeURIComponent(url.search) : ''}`);
    const out = (r: Row, sel?: string[]) => {
      const o2: Record<string, unknown> = s.version === 2 ? { __metadata: { id: `${url.origin}${s.path}/${set.name}('${r[set.keys[0]]}')`, uri: `${url.origin}${s.path}/${set.name}('${r[set.keys[0]]}')`, type: `${s.namespace}.${set.type}` } } : {};
      for (const p of set.props) if (!sel || sel.includes(p.name)) o2[p.name] = s.version === 2 ? v2Value(p, r[p.name]) : r[p.name] ?? null;
      return o2;
    };
    if (req.method === 'GET') {
      const sel = url.searchParams.get('$select')?.split(',').map((x) => x.trim());
      if (key !== undefined) {
        const r = rows.find((x) => x[set.keys[0]] === key);
        if (!r) throw new ODataError(404, 'SD_SALES/001', `Resource not found for segment '${set.name}'`);
        return sendJson(res, 200, s.version === 2 ? { d: out(r, sel) } : { '@odata.context': `$metadata#${set.name}/$entity`, ...out(r, sel) }, headers);
      }
      const preds = url.searchParams.get('$filter') ? parseFilter(url.searchParams.get('$filter')!) : [];
      const search = (url.searchParams.get('search') ?? url.searchParams.get('$search') ?? '').toLowerCase();
      let hit = rows.filter((r) => preds.every((p) => p(r))).filter((r) => !search || Object.values(r).some((v) => v.toLowerCase().includes(search)));
      const count = hit.length;
      const skip = Number(url.searchParams.get('$skip') ?? 0);
      const top = url.searchParams.get('$top') ? Number(url.searchParams.get('$top')) : undefined;
      hit = hit.slice(skip, top !== undefined ? skip + top : undefined);
      if (s.version === 2) return sendJson(res, 200, { d: { results: hit.map((r) => out(r, sel)), ...(url.searchParams.get('$inlinecount') === 'allpages' ? { __count: String(count) } : {}) } }, headers);
      return sendJson(res, 200, { '@odata.context': `$metadata#${set.name}`, ...(url.searchParams.get('$count') === 'true' ? { '@odata.count': count } : {}), value: hit.map((r) => out(r, sel)) }, headers);
    }
    if (!csrf.get(role) || csrf.get(role) !== token) {
      res.writeHead(403, { 'x-csrf-token': 'Required', 'content-type': 'text/plain' });
      res.end('CSRF token validation failed');
      return;
    }
    if (set.source !== 'orders' && set.source !== 'products') throw new ODataError(405, 'SY/530', `${set.name} is read-only`);
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    const vals: Row = {};
    for (const p of set.props) if (p.name in body) vals[p.name] = s.version === 2 ? fromV2(p, body[p.name]) : String(body[p.name] ?? '');
    const validate = (r: Row, creating: boolean) => {
      const details: Array<{ code: string; message: string; target: string; severity: string }> = [];
      for (const p of set.props) {
        if (p.required && p.creatable !== false && !(r[p.name] ?? '').trim()) details.push({ code: 'V1/012', message: p.name === 'PurchaseOrderByCustomer' ? 'Enter a purchase order number' : `Enter a value for ${p.label}`, target: p.name, severity: 'error' });
      }
      if (set.source === 'orders') {
        if (r.SalesOrderType && !data.orderTypes.some((t) => t.SalesDocumentType === r.SalesOrderType)) details.push({ code: 'V1/013', message: `Sales document type ${r.SalesOrderType} is not defined`, target: 'SalesOrderType', severity: 'error' });
        if (r.SoldToParty && !data.customers.some((c) => c.Customer === r.SoldToParty)) details.push({ code: 'VP/112', message: `Customer ${r.SoldToParty} does not exist`, target: 'SoldToParty', severity: 'error' });
        if (r.RequestedDeliveryDate && r.RequestedDeliveryDate < '2026-01-01') details.push({ code: 'V1/554', message: 'Requested delivery date is in the past', target: 'RequestedDeliveryDate', severity: 'error' });
      }
      void creating;
      if (details.length) throw new ODataError(400, details[0].code, details[0].message, details);
    };
    if (req.method === 'POST' && key === undefined) {
      const r: Row = { SalesOrganization: '1710', DistributionChannel: '10', TransactionCurrency: 'USD', TotalNetAmount: '0.000', OverallSDProcessStatus: 'A', ...vals };
      validate(r, true);
      if (set.source === 'orders') r.SalesOrder = String(nextOrder++);
      rows.push(r);
      return sendJson(res, 201, s.version === 2 ? { d: out(r) } : out(r), { ...headers, location: `${s.path}/${set.name}('${r[set.keys[0]]}')` });
    }
    if ((req.method === 'PATCH' || req.method === 'MERGE' || req.method === 'PUT') && key !== undefined) {
      const r = rows.find((x) => x[set.keys[0]] === key);
      if (!r) throw new ODataError(404, 'SD_SALES/001', 'Resource not found');
      for (const p of set.props) if (p.name in vals && p.updatable === false && vals[p.name] !== r[p.name]) throw new ODataError(400, 'SY/530', `Property ${p.name} cannot be changed`);
      validate({ ...r, ...vals }, false);
      Object.assign(r, vals);
      res.writeHead(204, headers);
      res.end();
      return;
    }
    throw new ODataError(405, 'SY/530', `Method ${req.method} not allowed`);
  }

  // ---------------------------------------------------------------- ADT
  const transports: Record<string, { desc: string; owner: string; objects: Array<[string, string, string]> }> = system === 'DEV' ? {
    DEVK900123: {
      desc: 'SD: PO number mandatory, retire credit memo request type', owner: 'DEVELOPER',
      objects: [['R3TR', 'DTEL', 'BSTKD'], ['R3TR', 'TABU', 'TVAK'], ['R3TR', 'PROG', 'SAPMV45A'], ['LIMU', 'REPS', 'MV45AFZZ'], ['R3TR', 'WAPA', 'ZSD_SO_MANAGE'], ['R3TR', 'IWSV', 'SD_SALESORDER_MANAGE_SRV 0001'], ['R3TR', 'PROG', 'ZEZ_UNUSED_REPORT']],
    },
    DEVK900130: { desc: 'MM: rename material group to product group', owner: 'DEVELOPER', objects: [['R3TR', 'DTEL', 'MATKL'], ['R3TR', 'SRVD', 'API_PRODUCT']] },
  } : {};
  const dataElements: Record<string, [string, string, string, string]> = {
    BSTKD: system === 'DEV' ? ['PO No.', 'PO Number', 'Purchase Order Number', 'PO Number'] : ['Cust. Ref.', 'Customer Ref.', 'Customer Reference', 'Customer Reference'],
    MATKL: system === 'DEV' ? ['Prod.Grp', 'Product Group', 'Product Group', 'Product Group'] : ['Matl Group', 'Material Group', 'Material Group', 'Material Group'],
    AUART: ['SaTy', 'Sales Doc. Type', 'Sales Document Type', 'Sales Doc. Type'],
  };
  function adt(req: IncomingMessage, res: ServerResponse, path: string): void {
    const role = authUser(req);
    if (role !== 'admin' && role !== 'integration') {
      res.writeHead(role ? 403 : 401, { 'content-type': 'text/plain', ...(role ? {} : { 'www-authenticate': 'Basic realm="SAP"' }) });
      res.end(role ? 'No authorization for ADT (S_ADT_RES)' : 'Logon failed');
      return;
    }
    let m = /^\/sap\/bc\/adt\/cts\/transportrequests\/(\w+)$/.exec(path);
    if (m) {
      const t = transports[m[1]];
      if (!t) {
        res.writeHead(404, { 'content-type': 'application/xml' });
        res.end(`<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework"><type id="ExceptionResourceNotFound"/><localizedMessage lang="EN">Request ${esc(m[1])} does not exist</localizedMessage></exc:exception>`);
        return;
      }
      const objs = t.objects.map(([pgmid, type, name]) => `<tm:abap_object tm:pgmid="${pgmid}" tm:type="${type}" tm:name="${esc(name)}" tm:wbtype="${type}" tm:obj_info="${type}"${type === 'TABU' ? ` tm:obj_desc="Customizing table contents"` : ''}>${type === 'TABU' ? '<tm:key tm:tabkey="100CR" tm:table="TVAK" tm:action="D"/>' : ''}</tm:abap_object>`).join('');
      res.writeHead(200, { 'content-type': 'application/vnd.sap.adt.transportorganizer.v1+xml' });
      res.end(`<?xml version="1.0" encoding="utf-8"?><tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${m[1]}" tm:object_type="K"><tm:request tm:number="${m[1]}" tm:owner="${t.owner}" tm:desc="${esc(t.desc)}" tm:status="R" tm:status_text="Released" tm:target="QAS" tm:type="Workbench"><tm:task tm:number="${m[1].replace(/\d$/, (d) => String((Number(d) + 1) % 10))}" tm:owner="${t.owner}" tm:status="R">${objs}</tm:task><tm:all_objects>${objs}</tm:all_objects></tm:request></tm:root>`);
      return;
    }
    m = /^\/sap\/bc\/adt\/ddic\/dataelements\/(\w+)$/.exec(path);
    if (m && dataElements[m[1].toUpperCase()]) {
      const [s, md, l, h] = dataElements[m[1].toUpperCase()];
      res.writeHead(200, { 'content-type': 'application/vnd.sap.adt.dataelements.v2+xml' });
      res.end(`<?xml version="1.0" encoding="utf-8"?><blue:wbobj xmlns:blue="http://www.sap.com/wbobj/dictionary/dtel" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${m[1].toUpperCase()}" adtcore:type="DTEL/DE"><dtel:dataElement xmlns:dtel="http://www.sap.com/adt/dictionary/dataelements"><dtel:shortFieldLabel>${esc(s)}</dtel:shortFieldLabel><dtel:mediumFieldLabel>${esc(md)}</dtel:mediumFieldLabel><dtel:longFieldLabel>${esc(l)}</dtel:longFieldLabel><dtel:headingFieldLabel>${esc(h)}</dtel:headingFieldLabel></dtel:dataElement></blue:wbobj>`);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  // ---------------------------------------------------------------- logon + launchpad
  const FLP = '/sap/bc/ui5_ui5/ui2/ushell/shells/abap/FioriLaunchpad.html';
  const logonPage = (error?: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Logon</title></head><body class="sapUiBody">
<form id="LOGIN_FORM" method="post" action="${FLP}?sap-client=${sapClient}"><div class="sapMTitle"><h1>Log On to SAP</h1></div>
${error ? `<div id="LOGON_MESSAGE" class="sapMMessageStrip sapMMsgStripError" role="alert">${esc(error)}</div>` : ''}
<label for="USERNAME_FIELD-inner" class="sapMLabel"><bdi>User</bdi></label><input id="USERNAME_FIELD-inner" name="sap-user" class="sapMInputBaseInner">
<label for="PASSWORD_FIELD-inner" class="sapMLabel"><bdi>Password</bdi></label><input id="PASSWORD_FIELD-inner" name="sap-password" type="password" class="sapMInputBaseInner">
<input type="hidden" name="sap-client" value="${sapClient}"><button id="LOGIN_LINK" type="submit" class="sapMBtn"><bdi>Log On</bdi></button></form></body></html>`;

  const shell = (role: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Home</title>
<style>.sapUshellTile{display:inline-block;width:176px;height:176px;margin:8px;border:1px solid #ccc;cursor:pointer}.sapMDialog,.sapMPopover{position:fixed;top:60px;left:20%;background:#fff;border:1px solid #888;padding:8px;z-index:10}
.sapMMessageToast{position:fixed;bottom:40px;left:40%;background:#333;color:#fff;padding:8px}.sapMListTblRow{cursor:pointer}.sapMLabelRequired bdi:after{content:" *";color:red}.sapUxAPObjectPageFloatingFooter{position:sticky;bottom:0;background:#eee}
.sapMInputBaseIcon{display:inline-block;width:22px;height:22px;cursor:pointer;vertical-align:middle;background:#ddd}.sapMInputBaseContentWrapper{display:inline-flex;align-items:center}</style></head>
<body class="sapUiBody sapUShellFullHeight" role="application"><div id="shell-header" class="sapUshellShellHead"><span id="shellAppTitle" class="sapUshellAppTitle"><bdi>Home</bdi></span><span class="sapUshellShellHeadUser" id="meAreaHeaderButton">${esc(users[role as keyof typeof users].username)}</span></div>
<div id="viewPortContainer" class="sapUshellViewPortCenter"><div id="application-container" class="sapUShellApplicationContainer"></div></div>
<script>window.__FLP_CONFIG=${JSON.stringify({ tiles: catalog[role] ?? [], system, services: Object.fromEntries(svc.map((s) => [s.name, { path: s.path, version: s.version }])) }).replace(/</g, '\\u003c')};</script>
<script>${LAUNCHPAD_JS}</script></body></html>`;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    (async () => {
      const path = url.pathname;
      const s = svc.find((x) => path === x.path || path.startsWith(x.path + '/'));
      if (s) return odata(req, res, url, s, path.slice(s.path.length));
      if (path.startsWith('/sap/bc/adt/')) return adt(req, res, path);
      if (path === FLP) {
        if (req.method === 'POST') {
          const p = new URLSearchParams(await readBody(req));
          const r = roleOf(p.get('sap-user') ?? '');
          if (!r || users[r].password !== p.get('sap-password') || r === 'integration') {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(logonPage(r === 'integration' ? 'User COMM_EZTEST is a communication user and cannot log on to the launchpad' : 'Name or password is incorrect (repeat logon)'));
            return;
          }
          const sid = randomBytes(16).toString('hex');
          sessions.set(sid, r);
          res.writeHead(302, { location: `${FLP}?sap-client=${sapClient}#Shell-home`, 'set-cookie': `SAP_SESSIONID_EZ1_${sapClient}=${sid}; Path=/; HttpOnly; SameSite=Lax` });
          res.end();
          return;
        }
        const r = authUser(req);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(r ? shell(r) : logonPage());
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    })().catch((e: unknown) => {
      if (e instanceof ODataError) {
        const isV4 = svc.find((x) => url.pathname.startsWith(x.path))?.version === 4;
        return sendJson(res, e.status, isV4
          ? { error: { code: e.code, message: e.message, target: e.details[0]?.target, details: e.details.map((d) => ({ code: d.code, message: d.message, target: d.target })) } }
          : { error: { code: e.code, message: { lang: 'en', value: e.message }, innererror: { errordetails: e.details } } });
      }
      sendJson(res, 500, { error: { code: 'SY/500', message: { lang: 'en', value: (e as Error).message } } });
    });
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`, client: sapClient, system, users, data, stats,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startSapMock({ port: Number(process.env.PORT ?? 8096), system: (process.env.SAP_SYSTEM as SapSystem) ?? 'QAS' });
  console.log(`SAP mock (${s.system}) on ${s.url}/sap/bc/ui5_ui5/ui2/ushell/shells/abap/FioriLaunchpad.html`);
  for (const [r, u] of Object.entries(s.users)) console.log(`  ${r}: ${u.username} / ${u.password}`);
}
