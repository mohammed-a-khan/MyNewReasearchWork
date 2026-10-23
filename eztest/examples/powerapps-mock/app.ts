/**
 * The "Account Manager" canvas app of the Power Apps mock: control
 * definitions for two app versions (as Power Apps source YAML, .pa.yaml) and
 * the browser runtime that renders them with the canvas player's DOM
 * conventions and an object model shaped like the one Power Apps Test Engine
 * reads (AppMagic.Controls.GlobalContextManager.bindingContext.controlContexts).
 */

export type AppVersion = 1 | 2;

export interface CanvasControl { name: string; type: string; text?: string; hint?: string; children?: CanvasControl[]; formulas?: Record<string, string> }
export interface CanvasScreen { name: string; controls: CanvasControl[] }

export function appDefinition(v: AppVersion): CanvasScreen[] {
  const nameCtl = v === 1 ? 'txtName' : 'txtAccountName';
  return [
    {
      name: 'BrowseScreen',
      controls: [
        { name: 'lblTitle', type: 'Label', text: 'Accounts', formulas: { Text: '="Accounts"' } },
        { name: 'txtSearch', type: 'TextInput', hint: 'Search accounts', formulas: { HintText: '="Search accounts"' } },
        {
          name: 'galAccounts', type: 'Gallery', formulas: { Items: `=Filter(Accounts, StartsWith('Account Name', txtSearch.Text))`, OnSelect: '=Navigate(EditScreen)' },
          children: [
            { name: 'lblAccountName', type: 'Label', formulas: { Text: "=ThisItem.'Account Name'" } },
            { name: 'lblPhone', type: 'Label', formulas: { Text: v === 1 ? "=ThisItem.'Main Phone'" : "=ThisItem.'Main Phone' & \" / \" & Text(ThisItem.'Annual Revenue')" } },
          ],
        },
        { name: 'btnNew', type: 'Button', text: 'New account', formulas: { OnSelect: '=NewForm(frmAccount); Navigate(EditScreen)' } },
        { name: 'btnDelete', type: 'Button', text: 'Delete', formulas: { Visible: '=gblIsAdmin', DisplayMode: '=If(IsBlank(galAccounts.Selected), DisplayMode.Disabled, DisplayMode.Edit)', OnSelect: '=Remove(Accounts, galAccounts.Selected)' } },
      ],
    },
    {
      name: 'EditScreen',
      controls: [
        { name: 'lblFormTitle', type: 'Label', text: 'Account', formulas: { Text: '="Account"' } },
        { name: nameCtl, type: 'TextInput', hint: 'Account name', formulas: { Default: "=galAccounts.Selected.'Account Name'" } },
        { name: 'txtPhone', type: 'TextInput', hint: 'Main phone', formulas: { Default: "=galAccounts.Selected.'Main Phone'" } },
        v === 1
          ? { name: 'ddIndustry', type: 'Dropdown', formulas: { Items: '=Choices(Accounts.Industry)', Default: '=galAccounts.Selected.Industry' } }
          : { name: 'cmbIndustry', type: 'ComboBox', formulas: { Items: '=Choices(Accounts.Industry)', DefaultSelectedItems: '=[galAccounts.Selected.Industry]' } },
        ...(v === 1 ? [{ name: 'tglCreditHold', type: 'Toggle', formulas: { Default: "=galAccounts.Selected.'Credit Hold'" } }] : []),
        { name: 'btnSave', type: 'Button', text: v === 1 ? 'Save' : 'Save changes', formulas: { OnSelect: `=If(IsBlank(${nameCtl}.Text), Notify("Account name is required", NotificationType.Error), Patch(Accounts, Coalesce(galAccounts.Selected, Defaults(Accounts)), {'Account Name': ${nameCtl}.Text, 'Main Phone': txtPhone.Text}); Notify("Account saved", NotificationType.Success); Set(gblStatus, "Saved"))` } },
        { name: 'btnBack', type: 'Button', text: 'Back', formulas: { OnSelect: '=Navigate(BrowseScreen)' } },
        { name: 'lblStatus', type: 'Label', text: '', formulas: { Text: '=gblStatus' } },
      ],
    },
  ];
}

