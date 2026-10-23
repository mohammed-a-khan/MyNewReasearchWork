/* Fiori launchpad emulation for the SAP mock (plain browser JS, no UI5).
 * Renders UI5 DOM conventions (sapM / sapUiComp / sapUxAP classes, -inner
 * inputs, -vhi value help icons, bdi texts) for two apps, reads $metadata
 * like a UI5 OData model, and exposes a minimal sap.ui.getCore().byId(). */
(function () {
  'use strict';
  var CFG = window.__FLP_CONFIG;
  var registry = {};
  var counter = 0;
  window.sap = {
    ui: {
      version: '1.120.0',
      getCore: function () {
        return {
          isInitialized: function () { return true; },
          byId: function (id) { return registry[id]; },
        };
      },
    },
    ushell: { Container: { getService: function () { return { getCurrentApplication: function () { return current ? { applicationType: 'UI5', componentInstance: { getManifestEntry: function () { return { dataSources: { mainService: { uri: CFG.services[current.app.service].path + '/', settings: { odataVersion: CFG.services[current.app.service].version === 4 ? '4.0' : '2.0' } } } }; } } } : null; } }; } } },
  };
  var APPS = {
    'SalesOrder-manage': {
      title: 'Manage Sales Orders', service: 'SD_SALESORDER_MANAGE_SRV', set: 'C_SalesOrder', key: 'SalesOrder', canCreate: true,
      filters: ['SalesOrder', 'SoldToParty', 'SalesOrderType'],
      columns: ['SalesOrder', 'SoldToParty', 'PurchaseOrderByCustomer', 'SalesOrderType', 'TotalNetAmount', 'OverallSDProcessStatus'],
      form: ['SalesOrderType', 'SalesOrganization', 'SoldToParty', 'PurchaseOrderByCustomer', 'RequestedDeliveryDate', 'TotalNetAmount', 'TransactionCurrency', 'OverallSDProcessStatus'],
      header: function (r) { return 'Sales Order ' + r.SalesOrder; }, entityLabel: 'Sales Order',
    },
    'Product-manage': {
      title: 'Manage Products', service: 'api_product', set: 'Product', key: 'Product', canCreate: false,
      filters: ['Product', 'ProductType'], columns: ['Product', 'ProductDescription', 'ProductType', 'ProductGroup'],
      form: ['ProductDescription', 'ProductType', 'ProductGroup', 'BaseUnit'],
      header: function (r) { return r.ProductDescription + ' (' + r.Product + ')'; }, entityLabel: 'Product',
    },
  };
  var current = null;
  var metaCache = {};
  var vhCache = {};
  var csrfToken = null;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function container() { return document.getElementById('application-container'); }
  function busy(on) {
    var b = document.getElementById('ez-busy');
    if (on && !b) { b = document.createElement('div'); b.id = 'ez-busy'; b.className = 'sapUiLocalBusyIndicator'; b.setAttribute('role', 'progressbar'); document.body.appendChild(b); }
    if (!on && b) b.remove();
  }
  function fmtDate(iso) { if (!iso) return ''; var p = iso.split('-'); return MONTHS[Number(p[1]) - 1] + ' ' + Number(p[2]) + ', ' + p[0]; }
  function parseDate(s) {
    s = (s || '').trim(); if (!s) return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); if (m) return s;
    m = /^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/.exec(s);
    if (m) { var mi = MONTHS.indexOf(m[1].slice(0, 1).toUpperCase() + m[1].slice(1, 3).toLowerCase()); if (mi >= 0) return m[3] + '-' + String(mi + 1).padStart(2, '0') + '-' + String(Number(m[2])).padStart(2, '0'); }
    return null;
  }
  function fmtAmount(v) { var n = Number(v || 0); return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fromV2(v) { if (v == null) return ''; var m = /^\/Date\((-?\d+)\)\/$/.exec(String(v)); return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : String(v); }

  function svcInfo(app) { return CFG.services[app.service]; }
  function odata(app, method, path, body) {
    var s = svcInfo(app);
    var url = s.path + '/' + path + (method === 'GET' && s.version === 2 ? (path.indexOf('?') >= 0 ? '&' : '?') + '$format=json' : '');
    var headers = { accept: 'application/json' };
    var go = function () {
      if (method !== 'GET') { headers['x-csrf-token'] = csrfToken; headers['content-type'] = 'application/json'; }
      return fetch(url, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    };
    if (method !== 'GET' && !csrfToken) {
      return fetch(s.path + '/', { headers: { 'x-csrf-token': 'Fetch', accept: 'application/json' }, credentials: 'same-origin' }).then(function (r) { csrfToken = r.headers.get('x-csrf-token'); return go(); });
    }
    return go();
  }
  function rowsOf(app, json) { return svcInfo(app).version === 2 ? (json.d.results || [json.d]) : (json.value || [json]); }

  function loadMeta(app) {
    if (metaCache[app.service]) return Promise.resolve(metaCache[app.service]);
    return fetch(svcInfo(app).path + '/$metadata', { credentials: 'same-origin' }).then(function (r) { return r.text(); }).then(function (xml) {
      var doc = new DOMParser().parseFromString(xml, 'application/xml');
      var SAP = 'http://www.sap.com/Protocols/SAPData';
      var meta = {};
      var types = {};
      Array.prototype.forEach.call(doc.getElementsByTagName('EntityType'), function (et) {
        var props = {};
        Array.prototype.forEach.call(et.getElementsByTagName('Property'), function (p) {
          props[p.getAttribute('Name')] = {
            name: p.getAttribute('Name'), type: p.getAttribute('Type'), label: p.getAttributeNS(SAP, 'label') || p.getAttribute('Name'),
            required: p.getAttribute('Nullable') === 'false' && p.getAttributeNS(SAP, 'creatable') !== 'false',
            creatable: p.getAttributeNS(SAP, 'creatable') !== 'false', updatable: p.getAttributeNS(SAP, 'updatable') !== 'false',
            valueList: p.getAttributeNS(SAP, 'value-list') || '', maxLength: p.getAttribute('MaxLength'),
          };
        });
        types[et.getAttribute('Name')] = props;
      });
      Array.prototype.forEach.call(doc.getElementsByTagName('Annotations'), function (a) {
        var target = a.getAttribute('Target').split('.').pop().split('/');
        var props = types[target[0]];
        if (!props || !target[1] || !props[target[1]]) return;
        Array.prototype.forEach.call(a.getElementsByTagName('Annotation'), function (an) {
          var term = an.getAttribute('Term');
          if (/Common\.v1\.Label$/.test(term)) props[target[1]].label = an.getAttribute('String');
          if (/Core\.V1\.Immutable$/.test(term)) props[target[1]].updatable = false;
          if (/Common\.v1\.ValueList$/.test(term)) {
            var pv = an.getElementsByTagName('PropertyValue');
            for (var i = 0; i < pv.length; i++) if (pv[i].getAttribute('Property') === 'CollectionPath') props[target[1]].collection = pv[i].getAttribute('String');
          }
        });
      });
      Array.prototype.forEach.call(doc.getElementsByTagName('EntitySet'), function (es) { meta[es.getAttribute('Name')] = types[es.getAttribute('EntityType').split('.').pop()]; });
      metaCache[app.service] = meta;
      return meta;
    });
  }
  function valueHelp(app, prop) {
    var k = app.service + '/' + prop.collection;
    if (vhCache[k]) return Promise.resolve(vhCache[k]);
    return odata(app, 'GET', prop.collection).then(function (r) { return r.json(); }).then(function (j) {
      var rows = rowsOf(app, j).map(function (r) { var ks = Object.keys(r).filter(function (x) { return x !== '__metadata'; }); return { key: r[ks[0]], text: r[ks[1]] }; });
      vhCache[k] = rows; return rows;
    });
  }
  function displayOf(app, meta, prop, v) {
    var p = meta[prop];
    if (!p) return v;
    if (p.type === 'Edm.DateTime' || p.type === 'Edm.Date') return fmtDate(v);
    if (p.type === 'Edm.Decimal') return fmtAmount(v);
    if (p.collection && v) {
      var vh = vhCache[app.service + '/' + p.collection] || [];
      var hit = vh.filter(function (x) { return x.key === v; })[0];
      return hit ? hit.text + ' (' + v + ')' : v;
    }
    return v;
  }

  function register(id, prop, kind, getEditable) {
    registry[id] = {
      getId: function () { return id; },
      getMetadata: function () { return { getName: function () { return kind; } }; },
      getBindingPath: function (p) { return p === 'value' ? prop : undefined; },
      getEditable: getEditable,
      getDomRef: function () { return document.getElementById(id); },
    };
  }

  // ---------------------------------------------------------------- controls
  function fieldHtml(app, meta, prop, value, mode, idPrefix) {
    var p = meta[prop];
    var id = idPrefix + '--' + prop;
    var editable = mode === 'create' ? p.creatable : mode === 'edit' ? p.updatable : false;
    var label = '<label id="' + id + '-label" class="sapMLabel' + (editable && p.required ? ' sapMLabelRequired' : '') + '" for="' + id + '-input-inner"><span class="sapMLabelTextWrapper"><bdi>' + esc(p.label) + '</bdi></span></label>';
    var inner;
    if (!editable) {
      inner = '<span id="' + id + '-text" class="sapMText">' + esc(displayOf(app, meta, prop, value)) + '</span>';
    } else if (p.valueList === 'fixed-values') {
      inner = '<div id="' + id + '-input" class="sapMComboBox sapMInputBase" data-sap-ui="' + id + '-input"><div class="sapMInputBaseContentWrapper"><input id="' + id + '-input-inner" role="combobox" aria-expanded="false" class="sapMInputBaseInner" data-key="' + esc(value) + '" value="' + esc(value ? displayOf(app, meta, prop, value) : '') + '"><span id="' + id + '-input-arrow" class="sapMInputBaseIcon sapUiIcon" role="button" aria-label="Show options" data-sap-ui-icon-content=""></span></div></div>';
    } else if (p.type === 'Edm.DateTime' || p.type === 'Edm.Date') {
      inner = '<div id="' + id + '-input" class="sapMDP sapMInputBase" data-sap-ui="' + id + '-input"><div class="sapMInputBaseContentWrapper"><input id="' + id + '-input-inner" class="sapMInputBaseInner" placeholder="e.g. ' + fmtDate('2026-12-31') + '" value="' + esc(fmtDate(value)) + '"><span id="' + id + '-input-icon" class="sapMInputBaseIcon sapUiIcon" role="button" aria-label="Open Picker"></span></div></div>';
    } else {
      inner = '<div id="' + id + '-input" class="sapMInput sapMInputBase" data-sap-ui="' + id + '-input"><div class="sapMInputBaseContentWrapper"><input id="' + id + '-input-inner" class="sapMInputBaseInner" value="' + esc(value) + '"' + (p.maxLength ? ' maxlength="' + p.maxLength + '"' : '') + '>' + (p.valueList === 'standard' ? '<span id="' + id + '-input-vhi" class="sapMInputBaseIcon sapUiIcon" role="button" aria-label="Show Value Help" data-sap-ui-icon-content=""></span>' : '') + '</div></div>';
    }
    register(id, prop, CFG.services[app.service].version === 4 ? 'sap.fe.macros.Field' : 'sap.ui.comp.smartfield.SmartField', function () { return editable; });
    return '<div class="sapUiFormElement sapUiAFLayoutItem" id="' + id + '-element">' + label + '<div id="' + id + '" data-sap-ui="' + id + '" class="sapUiCompSmartField" data-editable="' + editable + '">' + inner + '</div></div>';
  }

  function wireControls(root, app, meta) {
    root.querySelectorAll('.sapMComboBox').forEach(function (cb) {
      var input = cb.querySelector('input');
      var prop = input.id.replace(/^.*--/, '').replace(/-input-inner$/, '');
      var open = function () {
        closePopups();
        valueHelp(app, meta[prop]).then(function (rows) {
          var pop = document.createElement('div');
          pop.className = 'sapMPopover sapMComboBoxBasePicker'; pop.id = input.id.replace('-inner', '-popup'); pop.setAttribute('role', 'dialog');
          pop.innerHTML = '<ul class="sapMSelectList" role="listbox">' + rows.map(function (r) { return '<li class="sapMSelectListItemBase sapMComboBoxItem" role="option" data-key="' + esc(r.key) + '">' + esc(r.text + ' (' + r.key + ')') + '</li>'; }).join('') + '</ul>';
          document.body.appendChild(pop);
          input.setAttribute('aria-expanded', 'true');
          pop.querySelectorAll('li').forEach(function (li) { li.addEventListener('click', function () { input.dataset.key = li.dataset.key; input.value = li.textContent; input.setAttribute('aria-expanded', 'false'); pop.remove(); }); });
        });
      };
      cb.querySelector('.sapMInputBaseIcon').addEventListener('click', open);
      input.addEventListener('change', function () {
        var vh = vhCache[app.service + '/' + meta[prop].collection] || [];
        var t = input.value.trim().toLowerCase();
        var hit = vh.filter(function (r) { return r.key.toLowerCase() === t || r.text.toLowerCase() === t || (r.text + ' (' + r.key + ')').toLowerCase() === t; })[0];
        input.dataset.key = hit ? hit.key : '';
        if (hit) input.value = hit.text + ' (' + hit.key + ')';
      });
    });
    root.querySelectorAll('[id$="-input-vhi"]').forEach(function (icon) {
      icon.addEventListener('click', function () {
        var input = document.getElementById(icon.id.replace('-vhi', '-inner'));
        var prop = input.id.replace(/^.*--/, '').replace(/-input-inner$/, '');
        openValueHelp(app, meta, prop, input);
      });
    });
  }

  function openValueHelp(app, meta, prop, input) {
    closePopups();
    var p = meta[prop];
    valueHelp(app, p).then(function (rows) {
      var d = document.createElement('div');
      d.className = 'sapMDialog sapUiCompValueHelpDialog'; d.id = 'vhd--' + prop; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', p.label);
      var render = function (q) {
        q = (q || '').toLowerCase();
        var hit = rows.filter(function (r) { return !q || r.key.toLowerCase().indexOf(q) >= 0 || r.text.toLowerCase().indexOf(q) >= 0; });
        d.querySelector('tbody').innerHTML = hit.map(function (r) { return '<tr class="sapMLIB sapMListTblRow" data-key="' + esc(r.key) + '"><td class="sapMListTblCell">' + esc(r.key) + '</td><td class="sapMListTblCell">' + esc(r.text) + '</td></tr>'; }).join('');
        d.querySelectorAll('tbody tr').forEach(function (tr) { tr.addEventListener('click', function () { d.querySelectorAll('tbody tr').forEach(function (x) { x.classList.remove('sapMLIBSelected'); x.setAttribute('aria-selected', 'false'); }); tr.classList.add('sapMLIBSelected'); tr.setAttribute('aria-selected', 'true'); }); });
      };
      d.innerHTML = '<header class="sapMDialogTitle"><h1 class="sapMTitle"><span>' + esc(p.label) + '</span></h1></header><div class="sapMSF"><input class="sapMSFI" type="search" placeholder="Search" id="vhd--' + prop + '-search"><button class="sapMBtn" id="vhd--' + prop + '-go"><bdi>Go</bdi></button></div>' +
        '<table class="sapMListTbl" role="grid"><thead><tr><th class="sapMListTblHeaderCell"><span class="sapMColumnHeader">Key</span></th><th class="sapMListTblHeaderCell"><span class="sapMColumnHeader">Description</span></th></tr></thead><tbody></tbody></table>' +
        '<footer class="sapMDialogFooter"><button class="sapMBtn" id="vhd--' + prop + '-ok"><bdi>OK</bdi></button><button class="sapMBtn" id="vhd--' + prop + '-cancel"><bdi>Cancel</bdi></button></footer>';
      document.body.appendChild(d);
      render('');
      d.querySelector('[id$="-go"]').addEventListener('click', function () { render(d.querySelector('.sapMSFI').value); });
      d.querySelector('[id$="-ok"]').addEventListener('click', function () { var sel = d.querySelector('tr.sapMLIBSelected'); if (sel) input.value = sel.dataset.key; d.remove(); });
      d.querySelector('[id$="-cancel"]').addEventListener('click', function () { d.remove(); });
    });
  }
  function closePopups() { document.querySelectorAll('.sapMComboBoxBasePicker, .sapUiCompValueHelpDialog, .sapMMsgPopover').forEach(function (x) { x.remove(); }); }

  function toast(text) {
    var t = document.createElement('div');
    t.className = 'sapMMessageToast sapUiSelectable'; t.setAttribute('role', 'alert'); t.textContent = text;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }

  // ---------------------------------------------------------------- pages
  function setTitle(t) { $('#shellAppTitle bdi').textContent = t; document.title = t; }
  function home() {
    current = null; registry = {};
    setTitle('Home');
    container().innerHTML = '<div class="sapUshellTileContainer" id="tiles" role="list">' + CFG.tiles.map(function (t) {
      return '<div class="sapUshellTile sapMGT" role="link" tabindex="0" aria-label="' + esc(t.title) + '" data-intent="' + t.intent + '"><div class="sapMGTHdrTxt sapUshellTileTitle">' + esc(t.title) + '</div><div class="sapMGTSubHdrTxt">' + esc(t.subtitle) + '</div></div>';
    }).join('') + '</div>';
    container().querySelectorAll('.sapUshellTile').forEach(function (t) { t.addEventListener('click', function () { location.hash = t.dataset.intent; }); });
  }

  function listReport(intent, app) {
    registry = {};
    setTitle(app.title);
    busy(true);
    loadMeta(app).then(function (all) {
      var meta = all[app.set];
      var vhs = Object.keys(meta).filter(function (k) { return meta[k].collection; }).map(function (k) { return valueHelp(app, meta[k]); });
      return Promise.all(vhs).then(function () { return meta; });
    }).then(function (meta) {
      var id = 'listReport';
      var fmeta = {};
      Object.keys(meta).forEach(function (k) { fmeta[k] = Object.assign({}, meta[k], { creatable: true, required: false }); });
      container().innerHTML = '<div class="sapFDynamicPage" id="' + id + '"><div class="sapUiCompSmartFilterBar" id="' + id + '--smartFilterBar" data-sap-ui="' + id + '--smartFilterBar">' +
        app.filters.map(function (f) { return fieldHtml(app, fmeta, f, '', 'create', id + '--sfb'); }).join('') +
        '<button class="sapMBtn" id="' + id + '--btnGo"><span class="sapMBtnContent"><bdi>Go</bdi></span></button></div>' +
        '<div class="sapMTB sapMOTB" role="toolbar"><span class="sapMTitle" id="' + id + '--tableTitle">' + esc(app.entityLabel) + 's</span>' + (app.canCreate ? '<button class="sapMBtn" id="' + id + '--addEntry"><span class="sapMBtnContent"><bdi>Create</bdi></span></button>' : '') + '</div>' +
        '<table class="sapMListTbl" id="' + id + '--responsiveTable" role="grid"><thead><tr>' + app.columns.map(function (c) { return '<th class="sapMListTblHeaderCell" data-prop="' + c + '"><span class="sapMColumnHeader"><span class="sapMLabelTextWrapper"><bdi>' + esc(meta[c].label) + '</bdi></span></span></th>'; }).join('') + '</tr></thead><tbody></tbody></table><div class="sapMListNoData" style="display:none">No data found</div></div>';
      wireControls(container(), app, meta);
      var search = function () {
        var terms = [];
        container().querySelectorAll('#' + id + '--smartFilterBar input.sapMInputBaseInner').forEach(function (inp) {
          var prop = inp.id.replace(/^.*--/, '').replace(/-input-inner$/, '');
          var v = inp.getAttribute('role') === 'combobox' ? (inp.dataset.key || '') : inp.value.trim();
          if (v) terms.push(prop + " eq '" + v.replace(/'/g, "''") + "'");
        });
        busy(true);
        odata(app, 'GET', app.set + (terms.length ? '?$filter=' + encodeURIComponent(terms.join(' and ')) : '')).then(function (r) { return r.json(); }).then(function (j) {
          var rows = rowsOf(app, j);
          var tb = container().querySelector('tbody');
          tb.innerHTML = rows.map(function (r) {
            return '<tr class="sapMLIB sapMListTblRow sapMLIBTypeNavigation" tabindex="0" data-key="' + esc(r[app.key]) + '">' + app.columns.map(function (c) { return '<td class="sapMListTblCell"><span class="sapMText">' + esc(displayOf(app, meta, c, fromV2(r[c]))) + '</span></td>'; }).join('') + '</tr>';
          }).join('');
          container().querySelector('.sapMListNoData').style.display = rows.length ? 'none' : '';
          tb.querySelectorAll('tr').forEach(function (tr) { tr.addEventListener('click', function () { location.hash = intent + "&/" + app.set + "('" + tr.dataset.key + "')"; }); });
          busy(false);
        });
      };
      $('#' + id + '--btnGo').addEventListener('click', search);
      var add = $('#' + id + '--addEntry');
      if (add) add.addEventListener('click', function () { location.hash = intent + "&/" + app.set + "('new')"; });
      search();
    });
  }

  function objectPage(intent, app, key, mode) {
    registry = {};
    busy(true);
    loadMeta(app).then(function (all) {
      var meta = all[app.set];
      var vhs = Object.keys(meta).filter(function (k) { return meta[k].collection; }).map(function (k) { return valueHelp(app, meta[k]); });
      var rec = key === 'new' ? Promise.resolve({}) : odata(app, 'GET', app.set + "('" + encodeURIComponent(key) + "')").then(function (r) { return r.json(); }).then(function (j) { return rowsOf(app, j)[0]; });
      return Promise.all([rec].concat(vhs)).then(function (x) { return { meta: meta, rec: x[0] }; });
    }).then(function (x) {
      var meta = x.meta, rec = x.rec;
      var m = key === 'new' ? 'create' : mode;
      var id = 'objectPage';
      var vals = {}; Object.keys(meta).forEach(function (k) { vals[k] = fromV2(rec[k]); });
      setTitle(app.title);
      var title = key === 'new' ? 'New ' + app.entityLabel : app.header(vals);
      container().innerHTML = '<div class="sapUxAPObjectPageLayout" id="' + id + '"><header class="sapUxAPObjectPageHeader"><h2 class="sapUxAPObjectPageHeaderIdentifierTitle" id="' + id + '--title"><span>' + esc(title) + '</span></h2>' +
        (m === 'display' && app.canEdit !== false ? '<button class="sapMBtn" id="' + id + '--edit"><span class="sapMBtnContent"><bdi>Edit</bdi></span></button>' : '') + '</header>' +
        '<section class="sapUxAPObjectPageSection" id="' + id + '--generalInfo"><h3 class="sapUxAPObjectPageSectionTitle">General Information</h3><div class="sapUiForm" role="form">' +
        app.form.map(function (f) { return fieldHtml(app, meta, f, vals[f], m, id + '--' + (m === 'display' ? 'disp' : 'edit')); }).join('') + '</div></section>' +
        (m !== 'display' ? '<footer class="sapUxAPObjectPageFloatingFooter sapMTB" role="toolbar"><button class="sapMBtn sapMBtnNegative" id="' + id + '--showMessages" style="display:none"><span class="sapUiIcon" data-sap-ui-icon-content="message-popup"></span><bdi></bdi></button>' +
          '<button class="sapMBtn sapMBtnEmphasized" id="' + id + '--save"><span class="sapMBtnContent"><bdi>' + (m === 'create' ? 'Create' : 'Save') + '</bdi></span></button><button class="sapMBtn" id="' + id + '--cancel"><span class="sapMBtnContent"><bdi>Cancel</bdi></span></button></footer>' : '') + '</div>';
      wireControls(container(), app, meta);
      busy(false);
      var edit = $('#' + id + '--edit');
      if (edit) edit.addEventListener('click', function () { objectPage(intent, app, key, 'edit'); });
      var cancel = $('#' + id + '--cancel');
      if (cancel) cancel.addEventListener('click', function () { if (key === 'new') location.hash = intent; else objectPage(intent, app, key, 'display'); });
      var save = $('#' + id + '--save');
      if (save) save.addEventListener('click', function () {
        closePopups();
        container().querySelectorAll('.sapMInputBaseContentWrapperError').forEach(function (w) { w.classList.remove('sapMInputBaseContentWrapperError'); w.querySelector('input').removeAttribute('aria-invalid'); });
        var payload = {}; var bad = [];
        app.form.forEach(function (f) {
          var inp = document.getElementById(id + '--edit--' + f + '-input-inner');
          if (!inp) return;
          var v = inp.getAttribute('role') === 'combobox' ? (inp.dataset.key || '') : inp.value.trim();
          if (meta[f].type === 'Edm.DateTime' || meta[f].type === 'Edm.Date') {
            var d = parseDate(v);
            if (d === null) { bad.push({ target: f, message: 'Enter a valid date', severity: 'error' }); return; }
            v = d;
            if (svcInfo(app).version === 2) { payload[f] = v ? '/Date(' + Date.parse(v + 'T00:00:00Z') + ')/' : null; return; }
          }
          payload[f] = v;
        });
        var showMessages = function (items) {
          var btn = $('#' + id + '--showMessages');
          btn.style.display = ''; btn.querySelector('bdi').textContent = String(items.length);
          items.forEach(function (it) { var inp = document.getElementById(id + '--edit--' + it.target + '-input-inner'); if (inp) { inp.parentNode.classList.add('sapMInputBaseContentWrapperError'); inp.setAttribute('aria-invalid', 'true'); } });
          var pop = document.createElement('div');
          pop.className = 'sapMPopover sapMMsgPopover'; pop.setAttribute('role', 'dialog'); pop.id = id + '--messagePopover';
          pop.innerHTML = '<ul class="sapMListUl" role="list">' + items.map(function (it) { var lbl = meta[it.target] ? meta[it.target].label : ''; return '<li class="sapMLIB sapMMsgViewItem sapMMsgViewItem' + (it.severity === 'error' ? 'Error' : 'Warning') + '" data-target="' + esc(it.target) + '"><div class="sapMSLITitleOnly">' + esc(it.message) + '</div><div class="sapMSLIDescription">' + esc(lbl) + '</div></li>'; }).join('') + '</ul>';
          document.body.appendChild(pop);
          btn.onclick = function () { if (!document.getElementById(pop.id)) document.body.appendChild(pop); };
        };
        if (bad.length) return showMessages(bad);
        busy(true);
        var req = key === 'new' ? odata(app, 'POST', app.set, payload) : odata(app, 'PATCH', app.set + "('" + encodeURIComponent(key) + "')", payload);
        req.then(function (r) {
          busy(false);
          if (r.ok) {
            return (r.status === 204 ? Promise.resolve(null) : r.json()).then(function (j) {
              var newKey = key === 'new' && j ? rowsOf(app, j)[0][app.key] : key;
              toast(key === 'new' ? app.entityLabel + ' ' + newKey + ' created' : 'Your changes have been saved.');
              if (key === 'new') location.hash = intent + "&/" + app.set + "('" + newKey + "')";
              else objectPage(intent, app, key, 'display');
            });
          }
          return r.json().then(function (j) {
            var e = j.error || {};
            var details = (e.innererror && e.innererror.errordetails) || e.details || [];
            if (!details.length) details = [{ target: e.target || '', message: (e.message && e.message.value) || e.message || 'Error', severity: 'error' }];
            showMessages(details.map(function (d) { return { target: d.target, message: d.message, severity: d.severity || 'error' }; }));
          });
        });
      });
    });
  }

  function route() {
    closePopups();
    var h = location.hash.slice(1) || 'Shell-home';
    var parts = h.split('&/');
    var intent = parts[0];
    var app = APPS[intent];
    if (!app || !CFG.tiles.some(function (t) { return t.intent === intent; })) {
      if (intent !== 'Shell-home') { container().innerHTML = '<div class="sapMMessagePage" role="alert"><span class="sapMMessagePageMainText">Could not open app. You are not authorized to use this app or it does not exist.</span></div>'; setTitle('Error'); current = null; return; }
      return home();
    }
    current = { app: app, intent: intent };
    if (parts[1]) {
      var m = /^\w+\('([^']*)'\)$/.exec(parts[1]);
      return objectPage(intent, app, m ? decodeURIComponent(m[1]) : '', 'display');
    }
    listReport(intent, app);
  }
  window.addEventListener('hashchange', route);
  route();
  counter++;
})();
