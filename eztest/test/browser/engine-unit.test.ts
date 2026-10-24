/**
 * Page-side engine: selector chains, visibility, actionability, describe,
 * fingerprints and value helpers, run in a real Chromium page.
 */
import type { Browser, Page } from '../../src/browser/index.js';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { engineSource } from '../../src/browser/injected/engine.js';
import { ev, launch, load, q } from './harness.js';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await launch();
  page = await browser.newPage();
});
afterAll(async () => {
  await browser?.close();
});

describe('engine source', () => {
  it('is one self-contained expression', async () => {
    const src = engineSource();
    expect(src.startsWith('(() => {')).toBe(true);
    expect(src).not.toMatch(/\brequire\(|\bimport\s*\(|__name\(/);
    await load(page, '<p>x</p>');
    const v = await ev<string>(page, 'return E.version;');
    expect(v).toBe('eztest-engine/1.0');
  });
});

describe('query: selection steps', () => {
  const SHADOW = `
    <div id=a class=item>Alpha</div>
    <x-host id=host></x-host>
    <div id=b class=item>Beta</div>`;
  const SHADOW_SETUP = `const sr = document.getElementById('host').attachShadow({mode:'open'});
    sr.innerHTML = '<div id=s1 class=item>Shadow one</div><x-inner id=inner></x-inner>';
    sr.getElementById('inner').attachShadow({mode:'open'}).innerHTML = '<button id=s2 class=item>Deep</button>';`;

  it('css pierces open shadow roots, in document order, without duplicates', async () => {
    await load(page, SHADOW, SHADOW_SETUP);
    expect(await q(page, [{ css: '.item' }])).toEqual(['a', 's1', 's2', 'b']);
    expect(await q(page, [{ css: '.item, div.item' }])).toEqual(['a', 's1', 's2', 'b']);
  });

  it('xpath does not pierce shadow roots', async () => {
    await load(page, SHADOW, SHADOW_SETUP);
    expect(await q(page, [{ xpath: '//*[contains(@class,"item")]' }])).toEqual(['a', 'b']);
  });

  it('chained steps search descendants of each match; xpath is relative to the scope', async () => {
    await load(page, '<ul id=l1><li id=x1>A</li></ul><ul id=l2><li id=x2>B</li><li id=x3>C</li></ul>');
    expect(await q(page, [{ css: 'ul' }, { css: 'li' }])).toEqual(['x1', 'x2', 'x3']);
    expect(await q(page, [{ css: '#l2' }, { xpath: './/li' }])).toEqual(['x2', 'x3']);
    expect(await q(page, [{ css: '#l2' }, { xpath: '//li' }])).toEqual(['x1', 'x2', 'x3']);
    expect(await q(page, [{ css: 'li' }], '#l2')).toEqual(['x2', 'x3']);
  });

  it('role with name, exact, regex and states', async () => {
    await load(
      page,
      `<button id=b1>Submit order</button><button id=b2 aria-pressed=true>Bold</button>
       <button id=b3 disabled>Submit</button><div role=button id=b4 aria-hidden=true>Submit hidden</div>
       <input type=checkbox id=c1 checked aria-label=Agree><h2 id=h2>Title</h2><h3 id=h3>Title</h3>`,
    );
    expect(await q(page, [{ role: 'button', name: 'submit' }])).toEqual(['b1', 'b3']);
    expect(await q(page, [{ role: 'button', name: 'Submit', exact: true }])).toEqual(['b3']);
    expect(await q(page, [{ role: 'button', name: { regex: '^submit', flags: 'i' } }])).toEqual(['b1', 'b3']);
    expect(await q(page, [{ role: 'button', name: 'submit', includeHidden: true }])).toEqual(['b1', 'b3', 'b4']);
    expect(await q(page, [{ role: 'button', disabled: false }])).toEqual(['b1', 'b2']);
    expect(await q(page, [{ role: 'button', pressed: true }])).toEqual(['b2']);
    expect(await q(page, [{ role: 'checkbox', checked: true }])).toEqual(['c1']);
    expect(await q(page, [{ role: 'heading', level: 3 }])).toEqual(['h3']);
  });

  it('role pierces shadow DOM and skips hidden elements', async () => {
    await load(page, '<x-host id=host></x-host><button id=hid style="display:none">Go</button>', `document.getElementById('host').attachShadow({mode:'open'}).innerHTML = '<button id=sb>Go</button>'`);
    expect(await q(page, [{ role: 'button', name: 'Go' }])).toEqual(['sb']);
  });

  it('text: smallest element, case-insensitive substring, exact, regex, whitespace', async () => {
    await load(
      page,
      `<div id=d1>Hello <b id=b1>World</b></div><p id=p1>  hello
         world  </p><span id=s1>Say hello world!</span><script>var x = "Hello World"</script>
       <input type=submit id=i1 value="Hello World">`,
    );
    expect(await q(page, [{ text: 'world' }])).toEqual(['b1', 'p1', 's1', 'i1']);
    expect(await q(page, [{ text: 'hello world' }])).toEqual(['d1', 'p1', 's1', 'i1']);
    expect(await q(page, [{ text: 'hello world', exact: true }])).toEqual(['p1']);
    expect(await q(page, [{ text: 'Hello World', exact: true }])).toEqual(['d1', 'i1']);
    expect(await q(page, [{ text: { regex: '^say', flags: 'i' } }])).toEqual(['s1']);
  });

  it('text pierces shadow roots and follows slots', async () => {
    await load(page, '<x-card id=host><span id=light>Slotted text</span></x-card>', `document.getElementById('host').attachShadow({mode:'open'}).innerHTML = '<h3 id=sh>Card title</h3><slot></slot>'`);
    expect(await q(page, [{ text: 'card title' }])).toEqual(['sh']);
    expect(await q(page, [{ text: 'slotted' }])).toEqual(['light']);
    expect(await q(page, [{ css: '#host' }, { hasText: 'Card title' }])).toEqual(['host']);
  });

  it('label: for, wrapping, aria-labelledby, aria-label', async () => {
    await load(
      page,
      `<label for=i1>First name</label><input id=i1>
       <label>Last name <input id=i2></label>
       <span id=l3>Company name</span><input id=i3 aria-labelledby=l3>
       <input id=i4 aria-label="Nickname">
       <label for=i5>Name of pet</label><select id=i5></select>`,
    );
    expect(await q(page, [{ label: 'name' }])).toEqual(['i1', 'i2', 'i3', 'i4', 'i5']);
    expect(await q(page, [{ label: 'Last name', exact: true }])).toEqual(['i2']);
    expect(await q(page, [{ label: 'company' }])).toEqual(['i3']);
  });

  it('placeholder, altText, title, testId', async () => {
    await load(
      page,
      `<input id=p1 placeholder="Search products"><textarea id=p2 placeholder="search notes"></textarea>
       <img id=a1 alt="Company logo"><input type=image id=a2 alt="Go">
       <span id=t1 title="Close dialog">x</span>
       <div id=d1 data-testid=save-btn></div><div id=d2 data-testid=save-btn-2></div><div id=d3 data-qa=save-btn></div>`,
    );
    expect(await q(page, [{ placeholder: 'search' }])).toEqual(['p1', 'p2']);
    expect(await q(page, [{ placeholder: 'Search products', exact: true }])).toEqual(['p1']);
    expect(await q(page, [{ altText: 'logo' }])).toEqual(['a1']);
    expect(await q(page, [{ title: 'close' }])).toEqual(['t1']);
    expect(await q(page, [{ testId: 'save-btn', attr: 'data-testid' }])).toEqual(['d1']);
    expect(await q(page, [{ testId: 'save-btn', attr: 'data-qa' }])).toEqual(['d3']);
    expect(await q(page, [{ testId: { regex: '^save' }, attr: 'data-testid' }])).toEqual(['d1', 'd2']);
  });
});

describe('query: filters and frames', () => {
  const LIST = `<ul><li id=r1>Apple <button>Buy</button></li><li id=r2>Banana</li><li id=r3 style="display:none">Cherry <button>Buy</button></li><li id=r4>Durian <button>Buy</button></li></ul>`;

  it('nth, -1 = last, out of range = empty', async () => {
    await load(page, LIST);
    expect(await q(page, [{ css: 'li' }, { nth: 0 }])).toEqual(['r1']);
    expect(await q(page, [{ css: 'li' }, { nth: -1 }])).toEqual(['r4']);
    expect(await q(page, [{ css: 'li' }, { nth: 9 }])).toEqual([]);
  });

  it('hasText, hasNotText, has, hasNot, visible', async () => {
    await load(page, LIST);
    expect(await q(page, [{ css: 'li' }, { hasText: 'an' }])).toEqual(['r2', 'r4']);
    expect(await q(page, [{ css: 'li' }, { hasNotText: 'an' }])).toEqual(['r1', 'r3']);
    expect(await q(page, [{ css: 'li' }, { has: [{ role: 'button', includeHidden: true }] }])).toEqual(['r1', 'r3', 'r4']);
    expect(await q(page, [{ css: 'li' }, { hasNot: [{ css: 'button' }] }])).toEqual(['r2']);
    expect(await q(page, [{ css: 'li' }, { visible: true }])).toEqual(['r1', 'r2', 'r4']);
    expect(await q(page, [{ css: 'li' }, { visible: false }])).toEqual(['r3']);
    expect(await q(page, [{ css: 'li' }, { hasText: 'durian' }, { role: 'button' }])).toEqual(['button "Buy"']);
  });

  it('reports frame boundaries without crossing them', async () => {
    await load(page, '<iframe id=f1 srcdoc="<button>In frame</button>"></iframe><div><iframe id=f2></iframe></div>');
    const r = await ev<{ ids: string[]; frameAt?: number; rest?: unknown[] }>(
      page,
      `const r = E.queryDetailed([{ css: 'iframe' }, { frame: true }, { role: 'button' }]);
       return { ids: r.elements.map((e) => e.id), frameAt: r.frameAt, rest: r.rest };`,
    );
    expect(r).toEqual({ ids: ['f1', 'f2'], frameAt: 1, rest: [{ role: 'button' }] });
    const s = await ev<{ ids: string[]; frameAt?: number }>(page, `const r = E.queryDetailed([{ frame: '#f2' }, { css: 'x' }]); return { ids: r.elements.map((e) => e.id), frameAt: r.frameAt };`);
    expect(s).toEqual({ ids: ['f2'], frameAt: 0 });
  });

  it('throws clear errors for malformed selectors only', async () => {
    await load(page, '<p>x</p>');
    await expect(q(page, [{ css: 'p[' }])).rejects.toThrow(/Invalid CSS selector/);
    await expect(q(page, [{ xpath: '//p[' }])).rejects.toThrow(/Invalid XPath/);
    await expect(q(page, [{ bogus: 1 }])).rejects.toThrow(/Unknown selector step/);
    expect(await q(page, [{ css: 'nothing-here' }])).toEqual([]);
  });
});

describe('visibility', () => {
  it('box, visibility, display, content-visibility, opacity, display:contents, options', async () => {
    await load(
      page,
      `<div id=v1>shown</div><div id=v2 style="visibility:hidden">x</div><div id=v3 style="display:none"><span id=v3c>x</span></div>
       <div id=v4 style="opacity:0">x</div><div id=v5 style="width:0;height:0;overflow:hidden">x</div>
       <div id=v6 style="display:contents"><span>child</span></div><div id=v7 style="display:contents"></div>
       <div style="content-visibility:hidden"><span id=v8>x</span></div>
       <table><tr id=v9 style="visibility:collapse"><td>x</td></tr></table>
       <select id=sel><option id=o1>A</option></select><select style="display:none"><option id=o2>B</option></select>
       <div id=v10 hidden>x</div>`,
    );
    const r = await ev<Record<string, boolean>>(
      page,
      `const out = {}; for (const id of ['v1','v2','v3','v3c','v4','v5','v6','v7','v8','v9','o1','o2','v10']) out[id] = E.isVisible(document.getElementById(id)); return out;`,
    );
    expect(r).toEqual({ v1: true, v2: false, v3: false, v3c: false, v4: true, v5: false, v6: true, v7: false, v8: false, v9: false, o1: true, o2: false, v10: false });
  });
});

describe('actionability', () => {
  async function act(sel: string, action: string, options?: unknown) {
    return ev<{ ok: boolean; reason?: string; retry?: boolean; blocker?: string; point?: { x: number; y: number } }>(
      page,
      `return E.actionability(document.querySelector(ARG.sel), ARG.action, ARG.options || undefined);`,
      { sel, action, options },
    );
  }

  it('ok with a point inside the element', async () => {
    await load(page, '<button id=b style="position:absolute;left:10px;top:20px;width:100px;height:40px">Go</button>');
    const r = await act('#b', 'click');
    expect(r).toEqual({ ok: true, point: { x: 60, y: 40 } });
    expect(await act('#b', 'click', { position: { x: 5, y: 5 } })).toMatchObject({ ok: true, point: { x: 17, y: 27 } });
    expect(await act('#b', 'focus')).toEqual({ ok: true });
  });

  it('names the element that covers the target', async () => {
    await load(page, '<button id=b>Go</button><div class="modal-backdrop fade" style="position:fixed;inset:0"></div>');
    const r = await act('#b', 'click');
    expect(r).toEqual({ ok: false, reason: 'div.modal-backdrop.fade covers the target', retry: true, blocker: 'div.modal-backdrop.fade' });
    expect(await act('#b', 'click', { force: true })).toMatchObject({ ok: true });
  });

  it('hit inside a shadow root of the target, and label hits count for the control', async () => {
    await load(page, '<x-btn id=h></x-btn><label id=lab>Accept <input id=c type=checkbox style="width:1px;height:1px;opacity:0"></label>', `h.attachShadow({mode:'open'}).innerHTML = '<button style="width:80px;height:30px">Inner</button>'`);
    expect(await act('#h', 'click')).toMatchObject({ ok: true });
    expect(await act('#lab', 'click')).toMatchObject({ ok: true });
  });

  it('fails for hidden, disabled, readonly and non-editable targets', async () => {
    await load(
      page,
      `<button id=h style="display:none">x</button><button id=d disabled>x</button><input id=ro readonly>
       <input id=cb type=checkbox><div id=dv>text</div><fieldset disabled><input id=fi></fieldset>
       <button id=ad aria-disabled=true>x</button><span id=pe style="pointer-events:none">pe</span>`,
    );
    expect(await act('#h', 'click')).toEqual({ ok: false, reason: 'the element is hidden', retry: true });
    expect(await act('#d', 'click')).toEqual({ ok: false, reason: 'the element is disabled', retry: true });
    expect(await act('#d', 'hover')).toMatchObject({ ok: true });
    expect(await act('#ro', 'fill')).toEqual({ ok: false, reason: 'the element is read-only', retry: true });
    expect(await act('#cb', 'fill')).toEqual({ ok: false, reason: 'an <input type=checkbox> takes no typed text', retry: false });
    expect(await act('#dv', 'fill')).toMatchObject({ ok: false, retry: false });
    expect(await act('#fi', 'fill')).toMatchObject({ ok: false, reason: 'the element is disabled' });
    expect(await act('#ad', 'click')).toMatchObject({ ok: false, reason: 'the element is disabled' });
    expect(await act('#pe', 'click')).toMatchObject({ ok: false, reason: 'element does not receive pointer events (pointer-events: none)' });
    expect(await act('#dv', 'bogus')).toEqual({ ok: false, reason: 'unknown action "bogus"', retry: false });
  });

  it('fails while the element moves, and scrolls it into view', async () => {
    await load(
      page,
      `<style>@keyframes slide{from{transform:translateX(0)}to{transform:translateX(300px)}}</style>
       <button id=m style="animation:slide 2s linear infinite">Moving</button>
       <div style="height:3000px"></div><button id=far>Far</button>`,
    );
    expect(await act('#m', 'click')).toMatchObject({ ok: false, reason: 'the element is still moving or resizing', retry: true });
    const r = await act('#far', 'click');
    expect(r.ok).toBe(true);
    const inView = await ev<boolean>(page, `const r = document.getElementById('far').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight;`);
    expect(inView).toBe(true);
  });

  it('accepts the contract action names and short aliases', async () => {
    await load(page, '<select id=s><option>a</option></select><div id=d>x</div>');
    expect(await act('#s', 'select')).toEqual({ ok: true });
    expect(await act('#s', 'selectOption')).toEqual({ ok: true });
    expect(await act('#d', 'scroll')).toEqual({ ok: true });
  });
});

describe('describe and fingerprint', () => {
  it('describes by role and name, else CSS-like', async () => {
    await load(
      page,
      `<button id=b>Submit order</button><input id=qty name=quantity><div class="card selected">x</div><span>Total: 5</span>
       <a href="/help">Help</a><div></div>`,
    );
    const d = await ev<string[]>(page, `return [...document.querySelectorAll('body *')].map((e) => E.describe(e));`);
    expect(d).toEqual(['button "Submit order"', 'input#qty[name=quantity]', 'div.card.selected', 'span "Total: 5"', 'link "Help"', 'div']);
  });

  it('captures the healer fingerprint fields', async () => {
    await load(page, `<form id=login class="f"><div class="row"><label for=u>User</label><input id=u name=user type=text placeholder="you@x" data-testid=user-field></div></form>`);
    const fp = await ev<Record<string, unknown>>(page, `return E.fingerprint(document.getElementById('u'));`);
    expect(fp).toMatchObject({
      tag: 'input',
      role: 'textbox',
      name: 'User',
      id: 'u',
      testId: 'user-field',
      attributes: { type: 'text', name: 'user', placeholder: 'you@x' },
      label: 'User',
      placeholder: 'you@x',
      path: 'form#login > div.row',
    });
    expect(fp.text).toBeUndefined();
    expect(Object.keys(fp.box as object)).toEqual(['x', 'y', 'width', 'height']);
    const scan = await ev<Array<{ visible: boolean; enabled: boolean }>>(page, `return E.scan([document.getElementById('u')]);`);
    expect(scan[0]).toMatchObject({ visible: true, enabled: true });
  });
});

describe('fingerprint parity with src/heal/fingerprint.ts', () => {
  it('captures the same fields and values as the current healer capture', async () => {
    const { scanElements } = await import('../../src/heal/fingerprint.js');
    await load(
      page,
      `<form id=login class="card wide"><div class="row"><label for=u>User name</label><input id=u name=user placeholder="you@x" data-testid=user></div>
       <div class=row><label>Remember <input type=checkbox name=rem></label></div>
       <button type=submit class="btn btn-primary">Sign in</button><a href="/help" title="Help page">Help</a>
       <input type=submit value="Go"><select name=c aria-label=Country><option>NL</option></select>
       <h2>Orders</h2><img alt="Logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><span>Plain text</span></form>`,
    );
    const sel = '#login input, #login button, #login a, #login select, #login h2, #login img, #login span';
    const old = await scanElements(page.locator(sel));
    const fresh = await ev<Array<{ fingerprint: Record<string, unknown>; visible: boolean; enabled: boolean }>>(page, `return E.scan([...document.querySelectorAll(ARG)]);`, sel);
    expect(fresh.length).toBe(old.length);
    for (let i = 0; i < old.length; i++) {
      const a = old[i].fingerprint as Record<string, unknown>;
      const b = fresh[i].fingerprint;
      expect(Object.keys(b).sort(), `keys of #${i} ${String(a.tag)}`).toEqual(Object.keys(a).sort());
      for (const k of ['tag', 'text', 'id', 'testId', 'classes', 'attributes', 'label', 'placeholder', 'path', 'box', 'role', 'name']) {
        expect(b[k], `${k} of #${i} ${String(a.tag)}`).toEqual(a[k]);
      }
      expect(fresh[i].visible).toBe(old[i].visible);
      expect(fresh[i].enabled).toBe(old[i].enabled);
    }
  });
});

describe('value helpers', () => {
  it('fill fires beforeinput, input and change and defeats React-style value trackers', async () => {
    await load(page, '<input id=i value=old><textarea id=ta></textarea><div id=ce contenteditable>old</div>');
    const r = await ev<{ log: string[]; value: string; tracked: boolean; ta: string; ce: string }>(
      page,
      `const i = document.getElementById('i');
       const log = [];
       for (const t of ['beforeinput','input','change']) i.addEventListener(t, (e) => log.push(t + ':' + (e.inputType || '') + ':' + i.value));
       // Simulate React's value tracker: an own-property setter that records the last value set by the framework.
       let tracked = 'old';
       const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
       Object.defineProperty(i, 'value', { configurable: true, get() { return proto.get.call(this); }, set(v) { tracked = v; proto.set.call(this, v); } });
       E.fill(i, 'new text');
       const ta = document.getElementById('ta'); E.fill(ta, 'multi\\nline');
       const ce = document.getElementById('ce'); E.fill(ce, 'edited');
       return { log, value: i.value, tracked: tracked !== i.value, ta: ta.value, ce: ce.textContent };`,
    );
    expect(r.log).toEqual(['beforeinput:insertText:old', 'input:insertText:new text', 'change::new text']);
    expect(r.value).toBe('new text');
    expect(r.tracked).toBe(true); // the tracker did NOT see the write, so React will treat the input event as a change
    expect(r.ta).toBe('multi\nline');
    expect(r.ce).toBe('edited');
  });

  it('fill validates inputs and clear empties', async () => {
    await load(page, '<input id=n type=number><input id=d type=date><input id=t value=abc>');
    expect(await ev(page, `return E.fill(document.getElementById('n'), 'abc');`)).toEqual({ ok: false, reason: 'cannot type text into input[type=number]', retry: false });
    expect(await ev(page, `E.fill(document.getElementById('d'), '2026-10-22'); return document.getElementById('d').value;`)).toBe('2026-10-22');
    expect(await ev(page, `return E.fill(document.getElementById('d'), 'not a date');`)).toMatchObject({ ok: false, retry: false });
    expect(await ev(page, `E.clear(document.getElementById('t')); return E.inputValue(document.getElementById('t'));`)).toBe('');
    await expect(ev(page, `return E.inputValue(document.body);`)).rejects.toThrow(/Not an <input>/);
  });

  it('selectOptions by value, label or index, and fires input + change', async () => {
    await load(page, '<select id=s><option value=nl>Netherlands</option><option value=de>Germany</option><option value=fr disabled>France</option></select><select id=m multiple><option value=a>A</option><option value=b>B</option><option value=c>C</option></select>');
    const r = await ev<unknown[]>(
      page,
      `const s = document.getElementById('s'); const log = [];
       s.addEventListener('input', () => log.push('input')); s.addEventListener('change', () => log.push('change'));
       const out = [E.selectOptions(s, ['de']), s.value, E.selectOptions(s, ['Netherlands']), s.value, E.selectOptions(s, [{ index: 1 }]), s.value,
         E.selectOptions(s, ['fr']), E.selectOptions(document.getElementById('m'), ['a', { label: 'C' }]), log];
       return out;`,
    );
    expect(r).toEqual([
      { ok: true, value: ['de'] }, 'de',
      { ok: true, value: ['nl'] }, 'nl',
      { ok: true, value: ['de'] }, 'de',
      { ok: false, reason: 'no option matching "fr"', retry: true },
      { ok: true, value: ['a', 'c'] },
      ['input', 'change', 'input', 'change', 'input', 'change'],
    ]);
  });

  it('setChecked clicks only when needed; checkState reads it', async () => {
    await load(page, '<input id=c type=checkbox><div id=sw role=switch aria-checked=false tabindex=0></div><input id=r type=radio checked><p id=p>x</p>');
    await page.evaluate(`document.getElementById('sw').addEventListener('click', (e) => e.target.setAttribute('aria-checked', String(e.target.getAttribute('aria-checked') !== 'true')))`);
    const r = await ev<unknown[]>(
      page,
      `const c = document.getElementById('c'); let changes = 0; c.addEventListener('change', () => changes++);
       return [E.setChecked(c, true), E.setChecked(c, true), changes, E.checkState(c, 'checked'),
               E.setChecked(document.getElementById('sw'), true), E.checkState(document.getElementById('sw'), 'checked'),
               E.setChecked(document.getElementById('r'), false)];`,
    );
    expect(r).toEqual([{ ok: true, value: true }, { ok: true, value: false }, 1, true, { ok: true, value: true }, true, { ok: false, reason: 'cannot uncheck a radio button', retry: false }]);
    await expect(ev(page, `return E.checkState(document.getElementById('p'), 'checked');`)).rejects.toThrow(/not a checkbox or radio button/);
  });

  it('dispatchEvent builds the right event class with bubbling defaults', async () => {
    await load(page, '<div id=outer><button id=b>x</button></div>');
    const r = await ev<string[]>(
      page,
      `const log = []; const outer = document.getElementById('outer');
       for (const t of ['click', 'keydown', 'focus', 'dragstart', 'my-event', 'pointerdown']) outer.addEventListener(t, (e) => log.push(t + ':' + e.constructor.name + ':' + e.bubbles + (e.detail && e.detail.x ? ':' + e.detail.x : '') + (e.key ? ':' + e.key : '')), true);
       const b = document.getElementById('b');
       E.dispatchEvent(b, 'click'); E.dispatchEvent(b, 'keydown', { key: 'Enter' }); E.dispatchEvent(b, 'focus');
       E.dispatchEvent(b, 'dragstart'); E.dispatchEvent(b, 'my-event', { detail: { x: 7 } }); E.dispatchEvent(b, 'pointerdown');
       return log;`,
    );
    expect(r).toEqual(['click:MouseEvent:true', 'keydown:KeyboardEvent:true:Enter', 'focus:FocusEvent:false', 'dragstart:DragEvent:true', 'my-event:CustomEvent:true:7', 'pointerdown:PointerEvent:true']);
  });

  it('text helpers and element states', async () => {
    await load(page, '<div id=d>  Hello\n   <b>World</b> <span style="display:none">x</span></div><input id=i><button id=b>x</button>');
    const r = await ev<unknown[]>(
      page,
      `const d = document.getElementById('d');
       document.getElementById('i').focus();
       return [E.innerText(d), E.elementText(d), E.normalizeWhitespace(' a \\u00a0 b '), E.matchesText('Hello World', 'o w'),
         E.checkState(document.getElementById('i'), 'focused'), E.checkState(document.getElementById('i'), 'editable'),
         E.checkState(document.getElementById('b'), 'editable'), E.checkState(d, 'attached')];`,
    );
    expect(r).toEqual(['Hello World', 'Hello World x', 'a b', true, true, true, false, true]);
  });
});

describe('ariaSnapshot', () => {
  it('lists roles, names and states', async () => {
    await load(page, '<main><h1>Orders</h1><button aria-pressed=true>Bold</button><input type=checkbox aria-label=Agree checked><p>Done</p></main>');
    const s = await ev<string>(page, `return E.ariaSnapshot(document.body);`);
    expect(s).toBe(['- main', '  - heading "Orders" [level=1]', '  - button "Bold" [pressed=true]', '  - checkbox "Agree" [checked=true]', '  - paragraph', '    - text "Done"'].join('\n'));
  });
});