/** The app as Power Apps source YAML (pa.yaml, as `pac canvas unpack` / source control show it). */
export function appSourceYaml(v: AppVersion): string {
  const q = (s: string) => (/[:#'"{}[\],&*!|>%@`]/.test(s) || s.startsWith('=') ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s);
  const ctl = (c: CanvasControl, ind: string): string => {
    const props = { ...(c.formulas ?? {}), ...(c.text !== undefined && !c.formulas?.Text ? { Text: `="${c.text}"` } : {}) };
    return `${ind}- ${c.name}:\n${ind}    Control: ${c.type}\n${Object.keys(props).length ? `${ind}    Properties:\n${Object.entries(props).map(([k, f]) => `${ind}      ${k}: ${q(f)}`).join('\n')}\n` : ''}${c.children?.length ? `${ind}    Children:\n${c.children.map((x) => ctl(x, ind + '      ')).join('')}` : ''}`;
  };
  return `App:\n  Properties:\n    Name: "Account Manager"\n    Version: "${v}.0.0"\nDataSources:\n  Accounts:\n    Type: Table\n    Parameters:\n      TableLogicalName: account\nScreens:\n${appDefinition(v).map((s) => `  ${s.name}:\n    Children:\n${s.controls.map((c) => ctl(c, '      ')).join('')}`).join('')}`;
}

/** Browser runtime for the app frame (plain JS). */
export function runtimeJs(v: AppVersion, isAdmin: boolean, industries: string[]): string {
  const nameCtl = v === 1 ? 'txtName' : 'txtAccountName';
  const ind = v === 1 ? 'ddIndustry' : 'cmbIndustry';
  return `(function(){'use strict';
var VERSION=${v},IS_ADMIN=${isAdmin},NAME_CTL=${JSON.stringify(nameCtl)},IND_CTL=${JSON.stringify(ind)},INDUSTRIES=${JSON.stringify(industries)};
var state={screen:'BrowseScreen',accounts:[],selected:null,status:'',search:'',mode:'edit'};
var contexts={};
function prop(get){return {getValue:get}}
function ctx(name,props){contexts[name]={modelProperties:props,controlName:name};}
window.AppMagic={Controls:{GlobalContextManager:{bindingContext:{controlContexts:contexts}}},AuthoringTool:{Runtime:{getActiveScreen:function(){return state.screen}}}};
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function $(n){return document.querySelector('[data-control-name="'+n+'"]')}
function notify(msg,type){var n=document.createElement('div');n.className='appmagic-notification appmagic-notification-'+type;n.setAttribute('role','alert');n.innerHTML='<span class="appmagic-notification-message">'+esc(msg)+'</span>';document.getElementById('notifications').appendChild(n);setTimeout(function(){n.remove()},5000);}
function load(){return fetch('/play/data/accounts',{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(j){state.accounts=j.value;});}
function filtered(){var q=state.search.toLowerCase();return state.accounts.filter(function(a){return !q||a.name.toLowerCase().indexOf(q)===0});}
function control(name,type,inner,extra){return '<div class="appmagic-control-view" data-control-name="'+name+'" data-control-type="'+type+'"'+(extra||'')+'>'+inner+'</div>';}
function render(){
 var app=document.getElementById('app');var items=filtered();
 var browse='<div class="appmagic-screen" data-control-name="BrowseScreen" data-control-type="Screen"'+(state.screen==='BrowseScreen'?'':' style="display:none"')+'>'+
  control('lblTitle','Label','<div class="appmagic-label" role="heading"><div class="appmagic-label-text">Accounts</div></div>')+
  control('txtSearch','TextInput','<div class="appmagic-textbox"><input class="appmagic-text" aria-label="txtSearch" placeholder="Search accounts" value="'+esc(state.search)+'"></div>')+
  control('galAccounts','Gallery','<div class="appmagic-gallery" role="list" aria-label="galAccounts"><div class="virtualized-gallery">'+items.map(function(a,i){return '<div class="appmagic-gallery-item'+(state.selected&&state.selected.accountid===a.accountid?' appmagic-gallery-item-selected':'')+'" role="listitem" data-index="'+(i+1)+'" data-id="'+a.accountid+'">'+
   control('lblAccountName','Label','<div class="appmagic-label"><div class="appmagic-label-text">'+esc(a.name)+'</div></div>')+control('lblPhone','Label','<div class="appmagic-label"><div class="appmagic-label-text">'+esc(VERSION===1?(a.telephone1||''):((a.telephone1||'')+' / '+(a.revenue||'')))+'</div></div>')+'</div>'}).join('')+'</div></div>')+
  control('btnNew','Button','<div class="appmagic-button" role="button" tabindex="0" aria-disabled="false"><div class="appmagic-button-label">New account</div></div>')+
  control('btnDelete','Button','<div class="appmagic-button'+(state.selected?'':' appmagic-disabled')+'" role="button" tabindex="0" aria-disabled="'+(!state.selected)+'"><div class="appmagic-button-label">Delete</div></div>',IS_ADMIN?'':' style="display:none"')+'</div>';
 var a=state.mode==='new'?{}:(state.selected||{});
 var indCtl=VERSION===1?control('ddIndustry','Dropdown','<div class="appmagic-dropdown" role="combobox" aria-expanded="false" tabindex="0" aria-label="ddIndustry"><span class="appmagic-dropdownLabelText">'+esc(a.industry||'')+'</span><span class="appmagic-dropdownChevron" style="display:inline-block;width:12px;height:12px;background:#999"></span></div>')
  :control('cmbIndustry','ComboBox','<div class="appmagic-combobox" role="combobox" aria-expanded="false" tabindex="0" aria-label="cmbIndustry"><input class="appmagic-combobox-search" aria-label="cmbIndustry search" placeholder="Find items"><span class="appmagic-combobox-selected">'+esc(a.industry||'')+'</span></div>');
 var edit='<div class="appmagic-screen" data-control-name="EditScreen" data-control-type="Screen"'+(state.screen==='EditScreen'?'':' style="display:none"')+'>'+
  control('lblFormTitle','Label','<div class="appmagic-label"><div class="appmagic-label-text">Account</div></div>')+
  control(NAME_CTL,'TextInput','<div class="appmagic-textbox"><input class="appmagic-text" aria-label="'+NAME_CTL+'" placeholder="Account name" value="'+esc(a.name||'')+'"></div>')+
  control('txtPhone','TextInput','<div class="appmagic-textbox"><input class="appmagic-text" aria-label="txtPhone" placeholder="Main phone" value="'+esc(a.telephone1||'')+'"></div>')+indCtl+
  (VERSION===1?control('tglCreditHold','Toggle','<div class="appmagic-toggleSwitch" role="switch" tabindex="0" aria-checked="'+(!!a.creditonhold)+'" aria-label="tglCreditHold" style="display:inline-block;width:40px;height:20px;background:#ccc"></div>'):'')+
  control('btnSave','Button','<div class="appmagic-button" role="button" tabindex="0" aria-disabled="false"><div class="appmagic-button-label">'+(VERSION===1?'Save':'Save changes')+'</div></div>')+
  control('btnBack','Button','<div class="appmagic-button" role="button" tabindex="0" aria-disabled="false"><div class="appmagic-button-label">Back</div></div>')+
  control('lblStatus','Label','<div class="appmagic-label"><div class="appmagic-label-text">'+esc(state.status)+'</div></div>')+'</div>';
 app.innerHTML=browse+edit;wire();model();
}
function val(n){var e=$(n);if(!e)return '';var i=e.querySelector('input.appmagic-text');if(i)return i.value;var d=e.querySelector('.appmagic-dropdownLabelText,.appmagic-combobox-selected');if(d)return d.textContent;var t=e.querySelector('[role=switch]');if(t)return t.getAttribute('aria-checked')==='true';var l=e.querySelector('.appmagic-label-text,.appmagic-button-label');return l?l.textContent:'';}
function visible(n){var e=$(n);return !!e&&e.style.display!=='none'&&!!e.closest('.appmagic-screen')&&e.closest('.appmagic-screen').style.display!=='none';}
function model(){
 for(var k in contexts)delete contexts[k];
 document.querySelectorAll('.appmagic-screen > [data-control-name]').forEach(function(e){var n=e.dataset.controlName,t=e.dataset.controlType;
  var props={Visible:prop(function(){return visible(n)}),DisplayMode:prop(function(){var b=$(n).querySelector('[aria-disabled]');return b&&b.getAttribute('aria-disabled')==='true'?'Disabled':'Edit'})};
  if(t==='TextInput'){props.Text=prop(function(){return val(n)});props.Default=prop(function(){return val(n)});props.HintText=prop(function(){var i=$(n).querySelector('input');return i?i.placeholder:''})}
  if(t==='Label'||t==='Button')props.Text=prop(function(){return val(n)});
  if(t==='Dropdown'){props.Selected=prop(function(){return {Value:val(n)}});props.SelectedText=prop(function(){return {Value:val(n)}});props.Items=prop(function(){return INDUSTRIES.map(function(x){return {Value:x}})})}
  if(t==='ComboBox'){props.Selected=prop(function(){return {Value:val(n)}});props.SelectedItems=prop(function(){return val(n)?[{Value:val(n)}]:[]});props.Items=prop(function(){return INDUSTRIES.map(function(x){return {Value:x}})})}
  if(t==='Toggle')props.Value=prop(function(){return val(n)});
  if(t==='Gallery'){props.AllItems=prop(function(){return filtered().map(function(a){return {'Account Name':a.name,'Main Phone':a.telephone1||'',lblAccountName:{Text:a.name},lblPhone:{Text:VERSION===1?(a.telephone1||''):((a.telephone1||'')+' / '+(a.revenue||''))}}})});
   props.Items=props.AllItems;props.Selected=prop(function(){return state.selected?{'Account Name':state.selected.name,'Main Phone':state.selected.telephone1||''}:null})}
  ctx(n,props);});
 ctx('App',{ActiveScreen:prop(function(){return state.screen})});
}
function navigate(s){state.screen=s;render();}
function wire(){
 var s=$('txtSearch').querySelector('input');s.addEventListener('input',function(){state.search=s.value;var pos=s.value.length;render();var x=$('txtSearch').querySelector('input');x.focus();x.setSelectionRange(pos,pos);});
 document.querySelectorAll('.appmagic-gallery-item').forEach(function(it){it.addEventListener('click',function(){state.selected=state.accounts.filter(function(a){return a.accountid===it.dataset.id})[0];state.mode='edit';state.status='';navigate('EditScreen');});});
 $('btnNew').querySelector('[role=button]').addEventListener('click',function(){state.mode='new';state.selected=null;state.status='';navigate('EditScreen');});
 $('btnDelete').querySelector('[role=button]').addEventListener('click',function(){if(!state.selected)return;fetch('/play/data/accounts/'+state.selected.accountid,{method:'DELETE',credentials:'same-origin'}).then(function(r){if(!r.ok)return notify('You do not have permission to delete accounts','error');notify('Account deleted','success');state.selected=null;load().then(render);});});
 $('btnBack').querySelector('[role=button]').addEventListener('click',function(){load().then(function(){navigate('BrowseScreen')});});
 var dd=$(IND_CTL);var box=dd.querySelector('[role=combobox]');
 function openList(q){var old=document.getElementById('ddList');if(old)old.remove();var l=document.createElement('ul');l.id='ddList';l.className='appmagic-dropdownList';l.setAttribute('role','listbox');l.style.cssText='position:absolute;background:#fff;border:1px solid #888;z-index:9';
  l.innerHTML=INDUSTRIES.filter(function(x){return !q||x.toLowerCase().indexOf(q.toLowerCase())>=0}).map(function(x){return '<li role="option" class="appmagic-dropdownListItem">'+esc(x)+'</li>'}).join('');dd.appendChild(l);box.setAttribute('aria-expanded','true');
  l.querySelectorAll('li').forEach(function(li){li.addEventListener('click',function(e){e.stopPropagation();dd.querySelector('.appmagic-dropdownLabelText,.appmagic-combobox-selected').textContent=li.textContent;l.remove();box.setAttribute('aria-expanded','false');});});}
 box.addEventListener('click',function(e){if(e.target.tagName!=='INPUT')openList('')});var cs=dd.querySelector('.appmagic-combobox-search');if(cs)cs.addEventListener('input',function(){openList(cs.value)});
 var tg=document.querySelector('[data-control-name="tglCreditHold"] [role=switch]');if(tg)tg.addEventListener('click',function(){tg.setAttribute('aria-checked',String(tg.getAttribute('aria-checked')!=='true'))});
 $('btnSave').querySelector('[role=button]').addEventListener('click',function(){var name=val(NAME_CTL).trim();if(!name){notify('Account name is required','error');return;}
  var body={name:name,telephone1:val('txtPhone'),industry:val(IND_CTL),creditonhold:VERSION===1?val('tglCreditHold')===true:undefined};if(state.mode!=='new'&&state.selected)body.accountid=state.selected.accountid;
  fetch('/play/data/accounts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),credentials:'same-origin'}).then(function(r){return r.json().then(function(j){
   if(!r.ok)return notify(j.error||'Save failed','error');
   state.status='Saved';return load().then(function(){state.selected=state.accounts.filter(function(a){return a.accountid===j.accountid})[0];state.mode='edit';render();notify('Account saved','success');});});});});
}
load().then(function(){render();document.getElementById('loading').remove();});
})();`;
}
