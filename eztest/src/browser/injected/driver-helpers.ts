/**
 * Page-side helpers of the driver itself (not part of the selector engine
 * contract): filling inputs, selecting options, files, events, geometry,
 * screenshot masks. Installed next to the engine in the isolated world.
 *
 * Like the engine, everything lives inside one function that is stringified.
 */

export interface DriverHelpers {
  /**
   * engine.query plus the driver's own `{ anyOf: chains }` step (a selector
   * list whose alternatives are separate chains), results in document order.
   */
  query(engine: { query(chain: unknown[], scope?: Element | Document): Element[] }, chain: unknown[], scope?: Element | Document): Element[];
  /** Prepare an element for typing a new value. 'done' when the value was set directly. */
  prepareFill(el: Element, value: string): 'input' | 'done';
  selectOptions(el: Element, specs: Array<{ value?: string; label?: string; index?: number; valueOrLabel?: string }>): string[] | { retry: string };
  setFiles(el: Element, files: Array<{ name: string; mimeType: string; b64: string; lastModified?: number }>): void;
  dispatch(el: Element, type: string, init: Record<string, unknown>): void;
  inputValue(el: Element): string;
  innerText(el: Element): string;
  selectText(el: Element): void;
  focus(el: Element): void;
  blur(el: Element): void;
  /** Bounding client rect, or null when the element has no box. */
  rect(el: Element): { x: number; y: number; width: number; height: number } | null;
  /**
   * After one animation frame (so layout reacting to the pointer having just moved there has
   * run): does the point (frame viewport CSS pixels) still hit the element or a descendant?
   * Returns what it hits otherwise.
   */
  hitsAfterFrame(el: Element, x: number, y: number): Promise<{ ok: boolean; hit?: string }>;
  /** Offset of an iframe element's content box inside its own frame viewport. */
  frameContentOffset(el: Element): { x: number; y: number };
  scrollOffset(): { x: number; y: number };
  overlay(rects: Array<{ x: number; y: number; width: number; height: number }>, color: string, css: string | undefined): void;
  removeOverlay(): void;
  isFileInput(el: Element): 'file' | 'multiple' | 'no';
  /** Retarget a label to its control (for fill / check / setInputFiles). */
  retarget(el: Element, kind: 'control' | 'none'): Element;
  content(): string;
  setContent(html: string): void;
}

