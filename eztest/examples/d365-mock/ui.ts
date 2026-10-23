/**
 * Unified Interface–like HTML for the D365 mock: sitemap, command bar, form
 * with UCI control data-ids, lookup flyout, business process flow, form
 * notifications, "unsaved changes" indicator and a read-only grid view.
 */
import type { MockAttribute, MockEntity, MockRecord, MockStore } from './model.js';

export const APP_ID = '6b0c5e9a-1d0f-4a35-9a8e-2f1c8a0e5d11';

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function formatMoney(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** ISO date (YYYY-MM-DD...) -> M/D/YYYY. */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]}` : iso;
}

export function recordUrl(etn: string, id?: string): string {
  return `/main.aspx?appid=${APP_ID}&pagetype=entityrecord&etn=${encodeURIComponent(etn)}${id ? `&id=${encodeURIComponent(id)}` : ''}`;
}

export function listUrl(etn: string): string {
  return `/main.aspx?appid=${APP_ID}&pagetype=entitylist&etn=${encodeURIComponent(etn)}`;
}

function controlOf(a: MockAttribute): NonNullable<MockAttribute['control']> {
  if (a.control) return a.control;
  switch (a.type) {
    case 'Picklist': case 'Status': case 'State': return 'optionset';
    case 'Money': return 'money';
    case 'Integer': case 'Decimal': return 'number';
    case 'Boolean': return 'toggle';
    case 'DateTime': return 'date';
    case 'Lookup': case 'Customer': case 'Owner': return 'lookup';
    default: return 'text';
  }
}

const STYLE = `
body{font-family:Segoe UI,Arial,sans-serif;margin:0;display:flex;min-height:100vh;background:#faf9f8;color:#323130}
nav[data-id=sitemap]{width:200px;background:#efefef;padding:8px}
nav ul{list-style:none;padding:0;margin:0} nav li{padding:6px 8px;cursor:pointer} nav li:hover{background:#ddd}
main{flex:1;padding:0 16px}
ul[data-id=CommandBar]{list-style:none;display:flex;gap:8px;padding:8px 0;margin:0;border-bottom:1px solid #ddd}
.field{display:flex;align-items:center;gap:8px;margin:6px 0} .field label{width:220px}
.req{color:#a4262c}
[data-id=notificationWrapper]{background:#fde7e9;padding:6px;margin:6px 0}
[data-id=processStageArea]{display:flex;gap:4px;margin:8px 0}
[data-id=processStageArea] [role=button]{padding:6px 12px;border:1px solid #ccc;border-radius:12px;cursor:pointer}
[data-id=processStageArea] [aria-current=step]{background:#0078d4;color:#fff}
[role=grid]{display:table;border-collapse:collapse;margin-top:8px} [role=row]{display:table-row} [role=gridcell],[role=columnheader]{display:table-cell;padding:4px 10px;border-bottom:1px solid #eee}
.flyout{border:1px solid #ccc;background:#fff;position:absolute;min-width:240px;z-index:5}
.flyout li{padding:4px 8px;cursor:pointer;list-style:none} .flyout ul{margin:0;padding:0}
`;

function sitemap(all: MockEntity[]): string {
  const items = all
    .map((e) => `<li role="treeitem" data-id="sitemap-entity-${esc(e.logicalName)}" aria-label="${esc(e.collectionName)}" data-href="${esc(listUrl(e.logicalName))}">${esc(e.collectionName)}</li>`)
    .join('');
  return `<nav data-id="sitemap" aria-label="Site Map"><ul role="tree">${items}</ul></nav>`;
}

const SHELL_JS = `
document.querySelectorAll('[data-id^="sitemap-entity-"]').forEach(function(li){
  li.addEventListener('click', function(){ location.href = li.getAttribute('data-href'); });
});`;

function page(title: string, all: MockEntity[], body: string, script: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${STYLE}</style></head>
<body>${sitemap(all)}<main>${body}</main><script>${SHELL_JS}${script}</script></body></html>`;
}

function fieldHtml(a: MockAttribute, rec: MockRecord | undefined, store: MockStore): string {
  const n = a.logicalName;
  const c = controlOf(a);
  const raw = rec?.[c === 'lookup' ? `_${n}_value` : n];
  const labelId = `id-${n}-label`;
  const reqMark = a.required === 'ApplicationRequired' || a.required === 'SystemRequired' ? '<span class="req" aria-hidden="true">*</span>' : '';
  let control = '';
  switch (c) {
    case 'text':
    case 'phone':
    case 'email': {
      const suffix = c === 'text' ? 'text-box-text' : c === 'phone' ? 'phone-text-input' : 'mail-text-input';
      control = `<input id="${n}-input" type="text" aria-labelledby="${labelId}" data-id="${n}.fieldControl-${suffix}" value="${esc(raw ?? '')}"${a.maxLength ? ` maxlength="${a.maxLength}"` : ''}>`;
      break;
    }
    case 'money':
      control = `<input id="${n}-input" type="text" aria-labelledby="${labelId}" data-id="${n}.fieldControl-currency-text-input" value="${typeof raw === 'number' ? esc(formatMoney(raw)) : ''}">`;
      break;
    case 'number':
      control = `<input id="${n}-input" type="text" aria-labelledby="${labelId}" data-id="${n}.fieldControl-whole-number-text-input" value="${typeof raw === 'number' ? esc(raw.toLocaleString('en-US')) : ''}">`;
      break;
    case 'date':
      control = `<input id="${n}-input" type="text" placeholder="M/D/YYYY" aria-labelledby="${labelId}" data-id="${n}.fieldControl-date-time-input" value="${typeof raw === 'string' ? esc(formatDate(raw)) : ''}">`;
      break;
    case 'optionset': {
      const opts = (a.options ?? [])
        .map((o) => `<option value="${o.value}"${raw === o.value ? ' selected' : ''}>${esc(o.label)}</option>`)
        .join('');
      control = `<select id="${n}-input" aria-labelledby="${labelId}" data-id="${n}.fieldControl-option-set-select"><option value="">---</option>${opts}</select>`;
      break;
    }
    case 'toggle': {
      const [f, t] = a.booleanLabels ?? ['No', 'Yes'];
      const on = raw === true;
      control = `<input id="${n}-input" type="checkbox" role="switch" aria-labelledby="${labelId}" data-id="${n}.fieldControl-checkbox-toggle" data-true-label="${esc(t)}" data-false-label="${esc(f)}"${on ? ' checked' : ''}>
<span data-id="${n}.fieldControl-checkbox-label">${esc(on ? t : f)}</span>`;
      break;
    }
    case 'lookup': {
      const p = `${n}.fieldControl-LookupResultsDropdown_${n}`;
      const target = a.targets?.[0] ?? 'account';
      const name = typeof raw === 'string' ? store.nameOf(target, raw) : undefined;
      const sel = name !== undefined
        ? `<li data-record-id="${esc(raw)}"><div data-id="${p}_selected_tag_text">${esc(name)}</div><button type="button" data-id="${p}_selected_tag_delete" aria-label="Delete ${esc(name)}">x</button></li>`
        : '';
      control = `<div class="lookup" data-target="${esc(target)}" style="position:relative">
<ul data-id="${p}_SelectedRecordList" style="list-style:none;margin:0;padding:0">${sel}</ul>
<input id="${n}-input" type="text" role="combobox" aria-expanded="false" aria-labelledby="${labelId}" placeholder="Look for ${esc(a.label)}" data-id="${p}_textInputBox_with_filter_new"${name !== undefined ? ' hidden' : ''}>
<div class="flyout" role="listbox" aria-label="Lookup results" data-id="${p}_resultsContainer" hidden aria-busy="false"><ul></ul></div></div>`;
      break;
    }
  }
  return `<div class="field" data-id="${n}" data-control="${c}"><label id="${labelId}" for="${n}-input">${esc(a.label)}${reqMark}</label>${control}
<span data-id="${n}-error-message" role="alert" hidden></span></div>`;
}

export function renderForm(e: MockEntity, all: MockEntity[], store: MockStore, rec?: MockRecord): string {
  const etn = e.logicalName;
  const id = rec ? String(rec[e.primaryId]) : undefined;
  const fields = e.attributes.filter((a) => a.onForm);
  const cmd = (name: string, label: string) =>
    `<li><button type="button" data-id="${etn}|NoRelationship|Form|Mscrm.${name}" aria-label="${esc(label)}">${esc(label)}</button></li>`;
  let bpf = '';
  if (e.bpf) {
    const active = Math.max(0, e.bpf.stages.findIndex((s) => s.name === (rec?.stepname ?? e.bpf!.stages[0].name)));
    bpf = `<div data-id="processStageArea" aria-label="${esc(e.bpf.name)}" data-active-index="${active}"></div>
<div class="flyout" role="dialog" data-id="processStageFlyout" hidden></div>`;
  }
  const config = {
    etn, id: id ?? null, listUrl: listUrl(etn), recordUrl: recordUrl(etn), entityName: e.displayName,
    fields: fields.map((a) => ({ name: a.logicalName, label: a.label, control: controlOf(a), required: a.required })),
    bpf: e.bpf ? { stages: e.bpf.stages.map((s) => s.name), active: Math.max(0, e.bpf.stages.findIndex((s) => s.name === (rec?.stepname ?? e.bpf!.stages[0].name))) } : null,
  };
  const title = rec ? String(rec[e.primaryName] ?? '') : `New ${e.displayName}`;
  const body = `
<ul data-id="CommandBar" role="menubar" aria-label="${esc(e.displayName)} Form Command Bar">
${cmd('SavePrimary', 'Save')}${cmd('SaveAndClosePrimary', 'Save & Close')}${cmd('NewRecordFromForm', '+ New')}</ul>
<div data-id="form-header"><h1 data-id="header_title">${esc(title)}</h1>
<span data-id="header_entityName">${esc(e.displayName)}</span> · <span data-id="header_saveStatus" aria-live="polite"></span></div>
<div data-id="saveProgressIndicator" role="progressbar" hidden>Saving...</div>
<div data-id="notificationWrapper" aria-label="Form notifications" hidden></div>
${bpf}
<section data-id="form-section-general" aria-label="Summary">${fields.map((a) => fieldHtml(a, rec, store)).join('\n')}</section>
<script type="application/json" id="form-config">${JSON.stringify(config).replace(/</g, '\\u003c')}</script>`;
  return page(`${e.displayName}: ${title} - Dynamics 365`, all, body, FORM_JS);
}

export function renderList(e: MockEntity, all: MockEntity[]): string {
  const etn = e.logicalName;
  const cols = e.attributes.filter((a) => a.inView);
  const headers = cols.map((a) => `<div role="columnheader" col-id="${esc(a.logicalName)}">${esc(a.label)}</div>`).join('');
  const body = `
<ul data-id="CommandBar" role="menubar" aria-label="${esc(e.collectionName)} Command Bar">
<li><button type="button" data-id="${etn}|NoRelationship|HomePageGrid|Mscrm.HomepageGrid.${etn}.NewRecord" aria-label="New">+ New</button></li></ul>
<h1 data-id="ViewSelector"><span data-id="viewSelectorName">${esc(e.viewName)}</span></h1>
<div data-id="data-set-body-container">
<div role="grid" aria-label="${esc(e.viewName)}" aria-busy="true" data-etn="${esc(etn)}" data-new-url="${esc(recordUrl(etn))}">
<div role="rowgroup" data-id="grid-header"><div role="row" aria-rowindex="1">${headers}</div></div>
<div role="rowgroup" data-id="grid-body"></div></div></div>`;
  return page(`${e.viewName} - Dynamics 365`, all, body, LIST_JS);
}

const LIST_JS = `
(function(){
  var grid = document.querySelector('[role=grid]');
  var etn = grid.getAttribute('data-etn');
  document.querySelector('[data-id$="NewRecord"]').addEventListener('click', function(){ location.href = grid.getAttribute('data-new-url'); });
  setTimeout(function(){
    fetch('/_mock/view?etn=' + encodeURIComponent(etn)).then(function(r){ return r.json(); }).then(function(data){
      var body = grid.querySelector('[data-id=grid-body]');
      data.rows.forEach(function(row, i){
        var r = document.createElement('div');
        r.setAttribute('role','row'); r.setAttribute('row-index', String(i)); r.setAttribute('aria-rowindex', String(i + 2));
        r.setAttribute('data-id', 'row-' + row.id);
        data.columns.forEach(function(col){
          var c = document.createElement('div');
          c.setAttribute('role','gridcell'); c.setAttribute('col-id', col);
          if (col === data.primary) { var a = document.createElement('a'); a.href = row.url; a.textContent = row.cells[col] || ''; c.appendChild(a); }
          else c.textContent = row.cells[col] || '';
          r.appendChild(c);
        });
        body.appendChild(r);
      });
      grid.setAttribute('aria-rowcount', String(data.rows.length + 1));
      grid.setAttribute('aria-busy','false');
    });
  }, 200);
})();`;

const FORM_JS = `
(function(){
  var cfg = JSON.parse(document.getElementById('form-config').textContent);
  var dirty = false, saving = false;
  var statusEl = document.querySelector('[data-id=header_saveStatus]');
  var notif = document.querySelector('[data-id=notificationWrapper]');
  function markDirty(){ dirty = true; statusEl.textContent = 'Unsaved'; }
  function notify(msgs){
    notif.innerHTML = '';
    msgs.forEach(function(m){
      var d = document.createElement('div'); d.setAttribute('data-id','notification'); d.setAttribute('role','alert'); d.setAttribute('data-level','ERROR');
      var s = document.createElement('span'); s.setAttribute('data-id','notification-message'); s.textContent = m; d.appendChild(s); notif.appendChild(d);
    });
    notif.hidden = msgs.length === 0;
  }
  function money(n){ return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function el(f){ return document.getElementById(f.name + '-input'); }
  function num(s){ var t = String(s).replace(/[$,\\s]/g, ''); if (!t) return null; var n = Number(t); return isNaN(n) ? NaN : n; }
  cfg.fields.forEach(function(f){
    var input = el(f);
    if (f.control === 'toggle') {
      input.addEventListener('change', function(){
        input.nextElementSibling.textContent = input.checked ? input.getAttribute('data-true-label') : input.getAttribute('data-false-label');
        markDirty();
      });
    } else if (f.control === 'optionset') {
      input.addEventListener('change', markDirty);
    } else if (f.control === 'lookup') {
      setupLookup(f, input);
    } else {
      input.addEventListener('input', markDirty);
      if (f.control === 'money') input.addEventListener('blur', function(){ var n = num(input.value); if (typeof n === 'number' && !isNaN(n)) input.value = money(n); });
      if (f.control === 'number') input.addEventListener('blur', function(){ var n = num(input.value); if (typeof n === 'number' && !isNaN(n)) input.value = n.toLocaleString('en-US'); });
    }
  });

  function setupLookup(f, input){
    var root = input.parentElement;
    var flyout = root.querySelector('[role=listbox]');
    var selected = root.querySelector('[data-id$=_SelectedRecordList]');
    var p = f.name + '.fieldControl-LookupResultsDropdown_' + f.name;
    var timer = null, seq = 0;
    function wireDelete(){
      var del = selected.querySelector('button');
      if (del) del.addEventListener('click', function(){ selected.innerHTML = ''; input.hidden = false; input.value = ''; markDirty(); input.focus(); });
    }
    wireDelete();
    input.addEventListener('input', function(){
      clearTimeout(timer);
      var q = input.value; var my = ++seq;
      flyout.hidden = false; flyout.setAttribute('aria-busy','true'); input.setAttribute('aria-expanded','true');
      flyout.querySelector('ul').innerHTML = '';
      timer = setTimeout(function(){
        fetch('/_mock/lookup?etn=' + encodeURIComponent(root.getAttribute('data-target')) + '&q=' + encodeURIComponent(q))
          .then(function(r){ return r.json(); }).then(function(rows){
            if (my !== seq) return;
            var ul = flyout.querySelector('ul'); ul.innerHTML = '';
            if (!rows.length) { var li = document.createElement('li'); li.setAttribute('data-id', p + '_noRecordsText'); li.textContent = 'No records found'; ul.appendChild(li); }
            rows.forEach(function(r){
              var li = document.createElement('li'); li.setAttribute('role','option'); li.setAttribute('data-id', r.id); li.setAttribute('aria-label', r.name);
              var prim = document.createElement('span'); prim.setAttribute('data-id', p + '_resultsContainer_primaryField'); prim.textContent = r.name;
              var sec = document.createElement('span'); sec.setAttribute('data-id', p + '_resultsContainer_secondaryField'); sec.textContent = ' ' + (r.secondary || '');
              li.appendChild(prim); li.appendChild(sec);
              li.addEventListener('click', function(){
                selected.innerHTML = '<li data-record-id=""><div data-id="' + p + '_selected_tag_text"></div><button type="button" data-id="' + p + '_selected_tag_delete">x</button></li>';
                selected.firstChild.setAttribute('data-record-id', r.id);
                selected.querySelector('div').textContent = r.name;
                selected.querySelector('button').setAttribute('aria-label', 'Delete ' + r.name);
                wireDelete();
                input.hidden = true; flyout.hidden = true; input.setAttribute('aria-expanded','false'); markDirty();
              });
              ul.appendChild(li);
            });
            flyout.setAttribute('aria-busy','false');
          });
      }, 250);
    });
  }

  function collect(){
    var values = {}, errors = [];
    cfg.fields.forEach(function(f){
      var input = el(f), v = null;
      switch (f.control) {
        case 'optionset': v = input.value === '' ? null : Number(input.value); break;
        case 'toggle': v = input.checked; break;
        case 'money': case 'number': v = num(input.value); if (typeof v === 'number' && isNaN(v)) { errors.push(f.label + ': Enter a number.'); v = null; } break;
        case 'date': {
          var t = input.value.trim();
          if (t) { var m = /^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})$/.exec(t); if (!m) errors.push(f.label + ': Enter a valid date.'); else v = m[3] + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2) + 'T00:00:00Z'; }
          break;
        }
        case 'lookup': { var li = input.parentElement.querySelector('[data-record-id]'); v = li ? li.getAttribute('data-record-id') : null; break; }
        default: v = input.value.trim() === '' ? null : input.value.trim();
      }
      if (v === null && (f.required === 'ApplicationRequired' || f.required === 'SystemRequired')) errors.push(f.label + ': Required fields must be filled in.');
      values[f.name] = v;
    });
    return { values: values, errors: errors };
  }

  function save(close){
    if (saving) return;
    var c = collect();
    if (c.errors.length) { notify(c.errors); return; }
    saving = true;
    var prog = document.querySelector('[data-id=saveProgressIndicator]'); prog.hidden = false;
    statusEl.textContent = 'Saving...';
    fetch('/_mock/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ etn: cfg.etn, id: cfg.id, values: c.values }) })
      .then(function(r){ return r.json().then(function(b){ return { ok: r.ok, body: b }; }); })
      .then(function(res){
        saving = false; prog.hidden = true;
        if (!res.ok) { statusEl.textContent = dirty ? 'Unsaved' : ''; notify([typeof res.body.error === 'string' ? res.body.error : res.body.error.message]); return; }
        cfg.id = res.body.id; dirty = false; notify([]);
        history.replaceState(null, '', cfg.recordUrl + '&id=' + encodeURIComponent(cfg.id));
        document.querySelector('[data-id=header_title]').textContent = res.body.name;
        statusEl.textContent = 'Saved';
        if (close) location.href = cfg.listUrl;
      });
  }
  document.querySelector('[data-id$="Mscrm.SavePrimary"]').addEventListener('click', function(){ save(false); });
  document.querySelector('[data-id$="Mscrm.SaveAndClosePrimary"]').addEventListener('click', function(){ save(true); });
  document.querySelector('[data-id$="Mscrm.NewRecordFromForm"]').addEventListener('click', function(){ location.href = cfg.recordUrl; });

  if (cfg.bpf) {
    var area = document.querySelector('[data-id=processStageArea]');
    var fly = document.querySelector('[data-id=processStageFlyout]');
    function renderStages(){
      area.innerHTML = '';
      cfg.bpf.stages.forEach(function(name, i){
        var st = i < cfg.bpf.active ? 'Completed' : i === cfg.bpf.active ? 'Active' : 'Not Started';
        var b = document.createElement('div'); b.setAttribute('role','button'); b.setAttribute('tabindex','0');
        b.setAttribute('data-id','processStage_' + i); b.setAttribute('aria-label', name + ', ' + st);
        if (i === cfg.bpf.active) b.setAttribute('aria-current','step');
        var s = document.createElement('span'); s.setAttribute('data-id','processStageName'); s.textContent = name; b.appendChild(s);
        b.addEventListener('click', function(){ openFlyout(i); });
        area.appendChild(b);
      });
    }
    function openFlyout(i){
      fly.innerHTML = '';
      fly.setAttribute('aria-label', cfg.bpf.stages[i] + ' stage');
      var h = document.createElement('h2'); h.textContent = cfg.bpf.stages[i]; fly.appendChild(h);
      if (i === cfg.bpf.active && i < cfg.bpf.stages.length - 1) {
        var nb = document.createElement('button'); nb.type = 'button';
        nb.setAttribute('data-id','MscrmControls.Containers.ProcessStageControl-nextButtonContainer');
        nb.setAttribute('aria-label','Next Stage'); nb.textContent = 'Next Stage';
        nb.addEventListener('click', nextStage); fly.appendChild(nb);
      }
      fly.hidden = false;
    }
    function nextStage(){
      if (!cfg.id) { notify(['Save the record before moving to the next stage.']); fly.hidden = true; return; }
      if (dirty) { notify(['You have unsaved changes. Save the record before moving to the next stage.']); fly.hidden = true; return; }
      fetch('/_mock/stage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ etn: cfg.etn, id: cfg.id }) })
        .then(function(r){ return r.json().then(function(b){ return { ok: r.ok, body: b }; }); })
        .then(function(res){
          fly.hidden = true;
          if (!res.ok) { notify([typeof res.body.error === 'string' ? res.body.error : res.body.error.message]); return; }
          notify([]); cfg.bpf.active = res.body.index; renderStages();
        });
    }
    renderStages();
  }
})();`;
