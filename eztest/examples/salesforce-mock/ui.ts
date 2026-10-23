/**
 * Lightning Experience-like pages for the Salesforce mock. Every Lightning
 * component is a real custom element with an OPEN shadow root (lightning-input,
 * lightning-combobox, lightning-grouped-combobox, lightning-textarea,
 * lightning-datatable, lightning-path, records-highlights2, ...), so the
 * adapter's locators have to pierce shadow DOM exactly as they do in a real org.
 *
 * Pages are rendered from a JSON bootstrap (#sf-page); all user data is
 * inserted with textContent, never as HTML.
 */

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function formatCurrency(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** YYYY-MM-DD -> M/D/YYYY (en_US Lightning short date). */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]}` : iso;
}

export interface UiField {
  name: string;
  label: string;
  type: string;
  required: boolean;
  access: 'edit' | 'read';
  system: boolean;
  picklist?: Array<{ value: string; label: string; validFor?: string[] }>;
  controllerName?: string;
  referenceTo?: string;
  referencePlural?: string;
}

export interface UiRow {
  id: string;
  url: string;
  cells: Record<string, string>;
}

export interface PageData {
  kind: 'home' | 'list' | 'record' | 'error';
  title: string;
  user: { name: string; username: string };
  nav: Array<{ object: string; label: string; url: string }>;
  launcher: Array<{ object: string; label: string; url: string }>;
  object?: { name: string; label: string; labelPlural: string; canCreate: boolean; canDelete: boolean; nameField: string };
  fields?: UiField[];
  record?: { id: string; name: string; values: Record<string, unknown>; display: Record<string, string>; links: Record<string, string> };
  highlights?: string[];
  listView?: { name: string; columns: Array<{ field: string; label: string }> };
  related?: Array<{ label: string; columns: Array<{ field: string; label: string }>; rows: UiRow[] }>;
  path?: { field: string; stages: string[]; current: string };
  modal?: { mode: 'new' | 'edit'; backUrl: string };
  error?: { title: string; message: string };
}

const STYLE = `
*{box-sizing:border-box} body{font-family:Salesforce Sans,Arial,sans-serif;margin:0;background:#f3f3f3;color:#181818}
header.slds-global-header{background:#fff;padding:8px 16px;display:flex;justify-content:space-between;border-bottom:1px solid #ddd}
main{padding:12px 16px}
`;

const LOGIN_STYLE = `body{font-family:Arial,sans-serif;background:#f4f6f9;display:flex;justify-content:center;padding-top:60px}
#login_form{background:#fff;padding:24px;border:1px solid #ddd;border-radius:4px;width:340px} label{display:block;margin-top:12px}
input.input{width:100%;padding:8px} #Login{margin-top:16px;width:100%;padding:10px;background:#0070d2;color:#fff;border:0}
#error{color:#c23934;margin-bottom:8px}`;

export function renderLogin(o: { error?: string; username?: string; startUrl?: string } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Login | Salesforce</title><style>${LOGIN_STYLE}</style></head>
<body><div id="content"><form id="login_form" name="login" method="post" action="/login" autocomplete="off">
<h1>Log In</h1>
${o.error ? `<div id="error" class="loginError" role="alert">${esc(o.error)}</div>` : ''}
<input type="hidden" name="startURL" value="${esc(o.startUrl ?? '')}">
<label for="username" class="label usernamelabel">Username</label>
<input class="input r4 wide mb16 mt8 username" type="email" id="username" name="username" value="${esc(o.username ?? '')}">
<label for="password" class="label">Password</label>
<input class="input r4 wide mb16 mt8 password" type="password" id="password" name="pw" autocomplete="off">
<input class="button r4 wide primary" type="submit" id="Login" name="Login" value="Log In">
</form></div></body></html>`;
}

export function renderPage(data: PageData): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  let body = '';
  switch (data.kind) {
    case 'home':
      body = '<h1 class="slds-page-header__title">Home</h1><p>Welcome to Sales.</p>';
      break;
    case 'list':
      body = '<lst-list-view-manager-header></lst-list-view-manager-header><lightning-datatable></lightning-datatable>';
      break;
    case 'record':
      body = '<records-highlights2></records-highlights2>' + (data.path ? '<lightning-path></lightning-path>' : '') +
        '<div class="record-body"><records-lwc-detail-panel></records-lwc-detail-panel><div class="related">' +
        (data.related ?? []).map((_, i) => `<force-related-list-single-container data-index="${i}"></force-related-list-single-container>`).join('') + '</div></div>';
      break;
    case 'error':
      body = `<div class="slds-illustration" role="alert"><h2 class="slds-text-heading_medium">${esc(data.error?.title)}</h2><p class="slds-text-body_regular">${esc(data.error?.message)}</p></div>`;
      break;
  }
  if (data.modal) body += '<force-record-edit-modal></force-record-edit-modal>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(data.title)} | Salesforce</title><style>${STYLE}</style></head>
<body class="desktop">
<header class="slds-global-header" role="banner"><span class="slds-global-header__logo">Salesforce</span>
<span class="userProfile"><span class="uiImage" title="View profile">${esc(data.user.name)}</span></span></header>
<one-app-nav-bar></one-app-nav-bar>
<main role="main" class="oneContent">${body}</main>
<force-visual-message-queue></force-visual-message-queue>
<script type="application/json" id="sf-page">${json}</script>
<script>${CLIENT_JS}</script></body></html>`;
}

/* The client runtime. Written with String.raw so regexes need no double escaping; never uses template placeholders. */
const CLIENT_JS = String.raw`
(function(){
var SF = JSON.parse(document.getElementById('sf-page').textContent);
window.SF = SF;
var uid = 0;
function h(tag, attrs, text){ var e = document.createElement(tag); if (attrs) Object.keys(attrs).forEach(function(k){ if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) e.setAttribute(k, attrs[k] === true ? '' : String(attrs[k])); }); if (text !== undefined && text !== null) e.textContent = String(text); return e; }
function css(root, text){ var s = document.createElement('style'); s.textContent = text; root.appendChild(s); }
function post(url, body){ return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function(r){ return r.json().then(function(b){ return { ok: r.ok, status: r.status, body: b }; }); }); }
var BASE = '.slds-button{cursor:pointer;padding:4px 12px;border:1px solid #c9c9c9;border-radius:4px;background:#fff;color:#0176d3;font:inherit}.slds-button_brand{background:#0176d3;color:#fff}.slds-form-element{margin:6px 0}.slds-form-element__label{display:inline-block;color:#444;margin-bottom:2px}.slds-required{color:#ba0517;margin-right:2px;text-decoration:none}.slds-input,.slds-textarea{width:100%;padding:6px;border:1px solid #c9c9c9;border-radius:4px;font:inherit}.slds-form-element__help{color:#ba0517;font-size:12px}[hidden]{display:none!important}';

/* ---------------------------------------------------------------- toasts */
customElements.define('force-visual-message-queue', class extends HTMLElement {
  connectedCallback(){
    if (this.shadowRoot) return;
    var root = this.attachShadow({ mode: 'open' });
    css(root, BASE + '.toastContainer{position:fixed;top:56px;left:50%;transform:translateX(-50%);z-index:100}.forceToastMessage{min-width:360px;padding:12px 16px;margin:4px;border-radius:4px;color:#fff;display:flex;justify-content:space-between}.slds-theme_success{background:#2e844a}.slds-theme_error{background:#ba0517}');
    this.box = h('div', { 'class': 'toastContainer slds-notify_container', role: 'status' });
    root.appendChild(this.box);
    var pending = null;
    try { pending = JSON.parse(sessionStorage.getItem('sf-toast') || 'null'); sessionStorage.removeItem('sf-toast'); } catch (e) { pending = null; }
    if (pending) this.show(pending.type, pending.message);
  }
  show(type, message){
    var t = h('div', { 'class': 'slds-notify slds-notify_toast forceToastMessage slds-theme_' + type, role: 'alert', 'data-key': type });
    var c = h('div', { 'class': 'toastContent' });
    c.appendChild(h('span', { 'class': 'toastMessage slds-text-heading--small forceActionsText' }, message));
    t.appendChild(c);
    var close = h('button', { 'class': 'slds-button toastClose', title: 'Close', 'aria-label': 'Close' }, 'x');
    close.addEventListener('click', function(){ t.remove(); });
    t.appendChild(close);
    this.box.appendChild(t);
    if (type === 'success') setTimeout(function(){ t.remove(); }, 15000);
  }
});
function toast(type, message){ document.querySelector('force-visual-message-queue').show(type, message); }

/* ---------------------------------------------------------------- navigation */
customElements.define('one-app-nav-bar', class extends HTMLElement {
  connectedCallback(){
    if (this.shadowRoot) return;
    var root = this.attachShadow({ mode: 'open' });
    css(root, BASE + 'nav{display:flex;align-items:center;gap:16px;background:#fff;padding:6px 16px;border-bottom:3px solid #0176d3}ul{display:flex;list-style:none;margin:0;padding:0;gap:12px}a{color:#181818;text-decoration:none}.appLauncherMenu{position:absolute;top:90px;left:16px;background:#fff;border:1px solid #ccc;padding:12px;width:420px;z-index:50}.appLauncherMenu li{display:block;padding:4px}');
    var nav = h('nav', { role: 'navigation', 'aria-label': 'Global', 'class': 'slds-context-bar' });
    var launcher = h('div', { 'class': 'appLauncher slds-context-bar__icon-action' });
    var btn = h('button', { 'class': 'slds-button slds-icon-waffle_container', title: 'App Launcher', 'aria-label': 'App Launcher', 'aria-haspopup': 'dialog' }, ':::');
    launcher.appendChild(btn);
    nav.appendChild(launcher);
    nav.appendChild(h('span', { 'class': 'appName slds-context-bar__label-action', title: 'Sales' }, 'Sales'));
    var ul = h('ul', { 'class': 'slds-grid', role: 'list' });
    var home = h('li', { 'class': 'slds-context-bar__item', 'data-id': 'home' });
    home.appendChild(h('a', { href: '/lightning/page/home', title: 'Home' }, 'Home'));
    ul.appendChild(home);
    SF.nav.forEach(function(t){
      var li = h('li', { 'class': 'slds-context-bar__item', 'data-id': t.object });
      if (location.pathname.indexOf('/lightning/o/' + t.object + '/') === 0 || location.pathname.indexOf('/lightning/r/' + t.object + '/') === 0) li.classList.add('slds-is-active');
      var a = h('a', { href: t.url, title: t.label, 'class': 'slds-context-bar__label-action' });
      a.appendChild(h('span', { 'class': 'slds-truncate' }, t.label));
      li.appendChild(a);
      ul.appendChild(li);
    });
    nav.appendChild(ul);
    root.appendChild(nav);
    var dlg = h('div', { role: 'dialog', 'aria-label': 'App Launcher', 'class': 'appLauncherMenu', hidden: true });
    var search = h('input', { type: 'search', 'class': 'slds-input', placeholder: 'Search apps and items...', 'aria-label': 'Search apps and items...' });
    var list = h('ul', { role: 'listbox', 'aria-label': 'Items' });
    dlg.appendChild(search);
    dlg.appendChild(list);
    root.appendChild(dlg);
    function render(){
      list.innerHTML = '';
      var q = search.value.trim().toLowerCase();
      SF.launcher.filter(function(i){ return !q || i.label.toLowerCase().indexOf(q) >= 0; }).forEach(function(i){
        var li = h('li', { role: 'option', 'class': 'slds-listbox__item' });
        var a = h('a', { href: i.url, 'data-label': i.label, title: i.label, 'class': 'al-menu-dropdown-list-item' });
        a.appendChild(h('b', null, i.label));
        li.appendChild(a);
        list.appendChild(li);
      });
    }
    btn.addEventListener('click', function(){ dlg.hidden = !dlg.hidden; if (!dlg.hidden) { search.value = ''; render(); search.focus(); } });
    search.addEventListener('input', function(){ setTimeout(render, 120); });
  }
});

/* ---------------------------------------------------------------- base components */
function formElement(root, label, required, forId){
  var wrap = h('div', { 'class': 'slds-form-element' });
  var lab = h('label', { 'class': 'slds-form-element__label', id: 'label-' + forId, 'for': forId });
  if (required) lab.appendChild(h('abbr', { 'class': 'slds-required', title: 'required' }, '*'));
  lab.appendChild(document.createTextNode(label));
  wrap.appendChild(lab);
  var control = h('div', { 'class': 'slds-form-element__control' });
  wrap.appendChild(control);
  var help = h('div', { 'class': 'slds-form-element__help', id: 'help-message-' + forId, 'aria-live': 'assertive', hidden: true });
  wrap.appendChild(help);
  root.appendChild(wrap);
  return { wrap: wrap, control: control, help: help, label: lab };
}
var ErrorMixin = {
  setError: function(msg){ this._help.textContent = msg || ''; this._help.hidden = !msg; if (msg) this.setAttribute('data-invalid', ''); else this.removeAttribute('data-invalid'); }
};

class LightningInput extends HTMLElement {
  connectedCallback(){
    if (this.shadowRoot) return;
    var root = this.attachShadow({ mode: 'open' });
    css(root, BASE);
    var id = 'input-' + (++uid);
    var type = this.getAttribute('type') || 'text';
    var label = this.getAttribute('label') || '';
    if (type === 'checkbox') {
      var wrap = h('div', { 'class': 'slds-form-element' });
      var span = h('span', { 'class': 'slds-checkbox' });
      this._input = h('input', { type: 'checkbox', id: id, name: this.getAttribute('field-name') });
      var lab = h('label', { 'class': 'slds-checkbox__label', 'for': id });
      lab.appendChild(h('span', { 'class': 'slds-checkbox_faux' }));
      lab.appendChild(h('span', { 'class': 'slds-form-element__label' }, label));
      span.appendChild(this._input); span.appendChild(lab); wrap.appendChild(span);
      this._help = h('div', { 'class': 'slds-form-element__help', hidden: true });
      wrap.appendChild(this._help);
      root.appendChild(wrap);
      this._input.checked = this.getAttribute('value') === 'true';
    } else {
      var f = formElement(root, label, this.hasAttribute('required'), id);
      this._help = f.help;
      this._input = h('input', { 'class': 'slds-input', id: id, type: 'text', name: this.getAttribute('field-name'), 'aria-describedby': 'help-message-' + id, inputmode: type === 'number' ? 'decimal' : null, placeholder: type === 'date' ? 'M/D/YYYY' : null });
      if (this.hasAttribute('required')) this._input.required = true;
      f.control.appendChild(this._input);
      this._input.value = this.getAttribute('value') || '';
    }
    var self = this;
    this._input.addEventListener('change', function(){ self.setError(''); self.dispatchEvent(new CustomEvent('change', { bubbles: true, composed: true, detail: { value: self.value } })); });
  }
  get value(){ if (!this._input) return null; return this._input.type === 'checkbox' ? this._input.checked : this._input.value; }
}
Object.assign(LightningInput.prototype, ErrorMixin);
customElements.define('lightning-input', LightningInput);

class LightningTextarea extends HTMLElement {
  connectedCallback(){
    if (this.shadowRoot) return;
    var root = this.attachShadow({ mode: 'open' });
    css(root, BASE);
    var id = 'textarea-' + (++uid);
    var f = formElement(root, this.getAttribute('label') || '', this.hasAttribute('required'), id);
    this._help = f.help;
    this._input = h('textarea', { 'class': 'slds-textarea', id: id, name: this.getAttribute('field-name') });
    this._input.value = this.getAttribute('value') || '';
    f.control.appendChild(this._input);
  }
  get value(){ return this._input ? this._input.value : null; }
}
Object.assign(LightningTextarea.prototype, ErrorMixin);
customElements.define('lightning-textarea', LightningTextarea);

class LightningCombobox extends HTMLElement {
  connectedCallback(){
    if (this.shadowRoot) return;
    var root = this.attachShadow({ mode: 'open' });
    css(root, BASE + '.slds-combobox__input{width:100%;text-align:left;padding:6px;border:1px solid #c9c9c9;background:#fff;border-radius:4px;color:#181818}.slds-dropdown{position:absolute;background:#fff;border:1px solid #ccc;min-width:240px;z-index:20;max-height:260px;overflow:auto}lightning-base-combobox-item{display:block;padding:4px 8px;cursor:pointer}lightning-base-combobox-item:hover{background:#eef4ff}');
    var id = 'combobox-button-' + (++uid);
    var f = formElement(root, this.getAttribute('label') || '', this.hasAttribute('required'), id);
    f.label.removeAttribute('for');
    this._help = f.help;
    var container = h('div', { 'class': 'slds-combobox_container' });
    this._box = h('div', { 'class': 'slds-combobox slds-dropdown-trigger', 'aria-expanded': 'false', style: 'position:relative' });
    this._button = h('button', { type: 'button', role: 'combobox', id: id, 'class': 'slds-combobox__input slds-input_faux', 'aria-labelledby': 'label-' + id, 'aria-haspopup': 'listbox', 'aria-expanded': 'false', name: this.getAttribute('field-name') });
    this._text = h('span', { 'class': 'slds-truncate' });
    this._button.appendChild(this._text);
    this._list = h('div', { role: 'listbox', 'class': 'slds-dropdown slds-dropdown_fluid', id: 'dropdown-' + id, 'aria-label': this.getAttribute('label') || '', hidden: true });
    this._box.appendChild(this._button); this._box.appendChild(this._list); container.appendChild(this._box); f.control.appendChild(container);
    var self = this;
    this._value = this.getAttribute('value') || '';
    this._options = [];
    try { this._options = JSON.parse(this.getAttribute('options') || '[]'); } catch (e) { this._options = []; }
    this._button.addEventListener('click', function(){ if (self._button.disabled) return; self.toggle(self._list.hidden); });
    this.disabled = this.hasAttribute('disabled');
    this.render();
  }
  toggle(open){ this._list.hidden = !open; this._button.setAttribute('aria-expanded', String(open)); this._box.setAttribute('aria-expanded', String(open)); }
  set disabled(v){ if (this._button) { this._button.disabled = !!v; if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); } }
  get disabled(){ return this._button ? this._button.disabled : false; }
  set options(list){ this._options = list || []; if (this._value && !this._options.some(function(o){ return o.value === this._value; }, this)) this._value = ''; if (this._list) this.render(); }
  get options(){ return this._options; }
  get value(){ return this._value || null; }
  render(){
    var self = this;
    this._list.innerHTML = '';
    var all = (this.hasAttribute('required') ? [] : [{ value: '', label: '--None--' }]).concat(this._options);
    all.forEach(function(o){
      var item = h('lightning-base-combobox-item', { role: 'option', 'data-value': o.value, 'aria-checked': String(o.value === self._value), 'class': 'slds-listbox__item' });
      var body = h('span', { 'class': 'slds-media__body' });
      body.appendChild(h('span', { 'class': 'slds-truncate', title: o.label }, o.label));
      item.appendChild(body);
      item.addEventListener('click', function(){
        self._value = o.value; self.toggle(false); self.render(); self.setError('');
        self.dispatchEvent(new CustomEvent('change', { bubbles: true, composed: true, detail: { value: o.value } }));
      });
      self._list.appendChild(item);
    });
    var cur = this._options.filter(function(o){ return o.value === self._value; })[0];
    this._text.textContent = cur ? cur.label : '--None--';
    this._button.setAttribute('data-value', this._value || '');
  }
}
Object.assign(LightningCombobox.prototype, ErrorMixin);
customElements.define('lightning-combobox', LightningCombobox);

class LightningGroupedCombobox extends HTMLElement {
  connectedCallback(){
    if (this.shadowRoot) return;
    var root = this.attachShadow({ mode: 'open' });
    css(root, BASE + '.slds-dropdown{position:absolute;background:#fff;border:1px solid #ccc;min-width:300px;z-index:20}lightning-base-combobox-item{display:block;padding:4px 8px;cursor:pointer}.slds-listbox__option-meta{display:block;color:#666;font-size:12px}');
    var id = 'combobox-input-' + (++uid);
    var target = this.getAttribute('reference-to') || '';
    var plural = this.getAttribute('reference-plural') || target;
    var f = formElement(root, this.getAttribute('label') || '', this.hasAttribute('required'), id);
    this._help = f.help;
    var container = h('div', { 'class': 'slds-combobox_container' });
    var box = h('div', { 'class': 'slds-combobox slds-dropdown-trigger', style: 'position:relative' });
    this._input = h('input', { type: 'text', id: id, role: 'combobox', 'class': 'slds-input slds-combobox__input', 'aria-autocomplete': 'list', 'aria-expanded': 'false', autocomplete: 'off', placeholder: 'Search ' + plural + '...', name: this.getAttribute('field-name') });
    this._clear = h('button', { type: 'button', 'class': 'slds-button slds-input__icon', title: 'Clear Selection', 'aria-label': 'Clear Selection', hidden: true }, 'x');
    this._list = h('div', { role: 'listbox', 'class': 'slds-dropdown', 'aria-label': 'Search Results', 'aria-busy': 'false', hidden: true });
    box.appendChild(this._input); box.appendChild(this._clear); box.appendChild(this._list); container.appendChild(box); f.control.appendChild(container);
    var self = this, timer = null, seq = 0;
    this._id = this.getAttribute('value') || '';
    if (this._id) this.select(this._id, this.getAttribute('display-value') || '', true);
    this._clear.addEventListener('click', function(){ self._id = ''; self._input.readOnly = false; self._input.value = ''; self._input.removeAttribute('data-value'); self._clear.hidden = true; self._input.focus(); });
    this._input.addEventListener('input', function(){
      if (self._input.readOnly) return;
      clearTimeout(timer);
      var q = self._input.value, my = ++seq;
      self._list.hidden = false; self._list.setAttribute('aria-busy', 'true'); self._input.setAttribute('aria-expanded', 'true');
      self._list.innerHTML = '';
      timer = setTimeout(function(){
        fetch('/_ui/lookup?object=' + encodeURIComponent(target) + '&q=' + encodeURIComponent(q)).then(function(r){ return r.json(); }).then(function(rows){
          if (my !== seq) return;
          self._list.innerHTML = '';
          if (!rows.length) self._list.appendChild(h('div', { 'class': 'slds-listbox__item slds-text-color_weak', 'data-no-results': '' }, 'No results for "' + q + '"'));
          rows.forEach(function(r){
            var item = h('lightning-base-combobox-item', { role: 'option', 'data-value': r.id, 'aria-label': r.name, 'class': 'slds-listbox__item' });
            var main = h('span', { 'class': 'slds-listbox__option-text_entity' });
            main.appendChild(h('lightning-base-combobox-formatted-text', { title: r.name }, r.name));
            item.appendChild(main);
            item.appendChild(h('span', { 'class': 'slds-listbox__option-meta' }, r.meta));
            item.addEventListener('click', function(){ self.select(r.id, r.name, false); });
            self._list.appendChild(item);
          });
          self._list.setAttribute('aria-busy', 'false');
        });
      }, 200);
    });
  }
  select(id, name, silent){
    this._id = id; this._input.value = name; this._input.readOnly = true; this._input.setAttribute('data-value', id);
    this._clear.hidden = false; this._list.hidden = true; this._input.setAttribute('aria-expanded', 'false'); this.setError('');
    if (!silent) this.dispatchEvent(new CustomEvent('change', { bubbles: true, composed: true, detail: { value: id } }));
  }
  get value(){ return this._id || null; }
}
Object.assign(LightningGroupedCombobox.prototype, ErrorMixin);
customElements.define('lightning-grouped-combobox', LightningGroupedCombobox);

/* ---------------------------------------------------------------- list view */
customElements.define('lst-list-view-manager-header', class extends HTMLElement {
  connectedCallback(){
    if (this.shadowRoot) return;
    var root = this.attachShadow({ mode: 'open' });
    css(root, BASE + '.slds-page-header{background:#fff;padding:12px;border:1px solid #ddd;display:flex;justify-content:space-between}');
    var hd = h('div', { 'class': 'slds-page-header' });
    var left = h('div');
    left.appendChild(h('span', { 'class': 'entityNameTitle slds-breadcrumb__item' }, SF.object.labelPlural));
    var h1 = h('h1', { 'class': 'slds-page-header__title' });
    h1.appendChild(h('span', { 'class': 'triggerLinkText selectedListView' }, SF.listView.name));
    left.appendChild(h1);
    hd.appendChild(left);
    if (SF.object.canCreate) {
      var nb = h('a', { 'class': 'slds-button forceActionLink', role: 'button', title: 'New', href: '/lightning/o/' + SF.object.name + '/new' }, 'New');
      hd.appendChild(nb);
    }
    root.appendChild(hd);
  }
});

customElements.define('lightning-datatable', class extends HTMLElement {
  connectedCallback(){
    if (this.shadowRoot) return;
    var root = this.attachShadow({ mode: 'open' });
    css(root, BASE + 'table{border-collapse:collapse;background:#fff;width:100%}th,td{padding:6px 8px;border-bottom:1px solid #e5e5e5;text-align:left}.menu{position:absolute;background:#fff;border:1px solid #ccc;z-index:10}.menu a{display:block;padding:4px 12px;cursor:pointer}');
    var table = h('table', { role: 'grid', 'class': 'slds-table slds-table_bordered', 'aria-label': SF.listView.name, 'aria-busy': 'true' });
    var thead = h('thead'); var tr = h('tr');
    SF.listView.columns.forEach(function(c){ var th = h('th', { scope: 'col', 'aria-label': c.label, 'data-field': c.field }); th.appendChild(h('span', { 'class': 'slds-truncate', title: c.label }, c.label)); tr.appendChild(th); });
    tr.appendChild(h('th', { scope: 'col' }, ''));
    thead.appendChild(tr); table.appendChild(thead);
    var tbody = h('tbody'); table.appendChild(tbody);
    root.appendChild(table);
    setTimeout(function(){
      fetch('/_ui/list?object=' + encodeURIComponent(SF.object.name)).then(function(r){ return r.json(); }).then(function(data){
        data.rows.forEach(function(row){
          var r = h('tr', { 'data-row-key-value': row.id, 'class': 'slds-hint-parent' });
          SF.listView.columns.forEach(function(c, i){
            var cell = h(i === 0 ? 'th' : 'td', { 'data-label': c.label, scope: i === 0 ? 'row' : null, 'data-field': c.field });
            if (i === 0) cell.appendChild(h('a', { href: row.url, title: row.cells[c.field] || '', 'data-recordid': row.id }, row.cells[c.field] || ''));
            else cell.appendChild(h('lightning-primitive-cell-formatted', null, row.cells[c.field] || ''));
            r.appendChild(cell);
          });
          var act = h('td', { 'data-label': 'Actions', style: 'position:relative' });
          var btn = h('button', { 'class': 'slds-button slds-button_icon-border', 'aria-haspopup': 'true', title: 'Show Actions', 'aria-label': 'Show actions for ' + (row.cells[SF.listView.columns[0].field] || '') }, 'v');
          var menu = h('div', { role: 'menu', 'class': 'menu', hidden: true });
          var edit = h('a', { role: 'menuitem', title: 'Edit', href: '/lightning/r/' + SF.object.name + '/' + row.id + '/edit' }, 'Edit');
          menu.appendChild(edit);
          if (SF.object.canDelete) {
            var del = h('a', { role: 'menuitem', title: 'Delete' }, 'Delete');
            del.addEventListener('click', function(){ menu.hidden = true; confirmDelete(row.id, row.cells[SF.listView.columns[0].field] || '', location.pathname); });
            menu.appendChild(del);
          }
          btn.addEventListener('click', function(){ menu.hidden = !menu.hidden; });
          act.appendChild(btn); act.appendChild(menu); r.appendChild(act);
          tbody.appendChild(r);
        });
        table.setAttribute('aria-rowcount', String(data.rows.length));
        table.setAttribute('aria-busy', 'false');
      });
    }, 150);
  }
});

function confirmDelete(id, name, backUrl){
  var host = document.createElement('div');
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: 'open' });
  css(root, BASE + 'section{position:fixed;top:30%;left:30%;background:#fff;border:1px solid #999;padding:16px;z-index:60}');
  var s = h('section', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Delete ' + SF.object.label });
  s.appendChild(h('h2', { 'class': 'slds-modal__title' }, 'Delete ' + SF.object.label));
  s.appendChild(h('p', null, 'Are you sure you want to delete this ' + SF.object.label.toLowerCase() + '?'));
  var cancel = h('button', { 'class': 'slds-button', title: 'Cancel' }, 'Cancel');
  var ok = h('button', { 'class': 'slds-button slds-button_brand', title: 'Delete' }, 'Delete');
  cancel.addEventListener('click', function(){ host.remove(); });
  ok.addEventListener('click', function(){
    post('/_ui/delete', { object: SF.object.name, id: id }).then(function(res){
      host.remove();
      if (!res.ok) { toast('error', res.body.error || 'Delete failed'); return; }
      sessionStorage.setItem('sf-toast', JSON.stringify({ type: 'success', message: SF.object.label + ' "' + name + '" was deleted.' }));
      location.href = '/lightning/o/' + SF.object.name + '/list?filterName=Recent';
    });
  });
  s.appendChild(cancel); s.appendChild(ok); root.appendChild(s);
}

/* ---------------------------------------------------------------- record page */
function fieldByName(n){ return (SF.fields || []).filter(function(f){ return f.name === n; })[0]; }
function outputFor(name){
  var f = fieldByName(name);
  var text = SF.record.display[name] || '';
  if (f && f.type === 'boolean') { var cb = h('input', { type: 'checkbox', disabled: true, 'class': 'uiInputCheckbox' }); cb.checked = SF.record.values[name] === true; return cb; }
  if (f && f.type === 'reference' && SF.record.links[name]) return h('a', { href: SF.record.links[name], 'class': 'outputLookupLink' }, text);
  var tag = f && (f.type === 'currency' || f.type === 'int' || f.type === 'double' || f.type === 'percent') ? 'lightning-formatted-number' : 'lightning-formatted-text';
  return h(tag, null, text);
}

customElements.define('records-highlights2', class extends HTMLElement {
  connectedCallback(){
    if (this.shadowRoot) return;
    var root = this.attachShadow({ mode: 'open' });
    css(root, BASE + '.slds-page-header{background:#fff;padding:12px;border:1px solid #ddd}ul{list-style:none;display:flex;gap:24px;padding:0}.actions{display:flex;gap:6px}');
    this.root = root;
    this.render();
    var self = this;
    window.addEventListener('sf-record-changed', function(){ self.render(); });
  }
  render(){
    var root = this.root;
    Array.prototype.slice.call(root.querySelectorAll('.slds-page-header')).forEach(function(n){ n.remove(); });
    var hd = h('div', { 'class': 'slds-page-header slds-page-header_record-home' });
    hd.appendChild(h('div', { 'class': 'entityNameTitle slds-line-height_reset' }, SF.object.label));
    var h1 = h('h1', { 'class': 'slds-page-header__title' });
    h1.appendChild(h('lightning-formatted-text', { 'class': 'custom-truncate', slot: 'primaryField' }, SF.record.name));
    hd.appendChild(h1);
    var actions = h('ul', { 'class': 'actions slds-button-group-list' });
    var edit = h('li'); var eb = h('button', { 'class': 'slds-button slds-button_neutral', name: 'Edit' }, 'Edit');
    eb.addEventListener('click', function(){ location.href = '/lightning/r/' + SF.object.name + '/' + SF.record.id + '/edit'; });
    edit.appendChild(eb); actions.appendChild(edit);
    if (SF.object.canDelete) {
      var del = h('li'); var db = h('button', { 'class': 'slds-button slds-button_neutral', name: 'Delete' }, 'Delete');
      db.addEventListener('click', function(){ confirmDelete(SF.record.id, SF.record.name); });
      del.appendChild(db); actions.appendChild(del);
    }
    hd.appendChild(actions);
    var ul = h('ul', { 'class': 'slds-page-header__detail-row' });
    (SF.highlights || []).forEach(function(n){
      var f = fieldByName(n); if (!f) return;
      var li = h('li', { 'class': 'slds-page-header__detail-block' });
      var item = h('records-highlights-details-item', { 'data-field': n });
      item.appendChild(h('p', { 'class': 'slds-text-title slds-truncate', title: f.label }, f.label));
      var p = h('p', { 'class': 'fieldComponent slds-text-body--regular' }); p.appendChild(outputFor(n)); item.appendChild(p);
      li.appendChild(item); ul.appendChild(li);
    });
    hd.appendChild(ul);
    root.appendChild(hd);
  }
});

customElements.define('records-lwc-detail-panel', class extends HTMLElement {
  connectedCallback(){
    if (this.shadowRoot) return;
    var root = this.attachShadow({ mode: 'open' });
    css(root, BASE + '.slds-form{background:#fff;padding:12px;border:1px solid #ddd;margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:4px 24px}records-record-layout-item{display:block;border-bottom:1px solid #eee;padding:4px}.test-id__field-label{display:block;color:#666;font-size:12px}');
    this.root = root;
    this.render();
    var self = this;
    window.addEventListener('sf-record-changed', function(){ self.render(); });
  }
  render(){
    var root = this.root;
    var old = root.querySelector('.slds-form'); if (old) old.remove();
    var form = h('div', { 'class': 'slds-form', role: 'list', 'aria-label': 'Details' });
    SF.fields.forEach(function(f){
      if (f.type === 'id') return;
      var item = h('records-record-layout-item', { 'field-label': f.label, 'data-target-selection-name': 'sfdc:RecordField.' + SF.object.name + '.' + f.name, role: 'listitem' });
      var el = h('div', { 'class': 'slds-form-element slds-form-element_readonly' });
      el.appendChild(h('span', { 'class': 'test-id__field-label' }, f.label));
      var ctl = h('div', { 'class': 'slds-form-element__control' });
      var val = h('span', { 'class': 'test-id__field-value slds-form-element__static' });
      val.appendChild(outputFor(f.name));
      ctl.appendChild(val);
      if (f.access === 'edit' && !f.system) {
        var pencil = h('button', { 'class': 'slds-button test-id__inline-edit-trigger', title: 'Edit ' + f.label, 'aria-label': 'Edit ' + f.label }, 'edit');
        pencil.addEventListener('click', function(){ location.href = '/lightning/r/' + SF.object.name + '/' + SF.record.id + '/edit'; });
        ctl.appendChild(pencil);
      }
      el.appendChild(ctl); item.appendChild(el); form.appendChild(item);
    });
    root.appendChild(form);
  }
});

customElements.define('lightning-path', class extends HTMLElement {
  connectedCallback(){
    if (this.shadowRoot) return;
    var root = this.attachShadow({ mode: 'open' });
    css(root, BASE + '.slds-path{background:#fff;padding:8px;border:1px solid #ddd;margin-top:8px;display:flex;justify-content:space-between}ul{display:flex;list-style:none;padding:0;margin:0;gap:4px}a{display:block;padding:6px 12px;border-radius:14px;background:#ecebea;color:#181818;cursor:pointer;text-decoration:none}.slds-is-complete a{background:#2e844a;color:#fff}.slds-is-current a{background:#014486;color:#fff}.slds-is-active a{outline:2px solid #1b96ff}');
    this.root = root;
    this.selected = null;
    this.render();
  }
  render(){
    var self = this, root = this.root, P = SF.path;
    var old = root.querySelector('.slds-path'); if (old) old.remove();
    var cur = P.stages.indexOf(P.current);
    var sel = this.selected === null ? cur : this.selected;
    var wrap = h('div', { 'class': 'slds-path' });
    var ul = h('ul', { 'class': 'slds-path__nav', role: 'listbox', 'aria-orientation': 'horizontal', 'aria-label': 'Path Options' });
    P.stages.forEach(function(s, i){
      var cls = i < cur ? 'slds-is-complete' : i === cur ? 'slds-is-current' : 'slds-is-incomplete';
      if (i === sel) cls += ' slds-is-active';
      var li = h('li', { 'class': 'slds-path__item ' + cls, role: 'presentation' });
      var a = h('a', { role: 'option', 'aria-selected': String(i === sel), title: s, tabindex: i === sel ? '0' : '-1', 'data-tab-name': s });
      a.appendChild(h('span', { 'class': 'slds-path__stage' }, i < cur ? 'Stage Complete' : i === cur ? 'Current Stage:' : ''));
      a.appendChild(h('span', { 'class': 'slds-path__title' }, s));
      a.addEventListener('click', function(){ self.selected = i; self.render(); });
      li.appendChild(a); ul.appendChild(li);
    });
    wrap.appendChild(ul);
    var action = h('div', { 'class': 'slds-path__action' });
    if (sel !== cur || cur < P.stages.length - 1) {
      var label = sel === cur ? 'Mark Stage as Complete' : 'Mark as Current Stage';
      var btn = h('button', { 'class': 'slds-button slds-button_brand slds-path__mark-complete', title: label }, label);
      btn.addEventListener('click', function(){
        btn.disabled = true;
        post('/_ui/path', { object: SF.object.name, id: SF.record.id, stage: sel === cur ? null : P.stages[sel] }).then(function(res){
          btn.disabled = false;
          if (!res.ok) { toast('error', res.body.error); return; }
          P.current = res.body.stage; self.selected = null;
          SF.record.values = res.body.record.values; SF.record.display = res.body.record.display;
          window.dispatchEvent(new CustomEvent('sf-record-changed'));
          self.render();
          toast('success', 'Stage changed successfully.');
        });
      });
      action.appendChild(btn);
    }
    wrap.appendChild(action);
    root.appendChild(wrap);
  }
});

customElements.define('force-related-list-single-container', class extends HTMLElement {
  connectedCallback(){
    if (this.shadowRoot) return;
    var rl = SF.related[Number(this.getAttribute('data-index'))];
    this.setAttribute('data-related-list', rl.label);
    var root = this.attachShadow({ mode: 'open' });
    css(root, BASE + '.slds-card{background:#fff;border:1px solid #ddd;margin-top:8px;padding:8px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:4px}');
    var card = h('article', { 'class': 'slds-card forceRelatedListCardDesktop', 'aria-label': rl.label });
    var hd = h('h2', { 'class': 'slds-card__header-title' });
    var a = h('a', { 'class': 'slds-card__header-link' });
    a.appendChild(h('span', { title: rl.label }, rl.label));
    a.appendChild(h('span', { title: '(' + rl.rows.length + ')' }, ' (' + rl.rows.length + ')'));
    hd.appendChild(a); card.appendChild(hd);
    var table = h('table', { role: 'grid', 'aria-label': rl.label, 'class': 'slds-table' });
    var thead = h('thead'); var tr = h('tr');
    rl.columns.forEach(function(c){ tr.appendChild(h('th', { scope: 'col', 'aria-label': c.label }, c.label)); });
    thead.appendChild(tr); table.appendChild(thead);
    var tbody = h('tbody');
    rl.rows.forEach(function(row){
      var r = h('tr', { 'data-row-key-value': row.id });
      rl.columns.forEach(function(c, i){
        var cell = h(i === 0 ? 'th' : 'td', { 'data-label': c.label, scope: i === 0 ? 'row' : null });
        if (i === 0) cell.appendChild(h('a', { href: row.url, title: row.cells[c.field] || '' }, row.cells[c.field] || ''));
        else cell.textContent = row.cells[c.field] || '';
        r.appendChild(cell);
      });
      tbody.appendChild(r);
    });
    table.appendChild(tbody); card.appendChild(table);
    if (!rl.rows.length) card.appendChild(h('p', { 'class': 'slds-text-color_weak' }, 'No items to display'));
    root.appendChild(card);
  }
});

/* ---------------------------------------------------------------- edit / create modal */
customElements.define('force-record-edit-modal', class extends HTMLElement {
  connectedCallback(){
    if (this.shadowRoot) return;
    var self = this;
    var root = this.attachShadow({ mode: 'open' });
    css(root, BASE + '.slds-backdrop{position:fixed;inset:0;background:rgba(8,7,7,.6);z-index:30}.slds-modal{position:fixed;top:40px;left:50%;transform:translateX(-50%);width:760px;max-height:90vh;overflow:auto;background:#fff;z-index:31;border-radius:4px}header,footer{padding:12px 16px;border-bottom:1px solid #ddd}footer{border-top:1px solid #ddd;display:flex;justify-content:flex-end;gap:8px}.slds-modal__content{padding:12px 16px}.slds-form{display:grid;grid-template-columns:1fr 1fr;gap:0 24px}.pageLevelErrors{background:#fef1ee;border:1px solid #ba0517;padding:8px;margin-bottom:8px}.slds-spinner_container{position:absolute;inset:0;background:rgba(255,255,255,.6)}');
    var M = SF.modal, isNew = M.mode === 'new';
    root.appendChild(h('div', { 'class': 'slds-backdrop slds-backdrop_open' }));
    var section = h('section', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-heading', 'class': 'slds-modal slds-fade-in-open' });
    var header = h('header', { 'class': 'slds-modal__header' });
    header.appendChild(h('h2', { id: 'modal-heading', 'class': 'slds-modal__title' }, isNew ? 'New ' + SF.object.label : 'Edit ' + SF.record.name));
    section.appendChild(header);
    var content = h('div', { 'class': 'slds-modal__content' });
    var snag = h('div', { 'class': 'pageLevelErrors', role: 'alert', hidden: true });
    snag.appendChild(h('div', { 'class': 'genericNotification' }, 'We hit a snag.'));
    var snagBody = h('div', { 'class': 'errorsList' });
    snag.appendChild(snagBody);
    content.appendChild(snag);
    var form = h('div', { 'class': 'slds-form', role: 'list' });
    var comps = {};
    var values = isNew ? {} : SF.record.values;
    SF.fields.forEach(function(f){
      if (f.type === 'id' || f.system) return;
      var item = h('records-record-layout-item', { 'field-label': f.label, 'data-target-selection-name': 'sfdc:RecordField.' + SF.object.name + '.' + f.name, role: 'listitem' });
      if (f.access !== 'edit') {
        item.setAttribute('data-readonly', '');
        var ro = h('div', { 'class': 'slds-form-element slds-form-element_readonly' });
        ro.appendChild(h('span', { 'class': 'slds-form-element__label' }, f.label));
        var st = h('div', { 'class': 'slds-form-element__static' });
        st.appendChild(h('lightning-formatted-text', null, isNew ? '' : (SF.record.display[f.name] || '')));
        ro.appendChild(st); item.appendChild(ro); form.appendChild(item);
        return;
      }
      var v = values[f.name];
      var c;
      var common = { label: f.label, 'field-name': f.name, required: f.required };
      if (f.type === 'picklist') {
        c = h('lightning-combobox', common);
        var opts = f.picklist.map(function(o){ return { value: o.value, label: o.label }; });
        c.setAttribute('options', JSON.stringify(opts));
        if (v) c.setAttribute('value', v);
      } else if (f.type === 'reference') {
        c = h('lightning-grouped-combobox', Object.assign({ 'reference-to': f.referenceTo, 'reference-plural': f.referencePlural || f.referenceTo }, common));
        if (v) { c.setAttribute('value', v); c.setAttribute('display-value', SF.record.display[f.name] || ''); }
      } else if (f.type === 'textarea') {
        c = h('lightning-textarea', common);
        if (v) c.setAttribute('value', v);
      } else if (f.type === 'boolean') {
        c = h('lightning-input', Object.assign({ type: 'checkbox' }, common));
        c.setAttribute('value', String(v === true));
      } else {
        var type = f.type === 'date' ? 'date' : (f.type === 'currency' || f.type === 'double' || f.type === 'int' || f.type === 'percent') ? 'number' : f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : 'text';
        c = h('lightning-input', Object.assign({ type: type, formatter: f.type === 'currency' ? 'currency' : null }, common));
        if (v !== null && v !== undefined) c.setAttribute('value', f.type === 'date' ? (SF.record.display[f.name] || '') : String(v));
      }
      comps[f.name] = c;
      item.appendChild(c); form.appendChild(item);
    });
    content.appendChild(form);
    section.appendChild(content);
    var footer = h('footer', { 'class': 'slds-modal__footer' });
    var cancel = h('button', { 'class': 'slds-button slds-button_neutral', name: 'CancelEdit' }, 'Cancel');
    var save = h('button', { 'class': 'slds-button slds-button_brand', name: 'SaveEdit' }, 'Save');
    footer.appendChild(cancel); footer.appendChild(save);
    section.appendChild(footer);
    root.appendChild(section);
    // Dependent picklists: filter by controller value; disabled until the controller has a value.
    SF.fields.forEach(function(f){
      if (!f.controllerName || !comps[f.name] || !comps[f.controllerName]) return;
      var dep = comps[f.name], ctl = comps[f.controllerName];
      function sync(){
        var cv = ctl.value;
        dep.options = f.picklist.filter(function(o){ return cv && (o.validFor || []).indexOf(cv) >= 0; }).map(function(o){ return { value: o.value, label: o.label }; });
        dep.disabled = !cv;
      }
      ctl.addEventListener('change', sync);
      sync();
    });
    cancel.addEventListener('click', function(){ location.href = M.backUrl; });
    save.addEventListener('click', function(){
      if (save.disabled) return;
      var out = {};
      Object.keys(comps).forEach(function(k){ var v = comps[k].value; out[k] = v === '' ? null : v; comps[k].setError(''); });
      snag.hidden = true;
      save.disabled = true;
      var spinner = h('div', { 'class': 'slds-spinner_container', role: 'status' }); spinner.appendChild(h('span', { 'class': 'slds-assistive-text' }, 'Saving'));
      section.appendChild(spinner);
      post('/_ui/save', { object: SF.object.name, id: isNew ? null : SF.record.id, values: out }).then(function(res){
        save.disabled = false; spinner.remove();
        if (!res.ok) {
          var fe = res.body.fieldErrors || {}, pe = res.body.pageErrors || [];
          snagBody.innerHTML = '';
          var labels = Object.keys(fe).map(function(k){ var f = fieldByName(k); return f ? f.label : k; });
          if (labels.length) {
            snagBody.appendChild(h('p', null, 'Review the following fields'));
            var ul = h('ul', { 'class': 'errorsList' });
            labels.forEach(function(l){ ul.appendChild(h('li', null, l)); });
            snagBody.appendChild(ul);
          }
          pe.forEach(function(m){ snagBody.appendChild(h('p', { 'class': 'pageError' }, m)); });
          snag.hidden = false;
          Object.keys(fe).forEach(function(k){ if (comps[k]) comps[k].setError(fe[k]); });
          return;
        }
        sessionStorage.setItem('sf-toast', JSON.stringify({ type: 'success', message: SF.object.label + ' "' + res.body.name + '" was ' + (isNew ? 'created' : 'saved') + '.' }));
        location.href = '/lightning/r/' + SF.object.name + '/' + res.body.id + '/view';
      });
    });
  }
});
})();
`;
