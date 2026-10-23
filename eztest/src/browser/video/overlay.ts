/**
 * Burned-in video overlays: before each step the runner shows a caption with
 * the step text and (when the step has a target) a highlighted box around it,
 * so the recorded WebM is self-explaining. The overlay lives in a shadow root
 * on a top-layer element, is `pointer-events:none` so it never intercepts the
 * action, and is removed after the step. The script is static source — never
 * built from user input.
 */

/** Install-once overlay API on the page: window.__ezOverlay.show(text, box?) / hide(). */
export const OVERLAY_SCRIPT = String.raw`(function(){
  var W = window;
  if (W.__ezOverlay) return;
  var host = null, shadow = null, caption = null, boxEl = null;
  function ensure(){
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.setAttribute('data-eztest-overlay', '');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    caption = document.createElement('div');
    caption.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);max-width:88%;padding:8px 14px;border-radius:8px;background:rgba(15,17,22,.88);color:#fff;font:600 14px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.4);white-space:pre-wrap;text-align:center';
    boxEl = document.createElement('div');
    boxEl.style.cssText = 'position:fixed;border:3px solid #ffb000;border-radius:4px;box-shadow:0 0 0 2px rgba(255,176,0,.35);transition:all .08s ease;display:none';
    shadow.appendChild(boxEl); shadow.appendChild(caption);
    (document.body || document.documentElement).appendChild(host);
  }
  W.__ezOverlay = {
    show: function(text, box){
      try {
        ensure();
        caption.textContent = text || '';
        caption.style.display = text ? 'block' : 'none';
        if (box && box.width > 0 && box.height > 0){
          boxEl.style.display = 'block';
          boxEl.style.left = box.x + 'px'; boxEl.style.top = box.y + 'px';
          boxEl.style.width = box.width + 'px'; boxEl.style.height = box.height + 'px';
        } else { boxEl.style.display = 'none'; }
      } catch(e){}
    },
    hide: function(){ try { if (caption) caption.style.display='none'; if (boxEl) boxEl.style.display='none'; } catch(e){} },
    remove: function(){ try { if (host && host.parentNode) host.parentNode.removeChild(host); host=null; } catch(e){} },
  };
})();`;

export interface OverlayBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
