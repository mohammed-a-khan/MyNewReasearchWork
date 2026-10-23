/**
 * The EZTest capture snippet: an opt-in, privacy-safe script a team drops
 * into a test or staging environment to record how people actually use the
 * app, as semantic events (EZTest's own CaptureFile format). It is plain
 * JavaScript source (never eval of anything), installed only when the page
 * opts in.
 *
 * Privacy:
 *  - It records WHICH field was typed into, never the keystrokes, unless the
 *    field's name/id/testid/label is on an explicit allow-list — and even then
 *    the value is masked to its shape (digits -> #, letters -> x) so no real
 *    value is stored.
 *  - Password and hidden fields are never recorded.
 *  - It is off by default: nothing runs until `window.__ezCapture` is set up
 *    with an explicit `start()` (or the page sets `data-eztest-capture`).
 *
 * Events are buffered and handed to a sink: a POST endpoint (navigator
 * .sendBeacon) or `window.__ezCapture.flush()` returning the CaptureFile.
 */

export interface CaptureSnippetOptions {
  /** Field names/ids/testids/labels whose (masked) value may be recorded. */
  allowValues?: string[];
  /** POST the CaptureFile here on unload / every `batchMs`. When absent, keep it in memory for flush(). */
  endpoint?: string;
  /** Start recording immediately (otherwise call window.__ezCapture.start()). Default false. */
  autostart?: boolean;
  batchMs?: number;
}

