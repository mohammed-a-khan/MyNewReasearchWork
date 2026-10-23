/**
 * A Workday emulation for EZTest's Workday pack, built from Workday's public
 * conventions (data-automation-id attributes, prompts, the segmented date
 * widget, related actions, the business process inbox) and its public APIs.
 * It is NOT Workday: the pack is tested against this mock, not a real tenant.
 *
 *  - UI: login.htmld, home with global search, search results (tasks and
 *    people), the Hire Employee task (prompts with search and options,
 *    date widget with month/day/year sections, text inputs, required
 *    markers, error bar), worker profile with the related actions menu
 *    (Job Change > Change Job), the inbox with Approve / Send Back.
 *  - REST /ccx/api/v1/{tenant}/workers, WQL /ccx/api/wql/v1/{tenant}
 *    (dataSources, fields, data?query=SELECT ... FROM allWorkers WHERE ...),
 *    OAuth refresh_token grant at /ccx/oauth2/{tenant}/token.
 *  - SOAP Human_Resources v42.0 Get_Workers with WS-Security UsernameToken.
 *  - RaaS custom report "Whats_New_in_Workday" (format=json).
 *  - release '2026R1' (production) or '2026R2' (preview tenant): Reason is
 *    relabeled "Hire Reason", Time Type becomes required on Hire Employee,
 *    Employee Type "Contractor" is retired, the WQL field jobProfile is
 *    renamed "Job Profile" -> "Job Profile (Primary)".
 *
 * Run standalone: `npx tsx examples/workday-mock/server.ts`.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export type WorkdayRelease = '2026R1' | '2026R2';
type Worker = { wid: string; employeeId: string; firstName: string; lastName: string; businessTitle: string; hireDate: string; status: 'Active' | 'Pending'; org: string; employeeType: string; jobProfile: string; timeType: string; manager?: string };
type Event = { id: string; type: string; title: string; worker: string; assignee: string; status: 'Awaiting Action' | 'Approved' | 'Sent Back'; initiator: string };

export interface WorkdayMockServer {
  url: string;
  tenant: string;
  release: WorkdayRelease;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  isu: { username: string; password: string };
  users: Record<'hr' | 'manager' | 'employee', { username: string; password: string }>;
  workers: Worker[];
  events: Event[];
  stats: { wql: string[]; soap: number; rest: number };
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
const send = (res: ServerResponse, status: number, text: string, type = 'text/html; charset=utf-8') => {
  res.writeHead(status, { 'content-type': type });
  res.end(text);
};
const json = (res: ServerResponse, status: number, b: unknown) => send(res, status, JSON.stringify(b), 'application/json');

interface TaskField { id: string; label: string; widget: 'text' | 'date' | 'prompt' | 'checkbox'; required: boolean; options?: string[]; maps?: keyof Worker }

export async function startWorkdayMock(o: { release?: WorkdayRelease; port?: number; tenant?: string } = {}): Promise<WorkdayMockServer> {
  const release = o.release ?? '2026R1';
  const r2 = release === '2026R2';
  const tenant = o.tenant ?? 'ezcorp';
  const pw = (p: string) => `${p}-${randomBytes(6).toString('hex')}`;
  const users = { hr: { username: 'bliu', password: pw('Hr') }, manager: { username: 'lmcneil', password: pw('Mgr') }, employee: { username: 'ajones', password: pw('Emp') } };
  const isu = { username: `ISU_EZTest@${tenant}`, password: pw('Isu') };
  const clientId = 'ZWU1ZjI2' + randomBytes(4).toString('hex');
  const clientSecret = pw('wdcs');
  const refreshToken = pw('wdrt');
  const roleOf = (u: string) => (Object.entries(users).find(([, x]) => x.username === u)?.[0] ?? '') as keyof typeof users | '';
  const workers: Worker[] = [
    { wid: '3aa5550b7fe348b98d7b5741afc65534', employeeId: '21001', firstName: 'Logan', lastName: 'McNeil', businessTitle: 'Vice President, Engineering', hireDate: '2015-03-01', status: 'Active', org: 'Engineering', employeeType: 'Regular', jobProfile: 'Vice President', timeType: 'Full time' },
    { wid: '0e44c92412d34b01ace61e80a47aaf6d', employeeId: '21002', firstName: 'Betty', lastName: 'Liu', businessTitle: 'HR Partner', hireDate: '2018-06-11', status: 'Active', org: 'Human Resources', employeeType: 'Regular', jobProfile: 'HR Partner', timeType: 'Full time' },
    { wid: '6dcb8106e8b74b5aabb1fc3ab8ef2b92', employeeId: '21003', firstName: 'Alex', lastName: 'Jones', businessTitle: 'Software Engineer', hireDate: '2022-01-10', status: 'Active', org: 'Engineering', employeeType: 'Regular', jobProfile: 'Software Engineer', timeType: 'Full time', manager: 'lmcneil' },
  ];
  const userWorker: Record<string, string> = { lmcneil: workers[0].wid, bliu: workers[1].wid, ajones: workers[2].wid };
  const events: Event[] = [];
  let nextEmp = 21004;
  const stats = { wql: [] as string[], soap: 0, rest: 0 };
  const sessions = new Map<string, keyof typeof users>();
  const tokens = new Set<string>();
  const name = (w: Worker) => `${w.firstName} ${w.lastName}`;
  const ORGS = ['Engineering (Logan McNeil)', 'Finance (Teresa Serrano)', 'Human Resources (Betty Liu)'];
  const JOBS = ['Software Engineer', 'Senior Software Engineer', 'Accountant', 'HR Partner'];
  const HIRE: TaskField[] = [
    { id: 'supervisoryOrganization', label: 'Supervisory Organization', widget: 'prompt', required: true, options: ORGS, maps: 'org' },
    { id: 'firstName', label: 'First Name', widget: 'text', required: true, maps: 'firstName' },
    { id: 'lastName', label: 'Last Name', widget: 'text', required: true, maps: 'lastName' },
    { id: 'hireDate', label: 'Hire Date', widget: 'date', required: true, maps: 'hireDate' },
    { id: 'reason', label: r2 ? 'Hire Reason' : 'Reason', widget: 'prompt', required: true, options: ['New Position', 'Backfill', 'Conversion'] },
    { id: 'employeeType', label: 'Employee Type', widget: 'prompt', required: true, options: r2 ? ['Regular', 'Fixed Term'] : ['Regular', 'Fixed Term', 'Contractor'], maps: 'employeeType' },
    { id: 'jobProfile', label: 'Job Profile', widget: 'prompt', required: true, options: JOBS, maps: 'jobProfile' },
    ...(r2 ? [{ id: 'timeType', label: 'Time Type', widget: 'prompt' as const, required: true, options: ['Full time', 'Part time'], maps: 'timeType' as const }] : [{ id: 'timeType', label: 'Time Type', widget: 'prompt' as const, required: false, options: ['Full time', 'Part time'], maps: 'timeType' as const }]),
    { id: 'businessTitle', label: 'Business Title', widget: 'text', required: false, maps: 'businessTitle' },
  ];
  const CHANGE_JOB: TaskField[] = [
    { id: 'effectiveDate', label: 'Effective Date', widget: 'date', required: true },
    { id: 'reason', label: 'Reason', widget: 'prompt', required: true, options: ['Promotion', 'Lateral Move', 'Reorganization'] },
    { id: 'jobProfile', label: 'Job Profile', widget: 'prompt', required: false, options: JOBS, maps: 'jobProfile' },
    { id: 'businessTitle', label: 'Business Title', widget: 'text', required: false, maps: 'businessTitle' },
  ];
  const TASKS: Record<string, { title: string; fields: TaskField[]; roles: string[] }> = {
    hire: { title: 'Hire Employee', fields: HIRE, roles: ['hr'] },
    changejob: { title: 'Change Job', fields: CHANGE_JOB, roles: ['hr', 'manager'] },
  };
  const WQL_FIELDS = [
    { alias: 'workdayID', descriptor: 'Workday ID', type: 'Text' },
    { alias: 'employeeID', descriptor: 'Employee ID', type: 'Text' },
    { alias: 'fullName', descriptor: 'Worker', type: 'Text' },
    { alias: 'businessTitle', descriptor: 'Business Title', type: 'Text' },
    { alias: 'hireDate', descriptor: 'Hire Date', type: 'Date' },
    { alias: 'workerStatus', descriptor: 'Worker Status', type: 'Single Instance' },
    { alias: 'supervisoryOrganization', descriptor: 'Supervisory Organization', type: 'Single Instance' },
    { alias: 'employeeType', descriptor: 'Employee Type', type: 'Single Instance' },
    { alias: 'jobProfile', descriptor: r2 ? 'Job Profile (Primary)' : 'Job Profile', type: 'Single Instance' },
    { alias: 'timeType', descriptor: 'Time Type', type: 'Single Instance' },
  ];
  const wqlValue = (w: Worker, alias: string): unknown => {
    switch (alias) {
      case 'workdayID': return w.wid;
      case 'employeeID': return w.employeeId;
      case 'fullName': return name(w);
      case 'businessTitle': return w.businessTitle;
      case 'hireDate': return w.hireDate;
      case 'workerStatus': return { descriptor: w.status, id: w.status.toLowerCase() };
      case 'supervisoryOrganization': return { descriptor: w.org, id: w.org.replace(/\W+/g, '_') };
      case 'employeeType': return { descriptor: w.employeeType, id: w.employeeType.replace(/\W+/g, '_') };
      case 'jobProfile': return { descriptor: w.jobProfile, id: w.jobProfile.replace(/\W+/g, '_') };
      case 'timeType': return { descriptor: w.timeType, id: w.timeType.replace(/\W+/g, '_') };
      default: return undefined;
    }
  };

  // ---------------------------------------------------------------- UI
  const shell = (role: string, title: string, inner: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} - Workday</title>
<style>[data-automation-id="activeListContainer"],[data-automation-id="relatedActionsMenu"]{position:absolute;background:#fff;border:1px solid #888;z-index:5}[data-automation-id="promptOption"],[data-automation-id="relatedActionsItem"],[data-automation-id="relatedActionsItemLabel"]{cursor:pointer;padding:2px 6px}
[data-automation-id="relatedActionsButton"],[data-automation-id="promptIcon"],[data-automation-id="dateIcon"]{display:inline-block;width:18px;height:18px;background:#999;cursor:pointer}[data-automation-id="errorWidgetBarCanvas"]{background:#fdd}</style></head>
<body><header data-automation-id="globalNavigation"><a href="/${tenant}/d/home.htmld" data-automation-id="workdayLogo">workday.</a>
<form action="/${tenant}/d/search.htmld" method="get" data-automation-id="globalSearchForm"><input data-automation-id="globalSearchInput" name="q" aria-label="Search Workday"></form>
<a href="/${tenant}/d/inbox.htmld" data-automation-id="inboxButton" aria-label="My Tasks">Inbox (${events.filter((e) => e.assignee === role && e.status === 'Awaiting Action').length})</a>
<span data-automation-id="currentUser">${esc(users[role as keyof typeof users]?.username)}</span></header>
<main data-automation-id="pageContent"><h2 data-automation-id="pageHeaderTitleText">${esc(title)}</h2>${inner}</main></body></html>`;

  const PROMPT_JS = `
document.querySelectorAll('[data-automation-id="multiselectInputContainer"]').forEach(function(c){
 var input=c.querySelector('[data-automation-id="searchBox"]');var hidden=c.querySelector('input[type=hidden]');var opts=JSON.parse(c.dataset.options);
 function close(){var p=document.getElementById('prompt-'+hidden.name);if(p)p.remove();}
 function show(q){close();var hit=opts.filter(function(o){return !q||o.toLowerCase().indexOf(q.toLowerCase())>=0});var p=document.createElement('div');p.id='prompt-'+hidden.name;p.setAttribute('data-automation-id','activeListContainer');p.setAttribute('role','listbox');
  p.innerHTML=hit.length?hit.map(function(o){return '<div data-automation-id="promptOption" role="option" data-automation-label="'+o.replace(/"/g,'&quot;')+'">'+o.replace(/</g,'&lt;')+'</div>'}).join(''):'<div data-automation-id="promptNoResults">No matches found</div>';
  c.appendChild(p);p.querySelectorAll('[data-automation-id="promptOption"]').forEach(function(el){el.addEventListener('click',function(){hidden.value=el.dataset.automationLabel;input.value='';close();
   var s=c.querySelector('[data-automation-id="selectedItemList"]');s.innerHTML='<div data-automation-id="selectedItem" title="'+el.dataset.automationLabel.replace(/"/g,'&quot;')+'">'+el.textContent+'<span data-automation-id="DELETE_charm" role="button" aria-label="remove">x</span></div>';
   s.querySelector('[data-automation-id="DELETE_charm"]').addEventListener('click',function(){hidden.value='';s.innerHTML='';});});});}
 input.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();show(input.value);}else if(e.key==='Escape'){close();}});
 c.querySelector('[data-automation-id="promptIcon"]').addEventListener('click',function(){show('');});});
document.querySelectorAll('[data-automation-id="dateWidgetContainer"]').forEach(function(c){var h=c.querySelector('input[type=hidden]');
 function upd(){var m=c.querySelector('[data-automation-id="dateSectionMonth-input"]').value,d=c.querySelector('[data-automation-id="dateSectionDay-input"]').value,y=c.querySelector('[data-automation-id="dateSectionYear-input"]').value;
  h.value=(m&&d&&y)?(y.padStart(4,'0')+'-'+m.padStart(2,'0')+'-'+d.padStart(2,'0')):'';}
 c.querySelectorAll('input:not([type=hidden])').forEach(function(i){i.addEventListener('input',upd);});});
var ra=document.querySelector('[data-automation-id="relatedActionsButton"]');if(ra)ra.addEventListener('click',function(){var m=document.querySelector('[data-automation-id="relatedActionsMenu"]');m.hidden=!m.hidden;});
document.querySelectorAll('[data-automation-id="relatedActionsItem"]').forEach(function(it){it.addEventListener('click',function(){document.querySelectorAll('[data-automation-id="relatedActionsSubmenu"]').forEach(function(s){s.hidden=true;});it.nextElementSibling.hidden=false;});});
document.querySelectorAll('form[data-automation-id="taskForm"]').forEach(function(f){f.addEventListener('submit',function(){setTimeout(function(){f.querySelectorAll('button').forEach(function(b){b.disabled=true;});},0);});});`;

  function fieldHtml(f: TaskField, value: string, error?: string): string {
    const req = f.required ? '<span data-automation-id="formLabelRequired" class="WCPE" aria-label="Required">*</span>' : '';
    let w: string;
    if (f.widget === 'text') w = `<input data-automation-id="textInputBox" name="${f.id}" id="${f.id}" value="${esc(value)}" aria-required="${f.required}">`;
    else if (f.widget === 'checkbox') w = `<input type="checkbox" data-automation-id="checkboxPanel" name="${f.id}" id="${f.id}" value="true"${value === 'true' ? ' checked' : ''}>`;
    else if (f.widget === 'date') {
      const [y, m, d] = value ? value.split('-') : ['', '', ''];
      w = `<div data-automation-id="dateWidgetContainer" id="${f.id}" role="group" aria-label="${esc(f.label)}"><input type="hidden" name="${f.id}" value="${esc(value)}">
<input data-automation-id="dateSectionMonth-input" aria-label="Month" size="2" value="${esc(m ?? '')}"> / <input data-automation-id="dateSectionDay-input" aria-label="Day" size="2" value="${esc(d ?? '')}"> / <input data-automation-id="dateSectionYear-input" aria-label="Year" size="4" value="${esc(y ?? '')}">
<span data-automation-id="dateIcon" role="button" aria-label="Calendar"></span></div>`;
    } else {
      w = `<div data-automation-id="multiselectInputContainer" id="${f.id}" data-options="${esc(JSON.stringify(f.options ?? []))}"><input type="hidden" name="${f.id}" value="${esc(value)}">
<div data-automation-id="selectedItemList">${value ? `<div data-automation-id="selectedItem" title="${esc(value)}">${esc(value)}<span data-automation-id="DELETE_charm" role="button">x</span></div>` : ''}</div>
<input data-automation-id="searchBox" placeholder="search" aria-label="${esc(f.label)}"><span data-automation-id="promptIcon" role="button" aria-label="Prompt"></span></div>`;
    }
    return `<li data-automation-id="formField-${f.id}" class="WDFF"><div data-automation-id="formLabel"><label for="${f.id}">${esc(f.label)}</label>${req}</div><div data-automation-id="formFieldContent">${w}${error ? `<div data-automation-id="errorMessage" role="alert">${esc(error)}</div>` : ''}</div></li>`;
  }

  function taskPage(role: string, key: string, values: Record<string, string>, errors: Record<string, string> = {}, query = ''): string {
    const t = TASKS[key];
    const errs = Object.values(errors);
    return shell(role, t.title, `${errs.length ? `<div data-automation-id="errorWidgetBarCanvas" role="alert"><span data-automation-id="errorWidgetBarMessageCount">Errors: ${errs.length}</span><ul>${errs.map((e) => `<li data-automation-id="errorWidgetBarMessage">${esc(e)}</li>`).join('')}</ul></div>` : ''}
<form method="post" data-automation-id="taskForm" action="/${tenant}/d/task/${key}.htmld${query}"><ul data-automation-id="formFieldList">${t.fields.map((f) => fieldHtml(f, values[f.id] ?? '', errors[f.id])).join('')}</ul>
<div data-automation-id="wd-CommandButtonBar"><button type="submit" data-automation-id="wd-CommandButton_uic_okButton" title="Submit">Submit</button>
<button type="button" data-automation-id="wd-CommandButton_uic_cancelButton" title="Cancel" onclick="location.href='/${tenant}/d/home.htmld'">Cancel</button></div></form><script>${PROMPT_JS}</script>`);
  }

  function profile(role: string, w: Worker): string {
    const canJob = role === 'hr' || (role === 'manager' && (w.manager === 'lmcneil' || w.org === 'Engineering'));
    const self = userWorker[users[role as keyof typeof users].username] === w.wid;
    const menu = [
      ...(canJob ? [['Job Change', [['Change Job', `/${tenant}/d/task/changejob.htmld?worker=${w.wid}`], ['Transfer', '#']]]] : []),
      ...(self || role === 'hr' ? [['Personal Data', [['Change Legal Name', '#'], ['Change Contact Information', '#']]]] : []),
      ...(role !== 'employee' ? [['Compensation', [['Request Compensation Change', '#']]]] : []),
    ] as Array<[string, Array<[string, string]>]>;
    const fields: Array<[string, string]> = [['Employee ID', w.employeeId], ['Business Title', w.businessTitle], ['Supervisory Organization', w.org], ['Hire Date', w.hireDate], ['Worker Status', w.status], ['Job Profile', w.jobProfile]];
    return shell(role, name(w), `<div data-automation-id="workerProfileHeader"><span data-automation-id="relatedActionsButton" role="button" aria-label="Related Actions"></span>
<div data-automation-id="relatedActionsMenu" role="menu" hidden>${menu.map(([cat, items]) => `<div data-automation-id="relatedActionsItem" role="menuitem">${esc(cat)}</div><div data-automation-id="relatedActionsSubmenu" role="menu" hidden>${items.map(([l, href]) => `<a data-automation-id="relatedActionsItemLabel" role="menuitem" href="${href}">${esc(l)}</a>`).join('')}</div>`).join('')}</div></div>
<ul data-automation-id="profileFields">${fields.map(([l, v]) => `<li data-automation-id="formField-${l.replace(/\W+/g, '')}"><div data-automation-id="formLabel"><label>${esc(l)}</label></div><div data-automation-id="textView">${esc(v)}</div></li>`).join('')}</ul><script>${PROMPT_JS}</script>`);
  }

  function validate(t: { fields: TaskField[] }, v: Record<string, string>): Record<string, string> {
    const errors: Record<string, string> = {};
    for (const f of t.fields) {
      if (f.required && !(v[f.id] ?? '').trim()) errors[f.id] = `The field ${f.label} is required and must have a value.`;
      else if (f.widget === 'prompt' && v[f.id] && !(f.options ?? []).includes(v[f.id])) errors[f.id] = `${v[f.id]} is not a valid value for ${f.label}.`;
      else if (f.widget === 'date' && v[f.id] && !/^\d{4}-\d{2}-\d{2}$/.test(v[f.id])) errors[f.id] = `Enter a valid date for ${f.label}.`;
    }
    return errors;
  }

  async function ui(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const p = url.pathname.slice(tenant.length + 1);
    if (p === '/login.htmld') {
      if (req.method === 'POST') {
        const f = new URLSearchParams(await body(req));
        const r = roleOf(f.get('username') ?? '');
        if (!r || users[r].password !== f.get('password')) return send(res, 200, loginPage('Invalid user name or password'));
        const sid = randomBytes(16).toString('hex');
        sessions.set(sid, r);
        res.writeHead(302, { location: `/${tenant}/d/home.htmld`, 'set-cookie': `PLAY_SESSION=${sid}; Path=/; HttpOnly; SameSite=Lax` });
        res.end();
        return;
      }
      return send(res, 200, loginPage());
    }
    const role = sessions.get(cookies(req).PLAY_SESSION ?? '');
    if (!role) {
      res.writeHead(302, { location: `/${tenant}/login.htmld` });
      res.end();
      return;
    }
    if (p === '/d/home.htmld') return send(res, 200, shell(role, `Welcome, ${users[role].username}`, '<section data-automation-id="homeApplets"><a data-automation-id="applet" href="#">Directory</a></section>'));
    if (p === '/d/search.htmld') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const tasks = Object.entries(TASKS).filter(([, t]) => t.roles.includes(role) && t.title.toLowerCase().includes(q) && q);
      const people = workers.filter((w) => q && name(w).toLowerCase().includes(q) && (role !== 'employee' || w.status === 'Active'));
      return send(res, 200, shell(role, 'Search Results', `<div data-automation-id="searchResults"><h3 data-automation-id="searchCategory">Tasks and Reports</h3>${tasks.map(([k, t]) => `<div data-automation-id="promptOption" data-automation-label="${esc(t.title)}" data-category="tasks"><a href="/${tenant}/d/task/${k}.htmld">${esc(t.title)}</a></div>`).join('') || '<div data-automation-id="noResults">No tasks</div>'}
<h3 data-automation-id="searchCategory">People</h3>${people.map((w) => `<div data-automation-id="promptOption" data-automation-label="${esc(name(w))}" data-category="people"><a href="/${tenant}/d/inst/${w.wid}.htmld">${esc(name(w))}</a> <span>${esc(w.businessTitle)}</span></div>`).join('') || '<div data-automation-id="noResults">No people</div>'}</div>`));
    }
    let m = /^\/d\/task\/(\w+)\.htmld$/.exec(p);
    if (m && TASKS[m[1]]) {
      const key = m[1];
      const t = TASKS[key];
      if (!t.roles.includes(role)) return send(res, 403, shell(role, 'Error', '<div data-automation-id="errorWidgetBarCanvas" role="alert">You do not have permission to perform this task.</div>'));
      const worker = workers.find((w) => w.wid === url.searchParams.get('worker'));
      if (req.method === 'GET') {
        const init: Record<string, string> = key === 'changejob' && worker ? { businessTitle: worker.businessTitle, jobProfile: worker.jobProfile } : {};
        return send(res, 200, taskPage(role, key, init, {}, url.search));
      }
      const v = Object.fromEntries(new URLSearchParams(await body(req)));
      const errors = validate(t, v);
      if (Object.keys(errors).length) return send(res, 200, taskPage(role, key, v, errors, url.search));
      if (key === 'hire') {
        const w: Worker = {
          wid: randomBytes(16).toString('hex'), employeeId: String(nextEmp++), firstName: v.firstName, lastName: v.lastName, businessTitle: v.businessTitle || v.jobProfile,
          hireDate: v.hireDate, status: 'Pending', org: v.supervisoryOrganization.replace(/\s*\(.*\)$/, ''), employeeType: v.employeeType, jobProfile: v.jobProfile, timeType: v.timeType || 'Full time', manager: 'lmcneil',
        };
        workers.push(w);
        const ev: Event = { id: randomBytes(8).toString('hex'), type: 'Hire', title: `Hire: ${name(w)} - ${w.jobProfile}`, worker: w.wid, assignee: 'manager', status: 'Awaiting Action', initiator: role };
        events.push(ev);
        return send(res, 200, shell(role, 'You have submitted', `<div data-automation-id="confirmationPage"><div data-automation-id="pageHeaderSubtitle">Hire Employee for ${esc(name(w))}</div><div data-automation-id="upNext">Up Next: Logan McNeil, Manager - Approval by Manager</div><a data-automation-id="processDetails" href="/${tenant}/d/inbox/${ev.id}.htmld">Details and Process</a><span data-automation-id="employeeId">${w.employeeId}</span></div>`));
      }
      if (!worker) return send(res, 400, shell(role, 'Error', '<div data-automation-id="errorWidgetBarCanvas" role="alert">No worker selected</div>'));
      if (v.jobProfile) worker.jobProfile = v.jobProfile;
      if (v.businessTitle) worker.businessTitle = v.businessTitle;
      return send(res, 200, shell(role, 'You have submitted', `<div data-automation-id="confirmationPage"><div data-automation-id="pageHeaderSubtitle">Change Job for ${esc(name(worker))}</div><div data-automation-id="upNext">Process Successfully Completed</div></div>`));
    }
    m = /^\/d\/inst\/(\w+)\.htmld$/.exec(p);
    if (m) {
      const w = workers.find((x) => x.wid === m![1]);
      if (!w) return send(res, 404, shell(role, 'Not Found', '<div role="alert">The item you are looking for no longer exists</div>'));
      return send(res, 200, profile(role, w));
    }
    if (p === '/d/inbox.htmld') {
      const mine = events.filter((e) => e.assignee === role && e.status === 'Awaiting Action');
      return send(res, 200, shell(role, 'My Tasks', `<div data-automation-id="inboxList" role="list">${mine.map((e) => `<div data-automation-id="inbox_row" role="listitem"><a data-automation-id="inboxItemTitle" href="/${tenant}/d/inbox/${e.id}.htmld">${esc(e.title)}</a><span data-automation-id="inboxItemStatus">${e.status}</span></div>`).join('') || '<div data-automation-id="inboxEmpty">You have no items in your inbox</div>'}</div>`));
    }
    m = /^\/d\/inbox\/(\w+)\.htmld$/.exec(p);
    if (m) {
      const e = events.find((x) => x.id === m![1]);
      if (!e) return send(res, 404, shell(role, 'Not Found', '<div role="alert">Not found</div>'));
      const w = workers.find((x) => x.wid === e.worker)!;
      if (req.method === 'POST') {
        if (e.assignee !== role) return send(res, 403, shell(role, 'Error', '<div data-automation-id="errorWidgetBarCanvas" role="alert">You are not an approver for this step.</div>'));
        const action = new URLSearchParams(await body(req)).get('action');
        if (action === 'approve') {
          e.status = 'Approved';
          w.status = 'Active';
          return send(res, 200, shell(role, 'You have approved', `<div data-automation-id="confirmationPage"><div data-automation-id="pageHeaderSubtitle">${esc(e.title)}</div><div data-automation-id="upNext">Process Successfully Completed</div></div>`));
        }
        e.status = 'Sent Back';
        return send(res, 200, shell(role, 'You have sent back', `<div data-automation-id="confirmationPage"><div data-automation-id="pageHeaderSubtitle">${esc(e.title)}</div></div>`));
      }
      return send(res, 200, shell(role, e.title, `<div data-automation-id="inboxDetail"><ul data-automation-id="profileFields"><li><div data-automation-id="formLabel"><label>Worker</label></div><div data-automation-id="textView">${esc(name(w))}</div></li>
<li><div data-automation-id="formLabel"><label>Hire Date</label></div><div data-automation-id="textView">${esc(w.hireDate)}</div></li><li><div data-automation-id="formLabel"><label>Status</label></div><div data-automation-id="textView">${esc(e.status)}</div></li></ul>
${e.assignee === role && e.status === 'Awaiting Action' ? `<form method="post" data-automation-id="taskForm"><div data-automation-id="wd-CommandButtonBar"><button name="action" value="approve" type="submit" data-automation-id="wd-CommandButton_uic_approveButton" title="Approve">Approve</button>
<button name="action" value="sendback" type="submit" data-automation-id="wd-CommandButton_uic_sendBackButton" title="Send Back">Send Back</button></div></form>` : ''}</div><script>${PROMPT_JS}</script>`));
    }
    return send(res, 404, shell(role, 'Not Found', '<div role="alert">Not found</div>'));
  }

  const loginPage = (error?: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Workday</title></head><body><form method="post" data-automation-id="authPanel">
${error ? `<div data-automation-id="errorMessage" role="alert">${esc(error)}</div>` : ''}<label>Username<input data-automation-id="userName" name="username"></label><label>Password<input data-automation-id="password" name="password" type="password"></label>
<button type="submit" data-automation-id="signInSubmitButton">Sign In</button></form></body></html>`;

  // ---------------------------------------------------------------- APIs
  const bearer = (req: IncomingMessage) => tokens.has((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  const basicRole = (req: IncomingMessage): keyof typeof users | 'isu' | '' => {
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Basic ')) return '';
    const [u, ...pp] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
    const pass = pp.join(':');
    if (u === isu.username && pass === isu.password) return 'isu';
    const r = roleOf(u.replace(`@${tenant}`, ''));
    return r && users[r].password === pass ? r : '';
  };
  /** API caller: the integration (OAuth API client / ISU) or a role user (basic, for permission checks). */
  const apiCaller = (req: IncomingMessage): string => (bearer(req) ? 'isu' : basicRole(req));
  const canReadWorkers = (who: string) => who === 'isu' || who === 'hr' || who === 'manager';

  function wql(query: string): Array<Record<string, unknown>> {
    const m = /^SELECT\s+([\w\s,]+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+LIMIT\s+(\d+))?\s*$/i.exec(query.trim());
    if (!m) throw new Error(`WQL syntax error near "${query.slice(0, 40)}"`);
    if (m[2] !== 'allWorkers') throw new Error(`Unknown data source ${m[2]}`);
    const cols = m[1].split(',').map((x) => x.trim());
    for (const c of cols) if (!WQL_FIELDS.some((f) => f.alias === c)) throw new Error(`Invalid field ${c} for data source allWorkers`);
    const conds = (m[3] ?? '').split(/\s+AND\s+/i).filter(Boolean).map((c) => {
      const t = /^(\w+)\s*=\s*'((?:[^']|'')*)'$/.exec(c.trim());
      if (!t) throw new Error(`Unsupported condition ${c}`);
      return { alias: t[1], value: t[2].replace(/''/g, "'") };
    });
    let rows = workers.filter((w) => conds.every((c) => {
      const v = wqlValue(w, c.alias);
      return (typeof v === 'object' && v ? (v as { descriptor: string }).descriptor : String(v ?? '')) === c.value;
    }));
    if (m[4]) rows = rows.slice(0, Number(m[4]));
    return rows.map((w) => Object.fromEntries(cols.map((c) => [c, wqlValue(w, c)])));
  }

  function soap(xml: string): { status: number; body: string } {
    const user = /<wsse:Username>([^<]*)<\/wsse:Username>/.exec(xml)?.[1];
    const pass = /<wsse:Password[^>]*>([^<]*)<\/wsse:Password>/.exec(xml)?.[1];
    const fault = (code: string, msg: string, status = 500) => ({ status, body: `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Body><SOAP-ENV:Fault><faultcode>${code}</faultcode><faultstring>${esc(msg)}</faultstring></SOAP-ENV:Fault></SOAP-ENV:Body></SOAP-ENV:Envelope>` });
    if (user !== isu.username || pass !== isu.password) return fault('SOAP-ENV:Client.authenticationError', 'invalid username or password', 500);
    const id = /<wd:ID wd:type="Employee_ID">([^<]*)<\/wd:ID>/.exec(xml)?.[1];
    const w = workers.find((x) => x.employeeId === id);
    if (!w) return fault('SOAP-ENV:Client.validationError', `Invalid ID value. '${id ?? ''}' is not a valid ID value for type = 'Employee_ID'`);
    return {
      status: 200,
      body: `<?xml version="1.0" encoding="UTF-8"?><env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body><wd:Get_Workers_Response xmlns:wd="urn:com.workday/bsvc" wd:version="v42.0"><wd:Response_Data><wd:Worker><wd:Worker_Reference><wd:ID wd:type="WID">${w.wid}</wd:ID><wd:ID wd:type="Employee_ID">${w.employeeId}</wd:ID></wd:Worker_Reference>
<wd:Worker_Data><wd:Worker_ID>${w.employeeId}</wd:Worker_ID><wd:Personal_Data><wd:Name_Data><wd:Legal_Name_Data><wd:Name_Detail_Data wd:Formatted_Name="${esc(name(w))}"><wd:First_Name>${esc(w.firstName)}</wd:First_Name><wd:Last_Name>${esc(w.lastName)}</wd:Last_Name></wd:Name_Detail_Data></wd:Legal_Name_Data></wd:Name_Data></wd:Personal_Data>
<wd:Employment_Data><wd:Worker_Job_Data><wd:Position_Data><wd:Business_Title>${esc(w.businessTitle)}</wd:Business_Title><wd:Job_Profile_Summary_Data><wd:Job_Profile_Name>${esc(w.jobProfile)}</wd:Job_Profile_Name></wd:Job_Profile_Summary_Data><wd:Worker_Type_Reference><wd:ID wd:type="Employee_Type_ID">${esc(w.employeeType)}</wd:ID></wd:Worker_Type_Reference></wd:Position_Data></wd:Worker_Job_Data>
<wd:Worker_Status_Data><wd:Active>${w.status === 'Active' ? 1 : 0}</wd:Active><wd:Hire_Date>${w.hireDate}</wd:Hire_Date></wd:Worker_Status_Data></wd:Employment_Data></wd:Worker_Data></wd:Worker></wd:Response_Data></wd:Get_Workers_Response></env:Body></env:Envelope>`,
    };
  }

  const WHATS_NEW = r2 ? [
    { Functional_Area: 'Human Capital Management', Feature: 'Hire Reason prompt', Change_Type: 'Field Renamed', Tasks_Affected: 'Hire Employee', Field: 'Reason', New_Value: 'Hire Reason', Description: 'Reason is now labeled Hire Reason on Hire Employee.' },
    { Functional_Area: 'Human Capital Management', Feature: 'Time Type on hire', Change_Type: 'Field Required', Tasks_Affected: 'Hire Employee', Field: 'Time Type', New_Value: '', Description: 'Time Type is required when hiring.' },
    { Functional_Area: 'Human Capital Management', Feature: 'Contingent worker types', Change_Type: 'Value Retired', Tasks_Affected: 'Hire Employee', Field: 'Employee Type', New_Value: 'Contractor', Description: 'Contractor is retired as an Employee Type; use Contract Contingent Worker.' },
    { Functional_Area: 'Compensation', Feature: 'Merit process redesign', Change_Type: 'UI Change', Tasks_Affected: 'Request Compensation Change', Field: '', New_Value: '', Description: 'New guided experience.' },
  ] : [];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    (async () => {
      const p = url.pathname;
      if (p === `/ccx/oauth2/${tenant}/token` && req.method === 'POST') {
        const f = new URLSearchParams(await body(req));
        const basic = (req.headers.authorization ?? '').startsWith('Basic ') ? Buffer.from((req.headers.authorization as string).slice(6), 'base64').toString().split(':') : [f.get('client_id'), f.get('client_secret')];
        if (basic[0] !== clientId || basic[1] !== clientSecret) return json(res, 401, { error: 'invalid_client', error_description: 'Invalid client' });
        if (f.get('grant_type') !== 'refresh_token' || f.get('refresh_token') !== refreshToken) return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid refresh token' });
        const t = randomBytes(24).toString('base64url');
        tokens.add(t);
        return json(res, 200, { access_token: t, token_type: 'Bearer', refresh_token: refreshToken });
      }
      if (p.startsWith(`/ccx/api/v1/${tenant}/workers`)) {
        stats.rest++;
        const who = apiCaller(req);
        if (!who) return json(res, 401, { error: 'invalid request: authentication required' });
        if (!canReadWorkers(who)) return json(res, 403, { error: 'The task submitted is not authorized.', errors: [{ error: 'Not authorized: Worker Data: Public Worker Reports' }] });
        const id = p.split('/')[5];
        const view = (w: Worker) => ({ id: w.wid, descriptor: name(w), href: `${url.origin}/ccx/api/v1/${tenant}/workers/${w.wid}`, businessTitle: w.businessTitle, isManager: w.employeeId === '21001', primaryWorkEmail: `${w.firstName.toLowerCase()}.${w.lastName.toLowerCase()}@ezcorp.example` });
        if (id) {
          const w = workers.find((x) => x.wid === id);
          return w ? json(res, 200, view(w)) : json(res, 404, { error: 'Resource not found' });
        }
        const q = (url.searchParams.get('search') ?? '').toLowerCase();
        const hit = workers.filter((w) => !q || name(w).toLowerCase().includes(q));
        return json(res, 200, { total: hit.length, data: hit.map(view) });
      }
      if (p.startsWith(`/ccx/api/wql/v1/${tenant}/`)) {
        const who = apiCaller(req);
        if (!who) return json(res, 401, { error: 'invalid request: authentication required' });
        const rest = p.slice(`/ccx/api/wql/v1/${tenant}/`.length);
        if (!canReadWorkers(who)) return json(res, 403, { error: 'Not authorized to data source allWorkers' });
        if (rest === 'dataSources') return json(res, 200, { total: 1, data: [{ id: 'allWorkers', alias: 'allWorkers', descriptor: 'All Workers' }] });
        if (rest === 'dataSources/allWorkers/fields') return json(res, 200, { total: WQL_FIELDS.length, data: WQL_FIELDS.map((f) => ({ id: f.alias, alias: f.alias, descriptor: f.descriptor, type: f.type })) });
        if (rest === 'data') {
          const q = url.searchParams.get('query') ?? '';
          stats.wql.push(q);
          try {
            const rows = wql(q);
            return json(res, 200, { total: rows.length, data: rows });
          } catch (e) {
            return json(res, 400, { error: (e as Error).message });
          }
        }
        return json(res, 404, { error: 'not found' });
      }
      if (p === `/ccx/service/${tenant}/Human_Resources/v42.0` && req.method === 'POST') {
        stats.soap++;
        const r = soap(await body(req));
        return send(res, r.status, r.body, 'text/xml; charset=utf-8');
      }
      if (p === `/ccx/service/customreport2/${tenant}/ISU_EZTest/Whats_New_in_Workday`) {
        if (basicRole(req) !== 'isu' && !bearer(req)) return send(res, 401, 'Unauthorized', 'text/plain');
        return json(res, 200, { Report_Entry: WHATS_NEW });
      }
      if (p.startsWith(`/${tenant}/`)) return ui(req, res, url);
      send(res, 404, 'not found', 'text/plain');
    })().catch((e: unknown) => send(res, 500, String((e as Error).message), 'text/plain'));
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  return {
    url, tenant, release, tokenUrl: `${url}/ccx/oauth2/${tenant}/token`, clientId, clientSecret, refreshToken, isu, users, workers, events, stats,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startWorkdayMock({ port: Number(process.env.PORT ?? 8097), release: (process.env.WD_RELEASE as WorkdayRelease) ?? '2026R1' });
  console.log(`Workday mock (${s.release}) on ${s.url}/${s.tenant}/login.htmld`);
  for (const [r, u] of Object.entries(s.users)) console.log(`  ${r}: ${u.username} / ${u.password}`);
}
