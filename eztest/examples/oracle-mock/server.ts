/**
 * An Oracle Fusion Cloud + E-Business Suite emulation for EZTest's Oracle
 * pack, built from Oracle's public documentation of Redwood (Oracle JET
 * core-pack components), OA Framework pages and the Fusion REST API. It is
 * NOT Oracle: the pack is tested against this mock, not a real pod.
 *
 *  - Fusion sign-in (#userid / #password / #btnActive), a Redwood home with
 *    the Navigator, the Redwood "Create Purchase Order" page with
 *    oj-c-select-single LOVs (type-ahead, filtered results), oj-c-input-text,
 *    oj-c-input-number, oj-c-input-date-text, required indicators, inline
 *    validation messages, an editable lines table (oj-c-table) and a toast;
 *    the purchase order page and the "Manage Purchase Orders" table.
 *  - Fusion REST (/fscmRestApi/resources/11.13.18.05/purchaseOrders):
 *    q= filters, fields=, onlyData, limit, items/count/hasMore, describe
 *    (attributes with title/type/mandatory/updatable), procurementBUsLOV;
 *    /hcmRestApi/.../userAccounts with userAccountRoles. Basic auth.
 *  - EBS OA Framework (/OA_HTML): AppsLocalLogin.jsp, the Navigator with
 *    responsibilities, an iProcurement non-catalog request page (x8 labels,
 *    required markers, poplists, a modal "Search and Select" LOV in an
 *    iframe, OraMessageBox errors and confirmations).
 *  - update '25C' (current) or '25D' (quarterly update applied on a test
 *    pod): Buyer is relabeled Procurement Agent, Requisitioning BU becomes
 *    mandatory, the "US1 Business Unit (Legacy)" BU is retired.
 *
 * Run standalone: `npx tsx examples/oracle-mock/server.ts`.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export type OracleUpdate = '25C' | '25D';
type Po = { OrderNumber: string; POHeaderId: number; ProcurementBU: string; RequisitioningBU: string; Supplier: string; SupplierSite: string; Buyer: string; Description: string; Status: string; Total: number; lines: Array<{ LineNumber: number; Item: string; Quantity: number; Price: number }> };

export interface OracleMockServer {
  url: string;
  update: OracleUpdate;
  users: Record<'buyer' | 'requester' | 'viewer' | 'integration', { username: string; password: string }>;
  orders: Po[];
  requisitions: Array<{ number: string; description: string; category: string; quantity: number; uom: string; price: number; requester: string }>;
  stats: { rest: string[] };
  close(): Promise<void>;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
async function body(req: IncomingMessage): Promise<string> {
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
const send = (res: ServerResponse, status: number, text: string, type = 'text/html; charset=utf-8', h: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': type, ...h });
  res.end(text);
};
const json = (res: ServerResponse, status: number, b: unknown) => send(res, status, JSON.stringify(b), 'application/vnd.oracle.adf.resourcecollection+json');

export async function startOracleMock(o: { update?: OracleUpdate; port?: number } = {}): Promise<OracleMockServer> {
  const update = o.update ?? '25C';
  const d = update === '25D';
  const pw = (p: string) => `${p}-${randomBytes(6).toString('hex')}`;
  const users = {
    buyer: { username: 'CASEY.BROWN', password: pw('Buy') },
    requester: { username: 'PAT.STOCK', password: pw('Req') },
    viewer: { username: 'JORDAN.LEE', password: pw('Vw') },
    integration: { username: 'EZTEST.INTEGRATION', password: pw('Int') },
  };
  const ROLES: Record<string, string[]> = {
    buyer: ['Buyer', 'Procurement Requester', 'Employee'], requester: ['Procurement Requester', 'Employee'], viewer: ['Employee'], integration: ['Integration Specialist', 'Buyer'],
  };
  const roleOf = (u: string) => (Object.entries(users).find(([, x]) => x.username === u.toUpperCase())?.[0] ?? '') as keyof typeof users | '';
  const BUS = d ? ['US1 Business Unit', 'UK Business Unit'] : ['US1 Business Unit', 'UK Business Unit', 'US1 Business Unit (Legacy)'];
  const SUPPLIERS: Record<string, string[]> = { 'Lee Supplies': ['Lee US1', 'Lee Dallas'], 'Advanced Corp': ['Advanced HQ'], 'Lee Industrial Parts': ['Main'] };
  const ITEMS = ['AS54888 Standard Desktop', 'AS92888 Laptop 15"', 'CM96713 Ergonomic Chair'];
  const orders: Po[] = [
    { OrderNumber: '1001', POHeaderId: 300100, ProcurementBU: 'US1 Business Unit', RequisitioningBU: 'US1 Business Unit', Supplier: 'Lee Supplies', SupplierSite: 'Lee US1', Buyer: 'Casey Brown', Description: 'Desktops for Austin office', Status: 'Open', Total: 2400, lines: [{ LineNumber: 1, Item: 'AS54888 Standard Desktop', Quantity: 2, Price: 1200 }] },
  ];
  const requisitions: OracleMockServer['requisitions'] = [];
  let nextPo = 1002;
  let nextReq = 14523;
  const stats = { rest: [] as string[] };
  const sessions = new Map<string, keyof typeof users>();
  const ebsSessions = new Map<string, keyof typeof users>();
  const buyerLabel = d ? 'Procurement Agent' : 'Buyer';

  // ---------------------------------------------------------------- Fusion UI (Redwood)
  const fusionShell = (title: string, inner: string, role: string, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} - Oracle Fusion Cloud Applications</title>
<style>.oj-listbox-drop{position:absolute;background:#fff;border:1px solid #888;z-index:5}.oj-listbox-result{cursor:pointer;padding:2px 6px}.oj-message-error{color:#b00}.oj-c-message-toast{position:fixed;bottom:20px;right:20px;background:#333;color:#fff;padding:8px}
.oj-button-button{cursor:pointer}</style></head><body class="oj-sp-body"><header class="oj-sp-global-header"><span class="oj-sp-product-name">Oracle Fusion Cloud</span>
<oj-c-button id="navigator" label="Navigator"><button class="oj-button-button" aria-label="Navigator" onclick="document.getElementById('navMenu').hidden=!document.getElementById('navMenu').hidden"><span class="oj-button-text">Navigator</span></button></oj-c-button>
<nav id="navMenu" class="oj-navigationlist" hidden><ul>${(role === 'buyer' ? [['Purchase Orders', '/fscmUI/redwood/purchase-orders'], ['Create Purchase Order', '/fscmUI/redwood/purchase-orders/create']] : []).concat(role === 'requester' || role === 'buyer' ? [['Requisitions', '/fscmUI/redwood/requisitions']] : []).concat([['Me', '/fscmUI/redwood/me']]).map(([l, h]) => `<li class="oj-navigationlist-item"><a class="oj-navigationlist-item-label" href="${h}">${esc(l)}</a></li>`).join('')}</ul></nav>
<span class="oj-sp-user-name" id="userName">${esc(users[role as keyof typeof users].username)}</span></header>
<main class="oj-sp-main"><h1 class="oj-sp-header-general-overview-title oj-typography-heading-md" id="pageTitle">${esc(title)}</h1>${inner}</main>
<div id="toasts" class="oj-c-message-toast-container"></div><script>${script}</script></body></html>`;

  const ojField = (kind: string, id: string, label: string, o2: { required?: boolean; value?: string; options?: string[]; readonly?: boolean } = {}) => {
    const req = o2.required ? '<span class="oj-label-required-icon oj-component-icon" role="img" title="Required" aria-label="Required"></span>' : '';
    const input = kind === 'oj-c-select-single'
      ? `<input id="${id}|input" class="oj-text-field-input oj-select-single-input" role="combobox" aria-expanded="false" autocomplete="off" aria-label="${esc(label)}" value="${esc(o2.value ?? '')}"${o2.readonly ? ' readonly' : ''}><span class="oj-select-single-dropdown-arrow oj-component-icon" role="presentation" style="display:inline-block;width:14px;height:14px;background:#ccc"></span>`
      : `<input id="${id}|input" class="oj-text-field-input${kind === 'oj-c-input-number' ? ' oj-inputnumber-input' : ''}" aria-label="${esc(label)}" value="${esc(o2.value ?? '')}"${kind === 'oj-c-input-date-text' ? ' placeholder="m/d/yy"' : ''}${o2.readonly ? ' readonly' : ''}>`;
    return `<${kind} id="${id}" label-hint="${esc(label)}"${o2.required ? ' required' : ''}${o2.readonly ? ' readonly' : ''} data-options="${esc(JSON.stringify(o2.options ?? []))}" class="oj-form-control"><div class="oj-text-field oj-form-control-container"><div class="oj-text-field-label-inside"><label for="${id}|input" class="oj-label oj-label-inside">${req}<span class="oj-label-group">${esc(label)}</span></label></div>${input}</div><div class="oj-text-field-messages" id="${id}|messages"></div></${kind}>`;
  };

  const REDWOOD_JS = `
function opts(el){return JSON.parse(el.dataset.options||'[]')}
function closeDrops(){document.querySelectorAll('.oj-listbox-drop').forEach(function(x){x.remove()})}
function wireSelect(el){var input=el.querySelector('input');function show(){closeDrops();var q=input.value.toLowerCase();var hit=opts(el).filter(function(o){return !q||o.toLowerCase().indexOf(q)>=0});
 var d=document.createElement('div');d.className='oj-listbox-drop';d.id=el.id+'_drop';d.setAttribute('role','listbox');d.innerHTML='<ul class="oj-listbox-results">'+(hit.length?hit.map(function(o){return '<li class="oj-listbox-result" role="option"><div class="oj-listbox-result-label">'+o.replace(/</g,'&lt;')+'</div></li>'}).join(''):'<li class="oj-listbox-no-results">No results found</li>')+'</ul>';
 el.appendChild(d);input.setAttribute('aria-expanded','true');d.querySelectorAll('.oj-listbox-result').forEach(function(li){li.addEventListener('mousedown',function(e){e.preventDefault();input.value=li.textContent;el.dataset.value=li.textContent;closeDrops();input.setAttribute('aria-expanded','false');el.dispatchEvent(new CustomEvent('valueChanged',{bubbles:true}));});});}
 input.addEventListener('input',function(){el.dataset.value='';show();});el.querySelector('.oj-select-single-dropdown-arrow').addEventListener('click',show);input.addEventListener('blur',function(){setTimeout(function(){var my=document.getElementById(el.id+'_drop');if(my&&document.activeElement!==input)my.remove();},150)});}
document.querySelectorAll('oj-c-select-single').forEach(wireSelect);
function val(el){var i=el.querySelector('input');return el.tagName==='OJ-C-SELECT-SINGLE'?(el.dataset.value||''):i.value.trim()}
function msg(el,t){var m=el.querySelector('.oj-text-field-messages');m.innerHTML=t?'<div class="oj-message oj-message-error" role="alert"><span class="oj-message-summary">'+t+'</span></div>':'';el.classList.toggle('oj-invalid',!!t)}
function toast(t,sev){var c=document.getElementById('toasts');var d=document.createElement('div');d.className='oj-c-message-toast oj-message-'+(sev||'confirmation');d.setAttribute('role','alert');d.innerHTML='<span class="oj-message-summary">'+t+'</span>';c.appendChild(d);setTimeout(function(){d.remove()},4000)}`;

  function createPoPage(role: string): string {
    const lines = `<oj-c-table id="linesTable" aria-label="Lines" class="oj-table"><div class="oj-table-toolbar"><oj-c-button id="addLine" label="Add Line"><button class="oj-button-button" type="button"><span class="oj-button-text">Add Line</span></button></oj-c-button></div>
<table class="oj-table-element" role="grid" aria-label="Lines"><thead><tr><th class="oj-table-column-header-cell">Line</th><th class="oj-table-column-header-cell">Item</th><th class="oj-table-column-header-cell">Quantity</th><th class="oj-table-column-header-cell">Price</th></tr></thead><tbody></tbody></table></oj-c-table>`;
    const fields = [
      ojField('oj-c-select-single', 'procurementBU', 'Procurement BU', { required: true, options: BUS }),
      ojField('oj-c-select-single', 'requisitioningBU', 'Requisitioning BU', { required: d, options: BUS }),
      ojField('oj-c-select-single', 'supplier', 'Supplier', { required: true, options: Object.keys(SUPPLIERS) }),
      ojField('oj-c-select-single', 'supplierSite', 'Supplier Site', { required: true, options: [] }),
      ojField('oj-c-input-text', 'buyer', buyerLabel, { value: 'Casey Brown', readonly: true }),
      ojField('oj-c-input-text', 'description', 'Description'),
      ojField('oj-c-input-date-text', 'requiredDate', 'Required Date'),
    ].join('');
    const js = REDWOOD_JS + `
var SITES=${JSON.stringify(SUPPLIERS)};var ITEMS=${JSON.stringify(ITEMS)};
document.getElementById('supplier').addEventListener('valueChanged',function(){var s=document.getElementById('supplierSite');s.dataset.options=JSON.stringify(SITES[this.dataset.value]||[]);s.dataset.value='';s.querySelector('input').value='';});
var n=0;document.querySelector('#addLine button').addEventListener('click',function(){n++;var tr=document.createElement('tr');tr.className='oj-table-body-row';tr.dataset.line=n;
 tr.innerHTML='<td class="oj-table-data-cell">'+n+'</td><td class="oj-table-data-cell"><oj-c-select-single id="item'+n+'" label-hint="Item" data-options=\\''+JSON.stringify(ITEMS).replace(/'/g,'&#39;')+'\\'><div class="oj-text-field"><input id="item'+n+'|input" class="oj-text-field-input" role="combobox" aria-label="Item" autocomplete="off"><span class="oj-select-single-dropdown-arrow" style="display:inline-block;width:14px;height:14px;background:#ccc"></span></div><div class="oj-text-field-messages"></div></oj-c-select-single></td>'+
 '<td class="oj-table-data-cell"><oj-c-input-number id="qty'+n+'" label-hint="Quantity"><div class="oj-text-field"><input id="qty'+n+'|input" class="oj-text-field-input" aria-label="Quantity"></div><div class="oj-text-field-messages"></div></oj-c-input-number></td>'+
 '<td class="oj-table-data-cell"><oj-c-input-number id="price'+n+'" label-hint="Price"><div class="oj-text-field"><input id="price'+n+'|input" class="oj-text-field-input" aria-label="Price"></div><div class="oj-text-field-messages"></div></oj-c-input-number></td>';
 document.querySelector('#linesTable tbody').appendChild(tr);wireSelect(tr.querySelector('oj-c-select-single'));});
document.querySelector('#submit button').addEventListener('click',function(){var bad=false;
 document.querySelectorAll('#poForm [required]').forEach(function(el){if(!val(el)){msg(el,'Enter a value.');bad=true}else msg(el,'')});
 var lines=[].map.call(document.querySelectorAll('#linesTable tbody tr'),function(tr){return {Item:val(tr.querySelector('[label-hint=Item]')),Quantity:Number(val(tr.querySelector('[label-hint=Quantity]'))),Price:Number(val(tr.querySelector('[label-hint=Price]')))}});
 if(!lines.length){toast('Add at least one line before you submit.','error');bad=true}
 if(bad)return;var p={};document.querySelectorAll('#poForm .oj-form-control').forEach(function(el){p[el.id]=val(el)});p.lines=lines;
 document.getElementById('submit').setAttribute('disabled','');
 fetch('/fscmUI/redwood/purchase-orders/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p),credentials:'same-origin'}).then(function(r){return r.json().then(function(j){
  document.getElementById('submit').removeAttribute('disabled');
  if(!r.ok){(j.errors||[]).forEach(function(e){if(e.field){var el=document.getElementById(e.field);if(el)msg(el,e.message)}});document.getElementById('pageMessages').innerHTML='<oj-c-message-banner class="oj-message-banner-error" role="alert">'+(j.errors||[]).map(function(e){return '<div class="oj-message-banner-summary">'+e.message+'</div>'}).join('')+'</oj-c-message-banner>';return;}
  sessionStorage.setItem('toast','Purchase order '+j.OrderNumber+' submitted.');location.href='/fscmUI/redwood/purchase-orders/'+j.OrderNumber;});});});`;
    return fusionShell('Create Purchase Order', `<div id="pageMessages"></div><form id="poForm" class="oj-form" onsubmit="return false">${fields}</form>${lines}
<div class="oj-sp-header-actions"><oj-c-button id="submit" label="Submit"><button class="oj-button-button" type="button"><span class="oj-button-text">Submit</span></button></oj-c-button>
<oj-c-button id="cancel" label="Cancel"><button class="oj-button-button" type="button" onclick="location.href='/fscmUI/redwood/purchase-orders'"><span class="oj-button-text">Cancel</span></button></oj-c-button></div>`, role, js);
  }

  function poPage(role: string, po: Po): string {
    const f = (id: string, label: string, v: string) => `<oj-c-input-text id="${id}" label-hint="${esc(label)}" readonly class="oj-form-control"><div class="oj-text-field"><label class="oj-label"><span class="oj-label-group">${esc(label)}</span></label><span class="oj-text-field-readonly" id="${id}|readonly">${esc(v)}</span></div></oj-c-input-text>`;
    return fusionShell(`Purchase Order ${po.OrderNumber}`, `<div class="oj-sp-badge" id="status">${esc(po.Status)}</div><form class="oj-form">${f('procurementBU', 'Procurement BU', po.ProcurementBU)}${f('supplier', 'Supplier', po.Supplier)}${f('supplierSite', 'Supplier Site', po.SupplierSite)}${f('buyer', buyerLabel, po.Buyer)}${f('description', 'Description', po.Description)}${f('total', 'Total', po.Total.toFixed(2) + ' USD')}</form>
<oj-c-table id="linesTable" aria-label="Lines"><table class="oj-table-element" role="grid" aria-label="Lines"><thead><tr><th class="oj-table-column-header-cell">Line</th><th class="oj-table-column-header-cell">Item</th><th class="oj-table-column-header-cell">Quantity</th><th class="oj-table-column-header-cell">Price</th></tr></thead><tbody>${po.lines.map((l) => `<tr class="oj-table-body-row"><td class="oj-table-data-cell">${l.LineNumber}</td><td class="oj-table-data-cell">${esc(l.Item)}</td><td class="oj-table-data-cell">${l.Quantity}</td><td class="oj-table-data-cell">${l.Price.toFixed(2)}</td></tr>`).join('')}</tbody></table></oj-c-table>`, role,
      REDWOOD_JS + "var t=sessionStorage.getItem('toast');if(t){sessionStorage.removeItem('toast');toast(t);}");
  }

  function listPage(role: string): string {
    return fusionShell('Purchase Orders', `<oj-c-table id="ordersTable" aria-label="Purchase Orders"><table class="oj-table-element" role="grid" aria-label="Purchase Orders"><thead><tr><th class="oj-table-column-header-cell">Order</th><th class="oj-table-column-header-cell">Supplier</th><th class="oj-table-column-header-cell">Description</th><th class="oj-table-column-header-cell">Status</th><th class="oj-table-column-header-cell">Total</th></tr></thead>
<tbody>${orders.map((p) => `<tr class="oj-table-body-row"><td class="oj-table-data-cell"><a href="/fscmUI/redwood/purchase-orders/${p.OrderNumber}">${p.OrderNumber}</a></td><td class="oj-table-data-cell">${esc(p.Supplier)}</td><td class="oj-table-data-cell">${esc(p.Description)}</td><td class="oj-table-data-cell">${esc(p.Status)}</td><td class="oj-table-data-cell">${p.Total.toFixed(2)}</td></tr>`).join('')}</tbody></table></oj-c-table>`, role);
  }

  async function fusion(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const p = url.pathname;
    if (p === '/oam/server/login') {
      if (req.method === 'POST') {
        const f = new URLSearchParams(await body(req));
        const r = roleOf(f.get('userid') ?? '');
        if (!r || users[r].password !== f.get('password')) return send(res, 200, fusionLogin('Your account is locked or the user name and password are incorrect.'));
        const sid = randomBytes(16).toString('hex');
        sessions.set(sid, r);
        return send(res, 302, '', 'text/plain', { location: '/fscmUI/redwood/home', 'set-cookie': `ORA_FND_SESSION=${sid}; Path=/; HttpOnly; SameSite=Lax` });
      }
      return send(res, 200, fusionLogin());
    }
    const role = sessions.get(cookies(req).ORA_FND_SESSION ?? '');
    if (!role) return send(res, 302, '', 'text/plain', { location: '/oam/server/login' });
    if (p === '/fscmUI/redwood/home') return send(res, 200, fusionShell('Good morning', '<section class="oj-sp-welcome-page" id="welcome"><p>Things to Finish</p></section>', role));
    const needBuyer = p.startsWith('/fscmUI/redwood/purchase-orders');
    if (needBuyer && !ROLES[role].includes('Buyer')) return send(res, 403, fusionShell('Access Denied', '<oj-c-message-banner class="oj-message-banner-error" role="alert"><div class="oj-message-banner-summary">You don\'t have access to this page.</div></oj-c-message-banner>', role));
    if (p === '/fscmUI/redwood/purchase-orders') return send(res, 200, listPage(role));
    if (p === '/fscmUI/redwood/purchase-orders/create') return send(res, 200, createPoPage(role));
    if (p === '/fscmUI/redwood/purchase-orders/submit' && req.method === 'POST') {
      const b = JSON.parse(await body(req)) as Record<string, unknown> & { lines: Array<{ Item: string; Quantity: number; Price: number }> };
      const errors: Array<{ field?: string; message: string }> = [];
      if (!BUS.includes(String(b.procurementBU))) errors.push({ field: 'procurementBU', message: `The value ${String(b.procurementBU)} isn't valid for Procurement BU.` });
      if (d && !b.requisitioningBU) errors.push({ field: 'requisitioningBU', message: 'Enter a value.' });
      if (!SUPPLIERS[String(b.supplier)]?.includes(String(b.supplierSite))) errors.push({ field: 'supplierSite', message: 'The supplier site must belong to the supplier.' });
      b.lines.forEach((l, i) => {
        if (!(l.Quantity > 0)) errors.push({ message: `Line ${i + 1}: The quantity must be greater than zero.` });
        if (!ITEMS.includes(l.Item)) errors.push({ message: `Line ${i + 1}: Enter a valid item.` });
      });
      if (errors.length) return send(res, 400, JSON.stringify({ errors }), 'application/json');
      const po: Po = {
        OrderNumber: String(nextPo++), POHeaderId: 300100 + nextPo, ProcurementBU: String(b.procurementBU), RequisitioningBU: String(b.requisitioningBU || b.procurementBU), Supplier: String(b.supplier), SupplierSite: String(b.supplierSite),
        Buyer: 'Casey Brown', Description: String(b.description ?? ''), Status: 'Pending Approval', Total: b.lines.reduce((s, l) => s + l.Quantity * l.Price, 0), lines: b.lines.map((l, i) => ({ LineNumber: i + 1, ...l })),
      };
      orders.push(po);
      return send(res, 201, JSON.stringify({ OrderNumber: po.OrderNumber }), 'application/json');
    }
    const m = /^\/fscmUI\/redwood\/purchase-orders\/(\d+)$/.exec(p);
    if (m) {
      const po = orders.find((x) => x.OrderNumber === m[1]);
      return po ? send(res, 200, poPage(role, po)) : send(res, 404, fusionShell('Not Found', '<p role="alert">Not found</p>', role));
    }
    return send(res, 200, fusionShell(p.split('/').pop() ?? 'Page', '<p>Empty</p>', role));
  }
  const fusionLogin = (error?: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Sign In</title></head><body><form method="post" action="/oam/server/login" id="signin">
${error ? `<div class="message-error" id="loginErrorMessage" role="alert">${esc(error)}</div>` : ''}<label for="userid">User ID</label><input id="userid" name="userid"><label for="password">Password</label><input id="password" name="password" type="password">
<button id="btnActive" type="submit">Sign In</button></form></body></html>`;

  // ---------------------------------------------------------------- Fusion REST
  const PO_ATTRS = () => [
    { name: 'POHeaderId', type: 'integer', title: 'Purchase Order Header ID', mandatory: false, updatable: false, queryable: true },
    { name: 'OrderNumber', type: 'string', title: 'Order', mandatory: false, updatable: false, queryable: true, maxLength: '30' },
    { name: 'ProcurementBU', type: 'string', title: 'Procurement BU', mandatory: true, updatable: false, queryable: true, lov: { childRef: 'procurementBUsLOV' } },
    { name: 'RequisitioningBU', type: 'string', title: 'Requisitioning BU', mandatory: d, updatable: true, queryable: true, lov: { childRef: 'procurementBUsLOV' } },
    { name: 'Supplier', type: 'string', title: 'Supplier', mandatory: true, updatable: true, queryable: true },
    { name: 'SupplierSite', type: 'string', title: 'Supplier Site', mandatory: true, updatable: true, queryable: true },
    { name: 'Buyer', type: 'string', title: buyerLabel, mandatory: false, updatable: true, queryable: true },
    { name: 'Description', type: 'string', title: 'Description', mandatory: false, updatable: true, queryable: true, maxLength: '240' },
    { name: 'Status', type: 'string', title: 'Status', mandatory: false, updatable: false, queryable: true },
    { name: 'Total', type: 'number', title: 'Total', mandatory: false, updatable: false, queryable: true },
  ];
  const basic = (req: IncomingMessage): keyof typeof users | '' => {
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Basic ')) return '';
    const [u, ...pp] = Buffer.from(h.slice(6), 'base64').toString().split(':');
    const r = roleOf(u);
    return r && users[r].password === pp.join(':') ? r : '';
  };
  function parseQ(q: string): Array<(r: Record<string, unknown>) => boolean> {
    return q.split(';').filter(Boolean).map((t) => {
      const m = /^(\w+)\s*(=|>|<|LIKE)\s*(?:'((?:[^']|'')*)'|([\w.-]+))$/i.exec(t.trim());
      if (!m) throw new Error(`The query parameter is invalid: ${t}`);
      const [, k, op, qs, bare] = m;
      const v = (qs ?? bare).replace(/''/g, "'");
      return (r) => {
        const a = String(r[k] ?? '');
        if (op === '=') return a === v;
        if (op.toUpperCase() === 'LIKE') return new RegExp(`^${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'i').test(a);
        return op === '>' ? Number(a) > Number(v) : Number(a) < Number(v);
      };
    });
  }
  function rest(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const who = basic(req);
    if (!who) return send(res, 401, 'Unauthorized', 'text/plain', { 'www-authenticate': 'Basic realm="Oracle"' });
    stats.rest.push(`${url.pathname.replace(/^\/\w+RestApi\/resources\/11\.13\.18\.05\//, '')}${url.search ? decodeURIComponent(url.search) : ''}`);
    const p = url.pathname;
    const coll = (items: Array<Record<string, unknown>>) => {
      let rows = items;
      try {
        if (url.searchParams.get('q')) for (const f of parseQ(url.searchParams.get('q')!)) rows = rows.filter(f);
      } catch (e) {
        return json(res, 400, { title: 'Bad Request', detail: (e as Error).message, 'o:errorCode': '27024' });
      }
      const fields = url.searchParams.get('fields')?.split(',');
      const limit = Number(url.searchParams.get('limit') ?? 25);
      const out = rows.slice(0, limit).map((r) => (fields ? Object.fromEntries(fields.map((f) => [f, r[f]])) : r));
      return json(res, 200, { items: out, count: out.length, hasMore: rows.length > limit, limit, offset: 0 });
    };
    if (p === '/fscmRestApi/resources/11.13.18.05/purchaseOrders/describe') {
      return json(res, 200, { Resources: { purchaseOrders: { discrColumnType: false, title: 'Purchase Orders', titlePlural: 'Purchase Orders', attributes: PO_ATTRS(), collection: { finders: [{ name: 'PrimaryKey' }] } } } });
    }
    if (p === '/fscmRestApi/resources/11.13.18.05/purchaseOrders') {
      if (!ROLES[who].includes('Buyer')) return json(res, 403, { title: 'Forbidden', detail: 'You do not have the necessary privileges to access purchaseOrders.', 'o:errorCode': '403' });
      return coll(orders.map(({ lines: _l, ...rest2 }) => rest2));
    }
    if (p === '/fscmRestApi/resources/11.13.18.05/procurementBUsLOV') return coll(BUS.map((b, i) => ({ BUId: 300000 + i, BUName: b })));
    if (p === '/hcmRestApi/resources/11.13.18.05/userAccounts') {
      if (!ROLES[who].includes('Integration Specialist')) return json(res, 403, { title: 'Forbidden', detail: 'You do not have the necessary privileges to access userAccounts.' });
      const accounts = Object.entries(users).map(([r, u]) => ({ Username: u.username, SuspendedFlag: false, userAccountRoles: ROLES[r].map((n) => ({ RoleCode: `ORA_${n.toUpperCase().replace(/\W+/g, '_')}_JOB`, RoleCommonName: n })) }));
      if (url.searchParams.get('expand') !== 'userAccountRoles') for (const a of accounts) delete (a as Partial<typeof a>).userAccountRoles;
      return coll(accounts);
    }
    return json(res, 404, { title: 'Not Found', detail: `The requested resource ${p} does not exist.` });
  }

  // ---------------------------------------------------------------- EBS OA Framework
  const CATEGORIES = ['OFFICE.SUPPLIES', 'COMPUTER.HARDWARE', 'FURNITURE.CHAIRS', 'TRAVEL.SERVICES'];
  const oaShell = (title: string, inner: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>.OraLovModal{position:fixed;top:40px;left:10%;width:80%;height:420px;background:#fff;border:1px solid #444}</style></head>
<body class="OraBody"><div class="OraGlobalHeader"><a href="/OA_HTML/OA.jsp?OAFunc=OAHOMEPAGE" class="OraGlobalButtonText">Home</a> <a href="/OA_HTML/AppsLogout.jsp">Logout</a></div><h1 class="OraHeader" id="pageTitle">${esc(title)}</h1>${inner}</body></html>`;
  const oaRow = (id: string, label: string, ctrl: string, required = false) => `<tr><td class="x8" align="right" nowrap>${required ? '<span title="Required" class="x6">*</span>' : ''}<label for="${id}">${esc(label)}</label></td><td class="x8"></td><td valign="top" nowrap>${ctrl}</td></tr>`;
  function ebsReqPage(values: Record<string, string> = {}, errors: string[] = []): string {
    return oaShell('Non-Catalog Request', `${errors.length ? `<div class="OraMessageBox OraMessageBoxError" role="alert"><h1 class="OraHeader">Error</h1><ul>${errors.map((e) => `<li class="OraErrorText">${esc(e)}</li>`).join('')}</ul></div>` : ''}
<form method="post" name="DefaultFormName" id="DefaultFormName" action="/OA_HTML/OA.jsp?page=/oracle/apps/icx/por/req/webui/NonCatalogRequestPG"><table class="x1h" role="presentation">
${oaRow('ItemDescription', 'Item Description', `<input id="ItemDescription" name="ItemDescription" class="x4" size="40" value="${esc(values.ItemDescription ?? '')}">`, true)}
${oaRow('Category', 'Category', `<input id="Category" name="Category" class="x4" size="20" value="${esc(values.Category ?? '')}"><a id="CategoryLov" href="#" title="Search: Category" onclick="openLov();return false"><img src="/OA_MEDIA/lovicon_enabled.gif" alt="Search: Category" width="16" height="16" style="display:inline-block;background:#888"></a>`, true)}
${oaRow('Quantity', 'Quantity', `<input id="Quantity" name="Quantity" class="x4" size="8" value="${esc(values.Quantity ?? '')}">`, true)}
${oaRow('UnitOfMeasure', 'Unit of Measure', `<select id="UnitOfMeasure" name="UnitOfMeasure" class="x4">${['', 'Each', 'Box', 'Hour'].map((u) => `<option value="${u}"${values.UnitOfMeasure === u ? ' selected' : ''}>${u}</option>`).join('')}</select>`, true)}
${oaRow('UnitPrice', 'Unit Price', `<input id="UnitPrice" name="UnitPrice" class="x4" size="10" value="${esc(values.UnitPrice ?? '')}">`, true)}
</table><button type="submit" title="Submit" class="x7g" id="SubmitButton">Submit</button> <button type="button" title="Cancel" class="x7g" onclick="location.href='/OA_HTML/OA.jsp?OAFunc=OAHOMEPAGE'">Cancel</button></form>
<div id="lovContainer"></div><script>
function openLov(){var c=document.getElementById('lovContainer');c.innerHTML='<div class="OraLovModal" role="dialog" aria-label="Search and Select: Category"><iframe id="lovFrame" title="Search and Select: Category" src="/OA_HTML/LovWindow.jsp?lov=Category&q='+encodeURIComponent(document.getElementById('Category').value)+'" style="width:100%;height:100%"></iframe></div>';}
window.lovSelect=function(v){document.getElementById('Category').value=v;document.getElementById('lovContainer').innerHTML='';};
</script>`);
  }
  function lovWindow(q: string): string {
    const hits = CATEGORIES.filter((c) => !q || c.toLowerCase().includes(q.toLowerCase().replace(/%/g, '')));
    return `<!doctype html><html><head><meta charset="utf-8"><title>Search and Select: Category</title></head><body class="OraBody"><h1 class="OraHeader">Search and Select: Category</h1>
<form method="get" action="/OA_HTML/LovWindow.jsp"><input type="hidden" name="lov" value="Category"><label for="searchText">Search By Category</label><input id="searchText" name="q" value="${esc(q)}" class="x4"><button type="submit" title="Go" id="lovGo">Go</button></form>
<table class="x1o" role="grid" summary="Results"><thead><tr><th class="x1r">Select</th><th class="x1r">Category</th></tr></thead><tbody>${hits.map((c, i) => `<tr><td><input type="radio" name="lovSel" id="lovSel${i}" value="${esc(c)}" aria-label="Select ${esc(c)}"></td><td class="x1u">${esc(c)}</td></tr>`).join('')}</tbody></table>
<button type="button" title="Select" id="lovSelect" onclick="var r=document.querySelector('input[name=lovSel]:checked');if(r)parent.lovSelect(r.value)">Select</button> <button type="button" title="Cancel" onclick="parent.lovSelect(parent.document.getElementById('Category').value)">Cancel</button></body></html>`;
  }
  async function ebs(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const p = url.pathname;
    if (p === '/OA_HTML/AppsLocalLogin.jsp') {
      if (req.method === 'POST') {
        const f = new URLSearchParams(await body(req));
        const r = roleOf(f.get('usernameField') ?? '');
        if (!r || users[r].password !== f.get('passwordField')) return send(res, 200, ebsLogin('Error: Invalid username or password.'));
        const sid = randomBytes(16).toString('hex');
        ebsSessions.set(sid, r);
        return send(res, 302, '', 'text/plain', { location: '/OA_HTML/OA.jsp?OAFunc=OAHOMEPAGE', 'set-cookie': `EBSDB=${sid}; Path=/OA_HTML; HttpOnly; SameSite=Lax` });
      }
      return send(res, 200, ebsLogin());
    }
    const role = ebsSessions.get(cookies(req).EBSDB ?? '');
    if (!role) return send(res, 302, '', 'text/plain', { location: '/OA_HTML/AppsLocalLogin.jsp' });
    if (p === '/OA_HTML/LovWindow.jsp') return send(res, 200, lovWindow(url.searchParams.get('q') ?? ''));
    const page = url.searchParams.get('page') ?? '';
    if (page === '/oracle/apps/icx/por/req/webui/NonCatalogRequestPG') {
      if (role === 'viewer') return send(res, 200, oaShell('Error', '<div class="OraMessageBox OraMessageBoxError" role="alert"><h1 class="OraHeader">Error</h1><ul><li class="OraErrorText">You have insufficient privileges for the current operation.</li></ul></div>'));
      if (req.method === 'POST') {
        const v = Object.fromEntries(new URLSearchParams(await body(req)));
        const errors: string[] = [];
        for (const [k, l] of [['ItemDescription', 'Item Description'], ['Category', 'Category'], ['Quantity', 'Quantity'], ['UnitOfMeasure', 'Unit of Measure'], ['UnitPrice', 'Unit Price']]) if (!(v[k] ?? '').trim()) errors.push(`Please enter a value for ${l}.`);
        if (v.Category && !CATEGORIES.includes(v.Category)) errors.push(`The value "${v.Category}" for Category is not valid.`);
        if (v.Quantity && !(Number(v.Quantity) > 0)) errors.push('Quantity must be a positive number.');
        if (errors.length) return send(res, 200, ebsReqPage(v, errors));
        const number = String(nextReq++);
        requisitions.push({ number, description: v.ItemDescription, category: v.Category, quantity: Number(v.Quantity), uom: v.UnitOfMeasure, price: Number(v.UnitPrice), requester: users[role].username });
        return send(res, 200, oaShell('Confirmation', `<div class="OraMessageBox OraMessageBoxConfirmation" role="status"><h1 class="OraHeader">Confirmation</h1><div class="OraInstructionText">Requisition ${number} has been submitted for approval.</div></div>`));
      }
      return send(res, 200, ebsReqPage());
    }
    const fns = role === 'viewer' ? [] : [['iProcurement', 'Non-Catalog Request', '/OA_HTML/OA.jsp?page=/oracle/apps/icx/por/req/webui/NonCatalogRequestPG']];
    return send(res, 200, oaShell('Oracle Applications Home Page', `<div id="NavigatorRN" class="x1n" role="navigation"><h2 class="OraHeaderSub">Navigator</h2><ul>${fns.map(([r, f, h]) => `<li class="x3h"><span class="OraNavigatorResp">${esc(r)}</span><ul><li><a class="xd OraLinkText" href="${h}">${esc(f)}</a></li></ul></li>`).join('')}</ul></div>`));
  }
  const ebsLogin = (error?: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Login</title></head><body><form method="post" action="/OA_HTML/AppsLocalLogin.jsp" id="DefaultFormName">
${error ? `<div class="OraMessageBox OraMessageBoxError" role="alert" id="loginError">${esc(error)}</div>` : ''}<label for="usernameField">User Name</label><input id="usernameField" name="usernameField"><label for="passwordField">Password</label><input id="passwordField" name="passwordField" type="password">
<button type="submit" id="ButtonBox" title="Log In">Log In</button></form></body></html>`;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    (async () => {
      if (/^\/(fscm|hcm|crm)RestApi\//.test(url.pathname)) return rest(req, res, url);
      if (url.pathname.startsWith('/OA_HTML/')) return ebs(req, res, url);
      return fusion(req, res, url);
    })().catch((e: unknown) => send(res, 500, String((e as Error).message), 'text/plain'));
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, update, users, orders, requisitions, stats, close: () => new Promise<void>((r) => server.close(() => r())) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startOracleMock({ port: Number(process.env.PORT ?? 8098), update: (process.env.ORACLE_UPDATE as OracleUpdate) ?? '25C' });
  console.log(`Oracle mock (${s.update}) on ${s.url}/oam/server/login and ${s.url}/OA_HTML/AppsLocalLogin.jsp`);
  for (const [r, u] of Object.entries(s.users)) console.log(`  ${r}: ${u.username} / ${u.password}`);
}