/** Build the capture snippet source. Values are JSON-embedded (no interpolation of code). */
export function captureSnippet(opts: CaptureSnippetOptions = {}): string {
  const cfg = {
    allow: (opts.allowValues ?? []).map((s) => s.toLowerCase()),
    endpoint: opts.endpoint ?? null,
    autostart: !!opts.autostart,
    batchMs: opts.batchMs ?? 5000,
  };
  return `(function(){
  var CFG = ${JSON.stringify(cfg)};
  var W = window;
  if (W.__ezCapture && W.__ezCapture.installed) return;
  var SKEY = '__ezCapture';
  // Rehydrate from sessionStorage so a full-page navigation does not lose earlier events.
  var saved = null; try { saved = JSON.parse(sessionStorage.getItem(SKEY) || 'null'); } catch(e){}
  var events = (saved && saved.events) || [];
  var startedAt = (saved && saved.startedAt) || null;
  var firstUrl = (saved && saved.url) || null;
  var started = !!(saved && saved.started);
  function persist(){ try { sessionStorage.setItem(SKEY, JSON.stringify({ started: started, startedAt: startedAt, url: firstUrl, events: events })); } catch(e){} }
  function mask(v){ if (v == null) return ''; return String(v).replace(/[0-9]/g,'#').replace(/[^\\s#]/g,'x'); }
  function allowed(el){
    var keys = [el.name, el.id, el.getAttribute && el.getAttribute('data-testid'), labelOf(el)];
    for (var i=0;i<keys.length;i++){ var k=keys[i]; if (k && CFG.allow.indexOf(String(k).toLowerCase())>=0) return true; }
    return false;
  }
  function labelOf(el){
    try {
      if (el.getAttribute){
        var al = el.getAttribute('aria-label'); if (al) return al.trim();
        var lb = el.getAttribute('aria-labelledby');
        if (lb){ var e2 = document.getElementById(lb.split(' ')[0]); if (e2) return (e2.textContent||'').trim(); }
      }
      if (el.labels && el.labels.length) return (el.labels[0].textContent||'').trim();
      if (el.id){ var l = document.querySelector('label[for="'+CSS.escape(el.id)+'"]'); if (l) return (l.textContent||'').trim(); }
    } catch(e){}
    return '';
  }
  function roleOf(el){ var r = el.getAttribute && el.getAttribute('role'); if (r) return r; var t=el.tagName.toLowerCase();
    if (t==='a') return 'link'; if (t==='button') return 'button'; if (t==='input'){ var ty=(el.type||'text').toLowerCase(); if (ty==='checkbox') return 'checkbox'; if (ty==='radio') return 'radio'; if (ty==='submit'||ty==='button') return 'button'; return 'textbox'; } if (t==='select') return 'combobox'; if (t==='textarea') return 'textbox'; return t; }
  function nameOf(el){ var l = labelOf(el); if (l) return l; var t = (el.textContent||'').trim().replace(/\\s+/g,' '); if (t && t.length<=80) return t; return el.value && el.type!=='password' ? '' : ''; }
  function describe(el){
    if (!el || !el.tagName) return {};
    var d = { tag: el.tagName.toLowerCase(), role: roleOf(el) };
    var n = nameOf(el); if (n) d.name = n;
    var lb = labelOf(el); if (lb) d.label = lb;
    if (el.placeholder) d.placeholder = el.placeholder;
    var tid = el.getAttribute && el.getAttribute('data-testid'); if (tid) d.testId = tid;
    if (el.id) d.id = el.id;
    if (el.tagName.toLowerCase()==='input') d.inputType = (el.type||'text').toLowerCase();
    return d;
  }
  function push(e){ e.t = Date.now(); e.url = location.href; events.push(e); persist(); schedule(); }
  function lastNavUrl(){ for (var i=events.length-1;i>=0;i--){ if (events[i].kind==='navigate') return events[i].url; } return null; }
  function onClick(ev){ if (!started) return; var el = ev.target.closest ? ev.target.closest('a,button,[role=button],[role=link],input,label,summary,[onclick]') : ev.target; if (!el) el = ev.target; push({ kind: 'click', target: describe(el) }); }
  function onChange(ev){ if (!started) return; var el = ev.target; var t = (el.type||'').toLowerCase();
    if (t==='password' || t==='hidden') { return; }
    if (el.tagName.toLowerCase()==='select'){ var opt = el.options[el.selectedIndex]; push({ kind:'select', target: describe(el), value: opt?opt.text:'', masked:false }); return; }
    if (t==='checkbox' || t==='radio'){ push({ kind: el.checked?'check':'uncheck', target: describe(el) }); return; }
    var rec = allowed(el); push({ kind: 'input', target: describe(el), masked: true, value: rec ? mask(el.value) : undefined }); }
  function onSubmit(ev){ if (!started) return; push({ kind: 'submit', target: describe(ev.target) }); }
  var lastUrl = location.href;
  function onNav(){ if (!started) return; if (location.href!==lastUrl){ lastUrl = location.href; push({ kind:'navigate', url: location.href, title: document.title }); } }
  var timer = null;
  function schedule(){ if (!CFG.endpoint || timer) return; timer = setTimeout(flushBeacon, CFG.batchMs); }
  function fileObj(){ return { eztestCapture: 1, startedAt: startedAt, url: firstUrl, events: events.slice() }; }
  function flushBeacon(){ timer=null; if (!CFG.endpoint || !events.length) return; try { navigator.sendBeacon(CFG.endpoint, JSON.stringify(fileObj())); } catch(e){} }
  function start(){ if (started) return; started=true; startedAt=startedAt||new Date().toISOString(); firstUrl=firstUrl||location.href; push({ kind:'navigate', url: location.href, title: document.title }); }
  document.addEventListener('click', onClick, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('submit', onSubmit, true);
  W.addEventListener('popstate', onNav); W.addEventListener('hashchange', onNav);
  var _ps = history.pushState; history.pushState = function(){ var r=_ps.apply(this, arguments); onNav(); return r; };
  W.addEventListener('pagehide', flushBeacon); W.addEventListener('beforeunload', flushBeacon);
  W.__ezCapture = { installed: true, start: start, stop: function(){ started=false; persist(); flushBeacon(); }, flush: function(){ return fileObj(); }, clear: function(){ events.length=0; try{ sessionStorage.removeItem(SKEY); }catch(e){} }, get events(){ return events; } };
  if (started) {
    // A new document of an in-progress capture: record its navigation.
    if (lastNavUrl() !== location.href) push({ kind:'navigate', url: location.href, title: document.title });
  } else if (CFG.autostart || (document.documentElement && document.documentElement.hasAttribute('data-eztest-capture'))) start();
})();`;
}