export function createDriverHelpers(): DriverHelpers {
  const OVERLAY_ID = '__eztest_overlay__';
  const directSet = new Set(['color', 'date', 'time', 'datetime-local', 'month', 'range', 'week']);
  const typeable = new Set(['', 'email', 'number', 'password', 'search', 'tel', 'text', 'url']);

  function retarget(el: Element, kind: 'control' | 'none'): Element {
    if (kind === 'none') return el;
    if (el.localName === 'label' && (el as HTMLLabelElement).control) return (el as HTMLLabelElement).control as Element;
    if (!/^(input|textarea|select)$/.test(el.localName) && !(el as HTMLElement).isContentEditable) {
      const label = el.closest('label');
      if (label && (label as HTMLLabelElement).control) return (label as HTMLLabelElement).control as Element;
    }
    return el;
  }

  function fire(el: Element, type: string) {
    el.dispatchEvent(new Event(type, { bubbles: true, composed: type === 'input' }));
  }

  function prepareFill(el: Element, value: string): 'input' | 'done' {
    if (el.localName === 'input') {
      const input = el as HTMLInputElement;
      const type = (input.getAttribute('type') ?? '').toLowerCase();
      if (directSet.has(type)) {
        input.focus();
        input.value = value;
        if (input.value !== value) throw new Error('Malformed value');
        fire(input, 'input');
        fire(input, 'change');
        return 'done';
      }
      if (!typeable.has(type)) throw new Error(`Input of type "${type}" cannot be filled`);
      if (type === 'number' && value.trim() !== '' && Number.isNaN(Number(value))) throw new Error('Cannot type text into input[type=number]');
      input.focus();
      try {
        input.setSelectionRange(0, input.value.length);
      } catch {
        input.select();
      }
      return 'input';
    }
    if (el.localName === 'textarea') {
      const ta = el as HTMLTextAreaElement;
      ta.focus();
      ta.setSelectionRange(0, ta.value.length);
      return 'input';
    }
    if ((el as HTMLElement).isContentEditable) {
      (el as HTMLElement).focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      return 'input';
    }
    throw new Error('Element is not an <input>, <textarea> or [contenteditable] element');
  }

  function selectOptions(el: Element, specs: Array<{ value?: string; label?: string; index?: number; valueOrLabel?: string }>): string[] | { retry: string } {
    if (el.localName !== 'select') throw new Error('Element is not a <select> element');
    const select = el as HTMLSelectElement;
    const options = Array.from(select.options);
    const chosen: HTMLOptionElement[] = [];
    for (const spec of specs) {
      const opt = options.find((o, i) => {
        if (spec.valueOrLabel !== undefined) return o.value === spec.valueOrLabel || o.label === spec.valueOrLabel || o.text.trim() === spec.valueOrLabel;
        if (spec.value !== undefined && o.value !== spec.value) return false;
        if (spec.label !== undefined && o.label !== spec.label && o.text.trim() !== spec.label) return false;
        if (spec.index !== undefined && i !== spec.index) return false;
        return true;
      });
      if (!opt) return { retry: `did not find some options` };
      if (opt.disabled) return { retry: 'option being selected is disabled' };
      chosen.push(opt);
      if (!select.multiple) break;
    }
    if (select.multiple) for (const o of options) o.selected = chosen.includes(o);
    else if (chosen.length) select.value = chosen[0].value;
    else select.selectedIndex = -1;
    select.focus();
    fire(select, 'input');
    fire(select, 'change');
    return options.filter((o) => o.selected).map((o) => o.value);
  }

  function setFiles(el: Element, files: Array<{ name: string; mimeType: string; b64: string; lastModified?: number }>) {
    if (el.localName !== 'input' || (el as HTMLInputElement).type !== 'file') throw new Error('Node is not an HTMLInputElement of type file');
    const input = el as HTMLInputElement;
    if (files.length > 1 && !input.multiple) throw new Error('Non-multiple file input can only accept single file');
    const dt = new DataTransfer();
    for (const f of files) {
      const bin = atob(f.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], f.name, { type: f.mimeType, lastModified: f.lastModified ?? Date.now() }));
    }
    input.files = dt.files;
    fire(input, 'input');
    fire(input, 'change');
  }

  function dispatch(el: Element, type: string, init: Record<string, unknown>) {
    const base = { bubbles: true, cancelable: true, composed: true, ...init };
    let ev: Event;
    if (/^(click|dblclick|mouse(down|up|over|out|enter|leave|move)|contextmenu|auxclick)$/.test(type)) ev = new MouseEvent(type, base as MouseEventInit);
    else if (/^pointer/.test(type) || type === 'gotpointercapture' || type === 'lostpointercapture') ev = new PointerEvent(type, base as PointerEventInit);
    else if (/^key(down|up|press)$/.test(type)) ev = new KeyboardEvent(type, base as KeyboardEventInit);
    else if (/^(focus|blur|focusin|focusout)$/.test(type)) ev = new FocusEvent(type, base as FocusEventInit);
    else if (/^drag|^drop$/.test(type)) {
      const di = { ...base } as DragEventInit & { dataTransfer?: unknown };
      if (!di.dataTransfer) di.dataTransfer = new DataTransfer();
      ev = new DragEvent(type, di as DragEventInit);
    } else if (/^touch/.test(type) && typeof TouchEvent !== 'undefined') ev = new TouchEvent(type, base as TouchEventInit);
    else if (type === 'wheel') ev = new WheelEvent(type, base as WheelEventInit);
    else if (type === 'input' || type === 'beforeinput') ev = new InputEvent(type, base as InputEventInit);
    else ev = new CustomEvent(type, base as CustomEventInit);
    el.dispatchEvent(ev);
  }

  function inputValue(el: Element): string {
    if (el.localName === 'input' || el.localName === 'textarea' || el.localName === 'select') return (el as HTMLInputElement).value;
    throw new Error('Node is not an <input>, <textarea> or <select> element');
  }

  function rect(el: Element) {
    const r = el.getBoundingClientRect();
    if (!el.getClientRects().length && r.width === 0 && r.height === 0) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  function frameContentOffset(el: Element) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return {
      x: r.left + (el as HTMLElement).clientLeft + parseFloat(st.paddingLeft || '0'),
      y: r.top + (el as HTMLElement).clientTop + parseFloat(st.paddingTop || '0'),
    };
  }

  function overlay(rects: Array<{ x: number; y: number; width: number; height: number }>, color: string, css: string | undefined) {
    removeOverlay();
    const host = document.createElement('div');
    host.id = OVERLAY_ID;
    host.setAttribute('style', 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;');
    const sx = window.scrollX;
    const sy = window.scrollY;
    for (const r of rects) {
      const d = document.createElement('div');
      d.setAttribute('style', `position:absolute;left:${r.x + sx}px;top:${r.y + sy}px;width:${r.width}px;height:${r.height}px;background:${color};`);
      host.appendChild(d);
    }
    if (css) {
      const s = document.createElement('style');
      s.textContent = css;
      host.appendChild(s);
    }
    (document.documentElement || document.body).appendChild(host);
  }

  function removeOverlay() {
    document.getElementById(OVERLAY_ID)?.remove();
  }

  function query(engine: { query(chain: unknown[], scope?: Element | Document): Element[] }, chain: unknown[], scope?: Element | Document): Element[] {
    const at = chain.findIndex((s) => !!s && typeof s === 'object' && 'anyOf' in (s as object));
    if (at < 0) return engine.query(chain, scope);
    const before = chain.slice(0, at);
    const alts = (chain[at] as { anyOf: unknown[][] }).anyOf;
    const after = chain.slice(at + 1);
    const roots: Array<Element | Document> = before.length ? engine.query(before, scope) : [scope ?? document];
    const seen = new Set<Element>();
    for (const r of roots) for (const alt of alts) for (const el of engine.query(alt, r)) seen.add(el);
    const merged = [...seen].sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    if (!after.length) return merged;
    const first = after[0] as Record<string, unknown>;
    if ('nth' in first) {
      // nth applies to the merged list; the rest searches inside the picked element.
      const n = Number(first.nth);
      const el = n < 0 ? merged[merged.length + n] : merged[n];
      if (!el) return [];
      return after.length === 1 ? [el] : query(engine, after.slice(1), el);
    }
    // Otherwise run the rest of the chain once per alternative and merge.
    const out = new Set<Element>();
    for (const r of roots) for (const alt of alts) for (const el of query(engine, [...alt, ...after], r)) out.add(el);
    return [...out].sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }

  return {
    hitsAfterFrame: (el, x, y) => new Promise((resolve) => {
      const check = () => {
        const doc = el.ownerDocument;
        let hit = doc.elementFromPoint(x, y);
        while (hit && hit.shadowRoot) {
          const inner = hit.shadowRoot.elementFromPoint(x, y);
          if (!inner || inner === hit) break;
          hit = inner;
        }
        let ok = false;
        for (let n: Node | null = hit; n; n = (n as Element).assignedSlot ?? n.parentNode ?? ((n as ShadowRoot).host || null)) {
          if (n === el) {
            ok = true;
            break;
          }
        }
        if (!ok && hit) {
          const label = hit.closest('label') as HTMLLabelElement | null;
          if (label && label.control === el) ok = true;
        }
        resolve(ok || !el.isConnected ? { ok: ok && el.isConnected } : { ok, hit: hit ? `${hit.localName}${hit.id ? '#' + hit.id : ''}${typeof hit.className === 'string' && hit.className ? '.' + hit.className.trim().split(/\s+/).join('.') : ''}` : 'nothing' });
      };
      let done = false;
      const once = () => {
        if (!done) {
          done = true;
          check();
        }
      };
      const win = el.ownerDocument.defaultView;
      if (win) win.requestAnimationFrame(() => once());
      setTimeout(once, 100);
    }),
    query,
    prepareFill,
    selectOptions,
    setFiles,
    dispatch,
    inputValue,
    innerText: (el) => {
      const text = (el as HTMLElement).innerText !== undefined && el.namespaceURI === 'http://www.w3.org/1999/xhtml' ? (el as HTMLElement).innerText : el.textContent ?? '';
      // Chromium lists a rendered <select>'s options in innerText; Firefox leaves the select out
      // entirely. Add what the engine left out (after the rest), so both read the same options.
      const selects = el.localName === 'select' ? [el as HTMLSelectElement] : Array.from(el.querySelectorAll('select'));
      if (!selects.length) return text;
      const ws = (t: string) => t.replace(/\s+/g, ' ').trim();
      const flat = ws(text);
      const missing: string[] = [];
      for (const sel of selects) {
        if (!sel.getClientRects().length) continue;
        const options = Array.from(sel.options).map((o) => ws(o.text)).filter(Boolean);
        if (options.length && !options.every((o) => flat.includes(o))) missing.push(options.join('\n'));
      }
      if (!missing.length) return text;
      return text ? `${text}${text.endsWith('\n') ? '' : '\n'}${missing.join('\n')}` : missing.join('\n');
    },
    selectText: (el) => {
      if (el.localName === 'input' || el.localName === 'textarea') {
        (el as HTMLInputElement).focus();
        (el as HTMLInputElement).select();
        return;
      }
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      (el as HTMLElement).focus?.();
    },
    focus: (el) => (el as HTMLElement).focus?.(),
    blur: (el) => (el as HTMLElement).blur?.(),
    rect,
    frameContentOffset,
    scrollOffset: () => ({ x: window.scrollX, y: window.scrollY }),
    overlay,
    removeOverlay,
    isFileInput: (el) => (el.localName === 'input' && (el as HTMLInputElement).type === 'file' ? ((el as HTMLInputElement).multiple ? 'multiple' : 'file') : 'no'),
    retarget,
    content: () => {
      let s = '';
      if (document.doctype) s = new XMLSerializer().serializeToString(document.doctype);
      if (document.documentElement) s += document.documentElement.outerHTML;
      return s;
    },
    setContent: (html: string) => {
      document.open();
      document.write(html);
      document.close();
    },
  };
}

export function driverHelpersSource(): string {
  return `(${createDriverHelpers.toString()})()`;
}
